/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { subdivide } from '../js/subdivision.js';
import { applyDisplacement } from '../js/displacement.js';

// Issue #150: the Smooth Mask (boundaryFalloff) must ramp up from the mask
// BOUNDARY only. The export used to measure the distance to every position of
// the masked region, so a masked surface lying closer than the falloff
// distance behind a textured one (a thin wall) dented the textured face around
// each of its vertices — craters the preview never showed.

const THICK = 0.5;     // slab thickness (mm), below the falloff distance
const FALLOFF = 1;     // Smooth Mask distance (mm)
const AMP = 0.4;       // texture height (mm)

/** 20 × 20 mm slab, only the top face textured; the dense bottom face sits THICK below it. */
function maskedSlab() {
  const geo = new THREE.BoxGeometry(20, 20, THICK, 20, 20, 1).toNonIndexed();
  geo.computeVertexNormals();
  const p = geo.attributes.position.array;
  const tris = p.length / 9;
  const weights = new Float32Array(tris * 3);
  for (let t = 0; t < tris; t++) {
    const o = t * 9;
    const top = p[o + 2] > 0 && p[o + 5] > 0 && p[o + 8] > 0;
    weights[t * 3] = weights[t * 3 + 1] = weights[t * 3 + 2] = top ? 0 : 1;
  }
  return { geo, weights };
}

const settings = {
  mappingMode: 0, scaleU: 1, scaleV: 1, offsetU: 0, offsetV: 0, rotation: 0,
  amplitude: AMP, textureHeight: AMP, invertDisplacement: false, symmetricDisplacement: false,
  mappingBlend: 0, seamBandWidth: 0.35, capAngle: 20, textureSmoothing: 0,
  bottomAngleLimit: 0, topAngleLimit: 0, noDownwardZ: false, lockScale: true,
  boundaryFalloff: FALLOFF, boundaryFalloffCurve: 'linear',
};

test('Smooth Mask ignores masked positions behind a thin wall (#150)', async () => {
  const { geo, weights } = maskedSlab();
  const { geometry: refined } = await subdivide(geo, 1, () => {}, weights);
  const white = { data: new Uint8ClampedArray([255, 255, 255, 255]), width: 1, height: 1 };
  refined.computeBoundingBox();
  const bb = refined.boundingBox;
  const bounds = { min: bb.min, max: bb.max, size: bb.getSize(new THREE.Vector3()), center: bb.getCenter(new THREE.Vector3()) };
  const out = applyDisplacement(refined, white, 1, 1, settings, bounds);

  // Top-face corners farther than FALLOFF from the top face's rim get the full height.
  const p = out.attributes.position.array;
  const inner = 10 - FALLOFF - 0.5;
  let checked = 0;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    if (z < 0 || Math.abs(x) > inner || Math.abs(y) > inner) continue;
    assert.ok(Math.abs(z - (THICK / 2 + AMP)) < 1e-4, `top corner at (${x}, ${y}) displaced to z = ${z}`);
    checked++;
  }
  assert.ok(checked > 100, `checked ${checked} top corners`);
});
