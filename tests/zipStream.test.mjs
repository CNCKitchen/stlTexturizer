/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strToU8, strFromU8 } from 'fflate';
import { zipChunks } from '../js/zipStream.js';

for (const native of [true, false]) {
  test(`streaming ZIP preserves chunks, empty entries and CRC (${native ? 'native' : 'fallback'})`, async t => {
    if (!native) t.mock.method(globalThis, 'CompressionStream', function () { throw new TypeError('unsupported'); });
    const repeated = strToU8('exact coordinates 0.0000000009313225746154785\n'.repeat(40000));
    function* chunks() {
      for (let i = 0; i < repeated.length; i += 65536) yield repeated.subarray(i, i + 65536);
    }
    const blob = await zipChunks([
      ['checksum.txt', [strToU8('123'), strToU8('456789')]],
      ['mesh.xml', chunks()], ['empty', []],
    ]);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const decoded = unzipSync(bytes);
    assert.equal(strFromU8(decoded['checksum.txt']), '123456789');
    assert.deepEqual(decoded['mesh.xml'], repeated);
    assert.equal(decoded.empty.length, 0);
    assert.ok(bytes.length < repeated.length / 10);
    const view = new DataView(bytes.buffer);
    const central = view.getUint32(bytes.length - 6, true);
    assert.equal(view.getUint32(central, true), 0x02014b50);
    assert.equal(view.getUint16(central + 10, true), 8); // Standard ZIP DEFLATE
    assert.equal(view.getUint32(central + 16, true), 0xcbf43926);
    assert.equal(view.getUint32(central + 24, true), 9);
  });
}

test('streaming ZIP stops consuming input after cancellation', async () => {
  let cancelled = false;
  function* chunks() {
    yield strToU8('first');
    cancelled = true;
    yield strToU8('second');
    assert.fail('must not request another chunk');
  }
  await assert.rejects(zipChunks([['mesh', chunks()]], () => cancelled), /Aborted/);
});

test('streaming ZIP propagates an input failure without returning a partial archive', async () => {
  function* chunks() { yield strToU8('first'); throw new Error('source failed'); }
  await assert.rejects(zipChunks([['mesh', chunks()]]), /source failed/);
});

test('native compression failure rejects instead of downloading a partial archive', async t => {
  t.mock.method(globalThis, 'CompressionStream', function () {
    return new TransformStream({ transform() { throw new Error('compression failed'); } });
  });
  await assert.rejects(zipChunks([['mesh', [strToU8('data')]]]), /compression failed/);
});
