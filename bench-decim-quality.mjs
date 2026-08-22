/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Empirical validation of the Smart-button "minimum-quality-loss" maxTriangles
// formula: target_edge_decim = 3 × PPE × pixMm × √(0.5/max(amp, 0.1)).
//
// For each (STL, texture) pair:
//   1. Subdivide and displace once → reference mesh.
//   2. Decimate to {0.25, 0.5, 1.0, 2.0, 4.0} × formula's recommended count.
//   3. Measure RMS surface distance from sampled points on the reference to
//      the decimated mesh (proxy for visual quality).
//   4. Identify the elbow ratio where error stops improving.
//
// Run: node --max-old-space-size=12288 bench-decim-quality.mjs

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

import { subdivide }           from './js/subdivision.js';
import { applyDisplacement }   from './js/displacement.js';
import { decimate }            from './js/decimation.js';
import { computeSurfaceArea, computeBounds } from './js/stlLoader.js';
import { analyzeTexture }      from './js/textureAnalysis.js';
import { MODE_TRIPLANAR }      from './js/mapping.js';
import { estimateSubdivisionTriCount } from './js/smartResolution.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── STL loader ────────────────────────────────────────────────────────────────
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
  // Centre — matches stlLoader.setupGeometry
  geo.computeBoundingBox();
  const c = new THREE.Vector3();
  geo.boundingBox.getCenter(c);
  geo.translate(-c.x, -c.y, -c.z);
  geo.computeBoundingBox();
  return geo;
}

// ── Synthetic textures ────────────────────────────────────────────────────────
function makeSmoothGradient(size = 512) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const v = (x / (size - 1)) * 255;
      data[i]=v; data[i+1]=v; data[i+2]=v; data[i+3]=255;
    }
  }
  return { width: size, height: size, data };
}
function makeHardChecker(size = 512, cell = 8) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const v = ((Math.floor(x / cell) + Math.floor(y / cell)) & 1) ? 255 : 0;
      data[i]=v; data[i+1]=v; data[i+2]=v; data[i+3]=255;
    }
  }
  return { width: size, height: size, data };
}

// ── Recommended max-tri formula (the thing under test) ───────────────────────
const K_GEOM = 4 / Math.sqrt(3);
function recommendMaxTri({ pixelsPerEdge, pixMm, surfaceArea, amplitude, coarsen = 3 }) {
  const ampFactor = Math.sqrt(0.5 / Math.max(amplitude, 0.1));
  const targetEdge = coarsen * pixelsPerEdge * pixMm * ampFactor;
  const raw = K_GEOM * surfaceArea / (targetEdge * targetEdge);
  return Math.max(10_000, Math.min(20_000_000, Math.round(raw)));
}

// ── Surface-distance metric ──────────────────────────────────────────────────
// Sample S random face-centroid points on the reference mesh, then for each
// point find the closest distance to the decimated mesh's triangles via a
// simple grid hash.  RMS over samples is the quality metric.
function sampleSurfacePoints(geometry, N) {
  const pos = geometry.attributes.position.array;
  const triCount = pos.length / 9;
  // Sample random face indices (uniform across faces, not area-weighted —
  // adequate for relative comparison across decimation ratios).
  const samples = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const t = (Math.random() * triCount) | 0;
    const o = t * 9;
    // Random barycentric on face
    let u = Math.random(), v = Math.random();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const w = 1 - u - v;
    samples[i*3]   = u * pos[o]   + v * pos[o+3] + w * pos[o+6];
    samples[i*3+1] = u * pos[o+1] + v * pos[o+4] + w * pos[o+7];
    samples[i*3+2] = u * pos[o+2] + v * pos[o+5] + w * pos[o+8];
  }
  return samples;
}

// Simple uniform-grid spatial index over a triangle soup.  For each grid cell,
// list of triangle indices whose AABB touches the cell.
function buildTriGrid(geometry, gridDim = 64) {
  const pos = geometry.attributes.position.array;
  const triCount = pos.length / 9;
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  const sz = new THREE.Vector3();
  bb.getSize(sz);
  const margin = Math.max(sz.x, sz.y, sz.z) * 1e-4 + 1e-6;
  const minX = bb.min.x - margin, minY = bb.min.y - margin, minZ = bb.min.z - margin;
  const maxX = bb.max.x + margin, maxY = bb.max.y + margin, maxZ = bb.max.z + margin;
  const cellX = (maxX - minX) / gridDim;
  const cellY = (maxY - minY) / gridDim;
  const cellZ = (maxZ - minZ) / gridDim;
  const cells = new Map(); // packedKey → Int32Array of tri indices
  const tmp = [];
  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    const x0 = Math.min(pos[o], pos[o+3], pos[o+6]);
    const y0 = Math.min(pos[o+1], pos[o+4], pos[o+7]);
    const z0 = Math.min(pos[o+2], pos[o+5], pos[o+8]);
    const x1 = Math.max(pos[o], pos[o+3], pos[o+6]);
    const y1 = Math.max(pos[o+1], pos[o+4], pos[o+7]);
    const z1 = Math.max(pos[o+2], pos[o+5], pos[o+8]);
    const ix0 = Math.max(0, Math.floor((x0 - minX) / cellX));
    const iy0 = Math.max(0, Math.floor((y0 - minY) / cellY));
    const iz0 = Math.max(0, Math.floor((z0 - minZ) / cellZ));
    const ix1 = Math.min(gridDim-1, Math.floor((x1 - minX) / cellX));
    const iy1 = Math.min(gridDim-1, Math.floor((y1 - minY) / cellY));
    const iz1 = Math.min(gridDim-1, Math.floor((z1 - minZ) / cellZ));
    for (let iz = iz0; iz <= iz1; iz++)
      for (let iy = iy0; iy <= iy1; iy++)
        for (let ix = ix0; ix <= ix1; ix++) {
          const k = ix + iy * gridDim + iz * gridDim * gridDim;
          let arr = cells.get(k);
          if (!arr) { arr = []; cells.set(k, arr); }
          arr.push(t);
        }
  }
  // Convert arrays to typed
  const cellsTyped = new Map();
  for (const [k, arr] of cells) cellsTyped.set(k, new Int32Array(arr));
  return { pos, triCount, cells: cellsTyped, gridDim, minX, minY, minZ, cellX, cellY, cellZ };
}

// Closest point from p to a single triangle (a, b, c) — squared distance.
const _tmpV = new THREE.Vector3();
const _tmpA = new THREE.Vector3();
const _tmpB = new THREE.Vector3();
const _tmpC = new THREE.Vector3();
const _tmpClose = new THREE.Vector3();
const _tmpTri = new THREE.Triangle();
function distSqToTri(pos, t, px, py, pz) {
  const o = t * 9;
  _tmpA.set(pos[o], pos[o+1], pos[o+2]);
  _tmpB.set(pos[o+3], pos[o+4], pos[o+5]);
  _tmpC.set(pos[o+6], pos[o+7], pos[o+8]);
  _tmpTri.set(_tmpA, _tmpB, _tmpC);
  _tmpV.set(px, py, pz);
  _tmpTri.closestPointToPoint(_tmpV, _tmpClose);
  const dx = px - _tmpClose.x, dy = py - _tmpClose.y, dz = pz - _tmpClose.z;
  return dx*dx + dy*dy + dz*dz;
}

function closestDistance(grid, px, py, pz) {
  // Start at the cell containing p; expand outward by ring-radius until a hit
  // is found, then add one more ring to be safe.
  const ix = Math.max(0, Math.min(grid.gridDim-1, Math.floor((px - grid.minX) / grid.cellX)));
  const iy = Math.max(0, Math.min(grid.gridDim-1, Math.floor((py - grid.minY) / grid.cellY)));
  const iz = Math.max(0, Math.min(grid.gridDim-1, Math.floor((pz - grid.minZ) / grid.cellZ)));
  let bestSq = Infinity;
  let foundAtRing = -1;
  const maxRings = grid.gridDim;
  for (let r = 0; r <= maxRings; r++) {
    if (foundAtRing >= 0 && r > foundAtRing + 1) break;
    for (let dz = -r; dz <= r; dz++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue; // ring shell only
          const cx = ix+dx, cy = iy+dy, cz = iz+dz;
          if (cx<0||cy<0||cz<0||cx>=grid.gridDim||cy>=grid.gridDim||cz>=grid.gridDim) continue;
          const arr = grid.cells.get(cx + cy*grid.gridDim + cz*grid.gridDim*grid.gridDim);
          if (!arr) continue;
          for (let i = 0; i < arr.length; i++) {
            const dsq = distSqToTri(grid.pos, arr[i], px, py, pz);
            if (dsq < bestSq) { bestSq = dsq; if (foundAtRing < 0) foundAtRing = r; }
          }
        }
      }
    }
  }
  return Math.sqrt(bestSq);
}

function rmsError(samples, decimGeo) {
  const grid = buildTriGrid(decimGeo, 64);
  let sumSq = 0, max = 0;
  const n = samples.length / 3;
  for (let i = 0; i < n; i++) {
    const d = closestDistance(grid, samples[i*3], samples[i*3+1], samples[i*3+2]);
    sumSq += d * d;
    if (d > max) max = d;
  }
  return { rms: Math.sqrt(sumSq / n), max };
}

// ── One run ──────────────────────────────────────────────────────────────────
async function runCase(stlName, texEntry, ratios) {
  const file = path.join(__dirname, stlName);
  if (!fs.existsSync(file)) { console.log(`  SKIP ${stlName} (not found)`); return; }
  const geo = parseBinarySTL(fs.readFileSync(file));
  const bounds = computeBounds(geo);
  const surfaceArea = computeSurfaceArea(geo);

  // Texture analysis: PPE etc.
  const ta = analyzeTexture(texEntry.imageData);
  const diag = bounds.size.length();

  // Settings: triplanar with a fixed scale chosen so pixMm sits in a useful
  // range. scaleU/scaleV are absolute mm — 0.5 × maxDim matches the legacy
  // relative 0.5 per UV repeat.
  const md = Math.max(bounds.size.x, bounds.size.y, bounds.size.z, 1e-6);
  const settings = {
    mappingMode: MODE_TRIPLANAR,
    scaleU: 0.5 * md, scaleV: 0.5 * md,
    offsetU: 0, offsetV: 0,
    amplitude: 0.5,
    textureAspectU: 1, textureAspectV: 1,
    boundaryFalloff: 0,
  };

  // Mirror smartResolution.computeWorldPeriod: the period IS the mm tile size.
  const periodU = settings.scaleU;
  const pixMm = (periodU / texEntry.imageData.width);

  const recommended = recommendMaxTri({
    pixelsPerEdge: ta.pixelsPerEdge,
    pixMm, surfaceArea,
    amplitude: settings.amplitude,
  });

  // Reference mesh: subdivide finer than the recommendation to give decimation
  // headroom.  Start at edge = 1.5 × PPE × pixMm (close to Nyquist) and use the
  // simulator to keep the predicted post-subdivide tri count under 5M — the
  // V8 Map size limit blows up QEM beyond ~6M edges (= ~12-16M faces).
  let refUseEdge = Math.max(0.05, ta.pixelsPerEdge * pixMm * 1.5);
  const capTri = 5_000_000;
  for (let step = 0; step < 4; step++) {
    const predicted = estimateSubdivisionTriCount(geo, refUseEdge);
    if (predicted <= capTri) break;
    refUseEdge *= Math.sqrt(predicted / capTri);
  }

  console.log(`\n── ${stlName} × ${texEntry.label} ──`);
  console.log(`  area=${surfaceArea.toFixed(0)} mm²  PPE=${ta.pixelsPerEdge}  pixMm=${pixMm.toFixed(4)}  amp=${settings.amplitude}`);
  console.log(`  formula recommends maxTri = ${recommended.toLocaleString()}`);
  console.log(`  reference subdivide edge  = ${refUseEdge.toFixed(3)} mm`);

  console.time('  subdivide');
  const sub = await subdivide(geo, refUseEdge, null, null, { fast: false });
  console.timeEnd('  subdivide');
  const subTri = sub.geometry.attributes.position.count / 3;
  console.log(`  subdivided to ${subTri.toLocaleString()} tris`);

  console.time('  displace');
  const displaced = applyDisplacement(
    sub.geometry, texEntry.imageData,
    texEntry.imageData.width, texEntry.imageData.height,
    settings, bounds, null,
  );
  console.timeEnd('  displace');
  sub.geometry.dispose();

  // Reference samples
  const SAMPLES = 400;
  const samples = sampleSurfacePoints(displaced, SAMPLES);

  // Test multiple ratios of formula's recommendation
  console.log(`  ratio    target_tri    actual_tri    RMS_err     max_err`);
  let prevRMS = Infinity;
  let elbowRatio = null;
  const results = [];
  for (const r of ratios) {
    const target = Math.round(recommended * r);
    if (target >= subTri) {
      console.log(`  ${r.toFixed(2).padStart(5)}    ${target.toString().padStart(11)}    ${'(skip - target ≥ subdivided)'.padStart(36)}`);
      continue;
    }
    const tStart = performance.now();
    const dec = await decimate(displaced.clone(), target, null);
    const tEnd = performance.now();
    const decTri = dec.attributes.position.count / 3;
    const { rms, max } = rmsError(samples, dec);
    const bbDiag = bounds.size.length();
    const rmsRel = rms / bbDiag;
    console.log(`  ${r.toFixed(2).padStart(5)}    ${target.toString().padStart(11)}    ${decTri.toString().padStart(11)}    ${rms.toExponential(3).padStart(11)}  ${max.toExponential(3)}  (${(rmsRel*1000).toFixed(2)} mm/m diag, ${((tEnd-tStart)/1000).toFixed(1)}s)`);
    results.push({ ratio: r, target, actual: decTri, rms, max });
    dec.dispose();
  }
  displaced.dispose();
  geo.dispose();
  return { stl: stlName, tex: texEntry.label, recommended, results };
}

// ── Main ──────────────────────────────────────────────────────────────────────
const STLS = [
  '3DBenchy.stl',
  'laserPlate.stl',
  'cone.stl',
];
const TEXTURES = [
  { label: 'smooth-gradient', imageData: makeSmoothGradient() },
  { label: 'hard-checker',    imageData: makeHardChecker() },
];
const RATIOS = [0.25, 0.5, 1.0, 2.0, 4.0];

const allRuns = [];
for (const stl of STLS) {
  for (const tex of TEXTURES) {
    try {
      const r = await runCase(stl, tex, RATIOS);
      if (r) allRuns.push(r);
    } catch (err) {
      console.log(`  ERROR in ${stl} × ${tex.label}: ${err.message}`);
    }
  }
}

console.log('\n══════ ELBOW SUMMARY ══════');
console.log('Looking for the ratio where RMS stops decreasing meaningfully (≤10% improvement vs next finer step).\n');
for (const run of allRuns) {
  const sorted = [...run.results].sort((a, b) => a.actual - b.actual);
  let elbow = null;
  for (let i = 0; i < sorted.length - 1; i++) {
    const drop = (sorted[i].rms - sorted[i+1].rms) / sorted[i].rms;
    if (drop < 0.10) { elbow = sorted[i]; break; }
  }
  if (!elbow) elbow = sorted[sorted.length - 1];
  const elbowRatio = elbow.actual / run.recommended;
  console.log(`  ${run.stl.padEnd(20)} × ${run.tex.padEnd(18)}  recommend=${run.recommended.toLocaleString().padStart(11)}  elbow≈${elbow.actual.toLocaleString().padStart(11)}  (${elbowRatio.toFixed(2)}× recommended)`);
}
