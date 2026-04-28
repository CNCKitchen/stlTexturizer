import * as THREE from 'three';
import { initViewer, loadGeometry, setMeshMaterial, setMeshGeometry, setWireframe,
         getControls, getCamera, getCurrentMesh,
         setExclusionOverlay, setHoverPreview, setViewerTheme,
         setProjection, requestRender,
         clearDiagOverlays, setDiagEdges, addDiagFaces,
         setRotationGizmo, isGizmoDragging } from './viewer.js';
import { loadModelFile, computeBounds, getTriangleCount }  from './stlLoader.js';
import { loadAllThumbnails, loadFullPreset, loadCustomTexture, IMAGE_PRESETS }  from './presetTextures.js';
import { createPreviewMaterial, updateMaterial, setColorPreview } from './previewMaterial.js';
import { subdivide }          from './subdivision.js';
import { applyDisplacement }  from './displacement.js';
import { decimate }           from './decimation.js';
import { exportSTL, export3MF } from './exporter.js';
import { buildAdjacency, bucketFill,
         buildExclusionOverlayGeo, buildFaceWeights } from './exclusion.js';
import { applyColors }         from './colorBake.js';
import { medianCut }           from './quantize.js';
import { GradientEditor }      from './gradientEditor.js';
import { runFastDiagnostics, runExpensiveDiagnostics,
         getEdgePositions, getShellAssignments } from './meshValidation.js';
import { t, initLang, setLang, getLang, applyTranslations, TRANSLATIONS } from './i18n.js';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';

// ── State ─────────────────────────────────────────────────────────────────────

let currentGeometry   = null;   // original loaded geometry
let currentBounds     = null;   // bounds of the original geometry
let currentStlName    = 'model'; // base filename of the loaded STL (no extension)
let activeMapEntry    = null;   // { name, texture, imageData, width, height, isCustom? }
let _lastCustomMap    = null;   // most recent uploaded/imported custom-map entry, kept across preset switches so the thumbnail can re-activate it
let previewMaterial   = null;
let isExporting       = false;
let isBaking          = false;
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
let bucketThreshold    = 20;
let isPainting         = false;
let selectionMode      = false;       // false = exclude painted faces; true = include only painted faces
let _lastHoverTriIdx   = -1;          // last triangle index used for hover preview
let placeOnFaceActive  = false;       // true while "Place on Face" mode is active
let rotateActive       = false;       // true while rotate mode is active
let rotateAngles       = { x: 0, y: 0, z: 0 };  // accumulated rotation in degrees
let _rotateOriginalPositions = null;  // Float32Array snapshot before any rotation
const _raycaster       = new THREE.Raycaster();
let _lastPaintHitPoint = null;        // THREE.Vector3 — last brush paint position for shift-line
let _shiftLineMesh     = null;        // THREE.Line — preview line from last paint to cursor

// ── Color image state ─────────────────────────────────────────────────────────
// Uploaded color image (separate from displacement texture). Held at module scope
// rather than in `settings` so the binary asset never lands in sessionStorage —
// it persists in `.bumpmesh` projects via a separate `color.png` zip entry.
let _lastColorMap      = null;        // { name, imageData, width, height, fullCanvas }
let _colorImageTexture = null;        // THREE.CanvasTexture wrapping _lastColorMap.fullCanvas
let _gradientLUTCanvas = null;        // 256×1 canvas, rebuilt from gradient stops
let _gradientLUTTexture = null;       // THREE.CanvasTexture wrapping _gradientLUTCanvas

let _lastEffectiveTexture = null;
let _effectiveMapCache    = null;
let _effectiveMapCacheKey = null;

const settings = {
  mappingMode:   5,     // Triplanar default
  scaleU:        0.5,
  scaleV:        0.5,
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
  capAngle:         20,
  boundaryFalloff:  0,
  symmetricDisplacement: false,
  noDownwardZ: false,
  useDisplacement: false,
  // Cylindrical-mode controls.
  // null/undefined → derive from bounds (preserves legacy / non-cylindrical behavior).
  snapSeamlessWrap: true,
  cylinderCenterX:  null,
  cylinderCenterY:  null,
  cylinderRadius:   null,
  cylinderPanelMinimized: false,
  // ── Color export (3MF) ────────────────────────────────────────────────────
  colorExportEnabled:   false,
  colorAutoSource:      'none',         // 'none' | 'gradient' | 'image'
  colorBaseColor:       '#ffffff',      // applied to non-textured / excluded faces
  // Number of distinct palette entries in the exported 3MF. Caps median-cut so
  // slicers don't see N=32 filament slots when the user only has e.g. 4. The
  // dropdown in the UI offers 2/3/4/6/8/16/32; default 4 matches typical AMS.
  // Only used when colorAutoSource === 'image' (gradient mode snaps to
  // control points and ignores this).
  colorPaletteSize:     4,
  // When true, the live preview's gradient LUT is built as a stepped
  // (per-stop) palette instead of a smooth interpolation, so the on-screen
  // tint matches what the snap-to-control-points export will produce.
  colorSnapPreview:     false,
  // N-stop gradient: array of { pos: 0..1, color: '#RRGGBB', lockedToBase: bool }.
  // Two stops minimum, enforced by the gradient editor widget.
  colorGradientStops: [
    { pos: 0, color: '#222222' },
    { pos: 1, color: '#dddddd' },
  ],
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

// ── Displacement preview state ────────────────────────────────────────────────
let dispPreviewGeometry  = null;   // subdivided geometry with smoothNormal attribute
let dispPreviewBusy      = false;  // true while async subdivision is running
let dispPreviewParentMap = null;   // Int32Array: subdivided face → original face index

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
const stlFileInput   = document.getElementById('stl-file-input');
const textureInput   = document.getElementById('texture-file-input');
const presetGrid     = document.getElementById('preset-grid');
const activeMapName  = document.getElementById('active-map-name');
const customMapRow      = document.getElementById('custom-map-row');
const customMapSwatch   = document.getElementById('custom-map-swatch');
const customMapRemoveBtn = document.getElementById('custom-map-remove');
const meshInfo       = document.getElementById('mesh-info');
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
const symmetricDispToggle    = document.getElementById('symmetric-displacement');
const dispPreviewToggle      = document.getElementById('displacement-preview');
const noDownwardZChk         = document.getElementById('no-downward-z-chk');

// ── Exclusion panel DOM refs ──────────────────────────────────────────────────
const exclBrushBtn        = document.getElementById('excl-brush-btn');
const exclBucketBtn       = document.getElementById('excl-bucket-btn');
const exclBrushTypeRow    = document.getElementById('excl-brush-type-row');
const exclBrushSingleBtn  = document.getElementById('excl-brush-single');
const exclBrushRadiusBtn  = document.getElementById('excl-brush-radius-btn');
const exclRadiusRow       = document.getElementById('excl-radius-row');
const exclBrushRadiusSlider = document.getElementById('excl-brush-radius-slider');
const exclBrushRadiusVal    = document.getElementById('excl-brush-radius-val');
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
const WELCOME_LAST_UPDATED = '2026-04-28';
const WELCOME_STORAGE_KEY  = 'stlt-welcome-seen';
const welcomeLink     = document.getElementById('welcome-link');
const welcomeOverlay  = document.getElementById('welcome-overlay');
const welcomeClose    = document.getElementById('welcome-close');
const welcomeGotIt    = document.getElementById('welcome-got-it');
const welcomeDontShow = document.getElementById('welcome-dont-show');

// ── Language selector DOM refs ────────────────────────────────────────────────────
const languageSelector = document.querySelector('.lang-seg');

// ── Scale slider log helpers ──────────────────────────────────────────────────
// Slider stores 0–1000; actual scale spans 0.05–10 on a log axis.
// Middle position 500 → scale ~0.71 (log midpoint between 0.05 and 10).
const _LOG_MIN = Math.log(0.05);
const _LOG_MAX = Math.log(10);
const scaleToPos = v => Math.round(Math.max(0, Math.min(1000, (Math.log(Math.max(0.01, Math.min(10, v))) - _LOG_MIN) / (_LOG_MAX - _LOG_MIN) * 1000)));
const posToScale = p => parseFloat(Math.exp(_LOG_MIN + (p / 1000) * (_LOG_MAX - _LOG_MIN)).toFixed(2));

// Compute the active U texture-aspect factor (mirrors updatePreview's logic so
// the snap math agrees with what computeUV actually does).
function _currentTextureAspectU() {
  const tw = activeMapEntry?.width ?? 1, th = activeMapEntry?.height ?? 1;
  const tmax = Math.max(tw, th, 1);
  return tmax / Math.max(tw, 1);
}

// Round a U scale to the nearest seamless-wrap value:
//   tiles around circumference = aspectU / scaleU  →  must be a positive integer.
// Returns the snapped scale, clamped to [aspectU/MAX_TILES, aspectU].
function _snapScaleUForSeamlessWrap(scaleU) {
  const aU = _currentTextureAspectU();
  const MAX_TILES = 20;
  let n = Math.round(aU / Math.max(scaleU, 1e-6));
  if (!Number.isFinite(n) || n < 1) n = 1;
  if (n > MAX_TILES) n = MAX_TILES;
  return parseFloat((aU / n).toFixed(4));
}

function _applyScaleU(v) {
  v = Math.max(0.01, Math.min(10, v));
  if (settings.snapSeamlessWrap && settings.mappingMode === 3 /* MODE_CYLINDRICAL */) {
    v = _snapScaleUForSeamlessWrap(v);
  }
  settings.scaleU = v;
  scaleUSlider.value = scaleToPos(v);
  scaleUVal.value = v;
  if (settings.lockScale) { settings.scaleV = v; scaleVSlider.value = scaleToPos(v); scaleVVal.value = v; }
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
  cylinderSnapRow.style.display = isCyl ? '' : 'none';
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

initViewer(canvas);

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
      meshInfo.textContent = t('ui.meshInfo', { n: triCount.toLocaleString(), mb, sx, sy, sz });
      refreshExclusionOverlay();
      if (lastFastDiag) renderFastDiag(lastFastDiag);
      if (lastAdvancedDiag) renderAdvancedDiag(lastAdvancedDiag);
    }
    // The cylinder panel paints its placeholder text via Canvas2D, which
    // applyTranslations() doesn't reach — re-render so the new locale lands.
    _scheduleCylinderPanelRedraw();
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

wireEvents();
showWelcomeIfNeeded();
// Sync scale number inputs with the slider's initial position
scaleUVal.value = posToScale(parseFloat(scaleUSlider.value));
scaleVVal.value = posToScale(parseFloat(scaleVSlider.value));

// Load geometry immediately — don't wait for textures
loadDefaultCube();

// Build swatches with placeholder canvases, then load thumbnails
const DEFAULT_PRESET_NAME = 'Crystal';
const _presetSwatches = IMAGE_PRESETS.map((p, idx) => {
  const swatch = document.createElement('div');
  swatch.className = 'preset-swatch preset-loading';
  swatch.setAttribute('role', 'button');
  swatch.setAttribute('tabindex', '0');
  swatch.title = p.name;

  const placeholder = document.createElement('canvas');
  placeholder.width = 80; placeholder.height = 80;
  swatch.appendChild(placeholder);

  const label = document.createElement('span');
  label.className = 'preset-label';
  label.textContent = p.name;
  swatch.appendChild(label);

  swatch.addEventListener('click', () => selectPreset(idx, swatch));
  swatch.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      selectPreset(idx, swatch);
    }
  });
  presetGrid.appendChild(swatch);
  return swatch;
});

// Load lightweight thumbnails (~49 KB total), then auto-select a preset.
// If localStorage has a persisted preset name, pick that one with defaults
// suppressed (so the user's saved textureSmoothing / scaleU are preserved);
// otherwise fall back to the built-in default and apply its defaults.
loadAllThumbnails().then(thumbs => {
  thumbs.forEach((thumb, idx) => {
    if (!thumb) return;
    PRESETS[idx] = thumb;         // thumbnail-only entry for now
    const swatch = _presetSwatches[idx];
    if (!swatch) return;
    swatch.classList.remove('preset-loading');
    const placeholder = swatch.querySelector('canvas');
    swatch.replaceChild(thumb.thumbCanvas, placeholder);
  });

  let persistedName = null;
  try {
    const raw = sessionStorage.getItem('bumpmesh-settings');
    if (raw) persistedName = (JSON.parse(raw) || {}).activeMapName || null;
  } catch { /* ignore */ }

  let targetIdx = -1;
  // If the user had ANY map active last session (preset or a since-discarded
  // custom upload), suppress preset defaults so the restored settings survive
  // — we'd otherwise clobber textureSmoothing / scaleU when falling back.
  let applyDefaults = !persistedName;
  if (persistedName) {
    targetIdx = IMAGE_PRESETS.findIndex(p => p.name === persistedName);
    if (!(targetIdx >= 0 && PRESETS[targetIdx])) targetIdx = -1;
  }
  if (targetIdx < 0) targetIdx = IMAGE_PRESETS.findIndex(p => p.name === DEFAULT_PRESET_NAME);
  if (targetIdx >= 0 && PRESETS[targetIdx]) {
    selectPreset(targetIdx, _presetSwatches[targetIdx], applyDefaults);
  }
}).catch(err => console.error('Failed to load thumbnails:', err));

// ── Preset grid ───────────────────────────────────────────────────────────────

function resetTextureSmoothing() {
  settings.textureSmoothing = 0;
  textureSmoothingSlider.value = 0;
  textureSmoothingVal.value    = 0;
}

let _selectGeneration = 0;   // debounce rapid preset clicks

async function selectPreset(idx, swatchEl, applyDefaults = true) {
  const gen = ++_selectGeneration;
  document.querySelectorAll('.preset-swatch').forEach(s => s.classList.remove('active'));
  swatchEl.classList.add('active');

  const entry = PRESETS[idx];
  if (!entry) return;
  activeMapName.textContent = entry.name;
  if (applyDefaults) {
    resetTextureSmoothing();
    if (entry.defaultScale != null) _applyScaleU(entry.defaultScale);
  }

  // If full texture is already loaded, use it directly
  if (entry.texture) {
    activeMapEntry = entry;
    updatePreview();
    return;
  }

  // Load full-resolution texture on demand
  swatchEl.classList.add('preset-loading-full');
  try {
    const full = await loadFullPreset(idx);
    if (gen !== _selectGeneration) return;   // user clicked another preset meanwhile
    PRESETS[idx] = { ...entry, ...full };
    activeMapEntry = PRESETS[idx];
    swatchEl.classList.remove('preset-loading-full');
    updatePreview();
  } catch (err) {
    console.error('Failed to load full texture:', err);
    swatchEl.classList.remove('preset-loading-full');
  }
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
  if (!_lastCustomMap) return;
  activeMapEntry = _lastCustomMap;
  document.querySelectorAll('.preset-swatch').forEach(s => s.classList.remove('active'));
  customMapSwatch.classList.add('active');
  activeMapName.textContent = _lastCustomMap.name;
  updatePreview();
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
      if (idx >= 0 && _presetSwatches[idx] && PRESETS[idx]) {
        selectPreset(idx, _presetSwatches[idx], /*applyDefaults=*/false);
      } else {
        activeMapEntry = null;
        activeMapName.textContent = t('ui.noMapSelected');
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

// ── Event wiring ──────────────────────────────────────────────────────────────

function wireEvents() {
  // ── Model loading ──
  stlFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
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
    const file = files.find(f => /\.(stl|obj|3mf)$/i.test(f.name));
    if (file) handleModelFile(file);
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
      const results = await runExpensiveDiagnostics(currentGeometry, token);

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
      activeMapEntry = await loadCustomTexture(file);
      activeMapEntry.isCustom = true;
      _lastCustomMap = activeMapEntry;
      activeMapName.textContent = file.name;
      document.querySelectorAll('.preset-swatch').forEach(s => s.classList.remove('active'));
      _showCustomMapThumb(activeMapEntry);
      customMapSwatch.classList.add('active');
      resetTextureSmoothing();
      updatePreview();
    } catch (err) {
      console.error('Failed to load texture:', err);
    }
    // Reset the file input so re-uploading the same filename still triggers 'change'.
    textureInput.value = '';
  });

  // ── Settings ──
  mappingSelect.addEventListener('change', () => {
    settings.mappingMode = parseInt(mappingSelect.value, 10);
    capAngleRow.style.display = settings.mappingMode === 3 ? '' : 'none';
    updateCylinderUIVisibility();
    updatePreview();
  });

  cylinderSnapToggle.addEventListener('change', () => {
    settings.snapSeamlessWrap = cylinderSnapToggle.checked;
    if (settings.snapSeamlessWrap && settings.mappingMode === 3) {
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
  scaleUSlider.addEventListener('dblclick', () => applyScaleU(posToScale(parseFloat(scaleUSlider.defaultValue))));
  scaleUVal.addEventListener('change', () => applyScaleU(parseFloat(scaleUVal.value)));
  addFineWheelSupport(scaleUVal, applyScaleU);

  // Scale V — when lock is on, mirror to U
  const applyScaleV = (v) => {
    v = Math.max(0.01, Math.min(10, v));
    settings.scaleV = v;
    scaleVSlider.value = scaleToPos(v);
    scaleVVal.value = v;
    if (settings.lockScale) { settings.scaleU = v; scaleUSlider.value = scaleToPos(v); scaleUVal.value = v; }
    clearTimeout(previewDebounce); previewDebounce = setTimeout(updatePreview, 80);
  };
  scaleVSlider.addEventListener('input', () => applyScaleV(posToScale(parseFloat(scaleVSlider.value))));
  scaleVSlider.addEventListener('dblclick', () => applyScaleV(posToScale(parseFloat(scaleVSlider.defaultValue))));
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
      scaleVVal.value = settings.scaleU;
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
  linkSlider(refineLenSlider, refineLenVal, v => { settings.refineLength  = v; checkResolutionWarning(); return v.toFixed(2); }, false);
  refineLenVal.addEventListener('change', checkResolutionWarning);
  linkSlider(maxTriSlider, maxTriVal, v => { settings.maxTriangles = v; return formatM(v); }, false);
  linkSlider(bottomAngleLimitSlider, bottomAngleLimitVal, v => { settings.bottomAngleLimit = v; _falloffDirty = true; return v; });
  linkSlider(topAngleLimitSlider,    topAngleLimitVal,    v => { settings.topAngleLimit    = v; _falloffDirty = true; return v; });
  linkSlider(seamBlendSlider,        seamBlendVal,        v => { settings.mappingBlend     = v; return v.toFixed(2); });
  linkSlider(seamBandWidthSlider,    seamBandWidthVal,    v => { settings.seamBandWidth    = v; return v.toFixed(2); });
  linkSlider(textureSmoothingSlider, textureSmoothingVal, v => { settings.textureSmoothing = v; return v.toFixed(1); });
  linkSlider(capAngleSlider,          capAngleVal,          v => { settings.capAngle         = v; return Math.round(v); });
  symmetricDispToggle.addEventListener('change', () => {
    settings.symmetricDisplacement = symmetricDispToggle.checked;
    updatePreview();
  });
  noDownwardZChk.addEventListener('change', () => {
    settings.noDownwardZ = noDownwardZChk.checked;
    updatePreview();
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

    // Restore original vertex positions
    currentGeometry.attributes.position.array.set(_rotateOriginalPositions);
    currentGeometry.attributes.position.needsUpdate = true;
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
    if (sessionStorage.getItem('stlt-no-sponsor') === '1') {
      handleExport(format);
      return;
    }
    const overlay = document.getElementById('sponsor-overlay');
    const closeBtn = document.getElementById('sponsor-close');
    const storeLink = overlay.querySelector('.sponsor-link');
    overlay.classList.remove('hidden');
    trapFocus(overlay);

    const dismiss = () => {
      if (document.getElementById('sponsor-dont-show').checked) {
        sessionStorage.setItem('stlt-no-sponsor', '1');
      }
      overlay.classList.add('hidden');
      handleExport(format);
    };

    closeBtn.onclick = dismiss;
    // Also start processing when the user clicks through to the store
    storeLink.onclick = () => setTimeout(dismiss, 150);
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
    refreshExclusionOverlay();
  });

  exclModeExcludeBtn.addEventListener('click', () => setSelectionMode(false));
  exclModeIncludeBtn.addEventListener('click', () => setSelectionMode(true));

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
      const triIdx = pickTriangle(e);
      if (triIdx >= 0) {
        const filled = bucketFill(triIdx, triangleAdjacency, bucketThreshold);
        // Bucket fill always uses original face indices
        for (const t of filled) {
          if (eraseMode) excludedFaces.delete(t); else excludedFaces.add(t);
        }
        // If precision is active, also sync to precisionExcludedFaces
        if (precisionMaskingEnabled && precisionParentMap) {
          const len = precisionParentMap.length;
          for (let i = 0; i < len; i++) {
            if (filled.has(precisionParentMap[i])) {
              if (eraseMode) precisionExcludedFaces.delete(i); else precisionExcludedFaces.add(i);
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
      getControls().enabled = false;
      isPainting = true;
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
      _clearShiftLinePreview();
    }
  });

  document.addEventListener('keyup', (e) => {
    if (e.key === 'Control') _clearShiftLinePreview();
  });

  // ── Color export UI wiring ────────────────────────────────────────────────
  // Mounts the gradient editor and binds the master toggle, source radio,
  // base-color picker, and color-image upload. Safe no-op when DOM elements
  // are missing.
  wireColorExportUI();
}

// ── Color export UI wiring ───────────────────────────────────────────────────
// Wires the master toggle, source radio, gradient editor, base color picker,
// and color image upload. Runs once from wireEvents().
function wireColorExportUI() {
  // 1) Mount the gradient editor on its placeholder div.
  const gradMount = document.getElementById('color-gradient-mount');
  if (gradMount && typeof GradientEditor === 'function') {
    try {
      const editor = new GradientEditor();
      editor.mount(gradMount);
      editor.setStops(settings.colorGradientStops);
      editor.onChange((stops) => {
        // Deep-copy on assign so settings never aliases the editor's internal array.
        settings.colorGradientStops = stops.map(s => ({
          pos: s.pos, color: s.color, lockedToBase: !!s.lockedToBase,
        }));
        _refreshStopPropsPanel();
        _refreshPalettePreview();
        _pushColorPreviewState();
        _scheduleUndoCapture();
        const sp = document.getElementById('settings-panel');
        if (sp) sp.dispatchEvent(new Event('change', { bubbles: true }));
      });
      editor.onSelect(() => _refreshStopPropsPanel());
      window._gradientEditor = editor;
    } catch (err) {
      console.warn('GradientEditor failed to mount:', err);
    }
  }

  // 1b) Stop properties panel — drives the currently-selected stop.
  const stopColorEl  = document.getElementById('stop-color-input');
  const stopHexEl    = document.getElementById('stop-hex-input');
  const stopPosEl    = document.getElementById('stop-pos-input');
  const stopLockEl   = document.getElementById('stop-lock-input');
  const stopRemoveEl = document.getElementById('stop-remove-btn');
  if (stopColorEl) stopColorEl.addEventListener('input', () => {
    if (window._gradientEditor) window._gradientEditor.setSelectedColor(stopColorEl.value);
  });
  if (stopHexEl) stopHexEl.addEventListener('change', () => {
    let v = (stopHexEl.value || '').trim();
    if (!v.startsWith('#')) v = '#' + v;
    if (/^#[0-9a-fA-F]{6}$/.test(v) && window._gradientEditor) {
      window._gradientEditor.setSelectedColor(v.toLowerCase());
    } else {
      _refreshStopPropsPanel(); // revert to current value
    }
  });
  if (stopPosEl) stopPosEl.addEventListener('change', () => {
    const n = parseFloat(stopPosEl.value);
    if (Number.isFinite(n) && window._gradientEditor) {
      window._gradientEditor.setSelectedPos(Math.max(0, Math.min(100, n)) / 100);
    }
  });
  if (stopLockEl) stopLockEl.addEventListener('change', () => {
    if (window._gradientEditor) window._gradientEditor.setSelectedLocked(stopLockEl.checked);
  });
  if (stopRemoveEl) stopRemoveEl.addEventListener('click', () => {
    if (window._gradientEditor) window._gradientEditor.removeSelected();
  });

  // 1c) Snap-preview toggle.
  const snapEl = document.getElementById('color-snap-preview');
  if (snapEl) {
    snapEl.checked = !!settings.colorSnapPreview;
    snapEl.addEventListener('change', () => {
      settings.colorSnapPreview = !!snapEl.checked;
      _pushColorPreviewState();
    });
  }

  // 1d) Reset gradient button.
  const resetEl = document.getElementById('color-gradient-reset');
  if (resetEl) {
    resetEl.addEventListener('click', () => {
      if (window._gradientEditor) window._gradientEditor.resetToDefault();
    });
  }

  // 2) Master enable toggle.
  const enableEl = document.getElementById('color-export-toggle');
  if (enableEl) {
    enableEl.checked = !!settings.colorExportEnabled;
    enableEl.addEventListener('change', () => {
      settings.colorExportEnabled = !!enableEl.checked;
      _pushColorPreviewState();
    });
  }

  // 3) Auto-source radio (None / Gradient / Image).
  document.querySelectorAll('input[name="color-auto-source"]').forEach(el => {
    if (el.value === settings.colorAutoSource) el.checked = true;
    el.addEventListener('change', () => {
      if (el.checked) {
        settings.colorAutoSource = el.value;
        _pushColorPreviewState();
      }
    });
  });

  // 4) Base color picker. Also propagates to the gradient editor so any
  // stop with lockedToBase: true tracks this color in real time.
  const baseEl = document.getElementById('color-base-picker');
  if (baseEl) {
    baseEl.value = settings.colorBaseColor;
    baseEl.addEventListener('change', () => {
      settings.colorBaseColor = baseEl.value;
      if (window._gradientEditor && typeof window._gradientEditor.setBaseColor === 'function') {
        window._gradientEditor.setBaseColor(baseEl.value);
      }
      _pushColorPreviewState();
    });
  }
  // Initial sync so locked stops carry the right color from the get-go.
  if (window._gradientEditor && typeof window._gradientEditor.setBaseColor === 'function') {
    window._gradientEditor.setBaseColor(settings.colorBaseColor);
  }

  // 4b) Palette size selector — controls how many distinct colors land in the
  // 3MF colorgroup, so the slicer maps to a sane number of filament slots.
  const paletteSizeEl = document.getElementById('color-palette-size');
  if (paletteSizeEl) {
    paletteSizeEl.value = String(settings.colorPaletteSize);
    paletteSizeEl.addEventListener('change', () => {
      const n = parseInt(paletteSizeEl.value, 10);
      if (Number.isFinite(n) && n >= 2 && n <= 32) settings.colorPaletteSize = n;
    });
  }

  // 5) Color image upload.
  const colorFileInput = document.getElementById('color-image-input');
  if (colorFileInput) {
    colorFileInput.addEventListener('change', async (ev) => {
      const file = ev.target.files && ev.target.files[0];
      colorFileInput.value = '';
      if (!file) return;
      try {
        const bmp = await createImageBitmap(file);
        const cvs = document.createElement('canvas');
        cvs.width = bmp.width; cvs.height = bmp.height;
        const ctx = cvs.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bmp, 0, 0);
        const imgData = ctx.getImageData(0, 0, bmp.width, bmp.height);
        _lastColorMap = {
          name: file.name,
          imageData: imgData,
          width: bmp.width,
          height: bmp.height,
          fullCanvas: cvs,
        };
        bmp.close && bmp.close();
        if (typeof window._refreshColorImageUI === 'function') window._refreshColorImageUI();
        _pushColorPreviewState();
        _scheduleUndoCapture();
      } catch (err) {
        console.error('Color image load failed:', err);
        alert(t('alerts.colorImageFailed') || ('Could not load color image: ' + err.message));
      }
    });
  }

  // 6) Color image remove button.
  const colorRemoveBtn = document.getElementById('color-image-remove');
  if (colorRemoveBtn) {
    colorRemoveBtn.addEventListener('click', () => {
      _lastColorMap = null;
      if (typeof window._refreshColorImageUI === 'function') window._refreshColorImageUI();
      _pushColorPreviewState();
      _scheduleUndoCapture();
    });
  }

  // 7) Color image thumbnail / label refresh, used by upload, remove, reset,
  // and .bumpmesh import paths.
  window._refreshColorImageUI = refreshColorImageUI;
  refreshColorImageUI();
  // Wire base-color and source changes to the palette preview too.
  if (baseEl) baseEl.addEventListener('change', _refreshPalettePreview);
  document.querySelectorAll('input[name="color-auto-source"]').forEach(el => {
    el.addEventListener('change', _refreshPalettePreview);
  });
  // Initial sync — runs once after the gradient editor mounts and settings
  // are populated. Subsequent changes flow through the listeners above.
  _refreshStopPropsPanel();
  _refreshPalettePreview();
  _pushColorPreviewState();
}

// ── Color preview helpers ────────────────────────────────────────────────────
// Build a 256×1 LUT canvas from gradient stops; the fragment shader samples
// this with the displacement greyvalue to produce the gradient color.
function _rebuildGradientLUT() {
  if (!_gradientLUTCanvas) {
    _gradientLUTCanvas = document.createElement('canvas');
    _gradientLUTCanvas.width = 256; _gradientLUTCanvas.height = 1;
  }
  const ctx = _gradientLUTCanvas.getContext('2d');
  const stops = (Array.isArray(settings.colorGradientStops) && settings.colorGradientStops.length >= 2)
    ? settings.colorGradientStops.slice().sort((a, b) => a.pos - b.pos)
    : [{ pos: 0, color: '#222222' }, { pos: 1, color: '#dddddd' }];

  if (settings.colorSnapPreview) {
    // Stepped LUT: each pixel takes the color of the nearest stop by pos.
    // This produces the same visual the export will see, so the live preview
    // matches the printed result exactly (no smooth interpolation between
    // stops that won't appear in the colorgroup).
    const img = ctx.createImageData(256, 1);
    for (let x = 0; x < 256; x++) {
      const t = x / 255;
      let best = stops[0];
      let bestD = Math.abs(stops[0].pos - t);
      for (let i = 1; i < stops.length; i++) {
        const d = Math.abs(stops[i].pos - t);
        if (d < bestD) { bestD = d; best = stops[i]; }
      }
      const rgb = _hexToRGB01(best.color);
      img.data[x * 4]     = Math.round(rgb[0] * 255);
      img.data[x * 4 + 1] = Math.round(rgb[1] * 255);
      img.data[x * 4 + 2] = Math.round(rgb[2] * 255);
      img.data[x * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  } else {
    // Smooth interpolation via Canvas2D's built-in gradient.
    const grad = ctx.createLinearGradient(0, 0, 256, 0);
    for (const s of stops) {
      const p = Math.max(0, Math.min(1, +s.pos));
      grad.addColorStop(p, s.color);
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 1);
  }

  if (!_gradientLUTTexture) {
    _gradientLUTTexture = new THREE.CanvasTexture(_gradientLUTCanvas);
    _gradientLUTTexture.wrapS = _gradientLUTTexture.wrapT = THREE.ClampToEdgeWrapping;
  } else {
    _gradientLUTTexture.needsUpdate = true;
  }
  // Use NearestFilter when snapped so adjacent stop boundaries stay crisp;
  // LinearFilter for smooth so the interpolation isn't visibly stepped.
  const filter = settings.colorSnapPreview ? THREE.NearestFilter : THREE.LinearFilter;
  _gradientLUTTexture.minFilter = filter;
  _gradientLUTTexture.magFilter = filter;
  return _gradientLUTTexture;
}

function _rebuildColorImageTexture() {
  if (!_lastColorMap || !_lastColorMap.fullCanvas) {
    if (_colorImageTexture) { _colorImageTexture.dispose && _colorImageTexture.dispose(); }
    _colorImageTexture = null;
    return null;
  }
  if (!_colorImageTexture || _colorImageTexture.image !== _lastColorMap.fullCanvas) {
    if (_colorImageTexture) _colorImageTexture.dispose && _colorImageTexture.dispose();
    _colorImageTexture = new THREE.CanvasTexture(_lastColorMap.fullCanvas);
    _colorImageTexture.wrapS = _colorImageTexture.wrapT = THREE.RepeatWrapping;
    _colorImageTexture.minFilter = THREE.LinearFilter;
    _colorImageTexture.magFilter = THREE.LinearFilter;
  } else {
    _colorImageTexture.needsUpdate = true;
  }
  return _colorImageTexture;
}

function _hexToRGB01(hex) {
  if (typeof hex !== 'string') return [1, 1, 1];
  const h = hex.trim().replace(/^#/, '');
  if (h.length !== 6) return [1, 1, 1];
  const n = parseInt(h, 16);
  if (!Number.isFinite(n)) return [1, 1, 1];
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

function _hexToRGB255(hex) {
  const c01 = _hexToRGB01(hex);
  return [Math.round(c01[0] * 255), Math.round(c01[1] * 255), Math.round(c01[2] * 255)];
}

/**
 * Snap each triangle in `triRGB` to the nearest gradient stop OR the base
 * color (Euclidean RGB distance). Returns { palette, triPaletteIndices }
 * matching the shape that export3MF expects.
 *
 * The output palette is exactly the user's control points (deduplicated):
 * gradient stop colors first, base color last. No statistical averaging,
 * so the exported colors are pixel-exact what the user picked. Slicer-side
 * AMS slot assignment is predictable.
 */
/**
 * Reduce color-region fragmentation by reassigning isolated triangles to
 * their majority-neighbor color. The output of medianCut / snapToStops can
 * produce a "speckle" pattern at color boundaries — triangles whose averaged
 * color happened to land closer to a non-dominant palette entry. Slicers like
 * Bambu Studio / OrcaSlicer treat each color as a distinct filament region;
 * tens of thousands of single-triangle speckles produce a chaotic slice plan
 * with non-manifold-style errors at every region boundary.
 *
 * Algorithm: for each triangle, look at its ≤3 face-adjacent neighbors. If
 * 2+ neighbors share a color that isn't the triangle's own, switch. Iterate
 * until stable (capped). Geometry untouched; only triPaletteIndices change.
 *
 * @param {Uint16Array} indices  triangle → palette index (mutated in place)
 * @param {Array<Array<{neighbor:number,angle:number}>>} adjacency
 * @param {number} maxIters
 * @returns {number} total reassignments across all iterations
 */
function _smoothPaletteRegions(indices, adjacency, maxIters = 3) {
  const triCount = indices.length;
  let totalChanges = 0;
  // Double-buffer so each pass sees a consistent snapshot.
  const next = new Uint16Array(triCount);

  // Pass A — conservative: flip iff ≥2 of my (≤3) neighbors share a non-self
  // color. Preserves genuine sharp boundary triangles.
  for (let iter = 0; iter < maxIters; iter++) {
    next.set(indices);
    let changes = 0;
    for (let t = 0; t < triCount; t++) {
      const nbrs = adjacency[t];
      if (!nbrs || nbrs.length < 2) continue;
      const me = indices[t];
      let p0 = -1, c0 = 0, p1 = -1, c1 = 0, p2 = -1, c2 = 0;
      for (let k = 0; k < nbrs.length; k++) {
        const p = indices[nbrs[k].neighbor];
        if      (p === p0) c0++;
        else if (p === p1) c1++;
        else if (p === p2) c2++;
        else if (p0 < 0)   { p0 = p; c0 = 1; }
        else if (p1 < 0)   { p1 = p; c1 = 1; }
        else               { p2 = p; c2 = 1; }
      }
      let bestPid = -1, bestCount = 0;
      if (c0 > bestCount) { bestPid = p0; bestCount = c0; }
      if (c1 > bestCount) { bestPid = p1; bestCount = c1; }
      if (c2 > bestCount) { bestPid = p2; bestCount = c2; }
      if (bestPid >= 0 && bestPid !== me && bestCount >= 2) {
        next[t] = bestPid;
        changes++;
      }
    }
    if (changes === 0) break;
    indices.set(next);
    totalChanges += changes;
  }

  // Pass B — aggressive cleanup of fully-surrounded triangles only. After
  // the conservative passes have run to fixpoint, any triangle whose ALL ≥3
  // neighbors disagree with self is a true outlier (typically a "trijunction"
  // where 3+ regions meet). Flip to whichever neighbor color appears most
  // (lowest pid breaks ties), since "any neighbor color" is strictly better
  // than "an island of one". A single pass is enough — by definition this
  // doesn't propagate.
  next.set(indices);
  let aggChanges = 0;
  for (let t = 0; t < triCount; t++) {
    const nbrs = adjacency[t];
    if (!nbrs || nbrs.length < 2) continue;
    const me = indices[t];
    let agree = 0;
    let p0 = -1, c0 = 0, p1 = -1, c1 = 0, p2 = -1, c2 = 0;
    for (let k = 0; k < nbrs.length; k++) {
      const p = indices[nbrs[k].neighbor];
      if (p === me) { agree++; }
      if      (p === p0) c0++;
      else if (p === p1) c1++;
      else if (p === p2) c2++;
      else if (p0 < 0)   { p0 = p; c0 = 1; }
      else if (p1 < 0)   { p1 = p; c1 = 1; }
      else               { p2 = p; c2 = 1; }
    }
    if (agree > 0) continue; // not a fully-surrounded speckle
    // All neighbors disagree. Pick the most common neighbor color (any
    // neighbor color is better than self, which has 0 local support).
    let bestPid = p0, bestCount = c0;
    if (c1 > bestCount || (c1 === bestCount && p1 < bestPid)) { bestPid = p1; bestCount = c1; }
    if (c2 > bestCount || (c2 === bestCount && p2 < bestPid)) { bestPid = p2; bestCount = c2; }
    if (bestPid >= 0 && bestPid !== me) {
      next[t] = bestPid;
      aggChanges++;
    }
  }
  if (aggChanges > 0) {
    indices.set(next);
    totalChanges += aggChanges;
  }
  return totalChanges;
}

function _snapToControlPoints(triRGB, s) {
  const stops = Array.isArray(s.colorGradientStops) ? s.colorGradientStops : [];
  const palRGB = []; // array of [r, g, b] in 0..255
  const palSet = new Set();
  const pushIfNew = (rgb) => {
    const key = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
    if (palSet.has(key)) return;
    palSet.add(key); palRGB.push(rgb);
  };
  for (const stop of stops) pushIfNew(_hexToRGB255(stop.color));
  pushIfNew(_hexToRGB255(s.colorBaseColor || '#ffffff'));
  if (palRGB.length === 0) palRGB.push([255, 255, 255]); // defensive

  const triCount = (triRGB.length / 3) | 0;
  const indices = new Uint16Array(triCount);
  for (let i = 0; i < triCount; i++) {
    const r = triRGB[i * 3], g = triRGB[i * 3 + 1], b = triRGB[i * 3 + 2];
    let best = 0, bestD = Infinity;
    for (let j = 0; j < palRGB.length; j++) {
      const p = palRGB[j];
      const dr = r - p[0], dg = g - p[1], db = b - p[2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) { bestD = d; best = j; }
    }
    indices[i] = best;
  }
  const palette = new Uint8Array(palRGB.length * 3);
  for (let i = 0; i < palRGB.length; i++) {
    palette[i * 3]     = palRGB[i][0];
    palette[i * 3 + 1] = palRGB[i][1];
    palette[i * 3 + 2] = palRGB[i][2];
  }
  return { palette, triPaletteIndices: indices };
}

// Refresh the stop-properties panel inputs to match the currently-selected
// gradient stop. Called by the gradient editor's onSelect / onChange callbacks
// so the panel always reflects the live state without manual sync code.
function _refreshStopPropsPanel() {
  const ge = window._gradientEditor;
  if (!ge) return;
  const stop = ge.getSelectedStop();
  const colorEl  = document.getElementById('stop-color-input');
  const hexEl    = document.getElementById('stop-hex-input');
  const posEl    = document.getElementById('stop-pos-input');
  const lockEl   = document.getElementById('stop-lock-input');
  const removeEl = document.getElementById('stop-remove-btn');
  const panel    = document.getElementById('color-stop-props');
  if (!stop) {
    if (panel) panel.classList.add('disabled');
    return;
  }
  if (panel) panel.classList.remove('disabled');
  if (colorEl) colorEl.value = stop.color;
  if (hexEl)   hexEl.value   = stop.color;
  if (posEl)   posEl.value   = String(Math.round(stop.pos * 100));
  if (lockEl)  lockEl.checked = !!stop.lockedToBase;
  // Color picker is greyed out when locked — clearer than letting the user
  // edit and silently auto-unlock.
  if (colorEl) colorEl.disabled = !!stop.lockedToBase;
  if (hexEl)   hexEl.disabled   = !!stop.lockedToBase;
  // Disable Remove if we'd drop below the 2-stop minimum.
  if (removeEl) removeEl.disabled = (ge.getStops().length <= 2);
}

// Render the live palette preview row — exact swatches of what will appear
// in the exported 3MF. Gradient mode shows {stop colors} ∪ {base},
// deduplicated. Image and none modes hide (their palette isn't pre-known).
function _refreshPalettePreview() {
  const wrap = document.querySelector('.palette-preview-wrap');
  const row  = document.getElementById('color-palette-preview');
  if (!wrap || !row) return;
  if (settings.colorAutoSource !== 'gradient') {
    wrap.classList.add('hidden');
    return;
  }
  wrap.classList.remove('hidden');
  const stops = (Array.isArray(settings.colorGradientStops) ? settings.colorGradientStops : []);
  const colors = [];
  const seen = new Set();
  const add = (hex) => {
    const h = (typeof hex === 'string' ? hex : '#000000').toLowerCase();
    if (seen.has(h)) return;
    seen.add(h); colors.push(h);
  };
  for (const s of stops) add(s.color);
  add(settings.colorBaseColor || '#ffffff');
  row.innerHTML = '';
  for (const c of colors) {
    const sw = document.createElement('div');
    sw.className = 'palette-swatch';
    sw.style.background = c;
    sw.title = c;
    row.appendChild(sw);
  }
  const count = document.createElement('span');
  count.className = 'palette-count';
  count.textContent = colors.length === 1 ? '1 color' : `${colors.length} colors`;
  row.appendChild(count);
}

// Push the current color settings into the live preview material.
// Call this after any settings change that should affect the on-screen tint.
function _pushColorPreviewState() {
  if (!previewMaterial) return;
  setColorPreview(previewMaterial, {
    enabled:      !!settings.colorExportEnabled,
    autoSource:   settings.colorAutoSource || 'none',
    baseRGB:      _hexToRGB01(settings.colorBaseColor || '#ffffff'),
    gradientLUT:  _rebuildGradientLUT(),
    colorImage:   _rebuildColorImageTexture(),
    // Color image's own aspect — colorBake.js applies the same correction
    // separately from the displacement texture's aspect, so we must too or
    // the live preview will be scale-mismatched against the export.
    colorImageW:  _lastColorMap ? _lastColorMap.width  : 0,
    colorImageH:  _lastColorMap ? _lastColorMap.height : 0,
  });
  requestRender();
}

function refreshColorImageUI() {
  const thumb = document.getElementById('color-image-thumb');
  const removeBtn = document.getElementById('color-image-remove');
  const uploadLabel = document.querySelector('label[for="color-image-input"] span');

  if (thumb && thumb.getContext) {
    const ctx = thumb.getContext('2d');
    const w = thumb.width || 64;
    const h = thumb.height || 64;
    ctx.clearRect(0, 0, w, h);

    if (_lastColorMap && _lastColorMap.fullCanvas) {
      const sw = _lastColorMap.fullCanvas.width;
      const sh = _lastColorMap.fullCanvas.height;
      const scale = Math.min(w / sw, h / sh);
      const dw = sw * scale;
      const dh = sh * scale;
      ctx.drawImage(_lastColorMap.fullCanvas, (w - dw) / 2, (h - dh) / 2, dw, dh);
    }
  }

  if (removeBtn) removeBtn.disabled = !(_lastColorMap && _lastColorMap.fullCanvas);
  if (uploadLabel) {
    const key = _lastColorMap && _lastColorMap.fullCanvas
      ? 'color.imageReplace'
      : 'color.imageUpload';
    uploadLabel.setAttribute('data-i18n', key);
    uploadLabel.textContent = t(key);
  }
}

// ── Exclusion helpers ─────────────────────────────────────────────────────────

function setSelectionMode(include) {
  if (selectionMode === include) return;
  selectionMode = include;
  exclModeExcludeBtn.classList.toggle('active', !selectionMode);
  exclModeIncludeBtn.classList.toggle('active', selectionMode);
  exclModeExcludeBtn.setAttribute('aria-pressed', String(!selectionMode));
  exclModeIncludeBtn.setAttribute('aria-pressed', String(selectionMode));
  if (exclusionTool) setExclusionTool(null);
  exclSectionHeading.textContent = selectionMode ? t('sections.surfaceSelection') : t('sections.surfaceMasking');
  exclHint.textContent = selectionMode
    ? t('excl.hintInclude')
    : t('excl.hintExclude');
  // Clear the painted set — faces had opposite semantics in the previous mode
  excludedFaces = new Set();
  precisionExcludedFaces = new Set();
  refreshExclusionOverlay();
}

function setExclusionTool(tool) {
  // Clicking the active tool toggles it off; passing null always deactivates
  exclusionTool = (exclusionTool === tool) ? null : tool;

  // Deactivate place-on-face and rotate if an exclusion tool is being activated
  if (exclusionTool && placeOnFaceActive) togglePlaceOnFace(false);
  if (exclusionTool && rotateActive) toggleRotateMode(false);

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

function _paintSingleHit(hit, mesh) {
  const usePrecision = precisionMaskingEnabled && precisionGeometry && precisionParentMap;
  if (usePrecision) {
    if (brushIsRadius) {
      const r2 = brushRadius * brushRadius;
      bfsBrushSelect(hit.faceIndex, hit.point, r2, _viewDirFor(hit.point), t => {
        if (eraseMode) precisionExcludedFaces.delete(t); else precisionExcludedFaces.add(t);
      });
    } else {
      const precIdx = hit.faceIndex;
      if (eraseMode) precisionExcludedFaces.delete(precIdx); else precisionExcludedFaces.add(precIdx);
    }
  } else {
    let triIdx = hit.faceIndex;
    if (dispPreviewGeometry && mesh.geometry === dispPreviewGeometry && dispPreviewParentMap) {
      triIdx = dispPreviewParentMap[triIdx];
    }
    if (brushIsRadius) {
      const r2 = brushRadius * brushRadius;
      bfsBrushSelect(triIdx, hit.point, r2, _viewDirFor(hit.point), t => {
        if (eraseMode) excludedFaces.delete(t); else excludedFaces.add(t);
      });
    } else {
      if (eraseMode) excludedFaces.delete(triIdx); else excludedFaces.add(triIdx);
    }
  }
}

function _paintLineBetween(from, to, mesh) {
  // Sample points along the line and paint at each
  const dist = from.distanceTo(to);
  const step = brushIsRadius ? Math.max(brushRadius * 0.5, 0.1) : 0.5;
  const steps = Math.max(Math.ceil(dist / step), 1);
  const dir = new THREE.Vector3().subVectors(to, from);
  const cam = getCamera();
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const pt = new THREE.Vector3().lerpVectors(from, to, t);
    // Project 3D point to screen, then raycast back to find mesh hit
    const ndc = pt.clone().project(cam);
    _raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), cam);
    const hits = _raycaster.intersectObject(mesh);
    const hit = getFrontFaceHit(hits, mesh);
    if (hit) _paintSingleHit(hit, mesh);
  }
}

function paintAt(e) {
  const mesh = getCurrentMesh();
  if (!mesh) return;
  _raycaster.setFromCamera(_canvasNDC(e), getCamera());
  const hits = _raycaster.intersectObject(mesh);
  const hit = getFrontFaceHit(hits, mesh);
  if (!hit) return;

  // Shift+click: draw line from last paint point to current
  if (e.ctrlKey && _lastPaintHitPoint) {
    _paintLineBetween(_lastPaintHitPoint, hit.point, mesh);
    _clearShiftLinePreview();
  } else {
    _paintSingleHit(hit, mesh);
  }

  _lastPaintHitPoint = hit.point.clone();
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

  // Re-center geometry
  currentGeometry.computeBoundingBox();
  const center = new THREE.Vector3();
  currentGeometry.boundingBox.getCenter(center);
  currentGeometry.translate(-center.x, -center.y, -center.z);

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

  // Reset displacement preview
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

  // Deactivate tools but keep excludedFaces (face indices are stable after rotation)
  exclusionTool     = null;
  eraseMode         = false;
  isPainting        = false;
  exclBrushBtn.classList.remove('active');
  exclBucketBtn.classList.remove('active');
  exclBrushTypeRow.classList.add('hidden');
  exclRadiusRow.classList.add('hidden');
  exclThresholdRow.classList.add('hidden');
  canvas.style.cursor = '';
  setHoverPreview(null);
  _lastHoverTriIdx = -1;

  // Rebuild adjacency
  const adjData = buildAdjacency(currentGeometry);
  triangleAdjacency = adjData.adjacency;
  triangleCentroids = adjData.centroids;
  triangleFaceNormals = adjData.faceNormals;

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
  meshInfo.textContent = t('ui.meshInfo', { n: triCount.toLocaleString(), mb, sx, sy, sz });

  exportBtn.disabled = (activeMapEntry === null);
  export3mfBtn.disabled = (activeMapEntry === null);
  bakeBtn.disabled = (activeMapEntry === null);
  updatePreview();

  // Rebuild exclusion overlay with new vertex positions (face indices unchanged)
  if (excludedFaces.size > 0) {
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

    // Snapshot original positions for reset
    if (currentGeometry) {
      _rotateOriginalPositions = new Float32Array(currentGeometry.attributes.position.array);
    }
    rotateAngles = { x: 0, y: 0, z: 0 };
    rotateXInput.value = '0'; rotateYInput.value = '0'; rotateZInput.value = '0';

    // Show gizmo
    setRotationGizmo(true, handleGizmoDrag);
  } else {
    setRotationGizmo(false);
    _rotateOriginalPositions = null;

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

  // Re-center
  currentGeometry.computeBoundingBox();
  const center = new THREE.Vector3();
  currentGeometry.boundingBox.getCenter(center);
  currentGeometry.translate(-center.x, -center.y, -center.z);
  currentGeometry.attributes.position.needsUpdate = true;

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

  // Rebuild exclusion overlay
  if (excludedFaces.size > 0) {
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
  exclCount.textContent = selectionMode
    ? t(n === 1 ? 'excl.faceSelected' : 'excl.facesSelected', { n: n.toLocaleString() })
    : t(n === 1 ? 'excl.faceExcluded' : 'excl.facesExcluded', { n: n.toLocaleString() });

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
  const mesh = getCurrentMesh();
  if (!mesh) { brushCursorEl.style.display = 'none'; return; }
  _raycaster.setFromCamera(_canvasNDC(e), getCamera());
  const hits = _raycaster.intersectObject(mesh);
  const frontHit = getFrontFaceHit(hits, mesh);
  if (!frontHit) { brushCursorEl.style.display = 'none'; return; }

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
  const geo = new THREE.BoxGeometry(50, 50, 50).toNonIndexed();
  geo.computeBoundingBox();
  geo.computeVertexNormals();

  // Invalidate any in-flight async operations tied to the previous model
  precisionToken++;
  dispPreviewToken++;
  exportToken++;

  currentGeometry = geo;
  currentBounds   = computeBounds(geo);
  currentStlName  = 'cube_50x50x50';
  checkAmplitudeWarning();

  loadGeometry(geo);
  dropHint.classList.add('hidden');

  // Reset displacement preview
  if (dispPreviewGeometry) { dispPreviewGeometry.dispose(); dispPreviewGeometry = null; }
  settings.useDisplacement = false;
  dispPreviewToggle.checked = false;

  // Reset exclusion state
  excludedFaces     = new Set();
  exclusionTool     = null;
  eraseMode         = false;
  isPainting        = false;
  if (placeOnFaceActive) togglePlaceOnFace(false);
  if (rotateActive) toggleRotateMode(false);
  rotateAngles = { x: 0, y: 0, z: 0 };
  rotateXInput.value = '0'; rotateYInput.value = '0'; rotateZInput.value = '0';
  exclBrushBtn.classList.remove('active');
  exclBucketBtn.classList.remove('active');
  exclBrushTypeRow.classList.add('hidden');
  exclRadiusRow.classList.add('hidden');
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

  settings.scaleU  = 0.5; scaleUSlider.value = scaleToPos(0.5); scaleUVal.value = 0.5;
  settings.scaleV  = 0.5; scaleVSlider.value = scaleToPos(0.5); scaleVVal.value = 0.5;
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
  meshInfo.textContent = t('ui.meshInfo', { n: triCount.toLocaleString(), mb, sx, sy, sz });

  exportBtn.disabled = (activeMapEntry === null);
  export3mfBtn.disabled = (activeMapEntry === null);
  bakeBtn.disabled = (activeMapEntry === null);
  updatePreview();
}

async function handleModelFile(file) {
  _undoApplyDepth++;
  try {
    const { geometry, bounds, nanCount, degenerateCount } = await loadModelFile(file);

    // Invalidate any in-flight async operations tied to the previous model
    precisionToken++;
    dispPreviewToken++;
    exportToken++;
    diagToken++;

    currentGeometry = geometry;
    currentBounds   = bounds;
    currentStlName  = file.name.replace(/\.(stl|obj|3mf)$/i, '');
    checkAmplitudeWarning();

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

    // Auto-select first preset on first load
    if (!activeMapEntry && PRESETS.length > 0) {
      const idx = PRESETS.findIndex(p => p != null);
      if (idx >= 0) {
        const swatches = document.querySelectorAll('.preset-swatch');
        if (swatches[idx]) selectPreset(idx, swatches[idx]);
      }
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

    // Show mesh with a default material until a map is selected
    loadGeometry(geometry);
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
    exclusionTool     = null;
    eraseMode         = false;
    isPainting        = false;
    if (placeOnFaceActive) togglePlaceOnFace(false);
    if (rotateActive) toggleRotateMode(false);
    rotateAngles = { x: 0, y: 0, z: 0 };
    rotateXInput.value = '0'; rotateYInput.value = '0'; rotateZInput.value = '0';
    exclBrushBtn.classList.remove('active');
    exclBucketBtn.classList.remove('active');
    exclBrushTypeRow.classList.add('hidden');
    exclRadiusRow.classList.add('hidden');
    exclThresholdRow.classList.add('hidden');
    canvas.style.cursor = '';
    setExclusionOverlay(null);
    setHoverPreview(null);
    _lastHoverTriIdx = -1;
    exclCount.textContent = t('excl.initExcluded');
    // Build adjacency data for brush/bucket tools (synchronous; fast enough for
    // typical STL sizes processed by this tool)
    const adjData = buildAdjacency(geometry);
    triangleAdjacency = adjData.adjacency;
    triangleCentroids = adjData.centroids;
    triangleFaceNormals = adjData.faceNormals;
    updateMeshDiagnostics(adjData, geometry.attributes.position.count / 3);

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

    const triCount = getTriangleCount(geometry);
    const mb = ((geometry.attributes.position.array.byteLength) / 1024 / 1024).toFixed(2);
    const sx = bounds.size.x.toFixed(2);
    const sy = bounds.size.y.toFixed(2);
    const sz = bounds.size.z.toFixed(2);
    meshInfo.textContent = t('ui.meshInfo', { n: triCount.toLocaleString(), mb, sx, sy, sz });

    exportBtn.disabled = (activeMapEntry === null);
    export3mfBtn.disabled = (activeMapEntry === null);
    updatePreview();
  } catch (err) {
    console.error('Failed to load model:', err);
    alert(t('alerts.loadFailed', { msg: err.message }));
  } finally {
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
  if (lastFastDiag) {
    if (lastFastDiag.openEdges > 0 || lastFastDiag.nonManifoldEdges > 0) severity = 'error';
    else if (lastFastDiag.shellCount > 1 && severity !== 'error') severity = 'warn';
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
    const shellIds = getShellAssignments(triangleAdjacency, currentGeometry.attributes.position.count / 3);
    const shellCount = lastFastDiag ? lastFastDiag.shellCount : 0;
    const srcPos = currentGeometry.attributes.position.array;
    const srcNrm = currentGeometry.attributes.normal ? currentGeometry.attributes.normal.array : null;
    const triCount = srcPos.length / 9;

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

  if (diag.openEdges === 0 && diag.nonManifoldEdges === 0 && diag.shellCount <= 1) {
    meshDiagFast.textContent = t('diag.meshOk');
  } else {
    if (diag.openEdges > 0)
      meshDiagFast.appendChild(makeDiagLine(t('diag.openEdges', { n: diag.openEdges }), 'openEdges'));
    if (diag.nonManifoldEdges > 0)
      meshDiagFast.appendChild(makeDiagLine(t('diag.nonManifoldEdges', { n: diag.nonManifoldEdges }), 'nonManifold'));
    if (diag.shellCount > 1)
      meshDiagFast.appendChild(makeDiagLine(t('diag.multipleShells', { n: diag.shellCount }), 'shells'));
    const tip = document.createElement('div');
    tip.style.cssText = 'margin-top:4px;opacity:0.8;font-size:10px';
    tip.innerHTML = t('diag.recommendFix');
    meshDiagFast.appendChild(tip);
  }
  applyDiagSeverity();
}

function renderAdvancedDiag(results) {
  meshDiagAdvanced.innerHTML = '';

  if (results.intersectingPairs === 0 && results.overlappingPairs === 0) {
    meshDiagAdvanced.textContent = t('diag.advancedOk');
  } else {
    if (results.intersectingPairs > 0)
      meshDiagAdvanced.appendChild(makeDiagLine(t('diag.intersectingTris', { n: results.intersectingPairs }), 'intersects'));
    if (results.overlappingPairs > 0)
      meshDiagAdvanced.appendChild(makeDiagLine(t('diag.overlappingTris', { n: results.overlappingPairs }), 'overlaps'));
    const tip = document.createElement('div');
    tip.style.cssText = 'margin-top:4px;opacity:0.8;font-size:10px';
    tip.innerHTML = t('diag.recommendFix');
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
 * Set (or update) the `faceMask` vertex attribute on a geometry.
 * 1.0 = textured, 0.0 = user-excluded.  Angle masking stays in the shader.
 *
 * Always creates a fresh Float32BufferAttribute so that Three.js allocates a
 * new WebGL buffer and uploads the current data.  This avoids subtle buffer-
 * caching issues where in-place array edits + needsUpdate could keep stale
 * GPU data on some drivers.
 */
function updateFaceMask(geometry) {
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

  // Fast path: no user exclusion active
  if (faceSet.size === 0 && !selectionMode) {
    maskArr.fill(1.0);
  } else {
    const isDisp = (geometry === dispPreviewGeometry && dispPreviewParentMap);
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
  if (!exclusionTool && (_falloffDirty || geometry !== _falloffGeometry)) {
    computeBoundaryFalloffAttr(geometry, maskArr);
    computeBoundaryEdges(geometry, maskArr);
    _falloffDirty = false;
    _falloffGeometry = geometry;
  }
  syncBoundaryEdgeUniforms();
  requestRender();
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

  // Build per-unique-position map and identify boundary positions.
  const QUANT = 1e4;
  const posKey = (x, y, z) =>
    `${Math.round(x * QUANT)}_${Math.round(y * QUANT)}_${Math.round(z * QUANT)}`;

  const posFromKey = new Map();  // posKey → [x, y, z]
  // Per-position: [maskedArea, totalArea] to find boundary vertices
  const maskFracMap = new Map();
  const userMaskAreaMap = new Map(); // posKey → area of user-masked faces
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
      const k = posKey(tmpV.x, tmpV.y, tmpV.z);
      if (!posFromKey.has(k)) posFromKey.set(k, [tmpV.x, tmpV.y, tmpV.z]);
      const mf = maskFracMap.get(k);
      if (mf) {
        if (masked) mf[0] += area;
        mf[1] += area;
      } else {
        maskFracMap.set(k, [masked ? area : 0, area]);
      }
      // Track user-mask area per position to classify boundary type
      if (isUserMasked[t]) {
        const prev = userMaskAreaMap.get(k) || 0;
        userMaskAreaMap.set(k, prev + area);
      }
    }
  }

  // Boundary positions: shared between masked and non-masked faces.
  // Each entry: [x, y, z, maskType] where maskType 0 = user, 1 = angle.
  const boundaryPositions = [];
  for (const [k, pos] of posFromKey) {
    const mf = maskFracMap.get(k);
    const frac = mf[1] > 0 ? mf[0] / mf[1] : 0;
    if (frac > 0 && frac < 1) {
      const userArea = userMaskAreaMap.get(k) || 0;
      boundaryPositions.push([pos[0], pos[1], pos[2], userArea > 0 ? 0 : 1]);
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

  // Compute per-unique-position falloff factor and mask type
  const falloffCache = new Map(); // posKey → factor [0,1]
  const maskTypeCache = new Map(); // posKey → 0 (user mask) or 1 (angle mask)
  for (const [k, pos] of posFromKey) {
    const mf = maskFracMap.get(k);
    const frac = mf[1] > 0 ? mf[0] / mf[1] : 0;
    if (frac >= 1) continue; // fully masked vertex — keep 1.0 (mask zeroes it anyway)
    // Boundary vertices (shared between masked and unmasked faces) are AT
    // the boundary → distance 0 → falloff factor 0.
    if (frac > 0) {
      falloffCache.set(k, 0);
      const userArea = userMaskAreaMap.get(k) || 0;
      maskTypeCache.set(k, userArea > 0 ? 0 : 1);
      continue;
    }

    const px = pos[0], py = pos[1], pz = pos[2];
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
      falloffCache.set(k, factor);
      maskTypeCache.set(k, nearestType);
    }
  }

  // Write per-vertex attributes
  for (let i = 0; i < posCount; i++) {
    tmpV.fromBufferAttribute(posAttr, i);
    const k = posKey(tmpV.x, tmpV.y, tmpV.z);
    if (falloffCache.has(k)) falloffArr[i] = falloffCache.get(k);
    if (maskTypeCache.has(k)) maskTypeArr[i] = maskTypeCache.get(k);
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
  const pk = (x, y, z) =>
    `${Math.round(x * QUANT)}_${Math.round(y * QUANT)}_${Math.round(z * QUANT)}`;
  const ek = (k1, k2) => k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1;
  const tmpV = new THREE.Vector3();

  const edgeFaces = new Map();
  const edgePos   = new Map();

  for (let t = 0; t < triCount; t++) {
    const keys = [], pts = [];
    for (let v = 0; v < 3; v++) {
      tmpV.fromBufferAttribute(posAttr, t * 3 + v);
      keys.push(pk(tmpV.x, tmpV.y, tmpV.z));
      pts.push([tmpV.x, tmpV.y, tmpV.z]);
    }
    for (let e = 0; e < 3; e++) {
      const edgeKey = ek(keys[e], keys[(e + 1) % 3]);
      const list = edgeFaces.get(edgeKey);
      if (list) list.push(t);
      else {
        edgeFaces.set(edgeKey, [t]);
        edgePos.set(edgeKey, [pts[e], pts[(e + 1) % 3]]);
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
  if (!activeMapEntry || settings.textureSmoothing === 0) {
    _effectiveMapCache    = null;
    _effectiveMapCacheKey = null;
    return activeMapEntry;
  }
  const { fullCanvas, width, height, name } = activeMapEntry;
  const cacheKey = `${name}_${width}_${height}_${settings.textureSmoothing}`;
  if (_effectiveMapCacheKey === cacheKey && _effectiveMapCache) {
    return _effectiveMapCache;
  }
  // Tile the source 3×3 before blurring so edge pixels have correct
  // neighbours and the blurred centre tile is seamlessly tileable.
  const tiled = document.createElement('canvas');
  tiled.width  = width  * 3;
  tiled.height = height * 3;
  const tc = tiled.getContext('2d');
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      tc.drawImage(fullCanvas, col * width, row * height);
    }
  }
  // Blur the 3×3 canvas, then crop out only the centre tile.
  const blurred = document.createElement('canvas');
  blurred.width  = width  * 3;
  blurred.height = height * 3;
  blurred.getContext('2d').drawImage(tiled, 0, 0);
  blurCanvas(blurred, settings.textureSmoothing);
  const offscreen = document.createElement('canvas');
  offscreen.width  = width;
  offscreen.height = height;
  offscreen.getContext('2d').drawImage(blurred, width, height, width, height, 0, 0, width, height);
  const imageData = offscreen.getContext('2d').getImageData(0, 0, width, height);
  const texture   = new THREE.CanvasTexture(offscreen);
  texture.wrapS   = texture.wrapT = THREE.RepeatWrapping;
  if (_lastEffectiveTexture) _lastEffectiveTexture.dispose();
  _lastEffectiveTexture = texture;
  _effectiveMapCache    = { ...activeMapEntry, imageData, texture };
  _effectiveMapCacheKey = cacheKey;
  return _effectiveMapCache;
}

function updatePreview() {
  if (!currentGeometry || !currentBounds) return;

  // Texture aspect correction so non-square textures keep their proportions.
  // A 512×279 texture needs aspectV = 512/279 ≈ 1.84 so V tiles faster (more
  // repetitions), making each tile shorter in world-space to match the texture's
  // wider-than-tall content.  The wider axis gets aspect = 1 (unchanged).
  const tw = activeMapEntry?.width ?? 1, th = activeMapEntry?.height ?? 1;
  const tmax = Math.max(tw, th, 1);
  const fullSettings = {
    ...settings,
    bounds: currentBounds,
    textureAspectU: tmax / Math.max(tw, 1),
    textureAspectV: tmax / Math.max(th, 1),
  };

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
    _pushColorPreviewState();
  } else {
    updateMaterial(previewMaterial, effectiveEntry.texture, fullSettings);
  }

  syncBoundaryEdgeUniforms();
  exportBtn.disabled = false;
  export3mfBtn.disabled = false;
  bakeBtn.disabled = isBaking;
}

// ── Displacement preview ──────────────────────────────────────────────────────

/**
 * Compute and set flat geometric face normals as a `faceNormal` attribute.
 * Unlike the `normal` attribute (which may be smooth/interpolated after
 * subdivision), `faceNormal` is always the true per-triangle normal computed
 * from the cross product of the triangle's edges.  The shader uses this for
 * angle-based masking so that smooth normals at edges don't cause mask bleeding.
 */
function addFaceNormals(geometry) {
  const pos   = geometry.attributes.position.array;
  const count = geometry.attributes.position.count;
  const fn    = new Float32Array(count * 3);
  const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n  = new THREE.Vector3();
  for (let i = 0; i < count; i += 3) {
    vA.set(pos[i * 3],       pos[i * 3 + 1],       pos[i * 3 + 2]);
    vB.set(pos[(i+1) * 3],   pos[(i+1) * 3 + 1],   pos[(i+1) * 3 + 2]);
    vC.set(pos[(i+2) * 3],   pos[(i+2) * 3 + 1],   pos[(i+2) * 3 + 2]);
    e1.subVectors(vB, vA);
    e2.subVectors(vC, vA);
    n.crossVectors(e1, e2).normalize();
    for (let v = 0; v < 3; v++) {
      fn[(i + v) * 3]     = n.x;
      fn[(i + v) * 3 + 1] = n.y;
      fn[(i + v) * 3 + 2] = n.z;
    }
  }
  geometry.setAttribute('faceNormal', new THREE.Float32BufferAttribute(fn, 3));
}

/**
 * Compute area-weighted smooth normals for a non-indexed geometry and store
 * them as a `smoothNormal` vec3 attribute.  Every copy of the same position
 * gets the same averaged normal so vertex-shader displacement is watertight.
 */
function addSmoothNormals(geometry) {
  const pos   = geometry.attributes.position.array;
  const count = geometry.attributes.position.count;
  const nrm   = geometry.attributes.normal.array;

  // Vertex-dedup pass: assign a numeric ID to each unique quantised position.
  const QUANT = 1e4;
  const dedupMap = new Map();
  let nextId = 0;
  const vertId = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const key = `${Math.round(pos[i*3]*QUANT)}_${Math.round(pos[i*3+1]*QUANT)}_${Math.round(pos[i*3+2]*QUANT)}`;
    let id = dedupMap.get(key);
    if (id === undefined) { id = nextId++; dedupMap.set(key, id); }
    vertId[i] = id;
  }

  // Accumulate area-weighted buffer normals per unique position into flat arrays.
  // The subdivision pipeline splits indexed vertices at sharp dihedral edges
  // (>30 deg) so the interpolated buffer normals are smooth across soft edges
  // (cylinder, sphere) but sharp across hard edges (cube).  Using these buffer
  // normals instead of geometric face normals eliminates visible faceting steps
  // on round surfaces while still preserving hard edges.
  const uc = nextId;
  const snx = new Float64Array(uc), sny = new Float64Array(uc), snz = new Float64Array(uc);
  const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), fn = new THREE.Vector3();

  for (let i = 0; i < count; i += 3) {
    vA.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    vB.set(pos[(i + 1) * 3], pos[(i + 1) * 3 + 1], pos[(i + 1) * 3 + 2]);
    vC.set(pos[(i + 2) * 3], pos[(i + 2) * 3 + 1], pos[(i + 2) * 3 + 2]);
    e1.subVectors(vB, vA);
    e2.subVectors(vC, vA);
    fn.crossVectors(e1, e2);
    const area = fn.length();
    if (area < 1e-12) continue;
    for (let v = 0; v < 3; v++) {
      const vi = i + v;
      const id = vertId[vi];
      snx[id] += nrm[vi * 3]     * area;
      sny[id] += nrm[vi * 3 + 1] * area;
      snz[id] += nrm[vi * 3 + 2] * area;
    }
  }

  // Normalize accumulated normals
  for (let id = 0; id < uc; id++) {
    const len = Math.sqrt(snx[id] * snx[id] + sny[id] * sny[id] + snz[id] * snz[id]) || 1;
    snx[id] /= len; sny[id] /= len; snz[id] /= len;
  }

  // Write smoothNormal attribute via vertId lookup
  const sn = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const id = vertId[i];
    sn[i * 3] = snx[id]; sn[i * 3 + 1] = sny[id]; sn[i * 3 + 2] = snz[id];
  }
  geometry.setAttribute('smoothNormal', new THREE.Float32BufferAttribute(sn, 3));
}

// ── Precision masking ─────────────────────────────────────────────────────────

/** Compute the target max edge length from the brush diameter. */
function computePrecisionEdgeLength(brushDiameter) {
  // ~20 edge segments around the brush circumference, clamped to a sane floor
  return Math.max(0.05, Math.PI * brushDiameter / 20);
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

    // Promote precision excluded faces to the base set
    excludedFaces = precisionExcludedFaces;

    // Update mesh info display
    const mb = ((currentGeometry.attributes.position.array.byteLength) / 1024 / 1024).toFixed(2);
    const sx = currentBounds.size.x.toFixed(2);
    const sy = currentBounds.size.y.toFixed(2);
    const sz = currentBounds.size.z.toFixed(2);
    meshInfo.textContent = t('ui.meshInfo', { n: triCount.toLocaleString(), mb, sx, sy, sz });
  } else if (precisionExcludedFaces.size > 0 && precisionParentMap) {
    // No precision geometry but have selections — map back to original
    excludedFaces = new Set();
    for (const pf of precisionExcludedFaces) {
      excludedFaces.add(precisionParentMap[pf]);
    }
  }

  // Clear all precision state
  precisionExcludedFaces = new Set();
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
    if (excludedFaces.size > 0) refreshExclusionOverlay();
    else setExclusionOverlay(null);
  }
}

/** Refresh (or initially build) the precision mesh from current brush size. */
async function refreshPrecisionMesh() {
  if (!currentGeometry || precisionBusy) return;

  const brushDiameter = parseFloat(exclBrushRadiusSlider.value);
  const targetEdge = computePrecisionEdgeLength(brushDiameter);

  // Estimate triangle count and warn if > 5M
  const estimated = estimateSubdivisionTriCount(currentGeometry, targetEdge);
  if (estimated > 5_000_000) {
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

    // Seed precisionExcludedFaces from existing excludedFaces
    precisionExcludedFaces = new Set();
    if (excludedFaces.size > 0) {
      const len = precisionParentMap.length;
      for (let i = 0; i < len; i++) {
        if (excludedFaces.has(precisionParentMap[i])) precisionExcludedFaces.add(i);
      }
    }

    // Swap display mesh to refined geometry
    setMeshGeometry(precisionGeometry);
    updateFaceMask(precisionGeometry);
    // Force per-vertex falloff computation on the fresh geometry even though
    // the masking tool is still active – updateFaceMask only computes boundary
    // edges during painting; the full vertex-level falloff is deferred until
    // the tool is deactivated, but we need it now for the initial state.
    {
      const maskAttr = precisionGeometry.getAttribute('faceMask');
      if (maskAttr) {
        computeBoundaryFalloffAttr(precisionGeometry, maskAttr.array);
        _falloffDirty = false;
        _falloffGeometry = precisionGeometry;
      }
    }
    if (precisionExcludedFaces.size > 0) refreshExclusionOverlay();
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
    meshInfo.textContent = t('ui.meshInfo', { n: triCount.toLocaleString(), mb, sx, sy, sz });

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
 * When enabled: subdivides the current geometry to a moderate resolution,
 * computes smooth normals, and switches the viewer to the subdivided
 * geometry with vertex-shader displacement.
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
    return;
  }

  // Need a model and texture to subdivide
  if (!currentGeometry || !currentBounds || !activeMapEntry) {
    dispPreviewToggle.checked = false;
    settings.useDisplacement = false;
    return;
  }

  if (dispPreviewBusy) return;
  const myToken = ++dispPreviewToken;
  dispPreviewBusy = true;

  try {
    // Choose a preview edge length: coarser than export for performance.
    // Target ~maxDim/80 so a 50 mm cube gets ~0.6 mm edges → ~100 k triangles.
    const maxDim = Math.max(currentBounds.size.x, currentBounds.size.y, currentBounds.size.z);
    const previewEdge = Math.max(0.1, maxDim / 80);

    await yieldFrame();
    if (dispPreviewToken !== myToken) return;

    const { geometry: subdivided, faceParentId } = await subdivide(
      currentGeometry, previewEdge, null, null, { fast: true }
    );
    if (dispPreviewToken !== myToken) { subdivided.dispose(); return; }

    addSmoothNormals(subdivided);
    addFaceNormals(subdivided);

    // Dispose previous preview geometry if any
    if (dispPreviewGeometry) dispPreviewGeometry.dispose();
    dispPreviewGeometry = subdivided;

    // Use the face parent IDs tracked through subdivision (O(n) instead of spatial search)
    dispPreviewParentMap = faceParentId;
    updateFaceMask(subdivided);

    // Force material recreation so it binds the new geometry with smoothNormal
    if (previewMaterial) {
      previewMaterial.dispose();
      previewMaterial = null;
    }
    const fullSettings = { ...settings, bounds: currentBounds };
    previewMaterial = createPreviewMaterial(getEffectiveMapEntry().texture, fullSettings);
    setMeshGeometry(dispPreviewGeometry);
    setMeshMaterial(previewMaterial);
    _pushColorPreviewState();


  } catch (err) {
    console.error('Displacement preview failed:', err);
    dispPreviewToggle.checked = false;
    settings.useDisplacement = false;
  } finally {
    dispPreviewBusy = false;
  }
}

// ── Export pipeline ───────────────────────────────────────────────────────────

/**
 * Builds per-non-indexed-vertex weights (1.0 = excluded from subdivision/displacement)
 * that combine the user-painted exclusion set AND the top/bottom angle mask.
 */
function buildCombinedFaceWeights(geometry, excludedFaces, invert, settings) {
  const weights = buildFaceWeights(geometry, excludedFaces, invert);

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

async function handleExport(format = 'stl') {
  if (!currentGeometry || !activeMapEntry || isExporting || isBaking) return;
  const myToken = ++exportToken;
  isExporting = true;
  exportBtn.classList.add('busy');
  export3mfBtn.classList.add('busy');
  exportProgress.classList.remove('hidden');

  // If precision masking is active, bake the refined mesh before exporting
  if (precisionMaskingEnabled) {
    deactivatePrecisionMasking();
  }

  // Hoist intermediate geometries so the finally block can always dispose them
  let subdivided      = null;
  let displaced       = null;
  let finalGeometry   = null;
  let exportSucceeded = false; // set true only after exportSTL so finally can clean up on abort/error

  try {
    setProgress(0.02, t('progress.subdividing'));
    await yieldFrame();
    if (exportToken !== myToken) return;

    // Build per-vertex exclusion weights combining user-painted exclusion + angle masking.
    // Faces masked by top/bottom angle limits are treated the same as user-excluded faces
    // so subdivision skips their interior edges too, saving triangles where no
    // displacement will be applied.
    const hasAngleMask = settings.bottomAngleLimit > 0 || settings.topAngleLimit > 0;
    const faceWeights = (excludedFaces.size > 0 || selectionMode || hasAngleMask)
      ? buildCombinedFaceWeights(currentGeometry, excludedFaces, selectionMode, settings)
      : null;

    let safetyCapHit;
    let faceParentId; // Int32Array: subdivided face → original face index (used by colorBake)
    ({ geometry: subdivided, safetyCapHit, faceParentId } = await subdivide(
      currentGeometry, settings.refineLength,
      (p, triCount, longestEdge) => {
        const label = triCount != null
          ? t('progress.refining', { cur: triCount.toLocaleString(), edge: longestEdge.toFixed(2) })
          : t('progress.subdividing');
        setProgress(0.02 + p * 0.35, label);
      },
      faceWeights
    ));
    if (exportToken !== myToken) return;

    const subTriCount = subdivided.attributes.position.count / 3;
    setProgress(0.38, t('progress.applyingDisplacement', { n: subTriCount.toLocaleString() }));

    const exportEntry = getEffectiveMapEntry();
    displaced = await runAsync(() =>
      applyDisplacement(
        subdivided,
        exportEntry.imageData,
        exportEntry.width,
        exportEntry.height,
        settings,
        currentBounds,
        (p) => setProgress(0.38 + p * 0.32, t('progress.displacingVertices'))
      )
    );
    if (exportToken !== myToken) return;

    // Free subdivided geometry — displacement created a separate copy
    subdivided.dispose();

    // ── Color bake (3MF only) ─────────────────────────────────────────────
    // Writes a per-vertex `color` Float32×3 BufferAttribute on `displaced`
    // before decimation, so QEM threads it through to the final mesh.
    // No-op when colorExportEnabled is off; STL exports never read the attribute.
    if (format === '3mf' && settings.colorExportEnabled) {
      setProgress(0.69, t('progress.bakingColor') || 'Baking color…');
      await yieldFrame();
      if (exportToken !== myToken) return;
      try {
        applyColors(displaced, faceParentId, exportEntry.imageData,
          exportEntry.width, exportEntry.height,
          _lastColorMap && _lastColorMap.imageData ? _lastColorMap.imageData : null,
          _lastColorMap ? _lastColorMap.width  : 0,
          _lastColorMap ? _lastColorMap.height : 0,
          settings, currentBounds);
      } catch (err) {
        console.warn('Color bake failed; exporting without color:', err);
      }
    }

    const dispTriCount = displaced.attributes.position.count / 3;
    const needsDecimation = dispTriCount > settings.maxTriangles;
    triLimitWarning.classList.toggle('hidden', !safetyCapHit);
    triLimitWarning.textContent = t('warnings.safetyCapHit');

    finalGeometry = displaced;
    if (needsDecimation) {
      setProgress(0.71, t('progress.decimatingTo', { from: dispTriCount.toLocaleString(), to: settings.maxTriangles.toLocaleString() }));
      finalGeometry = await runAsync(() =>
        decimate(
          displaced,
          settings.maxTriangles,
          (p) => {
            const cur = Math.round(dispTriCount - (dispTriCount - settings.maxTriangles) * p);
            setProgress(
              0.71 + p * 0.25,
              t('progress.decimating', { cur: cur.toLocaleString(), to: settings.maxTriangles.toLocaleString() })
            );
          },
          { preserveColor: format === '3mf' && settings.colorExportEnabled }
        )
      );
      // Free pre-decimation geometry — decimate created a separate copy
      displaced.dispose();
	  if (exportToken !== myToken) return;
    }

    // Flat-bottom clamp: when bottom faces are masked (bottomAngleLimit > 0),
    // any vertex that ended up below the original model's bottom layer gets
    // snapped back up to that Z. Single pass with selective normal recomputation.
    if (settings.bottomAngleLimit > 0) {
      const bottomZ = currentBounds.min.z;
      const pa = finalGeometry.attributes.position.array;
      const na = finalGeometry.attributes.normal ? finalGeometry.attributes.normal.array : new Float32Array(pa.length);

      for (let i = 0; i < pa.length; i += 9) {
        let dirty = false;
        if (pa[i+2] < bottomZ) { pa[i+2] = bottomZ; dirty = true; }
        if (pa[i+5] < bottomZ) { pa[i+5] = bottomZ; dirty = true; }
        if (pa[i+8] < bottomZ) { pa[i+8] = bottomZ; dirty = true; }

        if (dirty) {
          const ux = pa[i+3]-pa[i],   uy = pa[i+4]-pa[i+1], uz = pa[i+5]-pa[i+2];
          const vx = pa[i+6]-pa[i],   vy = pa[i+7]-pa[i+1], vz = pa[i+8]-pa[i+2];
          const nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
          const len = Math.sqrt(nx*nx+ny*ny+nz*nz) || 1;
          na[i]   = na[i+3] = na[i+6] = nx/len;
          na[i+1] = na[i+4] = na[i+7] = ny/len;
          na[i+2] = na[i+5] = na[i+8] = nz/len;
        }
      }

      finalGeometry.attributes.position.needsUpdate = true;
      if (!finalGeometry.attributes.normal) finalGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(na, 3));
      else finalGeometry.attributes.normal.needsUpdate = true;
    }

    const texLabel = activeMapEntry.isCustom ? 'custom' : activeMapEntry.name.replace(/\s+/g, '-');
    const ampLabel = settings.amplitude.toFixed(2).replace('.', 'p');
    const baseName = `${currentStlName}_${texLabel}_amp${ampLabel}`;

    if (format === '3mf') {
      setProgress(0.97, t('progress.writing3mf'));
      await yieldFrame();
      if (exportToken !== myToken) return;

      // Quantize per-vertex colors to a small palette (≤32 entries) when
      // color export is enabled and the bake produced a `color` attribute.
      // Falls through to a geometry-only 3MF when either is absent —
      // unchanged backward-compat path.
      let exportOpts = undefined;
      if (settings.colorExportEnabled && finalGeometry.attributes.color) {
        const colAttr = finalGeometry.attributes.color.array;
        const triCount = (finalGeometry.attributes.position.count / 3) | 0;
        const triRGB = new Uint8Array(triCount * 3);
        for (let i = 0; i < triCount; i++) {
          // Average the 3 vertex colors for the triangle.
          const off = i * 9; // 3 verts * 3 components
          const r = (colAttr[off]   + colAttr[off + 3] + colAttr[off + 6]) / 3;
          const g = (colAttr[off+1] + colAttr[off + 4] + colAttr[off + 7]) / 3;
          const b = (colAttr[off+2] + colAttr[off + 5] + colAttr[off + 8]) / 3;
          triRGB[i * 3]     = Math.round(Math.max(0, Math.min(1, r)) * 255);
          triRGB[i * 3 + 1] = Math.round(Math.max(0, Math.min(1, g)) * 255);
          triRGB[i * 3 + 2] = Math.round(Math.max(0, Math.min(1, b)) * 255);
        }
        try {
          if (settings.colorAutoSource === 'gradient') {
            // Snap each triangle's color to the nearest of the user-defined
            // gradient stops + the base color. The user picks the colors;
            // no statistical averaging — the exported palette is exactly
            // the control points they specified. AMS slot assignment is
            // predictable: stop-count + maybe-1 (base) entries.
            exportOpts = _snapToControlPoints(triRGB, settings);
          } else {
            // Image source (or fallback): median-cut at the user-chosen
            // palette size. Image data has no natural "control points" so
            // statistical clustering is the right tool here.
            const paletteCap = Math.max(2, Math.min(32, +settings.colorPaletteSize || 4));
            const { palette, indices } = medianCut(triRGB, paletteCap);
            exportOpts = { palette, triPaletteIndices: indices };
          }

          // Region smoothing: collapse speckle triangles into their majority-
          // neighbor color. With per-vertex baking + decimation averaging,
          // boundary triangles can land on an isolated palette entry that
          // disagrees with all their neighbors — the slicer then treats every
          // such triangle as its own filament region and produces a chaotic
          // slice plan (non-manifold-style errors, fractured fill paths).
          // 3 passes is plenty empirically — converges by then for most meshes.
          setProgress(0.96, t('progress.smoothingColorRegions') || 'Smoothing color regions…');
          await yieldFrame();
          if (exportToken !== myToken) return;
          const adj = buildAdjacency(finalGeometry);
          _smoothPaletteRegions(exportOpts.triPaletteIndices, adj.adjacency, 3);
        } catch (err) {
          console.warn('Quantization failed; exporting without color:', err);
        }
      }
      export3MF(finalGeometry, `${baseName}.3mf`, exportOpts);
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
    console.error('Export failed:', err);
    if (/maximum size|out of memory|alloc/i.test(err.message)) {
      alert(t('alerts.exportOOM'));
    } else {
      alert(t('alerts.exportFailed', { msg: err.message }));
    }
  } finally {
    // Dispose all intermediate geometries regardless of success, failure, or abort.
    // finalGeometry may alias displaced (no decimation) — avoid double-dispose.
    if (subdivided) subdivided.dispose();
    if (displaced && displaced !== subdivided) displaced.dispose();
    if (finalGeometry && finalGeometry !== displaced && finalGeometry !== subdivided) finalGeometry.dispose();
    // Hide progress immediately on error or stale abort; success hides it after 1500 ms.
    if (!exportSucceeded) exportProgress.classList.add('hidden');
    isExporting = false;
    exportBtn.classList.remove('busy');
    export3mfBtn.classList.remove('busy');
  }
}

function setProgress(fraction, label) {
  const pct = Math.round(fraction * 100);
  exportProgBar.style.width = `${pct}%`;
  exportProgPct.textContent = `${pct}%`;
  exportProgLbl.textContent = label;
}

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

  let subdivided = null;
  let displaced  = null;
  let succeeded  = false;

  try {
    setBakeProgress(0.02, t('progress.subdividing'));
    await yieldFrame();

    // Mirror handleExport's pre-flight: combine user mask + angle masking
    // into per-vertex weights for subdivision.
    const hasAngleMask = settings.bottomAngleLimit > 0 || settings.topAngleLimit > 0;
    const faceWeights = (excludedFaces.size > 0 || selectionMode || hasAngleMask)
      ? buildCombinedFaceWeights(currentGeometry, excludedFaces, selectionMode, settings)
      : null;

    let faceParentId;
    ({ geometry: subdivided, faceParentId } = await subdivide(
      currentGeometry, settings.refineLength,
      (p, triCount, longestEdge) => {
        const label = triCount != null
          ? t('progress.refining', { cur: triCount.toLocaleString(), edge: longestEdge.toFixed(2) })
          : t('progress.subdividing');
        setBakeProgress(0.02 + p * 0.45, label);
      },
      faceWeights
    ));

    const subTriCount = subdivided.attributes.position.count / 3;
    setBakeProgress(0.47, t('progress.applyingDisplacement', { n: subTriCount.toLocaleString() }));

    const exportEntry = getEffectiveMapEntry();
    displaced = await runAsync(() =>
      applyDisplacement(
        subdivided,
        exportEntry.imageData,
        exportEntry.width,
        exportEntry.height,
        settings,
        currentBounds,
        (p) => setBakeProgress(0.47 + p * 0.40, t('progress.displacingVertices'))
      )
    );

    // Free pre-displacement subdivision — applyDisplacement returns a separate copy.
    subdivided.dispose();
    subdivided = null;

    // Mirror the export-side flat-bottom clamp.
    if (settings.bottomAngleLimit > 0) {
      const bottomZ = currentBounds.min.z;
      const pa = displaced.attributes.position.array;
      const na = displaced.attributes.normal ? displaced.attributes.normal.array : new Float32Array(pa.length);

      for (let i = 0; i < pa.length; i += 9) {
        let dirty = false;
        if (pa[i+2] < bottomZ) { pa[i+2] = bottomZ; dirty = true; }
        if (pa[i+5] < bottomZ) { pa[i+5] = bottomZ; dirty = true; }
        if (pa[i+8] < bottomZ) { pa[i+8] = bottomZ; dirty = true; }

        if (dirty) {
          const ux = pa[i+3]-pa[i],   uy = pa[i+4]-pa[i+1], uz = pa[i+5]-pa[i+2];
          const vx = pa[i+6]-pa[i],   vy = pa[i+7]-pa[i+1], vz = pa[i+8]-pa[i+2];
          const nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
          const len = Math.sqrt(nx*nx+ny*ny+nz*nz) || 1;
          na[i]   = na[i+3] = na[i+6] = nx/len;
          na[i+1] = na[i+4] = na[i+7] = ny/len;
          na[i+2] = na[i+5] = na[i+8] = nz/len;
        }
      }

      displaced.attributes.position.needsUpdate = true;
      if (!displaced.attributes.normal) displaced.setAttribute('normal', new THREE.Float32BufferAttribute(na, 3));
      else displaced.attributes.normal.needsUpdate = true;
    }

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
    if (subdivided) subdivided.dispose();
    if (displaced)  displaced.dispose();
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
  dispPreviewToken++;
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

  // Seed exclusion mask, exit any active painting/place/rotate modes.
  excludedFaces = new Set(opts.preExcludedFaces || []);
  precisionExcludedFaces = new Set();
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
  updateMeshDiagnostics(adjData, geometry.attributes.position.count / 3);

  // Refresh exclusion overlay using the new geometry + new mask.
  if (excludedFaces.size > 0) refreshExclusionOverlay();
  else setExclusionOverlay(null);
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
  meshInfo.textContent = t('ui.meshInfo', { n: triCount.toLocaleString(), mb, sx, sy, sz });

  exportBtn.disabled = (activeMapEntry === null);
  export3mfBtn.disabled = (activeMapEntry === null);
  bakeBtn.disabled = (activeMapEntry === null);

  updatePreview();

  // Bake is a destructive transform — undo history references the pre-bake
  // triangle set, so it's no longer meaningful.
  _clearUndoStacks();
}

/**
 * Yield to the browser event loop, then run fn.
 * Uses setTimeout instead of rAF so it fires even in background tabs.
 */
function runAsync(fn) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try { resolve(fn()); }
      catch (e) { reject(e); }
    }, 0);
  });
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
  'symmetricDisplacement', 'noDownwardZ', 'textureSmoothing',
  'mappingBlend', 'seamBandWidth', 'capAngle', 'boundaryFalloff',
  'bottomAngleLimit', 'topAngleLimit',
  'refineLength', 'maxTriangles',
  // Cylindrical-mode controls. cylinderCenterX/Y/radius are nullable —
  // null means "fall back to AABB defaults", which is what fresh loads get.
  'snapSeamlessWrap', 'cylinderCenterX', 'cylinderCenterY', 'cylinderRadius',
  'cylinderPanelMinimized',
  // Color export. The uploaded color image is intentionally NOT here — it's
  // shipped as a separate `color.png` zip entry in .bumpmesh and never touches
  // sessionStorage (would blow the 5MB quota). `_lastColorMap` holds the
  // runtime cache.
  'colorExportEnabled', 'colorAutoSource', 'colorBaseColor', 'colorGradientStops',
  'colorPaletteSize', 'colorSnapPreview',
];

function getSettingsSnapshot() {
  const snap = {};
  for (const k of PERSISTED_KEYS) {
    const v = settings[k];
    // Deep-copy gradient stops so undo snapshots don't share the live array
    // (mutation of stop.pos / stop.color would otherwise contaminate history).
    if (k === 'colorGradientStops' && Array.isArray(v)) {
      snap[k] = v.map(s => ({ pos: s.pos, color: s.color }));
    } else {
      snap[k] = v;
    }
  }
  if (activeMapEntry) {
    snap.activeMapName = activeMapEntry.name;
  } else {
    // Thumbnails may not have finished loading yet; preserve any previously
    // persisted preset name so a mid-load autosave doesn't wipe it.
    try {
      const prev = JSON.parse(sessionStorage.getItem(PROJECT_STORAGE_KEY) || 'null');
      snap.activeMapName = (prev && prev.activeMapName) || null;
    } catch { snap.activeMapName = null; }
  }
  return snap;
}

/**
 * Apply a settings snapshot to the live UI. Drives each control through the
 * same event it fires on user input (via dispatchEvent), so linkSlider's
 * clamp/display/preview flow runs unchanged.
 */
function applySettingsSnapshot(snap) {
  if (!snap) return;

  // Mapping mode first — changes cap-angle row visibility and triggers preview.
  if (snap.mappingMode != null) {
    mappingSelect.value = String(snap.mappingMode);
    mappingSelect.dispatchEvent(new Event('change', { bubbles: true }));
  }

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

  // ── Color export settings ─────────────────────────────────────────────────
  // Dispatching change events on each control pulls them through the standard
  // auto-save / undo / preview flow. Missing DOM elements are silently skipped.
  if ('colorExportEnabled' in snap) {
    settings.colorExportEnabled = !!snap.colorExportEnabled;
    const el = document.getElementById('color-export-toggle');
    if (el) { el.checked = settings.colorExportEnabled; el.dispatchEvent(new Event('change', { bubbles: true })); }
  }
  if ('colorAutoSource' in snap && (snap.colorAutoSource === 'none' || snap.colorAutoSource === 'gradient' || snap.colorAutoSource === 'image')) {
    settings.colorAutoSource = snap.colorAutoSource;
    const el = document.querySelector(`input[name="color-auto-source"][value="${settings.colorAutoSource}"]`);
    if (el) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }
  }
  if ('colorBaseColor' in snap && typeof snap.colorBaseColor === 'string') {
    settings.colorBaseColor = snap.colorBaseColor;
    const el = document.getElementById('color-base-picker');
    if (el) { el.value = settings.colorBaseColor; el.dispatchEvent(new Event('change', { bubbles: true })); }
  }
  if ('colorGradientStops' in snap && Array.isArray(snap.colorGradientStops) && snap.colorGradientStops.length >= 2) {
    // Deep-copy so the live settings array is never aliased to a snapshot.
    settings.colorGradientStops = snap.colorGradientStops.map(s => ({ pos: s.pos, color: s.color }));
    if (window._gradientEditor && typeof window._gradientEditor.setStops === 'function') {
      window._gradientEditor.setStops(settings.colorGradientStops);
    }
  }
  if ('colorPaletteSize' in snap) {
    const n = +snap.colorPaletteSize | 0;
    if (n >= 2 && n <= 32) {
      settings.colorPaletteSize = n;
      const el = document.getElementById('color-palette-size');
      if (el) { el.value = String(n); el.dispatchEvent(new Event('change', { bubbles: true })); }
    }
  }
  if ('colorSnapPreview' in snap) {
    settings.colorSnapPreview = !!snap.colorSnapPreview;
    const el = document.getElementById('color-snap-preview');
    if (el) { el.checked = settings.colorSnapPreview; el.dispatchEvent(new Event('change', { bubbles: true })); }
  }
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
  const swatch = _presetSwatches[idx];
  if (!swatch) return false;
  selectPreset(idx, swatch, applyDefaults);
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

// ── Reset to defaults ───────────────────────────────────────────────────────
// Frozen snapshot of the initial `settings` object plus the default preset
// name, so the reset button restores exactly what a fresh session starts with.

const DEFAULT_SETTINGS_SNAPSHOT = Object.freeze({
  mappingMode: 5, scaleU: 0.5, scaleV: 0.5, lockScale: true,
  offsetU: 0, offsetV: 0, rotation: 0,
  amplitude: 0.5, textureHeight: 0.5, invertDisplacement: false,
  symmetricDisplacement: false, noDownwardZ: false, textureSmoothing: 0,
  mappingBlend: 1, seamBandWidth: 0.5, capAngle: 20, boundaryFalloff: 0,
  bottomAngleLimit: 5, topAngleLimit: 0,
  refineLength: 1, maxTriangles: 750000,
  snapSeamlessWrap: true,
  cylinderCenterX: null, cylinderCenterY: null, cylinderRadius: null,
  cylinderPanelMinimized: false,
  // Color export defaults — feature off, gradient stops form a neutral dark→light ramp.
  colorExportEnabled: false,
  colorAutoSource: 'none',
  colorBaseColor: '#ffffff',
  colorGradientStops: [
    { pos: 0, color: '#222222' },
    { pos: 1, color: '#dddddd' },
  ],
  colorPaletteSize: 4,
  colorSnapPreview: false,
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
    _lastColorMap          = null;
    refreshColorImageUI();
    if (currentGeometry) refreshExclusionOverlay();

    const defaultIdx = IMAGE_PRESETS.findIndex(p => p.name === DEFAULT_PRESET_NAME);
    if (defaultIdx >= 0 && _presetSwatches[defaultIdx] && PRESETS[defaultIdx]) {
      // applyDefaults=true so the preset's defaultScale overrides whatever
      // scale the user had — matches the "fresh session" intent.
      selectPreset(defaultIdx, _presetSwatches[defaultIdx], true);
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

    const payload = { version: PROJECT_VERSION, ...getSettingsSnapshot() };
    // Mark the custom map as the active reference so the importer restores it
    // even if the user has a preset selected at export time.
    if (includeTexture) payload.activeMapName = customSource.name;
    const zipFiles = { 'settings.json': strToU8(JSON.stringify(payload, null, 2)) };

    if (includeModel) {
      zipFiles['model.stl'] = _geometryToBinarySTL(currentGeometry);
      // Mask indices reference the base geometry's triangles, so they only make
      // sense when shipped alongside the model that produced them.
      const mask = _collectCurrentMask();
      if (mask) zipFiles['mask.json'] = strToU8(JSON.stringify(mask));
    }
    if (includeTexture) {
      const blob = await new Promise(r => customSource.fullCanvas.toBlob(r, 'image/png'));
      zipFiles['texture.png'] = new Uint8Array(await blob.arrayBuffer());
    }

    // Ship the uploaded color image, if any. Kept out of sessionStorage (would
    // blow the 5MB quota); only ever lives in the .bumpmesh package.
    if (_lastColorMap && _lastColorMap.fullCanvas) {
      try {
        const blob = await new Promise(r => _lastColorMap.fullCanvas.toBlob(r, 'image/png'));
        zipFiles['color.png'] = new Uint8Array(await blob.arrayBuffer());
      } catch (err) { console.warn('Could not embed color image:', err); }
    }

    const zipped = zipSync(zipFiles);
    _downloadBlob(new Blob([zipped], { type: 'application/octet-stream' }),
                  (currentStlName || 'bumpmesh') + '.bumpmesh');
  } catch (err) {
    alert(t('alerts.exportFailed', { msg: err.message }));
  }
});

/** Pack a BufferGeometry into binary-STL bytes (80-byte header, uint32 count, 50 bytes per triangle). */
function _geometryToBinarySTL(geo) {
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
      view.setFloat32(dst,     nor[srcNor],     true);
      view.setFloat32(dst + 4, nor[srcNor + 1], true);
      view.setFloat32(dst + 8, nor[srcNor + 2], true);
    }
    for (let v = 0; v < 3; v++) {
      const d = dst + 12 + v * 12;
      view.setFloat32(d,     pos[srcPos + v * 3],     true);
      view.setFloat32(d + 4, pos[srcPos + v * 3 + 1], true);
      view.setFloat32(d + 8, pos[srcPos + v * 3 + 2], true);
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
 */
function _collectCurrentMask() {
  let liveExcluded;
  if (precisionMaskingEnabled && precisionParentMap && precisionExcludedFaces.size > 0) {
    liveExcluded = new Set();
    for (const pf of precisionExcludedFaces) liveExcluded.add(precisionParentMap[pf]);
  } else {
    liveExcluded = excludedFaces;
  }
  if (liveExcluded.size === 0 && !selectionMode) return null;
  return { selectionMode, excluded: [...liveExcluded] };
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
    refreshExclusionOverlay();
    return;
  }
  const triCount = (currentGeometry.attributes.position.count / 3) | 0;
  if (mask.selectionMode === true)  setSelectionMode(true);
  else if (mask.selectionMode === false && selectionMode) setSelectionMode(false);

  const valid = (Array.isArray(mask.excluded) ? mask.excluded : [])
    .filter(i => Number.isInteger(i) && i >= 0 && i < triCount);
  excludedFaces = new Set(valid);
  precisionExcludedFaces = new Set(); // precision rebuilds from this on demand
  // Older .bumpmesh files (pre-paint-removal) may include `mask.coloredFaces`;
  // we silently ignore it. The data isn't useful without the paint UI.
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
  _undoApplyDepth++;
  try {
  const buf = await file.arrayBuffer();
  const unzipped = unzipSync(new Uint8Array(buf));

  const settingsBytes = unzipped['settings.json'];
  const data = settingsBytes ? JSON.parse(strFromU8(settingsBytes)) : null;

  // 1) Load model first — handleModelFile resets scaleU/scaleV/offsets/refineLength
  //    AND clears any existing paint mask, so applied settings + restored mask
  //    below will correctly override those resets.
  const hasModel = !!unzipped['model.stl'];
  if (hasModel) {
    const stlFile = new File([unzipped['model.stl']], 'model.stl', { type: 'application/octet-stream' });
    await handleModelFile(stlFile);
  }

  // 2) Apply settings after any model reset.
  if (data) applySettingsSnapshot(data);

  // 2b) Restore paint mask — only meaningful when the project shipped a model,
  //     since indices reference that exact triangle set.
  if (hasModel && unzipped['mask.json']) {
    try {
      const mask = JSON.parse(strFromU8(unzipped['mask.json']));
      _restoreMask(mask);
    } catch (err) { console.warn('Could not restore paint mask:', err); }
  }

  // 3) Texture: custom PNG wins over named preset.
  if (unzipped['texture.png']) {
    const texName = (data && data.activeMapName) || 'imported-texture.png';
    const texFile = new File([unzipped['texture.png']], texName, { type: 'image/png' });
    activeMapEntry = await loadCustomTexture(texFile);
    activeMapEntry.isCustom = true;
    activeMapEntry.name = texName;
    _lastCustomMap = activeMapEntry;
    activeMapName.textContent = texName;
    document.querySelectorAll('.preset-swatch').forEach(s => s.classList.remove('active'));
    _showCustomMapThumb(activeMapEntry);
    customMapSwatch.classList.add('active');
    updatePreview();
  } else if (data && data.activeMapName) {
    _selectPresetByName(data.activeMapName);
  }

  // Restore color image if the project shipped one. Decodes off-thread via
  // createImageBitmap into a backing canvas + ImageData so colorBake can sample it.
  if (unzipped['color.png']) {
    try {
      const blob = new Blob([unzipped['color.png']], { type: 'image/png' });
      const bmp  = await createImageBitmap(blob);
      const cvs  = document.createElement('canvas');
      cvs.width  = bmp.width;
      cvs.height = bmp.height;
      const ctx  = cvs.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const imgData = ctx.getImageData(0, 0, bmp.width, bmp.height);
      _lastColorMap = {
        name: 'imported-color.png',
        imageData: imgData,
        width: bmp.width,
        height: bmp.height,
        fullCanvas: cvs,
      };
      // Update the preview thumbnail / file-input label if Unit D wired it.
      if (typeof window._refreshColorImageUI === 'function') window._refreshColorImageUI();
      bmp.close && bmp.close();
    } catch (err) { console.warn('Could not restore color image:', err); }
  } else {
    _lastColorMap = null;
    if (typeof window._refreshColorImageUI === 'function') window._refreshColorImageUI();
  }

  _autoSaveSettings();
  } finally {
    _undoApplyDepth--;
    // Imported project = fresh start; mask indices belong to the imported model.
    _clearUndoStacks();
  }
}

// ── Undo / Redo ──────────────────────────────────────────────────────────────
// Snapshot stack over the same state the project save/load helpers handle:
// `getSettingsSnapshot()` (PERSISTED_KEYS + activeMapName) and
// `_collectCurrentMask()` (selectionMode + excluded face indices). Operations
// are debounced so a slider drag collapses to one undo step.

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
    // colorGradientStops is the only nested structure in PERSISTED_KEYS — compare
    // by value rather than by reference (snapshots always deep-copy on capture).
    if (k === 'colorGradientStops') {
      const av = a.settings[k], bv = b.settings[k];
      if (av === bv) continue;
      if (!Array.isArray(av) || !Array.isArray(bv)) return false;
      if (av.length !== bv.length) return false;
      let differs = false;
      for (let i = 0; i < av.length; i++) {
        if (av[i].pos !== bv[i].pos || av[i].color !== bv[i].color) { differs = true; break; }
      }
      if (differs) return false;
      continue;
    }
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
  return true;
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
    if (snap.settings && snap.settings.activeMapName) {
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
