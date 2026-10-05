/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// "Don't modify untextured surfaces" must reach the file exactly: every
// untextured source triangle is either written bit-for-bit or split only at
// points on its own edges (the seam with the texture), all its corners stay
// bit-exact, and the export stays watertight. Runs the real export pipeline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { runExportPipeline } from '../js/exportPipeline.js';
import { buildFaceWeights } from '../js/exclusion.js';
import { countEdgeDefects } from '../js/meshRepair.js';

// Box with every face split into n×n quads, outward winding.
function makeBox(sx, sy, sz, n) {
  const tris = [];
  const face = (o, u, v) => {
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const p = (a, b) => [0, 1, 2].map(k => o[k] + u[k] * a / n + v[k] * b / n);
      const a = p(i, j), b = p(i + 1, j), c = p(i + 1, j + 1), d = p(i, j + 1);
      tris.push(a, b, c, a, c, d);
    }
  };
  face([0, 0, sz], [sx, 0, 0], [0, sy, 0]);
  face([0, 0, 0], [0, sy, 0], [sx, 0, 0]);
  face([0, 0, 0], [sx, 0, 0], [0, 0, sz]);
  face([0, sy, 0], [0, 0, sz], [sx, 0, 0]);
  face([0, 0, 0], [0, 0, sz], [0, sy, 0]);
  face([sx, 0, 0], [0, sy, 0], [0, 0, sz]);
  return new Float32Array(tris.flat());
}

function waveImage(w = 64, h = 64) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = 128 + 120 * Math.sin((i % w) / 3) * Math.cos(((i / w) | 0) / 4);
    data.fill(v, i * 4, i * 4 + 3); data[i * 4 + 3] = 255;
  }
  return { data, width: w, height: h };
}

const settingsFor = (over) => ({
  mappingMode: 5, scaleU: 10, scaleV: 10, amplitude: 0.6, textureHeight: 0.6,
  invertDisplacement: false, offsetU: 0, offsetV: 0, rotation: 0,
  refineLength: 0.6, maxTriangles: 200000, lockScale: true,
  bottomAngleLimit: 5, topAngleLimit: 0, mappingBlend: 1, seamBandWidth: 0.5,
  textureSmoothing: 0, blendNormalSmoothing: 32, capAngle: 20, boundaryFalloff: 0,
  symmetricDisplacement: false, noDownwardZ: false, smoothBottom: true,
  harvestFlatFaces: true, harvestTol: 0.005, snapSeamlessWrap: true,
  cylinderCenterX: null, cylinderCenterY: null, cylinderRadius: null,
  regularizeEnabled: true, regularizeAspectThreshold: 5, regularizeSlack: 3.0,
  regularizeAggressiveSlack: 8.0, regularizeExtremeAspect: 8,
  regularizeNormalDeg: 15, regularizeAggressiveNormalDeg: 25, regularizeSecondPassMul: 1.1,
  preserveUntextured: true, ...over,
});

async function exportBox(over) {
  const SZ = 10;
  const src = makeBox(20, 16, SZ, 3);
  const triN = src.length / 9;
  const excluded = new Set();
  for (let t = 0; t < triN; t++) {
    if (!(src[t * 9 + 2] === SZ && src[t * 9 + 5] === SZ && src[t * 9 + 8] === SZ)) excluded.add(t);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(src.slice(), 3));
  const s = settingsFor(over);
  const img = waveImage();
  const res = await runExportPipeline({
    positions: src.slice(), faceWeights: buildFaceWeights(geo, excluded, false),
    imageData: img, imgWidth: img.width, imgHeight: img.height, settings: s,
    bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 16, z: SZ }, size: { x: 20, y: 16, z: SZ }, center: { x: 10, y: 8, z: SZ / 2 } },
    regularizeOpts: {
      aspectThreshold: 5, slack: 3, aggressiveSlack: 8, extremeSliverAspect: 8,
      maxNormalDeltaCos: Math.cos(15 * Math.PI / 180), aggressiveNormalDeltaCos: Math.cos(25 * Math.PI / 180),
      preserveExcluded: true,
    },
    mode: 'export',
  });
  return { src, excluded, res };
}

const key = (a, i) => `${a[i]},${a[i + 1]},${a[i + 2]}`;

for (const [name, over] of [
  ['decimated', {}],
  ['not decimated', { maxTriangles: 1e9, harvestFlatFaces: false }],
]) {
  test(`untextured surfaces survive the export exactly (${name})`, async () => {
    const { src, excluded, res } = await exportBox(over);
    const out = res.positions;
    assert.ok(res.preserveStats && !res.preserveStats.failed, 'stitch ran and was kept');

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(out, 3));
    const d = countEdgeDefects(g);
    assert.equal(d.open, 0, 'no open edges');
    assert.equal(d.nonManifold, 0, 'no non-manifold edges');

    const outVerts = new Set(), outTris = new Set();
    for (let t = 0; t < out.length / 9; t++) {
      const k = [key(out, t * 9), key(out, t * 9 + 3), key(out, t * 9 + 6)];
      for (const v of k) outVerts.add(v);
      for (let r = 0; r < 3; r++) outTris.add(k[r] + '|' + k[(r + 1) % 3] + '|' + k[(r + 2) % 3]);
    }
    let verbatim = 0;
    for (const t of excluded) {
      const k = [key(src, t * 9), key(src, t * 9 + 3), key(src, t * 9 + 6)];
      for (const v of k) assert.ok(outVerts.has(v), `untextured corner ${v} is bit-exact in the output`);
      if (outTris.has(k.join('|'))) verbatim++;
    }
    // Only triangles touching the textured top may be split (3 per box side).
    assert.ok(verbatim >= excluded.size - 12, `${verbatim}/${excluded.size} untextured triangles verbatim`);
  });
}

// Keep Texture on the Bed: a textured wall meeting the masked bottom face must
// come down onto the bed instead of hanging over it as a lip.
test('textured walls reach the bed (extendUntextured)', async () => {
  const SX = 20, SY = 16, SZ = 10;
  const src = makeBox(SX, SY, SZ, 3);
  const triN = src.length / 9;
  const excluded = new Set();
  for (let t = 0; t < triN; t++) {
    const z = [src[t * 9 + 2], src[t * 9 + 5], src[t * 9 + 8]];
    if (z.every(v => v === 0) || z.every(v => v === SZ)) excluded.add(t); // bottom + top kept
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(src.slice(), 3));
  const s = settingsFor({ extendUntextured: true, mappingMode: 6 });
  const img = waveImage();
  const res = await runExportPipeline({
    positions: src.slice(), faceWeights: buildFaceWeights(geo, excluded, false),
    imageData: img, imgWidth: img.width, imgHeight: img.height, settings: s,
    bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: SX, y: SY, z: SZ }, size: { x: SX, y: SY, z: SZ }, center: { x: SX / 2, y: SY / 2, z: SZ / 2 } },
    regularizeOpts: {
      aspectThreshold: 5, slack: 3, aggressiveSlack: 8, extremeSliverAspect: 8,
      maxNormalDeltaCos: Math.cos(15 * Math.PI / 180), aggressiveNormalDeltaCos: Math.cos(25 * Math.PI / 180),
      preserveExcluded: true,
    },
    mode: 'export',
  });
  const out = res.positions;
  assert.ok(res.flushStats && res.flushStats.strips > 0, 'bed-contact strips were added');
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(out, 3));
  const d = countEdgeDefects(g);
  assert.equal(d.open, 0, 'no open edges');
  assert.equal(d.nonManifold, 0, 'no non-manifold edges');
  // How far the texture reaches out past the box outline, on the bed and in
  // the first 0.5 mm above it: with no lip the bed reaches about as far.
  const outside = (x, y) => Math.max(-x, x - SX, -y, y - SY);
  let onBed = 0, low = 0;
  for (let i = 0; i < out.length; i += 3) {
    const o = outside(out[i], out[i + 1]);
    if (out[i + 2] === 0) onBed = Math.max(onBed, o);
    else if (out[i + 2] <= 0.5) low = Math.max(low, o);
  }
  assert.ok(low > 0.1, `texture pushes the wall out near the bed (${low.toFixed(3)} mm)`);
  assert.ok(onBed >= 0.7 * low, `bed contact reaches ${onBed.toFixed(3)} of ${low.toFixed(3)} mm`);
});
