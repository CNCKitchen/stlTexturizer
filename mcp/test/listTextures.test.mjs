import { test } from 'node:test';
import assert from 'node:assert/strict';

import { listTextures, TEXTURE_CATALOG, resolveTexture } from '../lib/textures.mjs';
import * as listTexturesTool from '../tools/listTextures.mjs';

test('listTextures() returns exactly 24 presets with non-empty fields', () => {
  const textures = listTextures();
  assert.equal(textures.length, 24);
  for (const t of textures) {
    assert.ok(t.name && t.name.length > 0, 'name must be non-empty');
    assert.ok(t.description && t.description.length > 0, 'description must be non-empty');
    assert.ok(t.category && t.category.length > 0, 'category must be non-empty');
    assert.equal(typeof t.defaultScale, 'number');
  }
});

test('TEXTURE_CATALOG matches the exact preset names from js/presetTextures.js', () => {
  const expected = [
    'Basket', 'Brick', 'Bubble', 'Carbon Fiber', 'Crystal', 'Dots', 'Grid', 'Grip Surface',
    'Hexagon', 'Hexagons', 'Isogrid', 'Knitting', 'Knurling', 'Leather 2', 'Noise',
    'Stripes 1', 'Stripes 2', 'Voronoi', 'Weave 1', 'Weave 2', 'Weave 3', 'Wood 1', 'Wood 2', 'Wood 3',
  ];
  assert.deepEqual(TEXTURE_CATALOG.map((t) => t.name), expected);
});

test('resolveTexture is case-insensitive and resolves both name and filename', () => {
  const byName = resolveTexture('hexagon');
  const byExactName = resolveTexture('Hexagon');
  const byFile = resolveTexture('hexagon.jpg');
  assert.ok(byName.endsWith('hexagon.jpg'));
  assert.equal(byName, byExactName);
  assert.equal(byName, byFile);
});

test('resolveTexture returns null for an unknown name', () => {
  assert.equal(resolveTexture('not-a-real-texture'), null);
});

test('bumpmesh_list_textures tool handler returns the MCP content envelope', async () => {
  const result = await listTexturesTool.handler();
  assert.equal(result.structuredContent.count, 24);
  assert.equal(result.structuredContent.textures.length, 24);
  assert.equal(result.content[0].type, 'text');
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.count, 24);
});
