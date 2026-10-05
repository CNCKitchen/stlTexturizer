/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * preserveStitch.js — put the untextured surfaces back exactly as they were.
 *
 * "Don't modify untextured surfaces" locks those faces in regularize and
 * decimation, but the export still re-splits them along the seam, and the
 * T-junction repair snaps every coordinate onto the 0.1 µm export grid, so an
 * untextured triangle almost never reaches the file bit-for-bit. This is the
 * last export step and it makes the promise exact:
 *
 *   1. Every output triangle lying on the untextured source surface (centroid
 *      and all three corners within `tol`) is dropped.
 *   2. The untextured source triangles are appended verbatim (float32).
 *   3. The textured part is zipped onto them with the ORIGINAL SIDE WINNING:
 *      each open-edge vertex of the textured part moves onto the nearest seam
 *      corner of the original faces, or failing that onto the nearest seam
 *      edge. The original corners never move.
 *   4. T-junctions left by step 3 are closed by splitting triangles at points
 *      that lie on their own edges: a textured point on an original seam edge
 *      splits the original triangle there (same plane, same outline, corners
 *      bit-exact), an original corner on a textured edge splits that textured
 *      triangle. No vertex is created anywhere else.
 *
 * The caller compares edge defects before and after and keeps the unstitched
 * mesh if the stitch made things worse (stats.failed).
 *
 * Bake mode does not stitch: it needs the parent-face map, which a stitch
 * would invalidate.
 */

import { QuantizedPointMap, IntPairMap } from './meshIndex.js';

// ── Small geometry helpers (all Float64) ─────────────────────────────────────

function distPointSeg2(px, py, pz, ax, ay, az, bx, by, bz) {
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const L2 = ux * ux + uy * uy + uz * uz;
  let s = L2 > 0 ? ((px - ax) * ux + (py - ay) * uy + (pz - az) * uz) / L2 : 0;
  if (s < 0) s = 0; else if (s > 1) s = 1;
  const dx = ax + s * ux - px, dy = ay + s * uy - py, dz = az + s * uz - pz;
  return dx * dx + dy * dy + dz * dz;
}

// Squared distance from p to triangle (a,b,c): plane distance when the
// projection falls inside, else the nearest edge.
export function distPointTri2(p, t, pos) {
  const ax = pos[t], ay = pos[t + 1], az = pos[t + 2];
  const bx = pos[t + 3], by = pos[t + 4], bz = pos[t + 5];
  const cx = pos[t + 6], cy = pos[t + 7], cz = pos[t + 8];
  const [px, py, pz] = p;
  const e0x = bx - ax, e0y = by - ay, e0z = bz - az;
  const e1x = cx - ax, e1y = cy - ay, e1z = cz - az;
  const nx = e0y * e1z - e0z * e1y, ny = e0z * e1x - e0x * e1z, nz = e0x * e1y - e0y * e1x;
  const n2 = nx * nx + ny * ny + nz * nz;
  if (n2 > 0) {
    const wx = px - ax, wy = py - ay, wz = pz - az;
    // Barycentric sign tests via the sub-triangle normals.
    const s1 = (e0y * wz - e0z * wy) * nx + (e0z * wx - e0x * wz) * ny + (e0x * wy - e0y * wx) * nz;
    const fx = cx - bx, fy = cy - by, fz = cz - bz, vx = px - bx, vy = py - by, vz = pz - bz;
    const s2 = (fy * vz - fz * vy) * nx + (fz * vx - fx * vz) * ny + (fx * vy - fy * vx) * nz;
    const gx = ax - cx, gy = ay - cy, gz = az - cz, qx = px - cx, qy = py - cy, qz = pz - cz;
    const s3 = (gy * qz - gz * qy) * nx + (gz * qx - gx * qz) * ny + (gx * qy - gy * qx) * nz;
    if (s1 >= 0 && s2 >= 0 && s3 >= 0) {
      const d = wx * nx + wy * ny + wz * nz;
      return d * d / n2;
    }
  }
  return Math.min(
    distPointSeg2(px, py, pz, ax, ay, az, bx, by, bz),
    distPointSeg2(px, py, pz, bx, by, bz, cx, cy, cz),
    distPointSeg2(px, py, pz, cx, cy, cz, ax, ay, az),
  );
}

// ── Uniform grid over boxes (triangles, segments, points) ────────────────────
// Each item goes into every cell its tol-padded box touches; an item spanning
// too many cells (a huge diagonal CAD triangle) goes on an always-checked list
// instead. Cell keys are hashed, so collisions only add candidates.

export class BoxGrid {
  constructor(cell) {
    this.cell = cell;
    this.inv = 1 / cell;
    this.cells = new Map();
    this.big = [];
  }
  _key(ix, iy, iz) { return ((ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)) | 0; }
  add(item, minX, minY, minZ, maxX, maxY, maxZ) {
    const i0 = Math.floor(minX * this.inv), i1 = Math.floor(maxX * this.inv);
    const j0 = Math.floor(minY * this.inv), j1 = Math.floor(maxY * this.inv);
    const k0 = Math.floor(minZ * this.inv), k1 = Math.floor(maxZ * this.inv);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) * (k1 - k0 + 1) > 512) { this.big.push(item); return; }
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (let k = k0; k <= k1; k++) {
      const key = this._key(i, j, k);
      const list = this.cells.get(key);
      if (list) { if (list[list.length - 1] !== item) list.push(item); } else this.cells.set(key, [item]);
    }
  }
  // Candidates for a point query (items were padded by tol when added).
  forEach(x, y, z, fn) {
    const list = this.cells.get(this._key(Math.floor(x * this.inv), Math.floor(y * this.inv), Math.floor(z * this.inv)));
    if (list) for (let i = 0; i < list.length; i++) fn(list[i]);
    for (let i = 0; i < this.big.length; i++) fn(this.big[i]);
  }
}

// Growable float32 triangle-soup writer (a plain JS array costs 8+ bytes per
// coordinate, which adds up on multi-million-triangle exports).
class SoupWriter {
  constructor(cap) { this.a = new Float32Array(Math.max(9, cap)); this.n = 0; }
  push(...v) {
    if (this.n + v.length > this.a.length) {
      const g = new Float32Array(Math.max(this.a.length * 2, this.n + v.length)); g.set(this.a); this.a = g;
    }
    for (let i = 0; i < v.length; i++) this.a[this.n++] = v[i];
  }
  result() { return this.a.slice(0, this.n); }
}

// ── Triangle splitting at points on its own edges ────────────────────────────
// (A,B,C) with sorted point lists on AB, BC, CA (each from the edge's first
// vertex). Fans from the corner opposite a pointed edge; the two outer pieces
// inherit the neighbouring edges' points and recurse. Never adds a vertex off
// the triangle's edges and never fans from a point onto its own edge, so no
// piece is degenerate. Points are [x,y,z] arrays; output pushes 9 numbers.

function splitTri(A, B, C, eAB, eBC, eCA, out) {
  if (eAB.length === 0 && eBC.length === 0 && eCA.length === 0) {
    out.push(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2]);
    return;
  }
  if (eAB.length === 0) {
    if (eBC.length) return splitTri(B, C, A, eBC, eCA, eAB, out);
    return splitTri(C, A, B, eCA, eAB, eBC, out);
  }
  const seq = [A, ...eAB, B];
  const last = seq.length - 2;
  for (let i = 0; i <= last; i++) {
    splitTri(seq[i], seq[i + 1], C,
      [], i === last ? eBC : [], i === 0 ? eCA : [], out);
  }
}

/**
 * @param {Float32Array} outPos   final export mesh (triangle soup)
 * @param {Float32Array} keptPos  the untextured source triangles (soup)
 * @param {object} [opts]  tol (mm): how close counts as "on the original"
 * @returns {{ positions: Float32Array, stats: object }}
 */
export function stitchPreserved(outPos, keptPos, opts = {}) {
  const tol = opts.tol ?? 1e-3;
  const tol2 = tol * tol;
  const nKept = keptPos.length / 9;
  const nOut = outPos.length / 9;
  const stats = { kept: nKept, removed: 0, snappedToCorner: 0, snappedToEdge: 0, unmatched: 0, keptSplit: 0, texturedSplit: 0 };
  if (nKept === 0) return { positions: outPos, stats };

  // ── Original (kept) surface: welded corners, seam edges, spatial index ──
  const kWeld = new QuantizedPointMap(1e6, Math.min(nKept * 3, 1 << 22));
  const kVid = new Int32Array(nKept * 3);
  const kVert = [];
  for (let i = 0; i < nKept * 3; i++) {
    const x = keptPos[i * 3], y = keptPos[i * 3 + 1], z = keptPos[i * 3 + 2];
    const id = kWeld.getOrSet(x, y, z, kVert.length / 3);
    if (kWeld.inserted) kVert.push(x, y, z);
    kVid[i] = id;
  }
  // Edge use count within the kept set: 1 → seam (borders texture or a hole).
  const kEdges = new IntPairMap(nKept * 3);
  const kEdgeCount = [];
  const kEdgeLo = [], kEdgeHi = [];
  let edgeLenSum = 0;
  for (let t = 0; t < nKept; t++) {
    for (let e = 0; e < 3; e++) {
      const u = kVid[t * 3 + e], v = kVid[t * 3 + (e + 1) % 3];
      const lo = u < v ? u : v, hi = u < v ? v : u;
      const s = kEdges.getOrSet(lo, hi, kEdgeCount.length);
      if (kEdges.inserted) {
        kEdgeCount.push(0); kEdgeLo.push(lo); kEdgeHi.push(hi);
        edgeLenSum += Math.hypot(kVert[lo * 3] - kVert[hi * 3], kVert[lo * 3 + 1] - kVert[hi * 3 + 1], kVert[lo * 3 + 2] - kVert[hi * 3 + 2]);
      }
      kEdgeCount[s]++;
    }
  }
  const cell = Math.max(tol * 8, edgeLenSum / Math.max(1, kEdgeCount.length));

  const triGrid = new BoxGrid(cell);
  for (let t = 0; t < nKept; t++) {
    const b = t * 9;
    triGrid.add(t,
      Math.min(keptPos[b], keptPos[b + 3], keptPos[b + 6]) - tol,
      Math.min(keptPos[b + 1], keptPos[b + 4], keptPos[b + 7]) - tol,
      Math.min(keptPos[b + 2], keptPos[b + 5], keptPos[b + 8]) - tol,
      Math.max(keptPos[b], keptPos[b + 3], keptPos[b + 6]) + tol,
      Math.max(keptPos[b + 1], keptPos[b + 4], keptPos[b + 7]) + tol,
      Math.max(keptPos[b + 2], keptPos[b + 5], keptPos[b + 8]) + tol);
  }
  const _p = [0, 0, 0];
  const onKept = (x, y, z) => {
    _p[0] = x; _p[1] = y; _p[2] = z;
    let hit = false;
    triGrid.forEach(x, y, z, (t) => { if (!hit && distPointTri2(_p, t * 9, keptPos) <= tol2) hit = true; });
    return hit;
  };

  // Seam corners and seam edges, indexed for snapping.
  const seamEdges = [];
  const isSeamVert = new Uint8Array(kVert.length / 3);
  for (let s = 0; s < kEdgeCount.length; s++) {
    if (kEdgeCount[s] !== 1) continue;
    seamEdges.push(s);
    isSeamVert[kEdgeLo[s]] = 1; isSeamVert[kEdgeHi[s]] = 1;
  }
  const vertGrid = new BoxGrid(cell);
  for (let v = 0; v < isSeamVert.length; v++) {
    if (!isSeamVert[v]) continue;
    const x = kVert[v * 3], y = kVert[v * 3 + 1], z = kVert[v * 3 + 2];
    vertGrid.add(v, x - tol, y - tol, z - tol, x + tol, y + tol, z + tol);
  }
  const edgeGrid = new BoxGrid(cell);
  for (const s of seamEdges) {
    const a = kEdgeLo[s] * 3, b = kEdgeHi[s] * 3;
    edgeGrid.add(s,
      Math.min(kVert[a], kVert[b]) - tol, Math.min(kVert[a + 1], kVert[b + 1]) - tol, Math.min(kVert[a + 2], kVert[b + 2]) - tol,
      Math.max(kVert[a], kVert[b]) + tol, Math.max(kVert[a + 1], kVert[b + 1]) + tol, Math.max(kVert[a + 2], kVert[b + 2]) + tol);
  }

  // ── 1. Drop output triangles lying on the original untextured surface ──
  const keepOut = new Uint8Array(nOut);
  for (let t = 0; t < nOut; t++) {
    const b = t * 9;
    const cx = (outPos[b] + outPos[b + 3] + outPos[b + 6]) / 3;
    const cy = (outPos[b + 1] + outPos[b + 4] + outPos[b + 7]) / 3;
    const cz = (outPos[b + 2] + outPos[b + 5] + outPos[b + 8]) / 3;
    const drop = onKept(cx, cy, cz)
      && onKept(outPos[b], outPos[b + 1], outPos[b + 2])
      && onKept(outPos[b + 3], outPos[b + 4], outPos[b + 5])
      && onKept(outPos[b + 6], outPos[b + 7], outPos[b + 8]);
    if (drop) stats.removed++; else keepOut[t] = 1;
  }

  // ── Textured part: weld (export grid), find its open edges ──
  const nTex = nOut - stats.removed;
  const tWeld = new QuantizedPointMap(1e4, Math.min(nTex * 3 + 16, 1 << 22));
  const tVid = new Int32Array(nTex * 3);
  const tVert = [];
  {
    let r = 0;
    for (let t = 0; t < nOut; t++) {
      if (!keepOut[t]) continue;
      for (let c = 0; c < 3; c++) {
        const i = t * 9 + c * 3;
        const id = tWeld.getOrSet(outPos[i], outPos[i + 1], outPos[i + 2], tVert.length / 3);
        if (tWeld.inserted) tVert.push(outPos[i], outPos[i + 1], outPos[i + 2]);
        tVid[r * 3 + c] = id;
      }
      r++;
    }
  }
  const tEdges = new IntPairMap(nTex * 3 + 16);
  const tEdgeCount = [], tEdgeLo = [], tEdgeHi = [];
  for (let t = 0; t < nTex; t++) {
    for (let e = 0; e < 3; e++) {
      const u = tVid[t * 3 + e], v = tVid[t * 3 + (e + 1) % 3];
      if (u === v) continue;
      const lo = u < v ? u : v, hi = u < v ? v : u;
      const s = tEdges.getOrSet(lo, hi, tEdgeCount.length);
      if (tEdges.inserted) { tEdgeCount.push(0); tEdgeLo.push(lo); tEdgeHi.push(hi); }
      tEdgeCount[s]++;
    }
  }
  const tOpenVert = new Uint8Array(tVert.length / 3);
  const tOpenEdges = [];
  for (let s = 0; s < tEdgeCount.length; s++) {
    if (tEdgeCount[s] !== 1) continue;
    tOpenEdges.push(s);
    tOpenVert[tEdgeLo[s]] = 1; tOpenVert[tEdgeHi[s]] = 1;
  }

  // ── 3. Snap the textured part's open vertices onto the original seam ──
  // keptEdgePts: kept seam edge → points (param along lo→hi) to split it at.
  const keptEdgePts = new Map();
  const tSnapped = new Uint8Array(tVert.length / 3); // 1 = on an original corner
  const usedKeptVert = new Uint8Array(kVert.length / 3);
  for (let v = 0; v < tOpenVert.length; v++) {
    if (!tOpenVert[v]) continue;
    const x = tVert[v * 3], y = tVert[v * 3 + 1], z = tVert[v * 3 + 2];
    let best = tol2, bestV = -1;
    vertGrid.forEach(x, y, z, (k) => {
      const d = (kVert[k * 3] - x) ** 2 + (kVert[k * 3 + 1] - y) ** 2 + (kVert[k * 3 + 2] - z) ** 2;
      if (d <= best) { best = d; bestV = k; }
    });
    if (bestV >= 0) {
      tVert[v * 3] = kVert[bestV * 3]; tVert[v * 3 + 1] = kVert[bestV * 3 + 1]; tVert[v * 3 + 2] = kVert[bestV * 3 + 2];
      tSnapped[v] = 1; usedKeptVert[bestV] = 1; stats.snappedToCorner++;
      continue;
    }
    let bestE = -1; best = tol2;
    edgeGrid.forEach(x, y, z, (s) => {
      const a = kEdgeLo[s] * 3, b = kEdgeHi[s] * 3;
      const d = distPointSeg2(x, y, z, kVert[a], kVert[a + 1], kVert[a + 2], kVert[b], kVert[b + 1], kVert[b + 2]);
      if (d <= best) { best = d; bestE = s; }
    });
    if (bestE < 0) { stats.unmatched++; continue; }
    // Project exactly onto the original edge (float32, the precision written).
    const a = kEdgeLo[bestE] * 3, b = kEdgeHi[bestE] * 3;
    const ux = kVert[b] - kVert[a], uy = kVert[b + 1] - kVert[a + 1], uz = kVert[b + 2] - kVert[a + 2];
    const L2 = ux * ux + uy * uy + uz * uz;
    const s = Math.min(1, Math.max(0, ((x - kVert[a]) * ux + (y - kVert[a + 1]) * uy + (z - kVert[a + 2]) * uz) / L2));
    const p = [Math.fround(kVert[a] + s * ux), Math.fround(kVert[a + 1] + s * uy), Math.fround(kVert[a + 2] + s * uz)];
    tVert[v * 3] = p[0]; tVert[v * 3 + 1] = p[1]; tVert[v * 3 + 2] = p[2];
    let list = keptEdgePts.get(bestE);
    if (!list) keptEdgePts.set(bestE, list = []);
    list.push({ s, p });
    stats.snappedToEdge++;
  }

  // Original seam corners the textured part has no vertex at: they sit on a
  // textured open edge (a T-junction on the textured side) → split it there.
  const texEdgePts = new Map();
  for (let k = 0; k < usedKeptVert.length; k++) {
    if (!isSeamVert[k] || usedKeptVert[k]) continue;
    const x = kVert[k * 3], y = kVert[k * 3 + 1], z = kVert[k * 3 + 2];
    let best = tol2, bestE = -1, bestS = 0;
    for (const s of tOpenEdges) {
      const a = tEdgeLo[s] * 3, b = tEdgeHi[s] * 3;
      const ux = tVert[b] - tVert[a], uy = tVert[b + 1] - tVert[a + 1], uz = tVert[b + 2] - tVert[a + 2];
      const L2 = ux * ux + uy * uy + uz * uz;
      if (!(L2 > 0)) continue;
      const sp = ((x - tVert[a]) * ux + (y - tVert[a + 1]) * uy + (z - tVert[a + 2]) * uz) / L2;
      if (sp <= 0 || sp >= 1) continue;
      const d = distPointSeg2(x, y, z, tVert[a], tVert[a + 1], tVert[a + 2], tVert[b], tVert[b + 1], tVert[b + 2]);
      if (d <= best) { best = d; bestE = s; bestS = sp; }
    }
    if (bestE < 0) continue; // a seam corner on an open hole of the source
    let list = texEdgePts.get(bestE);
    if (!list) texEdgePts.set(bestE, list = []);
    list.push({ s: bestS, p: [kVert[k * 3], kVert[k * 3 + 1], kVert[k * 3 + 2]] });
  }

  // ── 2 + 4. Assemble: original triangles (split where needed) + textured ──
  const sortPts = (m) => { for (const list of m.values()) list.sort((a, b) => a.s - b.s); };
  sortPts(keptEdgePts); sortPts(texEdgePts);
  // Points on edge u→v of a triangle, ordered from u.
  const ptsOn = (edges, counts, lo, map, u, v) => {
    const a = u < v ? u : v, b = u < v ? v : u;
    const s = edges.get(a, b);
    if (s < 0) return [];
    const list = map.get(s);
    if (!list) return [];
    const pts = list.map(q => q.p);
    return u === lo[s] ? pts : pts.reverse();
  };

  const out = new SoupWriter(outPos.length + keptPos.length);
  for (let t = 0; t < nKept; t++) {
    const b = t * 9;
    const ids = [kVid[t * 3], kVid[t * 3 + 1], kVid[t * 3 + 2]];
    const eAB = ptsOn(kEdges, kEdgeCount, kEdgeLo, keptEdgePts, ids[0], ids[1]);
    const eBC = ptsOn(kEdges, kEdgeCount, kEdgeLo, keptEdgePts, ids[1], ids[2]);
    const eCA = ptsOn(kEdges, kEdgeCount, kEdgeLo, keptEdgePts, ids[2], ids[0]);
    if (eAB.length || eBC.length || eCA.length) {
      stats.keptSplit++;
      splitTri([keptPos[b], keptPos[b + 1], keptPos[b + 2]], [keptPos[b + 3], keptPos[b + 4], keptPos[b + 5]],
        [keptPos[b + 6], keptPos[b + 7], keptPos[b + 8]], eAB, eBC, eCA, out);
    } else {
      out.push(keptPos[b], keptPos[b + 1], keptPos[b + 2], keptPos[b + 3], keptPos[b + 4],
        keptPos[b + 5], keptPos[b + 6], keptPos[b + 7], keptPos[b + 8]);
    }
  }
  for (let t = 0; t < nTex; t++) {
    const ids = [tVid[t * 3], tVid[t * 3 + 1], tVid[t * 3 + 2]];
    if (ids[0] === ids[1] || ids[1] === ids[2] || ids[0] === ids[2]) continue;
    const P = ids.map(i => [tVert[i * 3], tVert[i * 3 + 1], tVert[i * 3 + 2]]);
    // Two corners snapped onto the same original corner: the sliver is gone.
    const same = (p, q) => p[0] === q[0] && p[1] === q[1] && p[2] === q[2];
    if (same(P[0], P[1]) || same(P[1], P[2]) || same(P[0], P[2])) { stats.collapsed = (stats.collapsed || 0) + 1; continue; }
    const eAB = ptsOn(tEdges, tEdgeCount, tEdgeLo, texEdgePts, ids[0], ids[1]);
    const eBC = ptsOn(tEdges, tEdgeCount, tEdgeLo, texEdgePts, ids[1], ids[2]);
    const eCA = ptsOn(tEdges, tEdgeCount, tEdgeLo, texEdgePts, ids[2], ids[0]);
    if (eAB.length || eBC.length || eCA.length) stats.texturedSplit++;
    splitTri(P[0], P[1], P[2], eAB, eBC, eCA, out);
  }
  return { positions: out.result(), stats };
}
