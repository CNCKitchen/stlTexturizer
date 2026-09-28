/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { export3MF } from '../js/exporter.js';

function captureDownload(t) {
  let blob;
  t.mock.method(URL, 'createObjectURL', value => { blob = value; return 'blob:test'; });
  t.mock.method(globalThis, 'setTimeout', () => 0);
  const previous = globalThis.document;
  globalThis.document = { createElement: () => ({ style: {}, click() {} }), body: { appendChild() {}, removeChild() {} } };
  t.after(() => { globalThis.document = previous; });
  return () => blob;
}
const geometry = positions => ({ attributes: { position: { array: positions } } });

for (const native of [true, false]) {
  test(`3MF keeps existing coordinate formatting, indices and package across chunks (${native ? 'native' : 'fallback'})`, async t => {
    if (!native) t.mock.method(globalThis, 'CompressionStream', function () { throw new TypeError('unsupported'); });
    const getBlob = captureDownload(t);
    const positions = new Float32Array(12000 * 9);
    for (let i = 0; i < 12000; i++) positions.set([i,0.123456,0,i+0.25,0.123456,0,i,0.123456,0.25], i*9);
    await export3MF(geometry(positions));
    const blob = getBlob();
    assert.equal(blob.type, 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml');
    const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    assert.deepEqual(Object.keys(entries), ['[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model']);
    const xml = strFromU8(entries['3D/3dmodel.model']);
    assert.ok(xml.length > 1 << 20);
    const vertices = [...xml.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g)];
    const faces = [...xml.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"\/>/g)];
    assert.equal(vertices.length, 36000);
    assert.equal(faces.length, 12000);
    for (let i = 0; i < 12000; i++) {
      assert.deepEqual(vertices[i*3].slice(1), [String(i), '0.1235', '0']);
      assert.deepEqual(vertices[i*3+1].slice(1), [String(i+0.25), '0.1235', '0']);
      assert.deepEqual(vertices[i*3+2].slice(1), [String(i), '0.1235', '0.25']);
      assert.deepEqual(faces[i].slice(1).map(Number), [i*3, i*3+1, i*3+2]);
    }
  });
}

test('3MF retains upstream grid welding and signed-zero formatting', async t => {
  const getBlob = captureDownload(t);
  await export3MF(geometry(new Float32Array([0,0,0,1,0,0,0,1,0, 0.00001,0,0,0,1,0,-0.00006,0,1])));
  const xml = strFromU8(unzipSync(new Uint8Array(await getBlob().arrayBuffer()))['3D/3dmodel.model']);
  assert.equal((xml.match(/<vertex /g) || []).length, 4);
  assert.ok(xml.includes('<vertex x="-0.0001" y="0" z="1"/>'));
  assert.ok(xml.includes('<triangle v1="0" v2="2" v3="3"/>'));
});

test('cancelled 3MF export never initiates a download', async t => {
  const getBlob = captureDownload(t);
  await assert.rejects(async () => export3MF(geometry(new Float32Array(9)), 'cancelled.3mf', () => true), /Aborted/);
  assert.equal(getBlob(), undefined);
});
