import * as THREE from 'three';
import { initViewer, loadGeometry, setMeshMaterial, setMeshGeometry, setWireframe,
         getControls, getCamera, getCurrentMesh,
         setExclusionOverlay, setHoverPreview, setViewerTheme } from './viewer.js';
import { loadModelFile, computeBounds, getTriangleCount }  from './stlLoader.js';
import { loadPresets, loadCustomTexture }  from './presetTextures.js';
import { createPreviewMaterial, updateMaterial } from './previewMaterial.js';
import { subdivide }          from './subdivision.js';
import { applyDisplacement }  from './displacement.js';
import { decimate }           from './decimation.js';
import { exportSTL }          from './exporter.js';
import { buildAdjacency, bucketFill,
         buildExclusionOverlayGeo, buildFaceWeights } from './exclusion.js';
import { t, initLang, setLang, getLang, applyTranslations } from './i18n.js';

// ── State ─────────────────────────────────────────────────────────────────────

let currentGeometry   = null;   // original loaded geometry
let currentBounds     = null;   // bounds of the original geometry
let currentStlName    = 'model'; // base filename of the loaded STL (no extension)
let activeMapEntry    = null;   // { name, texture, imageData, width, height, isCustom? }
let previewMaterial   = null;
let isExporting       = false;
let previewDebounce   = null;

// ── Exclusion state ───────────────────────────────────────────────────────────
let excludedFaces      = new Set();   // triangle indices in currentGeometry
let triangleAdjacency  = null;        // Map from buildAdjacency
let triangleCentroids  = null;        // Float32Array from buildAdjacency
let triangleBoundRadii = null;        // Float32Array — max vertex-to-centroid dist per tri
let exclusionTool      = null;        // 'brush' | 'bucket' | null
let eraseMode          = false;
let brushIsRadius      = false;
let brushRadius        = 5.0;
let bucketThreshold    = 20;
let isPainting         = false;
let selectionMode      = false;       // false = exclude painted faces; true = include only painted faces
let _lastHoverTriIdx   = -1;          // last triangle index used for hover preview
let placeOnFaceActive  = false;       // true while "Place on Face" mode is active
const _raycaster       = new THREE.Raycaster();

const settings = {
  mappingMode:   5,     // Triplanar default
  scaleU:        0.5,
  scaleV:        0.5,
  amplitude:     0.5,
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
  symmetricDisplacement: false,
  useDisplacement: false,
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
let precisionBoundRadii     = null;   // Float32Array — max vertex-to-centroid per refined tri
let precisionAdjacency      = null;   // Map from buildAdjacency on refined mesh
let precisionExcludedFaces  = new Set(); // precision face indices excluded while precision is active

// ── Displacement preview state ────────────────────────────────────────────────
let dispPreviewGeometry  = null;   // subdivided geometry with smoothNormal attribute
let dispPreviewBusy      = false;  // true while async subdivision is running
let dispPreviewParentMap = null;   // Int32Array: subdivided face → original face index

// ── DOM refs ──────────────────────────────────────────────────────────────────

const canvas         = document.getElementById('viewport');
const brushCursorEl  = document.getElementById('brush-cursor');
const dropZone       = document.getElementById('drop-zone');
const dropHint       = document.getElementById('drop-hint');
const stlFileInput   = document.getElementById('stl-file-input');
const textureInput   = document.getElementById('texture-file-input');
const presetGrid     = document.getElementById('preset-grid');
const activeMapName  = document.getElementById('active-map-name');
const meshInfo       = document.getElementById('mesh-info');
const exportBtn        = document.getElementById('export-btn');
const exportProgress   = document.getElementById('export-progress');
const exportProgBar    = document.getElementById('export-progress-bar');
const exportProgPct    = document.getElementById('export-progress-pct');
const exportProgLbl    = document.getElementById('export-progress-label');
const triLimitWarning  = document.getElementById('tri-limit-warning');
const wireframeToggle  = document.getElementById('wireframe-toggle');
const placeOnFaceBtn   = document.getElementById('place-on-face-btn');

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
const refineLenVal = document.getElementById('refine-length-val');
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
const symmetricDispToggle    = document.getElementById('symmetric-displacement');
const dispPreviewToggle      = document.getElementById('displacement-preview');

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

// ── License panel DOM refs ────────────────────────────────────────────────────
const licenseLink    = document.getElementById('license-link');
const licenseOverlay = document.getElementById('license-overlay');
const licenseClose   = document.getElementById('license-close');
const imprintLink    = document.getElementById('imprint-link');
const imprintOverlay = document.getElementById('imprint-overlay');
const imprintClose   = document.getElementById('imprint-close');

// ── Scale slider log helpers ──────────────────────────────────────────────────
// Slider stores 0–1000; actual scale spans 0.05–10 on a log axis.
// Middle position 500 → scale ~0.71 (log midpoint between 0.05 and 10).
const _LOG_MIN = Math.log(0.05);
const _LOG_MAX = Math.log(10);
const scaleToPos = v => Math.round((Math.log(Math.max(0.05, Math.min(10, v))) - _LOG_MIN) / (_LOG_MAX - _LOG_MIN) * 1000);
const posToScale = p => parseFloat(Math.exp(_LOG_MIN + (p / 1000) * (_LOG_MAX - _LOG_MIN)).toFixed(2));

function _applyScaleU(v) {
  v = Math.max(0.05, Math.min(10, v));
  settings.scaleU = v;
  scaleUSlider.value = scaleToPos(v);
  scaleUVal.value = v;
  if (settings.lockScale) { settings.scaleV = v; scaleVSlider.value = scaleToPos(v); scaleVVal.value = v; }
  clearTimeout(previewDebounce); previewDebounce = setTimeout(updatePreview, 80);
}

// ── Init ──────────────────────────────────────────────────────────────────────

let PRESETS = [];

initViewer(canvas);

// Apply saved theme to 3D viewport on startup
setViewerTheme(document.documentElement.getAttribute('data-theme') === 'light');

// Initialise language (reads localStorage / browser preference, applies translations)
initLang();

// Sync lang buttons to current language
(function() {
  const lang = getLang();
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.langCode === lang);
  });
})();

// Theme toggle
document.getElementById('theme-toggle').addEventListener('click', () => {
  const isLight = document.documentElement.getAttribute('data-theme') !== 'light';
  document.documentElement.setAttribute('data-theme', isLight ? 'light' : 'dark');
  localStorage.setItem('stlt-theme', isLight ? 'light' : 'dark');
  setViewerTheme(isLight);
});

wireEvents();
// Sync scale number inputs with the slider's initial position
scaleUVal.value = posToScale(parseFloat(scaleUSlider.value));
scaleVVal.value = posToScale(parseFloat(scaleVSlider.value));

loadPresets().then(presets => {
  PRESETS = presets;
  buildPresetGrid();
  loadDefaultCube();
  // Select Crystal as the default preset
  const noiseIdx = PRESETS.findIndex(p => p.name === 'Crystal');
  const defaultIdx = noiseIdx !== -1 ? noiseIdx : 0;
  const swatches = presetGrid.querySelectorAll('.preset-swatch');
  if (swatches[defaultIdx]) selectPreset(defaultIdx, swatches[defaultIdx]);
}).catch(err => console.error('Failed to load preset textures:', err));

// ── Preset grid ───────────────────────────────────────────────────────────────

function buildPresetGrid() {
  PRESETS.forEach((preset, idx) => {
    const swatch = document.createElement('div');
    swatch.className = 'preset-swatch';
    swatch.title = preset.name;

    // Use the small thumbnail canvas
    swatch.appendChild(preset.thumbCanvas);

    const label = document.createElement('span');
    label.className = 'preset-label';
    label.textContent = preset.name;
    swatch.appendChild(label);

    swatch.addEventListener('click', () => selectPreset(idx, swatch));
    presetGrid.appendChild(swatch);
  });
}

function resetTextureSmoothing() {
  settings.textureSmoothing = 0;
  textureSmoothingSlider.value = 0;
  textureSmoothingVal.value    = 0;
}

function selectPreset(idx, swatchEl) {
  document.querySelectorAll('.preset-swatch').forEach(s => s.classList.remove('active'));
  swatchEl.classList.add('active');
  activeMapEntry = PRESETS[idx];
  activeMapName.textContent = PRESETS[idx].name;
  resetTextureSmoothing();
  if (activeMapEntry.defaultScale != null) _applyScaleU(activeMapEntry.defaultScale);
  updatePreview();
}

// ── Event wiring ──────────────────────────────────────────────────────────────

function wireEvents() {
  // ── Language toggle ──
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const lang = btn.dataset.langCode;
      setLang(lang);
      document.querySelectorAll('.lang-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.langCode === lang));
      // Re-translate <option> elements (innerHTML won't reach these)
      document.querySelectorAll('select[id="mapping-mode"] option[data-i18n-opt]').forEach(opt => {
        opt.textContent = t(opt.dataset.i18nOpt);
      });
      // Refresh dynamic count text to current language
      if (currentGeometry) refreshExclusionOverlay();
    });
  });

  // ── Model loading ──
  stlFileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) handleModelFile(e.target.files[0]);
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
    const file = [...e.dataTransfer.files].find(f => /\.(stl|obj|3mf)$/i.test(f.name));
    if (file) handleModelFile(file);
  });

  // Allow clicking the drop zone to open the file picker (except on canvas)
  dropZone.addEventListener('click', (e) => {
    if (e.target === dropZone) stlFileInput.click();
  });

  // ── Custom texture upload ──
  textureInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      activeMapEntry = await loadCustomTexture(file);
      activeMapEntry.isCustom = true;
      activeMapName.textContent = file.name;
      document.querySelectorAll('.preset-swatch').forEach(s => s.classList.remove('active'));
      resetTextureSmoothing();
      updatePreview();
    } catch (err) {
      console.error('Failed to load texture:', err);
    }
  });

  // ── Settings ──
  mappingSelect.addEventListener('change', () => {
    settings.mappingMode = parseInt(mappingSelect.value, 10);
    capAngleRow.style.display = settings.mappingMode === 3 ? '' : 'none';
    updatePreview();
  });

  // Scale U — when lock is on, mirror to V
  const applyScaleU = (v) => _applyScaleU(v);
  scaleUSlider.addEventListener('input', () => applyScaleU(posToScale(parseFloat(scaleUSlider.value))));
  scaleUSlider.addEventListener('dblclick', () => applyScaleU(posToScale(parseFloat(scaleUSlider.defaultValue))));
  scaleUVal.addEventListener('change', () => applyScaleU(parseFloat(scaleUVal.value)));

  // Scale V — when lock is on, mirror to U
  const applyScaleV = (v) => {
    v = Math.max(0.05, Math.min(10, v));
    settings.scaleV = v;
    scaleVSlider.value = scaleToPos(v);
    scaleVVal.value = v;
    if (settings.lockScale) { settings.scaleU = v; scaleUSlider.value = scaleToPos(v); scaleUVal.value = v; }
    clearTimeout(previewDebounce); previewDebounce = setTimeout(updatePreview, 80);
  };
  scaleVSlider.addEventListener('input', () => applyScaleV(posToScale(parseFloat(scaleVSlider.value))));
  scaleVSlider.addEventListener('dblclick', () => applyScaleV(posToScale(parseFloat(scaleVSlider.defaultValue))));
  scaleVVal.addEventListener('change', () => applyScaleV(parseFloat(scaleVVal.value)));

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
  linkSlider(amplitudeSlider, amplitudeVal, v => { settings.amplitude = v; checkAmplitudeWarning(); return v.toFixed(2); });
  amplitudeVal.addEventListener('change', checkAmplitudeWarning);
  linkSlider(refineLenSlider, refineLenVal, v => { settings.refineLength  = v; return v.toFixed(2); }, false);
  linkSlider(maxTriSlider, maxTriVal, v => { settings.maxTriangles = v; return formatM(v); }, false);
  linkSlider(bottomAngleLimitSlider, bottomAngleLimitVal, v => { settings.bottomAngleLimit = v; return v; });
  linkSlider(topAngleLimitSlider,    topAngleLimitVal,    v => { settings.topAngleLimit    = v; return v; });
  linkSlider(seamBlendSlider,        seamBlendVal,        v => { settings.mappingBlend     = v; return v.toFixed(2); });
  linkSlider(seamBandWidthSlider,    seamBandWidthVal,    v => { settings.seamBandWidth    = v; return v.toFixed(2); });
  linkSlider(textureSmoothingSlider, textureSmoothingVal, v => { settings.textureSmoothing = v; return v.toFixed(1); });
  linkSlider(capAngleSlider,          capAngleVal,          v => { settings.capAngle         = v; return Math.round(v); });
  symmetricDispToggle.addEventListener('change', () => {
    settings.symmetricDisplacement = symmetricDispToggle.checked;
    updatePreview();
  });

  dispPreviewToggle.addEventListener('change', () => {
    toggleDisplacementPreview(dispPreviewToggle.checked);
  });

  // ── Place on Face ──
  placeOnFaceBtn.addEventListener('click', () => {
    togglePlaceOnFace(!placeOnFaceActive);
  });

  // ── License ──
  licenseLink.addEventListener('click', () => licenseOverlay.classList.remove('hidden'));
  licenseClose.addEventListener('click', () => licenseOverlay.classList.add('hidden'));
  licenseOverlay.addEventListener('click', (e) => {
    if (e.target === licenseOverlay) licenseOverlay.classList.add('hidden');
  });

  // ── Imprint & Privacy ──
  imprintLink.addEventListener('click', () => imprintOverlay.classList.remove('hidden'));
  imprintClose.addEventListener('click', () => imprintOverlay.classList.add('hidden'));
  imprintOverlay.addEventListener('click', (e) => {
    if (e.target === imprintOverlay) imprintOverlay.classList.add('hidden');
  });

  // ── Support banner dismiss ──
  document.getElementById('store-cta-dismiss').addEventListener('click', () => {
    document.getElementById('store-cta-wrapper').classList.add('store-cta-hidden');
  });

  // ── Export ──
  exportBtn.addEventListener('click', () => {
    if (sessionStorage.getItem('stlt-no-sponsor') === '1') {
      handleExport();
      return;
    }
    const overlay = document.getElementById('sponsor-overlay');
    const closeBtn = document.getElementById('sponsor-close');
    const storeLink = overlay.querySelector('.sponsor-link');
    overlay.classList.remove('hidden');

    const dismiss = () => {
      if (document.getElementById('sponsor-dont-show').checked) {
        sessionStorage.setItem('stlt-no-sponsor', '1');
      }
      overlay.classList.add('hidden');
      handleExport();
    };

    closeBtn.onclick = dismiss;
    // Also start processing when the user clicks through to the store
    storeLink.onclick = () => setTimeout(dismiss, 150);
  });

  // ── Wireframe ──
  wireframeToggle.addEventListener('change', () => setWireframe(wireframeToggle.checked));

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
    // Deactivate precision when switching away from circle mode
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

  canvas.addEventListener('mousemove', (e) => {
    if (placeOnFaceActive && currentGeometry) {
      updatePlaceOnFaceHover(e);
      return;
    }
    if (exclusionTool === 'brush' && brushIsRadius) {
      updateBrushCursor(e);
    }
    if (isPainting && exclusionTool === 'brush') {
      paintAt(e);
      return;
    }
    if (!isPainting && exclusionTool === 'brush' && currentGeometry) {
      updateBrushHover(e);
    }
    if (!isPainting && exclusionTool === 'bucket' && currentGeometry) {
      updateBucketHover(e);
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
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (placeOnFaceActive) togglePlaceOnFace(false);
      if (exclusionTool) setExclusionTool(null);
      licenseOverlay.classList.add('hidden');
      imprintOverlay.classList.add('hidden');
    }
  });
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

  // Deactivate place-on-face if an exclusion tool is being activated
  if (exclusionTool && placeOnFaceActive) togglePlaceOnFace(false);

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
  }
}

function _canvasNDC(e) {
  const rect = canvas.getBoundingClientRect();
  return new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width)  *  2 - 1,
    ((e.clientY - rect.top)  / rect.height) * -2 + 1,
  );
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

/** Test all triangles against a sphere and invoke cb(triIdx) for each hit. */
function forEachTriInSphere(hitPt, r2, cb) {
  const usePrecision = precisionMaskingEnabled && precisionGeometry;
  const geo = usePrecision ? precisionGeometry : currentGeometry;
  const centroids = usePrecision ? precisionCentroids : triangleCentroids;
  const boundRadii = usePrecision ? precisionBoundRadii : triangleBoundRadii;
  const pos = geo.attributes.position;
  const triCount = centroids.length / 3;
  const r = Math.sqrt(r2);
  for (let t = 0; t < triCount; t++) {
    // Quick reject: centroid distance > brush radius + triangle bounding radius
    const dx = centroids[t*3]   - hitPt.x;
    const dy = centroids[t*3+1] - hitPt.y;
    const dz = centroids[t*3+2] - hitPt.z;
    const bound = r + boundRadii[t];
    if (dx*dx + dy*dy + dz*dz > bound*bound) continue;
    // Precise sphere-triangle test
    const i = t * 3;
    const d2 = distSqPointToTri(
      hitPt.x, hitPt.y, hitPt.z,
      pos.getX(i), pos.getY(i), pos.getZ(i),
      pos.getX(i+1), pos.getY(i+1), pos.getZ(i+1),
      pos.getX(i+2), pos.getY(i+2), pos.getZ(i+2),
    );
    if (d2 <= r2) cb(t);
  }
}

function paintAt(e) {
  const mesh = getCurrentMesh();
  if (!mesh) return;
  _raycaster.setFromCamera(_canvasNDC(e), getCamera());
  const hits = _raycaster.intersectObject(mesh);
  const hit = getFrontFaceHit(hits, mesh);
  if (!hit) return;

  const usePrecision = precisionMaskingEnabled && precisionGeometry && precisionParentMap;

  if (usePrecision) {
    // Precision mode: store precision face indices for fine-grained selection
    if (brushIsRadius) {
      const r2 = brushRadius * brushRadius;
      forEachTriInSphere(hit.point, r2, t => {
        if (eraseMode) precisionExcludedFaces.delete(t); else precisionExcludedFaces.add(t);
      });
    } else {
      const precIdx = hit.faceIndex; // precision face index (mesh is precision geometry)
      if (eraseMode) precisionExcludedFaces.delete(precIdx); else precisionExcludedFaces.add(precIdx);
    }
  } else {
    // Normal mode: store original face indices
    let triIdx = hit.faceIndex;
    if (dispPreviewGeometry && mesh.geometry === dispPreviewGeometry && dispPreviewParentMap) {
      triIdx = dispPreviewParentMap[triIdx];
    }
    if (brushIsRadius) {
      const r2 = brushRadius * brushRadius;
      forEachTriInSphere(hit.point, r2, t => {
        if (eraseMode) excludedFaces.delete(t); else excludedFaces.add(t);
      });
    } else {
      if (eraseMode) excludedFaces.delete(triIdx); else excludedFaces.add(triIdx);
    }
  }

  refreshExclusionOverlay();
}

// ── Place on Face ─────────────────────────────────────────────────────────────

function togglePlaceOnFace(active) {
  placeOnFaceActive = active;
  placeOnFaceBtn.classList.toggle('active', active);

  if (active) {
    // Deactivate exclusion tool
    if (exclusionTool) setExclusionTool(null);
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
  checkAmplitudeWarning();

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
  precisionCentroids = null; precisionBoundRadii = null; precisionAdjacency = null;
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
  triangleCentroids = adjData.centroids; triangleBoundRadii = adjData.boundRadii;

  // Update edge length for new bounds
  const maxDim = Math.max(currentBounds.size.x, currentBounds.size.y, currentBounds.size.z);
  const defaultEdge = Math.max(0.05, Math.min(5.0, +(maxDim / 200).toFixed(2)));
  settings.refineLength = defaultEdge;
  refineLenSlider.value = defaultEdge;
  refineLenVal.value = defaultEdge;

  // Update mesh info
  const triCount = getTriangleCount(currentGeometry);
  const mb = ((currentGeometry.attributes.position.array.byteLength) / 1024 / 1024).toFixed(2);
  const sx = currentBounds.size.x.toFixed(2);
  const sy = currentBounds.size.y.toFixed(2);
  const sz = currentBounds.size.z.toFixed(2);
  meshInfo.textContent = t('ui.meshInfo', { n: triCount.toLocaleString(), mb, sx, sy, sz });

  exportBtn.disabled = (activeMapEntry === null);
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

function refreshExclusionOverlay() {
  if (!currentGeometry) return;

  // Choose which geometry and face set to build the overlay from
  const usePrecision = precisionMaskingEnabled && precisionGeometry;
  const overlayGeo = usePrecision ? precisionGeometry : currentGeometry;
  const overlayFaceSet = usePrecision ? precisionExcludedFaces : excludedFaces;

  if (selectionMode) {
    const maskGeo = buildExclusionOverlayGeo(overlayGeo, overlayFaceSet, true);
    setExclusionOverlay(maskGeo, 0x8ab4d4, 0.96);
  } else {
    setExclusionOverlay(buildExclusionOverlayGeo(overlayGeo, overlayFaceSet), 0xff6600);
  }
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
    forEachTriInSphere(hit.point, r2, t => hovered.add(t));
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

function linkSlider(slider, valInput, onChangeFn, livePreview = true) {
  const isSpan = valInput.tagName === 'SPAN';
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
      if (isNaN(raw)) { valInput.value = slider.value; return; }
      // Clamp to the input's own min/max (may be wider than the slider range)
      const inMin = parseFloat(valInput.min);
      const inMax = parseFloat(valInput.max);
      const clamped = (!isNaN(inMin) && !isNaN(inMax))
        ? Math.max(inMin, Math.min(inMax, raw))
        : raw;
      // Move slider thumb to nearest valid position (saturates at slider edges)
      slider.value = Math.max(parseFloat(slider.min), Math.min(parseFloat(slider.max), clamped));
      valInput.value = onChangeFn(clamped);
      if (livePreview) {
        clearTimeout(previewDebounce);
        previewDebounce = setTimeout(updatePreview, 80);
      }
    });
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
  triangleCentroids = adjData.centroids; triangleBoundRadii = adjData.boundRadii;

  settings.scaleU  = 0.5; scaleUSlider.value = scaleToPos(0.5); scaleUVal.value = 0.5;
  settings.scaleV  = 0.5; scaleVSlider.value = scaleToPos(0.5); scaleVVal.value = 0.5;
  settings.offsetU = 0; offsetUSlider.value = 0; offsetUVal.value = 0;
  settings.offsetV = 0; offsetVSlider.value = 0; offsetVVal.value = 0;
  triLimitWarning.classList.add('hidden');

  const maxDim = Math.max(currentBounds.size.x, currentBounds.size.y, currentBounds.size.z);
  const defaultEdge = Math.max(0.05, Math.min(5.0, +(maxDim / 200).toFixed(2)));
  settings.refineLength = defaultEdge;
  refineLenSlider.value = defaultEdge;
  refineLenVal.value = defaultEdge;

  const triCount = getTriangleCount(geo);
  const mb = ((geo.attributes.position.array.byteLength) / 1024 / 1024).toFixed(2);
  const sx = currentBounds.size.x.toFixed(2);
  const sy = currentBounds.size.y.toFixed(2);
  const sz = currentBounds.size.z.toFixed(2);
  meshInfo.textContent = t('ui.meshInfo', { n: triCount.toLocaleString(), mb, sx, sy, sz });

  exportBtn.disabled = (activeMapEntry === null);
  updatePreview();
}

async function handleModelFile(file) {
  try {
    const { geometry, bounds } = await loadModelFile(file);
    currentGeometry = geometry;
    currentBounds   = bounds;
    currentStlName  = file.name.replace(/\.(stl|obj|3mf)$/i, '');
    checkAmplitudeWarning();

    // Dispose old preview material and reset state for the new mesh
    if (previewMaterial) {
      previewMaterial.dispose();
      previewMaterial = null;
    }

    // Auto-select first preset on first load
    if (!activeMapEntry && PRESETS.length > 0) {
      activeMapEntry = PRESETS[0];
      activeMapName.textContent = PRESETS[0].name;
      const swatches = document.querySelectorAll('.preset-swatch');
      if (swatches.length > 0) swatches[0].classList.add('active');
    }
    mappingSelect.value = String(settings.mappingMode);
    capAngleRow.style.display = settings.mappingMode === 3 ? '' : 'none';

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
    precisionBoundRadii = null;
    precisionAdjacency  = null;
    precisionMaskingEnabled = false;
    precisionMaskingToggle.checked = false;
    precisionStatus.textContent = '';
    precisionOutdated.classList.add('hidden');
    precisionRefreshBtn.classList.add('hidden');
    precisionWarning.classList.add('hidden');
    precisionMaskingRow.classList.add('hidden');

    // Reset exclusion state for the new mesh
    excludedFaces     = new Set();
    precisionExcludedFaces = new Set();
    exclusionTool     = null;
    eraseMode         = false;
    isPainting        = false;
    if (placeOnFaceActive) togglePlaceOnFace(false);
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
    triangleCentroids = adjData.centroids; triangleBoundRadii = adjData.boundRadii;

    // Reset scale & offset sliders so scale=1 = one tile covers the full bounding box
    const resetVal = (slider, valEl, value) => {
      slider.value = value;
      valEl.value = value;
    };
    settings.scaleU  = 0.5; scaleUSlider.value = scaleToPos(0.5); scaleUVal.value = 0.5;
    settings.scaleV  = 0.5; scaleVSlider.value = scaleToPos(0.5); scaleVVal.value = 0.5;
    settings.offsetU = 0; resetVal(offsetUSlider, offsetUVal, 0);
    settings.offsetV = 0; resetVal(offsetVSlider, offsetVVal, 0);
    triLimitWarning.classList.add('hidden');

    // Default edge length = 1/200 of the largest bounding box dimension
    const maxDim = Math.max(bounds.size.x, bounds.size.y, bounds.size.z);
    const defaultEdge = Math.max(0.05, Math.min(5.0, +(maxDim / 200).toFixed(2)));
    settings.refineLength = defaultEdge;
    refineLenSlider.value = defaultEdge;
    refineLenVal.value = defaultEdge;

    const triCount = getTriangleCount(geometry);
    const mb = ((geometry.attributes.position.array.byteLength) / 1024 / 1024).toFixed(2);
    const sx = bounds.size.x.toFixed(2);
    const sy = bounds.size.y.toFixed(2);
    const sz = bounds.size.z.toFixed(2);
    meshInfo.textContent = t('ui.meshInfo', { n: triCount.toLocaleString(), mb, sx, sy, sz });

    exportBtn.disabled = (activeMapEntry === null);
    updatePreview();
  } catch (err) {
    console.error('Failed to load model:', err);
    alert(t('alerts.loadFailed', { msg: err.message }));
  }
}

// ── Live preview ──────────────────────────────────────────────────────────────

function checkAmplitudeWarning() {
  if (!currentBounds) return;
  const minDim = Math.min(currentBounds.size.x, currentBounds.size.y, currentBounds.size.z);
  const danger = Math.abs(settings.amplitude) > minDim * 0.1;
  amplitudeWarning.classList.toggle('hidden', !danger);
  amplitudeSlider.classList.toggle('amp-danger', danger);
  amplitudeVal.classList.toggle('amp-danger', danger);
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
  const maskArr = new Float32Array(posCount);

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

  geometry.setAttribute('faceMask', new THREE.Float32BufferAttribute(maskArr, 1));

  // Ensure faceNormal attribute exists (needed by shader for angle masking).
  // For the original geometry normal == faceNormal; for subdivided geometry
  // addFaceNormals() is called after subdivision, but guard here in case the
  // attribute is still missing.
  if (!geometry.attributes.faceNormal) {
    addFaceNormals(geometry);
  }
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
  if (!activeMapEntry || settings.textureSmoothing === 0) return activeMapEntry;
  const { fullCanvas, width, height } = activeMapEntry;
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
  return { ...activeMapEntry, imageData, texture };
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
    return;
  }

  // Choose geometry: subdivided preview (with smoothNormal attribute) or original
  const activeGeo = (settings.useDisplacement && dispPreviewGeometry)
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

  exportBtn.disabled = false;
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

  const QUANT = 1e4;
  const key = (x, y, z) =>
    `${Math.round(x * QUANT)}_${Math.round(y * QUANT)}_${Math.round(z * QUANT)}`;

  // Accumulate area-weighted buffer normals per unique position.
  // The subdivision pipeline splits indexed vertices at sharp dihedral edges
  // (>30°) so the interpolated buffer normals are smooth across soft edges
  // (cylinder, sphere) but sharp across hard edges (cube).  Using these buffer
  // normals instead of geometric face normals eliminates visible faceting steps
  // on round surfaces while still preserving hard edges.
  const nrmMap = new Map();
  const nrm = geometry.attributes.normal.array;
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
      const nx = nrm[vi * 3], ny = nrm[vi * 3 + 1], nz = nrm[vi * 3 + 2];
      const k = key(pos[vi * 3], pos[vi * 3 + 1], pos[vi * 3 + 2]);
      const prev = nrmMap.get(k);
      if (prev) {
        prev[0] += nx * area;
        prev[1] += ny * area;
        prev[2] += nz * area;
      } else {
        nrmMap.set(k, [nx * area, ny * area, nz * area]);
      }
    }
  }

  // Normalize accumulated normals
  for (const n of nrmMap.values()) {
    const len = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
    if (len > 1e-12) { n[0] /= len; n[1] /= len; n[2] /= len; }
  }

  // Write smoothNormal attribute
  const sn = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const k = key(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    const n = nrmMap.get(k);
    if (n) { sn[i * 3] = n[0]; sn[i * 3 + 1] = n[1]; sn[i * 3 + 2] = n[2]; }
    else   { sn[i * 3] = 0; sn[i * 3 + 1] = 0; sn[i * 3 + 2] = 1; }
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
    triangleAdjacency  = precisionAdjacency;
    triangleCentroids  = precisionCentroids;
    triangleBoundRadii = precisionBoundRadii;

    // Promote precision excluded faces to the base set
    excludedFaces = precisionExcludedFaces;

    // Update mesh info display
    const triCount = getTriangleCount(currentGeometry);
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
  precisionBoundRadii = null;
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

  precisionBusy = true;
  precisionStatus.textContent = t('precision.refining');
  precisionOutdated.classList.add('hidden');
  precisionRefreshBtn.classList.add('hidden');
  precisionWarning.classList.add('hidden');

  try {
    await yieldFrame();

    const { geometry: subdivided, safetyCapHit, faceParentId } = await subdivide(
      currentGeometry, targetEdge, null, null, { fast: true }
    );

    // Dispose previous precision geometry if any
    if (precisionGeometry) precisionGeometry.dispose();
    precisionGeometry  = subdivided;
    precisionParentMap = faceParentId;
    precisionEdgeLength = targetEdge;

    // Build adjacency data for the refined mesh
    const adjData = buildAdjacency(precisionGeometry);
    precisionAdjacency  = adjData.adjacency;
    precisionCentroids  = adjData.centroids;
    precisionBoundRadii = adjData.boundRadii;

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
  dispPreviewBusy = true;

  try {
    // Choose a preview edge length: coarser than export for performance.
    // Target ~maxDim/80 so a 50 mm cube gets ~0.6 mm edges → ~100 k triangles.
    const maxDim = Math.max(currentBounds.size.x, currentBounds.size.y, currentBounds.size.z);
    const previewEdge = Math.max(0.1, maxDim / 80);

    await yieldFrame();

    const { geometry: subdivided, faceParentId } = await subdivide(
      currentGeometry, previewEdge, null, null, { fast: true }
    );

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

async function handleExport() {
  if (!currentGeometry || !activeMapEntry || isExporting) return;
  isExporting = true;
  exportBtn.classList.add('busy');
  exportProgress.classList.remove('hidden');

  // If precision masking is active, bake the refined mesh before exporting
  if (precisionMaskingEnabled) {
    deactivatePrecisionMasking();
  }

  try {
    setProgress(0.02, t('progress.subdividing'));
    await yieldFrame();

    // Build per-vertex exclusion weights combining user-painted exclusion + angle masking.
    // Faces masked by top/bottom angle limits are treated the same as user-excluded faces
    // so subdivision skips their interior edges too, saving triangles where no
    // displacement will be applied.
    const hasAngleMask = settings.bottomAngleLimit > 0 || settings.topAngleLimit > 0;
    const faceWeights = (excludedFaces.size > 0 || selectionMode || hasAngleMask)
      ? buildCombinedFaceWeights(currentGeometry, excludedFaces, selectionMode, settings)
      : null;

    const { geometry: subdivided, safetyCapHit } = await subdivide(
      currentGeometry, settings.refineLength,
      (p, triCount, longestEdge) => {
        const label = triCount != null
          ? t('progress.refining', { cur: triCount.toLocaleString(), edge: longestEdge.toFixed(2) })
          : t('progress.subdividing');
        setProgress(0.02 + p * 0.35, label);
      },
      faceWeights
    );

    const subTriCount = subdivided.attributes.position.count / 3;
    setProgress(0.38, t('progress.applyingDisplacement', { n: subTriCount.toLocaleString() }));

    const exportEntry = getEffectiveMapEntry();
    const displaced = await runAsync(() =>
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

    const dispTriCount = displaced.attributes.position.count / 3;
    const needsDecimation = dispTriCount > settings.maxTriangles;
    triLimitWarning.classList.toggle('hidden', !safetyCapHit);
    // Re-apply translated warning text in case language changed since last export
    triLimitWarning.textContent = t('warnings.safetyCapHit');

    let finalGeometry = displaced;
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
          }
        )
      );
    }

    // Flat-bottom clamp: when bottom faces are masked (bottomAngleLimit > 0),
    // any vertex that ended up below the original model's bottom layer gets
    // snapped back up to that Z. Only the Z-value is changed.
    if (settings.bottomAngleLimit > 0) {
      const bottomZ = currentBounds.min.z;
      const posArr  = finalGeometry.attributes.position.array;
      for (let i = 2; i < posArr.length; i += 3) {
        if (posArr[i] < bottomZ) posArr[i] = bottomZ;
      }
      finalGeometry.attributes.position.needsUpdate = true;
      // Recompute normals via cross product so they always match winding order.
      const pa = finalGeometry.attributes.position.array;
      const na = finalGeometry.attributes.normal ? finalGeometry.attributes.normal.array : new Float32Array(pa.length);
      for (let i = 0; i < pa.length; i += 9) {
        const ux = pa[i+3]-pa[i],   uy = pa[i+4]-pa[i+1], uz = pa[i+5]-pa[i+2];
        const vx = pa[i+6]-pa[i],   vy = pa[i+7]-pa[i+1], vz = pa[i+8]-pa[i+2];
        const nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
        const len = Math.sqrt(nx*nx+ny*ny+nz*nz) || 1;
        na[i]   = na[i+3] = na[i+6] = nx/len;
        na[i+1] = na[i+4] = na[i+7] = ny/len;
        na[i+2] = na[i+5] = na[i+8] = nz/len;
      }
      if (!finalGeometry.attributes.normal) finalGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(na, 3));
      else finalGeometry.attributes.normal.needsUpdate = true;
    }

    setProgress(0.97, t('progress.writingStl'));
    await yieldFrame();

    const texLabel = activeMapEntry.isCustom ? 'custom' : activeMapEntry.name.replace(/\s+/g, '-');
    const ampLabel = settings.amplitude.toFixed(2).replace('.', 'p');
    const exportName = `${currentStlName}_${texLabel}_amp${ampLabel}.stl`;
    exportSTL(finalGeometry, exportName);

    setProgress(1.0, t('progress.done'));
    setTimeout(() => {
      exportProgress.classList.add('hidden');
      setProgress(0, '');
    }, 1500);
  } catch (err) {
    console.error('Export failed:', err);
    alert(t('alerts.exportFailed', { msg: err.message }));
    exportProgress.classList.add('hidden');
  } finally {
    isExporting = false;
    exportBtn.classList.remove('busy');
  }
}

function setProgress(fraction, label) {
  const pct = Math.round(fraction * 100);
  exportProgBar.style.width = `${pct}%`;
  exportProgPct.textContent = `${pct}%`;
  exportProgLbl.textContent = label;
}

/** Yield to the browser event loop for one frame, then run fn. */
function runAsync(fn) {
  return new Promise((resolve, reject) => {
    requestAnimationFrame(() => {
      try { resolve(fn()); }
      catch (e) { reject(e); }
    });
  });
}

function yieldFrame() {
  return new Promise(r => requestAnimationFrame(r));
}
