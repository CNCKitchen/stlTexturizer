/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Diagnose tiling-seam sources: for every preset texture, measure how well
// the image wraps at its edges. For a perfectly tileable texture, the jump
// from the last pixel column back to the first should look like any other
// adjacent-column difference. A much larger wrap jump = the texture itself
// carries a seam, which displacement faithfully reproduces as a ridge/groove
// line on the export (flat shading shows it; the previews hide it behind
// mipmaps / smooth normals / coarser preview meshes).
//
//   node diag-texture-seams.mjs
import { readFileSync, readdirSync } from 'fs';
import { unzlibSync } from 'fflate';

function decodePNG(path) {
  const d = readFileSync(path);
  let p = 8; const idat = []; let w, h, ct, bd;
  while (p < d.length) {
    const len = d.readUInt32BE(p); const type = d.toString('ascii', p+4, p+8);
    const start = p + 8;
    if (type === 'IHDR') { w = d.readUInt32BE(start); h = d.readUInt32BE(start+4); bd = d[start+8]; ct = d[start+9]; }
    else if (type === 'IDAT') idat.push(d.subarray(start, start+len));
    else if (type === 'IEND') break;
    p = start + len + 4;
  }
  if (bd !== 8) throw new Error('bitdepth ' + bd);
  const channels = ct === 0 ? 1 : ct === 2 ? 3 : ct === 4 ? 2 : 4;
  const raw = unzlibSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = new Uint8ClampedArray(w * h); // greyscale (red channel)
  const cur = new Uint8Array(stride), prev = new Uint8Array(stride);
  let rp = 0;
  const paeth = (a,b,c) => { const pp=a+b-c, pa=Math.abs(pp-a), pb=Math.abs(pp-b), pc=Math.abs(pp-c); return pa<=pb&&pa<=pc?a:pb<=pc?b:c; };
  for (let y = 0; y < h; y++) {
    const f = raw[rp++];
    for (let x = 0; x < stride; x++) {
      const rawv = raw[rp++];
      const a = x >= channels ? cur[x-channels] : 0, bb = prev[x], c = x >= channels ? prev[x-channels] : 0;
      cur[x] = (f === 0 ? rawv : f === 1 ? rawv + a : f === 2 ? rawv + bb : f === 3 ? rawv + ((a+bb)>>1) : rawv + paeth(a,bb,c)) & 0xff;
    }
    for (let x = 0; x < w; x++) out[y*w + x] = cur[x*channels];
    prev.set(cur);
  }
  return { g: out, w, h };
}

// Mean |difference| between two pixel columns (or rows).
function colDiff(g, w, h, x0, x1) {
  let s = 0;
  for (let y = 0; y < h; y++) s += Math.abs(g[y*w + x0] - g[y*w + x1]);
  return s / h;
}
function rowDiff(g, w, h, y0, y1) {
  let s = 0;
  for (let x = 0; x < w; x++) s += Math.abs(g[y0*w + x] - g[y1*w + x]);
  return s / w;
}

console.log('texture                    size      interior-step   wrap-X   wrap-Y   verdict');
for (const f of readdirSync('textures').filter(n => n.endsWith('.png')).sort()) {
  let t;
  try { t = decodePNG(`textures/${f}`); } catch (e) { console.log(`${f.padEnd(26)} SKIP (${e.message})`); continue; }
  const { g, w, h } = t;
  // Typical adjacent-column/row difference in the interior (sample a few)
  let interior = 0, n = 0;
  for (let x = 8; x < w - 8; x += Math.max(1, (w / 32) | 0)) { interior += colDiff(g, w, h, x, x + 1); n++; }
  for (let y = 8; y < h - 8; y += Math.max(1, (h / 32) | 0)) { interior += rowDiff(g, w, h, y, y + 1); n++; }
  interior /= n;
  const wrapX = colDiff(g, w, h, w - 1, 0);
  const wrapY = rowDiff(g, w, h, h - 1, 0);
  const worst = Math.max(wrapX, wrapY) / Math.max(interior, 0.01);
  const verdict = worst < 1.5 ? 'seamless' : worst < 3 ? 'slight seam' : 'SEAM';
  console.log(`${f.padEnd(26)} ${String(w).padStart(4)}x${String(h).padEnd(5)} ${interior.toFixed(2).padStart(9)} ${wrapX.toFixed(2).padStart(11)} ${wrapY.toFixed(2).padStart(8)}   ${verdict} (${worst.toFixed(1)}x)`);
}
