import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, stat } from 'node:fs/promises';

import { writeCubeFixture } from './fixtures/makeCube.mjs';
import * as subdivideTool from '../tools/subdivide.mjs';
import * as decimateTool from '../tools/decimate.mjs';
import * as placeOnBedTool from '../tools/placeOnBed.mjs';
import * as validateMeshTool from '../tools/validateMesh.mjs';

test('bumpmesh_subdivide increases triangle count and writes a valid file', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bumpmesh-mcp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cubePath = path.join(dir, 'cube.stl');
  const outPath = path.join(dir, 'sub.stl');
  await writeCubeFixture(cubePath, 20);

  const result = await subdivideTool.handler({ input: cubePath, output: outPath, refineLength: 3 });
  assert.equal(result.isError, undefined);
  assert.ok(result.structuredContent.triangles > 12);
  assert.equal(typeof result.structuredContent.safetyCapHit, 'boolean');
  const st = await stat(outPath);
  assert.ok(st.size > 0);
});

test('bumpmesh_decimate reduces a subdivided mesh toward the target count', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bumpmesh-mcp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cubePath = path.join(dir, 'cube.stl');
  const subPath = path.join(dir, 'sub.stl');
  const decPath = path.join(dir, 'dec.stl');
  await writeCubeFixture(cubePath, 20);
  await subdivideTool.handler({ input: cubePath, output: subPath, refineLength: 1.5 });

  const result = await decimateTool.handler({ input: subPath, output: decPath, targetTriangles: 20 });
  assert.equal(result.isError, undefined);
  assert.ok(result.structuredContent.triangles > 0);
  const st = await stat(decPath);
  assert.ok(st.size > 0);
});

test('bumpmesh_place_on_bed reorients the cube and reports a valid bounding box', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bumpmesh-mcp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cubePath = path.join(dir, 'cube.stl');
  const outPath = path.join(dir, 'placed.stl');
  await writeCubeFixture(cubePath, 20);

  const result = await placeOnBedTool.handler({ input: cubePath, output: outPath, face: 'auto' });
  assert.equal(result.isError, undefined);
  assert.ok(Math.abs(result.structuredContent.boundingBox.min.z) < 1e-3, 'placed mesh should rest on Z=0');

  const validated = await validateMeshTool.handler({ path: outPath });
  assert.equal(validated.structuredContent.watertight, true);
});

test('bumpmesh_place_on_bed accepts an explicit triangle index', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bumpmesh-mcp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cubePath = path.join(dir, 'cube.stl');
  const outPath = path.join(dir, 'placed-idx.stl');
  await writeCubeFixture(cubePath, 20);

  const result = await placeOnBedTool.handler({ input: cubePath, output: outPath, face: 0 });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.chosenFaceIndex, 0);
});
