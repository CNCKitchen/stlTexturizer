/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * CPU-side UV mapping — exact JavaScript mirror of the GLSL in previewMaterial.js.
 * All functions take Three.js Vector3 objects for position/normal and
 * a bounds object { min, max, center, size } (all THREE.Vector3).
 */

import { QuantizedPointMap } from './meshIndex.js';

export const MODE_PLANAR_XY   = 0;
export const MODE_PLANAR_XZ   = 1;
export const MODE_PLANAR_YZ   = 2;
export const MODE_CYLINDRICAL = 3;
export const MODE_SPHERICAL   = 4;
export const MODE_TRIPLANAR   = 5;
export const MODE_CUBIC       = 6;
export const MODE_SURFACE_NORMAL = 7;   // stamps only: along the surface normal at the stamp centre

const TWO_PI = Math.PI * 2;

/**
 * Reference lengths (mm) that one full UV unit spans along U and V, per
 * mapping mode. settings.scaleU/scaleV are absolute tile sizes in mm; the
 * internal math still works in normalized coordinates, so consumers divide
 * mm by these lengths to get the relative scale factor:
 *
 *   planar / triplanar / cubic: largest bbox edge (cancels against the
 *     coordinate normalization → texture is truly world-anchored)
 *   cylindrical: circumference of the projection cylinder (U = arc length,
 *     V is normalized by the same C in computeUV)
 *   spherical: equator arc for U, pole-to-pole meridian arc for V
 */
export function getScaleReferenceLengths(mode, settings, bounds) {
  const { size } = bounds;
  const md = Math.max(size.x, size.y, size.z, 1e-6);
  switch (mode) {
    case MODE_CYLINDRICAL: {
      const r = Math.max(settings.cylinderRadius ?? Math.max(size.x, size.y) * 0.5, 1e-6);
      const C = TWO_PI * r;
      return { refU: C, refV: C };
    }
    case MODE_SPHERICAL: {
      const R = Math.max(0.5 * md, 1e-6);
      return { refU: TWO_PI * R, refV: Math.PI * R };
    }
    default:
      return { refU: md, refV: md };
  }
}

/** Convert absolute mm tile sizes to the mode's relative scale factors. */
export function scaleMmToRelative(mode, settings, bounds) {
  const { refU, refV } = getScaleReferenceLengths(mode, settings, bounds);
  const u = Math.max(Number(settings.scaleU) || 1e-6, 1e-6) / refU;
  const v = Math.max(Number(settings.scaleV) || 1e-6, 1e-6) / refV;
  return { u, v };
}
const CUBIC_AXIS_EPSILON = 1e-4;

/**
 * "Rotate around Z" for the box-style projections (Triplanar, Cubic).
 *
 * By default the Rotation setting spins the texture inside every projection
 * plane, so on side faces a 90° turn stands the pattern on end (wood grain
 * goes vertical) instead of following the new direction it takes on top
 * faces. With settings.rotateAroundZ the side (XZ / YZ) projections are
 * instead turned around the vertical axis by the same angle — the top
 * projection is unchanged — so a directional pattern keeps one consistent
 * heading on top and side faces alike.
 */
export function isRotateAroundZ(settings) {
  return !!settings.rotateAroundZ && ((settings.rotation ?? 0) % 360) !== 0;
}

/**
 * Side-projection frame for rotateAroundZ: the position (relative to the
 * bbox, identical to pos - bounds.min at 0°) and normal turned about the
 * bbox's vertical centre line by the Rotation angle. Turning by +angle here
 * matches the heading the in-plane rotation gives the top projection.
 */
export function rotateSideFrame(px, py, nx, ny, bounds, cosR, sinR) {
  const rx = px - bounds.center.x;
  const ry = py - bounds.center.y;
  return {
    x:  cosR * rx - sinR * ry + 0.5 * bounds.size.x,
    y:  sinR * rx + cosR * ry + 0.5 * bounds.size.y,
    nx: cosR * nx - sinR * ny,
    ny: sinR * nx + cosR * ny,
  };
}

export function getDominantCubicAxis(normal) {
  const ax = Math.abs(normal.x);
  const ay = Math.abs(normal.y);
  const az = Math.abs(normal.z);

  // Treat near-ties as an intentional tie so 45° faces pick one stable axis
  // instead of flipping projection due to tiny normal jitter between triangles.
  if (ax >= ay - CUBIC_AXIS_EPSILON && ax >= az - CUBIC_AXIS_EPSILON) return 'x';
  if (ay >= az - CUBIC_AXIS_EPSILON) return 'y';
  return 'z';
}

export function getCubicBlendWeights(normal, blend, seamBandWidth = 0.35) {
  const axis = getDominantCubicAxis(normal);
  const ax = Math.abs(normal.x);
  const ay = Math.abs(normal.y);
  const az = Math.abs(normal.z);
  const primary = axis === 'x' ? ax : axis === 'y' ? ay : az;
  const secondary = axis === 'x' ? Math.max(ay, az) : axis === 'y' ? Math.max(ax, az) : Math.max(ax, ay);

  // blend=0: hard one-hot for sharp seams. Do NOT also short-circuit at the
  // primary≈secondary tie when blend>0 — the smooth weight branch handles
  // an exact 45° normal correctly (it produces 0.5/0.5), and short-circuiting
  // to one-hot there creates a single-vertex spike on fillets where the
  // smooth normal sweeps continuously across the cube-face boundary.
  if (blend <= 0.001) {
    return {
      x: axis === 'x' ? 1 : 0,
      y: axis === 'y' ? 1 : 0,
      z: axis === 'z' ? 1 : 0,
    };
  }

  const oneHot = {
    x: axis === 'x' ? 1 : 0,
    y: axis === 'y' ? 1 : 0,
    z: axis === 'z' ? 1 : 0,
  };

  // Only blend inside a seam band around the cube-face boundary. This keeps
  // strongly dominant faces fully textured even when the slider is barely on.
  const seamWidth = Math.max(seamBandWidth, CUBIC_AXIS_EPSILON * 2);
  const seamMixRaw = 1 - Math.min(1, Math.max(0, (primary - secondary) / seamWidth));
  const seamMix = blend * seamMixRaw * seamMixRaw * (3 - 2 * seamMixRaw);
  if (seamMix <= 0.001) return oneHot;

  // blend=1 should produce a genuinely soft triplanar-style transition.
  // Lower blend values progressively sharpen the weights back toward a single
  // dominant axis without snapping until the slider reaches zero.
  const power = 1 + (1 - seamMix) * 11;
  const sx = Math.pow(ax, power);
  const sy = Math.pow(ay, power);
  const sz = Math.pow(az, power);
  const smoothSum = sx + sy + sz + 1e-6;
  const smooth = {
    x: sx / smoothSum,
    y: sy / smoothSum,
    z: sz / smoothSum,
  };

  const mx = oneHot.x * (1 - seamMix) + smooth.x * seamMix;
  const my = oneHot.y * (1 - seamMix) + smooth.y * seamMix;
  const mz = oneHot.z * (1 - seamMix) + smooth.z * seamMix;
  const sum = mx + my + mz;

  return {
    x: mx / sum,
    y: my / sum,
    z: mz / sum,
  };
}

/**
 * Compute normalised UV coordinates [0, 1) (tiling) for a vertex.
 *
 * @param {{ x:number, y:number, z:number }} pos      vertex position
 * @param {{ x:number, y:number, z:number }} normal   vertex normal (unit)
 * @param {number}  mode    one of the MODE_* constants
 * @param {{ scaleU:number, scaleV:number, offsetU:number, offsetV:number }} settings
 * @param {{ min, max, center, size }} bounds           THREE.Vector3 fields
 * @returns {{ u:number, v:number }}                    tiled UV after scale+offset
 */
export function computeUV(pos, normal, mode, settings, bounds) {
  const { min, size, center } = bounds;
  // Compensate for non-square textures: divide scale by aspect correction
  // so equal world-space distances produce equal physical texture distances.
  const aU = settings.textureAspectU ?? 1;
  const aV = settings.textureAspectV ?? 1;
  // settings.scaleU/scaleV are absolute mm — convert to the relative factors
  // the normalized-coordinate math below expects.
  const rel = scaleMmToRelative(mode, settings, bounds);
  const scaleU = rel.u / aU;
  const scaleV = rel.v / aV;
  const { offsetU, offsetV } = settings;
  const rotRad = (settings.rotation ?? 0) * Math.PI / 180;
  const cosR = Math.cos(rotRad);
  const sinR = Math.sin(rotRad);
  const md = Math.max(size.x, size.y, size.z, 1e-6);

  let u = 0, v = 0;

  switch (mode) {

    case MODE_PLANAR_XY: {
      u = (pos.x - min.x) / md;
      v = (pos.y - min.y) / md;
      break;
    }

    case MODE_PLANAR_XZ: {
      u = (pos.x - min.x) / md;
      v = (pos.z - min.z) / md;
      break;
    }

    case MODE_PLANAR_YZ: {
      u = (pos.y - min.y) / md;
      v = (pos.z - min.z) / md;
      break;
    }

    case MODE_CYLINDRICAL: {
      // mappingBlend=0 → pure side projection for all faces (original behaviour, no cap seam).
      // mappingBlend>0 → smooth side↔cap blend.
      // Cylinder axis is +Z. Center XY and radius default to the AABB but can
      // be overridden so partial cylinders (pie slices) project undistorted.
      const cx = settings.cylinderCenterX ?? center.x;
      const cy = settings.cylinderCenterY ?? center.y;
      const r  = Math.max(settings.cylinderRadius ?? Math.max(size.x, size.y) * 0.5, 1e-6);
      const C  = TWO_PI * r;
      const rx = pos.x - cx;
      const ry = pos.y - cy;
      const blend = settings.mappingBlend ?? 0.0;
      const theta = Math.atan2(ry, rx);
      const uRaw = (theta / TWO_PI) + 0.5;
      const vSide = (pos.z - min.z) / C;

      // Seam smoothing: cross-fade between left-side and right-side texture
      // continuations at the atan2 wrap. Both sides use smoothly varying UVs
      // (shifted by ±1.0 in raw space), preserving full texture detail.
      const seamBand = (settings.seamBandWidth ?? 0.5) * 0.1;
      const seamDist = Math.min(uRaw, 1.0 - uRaw);
      const inSeamZone = seamBand > 0.001 && seamDist < seamBand;

      let sideSamples;
      if (inSeamZone) {
        const d = uRaw < 0.5 ? uRaw : uRaw - 1.0;
        const tRaw = (d + seamBand) / (2.0 * seamBand);
        const t = tRaw * tRaw * (3 - 2 * tRaw); // smoothstep
        const tLeft  = applyTransform(1.0 + d, vSide, scaleU, scaleV, offsetU, offsetV, cosR, sinR);
        const tRight = applyTransform(d,       vSide, scaleU, scaleV, offsetU, offsetV, cosR, sinR);
        sideSamples = [
          { u: tRight.u, v: tRight.v, w: t },
          { u: tLeft.u,  v: tLeft.v,  w: 1 - t },
        ];
      } else {
        const tSide = applyTransform(uRaw, vSide, scaleU, scaleV, offsetU, offsetV, cosR, sinR);
        sideSamples = [{ u: tSide.u, v: tSide.v, w: 1 }];
      }

      if (blend <= 0.001) {
        if (sideSamples.length === 1 && sideSamples[0].w === 1) return sideSamples[0];
        return { triplanar: true, samples: sideSamples };
      }

      const capThreshold = Math.cos((settings.capAngle ?? 20) * Math.PI / 180);
      const blendHalf = (settings.seamBandWidth ?? 0.5) * 0.5;
      const absnz = Math.abs(normal.z);
      const capRaw = Math.max(0, Math.min(1, (absnz - (capThreshold - blendHalf)) / (2 * blendHalf + 1e-6)));
      const capW = capRaw * capRaw * (3 - 2 * capRaw); // smoothstep, as in the preview shader

      if (capW <= 0) {
        if (sideSamples.length === 1 && sideSamples[0].w === 1) return sideSamples[0];
        return { triplanar: true, samples: sideSamples };
      }

      const uCap  = rx / C + 0.5;
      const vCap  = ry / C + 0.5;
      const tCap = applyTransform(uCap, vCap, scaleU, scaleV, offsetU, offsetV, cosR, sinR);

      if (capW >= 1) {
        return tCap;
      }

      // Combine seam-blended side samples with cap sample
      const samples = sideSamples.map(s => ({ u: s.u, v: s.v, w: s.w * (1 - capW) }));
      samples.push({ u: tCap.u, v: tCap.v, w: capW });
      return { triplanar: true, samples };
    }

    case MODE_SPHERICAL: {
      const rx = pos.x - center.x;
      const ry = pos.y - center.y;
      const rz = pos.z - center.z;
      const r  = Math.sqrt(rx*rx + ry*ry + rz*rz);
      const phi   = Math.acos(Math.max(-1, Math.min(1, rz / Math.max(r, 1e-6)))); // [0, PI], Z is up
      const theta = Math.atan2(ry, rx);              // [-PI, PI]
      const uRaw = (theta / TWO_PI) + 0.5;
      const vRaw = phi / Math.PI;

      // Seam smoothing: cross-fade at the atan2 wrap
      const seamBand = (settings.seamBandWidth ?? 0.5) * 0.1;
      const seamDist = Math.min(uRaw, 1.0 - uRaw);
      if (seamBand > 0.001 && seamDist < seamBand) {
        const d = uRaw < 0.5 ? uRaw : uRaw - 1.0;
        const tRaw = (d + seamBand) / (2.0 * seamBand);
        const t = tRaw * tRaw * (3 - 2 * tRaw); // smoothstep
        const tLeft  = applyTransform(1.0 + d, vRaw, scaleU, scaleV, offsetU, offsetV, cosR, sinR);
        const tRight = applyTransform(d,       vRaw, scaleU, scaleV, offsetU, offsetV, cosR, sinR);
        return {
          triplanar: true,
          samples: [
            { u: tRight.u, v: tRight.v, w: t },
            { u: tLeft.u,  v: tLeft.v,  w: 1 - t },
          ],
        };
      }

      u = uRaw;
      v = vRaw;
      break;
    }

    case MODE_CUBIC: {
      // rotateAroundZ: side projections work in the Z-rotated frame and get
      // no in-plane rotation (see isRotateAroundZ).
      const aroundZ = isRotateAroundZ(settings);
      const sf = aroundZ ? rotateSideFrame(pos.x, pos.y, normal.x, normal.y, bounds, cosR, sinR) : null;
      const sideNormal = aroundZ ? { x: sf.nx, y: sf.ny, z: normal.z } : normal;
      const sideCos = aroundZ ? 1 : cosR, sideSin = aroundZ ? 0 : sinR;
      const weights = getCubicBlendWeights(sideNormal, settings.mappingBlend ?? 0.0, settings.seamBandWidth ?? 0.35);
      // Flip U based on normal sign so opposite faces show correct (non-mirrored) text.
      // Derived from camera right = view_dir × up_dir for each face orientation (Z-up).
      let yzU = (aroundZ ? sf.y : pos.y - min.y) / md;
      if (sideNormal.x < 0) yzU = -yzU;
      let xzU = (aroundZ ? sf.x : pos.x - min.x) / md;
      if (sideNormal.y > 0) xzU = -xzU;
      let xyU = (pos.x - min.x) / md;
      if (normal.z < 0) xyU = -xyU;
      const tYZ = applyTransform(yzU, (pos.z - min.z) / md, scaleU, scaleV, offsetU, offsetV, sideCos, sideSin);
      const tXZ = applyTransform(xzU, (pos.z - min.z) / md, scaleU, scaleV, offsetU, offsetV, sideCos, sideSin);
      const tXY = applyTransform(xyU, (pos.y - min.y) / md, scaleU, scaleV, offsetU, offsetV, cosR, sinR);

      if (weights.x > 0.999) return tYZ;
      if (weights.y > 0.999) return tXZ;
      if (weights.z > 0.999) return tXY;

      return {
        triplanar: true,
        samples: [
          { u: tXY.u, v: tXY.v, w: weights.z },
          { u: tXZ.u, v: tXZ.v, w: weights.y },
          { u: tYZ.u, v: tYZ.v, w: weights.x },
        ],
      };
    }

    case MODE_TRIPLANAR:
    default: {
      // rotateAroundZ: side projections work in the Z-rotated frame and get
      // no in-plane rotation (see isRotateAroundZ).
      const aroundZ = isRotateAroundZ(settings);
      const sf = aroundZ ? rotateSideFrame(pos.x, pos.y, normal.x, normal.y, bounds, cosR, sinR) : null;
      const snx = aroundZ ? sf.nx : normal.x, sny = aroundZ ? sf.ny : normal.y;
      const sideCos = aroundZ ? 1 : cosR, sideSin = aroundZ ? 0 : sinR;
      // World-space normal blending
      const ax = Math.abs(snx);
      const ay = Math.abs(sny);
      const az = Math.abs(normal.z);
      const ax2 = ax * ax, ay2 = ay * ay, az2 = az * az;
      const bx = ax2 * ax2;
      const by = ay2 * ay2;
      const bz = az2 * az2;
      const sum = bx + by + bz + 1e-6;
      const wx = bx / sum;
      const wy = by / sum;
      const wz = bz / sum;

      // Flip U based on normal sign so opposite faces show correct (non-mirrored) text.
      let yzU = (aroundZ ? sf.y : pos.y - min.y) / md;
      if (snx < 0) yzU = -yzU;
      let xzU = (aroundZ ? sf.x : pos.x - min.x) / md;
      if (sny > 0) xzU = -xzU;
      let xyU = (pos.x - min.x) / md;
      if (normal.z < 0) xyU = -xyU;
      const uvXY = {
        u: xyU,
        v: (pos.y - min.y) / md,
        w: wz,
      };
      const uvXZ = {
        u: xzU,
        v: (pos.z - min.z) / md,
        w: wy,
      };
      const uvYZ = {
        u: yzU,
        v: (pos.z - min.z) / md,
        w: wx,
      };

      // Apply scale+offset+rotation and tile each independently
      return {
        triplanar: true,
        samples: [
          { ...applyTransform(uvXY.u, uvXY.v, scaleU, scaleV, offsetU, offsetV, cosR, sinR), w: uvXY.w },
          { ...applyTransform(uvXZ.u, uvXZ.v, scaleU, scaleV, offsetU, offsetV, sideCos, sideSin), w: uvXZ.w },
          { ...applyTransform(uvYZ.u, uvYZ.v, scaleU, scaleV, offsetU, offsetV, sideCos, sideSin), w: uvYZ.w },
        ],
      };
    }
  }

  return applyTransform(u, v, scaleU, scaleV, offsetU, offsetV, cosR, sinR);
}

// ── Stamp ("place once") ─────────────────────────────────────────────────────
// A stamp layer shows its image exactly once instead of tiling: centred on a
// picked surface point, sized by scaleU/scaleV (mm, aspect-corrected like a
// tile), rotated about its centre, and only on surfaces that face the stamp
// side. Outside that footprint the layer has zero coverage — it neither
// displaces nor covers the layers below. Mirrored by stampFrame /
// stampCoverAt in the GLSL of previewMaterial.js.

// Facing fade: coverage ramps from 0 at FACING_LO (≈ 81° from the projection
// axis) to 1 at FACING_HI (≈ 73°), so the stamp fades out instead of smearing
// down walls the projection hits edge-on.
export const STAMP_FACING_LO = 0.15;
export const STAMP_FACING_HI = 0.30;

/** True when this layer's settings place the image once (surface normal, planar and cylindrical modes only). */
export function isStampActive(settings) {
  const mode = settings.mappingMode;
  return !!settings.stampOnce && ((mode >= MODE_PLANAR_XY && mode <= MODE_CYLINDRICAL) || mode === MODE_SURFACE_NORMAL);
}

// A surface whose normal leans less than this from vertical (horizontal
// component ≈ sin 10°) counts as flat for a Surface-normal stamp's orientation.
const STAMP_FLAT = 0.17;

/**
 * In-plane axes of a Surface-normal stamp with unit normal n: u (image
 * right) and v (image up), so the image reads unmirrored from outside. v is
 * +Z projected onto the surface (the image's top points uphill), or +Y on
 * flat tops and bottoms like Planar XY. For axis-aligned normals these are
 * exactly the Planar XY / XZ / YZ stamp's axes.
 */
export function stampAxes(nx, ny, nz) {
  let vx, vy, vz;
  if (Math.hypot(nx, ny) < STAMP_FLAT) { vx = -ny * nx; vy = 1 - ny * ny; vz = -ny * nz; }
  else { vx = -nz * nx; vy = -nz * ny; vz = 1 - nz * nz; }
  const len = Math.hypot(vx, vy, vz);
  vx /= len; vy /= len; vz /= len;
  return { ux: vy * nz - vz * ny, uy: vz * nx - vx * nz, uz: vx * ny - vy * nx, vx, vy, vz };   // u = v × n
}

/**
 * Default stamp side per mode: the side each projection shows unmirrored
 * (top for XY, front (−Y) for XZ, +X for YZ, outside for cylindrical).
 */
export function defaultStampSide(mode) {
  return mode === MODE_PLANAR_XZ ? -1 : 1;
}

/**
 * Per-layer stamp placement, resolved once: centre (model mm), facing side,
 * footprint size (mm), rotation and the cylinder axis; for Surface normal
 * the projection normal n and its in-plane axes u, v (stampAxes), always on
 * side +1. A null centre falls back to the bounds centre — for cylindrical,
 * the front (−Y) point of the projection cylinder at mid height — and a
 * null normal to the front (−Y).
 */
export function stampFrame(settings, bounds) {
  const mode = settings.mappingMode;
  const ccx = settings.cylinderCenterX ?? bounds.center.x;
  const ccy = settings.cylinderCenterY ?? bounds.center.y;
  const r   = Math.max(settings.cylinderRadius ?? Math.max(bounds.size.x, bounds.size.y) * 0.5, 1e-6);
  let cx = settings.stampCenterX, cy = settings.stampCenterY, cz = settings.stampCenterZ;
  if (cx == null || cy == null || cz == null) {
    cx = bounds.center.x; cy = bounds.center.y; cz = bounds.center.z;
    if (mode === MODE_CYLINDRICAL) { cx = ccx; cy = ccy - r; }
  }
  let side = (settings.stampSide === 1 || settings.stampSide === -1) ? settings.stampSide : defaultStampSide(mode);
  let nx = 0, ny = -1, nz = 0;
  if (mode === MODE_SURFACE_NORMAL) {
    side = 1;
    const len = Math.hypot(settings.stampNormalX ?? 0, settings.stampNormalY ?? 0, settings.stampNormalZ ?? 0);
    if (len > 1e-9) { nx = settings.stampNormalX / len; ny = settings.stampNormalY / len; nz = settings.stampNormalZ / len; }
  }
  const rotRad = (settings.rotation ?? 0) * Math.PI / 180;
  return {
    mode, cx, cy, cz, side, ccx, ccy, r,
    nx, ny, nz, ...stampAxes(nx, ny, nz),
    sizeU: Math.max(Number(settings.scaleU) || 1e-6, 1e-6) / (settings.textureAspectU ?? 1),
    sizeV: Math.max(Number(settings.scaleV) || 1e-6, 1e-6) / (settings.textureAspectV ?? 1),
    cosR: Math.cos(rotRad), sinR: Math.sin(rotRad),
    // Smooth Mask: the layer's falloff distance (mm) and curve also fade the
    // stamp's own border.
    fade: Math.max(Number(settings.boundaryFalloff) || 0, 0),
    fadeCurve: settings.boundaryFalloffCurve ?? 'linear',
  };
}

/** The Smooth Mask ramp shapes — must match applyFalloffCurve in main.js and the shader. */
function _falloffCurve(t, mode) {
  if (mode === 'scurve') return t * t * (3 - 2 * t);
  if (mode === 'ease')   return t * t;
  return t;
}

/**
 * Stamp UV at a point: { u, v } in [0, 1] inside the footprint (not wrapped)
 * and `cover` in [0, 1] — 0 outside the footprint or on surfaces facing away,
 * ramping up from the footprint's edge when the layer has a Smooth Mask.
 * Mirroring follows the triplanar convention, so the image reads correctly
 * from whichever side it is placed on.
 */
export function stampUV(pos, normal, frame) {
  const ab = _stampAB(pos.x, pos.y, pos.z, frame, _ab);
  const facing = _stampFacing(normal.x, normal.y, normal.z, pos.x, pos.y, pos.z, frame);
  const ra = frame.cosR * ab.a - frame.sinR * ab.b;
  const rb = frame.sinR * ab.a + frame.cosR * ab.b;
  const u = ra / frame.sizeU + 0.5;
  const v = rb / frame.sizeV + 0.5;
  const inside = u >= 0 && u <= 1 && v >= 0 && v <= 1;
  let cover = 0;
  if (inside) {
    const t = Math.max(0, Math.min(1, (facing - STAMP_FACING_LO) / (STAMP_FACING_HI - STAMP_FACING_LO)));
    cover = t * t * (3 - 2 * t);
    if (frame.fade > 0) {
      // Distance (mm) to the nearest footprint edge, in the stamp's own frame.
      const edge = Math.min(Math.min(u, 1 - u) * frame.sizeU, Math.min(v, 1 - v) * frame.sizeV);
      cover *= _falloffCurve(Math.min(1, edge / frame.fade), frame.fadeCurve);
    }
    // Only the surface nearest the stamp gets it, not the ones behind.
    if (cover > 0 && frame.depth
        && _stampOccluded(u, v, _stampHeight(pos.x, pos.y, pos.z, frame), facing, frame.depth)) cover = 0;
  }
  return { u, v, cover };
}

const _ab = { a: 0, b: 0, dth: 0 };

/**
 * Stamp-plane coordinates (mm, mirrored for the side, before rotation) of a
 * point: planar axes, the u / v axes for surface normal, or arc length at
 * the projection radius and height for cylindrical (dth = angle from the
 * centre, in (−π, π]).
 */
function _stampAB(x, y, z, frame, out) {
  const { mode, side } = frame;
  let a, b;
  if (mode === MODE_SURFACE_NORMAL) {
    const dx = x - frame.cx, dy = y - frame.cy, dz = z - frame.cz;
    a = dx * frame.ux + dy * frame.uy + dz * frame.uz;
    b = dx * frame.vx + dy * frame.vy + dz * frame.vz;
  } else if (mode === MODE_PLANAR_XY) {
    a = x - frame.cx; b = y - frame.cy;
    if (side < 0) a = -a;
  } else if (mode === MODE_PLANAR_XZ) {
    a = x - frame.cx; b = z - frame.cz;
    if (side > 0) a = -a;
  } else if (mode === MODE_PLANAR_YZ) {
    a = y - frame.cy; b = z - frame.cz;
    if (side < 0) a = -a;
  } else {
    const rpx = x - frame.ccx, rpy = y - frame.ccy;
    const rcx = frame.cx - frame.ccx, rcy = frame.cy - frame.ccy;
    out.dth = Math.atan2(rcx * rpy - rcy * rpx, rcx * rpx + rcy * rpy);
    a = out.dth * frame.r; b = z - frame.cz;
    if (side < 0) a = -a;
  }
  out.a = a; out.b = b;
  return out;
}

/** Cosine between a normal and the stamp axis on the stamp side (outward radial for cylindrical). */
function _stampFacing(nx, ny, nz, x, y, z, frame) {
  const { mode, side } = frame;
  const nLen = Math.hypot(nx, ny, nz) || 1;
  let facing;
  if (mode === MODE_SURFACE_NORMAL) facing = nx * frame.nx + ny * frame.ny + nz * frame.nz;
  else if (mode === MODE_PLANAR_XY) facing = nz * side;
  else if (mode === MODE_PLANAR_XZ) facing = ny * side;
  else if (mode === MODE_PLANAR_YZ) facing = nx * side;
  else {
    const rpx = x - frame.ccx, rpy = y - frame.ccy;
    const lp = Math.hypot(rpx, rpy);
    facing = lp > 1e-6 ? (nx * rpx + ny * rpy) / lp * side : 0;
  }
  return facing / nLen;
}

// ── Stamp occlusion ──────────────────────────────────────────────────────────
// A projection runs straight through the part, so without a depth test every
// surface facing the stamp side inside the footprint would get the stamp —
// also those hidden behind the one it was placed on. Like a shadow map, the
// depth map stores per footprint texel the height (toward the stamp side) of
// the nearest surface; a point is stamped only when it is that surface.

// Texels along the footprint's longer side.
export const STAMP_DEPTH_RES = 512;
// Base tolerance (mm) for "is the nearest surface"; a slope-dependent part is
// added per point, since a texel holds one height for a whole texel of surface.
const STAMP_DEPTH_TOL = 0.05;
// Texel no surface reaches (nothing in front).
export const STAMP_DEPTH_EMPTY = -1e30;
// Conservative rasterisation radius (hidden-face test): a texel counts when its
// centre is within half a texel diagonal of the triangle, so every texel a
// corner's lookup lands on is included.
const HALF_DIAG = Math.SQRT1_2 + 1e-6;

/** Height of a point toward the stamp side: along the axis (planar), the normal (surface normal) or the radius (cylindrical). */
function _stampHeight(x, y, z, frame) {
  const { mode, side } = frame;
  if (mode === MODE_SURFACE_NORMAL) return x * frame.nx + y * frame.ny + z * frame.nz;
  if (mode === MODE_PLANAR_XY) return z * side;
  if (mode === MODE_PLANAR_XZ) return y * side;
  if (mode === MODE_PLANAR_YZ) return x * side;
  return Math.hypot(x - frame.ccx, y - frame.ccy) * side;
}

function _segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/**
 * Visit the depth texels (i, j) of a triangle given in texel-centre
 * coordinates: those whose centre lies inside it (edges included — a surface's
 * triangles tile it, so every centre under it is visited, however thin they
 * are), or with `conservative`, within half a texel diagonal of it.
 */
function _stampTriTexels(tx, ty, nu, nv, visit, conservative = false) {
  const pad = conservative ? HALF_DIAG : 0;
  const i0 = Math.max(0, Math.ceil(Math.min(tx[0], tx[1], tx[2]) - pad));
  const i1 = Math.min(nu - 1, Math.floor(Math.max(tx[0], tx[1], tx[2]) + pad));
  const j0 = Math.max(0, Math.ceil(Math.min(ty[0], ty[1], ty[2]) - pad));
  const j1 = Math.min(nv - 1, Math.floor(Math.max(ty[0], ty[1], ty[2]) + pad));
  if (i0 > i1 || j0 > j1) return;
  const area = (tx[1] - tx[0]) * (ty[2] - ty[0]) - (tx[2] - tx[0]) * (ty[1] - ty[0]);
  const sgn = area >= 0 ? 1 : -1;
  const eps = -1e-9 * Math.abs(area);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      let inside = area !== 0;
      for (let k = 0; inside && k < 3; k++) {
        const k1 = k === 2 ? 0 : k + 1;
        if (sgn * ((tx[k1] - tx[k]) * (j - ty[k]) - (ty[k1] - ty[k]) * (i - tx[k])) < eps) inside = false;
      }
      if (inside || (conservative && (
          _segDist(i, j, tx[0], ty[0], tx[1], ty[1]) <= HALF_DIAG
          || _segDist(i, j, tx[1], ty[1], tx[2], ty[2]) <= HALF_DIAG
          || _segDist(i, j, tx[2], ty[2], tx[0], ty[0]) <= HALF_DIAG))) visit(i, j);
    }
  }
}

/**
 * Footprint depth map of a non-indexed position array for a stamp frame:
 * { data: Float32Array(nu·nv), nu, nv, texel (mm) }, row j = v. Each texel
 * holds the largest stamp-side height of the triangles over its centre,
 * taken exactly from each triangle's plane along the projection ray (so the
 * chord sag of a faceted cylinder never hides its own surface). `res` sets
 * the texels along the longer side (coarser while dragging). Skipped:
 * triangles seen edge-on (they cover no area — walls along the projection,
 * a cylinder's end caps), and those straddling the cylinder axis or its back
 * seam, which are never in front of the stamped side.
 */
export function buildStampDepth(pos, frame, res = STAMP_DEPTH_RES) {
  const triCount = pos.length / 9;
  const big = Math.max(frame.sizeU, frame.sizeV);
  const nu = Math.max(16, Math.round(res * frame.sizeU / big));
  const nv = Math.max(16, Math.round(res * frame.sizeV / big));
  const data = new Float32Array(nu * nv).fill(STAMP_DEPTH_EMPTY);
  const { mode, side, cosR: cr, sinR: sr, sizeU, sizeV } = frame;
  const cyl = mode === MODE_CYLINDRICAL;
  const thC = cyl ? Math.atan2(frame.cy - frame.ccy, frame.cx - frame.ccx) : 0;
  const ab = { a: 0, b: 0, dth: 0 };
  const tx = new Float64Array(3), ty = new Float64Array(3), th = new Float64Array(3);
  const pa = new Float64Array(3), pb = new Float64Array(3);
  // Cylindrical prefilter: skip triangles wholly above or below the footprint
  // (it reaches at most half its diagonal from the centre height) before the
  // per-corner atan2.
  const reach = 0.5 * Math.hypot(sizeU, sizeV) + 1e-6;
  const zLo = frame.cz - reach, zHi = frame.cz + reach;

  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    if (cyl) {
      const z0 = pos[o + 2], z1 = pos[o + 5], z2 = pos[o + 8];
      if ((z0 > zHi && z1 > zHi && z2 > zHi) || (z0 < zLo && z1 < zLo && z2 < zLo)) continue;
    }
    let hmin = Infinity, hmax = -Infinity, thMin = Infinity, thMax = -Infinity;
    for (let k = 0; k < 3; k++) {
      const x = pos[o + k * 3], y = pos[o + k * 3 + 1], z = pos[o + k * 3 + 2];
      _stampAB(x, y, z, frame, ab);
      pa[k] = ab.a; pb[k] = ab.b;
      tx[k] = ((cr * ab.a - sr * ab.b) / sizeU + 0.5) * nu - 0.5;
      ty[k] = ((sr * ab.a + cr * ab.b) / sizeV + 0.5) * nv - 0.5;
      const h = th[k] = _stampHeight(x, y, z, frame);
      if (h < hmin) hmin = h; if (h > hmax) hmax = h;
      if (cyl) { if (ab.dth < thMin) thMin = ab.dth; if (ab.dth > thMax) thMax = ab.dth; }
    }
    const i0 = Math.max(0, Math.ceil(Math.min(tx[0], tx[1], tx[2])));
    const i1 = Math.min(nu - 1, Math.floor(Math.max(tx[0], tx[1], tx[2])));
    const j0 = Math.max(0, Math.ceil(Math.min(ty[0], ty[1], ty[2])));
    const j1 = Math.min(nv - 1, Math.floor(Math.max(ty[0], ty[1], ty[2])));
    if (i0 > i1 || j0 > j1) continue;                       // no texel centre under it
    // Edge-on: no area in the stamp plane (measured before the rotation, so a
    // wall along the projection comes out exactly flat).
    const areaAB = (pa[1] - pa[0]) * (pb[2] - pb[0]) - (pa[2] - pa[0]) * (pb[1] - pb[0]);
    const span = Math.max(Math.abs(pa[1] - pa[0]), Math.abs(pa[2] - pa[0]), Math.abs(pb[1] - pb[0]), Math.abs(pb[2] - pb[0]));
    if (Math.abs(areaAB) <= 1e-9 * span * span) continue;
    if (cyl && (thMax - thMin > Math.PI || _triContainsAxis(pos, o, frame.ccx, frame.ccy))) continue;

    // Edge functions in texel space; centres on an edge count (the surface's
    // triangles tile it, so every centre under it is written).
    const area = (tx[1] - tx[0]) * (ty[2] - ty[0]) - (tx[2] - tx[0]) * (ty[1] - ty[0]);
    const sgn = area >= 0 ? 1 : -1, eps = -1e-9 * Math.abs(area);
    // Planar: the height is affine over a flat triangle in texel space, so the
    // corner heights interpolate it exactly. Cylindrical: the ray through a
    // texel is radial, so solve the triangle's plane along it.
    let dhdi = 0, dhdj = 0, nx = 0, ny = 0, nz = 0, d = 0, nEps = 0;
    if (!cyl) {
      dhdi = ((th[1] - th[0]) * (ty[2] - ty[0]) - (th[2] - th[0]) * (ty[1] - ty[0])) / area;
      dhdj = ((th[2] - th[0]) * (tx[1] - tx[0]) - (th[1] - th[0]) * (tx[2] - tx[0])) / area;
    } else {
      const ax = pos[o], ay = pos[o + 1], az = pos[o + 2];
      const e1x = pos[o + 3] - ax, e1y = pos[o + 4] - ay, e1z = pos[o + 5] - az;
      const e2x = pos[o + 6] - ax, e2y = pos[o + 7] - ay, e2z = pos[o + 8] - az;
      nx = e1y * e2z - e1z * e2y; ny = e1z * e2x - e1x * e2z; nz = e1x * e2y - e1y * e2x;
      nEps = 1e-9 * (Math.hypot(nx, ny, nz) || 1);
      d = nx * ax + ny * ay + nz * az;
    }
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (sgn * ((tx[1] - tx[0]) * (j - ty[0]) - (ty[1] - ty[0]) * (i - tx[0])) < eps) continue;
        if (sgn * ((tx[2] - tx[1]) * (j - ty[1]) - (ty[2] - ty[1]) * (i - tx[1])) < eps) continue;
        if (sgn * ((tx[0] - tx[2]) * (j - ty[2]) - (ty[0] - ty[2]) * (i - tx[2])) < eps) continue;
        let h;
        if (!cyl) {
          h = th[0] + dhdi * (i - tx[0]) + dhdj * (j - ty[0]);
          if (h < hmin) h = hmin; else if (h > hmax) h = hmax;   // rounding at the edges
        } else {
          const ra = ((i + 0.5) / nu - 0.5) * sizeU, rb = ((j + 0.5) / nv - 0.5) * sizeV;
          const a = cr * ra + sr * rb, b = -sr * ra + cr * rb;
          const ang = thC + (side < 0 ? -a : a) / frame.r;
          const den = nx * Math.cos(ang) + ny * Math.sin(ang);
          const rad = Math.abs(den) < nEps ? NaN : (d - nx * frame.ccx - ny * frame.ccy - nz * (frame.cz + b)) / den;
          h = rad >= 0 ? rad * side : NaN;
          if (!(h <= hmax)) h = hmax;      // NaN / beyond the triangle: its highest corner
        }
        const k = j * nu + i;
        if (h > data[k]) data[k] = h;
      }
    }
  }
  return { data, nu, nv, texel: Math.max(sizeU / nu, sizeV / nv) };
}

/** Largest occlusion tolerance (mm) any point gets: the one at the steepest stamped slope. */
function _stampDepthTolMax(depth) {
  const f = STAMP_FACING_LO;
  return STAMP_DEPTH_TOL + depth.texel * Math.sqrt(1 - f * f) / f;
}

/**
 * True when something nearer the stamp side hides the point (u, v, height h)
 * — mirrored by the shader's stampCover. The tolerance grows with the
 * surface's slope: one texel holds one height for a whole texel of surface.
 */
function _stampOccluded(u, v, h, facing, depth) {
  const i = Math.min(depth.nu - 1, Math.max(0, Math.floor(u * depth.nu)));
  const j = Math.min(depth.nv - 1, Math.max(0, Math.floor(v * depth.nv)));
  const f = Math.max(facing, STAMP_FACING_LO);
  const tol = STAMP_DEPTH_TOL + depth.texel * Math.sqrt(Math.max(0, 1 - f * f)) / f;
  return h < depth.data[j * depth.nu + i] - tol;
}

/**
 * Per-triangle flags for a non-indexed position array: 1 where the stamp
 * cannot cover any point of the triangle, so the export can skip refining it
 * and Preserve Untextured keeps it as it is. A face counts as reached when
 * the bounding box of its stamp coordinates overlaps the footprint — widened
 * by the Smooth Mask distance, so the mask boundary these faces create never
 * ramps the stamp itself down — and one of its corners touches a face that
 * points toward the stamp. Faces straddling the cylinder axis or its back
 * seam count as overlapping. With a depth map (frame.depth), faces hidden
 * behind the stamped surface — by more than the largest tolerance and the
 * Smooth Mask margin — are unreached too. Every corner of an unreached face
 * has zero coverage (outside the footprint, all its faces pointing away, or
 * hidden), so masking these faces never changes the displacement.
 */
export function stampUntouchedFaces(pos, frame) {
  const triCount = pos.length / 9;
  const cyl = frame.mode === MODE_CYLINDRICAL;
  const ab = { a: 0, b: 0, dth: 0 };
  const cr = frame.cosR, sr = frame.sinR;
  const margin = frame.fade * 1.25;
  const mu = margin / frame.sizeU, mv = margin / frame.sizeV;
  const depth = frame.depth || null;
  const hiddenBy = depth ? Math.max(_stampDepthTolMax(depth), margin) : 0;
  const tx = new Float64Array(3), ty = new Float64Array(3);

  // Welded corners; per corner the most stamp-facing of its faces.
  const welded = new QuantizedPointMap(1e5, Math.min(triCount * 3, 1 << 22));
  const vid = new Int32Array(triCount * 3);
  let next = 0;
  for (let i = 0; i < triCount * 3; i++) {
    vid[i] = welded.getOrSet(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], next);
    if (welded.inserted) next++;
  }
  const facesToward = new Uint8Array(next);
  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    const ax = pos[o], ay = pos[o + 1], az = pos[o + 2];
    const e1x = pos[o + 3] - ax, e1y = pos[o + 4] - ay, e1z = pos[o + 5] - az;
    const e2x = pos[o + 6] - ax, e2y = pos[o + 7] - ay, e2z = pos[o + 8] - az;
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const facing = _stampFacing(nx, ny, nz,
      ax + (e1x + e2x) / 3, ay + (e1y + e2y) / 3, az + (e1z + e2z) / 3, frame);
    if (facing > 0) { facesToward[vid[t * 3]] = 1; facesToward[vid[t * 3 + 1]] = 1; facesToward[vid[t * 3 + 2]] = 1; }
  }

  const out = new Uint8Array(triCount);
  for (let t = 0; t < triCount; t++) {
    if (!facesToward[vid[t * 3]] && !facesToward[vid[t * 3 + 1]] && !facesToward[vid[t * 3 + 2]]) { out[t] = 1; continue; }
    const o = t * 9;
    let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
    let thMin = Infinity, thMax = -Infinity;
    let hmax = -Infinity;
    for (let k = 0; k < 3; k++) {
      const x = pos[o + k * 3], y = pos[o + k * 3 + 1], z = pos[o + k * 3 + 2];
      _stampAB(x, y, z, frame, ab);
      if (ab.a < amin) amin = ab.a; if (ab.a > amax) amax = ab.a;
      if (ab.b < bmin) bmin = ab.b; if (ab.b > bmax) bmax = ab.b;
      if (cyl) { if (ab.dth < thMin) thMin = ab.dth; if (ab.dth > thMax) thMax = ab.dth; }
      if (depth) {
        tx[k] = ((cr * ab.a - sr * ab.b) / frame.sizeU + 0.5) * depth.nu - 0.5;
        ty[k] = ((sr * ab.a + cr * ab.b) / frame.sizeV + 0.5) * depth.nv - 0.5;
        const h = _stampHeight(x, y, z, frame);
        if (h > hmax) hmax = h;
      }
    }
    if (cyl && (thMax - thMin > Math.PI || _triContainsAxis(pos, o, frame.ccx, frame.ccy))) continue;
    // Rotate the (a, b) box's corners: bounds the face's stamp UV even where
    // the cylindrical mapping bends its edges.
    let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
    for (let c = 0; c < 4; c++) {
      const a = c & 1 ? amax : amin, b = c & 2 ? bmax : bmin;
      const u = (cr * a - sr * b) / frame.sizeU + 0.5;
      const v = (sr * a + cr * b) / frame.sizeV + 0.5;
      if (u < umin) umin = u; if (u > umax) umax = u;
      if (v < vmin) vmin = v; if (v > vmax) vmax = v;
    }
    if (umax < -mu || umin > 1 + mu || vmax < -mv || vmin > 1 + mv) { out[t] = 1; continue; }
    if (depth) {
      // Hidden: every texel this face reaches holds a surface well in front of it.
      let minD = Infinity, any = false;
      _stampTriTexels(tx, ty, depth.nu, depth.nv, (i, j) => {
        any = true;
        const dv = depth.data[j * depth.nu + i];
        if (dv < minD) minD = dv;
      }, true);
      if (any && hmax + hiddenBy < minD) out[t] = 1;
    }
  }
  return out;
}

/** True when the XY projection of triangle o (offset into pos) contains the point (cx, cy). */
function _triContainsAxis(pos, o, cx, cy) {
  const d = (x1, y1, x2, y2) => (x2 - x1) * (cy - y1) - (y2 - y1) * (cx - x1);
  const d1 = d(pos[o], pos[o + 1], pos[o + 3], pos[o + 4]);
  const d2 = d(pos[o + 3], pos[o + 4], pos[o + 6], pos[o + 7]);
  const d3 = d(pos[o + 6], pos[o + 7], pos[o], pos[o + 1]);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

// Surface-normal stamp orientation: faces within this cone (cos 45°) of the
// running estimate count toward it.
const STAMP_NORMAL_CONE = Math.SQRT1_2;
// Faces the orientation fit looks at, about: bigger discs on denser meshes
// sample their small faces (stampSurfaceAt), so a drag costs the same at any size.
const STAMP_FIT_SAMPLES = 6000;

/**
 * Where a Surface-normal stamp sits near the point q, on a non-indexed
 * position array: the closest surface point p within `reach` (only on faces
 * within ~70° of `hint`, so the far side of a thin wall never wins), and the
 * normal of the surface the stamp lies on there — the dominant orientation
 * of the faces within `radius` of p (main.js: the footprint's inscribed
 * circle), area-weighted and fading toward the rim. Starting from the faces
 * within ~70° of `hint` (the face under the cursor, or the surface being
 * dragged along), each pass keeps only faces within 45° of the estimate and
 * near its plane, so facets, chamfers, rails and faces beyond an edge drop
 * out instead of tipping the stamp, while a curved surface is averaged.
 * Returns { x, y, z, nx, ny, nz }, or null when no face is in reach.
 */
export function stampSurfaceAt(pos, q, hint, radius, reach = radius) {
  const triCount = pos.length / 9;
  radius = Math.max(radius, 1e-6);
  const cp = { x: 0, y: 0, z: 0 };
  const hl = Math.hypot(hint.x, hint.y, hint.z) || 1;
  // One scan of the mesh: the triangles within reach + radius of q hold both
  // the snap and the disc around wherever p lands.
  let nc = 0;
  for (let t = 0; t < triCount; t++) {
    if (!_triNearBox(pos, t * 9, q.x, q.y, q.z, reach + radius)) continue;
    if (nc === _ssCand.length) { const g = new Int32Array(nc * 2); g.set(_ssCand); _ssCand = g; }
    _ssCand[nc++] = t;
  }
  let best = -1, bestD2 = reach * reach, px = 0, py = 0, pz = 0;
  for (let k = 0; k < nc; k++) {
    const o = _ssCand[k] * 9;
    if (!_triNearBox(pos, o, q.x, q.y, q.z, Math.sqrt(bestD2))) continue;   // the box shrinks with the best so far
    const n = _triNormal(pos, o, cp);
    const len = Math.hypot(n.x, n.y, n.z);
    if (!(len > 0) || (n.x * hint.x + n.y * hint.y + n.z * hint.z) < 0.34 * len * hl) continue;
    _closestOnTri(pos, o, q.x, q.y, q.z, cp);
    const d2 = (cp.x - q.x) ** 2 + (cp.y - q.y) ** 2 + (cp.z - q.z) ** 2;
    if (best < 0 ? d2 <= bestD2 : d2 < bestD2) { best = o / 9; bestD2 = d2; px = cp.x; py = cp.y; pz = cp.z; }
  }
  if (best < 0) return null;
  const fb = _triNormal(pos, best * 9, { x: 0, y: 0, z: 0 });
  const fl = Math.hypot(fb.x, fb.y, fb.z);
  fb.x /= fl; fb.y /= fl; fb.z /= fl;

  // Faces within the disc, 8 values each: unit normal, weight (capped area,
  // so a long face reaching in doesn't outweigh it, times the rim fade), and
  // the offset of their closest point from p. With many candidates, only
  // every stride-th small face by id counts (a power of two, so the sample
  // stays put while dragging), weighted up by the stride; a face larger than
  // a sample's share of the disc always counts.
  const stride = 2 ** Math.max(0, Math.floor(Math.log2(nc / STAMP_FIT_SAMPLES)));
  const share = Math.PI * radius * radius / STAMP_FIT_SAMPLES;
  let nf = 0;
  for (let k = 0; k < nc; k++) {
    const t = _ssCand[k], o = t * 9;
    if (!_triNearBox(pos, o, px, py, pz, radius)) continue;
    const n = _triNormal(pos, o, cp);
    const len = Math.hypot(n.x, n.y, n.z);
    if (!(len > 0)) continue;
    const big = 0.5 * len >= share;
    if (!big && t % stride !== 0) continue;
    const nx = n.x / len, ny = n.y / len, nz = n.z / len;   // before cp is reused below
    _closestOnTri(pos, o, px, py, pz, cp);
    const dx = cp.x - px, dy = cp.y - py, dz = cp.z - pz;
    const d = Math.hypot(dx, dy, dz);
    if (d > radius) continue;
    const fall = 1 - d / radius;
    if (nf + 8 > _ssF.length) { const g = new Float64Array(_ssF.length * 2); g.set(_ssF); _ssF = g; }
    const F = _ssF;
    F[nf] = nx; F[nf + 1] = ny; F[nf + 2] = nz; F[nf + 3] = Math.min(0.5 * len, radius * radius) * fall * fall * (big ? 1 : stride);
    F[nf + 4] = dx; F[nf + 5] = dy; F[nf + 6] = dz; F[nf + 7] = d;
    nf += 8;
  }
  // Weighted mean of the faces within `cone` of (ex, ey, ez) — with `plane`,
  // also within half the radius of the estimate's plane; null if none.
  const F = _ssF;
  const mean = (ex, ey, ez, cone, plane) => {
    let sx = 0, sy = 0, sz = 0;
    for (let i = 0; i < nf; i += 8) {
      if (F[i] * ex + F[i + 1] * ey + F[i + 2] * ez < cone) continue;
      if (plane && Math.abs(F[i + 4] * ex + F[i + 5] * ey + F[i + 6] * ez) > 0.5 * radius) continue;
      const w = F[i + 3];
      sx += F[i] * w; sy += F[i + 1] * w; sz += F[i + 2] * w;
    }
    const sl = Math.hypot(sx, sy, sz);
    return sl > 0 ? { x: sx / sl, y: sy / sl, z: sz / sl } : null;
  };
  // Seed: the disc's faces within ~70° of the hint — it picks between
  // surfaces meeting at an edge, the area decides within that.
  let e = mean(hint.x / hl, hint.y / hl, hint.z / hl, 0.34, false) ?? fb;
  for (let it = 0; it < 4; it++) e = mean(e.x, e.y, e.z, STAMP_NORMAL_CONE, true) ?? e;
  return { x: px, y: py, z: pz, nx: e.x, ny: e.y, nz: e.z };
}

// stampSurfaceAt scratch, grown as needed: candidate triangles, disc faces.
let _ssCand = new Int32Array(1 << 14);
let _ssF = new Float64Array(8 << 12);

/** True when triangle o's bounding box comes within r of (x, y, z) along every axis. */
function _triNearBox(pos, o, x, y, z, r) {
  for (let k = 0; k < 3; k++) {
    const a = pos[o + k], b = pos[o + 3 + k], c = pos[o + 6 + k];
    const p = k === 0 ? x : k === 1 ? y : z;
    if ((a < p - r && b < p - r && c < p - r) || (a > p + r && b > p + r && c > p + r)) return false;
  }
  return true;
}

/** Triangle o's unnormalised normal (length = twice its area), into out. */
function _triNormal(pos, o, out) {
  const ax = pos[o], ay = pos[o + 1], az = pos[o + 2];
  const e1x = pos[o + 3] - ax, e1y = pos[o + 4] - ay, e1z = pos[o + 5] - az;
  const e2x = pos[o + 6] - ax, e2y = pos[o + 7] - ay, e2z = pos[o + 8] - az;
  out.x = e1y * e2z - e1z * e2y; out.y = e1z * e2x - e1x * e2z; out.z = e1x * e2y - e1y * e2x;
  return out;
}

/** Closest point of triangle o to (px, py, pz), into out (Ericson, Real-Time Collision Detection 5.1.5). */
function _closestOnTri(pos, o, px, py, pz, out) {
  const ax = pos[o], ay = pos[o + 1], az = pos[o + 2];
  const bx = pos[o + 3], by = pos[o + 4], bz = pos[o + 5];
  const cx = pos[o + 6], cy = pos[o + 7], cz = pos[o + 8];
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return _set3(out, ax, ay, az);
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return _set3(out, bx, by, bz);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return _set3(out, ax + v * abx, ay + v * aby, az + v * abz); }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return _set3(out, cx, cy, cz);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return _set3(out, ax + w * acx, ay + w * acy, az + w * acz); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return _set3(out, bx + w * (cx - bx), by + w * (cy - by), bz + w * (cz - bz));
  }
  const sum = va + vb + vc;
  if (!(sum > 0)) return _set3(out, ax, ay, az);   // degenerate
  const v = vb / sum, w = vc / sum;
  return _set3(out, ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
}

function _set3(out, x, y, z) { out.x = x; out.y = y; out.z = z; return out; }

function applyTransform(u, v, scaleU, scaleV, offsetU, offsetV, cosR, sinR) {
  let uu = u / scaleU + offsetU;
  let vv = v / scaleV + offsetV;
  if (cosR !== 1 || sinR !== 0) {
    uu -= 0.5; vv -= 0.5;
    const ru = cosR * uu - sinR * vv;
    const rv = sinR * uu + cosR * vv;
    uu = ru + 0.5; vv = rv + 0.5;
  }
  return { triplanar: false, u: fract(uu), v: fract(vv) };
}

/** Fractional part, always positive (mirrors GLSL fract) */
function fract(x) { return x - Math.floor(x); }
