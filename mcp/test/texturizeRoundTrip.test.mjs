import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';

import { writeCubeFixture } from './fixtures/makeCube.mjs';
import * as texturizeTool from '../tools/texturize.mjs';
import { parseModelBuffer } from '../../js/stlLoader.js';

test('bumpmesh_texturize round-trips a cube with the Hexagon preset', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bumpmesh-mcp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cubePath = path.join(dir, 'cube.stl');
  const outPath = path.join(dir, 'cube-textured.stl');
  await writeCubeFixture(cubePath, 20);

  const result = await texturizeTool.handler({
    input: cubePath,
    output: outPath,
    texture: 'Hexagon',
    projection: 'triplanar',
    scaleU: 0.5,
    scaleV: 0.5,
    offsetU: 0,
    offsetV: 0,
    rotation: 0,
    amplitude: 0.5,
    symmetric: false,
    maskTopAngle: 0,
    maskBottomAngle: 5,
    refineLength: 2.0,
    decimateTo: 750000,
    textureSmoothing: 0,
  });

  assert.equal(result.isError, undefined, `handler reported an error: ${result.content?.[0]?.text}`);
  const summary = result.structuredContent;

  // 1. Output file exists.
  const st = await stat(outPath);
  assert.ok(st.isFile());
  assert.equal(st.size, summary.bytes);

  // 2. Re-parses via parseModelBuffer.
  const raw = await readFile(outPath);
  const arrayBuffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  const parsed = parseModelBuffer(arrayBuffer, 'stl');
  assert.ok(parsed.geometry.attributes.position.count > 0);

  // 3. Triangle count is finite and > 0, and grew from the 12-triangle cube
  //    (subdivision + displacement always increases triangle count on a cube).
  assert.ok(Number.isFinite(summary.triangles));
  assert.ok(summary.triangles > 12);

  // 4. STL byte length formula: 84 + 50 * triCount.
  assert.equal(st.size, 84 + 50 * summary.triangles);

  // warnings is always an array (possibly empty).
  assert.ok(Array.isArray(summary.warnings));
});

test('bumpmesh_texturize rejects an unknown texture name with an actionable error', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bumpmesh-mcp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cubePath = path.join(dir, 'cube.stl');
  await writeCubeFixture(cubePath, 20);

  const result = await texturizeTool.handler({
    input: cubePath,
    output: path.join(dir, 'out.stl'),
    texture: 'DefinitelyNotARealTexture',
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /DefinitelyNotARealTexture/);
});

test('bumpmesh_texturize surfaces the amplitude-overlap warning on a thin model', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bumpmesh-mcp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cubePath = path.join(dir, 'cube.stl');
  const outPath = path.join(dir, 'out.stl');
  // A 2mm cube with a 0.5mm (default) amplitude: 0.5 > 10% of 2mm (0.2mm) → warning.
  await writeCubeFixture(cubePath, 2);

  const result = await texturizeTool.handler({
    input: cubePath,
    output: outPath,
    texture: 'Dots',
    refineLength: 0.3,
  });

  assert.equal(result.isError, undefined, `handler reported an error: ${result.content?.[0]?.text}`);
  assert.ok(result.structuredContent.overlapWarning, 'expected an overlapWarning for a thin model');
});
