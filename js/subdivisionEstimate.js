/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Subdivision triangle-count simulator — predicts how many triangles
 * subdivide() produces for a target edge length without running it.
 *
 * Split out of smartResolution.js with no imports so it also loads inside
 * Web Workers (smartResolution.js pulls in stlLoader.js, whose bare
 * three/addons + fflate specifiers need the page import map).  Used by the
 * Smart resolution recommender and by the 3D-preview edge budget.
 */

// ── Subdivision triangle-count simulator ─────────────────────────────────────
//
// Walks the actual subdivide-pass logic shape-by-shape, using law-of-cosines
// medians for the 1→2 and 1→3 child-edge lengths.  Aggressively memoised on
// quantised (sorted-descending) edge tuples so duplicate CAD-tessellation
// triangles cost O(1).
//
// Per-triangle simulation matches global subdivide() because edge marking is
// purely a function of edge length (L > T?) — same decision regardless of
// which triangle the marked edge belongs to.  Empirically within ~5 % of the
// real subdivide() output across 3DBenchy, Barry Bear, Grip70mm, cone,
// cubeWithSmallFillets, laserPlate, and puerta texturized — vs the legacy
// closed-form K · area / edge² which underestimates by 3–7×.

function simTri(a, b, c, T, memo, depth) {
  // Sort descending: a ≥ b ≥ c.
  if (a < b) { const t = a; a = b; b = t; }
  if (b < c) { const t = b; b = c; c = t; }
  if (a < b) { const t = a; a = b; b = t; }

  // Quantise relative to T for cache.  256 bins per multiple of T → sub-percent
  // shape-resolution, ample for triangle-count accounting.
  const ka = Math.round((a / T) * 256);
  const kb = Math.round((b / T) * 256);
  const kc = Math.round((c / T) * 256);
  const key = ka * 0x40000000 + kb * 0x10000 + kc;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  // Match subdivide()'s 12-pass outer cap so deep slivers behave identically.
  if (depth > 12) { memo.set(key, 1); return 1; }

  const sa = a > T, sb = b > T, sc = c > T;
  const n = (sa ? 1 : 0) + (sb ? 1 : 0) + (sc ? 1 : 0);
  if (n === 0) { memo.set(key, 1); return 1; }

  let total;
  if (n === 3) {
    // 1→4 midpoint split: all four child shapes are (a/2, b/2, c/2).
    total = 4 * simTri(a / 2, b / 2, c / 2, T, memo, depth + 1);
  } else if (n === 1) {
    // 1→2 bisect: split edge a (longest), unsplit edges b and c stay intact in
    // separate children.  Median from opposite vertex to a's midpoint:
    //   m = ½ √(2b² + 2c² − a²)
    const m = 0.5 * Math.sqrt(Math.max(0, 2*b*b + 2*c*c - a*a));
    total = simTri(a / 2, b, m, T, memo, depth + 1)
          + simTri(a / 2, c, m, T, memo, depth + 1);
  } else {
    // n === 2: 1→3 fan.  Sorted descending → untouched edge is the smallest (c);
    // split neighbours are a and b.  Median from a's opposite vertex to a's
    // midpoint:  m = ½ √(2b² + 2c² − a²).
    const m = 0.5 * Math.sqrt(Math.max(0, 2*b*b + 2*c*c - a*a));
    total = simTri(c,     a / 2, m,     T, memo, depth + 1)
          + simTri(m,     c / 2, b / 2, T, memo, depth + 1)
          + simTri(b / 2, c / 2, a / 2, T, memo, depth + 1);
  }

  memo.set(key, total);
  return total;
}

/**
 * Pre-compute the three edge lengths of every triangle in `geometry`.
 * Returned Float64Array has 3 entries per triangle (no winding semantics).
 */
export function computeTriEdges(geometry) {
  const pos = geometry.attributes.position.array;
  const triCount = pos.length / 9;
  const out = new Float64Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    const ax = pos[o],   ay = pos[o+1], az = pos[o+2];
    const bx = pos[o+3], by = pos[o+4], bz = pos[o+5];
    const cx = pos[o+6], cy = pos[o+7], cz = pos[o+8];
    out[t*3]     = Math.hypot(bx-ax, by-ay, bz-az);
    out[t*3 + 1] = Math.hypot(cx-bx, cy-by, cz-bz);
    out[t*3 + 2] = Math.hypot(ax-cx, ay-cy, az-cz);
  }
  return out;
}

export function simulateFromEdges(triEdges, edge) {
  const memo = new Map();
  const triCount = triEdges.length / 3;
  let total = 0;
  for (let i = 0; i < triCount; i++) {
    const o = i * 3;
    const a = triEdges[o], b = triEdges[o+1], c = triEdges[o+2];
    if (a <= edge && b <= edge && c <= edge) { total += 1; continue; }
    total += simTri(a, b, c, edge, memo, 0);
  }
  return total;
}

/**
 * Predict the triangle count `subdivide(geometry, edge)` will produce, by
 * simulating the per-triangle split pattern.  Useful as a pre-flight check on
 * the user's chosen refineLength.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {number} edge  Target maximum edge length, same units as positions.
 * @returns {number} Predicted post-subdivision triangle count.
 */
export function estimateSubdivisionTriCount(geometry, edge) {
  if (!geometry || !geometry.attributes || !geometry.attributes.position) return 0;
  return simulateFromEdges(computeTriEdges(geometry), edge);
}

/**
 * Coarsen `startEdge` until the simulated subdivision count fits `budget`
 * (returned unchanged when it already fits).  Sim count scales ~1/edge², so
 * up to 3 ratio corrections multiply the edge by sqrt(predicted/budget).
 *
 * @param {Float64Array} triEdges  From computeTriEdges().
 * @param {number}       budget    Maximum simulated triangle count.
 * @param {number}       startEdge Finest edge to consider.
 * @returns {number} Edge length whose simulated count is ≤ budget.
 */
export function solveBudgetEdge(triEdges, budget, startEdge) {
  let edge = startEdge;
  for (let step = 0; step < 3; step++) {
    const simCount = simulateFromEdges(triEdges, edge);
    if (simCount <= budget) break;
    const correction = Math.sqrt(simCount / budget);
    if (correction < 1.005) break;          // converged
    edge = edge * correction;
  }
  // Guarantee the budget actually holds.  On near-uniform meshes (cube-like
  // CAD tessellations) the simulated count is a step function of the edge —
  // 12 × 4^k for the default cube — so the sqrt-ratio corrections above can
  // stall between split thresholds and finish a few percent over budget.
  // Walk coarser in 5% steps until the simulation fits; sim count is
  // monotonically non-increasing in edge length, so this always terminates.
  for (let step = 0; step < 24; step++) {
    if (simulateFromEdges(triEdges, edge) <= budget) break;
    edge *= 1.05;
  }
  return edge;
}
