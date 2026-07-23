import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';

import { writeCubeFixture } from './fixtures/makeCube.mjs';
import * as texturizeTool from '../tools/texturize.mjs';
import * as inspectMeshTool from '../tools/inspectMesh.mjs';
import { parseModelBuffer } from '../../js/stlLoader.js';

// Exercises the DOMParser shim (lib/bootstrap.mjs installs @xmldom/xmldom):
// js/stlLoader.js parse3MF() uses `new DOMParser()`, which is undefined in
// Node without the shim. Every step here touches .3mf output+input.

test('bumpmesh_texturize writes a .3mf and it re-parses to a watertight mesh (DOMParser shim)', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bumpmesh-mcp-3mf-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cubePath = path.join(dir, 'cube.stl');
  const outPath = path.join(dir, 'cube-textured.3mf');
  await writeCubeFixture(cubePath, 20);

  const result = await texturizeTool.handler({
    input: cubePath,
    output: outPath,
    texture: 'Dots',
    projection: 'triplanar',
    amplitude: 0.4,
    refineLength: 2.0,
    format: '3mf',
  });
  assert.equal(result.isError, undefined, `texturize errored: ${result.content?.[0]?.text}`);

  // 3MF file exists and its byte length matches the reported summary.
  const st = await stat(outPath);
  assert.ok(st.isFile());
  assert.equal(st.size, result.structuredContent.bytes);

  // Re-parse the .3mf directly via parseModelBuffer (exercises parse3MF + xmldom).
  const raw = await readFile(outPath);
  const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  const parsed = parseModelBuffer(ab, '3mf');
  assert.ok(parsed.geometry.attributes.position.count > 0);

  // And through the inspect_mesh tool: valid watertight mesh, 1 shell.
  const inspected = await inspectMeshTool.handler({ path: outPath });
  assert.equal(inspected.isError, undefined, `inspect errored: ${inspected.content?.[0]?.text}`);
  assert.ok(inspected.structuredContent.triangles > 0);
  assert.equal(inspected.structuredContent.watertight, true);
  assert.equal(inspected.structuredContent.shells, 1);
});

test('inspect_mesh reads a .3mf produced from the cube (build3MFBytes round-trip)', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bumpmesh-mcp-3mf-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cubePath = path.join(dir, 'cube.stl');
  const outPath = path.join(dir, 'cube-passthrough.3mf');
  await writeCubeFixture(cubePath, 20);

  // A texturize with a large refineLength barely subdivides, but still writes
  // a valid 3MF we can round-trip. (Separate from the detailed case above.)
  const result = await texturizeTool.handler({
    input: cubePath,
    output: outPath,
    texture: 'Grid',
    refineLength: 5,
    amplitude: 0.2,
    format: '3mf',
  });
  assert.equal(result.isError, undefined, `texturize errored: ${result.content?.[0]?.text}`);

  const inspected = await inspectMeshTool.handler({ path: outPath });
  assert.equal(inspected.structuredContent.watertight, true);
});
