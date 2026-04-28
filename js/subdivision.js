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

import * as THREE from 'three';

// 10 µm vertex-dedup cells. Below 1e5 (= 100 µm) small-fillet meshes have
// distinct fillet vertices that round to the same key and merge incorrectly,
// producing zero-length edges and non-manifold artifacts after displacement.
// 1e5 still tolerates float32 round-trip noise (~1e-4 mm worst case at metre
// scales) so well-formed inputs continue to dedup cleanly.
const QUANTISE   = 1e5;
const SAFETY_CAP = 20_000_000; // absolute OOM guard

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
  const { positions, normals, weights, indices } = indexed;
  const canonIdx    = indexed.canonIdx    || null;
  const posCanonMap = indexed.posCanonMap || null;

  const maxIterations = 12;
  let currentIndices = indices;
  let currentFaceExcluded = initialFaceExcluded;
  let safetyCapHit = false;

  // Track which original face each subdivided face descends from.
  const initialTriCount = indices.length / 3;
  let currentFaceParentId = new Array(initialTriCount);
  for (let i = 0; i < initialTriCount; i++) currentFaceParentId[i] = i;

  for (let iter = 0; iter < maxIterations; iter++) {
    const triCount = currentIndices.length / 3;
    if (triCount >= SAFETY_CAP) {
      safetyCapHit = true;
      break;
    }

    // Find longest edge for progress reporting
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

    const { newIndices, newFaceExcluded, newFaceParentId, changed } = subdividePass(
      positions, normals, weights, currentIndices, maxEdgeLength, SAFETY_CAP, currentFaceExcluded,
      canonIdx, posCanonMap, currentFaceParentId
    );
    currentIndices = newIndices;
    if (newFaceExcluded) currentFaceExcluded = newFaceExcluded;
    if (newFaceParentId) currentFaceParentId = newFaceParentId;

    if (newIndices.length / 3 >= SAFETY_CAP) safetyCapHit = true;

    const newTriCount = newIndices.length / 3;
    if (onProgress) onProgress(Math.min(0.95, (iter + 1) / maxIterations), newTriCount, longestEdge);
    // Yield once per subdivision pass (not per iteration) — keeps background tabs fast
    await new Promise(r => setTimeout(r, 0));
    if (!changed || safetyCapHit) break;
  }

  return {
    geometry: toNonIndexed(positions, normals, weights, currentIndices, currentFaceExcluded),
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

function subdividePass(positions, normals, weights, indices, maxEdgeLength, safetyCap, faceExcluded = null, canonIdx = null, posCanonMap = null, faceParentId = null) {
  const maxSq = maxEdgeLength * maxEdgeLength;
  const midCache = new Map();
  midCache._maxV = positions.length / 3; // set before any getMidpoint calls

  // When canonIdx is available (accurate/export mode), use position-canonical
  // edge keys so split-vertex faces on both sides of a sharp edge see the same
  // split decision.  Otherwise (fast/preview mode) use simple index-based keys.
  // NOTE: _maxV is computed once at pass start. During the pass, positions grows
  // via getMidpoint, but splitEdges and midCache only use indices < _maxV.
  const _maxV = positions.length / 3;
  const _edgeKey = canonIdx
    ? (a, b) => { const ca = canonIdx[a], cb = canonIdx[b]; return ca < cb ? ca * _maxV + cb : cb * _maxV + ca; }
    : (a, b) => a < b ? a * _maxV + b : b * _maxV + a;

  // ── Step 1: globally mark edges that need splitting ─────────────────────
  // Excluded triangles do NOT proactively mark their own edges – their
  // interior edges will never be split, saving triangles on untextured
  // regions.  Boundary edges are still marked by the included neighbour, so
  // excluded triangles respond to those splits and T-junctions are avoided.
  const splitEdges = new Set();
  for (let t = 0; t < indices.length; t += 3) {
    if (faceExcluded && faceExcluded[t / 3]) continue; // skip excluded faces
    const a = indices[t], b = indices[t + 1], c = indices[t + 2];
    if (edgeLenSq(positions, a, b) > maxSq) splitEdges.add(_edgeKey(a, b));
    if (edgeLenSq(positions, b, c) > maxSq) splitEdges.add(_edgeKey(b, c));
    if (edgeLenSq(positions, c, a) > maxSq) splitEdges.add(_edgeKey(c, a));
  }

  if (splitEdges.size === 0) return { newIndices: indices, newFaceExcluded: faceExcluded, newFaceParentId: faceParentId, changed: false };

  // ── Step 2: rebuild index list ───────────────────────────────────────────
  const nextIndices = [];
  const nextFaceExcluded = faceExcluded ? [] : null;
  const nextFaceParentId = faceParentId ? [] : null;

  for (let t = 0; t < indices.length; t += 3) {
    // Safety cap: stop splitting, carry remaining triangles as-is
    if (nextIndices.length / 3 >= safetyCap) {
      for (let r = t; r < indices.length; r++) nextIndices.push(indices[r]);
      // Carry remaining face-exclusion flags as-is
      if (nextFaceExcluded && faceExcluded) {
        for (let r = t / 3; r < indices.length / 3; r++) nextFaceExcluded.push(faceExcluded[r]);
      }
      if (nextFaceParentId && faceParentId) {
        for (let r = t / 3; r < indices.length / 3; r++) nextFaceParentId.push(faceParentId[r]);
      }
      break;
    }

    const a = indices[t], b = indices[t + 1], c = indices[t + 2];
    const fIdx = t / 3;
    const excl = faceExcluded ? faceExcluded[fIdx] : 0;
    const pid  = faceParentId ? faceParentId[fIdx] : 0;
    const sAB = splitEdges.has(_edgeKey(a, b));
    const sBC = splitEdges.has(_edgeKey(b, c));
    const sCA = splitEdges.has(_edgeKey(c, a));
    const n   = (sAB ? 1 : 0) + (sBC ? 1 : 0) + (sCA ? 1 : 0);

    if (n === 0) {
      // ── 0-split: keep triangle ─────────────────────────────────────────
      nextIndices.push(a, b, c);
      if (nextFaceExcluded) nextFaceExcluded.push(excl);
      if (nextFaceParentId) nextFaceParentId.push(pid);

    } else if (n === 3) {
      // ── 3-split: 1→4 regular midpoint subdivision ──────────────────────
      //
      //        a
      //       / \
      //     mCA─mAB
      //     / \ / \
      //    c─mBC───b
      //
      const mAB = getMidpoint(positions, normals, weights, midCache, a, b, canonIdx, posCanonMap);
      const mBC = getMidpoint(positions, normals, weights, midCache, b, c, canonIdx, posCanonMap);
      const mCA = getMidpoint(positions, normals, weights, midCache, c, a, canonIdx, posCanonMap);
      nextIndices.push(
        a,   mAB, mCA,
        mAB, b,   mBC,
        mCA, mBC, c,
        mAB, mBC, mCA,
      );
      if (nextFaceExcluded) nextFaceExcluded.push(excl, excl, excl, excl);
      if (nextFaceParentId) nextFaceParentId.push(pid, pid, pid, pid);

    } else if (n === 1) {
      // ── 1-split: bisect the one marked edge → 2 sub-triangles ──────────
      if (sAB) {
        const m = getMidpoint(positions, normals, weights, midCache, a, b, canonIdx, posCanonMap);
        nextIndices.push(a, m, c,  m, b, c);
        if (nextFaceExcluded) nextFaceExcluded.push(excl, excl);
        if (nextFaceParentId) nextFaceParentId.push(pid, pid);
      } else if (sBC) {
        const m = getMidpoint(positions, normals, weights, midCache, b, c, canonIdx, posCanonMap);
        nextIndices.push(a, b, m,  a, m, c);
        if (nextFaceExcluded) nextFaceExcluded.push(excl, excl);
        if (nextFaceParentId) nextFaceParentId.push(pid, pid);
      } else {                           // sCA
        const m = getMidpoint(positions, normals, weights, midCache, c, a, canonIdx, posCanonMap);
        nextIndices.push(a, b, m,  m, b, c);
        if (nextFaceExcluded) nextFaceExcluded.push(excl, excl);
        if (nextFaceParentId) nextFaceParentId.push(pid, pid);
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
        const mBC = getMidpoint(positions, normals, weights, midCache, b, c, canonIdx, posCanonMap);
        const mCA = getMidpoint(positions, normals, weights, midCache, c, a, canonIdx, posCanonMap);
        nextIndices.push(
          a,   b,   mBC,
          a,   mBC, mCA,
          c,   mCA, mBC,
        );
        if (nextFaceExcluded) nextFaceExcluded.push(excl, excl, excl);
        if (nextFaceParentId) nextFaceParentId.push(pid, pid, pid);
      } else if (!sBC) {                 // sAB + sCA: fan from A
        const mAB = getMidpoint(positions, normals, weights, midCache, a, b, canonIdx, posCanonMap);
        const mCA = getMidpoint(positions, normals, weights, midCache, c, a, canonIdx, posCanonMap);
        nextIndices.push(
          a,   mAB, mCA,
          mAB, b,   c,
          mAB, c,   mCA,
        );
        if (nextFaceExcluded) nextFaceExcluded.push(excl, excl, excl);
        if (nextFaceParentId) nextFaceParentId.push(pid, pid, pid);
      } else {                           // sAB + sBC: fan from B
        const mAB = getMidpoint(positions, normals, weights, midCache, a, b, canonIdx, posCanonMap);
        const mBC = getMidpoint(positions, normals, weights, midCache, b, c, canonIdx, posCanonMap);
        nextIndices.push(
          b,   mBC, mAB,
          a,   mAB, mBC,
          a,   mBC, c,
        );
        if (nextFaceExcluded) nextFaceExcluded.push(excl, excl, excl);
        if (nextFaceParentId) nextFaceParentId.push(pid, pid, pid);
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

function getMidpoint(positions, normals, weights, cache, a, b, canonIdx, posCanonMap) {
  // Numeric edge key: uses _maxV set on the cache by subdividePass at pass start.
  // All lookups use indices < _maxV, so this is safe even as positions grows.
  const _mv = cache._maxV;
  const key = a < b ? a * _mv + b : b * _mv + a;
  if (cache.has(key)) return cache.get(key);

  // Midpoint position
  const mx = (positions[a*3]   + positions[b*3])   / 2;
  const my = (positions[a*3+1] + positions[b*3+1]) / 2;
  const mz = (positions[a*3+2] + positions[b*3+2]) / 2;

  // Midpoint normal (average + normalise)
  const nx = normals[a*3]   + normals[b*3];
  const ny = normals[a*3+1] + normals[b*3+1];
  const nz = normals[a*3+2] + normals[b*3+2];
  const nl = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;

  const idx = (positions.length / 3) | 0;
  positions.push(mx, my, mz);
  normals.push(nx / nl, ny / nl, nz / nl);
  if (weights) weights.push((weights[a] + weights[b]) / 2);

  // Maintain canonIdx when in accurate (export) mode.
  if (canonIdx) {
    const pk = `${Math.round(mx * QUANTISE)}_${Math.round(my * QUANTISE)}_${Math.round(mz * QUANTISE)}`;
    let cid = posCanonMap.get(pk);
    if (cid === undefined) {
      cid = idx;
      posCanonMap.set(pk, cid);
    }
    canonIdx.push(cid);
  }

  cache.set(key, idx);
  return idx;
}

// ── Fast non-indexed → indexed (preview path) ──────────────────────────────
// Simple position-only merge — no cluster detection, no sharp-edge splitting.
// Much faster than toIndexed() on high-poly meshes like the 3DBenchy.

function toIndexedFast(geometry, nonIndexedWeights = null) {
  const posAttr = geometry.attributes.position;
  const nrmAttr = geometry.attributes.normal;
  const positions  = [];
  const normals    = [];
  const normalSums = [];
  const weights    = nonIndexedWeights ? [] : null;
  const indices    = [];
  const vertMap    = new Map();

  const n = posAttr.count;
  for (let i = 0; i < n; i++) {
    const px = posAttr.getX(i);
    const py = posAttr.getY(i);
    const pz = posAttr.getZ(i);
    const nx_ = nrmAttr ? nrmAttr.getX(i) : 0;
    const ny_ = nrmAttr ? nrmAttr.getY(i) : 0;
    const nz_ = nrmAttr ? nrmAttr.getZ(i) : 1;

    const key = `${Math.round(px * QUANTISE)}_${Math.round(py * QUANTISE)}_${Math.round(pz * QUANTISE)}`;
    let idx = vertMap.get(key);
    if (idx === undefined) {
      idx = positions.length / 3;
      positions.push(px, py, pz);
      normals.push(nx_, ny_, nz_);
      normalSums.push(nx_, ny_, nz_);
      if (weights) weights.push(nonIndexedWeights[i]);
      vertMap.set(key, idx);
    } else {
      normalSums[idx * 3]     += nx_;
      normalSums[idx * 3 + 1] += ny_;
      normalSums[idx * 3 + 2] += nz_;
      if (weights && nonIndexedWeights[i] > weights[idx]) {
        weights[idx] = nonIndexedWeights[i];
      }
    }
    indices.push(idx);
  }

  for (let i = 0; i < positions.length / 3; i++) {
    const nx = normalSums[i * 3];
    const ny = normalSums[i * 3 + 1];
    const nz = normalSums[i * 3 + 2];
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    normals[i * 3]     = nx / len;
    normals[i * 3 + 1] = ny / len;
    normals[i * 3 + 2] = nz / len;
  }

  return { positions, normals, weights, indices };
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

  const positions  = [];
  const normals    = [];
  const normalSums = [];
  const weights    = nonIndexedWeights ? [] : null;
  const indices    = [];
  const canonIdx   = [];            // vertex idx → canonical position ID
  const posCanonMap = new Map();    // posKey → first vertex idx at that position
  const vertMap    = new Map();     // posKey → [{idx, fnU: [x,y,z]}]

  for (let i = 0; i < n; i++) {
    const px = posAttr.getX(i);
    const py = posAttr.getY(i);
    const pz = posAttr.getZ(i);
    const fnUx = faceNrmUnit[i*3], fnUy = faceNrmUnit[i*3+1], fnUz = faceNrmUnit[i*3+2];
    const fnRx = faceNrmRaw[i*3],  fnRy = faceNrmRaw[i*3+1],  fnRz = faceNrmRaw[i*3+2];

    const key = `${Math.round(px * QUANTISE)}_${Math.round(py * QUANTISE)}_${Math.round(pz * QUANTISE)}`;
    let canonId = posCanonMap.get(key);
    const clusters = vertMap.get(key);
    if (clusters) {
      let matched = false;
      for (const cl of clusters) {
        const dot = cl.fnU[0]*fnUx + cl.fnU[1]*fnUy + cl.fnU[2]*fnUz;
        if (dot >= SHARP_COS) {
          // Same smooth group – accumulate area-weighted face normal
          const idx = cl.idx;
          normalSums[idx*3]   += fnRx;
          normalSums[idx*3+1] += fnRy;
          normalSums[idx*3+2] += fnRz;
          if (weights && nonIndexedWeights[i] > weights[idx]) {
            weights[idx] = nonIndexedWeights[i];
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
          indices.push(idx);
          matched = true;
          break;
        }
      }
      if (!matched) {
        // New cluster at this position (sharp-edge split)
        const idx = positions.length / 3;
        positions.push(px, py, pz);
        normals.push(fnRx, fnRy, fnRz);
        normalSums.push(fnRx, fnRy, fnRz);
        if (weights) weights.push(nonIndexedWeights[i]);
        canonIdx.push(canonId);  // same canonical position ID
        clusters.push({idx, fnU: [fnUx, fnUy, fnUz]});
        indices.push(idx);
      }
    } else {
      const idx = positions.length / 3;
      positions.push(px, py, pz);
      normals.push(fnRx, fnRy, fnRz);
      normalSums.push(fnRx, fnRy, fnRz);
      if (weights) weights.push(nonIndexedWeights[i]);
      canonId = idx;                  // first vertex at this position is canonical
      posCanonMap.set(key, canonId);
      canonIdx.push(canonId);
      vertMap.set(key, [{idx, fnU: [fnUx, fnUy, fnUz]}]);
      indices.push(idx);
    }
  }

  for (let i = 0; i < positions.length / 3; i++) {
    const nx = normalSums[i * 3];
    const ny = normalSums[i * 3 + 1];
    const nz = normalSums[i * 3 + 2];
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    normals[i * 3]     = nx / len;
    normals[i * 3 + 1] = ny / len;
    normals[i * 3 + 2] = nz / len;
  }

  return { positions, normals, weights, indices, canonIdx, posCanonMap };
}

// ── Indexed → non-indexed ────────────────────────────────────────────────────

function toNonIndexed(positions, normals, weights, indices, faceExcluded = null) {
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
