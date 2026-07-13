/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Locate a triangle by index in an exported 3MF and report where it sits
// relative to the triplanar texture-tile lines of a centered cube.
//   node diag-locate-tri.mjs <file.3mf> <triIndex> [scaleU]
import { readFileSync } from 'fs';
import { unzipSync } from 'fflate';

const [file, triIdxArg, scaleArg] = process.argv.slice(2);
const triIdx = +triIdxArg;
const scaleU = +(scaleArg ?? 0.5);

const z = unzipSync(readFileSync(file));
const entry = Object.keys(z).find(k => k.endsWith('3dmodel.model'));
const xml = new TextDecoder().decode(z[entry]);
const vtx = [...xml.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)].map(m => [+m[1], +m[2], +m[3]]);
const tri = [...xml.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)].map(m => [+m[1], +m[2], +m[3]]);
console.log(`verts=${vtx.length} tris=${tri.length}`);

const T = tri[triIdx];
if (!T) { console.log('tri index out of range'); process.exit(0); }
for (const vi of T) console.log('  v:', vtx[vi].map(c => c.toFixed(4)).join(', '));
const c = [0, 1, 2].map(k => (vtx[T[0]][k] + vtx[T[1]][k] + vtx[T[2]][k]) / 3);
console.log('centroid:', c.map(x => x.toFixed(4)).join(', '));

// Bounding box → md and tile period; report distance of the centroid to the
// nearest tile line per axis (planar projections use (coord - min)/md).
let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
for (const v of vtx) for (let k = 0; k < 3; k++) { if (v[k] < min[k]) min[k] = v[k]; if (v[k] > max[k]) max[k] = v[k]; }
const size = [max[0]-min[0], max[1]-min[1], max[2]-min[2]];
const md = Math.max(...size);
const P = md * scaleU;
console.log(`bbox min=${min.map(x=>x.toFixed(2))} size=${size.map(x=>x.toFixed(2))} md=${md.toFixed(2)} tilePeriod=${P.toFixed(2)}mm`);
for (let k = 0; k < 3; k++) {
  const u = (c[k] - min[k]) / P;
  const dist = Math.abs(u - Math.round(u)) * P;
  console.log(`  axis ${'xyz'[k]}: u=${u.toFixed(4)} tiles → distance to tile line = ${dist.toFixed(3)} mm`);
}
