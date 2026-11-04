/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Outline wrap (projection mode 8): the texture runs along the part's outline
 * around +Z instead of by angle, so a regular pattern keeps its cell size and
 * stays unbroken around every corner of a box-like part.
 *
 * The tables (buildOutlineWrap) come from the mesh once:
 *   - Cuts across Z every OUTLINE_CUT_STEP_MM or less, each in the middle of
 *     its step. The outline of a cut is its largest closed loop.
 *   - A point finds its place on the outline by its angle around the centre
 *     of the bounding box (XY). So the outline must go around the centre, and
 *     a ray from the centre must cross it once. A small fold (a step or a
 *     recess whose wall faces away from the centre) may hide up to
 *     OUTLINE_FOLD_MM of the outline; the distance jumps by the hidden length
 *     there. A pocket under the outline's convex hull no deeper than
 *     OUTLINE_POCKET_MM (an engraved letter) takes the hull's edge, so it does
 *     not shift the pattern from one cut to the next.
 *   - A cut whose loop runs along cap faces (within OUTLINE_CAP_FLAT_DEG of Z)
 *     for more than OUTLINE_CAP_RUN_MM counts as none: near an end that tilts
 *     off the axis, the cut crosses the end face.
 *   - The seam lies on the side that faces -Y. u runs counterclockwise seen
 *     from +Z (to the right on a face seen from outside, with v up), as the
 *     cylindrical mapping does.
 *
 * Whole repeats around each height (computeUV in mapping.js): with P one
 * repeat of the image along u, n = round(mean outline length / P), at least 1,
 * and L* = n·P, a point at the share s = u / L(h) of its outline takes
 * u' = s·L* and v' = L*·rise, where rise = ∫ dz / L(z) from the bottom of the
 * part. So the n repeats fit the outline exactly at every height (the pattern
 * closes on itself at the seam), and each repeat's height grows and shrinks
 * with its width where the outline changes along Z (a pot's draft).
 *
 * Imports only meshIndex.js, so the workers load it as it is.
 *
 * Rotation: by a multiple of 90° the n repeats stay whole along the image's
 * axes; any other rotation turns them into a fraction, so the seam shows.
 */

import { QuantizedPointMap } from './meshIndex.js';

/** The weld grid of the mesh's corners (10 nm cells, as subdivision and displacement weld). */
const WELD_QUANT = 1e5;

export const OUTLINE_CUT_STEP_MM = 0.5;
export const OUTLINE_FOLD_MM = 2;
export const OUTLINE_POCKET_MM = 2;
export const OUTLINE_CAP_RUN_MM = 2;
/** A face whose normal lies within this angle of Z takes a flat XY projection (the top and bottom caps). */
export const OUTLINE_CAP_FLAT_DEG = 20;
/** From OUTLINE_CAP_FLAT_DEG to this angle the cap and the side blend (smoothstep); beyond it, the side alone. */
export const OUTLINE_CAP_WRAP_DEG = 30;

const TWO_PI = Math.PI * 2;
/** The seam's angle around the centre: the -Y side. */
const SEAM = -Math.PI / 2;

const turn = (a) => { const r = a % TWO_PI; return r < 0 ? r + TWO_PI : r; };   // [0, 2π)
const half = (a) => { const r = turn(a); return r > Math.PI ? r - TWO_PI : r; }; // (-π, π]
const mm = (v) => String(Number(v.toFixed(2)));

/**
 * Weight of the flat cap projection for a normal whose Z component (of a unit
 * normal) is `nz`: 1 within OUTLINE_CAP_FLAT_DEG of the axis, 0 beyond
 * OUTLINE_CAP_WRAP_DEG, a smoothstep between. Mirrored in previewMaterial.js.
 */
export function outlineWrapCapWeight(nz) {
  const off = Math.acos(Math.min(1, Math.abs(nz))) * 180 / Math.PI;
  if (off <= OUTLINE_CAP_FLAT_DEG) return 1;
  if (off >= OUTLINE_CAP_WRAP_DEG) return 0;
  const t = (OUTLINE_CAP_WRAP_DEG - off) / (OUTLINE_CAP_WRAP_DEG - OUTLINE_CAP_FLAT_DEG);
  return t * t * (3 - 2 * t);
}

/**
 * Build the outline tables of the triangle soup `positions` (x, y, z per
 * corner, 9 numbers per triangle). Throws an Error with one sentence when the
 * outline wrap cannot follow the part: no cut gives an outline of its sides,
 * or a cut's outline does not go around the centre of the bounding box, or a
 * fold hides more than OUTLINE_FOLD_MM of it.
 *
 * @param {ArrayLike<number>} positions
 * @returns {{ cx:number, cy:number, minZ:number, maxZ:number, meanLength:number,
 *             cuts: { z:number, theta:Float64Array, s:Float64Array, x:Float64Array, y:Float64Array, rise:number }[] }}
 */
export function buildOutlineWrap(positions) {
  const corners = Math.floor(positions.length / 3);
  const triangles = Math.floor(corners / 3);

  // One id per welded position, so each edge of the mesh has one key.
  const ids = new Int32Array(corners);
  const seen = new QuantizedPointMap(WELD_QUANT, Math.min(corners, 1 << 22));
  const vx = [], vy = [], vz = [];
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let c = 0; c < corners; c++) {
    const x = positions[3 * c], y = positions[3 * c + 1], z = positions[3 * c + 2];
    const id = seen.getOrSet(x, y, z, vx.length);
    if (seen.inserted) {
      vx.push(x); vy.push(y); vz.push(z);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    ids[c] = id;
  }
  const vertices = vx.length;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  const range = maxZ - minZ;
  const count = Math.max(1, Math.ceil(range / OUTLINE_CUT_STEP_MM));
  const step = range / count;
  const heights = Array.from({ length: count }, (_, k) => minZ + (k + 0.5) * step);
  const segments = heights.map(() => ({ from: [], to: [], x: [], y: [], toX: [], toY: [], cap: [] }));
  const capCos = Math.cos(OUTLINE_CAP_FLAT_DEG * Math.PI / 180);

  for (let t = 0; t < triangles; t++) {
    const v = [ids[3 * t], ids[3 * t + 1], ids[3 * t + 2]];
    const zs = v.map((id) => vz[id]);
    const lo = Math.min(...zs);
    const hi = Math.max(...zs);
    if (!(hi > lo) || step === 0) continue;
    // The normal by the winding: the outline runs along z × n, counterclockwise for an outward normal.
    const ax = vx[v[1]] - vx[v[0]], ay = vy[v[1]] - vy[v[0]], az = vz[v[1]] - vz[v[0]];
    const bx = vx[v[2]] - vx[v[0]], by = vy[v[2]] - vy[v[0]], bz = vz[v[2]] - vz[v[0]];
    const nx = ay * bz - az * by;
    const ny = az * bx - ax * bz;
    const nz = ax * by - ay * bx;
    const area = Math.hypot(nx, ny, nz);
    const cap = area > 0 && Math.abs(nz) >= capCos * area;
    const first = Math.max(0, Math.floor((lo - heights[0]) / step));
    const last = Math.min(count - 1, Math.ceil((hi - heights[0]) / step));
    for (let k = first; k <= last; k++) {
      const h = heights[k];
      const ends = [];
      for (let e = 0; e < 3; e++) {
        const a = v[e];
        const b = v[(e + 1) % 3];
        // A corner on the cut counts as above it, so every edge the cut crosses has one corner on each side.
        if ((vz[a] >= h) === (vz[b] >= h)) continue;
        const [below, above] = vz[a] < h ? [a, b] : [b, a];
        const f = (h - vz[below]) / (vz[above] - vz[below]);
        ends.push([Math.min(a, b) * vertices + Math.max(a, b), vx[below] + f * (vx[above] - vx[below]), vy[below] + f * (vy[above] - vy[below])]);
      }
      if (ends.length !== 2) continue;
      let [start, end] = ends;
      if ((end[1] - start[1]) * -ny + (end[2] - start[2]) * nx < 0) [start, end] = [end, start];
      const cut = segments[k];
      cut.from.push(start[0]); cut.to.push(end[0]);
      cut.x.push(start[1]); cut.y.push(start[2]);
      cut.toX.push(end[1]); cut.toY.push(end[2]);
      cut.cap.push(cap);
    }
  }

  const outlines = [];
  heights.forEach((h, k) => {
    const loop = largestLoop(segments[k]);
    if (loop === null || loop.capRun > OUTLINE_CAP_RUN_MM) return;
    const table = cutTable(h, loop.x, loop.y, cx, cy);
    if (typeof table !== 'string') outlines.push(table);
    else if (loop.capRun === 0) throw new Error(table);
  });
  if (outlines.length === 0) throw new Error('No cut of the part across Z gives an outline of its sides, so the outline wrap has nothing to follow.');

  // The rise of each cut from the bottom of the part: below the first cut its length holds; between two cuts the
  // length runs linearly from one to the next, as outlineWrapPlace interpolates it.
  const lengths = outlines.map(lengthOf);
  const cuts = [];
  let rise = (outlines[0].z - minZ) / lengths[0];
  outlines.forEach((outline, k) => {
    if (k > 0) rise += riseAcross(lengths[k - 1], lengths[k], outline.z - outlines[k - 1].z, 1);
    cuts.push({ ...outline, rise });
  });
  const meanLength = lengths.reduce((sum, l) => sum + l, 0) / lengths.length;
  return { cx, cy, minZ, maxZ, meanLength, cuts };
}

/**
 * The place of a point on the outline wrap: its `share` of the outline from
 * the seam (0 up to 1) and its `rise` (∫ dz / L(z) from the bottom of the
 * part, dimensionless). Neither depends on the tile: computeUV scales both by
 * L* (relative units) to tile them.
 */
export function outlineWrapPlace(wrap, x, y, z) {
  const phi = turn(Math.atan2(y - wrap.cy, x - wrap.cx) - SEAM);
  const { cuts } = wrap;
  let k = 0;
  let t = 0;
  if (z >= cuts[cuts.length - 1].z) k = cuts.length - 1;
  else if (z > cuts[0].z) {
    let hi = cuts.length - 1;
    while (k + 1 < hi) {
      const mid = (k + hi) >> 1;
      if (cuts[mid].z <= z) k = mid; else hi = mid;
    }
    t = (z - cuts[k].z) / (cuts[k + 1].z - cuts[k].z);
  }
  const a = cuts[k];
  const u0 = along(a, phi, wrap.cx, wrap.cy);
  const l0 = lengthOf(a);
  if (t === 0) return { share: u0 / l0, rise: a.rise + (z - a.z) / l0 };
  const b = cuts[k + 1];
  const u1 = along(b, phi, wrap.cx, wrap.cy);
  const l1 = lengthOf(b);
  const length = l0 + t * (l1 - l0);
  return { share: (u0 + t * (u1 - u0)) / length, rise: a.rise + riseAcross(l0, l1, b.z - a.z, t) };
}

/**
 * The places of every corner of the triangle soup `positions` (2 floats per
 * corner: share, rise), for the preview's per-vertex attribute. Within each
 * triangle the shares of the second and third corner shift by ±1 to lie
 * within half a turn of the first, so a triangle across the seam interpolates
 * across it; u' = share·n moves by the whole number n there, so the repeating
 * texture lines up.
 */
export function outlineWrapPlaces(wrap, positions) {
  const corners = Math.floor(positions.length / 3);
  const out = new Float32Array(corners * 2);
  for (let c = 0; c < corners; c++) {
    const p = outlineWrapPlace(wrap, positions[3 * c], positions[3 * c + 1], positions[3 * c + 2]);
    out[2 * c] = p.share;
    out[2 * c + 1] = p.rise;
  }
  for (let c = 0; c + 2 < corners; c += 3) {
    const s0 = out[2 * c];
    for (let i = 1; i < 3; i++) {
      const k = 2 * (c + i);
      if (out[k] - s0 > 0.5) out[k] -= 1;
      else if (s0 - out[k] > 0.5) out[k] += 1;
    }
  }
  return out;
}

// ── Internal ──────────────────────────────────────────────────────────────────

const lengthOf = (outline) => outline.s[outline.s.length - 1];

/**
 * ∫ dz / L over the first `t` (0..1) of a step `span` mm long, where L runs
 * linearly from `from` to `to` across the step — exact, so v' grows by L* / L(z)
 * per mm of height wherever outlineWrapPlace interpolates the length.
 */
function riseAcross(from, to, span, t) {
  const x = (to - from) * t / from;
  return span * t * (x === 0 ? 1 : Math.log1p(x) / x) / from;
}

/**
 * The closed loop of largest area that a cut's segments make, counterclockwise,
 * and the length of it that lies on cap faces; null for none. The walk follows
 * the edge keys, each segment in its own direction where it can (a zero-area
 * triangle's segment has none, so the walk takes one backward where nothing
 * leads on). A chain that does not close (a hole in the mesh) is no loop.
 */
function largestLoop(cut) {
  const index = (keys) => {
    const map = new Map();
    keys.forEach((key, i) => {
      const list = map.get(key);
      if (list) list.push(i); else map.set(key, [i]);
    });
    return map;
  };
  const byFrom = index(cut.from);
  const byTo = index(cut.to);
  const used = new Uint8Array(cut.from.length);
  let best = null;
  let bestArea = 0;
  for (let i = 0; i < cut.from.length; i++) {
    if (used[i]) continue;
    const x = [], y = [];
    let capRun = 0;
    let at = i;
    let forward = true;
    let closed = false;
    for (;;) {
      used[at] = 1;
      x.push(forward ? cut.x[at] : cut.toX[at]);
      y.push(forward ? cut.y[at] : cut.toY[at]);
      if (cut.cap[at]) capRun += Math.hypot(cut.toX[at] - cut.x[at], cut.toY[at] - cut.y[at]);
      const exit = forward ? cut.to[at] : cut.from[at];
      if (exit === cut.from[i]) { closed = true; break; }
      const ahead = byFrom.get(exit)?.find((j) => !used[j]);
      const back = ahead === undefined ? byTo.get(exit)?.find((j) => !used[j]) : undefined;
      if (ahead === undefined && back === undefined) break;
      forward = ahead !== undefined;
      at = ahead ?? back;
    }
    if (!closed) continue;
    let area = 0;
    for (let j = 0; j < x.length; j++) {
      const k = (j + 1) % x.length;
      area += x[j] * y[k] - x[k] * y[j];
    }
    if (Math.abs(area) <= Math.abs(bestArea)) continue;
    bestArea = area;
    best = { x, y, capRun };
  }
  if (best && bestArea < 0) { best.x.reverse(); best.y.reverse(); }
  return best;
}

/**
 * The outline with each pocket under its convex hull no deeper than
 * OUTLINE_POCKET_MM replaced by the hull's edge across it. A pocket is the run
 * of corners between two hull corners that follow each other on the outline.
 */
function fillShallowPockets(X, Y) {
  const n = X.length;
  if (n < 4) return { X, Y };
  const cross = (o, a, b) => (X[a] - X[o]) * (Y[b] - Y[o]) - (Y[a] - Y[o]) * (X[b] - X[o]);
  // Andrew's monotone chain (collinear corners left out), then in the outline's own order.
  const order = [...X.keys()].sort((a, b) => X[a] - X[b] || Y[a] - Y[b]);
  const chain = [];
  for (const pass of [order, [...order].reverse()]) {
    const start = chain.length;
    for (const i of pass) {
      while (chain.length >= start + 2 && cross(chain[chain.length - 2], chain[chain.length - 1], i) <= 0) chain.pop();
      chain.push(i);
    }
    chain.pop();
  }
  const hull = [...new Set(chain)].sort((a, b) => a - b);
  if (hull.length < 3) return { X, Y };
  const outX = [], outY = [];
  hull.forEach((a, k) => {
    const b = hull[(k + 1) % hull.length];
    outX.push(X[a]); outY.push(Y[a]);
    const edge = Math.hypot(X[b] - X[a], Y[b] - Y[a]);
    const pocket = [];
    let depth = 0;
    for (let i = (a + 1) % n; i !== b; i = (i + 1) % n) {
      pocket.push(i);
      if (edge > 0) depth = Math.max(depth, Math.abs(cross(a, b, i)) / edge);
    }
    if (depth > OUTLINE_POCKET_MM) for (const i of pocket) { outX.push(X[i]); outY.push(Y[i]); }
  });
  return { X: outX, Y: outY };
}

/**
 * The table of one cut's outline (counterclockwise) from the seam once
 * around, as the centre (cx, cy) sees it: `theta` (unwrapped angle), `s`
 * (distance from the seam; the last is the length) and the corners. Where the
 * outline folds back around the centre, the table holds only what the centre
 * sees and `s` jumps by the hidden length. Returns the reason as a sentence
 * instead when the outline does not go around the centre, or a fold hides
 * more than OUTLINE_FOLD_MM.
 */
function cutTable(z, x, y, cx, cy) {
  // Corners that repeat (a cut through a mesh corner) make zero-length steps.
  let X = [], Y = [];
  for (let i = 0; i < x.length; i++) {
    const j = (i + 1) % x.length;
    if (Math.hypot(x[j] - x[i], y[j] - y[i]) > 1e-12) { X.push(x[i]); Y.push(y[i]); }
  }
  ({ X, Y } = fillShallowPockets(X, Y));
  const n = X.length;
  const angle = X.map((xi, i) => Math.atan2(Y[i] - cy, xi - cx));
  const steps = angle.map((a, i) => half(angle[(i + 1) % n] - a));
  if (n < 3 || steps.reduce((sum, d) => sum + d, 0) < Math.PI) {
    return `At z = ${mm(z)} mm, the centre of the bounding box lies outside the part's outline, so the outline wrap cannot go around it.`;
  }

  // Three laps with the angle unwrapped and the length run on. The first lap only finds the largest angle so far,
  // so a fold across corner 0 counts whole in the second; the second and third lap hold the seam's window.
  const laps = 3 * n;
  const A = new Float64Array(laps + 1);
  const S = new Float64Array(laps + 1);
  A[0] = angle[0];
  for (let i = 0; i < laps; i++) {
    const a = i % n, b = (i + 1) % n;
    A[i + 1] = A[i] + steps[a];
    S[i + 1] = S[i] + Math.hypot(X[b] - X[a], Y[b] - Y[a]);
  }
  // The pieces the centre sees: each segment from where it first passes the largest angle so far, to its end.
  const pieces = [];
  let most = A[0];
  let seenS = 0;
  let hidden = 0;
  for (let i = 0; i < laps; i++) {
    if (A[i + 1] <= most) continue;
    const a = i % n, b = (i + 1) % n;
    const f = A[i] >= most ? 0 : fraction(X[a], Y[a], X[b], Y[b], most, cx, cy);
    const startS = S[i] + f * (S[i + 1] - S[i]);
    if (i >= n) {
      hidden = Math.max(hidden, startS - seenS);
      pieces.push([Math.max(A[i], most), startS, X[a] + f * (X[b] - X[a]), Y[a] + f * (Y[b] - Y[a]), A[i + 1], S[i + 1], X[b], Y[b]]);
    }
    seenS = S[i + 1];
    most = A[i + 1];
  }
  if (hidden > OUTLINE_FOLD_MM) {
    return `At z = ${mm(z)} mm, a ray from the centre of the bounding box crosses the part's outline more than once, and ${mm(hidden)} mm of the outline lies hidden from the centre, so the outline wrap cannot follow it.`;
  }

  // The window from the seam once around, cut at the seam on each side.
  const from = pieces[0][0] + turn(SEAM - pieces[0][0]);
  const to = from + TWO_PI;
  const theta = [], s = [], tx = [], ty = [];
  const push = (a, at, px, py) => { theta.push(a); s.push(at); tx.push(px); ty.push(py); };
  const cutAt = (piece, a) => {
    const f = fraction(piece[2], piece[3], piece[6], piece[7], a, cx, cy);
    return [a, piece[1] + f * (piece[5] - piece[1]), piece[2] + f * (piece[6] - piece[2]), piece[3] + f * (piece[7] - piece[3])];
  };
  for (const piece of pieces) {
    if (piece[4] <= from || piece[0] >= to) continue;
    const [a0, s0, x0, y0] = piece[0] < from ? cutAt(piece, from) : piece.slice(0, 4);
    const [a1, s1, x1, y1] = piece[4] > to ? cutAt(piece, to) : piece.slice(4, 8);
    push(a0, s0, x0, y0);
    push(a1, s1, x1, y1);
  }
  const zero = s[0];
  return { z, theta: Float64Array.from(theta), s: Float64Array.from(s, (v) => v - zero), x: Float64Array.from(tx), y: Float64Array.from(ty) };
}

/** Where the ray from (cx, cy) at angle `a` meets the segment (ax, ay)–(bx, by), as the fraction along it (0..1). */
function fraction(ax, ay, bx, by, a, cx, cy) {
  const rx = Math.cos(a), ry = Math.sin(a);
  const ex = bx - ax, ey = by - ay;
  const across = ex * ry - ey * rx;
  if (Math.abs(across) < 1e-15) return 0;
  const f = -((ax - cx) * ry - (ay - cy) * rx) / across;
  return Math.min(1, Math.max(0, f));
}

/** The distance along a cut's outline from the seam to its point at angle `phi` past the seam (0..2π). */
function along(cut, phi, cx, cy) {
  const { theta, s, x, y } = cut;
  const a = theta[0] + phi;
  let lo = 0;
  let hi = theta.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (theta[mid] <= a) lo = mid; else hi = mid - 1;
  }
  const f = fraction(x[lo], y[lo], x[lo + 1], y[lo + 1], a, cx, cy);
  return s[lo] + f * (s[lo + 1] - s[lo]);
}
