# Handoff: BumpMesh Color Export Feature

**Reviewer:** GPT-5.5 Codex
**Author:** Claude Opus 4.7 (with parallel general-purpose agents for the four work units)
**Status:** Functional end-to-end. Stress-tested. Cache-bust query strings stripped. Codex review found and fixed an additional quantizer edge case plus color-image import/UI cleanup.
**Repo:** `/Users/eric/Documents/GitHub/stlTexturizer`
**Upstream:** `CNCKitchen/stlTexturizer` (the user's intent is to upstream this).
**Branch:** `feat/color-export-3mf`.

---

## 1. What this feature does

Adds full per-triangle color export to the 3MF output path of BumpMesh / stlTexturizer. STL output is unchanged (geometry only).

Three composable color sources, layered in this precedence:

1. **Excluded faces** (angle mask + exclusion paint) → `settings.colorBaseColor` (default `#ffffff`).
2. **Manual color paint override** → user-painted RGB per original face.
3. **Auto color source** (one of):
   - **Gradient mapping**: sample the *displacement texture* (greyscale) at each vertex's UV using the same UV pipeline as displacement, then look up that grey value in a user-defined N-stop gradient. This is the killer feature — wood grain auto-darkens valleys, brick auto-grouts, etc.
   - **Color image**: sample a user-uploaded RGB image at each vertex's UV (same UV pipeline).
   - **None**: only base + manual paint.

Per-triangle colors are quantized to ≤32 entries via median cut and emitted as a standard 3MF Materials Extension `<m:colorgroup>` with `pid="3" p1="<idx>"` per triangle. This is what OrcaSlicer / Bambu Studio / PrusaSlicer all reliably consume; modern slicer "filament blending" makes the quantization visually smooth at print time.

Backward compat: when the master toggle is OFF, the 3MF XML is byte-identical to today's geometry-only output.

## 2. Scope locked

**In scope:**
- N-stop gradient editor widget (custom, no deps)
- Color image upload (separate from displacement texture)
- Manual color paint (extends the existing exclusion-paint UX with a strategy callback)
- Per-triangle quantized colorgroup 3MF emission
- Persistence in `.bumpmesh` (settings + paint map + color.png)
- Undo/redo for all color settings + paint strokes
- i18n keys (English authored; other locales fall back to English — flag for native translation)

**Explicitly deferred:**
- **Live preview tinting.** The plan deliberately does not tint the live displacement preview with the chosen colors. Adding it is a small follow-up (~30 lines on top of the per-vertex `color` attribute the bake already writes — enable `vertexColors: true` on the preview material and add a `mix(baseColor, vColor, mask)` line in the fragment shader). Documented in the plan file's "Open risks" section.

## 3. Architecture overview

The export pipeline (in order):

```
currentGeometry (loaded mesh)
    │
    ├── buildCombinedFaceWeights(geo, excludedFaces, selectionMode, settings)
    │       Per-vertex weights (1.0 = excluded by user paint OR angle mask)
    │       Existing function in main.js, unchanged.
    │
    ├── subdivide(geo, refineLength, onProgress, faceWeights)
    │       Returns { geometry, safetyCapHit, faceParentId }
    │       faceParentId: subdivided face index → original face index
    │       Sets per-vertex `excludeWeight` BufferAttribute on output.
    │       Existing module, unchanged.
    │
    ├── applyDisplacement(subdivided, dispImage, w, h, settings, bounds, onProgress)
    │       Returns displaced geometry.
    │       FIX during stress test: now also forwards `excludeWeight` to its
    │       output (was previously stripped). See bug #1 below.
    │
    ├── applyColors(displaced, faceParentId, dispImg, dispW, dispH, colorImg,
    │              colorW, colorH, settings, bounds, paintedFaceColors,
    │              excludedFaces, selectionMode)
    │       Writes per-vertex Float32×3 `color` attribute on `displaced`.
    │       New module: js/colorBake.js
    │       Mirrors displacement.js's UV pipeline exactly so colors line up
    │       with displacement texels. Composition order applied per-face:
    │         - faceExcluded[i] (avg of 3 vertex excludeWeights > 0.99) → base color
    │         - paintedFaceColors.has(origFace[i])                      → packed RGB
    │         - autoSource gradient                                      → sampleGradient(grey)
    │         - autoSource image                                         → sampleBilinearRGB
    │         - else                                                     → base color
    │
    ├── decimate(displaced, maxTri, onProgress, { preserveColor })
    │       Threads `color` Float32×3 attribute through QEM edge collapses.
    │       Modified module: js/decimation.js (+56 LOC, gated on opts.preserveColor).
    │       Backward compat: when preserveColor is false, byte-identical to before.
    │
    ├── medianCut(triRGB, maxColors=32)
    │       Returns { palette: Uint8Array(N*3), indices: Uint16Array(triCount) }
    │       New module: js/quantize.js (~160 LOC).
    │       FIX during stress test: bucket selection switched from
    │       largest-population to range × log(pop+1). See bug #3 below.
    │
    └── export3MF(finalGeometry, filename, { palette, triPaletteIndices })
            New options arg. When absent → byte-identical to today's output.
            When present → adds `xmlns:m`, `requiredextensions="m"`,
            `<m:colorgroup id="3">...</m:colorgroup>`, and `pid="3" p1="..."`
            per triangle.
            Modified module: js/exporter.js (+~60 LOC, additive only).
```

UI state lives in:
- `settings` object in `js/main.js` (5 new keys)
- Top-level let-bindings in `js/main.js` (`paintedFaceColors: Map`, `_lastColorMap`, `colorPaintActive`, etc.)
- `<section id="color-section">` in `index.html`

State plumbing (all in `js/main.js`):
- `PERSISTED_KEYS` — controls sessionStorage + .bumpmesh inclusion
- `getSettingsSnapshot` / `applySettingsSnapshot` — snapshot ⇄ live state
- `_collectCurrentMask` / `_restoreMask` — paint map serialization (extended to include `coloredFaces`)
- `_captureUndoSnapshot` / `_undoSnapshotsEqual` — undo capture (extended to include color state)
- `wireColorPaintUI()` — newly added, runs once during `wireEvents()`. Wires all color UI controls + the colorPaint factory.

## 4. Files changed (categorized)

### New files (Unit deliverables)
- `js/colorBake.js` (~470 LOC) — `applyColors(...)`. Mirrors displacement.js Pass 1+2 structure exactly.
- `js/quantize.js` (~165 LOC) — `medianCut(triRGBs, maxColors)`. Range-weighted bucket selection.
- `js/gradientEditor.js` (~385 LOC) — `class GradientEditor` + `wireColorSectionVisibility()`. Self-contained widget.
- `js/colorPaint.js` (~250 LOC) — `setColorPaintHandlers(hooks) → { startPaint, paintAt, endPaint, isPainting }`.

### Modified existing files
- `js/main.js` (~5340 LOC, +~250 LOC) — settings, persistence, undo, wireColorPaintUI, handleExport integration. **All main.js edits orchestrator-owned to avoid agent collisions.**
- `js/displacement.js` (+1 line, in stress-test fix) — forward `excludeWeight` to output.
- `js/decimation.js` (+~56 LOC) — thread `color` Float32×3 through QEM edge collapses, gated on `opts.preserveColor`.
- `js/exporter.js` (+~60 LOC) — extend `export3MF` with optional `{ palette, triPaletteIndices }` opts.
- `index.html` (+~83 LOC) — `<section id="color-section">`.
- `style.css` (+~178 LOC) — gradient bar, stop handles, color section panel.
- `js/i18n/en.js` (+18 keys) — color.heading, color.enable, color.sourceNone/Gradient/Image, etc.
- `js/i18n/{de,fr,it,es,pt,ja}.js` (+18 keys each, English fallback values).

### Untouched
- `js/subdivision.js` — already produced `excludeWeight` and `faceParentId`; we just consume them.
- `js/exclusion.js` — paint machinery reused via callbacks; no internal changes.
- `js/mapping.js`, `js/previewMaterial.js`, `js/stlLoader.js`, `js/presetTextures.js`, `js/meshValidation.js`, `js/viewer.js` — untouched.

## 5. Critical design decisions

### Why median-cut, and why range-weighted bucket selection
Median-cut is implementable in ~80 LOC without iteration loops, gives perceptually balanced palettes for the smooth gradients that dominate the use case, and runs sub-100ms for 250k triangles.

The standard "split by largest population" variant equalizes bucket sizes, which **dilutes outlier clusters into nearby dominant clusters**. We hit this in stress test: 1022 angle-masked-bottom-face white triangles got assigned to a bucket with ~19k wood-tone neighbors and the bucket mean came out wood, not white. Every palette entry had exactly 656382/32 = 20512 triangles — telltale sign of population equalization.

Switching to `range × log(pop+1)` bucket selection prioritizes buckets that contain outlier clusters while still keeping smooth gradients smooth. Codex review added a second guard: after sorting a bucket by its widest channel, `js/quantize.js` now splits at a large channel gap when one exists, falling back to a median-ish split for smooth ramps. This prevents small but visually important clusters from being averaged away for many iterations.

### Why per-face exclusion threshold (not per-vertex)
The first pass of colorBake checked `excludeWeight >= 0.99` per-vertex. This failed at boundary corners on the cube's bottom face: subdivision dedups corner vertex weights to either the side-face copy (w=0) or the bottom-face copy (w=1) depending on iteration order, so partial-weight subdivided vertices fail the per-vertex check.

Switched to per-face: `(ew[f*3] + ew[f*3+1] + ew[f*3+2]) / 3 > 0.99`. This matches `displacement.js`'s own exclusion semantics (line 140) exactly, so colorBake and displacement agree on which faces are excluded.

### Why a separate post-displacement color bake (not inline with displacement)
Decouples color settings from displacement work: changing a gradient stop or paint stroke does not invalidate the cached `displaced` geometry in any future preview optimization. The bake runs on `displaced` (which has 1:1 vertex parity with `subdivided`, so `faceParentId` from subdivision still indexes it correctly).

### Why range-based 3MF colorgroup over per-vertex color
Per-vertex color is a non-standard 3MF extension. Slicers (Bambu/Orca/Prusa) all consume the standard `<m:colorgroup>` + per-triangle `pid`/`p1`. Quantization to ≤32 entries gives a manageable palette size; modern slicer filament-blending makes the quantization visually smooth at print time.

### Why color-image lives in `_lastColorMap` (top-level let), not `settings`
`.bumpmesh` ships the color image as a separate `color.png` zip entry (mirroring `texture.png` at `js/main.js:4749`). Embedding it as a data URL in `settings` would blow the ~5MB sessionStorage quota for any non-trivial image. Top-level `_lastColorMap` is a runtime cache; persistence flows through `.bumpmesh` zip directly.

## 6. Bugs found and fixed during stress test

### Bug #1: `excludeWeight` stripped by displacement
**Symptom:** Angle-masked bottom face on a default cube exported with wood-tone gradient instead of base white.

**Cause:** `js/displacement.js` constructed its output `BufferGeometry` with only `position` and `normal` attributes. The `excludeWeight` attribute set by subdivision was dropped. `applyColors` running on the displaced geometry never saw the exclusion data.

**Fix:** `js/displacement.js` end of `applyDisplacement` (after line 458):
```js
if (ewAttr) out.setAttribute('excludeWeight', new THREE.BufferAttribute(ewAttr.array, 1));
```
Underlying typed array is shared with the input (input is disposed after applyDisplacement returns; THREE.BufferGeometry.dispose() doesn't free the JS-side typed array, only the GPU-side WebGL buffer, so this is safe).

### Bug #2: Per-vertex exclusion check missed boundary triangles
**Symptom:** After Bug #1 fix, ewGE099 (count of vertices with weight ≥ 0.99) was 3066 — but the bottom face has 3070 tris × 3 verts = 9210 vertices. Only 33% of bottom-face vertices passed the per-vertex check; 0 triangles came out white.

**Cause:** Subdivision dedups corner vertices. A cube corner participates in 3 face-corner copies in the non-indexed mesh. After subdivision, the corner has ONE canonical weight — either 0 (taken from a side-face copy) or 1 (from the bottom-face copy). Bottom-face triangles whose corners got the side-face value have at most 1 vertex with weight=1, failing the per-vertex `>= 0.99` check.

**Fix:** `js/colorBake.js` Pass 3 (around line 280): precompute a per-face flag = `(avg of 3 vertex weights > 0.99)`, then check `faceExcluded[subdivFaceIdx]` instead of per-vertex. This matches `js/displacement.js:140` exactly.

### Bug #3: Quantization equalized bucket populations and lost outliers
**Symptom:** 1022 white triangles correctly written to the geometry's `color` attribute, but the exported palette had no white entries. Every palette entry had exactly 20512 triangles (656382 / 32).

**Cause:** `js/quantize.js` median-cut split the bucket with the largest population. With 1022 whites in a population of 656k, the white cluster never landed in its own bucket — it always got grouped with neighbors, and the bucket mean came out as the dominant neighbor color.

**Fix:** `js/quantize.js` — switch bucket selection to `range × log(pop+1)`, and split at a large sorted-channel gap when one exists. Range prioritizes outlier-containing buckets; log-pop prevents tiny buckets from monopolizing; gap-aware splitting isolates the outlier cluster instead of repeatedly bisecting the dominant population.

**Verification:** With all three fixes, a default cube exported with wood gradient + one painted face produces a palette with 3 white entries (angle-masked bottom), 8 magenta entries (painted face — duplicated due to decimation dedup smearing, see "Known caveats" below), and 21 wood entries (the gradient). Bottom-face triangle count: 3070 total, 1022 of which are exactly `#FFFFFF`, the remaining 2048 are wood tones at the smooth mask boundary (expected behavior, matches displacement's smooth boundary).

## 7. Known caveats and limitations

### Decimation dedup smear at color boundaries
`js/decimation.js` `buildIndexed` dedups vertices by quantized position and averages their color attribute components. At HARD color discontinuities (e.g. painted face adjacent to gradient face), this smears one row of vertices across the seam. Visual effect: a thin transition band of intermediate colors at paint boundaries.

In stress test, painting one face magenta produced 8 distinct near-magenta palette entries (instead of 1) due to this smearing. Slicer filament-blending interprets these as transitional colors and prints fine, but the palette has slight redundancy.

**Possible improvement (not done):** carry an exclusion-flag-like attribute through decimation alongside color, and skip color averaging on dedup hits when the flag differs. Out of scope for v1.

### Paint mode + precision masking are mutually exclusive
`wireColorPaintUI` deactivates precision masking when color paint is activated (`js/main.js:1879-1888`). Reason: `paintedFaceColors` is keyed on **original** face indices (so it survives subdivision), but precision paint stores **subdivided** indices. Without a remap, mixing the two produces wrong results.

### Live preview deferred
Color preview in the live displacement preview shader is not implemented. Painted faces tint the existing exclusion overlay (orange) for click feedback, but the user's chosen color does not appear in the live preview. Documented in the plan as a planned follow-up.

### Cache-bust query strings removed
The temporary `?v=10` query strings were stripped from `js/main.js` after stress testing. `rg "\\?v="` now only finds historical mentions in this handoff.

### i18n: non-English locales fall back to English
All 18 new keys exist in en.js with proper text. The other 6 locale files (de, fr, it, es, pt, ja) have the same keys with English values. CNCKitchen typically lands the feature first then crowdsources translations.

## 8. How to verify

Run the local server already started by the user (Python HTTP on :8765) and visit `http://localhost:8765/?fresh=1` (or any new query string to defeat the module cache).

### Smoke
1. Color section appears in the right sidebar with master toggle, source radio, gradient editor, color image upload, paint controls.
2. Master toggle OFF → 3MF export bytes match today's output (`diff` two unzipped models).
3. Master toggle ON, source = None → 3MF includes a single white colorgroup entry (or whatever base color is); all triangles point at it.
4. Master toggle ON, source = Gradient, edit gradient stops → palette reflects gradient.
5. Master toggle ON, source = Image, upload a 4-quadrant RGB image → palette contains entries representative of all 4 quadrant colors.

### Stress
6. Default settings + cube STL: bottom face triangles (z near -10) come out as the base color, not gradient values. Verify by inspecting the unzipped 3MF.
7. Paint one face manually with a vivid color, export → that color appears in the palette and on triangles in the painted region.
8. Multiple consecutive exports without reloading the page → no leaks, no errors.
9. Cylindrical mapping mode + gradient → gradient sampling follows the cylindrical UV pipeline.
10. .bumpmesh save → reload page → import → all color settings + painted faces + color image restored bit-exactly.
11. Make 3 settings changes, Ctrl+Z three times → all reverted in order.
12. Reset settings → color state cleared (gradient back to default 2-stop greyscale, paint map empty, image cleared).

### Adversarial
13. Set gradient to 1 stop only → editor auto-pads to 2 stops (defensive normalize).
14. Paint a face, then drag the gradient over it → painted color wins (manual paint precedence is correct).
15. Toggle source from Gradient to Image with no image uploaded → falls through to base color (no errors).
16. Click "Export STL" with color toggle ON → STL is geometry only (no color metadata bleed). 656k tris × 50 bytes/tri + 84-byte header = exact expected size.

### Slicer interop (needs human)
17. Open a colored 3MF in OrcaSlicer (or Bambu Studio, or PrusaSlicer 2.8+). Per-triangle colors should display in the filament/painting view; main 3D viewport may render flat-grey by default in some slicers — this is slicer behavior, not a file issue.

## 9. Suggested review focus

Priority order for what to examine carefully:

1. **`js/colorBake.js`** — UV computation must mirror `js/displacement.js` exactly. Compare line-by-line. Any drift produces miscoloration that lines up offset from displacement.
2. **`js/decimation.js`** color threading (lines ~165-173 in collapse loop, ~574-635 in `buildIndexed`, ~640-680 in `buildOutput`). Backward compat with `opts.preserveColor=false` is essential — the existing geometry-only export must not regress.
3. **`js/main.js` `handleExport`** integration glue (around the `subdivide()` call site and the new `applyColors`/`decimate`/`export3MF` calls). The `format === '3mf' && settings.colorExportEnabled` gating must be airtight; STL exports must never trigger color bake.
4. **`js/quantize.js`** range-weighted bucket selection. Verify edge cases: empty input, all-same-color input, fewer than maxColors distinct colors.
5. **`js/exporter.js`** XML emission. The geometry-only path must be byte-for-byte identical to the previous version when no color is provided.
6. **`js/colorPaint.js`** — the paint-state persistence and undo flow. Particularly: after a paint stroke, `_scheduleUndoCapture` runs, and `_collectCurrentMask` must include `coloredFaces`. Verify in `js/main.js:_collectCurrentMask` (around line 4670) and `_undoSnapshotsEqual` (around line 4815).
7. **`js/gradientEditor.js`** — defensive `setStops` normalization (clamps positions, enforces ≥2 stops). Test edge cases: empty array, single stop, unsorted stops, stops with positions outside [0,1], stops with malformed colors.
8. **i18n**: confirm the 18 new keys exist in `js/i18n/en.js` and are referenced by `data-i18n` attributes in `index.html` (search index.html for `data-i18n="color.`).

## 10. Reproduction recipes

All run inside a browser tab at `localhost:8765`. The `?fresh=N` query bumps the document URL so module imports re-fetch.

### Build a synthetic cube STL programmatically
```js
function buildCubeSTL(size=20) {
  const s = size / 2;
  const tris = [
    [-s,-s,-s,-s,s,-s,-s,s,s,-1,0,0],[-s,-s,-s,-s,s,s,-s,-s,s,-1,0,0],
    [s,-s,-s,s,-s,s,s,s,s,1,0,0],[s,-s,-s,s,s,s,s,s,-s,1,0,0],
    [-s,-s,-s,s,-s,-s,s,-s,s,0,-1,0],[-s,-s,-s,s,-s,s,-s,-s,s,0,-1,0],
    [-s,s,-s,-s,s,s,s,s,s,0,1,0],[-s,s,-s,s,s,s,s,s,-s,0,1,0],
    [-s,-s,-s,-s,s,-s,s,s,-s,0,0,-1],[-s,-s,-s,s,s,-s,s,-s,-s,0,0,-1],
    [-s,-s,s,s,-s,s,s,s,s,0,0,1],[-s,-s,s,s,s,s,-s,s,s,0,0,1]
  ];
  const buf = new ArrayBuffer(84 + 50 * tris.length);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  for (let i = 0; i < tris.length; i++) {
    const t = tris[i], off = 84 + i * 50;
    dv.setFloat32(off, t[9], true); dv.setFloat32(off+4, t[10], true); dv.setFloat32(off+8, t[11], true);
    for (let v = 0; v < 3; v++) {
      dv.setFloat32(off + 12 + v*12, t[v*3], true);
      dv.setFloat32(off + 12 + v*12 + 4, t[v*3+1], true);
      dv.setFloat32(off + 12 + v*12 + 8, t[v*3+2], true);
    }
  }
  return new File([buf], 'cube.stl');
}
const dt = new DataTransfer();
dt.items.add(buildCubeSTL());
const inp = document.getElementById('stl-file-input');
inp.files = dt.files;
inp.dispatchEvent(new Event('change', { bubbles: true }));
```

### Programmatically set gradient and trigger callback
The gradient editor's `setStops()` is "external apply" and intentionally does NOT fire onChange (avoids feedback loops with the orchestrator's settings reflection). To propagate a programmatic change to settings, invoke the registered callback explicitly:
```js
const ge = window._gradientEditor;
ge.setStops([{pos:0,color:'#3a1f0e'},{pos:1,color:'#f4d99e'}]);
ge._onChange(ge.getStops());  // private property; orchestrator's callback
```

Real user interactions (pointer events on stops, clicks on the bar) call the editor's internal `_emitChange()`, which DOES fire onChange.

### Capture an export blob without download dialog
```js
sessionStorage.setItem('stlt-no-sponsor', '1');  // skip the sponsor overlay
window.__capturedBlobs = [];
const _orig = URL.createObjectURL;
URL.createObjectURL = function(b){ window.__capturedBlobs.push(b); return _orig(b); };
document.getElementById('export-3mf-btn').click();
// Wait ~6 seconds for subdivide → displace → bake → quantize → write.
// Then: const blob = window.__capturedBlobs[window.__capturedBlobs.length - 1];
```

### Inspect the exported 3MF's colorgroup
```js
const blob = window.__capturedBlobs[window.__capturedBlobs.length - 1];
const ab = await blob.arrayBuffer();
const fflate = await import('fflate');
const unz = fflate.unzipSync(new Uint8Array(ab));
const xml = new TextDecoder().decode(unz['3D/3dmodel.model']);
const palette = [...xml.matchAll(/<m:color color="(#[0-9A-Fa-f]{8})"\/>/g)].map(m => m[1]);
const counts = new Array(palette.length).fill(0);
for (const m of xml.matchAll(/p1="(\d+)"/g)) counts[+m[1]]++;
console.log({ paletteSize: palette.length, palette, counts });
```

## 11. Things to actively try to break

If you want to find more bugs, attack these:

- **High-poly mesh + tight maxTriangles** (force aggressive decimation) → does the color attribute survive cleanly? Hint: dedup-time averaging may smear color boundaries. The smearing is acknowledged in `js/decimation.js` Unit B's notes; quantify how bad it gets.
- **Cubic mapping mode (mappingMode=6)** + gradient → the cubic UV pipeline in colorBake.js is the most complex code path; verify it agrees with displacement.js's cubic path (around `js/displacement.js:317-367`).
- **Boundary falloff > 0** + color export → does the falloff smoothing affect color the way it affects displacement? colorBake doesn't currently consult `falloffArr`. Probably fine for v1 (color and displacement diverge only at the soft boundary band, by design — colors are not faded at boundaries), but worth confirming with the user that this matches expectation.
- **Symmetric displacement + gradient** → colorBake doesn't reach into symmetric displacement logic, but the displacement texel value is what drives the gradient lookup. Verify gradient looks right when symmetric is on (50% grey = no displacement).
- **3MF re-import** of a colored 3MF → does BumpMesh's own importer cope, or does it choke on the `xmlns:m`? (Probably fine; the importer ignores unknown attributes. But test it.)
- **Very dense paint** (paint many faces with many different colors) → does median-cut produce a sensible palette, or does it produce 32 buckets that all look like averages?
- **i18n** — switch to German/French and verify the section labels, tooltips, and progress messages render with English fallback (no missing-key crashes).

## 12. Status of TODOs to close out

Before merging the upstream PR, do these in order:

1. **Run a fresh full pipeline end-to-end** in a freshly opened Chrome window (no cache) to confirm the import paths still resolve.
2. **Confirm the README's feature list** doesn't already claim "color export" in a way that conflicts with this PR's claims; update if needed.
3. **Open the upstream PR** with these claims:
   - All changes are additive
   - Toggle-OFF emits identical bytes to today
   - No new dependencies
   - Default-OFF on fresh load
   - Live preview tinting deferred to a follow-up PR (small, ~30 lines)

---

**Reviewer instructions:** Read this document, read the plan file at `/Users/eric/.claude/plans/1-yes-3mf-export-keen-falcon.md` (the original architectural plan, written before stress testing), then attack the code with adversarial scenarios from §11. Your job is to find what I missed.
