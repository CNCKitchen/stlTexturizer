import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

import { writeCubeFixture } from './fixtures/makeCube.mjs';
import * as inspectMeshTool from '../tools/inspectMesh.mjs';
import * as texturizeTool from '../tools/texturize.mjs';
import { resolveTexture } from '../lib/textures.mjs';

test('unknown/misspelled parameter is rejected with an actionable message', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bumpmesh-mcp-strict-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cubePath = path.join(dir, 'cube.stl');
  await writeCubeFixture(cubePath, 20);

  // "pat" is a typo for "path".
  const result = await inspectMeshTool.handler({ pat: cubePath });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /unknown parameter/i);
  assert.match(result.content[0].text, /pat/);
  // Names the allowed parameter(s).
  assert.match(result.content[0].text, /path/);
});

test('texturize rejects an unknown parameter naming it', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bumpmesh-mcp-strict-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cubePath = path.join(dir, 'cube.stl');
  await writeCubeFixture(cubePath, 20);

  const result = await texturizeTool.handler({
    input: cubePath,
    output: path.join(dir, 'out.stl'),
    texture: 'Dots',
    amplitudeMm: 0.5, // misspelled — real param is `amplitude`
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /amplitudeMm/);
});

test('texturize requires exactly one of texture / customImagePath — both is an error', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bumpmesh-mcp-strict-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cubePath = path.join(dir, 'cube.stl');
  await writeCubeFixture(cubePath, 20);

  const result = await texturizeTool.handler({
    input: cubePath,
    output: path.join(dir, 'out.stl'),
    texture: 'Dots',
    customImagePath: path.join(dir, 'whatever.png'),
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /exactly one/i);
});

test('texturize requires exactly one of texture / customImagePath — neither is an error', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bumpmesh-mcp-strict-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cubePath = path.join(dir, 'cube.stl');
  await writeCubeFixture(cubePath, 20);

  const result = await texturizeTool.handler({
    input: cubePath,
    output: path.join(dir, 'out.stl'),
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /No texture source/i);
});

test('texturize accepts a customImagePath pointing at a real preset file', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bumpmesh-mcp-strict-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cubePath = path.join(dir, 'cube.stl');
  const outPath = path.join(dir, 'out.stl');
  await writeCubeFixture(cubePath, 20);

  // Point customImagePath at a real texture file on disk (absolute path),
  // resolved via the library so it doesn't depend on the test's cwd.
  const imgPath = resolveTexture('Dots');

  const result = await texturizeTool.handler({
    input: cubePath,
    output: outPath,
    customImagePath: imgPath,
    refineLength: 2.5,
    amplitude: 0.3,
  });
  assert.equal(result.isError, undefined, `texturize errored: ${result.content?.[0]?.text}`);
  assert.ok(result.structuredContent.triangles > 12);
});
