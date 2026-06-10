/**
 * QEM (Quadric Error Metric) mesh decimation.
 *
 * Algorithm: Garland & Heckbert 1997, with the three safety guards from
 * PrusaSlicer's QuadricEdgeCollapse.cpp that eliminate holes, spikes and
 * non-manifold edges:
 *
 *   Guard 1 – Boundary edge protection
 *     Never collapse an edge shared by < 2 active faces.
 *     The primary cause of holes in open STL meshes.
 *
 *   Guard 2 – Link-condition (non-manifold / pinch prevention)
 *     Common neighbours of v1/v2 must equal exactly the apex vertices of
 *     their shared triangles.  Extra common neighbours mean collapsing would
 *     fuse disconnected surface regions → non-manifold edge.
 *
 *   Guard 3 – Normal-flip rejection
 *     Recompute every affected face normal after the hypothetical collapse.
 *     dot(original, new) < 0.2 (~78°) → reject.  Eliminates spikes / pits.
 *
 * Crease preservation (Garland & Heckbert §3.2):
 *   Edges where adjacent face normals diverge by more than CREASE_COS receive
 *   high-weight penalty planes added to both endpoint quadrics.  This raises
 *   the QEM cost of any collapse that would move a vertex off a sharp feature,
 *   ensuring smooth regions are decimated first while creases are kept intact.
 *
 * Performance notes:
 *   - Struct-of-arrays typed-array heap avoids per-entry object allocation.
 *   - Numeric edge keys (v_lo * MAX_V + v_hi) replace template strings.
 *   - Vertex deduplication uses a numeric spatial-grid Map instead of strings.
 *   - Link-violation check uses a module-level Set with packed keys for O(1)
 *     duplicate-face lookup.
 *   - Progress callback fires at most every 512 collapses.
 *
 * @param {THREE.BufferGeometry} geometry        non-indexed input
 * @param {number}               targetTriangles desired output face count
 * @param {function}             [onProgress]    callback(0–1)
 * @param {boolean}              [harvestFlat]   continue past the target to
 *   collapse the remaining near-zero-cost (flat) edges (default true)
 * @param {number}               [harvestTol]    absolute per-collapse surface-
 *   deviation tolerance in mm for harvesting; harvestCeil = harvestTol²
 * @returns {THREE.BufferGeometry}
 */

import { THREE } from './threeCompat.js';
import { QuantizedPointMap } from './meshIndex.js';

// Vertex-weld quantisation for buildIndexed. 1e6 → 1 nm cells, finer than the
// float32 resolution of the incoming positions, so it behaves as exact-float
// welding: bit-identical shared vertices (the pipeline moves watertight copies
// by the same vector, so they stay identical) merge, while genuinely distinct
// fine-feature vertices stay separate.
//
// The earlier 1e4 (0.1 µm) was far too coarse: on a real subdivided+displaced
// mesh (dots texture, 0.35 mm edges) it fused ~10k distinct vertices, leaving the
// pre-decimation mesh with 10,548 non-manifold edges; decimating that produced
// hundreds of open edges and thousands of non-manifold edges. At 1e6 the same
// mesh is fully manifold pre-decimation (0 non-manifold) and decimates to 0 open
// edges. (1e5 was an intermediate improvement but still fused ~100 vertices at
// fine resolution.) Measured, not estimated.
//
const QUANT_DEFAULT = 1e6;
const FLIP_DOT      = 0.2;  // cos ~78° — reject collapse if new normal deviates more
const FLIP_DOT_SQ   = FLIP_DOT * FLIP_DOT;
const CREASE_COS    = 0.5;  // cos 60° — edges sharper than this are treated as creases
const CREASE_WEIGHT = 1e4;  // quadric penalty weight for crease edges

// ── Flat-face harvesting (continue past the triangle target) ─────────────────
// When the collapse loop reaches targetTriangles it would normally stop, leaving
// behind flat faces that cost almost nothing to remove. With harvesting enabled
// we keep collapsing past the target while each collapse's QEM error stays below
// an ABSOLUTE tolerance (harvestCeil = harvestTol², a squared-distance bound),
// then stop. Because the heap is cost-ordered, harvesting ends the instant the
// cheapest remaining collapse exceeds the tolerance.
//
// Why absolute and not relative to the crossing cost: an earlier version scaled
// the band as c_stop × factor. But when the limit is reached while a large flat
// surplus still remains — the case with the MOST flat faces to shed — the
// crossing cost c_stop ≈ 0 (measured ~3e-11), so c_stop × factor also collapses
// to ≈0 and harvests almost nothing. An absolute error bound is regime-
// independent: it converges to the same flat-removed mesh no matter where the
// triangle target happened to land.
//
// harvestTol is an upper bound (mm) on the per-collapse surface deviation; the
// real deviation is smaller, since the cost sums squared distances over all
// incident faces. 0.005 mm ≈ a few microns — far below FDM resolution.
const DEFAULT_HARVEST_TOL = 0.005;  // mm; harvestCeil = tol²

// Time-based yield: only yield every ~100ms of wall time instead of every N iterations.
// In foreground tabs setTimeout(0) costs ~4ms; in background tabs it's throttled to ~1s.
// By yielding based on elapsed time we get ~10 yields per second in foreground (smooth progress)
// and minimal extra delay in background (~10 yields × 1s = ~10s overhead instead of ~200s).
let _lastYieldTime = 0;
function _shouldYield() {
  const now = performance.now();
  if (now - _lastYieldTime < 100) return false;
  _lastYieldTime = now;
  return true;
}
function _yieldFrame() {
  return new Promise(r => setTimeout(r, 0));
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function decimate(geometry, targetTriangles, onProgress, harvestFlat = true, harvestTol = DEFAULT_HARVEST_TOL) {
  const { positions, faces, vertCount, faceCount } = buildIndexed(geometry);

  // Already at/under the target: nothing to decimate. But if harvesting is on we
  // still run — there may be flat faces collapsible for free even below the limit.
  if (faceCount <= targetTriangles && !harvestFlat) return buildOutput(positions, faces, faceCount);

  // Per-vertex error quadrics (10 doubles = upper triangle of symmetric 4×4)
  const quadrics = new Float64Array(vertCount * 10);
  initQuadrics(quadrics, positions, faces, faceCount);
  addCreaseQuadrics(quadrics, positions, faces, faceCount);

  // Doubly-linked vertex-face incidence (typed arrays — faster than Set<number>)
  const { vfHead, slotFace, slotVert, slotNext, slotPrev, faceSlot } =
    buildLinkedAdj(faces, faceCount, vertCount);

  const active  = new Uint8Array(vertCount).fill(1);
  // Per-vertex version counter: incremented whenever a vertex's quadric or
  // position changes.  Heap entries carry the versions at push time; any
  // entry whose versions no longer match is stale and is skipped.
  const version = new Uint32Array(vertCount);
  // Epoch stamp for neighbour deduplication — O(1) "clear" via epoch++
  const nbStamp = new Uint32Array(vertCount);
  let   epoch   = 1;
  // Separate epoch-stamp array for the link-condition check (Guard 2).
  const lkStamp = new Uint32Array(vertCount);
  let   lkEpoch = 1;
  let   activeFaces = faceCount;

  // Seed min-heap with one entry per unique edge. Dedup via the integer
  // pair-keyed hash map (no V8 Set entry cap, no per-key boxing); seeding
  // order over faces/edges is unchanged.
  const heap     = new SoAHeap(Math.min(faceCount * 3, 1 << 24));
  const seedSeen = new QuantizedPointMap(1, Math.min(faceCount * 3, 1 << 22));
  for (let f = 0; f < faceCount; f++) {
    if (faces[f * 3] < 0) continue;
    for (let e = 0; e < 3; e++) {
      const va = faces[f * 3 + e];
      const vb = faces[f * 3 + ((e + 1) % 3)];
      const lo = va < vb ? va : vb, hi = va < vb ? vb : va;
      seedSeen.getOrSet(lo, hi, 0, 1);
      if (seedSeen.inserted) pushEdge(heap, quadrics, positions, version, va, vb);
    }
  }

  const initFaces  = activeFaces;
  // Progress denominator: triangles to remove to reach the target. When already
  // at/under the target (harvest-only run), there is no meaningful endpoint, so
  // fall back to initFaces to keep the reported fraction sane (monotonic, ≤1).
  const toRemove   = Math.max(1, initFaces - targetTriangles);
  let   lastProg   = 0;
  let   iterations = 0;

  // Flat-face harvesting: once the target is reached, keep collapsing while each
  // collapse's QEM error stays below the absolute tolerance (harvestTol²).
  const harvestCeil   = harvestTol * harvestTol;
  let   reachedTarget = false;

  while (heap.size() > 0) {
    // Termination / harvest gate. On reaching the target we either stop (feature
    // off) or enter harvest mode and keep collapsing below the error tolerance.
    if (activeFaces <= targetTriangles) {
      if (!harvestFlat) break;
      reachedTarget = true;
    }

    const idx = heap.pop();
    if (idx < 0) break;
    const cost = heap.getCost(idx);

    // In harvest mode the popped entry is the cheapest collapse left in the heap;
    // once its error exceeds the tolerance nothing cheaper remains → finished.
    if (reachedTarget && cost > harvestCeil) break;

    // Yield based on elapsed wall time (~every 100ms) instead of fixed iteration count.
    // Drastically reduces overhead in background tabs where setTimeout is throttled to 1s.
    ++iterations;
    if (_shouldYield()) {
      await _yieldFrame();
      if (onProgress) {
        const p = Math.min(1, (initFaces - activeFaces) / toRemove);
        if (p - lastProg > 0.005) { onProgress(p); lastProg = p; }
      }
    }

    const v1 = heap.getV1(idx), v2 = heap.getV2(idx);
    const ver1 = heap.getVer1(idx), ver2 = heap.getVer2(idx);
    const px = heap.getPx(idx), py = heap.getPy(idx), pz = heap.getPz(idx);

    // Stale-entry checks (lazy deletion)
    if (!active[v1] || !active[v2]) continue;
    if (version[v1] !== ver1 || version[v2] !== ver2) continue;

    // Single pass combines the old shareActiveFace + isBoundaryEdge:
    // 0 → stale entry, 1 → boundary edge (Guard 1), ≥2 → safe to continue
    const nsh = sharedFaceCount(faces, vfHead, slotFace, slotNext, v1, v2);
    if (nsh < 2) continue;

    // ── Three safety guards ───────────────────────────────────────────────────
    lkEpoch += 2;  // +2 so ep and ep+1 never collide with the next call
    if (hasLinkViolation(faces, vfHead, slotFace, slotNext, v1, v2, lkStamp, lkEpoch)) continue; // Guard 2
    if (checkFlipped(positions, vfHead, slotFace, slotNext, faces, v1, v2, px, py, pz)) continue; // Guard 3a
    if (checkFlipped(positions, vfHead, slotFace, slotNext, faces, v2, v1, px, py, pz)) continue; // Guard 3b

    // ── Collapse: keep v1 at new position, remove v2 ─────────────────────────
    positions[v1 * 3]     = px;
    positions[v1 * 3 + 1] = py;
    positions[v1 * 3 + 2] = pz;
    mergeQuadric(quadrics, v1, v2);
    version[v1]++;  // v1's quadric and position changed — invalidate old heap entries

    // Walk v2's face list; read sNext BEFORE modifying the list.
    let s = vfHead[v2];
    while (s >= 0) {
      const f     = slotFace[s];
      const sNext = slotNext[s]; // must be read before any list modification
      if (faces[f * 3] >= 0) {
        // Remap v2 → v1 in this face
        const cv2 = faces[f*3] === v2 ? 0 : faces[f*3+1] === v2 ? 1 : 2;
        faces[f * 3 + cv2] = v1;
        const fa = faces[f*3], fb = faces[f*3+1], fc = faces[f*3+2];
        if (fa === fb || fb === fc || fa === fc) {
          // Degenerate: unlink all 3 slots from their current vertex lists
          for (let k = 0; k < 3; k++) {
            const sk = faceSlot[f*3+k];
            if (sk >= 0) { _unlinkSlot(sk, vfHead, slotNext, slotPrev, slotVert); faceSlot[f*3+k] = -1; }
          }
          faces[f*3] = faces[f*3+1] = faces[f*3+2] = -1;
          activeFaces--;
        } else {
          // Surviving: move the v2-slot (s) into v1's list; other 2 slots stay put
          _moveSlot(s, v1, vfHead, slotNext, slotPrev, slotVert);
        }
      }
      s = sNext;
    }
    // After the loop vfHead[v2] === -1 (all slots moved or freed)
    active[v2] = 0;

    // Re-push edges for v1's updated neighbourhood (stamp dedup — no new Set)
    epoch++;
    for (let sv = vfHead[v1]; sv >= 0; sv = slotNext[sv]) {
      const f = slotFace[sv];
      if (faces[f*3] < 0) continue;
      for (let k = 0; k < 3; k++) {
        const nb = faces[f*3+k];
        if (nb !== v1 && nbStamp[nb] !== epoch) {
          nbStamp[nb] = epoch;
          if (active[nb]) pushEdge(heap, quadrics, positions, version, v1, nb);
        }
      }
    }


  }

  if (onProgress) onProgress(1);
  return buildOutput(positions, faces, faceCount);
}

// ── Linked-list vertex-face incidence ────────────────────────────────────────
// Replaces the old Array<Set<number>> adjacency.  For each face f and vertex
// position k, slot s = f*3+k tracks face f in vertex v = faces[f*3+k]'s list.
//
//   vfHead[v]       → first slot for vertex v  (-1 = empty)
//   slotFace[s]     → face tracked by slot s
//   slotVert[s]     → vertex that currently owns slot s
//   slotNext[s]     → next slot in vertex's list  (-1 = end)
//   slotPrev[s]     → prev slot in vertex's list  (-1 = head)
//   faceSlot[f*3+k] → slot for face f's k-th vertex incidence

function buildLinkedAdj(faces, faceCount, vertCount) {
  const S        = faceCount * 3;
  const vfHead   = new Int32Array(vertCount).fill(-1);
  const slotFace = new Int32Array(S);
  const slotVert = new Int32Array(S);
  const slotNext = new Int32Array(S).fill(-1);
  const slotPrev = new Int32Array(S).fill(-1);
  const faceSlot = new Int32Array(S).fill(-1);
  for (let f = 0; f < faceCount; f++) {
    if (faces[f * 3] < 0) continue;
    for (let k = 0; k < 3; k++) {
      const v = faces[f * 3 + k];
      const s = f * 3 + k;
      slotFace[s] = f;
      slotVert[s] = v;
      const h = vfHead[v];
      slotNext[s] = h;
      slotPrev[s] = -1;
      if (h >= 0) slotPrev[h] = s;
      vfHead[v] = s;
      faceSlot[f * 3 + k] = s;
    }
  }
  return { vfHead, slotFace, slotVert, slotNext, slotPrev, faceSlot };
}

// Remove slot s from its current vertex's list (slotVert[s] identifies the vertex).
function _unlinkSlot(s, vfHead, slotNext, slotPrev, slotVert) {
  const v = slotVert[s], p = slotPrev[s], n = slotNext[s];
  if (p < 0) vfHead[v] = n; else slotNext[p] = n;
  if (n >= 0) slotPrev[n] = p;
}

// Move slot s from its current vertex's list to vertex nv's list.
function _moveSlot(s, nv, vfHead, slotNext, slotPrev, slotVert) {
  _unlinkSlot(s, vfHead, slotNext, slotPrev, slotVert);
  const h = vfHead[nv];
  slotNext[s] = h;
  slotPrev[s] = -1;
  if (h >= 0) slotPrev[h] = s;
  vfHead[nv] = s;
  slotVert[s] = nv;
}

// ── Guard 0+1: combined shareActiveFace + isBoundaryEdge ─────────────────────
// Returns 0 = stale entry, 1 = boundary edge, ≥2 = safe to proceed.

function sharedFaceCount(faces, vfHead, slotFace, slotNext, v1, v2) {
  let count = 0;
  for (let s = vfHead[v1]; s >= 0; s = slotNext[s]) {
    const f = slotFace[s];
    if (faces[f * 3] < 0) continue;
    const fa = faces[f*3], fb = faces[f*3+1], fc = faces[f*3+2];
    if (fa === v2 || fb === v2 || fc === v2) { if (++count >= 2) return 2; }
  }
  return count;
}

// ── Guard 2: Link-condition (non-manifold / fold prevention) ─────────────────
// Complete link-condition check (Dey et al.): an interior edge (v1,v2) is safe
// to collapse iff the only common neighbours of v1 and v2 are the apex vertices
// of the faces shared by the edge. Any extra common neighbour — or more than two
// shared faces — would pile 3+ triangles onto an edge after the collapse, i.e.
// create a non-manifold edge or fold. The old duplicate-face test only caught
// the subset of these that produce identical triangles. O(valence) via stamps.
// lkStamp[w] === ep      → w is a one-ring neighbour of v1
// lkStamp[w] === ep + 1  → w is a legal shared-face apex (allowed)
function hasLinkViolation(faces, vfHead, slotFace, slotNext, v1, v2, lkStamp, ep) {
  // Pass 1: stamp every one-ring neighbour of v1.
  for (let s = vfHead[v1]; s >= 0; s = slotNext[s]) {
    const f = slotFace[s]; if (faces[f*3] < 0) continue;
    const a = faces[f*3], b = faces[f*3+1], c = faces[f*3+2];
    if (a !== v1) lkStamp[a] = ep;
    if (b !== v1) lkStamp[b] = ep;
    if (c !== v1) lkStamp[c] = ep;
  }
  // Pass 2: promote shared-face apexes to ep+1 (legal) and count shared faces.
  let shared = 0;
  for (let s = vfHead[v1]; s >= 0; s = slotNext[s]) {
    const f = slotFace[s]; if (faces[f*3] < 0) continue;
    const a = faces[f*3], b = faces[f*3+1], c = faces[f*3+2];
    if (a === v2 || b === v2 || c === v2) {
      shared++;
      const apex = (a !== v1 && a !== v2) ? a : (b !== v1 && b !== v2) ? b : c;
      lkStamp[apex] = ep + 1;
    }
  }
  if (shared > 2) return true; // edge already non-manifold (3+ shared faces)
  // Pass 3: a neighbour of v2 that is a v1-neighbour (ep) but not a shared apex
  // (ep+1) is an illegal common neighbour → collapse would be non-manifold.
  for (let s = vfHead[v2]; s >= 0; s = slotNext[s]) {
    const f = slotFace[s]; if (faces[f*3] < 0) continue;
    const a = faces[f*3], b = faces[f*3+1], c = faces[f*3+2];
    if (a !== v2 && a !== v1 && lkStamp[a] === ep) return true;
    if (b !== v2 && b !== v1 && lkStamp[b] === ep) return true;
    if (c !== v2 && c !== v1 && lkStamp[c] === ep) return true;
  }
  return false;
}

// ── Guard 3: Normal-flip rejection ──────────────────────────────────────────
// Fully inlined — no array allocations, no sqrt calls.
// Squared-dot comparison replaces the normalized dot product:
//   dot(on_norm, nn_norm) < FLIP_DOT
//   ⟺  rawDot < 0  OR  rawDot² < FLIP_DOT² · |on|² · |nn|²

function checkFlipped(positions, vfHead, slotFace, slotNext, faces, vc, vo, npx, npy, npz) {
  for (let s = vfHead[vc]; s >= 0; s = slotNext[s]) {
    const f = slotFace[s];
    if (faces[f * 3] < 0) continue;
    const fa = faces[f*3], fb = faces[f*3+1], fc = faces[f*3+2];
    if (fa === vo || fb === vo || fc === vo) continue;
    const oax = positions[fa*3], oay = positions[fa*3+1], oaz = positions[fa*3+2];
    const obx = positions[fb*3], oby = positions[fb*3+1], obz = positions[fb*3+2];
    const ocx = positions[fc*3], ocy = positions[fc*3+1], ocz = positions[fc*3+2];
    // Unnormalized original normal
    const oux = obx-oax, ouy = oby-oay, ouz = obz-oaz;
    const ovx = ocx-oax, ovy = ocy-oay, ovz = ocz-oaz;
    const onx = ouy*ovz - ouz*ovy;
    const ony = ouz*ovx - oux*ovz;
    const onz = oux*ovy - ouy*ovx;
    // New positions (vc replaced by np)
    let nax, nay, naz, nbx, nby, nbz, ncx, ncy, ncz;
    if (fa === vc)      { nax = npx; nay = npy; naz = npz; nbx = obx; nby = oby; nbz = obz; ncx = ocx; ncy = ocy; ncz = ocz; }
    else if (fb === vc) { nax = oax; nay = oay; naz = oaz; nbx = npx; nby = npy; nbz = npz; ncx = ocx; ncy = ocy; ncz = ocz; }
    else                { nax = oax; nay = oay; naz = oaz; nbx = obx; nby = oby; nbz = obz; ncx = npx; ncy = npy; ncz = npz; }
    // Unnormalized new normal
    const nux = nbx-nax, nuy = nby-nay, nuz = nbz-naz;
    const nvx = ncx-nax, nvy = ncy-nay, nvz = ncz-naz;
    const nnx = nuy*nvz - nuz*nvy;
    const nny = nuz*nvx - nux*nvz;
    const nnz = nux*nvy - nuy*nvx;
    // Squared-dot flip test (avoids sqrt + division)
    const rawDot = onx*nnx + ony*nny + onz*nnz;
    if (rawDot < 0) return true;
    if (rawDot * rawDot < FLIP_DOT_SQ * (onx*onx+ony*ony+onz*onz) * (nnx*nnx+nny*nny+nnz*nnz)) return true;
  }
  return false;
}

// ── Quadric helpers ──────────────────────────────────────────────────────────
// Symmetric 4×4 quadric stored as 10 upper-triangle values per vertex.

// ── Crease-edge quadric preservation (Garland & Heckbert §3.2) ─────────────
// For each interior edge whose two adjacent faces form a dihedral angle sharper
// than CREASE_COS, inject two penalty planes into both endpoint vertices.
// Each penalty plane is perpendicular to one adjacent face and passes through
// the crease edge, constraining the vertex to stay on the crease line.
// The high CREASE_WEIGHT ensures these edges have far higher QEM cost than
// smooth-surface edges and are therefore collapsed last (or not at all).

function addCreaseQuadrics(quadrics, positions, faces, faceCount) {
  // Edge table over typed arrays: the integer pair-keyed map assigns each
  // unique (va,vb) edge a sequential index in FIRST-OCCURRENCE order, which
  // matches the old Map's insertion-order iteration exactly. Order matters:
  // the penalty planes accumulate into per-vertex quadrics with float adds,
  // so a different edge order would change low bits and shift collapse order.
  // Arrays are sized to the upper bound (3 edge instances per face).
  const maxEdges = faceCount * 3;
  const edgeIdx = new QuantizedPointMap(1, Math.min(maxEdges, 1 << 22));
  const edgeVa  = new Int32Array(maxEdges);
  const edgeVb  = new Int32Array(maxEdges);
  const edgeF0  = new Int32Array(maxEdges);
  const edgeF1  = new Int32Array(maxEdges);
  const edgeNum = new Uint8Array(maxEdges); // 1, 2, or 3 (= "more than 2, skip")
  let edgeCount = 0;
  for (let f = 0; f < faceCount; f++) {
    if (faces[f * 3] < 0) continue;
    for (let e = 0; e < 3; e++) {
      const va = faces[f * 3 + e];
      const vb = faces[f * 3 + ((e + 1) % 3)];
      const lo = va < vb ? va : vb, hi = va < vb ? vb : va;
      const ei = edgeIdx.getOrSet(lo, hi, 0, edgeCount);
      if (edgeIdx.inserted) {
        edgeVa[ei] = lo; edgeVb[ei] = hi; edgeF0[ei] = f; edgeNum[ei] = 1;
        edgeCount++;
      } else if (edgeNum[ei] === 1) {
        edgeF1[ei] = f; edgeNum[ei] = 2;
      } else {
        // 3rd+ incidence: non-manifold edge — never feeds crease quadrics.
        // (Until June 2026 a legacy Map-encoding quirk re-armed every EVEN
        // incidence count as the bogus pair (face 0 of the whole mesh, latest
        // face), injecting crease penalty planes derived from an unrelated
        // triangle's normal into fold regions. Removing it was validated by
        // RMS surface-distance comparison and edge-defect counts — see the
        // commit message.)
        edgeNum[ei] = 3;
      }
    }
  }

  const sqrtW = Math.sqrt(CREASE_WEIGHT);

  for (let ei = 0; ei < edgeCount; ei++) {
    if (edgeNum[ei] !== 2) continue; // boundary (1 face) or non-manifold (>2) — skip
    const f0 = edgeF0[ei];
    const f1 = edgeF1[ei];
    const v0a = faces[f0*3], v0b = faces[f0*3+1], v0c = faces[f0*3+2];
    const v1a = faces[f1*3], v1b = faces[f1*3+1], v1c = faces[f1*3+2];

    // Unit face normals, inlined (same arithmetic as faceNormal, no per-edge
    // array allocation).
    let ux = positions[v0b*3] - positions[v0a*3], uy = positions[v0b*3+1] - positions[v0a*3+1], uz = positions[v0b*3+2] - positions[v0a*3+2];
    let vx = positions[v0c*3] - positions[v0a*3], vy = positions[v0c*3+1] - positions[v0a*3+1], vz = positions[v0c*3+2] - positions[v0a*3+2];
    let cnx = uy * vz - uz * vy, cny = uz * vx - ux * vz, cnz = ux * vy - uy * vx;
    let clen = Math.sqrt(cnx * cnx + cny * cny + cnz * cnz) || 1;
    const n0x = cnx / clen, n0y = cny / clen, n0z = cnz / clen;

    ux = positions[v1b*3] - positions[v1a*3]; uy = positions[v1b*3+1] - positions[v1a*3+1]; uz = positions[v1b*3+2] - positions[v1a*3+2];
    vx = positions[v1c*3] - positions[v1a*3]; vy = positions[v1c*3+1] - positions[v1a*3+1]; vz = positions[v1c*3+2] - positions[v1a*3+2];
    cnx = uy * vz - uz * vy; cny = uz * vx - ux * vz; cnz = ux * vy - uy * vx;
    clen = Math.sqrt(cnx * cnx + cny * cny + cnz * cnz) || 1;
    const n1x = cnx / clen, n1y = cny / clen, n1z = cnz / clen;

    if (n0x*n1x + n0y*n1y + n0z*n1z >= CREASE_COS) continue; // smooth — skip

    const va = edgeVa[ei];
    const vb = edgeVb[ei];

    // Normalised edge direction
    const ex = positions[vb*3]   - positions[va*3];
    const ey = positions[vb*3+1] - positions[va*3+1];
    const ez = positions[vb*3+2] - positions[va*3+2];
    const elen = Math.sqrt(ex*ex + ey*ey + ez*ez) || 1;
    const edx = ex / elen, edy = ey / elen, edz = ez / elen;

    // Add one penalty plane per adjacent face-normal (n0 first, then n1 —
    // same order as the old destructured-pair loop).
    for (let pi = 0; pi < 2; pi++) {
      const nx = pi === 0 ? n0x : n1x, ny = pi === 0 ? n0y : n1y, nz = pi === 0 ? n0z : n1z;
      // Penalty plane normal = normalize(face_normal × edge_dir)
      // This plane contains the edge and is perpendicular to the face,
      // so it constrains the vertex to lie on the crease line.
      let px = ny*edz - nz*edy;
      let py = nz*edx - nx*edz;
      let pz = nx*edy - ny*edx;
      const plen = Math.sqrt(px*px + py*py + pz*pz);
      if (plen < 1e-10) continue; // edge parallel to face normal — degenerate
      px /= plen; py /= plen; pz /= plen;
      const d = -(px*positions[va*3] + py*positions[va*3+1] + pz*positions[va*3+2]);
      // Scale by sqrtW: addPlaneQ accumulates (a²,ab,…) so scaling inputs by √w yields w×(a²,ab,…)
      addPlaneQ(quadrics, va, px*sqrtW, py*sqrtW, pz*sqrtW, d*sqrtW);
      addPlaneQ(quadrics, vb, px*sqrtW, py*sqrtW, pz*sqrtW, d*sqrtW);
    }
  }
}

function initQuadrics(quadrics, positions, faces, faceCount) {
  for (let f = 0; f < faceCount; f++) {
    if (faces[f * 3] < 0) continue;
    const fa = faces[f * 3], fb = faces[f * 3 + 1], fc = faces[f * 3 + 2];
    // Unit face normal, inlined (same arithmetic as the old faceNormal helper,
    // no per-face array allocation).
    const ux = positions[fb*3] - positions[fa*3], uy = positions[fb*3+1] - positions[fa*3+1], uz = positions[fb*3+2] - positions[fa*3+2];
    const vx = positions[fc*3] - positions[fa*3], vy = positions[fc*3+1] - positions[fa*3+1], vz = positions[fc*3+2] - positions[fa*3+2];
    const cnx = uy * vz - uz * vy, cny = uz * vx - ux * vz, cnz = ux * vy - uy * vx;
    const len = Math.sqrt(cnx * cnx + cny * cny + cnz * cnz) || 1;
    const nx = cnx / len, ny = cny / len, nz = cnz / len;
    const d = -(nx * positions[fa*3] + ny * positions[fa*3+1] + nz * positions[fa*3+2]);
    addPlaneQ(quadrics, fa, nx, ny, nz, d);
    addPlaneQ(quadrics, fb, nx, ny, nz, d);
    addPlaneQ(quadrics, fc, nx, ny, nz, d);
  }
}

function addPlaneQ(q, v, a, b, c, d) {
  const o = v * 10;
  q[o]   += a*a; q[o+1] += a*b; q[o+2] += a*c; q[o+3] += a*d;
                 q[o+4] += b*b; q[o+5] += b*c; q[o+6] += b*d;
                                q[o+7] += c*c; q[o+8] += c*d;
                                               q[o+9] += d*d;
}

function mergeQuadric(q, v1, v2) {
  const o1 = v1 * 10, o2 = v2 * 10;
  for (let i = 0; i < 10; i++) q[o1 + i] += q[o2 + i];
}

function evalQ(q, v, x, y, z) {
  const o = v * 10;
  return q[o]   * x*x + 2*q[o+1]*x*y + 2*q[o+2]*x*z + 2*q[o+3]*x
       + q[o+4] * y*y + 2*q[o+5]*y*z + 2*q[o+6]*y
       + q[o+7] * z*z + 2*q[o+8]*z
       + q[o+9];
}

function evalQSum(q, v1, v2, x, y, z) {
  return evalQ(q, v1, x, y, z) + evalQ(q, v2, x, y, z);
}

const _s = new Float64Array(3);

function solveQ(q, v1, v2) {
  const o1 = v1 * 10, o2 = v2 * 10;
  const a00 = q[o1]   + q[o2];
  const a01 = q[o1+1] + q[o2+1];
  const a02 = q[o1+2] + q[o2+2];
  const a11 = q[o1+4] + q[o2+4];
  const a12 = q[o1+5] + q[o2+5];
  const a22 = q[o1+7] + q[o2+7];
  const b0  = -(q[o1+3] + q[o2+3]);
  const b1  = -(q[o1+6] + q[o2+6]);
  const b2  = -(q[o1+8] + q[o2+8]);

  const det = a00*(a11*a22 - a12*a12) - a01*(a01*a22 - a12*a02) + a02*(a01*a12 - a11*a02);
  const maxEl = Math.max(Math.abs(a00), Math.abs(a01), Math.abs(a02), Math.abs(a11), Math.abs(a12), Math.abs(a22));
  const threshold = maxEl * maxEl * maxEl * 1e-10;
  if (Math.abs(det) < Math.max(threshold, 1e-30)) return false;

  const inv = 1 / det;
  _s[0] = inv * (b0*(a11*a22 - a12*a12) - a01*(b1*a22 - a12*b2) + a02*(b1*a12 - a11*b2));
  _s[1] = inv * (a00*(b1*a22 - a12*b2) - b0*(a01*a22 - a12*a02) + a02*(a01*b2 - b1*a02));
  _s[2] = inv * (a00*(a11*b2 - b1*a12) - a01*(a01*b2 - b1*a02) + b0*(a01*a12 - a11*a02));
  return true;
}

function pushEdge(heap, quadrics, positions, version, v1, v2) {
  let px, py, pz;

  if (solveQ(quadrics, v1, v2)) {
    px = _s[0]; py = _s[1]; pz = _s[2];
  } else {
    const mx = (positions[v1*3]   + positions[v2*3])   / 2;
    const my = (positions[v1*3+1] + positions[v2*3+1]) / 2;
    const mz = (positions[v1*3+2] + positions[v2*3+2]) / 2;
    const e1 = evalQSum(quadrics, v1, v2, positions[v1*3],   positions[v1*3+1], positions[v1*3+2]);
    const e2 = evalQSum(quadrics, v1, v2, positions[v2*3],   positions[v2*3+1], positions[v2*3+2]);
    const em = evalQSum(quadrics, v1, v2, mx, my, mz);
    // Prefer midpoint when costs are near-equal (degenerate / flat surfaces).
    // Midpoint minimises displacement of adjacent triangles, reducing normal
    // flips and preventing the collapse loop from stalling on coplanar geometry.
    const eMin = Math.min(e1, e2, em);
    const eTol = eMin * 1e-2 + 1e-12;
    if      (em <= eMin + eTol) { px = mx; py = my; pz = mz; }
    else if (e1 <= e2)          { px = positions[v1*3]; py = positions[v1*3+1]; pz = positions[v1*3+2]; }
    else                        { px = positions[v2*3]; py = positions[v2*3+1]; pz = positions[v2*3+2]; }
  }

  const cost = evalQSum(quadrics, v1, v2, px, py, pz);
  // Tiny edge-length tiebreaker: on degenerate (flat) surfaces where QEM
  // costs are ~0, prefer collapsing shorter edges first for better triangle
  // quality and fewer guard rejections.
  const dx = positions[v2*3] - positions[v1*3];
  const dy = positions[v2*3+1] - positions[v1*3+1];
  const dz = positions[v2*3+2] - positions[v1*3+2];
  heap.push(cost + (dx*dx + dy*dy + dz*dz) * 1e-8,
            v1, v2, version[v1], version[v2], px, py, pz);
}

// ── Indexed <-> Non-indexed conversion ──────────────────────────────────────

// Spatial-hash vertex deduplication via the shared integer-keyed point map
// (open addressing over typed arrays — no BigInt boxing, no Map overhead).
// Same 1e6 weld grid as before: QuantizedPointMap keys on Math.round(c*QUANT),
// which groups identically to the old offset-packed BigInt keys.
function buildIndexed(geometry) {
  const QUANT = QUANT_DEFAULT;
  const posAttr = geometry.attributes.position;
  const n = posAttr.count;

  const positions  = new Float64Array(n * 3); // over-allocated, trimmed later
  const indexRemap = new Int32Array(n);
  let   vertCount  = 0;

  const vertMap = new QuantizedPointMap(QUANT, Math.min(n, 1 << 22));

  for (let i = 0; i < n; i++) {
    const x = posAttr.getX(i), y = posAttr.getY(i), z = posAttr.getZ(i);
    const idx = vertMap.getOrSet(x, y, z, vertCount);
    if (vertMap.inserted) {
      vertCount++;
      positions[idx * 3]     = x;
      positions[idx * 3 + 1] = y;
      positions[idx * 3 + 2] = z;
    }
    indexRemap[i] = idx;
  }

  const faceCount = n / 3;
  const faces = new Int32Array(faceCount * 3);
  for (let i = 0; i < n; i++) faces[i] = indexRemap[i];

  return { positions: positions.subarray(0, vertCount * 3), faces, vertCount, faceCount };
}

// (adjacency helpers replaced by buildLinkedAdj and _unlinkSlot/_moveSlot above)

function buildOutput(positions, faces, faceCount) {
  let activeFaces = 0;
  for (let f = 0; f < faceCount; f++) {
    if (faces[f * 3] >= 0) activeFaces++;
  }

  const posArray = new Float32Array(activeFaces * 9);
  let out = 0;
  for (let f = 0; f < faceCount; f++) {
    if (faces[f * 3] < 0) continue;
    for (let v = 0; v < 3; v++) {
      const vi = faces[f * 3 + v];
      posArray[out++] = positions[vi * 3];
      posArray[out++] = positions[vi * 3 + 1];
      posArray[out++] = positions[vi * 3 + 2];
    }
  }

  // Compute exact per-face normals from the final positions so winding order
  // always agrees with the stored normals (computeVertexNormals averages across
  // shared positions and can flip normals on excluded surfaces).
  const nrmArray = new Float32Array(posArray.length);
  for (let i = 0; i < posArray.length; i += 9) {
    const ax = posArray[i],   ay = posArray[i+1], az = posArray[i+2];
    const bx = posArray[i+3], by = posArray[i+4], bz = posArray[i+5];
    const cx = posArray[i+6], cy = posArray[i+7], cz = posArray[i+8];
    const ux = bx-ax, uy = by-ay, uz = bz-az;
    const vx = cx-ax, vy = cy-ay, vz = cz-az;
    const nx = uy*vz - uz*vy, ny = uz*vx - ux*vz, nz = ux*vy - uy*vx;
    const len = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
    nrmArray[i]   = nrmArray[i+3] = nrmArray[i+6] = nx / len;
    nrmArray[i+1] = nrmArray[i+4] = nrmArray[i+7] = ny / len;
    nrmArray[i+2] = nrmArray[i+5] = nrmArray[i+8] = nz / len;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
  geo.setAttribute('normal',   new THREE.BufferAttribute(nrmArray, 3));
  return geo;
}

// ── Struct-of-arrays Min-Heap ────────────────────────────────────────────────
// Stores each heap entry in parallel typed arrays rather than JS objects to
// avoid heap allocation pressure and GC pauses during the collapse loop.
// The heap is 1-indexed (root at slot 1).  Slot 0 is used as a scratch area
// by pop() so the caller can read fields after popping.
// pop() returns 0 (the scratch slot index) on success, or -1 if empty.
const SOA_GROW = 1.5;
class SoAHeap {
  constructor(initialCap = 65536) {
    let cap = 2;
    while (cap <= initialCap) cap <<= 1;
    this._cap  = cap;
    this._len  = 0;
    this._cost = new Float64Array(cap);
    this._v1   = new Int32Array(cap);
    this._v2   = new Int32Array(cap);
    this._ver1 = new Uint32Array(cap);
    this._ver2 = new Uint32Array(cap);
    this._px   = new Float64Array(cap);
    this._py   = new Float64Array(cap);
    this._pz   = new Float64Array(cap);
  }

  size() { return this._len; }

  push(cost, v1, v2, ver1, ver2, px, py, pz) {
    let i = ++this._len;
    if (i >= this._cap) this._grow();
    this._cost[i] = cost; this._v1[i] = v1; this._v2[i] = v2;
    this._ver1[i] = ver1; this._ver2[i] = ver2;
    this._px[i] = px; this._py[i] = py; this._pz[i] = pz;
    this._bubbleUp(i);
  }

  // Pops the minimum entry into slot 0 and returns 0.  Returns -1 if empty.
  pop() {
    if (this._len === 0) return -1;
    this._copySlot(0, 1);
    this._copySlot(1, this._len--);
    if (this._len > 0) this._sinkDown(1);
    return 0;
  }

  getCost(i) { return this._cost[i]; }
  getV1  (i) { return this._v1[i]; }
  getV2  (i) { return this._v2[i]; }
  getVer1(i) { return this._ver1[i]; }
  getVer2(i) { return this._ver2[i]; }
  getPx  (i) { return this._px[i]; }
  getPy  (i) { return this._py[i]; }
  getPz  (i) { return this._pz[i]; }

  _copySlot(dst, src) {
    this._cost[dst] = this._cost[src]; this._v1[dst] = this._v1[src]; this._v2[dst] = this._v2[src];
    this._ver1[dst] = this._ver1[src]; this._ver2[dst] = this._ver2[src];
    this._px[dst]   = this._px[src];   this._py[dst]   = this._py[src];   this._pz[dst]   = this._pz[src];
  }

  _bubbleUp(idx) {
    const cost = this._cost[idx];
    const v1 = this._v1[idx], v2 = this._v2[idx];
    const ver1 = this._ver1[idx], ver2 = this._ver2[idx];
    const px = this._px[idx], py = this._py[idx], pz = this._pz[idx];

    while (idx > 1) {
      const parent = idx >> 1;
      if (this._cost[parent] <= cost) break;
      this._cost[idx] = this._cost[parent];
      this._v1[idx] = this._v1[parent]; this._v2[idx] = this._v2[parent];
      this._ver1[idx] = this._ver1[parent]; this._ver2[idx] = this._ver2[parent];
      this._px[idx] = this._px[parent]; this._py[idx] = this._py[parent]; this._pz[idx] = this._pz[parent];
      idx = parent;
    }
    this._cost[idx] = cost;
    this._v1[idx] = v1; this._v2[idx] = v2;
    this._ver1[idx] = ver1; this._ver2[idx] = ver2;
    this._px[idx] = px; this._py[idx] = py; this._pz[idx] = pz;
  }

  _sinkDown(idx) {
    const n = this._len;
    const cost = this._cost[idx];
    const v1 = this._v1[idx], v2 = this._v2[idx];
    const ver1 = this._ver1[idx], ver2 = this._ver2[idx];
    const px = this._px[idx], py = this._py[idx], pz = this._pz[idx];

    while (true) {
      const l = idx << 1, r = l | 1;
      let child = -1;
      // Find smallest child that is cheaper than saved element
      if (l <= n && this._cost[l] < cost) child = l;
      if (r <= n && this._cost[r] < (child >= 0 ? this._cost[child] : cost)) child = r;
      if (child < 0) break;
      // Move child up into hole
      this._cost[idx] = this._cost[child];
      this._v1[idx] = this._v1[child]; this._v2[idx] = this._v2[child];
      this._ver1[idx] = this._ver1[child]; this._ver2[idx] = this._ver2[child];
      this._px[idx] = this._px[child]; this._py[idx] = this._py[child]; this._pz[idx] = this._pz[child];
      idx = child;
    }
    // Place saved element in final hole
    this._cost[idx] = cost;
    this._v1[idx] = v1; this._v2[idx] = v2;
    this._ver1[idx] = ver1; this._ver2[idx] = ver2;
    this._px[idx] = px; this._py[idx] = py; this._pz[idx] = pz;
  }

  _grow() {
    const newCap = Math.ceil(this._cap * SOA_GROW) + 2;
    const resize = (old, Ctor) => { const n = new Ctor(newCap); n.set(old); return n; };
    this._cost = resize(this._cost, Float64Array);
    this._v1   = resize(this._v1,   Int32Array);
    this._v2   = resize(this._v2,   Int32Array);
    this._ver1 = resize(this._ver1, Uint32Array);
    this._ver2 = resize(this._ver2, Uint32Array);
    this._px   = resize(this._px,   Float64Array);
    this._py   = resize(this._py,   Float64Array);
    this._pz   = resize(this._pz,   Float64Array);
    this._cap  = newCap;
  }
}
