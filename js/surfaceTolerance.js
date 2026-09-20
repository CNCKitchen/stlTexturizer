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

// a,b,c must be finite Float32 coordinates; nonnegative integer weights must
// sum exactly to 2^32. The computed numerator has three products and two sums;
// each term crosses at most three rounded operations. Its absolute error is
// <= gamma(3) * sum(abs(term)), with u=2^-53 and gamma(3)=3u/(1-3u)<4u.
// Dividing by 2^32 is exact, and the normalized absolute terms sum to at most
// max(|a|,|b|,|c|). Use 8u of that maximum, then round both endpoints outward.
// Float32 ranges and integer weights rule out Float64 overflow/underflow here.
// The radius itself is an exact power-of-two scaling of a Float32 value.
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

// Projection only proposes a partition; it never authorizes acceptance. Split
// near a witness edge instead of building a fine grid across retriangulated
// patches. Integer weights define an exact point on the source edge, whose
// coordinates are enclosed by interpolate, so both children cover the parent.
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

// An explicit point inside a target triangle: nonnegative integer barycentric
// weights sum EXACTLY to 2^32. Interval arithmetic encloses its true coordinates.
// The approximate closest point is only a proposal for these witness weights.
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

// A BVH only proposes witnesses. Acceptance requires complete triangles to be
// within tolerance in both directions, including outward-rounded arithmetic.
export function withinSurfaceTolerance(before, after, toleranceMm, deadline, MeshBVH) {
  const expired = () => performance.now() >= deadline;
  const meshes = [indexExactPositions(before), indexExactPositions(after)];
  if (!meshes[0].indices.length || !meshes[1].indices.length) {
    return false;
  }

  let cells = 0;
  const limitSquared = nextDown(toleranceMm * toleranceMm);
  const shared = new QuantizedPointMap(
    1,
    Math.min((meshes[0].vertices.length + meshes[1].vertices.length) / 3, 1 << 20)
  );
  for (const mesh of meshes) {
    if (expired()) {
      return false;
    }
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

  const p = new THREE.Vector3();
  const center = new THREE.Vector3();
  const closest = new THREE.Vector3();
  const bary = new THREE.Vector3();
  const hit = { point: new THREE.Vector3() };
  const tri = new THREE.Triangle();

  // Depth-first traversal keeps each midpoint alive through both children. A
  // depth slot is reused only after its previous subtree has been exhausted.
  const roots = [new Float64Array(6), new Float64Array(6), new Float64Array(6)];
  const midpoints = [];

  for (let direction = 0; direction < 2; direction++) {
    if (expired()) {
      return false;
    }

    const source = meshes[direction];
    const target = meshes[1 - direction];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(target.vertices, 3));
    geometry.setIndex(new THREE.BufferAttribute(target.indices.slice(), 1));
    const bvh = new MeshBVH(geometry);
    const indices = geometry.index.array;

    const box = (id, out) => {
      const v = source.vertices;
      const i = id * 3;
      out[0] = out[1] = v[i];
      out[2] = out[3] = v[i + 1];
      out[4] = out[5] = v[i + 2];
      return out;
    };

    for (let f = 0; f < source.indices.length; f += 3) {
      if (f % 768 === 0 && expired()) {
        return false;
      }
      const ids = source.indices.subarray(f, f + 3);
      if (
        faceKey(target.faces, source.ids[ids[0]], source.ids[ids[1]], source.ids[ids[2]]) !== -1
      ) {
        continue;
      }

      const stack = [[box(ids[0], roots[0]), box(ids[1], roots[1]), box(ids[2], roots[2]), 0]];
      while (stack.length) {
        if (cells >= 2_000_000) {
          return false;
        }
        if (cells % 256 === 0 && expired()) {
          return false;
        }
        const [a, b, c, depth, hint = -1, da = Infinity, db = Infinity, dc = Infinity] =
          stack.pop();
        cells++;

        // Children can reuse their parent's certified corner distances to the
        // same target triangle. Boxes and target coordinates are immutable.
        if (hint >= 0 && da <= limitSquared && db <= limitSquared && dc <= limitSquared) {
          continue;
        }

        center.set(0, 0, 0);
        for (const vertex of [a, b, c]) {
          center.add(centerOf(vertex, p));
        }
        center.multiplyScalar(1 / 3);
        const nearest = bvh.closestPointToPoint(center, hit);

        // A numerical distance can reject a candidate, but never authorize it.
        if (
          !nearest ||
          !Number.isFinite(nearest.distance) ||
          nearest.distance > toleranceMm * 1.000001
        ) {
          return false;
        }

        const t = nearest.faceIndex * 3;
        tri.a.fromArray(target.vertices, indices[t] * 3);
        tri.b.fromArray(target.vertices, indices[t + 1] * 3);
        tri.c.fromArray(target.vertices, indices[t + 2] * 3);

        // Distance to a convex set is convex. If all three enclosed corners
        // are within epsilon of THIS triangle, their entire triangle is too.
        const vertices = [a, b, c];
        const bounds =
          nearest.faceIndex === hint
            ? [da, db, dc]
            : [
                distanceUpperSquared(a, tri, closest, bary, p),
                distanceUpperSquared(b, tri, closest, bary, p),
                distanceUpperSquared(c, tri, closest, bary, p)
              ];
        if (bounds[0] <= limitSquared && bounds[1] <= limitSquared && bounds[2] <= limitSquared) {
          continue;
        }
        if (depth >= 32) {
          return false;
        }

        // Edge-aligned proposals can repeatedly shave tiny slivers. Reserve
        // the deeper levels for balanced subdivision to ensure progress.
        let split = depth >= 12 ? null : boundarySplit(vertices, tri);
        if (!split) {
          const ab = edgeLengthSquared(a, b);
          const bc = edgeLengthSquared(b, c);
          const ca = edgeLengthSquared(c, a);
          split = { edge: ab >= bc && ab >= ca ? 0 : bc >= ca ? 1 : 2, weight: DENOM / 2 };
        }

        const i = split.edge;
        const j = (i + 1) % 3;
        const k = (i + 2) % 3;
        const x = vertices[i];
        const y = vertices[j];
        const z = vertices[k];
        const m = interpolate(x, y, split.weight, (midpoints[depth] ??= new Float64Array(6)));
        const dm = distanceUpperSquared(m, tri, closest, bary, p);
        const face = nearest.faceIndex;
        stack.push(
          [x, m, z, depth + 1, face, bounds[i], dm, bounds[k]],
          [m, y, z, depth + 1, face, dm, bounds[j], bounds[k]]
        );
      }
    }
    geometry.dispose();
  }
  if (expired()) {
    return false;
  }
  return true;
}
