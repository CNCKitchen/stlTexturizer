import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

import { writeCubeFixture } from './fixtures/makeCube.mjs';
import { inspectMeshAt, validateMeshAt } from '../lib/pipeline.mjs';
import * as inspectMeshTool from '../tools/inspectMesh.mjs';

test('inspect_mesh on a 20mm cube reports 12 triangles, watertight, 1 shell', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bumpmesh-mcp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cubePath = path.join(dir, 'cube.stl');
  await writeCubeFixture(cubePath, 20);

  const summary = await inspectMeshAt(cubePath);
  assert.equal(summary.triangles, 12);
  assert.equal(summary.watertight, true);
  assert.equal(summary.shells, 1);
  assert.ok(summary.surfaceArea > 0);
  assert.ok(Number.isFinite(summary.boundingBox.size.x));
  // Cube edge is 20mm on every axis.
  assert.ok(Math.abs(summary.boundingBox.size.x - 20) < 1e-3);
  assert.ok(Math.abs(summary.boundingBox.size.y - 20) < 1e-3);
  assert.ok(Math.abs(summary.boundingBox.size.z - 20) < 1e-3);
});

test('validate_mesh on the cube reports zero defects', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bumpmesh-mcp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cubePath = path.join(dir, 'cube.stl');
  await writeCubeFixture(cubePath, 20);

  const summary = await validateMeshAt(cubePath);
  assert.equal(summary.openEdges, 0);
  assert.equal(summary.nonManifoldEdges, 0);
  assert.equal(summary.shells, 1);
  assert.equal(summary.slivers, 0);
  assert.equal(summary.watertight, true);
});

test('bumpmesh_inspect_mesh tool handler returns the MCP content envelope', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bumpmesh-mcp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cubePath = path.join(dir, 'cube.stl');
  await writeCubeFixture(cubePath, 20);

  const result = await inspectMeshTool.handler({ path: cubePath });
  assert.equal(result.structuredContent.triangles, 12);
  assert.equal(result.content[0].type, 'text');
});

test('bumpmesh_inspect_mesh tool handler reports isError on a missing file', async () => {
  const result = await inspectMeshTool.handler({ path: path.join(tmpdir(), 'does-not-exist-bumpmesh.stl') });
  assert.equal(result.isError, true);
});
