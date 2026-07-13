/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Smart resolution — recommend a subdivision target edge length that
 *
 *   (a) is fine enough to resolve the active texture's detail at its
 *       current world-space scale, and
 *   (b) keeps the estimated post-subdivision triangle count within a
 *       conservative, device-independent slice of the subdivision safety
 *       cap (see HARD_CAP_TRIANGLES / HARD_CAP_HEADROOM below).
 *
 * The legacy default (bbox-diagonal / 250) ignores both texture frequency
 * and texture period, so it over-meshes smooth textures and under-meshes
 * fine ones.  This module replaces that heuristic when the user clicks
 * the "Smart" button next to the resolution slider.
 */

import { analyzeTexture } from './textureAnalysis.js';
import { computeSurfaceArea } from './stlLoader.js';
import {
  MODE_PLANAR_XY, MODE_PLANAR_XZ, MODE_PLANAR_YZ,
  MODE_CYLINDRICAL, MODE_SPHERICAL,
  MODE_TRIPLANAR, MODE_CUBIC,
} from './mapping.js';

// Conservative BASE of subdivision.js's SAFETY_CAP (which is adaptive since
// June 2026: 32M on Chrome/Edge machines reporting deviceMemory ≥ 8, 16M
// elsewhere).  Smart deliberately budgets against the 16M base on every
// machine so its recommended edge is device-independent — the same project
// must produce the same suggestion everywhere.
const HARD_CAP_TRIANGLES = 16_000_000;
// Smart targets a conservative slice of the OOM guard so the suggestion
// stays well clear of pipeline peak memory (displacement copies, decimation
// working set, optional regularize+re-subdivide pass).  Users dragging the
// resolution slider manually can still push subdivision up to the full
// safety cap.
//
// 0.75 → a 12M-triangle budget (~1.7 GB measured pipeline peak at ~145 B/tri
// after the June 2026 typed-array rewrites).  The previous 0.5 (8M) was sized
// for the old pipeline, where the same budget cost ~5 GB — so 12M today is
// still far safer than 8M ever was, while letting fine textures on large
// models get a meaningfully finer suggested edge.  Kept below 1.0 so a Smart
// suggestion can never trip the 16M floor cap's "coarser than requested"
// warning on browsers without the adaptive 32M cap.
const HARD_CAP_HEADROOM  = 0.75;
// Subdivision budget is the OOM guard only (16M).  We deliberately do NOT
// scale by `settings.maxTriangles` here — that would make Smart's recommended
// edge depend on the slider position, so two clicks of Smart could produce
// two different edges for the same texture.  Decimation downstream will
// crush the subdivided mesh to whatever maxTriangles the user has set;
// post-decim quality benefits from a *finer* subdivision input, not a
// coarser one, so over-subdividing is harmless.  See `recommendedMaxTri`
// for the texture-driven suggestion the user can apply to the slider.
// Equilateral-cover constant: triangles per (edge² × area) for an ideal
// equilateral mesh.  Used only as a starting point for the iterative
// budget-edge solver in computeSmartResolution; the actual count comes from
// simulateSubdivisionTriCount which models the real per-triangle split pattern.
const TRIS_PER_AREA_GEOM = 4 / Math.sqrt(3); // ≈ 2.309

/**
 * World-space "period" of the texture along U and V — i.e. how many world
 * millimetres correspond to one full UV repeat.  Mirrors the math in
 * mapping.js (computeUV → applyTransform).
 *
 * Returns { periodU_mm, periodV_mm }.  Undefined directions (rare) fall back
 * to the longest planar period so the min() in `computeSmartResolution` does
 * not pick a degenerate axis.
 */
function computeWorldPeriod(settings, bounds) {
  const { size, center, min } = bounds;
  const aspectU = settings.textureAspectU ?? 1;
  const aspectV = settings.textureAspectV ?? 1;
  // Match mapping.js:106-107: effective scale is (settings.scale / aspect)
  const sU = (settings.scaleU || 1e-6) / aspectU;
  const sV = (settings.scaleV || 1e-6) / aspectV;

  const md = Math.max(size.x, size.y, size.z, 1e-6);
  const planar = md * sU; // planar period (any axis — same `md` is used in mapping.js)
  const planarV = md * sV;

  switch (settings.mappingMode) {
    case MODE_PLANAR_XY:
    case MODE_PLANAR_XZ:
    case MODE_PLANAR_YZ:
      return { periodU_mm: planar, periodV_mm: planarV };

    case MODE_CYLINDRICAL: {
      const rDefault = Math.max(size.x, size.y) * 0.5;
      const r = Math.max(settings.cylinderRadius ?? rDefault, 1e-6);
      const C = 2 * Math.PI * r;
      // U: arc length per UV repeat = C × scaleU
      // V: vSide normalised by C, so V period (along Z) = C × scaleV
      return { periodU_mm: C * sU, periodV_mm: C * sV };
    }

    case MODE_SPHERICAL: {
      const r = Math.max(0.5 * Math.max(size.x, size.y, size.z), 1e-6);
      return { periodU_mm: 2 * Math.PI * r * sU, periodV_mm: Math.PI * r * sV };
    }

    case MODE_TRIPLANAR:
    case MODE_CUBIC:
    default:
      // Three planar projections blended by normal — use planar period.
      return { periodU_mm: planar, periodV_mm: planarV };
  }
}

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

// ── Decimation-target recommendation ─────────────────────────────────────────
//
// Estimates the post-decimation triangle count that preserves the texture's
// detail with minimum impact on visual quality.  Based on:
//
//   target_edge = COARSEN × pixelsPerEdge × pixMm × √(REF_AMP / max(amp, MIN_AMP))
//   N_tri       = K_geom × surfaceArea / target_edge²
//
// COARSEN = 1.0 → Nyquist target: triangle edge matches the texture's intrinsic
// detail spacing.  Earlier we tried 3× ("aggressive"), but that gave acceptable
// quality only on structured textures (logos, knurling) — on noise / fbm /
// leather textures, 3× coarsen produces visible faceting because every pixel
// of noise IS a feature, not just the high-gradient ones the analyser flags.
// At 1× the user can still drag the max-tri slider down for smaller files;
// the bench (bench-decim-quality.mjs) shows error becomes imperceptible at
// this ratio for both smooth and sharp test textures.
//
// Amplitude scaling: low amplitude needs fewer triangles to faithfully
// represent a gentle relief; high amplitude (heavy displacement) needs more.
const DECIM_COARSEN = 1.0;
const DECIM_REF_AMP = 0.5;
const DECIM_MIN_AMP = 0.1;
const DECIM_MIN_TRI = 10_000;
// Recommendation ceiling.  Sized for sensible default file sizes — much
// smaller than HARD_CAP_TRIANGLES (which is the OOM ceiling for what the
// pipeline can survive).  Users who want more can drag the Max Triangles
// slider up to its full range (20M); Smart just won't suggest above this
// by itself, since the downstream printable mesh rarely needs more.
const DECIM_MAX_TRI = 2_000_000;

/**
 * @param {object} args
 * @param {number} args.pixelsPerEdge   From analyzeTexture (1.0 sharp – 4.0 smooth).
 * @param {number} args.pixMm           World-space pixel size, mm.
 * @param {number} args.surfaceArea     Total mesh area, mm².
 * @param {number} args.amplitude       settings.amplitude (signed; magnitude is what matters).
 * @returns {number} Recommended Max Triangles for minimum quality loss.
 */
export function computeRecommendedMaxTri({ pixelsPerEdge, pixMm, surfaceArea, amplitude }) {
  if (!(pixelsPerEdge > 0) || !(pixMm > 0) || !(surfaceArea > 0)) return DECIM_MIN_TRI;
  const absAmp   = Math.abs(amplitude || 0);
  const ampScale = Math.sqrt(DECIM_REF_AMP / Math.max(absAmp, DECIM_MIN_AMP));
  const targetEdge = DECIM_COARSEN * pixelsPerEdge * pixMm * ampScale;
  const raw = TRIS_PER_AREA_GEOM * surfaceArea / (targetEdge * targetEdge);
  // Round to slider step (10k) and clamp to slider range.
  const stepped = Math.round(raw / 10_000) * 10_000;
  return Math.max(DECIM_MIN_TRI, Math.min(DECIM_MAX_TRI, stepped));
}

/**
 * Pre-compute the three edge lengths of every triangle in `geometry`.
 * Returned Float64Array has 3 entries per triangle (no winding semantics).
 */
function computeTriEdges(geometry) {
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

function simulateFromEdges(triEdges, edge) {
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
 * @param {object} args
 * @param {THREE.BufferGeometry} args.geometry      Current working geometry.
 * @param {{ min, max, size, center }} args.bounds  Bounds of `geometry`.
 * @param {object} args.settings                    Current settings object (see main.js).
 * @param {{ imageData: ImageData, width: number, height: number }} args.texture
 *        Active texture entry (presetTextures.js shape — must have `imageData`).
 * @returns {{
 *   edge: number,
 *   diagnostics: {
 *     pixelsPerEdge: number,
 *     meanGrad: number,
 *     sharpFrac: number,
 *     pixMm: number,
 *     surfaceArea: number,
 *     detailEdge: number,
 *     budgetEdge: number,
 *     estTriangles: number,
 *     triBudget: number,
 *     budgetClamped: boolean,
 *     edgeClamped: boolean,
 *     recommendedMaxTri: number,
 *   }
 * }}
 */
export function computeSmartResolution({ geometry, bounds, settings, texture }) {
  if (!geometry || !bounds || !texture || !texture.imageData) {
    return null;
  }

  // 1. Texture detail → pixels-per-edge.
  const { meanGrad, sharpFrac, pixelsPerEdge } = analyzeTexture(texture.imageData);

  // 2. World-space pixel size.
  const { periodU_mm, periodV_mm } = computeWorldPeriod(settings, bounds);
  const period_mm = Math.min(periodU_mm, periodV_mm);
  const texW = texture.imageData.width || texture.width || 512;
  const texH = texture.imageData.height || texture.height || 512;
  // Use the smaller pixel size across U/V so we resolve the densest direction.
  const pixUmm = periodU_mm / texW;
  const pixVmm = periodV_mm / texH;
  const pixMm = Math.min(pixUmm, pixVmm);

  // 3. Detail-driven edge length (Nyquist-style).
  const detailEdge = pixMm * pixelsPerEdge;

  // 4. Surface area & triangle budget.  Budget is purely the OOM guard —
  // intentionally NOT a function of `settings.maxTriangles` so Smart is
  // idempotent across clicks (see comment on HARD_CAP_TRIANGLES above).
  const surfaceArea = computeSurfaceArea(geometry);
  const triBudget = HARD_CAP_TRIANGLES * HARD_CAP_HEADROOM;

  // Pre-compute per-triangle edges once — reused across all simulator calls.
  const triEdges = computeTriEdges(geometry);

  // Solve for the largest (coarsest) edge that keeps simulated tri count ≤
  // budget.  Start from the closed-form equilateral-cover estimate, then
  // do up to 3 ratio corrections (sim count scales ~1/edge² so each step
  // multiplies edge by sqrt(predicted/budget) until it converges).
  let budgetEdge = Math.sqrt((TRIS_PER_AREA_GEOM * surfaceArea) / Math.max(triBudget, 1));
  for (let step = 0; step < 3; step++) {
    const simCount = simulateFromEdges(triEdges, budgetEdge);
    if (simCount <= triBudget) break;
    const correction = Math.sqrt(simCount / triBudget);
    if (correction < 1.005) break;          // converged
    budgetEdge = budgetEdge * correction;
  }
  // Guarantee the budget actually holds.  On near-uniform meshes (cube-like
  // CAD tessellations) the simulated count is a step function of the edge —
  // 12 × 4^k for the default cube — so the sqrt-ratio corrections above can
  // stall between split thresholds and finish a few percent over budget.
  // Walk coarser in 5% steps until the simulation fits; sim count is
  // monotonically non-increasing in edge length, so this always terminates.
  for (let step = 0; step < 24; step++) {
    if (simulateFromEdges(triEdges, budgetEdge) <= triBudget) break;
    budgetEdge *= 1.05;
  }

  // 5. Final edge: take the larger (coarser) of detail vs budget so neither
  // constraint is violated.
  let edge = Math.max(detailEdge, budgetEdge);
  const budgetClamped = budgetEdge > detailEdge;

  // Sanity clamp: never below 0.05 mm, never coarser than diag/50 (or the
  // 5 mm slider absolute) — matches the legacy default's spirit.
  const diag = Math.sqrt(bounds.size.x ** 2 + bounds.size.y ** 2 + bounds.size.z ** 2);
  const lo = 0.05;
  const hi = Math.min(5.0, diag / 50);
  const preClamp = edge;
  edge = Math.min(Math.max(edge, lo), Math.max(hi, lo));
  const edgeClamped = edge !== preClamp;

  // Round UP to 2 decimals so the slider value never violates the budget
  // floor (rounding down by even 0.005 mm can push estimated triangles past
  // the budget cap).
  edge = Math.max(lo, Math.ceil(edge * 100) / 100);

  // Estimated triangle count at the chosen edge length, via per-triangle
  // simulation of the actual subdivision pattern.
  const estTriangles = simulateFromEdges(triEdges, edge);

  // Recommended Max Triangles for "minimum quality loss" decimation.
  const recommendedMaxTri = computeRecommendedMaxTri({
    pixelsPerEdge, pixMm, surfaceArea,
    amplitude: settings.amplitude,
  });

  return {
    edge,
    diagnostics: {
      pixelsPerEdge,
      meanGrad,
      sharpFrac,
      pixMm,
      period_mm,
      surfaceArea,
      detailEdge,
      budgetEdge,
      estTriangles,
      triBudget,
      budgetClamped,
      edgeClamped,
      recommendedMaxTri,
    },
  };
}
