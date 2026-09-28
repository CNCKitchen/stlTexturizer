/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Where do non-manifold edges enter the pipeline?
//
// Exports at a high output-triangle target (decimation stops AT the target
// rather than exhausting cheap collapses) come out with large numbers of
// non-manifold edges — 179k at 5M triangles, 1.95M at 11.2M — while the same
// model decimated hard comes out clean. This measures edge defects after each
// stage so the entry point is a fact rather than a guess.
//
//   node --max-old-space-size=16000 diag-manifold-stages.mjs <model.stl> <tex.png> <refineMm> <maxTris> [tileMm]
import { readFileSync } from 'fs';
import { unzlibSync } from 'fflate';
import * as THREE from 'three';
import { subdivide } from './js/subdivision.js';
import { applyDisplacement } from './js/displacement.js';
import { decimate } from './js/decimation.js';
import { regularizeMesh } from './js/regularize.js';
import { resolveTJunctions, countAreaSlivers } from './js/meshRepair.js';
import { QuantizedPointMap, IntPairMap } from './js/meshIndex.js';
import { snapBottomToFlat } from './js/exportPipeline.js';
import { buildFaceWeights } from './js/exclusion.js';

const stlPath = process.argv[2];
const texPath = process.argv[3];
const refineLength = +(process.argv[4] || 0.35);
const maxTriangles = +(process.argv[5] || 5_000_000);
const tileMm = +(process.argv[6] || 25);

function parseSTL(path) {
  const b = readFileSync(path);
  const n = b.readUInt32LE(80);
  const pos = new Float32Array(n * 9);
  let o = 84;
  for (let i = 0; i < n; i++) { o += 12; for (let v = 0; v < 9; v++) { pos[i*9+v] = b.readFloatLE(o); o += 4; } o += 2; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.computeVertexNormals();
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
      const rv = raw[rp++];
      const a = x >= channels ? cur[x-channels] : 0, bb = prev[x], c = x >= channels ? prev[x-channels] : 0;
      cur[x] = (f===0?rv:f===1?rv+a:f===2?rv+bb:f===3?rv+((a+bb)>>1):rv+paeth(a,bb,c)) & 0xff;
    }
    for (let x = 0; x < w; x++) {
      const si = x*channels, di = (y*w+x)*4;
      out[di]=cur[si]; out[di+1]=channels>=3?cur[si+1]:cur[si]; out[di+2]=channels>=3?cur[si+2]:cur[si]; out[di+3]=255;
    }
    prev.set(cur);
  }
  return { data: out, width: w, height: h };
}

// UI defaults, matching what the app actually exports with.
const settings = {
  mappingMode: 0, scaleU: tileMm, scaleV: tileMm, amplitude: 0.5, textureHeight: 0.5,
  invertDisplacement: false, offsetU: 0, offsetV: 0, rotation: 0,
  refineLength, maxTriangles, lockScale: true,
  bottomAngleLimit: 5, topAngleLimit: 0, mappingBlend: 1, seamBandWidth: 0.5,
  textureSmoothing: 0, blendNormalSmoothing: 32, capAngle: 20, boundaryFalloff: 0,
  symmetricDisplacement: false, noDownwardZ: false, smoothBottom: true,
  harvestFlatFaces: true, harvestTol: 0.005, snapSeamlessWrap: true,
  cylinderCenterX: null, cylinderCenterY: null, cylinderRadius: null,
  regularizeEnabled: true, regularizeAspectThreshold: 5, regularizeSlack: 3.0,
  regularizeAggressiveSlack: 8.0, regularizeExtremeAspect: 8,
  regularizeNormalDeg: 15, regularizeAggressiveNormalDeg: 25, regularizeSecondPassMul: 1.1,
  preserveUntextured: true,
};
const regularizeOpts = {
  aspectThreshold: settings.regularizeAspectThreshold,
  slack: settings.regularizeSlack, aggressiveSlack: settings.regularizeAggressiveSlack,
  extremeSliverAspect: settings.regularizeExtremeAspect,
  maxNormalDeltaCos: Math.cos(settings.regularizeNormalDeg * Math.PI / 180),
  aggressiveNormalDeltaCos: Math.cos(settings.regularizeAggressiveNormalDeg * Math.PI / 180),
};

// meshRepair.countEdgeDefects keys edges in a JS Map, which throws
// "Map maximum size exceeded" past V8's ~16.7M entry cap — i.e. above ~11M
// triangles, which is exactly the regime under investigation. Same algorithm
// over typed arrays instead, so it scales.
function edgeDefects(geometry, Q = 1e4) {
  const p = geometry.attributes.position.array, n = p.length / 9;
  const vmap = new QuantizedPointMap(Q, Math.min(n * 3, 1 << 22));
  const id = new Int32Array(n * 3);
  for (let i = 0; i < n * 3; i++) id[i] = vmap.getOrSet(p[i*3], p[i*3+1], p[i*3+2], vmap.size);

  const edges = new IntPairMap(Math.ceil(n * 1.6));
  let nEdges = 0;
  let counts = new Int32Array(Math.ceil(n * 1.8) + 16);
  const tri = [0, 0, 0];
  for (let t = 0; t < n; t++) {
    tri[0] = id[t*3]; tri[1] = id[t*3+1]; tri[2] = id[t*3+2];
    if (tri[0] === tri[1] || tri[1] === tri[2] || tri[0] === tri[2]) continue;
    for (let e = 0; e < 3; e++) {
      const x = tri[e], y = tri[(e+1)%3];
      const lo = x < y ? x : y, hi = x < y ? y : x;
      const slot = edges.getOrSet(lo, hi, nEdges);
      if (edges.inserted) {
        if (nEdges >= counts.length) { const g = new Int32Array(counts.length * 2); g.set(counts); counts = g; }
        nEdges++;
      }
      counts[slot]++;
    }
  }
  let open = 0, nonManifold = 0;
  for (let i = 0; i < nEdges; i++) { if (counts[i] === 1) open++; else if (counts[i] > 2) nonManifold++; }
  return { open, nonManifold, tris: n };
}

function report(label, geo) {
  const d = edgeDefects(geo);
  const s = countAreaSlivers(geo);
  console.log(`  ${label.padEnd(26)} tris=${String(d.tris).padStart(10)}  open=${String(d.open).padStart(7)}  nonManifold=${String(d.nonManifold).padStart(9)}  slivers=${s}`);
  return d;
}

const src = parseSTL(stlPath);
src.computeBoundingBox();
const bb = src.boundingBox;
const bounds = { min: bb.min.clone(), max: bb.max.clone(),
  size: new THREE.Vector3().subVectors(bb.max, bb.min),
  center: new THREE.Vector3().addVectors(bb.min, bb.max).multiplyScalar(0.5) };
const img = decodePNG(texPath);
console.log(`model=${stlPath} tex=${texPath} refine=${refineLength} maxTri=${maxTriangles} tile=${tileMm}mm\n`);
report('0. source', src);

// Angle mask -> face weights (bottomAngleLimit 5, as the UI defaults to).
const weights = buildFaceWeights(src, new Set(), false);
{
  const posAttr = src.attributes.position, triCount = posAttr.count / 3;
  const vA=new THREE.Vector3(),vB=new THREE.Vector3(),vC=new THREE.Vector3(),e1=new THREE.Vector3(),e2=new THREE.Vector3(),fn=new THREE.Vector3();
  for (let t=0;t<triCount;t++){
    vA.fromBufferAttribute(posAttr,t*3); vB.fromBufferAttribute(posAttr,t*3+1); vC.fromBufferAttribute(posAttr,t*3+2);
    e1.subVectors(vB,vA); e2.subVectors(vC,vA); fn.crossVectors(e1,e2);
    const area=fn.length(), nz=area>1e-12?fn.z/area:0, ang=Math.acos(Math.abs(nz))*(180/Math.PI);
    if (nz<0 && ang<=settings.bottomAngleLimit) { weights[t*3]=1; weights[t*3+1]=1; weights[t*3+2]=1; }
  }
}

let { geometry: sub } = await subdivide(src, refineLength, null, weights, { safetyCap: 40_000_000 });
report('1. subdivided', sub);

const reg = regularizeMesh(sub, new Int32Array(sub.attributes.position.count / 3), refineLength, regularizeOpts);
sub.dispose();
const exclAttr = reg.geometry.attributes.excludeWeight;
({ geometry: sub } = await subdivide(reg.geometry, refineLength * settings.regularizeSecondPassMul, null,
  exclAttr ? exclAttr.array : null, { fast: false, safetyCap: 40_000_000 }));
reg.geometry.dispose();
report('2. regularized+resub', sub);

let lockedFaces = null;
{
  const ew = sub.attributes.excludeWeight;
  if (ew) {
    const triN = sub.attributes.position.count / 3;
    lockedFaces = new Uint8Array(triN);
    for (let t = 0; t < triN; t++) if (ew.array[t * 3] > 0.99) lockedFaces[t] = 1;
  }
}

const disp = applyDisplacement(sub, img, img.width, img.height, settings, bounds, null);
sub.dispose();
report('3. displaced', disp);

let fin = await decimate(disp, maxTriangles, null, settings.harvestFlatFaces, settings.harvestTol, lockedFaces, false);
report('4. decimated', fin);

if (settings.smoothBottom) { snapBottomToFlat(fin, bounds.min.z, 0.1); report('5. bottom-snapped', fin); }

const rep = resolveTJunctions(fin);
fin.dispose();
report('6. after resolveTJunctions', rep);
