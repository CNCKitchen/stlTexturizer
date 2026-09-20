/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { THREE } from './threeCompat.js';
import { indexExactPositions } from './exactGeometry.js';
import { QuantizedPointMap } from './meshIndex.js';

const number = new Float64Array([1]);
const bits = new Uint32Array(number.buffer);
const LOW = bits[0] === 0 ? 0 : 1;
const HIGH = 1 - LOW;

function nextUp(x) {
  if (Number.isNaN(x) || x === Infinity) {
    return x;
  }
  if (x === 0) {
    return Number.MIN_VALUE;
  }
  number[0] = x;
  let hi = bits[HIGH];
  let lo = bits[LOW];
  if (x > 0) {
    lo = (lo + 1) >>> 0;
    if (lo === 0) {
      hi++;
    }
  } else {
    if (lo === 0) {
      hi--;
    }
    lo = (lo - 1) >>> 0;
  }
  bits[HIGH] = hi;
  bits[LOW] = lo;
  return number[0];
}

const nextDown = x => -nextUp(-x);

// Float32 inputs; nonnegative integer weights sum to 2^32.
// 8u * max|coordinate| bounds rounding error because gamma(3) < 4u.
function encloseWitness(a, b, c, wa, wb, wc, out) {
  const value = (a * wa + b * wb + c * wc) / 2 ** 32;
  const radius = Math.max(Math.abs(a), Math.abs(b), Math.abs(c)) * 2 ** -50;
  out[0] = nextDown(value - radius);
  out[1] = nextUp(value + radius);
  return out;
}

const DENOM = 2 ** 32;
const faceKey = (map, a, b, c, insert = false) => {
  const lo = Math.min(a, b, c);
  const hi = Math.max(a, b, c);
  return insert
    ? map.getOrSet(lo, a + b + c - lo - hi, hi, 0)
    : map.get(lo, a + b + c - lo - hi, hi);
};

function interpolate(a, b, weight, out) {
  const other = DENOM - weight;
  for (let k = 0; k < 3; k++) {
    out[k * 2] = nextDown(
      nextDown(nextDown(a[k * 2] * other) + nextDown(b[k * 2] * weight)) / DENOM
    );
    out[k * 2 + 1] = nextUp(
      nextUp(nextUp(a[k * 2 + 1] * other) + nextUp(b[k * 2 + 1] * weight)) / DENOM
    );
  }
  return out;
}

// Propose an edge-aligned partition; acceptance is checked separately.
const projections = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const projectionPoint = new THREE.Vector3();

function boundarySplit(vertices, tri) {
  const projected = projections;
  for (let i = 0; i < 3; i++) {
    if (!tri.getBarycoord(centerOf(vertices[i], projectionPoint), projected[i])) {
      return null;
    }
  }
  let best = null;
  let score = 0;
  for (let edge = 0; edge < 3; edge++) {
    const j = (edge + 1) % 3;
    const a = projected[edge];
    const b = projected[j];
    for (let axis = 0; axis < 3; axis++) {
      const x = a.getComponent(axis);
      const y = b.getComponent(axis);
      if (!((x < 0 && y > 0) || (x > 0 && y < 0))) {
        continue;
      }
      const fraction = x / (x - y);
      if (!(fraction > 1e-5 && fraction < 1 - 1e-5)) {
        continue;
      }
      const weight = Math.round(fraction * DENOM);
      const length = edgeLengthSquared(vertices[edge], vertices[j]);
      const merit = length * Math.min(fraction, 1 - fraction) ** 2;
      if (merit > score) {
        score = merit;
        best = { edge, weight };
      }
    }
  }
  return best;
}

function edgeLengthSquared(a, b) {
  const x = (a[0] + a[1] - b[0] - b[1]) * 0.5;
  const y = (a[2] + a[3] - b[2] - b[3]) * 0.5;
  const z = (a[4] + a[5] - b[4] - b[5]) * 0.5;
  return x * x + y * y + z * z;
}

function centerOf(box, out) {
  return out.set((box[0] + box[1]) * 0.5, (box[2] + box[3]) * 0.5, (box[4] + box[5]) * 0.5);
}

// Integer barycentric weights keep the witness inside the target triangle.
const witness = new Float64Array(2);

function distanceUpperSquared(box, tri, closest, bary, point) {
  centerOf(box, point);
  tri.closestPointToPoint(point, closest);
  tri.getBarycoord(closest, bary);
  let wa = Number.isFinite(bary.x)
    ? Math.max(0, Math.min(DENOM, Math.round(bary.x * DENOM)))
    : DENOM;
  let wb = Number.isFinite(bary.y)
    ? Math.max(0, Math.min(DENOM - wa, Math.round(bary.y * DENOM)))
    : 0;
  const wc = DENOM - wa - wb;
  let squared = 0;
  for (let k = 0; k < 3; k++) {
    encloseWitness(
      tri.a.getComponent(k),
      tri.b.getComponent(k),
      tri.c.getComponent(k),
      wa,
      wb,
      wc,
      witness
    );
    const lo = witness[0];
    const hi = witness[1];
    const d = Math.max(Math.abs(nextDown(box[k * 2] - hi)), Math.abs(nextUp(box[k * 2 + 1] - lo)));
    squared = nextUp(squared + nextUp(d * d));
  }
  return squared;
}

function indexSharedFaces(mesh, shared) {
  const words = new Uint32Array(mesh.vertices.buffer);
  const ids = new Uint32Array(mesh.vertices.length / 3);
  for (let i = 0; i < ids.length; i++) {
    const k = i * 3;
    ids[i] = shared.getOrSet(
      mesh.vertices[k] === 0 ? 0 : words[k],
      mesh.vertices[k + 1] === 0 ? 0 : words[k + 1],
      mesh.vertices[k + 2] === 0 ? 0 : words[k + 2],
      shared.size
    );
  }
  mesh.ids = ids;
  mesh.faces = new QuantizedPointMap(1, mesh.indices.length / 3);
  for (let i = 0; i < mesh.indices.length; i += 3) {
    faceKey(
      mesh.faces,
      ids[mesh.indices[i]],
      ids[mesh.indices[i + 1]],
      ids[mesh.indices[i + 2]],
      true
    );
  }
}

function prepareMeshes(before, after, deadline) {
  const meshes = [indexExactPositions(before), indexExactPositions(after)];
  if (!meshes[0].indices.length || !meshes[1].indices.length) {
    return null;
  }
  const shared = new QuantizedPointMap(
    1,
    Math.min((meshes[0].vertices.length + meshes[1].vertices.length) / 3, 1 << 20)
  );
  for (const mesh of meshes) {
    if (performance.now() >= deadline) {
      return null;
    }
    indexSharedFaces(mesh, shared);
  }
  return meshes;
}

function createQuery(geometry, toleranceMm, budget, MeshBVH) {
  const bvh = new MeshBVH(geometry);
  return {
    bvh,
    positions: geometry.attributes.position.array,
    indices: geometry.index.array,
    toleranceMm,
    limitSquared: nextDown(toleranceMm * toleranceMm),
    budget,
    triangle: new THREE.Triangle(),
    point: new THREE.Vector3(),
    center: new THREE.Vector3(),
    closest: new THREE.Vector3(),
    barycentric: new THREE.Vector3(),
    hit: { point: new THREE.Vector3() },
    midpoints: []
  };
}

function findWitnessFace(vertices, query) {
  const { center, point, bvh, hit, triangle, positions, indices, toleranceMm } = query;
  center.set(0, 0, 0);
  for (const vertex of vertices) {
    center.add(centerOf(vertex, point));
  }
  center.multiplyScalar(1 / 3);
  const nearest = bvh.closestPointToPoint(center, hit);
  // Approximate distances may reject a cell, but cannot certify it.
  if (!nearest || !Number.isFinite(nearest.distance) || nearest.distance > toleranceMm * 1.000001) {
    return -1;
  }
  const offset = nearest.faceIndex * 3;
  triangle.a.fromArray(positions, indices[offset] * 3);
  triangle.b.fromArray(positions, indices[offset + 1] * 3);
  triangle.c.fromArray(positions, indices[offset + 2] * 3);
  return nearest.faceIndex;
}

function cornerDistance(vertex, query) {
  return distanceUpperSquared(
    vertex,
    query.triangle,
    query.closest,
    query.barycentric,
    query.point
  );
}

function cornersWithinLimit(bounds, limitSquared) {
  // Convexity extends these three bounds to the complete source triangle.
  return bounds[0] <= limitSquared && bounds[1] <= limitSquared && bounds[2] <= limitSquared;
}

function chooseSplit(vertices, depth, triangle) {
  // Use balanced subdivision at deeper levels to avoid repeatedly shaving slivers.
  const proposed = depth < 12 ? boundarySplit(vertices, triangle) : null;
  if (proposed) {
    return proposed;
  }
  const [a, b, c] = vertices;
  const ab = edgeLengthSquared(a, b);
  const bc = edgeLengthSquared(b, c);
  const ca = edgeLengthSquared(c, a);
  return { edge: ab >= bc && ab >= ca ? 0 : bc >= ca ? 1 : 2, weight: DENOM / 2 };
}

function pushChildren(stack, cell, bounds, face, query) {
  const { vertices, depth } = cell;
  const split = chooseSplit(vertices, depth, query.triangle);
  const i = split.edge;
  const j = (i + 1) % 3;
  const k = (i + 2) % 3;
  const x = vertices[i];
  const y = vertices[j];
  const z = vertices[k];
  // Depth-first traversal keeps this midpoint alive through both children.
  const storage = (query.midpoints[depth] ??= new Float64Array(6));
  const midpoint = interpolate(x, y, split.weight, storage);
  const distance = cornerDistance(midpoint, query);
  stack.push(
    {
      vertices: [x, midpoint, z],
      depth: depth + 1,
      face,
      bounds: [bounds[i], distance, bounds[k]]
    },
    { vertices: [midpoint, y, z], depth: depth + 1, face, bounds: [distance, bounds[j], bounds[k]] }
  );
}

function triangleWithinTolerance(vertices, query) {
  const { budget, limitSquared } = query;
  const stack = [{ vertices, depth: 0, face: -1, bounds: [Infinity, Infinity, Infinity] }];
  while (stack.length) {
    if (
      budget.cells >= 2_000_000 ||
      (budget.cells % 256 === 0 && performance.now() >= budget.deadline)
    ) {
      return false;
    }
    budget.cells++;
    const cell = stack.pop();
    if (cell.face >= 0 && cornersWithinLimit(cell.bounds, limitSquared)) {
      continue;
    }

    const face = findWitnessFace(cell.vertices, query);
    if (face < 0) {
      return false;
    }
    const bounds =
      face === cell.face ? cell.bounds : cell.vertices.map(vertex => cornerDistance(vertex, query));
    if (cornersWithinLimit(bounds, limitSquared)) {
      continue;
    }
    if (cell.depth >= 32) {
      return false;
    }
    pushChildren(stack, cell, bounds, face, query);
  }
  return true;
}

function vertexBounds(positions, id, out) {
  const offset = id * 3;
  out[0] = out[1] = positions[offset];
  out[2] = out[3] = positions[offset + 1];
  out[4] = out[5] = positions[offset + 2];
  return out;
}

function surfaceWithinTolerance(source, target, toleranceMm, budget, MeshBVH) {
  if (performance.now() >= budget.deadline) {
    return false;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(target.vertices, 3));
  geometry.setIndex(new THREE.BufferAttribute(target.indices.slice(), 1));
  try {
    const query = createQuery(geometry, toleranceMm, budget, MeshBVH);
    const corners = [new Float64Array(6), new Float64Array(6), new Float64Array(6)];
    for (let f = 0; f < source.indices.length; f += 3) {
      if (f % 768 === 0 && performance.now() >= budget.deadline) {
        return false;
      }
      const ids = source.indices.subarray(f, f + 3);
      if (
        faceKey(target.faces, source.ids[ids[0]], source.ids[ids[1]], source.ids[ids[2]]) !== -1
      ) {
        continue;
      }
      for (let k = 0; k < 3; k++) {
        vertexBounds(source.vertices, ids[k], corners[k]);
      }
      if (!triangleWithinTolerance(corners, query)) {
        return false;
      }
    }
    return true;
  } finally {
    geometry.dispose();
  }
}

/** Check complete surfaces in both directions, including numerical rounding. */
export function withinSurfaceTolerance(before, after, toleranceMm, deadline, MeshBVH) {
  const meshes = prepareMeshes(before, after, deadline);
  if (!meshes) {
    return false;
  }
  const budget = { cells: 0, deadline };
  return (
    surfaceWithinTolerance(meshes[0], meshes[1], toleranceMm, budget, MeshBVH) &&
    surfaceWithinTolerance(meshes[1], meshes[0], toleranceMm, budget, MeshBVH) &&
    performance.now() < deadline
  );
}
