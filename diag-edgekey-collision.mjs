/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// countEdgeDefects / resolveTJunctions key an edge as `x * 4294967296 + y`
// (x * 2^32 + y) in a JS number. That is exact only while x * 2^32 + y stays
// within float64's 2^53 integer range, i.e. up to x = 2^21 = 2,097,152
// vertices. Past that, DISTINCT edges collide onto one key, their incidence
// counts add up, and the sum trips the `> 2` test — so a perfectly manifold
// mesh is reported as having non-manifold edges.
//
// This builds a closed torus (manifold by construction: every edge has exactly
// two incident faces, guaranteed by the grid topology, not by measurement) at a
// range of sizes and compares the packed-float key against exact integer keys.
//
//   node --max-old-space-size=8000 diag-edgekey-collision.mjs
import * as THREE from 'three';
import { countEdgeDefects } from './js/meshRepair.js';
import { IntPairMap } from './js/meshIndex.js';

// Exact reference counter: integer pair keys, no float packing, no Map cap.
function exactDefects(geometry, Q = 1e4) {
  const p = geometry.attributes.position.array, n = p.length / 9;
  const vmap = new IntPairMap(Math.ceil(n * 2));
  // Quantise to the same grid, then id via a 3-key weld built from two pairs.
  const idOf = new Map();
  const id = new Int32Array(n * 3);
  let next = 0;
  for (let i = 0; i < n * 3; i++) {
    const k = Math.round(p[i*3]*Q) + '/' + Math.round(p[i*3+1]*Q) + '/' + Math.round(p[i*3+2]*Q);
    let v = idOf.get(k);
    if (v === undefined) { v = next++; idOf.set(k, v); }
    id[i] = v;
  }
  const edges = new IntPairMap(Math.ceil(n * 1.6));
  let nE = 0;
  let counts = new Int32Array(Math.ceil(n * 1.8) + 16);
  for (let t = 0; t < n; t++) {
    const a = id[t*3], b = id[t*3+1], c = id[t*3+2];
    if (a === b || b === c || a === c) continue;
    const tri = [a, b, c];
    for (let e = 0; e < 3; e++) {
      const x = tri[e], y = tri[(e+1)%3];
      const lo = x < y ? x : y, hi = x < y ? y : x;
      const s = edges.getOrSet(lo, hi, nE);
      if (edges.inserted) {
        if (nE >= counts.length) { const g = new Int32Array(counts.length*2); g.set(counts); counts = g; }
        nE++;
      }
      counts[s]++;
    }
  }
  let open = 0, nonManifold = 0;
  for (let i = 0; i < nE; i++) { if (counts[i] === 1) open++; else if (counts[i] > 2) nonManifold++; }
  return { open, nonManifold, verts: next };
}

// Closed torus: a full grid wrap in both directions, so EVERY edge borders
// exactly two faces. Manifold by topology, independent of any counter.
function torus(nu, nv, R = 100, r = 30) {
  const pos = new Float32Array(nu * nv * 2 * 9);
  let o = 0;
  const P = (i, j) => {
    const u = 2*Math.PI*(i % nu)/nu, v = 2*Math.PI*(j % nv)/nv;
    return [(R + r*Math.cos(v))*Math.cos(u), (R + r*Math.cos(v))*Math.sin(u), r*Math.sin(v)];
  };
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const a = P(i,j), b = P(i+1,j), c = P(i+1,j+1), d = P(i,j+1);
    for (const t of [[a,b,c],[a,c,d]]) for (const p of t) { pos[o++]=p[0]; pos[o++]=p[1]; pos[o++]=p[2]; }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return g;
}

console.log('Closed torus — every edge has exactly 2 incident faces by construction.\n');
console.log('  vertices     tris   | upstream countEdgeDefects | exact integer keys');
console.log('  ' + '-'.repeat(72));
for (const [nu, nv] of [[400,300],[900,700],[1400,1100],[1800,1400],[2200,1700]]) {
  const g = torus(nu, nv);
  const tris = g.attributes.position.count / 3;
  let up;
  try { up = countEdgeDefects(g); } catch (e) { up = { err: e.message }; }
  const ex = exactDefects(g);
  const upStr = up.err ? `THREW: ${up.err}` : `open=${String(up.open).padStart(6)} nonManifold=${String(up.nonManifold).padStart(9)}`;
  console.log(`  ${String(ex.verts).padStart(8)} ${String(tris).padStart(8)}   | ${upStr.padEnd(37)} | open=${ex.open} nonManifold=${ex.nonManifold}`);
  g.dispose();
}
console.log('\n  float64 keeps x*2^32+y exact only to x = 2^21 = 2,097,152 vertices.');
console.log('  Above that the upstream counter reports defects a manifold mesh does not have.');
