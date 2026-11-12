/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

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
import { THREE } from './threeCompat.js';
import { QuantizedPointMap, IntPairMap } from './meshIndex.js';

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
  // Exact integer pair keys over typed arrays. The previous implementation
  // packed each edge as `x * 4294967296 + y` into a JS number and counted in a
  // Map, which failed twice on large exports:
  //
  //   * float64 holds x * 2^32 + y exactly only up to x = 2^21 = 2,097,152
  //     vertices. Beyond that distinct edges share a key and their incidence
  //     counts add, so the `> 2` test fires on a perfectly manifold mesh —
  //     measured on a torus that is manifold by construction, 2.52 M vertices
  //     reported 210,422 phantom non-manifold edges and 3.74 M reported
  //     819,608. Exports were being declared broken when they were fine.
  //   * a JS Map throws past V8's ~16.7 M entry cap, i.e. above ~11 M
  //     triangles, which the pipeline can now reach.
  const edges = new IntPairMap(Math.max(16, n * 2));
  let nE = 0;
  let counts = new Int32Array(n * 3 + 16);
  for (let t = 0; t < n; t++) {
    const a = id[t*3], b = id[t*3+1], c = id[t*3+2];
    if (a === b || b === c || a === c) continue;
    for (let e = 0; e < 3; e++) {
      const x = e === 0 ? a : e === 1 ? b : c;
      const y = e === 0 ? b : e === 1 ? c : a;
      const lo = x < y ? x : y, hi = x < y ? y : x;
      const s = edges.getOrSet(lo, hi, nE);
      if (edges.inserted) {
        if (nE >= counts.length) {
          const g = new Int32Array(counts.length * 2); g.set(counts); counts = g;
        }
        nE++;
      }
      counts[s]++;
    }
  }
  let open = 0, nonManifold = 0;
  for (let i = 0; i < nE; i++) { if (counts[i] === 1) open++; else if (counts[i] > 2) nonManifold++; }
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

  for (let iter = 0; iter < maxIters; iter++) {
    // Edge → adjacent-face count, in a dense table keyed on the EXACT integer
    // pair. The previous key packed the pair into one JS number as
    // `a * 4294967296 + b`, which float64 represents exactly only while the
    // product stays inside 2^53 — i.e. up to a = 2^21 = 2,097,152 vertices.
    // Above that distinct edges land on the same key and their counts merge,
    // which here is a CORRECTNESS bug and not merely a reporting one: a real
    // boundary edge (count 1) colliding with another reads as count 2, so its
    // T-junction is never repaired, and decoding the key back into (a, b) —
    // `b = k % 4294967296` — yields vertex ids that were never on that edge.
    // Measured on a torus that is manifold by construction: 2.52 M vertices
    // reported 210,422 phantom non-manifold edges, 3.74 M reported 819,608.
    const eMap = new IntPairMap(Math.max(16, faces.length * 2));
    let nE = 0;
    let eLo = new Int32Array(faces.length * 3 + 16);
    let eHi = new Int32Array(eLo.length);
    let eCnt = new Int32Array(eLo.length);
    const edgeSlot = (a, b) => {
      const lo = a < b ? a : b, hi = a < b ? b : a;
      const s = eMap.getOrSet(lo, hi, nE);
      if (eMap.inserted) {
        if (nE >= eLo.length) {
          const grow = (o) => { const g = new Int32Array(o.length * 2); g.set(o); return g; };
          eLo = grow(eLo); eHi = grow(eHi); eCnt = grow(eCnt);
        }
        eLo[nE] = lo; eHi[nE] = hi; nE++;
      }
      return s;
    };
    const edgeCount = (a, b) => {
      const lo = a < b ? a : b, hi = a < b ? b : a;
      const s = eMap.get(lo, hi);
      return s === -1 ? 0 : eCnt[s];
    };

    for (let fi = 0; fi < faces.length; fi++) {
      const f = faces[fi];
      for (let e = 0; e < 3; e++) eCnt[edgeSlot(f[e], f[(e+1)%3])]++;
    }
    // Boundary edges (exactly one face) and the set of boundary vertices.
    const bverts = new Set();
    for (let s = 0; s < nE; s++) {
      if (eCnt[s] !== 1) continue;
      bverts.add(eLo[s]); bverts.add(eHi[s]);
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
        if (edgeCount(a, b) !== 1) continue;                    // only boundary edges
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

/**
 * Needle cleanup before refinement.
 *
 * A needle is a long triangle whose short edge is a tiny fraction of its long
 * ones (CAD exports leave them, e.g. a 67 mm strip 0.35 µm wide at its foot).
 * Refinement fills it with vertices in a strip narrower than the refinement
 * spacing: with longest edge L split down to refineLength, the strip of width w
 * is cut into about L / refineLength parts across, so distinct new vertices can
 * lie only w · refineLength / L apart. Below the 10 nm weld cell of subdivision
 * and displacement they merge, and the needle turns into degenerate triangles,
 * non-manifold edges and a visible scar along its length.
 *
 * A triangle counts as flat when its height over its longest edge,
 * h = |AB × AC| / L, is below `cell · safety · L / refineLength` (micrometres).
 * The height is used rather than a+b−c or the semi-perimeter minus L: those
 * shrink like h²/L and drown in float32 rounding long before h does.
 * In a flat triangle, each edge shorter than that limit is collapsed (both
 * ends move onto one of them) and the triangles that become degenerate are
 * dropped. A flat triangle without a short edge (a cap: two acute angles, one
 * near 180°) is left alone; it would need an edge flip. Returns null when there is no needle, or when the
 * collapse would leave an edge with more than two faces the input did not have
 * (then the input is used unchanged).
 *
 * @param {Float32Array} positions  non-indexed triangle soup (9 floats per triangle)
 * @param {number} refineLength     the refinement's maximum edge length (mm)
 * @param {number} [cell=1e-5]      weld cell of subdivision/displacement (mm)
 * @param {number} [safety=4]       margin over the weld cell
 * @returns {{ positions: Float32Array, keep: Uint32Array, collapsed: number } | null}
 *          keep: the kept input triangle per output triangle, for the per-face and
 *          per-corner arrays that index the input
 */
export function collapseNeedleEdges(positions, refineLength, cell = 1e-5, safety = 4) {
  const corners = Math.floor(positions.length / 3);
  const tris = Math.floor(corners / 3);
  if (!(refineLength > 0) || tris === 0) return null;

  // Weld the corners on the subdivision grid (1e5 = the 10 nm cell).
  const map = new QuantizedPointMap(1 / cell, Math.min(corners, 1 << 22));
  const id = new Int32Array(corners);
  let nv = 0;
  for (let c = 0; c < corners; c++) {
    id[c] = map.getOrSet(positions[c * 3], positions[c * 3 + 1], positions[c * 3 + 2], nv);
    if (map.inserted) nv++;
  }

  const parent = new Int32Array(nv);
  for (let v = 0; v < nv; v++) parent[v] = v;
  const find = (v) => { while (parent[v] !== v) { parent[v] = parent[parent[v]]; v = parent[v]; } return v; };

  const len = (a, b) => Math.hypot(positions[a * 3] - positions[b * 3],
    positions[a * 3 + 1] - positions[b * 3 + 1], positions[a * 3 + 2] - positions[b * 3 + 2]);
  let collapsed = 0;
  for (let t = 0; t < tris; t++) {
    const c = t * 3;
    const e0 = len(c, c + 1), e1 = len(c + 1, c + 2), e2 = len(c + 2, c);
    const L = Math.max(e0, e1, e2);
    if (L <= refineLength) continue;                  // not refined: no needle problem
    const limit = cell * safety * L / refineLength;
    // Height over the longest edge: twice the area (|AB × AC|) over L.
    const o = c * 3;
    const ux = positions[o + 3] - positions[o], uy = positions[o + 4] - positions[o + 1], uz = positions[o + 5] - positions[o + 2];
    const vx = positions[o + 6] - positions[o], vy = positions[o + 7] - positions[o + 1], vz = positions[o + 8] - positions[o + 2];
    const h = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / L;
    if (h >= limit) continue;                         // not flat
    const es = [[e0, c, c + 1], [e1, c + 1, c + 2], [e2, c + 2, c]];
    for (const [e, a, b] of es) {
      if (e >= limit) continue;
      const ra = find(id[a]), rb = find(id[b]);
      if (ra === rb) continue;
      parent[rb] = ra;
      collapsed++;
    }
  }
  if (collapsed === 0) return null;

  // Rebuild: merged corners take their root's position; degenerate triangles go.
  const rootCorner = new Int32Array(nv).fill(-1);
  for (let c = 0; c < corners; c++) if (find(id[c]) === id[c] && rootCorner[id[c]] < 0) rootCorner[id[c]] = c;
  const keepList = [];
  for (let t = 0; t < tris; t++) {
    const a = find(id[t * 3]), b = find(id[t * 3 + 1]), c = find(id[t * 3 + 2]);
    if (a !== b && b !== c && a !== c) keepList.push(t);
  }
  const keep = Uint32Array.from(keepList);
  const out = new Float32Array(keep.length * 9);
  for (let k = 0; k < keep.length; k++) {
    for (let j = 0; j < 3; j++) {
      const c = keep[k] * 3 + j;
      const r = find(id[c]);
      const src = r === id[c] ? c : rootCorner[r];
      out[k * 9 + j * 3] = positions[src * 3];
      out[k * 9 + j * 3 + 1] = positions[src * 3 + 1];
      out[k * 9 + j * 3 + 2] = positions[src * 3 + 2];
    }
  }

  // Safety: the collapse must not add edges with three or more faces.
  const overfull = (triIds, rootOf) => {
    const edges = new IntPairMap(Math.min(triIds.length * 3, 1 << 23));
    const count = new Uint8Array(triIds.length * 3 + 1);
    let next = 0, bad = 0;
    for (const t of triIds) {
      for (let j = 0; j < 3; j++) {
        const a = rootOf(t * 3 + j), b = rootOf(t * 3 + (j + 1) % 3);
        const slot = edges.getOrSet(Math.min(a, b), Math.max(a, b), next);
        if (edges.inserted) next++;
        if (++count[slot] === 3) bad++;
      }
    }
    return bad;
  };
  const all = { length: tris, [Symbol.iterator]: function* () { for (let t = 0; t < tris; t++) yield t; } };
  if (overfull(keep, (c) => find(id[c])) > overfull(all, (c) => id[c])) return null;

  return { positions: out, keep, collapsed };
}

/**
 * The pipeline input with the triangles `keep` lists (collapseNeedleEdges): new
 * positions, and every per-face and per-corner array cut down to match.
 */
export function remapPipelineInput(input, positions, keep) {
  const perCorner = (arr) => {
    if (!arr) return arr;
    const out = new arr.constructor(keep.length * 3);
    for (let k = 0; k < keep.length; k++) for (let j = 0; j < 3; j++) out[k * 3 + j] = arr[keep[k] * 3 + j];
    return out;
  };
  const perFace = (arr) => {
    if (!arr) return arr;
    const out = new arr.constructor(keep.length);
    for (let k = 0; k < keep.length; k++) out[k] = arr[keep[k]];
    return out;
  };
  return {
    ...input,
    positions,
    faceWeights: perCorner(input.faceWeights),
    softExclude: perCorner(input.softExclude),
    layers: Array.isArray(input.layers)
      ? input.layers.map((l) => ({ ...l, hardFaces: perFace(l.hardFaces), exclude: perCorner(l.exclude) }))
      : input.layers,
  };
}
