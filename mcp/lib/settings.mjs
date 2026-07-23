/**
 * settings.mjs — maps MCP tool params onto the exact `settings` object
 * js/exportPipeline.js expects. Defaults copied verbatim from
 * PIPELINE_CONTRACT.md (main.js line 76-127).
 */

export const PROJECTION_MODES = {
  planar_xy: 0,
  planar_xz: 1,
  planar_yz: 2,
  cylindrical: 3,
  spherical: 4,
  triplanar: 5,
  cubic: 6,
};

export function projectionNameToMode(name) {
  const key = String(name).trim().toLowerCase();
  if (!(key in PROJECTION_MODES)) {
    throw new Error(
      `Unknown projection "${name}". Valid options: ${Object.keys(PROJECTION_MODES).join(', ')}.`
    );
  }
  return PROJECTION_MODES[key];
}

const DEFAULT_SETTINGS = {
  mappingMode: 5, // triplanar
  scaleU: 0.5, scaleV: 0.5,
  amplitude: 0.5,
  textureHeight: 0.5, invertDisplacement: false,
  offsetU: 0.0, offsetV: 0.0, rotation: 0,
  refineLength: 1.0,
  maxTriangles: 750000,
  lockScale: true,
  bottomAngleLimit: 5, topAngleLimit: 0,
  mappingBlend: 1, seamBandWidth: 0.5, textureSmoothing: 0,
  blendNormalSmoothing: 32, capAngle: 20, boundaryFalloff: 0,
  symmetricDisplacement: false, noDownwardZ: false,
  smoothBottom: true, harvestFlatFaces: true, harvestTol: 0.005,
  useDisplacement: false,
  snapSeamlessWrap: true, cylinderCenterX: null, cylinderCenterY: null, cylinderRadius: null,
  regularizeEnabled: true, regularizeAspectThreshold: 5, regularizeSlack: 3.0,
  regularizeAggressiveSlack: 8.0, regularizeExtremeAspect: 8, regularizeNormalDeg: 15,
  regularizeAggressiveNormalDeg: 25, regularizeSecondPassMul: 1.1,
};

/**
 * Build the full pipeline settings object, overriding CONTRACT defaults from
 * tool params. NOTE (discrepancy vs the design doc's "amplitude(0..1)"):
 * the real app's `amplitude`/`textureHeight` slider is in MILLIMETERS
 * (index.html: `<input id="amplitude" min="0" max="2" step="0.01">`), added
 * directly to vertex positions in displacement.js — not a 0..1 fraction. We
 * follow the real code: `params.amplitude` is mm and may be negative to
 * invert the bump direction (equivalent to the app's invertDisplacement).
 */
export function buildSettings(params = {}) {
  const settings = { ...DEFAULT_SETTINGS };

  if (params.projection !== undefined) settings.mappingMode = projectionNameToMode(params.projection);
  if (params.scaleU !== undefined) settings.scaleU = params.scaleU;
  if (params.scaleV !== undefined) settings.scaleV = params.scaleV;
  if (params.offsetU !== undefined) settings.offsetU = params.offsetU;
  if (params.offsetV !== undefined) settings.offsetV = params.offsetV;
  if (params.rotation !== undefined) settings.rotation = params.rotation;
  if (params.amplitude !== undefined) {
    settings.amplitude = params.amplitude;
    settings.textureHeight = Math.abs(params.amplitude);
    settings.invertDisplacement = params.amplitude < 0;
  }
  if (params.symmetric !== undefined) settings.symmetricDisplacement = params.symmetric;
  if (params.maskTopAngle !== undefined) settings.topAngleLimit = params.maskTopAngle;
  if (params.maskBottomAngle !== undefined) settings.bottomAngleLimit = params.maskBottomAngle;
  if (params.refineLength !== undefined) settings.refineLength = params.refineLength;
  if (params.decimateTo !== undefined) settings.maxTriangles = params.decimateTo;
  if (params.textureSmoothing !== undefined) settings.textureSmoothing = params.textureSmoothing;

  return settings;
}

/** Mirrors main.js `_regularizeOpts` exactly — see PIPELINE_CONTRACT.md. */
export function buildRegularizeOpts(settings) {
  return {
    aspectThreshold: settings.regularizeAspectThreshold,
    slack: settings.regularizeSlack,
    aggressiveSlack: settings.regularizeAggressiveSlack,
    extremeSliverAspect: settings.regularizeExtremeAspect,
    maxNormalDeltaCos: Math.cos((settings.regularizeNormalDeg * Math.PI) / 180),
    aggressiveNormalDeltaCos: Math.cos((settings.regularizeAggressiveNormalDeg * Math.PI) / 180),
  };
}
