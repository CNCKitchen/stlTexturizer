/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { THREE } from './threeCompat.js';
import { decimate } from './decimation.js';
import { countAreaSlivers } from './meshRepair.js';
import { indexExactPositions } from './exactGeometry.js';
import { QuantizedPointMap } from './meshIndex.js';
import { withinSurfaceTolerance } from './surfaceTolerance.js';

// Optional acceleration: a failed download must not break ordinary exports.
const acceleration = import('three-mesh-bvh')
  .catch(() => import('https://esm.sh/three-mesh-bvh@0.9.1?deps=three@0.170.0'))
  .then(module => module.MeshBVH)
  .catch(() => null);

function inspect(positions, mask = null) {
  const { vertices, indices } = indexExactPositions(positions);
  const vertexCount = vertices.length / 3;
  if (mask && (mask.length !== positions.length / 9 || mask.some(v => v > 1))) {
    throw Error('Invalid face locks');
  }
  const locks = mask ? mask.slice() : new Uint8Array(positions.length / 9);
  const protectedVertices = new Uint8Array(vertexCount);
  const edges = new Map();
  const parents = Int32Array.from({ length: vertexCount }, (_, i) => i);
  const root = i => {
    while (parents[i] !== i) {
      parents[i] = parents[parents[i]];
      i = parents[i];
    }
    return i;
  };

  for (let f = 0; f < indices.length; f += 3) {
    for (let k = 0; k < 3; k++) {
      const a = indices[f + k];
      const b = indices[f + ((k + 1) % 3)];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (a === b) {
        protectedVertices[a] = 1;
      }
      let edge = edges.get(key);
      if (!edge) {
        edge = { a, b, count: 0, winding: 0 };
        edges.set(key, edge);
      }
      edge.count++;
      edge.winding += a < b ? 1 : -1;
      parents[root(a)] = root(b);
    }
  }

  let open = 0;
  let nonManifold = 0;
  let inconsistent = 0;
  for (const edge of edges.values()) {
    if (edge.count !== 2 || edge.winding !== 0) {
      protectedVertices[edge.a] = 1;
      protectedVertices[edge.b] = 1;
    }
    if (edge.count === 1) {
      open++;
    }
    if (edge.count > 2) {
      nonManifold++;
    }
    if (edge.count === 2 && edge.winding !== 0) {
      inconsistent++;
    }
  }

  for (let f = 0; f < locks.length; f++) {
    if (
      protectedVertices[indices[f * 3]] ||
      protectedVertices[indices[f * 3 + 1]] ||
      protectedVertices[indices[f * 3 + 2]]
    ) {
      locks[f] = 1;
    }
  }

  const eulerCharacteristic = vertexCount - edges.size + positions.length / 9;
  const componentCount = new Set(parents.map((_, i) => root(i))).size;
  return {
    locks,
    signature: [open, nonManifold, inconsistent, eulerCharacteristic, componentCount].join(',')
  };
}

function protectedEqual(before, mask, after, afterMask) {
  if (!afterMask) {
    return false;
  }
  const beforeBits = new Uint32Array(before.buffer, before.byteOffset, before.length);
  const afterBits = new Uint32Array(after.buffer, after.byteOffset, after.length);
  let j = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) {
      while (j < afterMask.length && !afterMask[j]) {
        j++;
      }
      if (j === afterMask.length) {
        return false;
      }
      for (let k = 0; k < 9; k++) {
        if (beforeBits[i * 9 + k] !== afterBits[j * 9 + k]) {
          return false;
        }
      }
      j++;
    }
  }
  return !afterMask.subarray(j).some(Boolean);
}

// Mirror the existing 3MF writer's welding and decimal output. Track the
// Float32 approximation error so the bound also covers the serialized surface.
function exportSurface(positions, format) {
  if (format !== '3mf') {
    return { positions, error: 0 };
  }
  const map = new QuantizedPointMap(1e4, Math.min(positions.length / 3, 1 << 20));
  const out = new Float32Array(positions.length);
  let error = 0;
  for (let i = 0; i < positions.length; i += 3) {
    const first = map.getOrSet(positions[i], positions[i + 1], positions[i + 2], i);
    if (first !== i) {
      out.set(out.subarray(first, first + 3), i);
      continue;
    }
    let squared = 0;
    for (let k = 0; k < 3; k++) {
      const value = Number(positions[i + k].toFixed(4));
      out[i + k] = value;
      squared += (Math.abs(out[i + k] - value) + Math.abs(value) * Number.EPSILON) ** 2;
    }
    error = Math.max(error, Math.sqrt(squared));
  }
  return { positions: out, error: error * (1 + 8 * Number.EPSILON) + Number.MIN_VALUE };
}

/** Optimize only a finished, posed export. Rejected candidates retain input buffers. */
export async function refineExportMesh(
  input,
  shouldAbort = () => false,
  deadline = performance.now() + 5000
) {
  const before = input.positions.length / 9;
  const unchanged = () => ({ ...input, refinement: { before, after: before } });
  if (shouldAbort()) {
    return null;
  }
  if (performance.now() >= deadline) {
    return unchanged();
  }

  const MeshBVH = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), Math.min(5000, deadline - performance.now()));
    acceleration.then(value => {
      clearTimeout(timer);
      resolve(value);
    });
  });
  if (shouldAbort()) {
    return null;
  }
  if (!MeshBVH || performance.now() >= deadline) {
    return unchanged();
  }

  const original = inspect(input.positions, input.lockedFaces);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(input.positions, 3));
  let candidate;

  try {
    const outputCoordinate =
      input.format === '3mf'
        ? value => Math.fround(Number(Math.fround(value).toFixed(4)))
        : Math.fround;
    candidate = await decimate(
      geometry,
      before,
      null,
      true,
      0.005,
      original.locks,
      outputCoordinate,
      deadline
    );
    if (shouldAbort()) {
      return null;
    }

    const positions = candidate.attributes.position.array;
    const candidateLocks = candidate.userData.lockedFaces;
    if (positions.length >= input.positions.length || performance.now() >= deadline) {
      return unchanged();
    }
    if (!protectedEqual(input.positions, original.locks, positions, candidateLocks)) {
      return unchanged();
    }

    const originalSurface = exportSurface(input.positions, input.format);
    const candidateSurface = exportSurface(positions, input.format);
    geometry.setAttribute('position', new THREE.BufferAttribute(originalSurface.positions, 3));
    candidate.setAttribute('position', new THREE.BufferAttribute(candidateSurface.positions, 3));

    if (countAreaSlivers(candidate) !== countAreaSlivers(geometry)) {
      return unchanged();
    }
    if (
      inspect(originalSurface.positions).signature !== inspect(candidateSurface.positions).signature
    ) {
      return unchanged();
    }
    if (
      !protectedEqual(
        originalSurface.positions,
        original.locks,
        candidateSurface.positions,
        candidateLocks
      )
    ) {
      return unchanged();
    }

    const remainingToleranceMm = 0.005 - originalSurface.error - candidateSurface.error;
    if (
      !(remainingToleranceMm > 0) ||
      !withinSurfaceTolerance(
        originalSurface.positions,
        candidateSurface.positions,
        remainingToleranceMm,
        deadline,
        MeshBVH
      )
    ) {
      return unchanged();
    }

    return { positions, normals: null, refinement: { before, after: positions.length / 9 } };
  } catch (error) {
    console.warn('[stlTexturizer] Export optimization skipped:', error);
    return unchanged();
  } finally {
    geometry.dispose();
    candidate?.dispose();
  }
}
