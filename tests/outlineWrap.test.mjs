/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Outline wrap (projection mode 8): js/outlineWrap.js and its branch of computeUV in js/mapping.js.
// Run: node --test tests/outlineWrap.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOutlineWrap, outlineWrapPlace, outlineWrapPlaces, outlineWrapCapWeight } from '../js/outlineWrap.js';
import { computeUV, getScaleReferenceLengths, MODE_CYLINDRICAL, MODE_OUTLINE_WRAP } from '../js/mapping.js';

const deg = (d) => d * Math.PI / 180;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (±${tol})`);
/** Distance of two tiled UV values on the circle that the tiling makes of [0, 1). */
const apart = (a, b) => { const d = Math.abs(a - b) % 1; return Math.min(d, 1 - d); };

/** Triangle soup of quads and triangles given as corner lists. */
function soup(polys) {
  const out = [];
  for (const p of polys) {
    for (let i = 1; i + 1 < p.length; i++) out.push(...p[0], ...p[i], ...p[i + 1]);
  }
  return new Float32Array(out);
}

/** A closed box from `a` to `b`, outward winding. */
function box([x0, y0, z0], [x1, y1, z1]) {
  const c = (i, j, k) => [i ? x1 : x0, j ? y1 : y0, k ? z1 : z0];
  return soup([
    [c(0, 0, 0), c(0, 1, 0), c(1, 1, 0), c(1, 0, 0)], // bottom
    [c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)], // top
    [c(0, 0, 0), c(1, 0, 0), c(1, 0, 1), c(0, 0, 1)], // -Y
    [c(1, 0, 0), c(1, 1, 0), c(1, 1, 1), c(1, 0, 1)], // +X
    [c(1, 1, 0), c(0, 1, 0), c(0, 1, 1), c(1, 1, 1)], // +Y
    [c(0, 1, 0), c(0, 0, 0), c(0, 0, 1), c(0, 1, 1)], // -X
  ]);
}

/**
 * A solid pot: a rounded rectangle `w` × `d` (corner radius `r`, `steps` pieces per corner) around (cx, cy) at z0,
 * growing by `draft` degrees up to z1. Returns the soup and its wall quads.
 */
function pot({ w = 60, d = 30, r = 5, steps = 8, cx = 40, cy = 25, z0 = 2, z1 = 42, draft = 5 } = {}) {
  const ring = (z) => {
    const R = r + (z - z0) * Math.tan(deg(draft));
    const a = w / 2 - r, b = d / 2 - r;
    const out = [];
    for (const [x, y, start, sx, sy] of [[a, b, 0, 1, 0], [-a, b, 90, 0, 1], [-a, -b, 180, -1, 0], [a, -b, 270, 0, -1]]) {
      out.push([cx + sx * (a + R), cy + sy * (b + R), z]);   // the middle of the side before the corner
      for (let i = 0; i <= steps; i++) {
        const t = deg(start + 90 * i / steps);
        out.push([cx + x + R * Math.cos(t), cy + y + R * Math.sin(t), z]);
      }
    }
    return out;
  };
  const lo = ring(z0), hi = ring(z1), n = lo.length;
  const walls = lo.map((_, i) => { const j = (i + 1) % n; return [lo[i], lo[j], hi[j], hi[i]]; });
  const polys = [...walls];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    polys.push([[cx, cy, z0], lo[j], lo[i]], [[cx, cy, z1], hi[i], hi[j]]);
  }
  // The outline's length at a height: the perimeter of the ring there.
  const length = (z) => { const g = ring(z); return g.reduce((sum, a, i) => { const b = g[(i + 1) % g.length]; return sum + Math.hypot(b[0] - a[0], b[1] - a[1]); }, 0); };
  return { positions: soup(polys), walls, length, shape: { w, d, r, cx, cy, z0, z1, draft } };
}

/** The point just before (e < 0) or after (e > 0) the seam, in the middle of the -Y side, at height z. */
function nearSeam({ d, r, cx, cy, z0, draft }, z, e) {
  const grow = (z - z0) * Math.tan(deg(draft));
  return { x: cx + e, y: cy - d / 2 - grow, z };
}

const bounds = (pos) => {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (let i = 0; i < pos.length; i += 3) {
    for (const [k, o] of [['x', 0], ['y', 1], ['z', 2]]) {
      min[k] = Math.min(min[k], pos[i + o]);
      max[k] = Math.max(max[k], pos[i + o]);
    }
  }
  const size = { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z };
  const center = { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 };
  return { min, max, size, center };
};

/** u' and v' in mm with whole repeats of `tile` mm: computeUV's rule, before the tiling. */
function fit(wrap, p, tile) {
  const n = Math.max(1, Math.round(wrap.meanLength / tile));
  const L = n * tile;
  const { share, rise } = outlineWrapPlace(wrap, p.x, p.y, p.z);
  return { u: share * L, v: rise * L, L };
}

/** σmax / σmin of the Jacobian of `map` over a wall quad, by central differences on a 6 × 6 grid. */
function stretch(map, [a, b, c, d]) {
  let worst = 1;
  const at = (s, t) => {
    const lerp = (p, q, f) => p.map((v, i) => v + (q[i] - v) * f);
    const [x, y, z] = lerp(lerp(a, b, s), lerp(d, c, s), t);
    return { x, y, z };
  };
  const len = (p, q) => Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z);
  for (let i = 1; i < 6; i++) {
    for (let j = 1; j < 6; j++) {
      const [s, t, e] = [i / 6, j / 6, 1e-3];
      const [s0, s1, t0, t1] = [at(s - e, t), at(s + e, t), at(s, t - e), at(s, t + e)];
      const [m0, m1, n0, n1] = [map(s0), map(s1), map(t0), map(t1)];
      const du = [(m1[0] - m0[0]) / len(s0, s1), (m1[1] - m0[1]) / len(s0, s1)];
      const dv = [(n1[0] - n0[0]) / len(t0, t1), (n1[1] - n0[1]) / len(t0, t1)];
      const sum = du[0] ** 2 + du[1] ** 2 + dv[0] ** 2 + dv[1] ** 2;
      const det = Math.abs(du[0] * dv[1] - du[1] * dv[0]);
      worst = Math.max(worst, (sum + Math.sqrt(Math.max(0, sum * sum - 4 * det * det))) / 2 / det);
    }
  }
  return worst;
}

test("runs along a box's outline from the seam in the middle of -Y, unbroken around each corner", () => {
  // 20 × 12 × 10: the outline is 64 mm; the seam lies at (10, 0); the corners at 10, 22, 42 and 54 mm.
  const wrap = buildOutlineWrap(box([0, 0, 0], [20, 12, 10]));
  near(wrap.meanLength, 64, 1e-9, 'outline');
  const at = (x, y) => outlineWrapPlace(wrap, x, y, 5).share * 64;
  near(at(10.0001, 0), 0, 1e-3, 'just after the seam');
  near(at(9.9999, 0), 64, 1e-3, 'just before the seam');
  near(at(20, 0), 10, 1e-9, 'corner (20, 0)');
  near(at(20, 6), 16, 1e-9, 'middle of +X');
  near(at(20, 12), 22, 1e-9, 'corner (20, 12)');
  near(at(0, 12), 42, 1e-9, 'corner (0, 12)');
  near(at(0, 0), 54, 1e-9, 'corner (0, 0)');
  // The rise of a straight box is the height over the outline.
  near(outlineWrapPlace(wrap, 20, 6, 7.5).rise, 7.5 / 64, 1e-9, 'rise');
});

test('fits whole repeats around every height of a drafted pot, so the pattern closes at the seam', () => {
  const p = pot();
  const wrap = buildOutlineWrap(p.positions);
  near(wrap.meanLength, p.length((p.shape.z0 + p.shape.z1) / 2), 1e-6, 'mean outline');
  for (const tile of [7, 24, 31.3]) {
    const n = Math.round(wrap.meanLength / tile);
    for (const z of [2.05, 9.6, 21.37, 41.95]) {
      const before = fit(wrap, nearSeam(p.shape, z, -1e-4), tile);
      const after = fit(wrap, nearSeam(p.shape, z, 1e-4), tile);
      near(before.L, n * tile, 1e-9, `L* at ${tile} mm`);
      near(before.u, n * tile, 2e-3, `before the seam, ${tile} mm at z ${z}`);
      near(after.u, 0, 2e-3, `after the seam, ${tile} mm at z ${z}`);
    }
  }
});

test("keeps the cells' shape on every wall of the drafted pot", () => {
  const p = pot();
  const wrap = buildOutlineWrap(p.positions);
  const map = (q) => { const f = fit(wrap, q, 24); return [f.u, f.v]; };
  const worst = Math.max(...p.walls.map((w) => stretch(map, w)));
  assert.ok(worst < 1.15, `largest stretch ${worst}`);
});

test('computeUV mode 8 tiles the places with whole repeats, takes planar XY on caps, and blends 20°–30°', () => {
  const p = pot();
  const wrap = buildOutlineWrap(p.positions);
  const b = bounds(p.positions);
  const settings = { scaleU: 24, scaleV: 24, offsetU: 0.3, offsetV: 0.2, rotation: 0, outlineWrap: wrap };
  assert.deepEqual(getScaleReferenceLengths(MODE_OUTLINE_WRAP, settings, b), { refU: wrap.meanLength, refV: wrap.meanLength });
  const n = Math.round(wrap.meanLength / 24);
  const q = nearSeam(p.shape, 20, 7);
  const side = computeUV(q, { x: 0, y: -1, z: 0 }, MODE_OUTLINE_WRAP, settings, b);
  assert.equal(side.triplanar, false);
  const { share, rise } = outlineWrapPlace(wrap, q.x, q.y, q.z);
  near(apart(side.u, share * n + 0.3), 0, 1e-9, 'u = share · n repeats');
  near(apart(side.v, rise * n + 0.2), 0, 1e-9, 'v = rise · n (scaleV = scaleU)');
  // Across the seam the tiled u matches, as n is whole.
  const [s0, s1] = [-1e-4, 1e-4].map((e) => computeUV(nearSeam(p.shape, 20, e), { x: 0, y: -1, z: 0 }, MODE_OUTLINE_WRAP, settings, b));
  near(apart(s0.u, s1.u), 0, 1e-4, 'seam');
  // A cap: planar XY over the mean outline, from the box's least corner.
  const top = { x: 45, y: 31, z: 42 };
  const cap = computeUV(top, { x: 0, y: 0, z: 1 }, MODE_OUTLINE_WRAP, settings, b);
  near(apart(cap.u, (top.x - b.min.x) / 24 + 0.3), 0, 1e-9, 'cap u');
  near(apart(cap.v, (top.y - b.min.y) / 24 + 0.2), 0, 1e-9, 'cap v');
  // 25° off the axis: half cap, half side.
  const mid = computeUV(top, { x: Math.sin(deg(25)), y: 0, z: Math.cos(deg(25)) }, MODE_OUTLINE_WRAP, settings, b);
  assert.equal(mid.triplanar, true);
  near(mid.samples[0].w + mid.samples[1].w, 1, 1e-12, 'weights');
  near(outlineWrapCapWeight(Math.cos(deg(25))), 0.5, 1e-12, 'cap weight at 25°');
  assert.equal(outlineWrapCapWeight(Math.cos(deg(19))), 1);
  assert.equal(outlineWrapCapWeight(Math.cos(deg(31))), 0);
});

test('maps as cylindrical without its tables', () => {
  const p = pot();
  const b = bounds(p.positions);
  const settings = { scaleU: 24, scaleV: 24, offsetU: 0, offsetV: 0, rotation: 0 };
  const q = nearSeam(p.shape, 20, 7);
  const nrm = { x: 0, y: -1, z: 0 };
  assert.deepEqual(computeUV(q, nrm, MODE_OUTLINE_WRAP, settings, b), computeUV(q, nrm, MODE_CYLINDRICAL, settings, b));
  assert.deepEqual(getScaleReferenceLengths(MODE_OUTLINE_WRAP, settings, b), getScaleReferenceLengths(MODE_CYLINDRICAL, settings, b));
});

test('gives each corner its place, with a triangle across the seam kept on one side of it', () => {
  const positions = box([0, 0, 0], [20, 12, 10]);
  const wrap = buildOutlineWrap(positions);
  const places = outlineWrapPlaces(wrap, positions);
  for (let c = 0; c < positions.length / 3; c += 3) {
    for (let i = 1; i < 3; i++) assert.ok(Math.abs(places[2 * (c + i)] - places[2 * c]) <= 0.5, `triangle ${c / 3}`);
  }
  // The -Y face (triangles 4 and 5) straddles the seam at x = 10.
  const shares = [0, 1, 2].map((i) => places[2 * (4 * 3 + i)]);
  assert.ok(Math.max(...shares) - Math.min(...shares) < 0.5);
});

test('refuses an outline that does not go around the centre, with the height in the reason', () => {
  // A C: a 30 mm square with a notch from the right, 12 to 18 mm up.
  const c = [[0, 0], [30, 0], [30, 12], [18, 12], [18, 18], [30, 18], [30, 30], [0, 30]];
  const ring = (z) => c.map(([x, y]) => [x, y, z]);
  const lo = ring(0), hi = ring(4);
  const polys = lo.map((_, i) => { const j = (i + 1) % c.length; return [lo[i], lo[j], hi[j], hi[i]]; });
  polys.push([...lo].reverse(), hi);
  assert.throws(() => buildOutlineWrap(soup(polys)), /^Error: At z = 0\.25 mm, a ray from the centre of the bounding box crosses the part's outline more than once/);
});
