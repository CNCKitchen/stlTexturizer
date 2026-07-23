/**
 * imageData.mjs — headless PNG/JPG decoding for displacement maps.
 *
 * Produces plain { data: Uint8ClampedArray (RGBA), width, height } objects —
 * exactly the shape js/displacement.js expects (it only reads the RED
 * channel, per the app's greyscale-map convention: R === G === B).
 */

import { readFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';

const MAX_SIDE = 512; // matches js/presetTextures.js `fitDimensions` (SIZE = 512)

/**
 * Decode a PNG or JPEG file from disk into a raw RGBA image.
 * @param {string} filePath
 * @returns {Promise<{data: Uint8ClampedArray, width: number, height: number}>}
 */
export async function decodeImageFile(filePath) {
  const buf = await readFile(filePath);
  const lower = filePath.toLowerCase();

  if (lower.endsWith('.png')) {
    const png = PNG.sync.read(buf);
    return {
      data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength),
      width: png.width,
      height: png.height,
    };
  }

  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    const decoded = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
    return {
      data: new Uint8ClampedArray(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength),
      width: decoded.width,
      height: decoded.height,
    };
  }

  throw new Error(`Unsupported image format for "${filePath}". Only .png, .jpg, and .jpeg are supported.`);
}

/**
 * Convert an RGBA image to greyscale luminance, writing the result into all
 * of R/G/B (displacement.js's sampleBilinear only reads R, but writing all
 * three keeps the buffer visually sane and matches the contract's guidance).
 */
export function toLuminance(imageData) {
  const { data, width, height } = imageData;
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const lum = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    out[i] = lum;
    out[i + 1] = lum;
    out[i + 2] = lum;
    out[i + 3] = data[i + 3];
  }
  return { data: out, width, height };
}

/**
 * Downscale so the longest side is at most `maxSide`, preserving aspect
 * ratio. Never upscales (mirrors presetTextures.js `fitDimensions`).
 */
export function capLongestSide(imageData, maxSide = MAX_SIDE) {
  const { width, height } = imageData;
  const scale = Math.min(maxSide / width, maxSide / height, 1);
  if (scale >= 1) return imageData;
  const newW = Math.max(1, Math.round(width * scale));
  const newH = Math.max(1, Math.round(height * scale));
  return resizeBilinear(imageData, newW, newH);
}

function resizeBilinear(imageData, newW, newH) {
  const { data, width, height } = imageData;
  const out = new Uint8ClampedArray(newW * newH * 4);
  for (let y = 0; y < newH; y++) {
    const srcY = ((y + 0.5) * height) / newH - 0.5;
    const y0c = Math.floor(srcY);
    const y0 = Math.max(0, Math.min(height - 1, y0c));
    const y1 = Math.max(0, Math.min(height - 1, y0c + 1));
    const ty = Math.min(1, Math.max(0, srcY - y0c));
    for (let x = 0; x < newW; x++) {
      const srcX = ((x + 0.5) * width) / newW - 0.5;
      const x0c = Math.floor(srcX);
      const x0 = Math.max(0, Math.min(width - 1, x0c));
      const x1 = Math.max(0, Math.min(width - 1, x0c + 1));
      const tx = Math.min(1, Math.max(0, srcX - x0c));
      for (let c = 0; c < 4; c++) {
        const v00 = data[(y0 * width + x0) * 4 + c];
        const v10 = data[(y0 * width + x1) * 4 + c];
        const v01 = data[(y1 * width + x0) * 4 + c];
        const v11 = data[(y1 * width + x1) * 4 + c];
        const v = v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty;
        out[(y * newW + x) * 4 + c] = v;
      }
    }
  }
  return { data: out, width: newW, height: newH };
}

// Separable box blur — mirrors js/main.js `_boxBlurH`/`_boxBlurV` exactly.
function boxBlurH(src, dst, w, h, r) {
  const iarr = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let ch = 0; ch < 4; ch++) {
      let val = 0;
      for (let x = -r; x <= r; x++) val += src[(row + Math.max(0, Math.min(x, w - 1))) * 4 + ch];
      for (let x = 0; x < w; x++) {
        val += src[(row + Math.min(x + r, w - 1)) * 4 + ch] - src[(row + Math.max(x - r - 1, 0)) * 4 + ch];
        dst[(row + x) * 4 + ch] = Math.round(val * iarr);
      }
    }
  }
}

function boxBlurV(src, dst, w, h, r) {
  const iarr = 1 / (2 * r + 1);
  for (let x = 0; x < w; x++) {
    for (let ch = 0; ch < 4; ch++) {
      let val = 0;
      for (let y = -r; y <= r; y++) val += src[(Math.max(0, Math.min(y, h - 1)) * w + x) * 4 + ch];
      for (let y = 0; y < h; y++) {
        val += src[(Math.min(y + r, h - 1) * w + x) * 4 + ch] - src[(Math.max(y - r - 1, 0) * w + x) * 4 + ch];
        dst[(y * w + x) * 4 + ch] = Math.round(val * iarr);
      }
    }
  }
}

/**
 * Apply an approximate Gaussian blur (sigma in px) via 3 passes of separable
 * box blur — the same WebKit-fallback algorithm js/main.js `blurCanvas` uses
 * when the CSS `filter` blur isn't available. sigma <= 0 is a no-op.
 */
export function applySmoothing(imageData, sigma) {
  if (!sigma || sigma <= 0) return imageData;
  const { width: w, height: h } = imageData;
  const r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
  let a = Uint8ClampedArray.from(imageData.data);
  const b = new Uint8ClampedArray(a.length);
  for (let pass = 0; pass < 3; pass++) {
    boxBlurH(a, b, w, h, r);
    boxBlurV(b, a, w, h, r);
  }
  return { data: a, width: w, height: h };
}
