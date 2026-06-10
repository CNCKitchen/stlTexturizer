// Full-pipeline benchmark: subdivide → regularize → re-subdivide → displace →
// bottom snaps → decimate → resolveTJunctions, mirroring handleExport().
// Prints per-stage wall time, peak RSS, and an FNV-1a fingerprint of the final
// position buffer. Run in two checkouts to compare speed AND verify the output
// is bit-identical.
//
//   node bench-pipeline.mjs <model.stl> <texture.png> <refineLength> <maxTriangles>
import { readFileSync } from 'fs';
import { unzlibSync } from 'fflate';
import * as THREE from 'three';
import { subdivide } from './js/subdivision.js';
import { regularizeMesh } from './js/regularize.js';
import { applyDisplacement } from './js/displacement.js';
import { decimate } from './js/decimation.js';
import { resolveTJunctions } from './js/meshRepair.js';
import { buildFaceWeights } from './js/exclusion.js';

const stlPath      = process.argv[2];
const texPath      = process.argv[3];
const refineLength = +(process.argv[4] || 0.2);
const maxTriangles = +(process.argv[5] || 2_000_000);

const settings = {
  mappingMode: 5, scaleU: 0.5, scaleV: 0.5, amplitude: 0.5, textureHeight: 0.5,
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
};
const _regularizeOpts = () => ({
  aspectThreshold: settings.regularizeAspectThreshold,
  slack: settings.regularizeSlack, aggressiveSlack: settings.regularizeAggressiveSlack,
  extremeSliverAspect: settings.regularizeExtremeAspect,
  maxNormalDeltaCos: Math.cos(settings.regularizeNormalDeg * Math.PI / 180),
  aggressiveNormalDeltaCos: Math.cos(settings.regularizeAggressiveNormalDeg * Math.PI / 180),
});

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
  let p = 8; const idat = [];
  let w, h, ct, bd;
  while (p < d.length) {
    const len = d.readUInt32BE(p); const type = d.toString('ascii', p+4, p+8);
    const start = p + 8;
    if (type === 'IHDR') { w = d.readUInt32BE(start); h = d.readUInt32BE(start+4); bd = d[start+8]; ct = d[start+9]; }
    else if (type === 'IDAT') idat.push(d.subarray(start, start+len));
    else if (type === 'IEND') break;
    p = start + len + 4;
  }
  if (bd !== 8) throw new Error('only 8-bit PNG supported');
  const channels = ct === 0 ? 1 : ct === 2 ? 3 : ct === 4 ? 2 : ct === 6 ? 4 : null;
  if (channels === null) throw new Error('unsupported color type ' + ct);
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
      const a = x >= channels ? cur[x-channels] : 0;
      const bb = prev[x];
      const c = x >= channels ? prev[x-channels] : 0;
      let v;
      switch (f) {
        case 0: v = rawv; break;
        case 1: v = rawv + a; break;
        case 2: v = rawv + bb; break;
        case 3: v = rawv + ((a + bb) >> 1); break;
        case 4: v = rawv + paeth(a, bb, c); break;
        default: throw new Error('bad filter ' + f);
      }
      cur[x] = v & 0xff;
    }
    for (let x = 0; x < w; x++) {
      const si = x * channels, di = (y*w + x) * 4;
      let r,gg,b2,al;
      if (channels === 1) { r=gg=b2=cur[si]; al=255; }
      else if (channels === 2) { r=gg=b2=cur[si]; al=cur[si+1]; }
      else if (channels === 3) { r=cur[si]; gg=cur[si+1]; b2=cur[si+2]; al=255; }
      else { r=cur[si]; gg=cur[si+1]; b2=cur[si+2]; al=cur[si+3]; }
      out[di]=r; out[di+1]=gg; out[di+2]=b2; out[di+3]=al;
    }
    prev.set(cur);
  }
  return { data: out, width: w, height: h };
}

function buildCombinedFaceWeights(geometry, excludedFaces, invert, settings) {
  const weights = buildFaceWeights(geometry, excludedFaces, invert);
  const hasAngleMask = settings.bottomAngleLimit > 0 || settings.topAngleLimit > 0;
  if (!hasAngleMask) return weights;
  const posAttr = geometry.attributes.position, triCount = posAttr.count / 3;
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
}
function snapBottomToFlat(geometry, bottomZ, tol=0.1){
  const pa=geometry.attributes.position.array;
  for(let i=0;i<pa.length;i+=9){if(Math.abs(pa[i+2]-bottomZ)<=tol)pa[i+2]=bottomZ;if(Math.abs(pa[i+5]-bottomZ)<=tol)pa[i+5]=bottomZ;if(Math.abs(pa[i+8]-bottomZ)<=tol)pa[i+8]=bottomZ;}
}

// FNV-1a over the byte view of a typed array — order-sensitive fingerprint.
function fnv1a(typed) {
  const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

let peakRss = 0;
const sampleRss = () => { const r = process.memoryUsage().rss; if (r > peakRss) peakRss = r; };
const rssTimer = setInterval(sampleRss, 50);

const t0 = performance.now();
let tPrev = t0;
const stage = (name) => {
  sampleRss();
  const now = performance.now();
  console.log(`  ${name.padEnd(22)} ${((now - tPrev)/1000).toFixed(2)}s`);
  tPrev = now;
};

const currentGeometry = loadSTL(stlPath);
currentGeometry.computeBoundingBox();
const bb = currentGeometry.boundingBox;
const currentBounds = { min: bb.min.clone(), max: bb.max.clone(), size: new THREE.Vector3().subVectors(bb.max,bb.min), center: new THREE.Vector3().addVectors(bb.min,bb.max).multiplyScalar(0.5) };
const img = decodePNG(texPath);
console.log(`model=${stlPath} tris=${currentGeometry.attributes.position.count/3} tex=${img.width}x${img.height} refine=${refineLength} maxTri=${maxTriangles}`);
stage('load');

const faceWeights = buildCombinedFaceWeights(currentGeometry, new Set(), false, settings);
let { geometry: subdivided } = await subdivide(currentGeometry, settings.refineLength, null, faceWeights);
stage(`subdivide1 (${subdivided.attributes.position.count/3} tris)`);

if (settings.regularizeEnabled) {
  const reg = regularizeMesh(subdivided, new Int32Array(subdivided.attributes.position.count/3), settings.refineLength, _regularizeOpts());
  subdivided.dispose();
  stage('regularize');
  const exclAttr = reg.geometry.attributes.excludeWeight;
  const w2 = exclAttr ? exclAttr.array : null;
  const { geometry: resub } = await subdivide(reg.geometry, settings.refineLength*settings.regularizeSecondPassMul, null, w2, { fast:false });
  reg.geometry.dispose();
  subdivided = resub;
  stage(`resubdivide (${subdivided.attributes.position.count/3} tris)`);
}

let displaced = applyDisplacement(subdivided, img, img.width, img.height, settings, currentBounds, null);
subdivided.dispose();
stage('displace');

if (settings.bottomAngleLimit > 0) {
  const bz = currentBounds.min.z, pa = displaced.attributes.position.array;
  for (let i=0;i<pa.length;i+=9){if(pa[i+2]<bz)pa[i+2]=bz;if(pa[i+5]<bz)pa[i+5]=bz;if(pa[i+8]<bz)pa[i+8]=bz;}
}
if (settings.smoothBottom) snapBottomToFlat(displaced, currentBounds.min.z, 0.1);

let finalGeometry = displaced;
const dispTri = displaced.attributes.position.count/3;
if (dispTri > settings.maxTriangles || settings.harvestFlatFaces) {
  finalGeometry = await decimate(displaced, settings.maxTriangles, null, settings.harvestFlatFaces, settings.harvestTol);
  stage(`decimate (${finalGeometry.attributes.position.count/3} tris)`);
}
if (settings.bottomAngleLimit > 0) {
  const bz = currentBounds.min.z, pa = finalGeometry.attributes.position.array;
  for (let i=0;i<pa.length;i+=9){if(pa[i+2]<bz)pa[i+2]=bz;if(pa[i+5]<bz)pa[i+5]=bz;if(pa[i+8]<bz)pa[i+8]=bz;}
}
if (settings.smoothBottom) snapBottomToFlat(finalGeometry, currentBounds.min.z, 0.1);

const repaired = resolveTJunctions(finalGeometry);
stage(`repair (${repaired.attributes.position.count/3} tris)`);

clearInterval(rssTimer);
sampleRss();
const total = (performance.now() - t0) / 1000;
console.log(`TOTAL ${total.toFixed(2)}s  peakRSS ${(peakRss/1024/1024).toFixed(0)}MB`);
console.log(`FINGERPRINT tris=${repaired.attributes.position.count/3} pos=${fnv1a(repaired.attributes.position.array)}`);
