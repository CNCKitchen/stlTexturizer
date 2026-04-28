// Regression harness for the small-fillet displacement artifact reported on
// cubeWithSmallFillets.stl: cubic mapping with transition smoothing produced
// "needle" spikes and stray non-manifold edges on small fillets where adjacent
// fillet vertices ended up sampling vastly different cubic projections.
//
// Two fixes covered here:
//   1) subdivision.js / displacement.js QUANTISE bumped from 1e4 to 1e5 so that
//      sub-100µm fillet vertices stop falsely merging into the same dedup bucket
//      (which produced zero-length edges and non-manifold output).
//   2) displacement.js cubic block now uses smooth-normal-based blend weights
//      (matching the GLSL preview shader) when the smooth normal is reliable,
//      falling back to the per-face zoneArea path only on knife-edge geometry.
//
// We compare cubic+blend=1, cubic+blend=0, and triplanar against budgets derived
// from a clean run on the test STL.
//
// Run:  node test-fillet-debug.mjs

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

import { subdivide } from './js/subdivision.js';
import { applyDisplacement } from './js/displacement.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STL_PATH  = path.join(__dirname, 'cubeWithSmallFillets.stl');

let _failed = 0;
function expect(label, ok, detail) {
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ''}`);
    _failed++;
  }
}

function parseBinarySTL(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const triCount = dv.getUint32(80, true);
  const positions = new Float32Array(triCount * 9);
  for (let i = 0; i < triCount; i++) {
    const base = 84 + i * 50;
    for (let v = 0; v < 3; v++) {
      const off = base + 12 + v * 12;
      positions[i*9 + v*3]     = dv.getFloat32(off,     true);
      positions[i*9 + v*3 + 1] = dv.getFloat32(off + 4, true);
      positions[i*9 + v*3 + 2] = dv.getFloat32(off + 8, true);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}

function makeNoiseImageData(w, h) {
  // Cell-noise texture — high-frequency content with sharp borders, the kind of
  // displacement map that surfaces the fillet artifact most aggressively.
  const data = new Uint8ClampedArray(w * h * 4);
  const K = 24;
  const cells = [];
  let seed = 13371337;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xFFFFFFFF; };
  for (let i = 0; i < K; i++) cells.push({ x: rand() * w, y: rand() * h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let d2min = Infinity;
      for (const c of cells) {
        let dx = x - c.x; if (dx > w/2) dx -= w; else if (dx < -w/2) dx += w;
        let dy = y - c.y; if (dy > h/2) dy -= h; else if (dy < -h/2) dy += h;
        const d2 = dx*dx + dy*dy;
        if (d2 < d2min) d2min = d2;
      }
      const cellRadius = Math.min(w, h) / Math.sqrt(K);
      let v = 1 - Math.sqrt(d2min) / cellRadius;
      v = Math.max(0, Math.min(1, v));
      const i4 = (y * w + x) * 4;
      const g = (v * 255) | 0;
      data[i4] = g; data[i4+1] = g; data[i4+2] = g; data[i4+3] = 255;
    }
  }
  return { data, width: w, height: h };
}

// Vertex-dedup precision must match the pipeline. 1e5 = 10 µm cells, the same
// threshold subdivision.js / displacement.js settled on.
const QUANT = 1e5;

function analyseEdges(geo) {
  const pa = geo.attributes.position;
  const triCount = pa.count / 3;
  const posToId = new Map();
  let nextId = 0;
  const vertId = new Uint32Array(pa.count);
  for (let i = 0; i < pa.count; i++) {
    const x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i);
    const key = `${Math.round(x*QUANT)}_${Math.round(y*QUANT)}_${Math.round(z*QUANT)}`;
    let id = posToId.get(key);
    if (id === undefined) { id = nextId++; posToId.set(key, id); }
    vertId[i] = id;
  }
  const ek = (a, b) => a < b ? a * nextId + b : b * nextId + a;
  const edgeMap = new Map();
  for (let t = 0; t < triCount; t++) {
    const a = vertId[t*3], b = vertId[t*3+1], c = vertId[t*3+2];
    if (a === b || b === c || c === a) continue; // skip degenerate triangles
    for (const [u, v] of [[a,b],[b,c],[c,a]]) {
      const k = ek(u, v);
      edgeMap.set(k, (edgeMap.get(k) || 0) + 1);
    }
  }
  let open = 0, nonManifold = 0;
  for (const c of edgeMap.values()) {
    if (c === 1) open++;
    else if (c > 2) nonManifold++;
  }
  return { open, nonManifold };
}

function findFilletFaces(geo) {
  const pa = geo.attributes.position.array;
  const triCount = pa.length / 9;
  const out = [];
  for (let t = 0; t < triCount; t++) {
    const b = t * 9;
    const ux = pa[b+3]-pa[b],   uy = pa[b+4]-pa[b+1], uz = pa[b+5]-pa[b+2];
    const vx = pa[b+6]-pa[b],   vy = pa[b+7]-pa[b+1], vz = pa[b+8]-pa[b+2];
    let nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
    const L = Math.sqrt(nx*nx+ny*ny+nz*nz) || 1;
    nx /= L; ny /= L; nz /= L;
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    if (Math.max(ax, ay, az) < 0.999) out.push(t);
  }
  return out;
}

function dihedralStats(geo, faceSet) {
  const pa = geo.attributes.position.array;
  const triCount = pa.length / 9;
  const posToId = new Map();
  let nextId = 0;
  const vertId = new Uint32Array(triCount * 3);
  for (let i = 0; i < triCount * 3; i++) {
    const x = pa[i*3], y = pa[i*3+1], z = pa[i*3+2];
    const key = `${Math.round(x*QUANT)}_${Math.round(y*QUANT)}_${Math.round(z*QUANT)}`;
    let id = posToId.get(key);
    if (id === undefined) { id = nextId++; posToId.set(key, id); }
    vertId[i] = id;
  }
  const ek = (a, b) => a < b ? a * nextId + b : b * nextId + a;
  const edgeFaces = new Map();
  const inSet = new Uint8Array(triCount);
  for (const t of faceSet) inSet[t] = 1;
  for (let t = 0; t < triCount; t++) {
    if (!inSet[t]) continue;
    const a = vertId[t*3], b = vertId[t*3+1], c = vertId[t*3+2];
    for (const k of [ek(a,b), ek(b,c), ek(c,a)]) {
      let arr = edgeFaces.get(k);
      if (!arr) { arr = []; edgeFaces.set(k, arr); }
      arr.push(t);
    }
  }
  const dihedrals = [];
  for (const arr of edgeFaces.values()) {
    if (arr.length !== 2) continue;
    const n1 = faceNormal(pa, arr[0]);
    const n2 = faceNormal(pa, arr[1]);
    const dot = n1[0]*n2[0] + n1[1]*n2[1] + n1[2]*n2[2];
    dihedrals.push(Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI);
  }
  if (!dihedrals.length) return { count: 0 };
  dihedrals.sort((a, b) => a - b);
  // Edges with dihedral > 90° are physically impossible on a smooth surface;
  // they signal a flipped or spike triangle. Track that fraction explicitly —
  // p95 alone hides spikes that affect <5% of edges (the visible 45° flat
  // spikes on a fillet are exactly that kind of low-density artifact).
  let extreme = 0;
  for (const d of dihedrals) if (d > 90) extreme++;
  return {
    count: dihedrals.length,
    p95:  dihedrals[Math.floor(dihedrals.length * 0.95)],
    mean: dihedrals.reduce((s,v)=>s+v,0) / dihedrals.length,
    extremeFrac: extreme / dihedrals.length,
  };
}

function faceNormal(pa, t) {
  const b = t * 9;
  const ux = pa[b+3]-pa[b],   uy = pa[b+4]-pa[b+1], uz = pa[b+5]-pa[b+2];
  const vx = pa[b+6]-pa[b],   vy = pa[b+7]-pa[b+1], vz = pa[b+8]-pa[b+2];
  let nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
  const L = Math.sqrt(nx*nx+ny*ny+nz*nz) || 1;
  return [nx/L, ny/L, nz/L];
}

async function runCase(label, settings, inputGeo, bounds, refineLength, tex) {
  const { geometry: subdivided } = await subdivide(
    inputGeo.clone(), refineLength, null, null, { fast: false }
  );
  const subDiag = analyseEdges(subdivided);
  const subTris = subdivided.attributes.position.count / 3;

  const displaced = applyDisplacement(
    subdivided, tex, tex.width, tex.height, settings, bounds
  );
  const outDiag = analyseEdges(displaced);
  const fillets = findFilletFaces(displaced);
  const dh = dihedralStats(displaced, fillets);
  return { sub: subDiag, subTris, out: outDiag, dh, displaced };
}

async function main() {
  const buf = fs.readFileSync(STL_PATH);
  const inputGeo = parseBinarySTL(buf);
  inputGeo.computeBoundingBox();
  const c = new THREE.Vector3(); inputGeo.boundingBox.getCenter(c);
  inputGeo.translate(-c.x, -c.y, -c.z);
  inputGeo.computeBoundingBox();

  const min = inputGeo.boundingBox.min.clone();
  const max = inputGeo.boundingBox.max.clone();
  const size = new THREE.Vector3(); inputGeo.boundingBox.getSize(size);
  const center = new THREE.Vector3(); inputGeo.boundingBox.getCenter(center);
  const bounds = { min, max, center, size };

  const inDiag = analyseEdges(inputGeo);
  console.log(`Input: open=${inDiag.open}, NM=${inDiag.nonManifold}`);
  expect('input mesh is closed (0 open edges)', inDiag.open === 0);
  expect('input mesh is manifold (0 NM edges)', inDiag.nonManifold === 0);

  const refineLength = Math.min(size.x, size.y, size.z) * 0.05;
  const tex = makeNoiseImageData(256, 256);

  const baseSettings = {
    scaleU: 1, scaleV: 1,
    offsetU: 0, offsetV: 0,
    rotation: 0,
    amplitude: Math.min(size.x, size.y, size.z) * 0.05,
    bottomAngleLimit: 0,
    topAngleLimit: 0,
    boundaryFalloff: 0,
    symmetricDisplacement: true,
    noDownwardZ: false,
    cylinderCenterX: 0, cylinderCenterY: 0,
    cylinderRadius: Math.max(size.x, size.y) * 0.5,
    capAngle: 20,
  };

  console.log('\nTest 1: cubic + transition smoothing (mappingBlend=1) — the user-reported failure');
  const r1 = await runCase('cubic_blend1', { ...baseSettings,
    mappingMode: 6, mappingBlend: 1, seamBandWidth: 0.5, _debugSliver: true,
  }, inputGeo, bounds, refineLength, tex);
  console.log(`  subTris=${r1.subTris}; sub: open=${r1.sub.open} NM=${r1.sub.nonManifold}; out: open=${r1.out.open} NM=${r1.out.nonManifold}; dh p95=${r1.dh.p95.toFixed(2)}° mean=${r1.dh.mean.toFixed(2)}° extreme>${(r1.dh.extremeFrac*100).toFixed(2)}%`);
  expect('cubic+blend1: subdivision is manifold (no NM edges)', r1.sub.nonManifold === 0);
  expect('cubic+blend1: displaced output is closed', r1.out.open === 0);
  expect('cubic+blend1: displaced output has at most 5 NM edges', r1.out.nonManifold <= 5,
         `got ${r1.out.nonManifold}`);
  // Pre-fix the p95 dihedral on this model with this texture was ~49°.
  // After the fix it tracks the triplanar baseline (~25°). Budget at 30° gives
  // a hard regression signal if the fillet artifact comes back.
  expect('cubic+blend1: fillet p95 dihedral ≤ 30° (no needle spikes)',
         r1.dh.p95 < 30, `got ${r1.dh.p95.toFixed(2)}°`);
  // Fraction of >90° edges. Pre-fix this was ~1.6% (cubic_blend1) vs ~0.8%
  // for triplanar; my earlier needle-fix dropped cubic to ~1.04%. The
  // residual is from sub-µm slivers in the *input* CAD tessellation that
  // subdivision propagates — eliminating those would require a per-vertex
  // sliver-cleanup that materially changes the output triangle topology
  // (it triples tri count or mangles the small fillet shape, both worse
  // than the residual artifact). Budget set generously above current
  // baseline so future regressions on this metric still trip the test.
  expect('cubic+blend1: extreme dihedral fraction ≤ 1.2%',
         r1.dh.extremeFrac < 0.012, `got ${(r1.dh.extremeFrac*100).toFixed(3)}%`);
  // Subdivision should not balloon triangle count. Baseline ~187k for this
  // model at refineLength = size × 0.05; budget catches a regression that
  // pushes it past 250k and OOMs the browser on real-world meshes.
  expect('cubic+blend1: subdivided triangle count ≤ 250k',
         r1.subTris < 250000, `got ${r1.subTris.toLocaleString()}`);

  console.log('\nTest 2: cubic + sharp seams (mappingBlend=0) — must remain stable');
  const r2 = await runCase('cubic_blend0', { ...baseSettings,
    mappingMode: 6, mappingBlend: 0, seamBandWidth: 0.5,
  }, inputGeo, bounds, refineLength, tex);
  console.log(`  subTris=${r2.subTris}; sub: open=${r2.sub.open} NM=${r2.sub.nonManifold}; out: open=${r2.out.open} NM=${r2.out.nonManifold}; dh p95=${r2.dh.p95.toFixed(2)}° mean=${r2.dh.mean.toFixed(2)}°`);
  expect('cubic+blend0: subdivision is manifold', r2.sub.nonManifold === 0);
  expect('cubic+blend0: displaced output has at most 5 NM edges', r2.out.nonManifold <= 5);
  expect('cubic+blend0: fillet p95 dihedral ≤ 30°', r2.dh.p95 < 30,
         `got ${r2.dh.p95.toFixed(2)}°`);

  console.log('\nTest 3: triplanar — sanity baseline');
  const r3 = await runCase('triplanar', { ...baseSettings,
    mappingMode: 5, mappingBlend: 0, seamBandWidth: 0.5,
  }, inputGeo, bounds, refineLength, tex);
  console.log(`  subTris=${r3.subTris}; sub: open=${r3.sub.open} NM=${r3.sub.nonManifold}; out: open=${r3.out.open} NM=${r3.out.nonManifold}; dh p95=${r3.dh.p95.toFixed(2)}° mean=${r3.dh.mean.toFixed(2)}°`);
  expect('triplanar: subdivision is manifold', r3.sub.nonManifold === 0);
  expect('triplanar: displaced output is closed', r3.out.open === 0);
  expect('triplanar: displaced output is manifold', r3.out.nonManifold === 0);
  expect('triplanar: fillet p95 dihedral ≤ 30°', r3.dh.p95 < 30,
         `got ${r3.dh.p95.toFixed(2)}°`);

  console.log(`\n${_failed === 0 ? 'All tests PASSED' : `${_failed} test(s) FAILED`}`);
  process.exit(_failed === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
