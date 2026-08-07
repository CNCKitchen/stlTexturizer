/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Compares the legacy K · area / edge² triangle-count estimate (the formula
// used in smartResolution.js before this change) against the per-triangle
// subdivision simulator now wired in via estimateSubdivisionTriCount().
//
// "Truth" is the actual triangle count produced by subdivide() at each target
// edge length, run on every .stl in the project root.  The simulator should
// land within 20 % of actual on every case; the legacy formula does not.
//
// Run: node --max-old-space-size=8192 bench-tri-estimate.mjs

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

import { subdivide }                  from './js/subdivision.js';
import { computeSurfaceArea }         from './js/stlLoader.js';
import { estimateSubdivisionTriCount } from './js/smartResolution.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NEW_TOLERANCE = 0.20;       // simulator must be within ±20 % of actual

// ── STL loader (binary path is what these test files use) ────────────────────
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

// Legacy estimator: smartResolution.js's pre-change formula.
// K = 6.93 (= 4/√3 × 3.0 growth factor).
const LEGACY_K = (4 / Math.sqrt(3)) * 3.0;
function legacyEstimate(area, edge) { return (LEGACY_K * area) / (edge * edge); }

// ── Run ──────────────────────────────────────────────────────────────────────

const STL_FILES = [
  '3DBenchy.stl', 'Barry Bear.stl', 'Grip70mm.stl', 'cone.stl',
  'cubeWithSmallFillets.stl', 'laserPlate.stl', 'puerta texturized.stl',
];

function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return n.toFixed(0);
}

let failures = 0;
const allCases = [];

for (const fileName of STL_FILES) {
  const filePath = path.join(__dirname, fileName);
  if (!fs.existsSync(filePath)) { console.log(`SKIP ${fileName} (not found)`); continue; }
  const geo = parseBinarySTL(fs.readFileSync(filePath));
  const triCount = geo.attributes.position.count / 3;
  const area = computeSurfaceArea(geo);
  const bbox = new THREE.Box3().setFromBufferAttribute(geo.attributes.position);
  const sz = new THREE.Vector3(); bbox.getSize(sz);
  const diag = Math.sqrt(sz.x*sz.x + sz.y*sz.y + sz.z*sz.z);

  console.log(`\n═══ ${fileName} (${triCount.toLocaleString()} tris, ${area.toFixed(0)} mm², diag ${diag.toFixed(1)} mm) ═══`);
  console.log('  ' + ['edge_mm', 'actual', 'legacy', 'new', 'leg/act', 'new/act'].map(s => s.padStart(11)).join(' '));

  const edgeTargets = [diag/80, diag/160, diag/320, diag/640].filter(e => e >= 0.05);
  for (const edge of edgeTargets) {
    const sub = await subdivide(geo.clone(), edge, null, null, { fast: false });
    const actual = sub.geometry.attributes.position.count / 3;
    // Skip cap-aborted subdivisions: the simulator predicts the full uncapped
    // count, while subdivide() now stops cleanly at the last viable pass to
    // keep the mesh watertight (test-subdivide-cap-no-cracks.mjs).  These
    // cases aren't in this bench's scope — it only validates the simulator
    // when subdivision runs to completion.
    if (sub.safetyCapHit) {
      console.log('  ' + [
        edge.toFixed(3), fmt(actual), '(cap)', '(cap)', '—', '— skip',
      ].map(s => s.padStart(11)).join(' '));
      sub.geometry.dispose();
      continue;
    }
    const legacy = legacyEstimate(area, edge);
    const newEst = estimateSubdivisionTriCount(geo, edge);

    const legRatio = legacy / actual;
    const newRatio = newEst / actual;
    const newPass  = Math.abs(newRatio - 1) <= NEW_TOLERANCE;

    if (!newPass) failures++;
    console.log('  ' + [
      edge.toFixed(3), fmt(actual), fmt(legacy), fmt(newEst),
      legRatio.toFixed(2) + 'x', newRatio.toFixed(2) + 'x' + (newPass ? '' : ' ✗'),
    ].map(s => s.padStart(11)).join(' '));

    allCases.push({ file: fileName, edge, actual, legacy, newEst, legRatio, newRatio });
    sub.geometry.dispose();
  }
  geo.dispose();
}

// ── Summary across all (file, edge) cases ───────────────────────────────────
console.log('\n══════ SUMMARY (across ' + allCases.length + ' cases) ══════');

function summarise(name, ratios) {
  const errs    = ratios.map(r => Math.abs(r - 1));
  const sorted  = [...ratios].sort((a, b) => a - b);
  const median  = sorted[Math.floor(sorted.length / 2)];
  const geomean = Math.exp(ratios.reduce((s, r) => s + Math.log(r), 0) / ratios.length);
  const mape    = errs.reduce((s, e) => s + e, 0) / errs.length;
  const worst   = Math.max(...errs);
  console.log(`  ${name.padEnd(8)}: median ${median.toFixed(3)}  geomean ${geomean.toFixed(3)}  MAPE ${(mape*100).toFixed(1)}%  worst ${(worst*100).toFixed(1)}%`);
}

summarise('legacy', allCases.map(c => c.legRatio));
summarise('new',    allCases.map(c => c.newRatio));

if (failures > 0) {
  console.log(`\n${failures} of ${allCases.length} cases violated the ±${NEW_TOLERANCE*100}% tolerance for the new estimator.`);
  process.exit(1);
}
console.log(`\nAll ${allCases.length} cases within ±${NEW_TOLERANCE*100}% for the new estimator.`);
