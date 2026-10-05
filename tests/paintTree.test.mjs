/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PaintTree } from '../js/paintTree.js';
import { buildAdjacency } from '../js/exclusion.js';

// Issue #134: a project's paint must come back on the re-imported model even
// though model.stl is written in the original pose and float32, so the
// corners the 0.1 µm weld groups together can differ from the saving session.

/** Sphere as triangle soup, every corner nudged independently (sub-cell noise). */
function noisySphere(seed, amp) {
  const geo = new THREE.SphereGeometry(20, 48, 32).toNonIndexed();
  const p = geo.attributes.position.array;
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = 0; i < p.length; i++) p[i] += (rnd() * 2 - 1) * amp;
  return geo;
}

function makeTree(geo, layerId) {
  const adj = buildAdjacency(geo);
  const tree = new PaintTree({ positions: geo.attributes.position.array, vertId: adj.vertId, vertCount: adj.vertCount, adjacency: adj.adjacency, faceNormals: adj.faceNormals });
  tree.addLayer(layerId);
  return { tree, adj };
}

/** Soft dab (50 % hardness) on the +Z pole plus a few hard faces at the equator. */
function paint(tree, adj, slot) {
  const fn = adj.faceNormals;
  let seed = 0, best = -1;
  for (let f = 0; f < tree.baseTriCount; f++) if (fn[f * 3 + 2] > best) { best = fn[f * 3 + 2]; seed = f; }
  tree.paintStroke({ slot, seedFace: seed, from: { x: 0, y: 0, z: 20 }, to: { x: 2, y: 1, z: 20 }, radius: 5, view: { x: 0, y: 0, z: -1 }, hardness: 0.5, erase: false, edgeLimit: 0.8 });
  const hard = [];
  for (let f = 0; f < tree.baseTriCount && hard.length < 40; f++) if (Math.abs(fn[f * 3 + 2]) < 0.05) hard.push(f);
  tree.paintFaces(slot, hard, false);
}

/** Soft coverage per base corner (0 without soft paint) and hard flag per base face. */
function cornerPaint(tree, adj, slot) {
  const cov = tree.layers[slot].cov;
  const soft = new Float32Array(adj.vertId.length);
  if (cov) for (let i = 0; i < soft.length; i++) soft[i] = cov[adj.vertId[i]];
  return { soft, hard: tree.basePaint(slot).hard };
}

/** What a re-weld must produce: corners the new weld joins share the strongest value. */
function groupMax(soft, vertId) {
  const best = new Map();
  for (let i = 0; i < soft.length; i++) best.set(vertId[i], Math.max(best.get(vertId[i]) ?? 0, soft[i]));
  return Float32Array.from(vertId, v => best.get(v));
}

const projectJSON = (tree) => JSON.parse(JSON.stringify(PaintTree.toJSON(tree.serialize({ leafCov: true }))));

test('project paint replays onto a different weld of the same triangles', () => {
  const geoA = noisySphere(1, 2e-5);
  const geoB = noisySphere(2, 2e-5);   // same triangles, corners re-rounded differently
  const { tree: A, adj: adjA } = makeTree(geoA, 11);
  const { tree: B, adj: adjB } = makeTree(geoB, 22);
  assert.notEqual(adjA.vertCount, adjB.vertCount, 'precondition: the two welds differ');

  paint(A, adjA, A.layerSlot(11));
  const before = cornerPaint(A, adjA, A.layerSlot(11));
  const { faces, softVertices } = A.countPainted(A.layerSlot(11));
  assert.ok(faces > 0 && softVertices > 0);

  const restored = PaintTree.fromJSON(projectJSON(A));
  restored.layerIds = restored.layerIds.map(id => id === 11 ? 22 : id);
  assert.equal(B.deserialize(restored), true);

  const after = cornerPaint(B, adjB, B.layerSlot(22));
  assert.deepEqual(after.hard, before.hard, 'hard faces are per node and must be identical');
  const expected = groupMax(before.soft, adjB.vertId);
  let maxDiff = 0, painted = 0;
  for (let i = 0; i < expected.length; i++) {
    maxDiff = Math.max(maxDiff, Math.abs(after.soft[i] - expected[i]));
    if (after.soft[i] > 0) painted++;
  }
  assert.ok(painted > 0, 'soft paint came back');
  assert.ok(maxDiff < 1e-6, `soft coverage per corner differs by ${maxDiff}`);
  // The split tree is per base face and replays verbatim; flatten()'s
  // T-junction splits depend on which edges the weld shares, so that count may differ.
  assert.equal(B.nodeCount, A.nodeCount, 'same split tree');
});

test('per-vertex form (undo snapshots) still needs the identical weld', () => {
  const geoA = noisySphere(1, 2e-5), geoB = noisySphere(2, 2e-5);
  const { tree: A, adj: adjA } = makeTree(geoA, 1);
  const { tree: B } = makeTree(geoB, 1);
  const { tree: A2 } = makeTree(geoA, 1);
  paint(A, adjA, 0);
  const snap = A.serialize();
  assert.equal(snap.leafCov, null);
  assert.equal(B.deserialize(snap), false, 'different weld is rejected without leafCov');
  assert.equal(A2.deserialize(snap), true);
  assert.ok(PaintTree.serializedEqual(snap, A2.serialize()));
});

test('project JSON without leafCov (older files) loads on the same weld', () => {
  const geo = noisySphere(1, 2e-5);
  const { tree: A, adj } = makeTree(geo, 5);
  const { tree: A2 } = makeTree(geo, 5);
  paint(A, adj, 0);
  const j = JSON.parse(JSON.stringify(PaintTree.toJSON(A.serialize())));
  assert.equal(j.leafCov, undefined);
  assert.equal(A2.deserialize(PaintTree.fromJSON(j)), true);
  assert.deepEqual(cornerPaint(A2, adj, 0), cornerPaint(A, adj, 0));
});
