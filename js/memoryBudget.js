/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * memoryBudget.js — one place that answers "how many triangles may the export
 * pipeline build?", expressed as a MEMORY budget rather than a magic number.
 *
 * Why this module exists
 * ----------------------
 * The subdivision safety cap used to be a pair of hardcoded triangle counts
 * (16 M, or 32 M when navigator.deviceMemory reported ≥ 8), justified in a
 * comment by "~145 bytes per subdivided triangle". That figure was measured on
 * an older pipeline and had drifted badly: profiling the current code
 * (js/decimation.js + js/subdivision.js + js/displacement.js, sphere at
 * 3.29 M triangles, Node with live-ArrayBuffer accounting) put the real peak at
 * **660 bytes per subdivided triangle**, all of it in the decimation stage.
 *
 * Two things followed from that gap:
 *
 *   1. The caps were fiction. 32 M triangles × 660 B is 21 GB — no browser tab
 *      was ever going to reach the "cap"; it hit the OS/engine allocator first
 *      and the export died with an out-of-memory error instead of a warning.
 *
 *   2. There was no way to go higher on a machine that could afford it.
 *      navigator.deviceMemory is clamped to 8 by its own specification, so a
 *      64 GB workstation and an 8 GB laptop reported the same value and got the
 *      same cap. "I have the RAM, let me use it" was unexpressible.
 *
 * So the cap is now derived: cap = budget ÷ bytes-per-triangle, where the
 * budget is a real byte figure the user can raise, and bytes-per-triangle is a
 * measured constant kept honest by bench-pipeline.mjs / diag-quality-ceiling.mjs.
 */

/**
 * Measured peak bytes per subdivided triangle across the whole
 * subdivide -> displace -> decimate -> repair pipeline.
 *
 * Two independent measurements, because they answer different questions:
 *
 *   327 B/tri  Node, live typed-array accounting
 *              (`process.memoryUsage().arrayBuffers + .heapUsed`, sampled every
 *              5 ms; RSS is useless here because V8 does not return freed pages
 *              to the OS promptly and overstates the peak by ~15-30 %).
 *              This is what the pipeline actually holds. Sphere, 3.29 M tris.
 *
 *   384 B/tri  Chromium, RSS of every browser process during a real export,
 *              minus the idle-with-model-loaded baseline. 400 mm sphere at
 *              0.45 mm, 15.0 M subdivided triangles: 665 MB baseline, 6165 MB
 *              peak. An UPPER bound — it includes allocator slack and browser
 *              overhead that is not the pipeline's — but it is the figure the
 *              OS sees, and the OS is what kills the tab.
 *
 * The constant takes the browser number. This guard exists to stop an export
 * before the allocator does, so the right input is the footprint the allocator
 * charges us for, not the subset V8 attributes to live buffers.
 *
 * For reference, the hardcoded caps this replaced assumed 145 B/tri.
 *
 * If you change an allocation in decimation.js / subdivision.js /
 * displacement.js, re-measure and update this — it is the only thing standing
 * between the user and an out-of-memory tab.
 */
export const PIPELINE_BYTES_PER_TRIANGLE = 384;

/** Absolute floor: below this the tool cannot do anything useful. */
const MIN_CAP_TRIANGLES = 1_000_000;

/**
 * Largest SINGLE typed array the engine will hand out, regardless of how much
 * RAM the machine has. V8 caps typed arrays at 2^31-1 bytes; measured on
 * Chromium 131 (page and worker alike) the largest allocatable Float32Array is
 * 2046 MB, which is that limit. Firefox and Safari are at or above it.
 *
 * This is a SEPARATE constraint from the total budget and it binds first on
 * large jobs. A 32 GB budget nominally allows 101 M triangles; subdivision
 * reaches ~65 M and then dies in toNonIndexed, because a 65 M-triangle
 * non-indexed position buffer is Float32Array(65M × 9) = 2.34 GB — one
 * allocation, over the ceiling. No amount of free RAM changes that.
 */
const ENGINE_MAX_TYPED_ARRAY_BYTES = 2 ** 31 - 1;

/**
 * Bytes per triangle in the pipeline's LARGEST SINGLE allocation (as opposed
 * to PIPELINE_BYTES_PER_TRIANGLE, which is the whole footprint at peak).
 * Candidates, for T triangles and V ≈ T/2 welded vertices:
 *
 *   decimation quadrics      Float64Array(V*10)  = 40 B/tri   <- worst
 *   toNonIndexed pos / nrm   Float32Array(T*9)   = 36 B/tri
 *   displacement newPos/Nrm  Float32Array(T*9)   = 36 B/tri
 *   subdivision verts.pos    Float64Array(2V*3)  = 24 B/tri
 *   decimation heap columns  Float64Array(1.6T)  = 12.8 B/tri
 *
 * 48 leaves margin over the 40 B/tri worst case for input that welds less
 * favourably than a closed manifold (V > T/2 pushes the quadric array up).
 */
const MAX_SINGLE_BUFFER_BYTES_PER_TRIANGLE = 48;

/**
 * Triangle ceiling imposed purely by the per-allocation limit above. Exported
 * so the UI can explain why raising the budget past a point changes nothing.
 */
export const STRUCTURAL_CAP_TRIANGLES = Math.floor(
  ENGINE_MAX_TYPED_ARRAY_BYTES / MAX_SINGLE_BUFFER_BYTES_PER_TRIANGLE
);

export const BYTES_PER_GB = 1024 * 1024 * 1024;
const GB = BYTES_PER_GB;

/** Budget presets offered in the UI, in bytes. */
export const BUDGET_PRESETS_GB = [1, 2, 4, 6, 8, 12, 16, 24, 32];

/**
 * Best-effort automatic budget for this machine, in bytes.
 *
 * There is no web API that reports free RAM, and the one that reports installed
 * RAM (navigator.deviceMemory) is deliberately quantised and clamped to 8 to
 * limit fingerprinting. So this is a floor, not a measurement — it is chosen so
 * that the default never OOMs a machine that reports honestly, and the user
 * raises it when they know better. hardwareConcurrency is used only to break
 * the tie at deviceMemory === 8, where "≥ 8 GB" spans everything from an 8 GB
 * laptop to a 512 GB workstation: a high core count is weak evidence of the
 * latter, and being wrong only costs a retry at a lower setting.
 */
export function detectDefaultBudgetBytes() {
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  const dm = nav && typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null;
  const cores = (nav && nav.hardwareConcurrency) || 0;

  if (dm === null) {
    // Safari and Firefox do not implement deviceMemory. Assume a mainstream
    // desktop; these engines also tend to be stricter about large allocations,
    // so do not get greedy.
    return 3 * GB;
  }
  if (dm >= 8) return (cores >= 16 ? 6 : 4) * GB;
  if (dm >= 4) return 2 * GB;
  if (dm >= 2) return 1 * GB;
  return 0.5 * GB;
}

/**
 * Triangle cap the subdivider may build within `budgetBytes`.
 * @param {number} budgetBytes
 * @returns {number} triangle count, clamped to the structural limits
 */
export function subdivisionCapFor(budgetBytes) {
  if (!(budgetBytes > 0)) budgetBytes = detectDefaultBudgetBytes();
  const raw = Math.floor(budgetBytes / PIPELINE_BYTES_PER_TRIANGLE);
  // Both constraints must hold: total live memory AND the per-allocation
  // ceiling. The second one binds above ~15 GB of budget and is the reason a
  // machine with plenty of free RAM still cannot go arbitrarily high.
  return Math.max(MIN_CAP_TRIANGLES, Math.min(STRUCTURAL_CAP_TRIANGLES, raw));
}

/** True when the engine's per-allocation limit, not the budget, is binding. */
export function isStructurallyCapped(budgetBytes) {
  if (!(budgetBytes > 0)) budgetBytes = detectDefaultBudgetBytes();
  return Math.floor(budgetBytes / PIPELINE_BYTES_PER_TRIANGLE) > STRUCTURAL_CAP_TRIANGLES;
}

/**
 * Ceiling on the OUTPUT triangle count that "Suggest values" will recommend.
 *
 * This used to be a flat 2 M regardless of anything. That is a quality bug
 * independent of memory: 2 M triangles on a 50 mm part is a fine mesh, and on a
 * 500 mm part it is a 100× coarser surface — yet the recommendation was the
 * same number for both, so large parts were silently handed a far worse result
 * than small ones (see diag-quality-ceiling.mjs, which shows every part size
 * from 50 mm to 1200 mm pinned at exactly 2.00 M).
 *
 * Tying it to a quarter of the subdivision cap keeps it proportional to what
 * the machine can actually chew through, and preserves a sane decimation ratio
 * — recommending an output closer than 4:1 to the subdivision input means the
 * decimator has almost nothing to remove and the subdivision was wasted work.
 * The 2 M floor means this can never recommend LESS than the old constant.
 *
 * @param {number} budgetBytes
 * @param {number} [sliderMax]  hard ceiling from the UI control
 */
export function outputCeilingFor(budgetBytes, sliderMax = 20_000_000) {
  const quarter = Math.floor(subdivisionCapFor(budgetBytes) / 4);
  return Math.max(2_000_000, Math.min(sliderMax, quarter));
}

/** Approximate peak pipeline memory for a given triangle count, in bytes. */
export function estimatedPeakBytes(triangles) {
  return triangles * PIPELINE_BYTES_PER_TRIANGLE;
}

// ── Page-side persistence ────────────────────────────────────────────────────
// Workers have no localStorage, and must not guess: the page resolves the
// budget and passes the resulting cap through the settings snapshot.

const STORAGE_KEY = 'bumpmesh.memoryBudgetBytes';

/** Resolved budget in bytes: the user's stored override, else the auto value. */
export function getBudgetBytes() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const n = Number(stored);
      // Guard against a stale/corrupt value locking the tool into an
      // unusable setting; anything outside the offered range is ignored.
      if (Number.isFinite(n) && n >= 0.25 * GB && n <= 64 * GB) return n;
    }
  } catch { /* private mode / storage disabled → fall through to auto */ }
  return detectDefaultBudgetBytes();
}

/** Persist a user override. Pass null to return to the automatic value. */
export function setBudgetBytes(bytes) {
  try {
    if (bytes === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, String(bytes));
  } catch { /* storage unavailable — the value still applies this session */ }
}

/** True when a user override is in effect (for UI labelling). */
export function hasBudgetOverride() {
  try { return localStorage.getItem(STORAGE_KEY) !== null; } catch { return false; }
}
