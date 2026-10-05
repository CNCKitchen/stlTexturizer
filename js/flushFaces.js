/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * flushFaces.js — make the texture end flush with the untextured faces.
 *
 * Where a textured surface meets an untextured (masked) face, the shared seam
 * is pinned, so the texture next to it either pokes past that face (a round
 * running tangent into a flat top: bumps rise above the top) or hangs over it
 * (a wall meeting the bed: the texture's base forms a lip). Both are fixed by
 * treating each untextured face's PLANE at the seam as the limit of the
 * texture, as if the face were extended outward through it:
 *
 *   1. Clamp: textured vertices near the seam may not cross the plane. Ones
 *      that do are projected back onto it, so a bump is cut off flat, level
 *      with the face.
 *   2. Extend: each seam vertex gets a twin pushed out sideways, within the
 *      plane, by the mean of how far the texture moved the textured vertices
 *      next to it. The textured surface takes the twins and a strip of
 *      triangles in the plane joins them to the untouched face: the face now
 *      continues out to meet the texture (on the bed: the wall stands on it).
 *
 * The untextured faces themselves are never moved, and the mesh stays
 * watertight (every copy of a position moves together; the strip pairs
 * half-edges with both sides). A seam vertex gets no plane where the
 * untextured faces around it are not flat (normals > ~10° apart: a curved
 * face or a corner between two faces); a twin is skipped where the in-plane
 * move is < MIN_OUT or points back into the face, where it would flip a
 * textured triangle against its pre-displacement facing, or where the point
 * would land on an untextured face (a small textured patch between coplanar
 * untextured faces, e.g. inside a hole) — the same guard applies to clamps.
 *
 * Runs on the displaced mesh in export mode (exportPipeline.js); the appended
 * strip triangles are locked in decimation.
 */

import { QuantizedPointMap, IntPairMap } from './meshIndex.js';
import { BoxGrid, distPointTri2 } from './preserveStitch.js';

const MIN_OUT = 0.02;           // mm: a smaller sideways move leaves a negligible lip
const FLAT_COS = Math.cos(10 * Math.PI / 180);
const EPS = 1e-5;

/**
 * @param {Float32Array} dispPos   displaced triangle soup
 * @param {Float32Array} origPos   the same triangles before displacement
 * @param {Float32Array|null} excludeWeight  per corner, > 0.99 = untextured face
 * @param {object} [opts]  reach (mm): how far from a seam the clamp acts
 * @returns {{ positions: Float32Array, strips: number, twins: number, clamped: number }}
 *   positions: dispPos with the clamps and twins applied and the strip
 *   triangles appended (the first dispPos.length/9 triangles keep their order).
 */
export function flushToUntextured(dispPos, origPos, excludeWeight, opts = {}) {
  const none = { positions: dispPos, strips: 0, twins: 0, clamped: 0 };
  if (!excludeWeight) return none;
  const reach = opts.reach ?? 3;
  const corners = dispPos.length / 3, nTri = corners / 3;

  const weld = new QuantizedPointMap(1e5, Math.min(corners, 1 << 22));
  const vid = new Int32Array(corners);
  let nV = 0;
  for (let i = 0; i < corners; i++) {
    vid[i] = weld.getOrSet(origPos[i * 3], origPos[i * 3 + 1], origPos[i * 3 + 2], nV);
    if (weld.inserted) nV++;
  }
  // Welded positions: original (o*) and displaced (d*).
  const ox = new Float64Array(nV), oy = new Float64Array(nV), oz = new Float64Array(nV);
  const dx = new Float64Array(nV), dy = new Float64Array(nV), dz = new Float64Array(nV);
  for (let i = 0; i < corners; i++) {
    const v = vid[i];
    ox[v] = origPos[i * 3]; oy[v] = origPos[i * 3 + 1]; oz[v] = origPos[i * 3 + 2];
    dx[v] = dispPos[i * 3]; dy[v] = dispPos[i * 3 + 1]; dz[v] = dispPos[i * 3 + 2];
  }
  const masked = new Uint8Array(nTri);
  for (let t = 0; t < nTri; t++) masked[t] = excludeWeight[t * 3] > 0.99 ? 1 : 0;

  // Original unit face normals.
  const fn = new Float64Array(nTri * 3);
  for (let t = 0; t < nTri; t++) {
    const p = t * 9;
    const ux = origPos[p + 3] - origPos[p], uy = origPos[p + 4] - origPos[p + 1], uz = origPos[p + 5] - origPos[p + 2];
    const wx = origPos[p + 6] - origPos[p], wy = origPos[p + 7] - origPos[p + 1], wz = origPos[p + 8] - origPos[p + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const l = Math.hypot(nx, ny, nz) || 1;
    fn[t * 3] = nx / l; fn[t * 3 + 1] = ny / l; fn[t * 3 + 2] = nz / l;
  }

  // Seam edges: between an untextured and a textured triangle. Remember the
  // textured triangle's winding (from → to) for the strip.
  const edges = new IntPairMap(corners);
  const eMasked = [], eFrom = [], eTo = [];
  for (let t = 0; t < nTri; t++) {
    for (let e = 0; e < 3; e++) {
      const u = vid[t * 3 + e], v = vid[t * 3 + (e + 1) % 3];
      if (u === v) continue;
      const lo = u < v ? u : v, hi = u < v ? v : u;
      const s = edges.getOrSet(lo, hi, eMasked.length);
      if (edges.inserted) { eMasked.push(0); eFrom.push(-1); eTo.push(-1); }
      if (masked[t]) eMasked[s] = 1;
      else { eFrom[s] = t * 3 + e; eTo[s] = t * 3 + (e + 1) % 3; }
    }
  }
  const seam = new Uint8Array(nV);
  let anySeam = false;
  for (let s = 0; s < eMasked.length; s++) {
    if (!eMasked[s] || eFrom[s] < 0) continue;
    seam[vid[eFrom[s]]] = 1; seam[vid[eTo[s]]] = 1; anySeam = true;
  }
  if (!anySeam) return none;

  // Plane per seam vertex: the untextured triangles around it, if flat.
  // pn = unit normal.
  const pnx = new Float64Array(nV), pny = new Float64Array(nV), pnz = new Float64Array(nV);
  const pCount = new Uint32Array(nV);
  const firstN = new Float64Array(nV * 3);
  const flat = new Uint8Array(nV);
  for (let v = 0; v < nV; v++) flat[v] = seam[v];
  for (let t = 0; t < nTri; t++) {
    if (!masked[t]) continue;
    for (let c = 0; c < 3; c++) {
      const v = vid[t * 3 + c];
      if (!seam[v] || !flat[v]) continue;
      const nx = fn[t * 3], ny = fn[t * 3 + 1], nz = fn[t * 3 + 2];
      if (pCount[v] === 0) { firstN[v * 3] = nx; firstN[v * 3 + 1] = ny; firstN[v * 3 + 2] = nz; }
      else if (nx * firstN[v * 3] + ny * firstN[v * 3 + 1] + nz * firstN[v * 3 + 2] < FLAT_COS) { flat[v] = 0; continue; }
      pnx[v] += nx; pny[v] += ny; pnz[v] += nz;
      pCount[v]++;
    }
  }
  for (let v = 0; v < nV; v++) {
    if (!flat[v] || !pCount[v]) { flat[v] = 0; continue; }
    // A seam vertex the texture moved isn't pinned: leave it alone.
    if (Math.hypot(dx[v] - ox[v], dy[v] - oy[v], dz[v] - oz[v]) > EPS) { flat[v] = 0; continue; }
    const l = Math.hypot(pnx[v], pny[v], pnz[v]) || 1;
    pnx[v] /= l; pny[v] /= l; pnz[v] /= l;
  }

  // Untextured surface, for the "would land on an untextured face" guard.
  let maskedGrid = null, mEdgeSum = 0, mEdgeN = 0;
  for (let t = 0; t < nTri; t++) {
    if (!masked[t]) continue;
    const p = t * 9;
    mEdgeSum += Math.hypot(origPos[p + 3] - origPos[p], origPos[p + 4] - origPos[p + 1], origPos[p + 5] - origPos[p + 2]);
    mEdgeN++;
  }
  const GUARD = 0.01;
  if (mEdgeN) {
    maskedGrid = new BoxGrid(Math.max(GUARD * 8, mEdgeSum / mEdgeN));
    for (let t = 0; t < nTri; t++) {
      if (!masked[t]) continue;
      const p = t * 9;
      maskedGrid.add(t,
        Math.min(origPos[p], origPos[p + 3], origPos[p + 6]) - GUARD,
        Math.min(origPos[p + 1], origPos[p + 4], origPos[p + 7]) - GUARD,
        Math.min(origPos[p + 2], origPos[p + 5], origPos[p + 8]) - GUARD,
        Math.max(origPos[p], origPos[p + 3], origPos[p + 6]) + GUARD,
        Math.max(origPos[p + 1], origPos[p + 4], origPos[p + 7]) + GUARD,
        Math.max(origPos[p + 2], origPos[p + 5], origPos[p + 8]) + GUARD);
    }
  }
  const _q = [0, 0, 0];
  const onMasked = (x, y, z) => {
    if (!maskedGrid) return false;
    _q[0] = x; _q[1] = y; _q[2] = z;
    let hit = false;
    // Inside a face only: on its plane AND projecting within it. A point just
    // past an edge (where a clamp or twin belongs) is near the face but not in it.
    maskedGrid.forEach(x, y, z, (t) => {
      if (hit) return;
      const d2 = distPointTri2(_q, t * 9, origPos);
      if (d2 > GUARD * GUARD) return;
      const n0 = fn[t * 3], n1 = fn[t * 3 + 1], n2 = fn[t * 3 + 2], p = t * 9;
      const dp = (x - origPos[p]) * n0 + (y - origPos[p + 1]) * n1 + (z - origPos[p + 2]) * n2;
      if (Math.abs(d2 - dp * dp) <= 1e-12) hit = true; // nearest point is interior
    });
    return hit;
  };

  // Outward direction per flat seam vertex: in its plane, perpendicular to
  // the seam edges through it, pointing away from the untextured triangle on
  // each edge (the centroid of a fan of long thin triangles is no guide).
  const mx0 = new Float64Array(nV), my0 = new Float64Array(nV), mz0 = new Float64Array(nV);
  {
    // untextured triangle per seam edge
    const eTri = new Int32Array(eMasked.length).fill(-1);
    for (let t = 0; t < nTri; t++) {
      if (!masked[t]) continue;
      for (let e = 0; e < 3; e++) {
        const u = vid[t * 3 + e], v = vid[t * 3 + (e + 1) % 3];
        if (u === v) continue;
        const k = edges.get(u < v ? u : v, u < v ? v : u);
        if (k >= 0 && eFrom[k] >= 0) eTri[k] = t;
      }
    }
    for (let k = 0; k < eMasked.length; k++) {
      if (!eMasked[k] || eFrom[k] < 0 || eTri[k] < 0) continue;
      const a = vid[eFrom[k]], b = vid[eTo[k]], t = eTri[k];
      let ex = ox[b] - ox[a], ey = oy[b] - oy[a], ez = oz[b] - oz[a];
      const L = Math.hypot(ex, ey, ez); if (!(L > 0)) continue;
      ex /= L; ey /= L; ez /= L;
      // third vertex of the untextured triangle
      let c = -1;
      for (let q = 0; q < 3; q++) { const w = vid[t * 3 + q]; if (w !== a && w !== b) c = w; }
      if (c < 0) continue;
      for (const s of [a, b]) {
        if (!flat[s]) continue;
        let px = pny[s] * ez - pnz[s] * ey, py = pnz[s] * ex - pnx[s] * ez, pz = pnx[s] * ey - pny[s] * ex;
        if (px * (ox[c] - ox[a]) + py * (oy[c] - oy[a]) + pz * (oz[c] - oz[a]) > 0) { px = -px; py = -py; pz = -pz; }
        mx0[s] += px; my0[s] += py; mz0[s] += pz;
      }
    }
    for (let v = 0; v < nV; v++) {
      if (!flat[v]) continue;
      const l = Math.hypot(mx0[v], my0[v], mz0[v]);
      if (!(l > 1e-9)) { flat[v] = 0; continue; }
      mx0[v] /= l; my0[v] /= l; mz0[v] /= l;
    }
  }

  // ── 1. Clamp textured vertices near a seam onto its plane ───────────────
  // Nearest flat seam vertex by ORIGINAL position (grid of cell = reach).
  const isTex = new Uint8Array(nV);       // touches a textured triangle
  const isMaskedV = new Uint8Array(nV);   // touches an untextured triangle
  for (let t = 0; t < nTri; t++) for (let c = 0; c < 3; c++) {
    if (masked[t]) isMaskedV[vid[t * 3 + c]] = 1; else isTex[vid[t * 3 + c]] = 1;
  }
  const cell = reach, inv = 1 / cell, grid = new Map();
  const gkey = (i, j, k) => ((i * 73856093) ^ (j * 19349663) ^ (k * 83492791)) | 0;
  for (let v = 0; v < nV; v++) {
    if (!flat[v]) continue;
    const k = gkey(Math.floor(ox[v] * inv), Math.floor(oy[v] * inv), Math.floor(oz[v] * inv));
    const l = grid.get(k); if (l) l.push(v); else grid.set(k, [v]);
  }
  let clamped = 0;
  const reach2 = reach * reach;
  for (let v = 0; v < nV; v++) {
    if (!isTex[v] || isMaskedV[v]) continue;
    const ci = Math.floor(ox[v] * inv), cj = Math.floor(oy[v] * inv), ck = Math.floor(oz[v] * inv);
    let best = reach2, s = -1;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      const l = grid.get(gkey(ci + a, cj + b, ck + c));
      if (!l) continue;
      for (const w of l) {
        const d2 = (ox[w] - ox[v]) ** 2 + (oy[w] - oy[v]) ** 2 + (oz[w] - oz[v]) ** 2;
        if (d2 < best) { best = d2; s = w; }
      }
    }
    if (s < 0) continue;
    // Only vertices that started on the inner side of the plane.
    if ((ox[v] - ox[s]) * pnx[s] + (oy[v] - oy[s]) * pny[s] + (oz[v] - oz[s]) * pnz[s] > EPS) continue;
    const over = (dx[v] - ox[s]) * pnx[s] + (dy[v] - oy[s]) * pny[s] + (dz[v] - oz[s]) * pnz[s];
    if (over <= 0) continue;
    // ...and only beyond the face's edge: projected onto the plane, the point
    // must lie outward of the seam (away from the face's interior), never
    // over the face itself, where it would fold onto it.
    {
      const px = dx[v] - over * pnx[s] - ox[s], py = dy[v] - over * pny[s] - oy[s], pz = dz[v] - over * pnz[s] - oz[s];
      if (px * mx0[s] + py * my0[s] + pz * mz0[s] <= 0) continue;
      if (onMasked(px + ox[s], py + oy[s], pz + oz[s])) continue;
    }
    dx[v] -= over * pnx[s]; dy[v] -= over * pny[s]; dz[v] -= over * pnz[s];
    clamped++;
  }

  // ── 2. Twins: seam vertices pushed out within their plane ───────────────
  const sx = new Float64Array(nV), sy = new Float64Array(nV), sz = new Float64Array(nV), sn = new Uint32Array(nV);
  for (let t = 0; t < nTri; t++) {
    if (masked[t]) continue;
    for (let c = 0; c < 3; c++) {
      const s = vid[t * 3 + c];
      if (!flat[s]) continue;
      for (let k = 0; k < 3; k++) {
        const w = vid[t * 3 + k];
        if (seam[w]) continue;
        sx[s] += dx[w] - ox[w]; sy[s] += dy[w] - oy[w]; sz[s] += dz[w] - oz[w]; sn[s]++;
      }
    }
  }
  const twin = new Uint8Array(nV);
  const tx = new Float64Array(nV), ty = new Float64Array(nV), tz = new Float64Array(nV);
  for (let v = 0; v < nV; v++) {
    if (!flat[v] || !sn[v]) continue;
    let mx = sx[v] / sn[v], my = sy[v] / sn[v], mz = sz[v] / sn[v];
    const along = mx * pnx[v] + my * pny[v] + mz * pnz[v];
    mx -= along * pnx[v]; my -= along * pny[v]; mz -= along * pnz[v];
    if (Math.hypot(mx, my, mz) < MIN_OUT) continue;
    // Must point away from the untextured face's interior.
    if (mx * mx0[v] + my * my0[v] + mz * mz0[v] <= 0) continue;
    if (onMasked(ox[v] + mx, oy[v] + my, oz[v] + mz)) continue;
    twin[v] = 1; tx[v] = ox[v] + mx; ty[v] = oy[v] + my; tz[v] = oz[v] + mz;
  }

  // Cancel twins that would flip a textured triangle against its original
  // facing (not the displaced one: next to the seam that is the lip itself).
  const P = new Float64Array(9);
  const normalOf = (t, useTwin) => {
    for (let c = 0; c < 3; c++) {
      const v = vid[t * 3 + c];
      if (!useTwin) { P[c * 3] = ox[v]; P[c * 3 + 1] = oy[v]; P[c * 3 + 2] = oz[v]; continue; }
      const tw = twin[v];
      P[c * 3] = tw ? tx[v] : dx[v]; P[c * 3 + 1] = tw ? ty[v] : dy[v]; P[c * 3 + 2] = tw ? tz[v] : dz[v];
    }
    const ux = P[3] - P[0], uy = P[4] - P[1], uz = P[5] - P[2], wx = P[6] - P[0], wy = P[7] - P[1], wz = P[8] - P[2];
    return [uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx];
  };
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (let t = 0; t < nTri; t++) {
      if (masked[t]) continue;
      const a = vid[t * 3], b = vid[t * 3 + 1], c = vid[t * 3 + 2];
      if (!twin[a] && !twin[b] && !twin[c]) continue;
      const n0 = normalOf(t, false), n1 = normalOf(t, true);
      const a1 = n1[0] * n1[0] + n1[1] * n1[1] + n1[2] * n1[2];
      if (a1 > 1e-20 && n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2] > 0) continue;
      twin[a] = twin[b] = twin[c] = 0; changed = true;
    }
    if (!changed) break;
  }

  // ── Apply ────────────────────────────────────────────────────────────────
  const moved = new Float32Array(dispPos.length);
  let twins = 0;
  const counted = new Uint8Array(nV);
  for (let i = 0; i < corners; i++) {
    const v = vid[i], t = (i / 3) | 0;
    if (!masked[t] && twin[v]) {
      moved[i * 3] = tx[v]; moved[i * 3 + 1] = ty[v]; moved[i * 3 + 2] = tz[v];
      if (!counted[v]) { counted[v] = 1; twins++; }
    } else if (masked[t]) {
      moved[i * 3] = dispPos[i * 3]; moved[i * 3 + 1] = dispPos[i * 3 + 1]; moved[i * 3 + 2] = dispPos[i * 3 + 2];
    } else {
      moved[i * 3] = dx[v]; moved[i * 3 + 1] = dy[v]; moved[i * 3 + 2] = dz[v];
    }
  }
  const out = [];
  for (let s = 0; s < eMasked.length; s++) {
    if (!eMasked[s] || eFrom[s] < 0) continue;
    const a = vid[eFrom[s]], b = vid[eTo[s]];
    if (!twin[a] && !twin[b]) continue;
    // Original edge a→b (as the textured side had it), twins a'→b' (as it
    // has now): quad (a, b, b', a') pairs a→b with the untextured face and
    // b'→a' with the textured surface.
    const A = [ox[a], oy[a], oz[a]], B = [ox[b], oy[b], oz[b]];
    const A2 = twin[a] ? [tx[a], ty[a], tz[a]] : A, B2 = twin[b] ? [tx[b], ty[b], tz[b]] : B;
    if (twin[b]) out.push(...A, ...B, ...B2);
    if (twin[a]) out.push(...A, ...B2, ...A2);
  }
  const positions = new Float32Array(moved.length + out.length);
  positions.set(moved);
  positions.set(out, moved.length);
  return { positions, strips: out.length / 9, twins, clamped };
}
