# Domain concepts — stlTexturizer

## Vertex welding (`js/meshIndex.js`)

The pipeline works on **non-indexed triangle soup**: every triangle carries its
own copy of each corner, so "the same point" exists many times with possible
float noise. **Welding** maps each position, quantised onto a grid, to one
small integer id. All modules do this through `QuantizedPointMap` /
`weldVertices` in `js/meshIndex.js` — an open-addressing hash table over typed
arrays (no string keys, no per-vertex allocation).

### Weld grids (quantisation)

The grid decides which points count as "the same". The app deliberately uses
three grids; **do not change a call site's grid casually** — it changes
watertightness behaviour:

| Grid | Cell    | Used by | Why |
|------|---------|---------|-----|
| 1e4  | 0.1 µm  | export (3MF), meshRepair, meshValidation, exclusion/adjacency, main.js masking | matches the 4-decimal precision exports are written with |
| 1e5  | 10 nm   | subdivision, regularize, displacement | fine enough to keep small fillet vertices distinct (1e4 merged them → needle artifacts); coarse enough to absorb float32 noise |
| 1e6  | 1 nm    | decimation (own packed-key welder in decimation.js) | collapse positioning needs the finest grid |

(Cell = 1/quant mm: positions are keyed by `Math.round(x * quant)`.)

`resolveTJunctions` (meshRepair.js) **snaps** coordinates onto the 1e4 grid
before export, so the exporter's weld only merges grid-identical points and the
export's decimal rounding is a no-op.

### Known issue link

A handful of residual non-manifold edges in exports trace back to
decimation/bottom-snap folds; the cross-module grid differences above are a
suspected contributor. If unifying grids is ever attempted, it is a
behaviour change — verify with the export→import round-trip, not the
in-memory mesh.

## Edge keys must be exact integers (`js/meshIndex.js`, `js/meshRepair.js`)

Do **not** pack a vertex-id pair into one JS number as `a * 2**32 + b`. float64
carries 53 bits of integer precision, so that form is exact only up to
`a = 2^21 = 2,097,152` — above it distinct edges collide onto one key, silently,
and only on meshes big enough that nobody verifies by hand.

`meshRepair.js` used to do this in both `countEdgeDefects` and
`resolveTJunctions`, with different severities:

* **countEdgeDefects** — colliding edges sum their incidence counts and trip the
  `> 2` non-manifold test, so a *good* export is reported as broken. Measured on
  a torus that is manifold by grid construction: 2.52 M vertices reported
  210,422 phantom non-manifold edges, 3.74 M reported 819,608.
* **resolveTJunctions** — worse, because it repairs rather than measures. A real
  boundary edge (count 1) that collides reads as count 2 and its T-junction is
  left unrepaired; and decoding the key back (`b = k % 4294967296`) returns
  vertex ids that were never on that edge.

Both now use `IntPairMap` (Int32 pair keys) over a dense edge table. Below the
2.1 M threshold the old keys were exact, so the change is a no-op there — which
is what the pipeline fingerprints confirm.

`diag-edgekey-collision.mjs` reproduces the failure and is the regression test:
it builds meshes whose manifoldness is guaranteed by topology, not measured, so
any counter that disagrees is wrong by construction.

## Integer-pair tables also save memory (`js/meshIndex.js`)

`IntPairMap` exists for correctness (see above), but it is also 12 bytes per
slot against `QuantizedPointMap`'s 28, which matters wherever such a table is
sized by triangle count:

| Call site | Table |
|-----------|-------|
| `subdivision.js` | `splitEdges` (marked edges), `midCache` (midpoint ids) |
| `decimation.js`  | `seedSeen` (edge-seeding dedup) |

Do not swap `IntPairMap` in where coordinates are the key: it does no
quantisation.

## Pipeline peak memory — measure, don't estimate

Decimation is the peak stage in every configuration measured. Measure with
`process.memoryUsage().arrayBuffers + .heapUsed`, **not RSS** — V8 does not
return freed pages to the OS promptly and RSS overstates the peak by ~30 %.

Measured peak per subdivided triangle (sphere, 3.29 M triangles):

| Stage | before | after |
|-------|--------|-------|
| subdivide | 178 | 147 |
| displace  | 254 | 216 |
| decimate  | **660** | **327** |

Where the decimation savings came from, all behaviour-preserving:

* **SoAHeap capacity.** Seeding pushes one entry per *unique* edge — 1.5 F by
  Euler, not the 3 F edge slots the face loop visits — and the constructor then
  rounded up to a power of two. A 4.9 M-entry heap was allocated as 16.7 M
  slots × 48 B = 805 MB. Capacity is only a bound in `push()`; nothing masks on
  it, so it need not be a power of two.
* **`buildIndexed` positions.** Allocated at the corner count and returned as a
  `subarray` **view**, so a 6× oversized buffer stayed reachable for the whole
  run (237 MB holding 39 MB). Grows on demand, returns a copy.
* **`slotFace` / `faceSlot`.** Slots are assigned `s = f*3+k` and never
  renumbered, so `slotFace[s]` is always `(s/3)|0`; `faceSlot[s]` only ever held
  `s` or `-1`, i.e. one bit. Both gone (−24 B/tri).
* **`decimate(…, releaseInput)`.** `buildIndexed` is the only reader of the
  input geometry; when the caller discards it anyway, dropping the attributes
  releases 72 B per input triangle for the whole collapse loop. `dispose()`
  cannot do this — it frees GPU resources, not the JS typed arrays.

Verify any change here with `bench-pipeline.mjs` fingerprints, not by eye.

## Texture layers (`js/main.js`, `js/displacement.js`, `js/previewMaterial.js`)

A layer is a texture plus its own projection/displacement settings
(`LAYER_KEYS`) and its own painted surface. The **active** layer is the live
sidebar state (`settings.*`, `activeMapEntry`, `selectionMode`); switching
layers stores that into `layers[activeLayer]` and re-applies the other
layer's record through `applySettingsSnapshot`, the same code path a project
load uses. Everything else in `settings` (resolution, triangle limit, angle
masks, bottom handling, regularize knobs) is global.

Composition is per welded vertex, in layer order: a layer **covers** the
layers below where its weight (mask × falloff × angle mask) lets it through,
or **adds** to them (`blendAdd`). `applyDisplacementLayers` does this on the
CPU; the preview shader (four samplers, per-layer uniform arrays, `layerMask`
/ `layerFalloff` vec4 attributes) does the same on the GPU. With one layer the
single-texture arithmetic is untouched — the bench fingerprint must not move.

The export pipeline takes `layers` (per-layer image, settings, per-corner
`exclude`, per-face `hardFaces`); each layer's mask is carried onto the
refined mesh through the parent-face map like soft paint always was.
`faceWeights` then marks the faces **no** layer textures (subdivision skip,
preserve-untextured lock). An unsplit single visible active layer still uses
the original inputs (`imageData` + `faceWeights` + `softExclude`).

## Sharp creases (`js/displacement.js`)

Every copy of a welded position must move by the same vector (watertight),
and that vector used to be `smooth normal × h`. On a hard edge that is wrong
twice over: a 90° cube-edge vertex moves 45° outward and ends up only
0.71 h from each face while its neighbours sit at h — a notched groove whose
triangles alternate into a sawtooth comb — and the Laplacian blend-normal
smoothing carried the 45° normal a few rings into each face, mixing in the
neighbouring face's projection, which is edge-on there (a horizontal smear).

A **crease position** is one whose corners carry buffer normals from
different smooth groups (subdivision's `toIndexed` splits at 30°) that meet
at ≥ 50°. For those only:

* each group is sampled with its own normal, and blend smoothing runs over
  per-group nodes, so it never crosses the crease;
* the position is **mitred**: `d · n_g = h_g` for every group (least squares
  with a 1 % pull toward the old move for the free directions), i.e. it goes
  where the displaced faces meet;
* **no intrusion** — `d` may not point into any face it bounds (along that
  face, away from the edge) or it would pass the face's own first row and
  fold. This is what keeps concave edges, obtuse convex edges with unequal
  heights and symmetric (sinking) displacement fold-free;
* the move is capped at 2 × the largest group height (acute wedges bevel
  instead of spiking).

Positions not on a sharp crease take exactly the old path: a sphere is
bit-identical, and on a cube everything ≥ 4 mm from an edge is too (the band
in between only loses the leaked blend normal). Gentler facet breaks (< 50°)
keep the smooth path on purpose — the groove there is ≤ 10 % and smoothing
across them keeps coarse cylinders' projection continuous. The GPU
displacement preview does not mitre.

## Paint tree (`js/paintTree.js`)

Surface masks live in a per-triangle split tree over the base mesh, after
PrusaSlicer's TriangleSelector. The circle brush splits only the triangles it
partly covers (1/2/3 long edges → 2/3/4 children, same scheme as
subdivision), down to `radius / 5` (finer across a soft brush's fade band),
paints fully covered triangles whole, and merges uniform children back after
every dab. Midpoints are shared through an `IntPairMap` and reference-counted
(the map has no delete); `flatten()` splits any leaf with a neighbour's
midpoint hanging on its edge, so the flattened mesh is watertight.

One tree serves all layers: structure shared, hard state per node and soft
coverage per vertex per layer. Two rules keep layers independent: a split
hands the parent's state to the children and gives a new midpoint the
average coverage of its edge; a stroke **refines first, paints second** —
splitting after painting would average a fresh vertex with a far one and
plant coverage outside the brush (the soft brush also refines one extra
edge-limit ring so the fade can't leak across a big outer triangle).

The viewer shows the flattened tree (`paintGeometry`) whenever a face is
split, else the base mesh; the display refresh is coalesced per animation
frame. Export runs over the flattened mesh. Undo snapshots and `paint.json`
in project files hold `serialize()` (DFS split codes, states, coverage in
replay order); `deserialize()` doubles as compaction of merged-away nodes.
The base mesh is never modified, so face indices stay valid across strokes.
