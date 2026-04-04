import * as THREE from 'three';

// Mapping mode constants (must match index.html <option value="…">)
export const MODE_PLANAR_XY   = 0;
export const MODE_PLANAR_XZ   = 1;
export const MODE_PLANAR_YZ   = 2;
export const MODE_CYLINDRICAL = 3;
export const MODE_SPHERICAL   = 4;
export const MODE_TRIPLANAR   = 5;
export const MODE_CUBIC       = 6;

// ── GLSL source ──────────────────────────────────────────────────────────────
//
// Preview strategy, two modes:
//   1. Bump-only (default):  UV projection & bump mapping in the fragment shader.
//      The underlying geometry is never modified; amplitude scales bump intensity.
//   2. Displacement preview: The vertex shader samples the same displacement
//      texture and physically moves each vertex along its smooth normal.
//      Fragment shader adds reduced bump mapping for sub-vertex detail.
//
// The shared GLSL block below is included in BOTH shaders so UV math,
// projection modes, and texture sampling stay identical.

const sharedGLSL = /* glsl */`
  uniform sampler2D displacementMap;
  uniform int       mappingMode;
  uniform vec2      scaleUV;
  uniform float     amplitude;
  uniform vec2      offsetUV;
  uniform float     rotation;
  uniform vec3      boundsMin;
  uniform vec3      boundsSize;
  uniform vec3      boundsCenter;
  uniform float     bottomAngleLimit;
  uniform float     topAngleLimit;
  uniform float     mappingBlend;
  uniform float     seamBandWidth;
  uniform float     capAngle;
  uniform int       symmetricDisplacement;
  uniform int       useDisplacement;
  uniform vec2      textureAspect;

  const float PI     = 3.14159265358979;
  const float TWO_PI = 6.28318530717959;
  const float CUBIC_AXIS_EPSILON = 1e-4;

  int dominantCubicAxis(vec3 n) {
    vec3 absN = abs(n);
    if (absN.x >= absN.y - CUBIC_AXIS_EPSILON && absN.x >= absN.z - CUBIC_AXIS_EPSILON) return 0;
    if (absN.y >= absN.z - CUBIC_AXIS_EPSILON) return 1;
    return 2;
  }

  vec3 cubicBlendWeights(vec3 n) {
    vec3 absN = abs(n);
    int axis = dominantCubicAxis(n);
    float primary = axis == 0 ? absN.x : axis == 1 ? absN.y : absN.z;
    float secondary = axis == 0 ? max(absN.y, absN.z)
                    : axis == 1 ? max(absN.x, absN.z)
                                : max(absN.x, absN.y);

    if (mappingBlend < 0.001 || primary - secondary <= CUBIC_AXIS_EPSILON) {
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

  // Sample after applying scale + tiling (aspect-corrected)
  float sampleMap(vec2 rawUV) {
    vec2 uv = (rawUV * textureAspect) / scaleUV + offsetUV;
    float c = cos(rotation); float s = sin(rotation);
    uv -= 0.5;
    uv  = vec2(c * uv.x - s * uv.y, s * uv.x + c * uv.y);
    uv += 0.5;
    return texture2D(displacementMap, uv).r;
  }

  // Compute displacement height at a world-space point.
  // projN  = face-stable projection normal (for axis selection)
  // blendN = smooth / interpolated normal  (for blend weights)
  float computeHeightAtPoint(vec3 pos, vec3 projN, vec3 blendN) {
    vec3 rel = pos - boundsCenter;
    float maxDim = max(boundsSize.x, max(boundsSize.y, boundsSize.z));
    float md = max(maxDim, 1e-4);

    if (mappingMode == 0) {
      return sampleMap(vec2((pos.x - boundsMin.x) / md, (pos.y - boundsMin.y) / md));

    } else if (mappingMode == 1) {
      return sampleMap(vec2((pos.x - boundsMin.x) / md, (pos.z - boundsMin.z) / md));

    } else if (mappingMode == 2) {
      return sampleMap(vec2((pos.y - boundsMin.y) / md, (pos.z - boundsMin.z) / md));

    } else if (mappingMode == 3) {
      float r = max(boundsSize.x, boundsSize.y) * 0.5;
      float C = TWO_PI * max(r, 1e-4);
      float u_cyl = atan(rel.y, rel.x) / TWO_PI + 0.5;
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
        float hLeft  = sampleMap(vec2(1.0 + d, v_cyl));
        float hRight = sampleMap(vec2(d, v_cyl));
        hSide = mix(hLeft, hRight, t);
      } else {
        hSide = sampleMap(vec2(u_cyl, v_cyl));
      }

      if (mappingBlend < 0.001) return hSide;
      float capThreshold = cos(radians(capAngle));
      float blendHalf = seamBandWidth * 0.5;
      float capW = smoothstep(capThreshold - blendHalf, capThreshold + blendHalf, abs(blendN.z));
      float hCap  = sampleMap(vec2(rel.x / C + 0.5, rel.y / C + 0.5));
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
        float hLeft  = sampleMap(vec2(1.0 + d, v_sph));
        float hRight = sampleMap(vec2(d, v_sph));
        return mix(hLeft, hRight, t);
      }
      return sampleMap(vec2(u_sph, v_sph));

    } else if (mappingMode == 5) {
      vec3 blend = abs(projN);
      blend = pow(blend, vec3(4.0));
      blend /= dot(blend, vec3(1.0)) + 1e-4;
      // Flip U based on normal sign so opposite faces show correct (non-mirrored) text.
      float yzU = (pos.y - boundsMin.y) / md;
      if (projN.x < 0.0) yzU = -yzU;
      float xzU = (pos.x - boundsMin.x) / md;
      if (projN.y > 0.0) xzU = -xzU;
      float xyU = (pos.x - boundsMin.x) / md;
      if (projN.z < 0.0) xyU = -xyU;
      float hXY = sampleMap(vec2(xyU, (pos.y - boundsMin.y) / md));
      float hXZ = sampleMap(vec2(xzU, (pos.z - boundsMin.z) / md));
      float hYZ = sampleMap(vec2(yzU, (pos.z - boundsMin.z) / md));
      return hXY * blend.z + hXZ * blend.y + hYZ * blend.x;

    } else {
      // Flip U based on normal sign so opposite faces show correct (non-mirrored) text.
      float yzU = (pos.y - boundsMin.y) / md;
      if (projN.x < 0.0) yzU = -yzU;
      float xzU = (pos.x - boundsMin.x) / md;
      if (projN.y > 0.0) xzU = -xzU;
      float xyU = (pos.x - boundsMin.x) / md;
      if (projN.z < 0.0) xyU = -xyU;
      float hYZ = sampleMap(vec2(yzU, (pos.z - boundsMin.z) / md));
      float hXZ = sampleMap(vec2(xzU, (pos.z - boundsMin.z) / md));
      float hXY = sampleMap(vec2(xyU, (pos.y - boundsMin.y) / md));
      vec3 bN = blendN;
      vec3 absFaceN = abs(projN);
      float facePrimary = max(absFaceN.x, max(absFaceN.y, absFaceN.z));
      float faceSecondary = absFaceN.x + absFaceN.y + absFaceN.z - facePrimary
                          - min(absFaceN.x, min(absFaceN.y, absFaceN.z));
      if (facePrimary - faceSecondary <= CUBIC_AXIS_EPSILON) bN = projN;
      vec3 wts = cubicBlendWeights(bN);
      return hYZ * wts.x + hXZ * wts.y + hXY * wts.z;
    }
  }
`;

const vertexShader = /* glsl */`
  precision highp float;
  ${sharedGLSL}

  attribute vec3  smoothNormal;
  attribute vec3  faceNormal;
  attribute float faceMask;

  varying vec3  vModelPos;    // ORIGINAL model-space position → UV computation in fragment
  varying vec3  vModelNormal; // model-space face normal       → stable UV blending
  varying vec3  vViewPos;     // view-space position (possibly displaced) → TBN & specular
  varying vec3  vNormal;      // view-space normal → lighting
  varying float vFaceMask;    // combined mask (angle + user exclusion)

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
    float totalMask = angleMask * faceMask;
    vFaceMask = totalMask;

    if (useDisplacement == 1) {
      float h = computeHeightAtPoint(position, safeN, safeN);
      if (symmetricDisplacement == 1) h = h - 0.5;
      h *= totalMask;

      // Displace along smooth normal so all copies of the same position
      // arrive at the same point (watertight, no cracks).
      vec3 sN = length(smoothNormal) > 1e-6 ? normalize(smoothNormal) : safeN;
      pos = position + sN * h * amplitude;
    }

    // Always pass the ORIGINAL position for UV computation in the fragment shader.
    vModelPos    = position;
    vModelNormal = fN;
    vec4 mvPos   = modelViewMatrix * vec4(pos, 1.0);
    vViewPos     = mvPos.xyz;
    vNormal      = normalize(normalMatrix * fN);
    gl_Position  = projectionMatrix * mvPos;
  }
`;

const fragmentShader = /* glsl */`
  precision highp float;
  ${sharedGLSL}

  varying vec3  vModelPos;
  varying vec3  vModelNormal;
  varying vec3  vViewPos;
  varying vec3  vNormal;
  varying float vFaceMask;

  // Fragment-only wrapper: compute face-stable projection normal via dFdx
  // then delegate to the shared height function.
  float getHeight() {
    vec3 _dpx = dFdx(vModelPos);
    vec3 _dpy = dFdy(vModelPos);
    vec3 _fN  = cross(_dpx, _dpy);
    vec3 PN   = length(_fN) > 1e-10 ? normalize(_fN) : vModelNormal;
    return computeHeightAtPoint(vModelPos, PN, vModelNormal);
  }

  void main() {
    // Flip normal for back faces so flipped-winding geometry still lights correctly.
    vec3 N = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
    float h = getHeight();
    if (symmetricDisplacement == 1) h = h - 0.5;

    // ── Bump mapping via screen-space height derivatives ──────────────────
    // Compute derivatives on the RAW (unmasked) height so that screen-space
    // 2×2 pixel quads spanning masked/unmasked boundaries don't produce
    // large derivative spikes that bleed bump artifacts across the edge.
    float dhx = dFdx(h);
    float dhy = dFdy(h);

    // ── Combined mask (angle + user exclusion) from vertex shader ────────
    float maskBlend = vFaceMask;
    h *= maskBlend;
    dhx *= maskBlend;
    dhy *= maskBlend;

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
      ? amplitude * 2.0 / posScale
      : amplitude * 6.0 / posScale;

    vec3 bumpVec = N - bumpStr * (dhx * T + dhy * B);
    vec3 bumpN = length(bumpVec) > 1e-6 ? normalize(bumpVec) : N;

    // ── Shading ───────────────────────────────────────────────────────────
    vec3 baseColor = mix(vec3(0.50, 0.50, 0.50), vec3(0.22, 0.68, 0.68), maskBlend);

    vec3 L1 = normalize(vec3( 0.5,  0.8,  1.0));
    vec3 L2 = normalize(vec3(-0.5, -0.2, -0.6));
    vec3 V  = normalize(-vViewPos);

    float diff1 = max(dot(bumpN, L1), 0.0);
    float diff2 = max(dot(bumpN, L2), 0.0) * 0.35;

    vec3 H1   = normalize(L1 + V);
    float spec = pow(max(dot(bumpN, H1), 0.0), 64.0) * 0.60;

    vec3 color = baseColor * 0.55                                        // ambient
               + baseColor * diff1 * vec3(1.00, 0.96, 0.88) * 0.55      // key light
               + baseColor * diff2 * vec3(0.80, 0.60, 0.50) * 0.15      // warm fill
               + vec3(spec);                                             // specular

    gl_FragColor = vec4(color, 1.0);
  }
`;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create a ShaderMaterial for the displacement preview.
 * @param {THREE.Texture|null} displacementTexture
 * @param {object} settings  – { mappingMode, scaleU, scaleV, amplitude, offsetU, offsetV, bounds }
 */
export function createPreviewMaterial(displacementTexture, settings) {
  const mat = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: buildUniforms(displacementTexture, settings),
    side: THREE.DoubleSide,
  });
  return mat;
}

/**
 * Update existing ShaderMaterial uniforms in-place (no recreate).
 */
export function updateMaterial(material, displacementTexture, settings) {
  const u = material.uniforms;
  if (displacementTexture && u.displacementMap.value !== displacementTexture) {
    u.displacementMap.value = displacementTexture;
  }
  u.mappingMode.value   = settings.mappingMode;
  u.scaleUV.value.set(settings.scaleU, settings.scaleV);
  u.amplitude.value     = settings.amplitude;
  u.offsetUV.value.set(settings.offsetU, settings.offsetV);
  u.rotation.value      = (settings.rotation ?? 0) * Math.PI / 180;
  if (settings.bounds) {
    u.boundsMin.value.copy(settings.bounds.min);
    u.boundsSize.value.copy(settings.bounds.size);
    u.boundsCenter.value.copy(settings.bounds.center);
  }
  u.bottomAngleLimit.value = settings.bottomAngleLimit ?? 5.0;
  u.topAngleLimit.value    = settings.topAngleLimit    ?? 0.0;
  u.mappingBlend.value            = settings.mappingBlend            ?? 0.0;
  u.seamBandWidth.value           = settings.seamBandWidth           ?? 0.35;
  u.capAngle.value                = settings.capAngle                ?? 20.0;
  u.symmetricDisplacement.value   = settings.symmetricDisplacement   ? 1 : 0;
  u.useDisplacement.value         = settings.useDisplacement         ? 1 : 0;
  u.textureAspect.value.set(settings.textureAspectU ?? 1, settings.textureAspectV ?? 1);
}

// ── Internal ──────────────────────────────────────────────────────────────────

function buildUniforms(tex, settings) {
  const b = settings.bounds || {
    min:    new THREE.Vector3(),
    size:   new THREE.Vector3(1, 1, 1),
    center: new THREE.Vector3(),
  };
  return {
    displacementMap: { value: tex || createFallbackTexture() },
    mappingMode:     { value: settings.mappingMode ?? MODE_TRIPLANAR },
    scaleUV:         { value: new THREE.Vector2(settings.scaleU ?? 1, settings.scaleV ?? 1) },
    amplitude:       { value: settings.amplitude ?? 1.0 },
    offsetUV:        { value: new THREE.Vector2(settings.offsetU ?? 0, settings.offsetV ?? 0) },
    rotation:        { value: ((settings.rotation ?? 0) * Math.PI / 180) },
    boundsMin:        { value: b.min.clone() },
    boundsSize:       { value: b.size.clone() },
    boundsCenter:     { value: b.center.clone() },
    bottomAngleLimit: { value: settings.bottomAngleLimit ?? 5.0 },
    topAngleLimit:    { value: settings.topAngleLimit    ?? 0.0 },
    mappingBlend:             { value: settings.mappingBlend            ?? 0.0 },
    seamBandWidth:            { value: settings.seamBandWidth            ?? 0.35 },
    capAngle:                 { value: settings.capAngle                 ?? 20.0 },
    symmetricDisplacement:    { value: settings.symmetricDisplacement   ? 1 : 0 },
    useDisplacement:          { value: settings.useDisplacement         ? 1 : 0 },
    textureAspect:            { value: new THREE.Vector2(settings.textureAspectU ?? 1, settings.textureAspectV ?? 1) },
  };
}

function createFallbackTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 4;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, 4, 4);
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
