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

## The quality ceiling is a memory budget (`js/memoryBudget.js`)

The subdivision safety cap is **derived**, not hardcoded:
`cap = budgetBytes / PIPELINE_BYTES_PER_TRIANGLE`, bounded by a second,
independent ceiling. It replaced a fixed 16M/32M pair whose justifying comment
assumed 145 B/tri when the real figure was 660 — so those caps were
unreachable, and an export hit the allocator instead of the "cap".

`PIPELINE_BYTES_PER_TRIANGLE` is 384: the **browser** figure (RSS of every
Chromium process during a real export, minus the idle baseline — 15.0 M
subdivided triangles, 665 MB to 6165 MB). Node's live typed-array accounting
gives 327; the browser number is deliberately preferred, because this guard
exists to stop an export before the allocator does and the allocator charges
for the footprint, not for the subset V8 calls live.

**If you change an allocation in `decimation.js`, `subdivision.js` or
`displacement.js`, re-measure and update `PIPELINE_BYTES_PER_TRIANGLE`.** It is
the only thing standing between the user and an out-of-memory tab.

### Two ceilings — total memory AND per-allocation

| Ceiling | Constant | Binds at |
|---------|----------|----------|
| Total footprint | `PIPELINE_BYTES_PER_TRIANGLE` (384) | budget ÷ 384 |
| One typed array | `MAX_SINGLE_BUFFER_BYTES_PER_TRIANGLE` (48) vs 2^31-1 B | ~44.7 M triangles |

The second is **not about how much RAM the machine has**. V8 caps a single
typed array at 2^31-1 bytes (measured: the largest allocatable Float32Array is
2046 MB, page and worker alike). The pipeline's biggest single allocations are
decimation's `quadrics` (Float64Array(V*10) = 40 B/tri) and `toNonIndexed`'s
position/normal buffers (Float32Array(T*9) = 36 B/tri each).

Found the hard way: a 32 GB budget nominally allowed 101 M triangles,
subdivision reached 65 M, and `toNonIndexed` then asked for a 2.34 GB
Float32Array and threw `Array buffer allocation failed` — killing the export
after minutes of work, on a machine with 30 GB free. Going out-of-core is the
only way past ~45 M triangles.

`navigator.deviceMemory` is clamped to 8 by its own specification, so it cannot
distinguish an 8 GB laptop from a 512 GB workstation. The budget is therefore a
user setting with a conservative automatic default, not a detection.

### Allocation failures degrade, they do not throw

`subdivide()` rolls back to the last complete level on an allocation failure
(`isAllocationFailure` matches the V8/Spidermonkey/JSC wordings; anything else
re-throws) and reports it as `safetyCapHit`, which the caller already surfaces
as "coarser than requested". With the structural cap in place this path should
be unreachable in Chromium — **it is defensive and currently unexercised by any
test**; it exists because engine limits differ and losing a finished
multi-minute subdivision to one failed allocation is not acceptable.

The page owns the budget (localStorage); the pipeline may run in a worker with
no localStorage, so the resolved cap travels as `settings.subdivisionCap`, where
`0` means "use the auto-detected default". `diag-quality-ceiling.mjs` shows
which ceiling binds at a given part size; `diag-manifold-stages.mjs` reports
edge defects after each stage.
