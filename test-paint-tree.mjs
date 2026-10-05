// paintTree.js checks: adaptive splitting under a circle brush, watertight
// flatten with T-joints, merge after erase, soft coverage, two layers,
// serialize round trip, samplePaint vs flatPaint.
//   node test-paint-tree.mjs
import * as THREE from 'three';
import { PaintTree } from './js/paintTree.js';
import { buildAdjacency } from './js/exclusion.js';

let fails = 0, runs = 0;
const check = (name, ok, info = '') => { runs++; if (!ok) { fails++; console.log('FAIL ' + name, info); } else console.log('ok   ' + name, info); };

function makeTree(geo) {
  const adj = buildAdjacency(geo);
  return { tree: new PaintTree({ positions: geo.attributes.position.array, vertId: adj.vertId, vertCount: adj.vertCount, adjacency: adj.adjacency, faceNormals: adj.faceNormals }), adj };
}
function flatGeo(flat) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(flat.positions, 3));
  return g;
}
function watertight(flat) {
  const a = buildAdjacency(flatGeo(flat));
  return { open: a.openEdgeCount, nm: a.nonManifoldEdgeCount, shells: a.shellCount };
}
function paintedArea(tree, slot, flat) {
  const { paint } = tree.flatPaint(slot, flat);
  let area = 0, total = 0;
  const p = flat.positions;
  for (let t = 0; t < flat.triCount; t++) {
    const b = t * 9;
    const ux = p[b+3]-p[b], uy = p[b+4]-p[b+1], uz = p[b+5]-p[b+2];
    const vx = p[b+6]-p[b], vy = p[b+7]-p[b+1], vz = p[b+8]-p[b+2];
    const cx = uy*vz-uz*vy, cy = uz*vx-ux*vz, cz = ux*vy-uy*vx;
    const A = Math.sqrt(cx*cx+cy*cy+cz*cz) / 2;
    const c = (paint[t*3] + paint[t*3+1] + paint[t*3+2]) / 3;
    area += A * c; total += A;
  }
  return { area, total };
}

// ── Cube: 12 triangles, a 5 mm dab on the +Z face ─────────────────────────
{
  const geo = new THREE.BoxGeometry(50, 50, 50).toNonIndexed();
  geo.computeVertexNormals();
  const { tree } = makeTree(geo);
  const slot = tree.addLayer(1);
  // Seed: a +Z face triangle
  const fn = tree.faceNormals;
  let seed = -1;
  for (let f = 0; f < 12; f++) if (fn[f*3+2] > 0.9) { seed = f; break; }
  const view = { x: 0, y: 0, z: -1 };
  const r = 5;
  tree.paintStroke({ slot, seedFace: seed, from: { x: 3, y: -4, z: 25 }, to: { x: 3, y: -4, z: 25 }, radius: r, view, hardness: 1, erase: false, edgeLimit: r / 5 });
  const flat = tree.flatten();
  const wt = watertight(flat);
  check('cube dab: flatten watertight', wt.open === 0 && wt.nm === 0 && wt.shells === 1, JSON.stringify(wt) + ` tris=${flat.triCount}`);
  const { area } = paintedArea(tree, slot, flat);
  const expect = Math.PI * r * r;
  check('cube dab: painted area ≈ πr²', Math.abs(area - expect) / expect < 0.08, `area=${area.toFixed(2)} expect=${expect.toFixed(2)}`);
  check('cube dab: tree is local', flat.triCount < 3000 && flat.triCount > 50, `leaves=${flat.triCount}`);
  // Only +Z face refined: other faces stay single triangles
  let otherLeaves = 0;
  for (let t = 0; t < flat.triCount; t++) if (fn[flat.faceParentId[t]*3+2] < 0.9) otherLeaves++;
  check('cube dab: other faces untouched (T-joints only)', otherLeaves <= 10 + 4, `leaves on other faces=${otherLeaves}`);

  // samplePaint agrees with flatPaint at leaf centroids
  const { paint } = tree.flatPaint(slot, flat);
  let mism = 0;
  for (let t = 0; t < flat.triCount; t++) {
    const b = t * 9;
    const cx = (flat.positions[b]+flat.positions[b+3]+flat.positions[b+6])/3, cy = (flat.positions[b+1]+flat.positions[b+4]+flat.positions[b+7])/3, cz = (flat.positions[b+2]+flat.positions[b+5]+flat.positions[b+8])/3;
    const s = tree.samplePaint(slot, flat.faceParentId[t], cx, cy, cz);
    const c = (paint[t*3]+paint[t*3+1]+paint[t*3+2])/3;
    if (Math.abs(s - c) > 1e-6) mism++;
  }
  check('cube dab: samplePaint == flatPaint at centroids', mism === 0, `mismatches=${mism}`);

  // Serialize round trip
  const ser = tree.serialize();
  const before = flat.triCount;
  const js = JSON.parse(JSON.stringify(PaintTree.toJSON(ser)));
  const ok = tree.deserialize(PaintTree.fromJSON(js));
  const flat2 = tree.flatten();
  const wt2 = watertight(flat2);
  const a2 = paintedArea(tree, tree.layerSlot(1), flat2).area;
  check('serialize round trip (JSON)', ok && flat2.triCount === before && wt2.open === 0 && Math.abs(a2 - area) < 1e-6, `tris ${before}→${flat2.triCount} area ${area.toFixed(3)}→${a2.toFixed(3)}`);
  check('serializedEqual after round trip', PaintTree.serializedEqual(ser, tree.serialize()));

  // Erase the dab → tree merges back to 12 leaves
  tree.paintStroke({ slot: tree.layerSlot(1), seedFace: seed, from: { x: 3, y: -4, z: 25 }, to: { x: 3, y: -4, z: 25 }, radius: r * 1.5, view, hardness: 1, erase: true, edgeLimit: r / 5 });
  const flat3 = tree.flatten();
  check('erase merges back', flat3.triCount === 12 && tree.isFlat, `leaves=${flat3.triCount}`);
  check('hasPaint false after erase', !tree.hasPaint(tree.layerSlot(1)));
}

// ── Two layers, shared tree: painting one never changes the other ─────────
{
  const geo = new THREE.SphereGeometry(20, 16, 12).toNonIndexed();
  geo.computeVertexNormals();
  const { tree } = makeTree(geo);
  const s1 = tree.addLayer(1), s2 = tree.addLayer(2);
  const fn = tree.faceNormals;
  let seed = -1;
  for (let f = 0; f < tree.baseTriCount; f++) if (fn[f*3] > 0.95) { seed = f; break; }
  const view = { x: -1, y: 0, z: 0 };
  tree.paintStroke({ slot: s1, seedFace: seed, from: { x: 20, y: 0, z: 0 }, to: { x: 20, y: 0, z: 0 }, radius: 6, view, hardness: 1, erase: false, edgeLimit: 1.2 });
  const flatA = tree.flatten();
  const area1 = paintedArea(tree, s1, flatA).area;
  const ser1 = tree.serialize();
  // Layer 2 paints an overlapping, smaller disk
  tree.paintStroke({ slot: s2, seedFace: seed, from: { x: 20, y: 2, z: 2 }, to: { x: 20, y: 2, z: 2 }, radius: 3, view, hardness: 1, erase: false, edgeLimit: 0.6 });
  const flatB = tree.flatten();
  const area1b = paintedArea(tree, s1, flatB).area;
  const area2 = paintedArea(tree, s2, flatB).area;
  check('layer 1 area unchanged by layer 2 paint', Math.abs(area1b - area1) / area1 < 1e-3, `${area1.toFixed(2)} → ${area1b.toFixed(2)}`);
  check('layer 2 area ≈ its disk', Math.abs(area2 - Math.PI * 9) / (Math.PI * 9) < 0.12, `area2=${area2.toFixed(2)}`);
  const wt = watertight(flatB);
  check('two layers: flatten watertight', wt.open === 0 && wt.nm === 0, JSON.stringify(wt));
  // Remove layer 2 → merge; layer 1 area still the same
  tree.removeLayer(2);
  const flatC = tree.flatten();
  const area1c = paintedArea(tree, tree.layerSlot(1), flatC).area;
  check('remove layer 2 keeps layer 1', Math.abs(area1c - area1) / area1 < 1e-3 && flatC.triCount <= flatB.triCount, `tris ${flatB.triCount} → ${flatC.triCount}`);
  check('states of layer 1 unchanged (serialized)', (() => { const s = tree.serialize(); return s.layerIds.length === 1 && s.states[0].length === ser1.states[0].length; })());
}

// ── Soft brush: coverage fades from 1 in the core to 0 at the rim ─────────
{
  const geo = new THREE.BoxGeometry(50, 50, 50).toNonIndexed();
  geo.computeVertexNormals();
  const { tree } = makeTree(geo);
  const slot = tree.addLayer(7);
  const fn = tree.faceNormals;
  let seed = -1;
  for (let f = 0; f < 12; f++) if (fn[f*3+2] > 0.9) { seed = f; break; }
  const view = { x: 0, y: 0, z: -1 };
  const r = 8, hardness = 0.4;
  const band = (1 - hardness) * r;
  tree.paintStroke({ slot, seedFace: seed, from: { x: 0, y: 0, z: 25 }, to: { x: 0, y: 0, z: 25 }, radius: r, view, hardness, erase: false, edgeLimit: Math.min(r / 5, band / 3) });
  const flat = tree.flatten();
  const wt = watertight(flat);
  check('soft dab: watertight', wt.open === 0 && wt.nm === 0, JSON.stringify(wt) + ` tris=${flat.triCount}`);
  const sAt = (d) => tree.samplePaint(slot, seed, d, 0.01, 25);   // along +x from the centre (seed face covers x>0? use samplePaint on both faces)
  const P = geo.attributes.position.array;
  const faceAt = (x, y) => { // the +Z face containing the point (2D point-in-triangle)
    for (let f = 0; f < 12; f++) {
      if (fn[f*3+2] < 0.9) continue;
      const b = f * 9;
      const x0=P[b],y0=P[b+1],x1=P[b+3],y1=P[b+4],x2=P[b+6],y2=P[b+7];
      const s0=(x1-x0)*(y-y0)-(y1-y0)*(x-x0), s1=(x2-x1)*(y-y1)-(y2-y1)*(x-x1), s2=(x0-x2)*(y-y2)-(y0-y2)*(x-x2);
      if ((s0>=0&&s1>=0&&s2>=0)||(s0<=0&&s1<=0&&s2<=0)) return f;
    }
    return -1;
  };
  const sample = (x, y) => { const f = faceAt(x, y); return f < 0 ? 0 : tree.samplePaint(slot, f, x, y, 25); };
  const lim = Math.min(r / 5, band / 3);
  const core = sample(1, 1), mid = sample(r * 0.7, 0.3), rim = sample(r * 0.98, 0.3), outside = sample(r + 2.5 * lim, 0);
  check('soft dab: core≈1, mid in (0,1), rim small, outside 0', core > 0.98 && mid > 0.05 && mid < 0.95 && rim < 0.35 && outside === 0, `core=${core.toFixed(3)} mid=${mid.toFixed(3)} rim=${rim.toFixed(3)} out=${outside}`);
  // Monotone fade along +x
  let mono = true, prev = 2;
  for (let x = 0.5; x < r + 2 * lim; x += 0.5) { const v = sample(x, 0.2); if (v > prev + 1e-6) mono = false; prev = v; }
  check('soft dab: fade is monotone', mono);
  // Stroke continuity: a swept capsule paints between two far dabs
  tree.paintStroke({ slot, seedFace: faceAt(15, -15), from: { x: -15, y: -15, z: 25 }, to: { x: 15, y: -15, z: 25 }, radius: 3, view, hardness: 0.5, erase: false, edgeLimit: 0.6 });
  const midStroke = sample(0, -15);
  check('soft stroke: capsule paints between endpoints', midStroke > 0.9, `mid=${midStroke.toFixed(3)}`);
  // Hard erase over the soft paint clears it
  tree.paintStroke({ slot, seedFace: faceAt(0, -15), from: { x: 0, y: -15, z: 25 }, to: { x: 0, y: -15, z: 25 }, radius: 4, view, hardness: 1, erase: true, edgeLimit: 0.8 });
  check('hard erase clears soft paint', sample(0, -15) === 0, `v=${sample(0, -15)}`);
}

// ── Fill faces + hard brush on a fine mesh: brush resolution independent ──
{
  const geo = new THREE.PlaneGeometry(40, 40, 40, 40).toNonIndexed(); // 0.7 mm triangles
  geo.computeVertexNormals();
  const { tree } = makeTree(geo);
  const slot = tree.addLayer(3);
  const view = { x: 0, y: 0, z: -1 };
  // find the face containing (5,5)
  const p = geo.attributes.position.array;
  let seed = -1;
  for (let f = 0; f < tree.baseTriCount; f++) { const cx = (p[f*9]+p[f*9+3]+p[f*9+6])/3, cy = (p[f*9+1]+p[f*9+4]+p[f*9+7])/3; if (Math.abs(cx-5) < 0.6 && Math.abs(cy-5) < 0.6) { seed = f; break; } }
  tree.paintStroke({ slot, seedFace: seed, from: { x: 5, y: 5, z: 0 }, to: { x: 5, y: 5, z: 0 }, radius: 4, view, hardness: 1, erase: false, edgeLimit: 0.8 });
  const flat = tree.flatten();
  const area = paintedArea(tree, slot, flat).area;
  check('fine plane dab: area ≈ πr² (few splits needed)', Math.abs(area - Math.PI * 16) / (Math.PI * 16) < 0.08, `area=${area.toFixed(2)} tris=${flat.triCount} base=${tree.baseTriCount}`);
  tree.paintFaces(slot, [0, 1, 2, 3], false);
  const { hard } = tree.flatPaint(slot, tree.flatten());
  check('paintFaces marks whole base faces', hard[0] === 1 && hard[1] === 1);
  tree.paintFaces(slot, [0, 1, 2, 3], true);
  const { hard: h2 } = tree.flatPaint(slot, tree.flatten());
  check('paintFaces erase', h2[0] === 0 && h2[3] === 0);
}

// ── Standard brush (whole): every touched base face in full, no splits ────
{
  const geo = new THREE.BoxGeometry(50, 50, 50).toNonIndexed();
  geo.computeVertexNormals();
  const { tree } = makeTree(geo);
  const slot = tree.addLayer(1);
  const fn = tree.faceNormals;
  const top = [];
  for (let f = 0; f < 12; f++) if (fn[f*3+2] > 0.9) top.push(f);
  const view = { x: 0, y: 0, z: -1 };
  // Off-centre dab whose disk crosses the face diagonal: both +Z triangles, nothing else.
  const at = { x: 3, y: -4, z: 25 };
  const preview = tree.facesUnderBrush(top[0], at, 5, view).sort((a, b) => a - b);
  tree.paintStroke({ slot, seedFace: top[0], from: at, to: at, radius: 5, view, hardness: 0.5, erase: false, edgeLimit: 1, whole: true });
  const { hard } = tree.basePaint(slot);
  const marked = [];
  for (let f = 0; f < 12; f++) if (hard[f]) marked.push(f);
  check('standard hover preview = faces the dab marks', preview.join() === marked.join(), `preview=${preview} marked=${marked}`);
  check('standard dab: tree stays flat', tree.isFlat);
  check('standard dab: both +Z faces whole, nothing else',
    hard[top[0]] === 1 && hard[top[1]] === 1 && hard.reduce((a, b) => a + b, 0) === 2, `painted=${hard.reduce((a, b) => a + b, 0)}`);
  check('standard dab: hardness ignored (no soft coverage)', tree.countPainted(slot).softVertices === 0);
  // A dab that stays inside one triangle paints only that one.
  tree.clearLayer(slot);
  const p = geo.attributes.position.array;
  const f0 = top[0];
  const c = { x: (p[f0*9]+p[f0*9+3]+p[f0*9+6])/3, y: (p[f0*9+1]+p[f0*9+4]+p[f0*9+7])/3, z: 25 };
  tree.paintStroke({ slot, seedFace: f0, from: c, to: c, radius: 1, view, hardness: 1, erase: false, edgeLimit: 0.2, whole: true });
  const { hard: h1 } = tree.basePaint(slot);
  check('standard small dab: only the face under it', h1[f0] === 1 && h1.reduce((a, b) => a + b, 0) === 1);
  // Precision paint on a face, then a Standard erase over it: merged back, clean.
  tree.clearLayer(slot);
  tree.paintStroke({ slot, seedFace: top[0], from: at, to: at, radius: 5, view, hardness: 1, erase: false, edgeLimit: 1 });
  check('precision dab splits the face', !tree.isFlat);
  tree.paintStroke({ slot, seedFace: top[0], from: at, to: at, radius: 5, view, hardness: 1, erase: true, edgeLimit: 1, whole: true });
  check('standard erase clears and merges the split face', tree.isFlat && !tree.hasPaint(slot));
}

console.log(`\n${runs - fails}/${runs} passed`);
process.exit(fails ? 1 : 0);
