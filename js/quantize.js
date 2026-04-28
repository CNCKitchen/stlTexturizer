/**
 * quantize.js — Median-cut palette quantization for per-triangle 3MF colors.
 *
 * Exports `medianCut(triRGBs, maxColors=32)` returning
 *   { palette: Uint8Array(N*3), indices: Uint16Array(triCount) }
 * where N ≤ maxColors and indices[i] points triangle i at its bucket's mean RGB.
 *
 * Algorithm:
 *   1. Place all triangles in one bucket.
 *   2. Pick the bucket with the largest range-weighted score (with > 1 distinct
 *      colour), find its widest channel (max−min over R, G, B), sort that
 *      channel, then partition at a large color gap when one exists; otherwise
 *      partition near the median.
 *   3. Repeat until bucket count == maxColors or no further bucket can be split.
 *   4. Each bucket's palette entry = mean RGB of its members.
 *
 * Performance: O(triCount * log(maxColors)) with in-place index sort, no
 * per-bucket allocation beyond `start, end, channel-stats` ints.
 */

export function medianCut(triRGBs, maxColors = 32) {
  const triCount = (triRGBs.length / 3) | 0;
  if (triCount === 0) {
    return { palette: new Uint8Array(0), indices: new Uint16Array(0) };
  }

  // `order` holds triangle indices; we partition slices of it in place. The
  // input triRGBs is never copied — we read RGB through order[k] each time.
  const order = new Uint32Array(triCount);
  for (let i = 0; i < triCount; i++) order[i] = i;

  // Bucket bookkeeping: each bucket is the slice order[start..end) of `order`.
  // Pre-size to maxColors (the upper bound on bucket count).
  const cap = Math.max(1, maxColors | 0);
  const bStart = new Int32Array(cap);
  const bEnd   = new Int32Array(cap);
  // Cached per-bucket channel ranges (max - min) and dominant channel; recomputed
  // on creation/split. We track:
  //   bRange  — the largest channel range (used to pick split channel)
  //   bChan   — which channel had that range (0=R, 1=G, 2=B)
  //   bSplittable — 1 iff bucket has > 1 distinct color (range > 0 in some channel)
  const bRange = new Int32Array(cap);
  const bChan  = new Int8Array(cap);
  const bSplittable = new Uint8Array(cap);

  // Initialize bucket 0 = full input.
  bStart[0] = 0;
  bEnd[0]   = triCount;
  let bCount = 1;
  _computeBucketStats(triRGBs, order, 0, triCount, 0, bRange, bChan, bSplittable);

  // ── Split loop ────────────────────────────────────────────────────────────
  // Pick the splittable bucket with the largest population, split it. Repeat
  // until we hit cap or no bucket is splittable.
  while (bCount < cap) {
    // Pick the splittable bucket with the largest channel range. Range-based
    // selection (vs population-based) preserves small but distinctive clusters
    // — e.g. a small white region on an otherwise wood-toned mesh — by
    // prioritizing buckets where the color span is wide. Population-based
    // splitting equalises bucket sizes, which dilutes outliers into nearby
    // dominant clusters and the bucket mean becomes the dominant color, not the
    // outlier's. Score by range × log(pop+1) so a tiny but high-range bucket
    // doesn't beat a large but moderate-range one — empirically this keeps
    // both gradients smooth and outliers crisp.
    let bestIdx = -1;
    let bestScore = 0;
    for (let b = 0; b < bCount; b++) {
      if (!bSplittable[b]) continue;
      const pop = bEnd[b] - bStart[b];
      const score = bRange[b] * Math.log(pop + 1);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = b;
      }
    }
    if (bestIdx < 0) break;

    const s = bStart[bestIdx];
    const e = bEnd[bestIdx];
    const chan = bChan[bestIdx];

    // Sort the slice [s, e) of `order` by chan via insertion-friendly TimSort
    // proxy: we use Array.prototype.sort on a Uint32Array subarray view.
    // Using a closure here is acceptable — N stops, sort cost dominates anyway.
    // Convert subarray to a plain Array for sort (Uint32Array has no comparator
    // sort that handles arbitrary number ordering reliably across engines for
    // our size — but TypedArray sort IS stable & sorts by numeric value of the
    // element. We instead sort indices with a comparator on triRGBs[chan]).
    const sub = order.subarray(s, e);
    const tmp = Array.from(sub);
    tmp.sort((a, b) => triRGBs[a * 3 + chan] - triRGBs[b * 3 + chan]);
    for (let k = 0; k < tmp.length; k++) sub[k] = tmp[k];

    // Split at a strong color boundary when one exists. A pure median split can
    // bury a small distinctive cluster (for example a white masked face among
    // thousands of wood-toned triangles) for many iterations. Gap-aware splits
    // isolate those clusters immediately while smooth ramps still fall back to
    // the count median.
    const mid = _chooseSplitPoint(triRGBs, order, s, e, chan, bRange[bestIdx]);
    if (mid <= s || mid >= e) {
      // Degenerate — mark unsplittable (e.g. pop == 1).
      bSplittable[bestIdx] = 0;
      continue;
    }

    // Left bucket inherits bestIdx slot; right takes a new slot.
    const newIdx = bCount++;
    bEnd[bestIdx] = mid;
    bStart[newIdx] = mid;
    bEnd[newIdx]   = e;

    _computeBucketStats(triRGBs, order, s,   mid, bestIdx, bRange, bChan, bSplittable);
    _computeBucketStats(triRGBs, order, mid, e,   newIdx,  bRange, bChan, bSplittable);
  }

  // ── Build palette + indices ───────────────────────────────────────────────
  const palette = new Uint8Array(bCount * 3);
  const indices = new Uint16Array(triCount);
  for (let b = 0; b < bCount; b++) {
    const s = bStart[b], e = bEnd[b];
    const pop = e - s;
    if (pop === 0) continue;
    let sr = 0, sg = 0, sb = 0;
    for (let k = s; k < e; k++) {
      const t = order[k];
      sr += triRGBs[t * 3];
      sg += triRGBs[t * 3 + 1];
      sb += triRGBs[t * 3 + 2];
      indices[t] = b;
    }
    palette[b * 3]     = Math.round(sr / pop);
    palette[b * 3 + 1] = Math.round(sg / pop);
    palette[b * 3 + 2] = Math.round(sb / pop);
  }

  return { palette, indices };
}

/**
 * Compute (max-min) per channel for the bucket slice order[s..e), pick
 * the widest channel, and write into bRange/bChan/bSplittable at slot `b`.
 */
function _computeBucketStats(triRGBs, order, s, e, b, bRange, bChan, bSplittable) {
  if (e <= s) {
    bRange[b] = 0;
    bChan[b]  = 0;
    bSplittable[b] = 0;
    return;
  }
  let minR = 255, minG = 255, minB = 255;
  let maxR = 0,   maxG = 0,   maxB = 0;
  for (let k = s; k < e; k++) {
    const t = order[k];
    const r = triRGBs[t * 3];
    const g = triRGBs[t * 3 + 1];
    const bb = triRGBs[t * 3 + 2];
    if (r < minR) minR = r; if (r > maxR) maxR = r;
    if (g < minG) minG = g; if (g > maxG) maxG = g;
    if (bb < minB) minB = bb; if (bb > maxB) maxB = bb;
  }
  const dR = maxR - minR;
  const dG = maxG - minG;
  const dB = maxB - minB;
  let chan = 0, range = dR;
  if (dG > range) { chan = 1; range = dG; }
  if (dB > range) { chan = 2; range = dB; }
  bRange[b] = range;
  bChan[b]  = chan;
  // Splittable iff at least one channel has range > 0 AND we have ≥ 2 elements.
  bSplittable[b] = (range > 0 && (e - s) > 1) ? 1 : 0;
}

/**
 * Pick a split point for a sorted bucket slice.
 *
 * Prefer a visually meaningful channel gap when present. This protects small
 * but important regions from being averaged into a dominant cluster. For
 * ordinary smooth gradients, adjacent gaps are small, so we use a median-ish
 * split and nudge it to the nearest color boundary to avoid splitting a run of
 * identical channel values.
 */
function _chooseSplitPoint(triRGBs, order, s, e, chan, range) {
  const median = (s + e) >> 1;
  let bestGap = 0;
  let bestGapMid = -1;

  for (let k = s + 1; k < e; k++) {
    const prev = triRGBs[order[k - 1] * 3 + chan];
    const cur  = triRGBs[order[k] * 3 + chan];
    const gap = cur - prev;
    if (gap > bestGap) {
      bestGap = gap;
      bestGapMid = k;
    }
  }

  // A gap this large is a real color boundary, not normal gradient stepping.
  const gapThreshold = Math.max(8, range * 0.2);
  if (bestGapMid > s && bestGapMid < e && bestGap >= gapThreshold) {
    return bestGapMid;
  }

  // Median fallback, nudged to the nearest distinct-value boundary so a bucket
  // made mostly of duplicate colors does not produce redundant child buckets.
  const leftVal = triRGBs[order[median - 1] * 3 + chan];
  const rightVal = triRGBs[order[median] * 3 + chan];
  if (leftVal !== rightVal) return median;

  let left = median - 1;
  while (left > s) {
    const a = triRGBs[order[left - 1] * 3 + chan];
    const b = triRGBs[order[left] * 3 + chan];
    if (a !== b) break;
    left--;
  }

  let right = median + 1;
  while (right < e) {
    const a = triRGBs[order[right - 1] * 3 + chan];
    const b = triRGBs[order[right] * 3 + chan];
    if (a !== b) break;
    right++;
  }

  const haveLeft = left > s;
  const haveRight = right < e;
  if (haveLeft && haveRight) {
    return (median - left <= right - median) ? left : right;
  }
  if (haveLeft) return left;
  if (haveRight) return right;
  return median;
}
