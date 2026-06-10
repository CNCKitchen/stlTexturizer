/**
 * T-junction resolution for the export mesh.
 *
 * Decimation can leave T-junctions: a long edge A→B on one triangle, with one or
 * more vertices sitting *on* segment AB that belong only to the triangles on the
 * other side (e.g. across a sharp-edge split seam, where the two patches decimate
 * to different edge lengths). Edge AB then has a single adjacent face → it reads
 * as an open edge and the mesh is "not watertight", even though there's no visible
 * gap. No vertex-weld tolerance can fix this (the on-edge vertices are genuinely
 * distinct points, not coincident with A or B).
 *
 * The fix is topological, not positional: find every vertex that lies on another
 * triangle's edge and split that edge to insert it, restoring shared topology.
 * This seals the mesh WITHOUT adding or removing geometry (no holes, no overlaps).
 *
 * @param {THREE.BufferGeometry} geometry  non-indexed input (decimate output)
 * @param {object} [opts]
 * @param {number} [opts.weldQuant=1e4]  export weld grid (vertices within 1/quant merge)
 * @param {number} [opts.onSegTol=0.02]  max perpendicular distance (mm) to treat a vertex as lying on an edge.
 *        Must comfortably exceed the harvest flatness tolerance (decimation collapses
 *        regions flat only to within ~harvestTol mm, so the collapsed long edge is a
 *        chord that the on-edge vertices deviate from by up to ~harvestTol). 2µm — the
 *        old value — was *below* the 5µm default harvestTol, so borderline-flat
 *        T-junctions slipped through. 20µm catches them with margin while staying far
 *        too small to wrongly split unrelated geometry (the weld grid is 100µm).
 * @param {number} [opts.maxIters=16]    cascade-split iteration cap
 * @returns {THREE.BufferGeometry}  repaired non-indexed geometry
 */
import * as THREE from 'three';
import { QuantizedPointMap } from './meshIndex.js';

/**
 * Count open (1-face) and non-manifold (3+-face) edges of a non-indexed geometry,
 * welding positions at grid Q first (matches the app's watertight check at 1e4).
 * Cheap — used to verify the repair from inside the live export.
 * @returns {{open:number, nonManifold:number, tris:number}}
 */
export function countEdgeDefects(geometry, Q = 1e4) {
  const p = geometry.attributes.position.array, n = p.length / 9;
  const vmap = new QuantizedPointMap(Q, Math.min(n * 3, 1 << 22)), id = new Int32Array(n * 3);
  for (let i = 0; i < n * 3; i++) {
    id[i] = vmap.getOrSet(p[i*3], p[i*3+1], p[i*3+2], vmap.size);
  }
  const ec = new Map();
  for (let t = 0; t < n; t++) {
    const a = id[t*3], b = id[t*3+1], c = id[t*3+2];
    if (a === b || b === c || a === c) continue;
    const tri = [a, b, c];
    for (let e = 0; e < 3; e++) {
      const x = tri[e], y = tri[(e+1)%3];
      const key = x < y ? x * 4294967296 + y : y * 4294967296 + x;
      ec.set(key, (ec.get(key) || 0) + 1);
    }
  }
  let open = 0, nonManifold = 0;
  for (const c of ec.values()) { if (c === 1) open++; else if (c > 2) nonManifold++; }
  return { open, nonManifold, tris: n };
}

/**
 * Count triangles a slicer / our own importer would delete as degenerate
 * (area² < 1e-24 mm², i.e. area < 1e-12 mm²). Each such triangle, once removed,
 * punches a hole — so a nonzero count on the export means the file is watertight
 * only on paper. Should be 0 after resolveTJunctions.
 * @returns {number}
 */
export function countAreaSlivers(geometry) {
  const p = geometry.attributes.position.array, n = p.length / 9;
  let s = 0;
  for (let t = 0; t < n; t++) {
    const b = t * 9;
    const ux = p[b+3]-p[b], uy = p[b+4]-p[b+1], uz = p[b+5]-p[b+2];
    const vx = p[b+6]-p[b], vy = p[b+7]-p[b+1], vz = p[b+8]-p[b+2];
    const a2 = (uy*vz-uz*vy)**2 + (uz*vx-ux*vz)**2 + (ux*vy-uy*vx)**2;
    if (a2 < 1e-24) s++;
  }
  return s;
}

export function resolveTJunctions(geometry, opts = {}) {
  const Q       = opts.weldQuant ?? 1e4;
  const onTol   = opts.onSegTol  ?? 0.02;
  const maxIters = opts.maxIters ?? 16;
  const onTol2  = onTol * onTol;

  const pos  = geometry.attributes.position.array;
  const nTri = pos.length / 9;

  // ── Weld vertices at the export grid, SNAPPING coords onto that grid ─────────
  // The export writes coordinates rounded to 1/Q (toFixed(4) for Q=1e4). If we
  // welded but kept the un-rounded coords, a thin triangle could pass the
  // degeneracy test here yet collapse to exactly collinear once the export rounds
  // its vertices onto the grid — becoming a zero-area triangle the importer/slicer
  // then deletes, punching a hole. Snapping here makes our check see precisely
  // what the export will write, and makes the export's rounding a no-op.
  const vmap = new QuantizedPointMap(Q, Math.min(nTri * 3, 1 << 22));
  const vx = [], vy = [], vz = [];
  const vid = new Int32Array(nTri * 3);
  for (let i = 0; i < nTri * 3; i++) {
    const x = pos[i*3], y = pos[i*3+1], z = pos[i*3+2];
    const id = vmap.getOrSet(x, y, z, vx.length);
    if (vmap.inserted) {
      vx.push(Math.round(x*Q)/Q); vy.push(Math.round(y*Q)/Q); vz.push(Math.round(z*Q)/Q);
    }
    vid[i] = id;
  }
  // Faces as index triples, dropping degenerates. Two kinds are dropped here:
  //   1. index-degenerate (two corners welded to the same vertex), and
  //   2. AREA-degenerate "needles" — three distinct but (on the export grid)
  //      collinear vertices with effectively zero area. These read as watertight
  //      (3 distinct verts) but every slicer and our own importer delete any
  //      triangle with area < 1e-12 mm², which punches a hole at each one. We drop
  //      them so the T-junction pass below re-seals the gaps (a dropped needle
  //      leaves exactly the on-edge-vertex topology that pass is built to close).
  //      On the grid, cross² is either 0 (collinear) or ≥ ~1e-16 (smallest real
  //      triangle = 1 grid unit per leg), so the 1e-18 cutoff cleanly separates
  //      the two — and since we output the snapped coords, the importer sees the
  //      identical geometry and finds nothing left to remove.
  const DEGEN_AREA2 = 1e-18;
  let faces = [], droppedNeedles = 0;
  for (let t = 0; t < nTri; t++) {
    const a = vid[t*3], b = vid[t*3+1], c = vid[t*3+2];
    if (a === b || b === c || a === c) continue;
    const ux = vx[b]-vx[a], uy = vy[b]-vy[a], uz = vz[b]-vz[a];
    const wx = vx[c]-vx[a], wy = vy[c]-vy[a], wz = vz[c]-vz[a];
    const cx = uy*wz - uz*wy, cy = uz*wx - ux*wz, cz = ux*wy - uy*wx;
    if (cx*cx + cy*cy + cz*cz < DEGEN_AREA2) { droppedNeedles++; continue; }
    faces.push([a, b, c]);
  }

  const ekey = (a, b) => (a < b ? a * 4294967296 + b : b * 4294967296 + a);

  for (let iter = 0; iter < maxIters; iter++) {
    // Edge → adjacent-face count + sample.
    const eCount = new Map();
    for (let fi = 0; fi < faces.length; fi++) {
      const f = faces[fi];
      for (let e = 0; e < 3; e++) eCount.set(ekey(f[e], f[(e+1)%3]), (eCount.get(ekey(f[e], f[(e+1)%3])) || 0) + 1);
    }
    // Boundary edges (exactly one face) and the set of boundary vertices.
    const bverts = new Set();
    for (const [k, c] of eCount) {
      if (c !== 1) continue;
      const b = k % 4294967296, a = (k - b) / 4294967296;
      bverts.add(a); bverts.add(b);
    }
    if (bverts.size === 0) break;
    const bvArr = [...bverts];

    // For each boundary edge, find boundary vertices lying on its segment.
    const splits = new Map(); // faceIndex → { a, b, mids:[vertex…] }
    let didSplit = false;
    for (let fi = 0; fi < faces.length; fi++) {
      const f = faces[fi];
      for (let e = 0; e < 3; e++) {
        const a = f[e], b = f[(e+1)%3];
        if ((eCount.get(ekey(a, b)) || 0) !== 1) continue;     // only boundary edges
        const ax = vx[a], ay = vy[a], az = vz[a];
        const ex = vx[b]-ax, ey = vy[b]-ay, ez = vz[b]-az;
        const elen2 = ex*ex + ey*ey + ez*ez;
        if (elen2 < 1e-20) continue;
        const found = [];
        for (const c of bvArr) {
          if (c === a || c === b) continue;
          const cx = vx[c]-ax, cy = vy[c]-ay, cz = vz[c]-az;
          const tp = (cx*ex + cy*ey + cz*ez) / elen2;
          if (tp <= 1e-4 || tp >= 1 - 1e-4) continue;          // strictly between A and B
          const px = cx - tp*ex, py = cy - tp*ey, pz = cz - tp*ez;
          if (px*px + py*py + pz*pz < onTol2) found.push([tp, c]);
        }
        if (found.length) {
          found.sort((p, q) => p[0] - q[0]);
          splits.set(fi, { a, b, mids: found.map(m => m[1]) });
          didSplit = true;
          break; // one split site per face per pass; cascades handled by iteration
        }
      }
    }
    if (!didSplit) break;

    // Apply: replace each split face with a fan from its apex over the split edge.
    const next = [];
    for (let fi = 0; fi < faces.length; fi++) {
      const sp = splits.get(fi);
      if (!sp) { next.push(faces[fi]); continue; }
      const f = faces[fi], { a, b, mids } = sp;
      const apex = f[0] !== a && f[0] !== b ? f[0] : f[1] !== a && f[1] !== b ? f[1] : f[2];
      // Preserve winding: walk the base in the direction the face traverses it.
      let dirAB = false;
      for (let e = 0; e < 3; e++) if (f[e] === a && f[(e+1)%3] === b) { dirAB = true; break; }
      const seq = dirAB ? [a, ...mids, b] : [b, ...mids.slice().reverse(), a];
      for (let s = 0; s < seq.length - 1; s++) next.push([seq[s], seq[s+1], apex]);
    }
    faces = next;
  }

  // ── Rebuild non-indexed soup with flat normals ──────────────────────────────
  const out = new Float32Array(faces.length * 9);
  const nrm = new Float32Array(faces.length * 9);
  for (let i = 0; i < faces.length; i++) {
    const f = faces[i];
    const ax = vx[f[0]], ay = vy[f[0]], az = vz[f[0]];
    const bx = vx[f[1]], by = vy[f[1]], bz = vz[f[1]];
    const cx = vx[f[2]], cy = vy[f[2]], cz = vz[f[2]];
    out[i*9]   = ax; out[i*9+1] = ay; out[i*9+2] = az;
    out[i*9+3] = bx; out[i*9+4] = by; out[i*9+5] = bz;
    out[i*9+6] = cx; out[i*9+7] = cy; out[i*9+8] = cz;
    const ux = bx-ax, uy = by-ay, uz = bz-az, vvx = cx-ax, vvy = cy-ay, vvz = cz-az;
    let nxx = uy*vvz - uz*vvy, nyy = uz*vvx - ux*vvz, nzz = ux*vvy - uy*vvx;
    const len = Math.sqrt(nxx*nxx + nyy*nyy + nzz*nzz) || 1;
    nxx /= len; nyy /= len; nzz /= len;
    for (let k = 0; k < 3; k++) { nrm[i*9+k*3] = nxx; nrm[i*9+k*3+1] = nyy; nrm[i*9+k*3+2] = nzz; }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(out, 3));
  g.setAttribute('normal',   new THREE.BufferAttribute(nrm, 3));
  return g;
}
