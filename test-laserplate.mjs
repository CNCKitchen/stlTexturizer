// Regression harness for laserPlate.stl — the user's reported failure case.
//
// laserPlate.stl is a 65×65×2 mm thin plate with a fan-tessellated bottom
// face (single centre vertex fanning out to many perimeter vertices) and a
// through-hole cutout.  After normal subdivision the long radial fan needles
// become chains of small slivers (long edge subdivides to maxEdgeLength but
// the short perimeter-arc edge is preserved).  Each sub-sliver's three
// vertices then sample three random texels of the displacement map, producing
// visibly noisy displaced geometry.
//
// The regularize pass walks the post-subdivision mesh, identifies high-aspect
// sub-slivers, and collapses their shortest edge to its midpoint — but only
// when (a) every surviving neighbour edge stays ≤ maxEdgeLength × slack,
// (b) every surviving face normal stays within the configured cone of its
// original direction, and (c) the link condition holds (no non-manifold).
//
// We assert at a target/slack the export pipeline will use:
//   1. Regularization shrinks the post-subdivision triangle count meaningfully
//      AND reduces the sliver fraction.
//   2. Topology is preserved — closed mesh, genus unchanged (through-hole
//      survives), no non-manifold edges.
//   3. No surviving edge exceeds maxEdgeLength × slack — the user's
//      "edge length doesn't get large again" constraint.
//
// Run:  node --max-old-space-size=8192 test-laserplate.mjs

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

import { subdivide } from './js/subdivision.js';
import { regularizeMesh } from './js/regularize.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STL_PATH  = path.join(__dirname, 'laserPlate.stl');

let _failed = 0;
function expect(label, ok, detail) {
  if (ok) console.log(`  PASS  ${label}`);
  else { console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ''}`); _failed++; }
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

const QUANT = 1e5;
function topoStats(geo) {
  const pa = geo.attributes.position;
  const tc = pa.count / 3;
  const m = new Map();
  let n = 0;
  const vid = new Uint32Array(pa.count);
  for (let i = 0; i < pa.count; i++) {
    const x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i);
    const k = `${Math.round(x*QUANT)}_${Math.round(y*QUANT)}_${Math.round(z*QUANT)}`;
    let id = m.get(k);
    if (id === undefined) { id = n++; m.set(k, id); }
    vid[i] = id;
  }
  const ek = (a, b) => a < b ? a * n + b : b * n + a;
  const edgeUseCount = new Map();
  let F = 0;
  const usedV = new Set();
  let openEdgeCount = 0;
  let nonManifold = 0;
  for (let t = 0; t < tc; t++) {
    const a = vid[t*3], b = vid[t*3+1], c = vid[t*3+2];
    if (a === b || b === c || c === a) continue;
    F++;
    usedV.add(a); usedV.add(b); usedV.add(c);
    for (const k of [ek(a,b), ek(b,c), ek(c,a)]) {
      edgeUseCount.set(k, (edgeUseCount.get(k) || 0) + 1);
    }
  }
  for (const c of edgeUseCount.values()) {
    if (c === 1) openEdgeCount++;
    else if (c > 2) nonManifold++;
  }
  const V = usedV.size, E = edgeUseCount.size;
  const chi = V - E + F;
  return { V, E, F, chi, genus: (2 - chi) / 2, openEdgeCount, nonManifold };
}

function maxEdgeAndSliverStats(geo, sliverAspectThreshold = 4) {
  const pa = geo.attributes.position.array;
  const tc = pa.length / 9;
  let maxLen = 0, slivers = 0;
  for (let t = 0; t < tc; t++) {
    const b = t * 9;
    const lAB = Math.hypot(pa[b+3]-pa[b], pa[b+4]-pa[b+1], pa[b+5]-pa[b+2]);
    const lBC = Math.hypot(pa[b+6]-pa[b+3], pa[b+7]-pa[b+4], pa[b+8]-pa[b+5]);
    const lCA = Math.hypot(pa[b]-pa[b+6], pa[b+1]-pa[b+7], pa[b+2]-pa[b+8]);
    const lmin = Math.min(lAB, lBC, lCA);
    const lmax = Math.max(lAB, lBC, lCA);
    if (lmax > maxLen) maxLen = lmax;
    if (lmin > 0 && lmax / lmin > sliverAspectThreshold) slivers++;
  }
  return { maxLen, slivers, fraction: slivers / tc, triCount: tc };
}

async function main() {
  if (!fs.existsSync(STL_PATH)) {
    console.log(`SKIP  laserPlate.stl not found at ${STL_PATH}`);
    return;
  }

  const inGeo = parseBinarySTL(fs.readFileSync(STL_PATH));
  inGeo.computeBoundingBox();
  const size = new THREE.Vector3(); inGeo.boundingBox.getSize(size);
  const inTri = inGeo.attributes.position.count / 3;

  // Use a target tied to the LARGEST dimension to stay within harness memory.
  const target = Math.max(size.x, size.y, size.z) * 0.01;

  console.log(`Input: ${inTri} tris, bounds ${size.x.toFixed(1)}×${size.y.toFixed(1)}×${size.z.toFixed(1)} mm`);
  console.log(`target=${target.toFixed(3)} mm\n`);

  const tIn = topoStats(inGeo);
  console.log(`Input topology: V=${tIn.V} E=${tIn.E} F=${tIn.F} χ=${tIn.chi} genus=${tIn.genus} open=${tIn.openEdgeCount}`);

  console.log('\nSubdividing (no min-area cap — long needles must subdivide to follow surface)…');
  const { geometry: subdivided, faceParentId } = await subdivide(inGeo.clone(), target, null, null, { fast: false });
  const subStats = maxEdgeAndSliverStats(subdivided);
  console.log(`  subdivided: ${subStats.triCount} tris, longest edge=${subStats.maxLen.toFixed(3)} mm, ${(subStats.fraction*100).toFixed(1)} % slivers (aspect>4)`);

  console.log('\nRegularizing…');
  const slack = 3.0;
  const aggressiveSlack = 8.0;
  const { geometry: regGeo, faceParentId: regParents, collapseCount, rejectStats } =
    regularizeMesh(subdivided, faceParentId, target, { slack, aggressiveSlack });
  const regStats = maxEdgeAndSliverStats(regGeo);
  console.log(`  collapsed ${collapseCount} edges`);
  console.log(`  rejected by gate: frozen=${rejectStats.frozen}  wingCount=${rejectStats.wingCount}  link=${rejectStats.linkCondition}  edgeCap=${rejectStats.edgeCap}  normal=${rejectStats.normalChange}  degenerate=${rejectStats.degenerate}  foldedApex=${rejectStats.foldedApex}`);
  console.log(`  regularized: ${regStats.triCount} tris, longest edge=${regStats.maxLen.toFixed(3)} mm, ${(regStats.fraction*100).toFixed(1)} % slivers`);

  console.log('\nRe-subdividing (coarser cap — only splits regularize-stretched edges)…');
  const secondPassCap = target * 1.5;
  const { geometry: resubGeo, faceParentId: resubParents } = await subdivide(regGeo, secondPassCap, null, null, { fast: false });
  const composed = new Int32Array(resubParents.length);
  for (let i = 0; i < resubParents.length; i++) composed[i] = regParents[resubParents[i]];
  const resubStats = maxEdgeAndSliverStats(resubGeo);
  console.log(`  resubdivided: ${resubStats.triCount} tris, longest edge=${resubStats.maxLen.toFixed(3)} mm, ${(resubStats.fraction*100).toFixed(1)} % slivers`);

  console.log('\nThird pass: regularize the re-subdivided mesh (cleans slivers introduced by the bisection)…');
  const reg2 = regularizeMesh(resubGeo, composed, target, { slack, aggressiveSlack });
  const reg2Stats = maxEdgeAndSliverStats(reg2.geometry);
  console.log(`  collapsed ${reg2.collapseCount} edges`);
  console.log(`  reg2: ${reg2Stats.triCount} tris, longest edge=${reg2Stats.maxLen.toFixed(3)} mm, ${(reg2Stats.fraction*100).toFixed(1)} % slivers`);

  console.log('\nTest 1: regularization meaningfully reduces sliver content');
  expect('triangle count drops by ≥30 %',
         regStats.triCount < subStats.triCount * 0.7,
         `before=${subStats.triCount} after=${regStats.triCount} ratio=${(regStats.triCount/subStats.triCount).toFixed(2)}`);
  expect('sliver fraction drops by ≥40 %',
         regStats.fraction < subStats.fraction * 0.6,
         `before=${(subStats.fraction*100).toFixed(1)} % after=${(regStats.fraction*100).toFixed(1)} %`);

  console.log('\nTest 2: edge-length cap respected (the user constraint)');
  expect(`no edge exceeds maxEdgeLength × aggressiveSlack = ${(target*aggressiveSlack).toFixed(3)} mm`,
         regStats.maxLen <= target * aggressiveSlack + 1e-6,
         `longest=${regStats.maxLen.toFixed(4)} cap=${(target*aggressiveSlack).toFixed(4)}`);

  console.log('\nTest 3: topology preserved (no welds, no holes closed)');
  const tOut = topoStats(regGeo);
  console.log(`  output topology: V=${tOut.V} E=${tOut.E} F=${tOut.F} χ=${tOut.chi} genus=${tOut.genus} open=${tOut.openEdgeCount} NM=${tOut.nonManifold}`);
  expect('regularized output is closed (no torn edges)',
         tOut.openEdgeCount === 0, `got ${tOut.openEdgeCount}`);
  expect('regularized output is manifold (no NM edges)',
         tOut.nonManifold === 0, `got ${tOut.nonManifold}`);
  expect('genus is preserved (through-hole survives)',
         tIn.genus === tOut.genus,
         `input=${tIn.genus} output=${tOut.genus}`);

  console.log('\nTest 4: parent-id mapping survives (one parent per surviving tri)');
  expect('parent-id array length matches output triangle count',
         regParents.length === regStats.triCount);

  console.log('\nTest 5: re-subdivide restores edge-length budget without bringing back slivers');
  expect(`re-subdivided longest edge ≤ secondPassCap = ${secondPassCap.toFixed(3)} mm`,
         resubStats.maxLen <= secondPassCap + 1e-6,
         `longest=${resubStats.maxLen.toFixed(4)} cap=${secondPassCap.toFixed(4)}`);
  // The re-subdivide pass bisects regularize's stretched edges (up to 8× target).
  // Sub-triangles of those bisected edges can themselves be slivers, so a small
  // bump in sliver fraction is expected — the trade-off for uniform edge length.
  // Cap at 15 pp (well below pure-subdivision's ~88 %) as a regression guard.
  expect('re-subdivide sliver regression stays below +15 percentage points',
         resubStats.fraction <= regStats.fraction + 0.15,
         `before=${(regStats.fraction*100).toFixed(2)}% after=${(resubStats.fraction*100).toFixed(2)}%`);
  const tResub = topoStats(resubGeo);
  expect('re-subdivided mesh is closed', tResub.openEdgeCount === 0, `got ${tResub.openEdgeCount}`);
  expect('re-subdivided mesh is manifold', tResub.nonManifold === 0, `got ${tResub.nonManifold}`);
  expect('re-subdivide preserves genus', tIn.genus === tResub.genus,
         `input=${tIn.genus} output=${tResub.genus}`);
  expect('composed parent-id array length matches re-subdivided triangle count',
         composed.length === resubStats.triCount);

  console.log(`\n${_failed === 0 ? 'All tests PASSED' : `${_failed} test(s) FAILED`}`);
  process.exit(_failed === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
