/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as THREE from 'three';
import { scaleMmToRelative, isStampActive, stampFrame, isRotateAroundZ } from './mapping.js';

// Mapping mode constants (must match index.html <option value="…">)
export const MODE_PLANAR_XY   = 0;
export const MODE_PLANAR_XZ   = 1;
export const MODE_PLANAR_YZ   = 2;
export const MODE_CYLINDRICAL = 3;
export const MODE_SPHERICAL   = 4;
export const MODE_TRIPLANAR   = 5;
export const MODE_CUBIC       = 6;
export const MODE_SURFACE_NORMAL = 7;   // stamps only

/** Texture layers the preview can composite at once (one vec4 attribute channel each). */
export const MAX_LAYERS = 4;

// ── GLSL source ──────────────────────────────────────────────────────────────
//
// Preview strategy, two modes:
//   1. Bump-only (default):  UV projection & bump mapping in the fragment shader.
//      The underlying geometry is never modified; amplitude scales bump intensity.
//   2. Displacement preview: The vertex shader samples the same displacement
//      textures and physically moves each vertex along its smooth normal.
//      Fragment shader adds reduced bump mapping for sub-vertex detail.
//
// Texture layers: up to MAX_LAYERS height maps, each with its own projection
// settings (uniform arrays indexed by layer) and its own per-vertex mask and
// boundary falloff (one channel of the layerMask / layerFalloff vec4
// attributes). Heights are composited in layer order the same way
// displacement.js does it: a layer covers the ones below where its weight
// lets it through ("over"), or adds to them (layerAdd). With one layer this
// is the plain single-texture preview.
//
// The shared GLSL block below is included in BOTH shaders so UV math,
// projection modes, and texture sampling stay identical.

const sharedGLSL = /* glsl */`
  #define MAX_LAYERS 4

  uniform sampler2D map0;
  uniform sampler2D map1;
  uniform sampler2D map2;
  uniform sampler2D map3;
  uniform int       layerCount;
  uniform int       activeLayer;
  uniform int       layerMode[MAX_LAYERS];
  uniform vec2      layerScale[MAX_LAYERS];
  uniform float     layerAmp[MAX_LAYERS];
  uniform vec2      layerOffset[MAX_LAYERS];
  uniform float     layerRot[MAX_LAYERS];
  uniform int       layerRotZ[MAX_LAYERS];   // 1 = side projections turn around Z (mapping.js isRotateAroundZ)
  uniform vec2      layerCylCenter[MAX_LAYERS];
  uniform float     layerCylRadius[MAX_LAYERS];
  uniform float     layerBlend[MAX_LAYERS];
  uniform float     layerSeamBand[MAX_LAYERS];
  uniform float     layerCapAngle[MAX_LAYERS];
  uniform int       layerSymmetric[MAX_LAYERS];
  uniform vec2      layerAspect[MAX_LAYERS];
  uniform int       layerAdd[MAX_LAYERS];
  uniform vec4      layerStamp[MAX_LAYERS];     // stamp: xyz = centre (model mm), w = facing side ±1; w = 0 → tiled
  uniform vec4      layerStampSize[MAX_LAYERS]; // stamp: xy = footprint (mm), zw = height map size (texels)
  uniform vec2      layerStampFade[MAX_LAYERS]; // stamp: x = Smooth Mask distance (mm), y = curve (FALLOFF_CURVE_INDEX)
  uniform vec4      layerStampDepth[MAX_LAYERS]; // stamp occlusion: x = has a depth map, y = texel (mm), zw = size (texels)
  uniform vec3      layerStampNormal[MAX_LAYERS]; // surface-normal stamp: projection normal
  uniform vec3      layerStampAxisU[MAX_LAYERS];  // … and its image right / up axes (mapping.js stampAxes)
  uniform vec3      layerStampAxisV[MAX_LAYERS];
  uniform sampler2D stampDepth0;                 // per-layer depth maps (mapping.js buildStampDepth)
  uniform sampler2D stampDepth1;
  uniform sampler2D stampDepth2;
  uniform sampler2D stampDepth3;
  uniform vec3      boundsMin;
  uniform vec3      boundsSize;
  uniform vec3      boundsCenter;
  uniform float     bottomAngleLimit;
  uniform float     topAngleLimit;
  uniform int       noDownwardZ;
  uniform int       useDisplacement;

  const float PI     = 3.14159265358979;
  const float TWO_PI = 6.28318530717959;
  const float CUBIC_AXIS_EPSILON = 1e-4;

  int dominantCubicAxis(vec3 n) {
    vec3 absN = abs(n);
    if (absN.x >= absN.y - CUBIC_AXIS_EPSILON && absN.x >= absN.z - CUBIC_AXIS_EPSILON) return 0;
    if (absN.y >= absN.z - CUBIC_AXIS_EPSILON) return 1;
    return 2;
  }

  vec3 cubicBlendWeights(vec3 n, float mappingBlend, float seamBandWidth) {
    vec3 absN = abs(n);
    int axis = dominantCubicAxis(n);
    float primary = axis == 0 ? absN.x : axis == 1 ? absN.y : absN.z;
    float secondary = axis == 0 ? max(absN.y, absN.z)
                    : axis == 1 ? max(absN.x, absN.z)
                                : max(absN.x, absN.y);

    // blend=0: hard one-hot for sharp seams. Do NOT also short-circuit at
    // primary≈secondary when blend>0 — the smooth branch produces 0.5/0.5
    // there, and short-circuiting to one-hot creates a single-fragment spike
    // wherever a fillet's smooth normal lands exactly on the 45° tie.
    if (mappingBlend < 0.001) {
      if (axis == 0) return vec3(1.0, 0.0, 0.0);
      if (axis == 1) return vec3(0.0, 1.0, 0.0);
      return vec3(0.0, 0.0, 1.0);
    }

    vec3 oneHot = axis == 0 ? vec3(1.0, 0.0, 0.0)
                : axis == 1 ? vec3(0.0, 1.0, 0.0)
                            : vec3(0.0, 0.0, 1.0);

    float seamWidth = max(seamBandWidth, CUBIC_AXIS_EPSILON * 2.0);
    float seamMixRaw = 1.0 - clamp((primary - secondary) / seamWidth, 0.0, 1.0);
    float seamMix = mappingBlend * seamMixRaw * seamMixRaw * (3.0 - 2.0 * seamMixRaw);
    if (seamMix <= 0.001) return oneHot;

    float power = 1.0 + (1.0 - seamMix) * 11.0;
    vec3 softWeights = pow(absN, vec3(power));
    softWeights /= dot(softWeights, vec3(1.0)) + 1e-6;

    vec3 blendedWeights = mix(oneHot, softWeights, seamMix);
    return blendedWeights / (dot(blendedWeights, vec3(1.0)) + 1e-6);
  }

  float sampleTex(int l, vec2 uv) {
    float h = 0.0;
    if      (l == 0) h = texture2D(map0, uv).r;
    else if (l == 1) h = texture2D(map1, uv).r;
    else if (l == 2) h = texture2D(map2, uv).r;
    else             h = texture2D(map3, uv).r;
    return h;
  }

  // Sample layer l after applying scale + tiling (aspect-corrected) and an
  // in-plane rotation by angle (radians)
  float sampleMapAngle(int l, vec2 rawUV, float angle) {
    vec2 uv = (rawUV * layerAspect[l]) / layerScale[l] + layerOffset[l];
    float c = cos(angle); float s = sin(angle);
    uv -= 0.5;
    uv  = vec2(c * uv.x - s * uv.y, s * uv.x + c * uv.y);
    uv += 0.5;
    return sampleTex(l, uv);
  }

  // Sample layer l with its own Rotation applied in-plane
  float sampleMap(int l, vec2 rawUV) {
    return sampleMapAngle(l, rawUV, layerRot[l]);
  }

  // Stamp ("place once") — mirrors stampUV in mapping.js. Returns the
  // unwrapped stamp UV in xy and the facing (cosine to the stamp axis on the
  // stamp side) in z.
  const float STAMP_FACING_LO = 0.15;
  const float STAMP_FACING_HI = 0.30;
  vec3 stampFrame(int l, vec3 pos, vec3 n) {
    vec4 st = layerStamp[l];
    float side = st.w;
    int mode = layerMode[l];
    vec2 d;
    float facing;
    if (mode == 7) {
      vec3 rel = pos - st.xyz;
      d = vec2(dot(rel, layerStampAxisU[l]), dot(rel, layerStampAxisV[l]));
      facing = dot(n, layerStampNormal[l]);
    } else if (mode == 0) {
      d = pos.xy - st.xy; facing = n.z * side;
      if (side < 0.0) d.x = -d.x;
    } else if (mode == 1) {
      d = pos.xz - st.xz; facing = n.y * side;
      if (side > 0.0) d.x = -d.x;
    } else if (mode == 2) {
      d = pos.yz - st.yz; facing = n.x * side;
      if (side < 0.0) d.x = -d.x;
    } else {
      vec2 rp = pos.xy - layerCylCenter[l];
      vec2 rc = st.xy - layerCylCenter[l];
      float dth = atan(rc.x * rp.y - rc.y * rp.x, dot(rc, rp));
      d = vec2(dth * max(layerCylRadius[l], 1e-4), pos.z - st.z);
      float lp = length(rp);
      facing = lp > 1e-6 ? dot(n.xy, rp / lp) * side : 0.0;
      if (side < 0.0) d.x = -d.x;
    }
    facing /= max(length(n), 1e-6);
    float c = cos(layerRot[l]); float s = sin(layerRot[l]);
    d = vec2(c * d.x - s * d.y, s * d.x + c * d.y);
    return vec3(d / layerStampSize[l].xy + 0.5, facing);
  }

  // Stamp occlusion — mirrors _stampHeight / _stampOccluded in mapping.js.
  const float STAMP_DEPTH_TOL = 0.05;
  // Single-return helpers: HLSL (ANGLE D3D11) warns about multi-return ones.
  float stampHeight(int l, vec3 pos) {
    int mode = layerMode[l];
    float h;
    if      (mode == 7) h = dot(pos, layerStampNormal[l]);
    else if (mode == 0) h = pos.z;
    else if (mode == 1) h = pos.y;
    else if (mode == 2) h = pos.x;
    else                h = length(pos.xy - layerCylCenter[l]);
    return h * layerStamp[l].w;
  }
  // Explicit LOD: looked up inside branches, where implicit derivatives are undefined.
  float stampDepthAt(int l, vec2 tc) {
    float d;
    if      (l == 0) d = textureLod(stampDepth0, tc, 0.0).r;
    else if (l == 1) d = textureLod(stampDepth1, tc, 0.0).r;
    else if (l == 2) d = textureLod(stampDepth2, tc, 0.0).r;
    else             d = textureLod(stampDepth3, tc, 0.0).r;
    return d;
  }
  // f = stampFrame(): true when a surface nearer the stamp side hides pos.
  bool stampOccluded(int l, vec3 pos, vec3 f) {
    vec4 sd = layerStampDepth[l];
    if (sd.x < 0.5) return false;
    vec2 idx = min(floor(clamp(f.xy, 0.0, 1.0) * sd.zw), sd.zw - 1.0);
    float D = stampDepthAt(l, (idx + 0.5) / sd.zw);
    float fc = max(f.z, STAMP_FACING_LO);
    float tol = STAMP_DEPTH_TOL + sd.y * sqrt(max(0.0, 1.0 - fc * fc)) / fc;
    return stampHeight(l, pos) < D - tol;
  }

  // Layer l's coverage: 1 for tiled layers; for a stamp, its footprint times
  // the facing fade, ramping up from the footprint's edge with a Smooth Mask,
  // and 0 where a nearer surface hides the point.
  float stampCover(int l, vec3 pos, vec3 n) {
    if (layerStamp[l].w == 0.0) return 1.0;
    vec3 f = stampFrame(l, pos, n);
    if (f.x < 0.0 || f.x > 1.0 || f.y < 0.0 || f.y > 1.0) return 0.0;
    float cover = smoothstep(STAMP_FACING_LO, STAMP_FACING_HI, f.z);
    float fade = layerStampFade[l].x;
    if (fade > 0.0) {
      vec2 size = layerStampSize[l].xy;
      float edge = min(min(f.x, 1.0 - f.x) * size.x, min(f.y, 1.0 - f.y) * size.y);
      float t = min(1.0, edge / fade);
      float curve = layerStampFade[l].y;
      if      (curve == 1.0) t = t * t * (3.0 - 2.0 * t);
      else if (curve == 2.0) t = t * t;
      cover *= t;
    }
    if (cover > 0.0 && stampOccluded(l, pos, f)) cover = 0.0;
    return cover;
  }

  // Side (XZ / YZ) projection frame for the box-style modes. With layerRotZ
  // the side projections are turned around the vertical axis by the layer's
  // Rotation instead of rotating the texture inside each plane — mirrors
  // rotateSideFrame in mapping.js. Returns the bbox-relative XY position;
  // the normals are rotated in place and sideAngle gets the in-plane angle.
  vec2 sideFrame(int l, vec3 pos, inout vec3 projN, inout vec3 blendN, out float sideAngle) {
    if (layerRotZ[l] == 0) {
      sideAngle = layerRot[l];
      return pos.xy - boundsMin.xy;
    }
    float c = cos(layerRot[l]); float s = sin(layerRot[l]);
    mat2 R = mat2(c, s, -s, c);   // column-major: R * v = (c*x - s*y, s*x + c*y)
    projN.xy  = R * projN.xy;
    blendN.xy = R * blendN.xy;
    sideAngle = 0.0;
    return R * (pos.xy - boundsCenter.xy) + 0.5 * boundsSize.xy;
  }

  // Compute layer l's raw height (0..1 grey) at a world-space point.
  // projN  = face-stable projection normal (for axis selection)
  // blendN = smooth / interpolated normal  (for blend weights)
  float computeHeightAtPoint(int l, vec3 pos, vec3 projN, vec3 blendN) {
    if (layerStamp[l].w != 0.0) {
      // Clamp half a texel inside the image so the bilinear blend never
      // wraps the opposite border in (same as _stampGrey in displacement.js).
      vec2 halfTexel = 0.5 / layerStampSize[l].zw;
      return sampleTex(l, clamp(stampFrame(l, pos, projN).xy, halfTexel, 1.0 - halfTexel));
    }
    int mappingMode = layerMode[l];
    float mappingBlend = layerBlend[l];
    float seamBandWidth = layerSeamBand[l];
    vec3 rel = pos - boundsCenter;
    float maxDim = max(boundsSize.x, max(boundsSize.y, boundsSize.z));
    float md = max(maxDim, 1e-4);

    if (mappingMode == 0) {
      return sampleMap(l, vec2((pos.x - boundsMin.x) / md, (pos.y - boundsMin.y) / md));

    } else if (mappingMode == 1) {
      return sampleMap(l, vec2((pos.x - boundsMin.x) / md, (pos.z - boundsMin.z) / md));

    } else if (mappingMode == 2) {
      return sampleMap(l, vec2((pos.y - boundsMin.y) / md, (pos.z - boundsMin.z) / md));

    } else if (mappingMode == 3) {
      // Cylinder axis is +Z. Center XY and radius are user-controllable so
      // pie-slice / off-center parts can be projected without distortion.
      vec2 cylRel2 = pos.xy - layerCylCenter[l];
      float r = max(layerCylRadius[l], 1e-4);
      float C = TWO_PI * r;
      float u_cyl = atan(cylRel2.y, cylRel2.x) / TWO_PI + 0.5;
      float v_cyl = (pos.z - boundsMin.z) / C;

      // Seam smoothing: cross-fade between left-side and right-side texture
      // continuations at the atan2 wrap point. Each side samples the texture
      // with a smoothly varying UV (no discontinuity), preserving full detail.
      float seamBand = seamBandWidth * 0.1;
      float seamDist = min(u_cyl, 1.0 - u_cyl);
      float hSide;
      if (seamBand > 0.001 && seamDist < seamBand) {
        float d = u_cyl < 0.5 ? u_cyl : u_cyl - 1.0;
        float t = smoothstep(0.0, 1.0, (d + seamBand) / (2.0 * seamBand));
        float hLeft  = sampleMap(l, vec2(1.0 + d, v_cyl));
        float hRight = sampleMap(l, vec2(d, v_cyl));
        hSide = mix(hLeft, hRight, t);
      } else {
        hSide = sampleMap(l, vec2(u_cyl, v_cyl));
      }

      if (mappingBlend < 0.001) return hSide;
      float capThreshold = cos(radians(layerCapAngle[l]));
      float blendHalf = seamBandWidth * 0.5;
      float capW = smoothstep(capThreshold - blendHalf, capThreshold + blendHalf, abs(blendN.z));
      float hCap  = sampleMap(l, vec2(cylRel2.x / C + 0.5, cylRel2.y / C + 0.5));
      return mix(hSide, hCap, capW);

    } else if (mappingMode == 4) {
      float r     = length(rel);
      float phi   = acos(clamp(rel.z / max(r, 1e-4), -1.0, 1.0));
      float u_sph = atan(rel.y, rel.x) / TWO_PI + 0.5;
      float v_sph = phi / PI;

      // Seam smoothing: cross-fade at the atan2 wrap
      float seamBand = seamBandWidth * 0.1;
      float seamDist = min(u_sph, 1.0 - u_sph);
      if (seamBand > 0.001 && seamDist < seamBand) {
        float d = u_sph < 0.5 ? u_sph : u_sph - 1.0;
        float t = smoothstep(0.0, 1.0, (d + seamBand) / (2.0 * seamBand));
        float hLeft  = sampleMap(l, vec2(1.0 + d, v_sph));
        float hRight = sampleMap(l, vec2(d, v_sph));
        return mix(hLeft, hRight, t);
      }
      return sampleMap(l, vec2(u_sph, v_sph));

    } else if (mappingMode == 5) {
      float sideAngle;
      vec2 sideXY = sideFrame(l, pos, projN, blendN, sideAngle);
      vec3 blend = abs(projN);
      blend = pow(blend, vec3(4.0));
      blend /= dot(blend, vec3(1.0)) + 1e-4;
      // Flip U based on normal sign so opposite faces show correct (non-mirrored) text.
      float yzU = sideXY.y / md;
      if (projN.x < 0.0) yzU = -yzU;
      float xzU = sideXY.x / md;
      if (projN.y > 0.0) xzU = -xzU;
      float xyU = (pos.x - boundsMin.x) / md;
      if (projN.z < 0.0) xyU = -xyU;
      float hXY = sampleMap(l, vec2(xyU, (pos.y - boundsMin.y) / md));
      float hXZ = sampleMapAngle(l, vec2(xzU, (pos.z - boundsMin.z) / md), sideAngle);
      float hYZ = sampleMapAngle(l, vec2(yzU, (pos.z - boundsMin.z) / md), sideAngle);
      return hXY * blend.z + hXZ * blend.y + hYZ * blend.x;

    } else {
      float sideAngle;
      vec2 sideXY = sideFrame(l, pos, projN, blendN, sideAngle);
      // Flip U based on normal sign so opposite faces show correct (non-mirrored) text.
      float yzU = sideXY.y / md;
      if (projN.x < 0.0) yzU = -yzU;
      float xzU = sideXY.x / md;
      if (projN.y > 0.0) xzU = -xzU;
      float xyU = (pos.x - boundsMin.x) / md;
      if (projN.z < 0.0) xyU = -xyU;
      float hYZ = sampleMapAngle(l, vec2(yzU, (pos.z - boundsMin.z) / md), sideAngle);
      float hXZ = sampleMapAngle(l, vec2(xzU, (pos.z - boundsMin.z) / md), sideAngle);
      float hXY = sampleMap(l, vec2(xyU, (pos.y - boundsMin.y) / md));
      vec3 bN = blendN;
      vec3 absFaceN = abs(projN);
      float facePrimary = max(absFaceN.x, max(absFaceN.y, absFaceN.z));
      float faceSecondary = absFaceN.x + absFaceN.y + absFaceN.z - facePrimary
                          - min(absFaceN.x, min(absFaceN.y, absFaceN.z));
      if (facePrimary - faceSecondary <= CUBIC_AXIS_EPSILON) bN = projN;
      vec3 wts = cubicBlendWeights(bN, mappingBlend, seamBandWidth);
      return hYZ * wts.x + hXZ * wts.y + hXY * wts.z;
    }
  }

  // Layer l's signed height in mm at a point (grey, centred if symmetric,
  // times the layer's amplitude) — before any mask weight.
  float layerHeightMm(int l, vec3 pos, vec3 projN, vec3 blendN) {
    float h = computeHeightAtPoint(l, pos, projN, blendN);
    if (layerSymmetric[l] == 1) h = h - 0.5;
    return h * layerAmp[l];
  }

  // Composite the layers' heights with per-layer weights w (mask × falloff ×
  // angle mask, times a stamp's coverage): later layers cover the ones
  // below, or add to them.
  float compositeHeight(vec3 pos, vec3 projN, vec3 blendN, vec4 w) {
    float H = 0.0;
    for (int l = 0; l < MAX_LAYERS; l++) {
      if (l >= layerCount) break;
      float wl = w[l] * stampCover(l, pos, projN);
      float hl = layerHeightMm(l, pos, projN, blendN) * wl;
      if (layerAdd[l] == 1) H += hl;
      else H = H * (1.0 - wl) + hl;
    }
    return H;
  }
`;

const vertexShader = /* glsl */`
  precision highp float;
  ${sharedGLSL}

  attribute vec3  smoothNormal;
  attribute vec3  faceNormal;
  attribute vec4  layerMask;      // per-layer user mask (0 = excluded, 1 = textured, between = soft brush)
  attribute vec4  layerFalloff;   // per-layer boundary falloff (0 at a mask edge → 1 beyond the falloff distance)
  attribute float boundaryMaskTypeAttr;

  varying vec3  vModelPos;    // ORIGINAL model-space position → UV computation in fragment
  varying vec3  vModelNormal; // model-space face normal       → stable UV blending
  varying vec3  vViewPos;     // view-space position (possibly displaced) → TBN & specular
  varying vec3  vNormal;      // view-space normal → lighting
  varying vec3  vSmoothNormal; // view-space smooth normal → smooth shading on masked faces
  varying vec4  vLayerMask;
  varying vec4  vLayerFalloff;
  varying float vAngleMask;   // angle mask (hard per-face)
  varying float vMaskType;    // boundary mask type (0 = user mask, 1 = angle mask)

  #include <clipping_planes_pars_vertex>

  void main() {
    vec3 safeN = length(normal) > 1e-6 ? normalize(normal) : vec3(0.0, 0.0, 1.0);
    // Use the true geometric face normal for angle masking so that
    // smooth/interpolated normals from subdivision don't cause mask bleeding.
    vec3 fN = length(faceNormal) > 1e-6 ? normalize(faceNormal) : safeN;
    vec3 pos = position;

    // Surface angle masking — hard per-face cutoff using flat face normal
    float surfaceAngle = degrees(acos(clamp(abs(fN.z), 0.0, 1.0)));
    float angleMask = 1.0;
    if (fN.z <  0.0 && bottomAngleLimit >= 1.0)
      angleMask = min(angleMask, surfaceAngle > bottomAngleLimit ? 1.0 : 0.0);
    if (fN.z >= 0.0 && topAngleLimit >= 1.0)
      angleMask = min(angleMask, surfaceAngle > topAngleLimit ? 1.0 : 0.0);
    vLayerMask    = layerMask;
    vLayerFalloff = layerFalloff;
    vAngleMask    = angleMask;
    vMaskType     = boundaryMaskTypeAttr;

    if (useDisplacement == 1) {
      float h = compositeHeight(position, safeN, safeN, layerMask * layerFalloff * angleMask);

      // Displace along smooth normal so all copies of the same position
      // arrive at the same point (watertight, no cracks).
      vec3 sN = length(smoothNormal) > 1e-6 ? normalize(smoothNormal) : safeN;
      pos = position + sN * h;
      // Overhang protection: never move a vertex below its original Z.
      if (noDownwardZ == 1 && pos.z < position.z) pos.z = position.z;
    }

    // Always pass the ORIGINAL position for UV computation in the fragment shader.
    vModelPos    = position;
    vModelNormal = fN;
    // Clipped (section view) on the displaced position, so the cut follows the preview surface.
    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    #include <clipping_planes_vertex>
    vViewPos     = mvPosition.xyz;
    vNormal      = normalize(normalMatrix * fN);
    vec3 sN = length(smoothNormal) > 1e-6 ? normalize(smoothNormal) : safeN;
    vSmoothNormal = normalize(normalMatrix * sN);
    gl_Position  = projectionMatrix * mvPosition;
  }
`;

const fragmentShader = /* glsl */`
  precision highp float;
  ${sharedGLSL}

  uniform sampler2D boundaryEdgeTex;
  uniform int       boundaryEdgeCount;
  uniform float     boundaryEdgeTexWidth;
  uniform float     boundaryFalloffDist;
  uniform int       boundaryFalloffCurve; // 0 = linear, 1 = s-curve, 2 = ease-in
  uniform int       layeredTint;          // 1 = several layers: surfaces the active layer leaves alone are neutral grey

  varying vec3  vModelPos;
  varying vec3  vModelNormal;
  varying vec3  vViewPos;
  varying vec3  vNormal;
  varying vec3  vSmoothNormal;
  varying vec4  vLayerMask;
  varying vec4  vLayerFalloff;
  varying float vAngleMask;
  varying float vMaskType;

  #include <clipping_planes_pars_fragment>

  // Fold layer l's screen-space height gradient (scaled by its amplitude and
  // weighted by wl) into the running bump sums with the over/add recurrence.
  void bumpLayer(int l, vec3 PN, float wl, inout float dhx, inout float dhy, inout float coverSum) {
    float hRaw = computeHeightAtPoint(l, vModelPos, PN, vModelNormal);
    // A stamp's coverage uses the attribute face normal: its orientation is
    // the mesh's, whereas PN's sign follows the screen-space derivatives.
    wl *= stampCover(l, vModelPos, vModelNormal);
    float gx = dFdx(hRaw) * layerAmp[l];
    float gy = dFdy(hRaw) * layerAmp[l];
    if (layerAdd[l] == 1) {
      dhx += gx * wl; dhy += gy * wl; coverSum += wl;
    } else {
      dhx = dhx * (1.0 - wl) + gx * wl;
      dhy = dhy * (1.0 - wl) + gy * wl;
      coverSum = coverSum * (1.0 - wl) + wl;
    }
  }

  void main() {
    // Flip normal for back faces so flipped-winding geometry still lights correctly.
    vec3 N = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);

    // Face-stable projection normal via dFdx, shared by every layer.
    vec3 _dpx = dFdx(vModelPos);
    vec3 _dpy = dFdy(vModelPos);
    vec3 _fN  = cross(_dpx, _dpy);
    vec3 PN   = length(_fN) > 1e-10 ? normalize(_fN) : vModelNormal;

    // Per-layer weights: user mask × boundary falloff × angle mask.
    vec4 w = vLayerMask * vLayerFalloff * vAngleMask;

    // Per-fragment boundary falloff for bump-only mode, on the active layer.
    // On coarse meshes the vertex attribute cannot produce a gradient (too
    // few vertices), so we compute the distance from each pixel to the
    // nearest boundary edge.
    if (useDisplacement == 0 && boundaryFalloffDist > 0.001 && boundaryEdgeCount > 0) {
      float minDist = boundaryFalloffDist;
      for (int i = 0; i < 64; i++) {
        if (i >= boundaryEdgeCount) break;
        float uA = (float(i * 2) + 0.5) / boundaryEdgeTexWidth;
        float uB = (float(i * 2 + 1) + 0.5) / boundaryEdgeTexWidth;
        vec3 ea = texture2D(boundaryEdgeTex, vec2(uA, 0.5)).xyz;
        vec3 eb = texture2D(boundaryEdgeTex, vec2(uB, 0.5)).xyz;
        vec3 ab = eb - ea;
        float abLen2 = dot(ab, ab);
        float t = clamp(dot(vModelPos - ea, ab) / max(abLen2, 1e-10), 0.0, 1.0);
        float d = length(vModelPos - (ea + t * ab));
        if (d < minDist) { minDist = d; if (d < 1e-4) break; }
      }
      float bf = clamp(minDist / boundaryFalloffDist, 0.0, 1.0);
      // Transition curve — must match applyFalloffCurve in main.js and the
      // export ramp in displacement.js.
      if      (boundaryFalloffCurve == 1) bf = bf * bf * (3.0 - 2.0 * bf);
      else if (boundaryFalloffCurve == 2) bf = bf * bf;
      if      (activeLayer == 0) w.x *= bf;
      else if (activeLayer == 1) w.y *= bf;
      else if (activeLayer == 2) w.z *= bf;
      else                       w.w *= bf;
    }

    // ── Bump mapping via screen-space height derivatives ──────────────────
    // Derivatives are taken on each layer's RAW height and weighted
    // afterwards, so 2×2 pixel quads spanning mask boundaries don't produce
    // large derivative spikes that bleed bump artifacts across the edge.
    // The weighted sums follow the same over/add recurrence as the height,
    // so the bump matches the composited relief. coverSum tracks how much of
    // the fragment any layer textures (shading blends to the smooth normal
    // where nothing does).
    //
    // One straight-line block per layer, NOT a loop: ANGLE's Direct3D
    // backend (Chrome/Edge on Windows) turns dFdx/dFdy inside a loop that
    // breaks on a uniform into code that silently yields zero, which made the
    // preview surface look flat while the silhouette still displaced.
    float dhx = 0.0, dhy = 0.0, coverSum = 0.0;
    bumpLayer(0, PN, w.x, dhx, dhy, coverSum);
    if (layerCount > 1) bumpLayer(1, PN, w.y, dhx, dhy, coverSum);
    if (layerCount > 2) bumpLayer(2, PN, w.z, dhx, dhy, coverSum);
    if (layerCount > 3) bumpLayer(3, PN, w.w, dhx, dhy, coverSum);
    coverSum = clamp(coverSum, 0.0, 1.0);

    vec3 dp1 = dFdx(vViewPos);
    vec3 dp2 = dFdy(vViewPos);

    vec3 T = dp1 - dot(dp1, N) * N;
    vec3 B = dp2 - dot(dp2, N) * N;
    float lenT = length(T);
    float lenB = length(B);
    T = lenT > 1e-5 ? T / lenT : vec3(1.0, 0.0, 0.0);
    B = lenB > 1e-5 ? B / lenB : vec3(0.0, 1.0, 0.0);

    // When vertex displacement is active, reduce bump strength: the macro shape
    // is already physical; bump only adds sub-vertex fine detail.
    float posScale = max(length(dp1) + length(dp2), 1e-6);
    float bumpStr  = useDisplacement == 1
      ? 2.0 / posScale
      : 6.0 / posScale;

    vec3 bumpVec = N - bumpStr * (dhx * T + dhy * B);
    vec3 bumpN = length(bumpVec) > 1e-6 ? normalize(bumpVec) : N;

    // On fully masked faces the bump derivatives are zero, so bumpN falls
    // back to the flat face normal → faceted/static look.  Blend toward
    // the smooth interpolated normal so masked areas get smooth shading.
    vec3 smoothN = normalize(vSmoothNormal) * (gl_FrontFacing ? 1.0 : -1.0);
    bumpN = mix(smoothN, bumpN, coverSum);

    // ── Shading ───────────────────────────────────────────────────────────
    // Compute lighting identically for ALL surfaces using the teal base so
    // that specular highlights, diffuse response, and view-dependent shading
    // are perfectly consistent everywhere.  Mask tinting is applied AFTER
    // lighting as a colour blend so masked areas keep the same glossy look.
    vec3 tealBase      = vec3(0.22, 0.68, 0.68);
    // Single layer: the familiar orange (painted out) and dark grey (angle
    // mask). Several layers: everything the active layer does not cover is a
    // plain neutral grey, so "teal = active layer" reads at a glance and the
    // other layers' relief still shows through the shading.
    vec3 inactiveGrey  = vec3(0.55, 0.57, 0.59);
    vec3 userMaskColor = layeredTint == 1 ? inactiveGrey : vec3(0.85, 0.40, 0.15);
    vec3 angleMaskColor = layeredTint == 1 ? inactiveGrey : vec3(0.45, 0.48, 0.50);

    vec3 L1 = normalize(vec3( 0.5,  0.8,  1.0));
    vec3 L2 = normalize(vec3(-0.5, -0.2, -0.6));
    vec3 V  = normalize(-vViewPos);

    float diff1 = max(dot(bumpN, L1), 0.0);
    float diff2 = max(dot(bumpN, L2), 0.0) * 0.35;

    vec3 H1   = normalize(L1 + V);
    float spec = pow(max(dot(bumpN, H1), 0.0), 64.0) * 0.60;

    // Lit teal (identical for textured and masked surfaces)
    vec3 litTeal = tealBase * 0.55
                 + tealBase * diff1 * vec3(1.00, 0.96, 0.88) * 0.55
                 + tealBase * diff2 * vec3(0.80, 0.60, 0.50) * 0.15
                 + vec3(spec);

    // Mask tint shows the ACTIVE layer's mask: pick colour by mask type,
    // compute the same lighting with that base.
    float userMask   = activeLayer == 0 ? vLayerMask.x : activeLayer == 1 ? vLayerMask.y : activeLayer == 2 ? vLayerMask.z : vLayerMask.w;
    float activeMask = activeLayer == 0 ? w.x : activeLayer == 1 ? w.y : activeLayer == 2 ? w.z : w.w;
    float maskEffect = 1.0 - activeMask; // 0 = fully textured, 1 = fully masked
    // Any user-mask coverage (hard 0 or soft-brush fractions) tints in the
    // user colour; only fully unmasked pixels defer to the boundary type.
    float effectiveMaskType = mix(vMaskType, 0.0, step(0.001, 1.0 - userMask));
    vec3 maskBase = mix(userMaskColor, angleMaskColor, effectiveMaskType);
    vec3 litMask = maskBase * 0.55
                 + maskBase * diff1 * vec3(1.00, 0.96, 0.88) * 0.55
                 + maskBase * diff2 * vec3(0.80, 0.60, 0.50) * 0.15
                 + vec3(spec);

    // Blend: 100% mask colour at the boundary, fading to 0% at falloff distance
    vec3 color = mix(litTeal, litMask, maskEffect);

    // Section view: discard last, so every dFdx/dFdy above ran in uniform control flow.
    #include <clipping_planes_fragment>
    gl_FragColor = vec4(color, 1.0);
  }
`;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create a ShaderMaterial for the displacement preview.
 * @param {Array<object>} layers  see updateMaterial
 * @param {object} settings       global settings, see updateMaterial
 */
export function createPreviewMaterial(layers, settings) {
  const mat = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: buildUniforms(),
    side: THREE.DoubleSide,
    clipping: true, // section view (viewer.js sets clippingPlanes)
  });
  updateMaterial(mat, layers, settings);
  return mat;
}

/**
 * Update existing ShaderMaterial uniforms in-place (no recreate).
 *
 * @param {THREE.ShaderMaterial} material
 * @param {Array<object>} layers  visible texture layers in composition order
 *   (at most MAX_LAYERS), each: { texture, mappingMode, scaleU, scaleV,
 *   offsetU, offsetV, rotation, amplitude, symmetricDisplacement,
 *   mappingBlend, seamBandWidth, capAngle, cylinderCenterX, cylinderCenterY,
 *   cylinderRadius, textureAspectU, textureAspectV, blendAdd, stampOnce,
 *   stampCenterX/Y/Z, stampSide, stampNormalX/Y/Z, mapWidth, mapHeight (height map texels),
 *   boundaryFalloff, boundaryFalloffCurve (the stamp's edge fade),
 *   stampDepth ({ depth, texture } occlusion map, main.js _stampDepthFor) }
 * @param {object} settings  { bounds, bottomAngleLimit, topAngleLimit,
 *   noDownwardZ, useDisplacement, activeLayer (index into `layers`),
 *   boundaryFalloff, boundaryFalloffCurve (the active layer's, for the
 *   per-fragment edge falloff), layeredTint (grey instead of orange for
 *   surfaces outside the active layer) }
 */
export function updateMaterial(material, layers, settings) {
  const u = material.uniforms;
  const b = settings.bounds || {
    min:    new THREE.Vector3(),
    size:   new THREE.Vector3(1, 1, 1),
    center: new THREE.Vector3(),
  };
  const n = Math.min(layers.length, MAX_LAYERS);
  u.layerCount.value  = n;
  u.activeLayer.value = Math.max(0, Math.min(n - 1, settings.activeLayer ?? 0));
  for (let l = 0; l < MAX_LAYERS; l++) {
    const L = l < n ? layers[l] : null;
    const mapU = u['map' + l];
    const tex = L && L.texture ? L.texture : _fallbackTexture();
    if (mapU.value !== tex) mapU.value = tex;
    const mode = L ? (L.mappingMode ?? MODE_TRIPLANAR) : MODE_TRIPLANAR;
    u.layerMode.value[l] = mode;
    // scaleU/scaleV are absolute mm; the shader works in normalized UV
    // space, so convert to the mode's relative factors on the CPU.
    const rel = L ? scaleMmToRelative(mode, L, b) : { u: 1, v: 1 };
    u.layerScale.value[l * 2]     = rel.u;
    u.layerScale.value[l * 2 + 1] = rel.v;
    u.layerAmp.value[l]           = L ? (L.amplitude ?? 0) : 0;
    u.layerOffset.value[l * 2]     = L ? (L.offsetU ?? 0) : 0;
    u.layerOffset.value[l * 2 + 1] = L ? (L.offsetV ?? 0) : 0;
    u.layerRot.value[l]            = L ? (L.rotation ?? 0) * Math.PI / 180 : 0;
    u.layerRotZ.value[l]           = L && isRotateAroundZ(L) ? 1 : 0;
    u.layerCylCenter.value[l * 2]     = L ? (L.cylinderCenterX ?? b.center.x) : 0;
    u.layerCylCenter.value[l * 2 + 1] = L ? (L.cylinderCenterY ?? b.center.y) : 0;
    u.layerCylRadius.value[l]  = L ? (L.cylinderRadius ?? Math.max(b.size.x, b.size.y) * 0.5) : 1;
    u.layerBlend.value[l]      = L ? (L.mappingBlend ?? 0) : 0;
    u.layerSeamBand.value[l]   = L ? (L.seamBandWidth ?? 0.35) : 0.35;
    u.layerCapAngle.value[l]   = L ? (L.capAngle ?? 20) : 20;
    u.layerSymmetric.value[l]  = L && L.symmetricDisplacement ? 1 : 0;
    u.layerAspect.value[l * 2]     = L ? (L.textureAspectU ?? 1) : 1;
    u.layerAspect.value[l * 2 + 1] = L ? (L.textureAspectV ?? 1) : 1;
    u.layerAdd.value[l]        = L && L.blendAdd ? 1 : 0;
    const st = L && isStampActive(L) ? stampFrame(L, b) : null;
    u.layerStamp.value[l * 4]     = st ? st.cx : 0;
    u.layerStamp.value[l * 4 + 1] = st ? st.cy : 0;
    u.layerStamp.value[l * 4 + 2] = st ? st.cz : 0;
    u.layerStamp.value[l * 4 + 3] = st ? st.side : 0;
    for (let k = 0; k < 3; k++) {
      u.layerStampNormal.value[l * 3 + k] = st ? st['n' + 'xyz'[k]] : 0;
      u.layerStampAxisU.value[l * 3 + k]  = st ? st['u' + 'xyz'[k]] : 0;
      u.layerStampAxisV.value[l * 3 + k]  = st ? st['v' + 'xyz'[k]] : 0;
    }
    u.layerStampSize.value[l * 4]     = st ? st.sizeU : 1;
    u.layerStampSize.value[l * 4 + 1] = st ? st.sizeV : 1;
    u.layerStampSize.value[l * 4 + 2] = L ? Math.max(L.mapWidth ?? 1, 1) : 1;
    u.layerStampSize.value[l * 4 + 3] = L ? Math.max(L.mapHeight ?? 1, 1) : 1;
    u.layerStampFade.value[l * 2]     = st ? st.fade : 0;
    u.layerStampFade.value[l * 2 + 1] = st ? (FALLOFF_CURVE_INDEX[st.fadeCurve] ?? 0) : 0;
    const sd = st && L.stampDepth ? L.stampDepth : null;
    const depthU = u['stampDepth' + l];
    const depthTex = sd ? sd.texture : _fallbackDepthTexture();
    if (depthU.value !== depthTex) depthU.value = depthTex;
    u.layerStampDepth.value[l * 4]     = sd ? 1 : 0;
    u.layerStampDepth.value[l * 4 + 1] = sd ? sd.depth.texel : 0;
    u.layerStampDepth.value[l * 4 + 2] = sd ? sd.depth.nu : 1;
    u.layerStampDepth.value[l * 4 + 3] = sd ? sd.depth.nv : 1;
  }
  u.boundsMin.value.copy(b.min);
  u.boundsSize.value.copy(b.size);
  u.boundsCenter.value.copy(b.center);
  u.bottomAngleLimit.value = settings.bottomAngleLimit ?? 5.0;
  u.topAngleLimit.value    = settings.topAngleLimit    ?? 0.0;
  u.noDownwardZ.value      = settings.noDownwardZ      ? 1 : 0;
  u.useDisplacement.value  = settings.useDisplacement  ? 1 : 0;
  u.boundaryFalloffDist.value  = settings.boundaryFalloff ?? 0.0;
  u.boundaryFalloffCurve.value = FALLOFF_CURVE_INDEX[settings.boundaryFalloffCurve] ?? 0;
  u.layeredTint.value = settings.layeredTint ? 1 : 0;
}

// ── Internal ──────────────────────────────────────────────────────────────────

function buildUniforms() {
  return {
    map0: { value: _fallbackTexture() },
    map1: { value: _fallbackTexture() },
    map2: { value: _fallbackTexture() },
    map3: { value: _fallbackTexture() },
    layerCount:     { value: 0 },
    activeLayer:    { value: 0 },
    layerMode:      { value: new Int32Array(MAX_LAYERS) },
    layerScale:     { value: new Float32Array(MAX_LAYERS * 2) },
    layerAmp:       { value: new Float32Array(MAX_LAYERS) },
    layerOffset:    { value: new Float32Array(MAX_LAYERS * 2) },
    layerRot:       { value: new Float32Array(MAX_LAYERS) },
    layerRotZ:      { value: new Int32Array(MAX_LAYERS) },
    layerCylCenter: { value: new Float32Array(MAX_LAYERS * 2) },
    layerCylRadius: { value: new Float32Array(MAX_LAYERS) },
    layerBlend:     { value: new Float32Array(MAX_LAYERS) },
    layerSeamBand:  { value: new Float32Array(MAX_LAYERS) },
    layerCapAngle:  { value: new Float32Array(MAX_LAYERS) },
    layerSymmetric: { value: new Int32Array(MAX_LAYERS) },
    layerAspect:    { value: new Float32Array(MAX_LAYERS * 2) },
    layerAdd:       { value: new Int32Array(MAX_LAYERS) },
    layerStamp:     { value: new Float32Array(MAX_LAYERS * 4) },
    layerStampSize: { value: new Float32Array(MAX_LAYERS * 4) },
    layerStampFade: { value: new Float32Array(MAX_LAYERS * 2) },
    layerStampDepth: { value: new Float32Array(MAX_LAYERS * 4) },
    layerStampNormal: { value: new Float32Array(MAX_LAYERS * 3) },
    layerStampAxisU:  { value: new Float32Array(MAX_LAYERS * 3) },
    layerStampAxisV:  { value: new Float32Array(MAX_LAYERS * 3) },
    stampDepth0:    { value: _fallbackDepthTexture() },
    stampDepth1:    { value: _fallbackDepthTexture() },
    stampDepth2:    { value: _fallbackDepthTexture() },
    stampDepth3:    { value: _fallbackDepthTexture() },
    boundsMin:       { value: new THREE.Vector3() },
    boundsSize:       { value: new THREE.Vector3(1, 1, 1) },
    boundsCenter:     { value: new THREE.Vector3() },
    bottomAngleLimit: { value: 5.0 },
    topAngleLimit:    { value: 0.0 },
    noDownwardZ:      { value: 0 },
    useDisplacement:  { value: 0 },
    boundaryEdgeTex:      { value: createFallbackDataTexture() },
    boundaryEdgeCount:    { value: 0 },
    boundaryEdgeTexWidth: { value: 1.0 },
    boundaryFalloffDist:  { value: 0.0 },
    boundaryFalloffCurve: { value: 0 },
    layeredTint:          { value: 0 },
  };
}

// Maps settings.boundaryFalloffCurve to the shader's integer uniform.
const FALLOFF_CURVE_INDEX = { linear: 0, scurve: 1, ease: 2 };

// One shared mid-grey texture for unused layer slots (never displaces).
let _fallback = null;
function _fallbackTexture() {
  if (_fallback) return _fallback;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 4;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, 4, 4);
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  _fallback = t;
  return t;
}

// One shared 1×1 float texture for stamp-depth slots without a map (never sampled: layerStampDepth.x = 0).
let _fallbackDepth = null;
function _fallbackDepthTexture() {
  if (_fallbackDepth) return _fallbackDepth;
  const t = new THREE.DataTexture(new Float32Array([-1e30]), 1, 1, THREE.RedFormat, THREE.FloatType);
  t.minFilter = THREE.NearestFilter;
  t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  _fallbackDepth = t;
  return t;
}

function createFallbackDataTexture() {
  const data = new Float32Array(4);
  const t = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = THREE.NearestFilter;
  t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}
