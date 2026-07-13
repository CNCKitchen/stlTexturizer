/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Diagnose the "Snap near-bottom vertices" (smoothBottom) defects: run the
// REAL export pipeline on a model with smoothBottom on/off, simulate the
// export→import round-trip (toFixed(4)+fround → weld 1e4 → drop slivers),
// and report open/non-manifold edges + disconnected shells the way the app's
// import warning sees them. Also bins the non-manifold edges by height above
// the bottom plane to localise the damage.
//
//   node diag-bottom-snap.mjs "Parking rack bits_fixed.stl" textures/dots.png 0.2 2000000
import { readFileSync } from 'fs';
import { unzlibSync } from 'fflate';
import * as THREE from 'three';
import { runExportPipeline } from './js/exportPipeline.js';
import { buildFaceWeights } from './js/exclusion.js';
import { QuantizedPointMap } from './js/meshIndex.js';

const stlPath = process.argv[2];
const texPath = process.argv[3];
const refineLength = +(process.argv[4] || 0.2);
const maxTriangles = +(process.argv[5] || 2_000_000);

const baseSettings = {
  mappingMode: 5, scaleU: 0.5, scaleV: 0.5, amplitude: 0.5, textureHeight: 0.5,
  invertDisplacement: false, offsetU: 0, offsetV: 0, rotation: 0,
  refineLength, maxTriangles, lockScale: true,
  bottomAngleLimit: 5, topAngleLimit: 0, mappingBlend: 1, seamBandWidth: 0.5,
  textureSmoothing: 0, blendNormalSmoothing: 32, capAngle: 20, boundaryFalloff: 0,
  symmetricDisplacement: false, noDownwardZ: false,
  harvestFlatFaces: true, harvestTol: 0.005, snapSeamlessWrap: true,
  cylinderCenterX: null, cylinderCenterY: null, cylinderRadius: null,
  regularizeEnabled: true, regularizeAspectThreshold: 5, regularizeSlack: 3.0,
  regularizeAggressiveSlack: 8.0, regularizeExtremeAspect: 8,
  regularizeNormalDeg: 15, regularizeAggressiveNormalDeg: 25, regularizeSecondPassMul: 1.1,
};
const regularizeOpts = {
  aspectThreshold: baseSettings.regularizeAspectThreshold,
  slack: baseSettings.regularizeSlack, aggressiveSlack: baseSettings.regularizeAggressiveSlack,
  extremeSliverAspect: baseSettings.regularizeExtremeAspect,
  maxNormalDeltaCos: Math.cos(baseSettings.regularizeNormalDeg * Math.PI / 180),
  aggressiveNormalDeltaCos: Math.cos(baseSettings.regularizeAggressiveNormalDeg * Math.PI / 180),
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
  // Centre — matches stlLoader.setupGeometry (the app centres on load)
  g.computeBoundingBox();
  const c = new THREE.Vector3();
  g.boundingBox.getCenter(c);
  g.translate(-c.x, -c.y, -c.z);
  g.computeBoundingBox();
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

// Simulate export→import round-trip, then analyse like the app's import check.
function roundTripAnalysis(positions, bottomZ) {
  const n = positions.length / 3;
  // 1. Export rounding: toFixed(4) → float32 (what the file actually stores)
  const rt = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i++) rt[i] = Math.fround(parseFloat(positions[i].toFixed(4)));
  // 2. Importer deletes area < 1e-12 mm² triangles (validateAndCleanGeometry)
  const triCount = n / 3;
  const keep = new Uint8Array(triCount);
  let kept = 0;
  for (let t = 0; t < triCount; t++) {
    const b = t * 9;
    const ux = rt[b+3]-rt[b], uy = rt[b+4]-rt[b+1], uz = rt[b+5]-rt[b+2];
    const vx = rt[b+6]-rt[b], vy = rt[b+7]-rt[b+1], vz = rt[b+8]-rt[b+2];
    const a2 = (uy*vz-uz*vy)**2 + (uz*vx-ux*vz)**2 + (ux*vy-uy*vx)**2;
    if (a2 >= 1e-24) { keep[t] = 1; kept++; }
  }
  // 3. Weld at 1e4 (buildAdjacency grid), build edge map
  const weld = new QuantizedPointMap(1e4, Math.min(n, 1 << 22));
  const vid = new Uint32Array(n);
  let nv = 0;
  for (let i = 0; i < n; i++) {
    const id = weld.getOrSet(rt[i*3], rt[i*3+1], rt[i*3+2], nv);
    if (weld.inserted) nv++;
    vid[i] = id;
  }
  const edgeIdx = new QuantizedPointMap(1, 1 << 20);
  const eCount = [];
  const eZ = [];       // representative edge midpoint height above bottom
  const eA = [], eB = []; // adjacency build: first two faces per edge
  const adjacency = [];
  for (let t = 0; t < triCount; t++) adjacency.push(keep[t] ? [] : null);
  for (let t = 0; t < triCount; t++) {
    if (!keep[t]) continue;
    for (let e = 0; e < 3; e++) {
      const i0 = t*3+e, i1 = t*3+(e+1)%3;
      const a = vid[i0], b = vid[i1];
      if (a === b) continue;
      const lo = a < b ? a : b, hi = a < b ? b : a;
      const ei = edgeIdx.getOrSet(lo, hi, 0, eCount.length);
      if (edgeIdx.inserted) {
        eCount.push(1);
        eZ.push(((rt[i0*3+2] + rt[i1*3+2]) / 2) - bottomZ);
        eA.push(t); eB.push(-1);
      } else {
        eCount[ei]++;
        if (eB[ei] === -1) eB[ei] = t;
      }
    }
  }
  let open = 0, nm = 0;
  const nmZ = [];
  for (let ei = 0; ei < eCount.length; ei++) {
    if (eCount[ei] === 1) open++;
    else if (eCount[ei] > 2) { nm++; nmZ.push(eZ[ei]); }
    else {
      // manifold edge → adjacency for shell BFS
      adjacency[eA[ei]].push(eB[ei]);
      adjacency[eB[ei]].push(eA[ei]);
    }
  }
  // 4. Shell count via BFS over manifold adjacency (mirrors countShells)
  const visited = new Uint8Array(triCount);
  let shells = 0;
  for (let s = 0; s < triCount; s++) {
    if (!keep[s] || visited[s]) continue;
    shells++;
    const q = [s]; visited[s] = 1;
    let head = 0;
    while (head < q.length) {
      const cur = q[head++];
      for (const nb of adjacency[cur]) {
        if (!visited[nb]) { visited[nb] = 1; q.push(nb); }
      }
    }
  }
  // 5. Histogram of nm-edge heights above bottom
  const bins = { 'z=0.0000': 0, '0<z<=0.05': 0, '0.05<z<=0.1': 0, '0.1<z<=0.5': 0, 'z>0.5': 0 };
  for (const z of nmZ) {
    if (Math.abs(z) < 5e-5) bins['z=0.0000']++;
    else if (z <= 0.05) bins['0<z<=0.05']++;
    else if (z <= 0.1) bins['0.05<z<=0.1']++;
    else if (z <= 0.5) bins['0.1<z<=0.5']++;
    else bins['z>0.5']++;
  }
  return { tris: kept, dropped: triCount - kept, open, nm, shells, nmHeightBins: bins };
}

const g = loadSTL(stlPath);
const bb = g.boundingBox;
const bounds = { min: bb.min.clone(), max: bb.max.clone(), size: new THREE.Vector3().subVectors(bb.max, bb.min), center: new THREE.Vector3().addVectors(bb.min, bb.max).multiplyScalar(0.5) };
const img = decodePNG(texPath);
console.log(`model=${stlPath} tris=${g.attributes.position.count/3} bottomZ=${bounds.min.z.toFixed(4)} refine=${refineLength}`);

for (const smoothBottom of [true, false]) {
  const settings = { ...baseSettings, smoothBottom };
  const faceWeights = (settings.bottomAngleLimit > 0 || settings.topAngleLimit > 0)
    ? (() => { // mirror buildCombinedFaceWeights with empty user mask
        const weights = buildFaceWeights(g, new Set(), false);
        const posAttr = g.attributes.position, triCount = posAttr.count / 3;
        const vA=new THREE.Vector3(),vB=new THREE.Vector3(),vC=new THREE.Vector3(),e1=new THREE.Vector3(),e2=new THREE.Vector3(),fn=new THREE.Vector3();
        for (let t=0;t<triCount;t++){
          if (weights[t*3] > 0.99) continue;
          vA.fromBufferAttribute(posAttr,t*3); vB.fromBufferAttribute(posAttr,t*3+1); vC.fromBufferAttribute(posAttr,t*3+2);
          e1.subVectors(vB,vA); e2.subVectors(vC,vA); fn.crossVectors(e1,e2);
          const area=fn.length(), nz=area>1e-12?fn.z/area:0, ang=Math.acos(Math.abs(nz))*(180/Math.PI);
          const masked = nz<0 ? (settings.bottomAngleLimit>0 && ang<=settings.bottomAngleLimit) : (settings.topAngleLimit>0 && ang<=settings.topAngleLimit);
          if (masked) { weights[t*3]=1; weights[t*3+1]=1; weights[t*3+2]=1; }
        }
        return weights;
      })()
    : null;

  const result = await runExportPipeline({
    positions: g.attributes.position.array,
    faceWeights,
    imageData: img, imgWidth: img.width, imgHeight: img.height,
    settings, bounds, regularizeOpts, mode: 'export',
  });
  const a = roundTripAnalysis(result.positions, bounds.min.z);
  console.log(`\nsmoothBottom=${smoothBottom}`);
  console.log(`  pipeline repairStats: ${JSON.stringify(result.repairStats)}`);
  console.log(`  round-trip: tris=${a.tris} dropped=${a.dropped} open=${a.open} nonManifold=${a.nm} shells=${a.shells}`);
  console.log(`  nm-edge heights above bottom: ${JSON.stringify(a.nmHeightBins)}`);
}
