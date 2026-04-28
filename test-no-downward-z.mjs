// Standalone harness for the noDownwardZ ("Overhang Protection") clamp added
// to js/displacement.js Pass 3. Mirrors the per-vertex displacement loop so
// we can exercise the new branch in Node without three.js or a browser.
//
// What's under test:
//   1. With the flag OFF, a vertex with a downward-pointing smooth normal
//      and positive displacement moves to negative Z (the regression the
//      feature exists to prevent).
//   2. With the flag ON, that same vertex's Z stays pinned to its original
//      value while X and Y components of the displacement are preserved.
//   3. Upward Z motion is never clamped — the flag only affects −Z.
//   4. The pre-existing maskedFrac>0 boundary Z-clamp still runs and the new
//      clamp doesn't fight it (both pin Z, idempotent).
//   5. Stress test over many vertices: only those whose newZ < origZ are
//      modified; X/Y always faithful to the unclamped displacement.
//
// To match production behavior the helper here is a direct copy of the Pass 3
// displacement step in js/displacement.js — if either side changes, this
// test should be updated too.

let _failed = 0;
function expect(label, ok, detail) {
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ''}`);
    _failed++;
  }
}
function approxEq(a, b, eps = 1e-9) { return Math.abs(a - b) <= eps; }

// ── Replica of the Pass 3 displacement step from displacement.js ─────────────
// Inputs are scalars per vertex. Reproduces the relevant bits only:
//   - new position = orig + smoothNrm * disp (per-axis)
//   - existing maskedFrac>0 Z clamps for bottom/top angle limits
//   - new noDownwardZ Z clamp
function displaceVertex({ pos, smoothNrm, disp, maskedFrac, bottomZ, settings }) {
  const newX = pos.x + smoothNrm.x * disp;
  const newY = pos.y + smoothNrm.y * disp;
  let   newZ = pos.z + smoothNrm.z * disp;

  if (maskedFrac > 0) {
    if (settings.bottomAngleLimit > 0 && newZ < pos.z) newZ = pos.z;
    if (settings.topAngleLimit    > 0 && newZ > pos.z) newZ = pos.z;
  }

  if (settings.noDownwardZ && newZ < pos.z) newZ = pos.z;
  // Bottom-plane flat clamp: when overhang protection is on and the vertex
  // was originally on the print bottom, also clamp upward movement so the
  // bed-contact surface stays perfectly flat regardless of the texture.
  if (settings.noDownwardZ && bottomZ !== undefined && pos.z <= bottomZ + 1e-5) {
    newZ = pos.z;
  }

  return { x: newX, y: newY, z: newZ };
}

const baseSettings = { bottomAngleLimit: 0, topAngleLimit: 0, noDownwardZ: false };

// ── Test 1: regression case the feature exists to prevent ────────────────────
console.log('Test 1: downward-facing surface, flag OFF → vertex moves to −Z');
{
  // Vertex on the bottom of a part, smooth normal points straight down,
  // texture sample produces positive displacement — vertex sinks into −Z.
  const pos = { x: 1, y: 2, z: 0 };
  const smoothNrm = { x: 0, y: 0, z: -1 };
  const disp = 0.3;
  const out = displaceVertex({ pos, smoothNrm, disp, maskedFrac: 0, settings: { ...baseSettings, noDownwardZ: false } });

  expect('X unchanged (smoothNrm.x = 0)', approxEq(out.x, 1));
  expect('Y unchanged (smoothNrm.y = 0)', approxEq(out.y, 2));
  expect('Z moves to −0.3 (overhang created)', approxEq(out.z, -0.3));
}

// ── Test 2: same vertex with flag ON → Z is pinned ──────────────────────────
console.log('\nTest 2: same vertex with noDownwardZ=true → Z stays put');
{
  const pos = { x: 1, y: 2, z: 0 };
  const smoothNrm = { x: 0, y: 0, z: -1 };
  const disp = 0.3;
  const out = displaceVertex({ pos, smoothNrm, disp, maskedFrac: 0, settings: { ...baseSettings, noDownwardZ: true } });

  expect('X still unchanged', approxEq(out.x, 1));
  expect('Y still unchanged', approxEq(out.y, 2));
  expect('Z clamped to original (no overhang)', approxEq(out.z, 0));
}

// ── Test 3: oblique normal — X/Y must survive when Z is clamped ─────────────
console.log('\nTest 3: oblique downward normal — X/Y kept, Z clamped');
{
  // Normal points down-and-to-the-side. With flag on, the lateral motion
  // should still apply so surface detail is visible — only Z is pinned.
  const inv = 1 / Math.sqrt(3);
  const pos = { x: 5, y: 5, z: 5 };
  const smoothNrm = { x: inv, y: inv, z: -inv };
  const disp = 0.6;
  const out = displaceVertex({ pos, smoothNrm, disp, maskedFrac: 0, settings: { ...baseSettings, noDownwardZ: true } });

  expect('X moved by smoothNrm.x * disp',
         approxEq(out.x, 5 + inv * 0.6),
         `got ${out.x}, expected ${5 + inv * 0.6}`);
  expect('Y moved by smoothNrm.y * disp',
         approxEq(out.y, 5 + inv * 0.6),
         `got ${out.y}, expected ${5 + inv * 0.6}`);
  expect('Z pinned to original despite −Z normal component', approxEq(out.z, 5));
}

// ── Test 4: upward motion never clamped ─────────────────────────────────────
console.log('\nTest 4: upward displacement is not affected by the flag');
{
  // +Z normal, positive disp → vertex moves up. Flag must not interfere.
  const pos = { x: 0, y: 0, z: 0 };
  const smoothNrm = { x: 0, y: 0, z: 1 };
  const disp = 0.4;
  const off = displaceVertex({ pos, smoothNrm, disp, maskedFrac: 0, settings: { ...baseSettings, noDownwardZ: false } });
  const on  = displaceVertex({ pos, smoothNrm, disp, maskedFrac: 0, settings: { ...baseSettings, noDownwardZ: true } });

  expect('flag off: Z = +0.4', approxEq(off.z, 0.4));
  expect('flag on:  Z = +0.4 (identical — no clamp triggered)', approxEq(on.z, 0.4));
}

// ── Test 5: inverted texture pushing a +Z surface downward ──────────────────
console.log('\nTest 5: inverted texture (negative disp) on a +Z surface');
{
  // smoothNrm = (0,0,1), disp = −0.25 → vertex sinks. The flag should pin Z.
  const pos = { x: 0, y: 0, z: 10 };
  const smoothNrm = { x: 0, y: 0, z: 1 };
  const disp = -0.25;
  const off = displaceVertex({ pos, smoothNrm, disp, maskedFrac: 0, settings: { ...baseSettings, noDownwardZ: false } });
  const on  = displaceVertex({ pos, smoothNrm, disp, maskedFrac: 0, settings: { ...baseSettings, noDownwardZ: true } });

  expect('flag off: Z = 9.75 (sinks)', approxEq(off.z, 9.75));
  expect('flag on:  Z = 10.0 (clamped)', approxEq(on.z, 10));
}

// ── Test 6: noDownwardZ does not collide with the existing boundary clamp ───
console.log('\nTest 6: idempotent with the maskedFrac>0 bottomAngleLimit clamp');
{
  // The existing branch already pins Z when maskedFrac>0 and Z would dip.
  // Adding the new branch on top must produce the same final Z (no overshoot,
  // no double-correction).
  const pos = { x: 0, y: 0, z: 2 };
  const smoothNrm = { x: 0, y: 0, z: -1 };
  const disp = 0.5;
  const settings = { bottomAngleLimit: 5, topAngleLimit: 0, noDownwardZ: true };
  const out = displaceVertex({ pos, smoothNrm, disp, maskedFrac: 0.4, settings });

  expect('Z pinned exactly to original (single clamped value)', approxEq(out.z, 2));
}

// ── Test 7: zero displacement vertex unchanged ──────────────────────────────
console.log('\nTest 7: zero displacement → no movement regardless of flag');
{
  const pos = { x: 7, y: -3, z: 4 };
  const smoothNrm = { x: 0, y: 0, z: -1 };
  const out = displaceVertex({ pos, smoothNrm, disp: 0, maskedFrac: 0, settings: { ...baseSettings, noDownwardZ: true } });

  expect('X unchanged', approxEq(out.x, 7));
  expect('Y unchanged', approxEq(out.y, -3));
  expect('Z unchanged', approxEq(out.z, 4));
}

// ── Test 8: large random sample — invariants hold across many vertices ──────
console.log('\nTest 8: 50k random vertices, invariants under noDownwardZ=true');
{
  // Reproducible seeded RNG so failures bisect cleanly.
  let seed = 1234567;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xFFFFFFFF;
  };
  const N = 50_000;
  let zClampCount = 0;
  let xyMismatches = 0;
  let upwardClampViolations = 0;

  for (let i = 0; i < N; i++) {
    const pos = { x: rand() * 20 - 10, y: rand() * 20 - 10, z: rand() * 20 - 10 };
    // Random unit-ish normal — accept the rare zero-length, the live code
    // already guards against it via len||1 in normalisation.
    let nx = rand() * 2 - 1, ny = rand() * 2 - 1, nz = rand() * 2 - 1;
    const len = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
    nx /= len; ny /= len; nz /= len;
    const smoothNrm = { x: nx, y: ny, z: nz };
    const disp = (rand() - 0.5) * 1.0;

    const off = displaceVertex({ pos, smoothNrm, disp, maskedFrac: 0, settings: { ...baseSettings, noDownwardZ: false } });
    const on  = displaceVertex({ pos, smoothNrm, disp, maskedFrac: 0, settings: { ...baseSettings, noDownwardZ: true } });

    // X and Y must be identical regardless of the flag.
    if (!approxEq(off.x, on.x) || !approxEq(off.y, on.y)) xyMismatches++;

    // Whenever the unclamped Z dipped below origin, the clamped Z must equal origin.
    if (off.z < pos.z) {
      zClampCount++;
      if (!approxEq(on.z, pos.z)) {
        // Mismatch — count it.
        xyMismatches++;
      }
    } else {
      // Upward / no-change cases: clamped Z must equal unclamped Z.
      if (!approxEq(on.z, off.z)) upwardClampViolations++;
    }
  }

  expect('X and Y identical between flag off/on for all vertices', xyMismatches === 0,
         `${xyMismatches} mismatches`);
  expect('clamp triggered only when unclamped Z < orig Z (no spurious clamps)',
         upwardClampViolations === 0, `${upwardClampViolations} violations`);
  // Sanity: with random ±disp and random normals, ~half the vertices will
  // dip below origin in Z. The exact count is unimportant; we just want a
  // healthy mix so the assertions above are exercising both branches.
  expect('a substantial fraction of vertices were clamped (mix of branches)',
         zClampCount > N * 0.2 && zClampCount < N * 0.8,
         `clamped ${zClampCount}/${N}`);
}

// ── Test 9: bottom-plane stays perfectly flat under noDownwardZ ──────────────
console.log('\nTest 9: noDownwardZ also clamps upward movement on bottom-plane vertices');
{
  // Real-world bug: a flat-bottom face (smoothNrm = (0,0,-1)) under
  // symmetric displacement gets pulled UPWARD by negative-grey samples
  // because the existing noDownwardZ clamp only catches downward motion.
  // Adjacent bottom-face vertices end up at slightly different Z heights,
  // and PrusaSlicer renders the now-tilted bottom triangles with visibly
  // varying shading. Once overhang protection is on, the bottom plane
  // must also stay perfectly flat so the print bed-contact surface is
  // a single Z value.
  const bottomZ = 0;
  const pos = { x: 5, y: 5, z: bottomZ };
  const smoothNrm = { x: 0, y: 0, z: -1 };

  // Centred grey of -0.1 → disp = -0.15 (with amp 1.5). newZ = 0 + (-1)*(-0.15) = +0.15.
  const disp = -0.15;
  const off = displaceVertex({ pos, smoothNrm, disp, maskedFrac: 0, bottomZ,
    settings: { ...baseSettings, noDownwardZ: false } });
  const on  = displaceVertex({ pos, smoothNrm, disp, maskedFrac: 0, bottomZ,
    settings: { ...baseSettings, noDownwardZ: true } });

  expect('flag off: bottom vertex moves up to +0.15 (regression case)',
         approxEq(off.z, 0.15));
  expect('flag on:  bottom vertex stays at bottomZ',
         approxEq(on.z, bottomZ));

  // Vertex slightly above the bottom plane (e.g. 0.5 mm into a side fillet)
  // must NOT be clamped — that's the textured surface, not the bed contact.
  const filletPos = { x: 5, y: 5, z: bottomZ + 0.5 };
  const filletNrm = { x: 1, y: 0, z: 0 };          // horizontal-facing fillet
  const filletOut = displaceVertex({ pos: filletPos, smoothNrm: filletNrm, disp: 0.1,
    maskedFrac: 0, bottomZ, settings: { ...baseSettings, noDownwardZ: true } });
  expect('above-bottom fillet vertex still receives full XY displacement',
         approxEq(filletOut.x, 5.1) && approxEq(filletOut.z, bottomZ + 0.5));
}

console.log(`\n${_failed === 0 ? 'All tests PASSED' : `${_failed} test(s) FAILED`}`);
process.exit(_failed === 0 ? 0 : 1);
