/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Where does the pipeline stop giving you the resolution you asked for?
//
// Sweeps a model across a range of physical sizes and reports, for each size,
// what "Suggest values" recommends and which ceiling — texture detail, the
// subdivision triangle budget, or the output-triangle recommendation ceiling —
// is the binding one. Run before/after a cap change to see the effect.
//
//   node diag-quality-ceiling.mjs <model.stl> <texture.png> [tileMm] [budgetGB]
import { readFileSync } from 'fs';
import { unzlibSync } from 'fflate';
import * as THREE from 'three';
import { computeSmartResolution } from './js/smartResolution.js';
import { subdivisionCapFor, outputCeilingFor, PIPELINE_BYTES_PER_TRIANGLE } from './js/memoryBudget.js';

const stlPath = process.argv[2];
const texPath = process.argv[3];
const tileMm  = +(process.argv[4] || 10);
const budgetGB = +(process.argv[5] || 4);
const budgetBytes = budgetGB * 1024 * 1024 * 1024;

function loadSTL(path) {
  const b = readFileSync(path);
  const n = b.readUInt32LE(80);
  const pos = new Float32Array(n * 9);
  let o = 84;
  for (let i = 0; i < n; i++) { o += 12; for (let v = 0; v < 9; v++) { pos[i*9+v] = b.readFloatLE(o); o += 4; } o += 2; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return g;
}

function decodePNG(path) {
  const d = readFileSync(path);
  let p = 8; const idat = []; let w, h, ct, bd;
  while (p < d.length) {
    const len = d.readUInt32BE(p); const type = d.toString('ascii', p+4, p+8); const start = p + 8;
    if (type === 'IHDR') { w = d.readUInt32BE(start); h = d.readUInt32BE(start+4); bd = d[start+8]; ct = d[start+9]; }
    else if (type === 'IDAT') idat.push(d.subarray(start, start+len));
    else if (type === 'IEND') break;
    p = start + len + 4;
  }
  const channels = ct === 0 ? 1 : ct === 2 ? 3 : ct === 4 ? 2 : 4;
  const raw = unzlibSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = new Uint8ClampedArray(w * h * 4);
  const cur = new Uint8Array(stride), prev = new Uint8Array(stride);
  let rp = 0;
  const paeth = (a,b,c) => { const pp=a+b-c, pa=Math.abs(pp-a), pb=Math.abs(pp-b), pc=Math.abs(pp-c); return pa<=pb&&pa<=pc?a:pb<=pc?b:c; };
  for (let y = 0; y < h; y++) {
    const f = raw[rp++];
    for (let x = 0; x < stride; x++) {
      const rawv = raw[rp++];
      const a = x >= channels ? cur[x-channels] : 0, bb = prev[x], c = x >= channels ? prev[x-channels] : 0;
      cur[x] = (f===0?rawv:f===1?rawv+a:f===2?rawv+bb:f===3?rawv+((a+bb)>>1):rawv+paeth(a,bb,c)) & 0xff;
    }
    for (let x = 0; x < w; x++) {
      const si = x*channels, di = (y*w+x)*4;
      const r = cur[si], gg = channels>=3?cur[si+1]:cur[si], b2 = channels>=3?cur[si+2]:cur[si];
      out[di]=r; out[di+1]=gg; out[di+2]=b2; out[di+3]=255;
    }
    prev.set(cur);
  }
  return { data: out, width: w, height: h };
}

const base = loadSTL(stlPath);
base.computeBoundingBox();
const baseDiag = base.boundingBox.getSize(new THREE.Vector3()).length();
const img = decodePNG(texPath);

console.log(`model=${stlPath}  tex=${texPath} ${img.width}x${img.height}  texture tile=${tileMm}mm`);
console.log(`memory budget=${budgetGB}GB @ ${PIPELINE_BYTES_PER_TRIANGLE}B/tri` +
  `  ->  subdivision cap=${(subdivisionCapFor(budgetBytes)/1e6).toFixed(1)}M tris` +
  `, output ceiling=${(outputCeilingFor(budgetBytes)/1e6).toFixed(2)}M tris\n`);
console.log('  size(mm)   suggested   detail-limited   budget-limited   est.subdiv    suggested   binding');
console.log('   (diag)     edge mm       edge mm          edge mm          tris        out-tris    ceiling');
console.log('  ' + '-'.repeat(96));

for (const targetDiag of [50, 100, 200, 300, 500, 800, 1200]) {
  const k = targetDiag / baseDiag;
  const g = base.clone();
  const pa = g.attributes.position.array;
  for (let i = 0; i < pa.length; i++) pa[i] *= k;
  g.computeBoundingBox();
  const bb = g.boundingBox;
  const bounds = { min: bb.min.clone(), max: bb.max.clone(),
    size: new THREE.Vector3().subVectors(bb.max, bb.min),
    center: new THREE.Vector3().addVectors(bb.min, bb.max).multiplyScalar(0.5) };

  const settings = { scaleU: tileMm, scaleV: tileMm, amplitude: 0.5,
    textureAspectU: 1, textureAspectV: 1 };
  const r = computeSmartResolution({ geometry: g, bounds, settings, budgetBytes,
    texture: { imageData: img, width: img.width, height: img.height } });
  const d = r.diagnostics;

  const binding = d.edgeClamped ? 'SLIDER CLAMP'
    : d.budgetClamped ? 'TRIANGLE BUDGET' : 'texture detail';
  const outCap = d.recommendedMaxTri >= outputCeilingFor(budgetBytes) ? '  <-- AT CEILING' : '';
  console.log(
    `  ${String(targetDiag).padStart(7)}   ` +
    `${r.edge.toFixed(3).padStart(8)}   ` +
    `${d.detailEdge.toFixed(3).padStart(11)}   ` +
    `${d.budgetEdge.toFixed(3).padStart(14)}   ` +
    `${(d.estTriangles/1e6).toFixed(2).padStart(9)}M   ` +
    `${(d.recommendedMaxTri/1e6).toFixed(2).padStart(9)}M   ` +
    `${binding}${outCap}`
  );
}
console.log('\n  detail-limited edge = what the texture actually needs (the ideal).');
console.log('  budget-limited edge = the coarsest constraint imposed by the triangle budget.');
console.log('  When "budget-limited" exceeds "detail-limited", the budget is throwing away texture detail.');
