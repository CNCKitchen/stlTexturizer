/**
 * Mesh regularization via short-edge collapse.
 *
 * Subdivision turns CAD-tessellation needles into chains of small slivers
 * that, while individually within the maxEdgeLength budget, are still poor
 * triangles (high aspect ratio).  When displacement samples a noisy texture
 * those slivers' three vertices grab three random texels and produce visibly
 * jagged geometry (the artifact reported on laserPlate.stl).
 *
 * This pass walks the post-subdivision mesh, finds sliver triangles, and
 * collapses their shortest edge to its midpoint — but only when the collapse
 * is provably safe under three constraints, all checked per candidate:
 *
 *   1. EDGE-LENGTH cap: no surviving triangle in the affected neighbourhood
 *      may end up with an edge longer than `maxEdgeLength × slack`.  Without
 *      this, collapsing one sliver could produce a triangle that itself
 *      exceeds the user-requested resolution.
 *
 *   2. NORMAL preservation: every surviving affected triangle must keep its
 *      face normal within `maxNormalDeltaCos` of its original direction.
 *      This prevents the collapse from flattening curved surfaces (fillets,
 *      domes, fine round features) — only locally-flat regions yield welds.
 *
 *   3. TOPOLOGY preservation: link condition — the only common neighbours of
 *      u and v in the mesh must be the two wing triangles' apex vertices.
 *      Extra common neighbours would produce non-manifold output.  Boundary
 *      and non-manifold edges are skipped.
 *
 * The pass is iterative: each round collapses every safe candidate, then
 * re-evaluates against the updated mesh, until no more valid candidates
 * remain or `maxRounds` is hit.
 *
 * @param {THREE.BufferGeometry} geometry      – non-indexed input from subdivide()
 * @param {Int32Array}           faceParentId  – tracked through subdivision
 * @param {number}               maxEdgeLength – user's requested edge length
 * @param {object}              [opts]
 * @param {number}              [opts.aspectThreshold=5] – consider triangles with thinness (lmax/hmin) above this
 * @param {number}              [opts.slack=3.0]         – base multiplier on maxEdgeLength for new edges
 * @param {number}              [opts.aggressiveSlack=8] – slack used when EITHER wing is an extreme sliver
 * @param {number}              [opts.extremeSliverAspect=8]            – thinness above which a wing counts as extreme
 * @param {number}              [opts.maxNormalDeltaCos=cos(15°)]       – min dot of new vs old face normal (base)
 * @param {number}              [opts.aggressiveNormalDeltaCos=cos(25°)] – min dot when BOTH wings are extreme slivers
 * @param {number}              [opts.maxRounds=8]       – iterate until stable, capped at this
 * @returns {{ geometry, faceParentId, collapseCount }}
 */

import { THREE } from './threeCompat.js';
import { QuantizedPointMap } from './meshIndex.js';

const QUANTISE = 1e5;

export function regularizeMesh(geometry, faceParentId, maxEdgeLength, opts = {}) {
  // Candidate filter — triangles with thinness ABOVE this become collapse
  // candidates.  Bumped from 3 → 5 when we switched from edge-ratio to
  // thinness: the new metric is more sensitive (catches near-collinear
  // tris), so 3 swept up moderate-shape fillet triangles and broke them.
  // 5 still catches every meaningful sliver — chain slivers routinely have
  // thinness > 50 and the user's reported case was ≈ 1800.
  const aspectThreshold   = opts.aspectThreshold   ?? 5;
  // Two-tier slack.  The BASE (slack) is already loose so non-sliver boundary
  // collapses still succeed — that's what gives sliver chains the topological
  // room to dissolve.  The AGGRESSIVE tier kicks in when at least one wing is
  // an extreme sliver and adds extra leeway on top, letting tough chain ends
  // clear that the base tier alone wouldn't reach.  An earlier attempt with a
  // tight base (1.2) BLOCKED the helper collapses and made chains worse —
  // hence the loose base here.
  const slack             = opts.slack             ?? 3.0;
  const aggressiveSlack   = opts.aggressiveSlack   ?? 8.0;
  // Note: extremeSliverAspect is measured in the new thinness metric (lmax/hmin),
  // so a value of 8 means "longest edge is at least 8× the shortest altitude".
  // This skips moderate-shape fillet triangles (typically thinness 2–5) so the
  // loose aggressive normal cap doesn't bend fine fillets, while still catching
  // every real chain sliver (thinness routinely > 50).
  const extremeSliverAspect = opts.extremeSliverAspect ?? 8;
  // Per-collapse normal swing is bounded by `maxNormalDeltaCos` BUT we measure
  // the swing against each affected triangle's *original* normal (captured
  // once before any collapse), not its current post-drift normal.  Without
  // this, multiple rounds of 15° drift each compound into >100° corner
  // damage on 45° edges.
  //
  // Like edge-cap, normal-change is two-tier.  The aggressive tier fires only
  // when BOTH wings are extreme slivers (not just one) — that matches the
  // chain-of-needles-on-a-curved-face shape but NOT the fillet-sliver-next-to-
  // a-larger-fillet-face shape, so fine fillets keep their tight gate.
  const maxNormalDeltaCos        = opts.maxNormalDeltaCos        ?? Math.cos(15 * Math.PI / 180);
  const aggressiveNormalDeltaCos = opts.aggressiveNormalDeltaCos ?? Math.cos(25 * Math.PI / 180);
  // Vertices on edges with dihedral > sharpEdgeAngle are frozen: they cannot
  // be collapse endpoints, so 45°/90° feature edges keep every original
  // vertex.  Slivers in the interior of a flat face are still collapsible.
  const sharpEdgeCos      = opts.sharpEdgeCos      ?? Math.cos(30 * Math.PI / 180);
  const maxRounds         = opts.maxRounds         ?? 8;

  // Squared caps precomputed for both tiers; the per-collapse logic picks one.
  const baseMaxLenSqAllowed       = (maxEdgeLength * slack)           * (maxEdgeLength * slack);
  const aggressiveMaxLenSqAllowed = (maxEdgeLength * aggressiveSlack) * (maxEdgeLength * aggressiveSlack);
  const extremeAspect2 = extremeSliverAspect * extremeSliverAspect;

  // ── Build indexed mesh ──
  const pa = geometry.attributes.position.array;
  const triCount = pa.length / 9;

  const posMap = new QuantizedPointMap(QUANTISE, Math.min(triCount * 3, 1 << 22));
  // Vertex coordinates in growable typed arrays (Float64 — JS-number math
  // below must match the previous plain-array behaviour exactly).
  let vcap = Math.min(Math.max(1 << 16, triCount), triCount * 3);
  let vertX = new Float64Array(vcap), vertY = new Float64Array(vcap), vertZ = new Float64Array(vcap);
  let nextVid = 0;
  const corners = new Int32Array(triCount * 3);
  for (let i = 0; i < triCount * 3; i++) {
    const x = pa[i*3], y = pa[i*3+1], z = pa[i*3+2];
    const id = posMap.getOrSet(x, y, z, nextVid);
    if (posMap.inserted) {
      if (nextVid === vcap) {
        vcap = Math.min(vcap * 2, triCount * 3);
        const gx = new Float64Array(vcap); gx.set(vertX); vertX = gx;
        const gy = new Float64Array(vcap); gy.set(vertY); vertY = gy;
        const gz = new Float64Array(vcap); gz.set(vertZ); vertZ = gz;
      }
      vertX[nextVid] = x; vertY[nextVid] = y; vertZ[nextVid] = z;
      nextVid++;
    }
    corners[i] = id;
  }

  // Per-triangle face normal (unit) + flag for deleted tris
  const triNrmX = new Float32Array(triCount);
  const triNrmY = new Float32Array(triCount);
  const triNrmZ = new Float32Array(triCount);
  const triDeleted = new Uint8Array(triCount);
  const newParentId = new Int32Array(faceParentId);

  function recomputeFaceNormal(t) {
    const a = corners[t*3], b = corners[t*3+1], c = corners[t*3+2];
    const ax = vertX[a], ay = vertY[a], az = vertZ[a];
    const e1x = vertX[b]-ax, e1y = vertY[b]-ay, e1z = vertZ[b]-az;
    const e2x = vertX[c]-ax, e2y = vertY[c]-ay, e2z = vertZ[c]-az;
    const nx = e1y*e2z - e1z*e2y;
    const ny = e1z*e2x - e1x*e2z;
    const nz = e1x*e2y - e1y*e2x;
    const len = Math.sqrt(nx*nx + ny*ny + nz*nz);
    if (len > 0) {
      triNrmX[t] = nx/len; triNrmY[t] = ny/len; triNrmZ[t] = nz/len;
    } else {
      triNrmX[t] = 0; triNrmY[t] = 0; triNrmZ[t] = 0;
    }
  }
  for (let t = 0; t < triCount; t++) recomputeFaceNormal(t);

  // Original face normals — frozen at start, never updated.  The normal-swing
  // gate measures against THESE, not the running triNrm, so cumulative drift
  // across rounds can't compound past the per-collapse cap.
  const origNrmX = new Float32Array(triNrmX);
  const origNrmY = new Float32Array(triNrmY);
  const origNrmZ = new Float32Array(triNrmZ);

  // vertex → incident triangles, as intrusive doubly-linked lists of corner
  // slots over typed arrays (replaces one JS Set per vertex — far lighter on
  // multi-million-vertex meshes and allocation-free per collapse).
  // Slot s = corner index (t*3+k); the vertex owning slot s is corners[s].
  // Deleted wings and moved corners are unlinked, so each vertex's list
  // contains exactly its alive incident corners.
  const vfHead   = new Int32Array(nextVid).fill(-1);
  const slotNext = new Int32Array(triCount * 3);
  const slotPrev = new Int32Array(triCount * 3);
  function linkSlot(s) {
    const v = corners[s];
    const h = vfHead[v];
    slotPrev[s] = -1; slotNext[s] = h;
    if (h !== -1) slotPrev[h] = s;
    vfHead[v] = s;
  }
  function unlinkSlot(s) {
    const p = slotPrev[s], n = slotNext[s];
    if (p !== -1) slotNext[p] = n; else vfHead[corners[s]] = n;
    if (n !== -1) slotPrev[n] = p;
  }
  for (let s = 0; s < triCount * 3; s++) linkSlot(s);

  // Stamp arrays for O(1) membership tests without per-collapse Set churn.
  const vertStamp = new Uint32Array(nextVid);
  const triStamp  = new Uint32Array(triCount);
  let stampGen = 0;

  // Sharp-edge vertex freeze.  Walk every edge, find pairs of triangles that
  // share it, compute their face-normal dot.  If the dot is below sharpEdgeCos
  // the edge represents a sharp feature (cube corner, chamfer, hard crease)
  // and BOTH endpoints are marked frozen — never used as collapse endpoints.
  // This preserves 45°/90° corners exactly while leaving interior-of-face
  // slivers free to collapse.
  //
  // Sliver-aware: dihedrals between extreme slivers are unreliable — a sliver's
  // normal is dominated by the position of its far apex, so a 0.1 mm Z noise
  // on a 30 mm needle pivots the normal by tens of degrees with no real
  // feature behind it (puerta texturized.stl, May 2026).  When EITHER
  // adjacent tri is an extreme sliver, we skip the freeze for that edge —
  // the per-collapse normal-change gate (measured against original normals)
  // remains as the primary safeguard against feature damage.  Real CAD
  // features (cube edges, chamfers) are bordered by well-shaped tris on
  // each side and are unaffected.
  const frozenVert = new Uint8Array(nextVid);
  {
    const triThin2 = new Float32Array(triCount);
    for (let t = 0; t < triCount; t++) triThin2[t] = triAspectSq(t);
    // (vertex,vertex) pair → first triangle index, via the integer-keyed
    // point map (quant 1 — ids are already integers; z is unused).
    const edgeSeen = new QuantizedPointMap(1, Math.min(triCount * 3, 1 << 22));
    for (let t = 0; t < triCount; t++) {
      const a = corners[t*3], b = corners[t*3+1], c = corners[t*3+2];
      for (let e = 0; e < 3; e++) {
        const u = e === 0 ? a : e === 1 ? b : c;
        const v = e === 0 ? b : e === 1 ? c : a;
        const lo = u < v ? u : v, hi = u < v ? v : u;
        const other = edgeSeen.getOrSet(lo, hi, 0, t);
        if (edgeSeen.inserted) continue;
        if (triThin2[t] > extremeAspect2 || triThin2[other] > extremeAspect2) continue;
        const dot = triNrmX[t]*triNrmX[other] + triNrmY[t]*triNrmY[other] + triNrmZ[t]*triNrmZ[other];
        if (dot < sharpEdgeCos) { frozenVert[u] = 1; frozenVert[v] = 1; }
      }
    }
  }

  // helper: triangles that contain both u and v.
  // Returns a reused scratch array — valid until the next call.
  const _wingScratch = [];
  function trianglesSharingEdge(u, v) {
    _wingScratch.length = 0;
    for (let s = vfHead[u]; s !== -1; s = slotNext[s]) {
      const t = (s / 3) | 0;
      if (triDeleted[t]) continue;
      if (corners[t*3] === v || corners[t*3+1] === v || corners[t*3+2] === v) _wingScratch.push(t);
    }
    return _wingScratch;
  }

  // helper: third vertex of a triangle (the one that isn't u or v)
  function thirdVertex(t, u, v) {
    const a = corners[t*3], b = corners[t*3+1], c = corners[t*3+2];
    if (a !== u && a !== v) return a;
    if (b !== u && b !== v) return b;
    return c;
  }

  let totalCollapses = 0;
  // Per-rejection counters — surfaced in the return value so the caller (and
  // diagnostic harnesses) can see exactly which gate is blocking residual
  // sliver chains.  Useful when the user reports "this region didn't merge."
  const rejectStats = { frozen: 0, wingCount: 0, linkCondition: 0, edgeCap: 0, normalChange: 0, degenerate: 0, foldedApex: 0 };

  // Scratch buffers for the per-candidate edge ordering (no per-candidate
  // object allocation; stable 3-element insertion sort preserves the exact
  // tie order of the previous Array#sort-based code).
  const _el = new Float64Array(3);
  const _eu = new Int32Array(3);
  const _ev = new Int32Array(3);
  const _affectedScratch = [];

  for (let round = 0; round < maxRounds; round++) {
    // Build candidate list (alive slivers) sorted by quality (worst first).
    // We rebuild every round so collapses from earlier rounds inform priorities.
    const candT = [];
    const candA = [];
    for (let t = 0; t < triCount; t++) {
      if (triDeleted[t]) continue;
      const a = corners[t*3], b = corners[t*3+1], c = corners[t*3+2];
      const lAB2 = sqDist(a, b), lBC2 = sqDist(b, c), lCA2 = sqDist(c, a);
      const lmin2 = Math.min(lAB2, lBC2, lCA2);
      if (lmin2 <= 0) continue;
      // Use thinness (lmax / hmin) as the candidate metric — it catches
      // near-collinear "flat sliver" triangles that edge-ratio (lmax / lmin)
      // misses entirely.  See triAspectSq comment.
      const aspect2 = triAspectSq(t);
      if (aspect2 < aspectThreshold * aspectThreshold) continue;
      candT.push(t); candA.push(aspect2);
    }
    // Stable index sort (worst aspect first) — ties keep ascending-t order,
    // matching the previous object-array sort exactly.
    const order = candT.map((_, i) => i);
    order.sort((x, y) => candA[y] - candA[x]);

    let roundCollapses = 0;
    for (let ci = 0; ci < order.length; ci++) {
      const t = candT[order[ci]];
      if (triDeleted[t]) continue;
      const a = corners[t*3], b = corners[t*3+1], c = corners[t*3+2];
      // Try all three edges — shortest first.  A sliver at a sharp
      // cylinder/flat seam may have its shortest edge crossing the seam (huge
      // normal swing → fails the normal gate) while one of its long edges
      // runs along a single surface and collapses safely.  Picking the
      // shortest only would leave such slivers stuck.
      _el[0] = sqDist(a, b); _eu[0] = a; _ev[0] = b;
      _el[1] = sqDist(b, c); _eu[1] = b; _ev[1] = c;
      _el[2] = sqDist(c, a); _eu[2] = c; _ev[2] = a;
      let o0 = 0, o1 = 1, o2 = 2;
      if (_el[o1] < _el[o0]) { const sw = o0; o0 = o1; o1 = sw; }
      if (_el[o2] < _el[o1]) {
        const sw = o1; o1 = o2; o2 = sw;
        if (_el[o1] < _el[o0]) { const sw2 = o0; o0 = o1; o1 = sw2; }
      }
      if (tryCollapse(_eu[o0], _ev[o0]) || tryCollapse(_eu[o1], _ev[o1]) || tryCollapse(_eu[o2], _ev[o2])) {
        roundCollapses++;
      }
    }
    totalCollapses += roundCollapses;
    if (roundCollapses === 0) break;
  }

  // ── Compact: drop deleted tris, build output buffers ──
  const survivingTriCount = triCount - countDeleted();
  const outPositions = new Float32Array(survivingTriCount * 9);
  const outParents   = new Int32Array(survivingTriCount);
  let oi = 0;
  for (let t = 0; t < triCount; t++) {
    if (triDeleted[t]) continue;
    const a = corners[t*3], b = corners[t*3+1], c = corners[t*3+2];
    outPositions[oi*9]   = vertX[a]; outPositions[oi*9+1] = vertY[a]; outPositions[oi*9+2] = vertZ[a];
    outPositions[oi*9+3] = vertX[b]; outPositions[oi*9+4] = vertY[b]; outPositions[oi*9+5] = vertZ[b];
    outPositions[oi*9+6] = vertX[c]; outPositions[oi*9+7] = vertY[c]; outPositions[oi*9+8] = vertZ[c];
    outParents[oi] = newParentId[t];
    oi++;
  }

  const outGeo = new THREE.BufferGeometry();
  outGeo.setAttribute('position', new THREE.BufferAttribute(outPositions, 3));
  outGeo.computeVertexNormals();

  // Carry through excludeWeight if input had it (precision masking pipeline)
  const inExcl = geometry.attributes.excludeWeight;
  if (inExcl) {
    const outExcl = new Float32Array(survivingTriCount * 3);
    let oj = 0;
    for (let t = 0; t < triCount; t++) {
      if (triDeleted[t]) continue;
      // Per-face exclusion was constant across the 3 vertices in toNonIndexed.
      // Take the first vertex's value as the face value.
      outExcl[oj*3] = outExcl[oj*3+1] = outExcl[oj*3+2] = inExcl.getX(t * 3);
      oj++;
    }
    outGeo.setAttribute('excludeWeight', new THREE.BufferAttribute(outExcl, 1));
  }

  return { geometry: outGeo, faceParentId: outParents, collapseCount: totalCollapses, rejectStats };

  // ── Helpers (closure over local state) ──

  function sqDist(va, vb) {
    const dx = vertX[va] - vertX[vb];
    const dy = vertY[va] - vertY[vb];
    const dz = vertZ[va] - vertZ[vb];
    return dx*dx + dy*dy + dz*dz;
  }

  // Squared "thinness" — longest edge divided by shortest altitude.
  //
  //   thinness   = lmax / hmin
  //              = lmax / (2·area / lmax)
  //              = lmax² / (2·area)
  //   thinness²  = lmax⁴ / (4·area²)
  //              = lmax⁴ / |AB × AC|²
  //
  // Why this metric and not just lmax/lmin?  An almost-collinear triangle
  // (three points sitting on a near-line) can have ALL edge lengths similar
  // — e.g. 1.7, 0.93, 0.79 mm — so the edge-ratio metric reports aspect ≈ 2
  // and our gate skips it.  But the triangle is geometrically a sliver: tiny
  // area, near-zero altitude, three vertices that displacement-sample three
  // unrelated texels.  thinness catches it (≈ 1800 in that case) while still
  // reporting ≈ 1.15 for an equilateral triangle, so the threshold scale is
  // similar to the old edge-ratio metric.
  function triAspectSq(t) {
    const a = corners[t*3], b = corners[t*3+1], c = corners[t*3+2];
    const ax = vertX[a], ay = vertY[a], az = vertZ[a];
    const abx = vertX[b]-ax, aby = vertY[b]-ay, abz = vertZ[b]-az;
    const acx = vertX[c]-ax, acy = vertY[c]-ay, acz = vertZ[c]-az;
    const bcx = vertX[c]-vertX[b], bcy = vertY[c]-vertY[b], bcz = vertZ[c]-vertZ[b];
    const lAB2 = abx*abx + aby*aby + abz*abz;
    const lAC2 = acx*acx + acy*acy + acz*acz;
    const lBC2 = bcx*bcx + bcy*bcy + bcz*bcz;
    const lmax2 = Math.max(lAB2, lAC2, lBC2);
    const nx = aby*acz - abz*acy;
    const ny = abz*acx - abx*acz;
    const nz = abx*acy - aby*acx;
    const cross2 = nx*nx + ny*ny + nz*nz;
    return cross2 > 0 ? lmax2 * lmax2 / cross2 : Infinity;
  }

  function countDeleted() {
    let n = 0;
    for (let i = 0; i < triCount; i++) if (triDeleted[i]) n++;
    return n;
  }

  // Attempt collapse of edge (u, v).  Returns true if applied.
  function tryCollapse(u, v) {
    if (u === v) return false;

    // Sharp-edge vertices stay put — refuse the collapse outright.
    if (frozenVert[u] || frozenVert[v]) { rejectStats.frozen++; return false; }

    // Wing triangles — must be exactly 2 (manifold interior edge).
    const wings = trianglesSharingEdge(u, v);
    if (wings.length !== 2) { rejectStats.wingCount++; return false; }

    const apexW1 = thirdVertex(wings[0], u, v);
    const apexW2 = thirdVertex(wings[1], u, v);
    if (apexW1 === apexW2) { rejectStats.foldedApex++; return false; }

    // Two-tier gate selection.  Edge-cap loosens if EITHER wing is extreme
    // (cheap to relax — easy to recover from with re-subdivide).  Normal-cap
    // loosens only if BOTH wings are extreme (asymmetric: protects fillets).
    const w1Asp2 = triAspectSq(wings[0]);
    const w2Asp2 = triAspectSq(wings[1]);
    const eitherExtreme = w1Asp2 > extremeAspect2 || w2Asp2 > extremeAspect2;
    const bothExtreme   = w1Asp2 > extremeAspect2 && w2Asp2 > extremeAspect2;
    const effMaxLenSq  = eitherExtreme ? aggressiveMaxLenSqAllowed : baseMaxLenSqAllowed;
    const effNormalCos = bothExtreme   ? aggressiveNormalDeltaCos  : maxNormalDeltaCos;


    // Link condition — vertices that share a triangle with BOTH u and v
    // (other than the wing apexes) would become non-manifold after the merge.
    // Stamp v's neighbours, then scan u's neighbours against the stamps.
    stampGen++;
    for (let s = vfHead[v]; s !== -1; s = slotNext[s]) {
      const t = (s / 3) | 0;
      if (triDeleted[t]) continue;
      const a = corners[t*3], b = corners[t*3+1], c = corners[t*3+2];
      if (a !== v) vertStamp[a] = stampGen;
      if (b !== v) vertStamp[b] = stampGen;
      if (c !== v) vertStamp[c] = stampGen;
    }
    for (let s = vfHead[u]; s !== -1; s = slotNext[s]) {
      const t = (s / 3) | 0;
      if (triDeleted[t]) continue;
      const a = corners[t*3], b = corners[t*3+1], c = corners[t*3+2];
      if (a !== u && a !== v && a !== apexW1 && a !== apexW2 && vertStamp[a] === stampGen) { rejectStats.linkCondition++; return false; }
      if (b !== u && b !== v && b !== apexW1 && b !== apexW2 && vertStamp[b] === stampGen) { rejectStats.linkCondition++; return false; }
      if (c !== u && c !== v && c !== apexW1 && c !== apexW2 && vertStamp[c] === stampGen) { rejectStats.linkCondition++; return false; }
    }

    // Merged position: midpoint
    const mx = (vertX[u] + vertX[v]) / 2;
    const my = (vertY[u] + vertY[v]) / 2;
    const mz = (vertZ[u] + vertZ[v]) / 2;

    // Affected triangles: all using u or v, excluding wings
    const w0 = wings[0], w1 = wings[1];
    stampGen++;
    const affected = _affectedScratch;
    affected.length = 0;
    for (let s = vfHead[u]; s !== -1; s = slotNext[s]) {
      const t = (s / 3) | 0;
      if (triDeleted[t] || t === w0 || t === w1) continue;
      if (triStamp[t] !== stampGen) { triStamp[t] = stampGen; affected.push(t); }
    }
    for (let s = vfHead[v]; s !== -1; s = slotNext[s]) {
      const t = (s / 3) | 0;
      if (triDeleted[t] || t === w0 || t === w1) continue;
      if (triStamp[t] !== stampGen) { triStamp[t] = stampGen; affected.push(t); }
    }

    // Validate every affected triangle's post-collapse state
    for (const t of affected) {
      let a = corners[t*3], b = corners[t*3+1], c = corners[t*3+2];
      if (a === u || a === v) a = -1;
      if (b === u || b === v) b = -1;
      if (c === u || c === v) c = -1;
      const ax = a === -1 ? mx : vertX[a];
      const ay = a === -1 ? my : vertY[a];
      const az = a === -1 ? mz : vertZ[a];
      const bx = b === -1 ? mx : vertX[b];
      const by = b === -1 ? my : vertY[b];
      const bz = b === -1 ? mz : vertZ[b];
      const cx = c === -1 ? mx : vertX[c];
      const cy = c === -1 ? my : vertY[c];
      const cz = c === -1 ? mz : vertZ[c];

      const ab2 = (bx-ax)*(bx-ax) + (by-ay)*(by-ay) + (bz-az)*(bz-az);
      const bc2 = (cx-bx)*(cx-bx) + (cy-by)*(cy-by) + (cz-bz)*(cz-bz);
      const ca2 = (ax-cx)*(ax-cx) + (ay-cy)*(ay-cy) + (az-cz)*(az-cz);
      if (ab2 > effMaxLenSq || bc2 > effMaxLenSq || ca2 > effMaxLenSq) {
        rejectStats.edgeCap++; return false;
      }

      const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
      const nx = e1y*e2z - e1z*e2y;
      const ny = e1z*e2x - e1x*e2z;
      const nz = e1x*e2y - e1y*e2x;
      const nLen = Math.sqrt(nx*nx + ny*ny + nz*nz);
      if (nLen <= 0) { rejectStats.degenerate++; return false; }
      const inv = 1 / nLen;
      const nux = nx * inv, nuy = ny * inv, nuz = nz * inv;
      // Gate against the ORIGINAL normal so cumulative drift across rounds
      // can't compound into corner damage.
      const dot = nux * origNrmX[t] + nuy * origNrmY[t] + nuz * origNrmZ[t];
      if (dot < effNormalCos) { rejectStats.normalChange++; return false; }
    }

    // ── All good — apply the collapse ──
    // Move u to merged position; redirect all v references to u.
    vertX[u] = mx; vertY[u] = my; vertZ[u] = mz;

    // Delete wings — unlink all three corner slots of each
    triDeleted[w0] = 1;
    unlinkSlot(w0*3); unlinkSlot(w0*3+1); unlinkSlot(w0*3+2);
    triDeleted[w1] = 1;
    unlinkSlot(w1*3); unlinkSlot(w1*3+1); unlinkSlot(w1*3+2);

    // Substitute v→u in all remaining triangles using v: move each of v's
    // corner slots into u's list (a non-wing triangle contains v exactly once).
    let s = vfHead[v];
    while (s !== -1) {
      const ns = slotNext[s];
      unlinkSlot(s);          // owner is still v here
      corners[s] = u;
      linkSlot(s);            // now owned by u
      recomputeFaceNormal((s / 3) | 0);
      s = ns;
    }
    // Recompute normals of all other affected triangles using u (positions changed)
    for (let s2 = vfHead[u]; s2 !== -1; s2 = slotNext[s2]) {
      const t = (s2 / 3) | 0;
      if (triDeleted[t]) continue;
      recomputeFaceNormal(t);
    }
    return true;
  }
}
