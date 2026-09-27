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

/**
 * Map size (px, longest side) the per-pixel heuristics here — and texture
 * smoothing's blur radius — were tuned at: every map used to be loaded at
 * ≤512 px. Custom maps now load at up to 2048 px (#89).
 */
export const REF_TEXTURE_SIZE = 512;

const _cache = new WeakMap();
const _refCache = new WeakMap();

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

/**
 * analyzeTexture() at REF_TEXTURE_SIZE. Gradients are per pixel, so a 2048 px
 * map reads ~4× "smoother" than the same picture at 512 px and would skew
 * Smart Resolution. Larger maps are bilinearly resampled to ≤512 px first —
 * what the loader used to hand this function — and the reference dimensions
 * are returned alongside, for converting pixels to millimetres.
 *
 * @param {ImageData} imageData
 * @returns {{ meanGrad: number, sharpFrac: number, pixelsPerEdge: number, width: number, height: number }}
 */
export function analyzeTextureAtRef(imageData) {
  if (!imageData) return { ...analyzeTexture(null), width: 0, height: 0 };
  const { width, height, data } = imageData;
  const longest = Math.max(width, height);
  if (longest <= REF_TEXTURE_SIZE) return { ...analyzeTexture(imageData), width, height };

  const cached = _refCache.get(imageData);
  if (cached) return cached;

  const s = REF_TEXTURE_SIZE / longest;
  const w = Math.max(1, Math.round(width * s)), h = Math.max(1, Math.round(height * s));
  const out = new Uint8ClampedArray(w * h * 4);   // red channel only is read
  const sx = width / w, sy = height / h;
  for (let y = 0; y < h; y++) {
    const fy = Math.min(Math.max((y + 0.5) * sy - 0.5, 0), height - 1);
    const y0 = Math.floor(fy), y1 = Math.min(y0 + 1, height - 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(Math.max((x + 0.5) * sx - 0.5, 0), width - 1);
      const x0 = Math.floor(fx), x1 = Math.min(x0 + 1, width - 1), tx = fx - x0;
      const top = data[(y0 * width + x0) * 4] * (1 - tx) + data[(y0 * width + x1) * 4] * tx;
      const bot = data[(y1 * width + x0) * 4] * (1 - tx) + data[(y1 * width + x1) * 4] * tx;
      out[(y * w + x) * 4] = top * (1 - ty) + bot * ty;
    }
  }
  const result = { ...analyzeTexture({ width: w, height: h, data: out }), width: w, height: h };
  _refCache.set(imageData, result);
  return result;
}
