/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { subdivide } from '../js/subdivision.js';
import { collapseNeedleEdges } from '../js/meshRepair.js';

// A CAD export can leave a needle: a long triangle a fraction of a micrometre
// wide. Refining it put vertices closer than the 10 nm weld cell, which merged
// into degenerate triangles and non-manifold edges — a scar along the needle.

const W = 0.00035;   // needle width at its foot (mm), as in the reported model
const H = 60;        // needle length (mm)

/** A closed 10 × 10 × H box whose front face (y = 0) is split by a needle from its top edge to its bottom. */
function boxWithNeedle() {
  const v = {
    a: [0, 0, 0], b: [5, 0, 0], b2: [5 + W, 0, 0], c: [10, 0, 0],
    d: [0, 0, H], e: [5, 0, H], f: [10, 0, H],
    A: [0, 10, 0], C: [10, 10, 0], D: [0, 10, H], F: [10, 10, H],
  };
  const tris = [
    // front, seen from -y (counterclockwise = outward normal -y)
    ['a', 'b', 'e'], ['a', 'e', 'd'], ['b', 'b2', 'e'], ['b2', 'c', 'f'], ['b2', 'f', 'e'],
    // back
    ['A', 'D', 'F'], ['A', 'F', 'C'],
    // left, right
    ['a', 'd', 'D'], ['a', 'D', 'A'], ['c', 'C', 'F'], ['c', 'F', 'f'],
    // bottom and top, fanned from a back corner (the front edges are straight lines)
    ['A', 'b', 'a'], ['A', 'b2', 'b'], ['A', 'c', 'b2'], ['A', 'C', 'c'],
    ['D', 'd', 'e'], ['D', 'e', 'f'], ['D', 'f', 'F'],
  ];
  return new Float32Array(tris.flatMap((t) => t.flatMap((k) => v[k])));
}

async function refinedDefects(positions) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.computeVertexNormals();
  const { geometry } = await subdivide(g, 1, () => {}, null);
  const p = geometry.attributes.position.array;
  const key = (i) => `${Math.round(p[i] * 1e5)},${Math.round(p[i + 1] * 1e5)},${Math.round(p[i + 2] * 1e5)}`;
  const ids = new Map();
  const id = (i) => { const k = key(i); if (!ids.has(k)) ids.set(k, ids.size); return ids.get(k); };
  const edges = new Map();
  let degenerate = 0;
  for (let t = 0; t < p.length / 9; t++) {
    const c = [id(t * 9), id(t * 9 + 3), id(t * 9 + 6)];
    if (c[0] === c[1] || c[1] === c[2] || c[0] === c[2]) { degenerate++; continue; }
    for (let j = 0; j < 3; j++) {
      const a = c[j], b = c[(j + 1) % 3];
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      edges.set(k, (edges.get(k) || 0) + 1);
    }
  }
  let open = 0, overfull = 0;
  for (const n of edges.values()) { if (n === 1) open++; if (n > 2) overfull++; }
  return { degenerate, open, overfull };
}

test('the needle breaks the refined mesh without the cleanup', async () => {
  const d = await refinedDefects(boxWithNeedle());
  assert.ok(d.degenerate + d.open + d.overfull > 0, JSON.stringify(d));
});

test('collapseNeedleEdges removes the needle, the refined mesh stays closed and manifold', async () => {
  const pos = boxWithNeedle();
  const r = collapseNeedleEdges(pos, 1);
  assert.ok(r, 'needle found');
  assert.equal(r.collapsed, 1);
  assert.equal(r.keep.length, pos.length / 9 - 2);   // the needle and the bottom sliver beside it
  const d = await refinedDefects(r.positions);
  assert.deepEqual(d, { degenerate: 0, open: 0, overfull: 0 });
});

test('collapseNeedleEdges leaves a mesh without needles alone', () => {
  const pos = boxWithNeedle();
  assert.equal(collapseNeedleEdges(pos, 100), null);     // nothing is refined at 100 mm
});
