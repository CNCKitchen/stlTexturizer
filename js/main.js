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
import { createPreviewMaterial, updateMaterial, MAX_LAYERS } from './previewMaterial.js';
import { subdivide }          from './subdivision.js';
import { runExportPipeline }  from './exportPipeline.js';
import { runPreviewPipeline, computeFaceNormals } from './previewPipeline.js';
import { exportSTL, export3MF } from './exporter.js';
import { buildAdjacency, bucketFill,
         buildExclusionOverlayGeo, buildFaceWeights } from './exclusion.js';
import { buildSoftExclusion, softPaintedFaces } from './softMask.js';
import { PaintTree } from './paintTree.js';
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

// ── Surface paint state ───────────────────────────────────────────────────────
// All layers' surface masks live in one PaintTree over currentGeometry
// (js/paintTree.js): triangles split adaptively under the brush, paint per
// layer. The viewer shows the flattened tree (paintGeometry) whenever a face
// is split, the base mesh otherwise.
let paintTree          = null;
let paintGeometry      = null;        // flattened tree mesh, or null when no face is split
let paintFlat          = null;        // paintTree.flatten() result behind paintGeometry
let _paintStructureVersion = -1;
let _paintCoverCache   = new Map();   // per (slot, geometry): paint arrays for the current paintVersion
let triangleAdjacency  = null;        // Array from buildAdjacency
let triangleCentroids  = null;        // Float32Array from buildAdjacency
let triangleFaceNormals = null;       // Float32Array — local-space unit face normal per tri
let exclusionTool      = null;        // 'brush' | 'bucket' | null
let eraseMode          = false;
let brushIsRadius      = true;
let brushRadius        = 5.0;
let brushHardness      = 0.5;         // circle brush: 1 = hard, leaf-exact; < 1 = soft, coverage per tree vertex
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

// ── Texture layers ────────────────────────────────────────────────────────────
// A layer is a texture plus its own projection/displacement settings
// (LAYER_KEYS) and its own surface mask. The ACTIVE layer lives in the
// existing globals — settings.*, activeMapEntry, selectionMode and
// maskModeChosen; its paint lives in paintTree under the layer's id — so the sidebar
// edits it exactly as it always did; the other layers are kept as plain data
// in `layers` and only feed the preview shader and the export pipeline.
// Switching layers stores the live state into layers[activeLayer] and
// materialises the new one through the same code path a project load uses.
// Everything else in `settings` (resolution, triangle limit, angle masks,
// bottom handling, regularize knobs) stays global.
const LAYER_KEYS = [
  'mappingMode', 'scaleU', 'scaleV', 'lockScale',
  'offsetU', 'offsetV', 'rotation',
  'amplitude', 'textureHeight', 'invertDisplacement', 'invertTexture', 'textureSmoothing',
  'symmetricDisplacement', 'mappingBlend', 'seamBandWidth', 'capAngle',
  'boundaryFalloff', 'boundaryFalloffCurve',
  'snapSeamlessWrap', 'cylinderCenterX', 'cylinderCenterY', 'cylinderRadius',
];
let layers = [];        // layer records, composition order (first = bottom); see _newLayer
let activeLayer = 0;    // index into `layers` of the layer the sidebar edits
let _layerSeq = 0;
layers = [_newLayer()];

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

// ── Texture layer strip DOM refs ──────────────────────────────────────────────
const layerList   = document.getElementById('layer-list');
const layerAddBtn = document.getElementById('layer-add-btn');
let _layerStripSig = '';

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
const WELCOME_LAST_UPDATED = '2026-10-05';
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
    _renderLayerStrip();
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
  // Only the latest custom map is kept; free the GPU copy of the one it
  // replaces — unless another layer still uses it.
  if (_lastCustomMap && _lastCustomMap !== entry && !_mapEntryInUse(_lastCustomMap)) _lastCustomMap.texture.dispose();
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

  // ── Texture layers ──
  if (layerAddBtn) layerAddBtn.addEventListener('click', _addLayer);

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
    canvas.style.cursor = exclusionTool ? 'crosshair' : '';
    brushCursorEl.style.display = 'none';
  });

  exclBrushRadiusBtn.addEventListener('click', () => {
    brushIsRadius = true;
    exclBrushRadiusBtn.classList.add('active');
    exclBrushSingleBtn.classList.remove('active');
    if (exclusionTool === 'brush') exclRadiusRow.classList.remove('hidden');
    if (exclusionTool === 'brush') exclHardnessRow.classList.remove('hidden');
    if (exclusionTool === 'brush') canvas.style.cursor = 'none';
  });

  exclBrushRadiusSlider.addEventListener('input', () => {
    brushRadius = parseFloat(exclBrushRadiusSlider.value) / 2;
    exclBrushRadiusVal.value = parseFloat(exclBrushRadiusSlider.value);
  });
  exclBrushRadiusSlider.addEventListener('dblclick', () => {
    exclBrushRadiusSlider.value = exclBrushRadiusSlider.defaultValue;
    brushRadius = parseFloat(exclBrushRadiusSlider.value) / 2;
    exclBrushRadiusVal.value = parseFloat(exclBrushRadiusSlider.value);
  });
  exclBrushRadiusVal.addEventListener('change', () => {
    let diam = Math.max(0.2, Math.min(100, parseFloat(exclBrushRadiusVal.value) || 10));
    brushRadius = diam / 2;
    exclBrushRadiusSlider.value = diam;
    exclBrushRadiusVal.value = diam;
  });
  addFineWheelSupport(exclBrushRadiusVal, (v) => {
    const diam = Math.max(0.2, Math.min(100, v));
    brushRadius = diam / 2;
    exclBrushRadiusSlider.value = diam;
    exclBrushRadiusVal.value = diam;
  });

  // Hardness (percent in the UI, 0–1 internally). The brush refines the mesh
  // under the stroke itself, so a soft fade works on any triangle size.
  const setHardness = (pct) => {
    pct = Math.max(0, Math.min(100, Math.round(pct)));
    brushHardness = pct / 100;
    exclBrushHardnessSlider.value = pct;
    exclBrushHardnessVal.value = pct;
    updateBrushCursorHardness();
  };
  exclBrushHardnessSlider.addEventListener('input', () => setHardness(parseFloat(exclBrushHardnessSlider.value)));
  exclBrushHardnessSlider.addEventListener('dblclick', () => setHardness(parseFloat(exclBrushHardnessSlider.defaultValue)));
  exclBrushHardnessVal.addEventListener('change', () => {
    const v = parseFloat(exclBrushHardnessVal.value);
    setHardness(Number.isFinite(v) ? v : parseFloat(exclBrushHardnessSlider.defaultValue));
  });
  addFineWheelSupport(exclBrushHardnessVal, (v) => setHardness(v));
  updateBrushCursorHardness();

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
    if (paintTree) paintTree.clearLayer(_activeSlot());
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

    if (!exclusionTool || !paintTree) return;

    if (exclusionTool === 'bucket') {
      e.preventDefault();
      _lastHoverTriIdx = -1;
      setHoverPreview(null);
      updateMaskingTriDebug(e);
      const triIdx = pickTriangle(e);
      if (triIdx >= 0) {
        // Bucket fill works on base faces: every leaf of a filled face is painted.
        const filled = bucketFill(triIdx, triangleAdjacency, bucketThreshold);
        paintTree.paintFaces(_activeSlot(), filled, eraseMode);
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
    _flushPaintRefresh();
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

function setSelectionMode(include, { clear = true } = {}) {
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
  // Clear the layer's paint — it had the opposite meaning in the previous
  // mode. (Switching layers passes clear:false: the paint is the other
  // layer's, already in its own mode.)
  if (clear && paintTree) paintTree.clearLayer(_activeSlot());
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
      updateFaceMask(_displayGeometry());
    }
    if (paintTree) paintTree.compactIfNeeded();
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
  return _baseFaceOf(hit.faceIndex, mesh.geometry);
}

/** Map a face of whatever mesh the viewer shows back to its base face. */
function _baseFaceOf(faceIndex, geometry) {
  if (geometry === dispPreviewGeometry && dispPreviewParentMap) return dispPreviewParentMap[faceIndex];
  if (geometry === paintGeometry && paintFlat) return paintFlat.faceParentId[faceIndex];
  return faceIndex;
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
            : geo === paintGeometry          ? 'paint'
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

const _viewDirScratch = new THREE.Vector3();
function _viewDirFor(hitPt) {
  return _viewDirScratch.subVectors(hitPt, getCamera().position).normalize();
}

// ── Surface paint: the paint tree ─────────────────────────────────────────────

/** A fresh paint tree over currentGeometry; every layer gets a slot. */
function _createPaintTree(adjData) {
  paintTree = new PaintTree({
    positions: currentGeometry.attributes.position.array,
    vertId: adjData.vertId, vertCount: adjData.vertCount,
    adjacency: adjData.adjacency, faceNormals: adjData.faceNormals,
  });
  for (const L of layers) paintTree.addLayer(L.id);
  _dropPaintGeometry();
}

/**
 * Carry the paint onto re-welded vertex ids of the SAME triangles (rotation,
 * place on face): serialize with per-leaf-corner coverage, rebuild on the
 * new positions, replay. Only a changed triangle count defeats this.
 */
function _rebuildPaintTreeKeepingPaint(adjData) {
  const data = paintTree ? paintTree.serialize({ leafCov: true }) : null;
  _createPaintTree(adjData);
  if (data && !paintTree.deserialize(data)) console.warn('[stlTexturizer] surface paint could not follow the re-welded mesh');
}

/** Keep the tree's layer slots in step with `layers` (by id). */
function _syncTreeLayers() {
  if (!paintTree) return;
  const ids = new Set(layers.map(L => L.id));
  for (const tl of [...paintTree.layers]) if (!ids.has(tl.id)) paintTree.removeLayer(tl.id);
  for (const L of layers) paintTree.addLayer(L.id);
}

function _activeSlot() { return paintTree ? paintTree.layerSlot(layers[activeLayer].id) : -1; }
function _slotOf(i)    { return paintTree ? paintTree.layerSlot(layers[i].id) : -1; }

function _dropPaintGeometry() {
  if (paintGeometry) paintGeometry.dispose();
  paintGeometry = null;
  paintFlat = null;
  _paintStructureVersion = -1;
  _paintCoverCache = new Map();
}

/** The mesh shown while painting: the flattened tree when any face is split, else the base mesh. */
function _paintDisplayGeometry() { return paintGeometry || currentGeometry; }

/** The mesh the viewer currently shows. */
function _displayGeometry() {
  return (settings.useDisplacement && dispPreviewGeometry) ? dispPreviewGeometry : _paintDisplayGeometry();
}

/**
 * Rebuild the flattened display mesh when the tree's structure changed
 * (a split or merge). Returns true when the geometry was swapped.
 */
function _refreshPaintGeometry() {
  if (!paintTree || !currentGeometry) return false;
  if (paintTree.structureVersion === _paintStructureVersion) return false;
  _paintStructureVersion = paintTree.structureVersion;
  _paintCoverCache = new Map();
  if (paintTree.isFlat) {
    if (paintGeometry) paintGeometry.dispose();
    paintGeometry = null;
    paintFlat = null;
  } else {
    const flat = paintTree.flatten(currentGeometry.attributes.normal ? currentGeometry.attributes.normal.array : null);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(flat.positions, 3));
    geo.setAttribute('normal',   new THREE.BufferAttribute(flat.normals, 3));
    // Flat face normals for the shader's angle masking: a leaf lies in its
    // parent's plane, so copy the base face's normal instead of recomputing.
    if (triangleFaceNormals) {
      const fn = new Float32Array(flat.triCount * 9);
      for (let t = 0; t < flat.triCount; t++) {
        const f = flat.faceParentId[t] * 3;
        const x = triangleFaceNormals[f], y = triangleFaceNormals[f + 1], z = triangleFaceNormals[f + 2];
        const o = t * 9;
        fn[o] = x; fn[o + 1] = y; fn[o + 2] = z; fn[o + 3] = x; fn[o + 4] = y; fn[o + 5] = z; fn[o + 6] = x; fn[o + 7] = y; fn[o + 8] = z;
      }
      geo.setAttribute('faceNormal', new THREE.Float32BufferAttribute(fn, 3));
    }
    if (paintGeometry) paintGeometry.dispose();
    paintGeometry = geo;
    paintFlat = flat;
  }
  _falloffDirty = true;
  if (!(settings.useDisplacement && dispPreviewGeometry)) setMeshGeometry(_paintDisplayGeometry());
  return true;
}

/**
 * Layer paint on a mesh the viewer may show: per-corner paint (0..1, hard
 * or soft) and per-face hard flag. Cached until the next stroke.
 */
function _layerPaintOn(slot, geometry) {
  if (!paintTree || slot < 0 || !geometry) return { paint: null, hard: null };
  const key = slot + ':' + (geometry === currentGeometry ? 'base' : geometry === paintGeometry ? 'paint' : geometry === dispPreviewGeometry ? 'disp' : 'x');
  const hit = _paintCoverCache.get(key);
  // A stroke only changes the active layer's paint; the others' is valid
  // until the structure (and with it the flattened mesh) changes.
  const version = slot === _activeSlot() ? paintTree.paintVersion : -1 - paintTree.structureVersion;
  if (hit && hit.version === version && hit.geometry === geometry) return hit;
  let r;
  if (geometry === paintGeometry && paintFlat) r = paintTree.flatPaint(slot, paintFlat);
  else if (geometry === currentGeometry) r = paintTree.basePaint(slot);
  else if (geometry === dispPreviewGeometry && dispPreviewParentMap) r = _sampledPaint(slot, geometry, dispPreviewParentMap);
  else r = { paint: null, hard: null };
  r.version = version;
  r.geometry = geometry;
  _paintCoverCache.set(key, r);
  return r;
}

/** Paint sampled from the tree at every corner of a refinement of the base mesh (3D preview). */
function _sampledPaint(slot, geometry, parentMap) {
  const pos = geometry.attributes.position.array;
  const triCount = parentMap.length;
  const paint = new Float32Array(triCount * 3);
  const hard = new Uint8Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const f = parentMap[t];
    let allHard = true;
    for (let k = 0; k < 3; k++) {
      const i = t * 3 + k;
      const v = paintTree.samplePaint(slot, f, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      paint[i] = v;
      if (v < 1) allHard = false;
    }
    hard[t] = allHard ? 1 : 0;
  }
  return { paint, hard };
}

/**
 * Layer i's coverage on `geometry` in shader terms: per-corner 1 = textured
 * (null = everything textured) and per-face user-mask flag (1 = the face is
 * hard-masked, i.e. it forms a mask boundary; null = none).
 */
function _layerCoverOn(i, geometry) {
  const includeOnly = i === activeLayer ? selectionMode : !!layers[i].includeOnly;
  const src = _layerPaintOn(_slotOf(i), geometry);
  if (src.coverFor === includeOnly && src.cover !== undefined) return { cover: src.cover, hardMasked: src.hardMasked };
  const { paint, hard } = src;
  const triCount = geometry.attributes.position.count / 3;
  if (!paint) {
    src.coverFor = includeOnly;
    src.cover = includeOnly ? new Float32Array(triCount * 3) : null;
    src.hardMasked = includeOnly ? new Uint8Array(triCount).fill(1) : null;
    return { cover: src.cover, hardMasked: src.hardMasked };
  }
  const cover = new Float32Array(paint.length);
  const hardMasked = new Uint8Array(triCount);
  if (includeOnly) {
    for (let k = 0; k < paint.length; k++) cover[k] = paint[k];
    for (let t = 0; t < triCount; t++) {
      hardMasked[t] = (!hard[t] && paint[t * 3] === 0 && paint[t * 3 + 1] === 0 && paint[t * 3 + 2] === 0) ? 1 : 0;
    }
  } else {
    for (let k = 0; k < paint.length; k++) cover[k] = 1 - paint[k];
    hardMasked.set(hard);
  }
  src.coverFor = includeOnly; src.cover = cover; src.hardMasked = hardMasked;
  return { cover, hardMasked };
}

/** Brush edge limit: r/5 for a hard brush, finer across a soft brush's fade band. */
function _brushEdgeLimit() {
  let edge = brushRadius / 5;
  if (brushHardness < 1) {
    const band = (1 - brushHardness) * brushRadius;
    edge = Math.min(edge, Math.max(band / 3, brushRadius / 10));
  }
  return Math.max(0.02, edge);
}

// strokeFrom: previous point of the same stroke — the brush sweeps the
// segment from there to hit.point, so fast strokes stay continuous.
function _paintSingleHit(hit, mesh, strokeFrom = null) {
  if (!paintTree) return;
  const slot = _activeSlot();
  const seedFace = _baseFaceOf(hit.faceIndex, mesh.geometry);
  if (brushIsRadius) {
    paintTree.paintStroke({
      slot, seedFace,
      from: strokeFrom || hit.point, to: hit.point,
      radius: brushRadius, view: _viewDirFor(hit.point),
      hardness: brushHardness, erase: eraseMode,
      edgeLimit: _brushEdgeLimit(),
    });
  } else {
    paintTree.paintFaces(slot, [seedFace], eraseMode);
  }
}

/** Legacy project mask (face list + soft corners on the base mesh) → tree paint. */
function _importLegacyMask(slot, mask) {
  if (!paintTree || slot < 0 || !mask) return;
  const triCount = paintTree.baseTriCount;
  const faces = (Array.isArray(mask.excluded) ? mask.excluded : []).filter(i => Number.isInteger(i) && i >= 0 && i < triCount);
  if (faces.length) paintTree.paintFaces(slot, faces, false);
  const soft = mask.soft;
  if (soft && Array.isArray(soft.corners) && Array.isArray(soft.values)) {
    const n = Math.min(soft.corners.length, soft.values.length);
    const corners = [], values = [];
    for (let j = 0; j < n; j++) {
      const c = soft.corners[j], v = soft.values[j];
      if (Number.isInteger(c) && c >= 0 && c < triCount * 3 && v > 0) { corners.push(c); values.push(Math.min(1, v)); }
    }
    if (corners.length) paintTree.setBaseCoverage(slot, corners, values);
  }
}

// ── Texture layers: data model ───────────────────────────────────────────────

/** The active layer's per-layer settings as a plain snapshot (see LAYER_KEYS). */
function _layerSettingsSnapshot() {
  const o = {};
  for (const k of LAYER_KEYS) o[k] = settings[k];
  o.scaleUnit = 'mm';   // absolute-mm marker, so applySettingsSnapshot never migrates it
  return o;
}

/**
 * A layer record. Its settings / map / mask fields are only current while
 * the layer is NOT the active one — the active layer's truth is the live
 * sidebar state, copied in by _storeActiveLayer.
 */
function _newLayer(opts = {}) {
  return {
    id: ++_layerSeq,
    settings: _layerSettingsSnapshot(),
    mapName:  activeMapEntry?.name ?? null,
    customId: activeMapEntry?.customId ?? null,
    mapEntry: activeMapEntry,
    // Mask mode: false = painted surfaces are excluded (everything else
    // textured); true = Include Only, painted surfaces are the textured ones.
    // The paint itself lives in paintTree under this layer's id.
    includeOnly: false,
    maskModeChosen: false,
    visible: true,
    blendAdd: false,   // add to the layers below instead of covering them
    ...opts,
  };
}

/** Copy the live sidebar state into layers[activeLayer]. */
function _storeActiveLayer() {
  const L = layers[activeLayer];
  if (!L) return;
  L.settings = _layerSettingsSnapshot();
  L.mapEntry = activeMapEntry;
  L.mapName  = activeMapEntry?.name ?? null;
  L.customId = activeMapEntry?.customId ?? null;
  L.includeOnly = selectionMode;
  L.maskModeChosen = maskModeChosen;
}

/** True when some layer other than the active one still uses this map entry. */
function _mapEntryInUse(entry) {
  if (!entry) return false;
  return layers.some((L, i) => i !== activeLayer && L.mapEntry === entry);
}

/**
 * Make layers[idx] the active layer: store the live state, then load the
 * other layer's settings, map and mask into the sidebar.
 */
function _activateLayer(idx, { commitUndo = true } = {}) {
  if (idx === activeLayer || idx < 0 || idx >= layers.length) return;
  _flushUndoCapture();
  if (exclusionTool) setExclusionTool(null);
  _storeActiveLayer();
  activeLayer = idx;
  _undoApplyDepth++;
  try { _materialiseActiveLayer(); } finally { _undoApplyDepth--; }
  _renderLayerStrip();
  updatePreview();
  _autoSaveSettings();
  if (commitUndo) _commitUndoCapture();
}

/** Load layers[activeLayer] into the live sidebar state. */
function _materialiseActiveLayer() {
  const L = layers[activeLayer];
  if (!L) return;
  const pausedBefore = _autoSavePaused;
  _autoSavePaused = true;
  try {
    applySettingsSnapshot(L.settings);
    _applyLayerMap(L);
    // The layer's paint is already in the tree; only the mode changes.
    setSelectionMode(!!L.includeOnly, { clear: false });
    maskModeChosen = !!L.maskModeChosen || selectionMode;
    updateMaskModeButtons();
    _falloffDirty = true;
    refreshExclusionOverlay();
  } finally {
    _autoSavePaused = pausedBefore;
  }
}

/** Activate a layer's map without touching its settings (no preset defaults). */
function _applyLayerMap(L) {
  if (L.mapEntry && L.mapEntry.texture) {
    if (L.mapEntry.isCustom) { _useCustomMap(L.mapEntry, false); return; }
    if (_selectPresetByName(L.mapEntry.name)) return;
  }
  if (L.customId) { selectCustomTexture(L.customId, false); return; }
  if (L.mapName && _selectPresetByName(L.mapName)) return;
  activeMapEntry = null;
  updatePreview();
}

/** Add a layer above the current ones (same texture and settings), in Include Only mode with nothing selected. */
function _addLayer() {
  if (layers.length >= MAX_LAYERS) return;
  _flushUndoCapture();
  if (exclusionTool) setExclusionTool(null);
  _storeActiveLayer();
  layers.push(_newLayer({ includeOnly: true, maskModeChosen: true }));
  activeLayer = layers.length - 1;
  _syncTreeLayers();
  _undoApplyDepth++;
  try { _materialiseActiveLayer(); } finally { _undoApplyDepth--; }
  // A fresh layer covers nothing yet: hand the user the fill tool so the
  // first click on a face gives the layer its surface.
  maskModeChosen = true;
  updateMaskModeButtons();
  if (!exclusionTool) setExclusionTool('bucket');
  _renderLayerStrip();
  updatePreview();
  _autoSaveSettings();
  _commitUndoCapture();
}

function _removeLayer(idx) {
  if (layers.length <= 1 || idx < 0 || idx >= layers.length) return;
  _flushUndoCapture();
  if (idx === activeLayer) {
    if (exclusionTool) setExclusionTool(null);
    layers.splice(idx, 1);
    activeLayer = Math.min(idx, layers.length - 1);
    _syncTreeLayers();
    _undoApplyDepth++;
    try { _materialiseActiveLayer(); } finally { _undoApplyDepth--; }
  } else {
    layers.splice(idx, 1);
    if (idx < activeLayer) activeLayer--;
    _syncTreeLayers();
  }
  _refreshPaintGeometry();
  _renderLayerStrip();
  updatePreview();
  _autoSaveSettings();
  _commitUndoCapture();
}

function _setLayerVisible(idx, visible) {
  const L = layers[idx];
  if (!L || L.visible === visible) return;
  _flushUndoCapture();
  L.visible = visible;
  _falloffDirty = true;
  _renderLayerStrip();
  updatePreview();
  _autoSaveSettings();
  _commitUndoCapture();
}

function _setLayerBlendAdd(idx, blendAdd) {
  const L = layers[idx];
  if (!L || L.blendAdd === blendAdd) return;
  _flushUndoCapture();
  L.blendAdd = blendAdd;
  _renderLayerStrip();
  updatePreview();
  _autoSaveSettings();
  _commitUndoCapture();
}

/**
 * Layers that take part in the preview, in composition order: every visible
 * layer, plus the active one even while hidden (its mask must stay
 * paintable). Capped at the shader's MAX_LAYERS; each gets one channel of
 * the layerMask / layerFalloff attributes.
 */
function _layerSlots() {
  const slots = [];
  for (let i = 0; i < layers.length && slots.length < MAX_LAYERS; i++) {
    const isActive = i === activeLayer;
    if (!layers[i].visible && !isActive) continue;
    slots.push({ index: i, isActive });
  }
  return slots;
}

/** Per-layer material parameters for the preview shader (see previewMaterial.js updateMaterial). */
function _previewLayers() {
  const slots = _layerSlots();
  const list = [];
  let activeIdx = -1;
  for (const { index, isActive } of slots) {
    const L = layers[index];
    const s = isActive ? settings : L.settings;
    const entry = isActive ? getEffectiveMapEntry()
                           : _effectiveMapFor(L.mapEntry, s.textureSmoothing, s.invertTexture);
    const tw = entry?.width ?? 1, th = entry?.height ?? 1;
    const tmax = Math.max(tw, th, 1);
    if (isActive) activeIdx = list.length;
    list.push({
      texture: entry?.texture ?? null,
      mappingMode: s.mappingMode, scaleU: s.scaleU, scaleV: s.scaleV,
      offsetU: s.offsetU, offsetV: s.offsetV, rotation: s.rotation,
      // A hidden active layer keeps its slot (for painting) but no relief;
      // a map that is still loading has nothing to show yet either.
      amplitude: (L.visible && entry) ? s.amplitude : 0,
      symmetricDisplacement: s.symmetricDisplacement,
      mappingBlend: s.mappingBlend, seamBandWidth: s.seamBandWidth, capAngle: s.capAngle,
      cylinderCenterX: s.cylinderCenterX, cylinderCenterY: s.cylinderCenterY, cylinderRadius: s.cylinderRadius,
      textureAspectU: tmax / Math.max(tw, 1), textureAspectV: tmax / Math.max(th, 1),
      blendAdd: index > 0 && L.blendAdd,
    });
  }
  return { list, activeIdx, count: slots.length };
}

/**
 * Per-vertex exclusion weights for subdivision / preserve-untextured: 1.0 on
 * faces that NO visible layer textures (the hard masks' intersection), plus
 * the angle masks.
 */
function _unionFaceWeights(hardFlags, geometry, withAngle) {
  const triCount = geometry.attributes.position.count / 3;
  const excluded = new Set();
  if (hardFlags.length && hardFlags.every(h => h)) {
    for (let t = 0; t < triCount; t++) {
      let all = true;
      for (const h of hardFlags) { if (!h[t]) { all = false; break; } }
      if (all) excluded.add(t);
    }
  }
  if (!withAngle) return excluded;
  const hasAngleMask = settings.bottomAngleLimit > 0 || settings.topAngleLimit > 0;
  if (excluded.size === 0 && !hasAngleMask) return null;
  return buildCombinedFaceWeights(geometry, excluded, false, settings, null);
}

/**
 * Inputs for the export/bake pipeline. The mesh is the flattened paint tree
 * (the base mesh when no face is split). One visible layer that is the
 * active one, on an unsplit mesh, goes through the original single-texture
 * path unchanged; anything else becomes the layered path (exportPipeline.js
 * `layers`).
 */
function _pipelineInputs() {
  const parts = [];
  for (let i = 0; i < layers.length; i++) {
    const L = layers[i];
    if (!L.visible) continue;
    const isActive = i === activeLayer;
    const s = isActive ? settings : L.settings;
    const entry = isActive ? getEffectiveMapEntry()
                           : _effectiveMapFor(L.mapEntry, s.textureSmoothing, s.invertTexture);
    if (!entry || !entry.imageData) continue;
    parts.push({ L, i, isActive, s, entry });
  }
  _refreshPaintGeometry();
  const split = !!(paintTree && !paintTree.isFlat && paintFlat);
  const positions = split ? paintFlat.positions : currentGeometry.attributes.position.array;
  const geometry = split ? paintGeometry : currentGeometry;

  if (!split && parts.length === 1 && parts[0].isActive) {
    // Legacy inputs from the root paint: hard faces as the excluded set, soft
    // coverage on the welded base vertices.
    const tl = paintTree ? paintTree.layers[_activeSlot()] : null;
    const excluded = new Set();
    let softValues = null;
    if (tl) {
      for (let f = 0; f < paintTree.baseTriCount; f++) if (tl.state[f]) excluded.add(f);
      if (tl.cov) {
        const sv = tl.cov.subarray(0, paintTree.baseVertCount);
        for (let v = 0; v < sv.length; v++) if (sv[v] > 0) { softValues = sv; break; }
      }
    }
    const vertId = paintTree ? paintTree.vertId : null;
    const softFaces = (softValues && selectionMode) ? softPaintedFaces(vertId, softValues) : null;
    const hasAngleMask = settings.bottomAngleLimit > 0 || settings.topAngleLimit > 0;
    const faceWeights = (excluded.size > 0 || selectionMode || hasAngleMask)
      ? buildCombinedFaceWeights(currentGeometry, excluded, selectionMode, settings, softFaces)
      : null;
    const softExclude = softValues ? buildSoftExclusion(vertId, softValues, excluded, selectionMode) : null;
    const e = parts[0].entry;
    return { positions, faceWeights, softExclude, imageData: e.imageData, imgWidth: e.width, imgHeight: e.height, layers: null, label: _mapLabel(activeMapEntry) };
  }

  const hardFlags = [];
  const out = [];
  for (const { L, i, s, entry } of parts) {
    const { cover, hardMasked } = _layerCoverOn(i, geometry);
    hardFlags.push(hardMasked);
    let exclude = null;
    if (cover) {
      exclude = new Float32Array(cover.length);
      for (let k = 0; k < cover.length; k++) exclude[k] = 1 - cover[k];
    }
    out.push({
      imageData: entry.imageData, imgWidth: entry.width, imgHeight: entry.height,
      settings: { ...settings, ...s },
      exclude, hardFaces: hardMasked,
      blendAdd: L !== layers[0] && L.blendAdd,
    });
  }
  const faceWeights = _unionFaceWeights(hardFlags, geometry, true);
  return {
    positions, faceWeights, softExclude: null,
    imageData: null, imgWidth: 0, imgHeight: 0,
    layers: out,
    label: parts.length ? (parts.length === 1 ? _mapLabel(parts[0].entry) : `${parts.length}layers`) : 'layers',
  };
}

function _mapLabel(entry) {
  if (!entry) return 'texture';
  return entry.isCustom ? 'custom' : String(entry.name).replace(/\s+/g, '-');
}

/** True when the pipeline has something to texture with. */
function _hasTexturedLayer() {
  return layers.some((L, i) => L.visible && (i === activeLayer ? !!activeMapEntry : !!L.mapEntry));
}

// ── Texture layers: strip UI ─────────────────────────────────────────────────


/** Rebuild the layer rows (cheap: at most MAX_LAYERS rows; skipped when nothing changed). */
function _renderLayerStrip() {
  if (!layerList) return;
  const sig = layers.map((L, i) => {
    const entry = i === activeLayer ? activeMapEntry : L.mapEntry;
    return `${L.id}:${entry?.name ?? ''}:${entry?.customId ?? ''}:${L.visible ? 1 : 0}:${L.blendAdd ? 1 : 0}`;
  }).join('|') + `#${activeLayer}#${getLang()}`;
  if (sig === _layerStripSig) return;
  _layerStripSig = sig;

  layerList.innerHTML = '';
  layers.forEach((L, i) => {
    const isActive = i === activeLayer;
    const entry = isActive ? activeMapEntry : L.mapEntry;
    const row = document.createElement('div');
    row.className = 'layer-row' + (isActive ? ' active' : '') + (L.visible ? '' : ' hidden-layer');
    row.dataset.idx = String(i);
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.title = t('layers.rowTitle', { n: i + 1 });

    const thumb = document.createElement('canvas');
    thumb.className = 'layer-thumb';
    thumb.width = thumb.height = 28;
    if (entry?.fullCanvas) {
      const ctx = thumb.getContext('2d');
      const sw = entry.fullCanvas.width, sh = entry.fullCanvas.height;
      const sc = Math.max(28 / sw, 28 / sh);
      const dw = sw * sc, dh = sh * sc;
      ctx.drawImage(entry.fullCanvas, (28 - dw) / 2, (28 - dh) / 2, dw, dh);
    }
    row.appendChild(thumb);

    const name = document.createElement('span');
    name.className = 'layer-name';
    name.textContent = entry?.name ? `${i + 1} · ${entry.name}` : t('layers.name', { n: i + 1 });
    row.appendChild(name);

    if (i > 0) {
      const blend = document.createElement('button');
      blend.type = 'button';
      blend.className = 'layer-btn layer-blend' + (L.blendAdd ? ' add' : '');
      blend.textContent = L.blendAdd ? t('layers.blendAdd') : t('layers.blendCover');
      blend.title = L.blendAdd ? t('layers.blendAddTitle') : t('layers.blendCoverTitle');
      blend.addEventListener('click', (e) => { e.stopPropagation(); _setLayerBlendAdd(i, !L.blendAdd); });
      row.appendChild(blend);
    }

    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'layer-btn layer-eye';
    eye.setAttribute('aria-pressed', String(L.visible));
    eye.title = L.visible ? t('layers.hide') : t('layers.show');
    eye.innerHTML = L.visible
      ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>'
      : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.9 17.9A10.9 10.9 0 0 1 12 19c-7 0-11-7-11-7a20 20 0 0 1 5.1-5.9M9.9 4.2A10 10 0 0 1 12 4c7 0 11 7 11 7a20 20 0 0 1-3.2 4.2"/><path d="M14.1 14.1a3 3 0 1 1-4.2-4.2"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
    eye.addEventListener('click', (e) => { e.stopPropagation(); _setLayerVisible(i, !L.visible); });
    row.appendChild(eye);

    if (layers.length > 1) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'layer-btn layer-del';
      del.title = t('layers.remove');
      del.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      del.addEventListener('click', (e) => { e.stopPropagation(); _removeLayer(i); });
      row.appendChild(del);
    }

    row.addEventListener('click', () => _activateLayer(i));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _activateLayer(i); }
    });
    layerList.appendChild(row);
  });
  if (layerAddBtn) {
    const full = layers.length >= MAX_LAYERS;
    layerAddBtn.disabled = full;
    layerAddBtn.title = full ? t('layers.max', { n: MAX_LAYERS }) : t('layers.addTitle');
  }
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
  _schedulePaintRefresh();
}

// Several mouse events can land in one frame; the tree takes every one of
// them, the display (flatten + attributes) is refreshed once per frame.
let _paintRefreshRaf = 0;
function _schedulePaintRefresh() {
  if (_paintRefreshRaf) return;
  _paintRefreshRaf = requestAnimationFrame(() => {
    _paintRefreshRaf = 0;
    refreshExclusionOverlay();
  });
}
function _flushPaintRefresh() {
  if (_paintRefreshRaf) { cancelAnimationFrame(_paintRefreshRaf); _paintRefreshRaf = 0; }
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

  // Deactivate tools but keep the paint (face indices are stable after rotation)
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

  // Rebuild adjacency and carry the paint onto the moved vertices
  const adjData = buildAdjacency(currentGeometry);
  triangleAdjacency = adjData.adjacency;
  triangleCentroids = adjData.centroids;
  triangleFaceNormals = adjData.faceNormals;
  _rebuildPaintTreeKeepingPaint(adjData);

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

  exportBtn.disabled = !_hasTexturedLayer();
  export3mfBtn.disabled = !_hasTexturedLayer();
  bakeBtn.disabled = !_hasTexturedLayer();
  updateSmartResBtnState();
  updatePreview();

  // Rebuild the paint display with the new vertex positions (face indices unchanged)
  refreshExclusionOverlay();

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

  // Rebuild adjacency for the paint tools and carry the paint onto the moved vertices
  const adjData = buildAdjacency(currentGeometry);
  triangleAdjacency = adjData.adjacency;
  triangleCentroids = adjData.centroids;
  triangleFaceNormals = adjData.faceNormals;
  _rebuildPaintTreeKeepingPaint(adjData);

  // Rebuild the paint display
  refreshExclusionOverlay();

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
  if (!currentGeometry || !paintTree) return;

  _falloffDirty = true;

  // Never show the flat-coloured MeshLambertMaterial overlay — the custom
  // shader handles mask visualisation with smooth, view-dependent shading.
  setExclusionOverlay(null);
  const { faces: n, softVertices } = paintTree.countPainted(_activeSlot());
  let countText = selectionMode
    ? t(n === 1 ? 'excl.faceSelected' : 'excl.facesSelected', { n: n.toLocaleString() })
    : t(n === 1 ? 'excl.faceExcluded' : 'excl.facesExcluded', { n: n.toLocaleString() });
  if (softVertices > 0) countText += ' · ' + t('excl.softVertices', { n: softVertices.toLocaleString() });
  exclCount.textContent = countText;

  // A split or merge changes the mesh the viewer shows; the paint itself is
  // an attribute update.
  _refreshPaintGeometry();
  updateFaceMask(_displayGeometry());
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

  // The circle brush shows its footprint as the cursor ring; only the
  // single-triangle brush highlights the base face under the pointer.
  if (brushIsRadius) { _lastHoverTriIdx = -1; setHoverPreview(null); return; }
  const triIdx = _baseFaceOf(hit.faceIndex, mesh.geometry);
  if (triIdx === _lastHoverTriIdx) return;
  _lastHoverTriIdx = triIdx;
  setHoverPreview(buildExclusionOverlayGeo(currentGeometry, new Set([triIdx])), eraseMode ? 0x999999 : 0xffee00);
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
  setHoverPreview(buildExclusionOverlayGeo(currentGeometry, hovered), eraseMode ? 0x999999 : 0xffee00);
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

  // Reset the paint (every layer's strokes indexed the previous mesh)
  _dropPaintGeometry();
  paintTree         = null;
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
  _createPaintTree(adjData);

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

  exportBtn.disabled = !_hasTexturedLayer();
  export3mfBtn.disabled = !_hasTexturedLayer();
  bakeBtn.disabled = !_hasTexturedLayer();
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

    // Reset mesh diagnostics for the new mesh
    meshDiagnostics.classList.add('hidden');
    meshDiagAdvanced.classList.add('hidden');
    lastFastDiag = null;
    lastAdvancedDiag = null;
    clearDiagHighlight();

    // Reset the paint for the new mesh (every layer's strokes indexed the previous one)
    _dropPaintGeometry();
    paintTree         = null;
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
    _createPaintTree(adjData);
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

    exportBtn.disabled = !_hasTexturedLayer();
    export3mfBtn.disabled = !_hasTexturedLayer();
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
    // count; skip if the mesh has been swapped since.
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
 * Refresh the per-vertex layer attributes the preview shader reads on a
 * geometry: `layerMask` (vec4, one channel per layer slot — 1 = textured,
 * 0 = user-excluded, between = soft brush), `layerFalloff` (vec4, boundary
 * falloff per slot) and `boundaryMaskTypeAttr` (active layer's boundary
 * type: 0 = user mask, 1 = angle mask). Angle masking stays in the shader.
 *
 * Attributes are created fresh when the geometry's size differs (so Three.js
 * allocates a new WebGL buffer) and flagged needsUpdate otherwise.
 *
 * forceFalloff: recompute the boundary falloff even while a masking tool is
 * active (a freshly built display mesh needs it for its initial state).
 */
function updateFaceMask(geometry, { forceFalloff = false } = {}) {
  if (!geometry) return;
  const posCount = geometry.attributes.position.count;
  const slots = _layerSlots();

  // Per-slot coverage on this geometry's corners (null = fully textured) and
  // per-face user-mask flags (null = none) for the falloff passes.
  const covers = [], hards = [];
  let activeSlot = -1;
  for (const { index, isActive } of slots) {
    if (isActive) activeSlot = covers.length;
    const r = _layerCoverOn(index, geometry);
    covers.push(r.cover);
    hards.push(r.hardMasked);
  }

  const maskAttr = _ensureAttr(geometry, 'layerMask', posCount, 4, 0.0);
  const m = maskAttr.array;
  const nSlots = covers.length;
  for (let i = 0; i < posCount; i++) {
    const o = i * 4;
    for (let k = 0; k < 4; k++) {
      const c = covers[k];
      m[o + k] = k < nSlots ? (c ? c[i] : 1) : 0;
    }
  }
  maskAttr.needsUpdate = true;

  // Ensure faceNormal attribute exists (needed by shader for angle masking).
  // For the original geometry normal == faceNormal; for subdivided geometry
  // addFaceNormals() is called after subdivision, but guard here in case the
  // attribute is still missing.
  if (!geometry.attributes.faceNormal) {
    addFaceNormals(geometry);
  }

  // Ensure falloff attributes exist so the shader doesn't read 0.0 for missing
  // attributes (which would make every weight 0 → entire model appears masked).
  // This matters when a fresh geometry is displayed while the masking tool is
  // active (e.g. a freshly flattened paint mesh) because the expensive recomputation
  // below is intentionally skipped during active masking.
  const falloffAttr = _ensureAttr(geometry, 'layerFalloff', posCount, 4, 1.0);
  const typeAttr    = _ensureAttr(geometry, 'boundaryMaskTypeAttr', posCount, 1, 1.0);

  // Skip expensive per-vertex falloff and boundary edge recomputation while
  // actively masking; both will be recalculated when the masking tool is
  // deactivated (in setExclusionTool → updateFaceMask with exclusionTool=null).
  if (forceFalloff || (!exclusionTool && (_falloffDirty || geometry !== _falloffGeometry))) {
    const f = falloffAttr.array;
    f.fill(1.0);
    typeAttr.array.fill(1.0);
    for (let k = 0; k < slots.length; k++) {
      const { index, isActive } = slots[k];
      const ls = isActive ? settings : layers[index].settings;
      const dist = ls.boundaryFalloff ?? 0;
      if (dist <= 0) continue;
      const r = computeBoundaryFalloff(geometry, hards[k], dist, ls.boundaryFalloffCurve);
      if (!r) continue;
      for (let i = 0; i < posCount; i++) f[i * 4 + k] = r.falloff[i];
      if (isActive) typeAttr.array.set(r.maskType);
    }
    falloffAttr.needsUpdate = true;
    typeAttr.needsUpdate = true;
    if (!exclusionTool) computeBoundaryEdges(geometry, activeSlot >= 0 ? hards[activeSlot] : null, settings.boundaryFalloff ?? 0);
    _falloffDirty = false;
    _falloffGeometry = geometry;
  }
  syncBoundaryEdgeUniforms();
  requestRender();
}

/** Get a Float32 attribute of the given item size, (re)creating it (filled with `fill`) when the size doesn't match. */
function _ensureAttr(geometry, name, posCount, itemSize, fill) {
  const existing = geometry.getAttribute(name);
  if (existing && existing.itemSize === itemSize && existing.array.length === posCount * itemSize) return existing;
  const arr = new Float32Array(posCount * itemSize);
  if (fill) arr.fill(fill);
  const attr = new THREE.Float32BufferAttribute(arr, itemSize);
  geometry.setAttribute(name, attr);
  return attr;
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

/** Shape the linear 0→1 falloff ramp per the given curve (default: the active layer's). */
function applyFalloffCurve(t, mode = settings.boundaryFalloffCurve) {
  if (mode === 'scurve') return t * t * (3 - 2 * t);
  if (mode === 'ease')   return t * t;
  return t;
}

/**
 * Per-vertex boundary falloff for one layer on `geometry`. Vertices near the
 * boundary between masked and non-masked regions get values ramping from 0
 * (at boundary) to 1 (at or beyond `falloff` mm); the shader multiplies the
 * layer's weight by it.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {Uint8Array|null} userMaskedFaces  per-face user-mask flag (1 = masked), null = none
 * @param {number} falloff   falloff distance (mm), > 0
 * @param {string} curve     'linear' | 'scurve' | 'ease'
 * @returns {{ falloff: Float32Array, maskType: Float32Array } | null}
 *   per-corner ramp and boundary type (0 = user mask, 1 = angle mask); null
 *   when the layer has no boundary on this geometry
 */
function computeBoundaryFalloff(geometry, userMaskedFaces, falloff, curve) {
  const posAttr = geometry.attributes.position;
  const posCount = posAttr.count;
  const triCount = posCount / 3;
  if (!(falloff > 0)) return null;

  // Compute per-face combined mask (angle masking + user exclusion).
  // Mirrors the vertex shader logic so the preview boundary matches export.
  const faceNrmAttr = geometry.attributes.faceNormal;
  const faceMask = new Float32Array(triCount); // 0 = masked, 1 = textured
  const isUserMasked = new Uint8Array(triCount); // 1 if user-excluded
  for (let t = 0; t < triCount; t++) {
    if (userMaskedFaces && userMaskedFaces[t]) { faceMask[t] = 0; isUserMasked[t] = 1; continue; }

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

  if (boundaryPositions.length === 0) return null;

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
      falloffById[id] = applyFalloffCurve(factor, curve);
      maskTypeById[id] = nearestType;
    }
  }

  // Write per-corner results via the welded id (no re-keying pass)
  const falloffArr  = new Float32Array(posCount).fill(1.0);
  const maskTypeArr = new Float32Array(posCount).fill(1.0);
  for (let i = 0; i < posCount; i++) {
    const id = vertId[i];
    if (falloffById[id] >= 0) falloffArr[i] = falloffById[id];
    if (maskTypeById[id] >= 0) maskTypeArr[i] = maskTypeById[id];
  }
  return { falloff: falloffArr, maskType: maskTypeArr };
}

/**
 * Compute boundary edge segments between masked and non-masked faces (active
 * layer) and pack them into a DataTexture for per-fragment distance queries
 * in the bump-only preview shader.  Each edge is stored as two RGBA texels
 * (endpoint A xyz, endpoint B xyz).
 */
function computeBoundaryEdges(geometry, userMaskedFaces, falloff) {
  const posAttr = geometry.attributes.position;
  const posCount = posAttr.count;
  const triCount = posCount / 3;

  if (_boundaryEdgeTex) { _boundaryEdgeTex.dispose(); _boundaryEdgeTex = null; }
  _boundaryEdgeCount = 0;
  if (!(falloff > 0)) return;

  const faceNrmAttr = geometry.attributes.faceNormal;
  const faceMaskBool = new Uint8Array(triCount);
  for (let t = 0; t < triCount; t++) {
    if (userMaskedFaces && userMaskedFaces[t]) { faceMaskBool[t] = 0; continue; }
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

/** The active layer's map after texture smoothing / inversion (see _effectiveMapFor). */
function getEffectiveMapEntry() {
  return _effectiveMapFor(activeMapEntry, settings.textureSmoothing, settings.invertTexture);
}

// Processed-map cache: one entry per (map, smoothing, invert) combination in
// use. Several layers can share a map with different processing, so keep a
// few entries and drop the least recently used beyond that.
const _effectiveMapCache = new Map();   // cacheKey → { entry, fullCanvas }
const EFFECTIVE_MAP_CACHE_MAX = MAX_LAYERS + 2;

/**
 * A map entry with `textureSmoothing` (px of a 512 px map) and `invert`
 * applied — the pixels BOTH the GPU preview and the CPU bake/export consume.
 * Returns the raw entry when nothing needs processing, null for no map.
 */
function _effectiveMapFor(mapEntry, textureSmoothing, invert) {
  if (!mapEntry) return null;
  if (!mapEntry.texture) return null;   // still loading
  if ((textureSmoothing ?? 0) === 0 && !invert) return mapEntry;
  const { fullCanvas, width, height, name } = mapEntry;
  const cacheKey = `${name}_${width}_${height}_${textureSmoothing}_${!!invert}_${mapEntry.customId ?? ''}`;
  // Two uploads can share a file name and size, so also check it was derived from this very map.
  const hit = _effectiveMapCache.get(cacheKey);
  if (hit && hit.fullCanvas === fullCanvas) {
    _effectiveMapCache.delete(cacheKey);   // refresh LRU order
    _effectiveMapCache.set(cacheKey, hit);
    return hit.entry;
  }
  const offscreen = document.createElement('canvas');
  offscreen.width  = width;
  offscreen.height = height;
  const ctx = offscreen.getContext('2d');
  if (textureSmoothing > 0) {
    // The slider is in pixels of a 512 px map; custom maps can be up to
    // 2048 px (#89), so scale the radius to blur the same share of the tile.
    const sigma = textureSmoothing * Math.max(1, Math.max(width, height) / REF_TEXTURE_SIZE);
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
  if (invert) {
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
  const entry = { ...mapEntry, imageData, texture };
  _effectiveMapCache.set(cacheKey, { entry, fullCanvas });
  while (_effectiveMapCache.size > EFFECTIVE_MAP_CACHE_MAX) {
    const oldestKey = _effectiveMapCache.keys().next().value;
    const old = _effectiveMapCache.get(oldestKey);
    _effectiveMapCache.delete(oldestKey);
    if (old && old.entry.texture && previewMaterial) {
      // Don't yank a texture the material still samples; it'll be replaced
      // on the next updatePreview and disposed with the material.
      const u = previewMaterial.uniforms;
      const bound = [u.map0, u.map1, u.map2, u.map3].some(m => m && m.value === old.entry.texture);
      if (!bound) old.entry.texture.dispose();
    } else if (old && old.entry.texture) {
      old.entry.texture.dispose();
    }
  }
  return entry;
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

// Global settings for the preview material's uniforms (per-layer parameters
// come from _previewLayers).
function _materialSettings(preview) {
  return {
    bounds: currentBounds,
    bottomAngleLimit: settings.bottomAngleLimit,
    topAngleLimit:    settings.topAngleLimit,
    noDownwardZ:      settings.noDownwardZ,
    // The displaced mesh exists only once its async build finishes; until
    // then the base mesh keeps bump-only shading.
    useDisplacement: settings.useDisplacement && !!dispPreviewGeometry,
    activeLayer: preview.activeIdx,
    // Per-fragment edge falloff (bump-only mode) follows the active layer.
    boundaryFalloff:      settings.boundaryFalloff,
    boundaryFalloffCurve: settings.boundaryFalloffCurve,
    // With several layers, surfaces the active layer does not cover are
    // shown in neutral grey instead of the single-layer orange/dark grey.
    layeredTint: preview.count > 1,
  };
}

/** Rebuild the preview material's per-layer uniforms and global settings. */
function _syncPreviewMaterial() {
  if (!previewMaterial) return;
  const preview = _previewLayers();
  updateMaterial(previewMaterial, preview.list, _materialSettings(preview));
}

function updatePreview() {
  if (!currentGeometry || !currentBounds) return;

  if (!_hasTexturedLayer()) {
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
    _renderLayerStrip();
    return;
  }

  // Choose geometry: 3D preview → painted (flattened tree) → original
  _refreshPaintGeometry();
  const activeGeo = _displayGeometry();

  // Ensure the per-layer mask attributes are current before rendering
  updateFaceMask(activeGeo);

  const preview = _previewLayers();
  if (!previewMaterial) {
    previewMaterial = createPreviewMaterial(preview.list, _materialSettings(preview));
    loadGeometry(activeGeo, previewMaterial);
  } else {
    updateMaterial(previewMaterial, preview.list, _materialSettings(preview));
  }

  syncBoundaryEdgeUniforms();
  exportBtn.disabled = false;
  export3mfBtn.disabled = false;
  bakeBtn.disabled = isBaking;
  updateSmartResBtnState();
  _renderLayerStrip();
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

  // Supersede any in-flight build (a re-enable restarts it).
  cancelDisplacementPreviewBuild();

  if (!enable) {
    // Revert to the painted / original geometry with bump-only shading.
    if (currentGeometry && previewMaterial) {
      _refreshPaintGeometry();
      updateFaceMask(_paintDisplayGeometry());
      _syncPreviewMaterial();
      setMeshGeometry(_paintDisplayGeometry());
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
  if (!currentGeometry || !currentBounds || !_hasTexturedLayer()) {
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
    {
      const preview = _previewLayers();
      previewMaterial = createPreviewMaterial(preview.list, _materialSettings(preview));
    }
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
  if (!paintTree) return null;
  const hardFlags = [];
  for (const { index, isActive } of _layerSlots()) {
    if (!layers[index].visible) continue;
    const includeOnly = isActive ? selectionMode : !!layers[index].includeOnly;
    const hard = paintTree.baseFaceUntextured(_slotOf(index), includeOnly);
    if (!hard) return null;   // a layer textures everything → nothing to skip
    hardFlags.push(hard);
  }
  if (!hardFlags.length) return null;
  const excluded = _unionFaceWeights(hardFlags, currentGeometry, false);
  if (excluded.size === 0) return null;
  const triCount = currentGeometry.attributes.position.count / 3;
  const flags = new Uint8Array(triCount);
  for (const f of excluded) flags[f] = 1;
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
  if (!currentGeometry || !_hasTexturedLayer() || isExporting || isBaking) return;
  const myToken = ++exportToken;
  isExporting = true;
  exportBtn.classList.add('busy');
  export3mfBtn.classList.add('busy');
  exportProgress.classList.remove('hidden');

  let finalGeometry   = null;
  let exportSucceeded = false; // set true only after exportSTL so finally can clean up on abort/error

  try {
    setProgress(0.02, t('progress.subdividing'));
    await yieldFrame();
    if (exportToken !== myToken) return;

    // Build per-vertex exclusion weights combining user-painted exclusion + angle masking.
    // Faces masked by top/bottom angle limits are treated the same as user-excluded faces
    // so subdivision skips their interior edges too, saving triangles where no
    // displacement will be applied. Soft-brush paint rides along separately.
    // With several visible layers the pipeline composites them per vertex
    // (exportPipeline.js `layers`).
    const inputs = _pipelineInputs();

    // Run the heavy pipeline (subdivide → regularize → displace → decimate →
    // bottom snaps → repair), preferably in the export worker so the UI stays
    // responsive and background-tab throttling can't stall it. Falls back to
    // running inline if the worker can't initialise. See exportPipeline.js.
    const isStale = () => exportToken !== myToken;
    const result = await runPipeline({
      positions: inputs.positions,
      faceWeights: inputs.faceWeights,
      softExclude: inputs.softExclude,
      imageData: inputs.imageData,
      imgWidth: inputs.imgWidth,
      imgHeight: inputs.imgHeight,
      layers: inputs.layers,
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

    const texLabel = inputs.label;
    const ampLabel = settings.amplitude.toFixed(2).replace('.', 'p');
    const baseName = inputs.layers
      ? `${currentStlName}_${texLabel}`
      : `${currentStlName}_${texLabel}_amp${ampLabel}`;

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
  if (!currentGeometry || !_hasTexturedLayer() || isBaking || isExporting) return;
  isBaking = true;
  bakeBtn.classList.add('busy');
  bakeBtn.disabled = true;
  bakeProgress.classList.remove('hidden');

  let displaced  = null;
  let succeeded  = false;

  try {
    setBakeProgress(0.02, t('progress.subdividing'));
    await yieldFrame();

    // Mirror handleExport's pre-flight: combine user mask + angle masking
    // into per-vertex weights for subdivision, plus soft-brush paint (or the
    // per-layer masks when several layers are visible).
    const inputs = _pipelineInputs();
    const faceWeights = inputs.faceWeights;

    // Run the bake pipeline (subdivide → regularize → displace → bottom
    // snaps; no decimation — it would drop the per-face parent mapping needed
    // to remap user exclusions onto the baked output). Worker-first with
    // inline fallback, same as handleExport.
    const result = await runPipeline({
      positions: inputs.positions,
      faceWeights,
      softExclude: inputs.softExclude,
      imageData: inputs.imageData,
      imgWidth: inputs.imgWidth,
      imgHeight: inputs.imgHeight,
      layers: inputs.layers,
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
    bakeBtn.disabled = !_hasTexturedLayer();
  }
}

// Replace currentGeometry with `geometry` and reset per-model state without
// touching the user's texture/settings. Mirrors the relevant subset of
// handleModelFile but keeps activeMapEntry, settings, and refineLength as-is,
// and seeds the exclusion paint from opts.preExcludedFaces.
function adoptBakedGeometry(geometry, bounds, opts = {}) {
  // Invalidate any in-flight async operations tied to the previous mesh.
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

  // Reset mesh diagnostics — they referenced the pre-bake mesh.
  meshDiagnostics.classList.add('hidden');
  meshDiagAdvanced.classList.add('hidden');
  lastFastDiag = null;
  lastAdvancedDiag = null;
  clearDiagHighlight();

  // The seeded mask carries exclude-mode semantics ("don't re-texture these
  // faces"). If the user was in include-only mode pre-bake, that mode would
  // invert the meaning to "only texture these faces" — exactly backwards. So
  // force exclude mode (the old paint is gone with the old mesh anyway).
  _dropPaintGeometry();
  paintTree = null;
  if (selectionMode) setSelectionMode(false, { clear: false });

  // The bake flattened every layer into the geometry: continue with a single
  // fresh layer that keeps the active layer's texture and settings.
  layers = [_newLayer()];
  activeLayer = 0;
  _renderLayerStrip();

  // Exit any active painting/place/rotate modes.
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
  _createPaintTree(adjData);
  updateMeshDiagnostics(adjData, geometry.attributes.position.count / 3);

  // Seed the exclusion mask with the just-baked faces so a follow-up texture
  // pass won't double up. Soft paint doesn't carry over: the baked faces it
  // touched are in the seed.
  const seed = opts.preExcludedFaces || [];
  if (seed.length) paintTree.paintFaces(_activeSlot(), seed, false);
  // A seeded post-bake mask means masking is actively in play (exclude mode
  // was forced above); no seed = back to the neutral default.
  maskModeChosen = seed.length > 0;
  updateMaskModeButtons();
  refreshExclusionOverlay();

  // Update mesh info display.
  triLimitWarning.classList.add('hidden');
  const triCount = getTriangleCount(geometry);
  const mb = ((geometry.attributes.position.array.byteLength) / 1024 / 1024).toFixed(2);
  const sx = bounds.size.x.toFixed(2);
  const sy = bounds.size.y.toFixed(2);
  const sz = bounds.size.z.toFixed(2);
  _setMeshInfo(triCount, mb, sx, sy, sz);

  exportBtn.disabled = !_hasTexturedLayer();
  export3mfBtn.disabled = !_hasTexturedLayer();
  bakeBtn.disabled = !_hasTexturedLayer();
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

// Settings that are NOT per layer (see LAYER_KEYS): resolution, triangle
// limit, angle masks, bottom handling, and the panel state.
const GLOBAL_KEYS = PERSISTED_KEYS.filter(k => !LAYER_KEYS.includes(k));

function _globalSettingsSnapshot() {
  const snap = {};
  for (const k of GLOBAL_KEYS) snap[k] = settings[k];
  return snap;
}

/**
 * Session / project snapshot: the global settings, the ACTIVE layer flattened
 * to the top level (what every older reader expects), plus `layers` — each
 * layer's settings, map reference, mode, visibility and blend — and the
 * active index. The paint is not part of it (see paint.json in the project export).
 */
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
  snap.layers = layers.map((L, i) => {
    const isActive = i === activeLayer;
    const entry = isActive ? activeMapEntry : L.mapEntry;
    return {
      id: L.id,
      settings: isActive ? _layerSettingsSnapshot() : { ...L.settings },
      activeMapName:  isActive ? snap.activeMapName  : (entry?.name ?? L.mapName ?? null),
      activeCustomId: isActive ? snap.activeCustomId : (entry?.customId ?? L.customId ?? null),
      includeOnly: isActive ? selectionMode : !!L.includeOnly,
      visible: L.visible,
      blendAdd: L.blendAdd,
    };
  });
  snap.activeLayer = activeLayer;
  return snap;
}

/** Per-layer settings from a saved layer record, on top of the live layer's values. */
function _layerSettingsFrom(saved) {
  const out = _layerSettingsSnapshot();
  if (saved && typeof saved === 'object') {
    for (const k of LAYER_KEYS) if (k in saved) out[k] = saved[k];
    if (saved.scaleUnit !== 'mm') {
      // Legacy relative scale fractions — convert like applySettingsSnapshot would.
      const m = _migrateSnapshotScaleToMm({ ...out, scaleUnit: saved.scaleUnit });
      out.scaleU = m.scaleU; out.scaleV = m.scaleV;
    }
  }
  out.scaleUnit = 'mm';
  return out;
}

/**
 * Rebuild `layers` from a snapshot's layer list (session restore or project
 * import). Maps are resolved afterwards by _loadLayerMaps; masks are the
 * caller's business. Returns false when the snapshot has no layer list.
 */
function _layersFromSnapshot(data) {
  if (!data || !Array.isArray(data.layers) || data.layers.length === 0) return false;
  const list = data.layers.slice(0, MAX_LAYERS).map((d) => _newLayer({
    settings: _layerSettingsFrom(d.settings),
    mapName:  d.activeMapName || null,
    customId: d.activeCustomId || null,
    mapEntry: null,
    includeOnly: !!d.includeOnly,
    maskModeChosen: !!d.includeOnly,
    visible: d.visible !== false,
    blendAdd: !!d.blendAdd,
  }));
  layers = list;
  activeLayer = Math.max(0, Math.min(list.length - 1, Number(data.activeLayer) || 0));
  return true;
}

/** Resolve a map reference (preset name or library id) to a loaded entry, or null. */
async function _loadMapEntry(name, customId) {
  if (customId) {
    try {
      const file = await getCustomTextureFile(customId);
      if (file) {
        const entry = await loadCustomTexture(file);
        entry.isCustom = true;
        entry.customId = customId;
        return entry;
      }
    } catch (err) {
      console.warn('Layer texture unavailable:', err);
    }
  }
  if (name) {
    const idx = IMAGE_PRESETS.findIndex(p => p.name === name);
    if (idx >= 0) {
      if (!PRESETS[idx].texture) {
        try {
          const full = await loadFullPreset(idx);
          if (!PRESETS[idx].texture) PRESETS[idx] = { ...PRESETS[idx], ...full };
        } catch (err) {
          console.warn('Layer preset failed to load:', err);
          return null;
        }
      }
      return PRESETS[idx];
    }
  }
  return null;
}

/** Load the maps of every inactive layer that doesn't have one yet, then refresh the preview. */
async function _loadLayerMaps() {
  const gen = ++_layerLoadGeneration;
  const pending = layers.filter((L, i) => i !== activeLayer && !(L.mapEntry && L.mapEntry.texture));
  for (const L of pending) {
    const entry = await _loadMapEntry(L.mapName, L.customId);
    if (gen !== _layerLoadGeneration) return;      // layers were replaced meanwhile
    if (layers.includes(L) && entry) L.mapEntry = entry;
  }
  if (pending.length) updatePreview();
}
let _layerLoadGeneration = 0;

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
  if (_layersFromSnapshot(data)) {
    _syncTreeLayers();
    const L = layers[activeLayer];
    if (L.includeOnly && !selectionMode) setSelectionMode(true, { clear: false });
    _renderLayerStrip();
    _loadLayerMaps();
  }
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

    // Back to a single layer with no paint, in Exclude mode.
    layers = [_newLayer({ includeOnly: false, maskModeChosen: false })];
    activeLayer = 0;
    _syncTreeLayers();
    if (paintTree) paintTree.clearLayer(_activeSlot());
    if (selectionMode) setSelectionMode(false, { clear: false });
    maskModeChosen         = false;
    updateMaskModeButtons();
    _renderLayerStrip();
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

/** Map entry of layer i as it currently stands (live for the active layer). */
function _layerMapEntry(i) {
  return i === activeLayer ? activeMapEntry : layers[i].mapEntry;
}

exportProjectBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  // Offer custom-texture export whenever a layer uses one, or one has been
  // uploaded this session even if a preset is currently active —
  // _lastCustomMap survives preset switches.
  const hasCustom = !!(_lastCustomMap && _lastCustomMap.fullCanvas)
    || layers.some((L, i) => _layerMapEntry(i)?.isCustom && _layerMapEntry(i)?.fullCanvas);
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
    const activeCustom   = (activeMapEntry?.isCustom && activeMapEntry.fullCanvas) ? activeMapEntry : null;
    // Legacy single-texture slot: the active layer's custom map, else the last
    // upload (older readers activate it through activeMapName).
    const customSource   = activeCustom || ((_lastCustomMap && _lastCustomMap.fullCanvas) ? _lastCustomMap : null);
    const includeTexture = exportTextureChk.checked && !!customSource;
    const payload = { version: PROJECT_VERSION, ...getSettingsSnapshot() };
    delete payload.activeCustomId;   // a browser-local library id means nothing in another browser
    for (const d of payload.layers) delete d.activeCustomId;
    // Mark the custom map as the active reference so the importer restores it
    // even if the user has a preset selected at export time.
    if (includeTexture) payload.activeMapName = customSource.name;
    // The bundled model is written in its ORIGINAL pose (issue #82), so the
    // in-app rotation must ride along in the settings for the importer to
    // replay — otherwise a saved session would lose its orientation.
    if (includeModel && Math.abs(currentPoseRot.w) < 1 - 1e-12) {
      payload.poseRotation = currentPoseRot.toArray();
    }
    const zipFiles = {};

    if (includeModel) {
      // Written in the original pose (issue #82); re-importing re-centers and
      // replays poseRotation, so project round-trips stay stable.
      zipFiles['model.stl'] = _geometryToBinarySTL(currentGeometry, true);
      // The paint tree indexes the base geometry's triangles, so it only makes
      // sense alongside the model that produced it. paint.json holds every
      // layer's strokes; mask.json is the active layer's hard paint as a face
      // list, what older readers expect.
      if (paintTree) {
        // Per-leaf-corner coverage: the import welds the STL's rounded
        // coordinates afresh, and per-vertex coverage would not survive a
        // regrouped vertex (#134).
        const data = paintTree.serialize({ leafCov: true });
        zipFiles['paint.json'] = strToU8(JSON.stringify(PaintTree.toJSON(data)));
        payload.paint = 'paint.json';
        const legacy = _legacyMaskOf(_activeSlot());
        if (legacy) zipFiles['mask.json'] = strToU8(JSON.stringify(legacy));
      }
    }
    if (includeTexture) {
      const blob = await new Promise(r => customSource.fullCanvas.toBlob(r, 'image/png'));
      zipFiles['texture.png'] = new Uint8Array(await blob.arrayBuffer());
      // Per-layer custom maps (the active layer's is the same bytes as texture.png).
      for (let i = 0; i < layers.length; i++) {
        const entry = _layerMapEntry(i);
        if (!(entry?.isCustom && entry.fullCanvas)) continue;
        const fname = `texture-${i}.png`;
        if (entry === customSource) zipFiles[fname] = zipFiles['texture.png'];
        else {
          const b2 = await new Promise(r => entry.fullCanvas.toBlob(r, 'image/png'));
          zipFiles[fname] = new Uint8Array(await b2.arrayBuffer());
        }
        payload.layers[i].texture = fname;
        payload.layers[i].activeMapName = entry.name;
      }
    }
    zipFiles['settings.json'] = strToU8(JSON.stringify(payload, null, 2));

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
 * The active layer's hard paint as the pre-tree project mask (base faces
 * whose root is painted whole), or null when there is none. Older versions
 * read this; strokes finer than a base face are only in paint.json.
 */
function _legacyMaskOf(slot) {
  if (!paintTree || slot < 0) return null;
  const tl = paintTree.layers[slot];
  const excluded = [];
  for (let f = 0; f < paintTree.baseTriCount; f++) if (tl.state[f]) excluded.push(f);
  if (excluded.length === 0 && !selectionMode) return null;
  return { selectionMode, excluded };
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

      // Apply settings after the model reset. The mask is restored below,
      // once the layer it belongs to exists: by _importLayers for a layered
      // project, by _restoreLegacyProjectMask for a pre-layer one.
      if (data) applySettingsSnapshot(data);
    } else {
      // Settings only: keep the current model and its mask untouched. We skip
      // model.stl (and never call handleModelFile, so the scale/offset/refine
      // resets don't fire) and mask.json (its indices belong to the saved
      // model, not the live one).
      if (data) applySettingsSnapshot(data);
    }

    if (data && Array.isArray(data.layers) && data.layers.length) {
      await _importLayers(unzipped, data, loadMode === 'all');
    } else {
      // Pre-layer project: a single layer, described by the top-level fields.
      // Collapse to that layer and give it a tree slot BEFORE restoring the
      // mask — restoring first left the paint under a layer id nothing
      // referenced any more, so it neither showed nor exported (#134).
      // Settings-only keeps the active layer's id, and with it the paint on
      // the model that stays loaded.
      const activeId = layers[activeLayer]?.id;
      layers = [_newLayer(loadMode === 'settings' && activeId != null ? { id: activeId } : {})];
      activeLayer = 0;
      _syncTreeLayers();
      if (loadMode === 'all') _restoreLegacyProjectMask(unzipped);
      else if (paintTree) refreshExclusionOverlay();
      await _applyImportedTexture(unzipped, data);
      _renderLayerStrip();
    }

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
 * Pre-layer project mask (mask.json: base-face list + soft corners) → the
 * active layer's paint. Only meaningful right after the bundled model was
 * loaded, since the indices reference its triangles.
 */
function _restoreLegacyProjectMask(unzipped) {
  if (!unzipped['mask.json'] || !paintTree) return;
  try {
    const mask = JSON.parse(strFromU8(unzipped['mask.json']));
    if (!mask || typeof mask !== 'object') return;
    if (!!mask.selectionMode !== selectionMode) setSelectionMode(!!mask.selectionMode, { clear: false });
    _importLegacyMask(_activeSlot(), mask);
    maskModeChosen = true;
    updateMaskModeButtons();
    refreshExclusionOverlay();
  } catch (err) { console.warn('Could not restore paint mask:', err); }
}

/**
 * Rebuild the layers of a layered project: settings, maps (bundled PNGs win
 * over preset names), modes and — with the bundled model loaded — masks.
 */
async function _importLayers(unzipped, data, withMasks) {
  _layersFromSnapshot(data);
  _syncTreeLayers();
  const files = data.layers.slice(0, layers.length);
  for (let i = 0; i < layers.length; i++) {
    const L = layers[i], d = files[i] || {};
    if (d.texture && unzipped[d.texture]) {
      try {
        const texName = d.activeMapName || d.texture;
        const entry = await loadCustomTexture(new File([unzipped[d.texture]], texName, { type: 'image/png' }));
        entry.isCustom = true;
        entry.name = texName;
        L.mapEntry = entry;
        L.mapName = texName;
      } catch (err) { console.warn('Layer texture failed to load:', err); }
    }
    if (!L.mapEntry) L.mapEntry = await _loadMapEntry(L.mapName, null);
    // Pre-paint-tree layered projects: one face-list mask per layer.
    if (withMasks && paintTree && d.mask && unzipped[d.mask]) {
      try {
        const m = JSON.parse(strFromU8(unzipped[d.mask]));
        if (m && typeof m === 'object') {
          L.includeOnly = !!m.selectionMode;
          L.maskModeChosen = true;
          _importLegacyMask(_slotOf(i), m);
        }
      } catch (err) { console.warn('Could not restore a layer mask:', err); }
    }
  }
  if (withMasks && paintTree && data.paint && unzipped[data.paint]) {
    try {
      const j = JSON.parse(strFromU8(unzipped[data.paint]));
      const restored = PaintTree.fromJSON(j);
      if (restored) {
        // The saved tree names layers by the ids of the saving session; the
        // rebuilt records have fresh ids, matched up by position.
        const idMap = new Map();
        files.forEach((d2, k) => { if (d2 && d2.id != null && layers[k]) idMap.set(d2.id, layers[k].id); });
        restored.layerIds = restored.layerIds.map(id => idMap.has(id) ? idMap.get(id) : id);
        if (!paintTree.deserialize(restored)) {
          // Only a different triangle count gets here now; say so instead of
          // silently loading the model without its mask (#134).
          console.warn('Saved paint does not match the loaded model');
          alert(t('alerts.paintNotRestored'));
        }
      }
      _syncTreeLayers();
    } catch (err) { console.warn('Could not restore the paint:', err); }
  }
  _materialiseActiveLayer();
  _renderLayerStrip();
  updatePreview();
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
// the global settings, the layer list (settings, map, mode, visibility per
// layer) and the serialized paint tree. Operations are debounced so a slider
// drag collapses to one undo step.

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
    active: activeLayer,
    global: _globalSettingsSnapshot(),
    layers: layers.map((L, i) => (i === activeLayer
      ? { id: L.id, settings: _layerSettingsSnapshot(), mapName: activeMapEntry?.name ?? null,
          customId: activeMapEntry?.customId ?? null, mapEntry: activeMapEntry,
          includeOnly: selectionMode, maskModeChosen, visible: L.visible, blendAdd: L.blendAdd }
      : { id: L.id, settings: { ...L.settings }, mapName: L.mapName, customId: L.customId,
          mapEntry: L.mapEntry, includeOnly: !!L.includeOnly, maskModeChosen: !!L.maskModeChosen,
          visible: L.visible, blendAdd: L.blendAdd })),
    paint: paintTree ? paintTree.serialize() : null,
  };
}

function _undoSnapshotsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.active !== b.active || a.layers.length !== b.layers.length) return false;
  for (const k of GLOBAL_KEYS) {
    if (a.global[k] !== b.global[k]) return false;
  }
  for (let i = 0; i < a.layers.length; i++) {
    const la = a.layers[i], lb = b.layers[i];
    if (la.id !== lb.id || la.visible !== lb.visible || la.blendAdd !== lb.blendAdd) return false;
    if (la.includeOnly !== lb.includeOnly || la.maskModeChosen !== lb.maskModeChosen) return false;
    if ((la.mapName || null) !== (lb.mapName || null)) return false;
    if ((la.customId || null) !== (lb.customId || null)) return false;
    for (const k of LAYER_KEYS) {
      if (la.settings[k] !== lb.settings[k]) return false;
    }
  }
  return PaintTree.serializedEqual(a.paint, b.paint);
}

function _commitUndoCapture() {
  _undoCaptureTimer = null;
  if (_undoApplyDepth > 0) return;
  // A stroke in progress commits on its own mouseup; a debounced capture from
  // just before it must not cut the stroke into two steps.
  if (isPainting) { _scheduleUndoCapture(); return; }
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
    layers = snap.layers.map(l => ({
      id: l.id, settings: { ...l.settings }, mapName: l.mapName, customId: l.customId,
      mapEntry: l.mapEntry, includeOnly: !!l.includeOnly, maskModeChosen: !!l.maskModeChosen,
      visible: l.visible, blendAdd: l.blendAdd,
    }));
    activeLayer = Math.max(0, Math.min(layers.length - 1, snap.active));
    if (paintTree) {
      _syncTreeLayers();
      if (snap.paint) paintTree.deserialize(snap.paint);
      _syncTreeLayers();
    }
    // Global settings first: applySettingsSnapshot resets a few per-layer
    // controls it doesn't find (invert, falloff curve), which the layer
    // materialisation then sets properly.
    applySettingsSnapshot(snap.global);
    _materialiseActiveLayer();
    _renderLayerStrip();
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
