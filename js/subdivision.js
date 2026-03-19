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

const QUANTISE   = 1e4;
const SAFETY_CAP = 10_000_000; // absolute OOM guard

// ── Public entry point ───────────────────────────────────────────────────────

export async function subdivide(geometry, maxEdgeLength, onProgress, faceWeights = null) {
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

  const { positions, normals, weights, indices } = toIndexed(geometry, faceWeights);

  const maxIterations = 12;
  let currentIndices = indices;
  let currentFaceExcluded = initialFaceExcluded;
  let safetyCapHit = false;

  for (let iter = 0; iter < maxIterations; iter++) {
    const triCount = currentIndices.length / 3;
    if (triCount >= SAFETY_CAP) {
      safetyCapHit = true;
      break;
    }

    const { newIndices, newFaceExcluded, changed } = subdividePass(
      positions, normals, weights, currentIndices, maxEdgeLength, SAFETY_CAP, currentFaceExcluded
    );
    currentIndices = newIndices;
    if (newFaceExcluded) currentFaceExcluded = newFaceExcluded;

    if (newIndices.length / 3 >= SAFETY_CAP) safetyCapHit = true;

    if (onProgress) onProgress(Math.min(0.95, (iter + 1) / maxIterations));
    await new Promise(r => setTimeout(r, 0));
    if (!changed || safetyCapHit) break;
  }

  return { geometry: toNonIndexed(positions, normals, weights, currentIndices, currentFaceExcluded), safetyCapHit };
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

function subdividePass(positions, normals, weights, indices, maxEdgeLength, safetyCap, faceExcluded = null) {
  const maxSq = maxEdgeLength * maxEdgeLength;
  const midCache = new Map();

  // ── Step 1: globally mark edges that need splitting ─────────────────────
  // Excluded triangles do NOT proactively mark their own edges – their
  // interior edges will never be split, saving triangles on untextured
  // regions.  Boundary edges are still marked by the included neighbour, so
  // excluded triangles respond to those splits and T-junctions are avoided.
  const splitEdges = new Set();
  for (let t = 0; t < indices.length; t += 3) {
    if (faceExcluded && faceExcluded[t / 3]) continue; // skip excluded faces
    const a = indices[t], b = indices[t + 1], c = indices[t + 2];
    if (edgeLenSq(positions, a, b) > maxSq) splitEdges.add(edgeKey(a, b));
    if (edgeLenSq(positions, b, c) > maxSq) splitEdges.add(edgeKey(b, c));
    if (edgeLenSq(positions, c, a) > maxSq) splitEdges.add(edgeKey(c, a));
  }

  if (splitEdges.size === 0) return { newIndices: indices, newFaceExcluded: faceExcluded, changed: false };

  // ── Step 2: rebuild index list ───────────────────────────────────────────
  const nextIndices = [];
  const nextFaceExcluded = faceExcluded ? [] : null;

  for (let t = 0; t < indices.length; t += 3) {
    // Safety cap: stop splitting, carry remaining triangles as-is
    if (nextIndices.length / 3 >= safetyCap) {
      for (let r = t; r < indices.length; r++) nextIndices.push(indices[r]);
      // Carry remaining face-exclusion flags as-is
      if (nextFaceExcluded && faceExcluded) {
        for (let r = t / 3; r < indices.length / 3; r++) nextFaceExcluded.push(faceExcluded[r]);
      }
      break;
    }

    const a = indices[t], b = indices[t + 1], c = indices[t + 2];
    const fIdx = t / 3;
    const excl = faceExcluded ? faceExcluded[fIdx] : 0;
    const sAB = splitEdges.has(edgeKey(a, b));
    const sBC = splitEdges.has(edgeKey(b, c));
    const sCA = splitEdges.has(edgeKey(c, a));
    const n   = (sAB ? 1 : 0) + (sBC ? 1 : 0) + (sCA ? 1 : 0);

    if (n === 0) {
      // ── 0-split: keep triangle ─────────────────────────────────────────
      nextIndices.push(a, b, c);
      if (nextFaceExcluded) nextFaceExcluded.push(excl);

    } else if (n === 3) {
      // ── 3-split: 1→4 regular midpoint subdivision ──────────────────────
      //
      //        a
      //       / \
      //     mCA─mAB
      //     / \ / \
      //    c─mBC───b
      //
      const mAB = getMidpoint(positions, normals, weights, midCache, a, b);
      const mBC = getMidpoint(positions, normals, weights, midCache, b, c);
      const mCA = getMidpoint(positions, normals, weights, midCache, c, a);
      nextIndices.push(
        a,   mAB, mCA,
        mAB, b,   mBC,
        mCA, mBC, c,
        mAB, mBC, mCA,
      );
      if (nextFaceExcluded) nextFaceExcluded.push(excl, excl, excl, excl);

    } else if (n === 1) {
      // ── 1-split: bisect the one marked edge → 2 sub-triangles ──────────
      if (sAB) {
        const m = getMidpoint(positions, normals, weights, midCache, a, b);
        nextIndices.push(a, m, c,  m, b, c);
        if (nextFaceExcluded) nextFaceExcluded.push(excl, excl);
      } else if (sBC) {
        const m = getMidpoint(positions, normals, weights, midCache, b, c);
        nextIndices.push(a, b, m,  a, m, c);
        if (nextFaceExcluded) nextFaceExcluded.push(excl, excl);
      } else {                           // sCA
        const m = getMidpoint(positions, normals, weights, midCache, c, a);
        nextIndices.push(a, b, m,  m, b, c);
        if (nextFaceExcluded) nextFaceExcluded.push(excl, excl);
      }

    } else {
      // ── 2-split: 3 sub-triangles, fan from the untouched-edge vertex ───
      //
      // For each case the unsplit-edge vertex forms a small corner triangle
      // with its two adjacent midpoints; the remaining quadrilateral is
      // split along the diagonal that connects those two midpoints to the
      // opposite vertices, preserving consistent CCW winding throughout.

      if (!sAB) {                        // sBC + sCA: fan from C
        const mBC = getMidpoint(positions, normals, weights, midCache, b, c);
        const mCA = getMidpoint(positions, normals, weights, midCache, c, a);
        nextIndices.push(
          a,   b,   mBC,
          a,   mBC, mCA,
          c,   mCA, mBC,
        );
        if (nextFaceExcluded) nextFaceExcluded.push(excl, excl, excl);
      } else if (!sBC) {                 // sAB + sCA: fan from A
        const mAB = getMidpoint(positions, normals, weights, midCache, a, b);
        const mCA = getMidpoint(positions, normals, weights, midCache, c, a);
        nextIndices.push(
          a,   mAB, mCA,
          mAB, b,   c,
          mAB, c,   mCA,
        );
        if (nextFaceExcluded) nextFaceExcluded.push(excl, excl, excl);
      } else {                           // sAB + sBC: fan from B
        const mAB = getMidpoint(positions, normals, weights, midCache, a, b);
        const mBC = getMidpoint(positions, normals, weights, midCache, b, c);
        nextIndices.push(
          b,   mBC, mAB,
          a,   mAB, mBC,
          a,   mBC, c,
        );
        if (nextFaceExcluded) nextFaceExcluded.push(excl, excl, excl);
      }
    }
  }

  return { newIndices: nextIndices, newFaceExcluded: nextFaceExcluded, changed: true };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Canonical order key for an undirected edge – matches the getMidpoint cache key. */
function edgeKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function edgeLenSq(pos, a, b) {
  const dx = pos[a*3]   - pos[b*3];
  const dy = pos[a*3+1] - pos[b*3+1];
  const dz = pos[a*3+2] - pos[b*3+2];
  return dx*dx + dy*dy + dz*dz;
}

function getMidpoint(positions, normals, weights, cache, a, b) {
  const key = a < b ? `${a}:${b}` : `${b}:${a}`;
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
  // Interpolate exclusion weight: 0 = included, 1 = excluded.
  // A midpoint between two excluded vertices → 1.0; between mixed → 0.5
  // (displacement.js treats > 0.5 average as excluded for the face).
  if (weights) weights.push((weights[a] + weights[b]) / 2);
  cache.set(key, idx);
  return idx;
}

// ── Non-indexed → indexed conversion ────────────────────────────────────────

// nonIndexedWeights: optional Float32Array(vertexCount) where vertex i has
// weight = 1.0 if its triangle (floor(i/3)) is user-excluded, else 0.
// When multiple original vertices map to the same indexed vertex, the MAX
// weight wins (conservative: any excluded face marks the shared vertex).
function toIndexed(geometry, nonIndexedWeights = null) {
  const posAttr = geometry.attributes.position;
  const nrmAttr = geometry.attributes.normal;

  const positions = [];
  const normals   = [];
  const normalSums = [];
  const weights   = nonIndexedWeights ? [] : null;
  const indices   = [];
  const vertMap   = new Map();

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
        // MAX: if any incident original face was excluded, the shared vertex is excluded
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
