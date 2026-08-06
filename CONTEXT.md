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
| 1e4  | 100 µm  | export (3MF), meshRepair, meshValidation, exclusion/adjacency, main.js masking | matches the 4-decimal precision exports are written with |
| 1e5  | 10 µm   | subdivision, regularize, displacement | fine enough to keep small fillet vertices distinct (1e4 merged them → needle artifacts); coarse enough to absorb float32 noise |
| 1e6  | 1 µm    | decimation (own packed-key welder in decimation.js) | collapse positioning needs the finest grid |

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
