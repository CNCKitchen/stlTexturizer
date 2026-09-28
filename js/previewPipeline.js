/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * previewPipeline.js — builds the 3D-preview mesh: the refined geometry whose
 * vertices the displacement vertex shader moves (previewMaterial.js). Pure
 * data in/out like exportPipeline.js, so it runs EITHER inside the preview
 * Web Worker (previewWorker.js) OR on the main thread as a fallback.
 *
 * Sequence (fast-mode subdivision throughout):
 *   pick edge → subdivide → [regularize → re-subdivide] → smooth/face normals
 *
 * The first subdivide brings edges down to the preview edge but creates
 * sliver chains from any CAD-tessellation needles in the input
 * (laserPlate-style fans).  Regularize collapses those slivers, possibly
 * stretching a few edges along the way; the second subdivide brings those
 * back to ≤ edge × secondPassMul for clean displacement sampling.
 */

import { THREE } from './threeCompat.js';
import { QuantizedPointMap } from './meshIndex.js';
import { subdivide } from './subdivision.js';
import { regularizeMesh } from './regularize.js';
import { computeTriEdges, solveBudgetEdge } from './subdivisionEstimate.js';

/**
 * Preview edge length: as fine as the export resolution (`floorEdge`), but
 * coarsened until the predicted first-subdivide triangle count — which drives
 * both build time and the preview's memory — fits `triBudget`.  Never coarser
 * than `maxEdge`.
 */
export function choosePreviewEdge(geometry, { floorEdge, maxEdge, triBudget }) {
  if (!(floorEdge < maxEdge)) return maxEdge;
  const edge = solveBudgetEdge(computeTriEdges(geometry), triBudget, floorEdge);
  return Math.min(edge, maxEdge);
}

/**
 * @param {object} input
 *   positions           Float32Array  non-indexed source mesh (xyz per vertex)
 *   normals             Float32Array|null  its vertex normals
 *   floorEdge, maxEdge, triBudget    edge selection, see choosePreviewEdge
 *   regularize          boolean  run the regularize + re-subdivide pass
 *   regularizeOpts      opts object for regularizeMesh
 *   secondPassMul       re-subdivide edge multiplier
 *   excludedFaces       Uint8Array|null  per source face, 1 = untextured; the
 *                       re-subdivide skips those (they're never displaced)
 * @param {function} [onEvent]      (stage) progress events
 * @param {function} [shouldAbort]  checked between stages; true → return null
 * @returns {Promise<null | {
 *   positions: Float32Array, normals: Float32Array,
 *   smoothNormals: Float32Array, faceNormals: Float32Array,
 *   faceParentId: Int32Array,  // preview face → source face
 *   edge: number,
 * }>}
 */
export async function runPreviewPipeline(input, onEvent = () => {}, shouldAbort = () => false) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(input.positions, 3));
  if (input.normals) geometry.setAttribute('normal', new THREE.BufferAttribute(input.normals, 3));

  const edge = choosePreviewEdge(geometry, input);
  onEvent('subdivide');
  const { geometry: subdivided, faceParentId } = await subdivide(
    geometry, edge, null, null, { fast: true }
  );
  if (shouldAbort()) return null;

  let activeGeo = subdivided, activeParents = faceParentId;
  if (input.regularize) {
    onEvent('regularize');
    const reg = regularizeMesh(subdivided, faceParentId, edge, input.regularizeOpts);
    if (shouldAbort()) return null;

    let weights = null;
    if (input.excludedFaces) {
      const triCount = reg.geometry.attributes.position.count / 3;
      weights = new Float32Array(triCount * 3);
      for (let i = 0; i < triCount; i++) {
        if (input.excludedFaces[reg.faceParentId[i]]) {
          weights[i * 3] = weights[i * 3 + 1] = weights[i * 3 + 2] = 1.0;
        }
      }
    }
    onEvent('subdivide2');
    const { geometry: resub, faceParentId: resubParents } = await subdivide(
      reg.geometry, edge * input.secondPassMul, null, weights, { fast: true }
    );
    if (shouldAbort()) return null;

    // Compose parent maps: resub faces → regularize faces → source faces.
    activeParents = new Int32Array(resubParents.length);
    for (let i = 0; i < resubParents.length; i++) {
      activeParents[i] = reg.faceParentId[resubParents[i]];
    }
    activeGeo = resub;
  }

  onEvent('normals');
  const positions = activeGeo.attributes.position.array;
  const normals   = activeGeo.attributes.normal.array;
  return {
    positions,
    normals,
    smoothNormals: computeSmoothNormals(positions, normals),
    faceNormals:   computeFaceNormals(positions),
    faceParentId:  activeParents,
    edge,
  };
}

/**
 * Flat geometric face normals, repeated on each triangle's three vertices.
 * Unlike `normal` (smooth/interpolated after subdivision), the shader uses
 * these for angle masking so smooth normals at edges don't bleed the mask.
 */
export function computeFaceNormals(pos) {
  const fn = new Float32Array(pos.length);
  for (let o = 0; o < pos.length; o += 9) {
    const e1x = pos[o + 3] - pos[o], e1y = pos[o + 4] - pos[o + 1], e1z = pos[o + 5] - pos[o + 2];
    const e2x = pos[o + 6] - pos[o], e2y = pos[o + 7] - pos[o + 1], e2z = pos[o + 8] - pos[o + 2];
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= len; ny /= len; nz /= len;
    for (let v = 0; v < 9; v += 3) {
      fn[o + v] = nx; fn[o + v + 1] = ny; fn[o + v + 2] = nz;
    }
  }
  return fn;
}

/**
 * Area-weighted smooth normals for a non-indexed mesh.  Every copy of the
 * same position gets the same averaged normal so vertex-shader displacement
 * is watertight.
 *
 * Averages the buffer normals rather than geometric face normals: the
 * subdivision pipeline splits indexed vertices at sharp dihedral edges
 * (>30°), so its interpolated normals are smooth across soft edges (cylinder,
 * sphere) but sharp across hard edges (cube) — no faceting steps on round
 * surfaces, hard edges preserved.
 */
export function computeSmoothNormals(pos, nrm) {
  const count = pos.length / 3;

  // Vertex-dedup pass: assign a numeric ID to each unique quantised position.
  const dedupMap = new QuantizedPointMap(1e4, Math.min(count, 1 << 22));
  let nextId = 0;
  const vertId = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const id = dedupMap.getOrSet(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], nextId);
    if (dedupMap.inserted) nextId++;
    vertId[i] = id;
  }

  const snx = new Float64Array(nextId), sny = new Float64Array(nextId), snz = new Float64Array(nextId);
  for (let i = 0; i < count; i += 3) {
    const o = i * 3;
    const e1x = pos[o + 3] - pos[o], e1y = pos[o + 4] - pos[o + 1], e1z = pos[o + 5] - pos[o + 2];
    const e2x = pos[o + 6] - pos[o], e2y = pos[o + 7] - pos[o + 1], e2z = pos[o + 8] - pos[o + 2];
    const cx = e1y * e2z - e1z * e2y;
    const cy = e1z * e2x - e1x * e2z;
    const cz = e1x * e2y - e1y * e2x;
    const area = Math.sqrt(cx * cx + cy * cy + cz * cz);
    if (area < 1e-12) continue;
    for (let v = 0; v < 3; v++) {
      const vi = i + v;
      const id = vertId[vi];
      snx[id] += nrm[vi * 3]     * area;
      sny[id] += nrm[vi * 3 + 1] * area;
      snz[id] += nrm[vi * 3 + 2] * area;
    }
  }

  for (let id = 0; id < nextId; id++) {
    const len = Math.sqrt(snx[id] * snx[id] + sny[id] * sny[id] + snz[id] * snz[id]) || 1;
    snx[id] /= len; sny[id] /= len; snz[id] /= len;
  }

  const sn = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const id = vertId[i];
    sn[i * 3] = snx[id]; sn[i * 3 + 1] = sny[id]; sn[i * 3 + 2] = snz[id];
  }
  return sn;
}
