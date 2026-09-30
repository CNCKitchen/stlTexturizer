/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as THREE from 'three';
import { initViewer, loadGeometry, setMeshMaterial, setMeshGeometry, setWireframe,
         getControls, getCamera, getCurrentMesh,
         setExclusionOverlay, setHoverPreview, setViewerTheme,
         setProjection, requestRender,
         clearDiagOverlays, setDiagEdges, addDiagFaces,
         setRotationGizmo, isGizmoDragging, isSoftwareRendering, setTurntable,
         setSectionView, setSectionAxis, flipSection, setSectionHandlesLocked,
         sectionVisibleHits } from './viewer.js';
import { loadModelFile, computeBounds, getTriangleCount }  from './stlLoader.js';
import { estimateStep } from './stepLoader.js';
import { resolveStepSettings } from './stepConvert.js';
import { computeSmartResolution } from './smartResolution.js';
import { REF_TEXTURE_SIZE } from './textureAnalysis.js';
import { loadFullPreset, loadCustomTexture, IMAGE_PRESETS }  from './presetTextures.js';
import { initTextureGallery } from './textureGallery.js';
import { getCustomTextureFile } from './customTextures.js';
import { initSidebarToggle } from './sidebarToggle.js';
import { createPreviewMaterial, updateMaterial } from './previewMaterial.js';
import { subdivide }          from './subdivision.js';
import { runExportPipeline }  from './exportPipeline.js';
import { runPreviewPipeline, computeFaceNormals } from './previewPipeline.js';
import { exportSTL, export3MF } from './exporter.js';
import { buildAdjacency, bucketFill,
         buildExclusionOverlayGeo, buildFaceWeights } from './exclusion.js';
import { brushCoverage, hasSoftPaint, valuesToCorners, cornersToValues,
         buildSoftExclusion, softPaintedFaces, interpolateFromParents } from './softMask.js';
import { runFastDiagnostics, runExpensiveDiagnostics,
         getEdgePositions } from './meshValidation.js';
import { t, tHtml, initLang, setLang, getLang, applyTranslations, TRANSLATIONS } from './i18n.js';
import { getScaleReferenceLengths } from './mapping.js';
import { QuantizedPointMap } from './meshIndex.js';
import { APP_VERSION } from './version.js';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';

// ── State ─────────────────────────────────────────────────────────────────────

let currentGeometry   = null;   // original loaded geometry
let currentBounds     = null;   // bounds of the original geometry
// Forward rigid transform from the file's original coordinates to the in-app
// (centered, possibly rotated) working space: mem = poseRot·orig + poseTrans.
// Import centering, in-app rotation, and place-on-face all fold into it; the
// full INVERSE is applied on export so files leave BumpMesh in their original
// position AND orientation (issue #82) — in-app rotation is a texturing aid,
// not part of the output.
let currentPoseRot    = new THREE.Quaternion();
let currentPoseTrans  = new THREE.Vector3();
let _rotatePoseSnapshot = null; // { rot, trans } captured on rotate-mode entry, restored by the reset button alongside _rotateOriginalPositions
let currentStlName    = 'model'; // base filename of the loaded STL (no extension)
let currentStlExt     = '.stl';  // source file extension (.stl/.obj/.3mf/.step/.stp), for the stats line
let activeMapEntry    = null;   // { name, texture, imageData, width, height, isCustom?, customId? (library id) }
let _lastCustomMap    = null;   // most recent uploaded/imported custom-map entry, kept across preset switches so the thumbnail can re-activate it
let previewMaterial   = null;
let isExporting       = false;
let isBaking          = false;
let smoothBottomAutoOff = false; // Smooth Bottom was switched off by Bottom faces = 0 (#126), see syncSmoothBottomToLimit
let previewDebounce   = null;

// Boundary edge data texture for per-fragment falloff in bump-only preview
let _boundaryEdgeTex   = null;
let _boundaryEdgeCount = 0;
let _falloffDirty      = true;   // recompute falloff on next updateFaceMask
let _falloffGeometry   = null;   // geometry the falloff was last computed for

// ── Exclusion state ───────────────────────────────────────────────────────────
let excludedFaces      = new Set();   // triangle indices in currentGeometry
let triangleAdjacency  = null;        // Array from buildAdjacency
let triangleCentroids  = null;        // Float32Array from buildAdjacency
let triangleFaceNormals = null;       // Float32Array — local-space unit face normal per tri
let exclusionTool      = null;        // 'brush' | 'bucket' | null
let eraseMode          = false;
let brushIsRadius      = false;
let brushRadius        = 5.0;
let brushHardness      = 1.0;         // circle brush: 1 = hard, face-exact; < 1 = soft, painted per vertex (softMask.js)
// Soft-brush paint layer on currentGeometry: { vertId, count, serial, values }
// — welded vertex id per corner (from buildAdjacency), welded vertex count, a
// serial that changes with the tessellation (undo snapshots only restore onto
// the mesh they were taken on), and coverage per welded vertex (null until the
// first soft stroke).
let softPaint          = null;
let _softLayerSerial   = 0;
let bucketThreshold    = 20;
let isPainting         = false;
let selectionMode      = false;       // false = exclude painted faces; true = include only painted faces
let maskModeChosen     = false;       // false until the user (or a loaded/seeded mask) engages surface masking — neither mode button is highlighted
let _lastHoverTriIdx   = -1;          // last triangle index used for hover preview
let placeOnFaceActive  = false;       // true while "Place on Face" mode is active
let rotateActive       = false;       // true while rotate mode is active
let rotateAngles       = { x: 0, y: 0, z: 0 };  // accumulated rotation in degrees
let _rotateOriginalPositions = null;  // Float32Array snapshot before any rotation
const _raycaster       = new THREE.Raycaster();
let _lastPaintHitPoint = null;        // THREE.Vector3 — last brush paint position for shift-line
let _strokeLastPoint   = null;        // THREE.Vector3 — previous point of the current drag (soft brush sweeps from it)
let _shiftLineMesh     = null;        // THREE.Line — preview line from last paint to cursor
let _lastEffectiveTexture = null;
let _effectiveMapCache    = null;
let _effectiveMapCacheKey = null;

const settings = {
  mappingMode:   5,     // Triplanar default
  // Texture tile size in ABSOLUTE millimetres (one full repeat along U/V).
  // Initialized per model on load: DEFAULT_TILE_FRACTION × largest bbox edge
  // (the default 50 mm cube → 25 mm). Consumers convert to relative factors
  // via mapping.js scaleMmToRelative.
  scaleU:        25,
  scaleV:        25,
  amplitude:     0.5,
  textureHeight: 0.5,
  invertDisplacement: false,
  offsetU:       0.0,
  offsetV:       0.0,
  rotation:      0,
  refineLength:  1.0,
  maxTriangles:  750_000,
  lockScale:     true,
  bottomAngleLimit: 5,
  topAngleLimit:    0,
  mappingBlend:     1,
  seamBandWidth:    0.5,
  textureSmoothing: 0,
  invertTexture: false,
  // Laplacian smoothing iterations applied to the per-vertex blend normal
  // (only the normal that drives projection-direction blend weights — not
  // the displacement direction). 0 = off, 4–8 = noticeable seam smoothing,
  // higher = diminishing returns and risk of losing macro orientation.
  blendNormalSmoothing: 32,
  capAngle:         20,
  boundaryFalloff:  0,
  // Shape of the 0→1 displacement ramp inside the boundary-falloff band:
  // 'linear' (constant slope), 'scurve' (smoothstep, eased at both ends),
  // 'ease' (quadratic ease-in, gentlest at the mask edge). Old snapshots
  // without the key fall back to 'linear' — the only ramp they had.
  boundaryFalloffCurve: 'ease',
  symmetricDisplacement: false,
  noDownwardZ: false,
  smoothBottom: true,
  harvestFlatFaces: true,
  harvestTol: 0.005,
  // Preserve Untextured Surfaces (beta): regularize + decimation leave faces
  // excluded from texturing (painted mask, selection mode, top/bottom angle
  // masks) completely untouched, so original fillets and fine CAD detail
  // survive. Subdivision already skips their interior edges regardless.
  preserveUntextured: true,
  useDisplacement: false,
  // Cylindrical-mode controls.
  // null/undefined → derive from bounds (preserves legacy / non-cylindrical behavior).
  snapSeamlessWrap: true,
  cylinderCenterX:  null,
  cylinderCenterY:  null,
  cylinderRadius:   null,
  cylinderPanelMinimized: false,
  // Regularize Mesh.  Two-step pipeline applied after the initial subdivide:
  // collapse sliver chains, then re-subdivide stretched edges back to a
  // multiple of refineLength.  Always on with these standard values — the
  // knobs here mirror regularize.js opts; second-pass cap is for the
  // post-regularize subdivide step in main.js.
  regularizeEnabled:        true,
  regularizeAspectThreshold: 5,
  regularizeSlack:           3.0,
  regularizeAggressiveSlack: 8.0,
  regularizeExtremeAspect:   8,
  regularizeNormalDeg:       15,
  regularizeAggressiveNormalDeg: 25,
  regularizeSecondPassMul:   1.1,
};

// ── Canvas filter support (Safari / iOS WebView don't support ctx.filter) ────
const CANVAS_FILTER_SUPPORTED = 'filter' in CanvasRenderingContext2D.prototype;

/**
 * Box-blur one row of RGBA pixels (horizontal pass).
 * Operates in-place reading from `src` and writing to `dst`.
 */
function _boxBlurH(src, dst, w, h, r) {
  const iarr = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let ch = 0; ch < 4; ch++) {
      let val = 0;
      // Seed with left-edge pixel repeated r+1 times plus the first r pixels
      for (let x = -r; x <= r; x++) val += src[(row + Math.max(0, Math.min(x, w - 1))) * 4 + ch];
      for (let x = 0; x < w; x++) {
        val += src[(row + Math.min(x + r, w - 1)) * 4 + ch]
             - src[(row + Math.max(x - r - 1, 0)) * 4 + ch];
        dst[(row + x) * 4 + ch] = Math.round(val * iarr);
      }
    }
  }
}

/** Box-blur one column of RGBA pixels (vertical pass). */
function _boxBlurV(src, dst, w, h, r) {
  const iarr = 1 / (2 * r + 1);
  for (let x = 0; x < w; x++) {
    for (let ch = 0; ch < 4; ch++) {
      let val = 0;
      for (let y = -r; y <= r; y++) val += src[(Math.max(0, Math.min(y, h - 1)) * w + x) * 4 + ch];
      for (let y = 0; y < h; y++) {
        val += src[(Math.min(y + r, h - 1) * w + x) * 4 + ch]
             - src[(Math.max(y - r - 1, 0) * w + x) * 4 + ch];
        dst[(y * w + x) * 4 + ch] = Math.round(val * iarr);
      }
    }
  }
}

/**
 * Apply an approximate Gaussian blur (sigma px) to `canvas` in-place.
 * Uses the native CSS filter on Chrome/Firefox; falls back to a 3-pass
 * separable box blur for Safari / iOS WebKit.
 */
function blurCanvas(canvas, sigma) {
  if (sigma <= 0) return;
  if (CANVAS_FILTER_SUPPORTED) {
    const tmp = document.createElement('canvas');
    tmp.width = canvas.width; tmp.height = canvas.height;
    const tc = tmp.getContext('2d');
    tc.filter = `blur(${sigma}px)`;
    tc.drawImage(canvas, 0, 0);
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    canvas.getContext('2d').drawImage(tmp, 0, 0);
  } else {
    // 3 passes of box blur ≈ Gaussian; radius r where r(r+1) ≈ sigma²
    const r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
    const ctx = canvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const a = imgData.data;
    const b = new Uint8ClampedArray(a.length);
    const w = canvas.width, h = canvas.height;
    for (let pass = 0; pass < 3; pass++) {
      _boxBlurH(a, b, w, h, r);
      _boxBlurV(b, a, w, h, r);
    }
    ctx.putImageData(imgData, 0, 0);
  }
}

// ── Precision masking state ────────────────────────────────────────────────────
let precisionMaskingEnabled = false;
let precisionGeometry       = null;   // subdivided geometry for finer masking
let precisionParentMap      = null;   // Int32Array: refined face → original face index
let precisionEdgeLength     = null;   // edge length used for current refinement
let precisionBusy           = false;  // true while async subdivision is running
let precisionCentroids      = null;   // Float32Array from buildAdjacency on refined mesh
let precisionFaceNormals    = null;   // Float32Array — local-space unit face normal per refined tri
let precisionAdjacency      = null;   // Array from buildAdjacency on refined mesh
let precisionExcludedFaces  = new Set(); // precision face indices excluded while precision is active
let precisionSoftPaint      = null;   // soft-brush paint layer on the refined mesh (see softPaint)
let precisionPainted        = false;  // refined mesh carries strokes that re-seeding from the base would lose

// ── Displacement preview state ────────────────────────────────────────────────
let dispPreviewGeometry  = null;   // subdivided geometry with smoothNormal attribute
let dispPreviewParentMap = null;   // Int32Array: subdivided face → original face index
let dispPreviewEdgeInfo  = null;   // { floorEdge, maxEdge, edge } of the latest build; edge null while building
// Declared up here, not beside their functions: model loads during module
// init already call cancelDisplacementPreviewBuild().
let _previewWorkerAbort  = null;   // set while a worker build is in flight: kill + resolve(null)
let _dispPreviewResolutionTimer = null;

// 3D-preview mesh budget, in predicted first-subdivide triangles (see
// choosePreviewEdge in previewPipeline.js).  That count drives the build time
// (~2 µs per triangle in the preview worker on a desktop CPU) and the
// preview's memory.  Low-memory and touch devices get a smaller budget.
const PREVIEW_TRI_BUDGET =
  (navigator.deviceMemory && navigator.deviceMemory < 4) || matchMedia('(pointer: coarse)').matches
    ? 600_000
    : 1_500_000;

// ── Operation tokens (stale-result guards) ────────────────────────────────────
// Each async operation captures the current token at start and checks it after
// every await. When a new model loads all tokens are incremented, causing any
// in-flight operation to silently abort rather than apply results to new state.
let precisionToken   = 0;
let dispPreviewToken = 0;
let exportToken      = 0;
let diagToken        = 0;
let lastFastDiag     = null;   // cached fast diagnostics result for language refresh
let lastAdvancedDiag = null;   // cached advanced diagnostics result for language refresh
let activeDiagHighlight = null; // which highlight is showing: 'openEdges'|'nonManifold'|'shells'|'overlaps'|null

// ── DOM refs ──────────────────────────────────────────────────────────────────

const canvas         = document.getElementById('viewport');
const brushCursorEl  = document.getElementById('brush-cursor');
const dropZone       = document.getElementById('drop-zone');
const dropHint       = document.getElementById('drop-hint');
const MODEL_FILE_RE  = /\.(stl|obj|3mf|step|stp)$/i;
const stlFileInput   = document.getElementById('stl-file-input');
const textureInput   = document.getElementById('texture-file-input');
const customMapRow      = document.getElementById('custom-map-row');
const customMapSwatch   = document.getElementById('custom-map-swatch');
const customMapRemoveBtn = document.getElementById('custom-map-remove');
const meshInfo       = document.getElementById('mesh-info');
const importProgress    = document.getElementById('import-progress');
const importProgBar     = document.getElementById('import-progress-bar');
const importProgPct     = document.getElementById('import-progress-pct');
const importProgLbl     = document.getElementById('import-progress-label');
const stepOverlay       = document.getElementById('step-overlay');
const stepDialogClose   = document.getElementById('step-dialog-close');
const stepModelSize     = document.getElementById('step-model-size');
const stepSurfaceDev    = document.getElementById('step-surface-dev');
const stepNormalDev     = document.getElementById('step-normal-dev');
const stepMaxEdge       = document.getElementById('step-max-edge');
const stepImportGo      = document.getElementById('step-import-go');
const stepImportCancel  = document.getElementById('step-import-cancel');

// Render the bottom-left mesh stats line, prefixed with the loaded model's
// name (currentStlName, extension-stripped) so the user can see which file
// the stats belong to.
function _setMeshInfo(triCount, mb, sx, sy, sz) {
  const stats = t('ui.meshInfo', { n: triCount.toLocaleString(), mb, sx, sy, sz });
  const fileName = currentStlName ? `${currentStlName}${currentStlExt}` : '';
  meshInfo.textContent = fileName ? `${fileName} · ${stats}` : stats;
}
const exportBtn        = document.getElementById('export-btn');
const export3mfBtn     = document.getElementById('export-3mf-btn');
const exportProgress   = document.getElementById('export-progress');
const exportProgBar    = document.getElementById('export-progress-bar');
const exportProgPct    = document.getElementById('export-progress-pct');
const exportProgLbl    = document.getElementById('export-progress-label');
const triLimitWarning  = document.getElementById('tri-limit-warning');
const bakeBtn          = document.getElementById('bake-btn');
const bakeMaskChk      = document.getElementById('bake-mask-chk');
const bakeProgress     = document.getElementById('bake-progress');
const bakeProgBar      = document.getElementById('bake-progress-bar');
const bakeProgPct      = document.getElementById('bake-progress-pct');
const bakeProgLbl      = document.getElementById('bake-progress-label');
const advancedSection  = document.getElementById('advanced-section');
const advancedToggle   = document.getElementById('advanced-toggle');
const wireframeToggle  = document.getElementById('wireframe-toggle');
const projectionToggle = document.getElementById('projection-toggle');
const sectionToggle    = document.getElementById('section-toggle');
const sectionControls  = document.getElementById('section-controls');
const placeOnFaceBtn   = document.getElementById('place-on-face-btn');
const rotateBtn        = document.getElementById('rotate-btn');
const rotateControls   = document.getElementById('rotate-controls');
const rotateXInput     = document.getElementById('rotate-x');
const rotateYInput     = document.getElementById('rotate-y');
const rotateZInput     = document.getElementById('rotate-z');
const rotateApplyBtn   = document.getElementById('rotate-apply-btn');
const rotateResetBtn   = document.getElementById('rotate-reset-btn');

const mappingSelect   = document.getElementById('mapping-mode');
const scaleUSlider    = document.getElementById('scale-u');
const scaleVSlider    = document.getElementById('scale-v');
const lockScaleBtn    = document.getElementById('lock-scale');
const offsetUSlider   = document.getElementById('offset-u');
const offsetVSlider   = document.getElementById('offset-v');
const amplitudeSlider = document.getElementById('amplitude');
const refineLenSlider = document.getElementById('refine-length');
const maxTriSlider    = document.getElementById('max-triangles');

const scaleUVal    = document.getElementById('scale-u-val');
const scaleVVal    = document.getElementById('scale-v-val');
const offsetUVal   = document.getElementById('offset-u-val');
const offsetVVal   = document.getElementById('offset-v-val');
const rotationSlider = document.getElementById('rotation');
const rotationVal    = document.getElementById('rotation-val');
const amplitudeVal      = document.getElementById('amplitude-val');
const amplitudeWarning  = document.getElementById('amplitude-warning');
const invertDisplacementCheckbox = document.getElementById('invert-displacement');
const refineLenVal = document.getElementById('refine-length-val');
const resolutionWarning = document.getElementById('resolution-warning');
const smartResBtn  = document.getElementById('smart-res-btn');
const smartResInfo = document.getElementById('smart-res-info');
const maxTriVal    = document.getElementById('max-triangles-val');

const bottomAngleLimitSlider = document.getElementById('bottom-angle-limit');
const topAngleLimitSlider    = document.getElementById('top-angle-limit');
const bottomAngleLimitVal    = document.getElementById('bottom-angle-limit-val');
const topAngleLimitVal       = document.getElementById('top-angle-limit-val');
const seamBlendSlider        = document.getElementById('seam-blend');
const seamBlendVal           = document.getElementById('seam-blend-val');
const seamBandWidthSlider    = document.getElementById('seam-band-width');
const seamBandWidthVal       = document.getElementById('seam-band-width-val');
const textureSmoothingSlider = document.getElementById('texture-smoothing');
const textureSmoothingVal    = document.getElementById('texture-smoothing-val');
const invertTextureCheckbox = document.getElementById('invert-texture');
const capAngleSlider         = document.getElementById('cap-angle');
const capAngleVal            = document.getElementById('cap-angle-val');
const capAngleRow            = document.getElementById('cap-angle-row');
const cylinderSnapRow        = document.getElementById('cylinder-snap-row');
const cylinderSnapToggle     = document.getElementById('cylinder-snap-toggle');
const cylinderAxisRow        = document.getElementById('cylinder-axis-row');
const cylinderAutofitBtn     = document.getElementById('cylinder-autofit-btn');
const cylinderResetBtn       = document.getElementById('cylinder-reset-btn');
const cylinderPanel          = document.getElementById('cylinder-panel');
const cylinderCanvas         = document.getElementById('cylinder-canvas');
const cylinderPanelMinimize  = document.getElementById('cylinder-panel-minimize');
const boundaryFalloffSlider    = document.getElementById('boundary-falloff');
const boundaryFalloffVal       = document.getElementById('boundary-falloff-val');
const falloffCurveButtons      = {
  linear: document.getElementById('falloff-curve-linear'),
  scurve: document.getElementById('falloff-curve-scurve'),
  ease:   document.getElementById('falloff-curve-ease'),
};
const symmetricDispToggle    = document.getElementById('symmetric-displacement');
const dispPreviewToggle      = document.getElementById('displacement-preview');
const dispPreviewSpinner     = document.getElementById('displacement-preview-spinner');
const noDownwardZChk         = document.getElementById('no-downward-z-chk');
const smoothBottomChk        = document.getElementById('smooth-bottom-chk');
const smoothBottomRow        = document.getElementById('smooth-bottom-row');
const harvestFlatChk         = document.getElementById('harvest-flat-chk');
const harvestTolInput        = document.getElementById('harvest-tol');
const harvestTolRow          = document.getElementById('harvest-tol-row');
const preserveUntexturedChk  = document.getElementById('preserve-untextured-chk');

// ── Exclusion panel DOM refs ──────────────────────────────────────────────────
const exclBrushBtn        = document.getElementById('excl-brush-btn');
const exclBucketBtn       = document.getElementById('excl-bucket-btn');
const exclBrushTypeRow    = document.getElementById('excl-brush-type-row');
const exclBrushSingleBtn  = document.getElementById('excl-brush-single');
const exclBrushRadiusBtn  = document.getElementById('excl-brush-radius-btn');
const exclRadiusRow       = document.getElementById('excl-radius-row');
const exclBrushRadiusSlider = document.getElementById('excl-brush-radius-slider');
const exclBrushRadiusVal    = document.getElementById('excl-brush-radius-val');
const exclHardnessRow       = document.getElementById('excl-hardness-row');
const exclBrushHardnessSlider = document.getElementById('excl-brush-hardness-slider');
const exclBrushHardnessVal    = document.getElementById('excl-brush-hardness-val');
const exclThresholdRow    = document.getElementById('excl-threshold-row');
const exclThresholdSlider = document.getElementById('excl-threshold-slider');
const exclThresholdVal    = document.getElementById('excl-threshold-val');
const exclCount           = document.getElementById('excl-count');
const exclClearBtn        = document.getElementById('excl-clear-btn');
const exclModeExcludeBtn  = document.getElementById('excl-mode-exclude');
const exclModeIncludeBtn  = document.getElementById('excl-mode-include');
const exclSectionHeading  = document.getElementById('excl-section-heading');
const exclHint            = document.getElementById('excl-hint');

// ── Precision masking DOM refs ────────────────────────────────────────────────
const precisionMaskingRow     = document.getElementById('precision-masking-row');
const precisionMaskingToggle  = document.getElementById('precision-masking-toggle');
const precisionStatus         = document.getElementById('precision-status');
const precisionOutdated       = document.getElementById('precision-outdated');
const precisionRefreshBtn     = document.getElementById('precision-refresh-btn');
const precisionWarning        = document.getElementById('precision-warning');

// ── Mesh diagnostics DOM refs ────────────────────────────────────────────────
const meshDiagnostics    = document.getElementById('mesh-diagnostics');
const meshDiagDismiss    = document.getElementById('mesh-diag-dismiss');
const meshDiagFast       = document.getElementById('mesh-diag-fast');
const meshDiagRunBtn     = document.getElementById('mesh-diag-run-btn');
const meshDiagSpinner    = document.getElementById('mesh-diag-spinner');
const meshDiagAdvanced   = document.getElementById('mesh-diag-advanced');

// ── License panel DOM refs ────────────────────────────────────────────────────
const licenseLink    = document.getElementById('license-link');
const licenseOverlay = document.getElementById('license-overlay');
const licenseClose   = document.getElementById('license-close');
const imprintLink    = document.getElementById('imprint-link');
const imprintOverlay = document.getElementById('imprint-overlay');
const imprintClose   = document.getElementById('imprint-close');

// ── Welcome / What's New popup ───────────────────────────────────────────────
// Bump this date whenever the "What's New" bullets in index.html change to
// re-show the popup to all returning visitors who previously dismissed it.
const WELCOME_LAST_UPDATED = '2026-09-29';
const WELCOME_STORAGE_KEY  = 'stlt-welcome-seen';
const welcomeLink     = document.getElementById('welcome-link');
const welcomeOverlay  = document.getElementById('welcome-overlay');
const welcomeClose    = document.getElementById('welcome-close');
const welcomeGotIt    = document.getElementById('welcome-got-it');
const welcomeDontShow = document.getElementById('welcome-dont-show');

// ── Language selector DOM refs ────────────────────────────────────────────────────
const languageSelector = document.querySelector('.lang-seg');

// ── Scale slider log helpers ──────────────────────────────────────────────────
// The slider stores 0–1000 and sweeps 0.05×–10× of the current model's
// largest bbox edge on a log axis — the exact travel and default position of
// the legacy relative slider — but the value it reads/writes is the absolute
// tile size in mm. The numeric input accepts values beyond the slider range
// (clamped in _applyScaleU/V); the slider just pins to its end.
const SCALE_REL_SLIDER_MIN = 0.05;
const SCALE_REL_SLIDER_MAX = 10;
const SCALE_MM_INPUT_MIN   = 0.01;
const SCALE_MM_INPUT_MAX   = 10000;
// Fraction of the model's largest bbox edge used to pre-calculate a
// nice-looking initial tile size when a model loads (legacy relative 0.5 —
// lands at slider position 435, same as always).
const DEFAULT_TILE_FRACTION = 0.5;
const _LOG_MIN = Math.log(SCALE_REL_SLIDER_MIN);
const _LOG_MAX = Math.log(SCALE_REL_SLIDER_MAX);

/** Largest bbox edge of the loaded model — the slider's per-model anchor. */
function _scaleAnchorMm() {
  return currentBounds
    ? Math.max(currentBounds.size.x, currentBounds.size.y, currentBounds.size.z)
    : 50;
}

const scaleToPos = mm => {
  const rel = Math.max(SCALE_REL_SLIDER_MIN, Math.min(SCALE_REL_SLIDER_MAX, mm / _scaleAnchorMm()));
  return Math.round((Math.log(rel) - _LOG_MIN) / (_LOG_MAX - _LOG_MIN) * 1000);
};
const posToScale = p => parseFloat(
  (_scaleAnchorMm() * Math.exp(_LOG_MIN + (p / 1000) * (_LOG_MAX - _LOG_MIN))).toPrecision(3));

/** Tile size (mm) that visually matches the legacy relative default on this model. */
function _defaultTileMm(relFraction = DEFAULT_TILE_FRACTION) {
  return parseFloat((relFraction * _scaleAnchorMm()).toPrecision(3));
}

// Compute the active U texture-aspect factor (mirrors updatePreview's logic so
// the snap math agrees with what computeUV actually does).
function _currentTextureAspectU() {
  const tw = activeMapEntry?.width ?? 1, th = activeMapEntry?.height ?? 1;
  const tmax = Math.max(tw, th, 1);
  return tmax / Math.max(tw, 1);
}

// True when the active mapping mode wraps U around the model, so snapping the
// U scale to integer tile counts can make the wrap seam disappear.
function _isSeamlessWrapMode() {
  return settings.mappingMode === 3 /* MODE_CYLINDRICAL */ ||
         settings.mappingMode === 4 /* MODE_SPHERICAL */;
}

// Round a U texture size (mm) to the nearest seamless-wrap value:
//   tiles around circumference = aspectU × C / scaleU_mm  →  must be a
//   positive integer, where C is the mode's wrap circumference (projection
//   cylinder circumference, or the sphere's equator).
function _snapScaleUForSeamlessWrap(scaleUMm) {
  const aU = _currentTextureAspectU();
  const size = currentBounds ? currentBounds.size : { x: 50, y: 50, z: 50 };
  const { refU: C } = getScaleReferenceLengths(settings.mappingMode, settings, { size });
  const MAX_TILES = 200;
  let n = Math.round((aU * C) / Math.max(scaleUMm, 1e-6));
  if (!Number.isFinite(n) || n < 1) n = 1;
  if (n > MAX_TILES) n = MAX_TILES;
  return parseFloat(((aU * C) / n).toFixed(4));
}

// The Size U/V number boxes show at most 2 decimals; the precise value
// (needed for exact seamless-wrap snapping) stays in settings.scaleU/scaleV.
const fmtScaleVal = v => +(+v).toFixed(2);

function _applyScaleU(v) {
  v = Math.max(SCALE_MM_INPUT_MIN, Math.min(SCALE_MM_INPUT_MAX, v));
  if (settings.snapSeamlessWrap && _isSeamlessWrapMode()) {
    v = _snapScaleUForSeamlessWrap(v);
  }
  settings.scaleU = v;
  scaleUSlider.value = scaleToPos(v);
  scaleUVal.value = fmtScaleVal(v);
  if (settings.lockScale) { settings.scaleV = v; scaleVSlider.value = scaleToPos(v); scaleVVal.value = fmtScaleVal(v); }
  clearTimeout(previewDebounce); previewDebounce = setTimeout(updatePreview, 80);
}

// ── Cylindrical projection: inset panel + axis helpers ────────────────────────
// The inset 2D panel shows a top-down (X-Y) silhouette of the part with two
// draggable handles: a center dot and a radius ring. Both drive
// settings.cylinderCenterX/Y and settings.cylinderRadius respectively. When any
// of those settings is null/undefined, the rendering and the projection both
// fall back to AABB-derived defaults — which preserves the pre-feature behavior
// for old projects and non-cylindrical modes.

let _cylSilhouetteCanvas     = null; // off-screen canvas of the X-Y silhouette
let _cylSilhouetteGeometry   = null; // identity check so we re-rasterize on swap
let _cylSilhouetteAnchor     = null; // { cxw, cyw, scale } — world XY at silhouette pixel-center, frozen at build time
let _cylPanelTransform       = null; // { scale, cxw, cyw, W, H } — current view; cxw/cyw are mutated by panning
let _cylDragMode             = null; // null | 'center' | 'radius' | 'pan'
let _cylHoverMode            = null; // null | 'center' | 'radius' (for cursor + redraw)
let _cylPanLastPx            = 0;    // last pointer X during pan, in panel pixels
let _cylPanLastPy            = 0;    // last pointer Y during pan, in panel pixels
let _cylRedrawScheduled      = false;
let _cylPreviewThrottle      = null;

// Hit-detection radii in panel pixels — kept in one place so pointer handlers
// and the redraw both treat the same area as the handle.
const _CYL_CENTER_HIT_PX = 10;
const _CYL_RING_HIT_PX   = 8;

function getEffectiveCylinderCenter() {
  const cx = settings.cylinderCenterX ?? (currentBounds?.center.x ?? 0);
  const cy = settings.cylinderCenterY ?? (currentBounds?.center.y ?? 0);
  return { cx, cy };
}

function getEffectiveCylinderRadius() {
  if (settings.cylinderRadius != null) return settings.cylinderRadius;
  if (!currentBounds) return 1;
  return Math.max(currentBounds.size.x, currentBounds.size.y) * 0.5;
}

function _buildCylinderSilhouette() {
  if (!currentGeometry || !currentBounds) {
    _cylSilhouetteCanvas = null;
    _cylSilhouetteGeometry = null;
    _cylSilhouetteAnchor = null;
    _cylPanelTransform = null;
    return;
  }
  if (_cylSilhouetteGeometry === currentGeometry && _cylSilhouetteCanvas) return;

  const W = cylinderCanvas.width, H = cylinderCanvas.height;
  const padPx = 18;
  const sx = currentBounds.size.x, sy = currentBounds.size.y;
  // Fit the silhouette into the panel with 50% room around the AABB so a
  // slightly off-center axis is still visible without panning. Panning lets
  // the user reach further when needed.
  const halfX = Math.max(sx, 1e-6) * 0.75;
  const halfY = Math.max(sy, 1e-6) * 0.75;
  const cxw = (currentBounds.min.x + currentBounds.max.x) * 0.5;
  const cyw = (currentBounds.min.y + currentBounds.max.y) * 0.5;
  const drawW = W - padPx * 2;
  const drawH = H - padPx * 2;
  const scale = Math.min(drawW / (halfX * 2), drawH / (halfY * 2));
  // The silhouette anchor is frozen at build time; the *view* transform
  // (_cylPanelTransform) starts equal to the anchor and is mutated by panning.
  _cylSilhouetteAnchor = { cxw, cyw, scale };
  _cylPanelTransform   = { scale, cxw, cyw, W, H };

  // Rasterize each triangle's X-Y projection into an offscreen canvas so we
  // can later drawImage it at a panning offset (putImageData ignores transforms).
  const pos = currentGeometry.attributes.position.array;
  const idx = currentGeometry.index ? currentGeometry.index.array : null;
  const triCount = idx ? (idx.length / 3) : (pos.length / 9);
  const buf = new Uint8Array(W * H);
  const wx2px = (wx) => (wx - cxw) * scale + W / 2;
  const wy2py = (wy) => H / 2 - (wy - cyw) * scale;

  for (let t = 0; t < triCount; t++) {
    const i0 = idx ? idx[t * 3]     : t * 3;
    const i1 = idx ? idx[t * 3 + 1] : t * 3 + 1;
    const i2 = idx ? idx[t * 3 + 2] : t * 3 + 2;
    const x0 = wx2px(pos[i0 * 3]),     y0 = wy2py(pos[i0 * 3 + 1]);
    const x1 = wx2px(pos[i1 * 3]),     y1 = wy2py(pos[i1 * 3 + 1]);
    const x2 = wx2px(pos[i2 * 3]),     y2 = wy2py(pos[i2 * 3 + 1]);
    const minX = Math.max(0,     Math.floor(Math.min(x0, x1, x2)));
    const maxX = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
    const minY = Math.max(0,     Math.floor(Math.min(y0, y1, y2)));
    const maxY = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));
    if (minX > maxX || minY > maxY) continue;
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const fx = px + 0.5, fy = py + 0.5;
        const w0 = (fx - x1) * (y2 - y1) - (fy - y1) * (x2 - x1);
        const w1 = (fx - x2) * (y0 - y2) - (fy - y2) * (x0 - x2);
        const w2 = (fx - x0) * (y1 - y0) - (fy - y0) * (x1 - x0);
        if ((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0)) {
          buf[py * W + px] = 1;
        }
      }
    }
  }

  const off = document.createElement('canvas');
  off.width = W; off.height = H;
  const offCtx = off.getContext('2d');
  const img = offCtx.createImageData(W, H);
  const d = img.data;
  for (let i = 0; i < W * H; i++) {
    if (buf[i]) {
      d[i * 4]     = 110;
      d[i * 4 + 1] = 130;
      d[i * 4 + 2] = 145;
      d[i * 4 + 3] = 220;
    } else {
      d[i * 4 + 3] = 0;
    }
  }
  offCtx.putImageData(img, 0, 0);
  _cylSilhouetteCanvas = off;
  _cylSilhouetteGeometry = currentGeometry;
}

function _redrawCylinderPanel() {
  if (!cylinderCanvas) return;
  if (cylinderPanel.classList.contains('hidden')) return;
  const ctx = cylinderCanvas.getContext('2d');
  const W = cylinderCanvas.width, H = cylinderCanvas.height;
  // Background — a cooler dark to read against the surface tone.
  ctx.fillStyle = '#0e1418';
  ctx.fillRect(0, 0, W, H);

  if (_cylPanelTransform && _cylSilhouetteCanvas && _cylSilhouetteAnchor) {
    // Translate the silhouette by the difference between its build-time anchor
    // and the current view center, so panning shifts it visually without a
    // re-rasterization.
    const a = _cylSilhouetteAnchor, t0 = _cylPanelTransform;
    const dxPx =  (a.cxw - t0.cxw) * t0.scale;
    const dyPx = -(a.cyw - t0.cyw) * t0.scale;
    ctx.drawImage(_cylSilhouetteCanvas, dxPx, dyPx);
  }
  if (!_cylPanelTransform) {
    // No model loaded yet — show a hint instead of an empty black square.
    ctx.fillStyle = 'rgba(180, 200, 220, 0.55)';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(t('ui.cylinderNoModel1'), W / 2, H / 2 - 6);
    ctx.fillText(t('ui.cylinderNoModel2'), W / 2, H / 2 + 8);
    return;
  }

  const t = _cylPanelTransform;
  const { cx, cy } = getEffectiveCylinderCenter();
  const r = getEffectiveCylinderRadius();
  const px = (cx - t.cxw) * t.scale + W / 2;
  const py = H / 2 - (cy - t.cyw) * t.scale;
  const pr = Math.max(2, r * t.scale);

  const activeHandle = _cylDragMode || _cylHoverMode;
  const ringActive   = activeHandle === 'radius';
  const centerActive = activeHandle === 'center';

  // Radius ring — thicker + brighter while hovered/dragged so it reads as a
  // grabbable handle. A faint dashed inner halo on hover hints at "draggable".
  ctx.lineWidth = ringActive ? 3.5 : 2;
  ctx.strokeStyle = ringActive ? '#7be0e0' : '#22a3a3';
  ctx.beginPath();
  ctx.arc(px, py, pr, 0, Math.PI * 2);
  ctx.stroke();

  if (ringActive) {
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(123, 224, 224, 0.6)';
    ctx.beginPath(); ctx.arc(px, py, pr - 5, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(px, py, pr + 5, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  // Center dot — grows a bit on hover/drag to mirror the ring's affordance.
  const dotR = centerActive ? 8 : 6;
  ctx.fillStyle = centerActive ? '#7be0e0' : '#22a3a3';
  ctx.beginPath();
  ctx.arc(px, py, dotR, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Axis crosshair to make the placement obvious.
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(px - 12, py); ctx.lineTo(px - 8,  py);
  ctx.moveTo(px + 8,  py); ctx.lineTo(px + 12, py);
  ctx.moveTo(px, py - 12); ctx.lineTo(px, py - 8);
  ctx.moveTo(px, py + 8);  ctx.lineTo(px, py + 12);
  ctx.stroke();
}

// Returns 'center' | 'radius' | null for a panel-pixel coordinate.
function _cylHandleAt(px, py) {
  if (!_cylPanelTransform) return null;
  const t = _cylPanelTransform;
  const { cx, cy } = getEffectiveCylinderCenter();
  const r = getEffectiveCylinderRadius();
  const cpx = (cx - t.cxw) * t.scale + cylinderCanvas.width / 2;
  const cpy = cylinderCanvas.height / 2 - (cy - t.cyw) * t.scale;
  const dx = px - cpx, dy = py - cpy;
  const distFromCenter = Math.sqrt(dx * dx + dy * dy);
  const ringPx = r * t.scale;
  if (distFromCenter <= _CYL_CENTER_HIT_PX) return 'center';
  if (Math.abs(distFromCenter - ringPx) <= _CYL_RING_HIT_PX) return 'radius';
  return null;
}

function _scheduleCylinderPanelRedraw() {
  if (_cylRedrawScheduled) return;
  _cylRedrawScheduled = true;
  requestAnimationFrame(() => {
    _cylRedrawScheduled = false;
    _redrawCylinderPanel();
  });
}

function _cylinderPanelToWorld(e) {
  if (!_cylPanelTransform) return null;
  const rect = cylinderCanvas.getBoundingClientRect();
  const px = ((e.clientX - rect.left) / rect.width)  * cylinderCanvas.width;
  const py = ((e.clientY - rect.top)  / rect.height) * cylinderCanvas.height;
  const t = _cylPanelTransform;
  const wx = (px - cylinderCanvas.width  / 2) / t.scale + t.cxw;
  const wy = (cylinderCanvas.height / 2 - py) / t.scale + t.cyw;
  return { px, py, wx, wy };
}

function _cylinderUpdateCursor() {
  if (!cylinderCanvas) return;
  const mode = _cylDragMode || _cylHoverMode;
  if (mode === 'center')      cylinderCanvas.style.cursor = 'move';
  else if (mode === 'radius') cylinderCanvas.style.cursor = 'ew-resize';
  else if (_cylDragMode === 'pan') cylinderCanvas.style.cursor = 'grabbing';
  else                        cylinderCanvas.style.cursor = 'grab';
}

function _cylinderPointerDown(e) {
  if (!currentBounds) return;
  const m = _cylinderPanelToWorld(e);
  if (!m) return;
  // Right-click and middle-click always pan (matching 3D-app conventions),
  // even if they happen on a handle. Left-click prefers handle pick — center
  // has higher priority than the ring when the ring is small enough that
  // they overlap; the user can always grow the ring to pick it specifically.
  const isPanButton = e.button === 1 || e.button === 2;
  const handle = isPanButton ? null : _cylHandleAt(m.px, m.py);
  if (handle) {
    _cylDragMode = handle;
  } else {
    // Empty area (or pan-button) — pan the view so the user can place the
    // cylinder axis outside the silhouette's default window (e.g. for a small
    // fragment of a much larger cylinder).
    _cylDragMode = 'pan';
    _cylPanLastPx = m.px;
    _cylPanLastPy = m.py;
  }
  _cylinderUpdateCursor();
  _scheduleCylinderPanelRedraw();
  try { cylinderCanvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  e.preventDefault();
}

function _cylinderPointerMove(e) {
  const m = _cylinderPanelToWorld(e);
  if (!m) return;

  if (_cylDragMode) {
    if (_cylDragMode === 'center') {
      settings.cylinderCenterX = m.wx;
      settings.cylinderCenterY = m.wy;
      _scheduleCylinderPanelRedraw();
      _scheduleCylinderPreviewUpdate();
    } else if (_cylDragMode === 'radius') {
      const { cx, cy } = getEffectiveCylinderCenter();
      const dx = m.wx - cx, dy = m.wy - cy;
      settings.cylinderRadius = Math.max(0.1, Math.sqrt(dx * dx + dy * dy));
      _scheduleCylinderPanelRedraw();
      _scheduleCylinderPreviewUpdate();
    } else if (_cylDragMode === 'pan' && _cylPanelTransform) {
      // Pan in panel pixels → translate the view's world center by the inverse
      // of the pixel delta (drag right = view moves right = cxw decreases).
      const dPx = m.px - _cylPanLastPx;
      const dPy = m.py - _cylPanLastPy;
      _cylPanelTransform.cxw -= dPx / _cylPanelTransform.scale;
      _cylPanelTransform.cyw += dPy / _cylPanelTransform.scale; // y is flipped
      _cylPanLastPx = m.px;
      _cylPanLastPy = m.py;
      _scheduleCylinderPanelRedraw();
      // Pan doesn't change projection state — no preview update needed.
    }
    return;
  }

  // Not dragging — update hover state for cursor + visual affordance.
  const handle = _cylHandleAt(m.px, m.py);
  if (handle !== _cylHoverMode) {
    _cylHoverMode = handle;
    _cylinderUpdateCursor();
    _scheduleCylinderPanelRedraw();
  }
}

function _scheduleCylinderPreviewUpdate() {
  if (_cylPreviewThrottle) return;
  _cylPreviewThrottle = setTimeout(() => {
    _cylPreviewThrottle = null;
    // Texture size is absolute mm, so a radius change alters the tile count
    // around the circumference — re-snap to keep the wrap seamless.
    if (settings.snapSeamlessWrap && settings.mappingMode === 3 /* MODE_CYLINDRICAL */) {
      _applyScaleU(settings.scaleU);
    }
    updatePreview();
    // updatePreview() mutates uniforms in place; the 3D viewport's render
    // loop only re-draws when _needsRender flips, so push it explicitly.
    requestRender();
  }, 30);
}

// Mouse wheel inside the cylinder ring adjusts the radius. Multiplicative
// scaling gives a smooth log feel — each wheel notch (~100 deltaY) changes
// the radius by ~5%.
function _cylinderWheel(e) {
  if (!currentBounds || !_cylPanelTransform) return;
  const m = _cylinderPanelToWorld(e);
  if (!m) return;
  // Only intercept wheel events that are actually on the cylinder gizmo, so
  // wheel scrolling outside the ring still bubbles to whatever the user
  // expects (page scroll, etc.).
  const t = _cylPanelTransform;
  const { cx, cy } = getEffectiveCylinderCenter();
  const cpx = (cx - t.cxw) * t.scale + cylinderCanvas.width / 2;
  const cpy = cylinderCanvas.height / 2 - (cy - t.cyw) * t.scale;
  const dx = m.px - cpx, dy = m.py - cpy;
  const distFromCenter = Math.sqrt(dx * dx + dy * dy);
  const ringPx = getEffectiveCylinderRadius() * t.scale;
  // Active wheel zone = inside the ring + a small ring-grace band.
  if (distFromCenter > ringPx + _CYL_RING_HIT_PX) return;
  e.preventDefault();
  const factor = Math.pow(0.95, e.deltaY / 100);
  settings.cylinderRadius = Math.max(0.1, getEffectiveCylinderRadius() * factor);
  _scheduleCylinderPanelRedraw();
  _scheduleCylinderPreviewUpdate();
  // Wheel is a discrete gesture — persist the new value without waiting for
  // a drag-end equivalent.
  if (typeof _autoSaveSettings === 'function') _autoSaveSettings();
}

function _cylinderPointerLeave() {
  if (_cylHoverMode) {
    _cylHoverMode = null;
    _cylinderUpdateCursor();
    _scheduleCylinderPanelRedraw();
  }
}

function _cylinderPointerUp(e) {
  if (!_cylDragMode) return;
  const wasPan = _cylDragMode === 'pan';
  _cylDragMode = null;
  try { cylinderCanvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  _cylinderUpdateCursor();
  _scheduleCylinderPanelRedraw();
  if (wasPan) return; // pan doesn't change projection state
  if (_cylPreviewThrottle) { clearTimeout(_cylPreviewThrottle); _cylPreviewThrottle = null; }
  updatePreview();
  requestRender();
  // Persist the new center/radius — cylinderCanvas is outside #settings-panel,
  // so the panel's input/change listener won't autosave for us.
  if (typeof _autoSaveSettings === 'function') _autoSaveSettings();
}

cylinderCanvas.addEventListener('pointerdown',   _cylinderPointerDown);
cylinderCanvas.addEventListener('pointermove',   _cylinderPointerMove);
cylinderCanvas.addEventListener('pointerup',     _cylinderPointerUp);
cylinderCanvas.addEventListener('pointercancel', _cylinderPointerUp);
cylinderCanvas.addEventListener('pointerleave',  _cylinderPointerLeave);
cylinderCanvas.addEventListener('wheel', _cylinderWheel, { passive: false });
// Right-click is reserved for panning, so swallow the browser context menu
// before it interrupts the drag.
cylinderCanvas.addEventListener('contextmenu', (e) => e.preventDefault());

function updateCylinderUIVisibility() {
  const isCyl = settings.mappingMode === 3 /* MODE_CYLINDRICAL */;
  // The seamless-wrap snap applies to both wrap-around modes (cylindrical
  // and spherical); the rest of this panel is cylinder-only.
  cylinderSnapRow.style.display = _isSeamlessWrapMode() ? '' : 'none';
  cylinderAxisRow.style.display = isCyl ? '' : 'none';
  // Show the panel whenever the user is in cylindrical mode, even without a
  // model loaded — they get the empty placeholder until they load one, which
  // makes it clear that the gizmo will appear there.
  cylinderPanel.classList.toggle('hidden', !isCyl);
  if (isCyl) {
    if (currentGeometry) _buildCylinderSilhouette();
    _scheduleCylinderPanelRedraw();
  }
}

// Least-squares circle fit (Kasa method). Fits to vertices of triangles whose
// face normal is roughly perpendicular to the cylinder axis (|n.z| < 0.5), so
// inner bores are excluded and end-caps don't pull the fit. Returns true and
// updates settings.cylinderCenterX/Y/cylinderRadius on success.
function autoFitCylinderAxis() {
  if (!currentGeometry || !currentBounds) return false;
  const pos = currentGeometry.attributes.position.array;
  const idx = currentGeometry.index ? currentGeometry.index.array : null;
  const fn  = triangleFaceNormals;
  const triCount = idx ? (idx.length / 3) : (pos.length / 9);

  let n = 0;
  let Sx = 0, Sy = 0, Sxx = 0, Syy = 0, Sxy = 0;
  let Sxz = 0, Syz = 0, Sz = 0;
  for (let t = 0; t < triCount; t++) {
    const nz = fn ? fn[t * 3 + 2] : 0;
    if (Math.abs(nz) >= 0.5) continue; // skip cap-like triangles
    for (let v = 0; v < 3; v++) {
      const i = idx ? idx[t * 3 + v] : (t * 3 + v);
      const x = pos[i * 3];
      const y = pos[i * 3 + 1];
      const z = x * x + y * y;
      Sx += x; Sy += y; Sxx += x * x; Syy += y * y; Sxy += x * y;
      Sxz += x * z; Syz += y * z; Sz += z;
      n++;
    }
  }
  if (n < 10) return false;

  // Solve the 3x3 normal equations for [A, B, C] where (cx, cy) = (A/2, B/2)
  // and r = sqrt(C + cx^2 + cy^2).
  const M = [
    [Sxx, Sxy, Sx],
    [Sxy, Syy, Sy],
    [Sx,  Sy,  n ],
  ];
  const b = [Sxz, Syz, Sz];
  const det = (m) =>
      m[0][0]*(m[1][1]*m[2][2] - m[1][2]*m[2][1])
    - m[0][1]*(m[1][0]*m[2][2] - m[1][2]*m[2][0])
    + m[0][2]*(m[1][0]*m[2][1] - m[1][1]*m[2][0]);
  const D = det(M);
  if (Math.abs(D) < 1e-12) return false;
  const colReplace = (col) => M.map((row, i) => row.map((v, j) => j === col ? b[i] : v));
  const A = det(colReplace(0)) / D;
  const B = det(colReplace(1)) / D;
  const C = det(colReplace(2)) / D;
  const cx = A / 2, cy = B / 2;
  const r2 = C + cx * cx + cy * cy;
  if (!Number.isFinite(r2) || r2 <= 0) return false;
  const r = Math.sqrt(r2);
  // Reject obviously bogus fits (e.g. degenerate symmetric input where the
  // fit collapses to a huge or tiny radius).
  const maxReasonable = Math.max(currentBounds.size.x, currentBounds.size.y) * 5;
  if (r > maxReasonable || r < 1e-3) return false;

  settings.cylinderCenterX = cx;
  settings.cylinderCenterY = cy;
  settings.cylinderRadius  = r;
  return true;
}

// ── Init ──────────────────────────────────────────────────────────────────────

let PRESETS = [];

document.getElementById('app-version').textContent = `v${APP_VERSION}`;
console.info(`BumpMesh v${APP_VERSION}`);

initViewer(canvas);

// A CPU-rendered viewer runs at a few fps and just looks broken — say why (#75).
if (isSoftwareRendering()) {
  const gpuWarning = document.getElementById('gpu-warning');
  gpuWarning.classList.remove('hidden');
  document.getElementById('gpu-warning-dismiss').addEventListener('click', () => {
    gpuWarning.classList.add('hidden');
  });
}

// Apply saved theme to 3D viewport on startup
setViewerTheme(document.documentElement.getAttribute('data-theme') === 'light');

// Populate the language selector
function populateLanguageSelector() {
  if (!languageSelector) return;
  languageSelector.innerHTML = '';

  const select = document.createElement('select');
  select.className = 'lang-dropdown';
  select.id = 'lang-select';
  select.name = 'lang-select';
  select.setAttribute('aria-label', 'Select language');

  for (const langKey in TRANSLATIONS) {
    const opt = document.createElement('option');
    opt.value = langKey;
    opt.className = 'lang-option';
    opt.textContent = TRANSLATIONS[langKey]['lang.name'] || langKey.toUpperCase();
    select.appendChild(opt);
  }

  select.addEventListener('change', async (e) => {
    const ok = await setLang(e.target.value);
    if (!ok) {
      // Revert the dropdown to the language that is actually active
      select.value = getLang();
      alert('Could not load the selected language. Please check your connection and try again.');
      return;
    }

    // Re-translate <option> elements (innerHTML won't reach these)
    document.querySelectorAll('#mapping-mode option[data-i18n-opt]').forEach(opt => {
      opt.textContent = t(opt.dataset.i18nOpt);
    });

    // Refresh dynamic count text to current language
    if (currentGeometry) {
      const triCount = getTriangleCount(currentGeometry);
      const mb = ((currentGeometry.attributes.position.array.byteLength) / 1024 / 1024).toFixed(2);
      const sx = currentBounds.size.x.toFixed(2);
      const sy = currentBounds.size.y.toFixed(2);
      const sz = currentBounds.size.z.toFixed(2);
      _setMeshInfo(triCount, mb, sx, sy, sz);
      refreshExclusionOverlay();
      if (lastFastDiag) renderFastDiag(lastFastDiag);
      if (lastAdvancedDiag) renderAdvancedDiag(lastAdvancedDiag);
    }
    // The cylinder panel paints its placeholder text via Canvas2D, which
    // applyTranslations() doesn't reach — re-render so the new locale lands.
    _scheduleCylinderPanelRedraw();
    gallery.refreshText();
  });

  languageSelector.appendChild(select);
}
populateLanguageSelector();

// Initialise language (reads localStorage / browser preference, applies translations)
{
  const { enFailed } = await initLang();
  if (enFailed) {
    // English base strings failed — the UI will show raw keys. Surface a plain
    // English message since t() won't work reliably at this point.
    console.error('[i18n] English language file failed to load — UI text will be missing');
    const banner = document.createElement('div');
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#c0392b;color:#fff;padding:10px 16px;font-family:sans-serif;font-size:14px;text-align:center';
    banner.textContent = 'Warning: language files could not be loaded. The interface may show missing text. Check your network connection and reload the page.';
    document.body.prepend(banner);
  }
}

// Sync lang dropdown to current language
(function() {
  const lang = getLang();
  const select = languageSelector.querySelector('select');
  if (select) {
    select.value = lang;
  }
})();

// Theme toggle
document.getElementById('theme-toggle').addEventListener('click', () => {
  const isLight = document.documentElement.getAttribute('data-theme') !== 'light';
  document.documentElement.setAttribute('data-theme', isLight ? 'light' : 'dark');
  localStorage.setItem('stlt-theme', isLight ? 'light' : 'dark');
  setViewerTheme(isLight);
});

// Favourites grid + texture gallery. Every preset is selectable right away (the full texture
// loads on demand), so PRESETS is filled synchronously instead of waiting for thumbnails.
const DEFAULT_PRESET_NAME = 'Crystal';
let _activePresetIdx = -1;   // preset picked most recently (set before its texture finishes loading)
PRESETS = IMAGE_PRESETS.map(p => ({ name: p.name, defaultScale: p.defaultScale }));
// Picks can come from the keyboard (gallery arrow keys), which the pointerup undo hook never sees.
// Capture once the texture has loaded: the snapshot's activeMapName follows activeMapEntry.
const gallery = initTextureGallery({
  onSelect: (idx) => selectPreset(idx).then(_scheduleUndoCapture),
  onSelectCustom: (id) => selectCustomTexture(id).then(_scheduleUndoCapture),
  setTurntable,
});
initSidebarToggle();

// The page itself never scrolls, but a mobile browser may still shift it to lift a focused input above
// the on-screen keyboard, and overflow:hidden leaves the user no way back. Undo any such shift once the
// keyboard closes, i.e. when the visual viewport grows again.
if (window.visualViewport) {
  let vvHeight = visualViewport.height;
  visualViewport.addEventListener('resize', () => {
    if (visualViewport.height > vvHeight) {
      document.scrollingElement?.scrollTo(0, 0);
      document.body.scrollTop = 0;
    }
    vvHeight = visualViewport.height;
  });
}

wireEvents();
showWelcomeIfNeeded();
// Sync scale number inputs with the slider's initial position
scaleUVal.value = fmtScaleVal(posToScale(parseFloat(scaleUSlider.value)));
scaleVVal.value = fmtScaleVal(posToScale(parseFloat(scaleVSlider.value)));

// Load geometry immediately — don't wait for textures
loadDefaultCube();

// Restore the map from the last session: a texture from the user's library if the browser still has
// it, else the preset, else the default. If the user had ANY map active last session (preset or a
// since-discarded custom upload), suppress preset defaults so the restored settings survive — we'd
// otherwise clobber textureSmoothing / scaleU when falling back.
// Deferred until the module has finished evaluating: selectPreset() touches top-level bindings
// declared further down (e.g. _selectGeneration), which would still be in their TDZ here.
queueMicrotask(async () => {
  let persisted = null;
  try { persisted = JSON.parse(sessionStorage.getItem('bumpmesh-settings')); } catch { /* ignore */ }
  const persistedName = persisted?.activeMapName || null;

  if (persisted?.activeCustomId && await selectCustomTexture(persisted.activeCustomId, false)) return;
  if (activeMapEntry || _activePresetIdx >= 0) return;   // the user picked a map while the library loaded

  const applyDefaults = !persistedName;
  let targetIdx = persistedName ? IMAGE_PRESETS.findIndex(p => p.name === persistedName) : -1;
  if (targetIdx < 0) targetIdx = IMAGE_PRESETS.findIndex(p => p.name === DEFAULT_PRESET_NAME);
  if (targetIdx >= 0) selectPreset(targetIdx, applyDefaults);
});

// ── Preset grid ───────────────────────────────────────────────────────────────

function resetTextureSmoothing() {
  settings.textureSmoothing = 0;
  textureSmoothingSlider.value = 0;
  textureSmoothingVal.value    = 0;
}

let _selectGeneration = 0;   // debounce rapid preset clicks

/** Un-highlight every preset (a custom map became the active map). */
function _clearPresetActive() {
  _activePresetIdx = -1;
  gallery.markActive(-1);
}

async function selectPreset(idx, applyDefaults = true) {
  const gen = ++_selectGeneration;
  _activePresetIdx = idx;
  customMapSwatch?.classList.remove('active');
  gallery.markActive(idx);

  const entry = PRESETS[idx];
  if (!entry) return;
  if (applyDefaults) {
    resetTextureSmoothing();
    // defaultScale is a legacy fraction of the model's largest bbox edge —
    // convert to the absolute mm tile size that looks the same on this model.
    if (entry.defaultScale != null) _applyScaleU(_defaultTileMm(entry.defaultScale));
  }

  // If full texture is already loaded, use it directly
  if (entry.texture) {
    activeMapEntry = entry;
    updatePreview();
    _autoSaveSettings();   // persist activeMapName now that it points at this preset
    return;
  }

  // Load full-resolution texture on demand
  gallery.setLoading(idx, true);
  try {
    const full = await loadFullPreset(idx);
    PRESETS[idx] = { ...entry, ...full };
    if (gen !== _selectGeneration) return;   // user clicked another preset meanwhile
    activeMapEntry = PRESETS[idx];
    updatePreview();
    // The scale change above auto-saved before the texture loaded, i.e. with the previous map's
    // name — save again so a reload restores this preset.
    _autoSaveSettings();
  } catch (err) {
    console.error('Failed to load full texture:', err);
  } finally {
    gallery.setLoading(idx, false);
  }
}

/**
 * Make one of the user's stored textures (js/customTextures.js) the active map. Resolves false if
 * the browser no longer has it (it may evict the library at any time) or it failed to decode. Only
 * a user pick (applyDefaults) says so out loud; session and undo restores fall back quietly.
 */
async function selectCustomTexture(id, applyDefaults = true) {
  const gen = ++_selectGeneration;
  let entry = _lastCustomMap?.customId === id ? _lastCustomMap : null;
  if (!entry) {
    let file = null;
    gallery.setCustomLoading(id, true);
    try {
      file = await getCustomTextureFile(id);
      if (file) {
        entry = await loadCustomTexture(file);
        entry.isCustom = true;
        entry.customId = id;
      }
    } catch (err) {
      console.error('Failed to load stored texture:', err);
    } finally {
      gallery.setCustomLoading(id, false);
    }
    if (!entry) {
      if (applyDefaults && gen === _selectGeneration) {
        alert(file ? t('alerts.textureLoadFailed', { name: file.name }) : t('alerts.customTextureMissing'));
      }
      gallery.refreshCustoms();   // drop the tile if its file is gone
      return false;
    }
  }
  if (gen !== _selectGeneration) {   // user clicked another map meanwhile
    if (entry !== _lastCustomMap) entry.texture.dispose();
    return false;
  }
  _useCustomMap(entry, applyDefaults);
  return true;
}

/** Make a decoded custom map the active map (fresh upload, library pick or project import). */
function _useCustomMap(entry, resetSmoothing) {
  _selectGeneration++;   // a preset or library load still in flight must not replace it
  // Only the latest custom map is kept; free the GPU copy of the one it replaces.
  if (_lastCustomMap && _lastCustomMap !== entry) _lastCustomMap.texture.dispose();
  activeMapEntry = entry;
  _lastCustomMap = entry;
  _clearPresetActive();
  gallery.markActiveCustom(entry.customId);
  _showCustomMapThumb(entry);
  customMapSwatch.classList.add('active');
  if (resetSmoothing) resetTextureSmoothing();
  updatePreview();
  _autoSaveSettings();
}

// ── Custom-map thumbnail (below the upload button) ───────────────────────────

/** Paint a small preview canvas of the custom map and reveal the thumbnail row. */
function _showCustomMapThumb(entry) {
  if (!entry || !entry.fullCanvas || !customMapSwatch) return;
  customMapSwatch.innerHTML = '';
  const THUMB_SIZE = 80;
  const thumb = document.createElement('canvas');
  thumb.width = THUMB_SIZE; thumb.height = THUMB_SIZE;
  const ctx = thumb.getContext('2d');
  // Aspect-fit the source canvas inside the square thumbnail.
  const sw = entry.fullCanvas.width, sh = entry.fullCanvas.height;
  const scale = Math.min(THUMB_SIZE / sw, THUMB_SIZE / sh);
  const dw = sw * scale, dh = sh * scale;
  ctx.drawImage(entry.fullCanvas, (THUMB_SIZE - dw) / 2, (THUMB_SIZE - dh) / 2, dw, dh);
  customMapSwatch.appendChild(thumb);

  const label = document.createElement('span');
  label.className = 'preset-label';
  label.textContent = entry.name;
  customMapSwatch.appendChild(label);

  customMapSwatch.title = entry.name;
  customMapRow.classList.remove('hidden');
}

function _hideCustomMapThumb() {
  if (!customMapRow) return;
  customMapRow.classList.add('hidden');
  if (customMapSwatch) customMapSwatch.innerHTML = '';
}

/** Promote the kept-aside custom map back to the active map. No defaults reset. */
function _activateCustomMap() {
  if (_lastCustomMap) _useCustomMap(_lastCustomMap, false);
}

if (customMapSwatch) {
  customMapSwatch.addEventListener('click', _activateCustomMap);
  customMapSwatch.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _activateCustomMap(); }
  });
}

if (customMapRemoveBtn) {
  customMapRemoveBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasActive = activeMapEntry === _lastCustomMap;
    _lastCustomMap = null;
    _hideCustomMapThumb();
    if (wasActive) {
      // Fall back to the default preset so the viewer keeps a usable texture.
      const idx = IMAGE_PRESETS.findIndex(p => p.name === DEFAULT_PRESET_NAME);
      if (idx >= 0) {
        selectPreset(idx, /*applyDefaults=*/false);
      } else {
        activeMapEntry = null;
        updatePreview();
      }
    }
  });
}

// ── Welcome popup: open / dismiss ─────────────────────────────────────────────
function openWelcome({ allowDismissPersist }) {
  welcomeDontShow.checked = false;
  welcomeOverlay.classList.remove('hidden');
  trapFocus(welcomeOverlay);

  const close = () => {
    if (allowDismissPersist && welcomeDontShow.checked) {
      try { localStorage.setItem(WELCOME_STORAGE_KEY, WELCOME_LAST_UPDATED); } catch { /* quota / private mode */ }
    }
    welcomeOverlay.classList.add('hidden');
  };
  welcomeClose.onclick   = close;
  welcomeGotIt.onclick   = close;
  welcomeOverlay.onclick = (e) => { if (e.target === welcomeOverlay) close(); };
}

function showWelcomeIfNeeded() {
  let seen = null;
  try { seen = localStorage.getItem(WELCOME_STORAGE_KEY); } catch { /* private mode */ }
  if (seen !== WELCOME_LAST_UPDATED) {
    openWelcome({ allowDismissPersist: true });
  }
}

// ── Accessibility: Modal focus trap ───────────────────────────────────────────
function trapFocus(overlay) {
  const focusable = overlay.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  );
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  first.focus();

  function handler(e) {
    if (e.key === 'Escape') {
      overlay.classList.add('hidden');
      overlay.removeEventListener('keydown', handler);
      return;
    }
    if (e.key !== 'Tab') return;
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  overlay.addEventListener('keydown', handler);
}

// Bottom faces = 0 textures the bed-contact face too, and the bottom snap
// would flatten that texture again — the export skips the snap then (#126).
// Mirror that in the UI: uncheck and grey out the checkbox, and restore it if
// the limit goes back above 0 before the user touches the checkbox
// (smoothBottomAutoOff, declared with the module state at the top).
function syncSmoothBottomToLimit() {
  const masked = settings.bottomAngleLimit > 0;
  if (!masked && smoothBottomChk.checked) {
    smoothBottomChk.checked = settings.smoothBottom = false;
    smoothBottomAutoOff = true;
  } else if (masked && smoothBottomAutoOff) {
    smoothBottomChk.checked = settings.smoothBottom = true;
    smoothBottomAutoOff = false;
  }
  smoothBottomChk.disabled = !masked;
  smoothBottomRow.classList.toggle('disabled', !masked);
}

// ── Event wiring ──────────────────────────────────────────────────────────────

function wireEvents() {
  // ── Model loading ──
  stlFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    // macOS pickers ignore the accept filter, so check the type here too (#124).
    if (/\.bumpmesh$/i.test(file.name)) { importProject(file).catch(err => alert(t('alerts.importFailed', { msg: err.message }))); return; }
    if (!MODEL_FILE_RE.test(file.name)) { alert(t('alerts.unsupportedModelType', { name: file.name })); return; }
    handleModelFile(file);
  });

  // Drag & drop on the viewport section
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const files = [...e.dataTransfer.files];
    const bmFile = files.find(f => /\.bumpmesh$/i.test(f.name));
    if (bmFile) { importProject(bmFile).catch(err => alert(t('alerts.importFailed', { msg: err.message }))); return; }
    const file = files.find(f => MODEL_FILE_RE.test(f.name));
    if (file) handleModelFile(file);
    else if (files.length) alert(t('alerts.unsupportedModelType', { name: files[0].name }));
  });

  // STEP import dialog: preset radios drive the tolerance fields; Import
  // kicks off (re-)tessellation, Cancel/backdrop/× just closes.
  for (const radio of document.querySelectorAll('input[name="step-preset"]')) {
    radio.addEventListener('change', () => _stepUpdateFields());
  }
  stepImportGo.addEventListener('click', () => {
    const file = _stepDialogFile;
    if (!file) { closeStepDialog(); return; }
    const preset = _stepSelectedPreset();
    const settings = preset === 'custom'
      ? { surfaceDeviation: +stepSurfaceDev.value, normalDeviation: +stepNormalDev.value, maxEdge: +stepMaxEdge.value }
      : { preset };
    closeStepDialog();
    handleModelFile(file, settings);
  });
  stepImportCancel.addEventListener('click', closeStepDialog);
  stepDialogClose.addEventListener('click', closeStepDialog);
  stepOverlay.addEventListener('click', (e) => {
    if (e.target === stepOverlay) closeStepDialog();
  });

  // Allow clicking the drop zone to open the file picker (except on canvas)
  dropZone.addEventListener('click', (e) => {
    if (e.target === dropZone) stlFileInput.click();
  });

  // ── Mesh diagnostics: advanced checks ──
  meshDiagRunBtn.addEventListener('click', async () => {
    if (!currentGeometry || !triangleAdjacency) return;
    const myToken = diagToken;
    meshDiagRunBtn.disabled = true;
    meshDiagSpinner.classList.remove('hidden');
    meshDiagAdvanced.classList.add('hidden');

    try {
      const token = { get() { return diagToken; } };
      const triCount = currentGeometry.attributes.position.count / 3;
      const shellIds = lastFastDiag?.triCount === triCount ? lastFastDiag.shellIds : null;
      const results = await runExpensiveDiagnostics(currentGeometry, token, shellIds);

      if (diagToken !== myToken) return; // model changed, discard

      if (!results) return; // aborted

      lastAdvancedDiag = results;
      renderAdvancedDiag(results);
      meshDiagAdvanced.classList.remove('hidden');
    } catch (err) {
      console.error('Advanced diagnostics failed:', err);
    } finally {
      if (diagToken === myToken) {
        meshDiagSpinner.classList.add('hidden');
        meshDiagRunBtn.disabled = false;
      }
    }
  });

  // ── Custom texture upload ──
  textureInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const entry = await loadCustomTexture(file);
      entry.isCustom = true;
      _useCustomMap(entry, true);
      // Keep the original in the gallery's "Your textures" (best effort — the map works either way).
      gallery.rememberUpload(file, entry.fullCanvas).then((id) => {
        if (!id) return;
        entry.customId = id;
        if (activeMapEntry === entry) {
          gallery.markActiveCustom(id);
          _autoSaveSettings();   // so a reload brings this map back
        }
      });
    } catch (err) {
      // macOS pickers ignore accept="image/*", and browsers can't decode
      // HEIC/TIFF — tell the user instead of silently keeping the old map (#124).
      console.error('Failed to load texture:', err);
      alert(t('alerts.textureLoadFailed', { name: file.name }));
    }
    // Reset the file input so re-uploading the same filename still triggers 'change'.
    textureInput.value = '';
  });

  // ── Settings ──
  mappingSelect.addEventListener('change', () => {
    settings.mappingMode = parseInt(mappingSelect.value, 10);
    capAngleRow.style.display = settings.mappingMode === 3 ? '' : 'none';
    updateCylinderUIVisibility();
    // The wrap circumference is mode-specific (cylinder vs sphere equator),
    // so entering a wrap mode with snapping on re-snaps the U scale.
    if (settings.snapSeamlessWrap && _isSeamlessWrapMode()) {
      _applyScaleU(settings.scaleU);
    }
    updatePreview();
  });

  cylinderSnapToggle.addEventListener('change', () => {
    settings.snapSeamlessWrap = cylinderSnapToggle.checked;
    if (settings.snapSeamlessWrap && _isSeamlessWrapMode()) {
      // Snap immediately so the user sees the seam fix without dragging first.
      _applyScaleU(settings.scaleU);
    }
  });

  cylinderAutofitBtn.addEventListener('click', () => {
    if (autoFitCylinderAxis()) {
      _scheduleCylinderPanelRedraw();
      updatePreview();
      requestRender();
      _autoSaveSettings();
    }
  });

  cylinderPanelMinimize.addEventListener('click', () => {
    settings.cylinderPanelMinimized = !settings.cylinderPanelMinimized;
    cylinderPanel.classList.toggle('minimized', settings.cylinderPanelMinimized);
    if (!settings.cylinderPanelMinimized) _scheduleCylinderPanelRedraw();
    _autoSaveSettings();
  });

  cylinderResetBtn.addEventListener('click', () => {
    settings.cylinderCenterX = null;
    settings.cylinderCenterY = null;
    settings.cylinderRadius  = null;
    // Also undo any panning so the silhouette returns to its default framing.
    if (_cylSilhouetteAnchor && _cylPanelTransform) {
      _cylPanelTransform.cxw = _cylSilhouetteAnchor.cxw;
      _cylPanelTransform.cyw = _cylSilhouetteAnchor.cyw;
    }
    _scheduleCylinderPanelRedraw();
    updatePreview();
    requestRender();
    _autoSaveSettings();
  });

  // Scale U — when lock is on, mirror to V
  const applyScaleU = (v) => _applyScaleU(v);
  scaleUSlider.addEventListener('input', () => applyScaleU(posToScale(parseFloat(scaleUSlider.value))));
  scaleUSlider.addEventListener('dblclick', () => applyScaleU(_defaultTileMm()));
  scaleUVal.addEventListener('change', () => applyScaleU(parseFloat(scaleUVal.value)));
  addFineWheelSupport(scaleUVal, applyScaleU);

  // Scale V — when lock is on, mirror to U
  const applyScaleV = (v) => {
    v = Math.max(SCALE_MM_INPUT_MIN, Math.min(SCALE_MM_INPUT_MAX, v));
    settings.scaleV = v;
    scaleVSlider.value = scaleToPos(v);
    scaleVVal.value = fmtScaleVal(v);
    if (settings.lockScale) { settings.scaleU = v; scaleUSlider.value = scaleToPos(v); scaleUVal.value = fmtScaleVal(v); }
    clearTimeout(previewDebounce); previewDebounce = setTimeout(updatePreview, 80);
  };
  scaleVSlider.addEventListener('input', () => applyScaleV(posToScale(parseFloat(scaleVSlider.value))));
  scaleVSlider.addEventListener('dblclick', () => applyScaleV(_defaultTileMm()));
  scaleVVal.addEventListener('change', () => applyScaleV(parseFloat(scaleVVal.value)));
  addFineWheelSupport(scaleVVal, applyScaleV);

  // Lock toggle
  lockScaleBtn.addEventListener('click', () => {
    settings.lockScale = !settings.lockScale;
    lockScaleBtn.classList.toggle('active', settings.lockScale);
    lockScaleBtn.setAttribute('aria-pressed', String(settings.lockScale));
    if (settings.lockScale) {
      settings.scaleV = settings.scaleU;
      scaleVSlider.value = scaleToPos(settings.scaleU);
      scaleVVal.value = fmtScaleVal(settings.scaleU);
      updatePreview();
    }
  });

  linkSlider(offsetUSlider,   offsetUVal,   v => { settings.offsetU   = v; return v.toFixed(2); });
  linkSlider(offsetVSlider,   offsetVVal,   v => { settings.offsetV   = v; return v.toFixed(2); });
  linkSlider(rotationSlider,  rotationVal,  v => { settings.rotation  = v; return Math.round(v); });
  linkSlider(amplitudeSlider, amplitudeVal, v => {
    settings.textureHeight = v;
    settings.amplitude = (settings.invertDisplacement ? -1 : 1) * v;
    checkAmplitudeWarning();
    return v.toFixed(2);
  });
  amplitudeVal.addEventListener('change', checkAmplitudeWarning);
  invertDisplacementCheckbox.addEventListener('change', () => {
    settings.invertDisplacement = invertDisplacementCheckbox.checked;
    settings.amplitude = (settings.invertDisplacement ? -1 : 1) * settings.textureHeight;
    updatePreview();
  });
  linkSlider(boundaryFalloffSlider, boundaryFalloffVal, v => { settings.boundaryFalloff = v; _falloffDirty = true; return v.toFixed(1); });
  for (const [mode, btn] of Object.entries(falloffCurveButtons)) {
    btn.addEventListener('click', () => setFalloffCurve(mode));
  }
  linkSlider(refineLenSlider, refineLenVal, v => {
    settings.refineLength = v;
    checkResolutionWarning();
    // Diagnostic from a previous Smart click no longer matches the new value.
    // (applySmartResolution sets values without dispatching `input`, so this
    // only fires when the user drags or types — exactly what we want.)
    if (smartResInfo) smartResInfo.classList.add('hidden');
    scheduleDisplacementPreviewResolutionRefresh();
    return v.toFixed(2);
  }, false);
  refineLenVal.addEventListener('change', checkResolutionWarning);
  linkSlider(maxTriSlider, maxTriVal, v => { settings.maxTriangles = v; return formatM(v); }, false);
  linkSlider(bottomAngleLimitSlider, bottomAngleLimitVal, v => {
    settings.bottomAngleLimit = v; _falloffDirty = true;
    syncSmoothBottomToLimit();
    return v;
  });
  smoothBottomChk.addEventListener('change', () => { smoothBottomAutoOff = false; });
  linkSlider(topAngleLimitSlider,    topAngleLimitVal,    v => { settings.topAngleLimit    = v; _falloffDirty = true; return v; });
  linkSlider(seamBlendSlider,        seamBlendVal,        v => { settings.mappingBlend     = v; return v.toFixed(2); });
  linkSlider(seamBandWidthSlider,    seamBandWidthVal,    v => { settings.seamBandWidth    = v; return v.toFixed(2); });
  linkSlider(textureSmoothingSlider, textureSmoothingVal, v => { settings.textureSmoothing = v; return v.toFixed(1); });
  invertTextureCheckbox.addEventListener('change', () => {
    settings.invertTexture = invertTextureCheckbox.checked;
    updatePreview();
  });
  linkSlider(capAngleSlider,          capAngleVal,          v => { settings.capAngle         = v; return Math.round(v); });
  symmetricDispToggle.addEventListener('change', () => {
    settings.symmetricDisplacement = symmetricDispToggle.checked;
    updatePreview();
  });
  noDownwardZChk.addEventListener('change', () => {
    settings.noDownwardZ = noDownwardZChk.checked;
    updatePreview();
  });
  smoothBottomChk.checked = settings.smoothBottom;
  smoothBottomChk.addEventListener('change', () => {
    settings.smoothBottom = smoothBottomChk.checked;
    // No preview rebuild needed — the snap is a final-export step only.
  });
  syncSmoothBottomToLimit();
  harvestFlatChk.checked = settings.harvestFlatFaces;
  harvestTolRow.classList.toggle('disabled', !settings.harvestFlatFaces);
  harvestFlatChk.addEventListener('change', () => {
    settings.harvestFlatFaces = harvestFlatChk.checked;
    harvestTolRow.classList.toggle('disabled', !settings.harvestFlatFaces);
    // No preview rebuild needed — harvesting only affects the final decimation.
  });
  harvestTolInput.value = settings.harvestTol;
  harvestTolInput.addEventListener('input', () => {
    const v = parseFloat(harvestTolInput.value);
    if (Number.isFinite(v) && v >= 0) settings.harvestTol = v;
    // No preview rebuild needed — harvesting only affects the final decimation.
  });
  preserveUntexturedChk.checked = settings.preserveUntextured;
  preserveUntexturedChk.addEventListener('change', () => {
    settings.preserveUntextured = preserveUntexturedChk.checked;
    // Export/bake-time flag only — no preview rebuild needed.
  });

  dispPreviewToggle.addEventListener('change', () => {
    toggleDisplacementPreview(dispPreviewToggle.checked);
  });

  // ── Place on Face ──
  placeOnFaceBtn.addEventListener('click', () => {
    togglePlaceOnFace(!placeOnFaceActive);
  });

  // ── Rotate ──
  rotateBtn.addEventListener('click', () => {
    toggleRotateMode(!rotateActive);
  });
  rotateApplyBtn.addEventListener('click', () => {
    applyRotationFromInputs();
    toggleRotateMode(false);
  });
  rotateResetBtn.addEventListener('click', () => {
    if (!currentGeometry || !_rotateOriginalPositions) return;

    // Restore original vertex positions and the matching pose transform
    currentGeometry.attributes.position.array.set(_rotateOriginalPositions);
    currentGeometry.attributes.position.needsUpdate = true;
    if (_rotatePoseSnapshot) {
      currentPoseRot.copy(_rotatePoseSnapshot.rot);
      currentPoseTrans.copy(_rotatePoseSnapshot.trans);
    }
    currentGeometry.computeVertexNormals();
    if (currentGeometry.attributes.faceNormal) {
      currentGeometry.deleteAttribute('faceNormal');
    }

    rotateAngles = { x: 0, y: 0, z: 0 };
    rotateXInput.value = '0';
    rotateYInput.value = '0';
    rotateZInput.value = '0';

    // Light update only — still in rotate mode
    setMeshGeometry(currentGeometry);
    requestRender();
  });
  // Allow Enter key in inputs to apply
  [rotateXInput, rotateYInput, rotateZInput].forEach(inp => {
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') applyRotationFromInputs();
    });
  });

  // ── License ──
  licenseLink.addEventListener('click', () => { licenseOverlay.classList.remove('hidden'); trapFocus(licenseOverlay); });
  licenseClose.addEventListener('click', () => licenseOverlay.classList.add('hidden'));
  licenseOverlay.addEventListener('click', (e) => {
    if (e.target === licenseOverlay) licenseOverlay.classList.add('hidden');
  });

  // ── Imprint & Privacy ──
  imprintLink.addEventListener('click', () => { imprintOverlay.classList.remove('hidden'); trapFocus(imprintOverlay); });
  imprintClose.addEventListener('click', () => imprintOverlay.classList.add('hidden'));
  imprintOverlay.addEventListener('click', (e) => {
    if (e.target === imprintOverlay) imprintOverlay.classList.add('hidden');
  });

  // ── Welcome / What's New ──
  welcomeLink.addEventListener('click', () => openWelcome({ allowDismissPersist: false }));

  // ── Mesh diagnostics dismiss ──
  meshDiagDismiss.addEventListener('click', () => {
    meshDiagnostics.classList.add('hidden');
    clearDiagHighlight();
  });

  // ── Support banner dismiss ──
  document.getElementById('store-cta-dismiss').addEventListener('click', () => {
    document.getElementById('store-cta-wrapper').classList.add('store-cta-hidden');
  });

  // ── Export ──
  const startExport = (format) => {
    // Start the export immediately — the pipeline runs in the worker, so the
    // sponsor overlay sits on top of a live progress bar instead of delaying
    // the work until it's dismissed.
    handleExport(format);

    if (sessionStorage.getItem('stlt-no-sponsor') === '1') return;
    const overlay = document.getElementById('sponsor-overlay');
    const closeBtn = document.getElementById('sponsor-close');
    // Button plus the inline text link (the button may be hidden or removed by adblockers)
    const storeLinks = overlay.querySelectorAll('a[href="https://geni.us/CNCStoreTexture"]');
    overlay.classList.remove('hidden');
    trapFocus(overlay);

    const dismiss = () => {
      if (document.getElementById('sponsor-dont-show').checked) {
        sessionStorage.setItem('stlt-no-sponsor', '1');
      }
      overlay.classList.add('hidden');
    };

    closeBtn.onclick = dismiss;
    storeLinks.forEach(a => { a.onclick = () => setTimeout(dismiss, 150); });
  };
  exportBtn.addEventListener('click', () => startExport('stl'));
  export3mfBtn.addEventListener('click', () => startExport('3mf'));

  // ── Advanced / Beta Features panel: collapse toggle + bake action ──
  advancedToggle.addEventListener('click', () => {
    advancedSection.classList.toggle('collapsed');
  });
  bakeBtn.addEventListener('click', bakeTextures);

  // ── Wireframe ──
  wireframeToggle.addEventListener('change', () => setWireframe(wireframeToggle.checked));

  // ── Projection toggle ──
  projectionToggle.addEventListener('change', () => setProjection(projectionToggle.checked));

  // ── Section view ──
  sectionToggle.addEventListener('change', () => {
    // The plane handles hide while a click tool is active; switching the cut on
    // hands the mouse to them so it can be placed first.
    if (sectionToggle.checked) {
      if (exclusionTool) setExclusionTool(null);
      if (placeOnFaceActive) togglePlaceOnFace(false);
    }
    setSectionView(sectionToggle.checked);
    sectionControls.classList.toggle('hidden', !sectionToggle.checked);
  });
  sectionControls.querySelectorAll('[data-section-axis]').forEach(btn => {
    btn.addEventListener('click', () => setSectionAxis(btn.dataset.sectionAxis));
  });
  document.getElementById('section-flip').addEventListener('click', flipSection);

  // ── Exclusion tool wiring ─────────────────────────────────────────────────

  exclBrushBtn.addEventListener('click', () => setExclusionTool('brush'));
  exclBucketBtn.addEventListener('click', () => setExclusionTool('bucket'));

  // Shift key toggles erase mode
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Shift' && exclusionTool) eraseMode = true;
  });
  document.addEventListener('keyup', (e) => {
    if (e.key === 'Shift') eraseMode = false;
  });

  exclBrushSingleBtn.addEventListener('click', () => {
    brushIsRadius = false;
    exclBrushSingleBtn.classList.add('active');
    exclBrushRadiusBtn.classList.remove('active');
    exclRadiusRow.classList.add('hidden');
    exclHardnessRow.classList.add('hidden');
    precisionMaskingRow.classList.add('hidden');
    if (precisionMaskingEnabled) deactivatePrecisionMasking();
    canvas.style.cursor = exclusionTool ? 'crosshair' : '';
    brushCursorEl.style.display = 'none';
  });

  exclBrushRadiusBtn.addEventListener('click', () => {
    brushIsRadius = true;
    exclBrushRadiusBtn.classList.add('active');
    exclBrushSingleBtn.classList.remove('active');
    if (exclusionTool === 'brush') exclRadiusRow.classList.remove('hidden');
    if (exclusionTool === 'brush') exclHardnessRow.classList.remove('hidden');
    if (exclusionTool === 'brush') precisionMaskingRow.classList.remove('hidden');
    if (exclusionTool === 'brush') canvas.style.cursor = 'none';
  });

  exclBrushRadiusSlider.addEventListener('input', () => {
    brushRadius = parseFloat(exclBrushRadiusSlider.value) / 2;
    exclBrushRadiusVal.value = parseFloat(exclBrushRadiusSlider.value);
    checkPrecisionOutdated();
  });
  exclBrushRadiusSlider.addEventListener('dblclick', () => {
    exclBrushRadiusSlider.value = exclBrushRadiusSlider.defaultValue;
    brushRadius = parseFloat(exclBrushRadiusSlider.value) / 2;
    exclBrushRadiusVal.value = parseFloat(exclBrushRadiusSlider.value);
    checkPrecisionOutdated();
  });
  exclBrushRadiusVal.addEventListener('change', () => {
    let diam = Math.max(0.2, Math.min(100, parseFloat(exclBrushRadiusVal.value) || 10));
    brushRadius = diam / 2;
    exclBrushRadiusSlider.value = diam;
    exclBrushRadiusVal.value = diam;
    checkPrecisionOutdated();
  });
  addFineWheelSupport(exclBrushRadiusVal, (v) => {
    const diam = Math.max(0.2, Math.min(100, v));
    brushRadius = diam / 2;
    exclBrushRadiusSlider.value = diam;
    exclBrushRadiusVal.value = diam;
    checkPrecisionOutdated();
  });

  // Hardness (percent in the UI, 0–1 internally)
  const setHardness = (pct) => {
    pct = Math.max(0, Math.min(100, Math.round(pct)));
    brushHardness = pct / 100;
    exclBrushHardnessSlider.value = pct;
    exclBrushHardnessVal.value = pct;
    updateBrushCursorHardness();
    checkPrecisionOutdated();
  };
  // Soft paint lives on mesh vertices, and typical CAD meshes have triangles
  // far larger than the fade — so going from a hard to a soft brush turns on
  // Precision. Only on that transition, once the value is committed (slider
  // release), so it never fights a user who switched Precision off again.
  let committedHardness = brushHardness;
  const commitHardness = () => {
    const wasHard = committedHardness >= 1;
    committedHardness = brushHardness;
    if (wasHard && brushHardness < 1 && exclusionTool === 'brush' && brushIsRadius &&
        currentGeometry && !precisionMaskingEnabled && !precisionBusy) {
      precisionMaskingToggle.checked = true;
      togglePrecisionMasking(true);
    }
  };
  exclBrushHardnessSlider.addEventListener('input', () => setHardness(parseFloat(exclBrushHardnessSlider.value)));
  exclBrushHardnessSlider.addEventListener('change', commitHardness);
  exclBrushHardnessSlider.addEventListener('dblclick', () => { setHardness(parseFloat(exclBrushHardnessSlider.defaultValue)); commitHardness(); });
  exclBrushHardnessVal.addEventListener('change', () => {
    const v = parseFloat(exclBrushHardnessVal.value);
    setHardness(Number.isFinite(v) ? v : 100);
    commitHardness();
  });
  addFineWheelSupport(exclBrushHardnessVal, (v) => { setHardness(v); commitHardness(); });

  exclThresholdSlider.addEventListener('input', () => {
    bucketThreshold = parseFloat(exclThresholdSlider.value);
    exclThresholdVal.value = bucketThreshold;
    _lastHoverTriIdx = -1; // invalidate hover so next mousemove re-computes
  });
  exclThresholdSlider.addEventListener('dblclick', () => {
    exclThresholdSlider.value = exclThresholdSlider.defaultValue;
    bucketThreshold = parseFloat(exclThresholdSlider.value);
    exclThresholdVal.value = bucketThreshold;
    _lastHoverTriIdx = -1;
  });
  exclThresholdVal.addEventListener('change', () => {
    bucketThreshold = Math.max(0, Math.min(180, parseFloat(exclThresholdVal.value) || 20));
    exclThresholdSlider.value = bucketThreshold;
    exclThresholdVal.value = bucketThreshold;
    _lastHoverTriIdx = -1;
  });
  addFineWheelSupport(exclThresholdVal, (v) => {
    bucketThreshold = Math.max(0, Math.min(180, v));
    exclThresholdSlider.value = bucketThreshold;
    exclThresholdVal.value = bucketThreshold;
    _lastHoverTriIdx = -1;
  });

  exclClearBtn.addEventListener('click', () => {
    excludedFaces = new Set();
    precisionExcludedFaces = new Set();
    _clearSoftPaint();
    refreshExclusionOverlay();
  });

  // Clicking a mask-mode button pre-selects the fill tool so painting can
  // start without an extra click (an already-active brush is kept). Only the
  // buttons do this — programmatic setSelectionMode() calls (project load,
  // session restore) must not activate a paint tool.
  exclModeExcludeBtn.addEventListener('click', () => {
    maskModeChosen = true;
    setSelectionMode(false);   // early-returns if already exclude…
    updateMaskModeButtons();   // …so refresh the highlight explicitly
    if (!exclusionTool) setExclusionTool('bucket');
  });
  exclModeIncludeBtn.addEventListener('click', () => {
    maskModeChosen = true;
    setSelectionMode(true);
    updateMaskModeButtons();
    if (!exclusionTool) setExclusionTool('bucket');
  });

  // ── Precision masking wiring ──────────────────────────────────────────────
  precisionMaskingToggle.addEventListener('change', () => {
    togglePrecisionMasking(precisionMaskingToggle.checked);
  });
  precisionRefreshBtn.addEventListener('click', () => {
    refreshPrecisionMesh();
  });

  // ── Canvas mouse events for exclusion painting ────────────────────────────
  canvas.addEventListener('mousedown', (e) => {
    if (!currentGeometry || e.button !== 0) return;

    // Rotation gizmo takes priority
    if (isGizmoDragging()) return;

    // Place on Face mode
    if (placeOnFaceActive) {
      e.preventDefault();
      handlePlaceOnFaceClick(e);
      return;
    }

    if (!exclusionTool) return;

    // Block painting while precision mesh is being built
    if (precisionBusy) return;

    if (exclusionTool === 'bucket') {
      e.preventDefault();
      _lastHoverTriIdx = -1;
      setHoverPreview(null);
      updateMaskingTriDebug(e);
      const triIdx = pickTriangle(e);
      if (triIdx >= 0) {
        const filled = bucketFill(triIdx, triangleAdjacency, bucketThreshold);
        // Bucket fill always uses original face indices
        for (const t of filled) {
          if (eraseMode) { excludedFaces.delete(t); _clearSoftFace(softPaint, t); }
          else excludedFaces.add(t);
        }
        // If precision is active, also sync to precisionExcludedFaces
        if (precisionMaskingEnabled && precisionParentMap) {
          precisionPainted = true;
          const len = precisionParentMap.length;
          for (let i = 0; i < len; i++) {
            if (filled.has(precisionParentMap[i])) {
              if (eraseMode) { precisionExcludedFaces.delete(i); _clearSoftFace(precisionSoftPaint, i); }
              else precisionExcludedFaces.add(i);
            }
          }
        }
        refreshExclusionOverlay();
        _lastHoverTriIdx = -1;
        setHoverPreview(null);
      }
    } else {
      // Brush mode: only start painting if we actually hit the mesh
      const triIdx = pickTriangle(e);
      if (triIdx < 0) return;          // miss → let OrbitControls handle the drag
      e.preventDefault();
      updateMaskingTriDebug(e);
      getControls().enabled = false;
      isPainting = true;
      _strokeLastPoint = null;
      _lastHoverTriIdx = -1;
      setHoverPreview(null);
      paintAt(e);
    }
  });

  // RAF-Batching: paint events fire immediately, hover/cursor batched per frame
  let _pendingHoverEvent = null;
  let _hoverRafId = 0;

  canvas.addEventListener('mousemove', (e) => {
    // Paint-Events sofort verarbeiten (jeder Event zaehlt fuer lueckenloses Malen)
    if (isPainting && exclusionTool === 'brush') {
      paintAt(e);
      // Cursor-Update kann warten
      _pendingHoverEvent = e;
      if (!_hoverRafId) {
        _hoverRafId = requestAnimationFrame(() => {
          _hoverRafId = 0;
          if (_pendingHoverEvent) updateBrushCursor(_pendingHoverEvent);
          _pendingHoverEvent = null;
        });
      }
      return;
    }
    // Alle anderen Hover-Pfade: RAF-Batching OK
    _pendingHoverEvent = e;
    if (!_hoverRafId) {
      _hoverRafId = requestAnimationFrame(() => {
        _hoverRafId = 0;
        const ev = _pendingHoverEvent;
        if (!ev) return;
        _pendingHoverEvent = null;
        if (placeOnFaceActive && currentGeometry) { updatePlaceOnFaceHover(ev); return; }
        if (exclusionTool === 'brush') {
          updateBrushCursor(ev);
          if (!isPainting && currentGeometry) updateBrushHover(ev);
          _updateShiftLinePreview(ev);
        } else if (exclusionTool === 'bucket' && !isPainting && currentGeometry) {
          updateBucketHover(ev);
        }
      });
    }
  });

  canvas.addEventListener('mouseleave', () => {
    _lastHoverTriIdx = -1;
    setHoverPreview(null);
    brushCursorEl.style.display = 'none';
  });

  document.addEventListener('mouseup', () => {
    if (!isPainting) return;
    isPainting = false;
    _strokeLastPoint = null;
    getControls().enabled = true;
    // Capture the completed stroke synchronously so quick consecutive strokes
    // each get their own undo entry — the debounced window-pointerup capture
    // would otherwise collapse strokes that finish within UNDO_DEBOUNCE_MS.
    _flushUndoCapture();
    _commitUndoCapture();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (rotateActive) toggleRotateMode(false);
      if (placeOnFaceActive) togglePlaceOnFace(false);
      if (exclusionTool) setExclusionTool(null);
      licenseOverlay.classList.add('hidden');
      imprintOverlay.classList.add('hidden');
      closeStepDialog();
      _clearShiftLinePreview();
    }
  });

  document.addEventListener('keyup', (e) => {
    if (e.key === 'Control') _clearShiftLinePreview();
  });
}

// ── Exclusion helpers ─────────────────────────────────────────────────────────

function setSelectionMode(include) {
  if (selectionMode === include) return;
  selectionMode = include;
  // Include-only is never the implicit default, so entering it always counts
  // as engaging the masking UI. Exclude can be entered programmatically as a
  // reset-to-default; those call sites manage maskModeChosen themselves.
  if (include) maskModeChosen = true;
  updateMaskModeButtons();
  if (exclusionTool) setExclusionTool(null);
  exclSectionHeading.textContent = selectionMode ? t('sections.surfaceSelection') : t('sections.surfaceMasking');
  exclHint.textContent = selectionMode
    ? t('excl.hintInclude')
    : t('excl.hintExclude');
  // Clear the painted set — faces had opposite semantics in the previous mode
  excludedFaces = new Set();
  precisionExcludedFaces = new Set();
  _clearSoftPaint();
  refreshExclusionOverlay();
}

// Neither mode button is highlighted until masking is engaged (maskModeChosen)
// — Exclude is still the effective default internally, but the user should
// deliberately pick a mode (or a tool) before it lights up.
function updateMaskModeButtons() {
  const excludeOn = maskModeChosen && !selectionMode;
  const includeOn = maskModeChosen && selectionMode;
  exclModeExcludeBtn.classList.toggle('active', excludeOn);
  exclModeIncludeBtn.classList.toggle('active', includeOn);
  exclModeExcludeBtn.setAttribute('aria-pressed', String(excludeOn));
  exclModeIncludeBtn.setAttribute('aria-pressed', String(includeOn));
}

function setExclusionTool(tool) {
  // Clicking the active tool toggles it off; passing null always deactivates
  exclusionTool = (exclusionTool === tool) ? null : tool;
  setSectionHandlesLocked(!!exclusionTool || placeOnFaceActive);

  // Deactivate place-on-face and rotate if an exclusion tool is being activated
  if (exclusionTool && placeOnFaceActive) togglePlaceOnFace(false);
  if (exclusionTool && rotateActive) toggleRotateMode(false);

  // Activating any masking tool engages the masking UI — highlight the mode
  // the paint will apply under (exclude unless include-only was chosen).
  if (exclusionTool && !maskModeChosen) {
    maskModeChosen = true;
    updateMaskModeButtons();
  }

  // Exit 3D displacement preview when a masking tool is activated
  if (exclusionTool && settings.useDisplacement) {
    settings.useDisplacement = false;
    dispPreviewToggle.checked = false;
    toggleDisplacementPreview(false);
  }
  exclBrushBtn.classList.toggle('active', exclusionTool === 'brush');
  exclBucketBtn.classList.toggle('active', exclusionTool === 'bucket');
  // Show brush-type row only while brush is active
  exclBrushTypeRow.classList.toggle('hidden', exclusionTool !== 'brush');
  // Show radius row only while brush + radius mode is active
  exclRadiusRow.classList.toggle('hidden', !(exclusionTool === 'brush' && brushIsRadius));
  exclHardnessRow.classList.toggle('hidden', !(exclusionTool === 'brush' && brushIsRadius));
  // Show precision masking row only when brush + circle mode is active
  precisionMaskingRow.classList.toggle('hidden', !(exclusionTool === 'brush' && brushIsRadius));
  // Show threshold row only while bucket is active
  exclThresholdRow.classList.toggle('hidden', exclusionTool !== 'bucket');
  canvas.style.cursor = (exclusionTool === 'brush' && brushIsRadius) ? 'none' : exclusionTool ? 'crosshair' : '';
  // Clear hover preview whenever the tool changes or is deactivated
  _lastHoverTriIdx = -1;
  setHoverPreview(null);
  // Hide brush cursor if tool deactivated or switched away from radius brush
  if (!(exclusionTool === 'brush' && brushIsRadius)) {
    brushCursorEl.style.display = 'none';
  }
  // Re-enable controls if tool was deactivated mid-paint
  if (!exclusionTool) {
    isPainting = false;
    getControls().enabled = true;
    const dbg = document.getElementById('masking-tri-debug');
    if (dbg) { dbg.hidden = true; dbg.textContent = ''; }
    // Recompute boundary falloff now that masking is done
    if (_falloffDirty && currentGeometry) {
      const activeGeo = (precisionMaskingEnabled && precisionGeometry)
        ? precisionGeometry
        : (settings.useDisplacement && dispPreviewGeometry)
          ? dispPreviewGeometry : currentGeometry;
      updateFaceMask(activeGeo);
    }
  }
}

const _ndcResult = new THREE.Vector2();
function _canvasNDC(e) {
  const rect = canvas.getBoundingClientRect();
  _ndcResult.set(
    ((e.clientX - rect.left) / rect.width)  *  2 - 1,
    ((e.clientY - rect.top)  / rect.height) * -2 + 1,
  );
  return _ndcResult;
}

// The preview material uses THREE.DoubleSide, so the raycaster can return
// back-face hits of adjacent triangles that are marginally closer than the
// intended front-facing triangle.  This helper returns the first hit whose
// face normal (in world space) points toward the camera ray origin.
const _normalMatrix = new THREE.Matrix3();
function getFrontFaceHit(hits, mesh) {
  // Section view: the cut-away side isn't there, and the cut face covers what's behind it.
  hits = sectionVisibleHits(hits, _raycaster.ray);
  if (!hits.length) return null;
  _normalMatrix.getNormalMatrix(mesh.matrixWorld);
  for (const hit of hits) {
    const wn = hit.face.normal.clone().applyMatrix3(_normalMatrix).normalize();
    if (wn.dot(_raycaster.ray.direction) < 0) return hit;
  }
  return hits[0]; // fallback — should not happen with a closed mesh
}

function pickTriangle(e) {
  const mesh = getCurrentMesh();
  if (!mesh) return -1;
  _raycaster.setFromCamera(_canvasNDC(e), getCamera());
  const hits = _raycaster.intersectObject(mesh);
  const hit = getFrontFaceHit(hits, mesh);
  if (!hit) return -1;
  let fi = hit.faceIndex;
  // When displacement preview is active the mesh uses the subdivided geometry,
  // so the raycaster returns a subdivided face index.  Map it back to the
  // original face index so that excludedFaces always stores original indices.
  if (dispPreviewGeometry && mesh.geometry === dispPreviewGeometry && dispPreviewParentMap) {
    fi = dispPreviewParentMap[fi];
  }
  // Same mapping for precision masking geometry
  if (precisionGeometry && mesh.geometry === precisionGeometry && precisionParentMap) {
    fi = precisionParentMap[fi];
  }
  return fi;
}

// Debug panel: dump vertex coords + edge stats for the *visually picked*
// triangle on the currently rendered mesh.  Used to investigate sliver chains:
// pickTriangle() collapses to the original-mesh ancestor (needed by
// excludedFaces), but for sliver debugging we want the actual subdivided /
// regularized / preview face that the user clicked on.
function updateMaskingTriDebug(e) {
  const el = document.getElementById('masking-tri-debug');
  if (!el) return;
  const mesh = getCurrentMesh();
  if (!mesh) return;
  _raycaster.setFromCamera(_canvasNDC(e), getCamera());
  const hits = _raycaster.intersectObject(mesh);
  const hit = getFrontFaceHit(hits, mesh);
  if (!hit) return;
  const fi  = hit.faceIndex;
  const geo = hit.object.geometry;
  const pos = geo.attributes.position;
  // Non-indexed geometry — three corners are at fi*3, fi*3+1, fi*3+2.
  const ax = pos.getX(fi*3),     ay = pos.getY(fi*3),     az = pos.getZ(fi*3);
  const bx = pos.getX(fi*3 + 1), by = pos.getY(fi*3 + 1), bz = pos.getZ(fi*3 + 1);
  const cx = pos.getX(fi*3 + 2), cy = pos.getY(fi*3 + 2), cz = pos.getZ(fi*3 + 2);
  const lAB = Math.hypot(bx-ax, by-ay, bz-az);
  const lBC = Math.hypot(cx-bx, cy-by, cz-bz);
  const lCA = Math.hypot(ax-cx, ay-cy, az-cz);
  const lmin = Math.min(lAB, lBC, lCA);
  const lmax = Math.max(lAB, lBC, lCA);
  const aspect = lmin > 0 ? lmax / lmin : Infinity;
  const tag = geo === currentGeometry        ? 'orig'
            : geo === precisionGeometry      ? 'precision'
            : geo === dispPreviewGeometry    ? 'preview'
            : 'mesh';
  el.textContent =
    `tri #${fi}  (${tag})\n` +
    `A:  (${ax.toFixed(4)}, ${ay.toFixed(4)}, ${az.toFixed(4)})\n` +
    `B:  (${bx.toFixed(4)}, ${by.toFixed(4)}, ${bz.toFixed(4)})\n` +
    `C:  (${cx.toFixed(4)}, ${cy.toFixed(4)}, ${cz.toFixed(4)})\n` +
    `AB=${lAB.toFixed(4)}  BC=${lBC.toFixed(4)}  CA=${lCA.toFixed(4)}  mm\n` +
    `min=${lmin.toFixed(4)}  max=${lmax.toFixed(4)}  aspect=${aspect.toFixed(2)}`;
  el.hidden = false;
}

/**
 * Squared distance from point P to the closest point on triangle ABC.
 * Uses the Voronoi-region method (no allocations, pure arithmetic).
 */
function distSqPointToTri(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx-ax, aby = by-ay, abz = bz-az;
  const acx = cx-ax, acy = cy-ay, acz = cz-az;
  const apx = px-ax, apy = py-ay, apz = pz-az;

  const d1 = abx*apx + aby*apy + abz*apz;
  const d2 = acx*apx + acy*apy + acz*apz;
  if (d1 <= 0 && d2 <= 0) return apx*apx + apy*apy + apz*apz; // vertex A

  const bpx = px-bx, bpy = py-by, bpz = pz-bz;
  const d3 = abx*bpx + aby*bpy + abz*bpz;
  const d4 = acx*bpx + acy*bpy + acz*bpz;
  if (d3 >= 0 && d4 <= d3) return bpx*bpx + bpy*bpy + bpz*bpz; // vertex B

  const cpx = px-cx, cpy = py-cy, cpz = pz-cz;
  const d5 = abx*cpx + aby*cpy + abz*cpz;
  const d6 = acx*cpx + acy*cpy + acz*cpz;
  if (d6 >= 0 && d5 <= d6) return cpx*cpx + cpy*cpy + cpz*cpz; // vertex C

  const vc = d1*d4 - d3*d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { // edge AB
    const v = d1 / (d1 - d3);
    const qx = ax+v*abx-px, qy = ay+v*aby-py, qz = az+v*abz-pz;
    return qx*qx + qy*qy + qz*qz;
  }

  const vb = d5*d2 - d1*d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { // edge AC
    const w = d2 / (d2 - d6);
    const qx = ax+w*acx-px, qy = ay+w*acy-py, qz = az+w*acz-pz;
    return qx*qx + qy*qy + qz*qz;
  }

  const va = d3*d6 - d5*d4;
  if (va <= 0 && (d4-d3) >= 0 && (d5-d6) >= 0) { // edge BC
    const w = (d4-d3) / ((d4-d3) + (d5-d6));
    const qx = bx+w*(cx-bx)-px, qy = by+w*(cy-by)-py, qz = bz+w*(cz-bz)-pz;
    return qx*qx + qy*qy + qz*qz;
  }

  // Inside triangle
  const den = 1 / (va + vb + vc);
  const v = vb*den, w = vc*den;
  const qx = ax+abx*v+acx*w-px, qy = ay+aby*v+acy*w-py, qz = az+abz*v+acz*w-pz;
  return qx*qx + qy*qy + qz*qz;
}

/**
 * BFS-along-adjacency circle brush (after PrusaSlicer's TriangleSelector).
 *
 * Starts at `seedTriIdx`, walks the mesh's neighbor graph, and invokes
 * cb(triIdx) for every triangle that:
 *   1. has at least one part inside the brush "cylinder" (the projection of
 *      a 3D distance-to-triangle test onto the plane perpendicular to
 *      `viewDir`), AND
 *   2. is reachable without crossing any back-facing triangle.
 *
 * Back-face culling at the BFS expansion step is what makes this both fast
 * and correct: the walk can't tunnel through a thin shell to its hidden
 * other side because the connecting wall faces away from the camera. Work
 * is bounded by the painted area, not the mesh size — no spatial index
 * required.
 */
function bfsBrushSelect(seedTriIdx, hitPt, r2, viewDir, cb) {
  const usePrecision = precisionMaskingEnabled && precisionGeometry;
  const adjacency  = usePrecision ? precisionAdjacency  : triangleAdjacency;
  const faceNormals = usePrecision ? precisionFaceNormals : triangleFaceNormals;
  const geo        = usePrecision ? precisionGeometry   : currentGeometry;
  if (!adjacency || !faceNormals || !geo || seedTriIdx < 0 || seedTriIdx >= adjacency.length) return;
  const pos = geo.attributes.position;

  const vdx = viewDir.x, vdy = viewDir.y, vdz = viewDir.z;
  const hx  = hitPt.x,   hy  = hitPt.y,   hz  = hitPt.z;

  const visited = new Uint8Array(adjacency.length);
  visited[seedTriIdx] = 1;
  const queue = [seedTriIdx];
  let head = 0;

  while (head < queue.length) {
    const cur = queue[head++];
    const i3 = cur * 3;

    // Inside-test: project each vertex onto the plane through hitPt
    // perpendicular to viewDir, then take 3D point-to-triangle distance to
    // the projected triangle (equivalent to 2D screen-space disk in world
    // units). Any triangle with at least partial overlap → cb + expand.
    const ax = pos.getX(i3),     ay = pos.getY(i3),     az = pos.getZ(i3);
    const bx = pos.getX(i3 + 1), by = pos.getY(i3 + 1), bz = pos.getZ(i3 + 1);
    const cx = pos.getX(i3 + 2), cy = pos.getY(i3 + 2), cz = pos.getZ(i3 + 2);

    const da = (ax - hx) * vdx + (ay - hy) * vdy + (az - hz) * vdz;
    const db = (bx - hx) * vdx + (by - hy) * vdy + (bz - hz) * vdz;
    const dc = (cx - hx) * vdx + (cy - hy) * vdy + (cz - hz) * vdz;

    const d2 = distSqPointToTri(
      hx, hy, hz,
      ax - da * vdx, ay - da * vdy, az - da * vdz,
      bx - db * vdx, by - db * vdy, bz - db * vdz,
      cx - dc * vdx, cy - dc * vdy, cz - dc * vdz
    );
    if (d2 > r2) continue; // outside cylinder — don't paint, don't expand

    cb(cur);

    const nbrs = adjacency[cur];
    if (!nbrs) continue;
    for (let k = 0; k < nbrs.length; k++) {
      const nb = nbrs[k].neighbor;
      if (visited[nb]) continue;
      visited[nb] = 1;
      // Cull back-facing neighbors: front-facing means normal opposes view dir
      // (their dot with viewDir is negative). Eq-zero (perpendicular) also
      // culled — that's the seam at the silhouette where BFS should stop.
      const nbi = nb * 3;
      const dotN = faceNormals[nbi]   * vdx
                 + faceNormals[nbi+1] * vdy
                 + faceNormals[nbi+2] * vdz;
      if (dotN >= 0) continue;
      queue.push(nb);
    }
  }
}

const _viewDirScratch = new THREE.Vector3();
function _viewDirFor(hitPt) {
  return _viewDirScratch.subVectors(hitPt, getCamera().position).normalize();
}

// strokeFrom: previous point of the same stroke — the soft brush sweeps the
// segment from there to hit.point (the hard brush paints at hit.point only).
function _paintSingleHit(hit, mesh, strokeFrom = null) {
  const usePrecision = precisionMaskingEnabled && precisionGeometry && precisionParentMap;
  if (usePrecision) precisionPainted = true;
  if (brushIsRadius && brushHardness < 1) {
    let seed = hit.faceIndex;
    if (!usePrecision && dispPreviewGeometry && mesh.geometry === dispPreviewGeometry && dispPreviewParentMap) {
      seed = dispPreviewParentMap[seed];
    }
    _paintSoftSegment(seed, strokeFrom || hit.point, hit.point, !!usePrecision);
    return;
  }
  if (usePrecision) {
    if (brushIsRadius) {
      const r2 = brushRadius * brushRadius;
      bfsBrushSelect(hit.faceIndex, hit.point, r2, _viewDirFor(hit.point), t => {
        if (eraseMode) { precisionExcludedFaces.delete(t); _clearSoftFace(precisionSoftPaint, t); }
        else precisionExcludedFaces.add(t);
      });
    } else {
      const precIdx = hit.faceIndex;
      if (eraseMode) { precisionExcludedFaces.delete(precIdx); _clearSoftFace(precisionSoftPaint, precIdx); }
      else precisionExcludedFaces.add(precIdx);
    }
  } else {
    let triIdx = hit.faceIndex;
    if (dispPreviewGeometry && mesh.geometry === dispPreviewGeometry && dispPreviewParentMap) {
      triIdx = dispPreviewParentMap[triIdx];
    }
    if (brushIsRadius) {
      const r2 = brushRadius * brushRadius;
      bfsBrushSelect(triIdx, hit.point, r2, _viewDirFor(hit.point), t => {
        if (eraseMode) { excludedFaces.delete(t); _clearSoftFace(softPaint, t); }
        else excludedFaces.add(t);
      });
    } else {
      if (eraseMode) { excludedFaces.delete(triIdx); _clearSoftFace(softPaint, triIdx); }
      else excludedFaces.add(triIdx);
    }
  }
}

const _softSegMid = new THREE.Vector3();

/**
 * Soft brush (hardness < 100 %): paint — or erase — per-vertex coverage along
 * the stroke segment from → to, i.e. the union of brush dabs swept between the
 * two points, so fast strokes stay continuous instead of beading into dabs.
 * Like the hard brush's cylinder test, distances are measured in the plane
 * perpendicular to the view. Coverage combines by max (erase: min), so
 * overlapping dabs within and across strokes never build up past the profile.
 */
function _paintSoftSegment(seedTri, from, to, precision) {
  const geo   = precision ? precisionGeometry  : currentGeometry;
  const layer = precision ? precisionSoftPaint : softPaint;
  const faces = precision ? precisionExcludedFaces : excludedFaces;
  if (!geo || !layer) return;
  if (!layer.values) layer.values = new Float32Array(layer.count);
  const soft = layer.values, vertId = layer.vertId;

  const view = _viewDirFor(to);
  const vx = view.x, vy = view.y, vz = view.z;
  // Segment in the view plane through `to`, running from s to the origin.
  let sx = from.x - to.x, sy = from.y - to.y, sz = from.z - to.z;
  const sAlong = sx * vx + sy * vy + sz * vz;
  sx -= sAlong * vx; sy -= sAlong * vy; sz -= sAlong * vz;
  const segLen2 = sx * sx + sy * sy + sz * sz;

  // One BFS over a disk around the segment midpoint that covers the whole sweep.
  const reach = brushRadius + Math.sqrt(segLen2) / 2;
  _softSegMid.set(to.x + sx / 2, to.y + sy / 2, to.z + sz / 2);
  const touched = [];
  bfsBrushSelect(seedTri, _softSegMid, reach * reach, view, t => touched.push(t));

  // Coverage per touched corner (0 outside the swept brush).
  const pos = geo.attributes.position;
  const r2 = brushRadius * brushRadius;
  const cov = new Float32Array(touched.length * 3);
  for (let j = 0; j < touched.length; j++) {
    for (let k = 0; k < 3; k++) {
      const i = touched[j] * 3 + k;
      let px = pos.getX(i) - to.x, py = pos.getY(i) - to.y, pz = pos.getZ(i) - to.z;
      const along = px * vx + py * vy + pz * vz;
      px -= along * vx; py -= along * vy; pz -= along * vz;
      let u = segLen2 > 0 ? (px * sx + py * sy + pz * sz) / segLen2 : 0;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const dx = px - u * sx, dy = py - u * sy, dz = pz - u * sz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < r2) cov[j * 3 + k] = brushCoverage(Math.sqrt(d2), brushRadius, brushHardness);
    }
  }

  // A soft eraser feathers hard-masked faces: each one it reaches is turned
  // into full vertex coverage first, then faded like any other paint.
  if (eraseMode) {
    for (let j = 0; j < touched.length; j++) {
      const t = touched[j];
      if (!(cov[j * 3] > 0 || cov[j * 3 + 1] > 0 || cov[j * 3 + 2] > 0)) continue;
      if (!faces.delete(t)) continue;
      soft[vertId[t * 3]] = soft[vertId[t * 3 + 1]] = soft[vertId[t * 3 + 2]] = 1;
    }
  }

  for (let j = 0; j < touched.length; j++) {
    for (let k = 0; k < 3; k++) {
      const a = cov[j * 3 + k];
      if (a <= 0) continue;
      const id = vertId[touched[j] * 3 + k];
      if (eraseMode) { if (1 - a < soft[id]) soft[id] = 1 - a; }
      else if (a > soft[id]) soft[id] = a;
    }
  }
}

// Hard erase over soft paint: wipe the paint on every corner of face t.
function _clearSoftFace(layer, t) {
  if (!layer || !layer.values) return;
  const v = layer.values, id = layer.vertId;
  v[id[t * 3]] = v[id[t * 3 + 1]] = v[id[t * 3 + 2]] = 0;
}

// ── Soft-brush paint layers ──────────────────────────────────────────────────

/** Fresh, unpainted soft layer for a newly tessellated painting mesh. */
function _newSoftLayer(adjData) {
  return { vertId: adjData.vertId, count: adjData.vertCount, serial: ++_softLayerSerial, values: null };
}

/**
 * Carry a layer onto re-welded vertex ids of the SAME triangles (rotation).
 * Ids normally come out identical; if quantisation grouped a vertex
 * differently the paint is remapped per corner and the serial changes so
 * stale undo snapshots can't land on the wrong vertices.
 */
function _reweldSoftLayer(layer, adjData) {
  const next = _newSoftLayer(adjData);
  if (!layer || layer.vertId.length !== next.vertId.length) return next;
  let same = layer.count === next.count;
  for (let i = 0; same && i < next.vertId.length; i++) same = layer.vertId[i] === next.vertId[i];
  if (same) next.serial = layer.serial;
  if (layer.values) {
    next.values = same
      ? layer.values
      : cornersToValues(valuesToCorners(layer.values, layer.vertId), next.vertId, next.count);
  }
  return next;
}

function _layerHasPaint(layer) {
  return !!(layer && hasSoftPaint(layer.values));
}

function _clearSoftPaint() {
  if (softPaint) softPaint.values = null;
  if (precisionSoftPaint) precisionSoftPaint.values = null;
}

/**
 * Soft paint as per-corner coverage in `geometry`'s own corner order, or null
 * when there is none. The displacement preview mesh is a refinement of
 * currentGeometry, so its coverage is interpolated from the base layer.
 */
function _softCornersFor(geometry, isPrecision, isDisp) {
  const layer = isPrecision ? precisionSoftPaint : softPaint;
  if (!_layerHasPaint(layer)) return null;
  // The layer must index the mesh it's applied to (guards the brief window
  // during a model swap where the old layer is still set).
  const paintGeo = isDisp ? currentGeometry : geometry;
  if (!isDisp && geometry !== (isPrecision ? precisionGeometry : currentGeometry)) return null;
  if (layer.vertId.length !== paintGeo.attributes.position.count) return null;
  const corners = valuesToCorners(layer.values, layer.vertId);
  if (!isDisp) return corners;
  return interpolateFromParents(geometry.attributes.position.array, dispPreviewParentMap,
                                currentGeometry.attributes.position.array, corners);
}

/**
 * Re-seed the precision mesh's paint from the base mesh: hard faces through
 * the parent map, soft paint by interpolation inside each parent triangle.
 */
function _seedPrecisionFromBase() {
  precisionPainted = false;
  precisionExcludedFaces = new Set();
  if (excludedFaces.size > 0) {
    const len = precisionParentMap.length;
    for (let i = 0; i < len; i++) {
      if (excludedFaces.has(precisionParentMap[i])) precisionExcludedFaces.add(i);
    }
  }
  precisionSoftPaint.values = null;
  if (_layerHasPaint(softPaint)) {
    const child = interpolateFromParents(
      precisionGeometry.attributes.position.array, precisionParentMap,
      currentGeometry.attributes.position.array, valuesToCorners(softPaint.values, softPaint.vertId));
    precisionSoftPaint.values = cornersToValues(child, precisionSoftPaint.vertId, precisionSoftPaint.count);
  }
}

// Sparse copy of a layer's paint for undo snapshots (ids into the layer's
// welded vertices, tagged with its serial), or null when unpainted.
function _sparseSoft(layer) {
  if (!_layerHasPaint(layer)) return null;
  const v = layer.values;
  let n = 0;
  for (let i = 0; i < v.length; i++) if (v[i] > 0) n++;
  const ids = new Uint32Array(n), vals = new Float32Array(n);
  for (let i = 0, j = 0; i < v.length; i++) {
    if (v[i] > 0) { ids[j] = i; vals[j] = v[i]; j++; }
  }
  return { serial: layer.serial, ids, vals };
}

// Dense layer values from a _sparseSoft snapshot — null if it was taken on
// a different tessellation.
function _denseSoft(sparse, layer) {
  if (!sparse || !layer || sparse.serial !== layer.serial) return null;
  const out = new Float32Array(layer.count);
  for (let j = 0; j < sparse.ids.length; j++) out[sparse.ids[j]] = sparse.vals[j];
  return out;
}

function _sparseSoftEqual(a, b) {
  if (!a || !b) return a === b;
  if (a.serial !== b.serial || a.ids.length !== b.ids.length) return false;
  for (let j = 0; j < a.ids.length; j++) {
    if (a.ids[j] !== b.ids[j] || a.vals[j] !== b.vals[j]) return false;
  }
  return true;
}

/**
 * Base-mesh soft paint for a project file: sparse per-corner lists (corner =
 * triangle × 3 + k), which unlike welded ids survive the model round-trip
 * through STL regardless of how the importer re-welds it. (Project export
 * bakes precision first, so the base layer holds all the paint.)
 */
function _collectProjectSoft() {
  if (!_layerHasPaint(softPaint)) return null;
  const corners = [], vals = [];
  for (let i = 0; i < softPaint.vertId.length; i++) {
    const v = softPaint.values[softPaint.vertId[i]];
    // 6 significant digits: compact JSON, and the fade's faint tail stays > 0
    if (v > 0) { corners.push(i); vals.push(+v.toPrecision(6)); }
  }
  return { corners, values: vals };
}

/** Soft paint for the export/bake pipeline, from the base mesh. */
function _pipelineMaskInputs() {
  const soft = _layerHasPaint(softPaint) ? softPaint : null;
  const softFaces = (soft && selectionMode) ? softPaintedFaces(soft.vertId, soft.values) : null;
  const hasAngleMask = settings.bottomAngleLimit > 0 || settings.topAngleLimit > 0;
  const faceWeights = (excludedFaces.size > 0 || selectionMode || hasAngleMask)
    ? buildCombinedFaceWeights(currentGeometry, excludedFaces, selectionMode, settings, softFaces)
    : null;
  const softExclude = soft ? buildSoftExclusion(soft.vertId, soft.values, excludedFaces, selectionMode) : null;
  return { faceWeights, softExclude };
}

/** Show the hardness core as a dashed inner ring on the brush cursor. */
function updateBrushCursorHardness() {
  const soft = brushHardness < 1;
  brushCursorEl.classList.toggle('soft', soft && brushHardness > 0);
  brushCursorEl.style.setProperty('--brush-hardness', String(brushHardness));
}

function _paintLineBetween(from, to, mesh) {
  // Sample points along the line and paint at each
  const dist = from.distanceTo(to);
  const step = brushIsRadius ? Math.max(brushRadius * 0.5, 0.1) : 0.5;
  const steps = Math.max(Math.ceil(dist / step), 1);
  const dir = new THREE.Vector3().subVectors(to, from);
  const cam = getCamera();
  let prevPt = null; // soft brush: sweep between consecutive samples
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const pt = new THREE.Vector3().lerpVectors(from, to, t);
    // Project 3D point to screen, then raycast back to find mesh hit
    const ndc = pt.clone().project(cam);
    _raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), cam);
    const hits = _raycaster.intersectObject(mesh);
    const hit = getFrontFaceHit(hits, mesh);
    if (hit) _paintSingleHit(hit, mesh, prevPt);
    prevPt = hit ? hit.point : null;
  }
}

function paintAt(e) {
  const mesh = getCurrentMesh();
  if (!mesh) return;
  _raycaster.setFromCamera(_canvasNDC(e), getCamera());
  const hits = _raycaster.intersectObject(mesh);
  const hit = getFrontFaceHit(hits, mesh);
  // Off the model: break the stroke so the soft brush doesn't sweep a band
  // across the surface between where the cursor left and re-entered.
  if (!hit) { _strokeLastPoint = null; return; }

  // Shift+click: draw line from last paint point to current
  if (e.ctrlKey && _lastPaintHitPoint) {
    _paintLineBetween(_lastPaintHitPoint, hit.point, mesh);
    _clearShiftLinePreview();
  } else {
    _paintSingleHit(hit, mesh, _strokeLastPoint);
  }

  _lastPaintHitPoint = hit.point.clone();
  _strokeLastPoint = _lastPaintHitPoint;
  refreshExclusionOverlay();
}

// ── Place on Face ─────────────────────────────────────────────────────────────

// ── Shift-line preview for brush painting ─────────────────────────────────

function _updateShiftLinePreview(e) {
  if (!e.ctrlKey || !_lastPaintHitPoint || !exclusionTool || exclusionTool !== 'brush') {
    _clearShiftLinePreview();
    return;
  }
  const mesh = getCurrentMesh();
  if (!mesh) return;
  _raycaster.setFromCamera(_canvasNDC(e), getCamera());
  const hits = _raycaster.intersectObject(mesh);
  const hit = getFrontFaceHit(hits, mesh);
  if (!hit) { _clearShiftLinePreview(); return; }

  const points = [_lastPaintHitPoint, hit.point];
  if (_shiftLineMesh) {
    _shiftLineMesh.geometry.setFromPoints(points);
    _shiftLineMesh.geometry.attributes.position.needsUpdate = true;
  } else {
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    const mat = new THREE.LineBasicMaterial({ color: 0x00ffaa, linewidth: 2, depthTest: false });
    _shiftLineMesh = new THREE.Line(geo, mat);
    _shiftLineMesh.renderOrder = 999;
    const scene = mesh.parent.parent; // meshGroup → scene
    if (scene) scene.add(_shiftLineMesh);
  }
  requestRender();
}

function _clearShiftLinePreview() {
  if (_shiftLineMesh) {
    if (_shiftLineMesh.parent) _shiftLineMesh.parent.remove(_shiftLineMesh);
    _shiftLineMesh.geometry.dispose();
    _shiftLineMesh.material.dispose();
    _shiftLineMesh = null;
    requestRender();
  }
}

// ── Place on Face ─────────────────────────────────────────────────────────────

function togglePlaceOnFace(active) {
  placeOnFaceActive = active;
  placeOnFaceBtn.classList.toggle('active', active);
  setSectionHandlesLocked(!!exclusionTool || active);

  if (active) {
    // Deactivate exclusion tool
    if (exclusionTool) setExclusionTool(null);
    // Deactivate rotate mode
    if (rotateActive) toggleRotateMode(false);
    // Deactivate precision masking (geometry will be rotated/replaced)
    if (precisionMaskingEnabled) deactivatePrecisionMasking();
    canvas.style.cursor = 'crosshair';
  } else {
    if (!exclusionTool) canvas.style.cursor = '';
    _lastHoverTriIdx = -1;
    setHoverPreview(null);
  }
}

function updatePlaceOnFaceHover(e) {
  const mesh = getCurrentMesh();
  if (!mesh) { setHoverPreview(null); return; }
  _raycaster.setFromCamera(_canvasNDC(e), getCamera());
  const hits = _raycaster.intersectObject(mesh);
  const hit = getFrontFaceHit(hits, mesh);
  if (!hit) { _lastHoverTriIdx = -1; setHoverPreview(null); return; }

  let triIdx = hit.faceIndex;
  if (dispPreviewGeometry && mesh.geometry === dispPreviewGeometry && dispPreviewParentMap) {
    triIdx = dispPreviewParentMap[triIdx];
  }
  if (triIdx === _lastHoverTriIdx) return;
  _lastHoverTriIdx = triIdx;
  setHoverPreview(buildExclusionOverlayGeo(currentGeometry, new Set([triIdx])));
}

function handlePlaceOnFaceClick(e) {
  const mesh = getCurrentMesh();
  if (!mesh) return;
  _raycaster.setFromCamera(_canvasNDC(e), getCamera());
  const hits = _raycaster.intersectObject(mesh);
  const hit = getFrontFaceHit(hits, mesh);
  if (!hit) return;

  // Get the face normal (mesh has identity transform)
  const faceNormal = hit.face.normal.clone().normalize();

  // Compute quaternion that rotates faceNormal to -Z (face down on print bed)
  const targetDir = new THREE.Vector3(0, 0, -1);
  const quat = new THREE.Quaternion().setFromUnitVectors(faceNormal, targetDir);

  // Apply rotation to all vertex positions
  const pos = currentGeometry.attributes.position.array;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.length; i += 3) {
    v.set(pos[i], pos[i + 1], pos[i + 2]);
    v.applyQuaternion(quat);
    pos[i]     = v.x;
    pos[i + 1] = v.y;
    pos[i + 2] = v.z;
  }

  // Fold the rotation into the pose transform (undone again on export).
  currentPoseRot.premultiply(quat).normalize();
  currentPoseTrans.applyQuaternion(quat);

  // Re-center geometry
  currentGeometry.computeBoundingBox();
  const center = new THREE.Vector3();
  currentGeometry.boundingBox.getCenter(center);
  currentGeometry.translate(-center.x, -center.y, -center.z);
  currentPoseTrans.sub(center);

  // Recompute normals from scratch (fixes lighting + angle masking)
  currentGeometry.computeVertexNormals();
  // Delete stale faceNormal attribute so updateFaceMask() recomputes it
  // from the new rotated positions (needed for correct angle masking in 2D preview)
  if (currentGeometry.attributes.faceNormal) {
    currentGeometry.deleteAttribute('faceNormal');
  }

  // Now reload as if this were a freshly loaded STL
  currentBounds = computeBounds(currentGeometry);
  // Geometry rotated — cylinder axis settings tied to old XY are stale.
  settings.cylinderCenterX = null;
  settings.cylinderCenterY = null;
  settings.cylinderRadius  = null;
  _cylSilhouetteCanvas = null;
  _cylSilhouetteGeometry = null;
  _cylSilhouetteAnchor = null;
  updateCylinderUIVisibility();
  checkAmplitudeWarning();
  checkResolutionWarning();

  // Dispose old preview material so it gets fully recreated
  if (previewMaterial) {
    previewMaterial.dispose();
    previewMaterial = null;
  }

  loadGeometry(currentGeometry);

  // Reset displacement preview (an in-flight build used the old pose)
  cancelDisplacementPreviewBuild();
  if (dispPreviewGeometry) { dispPreviewGeometry.dispose(); dispPreviewGeometry = null; }
  settings.useDisplacement = false;
  dispPreviewToggle.checked = false;

  // Reset precision masking (geometry was rotated)
  if (precisionGeometry) { precisionGeometry.dispose(); precisionGeometry = null; }
  precisionParentMap = null; precisionEdgeLength = null;
  precisionCentroids = null; precisionFaceNormals = null; precisionAdjacency = null;
  precisionMaskingEnabled = false; precisionMaskingToggle.checked = false;
  precisionStatus.textContent = '';
  precisionOutdated.classList.add('hidden'); precisionRefreshBtn.classList.add('hidden');
  precisionWarning.classList.add('hidden'); precisionMaskingRow.classList.add('hidden');
  precisionExcludedFaces = new Set();
  precisionSoftPaint = null;
  precisionPainted = false;

  // Deactivate tools but keep excludedFaces (face indices are stable after rotation)
  exclusionTool     = null;
  eraseMode         = false;
  isPainting        = false;
  exclBrushBtn.classList.remove('active');
  exclBucketBtn.classList.remove('active');
  exclBrushTypeRow.classList.add('hidden');
  exclRadiusRow.classList.add('hidden');
  exclHardnessRow.classList.add('hidden');
  exclThresholdRow.classList.add('hidden');
  canvas.style.cursor = '';
  setHoverPreview(null);
  _lastHoverTriIdx = -1;

  // Rebuild adjacency
  const adjData = buildAdjacency(currentGeometry);
  triangleAdjacency = adjData.adjacency;
  triangleCentroids = adjData.centroids;
  triangleFaceNormals = adjData.faceNormals;
  softPaint = _reweldSoftLayer(softPaint, adjData);

  // Update edge length for new bounds
  const diag = Math.sqrt(currentBounds.size.x ** 2 + currentBounds.size.y ** 2 + currentBounds.size.z ** 2);
  const defaultEdge = Math.max(0.05, Math.min(5.0, +(diag / 300).toFixed(2)));
  settings.refineLength = defaultEdge;
  refineLenSlider.value = defaultEdge;
  refineLenVal.value = defaultEdge;
  checkResolutionWarning();

  // Update mesh info
  const triCount = getTriangleCount(currentGeometry);
  const mb = ((currentGeometry.attributes.position.array.byteLength) / 1024 / 1024).toFixed(2);
  const sx = currentBounds.size.x.toFixed(2);
  const sy = currentBounds.size.y.toFixed(2);
  const sz = currentBounds.size.z.toFixed(2);
  _setMeshInfo(triCount, mb, sx, sy, sz);

  exportBtn.disabled = (activeMapEntry === null);
  export3mfBtn.disabled = (activeMapEntry === null);
  bakeBtn.disabled = (activeMapEntry === null);
  updateSmartResBtnState();
  updatePreview();

  // Rebuild exclusion overlay with new vertex positions (face indices unchanged)
  if (excludedFaces.size > 0 || _layerHasPaint(softPaint)) {
    refreshExclusionOverlay();
  } else {
    setExclusionOverlay(null);
  }

  // Exit place-on-face mode
  togglePlaceOnFace(false);
}

// ── Rotate Mode ──────────────────────────────────────────────────────────────

function toggleRotateMode(active) {
  rotateActive = active;
  rotateBtn.classList.toggle('active', active);
  rotateControls.classList.toggle('hidden', !active);

  if (active) {
    // Deactivate conflicting modes
    if (placeOnFaceActive) togglePlaceOnFace(false);
    if (exclusionTool) setExclusionTool(null);

    // Snapshot original positions (and the matching pose transform) for reset
    if (currentGeometry) {
      _rotateOriginalPositions = new Float32Array(currentGeometry.attributes.position.array);
      _rotatePoseSnapshot = { rot: currentPoseRot.clone(), trans: currentPoseTrans.clone() };
    }
    rotateAngles = { x: 0, y: 0, z: 0 };
    rotateXInput.value = '0'; rotateYInput.value = '0'; rotateZInput.value = '0';

    // Show gizmo
    setRotationGizmo(true, handleGizmoDrag);
  } else {
    setRotationGizmo(false);
    _rotateOriginalPositions = null;
    _rotatePoseSnapshot = null;

    // Full rebuild now that rotation is done
    _rotateFinalize();
  }
}

function handleGizmoDrag(axis, deltaDegrees) {
  if (!currentGeometry) return;

  // Accumulate the angle
  rotateAngles[axis] = ((rotateAngles[axis] || 0) + deltaDegrees) % 360;

  // Update input fields
  rotateXInput.value = Math.round(rotateAngles.x * 100) / 100;
  rotateYInput.value = Math.round(rotateAngles.y * 100) / 100;
  rotateZInput.value = Math.round(rotateAngles.z * 100) / 100;

  // Apply incremental rotation to geometry
  applyIncrementalRotation(axis, THREE.MathUtils.degToRad(deltaDegrees));
}

function applyIncrementalRotation(axis, radians) {
  const quat = new THREE.Quaternion();
  if (axis === 'x') quat.setFromAxisAngle(new THREE.Vector3(1, 0, 0), radians);
  else if (axis === 'y') quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), radians);
  else quat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), radians);

  _rotateGeometry(quat);
}

function applyRotationFromInputs() {
  if (!currentGeometry) return;

  const targetX = parseFloat(rotateXInput.value) || 0;
  const targetY = parseFloat(rotateYInput.value) || 0;
  const targetZ = parseFloat(rotateZInput.value) || 0;

  // Compute delta from current accumulated angles
  const dx = targetX - rotateAngles.x;
  const dy = targetY - rotateAngles.y;
  const dz = targetZ - rotateAngles.z;

  if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001 && Math.abs(dz) < 0.001) return;

  // Apply as Euler XYZ rotation delta
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(dx),
    THREE.MathUtils.degToRad(dy),
    THREE.MathUtils.degToRad(dz),
    'XYZ',
  );
  const quat = new THREE.Quaternion().setFromEuler(euler);

  rotateAngles.x = targetX;
  rotateAngles.y = targetY;
  rotateAngles.z = targetZ;

  _rotateGeometry(quat);
}

function _rotateGeometry(quat) {
  const pos = currentGeometry.attributes.position.array;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.length; i += 3) {
    v.set(pos[i], pos[i + 1], pos[i + 2]);
    v.applyQuaternion(quat);
    pos[i]     = v.x;
    pos[i + 1] = v.y;
    pos[i + 2] = v.z;
  }

  // Fold the rotation into the pose transform (undone again on export).
  currentPoseRot.premultiply(quat).normalize();
  currentPoseTrans.applyQuaternion(quat);

  // Recompute normals
  currentGeometry.computeVertexNormals();
  if (currentGeometry.attributes.faceNormal) {
    currentGeometry.deleteAttribute('faceNormal');
  }

  currentGeometry.attributes.position.needsUpdate = true;
  if (currentGeometry.attributes.normal) {
    currentGeometry.attributes.normal.needsUpdate = true;
  }

  // Light update only: swap geometry on mesh, no camera/grid/dimension rebuild
  setMeshGeometry(currentGeometry);
  requestRender();
}

function _rotateFinalize() {
  if (!currentGeometry) return;

  // Re-center, folding the shift into the pose transform (undone on export).
  currentGeometry.computeBoundingBox();
  const center = new THREE.Vector3();
  currentGeometry.boundingBox.getCenter(center);
  currentGeometry.translate(-center.x, -center.y, -center.z);
  currentGeometry.attributes.position.needsUpdate = true;
  currentPoseTrans.sub(center);

  // Full refresh
  currentBounds = computeBounds(currentGeometry);
  loadGeometry(currentGeometry);

  // Geometry was reauthored (displacement baked in); cylinder silhouette
  // bitmap is stale. Settings are kept so the user's axis placement still
  // applies — the part shape didn't change in plan view, only Z displacement.
  _cylSilhouetteCanvas = null;
  _cylSilhouetteGeometry = null;
  _cylSilhouetteAnchor = null;
  updateCylinderUIVisibility();

  // Rebuild adjacency for exclusion tools
  const adjData = buildAdjacency(currentGeometry);
  triangleAdjacency = adjData.adjacency;
  triangleCentroids = adjData.centroids;
  triangleFaceNormals = adjData.faceNormals;
  softPaint = _reweldSoftLayer(softPaint, adjData);

  // Rebuild exclusion overlay
  if (excludedFaces.size > 0 || _layerHasPaint(softPaint)) {
    refreshExclusionOverlay();
  } else {
    setExclusionOverlay(null);
  }

  // Dispose old preview material so it gets recreated
  if (previewMaterial) {
    previewMaterial.dispose();
    previewMaterial = null;
  }

  checkAmplitudeWarning();
  checkResolutionWarning();
  updatePreview();
}

function refreshExclusionOverlay() {
  if (!currentGeometry) return;

  // Choose which geometry and face set to build the overlay from
  const usePrecision = precisionMaskingEnabled && precisionGeometry;
  const overlayGeo = usePrecision ? precisionGeometry : currentGeometry;
  const overlayFaceSet = usePrecision ? precisionExcludedFaces : excludedFaces;

  _falloffDirty = true;

  // Never show the flat-coloured MeshLambertMaterial overlay — the custom
  // shader handles mask visualisation with smooth, view-dependent shading.
  setExclusionOverlay(null);
  const n = usePrecision ? precisionExcludedFaces.size : excludedFaces.size;
  let countText = selectionMode
    ? t(n === 1 ? 'excl.faceSelected' : 'excl.facesSelected', { n: n.toLocaleString() })
    : t(n === 1 ? 'excl.faceExcluded' : 'excl.facesExcluded', { n: n.toLocaleString() });
  const softValues = (usePrecision ? precisionSoftPaint : softPaint)?.values;
  if (softValues) {
    let softN = 0;
    for (let i = 0; i < softValues.length; i++) if (softValues[i] > 0) softN++;
    if (softN > 0) countText += ' · ' + t('excl.softVertices', { n: softN.toLocaleString() });
  }
  exclCount.textContent = countText;

  // Update the faceMask attribute on the active preview geometry so the shader
  // reflects user-painted exclusions in real time.
  const activeGeo = usePrecision
    ? precisionGeometry
    : (settings.useDisplacement && dispPreviewGeometry)
      ? dispPreviewGeometry : currentGeometry;
  updateFaceMask(activeGeo);
}

function updateBrushCursor(e) {
  if (!brushIsRadius || !currentGeometry) {
    brushCursorEl.style.display = 'none';
    return;
  }
  // Hide the OS cursor only while the circle overlay is drawn on the model;
  // off-model the default cursor returns, so the pointer never vanishes and
  // painting vs. orbiting stays visually distinct (#52).
  const mesh = getCurrentMesh();
  if (!mesh) { brushCursorEl.style.display = 'none'; canvas.style.cursor = ''; return; }
  _raycaster.setFromCamera(_canvasNDC(e), getCamera());
  const hits = _raycaster.intersectObject(mesh);
  const frontHit = getFrontFaceHit(hits, mesh);
  if (!frontHit) { brushCursorEl.style.display = 'none'; canvas.style.cursor = ''; return; }
  canvas.style.cursor = 'none';

  const hitPt = frontHit.point;
  const cam   = getCamera();

  // Offset the hit point by brushRadius along the camera's right axis
  // then project both to screen space to get pixel-accurate circle size
  const camRight = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).normalize();
  const edgePt   = hitPt.clone().addScaledVector(camRight, brushRadius);

  const rect  = canvas.getBoundingClientRect();
  const toScreen = (v) => {
    const c = v.clone().project(cam);
    return {
      x: (c.x * 0.5 + 0.5) * rect.width,
      y: (1 - (c.y * 0.5 + 0.5)) * rect.height,
    };
  };

  const sc = toScreen(hitPt);
  const se = toScreen(edgePt);
  const screenRadius = Math.sqrt((se.x - sc.x) ** 2 + (se.y - sc.y) ** 2);
  const diam = screenRadius * 2;

  brushCursorEl.style.display = 'block';
  brushCursorEl.style.left    = `${rect.left + sc.x - screenRadius}px`;
  brushCursorEl.style.top     = `${rect.top  + sc.y - screenRadius}px`;
  brushCursorEl.style.width   = `${diam}px`;
  brushCursorEl.style.height  = `${diam}px`;
}

function updateBrushHover(e) {
  const mesh = getCurrentMesh();
  if (!mesh) { setHoverPreview(null); return; }
  _raycaster.setFromCamera(_canvasNDC(e), getCamera());
  const hits = _raycaster.intersectObject(mesh);
  const hit = getFrontFaceHit(hits, mesh);
  if (!hit) { _lastHoverTriIdx = -1; setHoverPreview(null); return; }

  // Use raw face index for cache when precision is active (small faces → frequent updates)
  const usePrecision = precisionMaskingEnabled && precisionGeometry && precisionParentMap;
  let triIdx = hit.faceIndex;
  if (!usePrecision) {
    if (dispPreviewGeometry && mesh.geometry === dispPreviewGeometry && dispPreviewParentMap) {
      triIdx = dispPreviewParentMap[triIdx];
    }
  }
  if (triIdx === _lastHoverTriIdx) return;
  _lastHoverTriIdx = triIdx;

  const hoverGeo = usePrecision ? precisionGeometry : currentGeometry;
  const hoverColor = eraseMode ? 0x999999 : 0xffee00;
  if (brushIsRadius) {
    const r2 = brushRadius * brushRadius;
    const hovered = new Set();
    // Hover seed must be in the same index space as bfsBrushSelect uses.
    // In precision mode that's hit.faceIndex (precision); in disp-preview
    // mode it's the parent-mapped index; otherwise it's the raw faceIndex.
    let seed = hit.faceIndex;
    if (!usePrecision && dispPreviewGeometry && mesh.geometry === dispPreviewGeometry && dispPreviewParentMap) {
      seed = dispPreviewParentMap[seed];
    }
    bfsBrushSelect(seed, hit.point, r2, _viewDirFor(hit.point), t => hovered.add(t));
    setHoverPreview(buildExclusionOverlayGeo(hoverGeo, hovered), hoverColor);
  } else {
    // For single mode with precision, find the refined face index for the hover highlight
    if (usePrecision) {
      const rawIdx = hit.faceIndex;
      const hovered = new Set([rawIdx]);
      setHoverPreview(buildExclusionOverlayGeo(precisionGeometry, hovered), hoverColor);
    } else {
      const hovered = new Set([triIdx]);
      setHoverPreview(buildExclusionOverlayGeo(currentGeometry, hovered), hoverColor);
    }
  }
}

function updateBucketHover(e) {
  const triIdx = pickTriangle(e);
  if (triIdx === _lastHoverTriIdx) return; // unchanged — skip expensive BFS
  _lastHoverTriIdx = triIdx;
  if (triIdx < 0 || !triangleAdjacency) {
    setHoverPreview(null);
    return;
  }
  const hovered = bucketFill(triIdx, triangleAdjacency, bucketThreshold);
  const usePrecision = precisionMaskingEnabled && precisionGeometry && precisionParentMap;
  if (usePrecision) {
    // Map original face indices to precision face indices for overlay
    const refinedHover = new Set();
    const len = precisionParentMap.length;
    for (let i = 0; i < len; i++) {
      if (hovered.has(precisionParentMap[i])) refinedHover.add(i);
    }
    setHoverPreview(buildExclusionOverlayGeo(precisionGeometry, refinedHover), eraseMode ? 0x999999 : 0xffee00);
  } else {
    setHoverPreview(buildExclusionOverlayGeo(currentGeometry, hovered), eraseMode ? 0x999999 : 0xffee00);
  }
}

// ── Slider helper ─────────────────────────────────────────────────────────────

const INPUT_WHEEL_DECIMALS = 3;

function getInputPrecision(input) {
  const configured = parseInt(input.dataset.wheelDecimals, 10);
  if (!isNaN(configured) && configured >= 0) return configured;
  const step = input.step;
  if (step === 'any') return INPUT_WHEEL_DECIMALS;
  const stepNum = parseFloat(step);
  if (isNaN(stepNum)) return INPUT_WHEEL_DECIMALS;
  if (Number.isInteger(stepNum)) return 0;
  const frac = step.includes('.') ? step.split('.')[1].replace(/0+$/, '').length : 0;
  return Math.max(INPUT_WHEEL_DECIMALS, frac);
}

function roundToPrecision(value, precision) {
  if (precision <= 0) return Math.round(value);
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function clampToInputBounds(input, value) {
  const min = parseFloat(input.min);
  const max = parseFloat(input.max);
  let clamped = value;
  if (!isNaN(min)) clamped = Math.max(min, clamped);
  if (!isNaN(max)) clamped = Math.min(max, clamped);
  return clamped;
}

function formatInputValue(input, value) {
  const precision = getInputPrecision(input);
  if (precision <= 0) return String(Math.round(value));
  return value.toFixed(precision).replace(/\.?0+$/, '');
}

function addFineWheelSupport(input, applyFn) {
  input.addEventListener('wheel', (e) => {
    if (input.disabled || input.readOnly) return;
    e.preventDefault();
    input.focus({ preventScroll: true });

    const precision = getInputPrecision(input);

    let step = precision <= 0 ? 1 : 1 / (10 ** precision);

   
    if (e.shiftKey) {
      step *= 10;        // faster
    } else if (e.ctrlKey || e.metaKey) {
      step *= 0.1;       // ultra fine 
    }

    const current = parseFloat(input.value);
    const fallback = parseFloat(input.defaultValue || input.min || '0');
    const base = isNaN(current) ? (isNaN(fallback) ? 0 : fallback) : current;

    const direction = e.deltaY < 0 ? 1 : -1;
    const next = clampToInputBounds(
      input,
      roundToPrecision(base + direction * step, precision + 2) 
    );

    applyFn(next);
  }, { passive: false });
}

function linkSlider(slider, valInput, onChangeFn, livePreview = true) {
  const isSpan = valInput.tagName === 'SPAN';
  const applyLinkedValue = (raw) => {
    const clamped = clampToInputBounds(valInput, raw);
    slider.value = Math.max(parseFloat(slider.min), Math.min(parseFloat(slider.max), clamped));
    onChangeFn(clamped);
    valInput.value = formatInputValue(valInput, clamped);
    if (livePreview) {
      clearTimeout(previewDebounce);
      previewDebounce = setTimeout(updatePreview, 80);
    }
  };
  slider.addEventListener('input', () => {
    const v = parseFloat(slider.value);
    const display = onChangeFn(v);
    if (isSpan) valInput.textContent = display; else valInput.value = display;
    if (livePreview) {
      clearTimeout(previewDebounce);
      previewDebounce = setTimeout(updatePreview, 80);
    }
  });
  // Double-click resets to default value
  slider.addEventListener('dblclick', () => {
    slider.value = slider.defaultValue;
    const v = parseFloat(slider.value);
    const display = onChangeFn(v);
    if (isSpan) valInput.textContent = display; else valInput.value = display;
    if (livePreview) {
      clearTimeout(previewDebounce);
      previewDebounce = setTimeout(updatePreview, 80);
    }
  });
  if (!isSpan) {
    valInput.addEventListener('change', () => {
      const raw = parseFloat(valInput.value);
      if (isNaN(raw)) { valInput.value = formatInputValue(valInput, parseFloat(slider.value)); return; }
      applyLinkedValue(raw);
    });
    addFineWheelSupport(valInput, applyLinkedValue);
  }
}

function formatM(n) {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} M`
       : n >= 1_000    ? `${(n / 1_000).toFixed(0)} k`
       : String(n);
}

// ── STL loading ───────────────────────────────────────────────────────────────

function loadDefaultCube() {
  // Create a 50×50×50 mm box; convert to non-indexed so it behaves like a
  // real STL (buildAdjacency and displacement expect non-indexed geometry).
  let geo = new THREE.BoxGeometry(50, 50, 50).toNonIndexed();
  geo.computeBoundingBox();
  geo.computeVertexNormals();

  // Invalidate any in-flight async operations tied to the previous model
  precisionToken++;
  cancelDisplacementPreviewBuild();
  exportToken++;

  currentGeometry = geo;
  currentBounds   = computeBounds(geo);
  currentPoseRot   = new THREE.Quaternion(); // authored at the origin — nothing to restore
  currentPoseTrans = new THREE.Vector3();
  currentStlName  = 'cube_50x50x50';
  currentStlExt   = '.stl';
  checkAmplitudeWarning();

  loadGeometry(geo);
  dropHint.classList.add('hidden');

  // Reset displacement preview
  if (dispPreviewGeometry) { dispPreviewGeometry.dispose(); dispPreviewGeometry = null; }
  settings.useDisplacement = false;
  dispPreviewToggle.checked = false;

  // Reset exclusion state
  excludedFaces     = new Set();
  softPaint         = null;
  exclusionTool     = null;
  eraseMode         = false;
  isPainting        = false;
  // Exclude reverts to the neutral (unhighlighted) default; include-only
  // persists across loads and stays highlighted.
  maskModeChosen    = selectionMode;
  updateMaskModeButtons();
  if (placeOnFaceActive) togglePlaceOnFace(false);
  if (rotateActive) toggleRotateMode(false);
  rotateAngles = { x: 0, y: 0, z: 0 };
  rotateXInput.value = '0'; rotateYInput.value = '0'; rotateZInput.value = '0';
  exclBrushBtn.classList.remove('active');
  exclBucketBtn.classList.remove('active');
  exclBrushTypeRow.classList.add('hidden');
  exclRadiusRow.classList.add('hidden');
  exclHardnessRow.classList.add('hidden');
  exclThresholdRow.classList.add('hidden');
  canvas.style.cursor = '';
  setExclusionOverlay(null);
  setHoverPreview(null);
  _lastHoverTriIdx = -1;
  exclCount.textContent = t('excl.initExcluded');

  const adjData = buildAdjacency(geo);
  triangleAdjacency = adjData.adjacency;
  triangleCentroids = adjData.centroids;
  triangleFaceNormals = adjData.faceNormals;
  softPaint = _newSoftLayer(adjData);

  // Pre-calculate an initial tile size that looks nice on this model; from
  // here on the value is absolute (mm) and independent of the model bounds.
  const tileMm = _defaultTileMm();
  settings.scaleU  = tileMm; scaleUSlider.value = scaleToPos(tileMm); scaleUVal.value = fmtScaleVal(tileMm);
  settings.scaleV  = tileMm; scaleVSlider.value = scaleToPos(tileMm); scaleVVal.value = fmtScaleVal(tileMm);
  settings.offsetU = 0; offsetUSlider.value = 0; offsetUVal.value = 0;
  settings.offsetV = 0; offsetVSlider.value = 0; offsetVVal.value = 0;
  triLimitWarning.classList.add('hidden');

  const diag = Math.sqrt(currentBounds.size.x ** 2 + currentBounds.size.y ** 2 + currentBounds.size.z ** 2);
  const defaultEdge = Math.max(0.05, Math.min(5.0, +(diag / 250).toFixed(2)));
  settings.refineLength = defaultEdge;
  refineLenSlider.value = defaultEdge;
  refineLenVal.value = defaultEdge;
  checkResolutionWarning();

  const triCount = getTriangleCount(geo);
  const mb = ((geo.attributes.position.array.byteLength) / 1024 / 1024).toFixed(2);
  const sx = currentBounds.size.x.toFixed(2);
  const sy = currentBounds.size.y.toFixed(2);
  const sz = currentBounds.size.z.toFixed(2);
  _setMeshInfo(triCount, mb, sx, sy, sz);

  exportBtn.disabled = (activeMapEntry === null);
  export3mfBtn.disabled = (activeMapEntry === null);
  bakeBtn.disabled = (activeMapEntry === null);
  updateSmartResBtnState();
  updatePreview();
}

// Import-progress bar (STEP tessellation runs in a worker and can take a
// while on real CAD parts; every other format parses too fast to need this).
function _setImportProgress(stage, fraction) {
  const pct = Math.round(fraction * 100);
  importProgBar.style.width = `${pct}%`;
  importProgPct.textContent = `${pct}%`;
  importProgLbl.textContent = t(stage === 'parse' ? 'progress.stepParse' : 'progress.stepTessellate');
}

// ── STEP import dialog ──────────────────────────────────────────────────────
// Dropping a .step file opens a settings popup first: quality presets that
// scale meshStep's size-adaptive auto tolerances, or Custom with the three
// main tolerances exposed (Fusion-style naming). To change the settings
// later, reload the file — the dialog opens on every STEP import.

let _stepDialogFile = null; // File pending import while the dialog is open
let _stepAutoTol    = null; // { surfaceDeviation, maxEdge } from the worker's size estimate
let _stepEstimateSeq = 0;   // ignores stale estimate responses after reopen/close

function _stepSelectedPreset() {
  return document.querySelector('input[name="step-preset"]:checked').value;
}

// Reflect the effective tolerances into the fields; editable only for Custom.
function _stepUpdateFields() {
  const preset = _stepSelectedPreset();
  const custom = preset === 'custom';
  stepSurfaceDev.disabled = stepNormalDev.disabled = stepMaxEdge.disabled = !custom;
  if (!custom) {
    const tol = resolveStepSettings(_stepAutoTol, { preset });
    stepSurfaceDev.value = +tol.surfaceDeviation.toPrecision(3);
    stepNormalDev.value  = +tol.normalDeviation.toPrecision(3);
    stepMaxEdge.value    = +tol.maxEdge.toPrecision(3);
  }
}

function openStepDialog(file) {
  _stepDialogFile = file;
  _stepAutoTol = null;
  stepModelSize.textContent = '';
  document.querySelector('input[name="step-preset"][value="standard"]').checked = true;
  _stepUpdateFields();
  stepOverlay.classList.remove('hidden');
  trapFocus(stepOverlay);

  // Probe the model size in the worker (also warms it up for the import) and
  // fill in the real auto tolerances once known.
  const mySeq = ++_stepEstimateSeq;
  file.text()
    .then((text) => estimateStep(text))
    .then((r) => {
      if (mySeq !== _stepEstimateSeq || !r) return;
      _stepAutoTol = r.auto;
      if (r.est) stepModelSize.textContent = t('step.modelSize', { d: r.est.diag.toFixed(1) });
      if (_stepSelectedPreset() !== 'custom') _stepUpdateFields();
    })
    .catch(() => {});
}

function closeStepDialog() {
  _stepEstimateSeq++;
  _stepDialogFile = null;
  stepOverlay.classList.add('hidden');
}

let _importSeq = 0; // guards the shared progress bar against superseded imports

async function handleModelFile(file, stepSettings = null) {
  const isStep = /\.(step|stp)$/i.test(file.name);
  // A STEP file without chosen settings goes through the import dialog first;
  // the dialog's Import button re-enters here with settings resolved.
  if (isStep && !stepSettings) {
    openStepDialog(file);
    return;
  }
  _undoApplyDepth++;
  const mySeq = ++_importSeq;
  if (isStep) {
    _setImportProgress('parse', 0);
    importProgress.classList.remove('hidden');
  }
  try {
    const { geometry, bounds, nanCount, degenerateCount, originOffset, step } =
      await loadModelFile(file, { settings: stepSettings, onProgress: _setImportProgress });

    // Invalidate any in-flight async operations tied to the previous model
    precisionToken++;
    cancelDisplacementPreviewBuild();
    exportToken++;
    diagToken++;

    currentGeometry = geometry;
    currentBounds   = bounds;
    currentPoseRot   = new THREE.Quaternion();
    currentPoseTrans = originOffset ? originOffset.clone().negate() : new THREE.Vector3(); // mem = orig − centre
    currentStlName  = file.name.replace(/\.(stl|obj|3mf|step|stp)$/i, '');
    const _extMatch = file.name.match(/\.(stl|obj|3mf|step|stp)$/i);
    currentStlExt   = _extMatch ? _extMatch[0].toLowerCase() : '';
    checkAmplitudeWarning();

    // Surface the STEP conversion verdict without blocking the user.
    if (step && step.diagnostics && !step.diagnostics.ok) {
      const d = step.diagnostics;
      console.warn(
        `STEP conversion imperfect: ${d.openEdges} open edges, ${d.nonManifoldEdges} non-manifold edges, ` +
        `${d.facesDropped} faces dropped, ${d.facesSkipped} faces skipped`, d.warnings);
    }

    // Log (but don't block the user with an alert) if bad triangles were
    // silently removed during load — this is non-critical; the all-invalid
    // case is already thrown as an error by validateAndCleanGeometry.
    const removedCount = (nanCount ?? 0) + (degenerateCount ?? 0);
    if (removedCount > 0) {
      console.warn(`Removed ${nanCount} NaN and ${degenerateCount} degenerate triangles at load time`);
    }

    // Dispose old preview material and reset state for the new mesh
    if (previewMaterial) {
      previewMaterial.dispose();
      previewMaterial = null;
    }

    // Auto-select the default preset on first load, unless a preset is already picked (its
    // texture may still be loading) or a custom map is active.
    if (!activeMapEntry && _activePresetIdx < 0) {
      const idx = IMAGE_PRESETS.findIndex(p => p.name === DEFAULT_PRESET_NAME);
      if (idx >= 0) selectPreset(idx);
    }
    mappingSelect.value = String(settings.mappingMode);
    capAngleRow.style.display = settings.mappingMode === 3 ? '' : 'none';

    // Fresh model → reset cylinder axis to AABB defaults so the gizmo lands on
    // a sensible starting point. (Project snapshot restore overrides this
    // afterwards if it has explicit cylinderCenterX/Y/radius values.)
    settings.cylinderCenterX = null;
    settings.cylinderCenterY = null;
    settings.cylinderRadius  = null;
    _cylSilhouetteCanvas = null;
    _cylSilhouetteGeometry = null;
    _cylSilhouetteAnchor = null;
    updateCylinderUIVisibility();

    // Show mesh with a default material until a map is selected.  Use
    // currentGeometry (not the destructured `geometry`) since the input-clean
    // pass above may have replaced it with a regularized copy.
    loadGeometry(currentGeometry);
    dropHint.classList.add('hidden');

    // Reset displacement preview for the new mesh
    if (dispPreviewGeometry) { dispPreviewGeometry.dispose(); dispPreviewGeometry = null; }
    settings.useDisplacement = false;
    dispPreviewToggle.checked = false;

    // Reset precision masking for the new mesh
    if (precisionGeometry) { precisionGeometry.dispose(); precisionGeometry = null; }
    precisionParentMap  = null;
    precisionEdgeLength = null;
    precisionCentroids  = null;
    precisionFaceNormals = null;
    precisionAdjacency  = null;
    precisionMaskingEnabled = false;
    precisionMaskingToggle.checked = false;
    precisionStatus.textContent = '';
    precisionOutdated.classList.add('hidden');
    precisionRefreshBtn.classList.add('hidden');
    precisionWarning.classList.add('hidden');
    precisionMaskingRow.classList.add('hidden');

    // Reset mesh diagnostics for the new mesh
    meshDiagnostics.classList.add('hidden');
    meshDiagAdvanced.classList.add('hidden');
    lastFastDiag = null;
    lastAdvancedDiag = null;
    clearDiagHighlight();

    // Reset exclusion state for the new mesh
    excludedFaces     = new Set();
    precisionExcludedFaces = new Set();
    softPaint         = null;
    precisionSoftPaint = null;
    precisionPainted = false;
    exclusionTool     = null;
    eraseMode         = false;
    isPainting        = false;
    // Exclude reverts to the neutral (unhighlighted) default; include-only
    // persists across loads and stays highlighted.
    maskModeChosen    = selectionMode;
    updateMaskModeButtons();
    if (placeOnFaceActive) togglePlaceOnFace(false);
    if (rotateActive) toggleRotateMode(false);
    rotateAngles = { x: 0, y: 0, z: 0 };
    rotateXInput.value = '0'; rotateYInput.value = '0'; rotateZInput.value = '0';
    exclBrushBtn.classList.remove('active');
    exclBucketBtn.classList.remove('active');
    exclBrushTypeRow.classList.add('hidden');
    exclRadiusRow.classList.add('hidden');
    exclHardnessRow.classList.add('hidden');
    exclThresholdRow.classList.add('hidden');
    canvas.style.cursor = '';
    setExclusionOverlay(null);
    setHoverPreview(null);
    _lastHoverTriIdx = -1;
    exclCount.textContent = t('excl.initExcluded');
    // Build adjacency data for brush/bucket tools (synchronous; fast enough for
    // typical STL sizes processed by this tool)
    const adjData = buildAdjacency(currentGeometry);
    triangleAdjacency = adjData.adjacency;
    triangleCentroids = adjData.centroids;
    triangleFaceNormals = adjData.faceNormals;
    softPaint = _newSoftLayer(adjData);
    updateMeshDiagnostics(adjData, currentGeometry.attributes.position.count / 3);

    // Carry scale, offset, rotation, and all other tuning across model swaps —
    // they're normalized to the bounding box so they apply meaningfully to the
    // new mesh. Output resolution is the one exception: it's recomputed below
    // from the new model's diagonal so a default-sized edge length still makes
    // sense whether the user just loaded a thumb-sized part or a 1m piece.
    triLimitWarning.classList.add('hidden');

    // Default edge length = 1/250 of the bounding box diagonal
    const diag = Math.sqrt(bounds.size.x ** 2 + bounds.size.y ** 2 + bounds.size.z ** 2);
    const defaultEdge = Math.max(0.05, Math.min(5.0, +(diag / 250).toFixed(2)));
    settings.refineLength = defaultEdge;
    refineLenSlider.value = defaultEdge;
    refineLenVal.value = defaultEdge;
    checkResolutionWarning();

    const triCount = getTriangleCount(currentGeometry);
    const mb = ((currentGeometry.attributes.position.array.byteLength) / 1024 / 1024).toFixed(2);
    const sx = bounds.size.x.toFixed(2);
    const sy = bounds.size.y.toFixed(2);
    const sz = bounds.size.z.toFixed(2);
    _setMeshInfo(triCount, mb, sx, sy, sz);

    exportBtn.disabled = (activeMapEntry === null);
    export3mfBtn.disabled = (activeMapEntry === null);
    updateSmartResBtnState();
    updatePreview();
  } catch (err) {
    // A superseded STEP import (user dropped another file mid-tessellation)
    // is not a failure — the newer load owns the UI now.
    if (!err || !err.stepCancelled) {
      console.error('Failed to load model:', err);
      alert(t('alerts.loadFailed', { msg: err.message }));
    }
  } finally {
    if (isStep && mySeq === _importSeq) importProgress.classList.add('hidden');
    _undoApplyDepth--;
    // Mask indices reference the freshly-loaded triangle set, so any prior
    // history is meaningless for the new geometry.
    _clearUndoStacks();
  }
}

// ── Live preview ──────────────────────────────────────────────────────────────

function checkAmplitudeWarning() {
  if (!currentBounds) return;
  const minDim = Math.min(currentBounds.size.x, currentBounds.size.y, currentBounds.size.z);
  const danger = settings.textureHeight > minDim * 0.1;
  amplitudeWarning.classList.toggle('hidden', !danger);
  amplitudeSlider.classList.toggle('amp-danger', danger);
  amplitudeVal.classList.toggle('amp-danger', danger);
}

// Shell colours — evenly spaced hues, high saturation
const SHELL_COLORS = [0xe6194b, 0x3cb44b, 0x4363d8, 0xf58231, 0x911eb4, 0x42d4f4, 0xf032e6, 0xbfef45, 0xfabed4, 0xdcbeff, 0x9a6324, 0x800000, 0xaaffc3, 0x808000, 0x000075, 0xa9a9a9];

/**
 * Determine the worst severity across fast + advanced diagnostics and apply it
 * to the popup container.  'error' > 'warn' > 'ok'.
 */
function applyDiagSeverity() {
  let severity = 'ok';
  // Several shells / bodies touching each other are normal for multi-part
  // files, so they're informational and don't raise the severity (#125).
  if (lastFastDiag) {
    if (lastFastDiag.openEdges > 0 || lastFastDiag.nonManifoldEdges > 0) severity = 'error';
  }
  if (lastAdvancedDiag) {
    if (lastAdvancedDiag.intersectingPairs > 0) severity = 'error';
    else if (lastAdvancedDiag.overlappingPairs > 0 && severity !== 'error') severity = 'warn';
  }
  meshDiagnostics.classList.remove('diag-ok', 'diag-warn', 'diag-error');
  meshDiagnostics.classList.add('diag-' + severity);
  meshDiagnostics.classList.toggle('diag-corner-tr', severity !== 'ok');
}

function clearDiagHighlight() {
  clearDiagOverlays();
  activeDiagHighlight = null;
  // Reset all toggle buttons in the popup
  meshDiagnostics.querySelectorAll('.diag-show-btn').forEach(btn => {
    btn.textContent = t('diag.show');
  });
}

function toggleDiagHighlight(kind) {
  if (activeDiagHighlight === kind) {
    clearDiagHighlight();
    return;
  }
  clearDiagOverlays();
  activeDiagHighlight = kind;

  // Reset all buttons then mark the active one
  meshDiagnostics.querySelectorAll('.diag-show-btn').forEach(btn => {
    btn.textContent = (btn.dataset.kind === kind) ? t('diag.hide') : t('diag.show');
  });

  if (!currentGeometry) return;

  if (kind === 'openEdges' || kind === 'nonManifold') {
    const edgeData = getEdgePositions(currentGeometry);
    const positions = kind === 'openEdges' ? edgeData.open : edgeData.nonManifold;
    setDiagEdges(positions, 0xff0000);
  } else if (kind === 'shells') {
    const srcPos = currentGeometry.attributes.position.array;
    const srcNrm = currentGeometry.attributes.normal ? currentGeometry.attributes.normal.array : null;
    const triCount = srcPos.length / 9;
    // Shell ids come from the diagnostics run, so they match the reported
    // count; skip if the mesh has been swapped since (precision promotion).
    if (!lastFastDiag || lastFastDiag.triCount !== triCount) return;
    const { shellIds, shellCount } = lastFastDiag;

    for (let s = 0; s < shellCount; s++) {
      // Count triangles in this shell
      let count = 0;
      for (let tt = 0; tt < triCount; tt++) if (shellIds[tt] === s) count++;
      const outPos = new Float32Array(count * 9);
      const outNrm = srcNrm ? new Float32Array(count * 9) : null;
      let dst = 0;
      for (let tt = 0; tt < triCount; tt++) {
        if (shellIds[tt] !== s) continue;
        const src = tt * 9;
        outPos.set(srcPos.subarray(src, src + 9), dst);
        if (outNrm) outNrm.set(srcNrm.subarray(src, src + 9), dst);
        dst += 9;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(outPos, 3));
      if (outNrm) geo.setAttribute('normal', new THREE.BufferAttribute(outNrm, 3));
      addDiagFaces(geo, SHELL_COLORS[s % SHELL_COLORS.length], 0.55);
    }
  } else if (kind === 'intersects' && lastAdvancedDiag && lastAdvancedDiag.intersectFaces) {
    const geo = buildExclusionOverlayGeo(currentGeometry, lastAdvancedDiag.intersectFaces);
    addDiagFaces(geo, 0xff0000, 0.7, true);
  } else if (kind === 'bodyIntersects' && lastAdvancedDiag && lastAdvancedDiag.bodyIntersectFaces) {
    const geo = buildExclusionOverlayGeo(currentGeometry, lastAdvancedDiag.bodyIntersectFaces);
    addDiagFaces(geo, 0xf59e0b, 0.7, true);
  } else if (kind === 'overlaps' && lastAdvancedDiag && lastAdvancedDiag.overlapFaces) {
    const geo = buildExclusionOverlayGeo(currentGeometry, lastAdvancedDiag.overlapFaces);
    addDiagFaces(geo, 0xf59e0b, 0.7);
  }
}

/**
 * Build a single issue line element with a "Show" toggle button.
 * @param {string} text  – the issue description
 * @param {string} kind  – highlight kind key
 * @returns {HTMLElement}
 */
function makeDiagLine(text, kind) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;gap:8px';
  const span = document.createElement('span');
  span.textContent = '\u26a0 ' + text;
  const btn = document.createElement('button');
  btn.className = 'diag-show-btn';
  btn.dataset.kind = kind;
  btn.textContent = activeDiagHighlight === kind ? t('diag.hide') : t('diag.show');
  btn.addEventListener('click', () => toggleDiagHighlight(kind));
  row.appendChild(span);
  row.appendChild(btn);
  return row;
}

function renderFastDiag(diag) {
  meshDiagFast.innerHTML = '';

  const defects = diag.openEdges > 0 || diag.nonManifoldEdges > 0;
  if (!defects) meshDiagFast.textContent = t('diag.meshOk');
  if (diag.openEdges > 0)
    meshDiagFast.appendChild(makeDiagLine(t('diag.openEdges', { n: diag.openEdges }), 'openEdges'));
  if (diag.nonManifoldEdges > 0)
    meshDiagFast.appendChild(makeDiagLine(t('diag.nonManifoldEdges', { n: diag.nonManifoldEdges }), 'nonManifold'));
  if (diag.shellCount > 1)
    meshDiagFast.appendChild(makeDiagLine(t('diag.multipleShells', { n: diag.shellCount }), 'shells'));
  if (defects) {
    const tip = document.createElement('div');
    tip.style.cssText = 'margin-top:4px;opacity:0.8;font-size:10px';
    tip.innerHTML = tHtml('diag.recommendFix');
    meshDiagFast.appendChild(tip);
  }
  applyDiagSeverity();
}

function renderAdvancedDiag(results) {
  meshDiagAdvanced.innerHTML = '';

  const defects = results.intersectingPairs > 0 || results.overlappingPairs > 0;
  if (!defects) meshDiagAdvanced.textContent = t('diag.advancedOk');
  if (results.intersectingPairs > 0)
    meshDiagAdvanced.appendChild(makeDiagLine(t('diag.intersectingTris', { n: results.intersectingPairs }), 'intersects'));
  if (results.overlappingPairs > 0)
    meshDiagAdvanced.appendChild(makeDiagLine(t('diag.overlappingTris', { n: results.overlappingPairs }), 'overlaps'));
  // Separate parts that touch intersect where each side was tessellated on
  // its own — harmless for printing, so informational (#125).
  if (results.bodyIntersectingPairs > 0)
    meshDiagAdvanced.appendChild(makeDiagLine(t('diag.intersectingBodies', { n: results.bodyIntersectingPairs }), 'bodyIntersects'));
  if (defects) {
    const tip = document.createElement('div');
    tip.style.cssText = 'margin-top:4px;opacity:0.8;font-size:10px';
    tip.innerHTML = tHtml('diag.recommendFix');
    meshDiagAdvanced.appendChild(tip);
  }
  applyDiagSeverity();
}

function updateMeshDiagnostics(adjData, triCount) {
  lastFastDiag = runFastDiagnostics(adjData, triCount);
  lastAdvancedDiag = null;
  clearDiagHighlight();
  renderFastDiag(lastFastDiag);

  meshDiagnostics.classList.remove('hidden');
  meshDiagAdvanced.classList.add('hidden');
  meshDiagRunBtn.disabled = false;
}

function checkResolutionWarning() {
  if (!currentBounds) return;
  const diag = Math.sqrt(
    currentBounds.size.x ** 2 +
    currentBounds.size.y ** 2 +
    currentBounds.size.z ** 2
  );
  const tooCoarse = settings.refineLength > diag / 100;
  resolutionWarning.classList.toggle('hidden', !tooCoarse);
  refineLenSlider.classList.toggle('res-warn', tooCoarse);
  refineLenVal.classList.toggle('res-warn', tooCoarse);
}

/**
 * Smart resolution: pick a refineLength based on the active texture's detail
 * and the model's surface area, capped to fit the triangle budget.  Run on
 * demand (button) so the result reflects the most up-to-date texture, mapping,
 * and geometry — i.e. the state the export pipeline will actually consume.
 */
function applySmartResolution() {
  if (!currentGeometry || !currentBounds || !activeMapEntry) return;
  // Use the smoothing-blurred ImageData when textureSmoothing > 0 — that's
  // the data the export pipeline actually samples, and a heavily blurred
  // texture has lower gradients → lower PPE → coarser recommended edge.
  const effective = getEffectiveMapEntry() || activeMapEntry;
  const result = computeSmartResolution({
    geometry: currentGeometry,
    bounds:   currentBounds,
    settings,
    texture:  effective,
  });
  if (!result) return;

  // Apply both values together.  Resolution and max-tri are a matched pair —
  // both are derived from the texture / amplitude / surface area, and the
  // chosen edge assumes decimation will land near `recommendedMaxTri`.
  // Setting them in lockstep means clicking Smart twice is idempotent.
  const d = result.diagnostics;
  settings.refineLength = result.edge;
  refineLenSlider.value = result.edge;
  refineLenVal.value    = result.edge;
  checkResolutionWarning();
  scheduleDisplacementPreviewResolutionRefresh();

  // Set max-tri via the slider's existing input event so settings.maxTriangles
  // and the displayed label stay consistent with all other slider drag paths.
  maxTriSlider.value = d.recommendedMaxTri;
  maxTriSlider.dispatchEvent(new Event('input', { bubbles: true }));

  const maxLabel = formatM(d.recommendedMaxTri);
  const clampedNote = d.budgetClamped
    ? ` <span class="clamped">[${t('ui.smartResBudgetCapped')}]</span>`
    : '';
  smartResInfo.innerHTML = tHtml('ui.smartResInfo', {
    edge: result.edge.toFixed(2),
    ppe:  d.pixelsPerEdge.toFixed(1),
    pix:  d.pixMm.toFixed(3),
    area: (d.surfaceArea / 100).toFixed(0),  // cm²
    tris: maxLabel,
  }) + clampedNote;
  smartResInfo.classList.remove('hidden');
}

function updateSmartResBtnState() {
  if (!smartResBtn) return;
  smartResBtn.disabled = !(currentGeometry && activeMapEntry);
}

if (smartResBtn) smartResBtn.addEventListener('click', applySmartResolution);

/**
 * Set (or update) the `faceMask` vertex attribute on a geometry.
 * 1.0 = textured, 0.0 = user-excluded, in between = soft-brush paint.
 * Angle masking stays in the shader.
 *
 * Always creates a fresh Float32BufferAttribute so that Three.js allocates a
 * new WebGL buffer and uploads the current data.  This avoids subtle buffer-
 * caching issues where in-place array edits + needsUpdate could keep stale
 * GPU data on some drivers.
 *
 * forceFalloff: recompute the boundary falloff even while a masking tool is
 * active (a freshly built precision mesh needs it for its initial state).
 */
function updateFaceMask(geometry, { forceFalloff = false } = {}) {
  if (!geometry) return;
  const posCount = geometry.attributes.position.count;
  const triCount = posCount / 3;

  // Reuse existing buffer if length matches exactly, otherwise allocate new
  const existing = geometry.getAttribute('faceMask');
  const reuseBuffer = existing && existing.array.length === posCount;
  const maskArr = reuseBuffer ? existing.array : new Float32Array(posCount);

  // Determine which face set to check
  const isPrecision = (geometry === precisionGeometry && precisionMaskingEnabled);
  const faceSet = isPrecision ? precisionExcludedFaces : excludedFaces;
  const isDisp = (geometry === dispPreviewGeometry && dispPreviewParentMap);
  const softCorners = _softCornersFor(geometry, isPrecision, isDisp);
  // Binary hard mask for the boundary-falloff passes — soft paint only fades
  // the texture, it never forms a mask boundary. Same array as maskArr unless
  // soft paint made that fractional.
  let hardMaskArr = maskArr;

  // Fast path: no user exclusion active
  if (faceSet.size === 0 && !selectionMode && !softCorners) {
    maskArr.fill(1.0);
  } else if (!softCorners) {
    for (let t = 0; t < triCount; t++) {
      // For precision geometry, t is already a precision face index.
      // For disp preview, map through dispPreviewParentMap to original.
      // Otherwise t is already an original face index.
      const faceIdx = isDisp ? dispPreviewParentMap[t] : t;
      const excluded = selectionMode ? !faceSet.has(faceIdx) : faceSet.has(faceIdx);
      const val = excluded ? 0.0 : 1.0;
      maskArr[t * 3]     = val;
      maskArr[t * 3 + 1] = val;
      maskArr[t * 3 + 2] = val;
    }
  } else {
    hardMaskArr = new Float32Array(posCount);
    for (let t = 0; t < triCount; t++) {
      const faceIdx = isDisp ? dispPreviewParentMap[t] : t;
      const painted = faceSet.has(faceIdx);
      const i = t * 3;
      const s0 = softCorners[i], s1 = softCorners[i + 1], s2 = softCorners[i + 2];
      // Exclude mode: paint masks. Include-only: paint textures, and a face
      // is hard-masked only when neither hard nor soft paint reaches it.
      let hardMasked;
      if (selectionMode) {
        maskArr[i] = painted ? 1 : s0; maskArr[i + 1] = painted ? 1 : s1; maskArr[i + 2] = painted ? 1 : s2;
        hardMasked = !painted && s0 === 0 && s1 === 0 && s2 === 0;
      } else {
        maskArr[i] = painted ? 0 : 1 - s0; maskArr[i + 1] = painted ? 0 : 1 - s1; maskArr[i + 2] = painted ? 0 : 1 - s2;
        hardMasked = painted;
      }
      const h = hardMasked ? 0 : 1;
      hardMaskArr[i] = hardMaskArr[i + 1] = hardMaskArr[i + 2] = h;
    }
  }

  if (reuseBuffer) {
    existing.needsUpdate = true;
  } else {
    geometry.setAttribute('faceMask', new THREE.Float32BufferAttribute(maskArr, 1));
  }

  // Ensure faceNormal attribute exists (needed by shader for angle masking).
  // For the original geometry normal == faceNormal; for subdivided geometry
  // addFaceNormals() is called after subdivision, but guard here in case the
  // attribute is still missing.
  if (!geometry.attributes.faceNormal) {
    addFaceNormals(geometry);
  }

  // Ensure falloff attributes exist so the shader doesn't read 0.0 for missing
  // attributes (which would make totalMask = 0 → entire model appears masked).
  // This matters when a fresh geometry is displayed while the masking tool is
  // active (e.g. entering precision mode) because the expensive recomputation
  // below is intentionally skipped during active masking.
  if (!geometry.attributes.boundaryFalloffAttr) {
    const arr = new Float32Array(posCount);
    arr.fill(1.0);
    geometry.setAttribute('boundaryFalloffAttr', new THREE.Float32BufferAttribute(arr, 1));
  }
  if (!geometry.attributes.boundaryMaskTypeAttr) {
    const arr = new Float32Array(posCount);
    arr.fill(1.0);
    geometry.setAttribute('boundaryMaskTypeAttr', new THREE.Float32BufferAttribute(arr, 1));
  }

  // Skip expensive per-vertex falloff and boundary edge recomputation while
  // actively masking; both will be recalculated when the masking tool is
  // deactivated (in setExclusionTool → updateFaceMask with exclusionTool=null).
  if (forceFalloff || (!exclusionTool && (_falloffDirty || geometry !== _falloffGeometry))) {
    computeBoundaryFalloffAttr(geometry, hardMaskArr);
    if (!exclusionTool) computeBoundaryEdges(geometry, hardMaskArr);
    _falloffDirty = false;
    _falloffGeometry = geometry;
  }
  syncBoundaryEdgeUniforms();
  requestRender();
}

/**
 * Set the boundary-falloff transition curve, sync the segmented buttons, and
 * refresh the preview. Mirrors displacement.js and the fragment shader in
 * previewMaterial.js — all three must use the same curve definitions.
 */
function setFalloffCurve(mode) {
  if (!(mode in falloffCurveButtons)) mode = 'linear';
  settings.boundaryFalloffCurve = mode;
  for (const [m, btn] of Object.entries(falloffCurveButtons)) {
    btn.classList.toggle('active', m === mode);
    btn.setAttribute('aria-pressed', String(m === mode));
  }
  _falloffDirty = true;
  updatePreview();
}

/** Shape the linear 0→1 falloff ramp per settings.boundaryFalloffCurve. */
function applyFalloffCurve(t) {
  const mode = settings.boundaryFalloffCurve;
  if (mode === 'scurve') return t * t * (3 - 2 * t);
  if (mode === 'ease')   return t * t;
  return t;
}

/**
 * Compute a per-vertex `boundaryFalloffAttr` float attribute on the geometry.
 * Vertices near the boundary between masked and non-masked regions get values
 * ramping from 0 (at boundary) to 1 (at or beyond boundaryFalloff distance).
 * The shader multiplies displacement/bump by this attribute.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {Float32Array}         userMaskArr – per-vertex user-exclusion mask from updateFaceMask
 */
function computeBoundaryFalloffAttr(geometry, userMaskArr) {
  const posAttr = geometry.attributes.position;
  const posCount = posAttr.count;
  const triCount = posCount / 3;
  const falloff = settings.boundaryFalloff ?? 0;

  // Reuse existing attribute buffers when sizes match to avoid Three.js
  // WebGL binding state cache issues when replacing attribute objects on
  // a geometry that is already attached to a rendered mesh.
  const existingFalloff = geometry.getAttribute('boundaryFalloffAttr');
  const reuseFalloff = existingFalloff && existingFalloff.array.length === posCount;
  const falloffArr = reuseFalloff ? existingFalloff.array : new Float32Array(posCount);
  falloffArr.fill(1.0);

  const existingType = geometry.getAttribute('boundaryMaskTypeAttr');
  const reuseType = existingType && existingType.array.length === posCount;
  const maskTypeArr = reuseType ? existingType.array : new Float32Array(posCount);
  maskTypeArr.fill(1.0);

  if (falloff <= 0) {
    if (reuseFalloff) existingFalloff.needsUpdate = true;
    else geometry.setAttribute('boundaryFalloffAttr', new THREE.Float32BufferAttribute(falloffArr, 1));
    if (reuseType) existingType.needsUpdate = true;
    else geometry.setAttribute('boundaryMaskTypeAttr', new THREE.Float32BufferAttribute(maskTypeArr, 1));
    return;
  }

  // Compute per-face combined mask (angle masking + user exclusion).
  // Mirrors the vertex shader logic so the preview boundary matches export.
  const faceNrmAttr = geometry.attributes.faceNormal;
  const faceMask = new Float32Array(triCount); // 0 = masked, 1 = textured
  const isUserMasked = new Uint8Array(triCount); // 1 if user-excluded
  for (let t = 0; t < triCount; t++) {
    const userVal = userMaskArr[t * 3]; // same for all 3 verts of this face
    if (userVal < 0.5) { faceMask[t] = 0; isUserMasked[t] = 1; continue; }

    let angleMask = 1.0;
    if (faceNrmAttr) {
      const fnz = faceNrmAttr.getZ(t * 3);
      const fnx = faceNrmAttr.getX(t * 3);
      const fny = faceNrmAttr.getY(t * 3);
      const len = Math.sqrt(fnx * fnx + fny * fny + fnz * fnz);
      const nz = len > 1e-6 ? fnz / len : 0;
      const surfaceAngle = Math.acos(Math.min(1, Math.abs(nz))) * (180 / Math.PI);
      if (nz < 0 && settings.bottomAngleLimit >= 1)
        angleMask = surfaceAngle > settings.bottomAngleLimit ? 1.0 : 0.0;
      if (nz >= 0 && settings.topAngleLimit >= 1)
        angleMask = Math.min(angleMask, surfaceAngle > settings.topAngleLimit ? 1.0 : 0.0);
    }
    faceMask[t] = angleMask;
  }

  // Weld vertices to unique-position ids and accumulate per-id areas.
  // Arrays are pre-sized to posCount (upper bound on unique count); extra
  // tail slots stay unused — same pattern as displacement.js.
  const QUANT = 1e4;
  const weldMap = new QuantizedPointMap(QUANT, Math.min(posCount, 1 << 22));
  let nUnique = 0;
  const vertId = new Uint32Array(posCount);
  const idPosX = new Float64Array(posCount);  // first-occurrence position per id
  const idPosY = new Float64Array(posCount);
  const idPosZ = new Float64Array(posCount);
  const maskedArea   = new Float64Array(posCount);
  const totalArea    = new Float64Array(posCount);
  const userMaskArea = new Float64Array(posCount);
  const tmpV = new THREE.Vector3();
  const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), fn = new THREE.Vector3();

  for (let t = 0; t < triCount; t++) {
    vA.fromBufferAttribute(posAttr, t * 3);
    vB.fromBufferAttribute(posAttr, t * 3 + 1);
    vC.fromBufferAttribute(posAttr, t * 3 + 2);
    e1.subVectors(vB, vA);
    e2.subVectors(vC, vA);
    fn.crossVectors(e1, e2);
    const area = fn.length();
    const masked = faceMask[t] < 0.5;

    for (let v = 0; v < 3; v++) {
      tmpV.fromBufferAttribute(posAttr, t * 3 + v);
      const id = weldMap.getOrSet(tmpV.x, tmpV.y, tmpV.z, nUnique);
      if (weldMap.inserted) {
        nUnique++;
        idPosX[id] = tmpV.x; idPosY[id] = tmpV.y; idPosZ[id] = tmpV.z;
      }
      vertId[t * 3 + v] = id;
      if (masked) maskedArea[id] += area;
      totalArea[id] += area;
      // Track user-mask area per position to classify boundary type
      if (isUserMasked[t]) userMaskArea[id] += area;
    }
  }

  // Boundary positions: shared between masked and non-masked faces.
  // Each entry: [x, y, z, maskType] where maskType 0 = user, 1 = angle.
  const boundaryPositions = [];
  for (let id = 0; id < nUnique; id++) {
    const frac = totalArea[id] > 0 ? maskedArea[id] / totalArea[id] : 0;
    if (frac > 0 && frac < 1) {
      boundaryPositions.push([idPosX[id], idPosY[id], idPosZ[id], userMaskArea[id] > 0 ? 0 : 1]);
    }
  }

  if (boundaryPositions.length === 0) {
    if (reuseFalloff) existingFalloff.needsUpdate = true;
    else geometry.setAttribute('boundaryFalloffAttr', new THREE.Float32BufferAttribute(falloffArr, 1));
    if (reuseType) existingType.needsUpdate = true;
    else geometry.setAttribute('boundaryMaskTypeAttr', new THREE.Float32BufferAttribute(maskTypeArr, 1));
    return;
  }

  // Spatial grid of boundary positions for fast nearest-neighbor search
  let gMinX = Infinity, gMinY = Infinity, gMinZ = Infinity;
  let gMaxX = -Infinity, gMaxY = -Infinity, gMaxZ = -Infinity;
  for (const bp of boundaryPositions) {
    if (bp[0] < gMinX) gMinX = bp[0]; if (bp[0] > gMaxX) gMaxX = bp[0];
    if (bp[1] < gMinY) gMinY = bp[1]; if (bp[1] > gMaxY) gMaxY = bp[1];
    if (bp[2] < gMinZ) gMinZ = bp[2]; if (bp[2] > gMaxZ) gMaxZ = bp[2];
  }
  const gPad = falloff + 1e-3;
  gMinX -= gPad; gMinY -= gPad; gMinZ -= gPad;
  gMaxX += gPad; gMaxY += gPad; gMaxZ += gPad;

  const gRes = Math.max(4, Math.min(128, Math.ceil(Math.cbrt(boundaryPositions.length) * 2)));
  const gDx = (gMaxX - gMinX) / gRes || 1;
  const gDy = (gMaxY - gMinY) / gRes || 1;
  const gDz = (gMaxZ - gMinZ) / gRes || 1;
  const bGrid = new Map();
  const bCellKey = (ix, iy, iz) => (ix * gRes + iy) * gRes + iz;

  for (const bp of boundaryPositions) {
    const ix = Math.max(0, Math.min(gRes - 1, Math.floor((bp[0] - gMinX) / gDx)));
    const iy = Math.max(0, Math.min(gRes - 1, Math.floor((bp[1] - gMinY) / gDy)));
    const iz = Math.max(0, Math.min(gRes - 1, Math.floor((bp[2] - gMinZ) / gDz)));
    const ck = bCellKey(ix, iy, iz);
    const cell = bGrid.get(ck);
    if (cell) cell.push(bp); else bGrid.set(ck, [bp]);
  }

  const searchX = Math.ceil(falloff / gDx);
  const searchY = Math.ceil(falloff / gDy);
  const searchZ = Math.ceil(falloff / gDz);

  // Compute per-unique-position falloff factor and mask type.
  // -1 = unset (keep the 1.0 default written into the attribute arrays).
  const falloffById  = new Float32Array(nUnique).fill(-1);
  const maskTypeById = new Float32Array(nUnique).fill(-1);
  for (let id = 0; id < nUnique; id++) {
    const frac = totalArea[id] > 0 ? maskedArea[id] / totalArea[id] : 0;
    if (frac >= 1) continue; // fully masked vertex — keep 1.0 (mask zeroes it anyway)
    // Boundary vertices (shared between masked and unmasked faces) are AT
    // the boundary → distance 0 → falloff factor 0.
    if (frac > 0) {
      falloffById[id] = 0;
      maskTypeById[id] = userMaskArea[id] > 0 ? 0 : 1;
      continue;
    }

    const px = idPosX[id], py = idPosY[id], pz = idPosZ[id];
    const cix = Math.max(0, Math.min(gRes - 1, Math.floor((px - gMinX) / gDx)));
    const ciy = Math.max(0, Math.min(gRes - 1, Math.floor((py - gMinY) / gDy)));
    const ciz = Math.max(0, Math.min(gRes - 1, Math.floor((pz - gMinZ) / gDz)));

    let minDist2 = falloff * falloff;
    let nearestType = 1; // default: angle mask
    for (let dix = -searchX; dix <= searchX; dix++) {
      const nix = cix + dix;
      if (nix < 0 || nix >= gRes) continue;
      for (let diy = -searchY; diy <= searchY; diy++) {
        const niy = ciy + diy;
        if (niy < 0 || niy >= gRes) continue;
        for (let diz = -searchZ; diz <= searchZ; diz++) {
          const niz = ciz + diz;
          if (niz < 0 || niz >= gRes) continue;
          const cell = bGrid.get(bCellKey(nix, niy, niz));
          if (!cell) continue;
          for (const bp of cell) {
            const dx = px - bp[0], dy = py - bp[1], dz = pz - bp[2];
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < minDist2) { minDist2 = d2; nearestType = bp[3]; }
          }
        }
      }
    }
    const dist = Math.sqrt(minDist2);
    const factor = Math.min(1, dist / falloff);
    if (factor < 1) {
      falloffById[id] = applyFalloffCurve(factor);
      maskTypeById[id] = nearestType;
    }
  }

  // Write per-vertex attributes via the welded id (no re-keying pass)
  for (let i = 0; i < posCount; i++) {
    const id = vertId[i];
    if (falloffById[id] >= 0) falloffArr[i] = falloffById[id];
    if (maskTypeById[id] >= 0) maskTypeArr[i] = maskTypeById[id];
  }

  if (reuseFalloff) existingFalloff.needsUpdate = true;
  else geometry.setAttribute('boundaryFalloffAttr', new THREE.Float32BufferAttribute(falloffArr, 1));
  if (reuseType) existingType.needsUpdate = true;
  else geometry.setAttribute('boundaryMaskTypeAttr', new THREE.Float32BufferAttribute(maskTypeArr, 1));
}

/**
 * Compute boundary edge segments between masked and non-masked faces and
 * pack them into a DataTexture for per-fragment distance queries in the
 * bump-only preview shader.  Each edge is stored as two RGBA texels
 * (endpoint A xyz, endpoint B xyz).
 */
function computeBoundaryEdges(geometry, userMaskArr) {
  const posAttr = geometry.attributes.position;
  const posCount = posAttr.count;
  const triCount = posCount / 3;
  const falloff = settings.boundaryFalloff ?? 0;

  if (_boundaryEdgeTex) { _boundaryEdgeTex.dispose(); _boundaryEdgeTex = null; }
  _boundaryEdgeCount = 0;
  if (falloff <= 0) return;

  const faceNrmAttr = geometry.attributes.faceNormal;
  const faceMaskBool = new Uint8Array(triCount);
  for (let t = 0; t < triCount; t++) {
    if (userMaskArr[t * 3] < 0.5) { faceMaskBool[t] = 0; continue; }
    let angleMask = 1.0;
    if (faceNrmAttr) {
      const fnx = faceNrmAttr.getX(t * 3);
      const fny = faceNrmAttr.getY(t * 3);
      const fnz = faceNrmAttr.getZ(t * 3);
      const len = Math.sqrt(fnx * fnx + fny * fny + fnz * fnz);
      const nz = len > 1e-6 ? fnz / len : 0;
      const surfAngle = Math.acos(Math.min(1, Math.abs(nz))) * (180 / Math.PI);
      if (nz < 0 && settings.bottomAngleLimit >= 1)
        angleMask = surfAngle > settings.bottomAngleLimit ? 1.0 : 0.0;
      if (nz >= 0 && settings.topAngleLimit >= 1)
        angleMask = Math.min(angleMask, surfAngle > settings.topAngleLimit ? 1.0 : 0.0);
    }
    faceMaskBool[t] = angleMask > 0.5 ? 1 : 0;
  }

  const QUANT = 1e4;
  const weldMap = new QuantizedPointMap(QUANT, Math.min(posCount, 1 << 22));
  let nUnique = 0;
  const tmpV = new THREE.Vector3();

  const edgeFaces = new Map();   // numeric edge key → [face, ...]
  const edgePos   = new Map();   // numeric edge key → [[x,y,z], [x,y,z]]
  // ids < posCount, so a*posCount+b is collision-free below ~94M vertices
  // (same bound as exclusion.js numEdgeKey).
  const EKM = posCount;
  const ids = new Uint32Array(3);
  const ptx = new Float64Array(3), pty = new Float64Array(3), ptz = new Float64Array(3);

  for (let t = 0; t < triCount; t++) {
    for (let v = 0; v < 3; v++) {
      tmpV.fromBufferAttribute(posAttr, t * 3 + v);
      const id = weldMap.getOrSet(tmpV.x, tmpV.y, tmpV.z, nUnique);
      if (weldMap.inserted) nUnique++;
      ids[v] = id; ptx[v] = tmpV.x; pty[v] = tmpV.y; ptz[v] = tmpV.z;
    }
    for (let e = 0; e < 3; e++) {
      const e2 = (e + 1) % 3;
      const a = ids[e], b = ids[e2];
      const edgeKey = a < b ? a * EKM + b : b * EKM + a;
      const list = edgeFaces.get(edgeKey);
      if (list) list.push(t);
      else {
        edgeFaces.set(edgeKey, [t]);
        edgePos.set(edgeKey, [[ptx[e], pty[e], ptz[e]], [ptx[e2], pty[e2], ptz[e2]]]);
      }
    }
  }

  const MAX_EDGES = 64;
  const edges = [];
  for (const [key, faces] of edgeFaces) {
    if (edges.length >= MAX_EDGES) break;
    let hasMasked = false, hasTextured = false;
    for (const f of faces) {
      if (faceMaskBool[f] === 0) hasMasked = true;
      else hasTextured = true;
      if (hasMasked && hasTextured) break;
    }
    if (hasMasked && hasTextured) edges.push(edgePos.get(key));
  }

  if (edges.length === 0) return;

  const texWidth = edges.length * 2;
  const data = new Float32Array(texWidth * 4);
  for (let i = 0; i < edges.length; i++) {
    const [a, b] = edges[i];
    const off = i * 8;
    data[off] = a[0]; data[off + 1] = a[1]; data[off + 2] = a[2]; data[off + 3] = 0;
    data[off + 4] = b[0]; data[off + 5] = b[1]; data[off + 6] = b[2]; data[off + 7] = 0;
  }

  _boundaryEdgeTex = new THREE.DataTexture(data, texWidth, 1, THREE.RGBAFormat, THREE.FloatType);
  _boundaryEdgeTex.minFilter = THREE.NearestFilter;
  _boundaryEdgeTex.magFilter = THREE.NearestFilter;
  _boundaryEdgeTex.needsUpdate = true;
  _boundaryEdgeCount = edges.length;
}

function syncBoundaryEdgeUniforms() {
  if (!previewMaterial || !previewMaterial.uniforms.boundaryEdgeTex) return;
  const u = previewMaterial.uniforms;
  if (_boundaryEdgeTex) {
    u.boundaryEdgeTex.value = _boundaryEdgeTex;
    u.boundaryEdgeTexWidth.value = _boundaryEdgeTex.image.width;
  }
  u.boundaryEdgeCount.value = _boundaryEdgeCount;
  u.boundaryFalloffDist.value = settings.boundaryFalloff ?? 0;
}

/**
 * Build a mapping from each subdivided face to its nearest original face
 * using a grid-accelerated nearest-centroid lookup, with face normal
 * tiebreaking to prevent boundary faces from being mapped to the wrong
 * original face (e.g. a subdivided face on a cube edge mapped to the
 * adjacent face instead of the correct one).
 */
function buildParentFaceMap(subdivGeo) {
  if (!triangleCentroids || !currentGeometry) return null;

  const origPos = currentGeometry.attributes.position.array;
  const origTriCount = currentGeometry.attributes.position.count / 3;
  const subPos = subdivGeo.attributes.position.array;
  const subTriCount = subdivGeo.attributes.position.count / 3;

  // Precompute original face normals
  const origNormals = new Float32Array(origTriCount * 3);
  const _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3(), _fn = new THREE.Vector3();
  for (let t = 0; t < origTriCount; t++) {
    const b = t * 9;
    _e1.set(origPos[b + 3] - origPos[b], origPos[b + 4] - origPos[b + 1], origPos[b + 5] - origPos[b + 2]);
    _e2.set(origPos[b + 6] - origPos[b], origPos[b + 7] - origPos[b + 1], origPos[b + 8] - origPos[b + 2]);
    _fn.crossVectors(_e1, _e2).normalize();
    origNormals[t * 3] = _fn.x; origNormals[t * 3 + 1] = _fn.y; origNormals[t * 3 + 2] = _fn.z;
  }

  // Bounding box of original centroids
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < origTriCount; i++) {
    const cx = triangleCentroids[i * 3], cy = triangleCentroids[i * 3 + 1], cz = triangleCentroids[i * 3 + 2];
    if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
    if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
    if (cz < minZ) minZ = cz; if (cz > maxZ) maxZ = cz;
  }
  const pad = 1e-3;
  minX -= pad; minY -= pad; minZ -= pad;
  maxX += pad; maxY += pad; maxZ += pad;

  const res = Math.max(4, Math.min(128, Math.ceil(Math.cbrt(origTriCount) * 2)));
  const dx = (maxX - minX) / res || 1;
  const dy = (maxY - minY) / res || 1;
  const dz = (maxZ - minZ) / res || 1;

  // Build spatial grid of original centroids
  const grid = new Map();
  const cellKey = (ix, iy, iz) => (ix * res + iy) * res + iz;
  for (let i = 0; i < origTriCount; i++) {
    const cx = triangleCentroids[i * 3], cy = triangleCentroids[i * 3 + 1], cz = triangleCentroids[i * 3 + 2];
    const ix = Math.max(0, Math.min(res - 1, Math.floor((cx - minX) / dx)));
    const iy = Math.max(0, Math.min(res - 1, Math.floor((cy - minY) / dy)));
    const iz = Math.max(0, Math.min(res - 1, Math.floor((cz - minZ) / dz)));
    const k = cellKey(ix, iy, iz);
    const cell = grid.get(k);
    if (cell) cell.push(i); else grid.set(k, [i]);
  }

  // For each subdivided face, find nearest original face by centroid distance
  // with face-normal tiebreaking to resolve boundary ambiguity.
  const parentMap = new Int32Array(subTriCount);
  for (let st = 0; st < subTriCount; st++) {
    const base = st * 9;
    const sx = (subPos[base] + subPos[base + 3] + subPos[base + 6]) / 3;
    const sy = (subPos[base + 1] + subPos[base + 4] + subPos[base + 7]) / 3;
    const sz = (subPos[base + 2] + subPos[base + 5] + subPos[base + 8]) / 3;

    // Subdivided face normal
    _e1.set(subPos[base + 3] - subPos[base], subPos[base + 4] - subPos[base + 1], subPos[base + 5] - subPos[base + 2]);
    _e2.set(subPos[base + 6] - subPos[base], subPos[base + 7] - subPos[base + 1], subPos[base + 8] - subPos[base + 2]);
    _fn.crossVectors(_e1, _e2).normalize();
    const snx = _fn.x, sny = _fn.y, snz = _fn.z;

    const ix = Math.max(0, Math.min(res - 1, Math.floor((sx - minX) / dx)));
    const iy = Math.max(0, Math.min(res - 1, Math.floor((sy - minY) / dy)));
    const iz = Math.max(0, Math.min(res - 1, Math.floor((sz - minZ) / dz)));

    let bestDist = Infinity, bestIdx = 0;
    // Two-pass: prefer original faces whose normal aligns with the subdivided
    // face (dot > 0.4 ≈ within ~66°), then among those pick the nearest
    // centroid.  This prevents boundary faces at sharp seams (cube edges etc.)
    // from being mapped to the adjacent face even when that face's centroid
    // happens to be closer.  Falls back to pure nearest-centroid if no
    // normal-matching candidate is found.
    let bestDistAligned = Infinity, bestIdxAligned = -1;
    for (let dix = -1; dix <= 1; dix++) {
      for (let diy = -1; diy <= 1; diy++) {
        for (let diz = -1; diz <= 1; diz++) {
          const nix = ix + dix, niy = iy + diy, niz = iz + diz;
          if (nix < 0 || nix >= res || niy < 0 || niy >= res || niz < 0 || niz >= res) continue;
          const cell = grid.get(cellKey(nix, niy, niz));
          if (!cell) continue;
          for (const oi of cell) {
            const cdx = sx - triangleCentroids[oi * 3];
            const cdy = sy - triangleCentroids[oi * 3 + 1];
            const cdz = sz - triangleCentroids[oi * 3 + 2];
            const centroidDist = cdx * cdx + cdy * cdy + cdz * cdz;
            if (centroidDist < bestDist) { bestDist = centroidDist; bestIdx = oi; }
            const dot = snx * origNormals[oi * 3] + sny * origNormals[oi * 3 + 1] + snz * origNormals[oi * 3 + 2];
            if (dot > 0.4 && centroidDist < bestDistAligned) {
              bestDistAligned = centroidDist; bestIdxAligned = oi;
            }
          }
        }
      }
    }

    // If the local grid search didn't find a normal-aligned original face
    // (common for sparse original meshes like cubes where face centroids
    // are far from the grid cell of a corner-adjacent subdivided face),
    // fall back to a brute-force scan over ALL original faces.
    if (bestIdxAligned < 0) {
      for (let oi = 0; oi < origTriCount; oi++) {
        const cdx = sx - triangleCentroids[oi * 3];
        const cdy = sy - triangleCentroids[oi * 3 + 1];
        const cdz = sz - triangleCentroids[oi * 3 + 2];
        const centroidDist = cdx * cdx + cdy * cdy + cdz * cdz;
        if (centroidDist < bestDist) { bestDist = centroidDist; bestIdx = oi; }
        const dot = snx * origNormals[oi * 3] + sny * origNormals[oi * 3 + 1] + snz * origNormals[oi * 3 + 2];
        if (dot > 0.4 && centroidDist < bestDistAligned) {
          bestDistAligned = centroidDist; bestIdxAligned = oi;
        }
      }
    }
    parentMap[st] = bestIdxAligned >= 0 ? bestIdxAligned : bestIdx;
  }

  return parentMap;
}

function getEffectiveMapEntry() {
  if (!activeMapEntry || (settings.textureSmoothing === 0 && !settings.invertTexture)) {
    _effectiveMapCache    = null;
    _effectiveMapCacheKey = null;
    return activeMapEntry;
  }
  const { fullCanvas, width, height, name } = activeMapEntry;
  const cacheKey = `${name}_${width}_${height}_${settings.textureSmoothing}_${settings.invertTexture}`;
  // Two uploads can share a file name and size, so also check it was derived from this very map.
  if (_effectiveMapCacheKey === cacheKey && _effectiveMapCache?.fullCanvas === fullCanvas) {
    return _effectiveMapCache;
  }
  const offscreen = document.createElement('canvas');
  offscreen.width  = width;
  offscreen.height = height;
  const ctx = offscreen.getContext('2d');
  if (settings.textureSmoothing > 0) {
    // The slider is in pixels of a 512 px map; custom maps can be up to
    // 2048 px (#89), so scale the radius to blur the same share of the tile.
    const sigma = settings.textureSmoothing * Math.max(1, Math.max(width, height) / REF_TEXTURE_SIZE);
    // Surround the tile with wrapped copies of itself before blurring so edge
    // pixels have correct neighbours and the blurred centre tile is seamlessly
    // tileable. A 4σ margin covers the blur kernel; capping it (instead of a
    // full 3×3 tiling) keeps a 2048 px map under iOS's ~16.7 Mpx canvas limit.
    const padX = Math.min(width,  Math.ceil(4 * sigma) + 2);
    const padY = Math.min(height, Math.ceil(4 * sigma) + 2);
    const tiled = document.createElement('canvas');
    tiled.width  = width  + 2 * padX;
    tiled.height = height + 2 * padY;
    const tc = tiled.getContext('2d');
    for (let row = -1; row <= 1; row++) {
      for (let col = -1; col <= 1; col++) {
        tc.drawImage(fullCanvas, padX + col * width, padY + row * height);
      }
    }
    // Blur the padded canvas, then crop out only the centre tile.
    blurCanvas(tiled, sigma);
    ctx.drawImage(tiled, padX, padY, width, height, 0, 0, width, height);
  } else {
    ctx.drawImage(fullCanvas, 0, 0);
  }
  const imageData = ctx.getImageData(0, 0, width, height);
  if (settings.invertTexture) {
    // Invert the height map itself; amplitude still controls push/pull direction.
    // Both the GPU preview and CPU bake/export consume these same pixels.
    const pixels = imageData.data;
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i]     = 255 - pixels[i];
      pixels[i + 1] = 255 - pixels[i + 1];
      pixels[i + 2] = 255 - pixels[i + 2];
      // Height sampling ignores alpha. Keep the processed map opaque so
      // Canvas2D preserves the same RGB values used by CPU bake/export.
      pixels[i + 3] = 255;
    }
    ctx.putImageData(imageData, 0, 0);
  }
  const texture   = new THREE.CanvasTexture(offscreen);
  texture.wrapS   = texture.wrapT = THREE.RepeatWrapping;
  if (_lastEffectiveTexture) _lastEffectiveTexture.dispose();
  _lastEffectiveTexture = texture;
  _effectiveMapCache    = { ...activeMapEntry, imageData, texture };
  _effectiveMapCacheKey = cacheKey;
  return _effectiveMapCache;
}

// Build the regularize.js opts object from current settings.  Centralised so
// preview / export / bake stay in sync with the Advanced-panel debug knobs.
function _regularizeOpts() {
  return {
    aspectThreshold:           settings.regularizeAspectThreshold,
    slack:                     settings.regularizeSlack,
    aggressiveSlack:           settings.regularizeAggressiveSlack,
    extremeSliverAspect:       settings.regularizeExtremeAspect,
    maxNormalDeltaCos:         Math.cos(settings.regularizeNormalDeg          * Math.PI / 180),
    aggressiveNormalDeltaCos:  Math.cos(settings.regularizeAggressiveNormalDeg * Math.PI / 180),
    // Preserve-untextured beta: freezes excludeWeight-marked faces. Inert on
    // geometry without the attribute (e.g. the displacement-preview path).
    preserveExcluded:          settings.preserveUntextured,
  };
}

// Settings snapshot for the preview material's uniforms.
function _materialSettings() {
  // Texture aspect correction so non-square textures keep their proportions.
  // A 512×279 texture needs aspectV = 512/279 ≈ 1.84 so V tiles faster (more
  // repetitions), making each tile shorter in world-space to match the texture's
  // wider-than-tall content.  The wider axis gets aspect = 1 (unchanged).
  const tw = activeMapEntry?.width ?? 1, th = activeMapEntry?.height ?? 1;
  const tmax = Math.max(tw, th, 1);
  return {
    ...settings,
    bounds: currentBounds,
    textureAspectU: tmax / Math.max(tw, 1),
    textureAspectV: tmax / Math.max(th, 1),
    // The displaced mesh exists only once its async build finishes; until
    // then the base mesh keeps bump-only shading.
    useDisplacement: settings.useDisplacement && !!dispPreviewGeometry,
  };
}

function updatePreview() {
  if (!currentGeometry || !currentBounds) return;

  const fullSettings = _materialSettings();

  if (!activeMapEntry) {
    // No map yet — plain material
    if (previewMaterial) {
      setMeshMaterial(null);
      previewMaterial.dispose();
      previewMaterial = null;
    }
    exportBtn.disabled = true;
    export3mfBtn.disabled = true;
    bakeBtn.disabled = true;
    updateSmartResBtnState();
    return;
  }

  // Choose geometry: precision mode → subdivided preview → original
  const activeGeo = (precisionMaskingEnabled && precisionGeometry)
    ? precisionGeometry
    : (settings.useDisplacement && dispPreviewGeometry)
      ? dispPreviewGeometry
      : currentGeometry;

  // Ensure faceMask attribute is current before rendering
  updateFaceMask(activeGeo);

  const effectiveEntry = getEffectiveMapEntry();

  if (!previewMaterial) {
    previewMaterial = createPreviewMaterial(effectiveEntry.texture, fullSettings);
    loadGeometry(activeGeo, previewMaterial);
  } else {
    updateMaterial(previewMaterial, effectiveEntry.texture, fullSettings);
  }

  syncBoundaryEdgeUniforms();
  exportBtn.disabled = false;
  export3mfBtn.disabled = false;
  bakeBtn.disabled = isBaking;
  updateSmartResBtnState();
}

// ── Displacement preview ──────────────────────────────────────────────────────

/**
 * Set flat geometric face normals as a `faceNormal` attribute (the shader's
 * angle masking reads them — see computeFaceNormals in previewPipeline.js).
 */
function addFaceNormals(geometry) {
  const fn = computeFaceNormals(geometry.attributes.position.array);
  geometry.setAttribute('faceNormal', new THREE.Float32BufferAttribute(fn, 3));
}

// ── Precision masking ─────────────────────────────────────────────────────────

/** Compute the target max edge length from the brush diameter. */
function computePrecisionEdgeLength(brushDiameter) {
  // ~20 edge segments around the brush circumference, clamped to a sane floor
  let edge = Math.PI * brushDiameter / 20;
  // Soft brushes paint per vertex: aim for ~4 edges across the fade band,
  // but refine at most 2× beyond the hard-brush mesh.
  if (brushHardness < 1) {
    const band = (1 - brushHardness) * brushDiameter / 2;
    edge = Math.max(edge / 2, Math.min(edge, band / 4));
  }
  return Math.max(0.05, edge);
}

/**
 * Estimate how many triangles subdivision will produce for a given edge length.
 * Uses a sample of existing edges to compute average edge length, then
 * assumes area-proportional subdivision: triCount × (avgEdge / target)².
 */
function estimateSubdivisionTriCount(geometry, targetEdge) {
  const pos = geometry.attributes.position;
  const triCount = pos.count / 3;
  // Sample up to 3000 edges (1000 triangles × 3 edges)
  const sampleTris = Math.min(triCount, 1000);
  let totalEdgeLen = 0;
  let edgeCount = 0;
  for (let t = 0; t < sampleTris; t++) {
    const i = t * 3;
    for (let e = 0; e < 3; e++) {
      const a = i + e, b = i + (e + 1) % 3;
      const dx = pos.getX(a) - pos.getX(b);
      const dy = pos.getY(a) - pos.getY(b);
      const dz = pos.getZ(a) - pos.getZ(b);
      totalEdgeLen += Math.sqrt(dx * dx + dy * dy + dz * dz);
      edgeCount++;
    }
  }
  if (edgeCount === 0) return triCount;
  const avgEdge = totalEdgeLen / edgeCount;
  const ratio = avgEdge / targetEdge;
  return Math.max(triCount, Math.round(triCount * ratio * ratio));
}

/** Deactivate precision masking and bake the refined mesh as the new base geometry. */
function deactivatePrecisionMasking() {
  const promoted = !!precisionGeometry;
  if (precisionGeometry) {
    // Bake: the precision geometry becomes the new currentGeometry
    if (currentGeometry && currentGeometry !== precisionGeometry) {
      currentGeometry.dispose();
    }
    currentGeometry = precisionGeometry;

    // Promote precision adjacency data to the base adjacency
    triangleAdjacency   = precisionAdjacency;
    triangleCentroids   = precisionCentroids;
    triangleFaceNormals = precisionFaceNormals;

    // Promote precision excluded faces and soft paint to the base
    excludedFaces = precisionExcludedFaces;
    softPaint = precisionSoftPaint;

    // Update mesh info display
    const triCount = getTriangleCount(currentGeometry);
    const mb = ((currentGeometry.attributes.position.array.byteLength) / 1024 / 1024).toFixed(2);
    const sx = currentBounds.size.x.toFixed(2);
    const sy = currentBounds.size.y.toFixed(2);
    const sz = currentBounds.size.z.toFixed(2);
    _setMeshInfo(triCount, mb, sx, sy, sz);
  } else if (precisionExcludedFaces.size > 0 && precisionParentMap) {
    // No precision geometry but have selections — map back to original
    excludedFaces = new Set();
    for (const pf of precisionExcludedFaces) {
      excludedFaces.add(precisionParentMap[pf]);
    }
  }

  // Clear all precision state
  precisionExcludedFaces = new Set();
  precisionSoftPaint  = null;
  precisionPainted    = false;
  precisionGeometry   = null;
  precisionParentMap  = null;
  precisionEdgeLength = null;
  precisionCentroids  = null;
  precisionFaceNormals = null;
  precisionAdjacency  = null;
  precisionMaskingEnabled = false;
  precisionMaskingToggle.checked = false;
  precisionStatus.textContent = '';
  precisionOutdated.classList.add('hidden');
  precisionRefreshBtn.classList.add('hidden');
  precisionWarning.classList.add('hidden');
  if (currentGeometry) {
    setMeshGeometry(currentGeometry);
    updateFaceMask(currentGeometry);
    if (excludedFaces.size > 0 || _layerHasPaint(softPaint)) refreshExclusionOverlay();
    else setExclusionOverlay(null);
  }

  // Promoting the precision mesh re-tessellates currentGeometry, so undo
  // snapshots reference the pre-promotion triangle set. Applying one of them
  // afterwards scatters the mask across the new tessellation (issue #61) —
  // clear the history, same as bake does.
  if (promoted) _clearUndoStacks();
}

/** Refresh (or initially build) the precision mesh from current brush size. */
async function refreshPrecisionMesh() {
  if (!currentGeometry || precisionBusy) return;

  // A refresh re-seeds from the base mesh, which would drop every stroke
  // painted on the current refined mesh. Promote that mesh to the base first
  // (the same bake as turning precision off) so the new one inherits it.
  if (precisionGeometry && precisionPainted) {
    deactivatePrecisionMasking();
    precisionMaskingEnabled = true;
    precisionMaskingToggle.checked = true;
  }

  const brushDiameter = parseFloat(exclBrushRadiusSlider.value);
  const targetEdge = computePrecisionEdgeLength(brushDiameter);

  // Estimate triangle count and warn if > 8M (threshold raised June 2026 —
  // the typed-array subdivision is ~2× faster with far less GC churn, so the
  // point where a confirm is warranted moved up accordingly)
  const estimated = estimateSubdivisionTriCount(currentGeometry, targetEdge);
  if (estimated > 8_000_000) {
    const estLabel = (estimated / 1_000_000).toFixed(1) + 'M';
    const msg = t('precision.warningBody', { n: estLabel });
    if (!confirm(msg)) return;
  }

  const myToken = ++precisionToken;
  precisionBusy = true;
  precisionStatus.textContent = t('precision.refining');
  precisionOutdated.classList.add('hidden');
  precisionRefreshBtn.classList.add('hidden');
  precisionWarning.classList.add('hidden');

  try {
    await yieldFrame();
    if (precisionToken !== myToken) return;

    const { geometry: subdivided, safetyCapHit, faceParentId } = await subdivide(
      currentGeometry, targetEdge, null, null, { fast: true }
    );
    if (precisionToken !== myToken) { subdivided.dispose(); return; }

    // Dispose previous precision geometry if any
    if (precisionGeometry) precisionGeometry.dispose();
    precisionGeometry  = subdivided;
    precisionParentMap = faceParentId;
    precisionEdgeLength = targetEdge;

    // Build adjacency data for the refined mesh
    const adjData = buildAdjacency(precisionGeometry);
    precisionAdjacency   = adjData.adjacency;
    precisionCentroids   = adjData.centroids;
    precisionFaceNormals = adjData.faceNormals;
    precisionSoftPaint   = _newSoftLayer(adjData);

    // Seed the refined mesh's hard and soft paint from the base mesh
    _seedPrecisionFromBase();

    // Swap display mesh to refined geometry. Force the per-vertex falloff on
    // the fresh geometry even though the masking tool is still active — it's
    // normally deferred until the tool is deactivated, but we need it now for
    // the initial state.
    setMeshGeometry(precisionGeometry);
    updateFaceMask(precisionGeometry, { forceFalloff: true });
    if (precisionExcludedFaces.size > 0 || _layerHasPaint(precisionSoftPaint)) refreshExclusionOverlay();
    else setExclusionOverlay(null);

    // Update status label
    const triCount = precisionGeometry.attributes.position.count / 3;
    const triLabel = triCount >= 1_000_000
      ? (triCount / 1_000_000).toFixed(1) + 'M'
      : triCount >= 1_000
        ? (triCount / 1_000).toFixed(0) + 'k'
        : String(triCount);
    precisionStatus.textContent = t('precision.triCount', { n: triLabel });

    // Update mesh info in the lower-left corner
    const mb = ((precisionGeometry.attributes.position.array.byteLength) / 1024 / 1024).toFixed(2);
    const sx = currentBounds.size.x.toFixed(2);
    const sy = currentBounds.size.y.toFixed(2);
    const sz = currentBounds.size.z.toFixed(2);
    _setMeshInfo(triCount, mb, sx, sy, sz);

    if (safetyCapHit) {
      triLimitWarning.classList.remove('hidden');
    }
  } catch (err) {
    console.error('Precision masking subdivision failed:', err);
    deactivatePrecisionMasking();
  } finally {
    precisionBusy = false;
  }
}

/** Toggle precision masking on/off. */
async function togglePrecisionMasking(enable) {
  if (enable) {
    // Mutually exclusive with displacement preview
    if (settings.useDisplacement) {
      settings.useDisplacement = false;
      dispPreviewToggle.checked = false;
      await toggleDisplacementPreview(false);
    }
    precisionMaskingEnabled = true;
    await refreshPrecisionMesh();
    // If refresh was cancelled (e.g. user declined warning), revert
    if (!precisionGeometry) {
      precisionMaskingEnabled = false;
      precisionMaskingToggle.checked = false;
    }
  } else {
    deactivatePrecisionMasking();
  }
}

/** Show/hide the "outdated" badge when brush size changes while precision is active. */
function checkPrecisionOutdated() {
  if (!precisionMaskingEnabled || !precisionEdgeLength) return;
  const neededEdge = computePrecisionEdgeLength(parseFloat(exclBrushRadiusSlider.value));
  // Show outdated if the needed edge is significantly smaller than current
  // (brush shrank → mesh too coarse for the new brush size)
  if (neededEdge < precisionEdgeLength * 0.8) {
    precisionOutdated.classList.remove('hidden');
    precisionRefreshBtn.classList.remove('hidden');
  } else {
    precisionOutdated.classList.add('hidden');
    precisionRefreshBtn.classList.add('hidden');
  }
}

/**
 * Toggle displacement preview on/off.
 * When enabled: builds a refined copy of the current geometry in the preview
 * worker (previewPipeline.js) and switches the viewer to it with vertex-
 * shader displacement.  The bump-only preview stays interactive meanwhile.
 * When disabled: reverts to the original geometry with bump-only preview.
 */
async function toggleDisplacementPreview(enable) {
  settings.useDisplacement = enable;

  // Exit surface masking mode when the 3D preview is activated
  if (enable && exclusionTool) {
    setExclusionTool(null);
  }

  // Deactivate precision masking when displacement preview is activated
  if (enable && precisionMaskingEnabled) {
    deactivatePrecisionMasking();
  }

  // Supersede any in-flight build (a re-enable restarts it).
  cancelDisplacementPreviewBuild();

  if (!enable) {
    // Revert to original geometry with bump-only shading.
    if (currentGeometry && previewMaterial) {
      updateMaterial(previewMaterial, getEffectiveMapEntry()?.texture, { ...settings, bounds: currentBounds });
      updateFaceMask(currentGeometry);
      setMeshGeometry(currentGeometry);
    }
    // Dispose the subdivided preview geometry (no longer on the mesh)
    if (dispPreviewGeometry) {
      dispPreviewGeometry.dispose();
      dispPreviewGeometry = null;
    }
    dispPreviewParentMap = null;
    dispPreviewEdgeInfo = null;
    return;
  }

  // Need a model and texture to subdivide
  if (!currentGeometry || !currentBounds || !activeMapEntry) {
    dispPreviewToggle.checked = false;
    settings.useDisplacement = false;
    return;
  }

  const myToken = dispPreviewToken;
  dispPreviewSpinner.classList.remove('hidden');

  try {
    // Edge length: as fine as the export resolution, coarsened to fit the
    // triangle budget, never coarser than the legacy maxDim/80 (which gave
    // a 50 mm cube ~0.6 mm edges).
    const maxDim = Math.max(currentBounds.size.x, currentBounds.size.y, currentBounds.size.z);
    const maxEdge = Math.max(0.1, maxDim / 80);
    const floorEdge = settings.refineLength;
    dispPreviewEdgeInfo = { floorEdge, maxEdge, edge: null };

    const result = await runPreviewBuild({
      positions:      currentGeometry.attributes.position.array,
      normals:        currentGeometry.attributes.normal?.array ?? null,
      floorEdge, maxEdge, triBudget: PREVIEW_TRI_BUDGET,
      regularize:     settings.regularizeEnabled,
      regularizeOpts: _regularizeOpts(),
      secondPassMul:  settings.regularizeSecondPassMul,
      excludedFaces:  _previewExcludedFaces(),
    }, () => dispPreviewToken !== myToken);
    if (!result || dispPreviewToken !== myToken) return;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position',     new THREE.BufferAttribute(result.positions, 3));
    geo.setAttribute('normal',       new THREE.BufferAttribute(result.normals, 3));
    geo.setAttribute('smoothNormal', new THREE.BufferAttribute(result.smoothNormals, 3));
    geo.setAttribute('faceNormal',   new THREE.BufferAttribute(result.faceNormals, 3));

    // Dispose previous preview geometry if any
    if (dispPreviewGeometry) dispPreviewGeometry.dispose();
    dispPreviewGeometry = geo;
    dispPreviewEdgeInfo.edge = result.edge;

    // Use the face parent IDs tracked through subdivision (O(n) instead of spatial search)
    dispPreviewParentMap = result.faceParentId;
    updateFaceMask(geo);

    // Force material recreation so it binds the new geometry with smoothNormal
    if (previewMaterial) {
      previewMaterial.dispose();
      previewMaterial = null;
    }
    previewMaterial = createPreviewMaterial(getEffectiveMapEntry()?.texture, _materialSettings());
    setMeshGeometry(dispPreviewGeometry);
    setMeshMaterial(previewMaterial);
  } catch (err) {
    if (dispPreviewToken !== myToken) return;
    console.error('Displacement preview failed:', err);
    dispPreviewToggle.checked = false;
    settings.useDisplacement = false;
    dispPreviewEdgeInfo = null;
  } finally {
    if (dispPreviewToken === myToken) dispPreviewSpinner.classList.add('hidden');
  }
}

/**
 * Invalidate any in-flight 3D-preview build: bump the token so its result is
 * dropped, and terminate the worker so it stops burning CPU on it.
 */
function cancelDisplacementPreviewBuild() {
  dispPreviewToken++;
  if (_previewWorkerAbort) _previewWorkerAbort();
  dispPreviewSpinner.classList.add('hidden');
}

/**
 * Per-source-face flags (1 = untextured) for the preview's second subdivide,
 * so masked surfaces aren't refined — they won't be displaced anyway.  The
 * shader handles the mask itself, so this is only an optimisation.
 */
function _previewExcludedFaces() {
  if (excludedFaces.size === 0 && !selectionMode) return null;
  const triCount = currentGeometry.attributes.position.count / 3;
  const flags = new Uint8Array(triCount);
  // Include-only: soft-painted faces get (partial) texture too
  const softFaces = (selectionMode && _layerHasPaint(softPaint))
    ? softPaintedFaces(softPaint.vertId, softPaint.values) : null;
  for (let f = 0; f < triCount; f++) {
    let isExcluded = excludedFaces.has(f);
    if (selectionMode) isExcluded = !isExcluded && !(softFaces && softFaces[f]);
    if (isExcluded) flags[f] = 1;
  }
  return flags;
}

// The preview edge follows the export resolution (see toggleDisplacementPreview),
// so rebuild an active 3D preview once the resolution settles on a value that
// would change it.  Debounced: slider drags and wheel steps fire per step.
function scheduleDisplacementPreviewResolutionRefresh() {
  clearTimeout(_dispPreviewResolutionTimer);
  _dispPreviewResolutionTimer = setTimeout(() => {
    const info = dispPreviewEdgeInfo;
    if (!settings.useDisplacement || !info) return;
    const newFloor = settings.refineLength;
    if (Math.min(newFloor, info.maxEdge) === Math.min(info.floorEdge, info.maxEdge)) return;
    // A finished build that the budget (not the resolution) limited only
    // changes if the new resolution is coarser than the edge it used.
    if (info.edge !== null && info.edge > info.floorEdge && newFloor <= info.edge) return;
    toggleDisplacementPreview(true);
  }, 400);
}

// ── Export pipeline ───────────────────────────────────────────────────────────

/**
 * Builds per-non-indexed-vertex weights (1.0 = excluded from subdivision/displacement)
 * that combine the user-painted exclusion set AND the top/bottom angle mask.
 */
function buildCombinedFaceWeights(geometry, excludedFaces, invert, settings, softFaces = null) {
  const weights = buildFaceWeights(geometry, excludedFaces, invert, softFaces);

  const hasAngleMask = settings.bottomAngleLimit > 0 || settings.topAngleLimit > 0;
  if (!hasAngleMask) return weights;

  const posAttr = geometry.attributes.position;
  const triCount = posAttr.count / 3;
  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const vC = new THREE.Vector3();
  const edge1 = new THREE.Vector3();
  const edge2 = new THREE.Vector3();
  const faceNrm = new THREE.Vector3();

  for (let t = 0; t < triCount; t++) {
    if (weights[t * 3] > 0.99) continue; // already excluded
    vA.fromBufferAttribute(posAttr, t * 3);
    vB.fromBufferAttribute(posAttr, t * 3 + 1);
    vC.fromBufferAttribute(posAttr, t * 3 + 2);
    edge1.subVectors(vB, vA);
    edge2.subVectors(vC, vA);
    faceNrm.crossVectors(edge1, edge2);
    const faceArea  = faceNrm.length();
    const faceNzNorm = faceArea > 1e-12 ? faceNrm.z / faceArea : 0;
    const faceAngle  = Math.acos(Math.abs(faceNzNorm)) * (180 / Math.PI);
    const angleMasked = faceNzNorm < 0
      ? (settings.bottomAngleLimit > 0 && faceAngle <= settings.bottomAngleLimit)
      : (settings.topAngleLimit    > 0 && faceAngle <= settings.topAngleLimit);
    if (angleMasked) {
      weights[t * 3]     = 1.0;
      weights[t * 3 + 1] = 1.0;
      weights[t * 3 + 2] = 1.0;
    }
  }
  return weights;
}

/**
 * Map flat position/normal arrays from the in-app working space back to the
 * model's original file pose: orig = poseRot⁻¹ · (mem − poseTrans). Undoes
 * both the import centering and any in-app rotation, so exports align with
 * the untouched source file (issue #82). Normals get the rotation only.
 */
function _restoreOriginalPose(positions, normals = null) {
  const t = currentPoseTrans;
  // Unit quaternion with |w| ≈ 1 is the identity rotation (either cover) —
  // pure-translation fast path, and normals stay untouched.
  if (Math.abs(currentPoseRot.w) > 1 - 1e-12) {
    if (t.x === 0 && t.y === 0 && t.z === 0) return;
    for (let i = 0; i < positions.length; i += 3) {
      positions[i]     -= t.x;
      positions[i + 1] -= t.y;
      positions[i + 2] -= t.z;
    }
    return;
  }
  const rotInv = currentPoseRot.clone().invert();
  const v = new THREE.Vector3();
  for (let i = 0; i < positions.length; i += 3) {
    v.set(positions[i] - t.x, positions[i + 1] - t.y, positions[i + 2] - t.z).applyQuaternion(rotInv);
    positions[i]     = v.x;
    positions[i + 1] = v.y;
    positions[i + 2] = v.z;
  }
  if (normals) {
    for (let i = 0; i < normals.length; i += 3) {
      v.set(normals[i], normals[i + 1], normals[i + 2]).applyQuaternion(rotInv);
      normals[i]     = v.x;
      normals[i + 1] = v.y;
      normals[i + 2] = v.z;
    }
  }
}

async function handleExport(format = 'stl') {
  if (!currentGeometry || !activeMapEntry || isExporting || isBaking) return;
  const myToken = ++exportToken;
  isExporting = true;
  exportBtn.classList.add('busy');
  export3mfBtn.classList.add('busy');
  exportProgress.classList.remove('hidden');

  let finalGeometry   = null;
  let exportSucceeded = false; // set true only after exportSTL so finally can clean up on abort/error

  try {
    // If precision masking is active, bake the refined mesh before exporting.
    // Inside the try so a failure here still releases the busy state in finally.
    if (precisionMaskingEnabled) {
      deactivatePrecisionMasking();
    }

    setProgress(0.02, t('progress.subdividing'));
    await yieldFrame();
    if (exportToken !== myToken) return;

    // Build per-vertex exclusion weights combining user-painted exclusion + angle masking.
    // Faces masked by top/bottom angle limits are treated the same as user-excluded faces
    // so subdivision skips their interior edges too, saving triangles where no
    // displacement will be applied. Soft-brush paint rides along separately.
    const { faceWeights, softExclude } = _pipelineMaskInputs();

    // Run the heavy pipeline (subdivide → regularize → displace → decimate →
    // bottom snaps → repair), preferably in the export worker so the UI stays
    // responsive and background-tab throttling can't stall it. Falls back to
    // running inline if the worker can't initialise. See exportPipeline.js.
    const exportEntry = getEffectiveMapEntry();
    const isStale = () => exportToken !== myToken;
    const result = await runPipeline({
      positions: currentGeometry.attributes.position.array,
      faceWeights,
      softExclude,
      imageData: exportEntry.imageData,
      imgWidth: exportEntry.width,
      imgHeight: exportEntry.height,
      settings,
      bounds: currentBounds,
      regularizeOpts: _regularizeOpts(),
      mode: 'export',
    }, _onExportPipelineEvent, isStale);
    if (!result || isStale()) return;

    const exportWarnings = [];
    if (result.safetyCapHit) exportWarnings.push(t('warnings.safetyCapHit'));
    if (result.lockedOverBudget) exportWarnings.push(t('warnings.preserveOverBudget'));
    triLimitWarning.classList.toggle('hidden', exportWarnings.length === 0);
    triLimitWarning.textContent = exportWarnings.join(' ');

    // Map the pipeline output back to the model's original position and
    // orientation (issue #82) — in-app rotation is a texturing aid and is
    // reverted here. The pipeline itself runs in the working space, so this
    // must stay after runPipeline — and outside of it, keeping the
    // bench-pipeline fingerprint valid. result arrays are fresh; mutating is safe.
    _restoreOriginalPose(result.positions, result.normals);

    finalGeometry = new THREE.BufferGeometry();
    finalGeometry.setAttribute('position', new THREE.BufferAttribute(result.positions, 3));
    if (result.normals) finalGeometry.setAttribute('normal', new THREE.BufferAttribute(result.normals, 3));

    if (result.repairStats) {
      const rs = result.repairStats;
      // Ground-truth readout. The decisive number is `slivers`: zero-area
      // "needle" triangles read as watertight here but every slicer (and our
      // own importer) deletes them, punching a hole at each — that was the
      // real cause of the open-edge warning on re-imported files. After
      // repair both `slivers` and `open` must be 0.
      console.log(
        `%c[stlTexturizer] mesh repair (build 2026-06-10w): ` +
        `removed ${rs.beforeSlivers.toLocaleString()} zero-area slivers; ` +
        `final open=${rs.open}, non-manifold=${rs.nonManifold}, slivers=${rs.slivers} ` +
        `(${rs.tris.toLocaleString()} tris)`,
        'color:#0a0;font-weight:bold'
      );
    }

    const texLabel = activeMapEntry.isCustom ? 'custom' : activeMapEntry.name.replace(/\s+/g, '-');
    const ampLabel = settings.amplitude.toFixed(2).replace('.', 'p');
    const baseName = `${currentStlName}_${texLabel}_amp${ampLabel}`;

    if (format === '3mf') {
      setProgress(0.97, t('progress.writing3mf'));
      await yieldFrame();
      if (exportToken !== myToken) return;
      await export3MF(finalGeometry, `${baseName}.3mf`, () => exportToken !== myToken);
    } else {
      setProgress(0.97, t('progress.writingStl'));
      await yieldFrame();
      if (exportToken !== myToken) return;
      exportSTL(finalGeometry, `${baseName}.stl`);
    }
    exportSucceeded = true;

    setProgress(1.0, t('progress.done'));
    setTimeout(() => {
      exportProgress.classList.add('hidden');
      setProgress(0, '');
    }, 1500);
  } catch (err) {
    if (exportToken !== myToken) return;
    console.error('Export failed:', err);
    if (/maximum size|out of memory|alloc/i.test(err.message)) {
      alert(t('alerts.exportOOM'));
    } else {
      alert(t('alerts.exportFailed', { msg: err.message }));
    }
  } finally {
    // Intermediate geometries live inside the pipeline (worker or inline) and
    // are disposed there; only the reconstructed output remains on this side.
    if (finalGeometry) finalGeometry.dispose();
    // Hide progress immediately on error or stale abort; success hides it after 1500 ms.
    if (!exportSucceeded) exportProgress.classList.add('hidden');
    isExporting = false;
    exportBtn.classList.remove('busy');
    export3mfBtn.classList.remove('busy');
  }
}

// ── Pipeline progress mapping (worker events → progress bar) ────────────────
// Same fractions and labels as the old inline pipeline.

function _onExportPipelineEvent(stage, p, info) {
  switch (stage) {
    case 'subdivide1': {
      const label = info && info.triCount != null
        ? t('progress.refining', { cur: info.triCount.toLocaleString(), edge: info.longestEdge.toFixed(2) })
        : t('progress.subdividing');
      setProgress(0.02 + p * 0.28, label);
      break;
    }
    case 'regularize':
      setProgress(0.30, t('progress.regularizing'));
      break;
    case 'subdivide2': {
      const label = info && info.triCount != null
        ? t('progress.refining', { cur: info.triCount.toLocaleString(), edge: info.longestEdge.toFixed(2) })
        : t('progress.subdividing');
      setProgress(0.32 + p * 0.06, label);
      break;
    }
    case 'displace':
      if (p === 0) setProgress(0.38, t('progress.applyingDisplacement', { n: info.triCount.toLocaleString() }));
      else setProgress(0.38 + p * 0.32, t('progress.displacingVertices'));
      break;
    case 'decimate':
      if (info.needsDecimation) {
        if (p === 0) {
          setProgress(0.71, t('progress.decimatingTo', { from: info.from.toLocaleString(), to: settings.maxTriangles.toLocaleString() }));
        } else {
          const cur = Math.round(info.from - (info.from - settings.maxTriangles) * p);
          setProgress(0.71 + p * 0.25, t('progress.decimating', { cur: cur.toLocaleString(), to: settings.maxTriangles.toLocaleString() }));
        }
      } else {
        setProgress(0.71 + p * 0.25, t('progress.harvestingFlat'));
      }
      break;
    case 'repair':
      setProgress(0.96, t('progress.repairingMesh'));
      break;
  }
}

function _onBakePipelineEvent(stage, p, info) {
  switch (stage) {
    case 'subdivide1': {
      const label = info && info.triCount != null
        ? t('progress.refining', { cur: info.triCount.toLocaleString(), edge: info.longestEdge.toFixed(2) })
        : t('progress.subdividing');
      setBakeProgress(0.02 + p * 0.34, label);
      break;
    }
    case 'regularize':
      setBakeProgress(0.36, t('progress.regularizing'));
      break;
    case 'subdivide2': {
      const label = info && info.triCount != null
        ? t('progress.refining', { cur: info.triCount.toLocaleString(), edge: info.longestEdge.toFixed(2) })
        : t('progress.subdividing');
      setBakeProgress(0.38 + p * 0.09, label);
      break;
    }
    case 'displace':
      if (p === 0) setBakeProgress(0.47, t('progress.applyingDisplacement', { n: info.triCount.toLocaleString() }));
      else setBakeProgress(0.47 + p * 0.40, t('progress.displacingVertices'));
      break;
  }
}

// ── Export worker management ─────────────────────────────────────────────────
// One persistent module worker runs the export/bake pipeline off the main
// thread. If it can't initialise (very old browser, CDN unreachable from the
// worker) the pipeline runs inline exactly as before — same module, same code.

let _pipelineWorker = null;
let _pipelineWorkerFailed = false; // hard init failure → stop retrying
let _pipelineWorkerInit = null;    // in-flight init promise (warmup + export may race)

// Resolve the cached worker, initialising it at most once. Returns null when
// the worker can't run here (the caller then uses the inline pipeline).
function ensurePipelineWorker() {
  if (_pipelineWorkerFailed) return Promise.resolve(null);
  if (_pipelineWorker) return Promise.resolve(_pipelineWorker);
  if (!_pipelineWorkerInit) {
    _pipelineWorkerInit = _initWorker(new URL('./exportWorker.js', import.meta.url)).then(
      (w) => { _pipelineWorker = w; _pipelineWorkerInit = null; return w; },
      (err) => {
        _pipelineWorkerFailed = true;
        _pipelineWorkerInit = null;
        console.warn('[stlTexturizer] export worker unavailable — running pipeline on the main thread:', err.message);
        return null;
      }
    );
  }
  return _pipelineWorkerInit;
}

// Warm the worker up during idle time after load: the worker boot includes
// fetching three.js (workers ignore the page import map), and doing that now
// keeps it off the first export's critical path.
{
  const warm = () => { ensurePipelineWorker(); };
  const schedule = () => {
    if ('requestIdleCallback' in window) requestIdleCallback(warm, { timeout: 8000 });
    else setTimeout(warm, 3000);
  };
  if (document.readyState === 'complete') schedule();
  else window.addEventListener('load', schedule, { once: true });
}

// Start a module worker and resolve once it posts {type:'ready'} (its static
// imports, incl. three.js, have loaded). Shared by the export and preview workers.
function _initWorker(url) {
  return new Promise((resolve, reject) => {
    let w;
    try {
      w = new Worker(url, { type: 'module' });
    } catch (err) {
      reject(err);
      return;
    }
    const fail = (msg) => { try { w.terminate(); } catch {} reject(new Error(msg)); };
    const timer = setTimeout(() => fail('worker init timeout'), 20000);
    w.onmessage = (e) => {
      if (e.data && e.data.type === 'ready') {
        clearTimeout(timer);
        w.onmessage = null;
        w.onerror = null;
        resolve(w);
      }
    };
    w.onerror = (e) => { clearTimeout(timer); fail((e && e.message) || 'worker failed to load'); };
  });
}

async function runPipeline(input, onEvent, isStale) {
  // Prefer the worker. Fall back to inline ONLY on init failure — a pipeline
  // error inside the worker (e.g. OOM) must propagate to the caller's alert,
  // not silently re-run the same doomed job on the main thread.
  const w = await ensurePipelineWorker();
  if (isStale()) return null;
  if (!w) {
    return runExportPipeline(input, onEvent, isStale);
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => { w.onmessage = null; w.onerror = null; };
    const kill = () => { cleanup(); try { w.terminate(); } catch {} _pipelineWorker = null; };
    w.onmessage = (e) => {
      const m = e.data;
      if (isStale()) { kill(); resolve(null); return; } // aborted → stop the worker's CPU burn
      if (m.type === 'progress') onEvent(m.stage, m.p, m.info);
      else if (m.type === 'done') { cleanup(); resolve(m.result); }
      else if (m.type === 'error') { cleanup(); reject(new Error(m.message)); }
    };
    w.onerror = (e) => { kill(); reject(new Error((e && e.message) || 'export worker crashed')); };
    w.postMessage({ cmd: 'run', input });
  });
}

// ── 3D-preview worker ──────────────────────────────────────────────────────
// Its own worker (previewWorker.js) so a preview build never queues behind or
// gets killed with an export. Started lazily on the first preview build.
let _previewWorker = null;
let _previewWorkerFailed = false;
let _previewWorkerInit = null;

function ensurePreviewWorker() {
  if (_previewWorkerFailed) return Promise.resolve(null);
  if (_previewWorker) return Promise.resolve(_previewWorker);
  if (!_previewWorkerInit) {
    _previewWorkerInit = _initWorker(new URL('./previewWorker.js', import.meta.url)).then(
      (w) => { _previewWorker = w; _previewWorkerInit = null; return w; },
      (err) => {
        _previewWorkerFailed = true;
        _previewWorkerInit = null;
        console.warn('[stlTexturizer] preview worker unavailable — building the 3D preview on the main thread:', err.message);
        return null;
      }
    );
  }
  return _previewWorkerInit;
}

async function runPreviewBuild(input, isStale) {
  const w = await ensurePreviewWorker();
  if (isStale()) return null;
  if (!w) {
    // The main-thread fallback freezes the UI for the whole build, so keep
    // the legacy coarse edge there.
    return runPreviewPipeline({ ...input, floorEdge: input.maxEdge }, undefined, isStale);
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => { w.onmessage = null; w.onerror = null; _previewWorkerAbort = null; };
    const kill = () => { cleanup(); try { w.terminate(); } catch {} if (_previewWorker === w) _previewWorker = null; };
    _previewWorkerAbort = () => { kill(); resolve(null); };
    w.onmessage = (e) => {
      const m = e.data;
      if (isStale()) { kill(); resolve(null); return; }
      if (m.type === 'done') { cleanup(); resolve(m.result); }
      else if (m.type === 'error') { cleanup(); reject(new Error(m.message)); }
    };
    w.onerror = (e) => { kill(); reject(new Error((e && e.message) || 'preview worker crashed')); };
    w.postMessage({ cmd: 'run', input });
  });
}

function setProgress(fraction, label) {
  const pct = Math.round(fraction * 100);
  exportProgBar.style.width = `${pct}%`;
  exportProgPct.textContent = `${pct}%`;
  exportProgLbl.textContent = label;
}

// ── Smooth Bottom (advanced feature) ────────────────────────────────────────
// Snaps every vertex within `tol` of the bottom plane onto it, so the bed-
// contact surface comes out perfectly flat — implementation lives in
// exportPipeline.js (snapBottomToFlat) so it runs inside the worker.

function setBakeProgress(fraction, label) {
  const pct = Math.round(fraction * 100);
  bakeProgBar.style.width = `${pct}%`;
  bakeProgPct.textContent = `${pct}%`;
  bakeProgLbl.textContent = label;
}

// ── Bake Textures (beta) ─────────────────────────────────────────────────────
// Apply the current displacement texture to currentGeometry and adopt the
// result as the working model so the user can keep editing on the textured
// mesh. By default, masks the just-baked faces in the new exclusion set.
//
// Pipeline: subdivide → applyDisplacement → (optional) flat-bottom clamp.
// Decimation is intentionally skipped — decimate() drops the per-face parent
// mapping needed to translate "which input faces were textured" into the new
// mesh's triangle indices. Final decimation still happens on Export.
async function bakeTextures() {
  if (!currentGeometry || !activeMapEntry || isBaking || isExporting) return;
  isBaking = true;
  bakeBtn.classList.add('busy');
  bakeBtn.disabled = true;
  bakeProgress.classList.remove('hidden');

  if (precisionMaskingEnabled) deactivatePrecisionMasking();

  let displaced  = null;
  let succeeded  = false;

  try {
    setBakeProgress(0.02, t('progress.subdividing'));
    await yieldFrame();

    // Mirror handleExport's pre-flight: combine user mask + angle masking
    // into per-vertex weights for subdivision, plus soft-brush paint.
    const { faceWeights, softExclude } = _pipelineMaskInputs();

    // Run the bake pipeline (subdivide → regularize → displace → bottom
    // snaps; no decimation — it would drop the per-face parent mapping needed
    // to remap user exclusions onto the baked output). Worker-first with
    // inline fallback, same as handleExport.
    const exportEntry = getEffectiveMapEntry();
    const result = await runPipeline({
      positions: currentGeometry.attributes.position.array,
      faceWeights,
      softExclude,
      imageData: exportEntry.imageData,
      imgWidth: exportEntry.width,
      imgHeight: exportEntry.height,
      settings,
      bounds: currentBounds,
      regularizeOpts: _regularizeOpts(),
      mode: 'bake',
    }, _onBakePipelineEvent, () => false);
    if (!result) throw new Error('bake pipeline aborted');

    const faceParentId = result.faceParentId;
    displaced = new THREE.BufferGeometry();
    displaced.setAttribute('position', new THREE.BufferAttribute(result.positions, 3));
    if (result.normals) displaced.setAttribute('normal', new THREE.BufferAttribute(result.normals, 3));

    setBakeProgress(0.90, t('progress.finalizing'));
    await yieldFrame();

    // Build the new exclusion set: every output triangle whose parent face
    // was NOT excluded (by user paint, selectionMode, or angle masking) got
    // textured this round → mask it on the new mesh so a follow-up texture
    // pass won't double-up. faceWeights[parentIdx*3] > 0.99 captures all
    // three exclusion paths in a single check (it's the same predicate
    // subdivide uses to skip subdividing those faces).
    let preExcluded = null;
    if (bakeMaskChk.checked) {
      preExcluded = [];
      const wasParentExcluded = faceWeights
        ? (parentIdx) => faceWeights[parentIdx * 3] > 0.99
        : () => false; // no exclusions at all → every face was textured
      for (let i = 0; i < faceParentId.length; i++) {
        if (!wasParentExcluded(faceParentId[i])) preExcluded.push(i);
      }
    }

    // Compute new bounds from the displaced geometry. Do NOT re-center —
    // the displaced mesh is approximately at the same location, and
    // re-centering would shift the user's frame of reference.
    displaced.computeBoundingBox();
    const bb = displaced.boundingBox;
    const newBounds = {
      min:    bb.min.clone(),
      max:    bb.max.clone(),
      size:   new THREE.Vector3().subVectors(bb.max, bb.min),
      center: new THREE.Vector3().addVectors(bb.min, bb.max).multiplyScalar(0.5),
    };

    adoptBakedGeometry(displaced, newBounds, { preExcludedFaces: preExcluded });
    displaced = null; // ownership transferred to currentGeometry

    succeeded = true;
    setBakeProgress(1.0, t('progress.done'));
    setTimeout(() => { bakeProgress.classList.add('hidden'); setBakeProgress(0, ''); }, 1200);
  } catch (err) {
    console.error('Bake failed:', err);
    if (/maximum size|out of memory|alloc/i.test(err.message)) {
      alert(t('alerts.exportOOM'));
    } else {
      alert(t('alerts.bakeFailed', { msg: err.message }));
    }
  } finally {
    if (displaced) displaced.dispose();
    if (!succeeded) bakeProgress.classList.add('hidden');
    isBaking = false;
    bakeBtn.classList.remove('busy');
    bakeBtn.disabled = (activeMapEntry === null);
  }
}

// Replace currentGeometry with `geometry` and reset per-model state without
// touching the user's texture/settings. Mirrors the relevant subset of
// handleModelFile but keeps activeMapEntry, settings, and refineLength as-is,
// and seeds excludedFaces from opts.preExcludedFaces.
function adoptBakedGeometry(geometry, bounds, opts = {}) {
  // Invalidate any in-flight async operations tied to the previous mesh.
  precisionToken++;
  cancelDisplacementPreviewBuild();
  exportToken++;
  diagToken++;

  // Dispose the previous working geometry so we don't leak GPU buffers. Note
  // that it's still referenced by previewMaterial/loadGeometry until we swap
  // those — but loadGeometry below replaces the visible mesh, and Three's
  // BufferGeometry.dispose() only frees GPU resources (CPU arrays remain
  // valid for any code that still holds the reference).
  if (currentGeometry && currentGeometry !== geometry) currentGeometry.dispose();

  currentGeometry = geometry;
  currentBounds   = bounds;
  currentStlName  = `${currentStlName}_baked`;
  checkAmplitudeWarning();

  geometry = currentGeometry;

  // Dispose preview material so updatePreview rebuilds it on the new mesh.
  if (previewMaterial) {
    previewMaterial.dispose();
    previewMaterial = null;
  }

  // Replace the visible mesh in the viewer.
  loadGeometry(geometry);

  // Reset displacement preview — its geometry referenced the pre-bake mesh.
  if (dispPreviewGeometry) { dispPreviewGeometry.dispose(); dispPreviewGeometry = null; }
  settings.useDisplacement = false;
  dispPreviewToggle.checked = false;

  // Reset precision masking — its mesh referenced the pre-bake mesh.
  if (precisionGeometry) { precisionGeometry.dispose(); precisionGeometry = null; }
  precisionParentMap  = null;
  precisionEdgeLength = null;
  precisionCentroids  = null;
  precisionFaceNormals = null;
  precisionAdjacency  = null;
  precisionMaskingEnabled = false;
  precisionMaskingToggle.checked = false;
  precisionStatus.textContent = '';
  precisionOutdated.classList.add('hidden');
  precisionRefreshBtn.classList.add('hidden');
  precisionWarning.classList.add('hidden');
  precisionMaskingRow.classList.add('hidden');

  // Reset mesh diagnostics — they referenced the pre-bake mesh.
  meshDiagnostics.classList.add('hidden');
  meshDiagAdvanced.classList.add('hidden');
  lastFastDiag = null;
  lastAdvancedDiag = null;
  clearDiagHighlight();

  // The seeded mask carries exclude-mode semantics ("don't re-texture these
  // faces"). If the user was in include-only mode pre-bake, that mode would
  // invert the meaning to "only texture these faces" — exactly backwards. So
  // force exclude mode before seeding. setSelectionMode also clears
  // excludedFaces as a side effect, which is fine — we re-seed below.
  if (selectionMode) setSelectionMode(false);

  // Seed exclusion mask, exit any active painting/place/rotate modes. Soft
  // paint doesn't carry over: the baked faces it touched are in the seed.
  excludedFaces = new Set(opts.preExcludedFaces || []);
  precisionExcludedFaces = new Set();
  softPaint = null;
  precisionSoftPaint = null;
  precisionPainted = false;
  exclusionTool = null;
  eraseMode     = false;
  isPainting    = false;
  if (placeOnFaceActive) togglePlaceOnFace(false);
  if (rotateActive) toggleRotateMode(false);
  rotateAngles = { x: 0, y: 0, z: 0 };
  rotateXInput.value = '0'; rotateYInput.value = '0'; rotateZInput.value = '0';
  exclBrushBtn.classList.remove('active');
  exclBucketBtn.classList.remove('active');
  exclBrushTypeRow.classList.add('hidden');
  exclRadiusRow.classList.add('hidden');
  exclHardnessRow.classList.add('hidden');
  exclThresholdRow.classList.add('hidden');
  canvas.style.cursor = '';
  setHoverPreview(null);
  _lastHoverTriIdx = -1;

  // Build adjacency for the new geometry (needed by brush/bucket tools and
  // by the exclusion overlay).
  const adjData = buildAdjacency(geometry);
  triangleAdjacency = adjData.adjacency;
  triangleCentroids = adjData.centroids;
  triangleFaceNormals = adjData.faceNormals;
  softPaint = _newSoftLayer(adjData);
  updateMeshDiagnostics(adjData, geometry.attributes.position.count / 3);

  // Refresh exclusion overlay using the new geometry + new mask.
  if (excludedFaces.size > 0) refreshExclusionOverlay();
  else setExclusionOverlay(null);
  // A seeded post-bake mask means masking is actively in play (exclude mode
  // was forced above); no seed = back to the neutral default.
  maskModeChosen = excludedFaces.size > 0;
  updateMaskModeButtons();
  const maskCount = excludedFaces.size;
  exclCount.textContent = maskCount === 0
    ? t('excl.initExcluded')
    : (maskCount === 1
      ? (selectionMode ? t('excl.faceSelected', { n: 1 }) : t('excl.faceExcluded', { n: 1 }))
      : (selectionMode ? t('excl.facesSelected', { n: maskCount }) : t('excl.facesExcluded', { n: maskCount })));

  // Update mesh info display.
  triLimitWarning.classList.add('hidden');
  const triCount = getTriangleCount(geometry);
  const mb = ((geometry.attributes.position.array.byteLength) / 1024 / 1024).toFixed(2);
  const sx = bounds.size.x.toFixed(2);
  const sy = bounds.size.y.toFixed(2);
  const sz = bounds.size.z.toFixed(2);
  _setMeshInfo(triCount, mb, sx, sy, sz);

  exportBtn.disabled = (activeMapEntry === null);
  export3mfBtn.disabled = (activeMapEntry === null);
  bakeBtn.disabled = (activeMapEntry === null);
  updateSmartResBtnState();

  updatePreview();

  // Bake is a destructive transform — undo history references the pre-bake
  // triangle set, so it's no longer meaningful.
  _clearUndoStacks();
}

/** Yield to the browser event loop (for progress bar paints etc.). */
function yieldFrame() {
  return new Promise(r => setTimeout(r, 0));
}

// ── Project save/load (.bumpmesh) + sessionStorage auto-save ────────────────
// .bumpmesh is a ZIP containing: settings.json (required), model.stl (optional),
// texture.png (optional custom displacement map). Settings alone are also
// auto-persisted to sessionStorage — so a reload inside the same tab restores
// the session, but closing the tab (or opening a fresh one later) starts from
// defaults. One-time migration wipes any legacy localStorage payload.

const PROJECT_STORAGE_KEY = 'bumpmesh-settings';
const PROJECT_VERSION     = 1;
const PROJECT_MAX_IMPORT  = 500 * 1024 * 1024; // 500 MB cap on imports
try { localStorage.removeItem(PROJECT_STORAGE_KEY); } catch { /* ignore */ }

// Persisted setting keys — excludes `useDisplacement` (transient UI state).
const PERSISTED_KEYS = [
  'mappingMode', 'scaleU', 'scaleV', 'lockScale',
  'offsetU', 'offsetV', 'rotation',
  'amplitude', 'textureHeight', 'invertDisplacement',
  'invertTexture',
  'symmetricDisplacement', 'noDownwardZ', 'smoothBottom', 'harvestFlatFaces', 'harvestTol', 'preserveUntextured', 'textureSmoothing',
  'mappingBlend', 'seamBandWidth', 'capAngle', 'boundaryFalloff', 'boundaryFalloffCurve',
  'bottomAngleLimit', 'topAngleLimit',
  'refineLength', 'maxTriangles',
  // Cylindrical-mode controls. cylinderCenterX/Y/radius are nullable —
  // null means "fall back to AABB defaults", which is what fresh loads get.
  'snapSeamlessWrap', 'cylinderCenterX', 'cylinderCenterY', 'cylinderRadius',
  'cylinderPanelMinimized',
];

function getSettingsSnapshot() {
  const snap = {};
  for (const k of PERSISTED_KEYS) snap[k] = settings[k];
  // scaleU/scaleV are absolute mm since July 2026; older snapshots without
  // this marker carry legacy relative fractions and are converted on apply.
  snap.scaleUnit = 'mm';
  if (activeMapEntry) {
    snap.activeMapName = activeMapEntry.name;
    // Library id of a custom map (js/customTextures.js) — only meaningful in this browser.
    snap.activeCustomId = activeMapEntry.customId || null;
  } else {
    // Thumbnails may not have finished loading yet; preserve any previously
    // persisted map so a mid-load autosave doesn't wipe it.
    try {
      const prev = JSON.parse(sessionStorage.getItem(PROJECT_STORAGE_KEY) || 'null');
      snap.activeMapName = (prev && prev.activeMapName) || null;
      snap.activeCustomId = (prev && prev.activeCustomId) || null;
    } catch { snap.activeMapName = snap.activeCustomId = null; }
  }
  return snap;
}

/**
 * Convert a legacy snapshot (scaleU/scaleV as fractions of the mode's
 * reference length) to absolute mm. New snapshots carry scaleUnit:'mm' and
 * pass through untouched. Uses the currently-loaded model's bounds — for
 * project files the bundled model is loaded before settings are applied, so
 * the conversion reproduces the file's original appearance exactly.
 */
function _migrateSnapshotScaleToMm(snap) {
  if (!snap || snap.scaleUnit === 'mm') return snap;
  if (snap.scaleU == null && snap.scaleV == null) return snap;
  const out = { ...snap, scaleUnit: 'mm' };
  const b = currentBounds || { size: { x: 50, y: 50, z: 50 } };
  const mode = out.mappingMode ?? settings.mappingMode;
  const { refU, refV } = getScaleReferenceLengths(mode, { cylinderRadius: out.cylinderRadius ?? null }, b);
  // Short-lived fixed-reference feature (July 2026): its reference overrode
  // the bbox extent for planar/triplanar/cubic modes.
  const isAngular = mode === 3 /* CYLINDRICAL */ || mode === 4 /* SPHERICAL */;
  const legacyRef = !isAngular && out.fixedWorldTextureScale && Number(out.referenceExtentMm) > 0
    ? Number(out.referenceExtentMm) : null;
  const rU = legacyRef ?? refU;
  const rV = legacyRef ?? refV;
  if (out.scaleU != null) out.scaleU = parseFloat((out.scaleU * rU).toPrecision(4));
  if (out.scaleV != null) out.scaleV = parseFloat((out.scaleV * rV).toPrecision(4));
  delete out.fixedWorldTextureScale;
  delete out.referenceExtentMm;
  return out;
}

/**
 * Apply a settings snapshot to the live UI. Drives each control through the
 * same event it fires on user input (via dispatchEvent), so linkSlider's
 * clamp/display/preview flow runs unchanged.
 */
function applySettingsSnapshot(snap) {
  if (!snap) return;
  snap = _migrateSnapshotScaleToMm(snap);

  // Mapping mode first — changes cap-angle row visibility and triggers preview.
  if (snap.mappingMode != null) {
    mappingSelect.value = String(snap.mappingMode);
    mappingSelect.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Older projects were created with the original texture polarity.
  invertTextureCheckbox.checked = snap.invertTexture ?? false;
  invertTextureCheckbox.dispatchEvent(new Event('change', { bubbles: true }));

  // invertDisplacement BEFORE amplitude — the amplitude setter reads the flag.
  if (snap.invertDisplacement != null) {
    invertDisplacementCheckbox.checked = snap.invertDisplacement;
    invertDisplacementCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Temporarily disable lockScale so U and V can be set independently without
  // one mirroring the other; restore the saved lock state afterwards.
  const wantLock = snap.lockScale != null ? snap.lockScale : settings.lockScale;
  settings.lockScale = false;

  const setLinkedVal = (inputEl, value) => {
    if (inputEl && value != null) {
      inputEl.value = value;
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };

  setLinkedVal(scaleUVal,           snap.scaleU);
  setLinkedVal(scaleVVal,           snap.scaleV);
  setLinkedVal(offsetUVal,          snap.offsetU);
  setLinkedVal(offsetVVal,          snap.offsetV);
  setLinkedVal(rotationVal,         snap.rotation);
  setLinkedVal(amplitudeVal,        snap.textureHeight);
  setLinkedVal(textureSmoothingVal, snap.textureSmoothing);
  setLinkedVal(seamBlendVal,        snap.mappingBlend);
  setLinkedVal(seamBandWidthVal,    snap.seamBandWidth);
  setLinkedVal(capAngleVal,         snap.capAngle);
  setLinkedVal(boundaryFalloffVal,  snap.boundaryFalloff);
  // Older snapshots predate the curve setting and were authored with the
  // then-only linear ramp — fall back to 'linear' rather than keeping the
  // current UI choice, so loaded projects reproduce their original look.
  setFalloffCurve(snap.boundaryFalloffCurve ?? 'linear');
  setLinkedVal(bottomAngleLimitVal, snap.bottomAngleLimit);
  setLinkedVal(topAngleLimitVal,    snap.topAngleLimit);
  setLinkedVal(refineLenVal,        snap.refineLength);

  // maxTriangles uses a <span> for its display, so linkSlider wires it via
  // the slider's 'input' event, not a val-input 'change'.
  if (snap.maxTriangles != null) {
    maxTriSlider.value = snap.maxTriangles;
    maxTriSlider.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Restore saved lock state without invoking the button's click handler
  // (which would mirror scaleU→scaleV and clobber what we just set).
  settings.lockScale = wantLock;
  lockScaleBtn.classList.toggle('active', wantLock);
  lockScaleBtn.setAttribute('aria-pressed', String(wantLock));

  // Checkboxes
  if (snap.symmetricDisplacement != null) {
    symmetricDispToggle.checked = snap.symmetricDisplacement;
    symmetricDispToggle.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (snap.noDownwardZ != null) {
    noDownwardZChk.checked = snap.noDownwardZ;
    noDownwardZChk.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (snap.smoothBottom != null) {
    smoothBottomChk.checked = snap.smoothBottom;
    smoothBottomChk.dispatchEvent(new Event('change', { bubbles: true }));
  }
  // The restore above resets the auto-off flag, so re-apply the limit rule —
  // otherwise a project saved with Bottom faces = 0 re-enables the snap (#126).
  syncSmoothBottomToLimit();
  if (snap.harvestFlatFaces != null) {
    harvestFlatChk.checked = snap.harvestFlatFaces;
    harvestFlatChk.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (snap.harvestTol != null) {
    harvestTolInput.value = snap.harvestTol;
    harvestTolInput.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (snap.preserveUntextured != null) {
    preserveUntexturedChk.checked = snap.preserveUntextured;
    preserveUntexturedChk.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Cylindrical-mode state. cylinderCenterX/Y/radius pass through unchanged
  // (null is meaningful — falls back to AABB defaults during projection).
  if (snap.snapSeamlessWrap != null) {
    settings.snapSeamlessWrap = !!snap.snapSeamlessWrap;
    if (cylinderSnapToggle) cylinderSnapToggle.checked = settings.snapSeamlessWrap;
  }
  if ('cylinderCenterX' in snap) settings.cylinderCenterX = snap.cylinderCenterX;
  if ('cylinderCenterY' in snap) settings.cylinderCenterY = snap.cylinderCenterY;
  if ('cylinderRadius'  in snap) settings.cylinderRadius  = snap.cylinderRadius;
  if ('cylinderPanelMinimized' in snap) {
    settings.cylinderPanelMinimized = !!snap.cylinderPanelMinimized;
    cylinderPanel.classList.toggle('minimized', settings.cylinderPanelMinimized);
  }
  updateCylinderUIVisibility();
}

/**
 * Find a preset by name and activate it. By default, suppresses preset defaults
 * (resetTextureSmoothing + defaultScale override) so a just-restored snapshot
 * isn't clobbered. Pass applyDefaults=true for fresh user-initiated picks.
 */
function _selectPresetByName(name, applyDefaults = false) {
  if (!name) return false;
  const idx = IMAGE_PRESETS.findIndex(p => p.name === name);
  if (idx < 0) return false;
  selectPreset(idx, applyDefaults);
  return true;
}

// ── localStorage auto-save ───────────────────────────────────────────────────

let _autoSaveTimer = null;
let _autoSavePaused = false;
function _autoSaveSettings() {
  if (_autoSavePaused) return;
  clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(() => {
    try {
      const payload = { version: PROJECT_VERSION, ...getSettingsSnapshot() };
      sessionStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify(payload));
    } catch { /* quota exceeded or disabled — ignore */ }
  }, 300);
}

function _restoreSessionSettings() {
  let raw;
  try { raw = sessionStorage.getItem(PROJECT_STORAGE_KEY); }
  catch { return; }
  if (!raw) return;
  let data;
  try { data = JSON.parse(raw); } catch { return; }
  if (!data || typeof data !== 'object') return;
  applySettingsSnapshot(data);
  // Preset activation is handled by the thumbnail-load auto-select path —
  // it reads activeMapName from sessionStorage and suppresses defaults so
  // the user's saved scaleU / textureSmoothing survive.
}

// Delegate auto-save to input/change bubbling in the settings panel —
// covers every slider, number input, select, and checkbox in one shot.
const _settingsPanel = document.getElementById('settings-panel');
if (_settingsPanel) {
  _settingsPanel.addEventListener('input', _autoSaveSettings);
  _settingsPanel.addEventListener('change', _autoSaveSettings);
}
// The lock-scale button doesn't emit input/change — catch it separately.
lockScaleBtn.addEventListener('click', _autoSaveSettings);
// Same for the falloff-curve segmented buttons.
for (const btn of Object.values(falloffCurveButtons)) {
  btn.addEventListener('click', _autoSaveSettings);
}

// ── Reset to defaults ───────────────────────────────────────────────────────
// Frozen snapshot of the initial `settings` object plus the default preset
// name, so the reset button restores exactly what a fresh session starts with.

// NOTE: no scaleUnit marker — scaleU/scaleV are deliberately legacy fractions
// so applySettingsSnapshot's migration turns them into "0.5 × largest bbox
// edge" mm for whatever model is currently loaded (the per-model default).
const DEFAULT_SETTINGS_SNAPSHOT = Object.freeze({
  mappingMode: 5, scaleU: 0.5, scaleV: 0.5, lockScale: true,
  offsetU: 0, offsetV: 0, rotation: 0,
  amplitude: 0.5, textureHeight: 0.5, invertDisplacement: false,
  invertTexture: false,
  symmetricDisplacement: false, noDownwardZ: false, smoothBottom: true, harvestFlatFaces: true, harvestTol: 0.005, preserveUntextured: true, textureSmoothing: 0,
  mappingBlend: 1, seamBandWidth: 0.5, capAngle: 20, boundaryFalloff: 0,
  boundaryFalloffCurve: 'ease',
  bottomAngleLimit: 5, topAngleLimit: 0,
  refineLength: 1, maxTriangles: 750000,
  snapSeamlessWrap: true,
  cylinderCenterX: null, cylinderCenterY: null, cylinderRadius: null,
  cylinderPanelMinimized: false,
  activeMapName: DEFAULT_PRESET_NAME,
});

function resetSettingsToDefaults() {
  // Capture any pending edit, then push the pre-reset state so Ctrl+Z
  // restores all 20 parameters AND the painted mask.
  _flushUndoCapture();
  if (_baselineSnapshot) {
    _undoStack.push(_baselineSnapshot);
    if (_undoStack.length > UNDO_LIMIT) _undoStack.shift();
    _redoStack.length = 0;
  }
  _undoApplyDepth++;
  // Pause autosave so each intermediate change event doesn't queue a save;
  // we clear sessionStorage explicitly below.
  _autoSavePaused = true;
  try {
    // Match handleModelFile: refineLength defaults to ~1/250 of the loaded
    // model's bounding-box diagonal, clamped to [0.05, 5.0]. Without this the
    // reset would clobber a sensibly-tuned resolution back to the literal 1.0.
    const snapshot = { ...DEFAULT_SETTINGS_SNAPSHOT };
    if (currentBounds && currentBounds.size) {
      const sz = currentBounds.size;
      const diag = Math.sqrt(sz.x * sz.x + sz.y * sz.y + sz.z * sz.z);
      snapshot.refineLength = Math.max(0.05, Math.min(5.0, +(diag / 250).toFixed(2)));
    }
    applySettingsSnapshot(snapshot);

    // Clear any painted mask and revert to Exclude mode. setSelectionMode
    // also clears the face sets, but only when the mode actually changes —
    // run explicit resets afterwards so we always end up empty.
    if (selectionMode) setSelectionMode(false);
    excludedFaces          = new Set();
    precisionExcludedFaces = new Set();
    _clearSoftPaint();
    maskModeChosen         = false;
    updateMaskModeButtons();
    if (currentGeometry) refreshExclusionOverlay();

    const defaultIdx = IMAGE_PRESETS.findIndex(p => p.name === DEFAULT_PRESET_NAME);
    if (defaultIdx >= 0) {
      // applyDefaults=true so the preset's defaultScale overrides whatever
      // scale the user had — matches the "fresh session" intent.
      selectPreset(defaultIdx, true);
    }
    try { sessionStorage.removeItem(PROJECT_STORAGE_KEY); } catch { /* ignore */ }
  } finally {
    _autoSavePaused = false;
    _undoApplyDepth--;
    _baselineSnapshot = _captureUndoSnapshot();
    _updateUndoButtons();
  }
}

const resetSettingsBtn = document.getElementById('reset-settings-btn');
if (resetSettingsBtn) {
  resetSettingsBtn.addEventListener('click', () => {
    if (confirm(t('alerts.resetConfirm'))) resetSettingsToDefaults();
  });
}

// ── Export: build .bumpmesh ZIP and trigger download ─────────────────────────

const exportProjectBtn  = document.getElementById('export-project-btn');
const exportDialog      = document.getElementById('export-dialog');
const exportGoBtn       = document.getElementById('export-go-btn');
const exportModelChk    = document.getElementById('export-model-chk');
const exportTextureChk  = document.getElementById('export-texture-chk');
const exportTextureRow  = document.getElementById('export-texture-row');
const importProjectInput = document.getElementById('import-project-input');
const loadDialog        = document.getElementById('load-dialog');
const loadModeAllRadio  = document.getElementById('load-mode-all');
const loadModeSettingsRadio = document.getElementById('load-mode-settings');
const loadGoBtn         = document.getElementById('load-go-btn');

exportProjectBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  // Offer custom-texture export whenever one has been uploaded this session,
  // even if a preset is currently active — _lastCustomMap survives preset switches.
  const hasCustom = !!(_lastCustomMap && _lastCustomMap.fullCanvas);
  exportModelChk.disabled = !currentGeometry;
  if (!currentGeometry) exportModelChk.checked = false;
  exportTextureRow.classList.toggle('hidden', !hasCustom);
  if (!hasCustom) exportTextureChk.checked = false;
  exportDialog.classList.toggle('hidden');
});

// Close dialog on outside click.
document.addEventListener('click', (e) => {
  if (exportDialog.classList.contains('hidden')) return;
  if (!exportDialog.contains(e.target) && e.target !== exportProjectBtn && !exportProjectBtn.contains(e.target)) {
    exportDialog.classList.add('hidden');
  }
});

exportGoBtn.addEventListener('click', async () => {
  exportDialog.classList.add('hidden');
  try {
    const includeModel   = exportModelChk.checked && !!currentGeometry;
    const customSource   = (_lastCustomMap && _lastCustomMap.fullCanvas) ? _lastCustomMap : null;
    const includeTexture = exportTextureChk.checked && !!customSource;
    // The mask is saved against the model it indexes. With precision active
    // the paint lives on the refined mesh — bake it first (as Export does) so
    // the project keeps it exactly instead of collapsing it onto the coarse
    // base mesh.
    if (includeModel && precisionMaskingEnabled) deactivatePrecisionMasking();

    const payload = { version: PROJECT_VERSION, ...getSettingsSnapshot() };
    delete payload.activeCustomId;   // a browser-local library id means nothing in another browser
    // Mark the custom map as the active reference so the importer restores it
    // even if the user has a preset selected at export time.
    if (includeTexture) payload.activeMapName = customSource.name;
    // The bundled model is written in its ORIGINAL pose (issue #82), so the
    // in-app rotation must ride along in the settings for the importer to
    // replay — otherwise a saved session would lose its orientation.
    if (includeModel && Math.abs(currentPoseRot.w) < 1 - 1e-12) {
      payload.poseRotation = currentPoseRot.toArray();
    }
    const zipFiles = { 'settings.json': strToU8(JSON.stringify(payload, null, 2)) };

    if (includeModel) {
      // Written in the original pose (issue #82); re-importing re-centers and
      // replays poseRotation, so project round-trips stay stable.
      zipFiles['model.stl'] = _geometryToBinarySTL(currentGeometry, true);
      // Mask indices reference the base geometry's triangles, so they only make
      // sense when shipped alongside the model that produced them.
      const mask = _collectProjectMask();
      if (mask) zipFiles['mask.json'] = strToU8(JSON.stringify(mask));
    }
    if (includeTexture) {
      const blob = await new Promise(r => customSource.fullCanvas.toBlob(r, 'image/png'));
      zipFiles['texture.png'] = new Uint8Array(await blob.arrayBuffer());
    }

    const zipped = zipSync(zipFiles);
    _downloadBlob(new Blob([zipped], { type: 'application/octet-stream' }),
                  (currentStlName || 'bumpmesh') + '.bumpmesh');
  } catch (err) {
    alert(t('alerts.exportFailed', { msg: err.message }));
  }
});

/** Pack a BufferGeometry into binary-STL bytes (80-byte header, uint32 count, 50 bytes per triangle). With restorePose, vertices/normals are mapped back to the model's original file pose (see _restoreOriginalPose) without mutating the geometry. */
function _geometryToBinarySTL(geo, restorePose = false) {
  const t = currentPoseTrans;
  const rotInv = (restorePose && Math.abs(currentPoseRot.w) < 1 - 1e-12)
    ? currentPoseRot.clone().invert()
    : null;
  const ox = restorePose ? t.x : 0, oy = restorePose ? t.y : 0, oz = restorePose ? t.z : 0;
  const _v = new THREE.Vector3();
  const pos = geo.attributes.position.array;
  const nor = geo.attributes.normal ? geo.attributes.normal.array : null;
  const triCount = (pos.length / 9) | 0;
  const buf = new ArrayBuffer(84 + 50 * triCount);
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  view.setUint32(80, triCount, true);
  // Copy per-triangle normal + 3 vertex positions. If no normal attribute,
  // leave the normal slot as zeros — slicers compute per-face normals anyway.
  for (let i = 0; i < triCount; i++) {
    const dst = 84 + i * 50;
    const srcPos = i * 9;
    if (nor) {
      const srcNor = i * 9;
      _v.set(nor[srcNor], nor[srcNor + 1], nor[srcNor + 2]);
      if (rotInv) _v.applyQuaternion(rotInv);
      view.setFloat32(dst,     _v.x, true);
      view.setFloat32(dst + 4, _v.y, true);
      view.setFloat32(dst + 8, _v.z, true);
    }
    for (let v = 0; v < 3; v++) {
      const d = dst + 12 + v * 12;
      _v.set(pos[srcPos + v * 3] - ox, pos[srcPos + v * 3 + 1] - oy, pos[srcPos + v * 3 + 2] - oz);
      if (rotInv) _v.applyQuaternion(rotInv);
      view.setFloat32(d,     _v.x, true);
      view.setFloat32(d + 4, _v.y, true);
      view.setFloat32(d + 8, _v.z, true);
    }
  }
  return bytes;
}

/**
 * Snapshot the current paint mask (selection mode + excluded face indices into
 * the *base* geometry). Returns null when there's nothing meaningful to save —
 * i.e. exclude-mode with no painted faces.
 *
 * If precision masking is active, collapse `precisionExcludedFaces` back to
 * base-geometry indices via `precisionParentMap`, mirroring the collapse that
 * happens when the user disables precision (line 3193).
 *
 * Soft-brush paint rides along as sparse per-layer snapshots (`soft`), and
 * while precision is active the refined mesh's exact paint is kept too
 * (`precision`) so undo restores strokes on the mesh they were painted on.
 * These use typed arrays — project files go through _collectProjectMask.
 */
function _collectCurrentMask() {
  let liveExcluded;
  if (precisionMaskingEnabled && precisionParentMap && precisionExcludedFaces.size > 0) {
    liveExcluded = new Set();
    for (const pf of precisionExcludedFaces) liveExcluded.add(precisionParentMap[pf]);
  } else {
    liveExcluded = excludedFaces;
  }
  const soft = _sparseSoft(softPaint);
  const precision = (precisionMaskingEnabled && precisionGeometry && precisionSoftPaint && precisionPainted) ? {
    serial: precisionSoftPaint.serial,
    excluded: Uint32Array.from(precisionExcludedFaces).sort(),
    soft: _sparseSoft(precisionSoftPaint),
  } : null;
  // Include-mode with zero painted = "mask everything" — also worth preserving.
  if (liveExcluded.size === 0 && !selectionMode && !soft && !(precision && precision.soft)) return null;
  const mask = { selectionMode, excluded: [...liveExcluded] };
  if (soft) mask.soft = soft;
  if (precision) mask.precision = precision;
  return mask;
}

/** JSON-safe project-file form of the mask: base-mesh indices only. */
function _collectProjectMask() {
  const mask = _collectCurrentMask();
  if (!mask) return null;
  const out = { selectionMode: mask.selectionMode, excluded: mask.excluded };
  const soft = _collectProjectSoft();
  if (soft) out.soft = soft;
  return out;
}

/**
 * Soft paint values for `layer` from a saved mask — either an undo snapshot
 * (_sparseSoft form) or a project file's sparse per-corner lists, validated
 * like the face indices.
 */
function _restoreSoftValues(soft, layer) {
  if (!soft || !layer) return null;
  if (soft.ids) return _denseSoft(soft, layer);
  const corners = Array.isArray(soft.corners) ? soft.corners : [];
  const vals = Array.isArray(soft.values) ? soft.values : [];
  const out = new Float32Array(layer.count);
  const n = Math.min(corners.length, vals.length);
  for (let j = 0; j < n; j++) {
    const c = corners[j], v = vals[j];
    if (!Number.isInteger(c) || c < 0 || c >= layer.vertId.length || !(v > 0)) continue;
    const id = layer.vertId[c];
    const vv = v > 1 ? 1 : v;
    if (vv > out[id]) out[id] = vv;
  }
  return hasSoftPaint(out) ? out : null;
}

/**
 * Apply a saved mask to the currently-loaded geometry. Filters out indices
 * that would be out-of-range for the loaded mesh (defensive — the .bumpmesh
 * file always ships its own model, but we still validate).
 */
function _restoreMask(mask) {
  if (!currentGeometry) return;
  // null mask = exclude-mode with zero painted faces (the implicit default).
  // Without this branch, undoing back to the empty baseline would leave the
  // previously-painted mask on screen because the early-return skipped the
  // clear, making subsequent undo/redo appear broken.
  if (!mask) {
    if (selectionMode) setSelectionMode(false); // also clears the face sets
    excludedFaces = new Set();
    precisionExcludedFaces = new Set();
    _clearSoftPaint();
    maskModeChosen = false;
    updateMaskModeButtons();
    refreshExclusionOverlay();
    return;
  }
  const triCount = (currentGeometry.attributes.position.count / 3) | 0;
  // setSelectionMode clears any current paint, so flip mode FIRST then seed.
  if (mask.selectionMode === true)  setSelectionMode(true);
  else if (mask.selectionMode === false && selectionMode) setSelectionMode(false);

  const valid = (Array.isArray(mask.excluded) ? mask.excluded : [])
    .filter(i => Number.isInteger(i) && i >= 0 && i < triCount);
  excludedFaces = new Set(valid);
  if (softPaint) softPaint.values = _restoreSoftValues(mask.soft, softPaint);
  // With precision active, restore the refined mesh's exact paint when the
  // snapshot was taken on this very mesh; otherwise re-seed it from the base.
  precisionExcludedFaces = new Set();
  if (precisionMaskingEnabled && precisionGeometry && precisionParentMap && precisionSoftPaint) {
    const p = mask.precision;
    if (p && p.serial === precisionSoftPaint.serial) {
      precisionExcludedFaces = new Set(p.excluded);
      precisionSoftPaint.values = _denseSoft(p.soft, precisionSoftPaint);
      precisionPainted = true;
    } else {
      _seedPrecisionFromBase();
    }
  }
  // A non-null mask always carries painted faces or include-only mode, so
  // masking is engaged and its mode button should light up.
  maskModeChosen = true;
  updateMaskModeButtons();
  refreshExclusionOverlay();
}

function _downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ── Import ───────────────────────────────────────────────────────────────────

importProjectInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  importProjectInput.value = ''; // reset so the same file can be re-imported
  try { await importProject(file); }
  catch (err) { alert(t('alerts.importFailed', { msg: err.message })); }
});

async function importProject(file) {
  if (file.size > PROJECT_MAX_IMPORT) {
    throw new Error(`File too large (${(file.size / 1024 / 1024).toFixed(1)} MB, max 500 MB)`);
  }
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);

  // A .bumpmesh project is a ZIP (PK\x03\x04). If the user picked a bare model
  // file here instead — common on macOS Chrome, where the accept=".bumpmesh"
  // filter doesn't reliably hide .stl/.obj files — route it to the model loader
  // rather than failing with a cryptic "invalid zip data". A 3MF is also a ZIP,
  // so trust the extension first and fall back to the magic-byte sniff for
  // extension-less STLs.
  const isModelExt = /\.(stl|obj|3mf)$/i.test(file.name);
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4B &&
                bytes[2] === 0x03 && bytes[3] === 0x04;
  if (isModelExt || !isZip) {
    await handleModelFile(file);
    return;
  }

  const unzipped = unzipSync(bytes);

  const settingsBytes = unzipped['settings.json'];
  const data = settingsBytes ? JSON.parse(strFromU8(settingsBytes)) : null;
  const hasModel = !!unzipped['model.stl'];

  // Decide what to load. When the file carries a model the user chooses whether
  // to replace their current model ('all') or keep it and apply settings only
  // ('settings'). A file without a model is always settings-only — nothing to
  // ask. The prompt runs BEFORE we touch any state, so dismissing it is a no-op.
  let loadMode = 'settings';
  if (hasModel) {
    const choice = await promptLoadMode();
    if (choice === null) return; // dialog dismissed → load nothing
    loadMode = choice;
  }

  // Flush any pending settings change so it lands as its own undo step, keeping
  // the pre-load baseline accurate for the settings-only commit below.
  _flushUndoCapture();

  _undoApplyDepth++;
  try {
    if (loadMode === 'all') {
      // Load model first — handleModelFile resets scaleU/scaleV/offsets/refineLength
      // AND clears any existing paint mask, so applied settings + restored mask
      // below will correctly override those resets.
      const stlFile = new File([unzipped['model.stl']], 'model.stl', { type: 'application/octet-stream' });
      await handleModelFile(stlFile);

      // The bundled model is stored in its original pose; replay the saved
      // in-app rotation so the session resumes exactly as it was exported.
      // Runs before applySettingsSnapshot so the finalize's cylinder-axis
      // reset is overridden by the saved settings, not the other way around.
      if (data && Array.isArray(data.poseRotation) && data.poseRotation.length === 4) {
        const q = new THREE.Quaternion().fromArray(data.poseRotation).normalize();
        if (Math.abs(q.w) < 1 - 1e-12) {
          _rotateGeometry(q);
          _rotateFinalize();
        }
      }

      // Apply settings after the model reset.
      if (data) applySettingsSnapshot(data);

      // Restore paint mask — only meaningful here, since its indices reference
      // the model we just loaded.
      if (unzipped['mask.json']) {
        try {
          const mask = JSON.parse(strFromU8(unzipped['mask.json']));
          _restoreMask(mask);
        } catch (err) { console.warn('Could not restore paint mask:', err); }
      }
    } else {
      // Settings only: keep the current model and its mask untouched. We skip
      // model.stl (and never call handleModelFile, so the scale/offset/refine
      // resets don't fire) and mask.json (its indices belong to the saved
      // model, not the live one).
      if (data) applySettingsSnapshot(data);
    }

    await _applyImportedTexture(unzipped, data);

    _autoSaveSettings();
  } finally {
    _undoApplyDepth--;
    if (loadMode === 'all') {
      // Full import = fresh start; mask indices belong to the imported model.
      _clearUndoStacks();
    } else {
      // Settings-only is an undoable settings change on the unchanged model.
      _commitUndoCapture();
    }
  }
}

/**
 * Apply a project's texture: custom PNG wins over a named preset. Shared by
 * both load modes — the displacement map is part of the saved settings.
 */
async function _applyImportedTexture(unzipped, data) {
  if (unzipped['texture.png']) {
    const texName = (data && data.activeMapName) || 'imported-texture.png';
    const texFile = new File([unzipped['texture.png']], texName, { type: 'image/png' });
    const entry = await loadCustomTexture(texFile);
    entry.isCustom = true;
    entry.name = texName;
    _useCustomMap(entry, false);
  } else if (data && data.activeMapName) {
    _selectPresetByName(data.activeMapName);
  }
}

/**
 * Show the load-mode dialog and resolve to 'all' (model + settings),
 * 'settings' (settings only), or null if the user dismisses it. Defaults to
 * 'settings' when a model is already loaded (protect what you're working on),
 * otherwise 'all' (you need the file's model to see anything).
 */
function promptLoadMode() {
  return new Promise((resolve) => {
    const keepCurrent = !!currentGeometry;
    loadModeSettingsRadio.checked = keepCurrent;
    loadModeAllRadio.checked = !keepCurrent;
    loadDialog.classList.remove('hidden');

    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      loadDialog.classList.add('hidden');
      loadGoBtn.removeEventListener('click', onGo);
      document.removeEventListener('click', onOutside, true);
      document.removeEventListener('keydown', onKey, true);
      resolve(result);
    };
    const onGo = () => finish(loadModeSettingsRadio.checked ? 'settings' : 'all');
    const onOutside = (e) => { if (!loadDialog.contains(e.target)) finish(null); };
    const onKey = (e) => { if (e.key === 'Escape') finish(null); };

    loadGoBtn.addEventListener('click', onGo);
    // Defer the dismiss listeners so the click/change that opened the picker
    // doesn't immediately close the dialog.
    setTimeout(() => {
      document.addEventListener('click', onOutside, true);
      document.addEventListener('keydown', onKey, true);
    }, 0);
  });
}

// ── Undo / Redo ──────────────────────────────────────────────────────────────
// Snapshot stack over the same state the project save/load helpers handle:
// `getSettingsSnapshot()` (PERSISTED_KEYS + activeMapName) and
// `_collectCurrentMask()` (selectionMode + excluded face indices + soft-brush
// paint). Operations are debounced so a slider drag collapses to one undo step.

const UNDO_LIMIT = 50;
const UNDO_DEBOUNCE_MS = 400;

let _undoStack = [];
let _redoStack = [];
let _baselineSnapshot = null;     // last committed state — the "before" of the next push
let _undoApplyDepth = 0;          // > 0 while applying — suppresses re-capture
let _undoCaptureTimer = null;

const undoBtn = document.getElementById('undo-btn');
const redoBtn = document.getElementById('redo-btn');

function _captureUndoSnapshot() {
  return {
    settings: getSettingsSnapshot(),
    mask:     _collectCurrentMask(),
  };
}

function _undoSnapshotsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  for (const k of PERSISTED_KEYS) {
    if (a.settings[k] !== b.settings[k]) return false;
  }
  if ((a.settings.activeMapName || null) !== (b.settings.activeMapName || null)) return false;
  const ma = a.mask, mb = b.mask;
  if (!ma && !mb) return true;
  if (!ma || !mb) return false;
  if (ma.selectionMode !== mb.selectionMode) return false;
  if (ma.excluded.length !== mb.excluded.length) return false;
  const sb = new Set(mb.excluded);
  for (const v of ma.excluded) if (!sb.has(v)) return false;
  if (!_sparseSoftEqual(ma.soft || null, mb.soft || null)) return false;
  const pa = ma.precision || null, pb = mb.precision || null;
  if (!pa || !pb) return pa === pb;
  if (pa.serial !== pb.serial || pa.excluded.length !== pb.excluded.length) return false;
  for (let i = 0; i < pa.excluded.length; i++) if (pa.excluded[i] !== pb.excluded[i]) return false;
  return _sparseSoftEqual(pa.soft, pb.soft);
}

function _commitUndoCapture() {
  _undoCaptureTimer = null;
  if (_undoApplyDepth > 0) return;
  const next = _captureUndoSnapshot();
  if (_baselineSnapshot && _undoSnapshotsEqual(_baselineSnapshot, next)) return;
  if (_baselineSnapshot) {
    _undoStack.push(_baselineSnapshot);
    if (_undoStack.length > UNDO_LIMIT) _undoStack.shift();
  }
  _redoStack.length = 0;
  _baselineSnapshot = next;
  _updateUndoButtons();
}

function _scheduleUndoCapture() {
  if (_undoApplyDepth > 0) return;
  clearTimeout(_undoCaptureTimer);
  _undoCaptureTimer = setTimeout(_commitUndoCapture, UNDO_DEBOUNCE_MS);
}

function _flushUndoCapture() {
  if (_undoCaptureTimer) {
    clearTimeout(_undoCaptureTimer);
    _undoCaptureTimer = null;
    _commitUndoCapture();
  }
}

function _clearUndoStacks() {
  _undoStack.length = 0;
  _redoStack.length = 0;
  if (_undoCaptureTimer) { clearTimeout(_undoCaptureTimer); _undoCaptureTimer = null; }
  _baselineSnapshot = _captureUndoSnapshot();
  _updateUndoButtons();
}

function _applyUndoSnapshot(snap) {
  _undoApplyDepth++;
  try {
    applySettingsSnapshot(snap.settings);
    _restoreMask(snap.mask);
    if (snap.settings && snap.settings.activeCustomId) {
      selectCustomTexture(snap.settings.activeCustomId, false);
    } else if (snap.settings && snap.settings.activeMapName) {
      _selectPresetByName(snap.settings.activeMapName);
    }
    updatePreview();
    _autoSaveSettings();
  } finally {
    _undoApplyDepth--;
  }
}

function _undo() {
  _flushUndoCapture();
  if (!_undoStack.length) return;
  const prev = _undoStack.pop();
  if (_baselineSnapshot) _redoStack.push(_baselineSnapshot);
  _applyUndoSnapshot(prev);
  _baselineSnapshot = prev;
  _updateUndoButtons();
}

function _redo() {
  _flushUndoCapture();
  if (!_redoStack.length) return;
  const next = _redoStack.pop();
  if (_baselineSnapshot) _undoStack.push(_baselineSnapshot);
  _applyUndoSnapshot(next);
  _baselineSnapshot = next;
  _updateUndoButtons();
}

function _updateUndoButtons() {
  if (undoBtn) undoBtn.disabled = _undoStack.length === 0;
  if (redoBtn) redoBtn.disabled = _redoStack.length === 0;
}

// Capture hooks — piggyback on the same input/change bubbling that drives
// autosave (line 3834), plus a global pointerup so mask paint strokes (which
// don't go through #settings-panel events) terminate into a snapshot.
if (_settingsPanel) {
  _settingsPanel.addEventListener('input',  _scheduleUndoCapture);
  _settingsPanel.addEventListener('change', _scheduleUndoCapture);
}
lockScaleBtn.addEventListener('click', _scheduleUndoCapture);
window.addEventListener('pointerup', _scheduleUndoCapture);

// Buttons
if (undoBtn) undoBtn.addEventListener('click', _undo);
if (redoBtn) redoBtn.addEventListener('click', _redo);

// Keyboard: Ctrl/Cmd+Z = undo, Ctrl/Cmd+Shift+Z (or Ctrl/Cmd+Y) = redo.
// Skip when focus is in a text-entry control so the browser's native field
// undo works there.
window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const k = (e.key || '').toLowerCase();
  if (k !== 'z' && k !== 'y') return;
  const tgt = e.target;
  if (tgt) {
    if (tgt.isContentEditable) return;
    if (tgt.tagName === 'TEXTAREA') return;
    if (tgt.tagName === 'INPUT') {
      const tt = (tgt.type || '').toLowerCase();
      if (tt === 'text' || tt === 'number' || tt === 'search' ||
          tt === 'tel'  || tt === 'email'  || tt === 'url'    ||
          tt === 'password') return;
    }
  }
  if (k === 'z' && !e.shiftKey) { e.preventDefault(); _undo(); }
  else                          { e.preventDefault(); _redo(); }
});

// Restore last session's settings on startup, then take an initial baseline.
_restoreSessionSettings();
_baselineSnapshot = _captureUndoSnapshot();
_updateUndoButtons();
