/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { Worker } from 'node:worker_threads';
import { decimate } from '../js/decimation.js';
import { resolveTJunctions } from '../js/meshRepair.js';
import { refineExportMesh } from '../js/exportRefinement.js';
import { withinSurfaceTolerance } from '../js/surfaceTolerance.js';

const mesh = () =>
  new THREE.BoxGeometry(2, 2, 2, 4, 4, 4)
    .toNonIndexed()
    .attributes.position.array.map(v => (v === 0 ? 0 : v));
const bounded = (a, b, t = 0.005) =>
  withinSurfaceTolerance(a, b, t, performance.now() + 1000, MeshBVH);

test('exports reduce flat faces without modifying the input or retaining stale normals', async () => {
  for (const format of ['stl', '3mf']) {
    const positions = mesh();
    const original = positions.slice();
    const normals = new Float32Array(positions.length);
    const out = await refineExportMesh({ positions, normals, format });
    assert.ok(out.positions.length < positions.length);
    assert.equal(out.normals, null);
    assert.deepEqual(positions, original);
    assert.equal(out.refinement.after, out.positions.length / 9);
    assert.ok(bounded(positions, out.positions));
  }
});

test('protected meshes and exhausted budgets keep the original buffers', async () => {
  const positions = mesh();
  const normals = new Float32Array(positions.length);
  for (const [lockedFaces, deadline] of [
    [new Uint8Array(positions.length / 9).fill(1), Infinity],
    [null, 0]
  ]) {
    const out = await refineExportMesh({ positions, normals, lockedFaces }, () => false, deadline);
    assert.equal(out.positions, positions);
    assert.equal(out.normals, normals);
  }
  assert.equal(await refineExportMesh({ positions }, () => true), null);
});

test('an unprotected component can shrink while a protected component stays exact', async () => {
  const a = mesh();
  const b = a.slice();
  for (let i = 0; i < b.length; i += 3) {
    b[i] += 10;
  }
  const positions = new Float32Array([...a, ...b]);
  const lockedFaces = new Uint8Array(positions.length / 9);
  lockedFaces.fill(1, a.length / 9);
  const out = await refineExportMesh({ positions, lockedFaces });
  assert.ok(out.positions.length < positions.length);
  const protectedPositions = [];
  for (let i = 0; i < out.positions.length; i += 9) {
    if (out.positions[i] > 5) {
      protectedPositions.push(...out.positions.subarray(i, i + 9));
    }
  }
  assert.deepEqual(new Float32Array(protectedPositions), b);
});

test('repair preserves protected flags when splitting and discarding faces', () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 2, 0, 1, 0, 0, 0, -1, 0, 2, -1, 0],
      3
    )
  );
  geometry.userData.lockedFaces = new Uint8Array([0, 1, 0]);
  assert.deepEqual(resolveTJunctions(geometry).userData.lockedFaces, new Uint8Array([1, 1, 0]));
});

test('the real worker runs final refinement and returns transferred buffers', async t => {
  const positions = mesh();
  const original = positions.slice();
  const expected = await refineExportMesh({ positions: original });
  const worker = new Worker(new URL('./helpers/exportWorkerHarness.mjs', import.meta.url));
  t.after(() => worker.terminate());
  const result = await new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.on('message', message => {
      if (message.type === 'ready') {
        worker.postMessage({ cmd: 'refine', input: { positions } }, [positions.buffer]);
      }
      if (message.type === 'done') {
        resolve(message.result);
      }
      if (message.type === 'error') {
        reject(Error(message.message));
      }
    });
  });
  assert.equal(positions.byteLength, 0);
  assert.deepEqual(result, expected);
});

test('decimation stops collapsing when the final export deadline has expired', async () => {
  const geometry = new THREE.BufferGeometry();
  const positions = mesh();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const out = await decimate(geometry, 0, null, true, 0.005, null, Math.fround, 0);
  assert.deepEqual(out.attributes.position.array, positions);
});
