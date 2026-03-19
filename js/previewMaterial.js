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
// Preview strategy: NO vertex displacement.
// All UV projection is done in the fragment shader so the underlying mesh
// geometry is never modified.  The displacement map is visualised via
// per-fragment bump mapping (perturbing the shading normal from screen-space
// height derivatives).  `amplitude` scales the bump intensity only.

const vertexShader = /* glsl */`
  precision highp float;

  varying vec3 vModelPos;    // model-space position  → UV computation in fragment
  varying vec3 vModelNormal; // model-space normal    → stable UV blending (triplanar/cubic)
  varying vec3 vViewPos;     // view-space position   → TBN & specular
  varying vec3 vNormal;      // view-space normal     → lighting

  void main() {
    vModelPos = position;
    // Guard against degenerate zero-length normals (non-manifold / multi-body STLs
    // can produce averaged-to-zero normals at shared vertices between opposing bodies).
    // normalize(vec3(0)) is undefined in GLSL and produces NaN on most GPUs,
    // which then turns the entire fragment black.
    vec3 safeN   = length(normal) > 1e-6 ? normalize(normal) : vec3(0.0, 0.0, 1.0);
    vModelNormal = safeN;
    vec4 mvPos   = modelViewMatrix * vec4(position, 1.0);
    vViewPos     = mvPos.xyz;
    vNormal      = normalize(normalMatrix * safeN);
    gl_Position  = projectionMatrix * mvPos;
  }
`;

const fragmentShader = /* glsl */`
  precision highp float;

  uniform sampler2D displacementMap;
  uniform int       mappingMode;
  uniform vec2      scaleUV;
  uniform float     amplitude;
  uniform vec2      offsetUV;
  uniform float     rotation;
  uniform vec3      boundsMin;
  uniform vec3      boundsSize;
  uniform vec3      boundsCenter;
  uniform float     bottomAngleLimit; // degrees from horizontal; 0 = disabled
  uniform float     topAngleLimit;    // degrees from horizontal; 0 = disabled
  uniform float     mappingBlend;     // 0 = sharp seams, 1 = fully blended

  varying vec3 vModelPos;
  varying vec3 vModelNormal;
  varying vec3 vViewPos;
  varying vec3 vNormal;

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

    float seamWidth = max(mappingBlend * 0.35, CUBIC_AXIS_EPSILON * 2.0);
    float seamMixRaw = 1.0 - clamp((primary - secondary) / seamWidth, 0.0, 1.0);
    float seamMix = mappingBlend * seamMixRaw * seamMixRaw * (3.0 - 2.0 * seamMixRaw);
    if (seamMix <= 0.001) return oneHot;

    float power = 1.0 + (1.0 - seamMix) * 11.0;
    vec3 softWeights = pow(absN, vec3(power));
    softWeights /= dot(softWeights, vec3(1.0)) + 1e-6;

    vec3 blendedWeights = mix(oneHot, softWeights, seamMix);
    return blendedWeights / (dot(blendedWeights, vec3(1.0)) + 1e-6);
  }

  // Sample after applying scale + tiling
  float sampleMap(vec2 rawUV) {
    vec2 uv = rawUV / scaleUV + offsetUV;
    // rotate around tile centre
    float c = cos(rotation); float s = sin(rotation);
    uv -= 0.5;
    uv  = vec2(c * uv.x - s * uv.y, s * uv.x + c * uv.y);
    uv += 0.5;
    return texture2D(displacementMap, uv).r;
  }

  // Height at this fragment for all projection modes.
  // Uses vModelPos / vModelNormal (model-space) so UV is stable as the camera orbits.
  float getHeight() {
    vec3 pos = vModelPos;
    vec3 MN  = vModelNormal;  // smooth interpolated normal → shading only
    vec3 rel = pos - boundsCenter;
    float maxDim = max(boundsSize.x, max(boundsSize.y, boundsSize.z));
    float md = max(maxDim, 1e-4);

    // Face-stable projection normal: cross product of screen-space position
    // derivatives is CONSTANT within a triangle (unlike the interpolated
    // vModelNormal), eliminating within-face texture z-fighting at seam
    // boundaries in cubic / triplanar mapping. Falls back to MN if degenerate.
    vec3 _dpx = dFdx(vModelPos);
    vec3 _dpy = dFdy(vModelPos);
    vec3 _fN  = cross(_dpx, _dpy);
    vec3 PN   = length(_fN) > 1e-10 ? normalize(_fN) : MN;

    if (mappingMode == 0) {
      return sampleMap(vec2((pos.x - boundsMin.x) / md, (pos.y - boundsMin.y) / md));

    } else if (mappingMode == 1) {
      return sampleMap(vec2((pos.x - boundsMin.x) / md, (pos.z - boundsMin.z) / md));

    } else if (mappingMode == 2) {
      return sampleMap(vec2((pos.y - boundsMin.y) / md, (pos.z - boundsMin.z) / md));

    } else if (mappingMode == 3) {
      // Cylindrical around Z axis (Z is up) with blendable side↔cap transition.
      float r = max(boundsSize.x, boundsSize.y) * 0.5;
      float C = TWO_PI * max(r, 1e-4);
      float hSide = sampleMap(vec2(atan(rel.y, rel.x) / TWO_PI + 0.5,
                                   (pos.z - boundsMin.z) / C));
      if (mappingBlend < 0.001) return hSide;
      float blendHalf = mappingBlend * 0.20;
      float capW = smoothstep(0.7 - blendHalf, 0.7 + blendHalf, abs(vModelNormal.z));
      float hCap  = sampleMap(vec2(rel.x / C + 0.5, rel.y / C + 0.5));
      return mix(hSide, hCap, capW);

    } else if (mappingMode == 4) {
      // Spherical — Z is up
      float r     = length(rel);
      float phi   = acos(clamp(rel.z / max(r, 1e-4), -1.0, 1.0));
      float theta = atan(rel.y, rel.x);
      return sampleMap(vec2(theta / TWO_PI + 0.5, phi / PI));

    } else if (mappingMode == 5) {
      // Triplanar – smooth blend using face-stable projection normal (constant per triangle)
      vec3 blend = abs(PN);
      blend = pow(blend, vec3(4.0));
      blend /= dot(blend, vec3(1.0)) + 1e-4;

      float hXY = sampleMap(vec2((pos.x - boundsMin.x) / md, (pos.y - boundsMin.y) / md));
      float hXZ = sampleMap(vec2((pos.x - boundsMin.x) / md, (pos.z - boundsMin.z) / md));
      float hYZ = sampleMap(vec2((pos.y - boundsMin.y) / md, (pos.z - boundsMin.z) / md));

      return hXY * blend.z + hXZ * blend.y + hYZ * blend.x;

    } else {
      // Cubic (box) – use smooth normals for blend weights so high blend values
      // can hide seams, but fall back to the face-stable triangle normal when
      // the triangle sits on an ambiguous near-45° tie.
      float hYZ = sampleMap(vec2((pos.y - boundsMin.y) / md, (pos.z - boundsMin.z) / md));
      float hXZ = sampleMap(vec2((pos.x - boundsMin.x) / md, (pos.z - boundsMin.z) / md));
      float hXY = sampleMap(vec2((pos.x - boundsMin.x) / md, (pos.y - boundsMin.y) / md));
      vec3 blendN = vModelNormal;
      vec3 absFaceN = abs(PN);
      float facePrimary = max(absFaceN.x, max(absFaceN.y, absFaceN.z));
      float faceSecondary = absFaceN.x + absFaceN.y + absFaceN.z - facePrimary - min(absFaceN.x, min(absFaceN.y, absFaceN.z));
      if (facePrimary - faceSecondary <= CUBIC_AXIS_EPSILON) blendN = PN;
      vec3 wts = cubicBlendWeights(blendN);
      return hYZ * wts.x + hXZ * wts.y + hXY * wts.z;
    }
  }

  void main() {
    // Flip normal for back faces so flipped-winding geometry still lights correctly.
    vec3 N = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
    float h = getHeight();

    // ── Surface angle masking (FDM: suppress texture on near-horizontal faces) ────
    // Use a 15° smoothstep fade above the threshold so the bump tapers gradually
    // into the masked region rather than cutting off abruptly at the boundary edge.
    float surfaceAngle = degrees(acos(clamp(abs(vModelNormal.z), 0.0, 1.0)));
    float maskBlend = 1.0;
    float FADE = 15.0;
    if (vModelNormal.z <  0.0 && bottomAngleLimit >= 1.0)
      maskBlend = min(maskBlend, smoothstep(bottomAngleLimit, bottomAngleLimit + FADE, surfaceAngle));
    if (vModelNormal.z >= 0.0 && topAngleLimit >= 1.0)
      maskBlend = min(maskBlend, smoothstep(topAngleLimit, topAngleLimit + FADE, surfaceAngle));
    h = mix(0.5, h, maskBlend); // blend toward neutral grey (zero-gradient → no bump)

    // ── Bump mapping via screen-space height derivatives ──────────────────
    float dhx = dFdx(h);
    float dhy = dFdy(h);

    vec3 dp1 = dFdx(vViewPos);
    vec3 dp2 = dFdy(vViewPos);

    vec3 T = dp1 - dot(dp1, N) * N;
    vec3 B = dp2 - dot(dp2, N) * N;
    float lenT = length(T);
    float lenB = length(B);
    T = lenT > 1e-5 ? T / lenT : vec3(1.0, 0.0, 0.0);
    B = lenB > 1e-5 ? B / lenB : vec3(0.0, 1.0, 0.0);

    // Bump strength normalised by screen-space position derivative so
    // the effect is independent of zoom level.
    float posScale = max(length(dp1) + length(dp2), 1e-6);
    float bumpStr  = amplitude * 6.0 / posScale;

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
  u.mappingBlend.value     = settings.mappingBlend     ?? 0.0;
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
    mappingBlend:     { value: settings.mappingBlend     ?? 0.0 },
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
