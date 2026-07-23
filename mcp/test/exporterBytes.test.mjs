import { test } from 'node:test';
import assert from 'node:assert/strict';

import { THREE } from '../../js/threeCompat.js';
import { buildSTLBytes } from '../../js/exporter.js';
import { buildCubeSTLBuffer } from './fixtures/makeCube.mjs';
import { parseModelBuffer } from '../../js/stlLoader.js';

test('buildSTLBytes output length == 84 + 50 * triangleCount', () => {
  const cubeBuffer = buildCubeSTLBuffer(20);
  const arrayBuffer = cubeBuffer.buffer.slice(cubeBuffer.byteOffset, cubeBuffer.byteOffset + cubeBuffer.byteLength);
  const { geometry } = parseModelBuffer(arrayBuffer, 'stl');

  const bytes = buildSTLBytes(geometry);
  const triCount = geometry.attributes.position.count / 3;
  assert.equal(triCount, 12);
  assert.equal(bytes.length, 84 + 50 * triCount);

  // Header triangle count field matches.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(80, true), triCount);
});

test('buildSTLBytes on an arbitrary non-indexed geometry also satisfies the formula', () => {
  // A single triangle.
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const bytes = buildSTLBytes(geometry);
  assert.equal(bytes.length, 84 + 50 * 1);
});
