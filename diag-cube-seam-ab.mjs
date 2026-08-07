/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// A/B the tile-seam crease on Stefan's exact cube project: run the export
// pipeline (whatever sampler the current checkout has) on the 50mm cube with
// Leather 2 / triplanar / amplitude 2, then measure interior-edge dihedral
// angles binned by distance to the mid-face tile wrap lines (in-plane
// coordinate = 0 on a centered cube with 25mm tile period).
//
//   node diag-cube-seam-ab.mjs
import { readFileSync } from 'fs';
import { unzipSync } from 'fflate';
import * as THREE from 'three';
import { runExportPipeline } from './js/exportPipeline.js';
import { QuantizedPointMap } from './js/meshIndex.js';

// ── Inputs: model from the .bumpmesh, leather2 texture, project settings ────
const proj = unzipSync(readFileSync('cube_50x50x50.bumpmesh'));
const settings = JSON.parse(new TextDecoder().decode(proj['settings.json']));
const stl = proj['model.stl'];

function parseSTL(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const n = dv.getUint32(80, true);
  const pos = new Float32Array(n * 9);
  for (let i = 0; i < n; i++) {
    const base = 84 + i * 50;
    for (let v = 0; v < 9; v++) pos[i*9+v] = dv.getFloat32(base + 12 + v*4, true);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.computeVertexNormals();
  g.computeBoundingBox();
  const c = new THREE.Vector3(); g.boundingBox.getCenter(c);
  g.translate(-c.x, -c.y, -c.z);
  g.computeBoundingBox();
  return g;
}

function decodePNG(path) {
  const { unzlibSync } = require('fflate');
  return null; // not used — see below
}
// leather2.png decode (same minimal PNG reader as the other diags)
import { unzlibSync } from 'fflate';
function loadPNG(path) {
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
      cur[x] = (f === 0 ? rawv : f === 1 ? rawv + a : f === 2 ? rawv + bb : f === 3 ? rawv + ((a+bb)>>1) : rawv + paeth(a,bb,c)) & 0xff;
    }
    for (let x = 0; x < w; x++) {
      const si = x * channels, di = (y*w + x) * 4;
      out[di] = cur[si]; out[di+1] = channels >= 3 ? cur[si+1] : cur[si]; out[di+2] = channels >= 3 ? cur[si+2] : cur[si]; out[di+3] = 255;
    }
    prev.set(cur);
  }
  return { data: out, width: w, height: h };
}

const g = parseSTL(stl);
const bb = g.boundingBox;
const bounds = { min: bb.min.clone(), max: bb.max.clone(), size: new THREE.Vector3().subVectors(bb.max, bb.min), center: new THREE.Vector3().addVectors(bb.min, bb.max).multiplyScalar(0.5) };
const img = loadPNG('textures/leather2.png');
const regularizeOpts = {
  aspectThreshold: 5, slack: 3.0, aggressiveSlack: 8.0, extremeSliverAspect: 8,
  maxNormalDeltaCos: Math.cos(15 * Math.PI / 180), aggressiveNormalDeltaCos: Math.cos(25 * Math.PI / 180),
};
const runSettings = { ...settings, regularizeEnabled: true, regularizeSecondPassMul: 1.1 };

const result = await runExportPipeline({
  positions: g.attributes.position.array,
  faceWeights: null, imageData: img, imgWidth: img.width, imgHeight: img.height,
  settings: runSettings, bounds, regularizeOpts, mode: 'export',
});
const pa = result.positions;
const triCount = pa.length / 9;
console.log(`pipeline output: ${triCount} tris  repair=${JSON.stringify(result.repairStats)}`);

// ── Dihedral scan binned by distance to mid-face tile lines ─────────────────
const weld = new QuantizedPointMap(1e4, 1 << 22);
const vid = new Uint32Array(triCount * 3);
let nv = 0;
for (let i = 0; i < triCount * 3; i++) {
  const id = weld.getOrSet(pa[i*3], pa[i*3+1], pa[i*3+2], nv);
  if (weld.inserted) nv++;
  vid[i] = id;
}
const fn = new Float64Array(triCount * 3);
for (let t = 0; t < triCount; t++) {
  const b = t * 9;
  const ux = pa[b+3]-pa[b], uy = pa[b+4]-pa[b+1], uz = pa[b+5]-pa[b+2];
  const vx = pa[b+6]-pa[b], vy = pa[b+7]-pa[b+1], vz = pa[b+8]-pa[b+2];
  let nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
  const len = Math.sqrt(nx*nx+ny*ny+nz*nz) || 1;
  fn[t*3] = nx/len; fn[t*3+1] = ny/len; fn[t*3+2] = nz/len;
}
const edgeIdx = new QuantizedPointMap(1, 1 << 22);
const eF0 = [], eF1 = [], eMid = [];
for (let t = 0; t < triCount; t++) {
  for (let e = 0; e < 3; e++) {
    const i0 = t*3+e, i1 = t*3+(e+1)%3;
    const a = vid[i0], b = vid[i1];
    if (a === b) continue;
    const lo = a < b ? a : b, hi = a < b ? b : a;
    const ei = edgeIdx.getOrSet(lo, hi, 0, eF0.length);
    if (edgeIdx.inserted) {
      eF0.push(t); eF1.push(-1);
      eMid.push([(pa[i0*3]+pa[i1*3])/2, (pa[i0*3+1]+pa[i1*3+1])/2, (pa[i0*3+2]+pa[i1*3+2])/2]);
    } else if (eF1[ei] === -1) eF1[ei] = t;
  }
}
const bins = [0.1, 0.3, 1, 3, 100];
const sumAng = new Float64Array(bins.length), cnt = new Uint32Array(bins.length), maxAng = new Float64Array(bins.length);
for (let ei = 0; ei < eF0.length; ei++) {
  const f0 = eF0[ei], f1 = eF1[ei];
  if (f1 === -1) continue;
  const m = eMid[ei];
  // dominant axis from f0's normal; only mid-face regions (skip cube edges/corners)
  const ax = Math.abs(fn[f0*3]), ay = Math.abs(fn[f0*3+1]), az = Math.abs(fn[f0*3+2]);
  let dom = 0;
  if (ay > ax && ay > az) dom = 1; else if (az > ax && az > ay) dom = 2;
  if (Math.max(ax, ay, az) < 0.9) continue;          // near cube edges — skip
  const inPlane = [0, 1, 2].filter(k => k !== dom);
  if (inPlane.some(k => Math.abs(m[k]) > 22)) continue; // stay clear of cube borders
  // tile wrap lines on a centered 50mm cube with P=25mm: in-plane coord = 0
  const d = Math.min(...inPlane.map(k => Math.abs(m[k])));
  const dot = Math.max(-1, Math.min(1, fn[f0*3]*fn[f1*3] + fn[f0*3+1]*fn[f1*3+1] + fn[f0*3+2]*fn[f1*3+2]));
  const ang = Math.acos(dot) * 180 / Math.PI;
  for (let b = 0; b < bins.length; b++) {
    if (d <= bins[b]) { sumAng[b] += ang; cnt[b]++; if (ang > maxAng[b]) maxAng[b] = ang; break; }
  }
}
console.log('dihedral vs distance to mid-face tile line:');
let lo = 0;
for (let b = 0; b < bins.length; b++) {
  console.log(`  ${String(lo).padStart(4)}-${String(bins[b]).padEnd(4)} mm: edges=${String(cnt[b]).padStart(7)}  mean=${(sumAng[b]/Math.max(cnt[b],1)).toFixed(3)}  max=${maxAng[b].toFixed(2)}`);
  lo = bins[b];
}
