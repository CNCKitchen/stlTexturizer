/**
 * Edge-based adaptive mesh subdivision.
 *
 * Subdivides until every edge is ≤ maxEdgeLength.  A hard safety cap of
 * SAFETY_CAP triangles prevents OOM on very fine settings; the caller
 * (export pipeline) hands the result to the QEM decimator which then trims
 * it to the user-requested budget.
 *
 * @param {THREE.BufferGeometry} geometry   – non-indexed input from STLLoader
 * @param {number} maxEdgeLength            – maximum allowed edge length (same unit as STL)
 * @param {function} [onProgress]           – optional callback(fraction 0–1)
 * @returns {{ geometry: THREE.BufferGeometry, safetyCapHit: boolean }}
 */

import { THREE } from './threeCompat.js';
import { QuantizedPointMap } from './meshIndex.js';

// 10 µm vertex-dedup cells. Below 1e5 (= 100 µm) small-fillet meshes have
// distinct fillet vertices that round to the same key and merge incorrectly,
// producing zero-length edges and non-manifold artifacts after displacement.
// 1e5 still tolerates float32 round-trip noise (~1e-4 mm worst case at metre
// scales) so well-formed inputs continue to dedup cleanly.
const QUANTISE   = 1e5;
// Absolute OOM guard for the pipeline downstream of subdivide (displacement
// copy, QEM decimation working set).  Historically fixed at 16M, which was
// also a hard ceiling from V8's ~16.7M hash-table entry cap in the old
// edge-marking Set — that structure is gone (integer hash map, no entry cap),
// so the guard is now purely about memory.
//
// Measured pipeline peak (3DBenchy + dots, June 2026): ~145 bytes per
// subdivided triangle — 16M ≈ 2.9 GB, 32M ≈ 4.3 GB (29M measured at 4.25 GB,
// completing watertight in ~2 min).  32M therefore fits comfortably on
// ≥16 GB machines.  navigator.deviceMemory (Chrome/Edge, available on the
// page and in workers, reports 8 for ANY machine with ≥8 GB) gates the
// higher cap; browsers without the API (Safari, Firefox) and Node keep the
// long-proven 16M.  Since the pipeline moved into the export worker, blowing
// past available memory surfaces as a clean error alert instead of killing
// the tab, so the worst case at 32M on a marginal machine is a retry at a
// coarser setting.  The Smart recommender targets a conservative ~4M either
// way; only manual resolution-slider drags approach these caps.
const SAFETY_CAP = (typeof navigator !== 'undefined' && navigator.deviceMemory >= 8)
  ? 32_000_000
  : 16_000_000;

// ── Growable typed vertex store ──────────────────────────────────────────────
// Shared by the indexers (which build it) and the subdivision passes (which
// append midpoint vertices via getMidpoint). pos/nrm hold xyz triples per
// vertex; wgt (exclusion weights) and canon (canonical position ids, accurate
// mode only) are optional. Arrays are reallocated on growth, so long-lived
// references must re-read store fields after any append — cached references
// remain valid for READS of pre-growth entries (values are copied).
function makeVertStore(initialCap, hasWeights, hasCanon) {
  return {
    cap: initialCap,
    count: 0,
    pos: new Float64Array(initialCap * 3),
    nrm: new Float64Array(initialCap * 3),
    wgt: hasWeights ? new Float64Array(initialCap) : null,
    canon: hasCanon ? new Int32Array(initialCap) : null,
    grow() {
      this.cap *= 2;
      const np = new Float64Array(this.cap * 3); np.set(this.pos); this.pos = np;
      const nn = new Float64Array(this.cap * 3); nn.set(this.nrm); this.nrm = nn;
      if (this.wgt)   { const nw = new Float64Array(this.cap); nw.set(this.wgt);   this.wgt = nw; }
      if (this.canon) { const nc = new Int32Array(this.cap);   nc.set(this.canon); this.canon = nc; }
    },
  };
}

// ── Public entry point ───────────────────────────────────────────────────────

export async function subdivide(geometry, maxEdgeLength, onProgress, faceWeights = null, { fast = false } = {}) {
  // Derive per-face exclusion BEFORE toIndexed so we use the untouched
  // non-indexed weights (toIndexed uses MAX-merge which can push boundary
  // vertices to weight 1.0 even on included triangles).
  let initialFaceExcluded = null;
  if (faceWeights) {
    const triCount = faceWeights.length / 3;
    initialFaceExcluded = new Uint8Array(triCount);
    for (let i = 0; i < triCount; i++) {
      // Non-indexed vertex i*3 belongs to face i; weight > 0.99 → excluded
      if (faceWeights[i * 3] > 0.99) initialFaceExcluded[i] = 1;
    }
  }

  // Fast mode (preview): simple position-merge, index-based edge keys.
  // Accurate mode (export): cluster-based sharp-edge splitting + canonIdx.
  const indexed = fast
    ? toIndexedFast(geometry, faceWeights)
    : toIndexed(geometry, faceWeights);
  const { verts, indices } = indexed;
  const posCanonMap = indexed.posCanonMap || null;

  const maxIterations = 12;
  let currentIndices = indices;
  let currentFaceExcluded = initialFaceExcluded;
  let safetyCapHit = false;

  // Track which original face each subdivided face descends from.
  const initialTriCount = indices.length / 3;
  let currentFaceParentId = new Int32Array(initialTriCount);
  for (let i = 0; i < initialTriCount; i++) currentFaceParentId[i] = i;

  for (let iter = 0; iter < maxIterations; iter++) {
    const triCount = currentIndices.length / 3;
    if (triCount >= SAFETY_CAP) {
      safetyCapHit = true;
      break;
    }

    const { newIndices, newFaceExcluded, newFaceParentId, changed, capped } = subdividePass(
      verts, currentIndices, maxEdgeLength, SAFETY_CAP, currentFaceExcluded,
      posCanonMap, currentFaceParentId
    );
    currentIndices = newIndices;
    if (newFaceExcluded) currentFaceExcluded = newFaceExcluded;
    if (newFaceParentId) currentFaceParentId = newFaceParentId;

    if (capped || newIndices.length / 3 >= SAFETY_CAP) safetyCapHit = true;

    // Report POST-pass state — the longest edge now is what the pass left
    // behind, not what it just refined away.  This way the user sees the
    // edge length actually decrease across iterations instead of seeing
    // each value one step delayed.
    const positions = verts.pos; // re-read: the pass may have grown the store
    let maxEdgeLenSq = 0;
    for (let t = 0; t < currentIndices.length; t += 3) {
      const a = currentIndices[t], b = currentIndices[t + 1], c = currentIndices[t + 2];
      const ab = edgeLenSq(positions, a, b);
      const bc = edgeLenSq(positions, b, c);
      const ca = edgeLenSq(positions, c, a);
      if (ab > maxEdgeLenSq) maxEdgeLenSq = ab;
      if (bc > maxEdgeLenSq) maxEdgeLenSq = bc;
      if (ca > maxEdgeLenSq) maxEdgeLenSq = ca;
    }
    const longestEdge = Math.sqrt(maxEdgeLenSq);

    const newTriCount = newIndices.length / 3;
    if (onProgress) onProgress(Math.min(0.95, (iter + 1) / maxIterations), newTriCount, longestEdge);
    // Yield once per subdivision pass (not per iteration) — keeps background tabs fast
    await new Promise(r => setTimeout(r, 0));
    if (!changed || safetyCapHit) break;
  }

  return {
    geometry: toNonIndexed(verts, currentIndices, currentFaceExcluded),
    safetyCapHit,
    faceParentId: new Int32Array(currentFaceParentId),
  };
}

// ── One subdivision pass ──────────────────────────────────────────────────────
//
// Uses a two-step approach to eliminate T-junctions:
//
//  Step 1 – scan ALL triangles and mark every edge whose squared length
//            exceeds maxSq.  Because this is global, both triangles that
//            share an edge always agree on whether to split it.
//
//  Step 2 – rebuild the index list.  Each triangle is handled according to
//            how many of its three edges are marked:
//
//    0 edges → keep as-is
//    1 edge  → 2 sub-triangles  (bisect the one long edge)
//    2 edges → 3 sub-triangles  (fan from the vertex opposite the short edge)
//    3 edges → 4 sub-triangles  (classic 1→4 midpoint subdivision – most regular)
//
// The 2- and 3-edge cases are new compared to the old single-edge split and
// produce significantly more regular results.  Thin slivers with one very
// long edge still produce chains of thin children (unavoidable without moving
// vertices off the surface), but the mesh is now crack-free in all cases.

function subdividePass(verts, indices, maxEdgeLength, safetyCap, faceExcluded = null, posCanonMap = null, faceParentId = null) {
  const maxSq = maxEdgeLength * maxEdgeLength;
  // Midpoint cache keyed by the RAW (unordered) parent-vertex pair — sharp-edge
  // cluster copies of the same position get their own midpoints (different
  // normals), exactly as before.
  const midCache = new QuantizedPointMap(1, 1 << 16);

  // verts.pos/canon are safe to cache for reads of pre-pass vertices: growth
  // reallocates but copies, and steps 1/1.5 only touch pre-pass indices.
  const positions = verts.pos;
  const canonIdx  = verts.canon;

  // When canonIdx is available (accurate/export mode), use position-canonical
  // edge keys so split-vertex faces on both sides of a sharp edge see the same
  // split decision.  Otherwise (fast/preview mode) use simple index-based keys.
  // Keys are the (lo, hi) id pair fed to an integer-keyed hash set — no V8
  // Set/Map entry cap, so very dense passes no longer need a RangeError
  // bail-out (the predicted-count cap below handles oversized passes).
  const splitEdges = new QuantizedPointMap(1, 1 << 16);
  const markEdge = (a, b) => {
    const u = canonIdx ? canonIdx[a] : a, v = canonIdx ? canonIdx[b] : b;
    if (u < v) splitEdges.getOrSet(u, v, 0, 1);
    else       splitEdges.getOrSet(v, u, 0, 1);
  };
  const isMarked = (a, b) => {
    const u = canonIdx ? canonIdx[a] : a, v = canonIdx ? canonIdx[b] : b;
    return (u < v ? splitEdges.get(u, v, 0) : splitEdges.get(v, u, 0)) !== -1;
  };

  // ── Step 1: globally mark edges that need splitting ─────────────────────
  // Excluded triangles do NOT proactively mark their own edges – their
  // interior edges will never be split, saving triangles on untextured
  // regions.  Boundary edges are still marked by the included neighbour, so
  // excluded triangles respond to those splits and T-junctions are avoided.
  for (let t = 0; t < indices.length; t += 3) {
    if (faceExcluded && faceExcluded[t / 3]) continue; // skip excluded faces
    const a = indices[t], b = indices[t + 1], c = indices[t + 2];
    if (edgeLenSq(positions, a, b) > maxSq) markEdge(a, b);
    if (edgeLenSq(positions, b, c) > maxSq) markEdge(b, c);
    if (edgeLenSq(positions, c, a) > maxSq) markEdge(c, a);
  }

  if (splitEdges.size === 0) return { newIndices: indices, newFaceExcluded: faceExcluded, newFaceParentId: faceParentId, changed: false };

  // ── Step 1.5: predict the post-split triangle count ─────────────────────
  // Each parent's child count is fully determined by how many of its edges
  // are marked in splitEdges (0→1, 1→2, 2→3, 3→4).  If the predicted total
  // exceeds the cap, abort the ENTIRE pass — partially splitting would
  // leave T-junctions on shared edges (a parent that got split has midpoint
  // vertices its as-is neighbour doesn't know about), which open into
  // visible cracks after displacement.
  let predictedTris = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2];
    const sAB = isMarked(a, b);
    const sBC = isMarked(b, c);
    const sCA = isMarked(c, a);
    const n   = (sAB ? 1 : 0) + (sBC ? 1 : 0) + (sCA ? 1 : 0);
    predictedTris += n === 0 ? 1 : n + 1;   // 0→1, 1→2, 2→3, 3→4
  }
  if (predictedTris > safetyCap) {
    // Coarser-than-requested mesh, but watertight.  Caller flags via `capped`.
    return { newIndices: indices, newFaceExcluded: faceExcluded, newFaceParentId: faceParentId, changed: false, capped: true };
  }

  // ── Step 2: rebuild index list ───────────────────────────────────────────
  // predictedTris is exact, so the output buffers are allocated once at their
  // final size (no push-array growth churn).
  const nextIndices = new Uint32Array(predictedTris * 3);
  const nextFaceExcluded = faceExcluded ? new Uint8Array(predictedTris) : null;
  const nextFaceParentId = faceParentId ? new Int32Array(predictedTris) : null;
  let wi = 0; // index write cursor (vertex slots)
  let fi = 0; // face write cursor

  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2];
    const fIdx = t / 3;
    const excl = faceExcluded ? faceExcluded[fIdx] : 0;
    const pid  = faceParentId ? faceParentId[fIdx] : 0;
    const sAB = isMarked(a, b);
    const sBC = isMarked(b, c);
    const sCA = isMarked(c, a);
    const n   = (sAB ? 1 : 0) + (sBC ? 1 : 0) + (sCA ? 1 : 0);

    if (n === 0) {
      // ── 0-split: keep triangle ─────────────────────────────────────────
      nextIndices[wi++] = a; nextIndices[wi++] = b; nextIndices[wi++] = c;
      if (nextFaceExcluded) nextFaceExcluded[fi] = excl;
      if (nextFaceParentId) nextFaceParentId[fi] = pid;
      fi++;

    } else if (n === 3) {
      // ── 3-split: 1→4 regular midpoint subdivision ──────────────────────
      //
      //        a
      //       / \
      //     mCA─mAB
      //     / \ / \
      //    c─mBC───b
      //
      const mAB = getMidpoint(verts, midCache, a, b, posCanonMap);
      const mBC = getMidpoint(verts, midCache, b, c, posCanonMap);
      const mCA = getMidpoint(verts, midCache, c, a, posCanonMap);
      nextIndices[wi++] = a;   nextIndices[wi++] = mAB; nextIndices[wi++] = mCA;
      nextIndices[wi++] = mAB; nextIndices[wi++] = b;   nextIndices[wi++] = mBC;
      nextIndices[wi++] = mCA; nextIndices[wi++] = mBC; nextIndices[wi++] = c;
      nextIndices[wi++] = mAB; nextIndices[wi++] = mBC; nextIndices[wi++] = mCA;
      for (let k = 0; k < 4; k++) {
        if (nextFaceExcluded) nextFaceExcluded[fi] = excl;
        if (nextFaceParentId) nextFaceParentId[fi] = pid;
        fi++;
      }

    } else if (n === 1) {
      // ── 1-split: bisect the one marked edge → 2 sub-triangles ──────────
      if (sAB) {
        const m = getMidpoint(verts, midCache, a, b, posCanonMap);
        nextIndices[wi++] = a; nextIndices[wi++] = m; nextIndices[wi++] = c;
        nextIndices[wi++] = m; nextIndices[wi++] = b; nextIndices[wi++] = c;
      } else if (sBC) {
        const m = getMidpoint(verts, midCache, b, c, posCanonMap);
        nextIndices[wi++] = a; nextIndices[wi++] = b; nextIndices[wi++] = m;
        nextIndices[wi++] = a; nextIndices[wi++] = m; nextIndices[wi++] = c;
      } else {                           // sCA
        const m = getMidpoint(verts, midCache, c, a, posCanonMap);
        nextIndices[wi++] = a; nextIndices[wi++] = b; nextIndices[wi++] = m;
        nextIndices[wi++] = m; nextIndices[wi++] = b; nextIndices[wi++] = c;
      }
      for (let k = 0; k < 2; k++) {
        if (nextFaceExcluded) nextFaceExcluded[fi] = excl;
        if (nextFaceParentId) nextFaceParentId[fi] = pid;
        fi++;
      }

    } else {
      // ── 2-split: 3 sub-triangles, fan from the untouched-edge vertex ───
      //
      // For each case the unsplit-edge vertex forms a small corner triangle
      // with its two adjacent midpoints; the remaining quadrilateral is
      // split along the diagonal that connects those two midpoints to the
      // opposite vertices, preserving consistent CCW winding throughout.
      //
      // KNOWN LIMITATION: on sliver parents (one short edge from CAD
      // tessellation noise + two long edges), the inner mid-mid diagonal
      // inherits half the parent's short edge and propagates the sliver
      // into two new sub-triangles per pass. We can't avoid this — the
      // alternative pentagon diagonal that would skip the midpoints
      // necessarily passes through one of them (since each midpoint sits
      // on its parent edge), producing a degenerate zero-area triangle.
      // The fix is upstream: clean sub-µm CAD slivers from the input
      // mesh before texturing.

      if (!sAB) {                        // sBC + sCA: fan from C
        const mBC = getMidpoint(verts, midCache, b, c, posCanonMap);
        const mCA = getMidpoint(verts, midCache, c, a, posCanonMap);
        nextIndices[wi++] = a;   nextIndices[wi++] = b;   nextIndices[wi++] = mBC;
        nextIndices[wi++] = a;   nextIndices[wi++] = mBC; nextIndices[wi++] = mCA;
        nextIndices[wi++] = c;   nextIndices[wi++] = mCA; nextIndices[wi++] = mBC;
      } else if (!sBC) {                 // sAB + sCA: fan from A
        const mAB = getMidpoint(verts, midCache, a, b, posCanonMap);
        const mCA = getMidpoint(verts, midCache, c, a, posCanonMap);
        nextIndices[wi++] = a;   nextIndices[wi++] = mAB; nextIndices[wi++] = mCA;
        nextIndices[wi++] = mAB; nextIndices[wi++] = b;   nextIndices[wi++] = c;
        nextIndices[wi++] = mAB; nextIndices[wi++] = c;   nextIndices[wi++] = mCA;
      } else {                           // sAB + sBC: fan from B
        const mAB = getMidpoint(verts, midCache, a, b, posCanonMap);
        const mBC = getMidpoint(verts, midCache, b, c, posCanonMap);
        nextIndices[wi++] = b;   nextIndices[wi++] = mBC; nextIndices[wi++] = mAB;
        nextIndices[wi++] = a;   nextIndices[wi++] = mAB; nextIndices[wi++] = mBC;
        nextIndices[wi++] = a;   nextIndices[wi++] = mBC; nextIndices[wi++] = c;
      }
      for (let k = 0; k < 3; k++) {
        if (nextFaceExcluded) nextFaceExcluded[fi] = excl;
        if (nextFaceParentId) nextFaceParentId[fi] = pid;
        fi++;
      }
    }
  }

  return { newIndices: nextIndices, newFaceExcluded: nextFaceExcluded, newFaceParentId: nextFaceParentId, changed: true };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function edgeLenSq(pos, a, b) {
  const dx = pos[a*3]   - pos[b*3];
  const dy = pos[a*3+1] - pos[b*3+1];
  const dz = pos[a*3+2] - pos[b*3+2];
  return dx*dx + dy*dy + dz*dz;
}

function getMidpoint(verts, cache, a, b, posCanonMap) {
  const lo = a < b ? a : b, hi = a < b ? b : a;
  const cached = cache.get(lo, hi, 0);
  if (cached !== -1) return cached;

  const pos = verts.pos, nrm = verts.nrm;

  // Midpoint position
  const mx = (pos[a*3]   + pos[b*3])   / 2;
  const my = (pos[a*3+1] + pos[b*3+1]) / 2;
  const mz = (pos[a*3+2] + pos[b*3+2]) / 2;

  // Midpoint normal (average + normalise)
  const nx = nrm[a*3]   + nrm[b*3];
  const ny = nrm[a*3+1] + nrm[b*3+1];
  const nz = nrm[a*3+2] + nrm[b*3+2];
  const nl = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;

  const idx = verts.count;
  if (idx === verts.cap) verts.grow();
  verts.pos[idx*3] = mx; verts.pos[idx*3+1] = my; verts.pos[idx*3+2] = mz;
  verts.nrm[idx*3] = nx / nl; verts.nrm[idx*3+1] = ny / nl; verts.nrm[idx*3+2] = nz / nl;
  if (verts.wgt) verts.wgt[idx] = (verts.wgt[a] + verts.wgt[b]) / 2;

  // Maintain canonical position ids when in accurate (export) mode.
  if (verts.canon) {
    verts.canon[idx] = posCanonMap.getOrSet(mx, my, mz, idx);
  }
  verts.count = idx + 1;

  cache.getOrSet(lo, hi, 0, idx);
  return idx;
}

// ── Fast non-indexed → indexed (preview path) ──────────────────────────────
// Simple position-only merge — no cluster detection, no sharp-edge splitting.
// Much faster than toIndexed() on high-poly meshes like the 3DBenchy.

function toIndexedFast(geometry, nonIndexedWeights = null) {
  const posAttr = geometry.attributes.position;
  const nrmAttr = geometry.attributes.normal;
  const n = posAttr.count;
  const vertMap = new QuantizedPointMap(QUANTISE, Math.min(n, 1 << 22));
  const indices = new Uint32Array(n);
  // nrm accumulates raw normal sums during the merge and is normalised in
  // place afterwards (the pre-normalisation values are never read).
  const verts = makeVertStore(Math.max(16, Math.min(1 << 16, n)), !!nonIndexedWeights, false);

  for (let i = 0; i < n; i++) {
    const px = posAttr.getX(i);
    const py = posAttr.getY(i);
    const pz = posAttr.getZ(i);
    const nx_ = nrmAttr ? nrmAttr.getX(i) : 0;
    const ny_ = nrmAttr ? nrmAttr.getY(i) : 0;
    const nz_ = nrmAttr ? nrmAttr.getZ(i) : 1;

    const idx = vertMap.getOrSet(px, py, pz, verts.count);
    if (vertMap.inserted) {
      if (verts.count === verts.cap) verts.grow();
      verts.pos[idx*3] = px; verts.pos[idx*3+1] = py; verts.pos[idx*3+2] = pz;
      verts.nrm[idx*3] = nx_; verts.nrm[idx*3+1] = ny_; verts.nrm[idx*3+2] = nz_;
      if (verts.wgt) verts.wgt[idx] = nonIndexedWeights[i];
      verts.count++;
    } else {
      verts.nrm[idx * 3]     += nx_;
      verts.nrm[idx * 3 + 1] += ny_;
      verts.nrm[idx * 3 + 2] += nz_;
      if (verts.wgt && nonIndexedWeights[i] > verts.wgt[idx]) {
        verts.wgt[idx] = nonIndexedWeights[i];
      }
    }
    indices[i] = idx;
  }

  normalizeStoreNormals(verts);
  return { verts, indices };
}

// Normalise accumulated normal sums in place (shared by both indexers).
function normalizeStoreNormals(verts) {
  const nrm = verts.nrm;
  for (let i = 0; i < verts.count; i++) {
    const nx = nrm[i * 3];
    const ny = nrm[i * 3 + 1];
    const nz = nrm[i * 3 + 2];
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nrm[i * 3]     = nx / len;
    nrm[i * 3 + 1] = ny / len;
    nrm[i * 3 + 2] = nz / len;
  }
}

// ── Non-indexed → indexed conversion (export path) ──────────────────────────

// nonIndexedWeights: optional Float32Array(vertexCount) where vertex i has
// weight = 1.0 if its triangle (floor(i/3)) is user-excluded, else 0.
// When multiple original vertices map to the same indexed vertex, the MAX
// weight wins (conservative: any excluded face marks the shared vertex).
function toIndexed(geometry, nonIndexedWeights = null) {
  const posAttr = geometry.attributes.position;
  const n = posAttr.count;

  // ── Pre-compute per-face normals (unit + raw cross product) ──────────────
  const faceNrmUnit = new Float32Array(n * 3);
  const faceNrmRaw  = new Float32Array(n * 3);
  for (let t = 0; t < n; t += 3) {
    const ax = posAttr.getX(t),   ay = posAttr.getY(t),   az = posAttr.getZ(t);
    const bx = posAttr.getX(t+1), by = posAttr.getY(t+1), bz = posAttr.getZ(t+1);
    const cx = posAttr.getX(t+2), cy = posAttr.getY(t+2), cz = posAttr.getZ(t+2);
    const e1x = bx-ax, e1y = by-ay, e1z = bz-az;
    const e2x = cx-ax, e2y = cy-ay, e2z = cz-az;
    const rx = e1y*e2z - e1z*e2y;
    const ry = e1z*e2x - e1x*e2z;
    const rz = e1x*e2y - e1y*e2x;
    const len = Math.sqrt(rx*rx + ry*ry + rz*rz) || 1;
    const ux = rx/len, uy = ry/len, uz = rz/len;
    for (let v = 0; v < 3; v++) {
      faceNrmUnit[(t+v)*3]   = ux;
      faceNrmUnit[(t+v)*3+1] = uy;
      faceNrmUnit[(t+v)*3+2] = uz;
      faceNrmRaw[(t+v)*3]    = rx;
      faceNrmRaw[(t+v)*3+1]  = ry;
      faceNrmRaw[(t+v)*3+2]  = rz;
    }
  }

  // ── Merge vertices, splitting at sharp dihedral edges ───────────────────
  // Two vertices at the same position merge into one indexed vertex only when
  // their face normals are within SHARP_ANGLE of each other.  This keeps
  // smooth-surface normals averaged across facet boundaries (cylinder, sphere)
  // while preventing the 45° edge-normal tilt from propagating into flat-face
  // interiors during subdivision (cube, box).
  const SHARP_COS = Math.cos(30 * Math.PI / 180);

  const indices = new Uint32Array(n);
  // nrm accumulates raw (area-weighted) normal sums during the merge and is
  // normalised in place afterwards; canon holds the canonical position ids.
  const verts = makeVertStore(Math.max(16, Math.min(1 << 16, n)), !!nonIndexedWeights, true);
  // position → first vertex idx at that position (canonical ID)
  const posCanonMap = new QuantizedPointMap(QUANTISE, Math.min(n, 1 << 22));
  // canonical ID → [{idx, fnU: [x,y,z]}] smooth-group clusters at that position
  const clustersByCanon = new Map();

  for (let i = 0; i < n; i++) {
    const px = posAttr.getX(i);
    const py = posAttr.getY(i);
    const pz = posAttr.getZ(i);
    const fnUx = faceNrmUnit[i*3], fnUy = faceNrmUnit[i*3+1], fnUz = faceNrmUnit[i*3+2];
    const fnRx = faceNrmRaw[i*3],  fnRy = faceNrmRaw[i*3+1],  fnRz = faceNrmRaw[i*3+2];

    // The first vertex at a new position becomes its canonical ID.
    const canonId = posCanonMap.getOrSet(px, py, pz, verts.count);
    const clusters = posCanonMap.inserted ? undefined : clustersByCanon.get(canonId);
    if (clusters) {
      let matched = false;
      for (const cl of clusters) {
        const dot = cl.fnU[0]*fnUx + cl.fnU[1]*fnUy + cl.fnU[2]*fnUz;
        if (dot >= SHARP_COS) {
          // Same smooth group – accumulate area-weighted face normal
          const idx = cl.idx;
          verts.nrm[idx*3]   += fnRx;
          verts.nrm[idx*3+1] += fnRy;
          verts.nrm[idx*3+2] += fnRz;
          if (verts.wgt && nonIndexedWeights[i] > verts.wgt[idx]) {
            verts.wgt[idx] = nonIndexedWeights[i];
          }
          // Update the cluster representative to the running average direction
          // so gradual curvature on smooth surfaces (benchy hull, cylinders)
          // stays in one cluster instead of fragmenting when faces far from the
          // seed happen to exceed 30° from the seed's fixed normal.
          cl.fnU[0] += fnUx;
          cl.fnU[1] += fnUy;
          cl.fnU[2] += fnUz;
          const rl = Math.sqrt(cl.fnU[0]*cl.fnU[0] + cl.fnU[1]*cl.fnU[1] + cl.fnU[2]*cl.fnU[2]) || 1;
          cl.fnU[0] /= rl; cl.fnU[1] /= rl; cl.fnU[2] /= rl;
          indices[i] = idx;
          matched = true;
          break;
        }
      }
      if (!matched) {
        // New cluster at this position (sharp-edge split)
        const idx = verts.count;
        if (idx === verts.cap) verts.grow();
        verts.pos[idx*3] = px;   verts.pos[idx*3+1] = py;   verts.pos[idx*3+2] = pz;
        verts.nrm[idx*3] = fnRx; verts.nrm[idx*3+1] = fnRy; verts.nrm[idx*3+2] = fnRz;
        if (verts.wgt) verts.wgt[idx] = nonIndexedWeights[i];
        verts.canon[idx] = canonId;  // same canonical position ID
        verts.count++;
        clusters.push({idx, fnU: [fnUx, fnUy, fnUz]});
        indices[i] = idx;
      }
    } else {
      const idx = verts.count;   // === canonId (just inserted above)
      if (idx === verts.cap) verts.grow();
      verts.pos[idx*3] = px;   verts.pos[idx*3+1] = py;   verts.pos[idx*3+2] = pz;
      verts.nrm[idx*3] = fnRx; verts.nrm[idx*3+1] = fnRy; verts.nrm[idx*3+2] = fnRz;
      if (verts.wgt) verts.wgt[idx] = nonIndexedWeights[i];
      verts.canon[idx] = canonId;
      verts.count++;
      clustersByCanon.set(canonId, [{idx, fnU: [fnUx, fnUy, fnUz]}]);
      indices[i] = idx;
    }
  }

  normalizeStoreNormals(verts);
  return { verts, indices, posCanonMap };
}

// ── Indexed → non-indexed ────────────────────────────────────────────────────

function toNonIndexed(verts, indices, faceExcluded = null) {
  const positions = verts.pos, normals = verts.nrm, weights = verts.wgt;
  const triCount  = indices.length / 3;
  const posArray  = new Float32Array(triCount * 9);
  const nrmArray  = new Float32Array(triCount * 9);
  const wgtArray  = (faceExcluded || weights) ? new Float32Array(triCount * 3) : null;

  for (let t = 0; t < triCount; t++) {
    // Use the binary faceExcluded flag (tracked accurately through subdivision)
    // rather than the interpolated weights[vidx].  The interpolated weights can
    // be pushed to 1.0 on included faces via the MAX-merge in toIndexed: if an
    // included face shares edges with TWO excluded neighbours all three of its
    // vertices are merged to weight 1.0, making its average exceed the 0.99
    // threshold and falsely excluding it from displacement.
    const faceW = faceExcluded ? (faceExcluded[t] ? 1.0 : 0.0) : null;
    for (let v = 0; v < 3; v++) {
      const vidx = indices[t * 3 + v];
      posArray[t * 9 + v * 3]     = positions[vidx * 3];
      posArray[t * 9 + v * 3 + 1] = positions[vidx * 3 + 1];
      posArray[t * 9 + v * 3 + 2] = positions[vidx * 3 + 2];

      nrmArray[t * 9 + v * 3]     = normals[vidx * 3];
      nrmArray[t * 9 + v * 3 + 1] = normals[vidx * 3 + 1];
      nrmArray[t * 9 + v * 3 + 2] = normals[vidx * 3 + 2];

      if (wgtArray) wgtArray[t * 3 + v] = faceW !== null ? faceW : weights[vidx];
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
  geo.setAttribute('normal',   new THREE.BufferAttribute(nrmArray, 3));
  if (wgtArray) geo.setAttribute('excludeWeight', new THREE.BufferAttribute(wgtArray, 1));
  return geo;
}
