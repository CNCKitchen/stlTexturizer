// Standalone harness for the Smooth Bottom advanced feature added in main.js
// (snapBottomToFlat). Mirrors the algorithm so we can exercise it in Node
// without three.js or a browser.
//
// What's under test:
//   1. Vertices within ±tol of the bottom plane snap to bottomZ exactly.
//   2. Vertices outside ±tol stay put — side fillets and the rest of the
//      model are not affected.
//   3. Triangles that get any vertex snapped have their face normal
//      recomputed from the new positions so slicers shade the now-planar
//      surface uniformly.
//   4. Non-dirty triangles' normals are left untouched (no spurious work).
//   5. The default 0.1 mm threshold is well above float32 round-trip noise
//      but below typical printer resolution, so it's safe by default.
//
// Mirror of main.js's snapBottomToFlat — keep the two in sync if either
// changes.

let _failed = 0;
function expect(label, ok, detail) {
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ''}`);
    _failed++;
  }
}
function approxEq(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }

function snapBottomToFlat(positions, normals, bottomZ, tol = 0.1) {
  let dirtyTris = 0;
  for (let i = 0; i < positions.length; i += 9) {
    let dirty = false;
    if (Math.abs(positions[i+2] - bottomZ) <= tol) { positions[i+2] = bottomZ; dirty = true; }
    if (Math.abs(positions[i+5] - bottomZ) <= tol) { positions[i+5] = bottomZ; dirty = true; }
    if (Math.abs(positions[i+8] - bottomZ) <= tol) { positions[i+8] = bottomZ; dirty = true; }
    if (dirty) {
      dirtyTris++;
      const ux = positions[i+3]-positions[i],   uy = positions[i+4]-positions[i+1], uz = positions[i+5]-positions[i+2];
      const vx = positions[i+6]-positions[i],   vy = positions[i+7]-positions[i+1], vz = positions[i+8]-positions[i+2];
      const nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
      const len = Math.sqrt(nx*nx+ny*ny+nz*nz) || 1;
      normals[i]   = normals[i+3] = normals[i+6] = nx/len;
      normals[i+1] = normals[i+4] = normals[i+7] = ny/len;
      normals[i+2] = normals[i+5] = normals[i+8] = nz/len;
    }
  }
  return dirtyTris;
}

// ── Test 1: nearly-flat bottom slivers all snap to bottomZ ─────────────────
console.log('Test 1: 0.05 mm-tilted bottom slivers snap flat');
{
  const bottomZ = 0;
  // Two adjacent triangles forming a small bottom region. Winding is CCW
  // viewed from below so the recomputed face normal points -Z (the typical
  // convention for the underside of a printed model).
  // All vertices are within 0.1 mm of bottomZ but slightly above by varying
  // amounts — the artifact slicers shade differently.
  const positions = new Float32Array([
    // t0 — A=(0,0), B=(0,1), C=(1,0) → cross gives (0,0,-1)
    0, 0, 0.02,
    0, 1, 0.07,
    1, 0, 0.05,
    // t1 — same orientation
    1, 0, 0.05,
    0, 1, 0.07,
    1, 1, 0.03,
  ]);
  const normals = new Float32Array(positions.length);

  const dirty = snapBottomToFlat(positions, normals, bottomZ, 0.1);

  expect('both triangles flagged dirty', dirty === 2);
  expect('all vertex z-coords snapped to bottomZ',
         positions.every((_, i) => i % 3 !== 2 || positions[i] === bottomZ));
  expect('t0 normal points down (cross-product after snap)',
         approxEq(normals[0], 0) && approxEq(normals[1], 0) && approxEq(normals[2], -1));
  expect('t1 normal also points down (consistent winding)',
         approxEq(normals[9], 0) && approxEq(normals[10], 0) && approxEq(normals[11], -1));
}

// ── Test 2: above-tol vertices stay put (side fillet, etc.) ────────────────
console.log('\nTest 2: vertices above the threshold are not touched');
{
  const bottomZ = 0;
  // Triangle with two bottom-plane vertices and one fillet vertex 0.5 mm up.
  const positions = new Float32Array([
    0, 0, 0.05,    // close to bottom (within tol)
    1, 0, 0.02,    // close to bottom
    0.5, 1, 0.5,   // fillet vertex — must stay
  ]);
  const normals = new Float32Array(positions.length);

  const dirty = snapBottomToFlat(positions, normals, bottomZ, 0.1);

  expect('triangle is dirty (it has 2 bottom-plane vertices)', dirty === 1);
  expect('bottom-plane vertices snapped',
         positions[2] === 0 && positions[5] === 0);
  expect('fillet vertex z preserved', positions[8] === 0.5);
  // Normal should point along (small +y, mostly +z direction) — not pure ±Z
  // because the fillet vertex is offset upward.
  expect('normal recomputed (z component non-zero)',
         normals[2] !== 0);
}

// ── Test 3: clean mesh below threshold — no spurious normal writes ─────────
console.log('\nTest 3: triangles entirely above threshold stay untouched');
{
  const bottomZ = 0;
  // Triangle 0.5 mm above bottom — outside ±0.1 tol, must be untouched.
  const positions = new Float32Array([
    0, 0, 0.5,
    1, 0, 0.5,
    0, 1, 0.5,
  ]);
  const sentinel = 999;
  const normals = new Float32Array(9).fill(sentinel);

  const dirty = snapBottomToFlat(positions, normals, bottomZ, 0.1);

  expect('no triangles dirty', dirty === 0);
  expect('positions unchanged',
         positions[2] === 0.5 && positions[5] === 0.5 && positions[8] === 0.5);
  expect('normals untouched (sentinel preserved)',
         normals.every(v => v === sentinel));
}

// ── Test 4: threshold boundary — well-inside vs well-outside ──────────────
console.log('\nTest 4: threshold boundary discriminates well-inside vs well-outside');
{
  const bottomZ = 0;
  const tol = 0.1;
  // Use values comfortably inside / outside the tol so the test isn't at
  // the float32 representation boundary of 0.1 (which can fall either side).
  const positions = new Float32Array([
    0, 0, 0.099,   // just inside tol — must snap
    1, 0, 0.15,    // outside tol — must NOT snap
    0, 1, 0.05,    // well inside — must snap
  ]);
  const normals = new Float32Array(positions.length);

  snapBottomToFlat(positions, normals, bottomZ, tol);

  expect('z = 0.099 snapped to bottomZ', positions[2] === 0);
  expect('z = 0.15  is NOT snapped',     positions[5] !== 0);
  expect('z = 0.05  snapped to bottomZ', positions[8] === 0);
}

// ── Test 5: below-bottom vertices (slipped through earlier clamps) ─────────
console.log('\nTest 5: below-bottom vertices within tol snap up to bottomZ');
{
  const bottomZ = 0;
  const positions = new Float32Array([
    0, 0, -0.05,   // slightly below bottom — must snap UP
    1, 0, -0.08,
    0, 1, -0.02,
  ]);
  const normals = new Float32Array(positions.length);

  snapBottomToFlat(positions, normals, bottomZ, 0.1);

  expect('z = -0.05 snapped to 0', positions[2] === 0);
  expect('z = -0.08 snapped to 0', positions[5] === 0);
  expect('z = -0.02 snapped to 0', positions[8] === 0);
}

// ── Test 6: large stress test — invariants hold across many vertices ──────
console.log('\nTest 6: 50k random vertices');
{
  const bottomZ = 0;
  let seed = 9876543;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xFFFFFFFF; };
  const N = 50_000;
  const positions = new Float32Array(N * 9);
  const original  = new Float32Array(N * 9);
  for (let i = 0; i < N * 9; i++) {
    // Spread z between -0.5 and +5.0 mm so a healthy fraction is within tol
    // and a healthy fraction isn't.
    positions[i] = (i % 3 === 2) ? rand() * 5.5 - 0.5 : rand() * 10;
    original[i] = positions[i];
  }
  const normals = new Float32Array(N * 9);

  snapBottomToFlat(positions, normals, bottomZ, 0.1);

  let snapped = 0, preserved = 0, mismatch = 0;
  for (let i = 0; i < N * 9; i += 3) {
    const z = positions[i + 2];
    const oz = original[i + 2];
    if (Math.abs(oz - bottomZ) <= 0.1) {
      // Was within tol → must be exactly bottomZ now.
      if (z === bottomZ) snapped++;
      else mismatch++;
    } else {
      // Was outside tol → must be untouched.
      if (z === oz) preserved++;
      else mismatch++;
    }
  }
  expect('every within-tol vertex snapped to bottomZ', mismatch === 0,
         `${mismatch} vertices in wrong state`);
  expect('a substantial fraction of vertices were snapped',
         snapped > N * 0.1, `snapped only ${snapped}/${N*3} z-coords`);
  expect('a substantial fraction of vertices were preserved',
         preserved > N * 0.1, `preserved only ${preserved}/${N*3} z-coords`);
}

console.log(`\n${_failed === 0 ? 'All tests PASSED' : `${_failed} test(s) FAILED`}`);
process.exit(_failed === 0 ? 0 : 1);
