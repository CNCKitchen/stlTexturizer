/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Hunt residual tile-seam artifacts in the FINAL exported geometry.
//
// Runs the real export pipeline on a flat plate (planar-XY mapping, bubble
// texture, four tiles across), then measures the dihedral angle of every
// interior edge of the result â€” the quantity that catches light as a "line"
// in slicer renders. If tile seams leave a physical crease, edges near
// u/v-integer world lines will show systematically higher dihedral angles
// than the rest of the surface.
//
//   node diag-seam-dihedral.mjs textures/bubble.png
import { readFileSync } from 'fs';
import { unzlibSync } from 'fflate';
import * as THREE from 'three';
import { runExportPipeline } from './js/exportPipeline.js';
import { QuantizedPointMap } from './js/meshIndex.js';

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

// â”€â”€ Flat plate 100 Ã— 100 mm in XY (z = 0), coarse input quads â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const L = 100, N = 10, ST = L / N;
const tris = [];
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
  const x0 = i*ST, x1 = (i+1)*ST, y0 = j*ST, y1 = (j+1)*ST;
  tris.push(x0,y0,0, x1,y0,0, x1,y1,0,  x0,y0,0, x1,y1,0, x0,y1,0);
}
const geometry = new THREE.BufferGeometry();
geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tris), 3));
geometry.computeVertexNormals();
const bounds = {
  min: new THREE.Vector3(0, 0, 0), max: new THREE.Vector3(L, L, 0),
  size: new THREE.Vector3(L, L, 0), center: new THREE.Vector3(L/2, L/2, 0),
};

// 'sine' = synthetic perfectly tileable 2D sine â€” uniform smoothness
// everywhere, so ANY seam-aligned dihedral elevation is a pipeline artifact,
// not texture content.
function sineImage(n = 256) {
  const data = new Uint8ClampedArray(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const g = Math.round(255 * (0.5 + 0.25 * Math.sin(2 * Math.PI * (x + 0.5) / n)
                                    + 0.25 * Math.sin(2 * Math.PI * (y + 0.5) / n)));
    const o = (y * n + x) * 4;
    data[o] = data[o+1] = data[o+2] = g; data[o+3] = 255;
  }
  return { data, width: n, height: n };
}
const texArg = process.argv[2] || 'textures/bubble.png';
const img = texArg === 'sine' ? sineImage() : decodePNG(texArg);
const settings = {
  // scaleU/scaleV are absolute mm: 25 mm = legacy relative 0.25 × md(100).
  mappingMode: 0, scaleU: 25, scaleV: 25, amplitude: 0.5, textureHeight: 0.5,
  invertDisplacement: false, offsetU: 0, offsetV: 0, rotation: 0,
  refineLength: 0.2, maxTriangles: 750_000, lockScale: true,
  bottomAngleLimit: 0, topAngleLimit: 0, mappingBlend: 1, seamBandWidth: 0.5,
  textureSmoothing: 0, blendNormalSmoothing: 32, capAngle: 20, boundaryFalloff: 0,
  symmetricDisplacement: false, noDownwardZ: false, smoothBottom: false,
  harvestFlatFaces: true, harvestTol: 0.005, snapSeamlessWrap: true,
  cylinderCenterX: null, cylinderCenterY: null, cylinderRadius: null,
  regularizeEnabled: true, regularizeAspectThreshold: 5, regularizeSlack: 3.0,
  regularizeAggressiveSlack: 8.0, regularizeExtremeAspect: 8,
  regularizeNormalDeg: 15, regularizeAggressiveNormalDeg: 25, regularizeSecondPassMul: 1.1,
};
const regularizeOpts = {
  aspectThreshold: 5, slack: 3.0, aggressiveSlack: 8.0, extremeSliverAspect: 8,
  maxNormalDeltaCos: Math.cos(15 * Math.PI / 180), aggressiveNormalDeltaCos: Math.cos(25 * Math.PI / 180),
};

const result = await runExportPipeline({
  positions: geometry.attributes.position.array,
  faceWeights: null, imageData: img, imgWidth: img.width, imgHeight: img.height,
  settings, bounds, regularizeOpts, mode: 'export',
});
const pa = result.positions;
const triCount = pa.length / 9;
console.log(`pipeline output: ${triCount} tris  repair=${JSON.stringify(result.repairStats)}`);

// â”€â”€ Dihedral angles of interior edges, binned by distance to tile seams â”€â”€â”€â”€â”€
// Tile period: scaleU = 25 mm → seams at x,y = 25, 50, 75.
const P = 25;
const weld = new QuantizedPointMap(1e4, 1 << 22);
const vid = new Uint32Array(triCount * 3);
let nv = 0;
for (let i = 0; i < triCount * 3; i++) {
  const id = weld.getOrSet(pa[i*3], pa[i*3+1], pa[i*3+2], nv);
  if (weld.inserted) nv++;
  vid[i] = id;
}
// face normals
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
const eF0 = [], eF1 = [], eMidX = [], eMidY = [];
for (let t = 0; t < triCount; t++) {
  for (let e = 0; e < 3; e++) {
    const i0 = t*3+e, i1 = t*3+(e+1)%3;
    const a = vid[i0], b = vid[i1];
    if (a === b) continue;
    const lo = a < b ? a : b, hi = a < b ? b : a;
    const ei = edgeIdx.getOrSet(lo, hi, 0, eF0.length);
    if (edgeIdx.inserted) {
      eF0.push(t); eF1.push(-1);
      eMidX.push((pa[i0*3] + pa[i1*3]) / 2);
      eMidY.push((pa[i0*3+1] + pa[i1*3+1]) / 2);
    } else if (eF1[ei] === -1) {
      eF1[ei] = t;
    }
  }
}
// Distance to nearest interior seam line (x or y in {25,50,75}); skip plate
// borders (outer 5 mm) where boundary effects dominate.
const seamDist = (x, y) => {
  let d = Infinity;
  for (const s of [25, 50, 75]) d = Math.min(d, Math.abs(x - s), Math.abs(y - s));
  return d;
};
const bins = [0.1, 0.3, 1, 3, 100]; // mm distance bins
const sumAng = new Float64Array(bins.length), cnt = new Uint32Array(bins.length), maxAng = new Float64Array(bins.length);
const nEdges = eMidX.length;
for (let ei = 0; ei < nEdges; ei++) {
  const f0 = eF0[ei], f1 = eF1[ei];
  if (f1 === -1) continue;
  const x = eMidX[ei], y = eMidY[ei];
  if (x < 5 || x > 95 || y < 5 || y > 95) continue;
  const dot = Math.max(-1, Math.min(1, fn[f0*3]*fn[f1*3] + fn[f0*3+1]*fn[f1*3+1] + fn[f0*3+2]*fn[f1*3+2]));
  const ang = Math.acos(dot) * 180 / Math.PI;
  const d = seamDist(x, y);
  for (let b = 0; b < bins.length; b++) {
    if (d <= bins[b]) { sumAng[b] += ang; cnt[b]++; if (ang > maxAng[b]) maxAng[b] = ang; break; }
  }
}
console.log('\ndihedral angle vs distance to texture-tile seam:');
let lo = 0;
for (let b = 0; b < bins.length; b++) {
  console.log(`  ${String(lo).padStart(4)}â€“${String(bins[b]).padEnd(4)} mm: edges=${String(cnt[b]).padStart(7)}  mean=${(sumAng[b]/Math.max(cnt[b],1)).toFixed(3)}Â°  max=${maxAng[b].toFixed(2)}Â°`);
  lo = bins[b];
}
