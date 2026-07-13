/**
 * makeCube.mjs — programmatically builds a tiny binary-STL cube fixture.
 * No external assets needed; every test that needs a mesh calls
 * `writeCubeFixture()` to materialize it under a temp path.
 */

import { writeFile } from 'node:fs/promises';

/** 12-triangle cube, outward-facing CCW winding, spanning [0,size]^3. */
export function buildCubeSTLBuffer(size = 20) {
  const s = size;
  const v = {
    '000': [0, 0, 0], '100': [s, 0, 0], '110': [s, s, 0], '010': [0, s, 0],
    '001': [0, 0, s], '101': [s, 0, s], '111': [s, s, s], '011': [0, s, s],
  };
  const tris = [
    [v['001'], v['101'], v['111']], [v['001'], v['111'], v['011']], // top    (+Z)
    [v['000'], v['110'], v['100']], [v['000'], v['010'], v['110']], // bottom (-Z)
    [v['000'], v['100'], v['101']], [v['000'], v['101'], v['001']], // front  (-Y)
    [v['010'], v['011'], v['111']], [v['010'], v['111'], v['110']], // back   (+Y)
    [v['000'], v['001'], v['011']], [v['000'], v['011'], v['010']], // left   (-X)
    [v['100'], v['110'], v['111']], [v['100'], v['111'], v['101']], // right  (+X)
  ];

  const triCount = tris.length;
  const buf = Buffer.alloc(84 + 50 * triCount);
  buf.writeUInt32LE(triCount, 80);
  let o = 84;
  for (const [a, b, c] of tris) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz) || 1;
    buf.writeFloatLE(nx / len, o); buf.writeFloatLE(ny / len, o + 4); buf.writeFloatLE(nz / len, o + 8);
    o += 12;
    for (const p of [a, b, c]) {
      buf.writeFloatLE(p[0], o); buf.writeFloatLE(p[1], o + 4); buf.writeFloatLE(p[2], o + 8);
      o += 12;
    }
    o += 2; // attribute byte count
  }
  return buf;
}

export async function writeCubeFixture(path, size = 20) {
  await writeFile(path, buildCubeSTLBuffer(size));
  return path;
}
