// Standalone checks for js/quantize.js.
//
// Run: node test-color-quantize.mjs

import { medianCut } from './js/quantize.js';

let failed = 0;

function check(label, cond, detail = '') {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.error(`  FAIL ${label}${detail ? ` :: ${detail}` : ''}`);
  }
}

function paletteTriplets(palette) {
  const out = [];
  for (let i = 0; i < palette.length; i += 3) {
    out.push([palette[i], palette[i + 1], palette[i + 2]]);
  }
  return out;
}

function findNearColor(palette, target, tolerance = 8) {
  const pals = paletteTriplets(palette);
  return pals.findIndex(([r, g, b]) =>
    Math.abs(r - target[0]) <= tolerance &&
    Math.abs(g - target[1]) <= tolerance &&
    Math.abs(b - target[2]) <= tolerance
  );
}

console.log('\n[1] Empty input');
{
  const { palette, indices } = medianCut(new Uint8Array(0), 32);
  check('empty palette', palette.length === 0);
  check('empty indices', indices.length === 0);
}

console.log('\n[2] Single-color input');
{
  const tri = new Uint8Array(10 * 3);
  for (let i = 0; i < 10; i++) {
    tri[i * 3] = 12;
    tri[i * 3 + 1] = 34;
    tri[i * 3 + 2] = 56;
  }
  const { palette, indices } = medianCut(tri, 32);
  check('emits one bucket', palette.length === 3, JSON.stringify(paletteTriplets(palette)));
  check('preserves source color', palette[0] === 12 && palette[1] === 34 && palette[2] === 56);
  check('all triangles point to bucket 0', Array.from(indices).every(i => i === 0));
}

console.log('\n[3] Tiny outlier cluster');
{
  const brown = [90, 60, 30];
  const white = [255, 255, 255];
  const tri = new Uint8Array(1003 * 3);
  for (let i = 0; i < 1000; i++) {
    tri[i * 3] = brown[0];
    tri[i * 3 + 1] = brown[1];
    tri[i * 3 + 2] = brown[2];
  }
  for (let i = 1000; i < 1003; i++) {
    tri[i * 3] = white[0];
    tri[i * 3 + 1] = white[1];
    tri[i * 3 + 2] = white[2];
  }

  const { palette, indices } = medianCut(tri, 4);
  const whiteBucket = findNearColor(palette, white, 0);
  const whiteCount = whiteBucket >= 0
    ? Array.from(indices).filter(i => i === whiteBucket).length
    : 0;

  check('keeps a white palette entry', whiteBucket >= 0, JSON.stringify(paletteTriplets(palette)));
  check('assigns the outlier triangles to white', whiteCount === 3, `whiteCount=${whiteCount}`);
}

console.log('\n[4] Smooth ramp stays bounded');
{
  const tri = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    tri[i * 3] = i;
    tri[i * 3 + 1] = i;
    tri[i * 3 + 2] = i;
  }
  const { palette, indices } = medianCut(tri, 8);
  check('uses requested cap', palette.length <= 8 * 3, `palette=${palette.length / 3}`);
  check('produces one index per triangle', indices.length === 256);
}

if (failed) {
  console.error(`\nFAIL: ${failed} failure(s)`);
  process.exit(1);
}
console.log('\nAll color quantize tests passed');
