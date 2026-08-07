/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Texture detail analysis for smart resolution.
 *
 * Walks an ImageData (red channel — same channel `displacement.js` samples)
 * and returns gradient statistics that classify the texture as smooth,
 * medium, or sharp.  The classification yields a "pixels-per-edge" (PPE)
 * value: how many texture pixels each mesh edge should span to faithfully
 * reproduce the texture without aliasing.
 *
 * PPE = 1.0  → very sharp features, one edge per pixel (e.g. knurling, hex grids)
 * PPE = 1.5  → medium features (e.g. weave, dots)
 * PPE = 2.5  → soft features (e.g. noise, leather)
 * PPE = 4.0  → very smooth gradients (no fine detail to preserve)
 *
 * Results are memoised by ImageData identity (WeakMap) so re-analysing the
 * same texture entry is O(1).
 */

const SHARP_THRESHOLD = 30; // |∇I| above this counts as a "sharp" pixel (0–255 scale)

const _cache = new WeakMap();

/**
 * @param {ImageData} imageData  RGBA pixel buffer (only the R channel is read)
 * @returns {{ meanGrad: number, sharpFrac: number, pixelsPerEdge: number }}
 */
export function analyzeTexture(imageData) {
  if (!imageData) {
    return { meanGrad: 0, sharpFrac: 0, pixelsPerEdge: 4.0 };
  }
  const cached = _cache.get(imageData);
  if (cached) return cached;

  const { width, height, data } = imageData;
  if (width < 3 || height < 3) {
    const fallback = { meanGrad: 0, sharpFrac: 0, pixelsPerEdge: 4.0 };
    _cache.set(imageData, fallback);
    return fallback;
  }

  const stride = width * 4;
  let sumGrad = 0;
  let sharpCount = 0;
  let pixelCount = 0;

  // Central differences on the red channel; skip the 1-pixel border.
  for (let y = 1; y < height - 1; y++) {
    const rowOff = y * stride;
    for (let x = 1; x < width - 1; x++) {
      const i = rowOff + x * 4;
      const left  = data[i - 4];
      const right = data[i + 4];
      const up    = data[i - stride];
      const down  = data[i + stride];
      const dx = (right - left) * 0.5;
      const dy = (down  - up)   * 0.5;
      const mag = Math.sqrt(dx * dx + dy * dy);
      sumGrad += mag;
      if (mag > SHARP_THRESHOLD) sharpCount++;
      pixelCount++;
    }
  }

  const meanGrad = sumGrad / pixelCount;
  const sharpFrac = sharpCount / pixelCount;

  let pixelsPerEdge;
  if (sharpFrac > 0.15 || meanGrad > 50)      pixelsPerEdge = 1.0;
  else if (sharpFrac > 0.05 || meanGrad > 20) pixelsPerEdge = 1.5;
  else if (meanGrad > 8)                       pixelsPerEdge = 2.5;
  else                                         pixelsPerEdge = 4.0;

  const result = { meanGrad, sharpFrac, pixelsPerEdge };
  _cache.set(imageData, result);
  return result;
}
