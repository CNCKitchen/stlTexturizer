/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Diagnostic: histogram of edge-instance counts on the decimate INPUT mesh
// (pipeline up to displacement + bottom snaps), welded at the 1e6 grid.
// Purpose: check whether edges with >=4 incident face-instances exist — those
// trigger the legacy addCreaseQuadrics alternation quirk.
import { readFileSync } from 'fs';
import * as THREE from 'three';
import { subdivide } from './js/subdivision.js';
import { regularizeMesh } from './js/regularize.js';
import { applyDisplacement } from './js/displacement.js';
import { buildFaceWeights } from './js/exclusion.js';
import { QuantizedPointMap } from './js/meshIndex.js';
import { unzlibSync } from 'fflate';

const settings = {
  mappingMode: 5, scaleU: 0.5, scaleV: 0.5, amplitude: 0.5, textureHeight: 0.5,
  invertDisplacement: false, offsetU: 0, offsetV: 0, rotation: 0,
  refineLength: 0.2, maxTriangles: 2_000_000, lockScale: true,
  bottomAngleLimit: 5, topAngleLimit: 0, mappingBlend: 1, seamBandWidth: 0.5,
  textureSmoothing: 0, blendNormalSmoothing: 32, capAngle: 20, boundaryFalloff: 0,
  symmetricDisplacement: false, noDownwardZ: false, smoothBottom: true,
  snapSeamlessWrap: true, cylinderCenterX: null, cylinderCenterY: null, cylinderRadius: null,
};

function loadSTL(path) {
  const b = readFileSync(path);
  const n = b.readUInt32LE(80);
  const pos = new Float32Array(n * 9);
  let o = 84;
  for (let i = 0; i < n; i++) {
    o += 12;
    for (let v = 0; v < 9; v++) { pos[i*9+v] = b.readFloatLE(o); o += 4; }
    o += 2;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}
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
  const channels = ct === 0 ? 1 : ct === 2 ? 3 : 4;
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

const g = loadSTL(process.argv[2]);
g.computeBoundingBox();
const bb = g.boundingBox;
const bounds = { min: bb.min.clone(), max: bb.max.clone(), size: new THREE.Vector3().subVectors(bb.max, bb.min), center: new THREE.Vector3().addVectors(bb.min, bb.max).multiplyScalar(0.5) };
const img = decodePNG(process.argv[3]);
// scaleU/scaleV are absolute mm; 0.5 × maxDim matches the legacy relative 0.5.
{
  const md = Math.max(bounds.size.x, bounds.size.y, bounds.size.z);
  settings.scaleU = 0.5 * md;
  settings.scaleV = 0.5 * md;
}

const fw = buildFaceWeights(g, new Set(), false);
let { geometry: sub } = await subdivide(g, settings.refineLength, null, fw);
const reg = regularizeMesh(sub, new Int32Array(sub.attributes.position.count/3), settings.refineLength, {});
sub.dispose();
const { geometry: resub } = await subdivide(reg.geometry, settings.refineLength*1.1, null, reg.geometry.attributes.excludeWeight ? reg.geometry.attributes.excludeWeight.array : null, { fast: false });
reg.geometry.dispose();
const disp = applyDisplacement(resub, img, img.width, img.height, settings, bounds, null);
resub.dispose();
// bottom snaps (same as export)
{
  const bz = bounds.min.z, pa = disp.attributes.position.array;
  for (let i=0;i<pa.length;i+=9){if(pa[i+2]<bz)pa[i+2]=bz;if(pa[i+5]<bz)pa[i+5]=bz;if(pa[i+8]<bz)pa[i+8]=bz;}
  for(let i=0;i<pa.length;i+=9){if(Math.abs(pa[i+2]-bz)<=0.1)pa[i+2]=bz;if(Math.abs(pa[i+5]-bz)<=0.1)pa[i+5]=bz;if(Math.abs(pa[i+8]-bz)<=0.1)pa[i+8]=bz;}
}

// Weld at 1e6 (decimation grid), then count instances per undirected edge.
const pa = disp.attributes.position.array;
const n = pa.length / 3;
const weld = new QuantizedPointMap(1e6, Math.min(n, 1 << 22));
const vid = new Uint32Array(n);
let nv = 0;
for (let i = 0; i < n; i++) {
  const id = weld.getOrSet(pa[i*3], pa[i*3+1], pa[i*3+2], nv);
  if (weld.inserted) nv++;
  vid[i] = id;
}
const counts = new QuantizedPointMap(1, 1 << 22); // (lo,hi) → index into cnt
const cnt = [];
for (let t = 0; t < n / 3; t++) {
  for (let e = 0; e < 3; e++) {
    const a = vid[t*3+e], b = vid[t*3+(e+1)%3];
    if (a === b) continue;
    const lo = a < b ? a : b, hi = a < b ? b : a;
    const ci = counts.getOrSet(lo, hi, 0, cnt.length);
    if (counts.inserted) cnt.push(1); else cnt[ci]++;
  }
}
const hist = {};
for (const c of cnt) hist[c] = (hist[c] || 0) + 1;
console.log(`decimate input: ${n/3} tris, ${nv} welded verts, ${cnt.length} edges`);
console.log('edge-instance histogram:', JSON.stringify(hist));
