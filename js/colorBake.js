/**
 * colorBake.js — Per-vertex color bake for 3MF export.
 *
 * Writes a Float32×3 `color` BufferAttribute onto the displaced (post-subdivision,
 * pre-decimation) geometry. Composition order per vertex:
 *   excludeWeight ≥ 0.99       → settings.colorBaseColor
 *   autoSource === 'gradient'  → sample displacementImageData (same UV pipeline as
 *                                 displacement.js Pass 2), look up grey in
 *                                 settings.colorGradientStops
 *   autoSource === 'image'     → sample colorImageData at the same UV
 *   else                        → settings.colorBaseColor
 *
 * Mirrors displacement.js's pipeline exactly: same QUANT vertex dedup, same Pass 1
 * area accumulation for zoneArea (cubic) and smoothNrm, same Pass 2 UV resolution.
 * For cubic mode, the per-zone color is computed from the per-zone grey (gradient)
 * or per-zone RGB sample (image) and weight-blended across zones, matching the
 * displacement-side approach so colors line up with displacement texels.
 */
import * as THREE from 'three';
import { computeUV, getCubicBlendWeights } from './mapping.js';

export function applyColors(
  geometry,
  faceParentId,
  displacementImageData, dispW, dispH,
  colorImageData, colorW, colorH,
  settings, bounds,
) {
  if (!geometry || !geometry.attributes || !geometry.attributes.position) return geometry;
  const posAttr = geometry.attributes.position;
  const nrmAttr = geometry.attributes.normal;
  const ewAttr  = geometry.attributes.excludeWeight || null;
  const count   = posAttr.count;

  // ── Resolve effective color source ────────────────────────────────────────
  const baseRGB = _parseHex(settings.colorBaseColor || '#ffffff');
  const autoSource = settings.colorAutoSource || 'none';
  const haveGradient = autoSource === 'gradient' && displacementImageData && displacementImageData.data;
  const haveImage    = autoSource === 'image' && colorImageData && colorImageData.data;

  // Pre-sort gradient stops once (defensive — UI may emit unsorted).
  let gradientStops = null;
  if (haveGradient) {
    const stops = Array.isArray(settings.colorGradientStops) ? settings.colorGradientStops : [];
    gradientStops = stops
      .map(s => ({ pos: +s.pos, rgb: _parseHex(s.color) }))
      .filter(s => Number.isFinite(s.pos))
      .sort((a, b) => a.pos - b.pos);
    if (gradientStops.length === 0) gradientStops = null;
  }

  // Texture-aspect correction. Two distinct sets — displacement and color images
  // may have different aspect ratios. Mirror displacement.js exactly.
  const dispTmax  = Math.max(dispW || 1, dispH || 1, 1);
  const dispAspectU = dispTmax / Math.max(dispW || 1, 1);
  const dispAspectV = dispTmax / Math.max(dispH || 1, 1);
  const dispSettings = { ...settings, textureAspectU: dispAspectU, textureAspectV: dispAspectV };

  let colSettings = dispSettings;
  let colAspectU = dispAspectU, colAspectV = dispAspectV;
  if (haveImage) {
    const cTmax = Math.max(colorW || 1, colorH || 1, 1);
    colAspectU = cTmax / Math.max(colorW || 1, 1);
    colAspectV = cTmax / Math.max(colorH || 1, 1);
    colSettings = { ...settings, textureAspectU: colAspectU, textureAspectV: colAspectV };
  }

  // ── Vertex dedup pass: position → numeric ID via one-time string-map pass ─
  const QUANT = 1e4;
  const _dedupMap = new Map();
  let _nextId = 0;
  const vertexId = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const x = posAttr.getX(i), y = posAttr.getY(i), z = posAttr.getZ(i);
    const key = `${Math.round(x * QUANT)}_${Math.round(y * QUANT)}_${Math.round(z * QUANT)}`;
    let id = _dedupMap.get(key);
    if (id === undefined) {
      id = _nextId++;
      _dedupMap.set(key, id);
    }
    vertexId[i] = id;
  }
  const uniqueCount = _nextId;

  // ── Pass 1: area-weighted smooth normals + cubic zoneArea per unique pos ──
  const smoothNrmX = new Float64Array(uniqueCount);
  const smoothNrmY = new Float64Array(uniqueCount);
  const smoothNrmZ = new Float64Array(uniqueCount);
  const zoneAreaX  = new Float64Array(uniqueCount);
  const zoneAreaY  = new Float64Array(uniqueCount);
  const zoneAreaZ  = new Float64Array(uniqueCount);

  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const vC = new THREE.Vector3();
  const edge1 = new THREE.Vector3();
  const edge2 = new THREE.Vector3();
  const faceNrm = new THREE.Vector3();
  const tmpPos = new THREE.Vector3();
  const tmpNrm = new THREE.Vector3();

  const isCubic = settings.mappingMode === 6;
  const cubicBlend = settings.mappingBlend ?? 0;
  const cubicBandWidth = settings.seamBandWidth ?? 0.35;

  for (let t = 0; t < count; t += 3) {
    vA.fromBufferAttribute(posAttr, t);
    vB.fromBufferAttribute(posAttr, t + 1);
    vC.fromBufferAttribute(posAttr, t + 2);
    edge1.subVectors(vB, vA);
    edge2.subVectors(vC, vA);
    faceNrm.crossVectors(edge1, edge2);
    const faceArea = faceNrm.length();

    let czX = 0, czY = 0, czZ = 0;
    if (isCubic && faceArea > 1e-12) {
      const unitFaceNrm = { x: faceNrm.x / faceArea, y: faceNrm.y / faceArea, z: faceNrm.z / faceArea };
      const w = getCubicBlendWeights(unitFaceNrm, cubicBlend, cubicBandWidth);
      czX = w.x * faceArea;
      czY = w.y * faceArea;
      czZ = w.z * faceArea;
    }

    for (let v = 0; v < 3; v++) {
      const vid = vertexId[t + v];
      tmpNrm.fromBufferAttribute(nrmAttr, t + v);
      smoothNrmX[vid] += tmpNrm.x * faceArea;
      smoothNrmY[vid] += tmpNrm.y * faceArea;
      smoothNrmZ[vid] += tmpNrm.z * faceArea;
      if (czX > 1e-12 || czY > 1e-12 || czZ > 1e-12) {
        zoneAreaX[vid] += czX;
        zoneAreaY[vid] += czY;
        zoneAreaZ[vid] += czZ;
      }
    }
  }

  // Normalise smooth normals
  for (let id = 0; id < uniqueCount; id++) {
    const len = Math.sqrt(
      smoothNrmX[id] * smoothNrmX[id] +
      smoothNrmY[id] * smoothNrmY[id] +
      smoothNrmZ[id] * smoothNrmZ[id]
    ) || 1;
    smoothNrmX[id] /= len;
    smoothNrmY[id] /= len;
    smoothNrmZ[id] /= len;
  }

  // ── Pass 2: per-unique-vertex auto color cache ────────────────────────────
  // We cache the auto-source color (gradient or image sample) per unique
  // position so coincident vertices on adjacent triangles agree. Per-face
  // overrides (excludeWeight and paint) are applied per-vertex-copy in Pass 3,
  // because they depend on the owning original-face index, which is per-copy.
  const autoR = new Float32Array(uniqueCount);
  const autoG = new Float32Array(uniqueCount);
  const autoB = new Float32Array(uniqueCount);
  const autoSet = new Uint8Array(uniqueCount);

  const md = Math.max(bounds.size.x, bounds.size.y, bounds.size.z, 1e-6);
  const rotRad = (settings.rotation ?? 0) * Math.PI / 180;
  const useAuto = haveGradient || haveImage;

  if (useAuto) {
    for (let i = 0; i < count; i++) {
      const vid = vertexId[i];
      if (autoSet[vid]) continue;
      autoSet[vid] = 1;

      tmpPos.fromBufferAttribute(posAttr, i);

      // Cubic: zone-area-weighted color blending. Per-zone we sample the
      // appropriate UV, then for gradient mode look up grey→RGB per zone (so
      // we blend final colors, not greys). For image mode we sample RGB
      // directly per zone. Mirrors displacement.js's cubic Pass 2 layout.
      if (isCubic) {
        const zaX = zoneAreaX[vid], zaY = zoneAreaY[vid], zaZ = zoneAreaZ[vid];
        const total = zaX + zaY + zaZ;
        if (total > 0) {
          let rOut = 0, gOut = 0, bOut = 0;

          // Each zone contributes to BOTH displacement-UV (for gradient grey lookup)
          // AND color-UV (for image RGB lookup). The two UV sets differ only in
          // their per-image aspect correction, so we recompute when different.

          if (zaX > 0) { // X-dominant zone → YZ projection
            let rawU = (tmpPos.y - bounds.min.y) / md;
            if (smoothNrmX[vid] < 0) rawU = -rawU;
            const rawV = (tmpPos.z - bounds.min.z) / md;
            const w = zaX / total;
            const c = _zoneColor(rawU, rawV, settings, rotRad,
              dispAspectU, dispAspectV, colAspectU, colAspectV,
              displacementImageData, dispW, dispH,
              colorImageData, colorW, colorH,
              gradientStops, haveGradient, haveImage, baseRGB);
            rOut += c[0] * w; gOut += c[1] * w; bOut += c[2] * w;
          }
          if (zaY > 0) { // Y-dominant zone → XZ projection
            let rawU = (tmpPos.x - bounds.min.x) / md;
            if (smoothNrmY[vid] > 0) rawU = -rawU;
            const rawV = (tmpPos.z - bounds.min.z) / md;
            const w = zaY / total;
            const c = _zoneColor(rawU, rawV, settings, rotRad,
              dispAspectU, dispAspectV, colAspectU, colAspectV,
              displacementImageData, dispW, dispH,
              colorImageData, colorW, colorH,
              gradientStops, haveGradient, haveImage, baseRGB);
            rOut += c[0] * w; gOut += c[1] * w; bOut += c[2] * w;
          }
          if (zaZ > 0) { // Z-dominant zone → XY projection
            let rawU = (tmpPos.x - bounds.min.x) / md;
            if (smoothNrmZ[vid] < 0) rawU = -rawU;
            const rawV = (tmpPos.y - bounds.min.y) / md;
            const w = zaZ / total;
            const c = _zoneColor(rawU, rawV, settings, rotRad,
              dispAspectU, dispAspectV, colAspectU, colAspectV,
              displacementImageData, dispW, dispH,
              colorImageData, colorW, colorH,
              gradientStops, haveGradient, haveImage, baseRGB);
            rOut += c[0] * w; gOut += c[1] * w; bOut += c[2] * w;
          }

          autoR[vid] = rOut;
          autoG[vid] = gOut;
          autoB[vid] = bOut;
          continue;
        }
      }

      // Non-cubic: use computeUV with the smooth normal.
      tmpNrm.set(smoothNrmX[vid], smoothNrmY[vid], smoothNrmZ[vid]);

      if (haveGradient) {
        const uvResult = computeUV(tmpPos, tmpNrm, settings.mappingMode, dispSettings, bounds);
        let grey;
        if (uvResult.triplanar) {
          grey = 0;
          for (const s of uvResult.samples) {
            grey += _sampleBilinearGrey(displacementImageData.data, dispW, dispH, s.u, s.v) * s.w;
          }
        } else {
          grey = _sampleBilinearGrey(displacementImageData.data, dispW, dispH, uvResult.u, uvResult.v);
        }
        const rgb = _sampleGradient(gradientStops, grey);
        autoR[vid] = rgb[0]; autoG[vid] = rgb[1]; autoB[vid] = rgb[2];
      } else if (haveImage) {
        const uvResult = computeUV(tmpPos, tmpNrm, settings.mappingMode, colSettings, bounds);
        let r = 0, g = 0, b = 0;
        if (uvResult.triplanar) {
          for (const s of uvResult.samples) {
            const c = _sampleBilinearRGB(colorImageData.data, colorW, colorH, s.u, s.v);
            r += c[0] * s.w; g += c[1] * s.w; b += c[2] * s.w;
          }
        } else {
          const c = _sampleBilinearRGB(colorImageData.data, colorW, colorH, uvResult.u, uvResult.v);
          r = c[0]; g = c[1]; b = c[2];
        }
        autoR[vid] = r; autoG[vid] = g; autoB[vid] = b;
      } else {
        autoR[vid] = baseRGB[0]; autoG[vid] = baseRGB[1]; autoB[vid] = baseRGB[2];
      }
    }
  }

  // ── Pass 3: write per-vertex-copy color, applying per-face overrides ──────
  // Per-face excluded flag (matches displacement.js semantics): a face is excluded
  // iff the AVERAGE of its 3 vertex weights > 0.99. Per-vertex thresholding fails
  // at the cube's bottom-face corners because subdivision dedups corner weights to
  // either the side-face copy (w=0) or the bottom-face copy (w=1) depending on
  // iteration order, leaving partial-weight subdivided vertices that the per-vertex
  // check would falsely treat as non-excluded.
  const faceCount = (count / 3) | 0;
  const faceExcluded = new Uint8Array(faceCount);
  if (ewAttr) {
    const ewArr = ewAttr.array;
    for (let f = 0; f < faceCount; f++) {
      const avg = (ewArr[f * 3] + ewArr[f * 3 + 1] + ewArr[f * 3 + 2]) / 3;
      if (avg > 0.99) faceExcluded[f] = 1;
    }
  }

  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const subdivFaceIdx = (i / 3) | 0;

    // Excluded faces always get base color regardless of auto source.
    let r, g, b;
    if (faceExcluded[subdivFaceIdx]) {
      r = baseRGB[0]; g = baseRGB[1]; b = baseRGB[2];
    } else if (useAuto) {
      const vid = vertexId[i];
      r = autoR[vid]; g = autoG[vid]; b = autoB[vid];
    } else {
      r = baseRGB[0]; g = baseRGB[1]; b = baseRGB[2];
    }

    out[i * 3]     = r;
    out[i * 3 + 1] = g;
    out[i * 3 + 2] = b;
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(out, 3));
  return geometry;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Compute one cubic-zone color contribution.
 * Returns [r, g, b] (0..1). Picks gradient or image branch based on flags;
 * displacement and color images have separate aspect-corrected UVs.
 */
function _zoneColor(rawU, rawV, settings, rotRad,
                    dAU, dAV, cAU, cAV,
                    dispImgData, dW, dH,
                    colImgData, cW, cH,
                    gradientStops, haveGradient, haveImage, baseRGB) {
  if (haveGradient) {
    const uv = _cubicUV(rawU, rawV, settings, rotRad, dAU, dAV);
    const grey = _sampleBilinearGrey(dispImgData.data, dW, dH, uv.u, uv.v);
    return _sampleGradient(gradientStops, grey);
  }
  if (haveImage) {
    const uv = _cubicUV(rawU, rawV, settings, rotRad, cAU, cAV);
    return _sampleBilinearRGB(colImgData.data, cW, cH, uv.u, uv.v);
  }
  return baseRGB;
}

/** Apply scale/offset/rotation to raw UV for cubic projection.
 *  Exact mirror of displacement.js's _cubicUV helper. */
function _cubicUV(rawU, rawV, settings, rotRad, aspectU, aspectV) {
  let u = (rawU * aspectU) / settings.scaleU + settings.offsetU;
  let v = (rawV * aspectV) / settings.scaleV + settings.offsetV;
  if (rotRad !== 0) {
    const c = Math.cos(rotRad), s = Math.sin(rotRad);
    u -= 0.5; v -= 0.5;
    const ru = c * u - s * v, rv = s * u + c * v;
    u = ru + 0.5; v = rv + 0.5;
  }
  return { u: u - Math.floor(u), v: v - Math.floor(v) };
}

/**
 * Sample a greyscale value (0–1) from raw RGBA ImageData using bilinear
 * interpolation. UV is tiled via mod 1. Mirrors displacement.js exactly.
 */
function _sampleBilinearGrey(data, w, h, u, v) {
  u = ((u % 1) + 1) % 1;
  v = ((v % 1) + 1) % 1;
  v = 1 - v;

  const fx = u * (w - 1);
  const fy = v * (h - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const tx = fx - x0;
  const ty = fy - y0;

  const v00 = data[(y0 * w + x0) * 4] / 255;
  const v10 = data[(y0 * w + x1) * 4] / 255;
  const v01 = data[(y1 * w + x0) * 4] / 255;
  const v11 = data[(y1 * w + x1) * 4] / 255;

  return v00 * (1 - tx) * (1 - ty)
       + v10 * tx * (1 - ty)
       + v01 * (1 - tx) * ty
       + v11 * tx * ty;
}

/**
 * Sample [r, g, b] (each 0–1) from raw RGBA ImageData using bilinear
 * interpolation. UV is tiled via mod 1.
 */
function _sampleBilinearRGB(data, w, h, u, v) {
  u = ((u % 1) + 1) % 1;
  v = ((v % 1) + 1) % 1;
  v = 1 - v;

  const fx = u * (w - 1);
  const fy = v * (h - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const tx = fx - x0;
  const ty = fy - y0;

  const i00 = (y0 * w + x0) * 4;
  const i10 = (y0 * w + x1) * 4;
  const i01 = (y1 * w + x0) * 4;
  const i11 = (y1 * w + x1) * 4;

  const w00 = (1 - tx) * (1 - ty);
  const w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty;
  const w11 = tx * ty;

  const r = (data[i00]     * w00 + data[i10]     * w10 + data[i01]     * w01 + data[i11]     * w11) / 255;
  const g = (data[i00 + 1] * w00 + data[i10 + 1] * w10 + data[i01 + 1] * w01 + data[i11 + 1] * w11) / 255;
  const b = (data[i00 + 2] * w00 + data[i10 + 2] * w10 + data[i01 + 2] * w01 + data[i11 + 2] * w11) / 255;
  return [r, g, b];
}

/** Parse a CSS hex color (#rgb / #rrggbb) → [r, g, b] in 0..1. */
function _parseHex(hex) {
  if (!hex || typeof hex !== 'string') return [1, 1, 1];
  let s = hex.trim();
  if (s[0] === '#') s = s.slice(1);
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  if (s.length !== 6) return [1, 1, 1];
  const n = parseInt(s, 16);
  if (!Number.isFinite(n)) return [1, 1, 1];
  return [
    ((n >> 16) & 0xff) / 255,
    ((n >>  8) & 0xff) / 255,
    ( n        & 0xff) / 255,
  ];
}

/**
 * Sample a sorted-by-pos gradient at parameter t ∈ [0, 1].
 * Stops are pre-sorted in applyColors. Linear interpolation between adjacent
 * stops; clamp at edges. Returns [r, g, b] in 0..1.
 */
function _sampleGradient(stops, t) {
  if (!stops || stops.length === 0) return [0, 0, 0];
  if (stops.length === 1) return stops[0].rgb.slice();
  if (t <= stops[0].pos) return stops[0].rgb.slice();
  const last = stops[stops.length - 1];
  if (t >= last.pos) return last.rgb.slice();

  // Linear scan is fine — N stops is small (typically 2–8).
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1], b = stops[i];
    if (t <= b.pos) {
      const span = b.pos - a.pos;
      const f = span > 1e-9 ? (t - a.pos) / span : 0;
      return [
        a.rgb[0] + (b.rgb[0] - a.rgb[0]) * f,
        a.rgb[1] + (b.rgb[1] - a.rgb[1]) * f,
        a.rgb[2] + (b.rgb[2] - a.rgb[2]) * f,
      ];
    }
  }
  return last.rgb.slice();
}
