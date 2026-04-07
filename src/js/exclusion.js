/**
 * exclusion.js — per-face exclusion masking
 *
 * Provides three capabilities:
 *  1. buildAdjacency   – builds an inter-triangle adjacency list with dihedral
 *                        angles and precomputes per-triangle centroids.
 *  2. bucketFill       – BFS flood fill that respects a max dihedral-angle
 *                        threshold (stops at "sharp" edges).
 *  3. buildExclusionOverlayGeo – compact geometry for the orange preview overlay.
 *  4. buildFaceWeights – per-vertex exclusion weights for the subdivision pass.
 */

import * as THREE from 'three';

const QUANT = 1e4;
const quantKey = (x, y, z) =>
  `${Math.round(x * QUANT)}_${Math.round(y * QUANT)}_${Math.round(z * QUANT)}`;

// ── Adjacency & centroids ─────────────────────────────────────────────────────

/**
 * Build inter-triangle adjacency data for a non-indexed BufferGeometry.
 *
 * @param {THREE.BufferGeometry} geometry  – non-indexed
 * @returns {{
 *   adjacency: Array<Array<{neighbor:number, angle:number}>>,
 *   centroids: Float32Array   (triCount × 3, world-space centroid per triangle)
 * }}
 */
export function buildAdjacency(geometry) {
  const posAttr  = geometry.attributes.position;
  const triCount = posAttr.count / 3;

  // Pre-allocate face normals, centroids, and per-triangle bounding radii
  const faceNormals = new Float32Array(triCount * 3);
  const centroids   = new Float32Array(triCount * 3);
  const boundRadii  = new Float32Array(triCount); // max vertex-to-centroid distance

  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const vC = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const fn = new THREE.Vector3();

  for (let t = 0; t < triCount; t++) {
    const i = t * 3;
    vA.fromBufferAttribute(posAttr, i);
    vB.fromBufferAttribute(posAttr, i + 1);
    vC.fromBufferAttribute(posAttr, i + 2);

    e1.subVectors(vB, vA);
    e2.subVectors(vC, vA);
    fn.crossVectors(e1, e2).normalize();

    faceNormals[i]     = fn.x;
    faceNormals[i + 1] = fn.y;
    faceNormals[i + 2] = fn.z;

    const cx = (vA.x + vB.x + vC.x) / 3;
    const cy = (vA.y + vB.y + vC.y) / 3;
    const cz = (vA.z + vB.z + vC.z) / 3;
    centroids[i]     = cx;
    centroids[i + 1] = cy;
    centroids[i + 2] = cz;
    const dA = (vA.x-cx)**2 + (vA.y-cy)**2 + (vA.z-cz)**2;
    const dB = (vB.x-cx)**2 + (vB.y-cy)**2 + (vB.z-cz)**2;
    const dC = (vC.x-cx)**2 + (vC.y-cy)**2 + (vC.z-cz)**2;
    boundRadii[t] = Math.sqrt(Math.max(dA, dB, dC));
  }

  // Build edge → triangle list (two triangles share an edge iff they share two
  // vertex positions after quantization-based deduplication).
  // Vertex-dedup pass: assign a numeric ID to each unique quantised position.
  const posToId = new Map();
  let nextId = 0;
  const vertId = new Uint32Array(triCount * 3);
  for (let i = 0; i < triCount * 3; i++) {
    const x = posAttr.getX(i), y = posAttr.getY(i), z = posAttr.getZ(i);
    const key = `${Math.round(x*QUANT)}_${Math.round(y*QUANT)}_${Math.round(z*QUANT)}`;
    let id = posToId.get(key);
    if (id === undefined) { id = nextId++; posToId.set(key, id); }
    vertId[i] = id;
  }
  // nextId^2 < MAX_SAFE_INTEGER → safe up to ~94M unique vertices
  const numEdgeKey = (a, b) => a < b ? a * nextId + b : b * nextId + a;

  const edgeMap = new Map();
  const edgePairs = [0, 1, 0, 2, 1, 2]; // vertex-index pairs within triangle

  for (let t = 0; t < triCount; t++) {
    const base = t * 3;
    for (let e = 0; e < 6; e += 2) {
      const ek = numEdgeKey(vertId[base + edgePairs[e]], vertId[base + edgePairs[e + 1]]);
      const entry = edgeMap.get(ek);
      if (entry) entry.push(t);
      else edgeMap.set(ek, [t]);
    }
  }

  // Convert edge map to adjacency list with per-edge dihedral angle
  // Array from buildAdjacency
  const adjacency = new Array(triCount);
  for (let t = 0; t < triCount; t++) adjacency[t] = [];

  for (const [, tris] of edgeMap) {
    if (tris.length !== 2) continue;
    const [a, b] = tris;
    const nAx = faceNormals[a * 3], nAy = faceNormals[a * 3 + 1], nAz = faceNormals[a * 3 + 2];
    const nBx = faceNormals[b * 3], nBy = faceNormals[b * 3 + 1], nBz = faceNormals[b * 3 + 2];
    const dot      = Math.max(-1, Math.min(1, nAx * nBx + nAy * nBy + nAz * nBz));
    const angleDeg = Math.acos(dot) * (180 / Math.PI);
    adjacency[a].push({ neighbor: b, angle: angleDeg });
    adjacency[b].push({ neighbor: a, angle: angleDeg });
  }

  return { adjacency, centroids, boundRadii };
}

// ── Bucket fill ───────────────────────────────────────────────────────────────

/**
 * BFS flood fill starting from seedTriIdx.
 * Spreads across edges whose dihedral angle ≤ thresholdDeg.
 *
 * @param {number} seedTriIdx
 * @param {Array<Array<{neighbor:number, angle:number}>>} adjacency
 * @param {number} thresholdDeg
 * @returns {Set<number>}  set of triangle indices in the filled region
 */
export function bucketFill(seedTriIdx, adjacency, thresholdDeg) {
  const visited = new Set([seedTriIdx]);
  const queue   = [seedTriIdx];
  let head = 0;
  while (head < queue.length) {
    const cur       = queue[head++];
    const neighbors = adjacency[cur];
    if (!neighbors) continue;
    for (const { neighbor, angle } of neighbors) {
      if (!visited.has(neighbor) && angle <= thresholdDeg) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  return visited;
}

// ── Overlay geometry ──────────────────────────────────────────────────────────

/**
 * Build a compact non-indexed BufferGeometry for an overlay.
 *
 * @param {THREE.BufferGeometry} geometry   – non-indexed source geometry
 * @param {Set<number>}          faceSet
 * @param {boolean}              [invert=false]  when true, include faces NOT in faceSet
 * @returns {THREE.BufferGeometry}
 */
export function buildExclusionOverlayGeo(geometry, faceSet, invert = false) {
  const srcPos   = geometry.attributes.position.array;
  const srcNrm   = geometry.attributes.normal ? geometry.attributes.normal.array : null;
  const total    = srcPos.length / 9; // total triangle count
  const isArr    = faceSet instanceof Uint8Array;

  // Count included faces
  let setSize;
  if (isArr) {
    setSize = 0;
    for (let i = 0; i < faceSet.length; i++) if (faceSet[i]) setSize++;
  } else {
    setSize = faceSet.size;
  }
  const count    = invert ? total - setSize : setSize;
  const outPos   = new Float32Array(count * 9);
  const outNrm   = srcNrm ? new Float32Array(count * 9) : null;
  let dst = 0;
  if (invert) {
    for (let t = 0; t < total; t++) {
      if (isArr ? faceSet[t] : faceSet.has(t)) continue;
      const src = t * 9;
      outPos.set(srcPos.subarray(src, src + 9), dst);
      if (outNrm) outNrm.set(srcNrm.subarray(src, src + 9), dst);
      dst += 9;
    }
  } else {
    if (isArr) {
      for (let t = 0; t < faceSet.length; t++) {
        if (!faceSet[t]) continue;
        const src = t * 9;
        outPos.set(srcPos.subarray(src, src + 9), dst);
        if (outNrm) outNrm.set(srcNrm.subarray(src, src + 9), dst);
        dst += 9;
      }
    } else {
      for (const t of faceSet) {
        const src = t * 9;
        outPos.set(srcPos.subarray(src, src + 9), dst);
        if (outNrm) outNrm.set(srcNrm.subarray(src, src + 9), dst);
        dst += 9;
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(outPos, 3));
  if (outNrm) geo.setAttribute('normal', new THREE.BufferAttribute(outNrm, 3));
  return geo;
}

// ── Face-weight array for subdivision ────────────────────────────────────────

/**
 * Build a per-non-indexed-vertex exclusion weight array.
 * Vertex i (in the non-indexed buffer) belongs to triangle floor(i/3).
 * Excluded triangles get weight 1.0, all others 0.0.
 * subdivision.js threads these through edge splits via linear interpolation,
 * producing smooth 0→1 transitions at exclusion boundaries.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {Set<number>}          excludedFaces
 * @returns {Float32Array}  length = geometry.attributes.position.count
 */
export function buildFaceWeights(geometry, excludedFaces, invert = false) {
  const count   = geometry.attributes.position.count;
  const weights = new Float32Array(count); // default 0.0 (included)
  if (invert) {
    // Include-only mode: all faces start excluded (1.0); painted faces are included (0.0)
    weights.fill(1.0);
    for (const t of excludedFaces) {
      weights[t * 3]     = 0.0;
      weights[t * 3 + 1] = 0.0;
      weights[t * 3 + 2] = 0.0;
    }
  } else {
    for (const t of excludedFaces) {
      weights[t * 3]     = 1.0;
      weights[t * 3 + 1] = 1.0;
      weights[t * 3 + 2] = 1.0;
    }
  }
  return weights;
}
