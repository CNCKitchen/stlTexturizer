/**
 * QEM (Quadric Error Metric) mesh decimation.
 *
 * Algorithm: Garland & Heckbert 1997, with the three safety guards from
 * PrusaSlicer's QuadricEdgeCollapse.cpp that eliminate holes, spikes and
 * non-manifold edges:
 *
 *   Guard 1 – Boundary edge protection
 *     Never collapse an edge shared by < 2 active faces.
 *     The primary cause of holes in open STL meshes.
 *
 *   Guard 2 – Link-condition (non-manifold / pinch prevention)
 *     Common neighbours of v1/v2 must equal exactly the apex vertices of
 *     their shared triangles.  Extra common neighbours mean collapsing would
 *     fuse disconnected surface regions → non-manifold edge.
 *
 *   Guard 3 – Normal-flip rejection
 *     Recompute every affected face normal after the hypothetical collapse.
 *     dot(original, new) < 0.2 (~78°) → reject.  Eliminates spikes / pits.
 *
 * Crease preservation (Garland & Heckbert §3.2):
 *   Edges where adjacent face normals diverge by more than CREASE_COS receive
 *   high-weight penalty planes added to both endpoint quadrics.  This raises
 *   the QEM cost of any collapse that would move a vertex off a sharp feature,
 *   ensuring smooth regions are decimated first while creases are kept intact.
 *
 * Performance notes:
 *   - Struct-of-arrays typed-array heap avoids per-entry object allocation.
 *   - Numeric edge keys (v_lo * MAX_V + v_hi) replace template strings.
 *   - Vertex deduplication uses a numeric spatial-grid Map instead of strings.
 *   - Link-violation check packs sorted face triple into two Numbers to avoid
 *     string allocation.
 *   - Progress callback fires at most every 512 collapses.
 *
 * @param {THREE.BufferGeometry} geometry        non-indexed input
 * @param {number}               targetTriangles desired output face count
 * @param {function}             [onProgress]    callback(0–1)
 * @returns {THREE.BufferGeometry}
 */

import * as THREE from 'three';

const QUANT         = 1e4;
const FLIP_DOT      = 0.2;  // cos ~78° — reject collapse if new normal deviates more
const FLIP_DOT_SQ   = FLIP_DOT * FLIP_DOT;
const CREASE_COS    = 0.5;  // cos 60° — edges sharper than this are treated as creases
const CREASE_WEIGHT = 1e4;  // quadric penalty weight for crease edges

// Module-level scratch arrays for hasLinkViolation — avoids new Map() per call.
// Size 128 exceeds the maximum practical vertex valence in any STL mesh.
const _hlvHi = new Float64Array(512);
const _hlvLo = new Int32Array(512);

// ── Public API ───────────────────────────────────────────────────────────────

export async function decimate(geometry, targetTriangles, onProgress) {
  const { positions, faces, vertCount, faceCount } = buildIndexed(geometry);

  if (faceCount <= targetTriangles) return buildOutput(positions, faces, faceCount);

  // Per-vertex error quadrics (10 doubles = upper triangle of symmetric 4×4)
  const quadrics = new Float64Array(vertCount * 10);
  initQuadrics(quadrics, positions, faces, faceCount);
  addCreaseQuadrics(quadrics, positions, faces, faceCount);

  // Doubly-linked vertex-face incidence (typed arrays — faster than Set<number>)
  const { vfHead, slotFace, slotVert, slotNext, slotPrev, faceSlot } =
    buildLinkedAdj(faces, faceCount, vertCount);

  const active  = new Uint8Array(vertCount).fill(1);
  // Per-vertex version counter: incremented whenever a vertex's quadric or
  // position changes.  Heap entries carry the versions at push time; any
  // entry whose versions no longer match is stale and is skipped.
  const version = new Uint32Array(vertCount);
  // Epoch stamp for neighbour deduplication — O(1) "clear" via epoch++
  const nbStamp = new Uint32Array(vertCount);
  let   epoch   = 1;
  let   activeFaces = faceCount;

  // Seed min-heap with one entry per unique edge.
  // Use BigInt keys to handle any vertex count without integer overflow.
  const heap     = new SoAHeap(Math.min(faceCount * 3, 1 << 24));
  const seedSeen = new Set();
  const _vc = BigInt(vertCount);
  for (let f = 0; f < faceCount; f++) {
    if (faces[f * 3] < 0) continue;
    for (let e = 0; e < 3; e++) {
      const va = faces[f * 3 + e];
      const vb = faces[f * 3 + ((e + 1) % 3)];
      const lo = va < vb ? va : vb, hi = va < vb ? vb : va;
      const ek = BigInt(lo) * _vc + BigInt(hi);
      if (!seedSeen.has(ek)) { seedSeen.add(ek); pushEdge(heap, quadrics, positions, version, va, vb); }
    }
  }
  seedSeen.clear();

  const initFaces  = activeFaces;
  const toRemove   = initFaces - targetTriangles;
  let   lastProg   = 0;
  let   iterations = 0;

  while (activeFaces > targetTriangles && heap.size() > 0) {
    const idx = heap.pop();
    if (idx < 0) break;

    // Yield periodically based on total iterations (including rejections)
    // to keep the UI responsive.  Critical for flat / low-displacement
    // surfaces where most collapses are rejected by the safety guards.
    if ((++iterations & 4095) === 0) {
      await new Promise(r => setTimeout(r, 0));
      if (onProgress) {
        const p = Math.min(1, (initFaces - activeFaces) / toRemove);
        if (p - lastProg > 0.005) { onProgress(p); lastProg = p; }
      }
    }

    const v1 = heap.getV1(idx), v2 = heap.getV2(idx);
    const ver1 = heap.getVer1(idx), ver2 = heap.getVer2(idx);
    const px = heap.getPx(idx), py = heap.getPy(idx), pz = heap.getPz(idx);

    // Stale-entry checks (lazy deletion)
    if (!active[v1] || !active[v2]) continue;
    if (version[v1] !== ver1 || version[v2] !== ver2) continue;

    // Single pass combines the old shareActiveFace + isBoundaryEdge:
    // 0 → stale entry, 1 → boundary edge (Guard 1), ≥2 → safe to continue
    const nsh = sharedFaceCount(faces, vfHead, slotFace, slotNext, v1, v2);
    if (nsh < 2) continue;

    // ── Three safety guards ───────────────────────────────────────────────────
    if (hasLinkViolation(faces, vfHead, slotFace, slotNext, v1, v2)) continue;          // Guard 2
    if (checkFlipped(positions, vfHead, slotFace, slotNext, faces, v1, v2, px, py, pz)) continue; // Guard 3a
    if (checkFlipped(positions, vfHead, slotFace, slotNext, faces, v2, v1, px, py, pz)) continue; // Guard 3b

    // ── Collapse: keep v1 at new position, remove v2 ─────────────────────────
    positions[v1 * 3]     = px;
    positions[v1 * 3 + 1] = py;
    positions[v1 * 3 + 2] = pz;
    mergeQuadric(quadrics, v1, v2);
    version[v1]++;  // v1's quadric and position changed — invalidate old heap entries

    // Walk v2's face list; read sNext BEFORE modifying the list.
    let s = vfHead[v2];
    while (s >= 0) {
      const f     = slotFace[s];
      const sNext = slotNext[s]; // must be read before any list modification
      if (faces[f * 3] >= 0) {
        // Remap v2 → v1 in this face
        const cv2 = faces[f*3] === v2 ? 0 : faces[f*3+1] === v2 ? 1 : 2;
        faces[f * 3 + cv2] = v1;
        const fa = faces[f*3], fb = faces[f*3+1], fc = faces[f*3+2];
        if (fa === fb || fb === fc || fa === fc) {
          // Degenerate: unlink all 3 slots from their current vertex lists
          for (let k = 0; k < 3; k++) {
            const sk = faceSlot[f*3+k];
            if (sk >= 0) { _unlinkSlot(sk, vfHead, slotNext, slotPrev, slotVert); faceSlot[f*3+k] = -1; }
          }
          faces[f*3] = faces[f*3+1] = faces[f*3+2] = -1;
          activeFaces--;
        } else {
          // Surviving: move the v2-slot (s) into v1's list; other 2 slots stay put
          _moveSlot(s, v1, vfHead, slotNext, slotPrev, slotVert);
        }
      }
      s = sNext;
    }
    // After the loop vfHead[v2] === -1 (all slots moved or freed)
    active[v2] = 0;

    // Re-push edges for v1's updated neighbourhood (stamp dedup — no new Set)
    epoch++;
    for (let sv = vfHead[v1]; sv >= 0; sv = slotNext[sv]) {
      const f = slotFace[sv];
      if (faces[f*3] < 0) continue;
      for (let k = 0; k < 3; k++) {
        const nb = faces[f*3+k];
        if (nb !== v1 && nbStamp[nb] !== epoch) {
          nbStamp[nb] = epoch;
          if (active[nb]) pushEdge(heap, quadrics, positions, version, v1, nb);
        }
      }
    }


  }

  if (onProgress) onProgress(1);
  return buildOutput(positions, faces, faceCount);
}

// ── Linked-list vertex-face incidence ────────────────────────────────────────
// Replaces the old Array<Set<number>> adjacency.  For each face f and vertex
// position k, slot s = f*3+k tracks face f in vertex v = faces[f*3+k]'s list.
//
//   vfHead[v]       → first slot for vertex v  (-1 = empty)
//   slotFace[s]     → face tracked by slot s
//   slotVert[s]     → vertex that currently owns slot s
//   slotNext[s]     → next slot in vertex's list  (-1 = end)
//   slotPrev[s]     → prev slot in vertex's list  (-1 = head)
//   faceSlot[f*3+k] → slot for face f's k-th vertex incidence

function buildLinkedAdj(faces, faceCount, vertCount) {
  const S        = faceCount * 3;
  const vfHead   = new Int32Array(vertCount).fill(-1);
  const slotFace = new Int32Array(S);
  const slotVert = new Int32Array(S);
  const slotNext = new Int32Array(S).fill(-1);
  const slotPrev = new Int32Array(S).fill(-1);
  const faceSlot = new Int32Array(S).fill(-1);
  for (let f = 0; f < faceCount; f++) {
    if (faces[f * 3] < 0) continue;
    for (let k = 0; k < 3; k++) {
      const v = faces[f * 3 + k];
      const s = f * 3 + k;
      slotFace[s] = f;
      slotVert[s] = v;
      const h = vfHead[v];
      slotNext[s] = h;
      slotPrev[s] = -1;
      if (h >= 0) slotPrev[h] = s;
      vfHead[v] = s;
      faceSlot[f * 3 + k] = s;
    }
  }
  return { vfHead, slotFace, slotVert, slotNext, slotPrev, faceSlot };
}

// Remove slot s from its current vertex's list (slotVert[s] identifies the vertex).
function _unlinkSlot(s, vfHead, slotNext, slotPrev, slotVert) {
  const v = slotVert[s], p = slotPrev[s], n = slotNext[s];
  if (p < 0) vfHead[v] = n; else slotNext[p] = n;
  if (n >= 0) slotPrev[n] = p;
}

// Move slot s from its current vertex's list to vertex nv's list.
function _moveSlot(s, nv, vfHead, slotNext, slotPrev, slotVert) {
  _unlinkSlot(s, vfHead, slotNext, slotPrev, slotVert);
  const h = vfHead[nv];
  slotNext[s] = h;
  slotPrev[s] = -1;
  if (h >= 0) slotPrev[h] = s;
  vfHead[nv] = s;
  slotVert[s] = nv;
}

// ── Guard 0+1: combined shareActiveFace + isBoundaryEdge ─────────────────────
// Returns 0 = stale entry, 1 = boundary edge, ≥2 = safe to proceed.

function sharedFaceCount(faces, vfHead, slotFace, slotNext, v1, v2) {
  let count = 0;
  for (let s = vfHead[v1]; s >= 0; s = slotNext[s]) {
    const f = slotFace[s];
    if (faces[f * 3] < 0) continue;
    const fa = faces[f*3], fb = faces[f*3+1], fc = faces[f*3+2];
    if (fa === v2 || fb === v2 || fc === v2) { if (++count >= 2) return 2; }
  }
  return count;
}

// ── Guard 2: Duplicate-face / pinch prevention ───────────────────────────────
// Uses module-level scratch arrays (_hlvHi, _hlvLo) instead of new Map()
// to avoid per-call heap allocation.

function hasLinkViolation(faces, vfHead, slotFace, slotNext, v1, v2) {
  let n = 0;
  for (let s = vfHead[v1]; s >= 0; s = slotNext[s]) {
    const f = slotFace[s];
    if (faces[f * 3] < 0) continue;
    let fa = faces[f*3], fb = faces[f*3+1], fc = faces[f*3+2];
    if (fa === v2 || fb === v2 || fc === v2) continue;
    let t;
    if (fa > fb) { t = fa; fa = fb; fb = t; }
    if (fb > fc) { t = fb; fb = fc; fc = t; }
    if (fa > fb) { t = fa; fa = fb; fb = t; }
    _hlvHi[n] = fa * 0x200000 + fb;
    _hlvLo[n] = fc;
    n++;
  }
  for (let s = vfHead[v2]; s >= 0; s = slotNext[s]) {
    const f = slotFace[s];
    if (faces[f * 3] < 0) continue;
    let fa = faces[f*3], fb = faces[f*3+1], fc = faces[f*3+2];
    if (fa === v1 || fb === v1 || fc === v1) continue;
    if (fa === v2) fa = v1; else if (fb === v2) fb = v1; else fc = v1;
    let t;
    if (fa > fb) { t = fa; fa = fb; fb = t; }
    if (fb > fc) { t = fb; fb = fc; fc = t; }
    if (fa > fb) { t = fa; fa = fb; fb = t; }
    const hi = fa * 0x200000 + fb;
    for (let i = 0; i < n; i++) {
      if (_hlvHi[i] === hi && _hlvLo[i] === fc) return true;
    }
  }
  return false;
}

// ── Guard 3: Normal-flip rejection ──────────────────────────────────────────
// Fully inlined — no array allocations, no sqrt calls.
// Squared-dot comparison replaces the normalized dot product:
//   dot(on_norm, nn_norm) < FLIP_DOT
//   ⟺  rawDot < 0  OR  rawDot² < FLIP_DOT² · |on|² · |nn|²

function checkFlipped(positions, vfHead, slotFace, slotNext, faces, vc, vo, npx, npy, npz) {
  for (let s = vfHead[vc]; s >= 0; s = slotNext[s]) {
    const f = slotFace[s];
    if (faces[f * 3] < 0) continue;
    const fa = faces[f*3], fb = faces[f*3+1], fc = faces[f*3+2];
    if (fa === vo || fb === vo || fc === vo) continue;
    const oax = positions[fa*3], oay = positions[fa*3+1], oaz = positions[fa*3+2];
    const obx = positions[fb*3], oby = positions[fb*3+1], obz = positions[fb*3+2];
    const ocx = positions[fc*3], ocy = positions[fc*3+1], ocz = positions[fc*3+2];
    // Unnormalized original normal
    const oux = obx-oax, ouy = oby-oay, ouz = obz-oaz;
    const ovx = ocx-oax, ovy = ocy-oay, ovz = ocz-oaz;
    const onx = ouy*ovz - ouz*ovy;
    const ony = ouz*ovx - oux*ovz;
    const onz = oux*ovy - ouy*ovx;
    // New positions (vc replaced by np)
    const nax = fa===vc ? npx : oax, nay = fa===vc ? npy : oay, naz = fa===vc ? npz : oaz;
    const nbx = fb===vc ? npx : obx, nby = fb===vc ? npy : oby, nbz = fb===vc ? npz : obz;
    const ncx = fc===vc ? npx : ocx, ncy = fc===vc ? npy : ocy, ncz = fc===vc ? npz : ocz;
    // Unnormalized new normal
    const nux = nbx-nax, nuy = nby-nay, nuz = nbz-naz;
    const nvx = ncx-nax, nvy = ncy-nay, nvz = ncz-naz;
    const nnx = nuy*nvz - nuz*nvy;
    const nny = nuz*nvx - nux*nvz;
    const nnz = nux*nvy - nuy*nvx;
    // Squared-dot flip test (avoids sqrt + division)
    const rawDot = onx*nnx + ony*nny + onz*nnz;
    if (rawDot < 0) return true;
    if (rawDot * rawDot < FLIP_DOT_SQ * (onx*onx+ony*ony+onz*onz) * (nnx*nnx+nny*nny+nnz*nnz)) return true;
  }
  return false;
}

function faceNormal(ax, ay, az, bx, by, bz, cx, cy, cz) {
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  return [nx / len, ny / len, nz / len];
}

// ── Quadric helpers ──────────────────────────────────────────────────────────
// Symmetric 4×4 quadric stored as 10 upper-triangle values per vertex.

// ── Crease-edge quadric preservation (Garland & Heckbert §3.2) ─────────────
// For each interior edge whose two adjacent faces form a dihedral angle sharper
// than CREASE_COS, inject two penalty planes into both endpoint vertices.
// Each penalty plane is perpendicular to one adjacent face and passes through
// the crease edge, constraining the vertex to stay on the crease line.
// The high CREASE_WEIGHT ensures these edges have far higher QEM cost than
// smooth-surface edges and are therefore collapsed last (or not at all).

function addCreaseQuadrics(quadrics, positions, faces, faceCount) {
  // Build edge → [face, face] map using numeric keys (va_lo * vertMax + vb_hi)
  // vertMax = next power of two >= faceCount*3 vertices upper bound; use faceCount*3
  // as a safe upper bound since #verts ≤ #triangles*3.
  // We already have the actual vertCount from the caller but it's not passed here;
  // use a Map with numeric key = min*N + max where N = faceCount*3 (safe upper bound).
  const N = faceCount * 3;
  const edgeToFaces = new Map();
  for (let f = 0; f < faceCount; f++) {
    if (faces[f * 3] < 0) continue;
    for (let e = 0; e < 3; e++) {
      const va = faces[f * 3 + e];
      const vb = faces[f * 3 + ((e + 1) % 3)];
      const key = va < vb ? va * N + vb : vb * N + va;
      let arr = edgeToFaces.get(key);
      if (!arr) { arr = []; edgeToFaces.set(key, arr); }
      arr.push(f);
    }
  }

  const sqrtW = Math.sqrt(CREASE_WEIGHT);

  for (const [key, flist] of edgeToFaces) {
    if (flist.length !== 2) continue; // open boundary or non-manifold — skip

    const f0 = flist[0], f1 = flist[1];
    const v0a = faces[f0*3], v0b = faces[f0*3+1], v0c = faces[f0*3+2];
    const v1a = faces[f1*3], v1b = faces[f1*3+1], v1c = faces[f1*3+2];

    const [n0x, n0y, n0z] = faceNormal(
      positions[v0a*3], positions[v0a*3+1], positions[v0a*3+2],
      positions[v0b*3], positions[v0b*3+1], positions[v0b*3+2],
      positions[v0c*3], positions[v0c*3+1], positions[v0c*3+2]
    );
    const [n1x, n1y, n1z] = faceNormal(
      positions[v1a*3], positions[v1a*3+1], positions[v1a*3+2],
      positions[v1b*3], positions[v1b*3+1], positions[v1b*3+2],
      positions[v1c*3], positions[v1c*3+1], positions[v1c*3+2]
    );

    if (n0x*n1x + n0y*n1y + n0z*n1z >= CREASE_COS) continue; // smooth — skip

    // Resolve the two vertex indices from the numeric key
    const va = Math.floor(key / N);
    const vb = key - va * N;

    // Normalised edge direction
    const ex = positions[vb*3]   - positions[va*3];
    const ey = positions[vb*3+1] - positions[va*3+1];
    const ez = positions[vb*3+2] - positions[va*3+2];
    const elen = Math.sqrt(ex*ex + ey*ey + ez*ez) || 1;
    const edx = ex / elen, edy = ey / elen, edz = ez / elen;

    // Add one penalty plane per adjacent face-normal
    for (const [nx, ny, nz] of [[n0x, n0y, n0z], [n1x, n1y, n1z]]) {
      // Penalty plane normal = normalize(face_normal × edge_dir)
      // This plane contains the edge and is perpendicular to the face,
      // so it constrains the vertex to lie on the crease line.
      let px = ny*edz - nz*edy;
      let py = nz*edx - nx*edz;
      let pz = nx*edy - ny*edx;
      const plen = Math.sqrt(px*px + py*py + pz*pz);
      if (plen < 1e-10) continue; // edge parallel to face normal — degenerate
      px /= plen; py /= plen; pz /= plen;
      const d = -(px*positions[va*3] + py*positions[va*3+1] + pz*positions[va*3+2]);
      // Scale by sqrtW: addPlaneQ accumulates (a²,ab,…) so scaling inputs by √w yields w×(a²,ab,…)
      addPlaneQ(quadrics, va, px*sqrtW, py*sqrtW, pz*sqrtW, d*sqrtW);
      addPlaneQ(quadrics, vb, px*sqrtW, py*sqrtW, pz*sqrtW, d*sqrtW);
    }
  }
}

function initQuadrics(quadrics, positions, faces, faceCount) {
  for (let f = 0; f < faceCount; f++) {
    if (faces[f * 3] < 0) continue;
    const fa = faces[f * 3], fb = faces[f * 3 + 1], fc = faces[f * 3 + 2];
    const [nx, ny, nz] = faceNormal(
      positions[fa*3], positions[fa*3+1], positions[fa*3+2],
      positions[fb*3], positions[fb*3+1], positions[fb*3+2],
      positions[fc*3], positions[fc*3+1], positions[fc*3+2]
    );
    const d = -(nx * positions[fa*3] + ny * positions[fa*3+1] + nz * positions[fa*3+2]);
    addPlaneQ(quadrics, fa, nx, ny, nz, d);
    addPlaneQ(quadrics, fb, nx, ny, nz, d);
    addPlaneQ(quadrics, fc, nx, ny, nz, d);
  }
}

function addPlaneQ(q, v, a, b, c, d) {
  const o = v * 10;
  q[o]   += a*a; q[o+1] += a*b; q[o+2] += a*c; q[o+3] += a*d;
                 q[o+4] += b*b; q[o+5] += b*c; q[o+6] += b*d;
                                q[o+7] += c*c; q[o+8] += c*d;
                                               q[o+9] += d*d;
}

function mergeQuadric(q, v1, v2) {
  const o1 = v1 * 10, o2 = v2 * 10;
  for (let i = 0; i < 10; i++) q[o1 + i] += q[o2 + i];
}

function evalQ(q, v, x, y, z) {
  const o = v * 10;
  return q[o]   * x*x + 2*q[o+1]*x*y + 2*q[o+2]*x*z + 2*q[o+3]*x
       + q[o+4] * y*y + 2*q[o+5]*y*z + 2*q[o+6]*y
       + q[o+7] * z*z + 2*q[o+8]*z
       + q[o+9];
}

function evalQSum(q, v1, v2, x, y, z) {
  return evalQ(q, v1, x, y, z) + evalQ(q, v2, x, y, z);
}

const _s = new Float64Array(3);

function solveQ(q, v1, v2) {
  const o1 = v1 * 10, o2 = v2 * 10;
  const a00 = q[o1]   + q[o2];
  const a01 = q[o1+1] + q[o2+1];
  const a02 = q[o1+2] + q[o2+2];
  const a11 = q[o1+4] + q[o2+4];
  const a12 = q[o1+5] + q[o2+5];
  const a22 = q[o1+7] + q[o2+7];
  const b0  = -(q[o1+3] + q[o2+3]);
  const b1  = -(q[o1+6] + q[o2+6]);
  const b2  = -(q[o1+8] + q[o2+8]);

  const det = a00*(a11*a22 - a12*a12) - a01*(a01*a22 - a12*a02) + a02*(a01*a12 - a11*a02);
  if (Math.abs(det) < 1e-10) return false;

  const inv = 1 / det;
  _s[0] = inv * (b0*(a11*a22 - a12*a12) - a01*(b1*a22 - a12*b2) + a02*(b1*a12 - a11*b2));
  _s[1] = inv * (a00*(b1*a22 - a12*b2) - b0*(a01*a22 - a12*a02) + a02*(a01*b2 - b1*a02));
  _s[2] = inv * (a00*(a11*b2 - b1*a12) - a01*(a01*b2 - b1*a02) + b0*(a01*a12 - a11*a02));
  return true;
}

function pushEdge(heap, quadrics, positions, version, v1, v2) {
  let px, py, pz;

  if (solveQ(quadrics, v1, v2)) {
    px = _s[0]; py = _s[1]; pz = _s[2];
  } else {
    const mx = (positions[v1*3]   + positions[v2*3])   / 2;
    const my = (positions[v1*3+1] + positions[v2*3+1]) / 2;
    const mz = (positions[v1*3+2] + positions[v2*3+2]) / 2;
    const e1 = evalQSum(quadrics, v1, v2, positions[v1*3],   positions[v1*3+1], positions[v1*3+2]);
    const e2 = evalQSum(quadrics, v1, v2, positions[v2*3],   positions[v2*3+1], positions[v2*3+2]);
    const em = evalQSum(quadrics, v1, v2, mx, my, mz);
    // Prefer midpoint when costs are near-equal (degenerate / flat surfaces).
    // Midpoint minimises displacement of adjacent triangles, reducing normal
    // flips and preventing the collapse loop from stalling on coplanar geometry.
    const eMin = Math.min(e1, e2, em);
    const eTol = eMin * 1e-2 + 1e-12;
    if      (em <= eMin + eTol) { px = mx; py = my; pz = mz; }
    else if (e1 <= e2)          { px = positions[v1*3]; py = positions[v1*3+1]; pz = positions[v1*3+2]; }
    else                        { px = positions[v2*3]; py = positions[v2*3+1]; pz = positions[v2*3+2]; }
  }

  const cost = evalQSum(quadrics, v1, v2, px, py, pz);
  // Tiny edge-length tiebreaker: on degenerate (flat) surfaces where QEM
  // costs are ~0, prefer collapsing shorter edges first for better triangle
  // quality and fewer guard rejections.
  const dx = positions[v2*3] - positions[v1*3];
  const dy = positions[v2*3+1] - positions[v1*3+1];
  const dz = positions[v2*3+2] - positions[v1*3+2];
  heap.push(cost + (dx*dx + dy*dy + dz*dz) * 1e-8,
            v1, v2, version[v1], version[v2], px, py, pz);
}

// ── Indexed <-> Non-indexed conversion ──────────────────────────────────────

// Numeric spatial-hash vertex deduplication.
// Avoids template-string allocation by encoding quantised (ix,iy,iz) as a
// BigInt key: this is still fast because we only call BigInt() once per vertex.
function buildIndexed(geometry) {
  const posAttr = geometry.attributes.position;
  const n = posAttr.count;

  const positions  = new Float64Array(n * 3); // over-allocated, trimmed later
  const indexRemap = new Int32Array(n);
  let   vertCount  = 0;

  const vertMap = new Map();

  for (let i = 0; i < n; i++) {
    const x = posAttr.getX(i), y = posAttr.getY(i), z = posAttr.getZ(i);
    // Encode three 21-bit quantised integers into one BigInt key.
    // Offset by 2^20 to handle negative coordinates.
    const ix = (Math.round(x * QUANT) + 0x100000) >>> 0;
    const iy = (Math.round(y * QUANT) + 0x100000) >>> 0;
    const iz = (Math.round(z * QUANT) + 0x100000) >>> 0;
    const key = (BigInt(ix) << 42n) | (BigInt(iy) << 21n) | BigInt(iz);
    let idx = vertMap.get(key);
    if (idx === undefined) {
      idx = vertCount++;
      positions[idx * 3]     = x;
      positions[idx * 3 + 1] = y;
      positions[idx * 3 + 2] = z;
      vertMap.set(key, idx);
    }
    indexRemap[i] = idx;
  }

  const faceCount = n / 3;
  const faces = new Int32Array(faceCount * 3);
  for (let i = 0; i < n; i++) faces[i] = indexRemap[i];

  return { positions: positions.subarray(0, vertCount * 3), faces, vertCount, faceCount };
}

// (adjacency helpers replaced by buildLinkedAdj and _unlinkSlot/_moveSlot above)

function buildOutput(positions, faces, faceCount) {
  let activeFaces = 0;
  for (let f = 0; f < faceCount; f++) {
    if (faces[f * 3] >= 0) activeFaces++;
  }

  const posArray = new Float32Array(activeFaces * 9);
  let out = 0;
  for (let f = 0; f < faceCount; f++) {
    if (faces[f * 3] < 0) continue;
    for (let v = 0; v < 3; v++) {
      const vi = faces[f * 3 + v];
      posArray[out++] = positions[vi * 3];
      posArray[out++] = positions[vi * 3 + 1];
      posArray[out++] = positions[vi * 3 + 2];
    }
  }

  // Compute exact per-face normals from the final positions so winding order
  // always agrees with the stored normals (computeVertexNormals averages across
  // shared positions and can flip normals on excluded surfaces).
  const nrmArray = new Float32Array(posArray.length);
  for (let i = 0; i < posArray.length; i += 9) {
    const ax = posArray[i],   ay = posArray[i+1], az = posArray[i+2];
    const bx = posArray[i+3], by = posArray[i+4], bz = posArray[i+5];
    const cx = posArray[i+6], cy = posArray[i+7], cz = posArray[i+8];
    const ux = bx-ax, uy = by-ay, uz = bz-az;
    const vx = cx-ax, vy = cy-ay, vz = cz-az;
    const nx = uy*vz - uz*vy, ny = uz*vx - ux*vz, nz = ux*vy - uy*vx;
    const len = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
    nrmArray[i]   = nrmArray[i+3] = nrmArray[i+6] = nx / len;
    nrmArray[i+1] = nrmArray[i+4] = nrmArray[i+7] = ny / len;
    nrmArray[i+2] = nrmArray[i+5] = nrmArray[i+8] = nz / len;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
  geo.setAttribute('normal',   new THREE.BufferAttribute(nrmArray, 3));
  return geo;
}

// ── Struct-of-arrays Min-Heap ────────────────────────────────────────────────
// Stores each heap entry in parallel typed arrays rather than JS objects to
// avoid heap allocation pressure and GC pauses during the collapse loop.
// The heap is 1-indexed (root at slot 1).  Slot 0 is used as a scratch area
// by pop() so the caller can read fields after popping.
// pop() returns 0 (the scratch slot index) on success, or -1 if empty.
const SOA_GROW = 1.5;
class SoAHeap {
  constructor(initialCap = 65536) {
    let cap = 2;
    while (cap <= initialCap) cap <<= 1;
    this._cap  = cap;
    this._len  = 0;
    this._cost = new Float64Array(cap);
    this._v1   = new Int32Array(cap);
    this._v2   = new Int32Array(cap);
    this._ver1 = new Uint32Array(cap);
    this._ver2 = new Uint32Array(cap);
    this._px   = new Float64Array(cap);
    this._py   = new Float64Array(cap);
    this._pz   = new Float64Array(cap);
  }

  size() { return this._len; }

  push(cost, v1, v2, ver1, ver2, px, py, pz) {
    let i = ++this._len;
    if (i >= this._cap) this._grow();
    this._cost[i] = cost; this._v1[i] = v1; this._v2[i] = v2;
    this._ver1[i] = ver1; this._ver2[i] = ver2;
    this._px[i] = px; this._py[i] = py; this._pz[i] = pz;
    this._bubbleUp(i);
  }

  // Pops the minimum entry into slot 0 and returns 0.  Returns -1 if empty.
  pop() {
    if (this._len === 0) return -1;
    this._copySlot(0, 1);
    this._copySlot(1, this._len--);
    if (this._len > 0) this._sinkDown(1);
    return 0;
  }

  getV1  (i) { return this._v1[i]; }
  getV2  (i) { return this._v2[i]; }
  getVer1(i) { return this._ver1[i]; }
  getVer2(i) { return this._ver2[i]; }
  getPx  (i) { return this._px[i]; }
  getPy  (i) { return this._py[i]; }
  getPz  (i) { return this._pz[i]; }

  _copySlot(dst, src) {
    this._cost[dst] = this._cost[src]; this._v1[dst] = this._v1[src]; this._v2[dst] = this._v2[src];
    this._ver1[dst] = this._ver1[src]; this._ver2[dst] = this._ver2[src];
    this._px[dst]   = this._px[src];   this._py[dst]   = this._py[src];   this._pz[dst]   = this._pz[src];
  }

  _swap(a, b) {
    const tc = this._cost[a], tv1 = this._v1[a], tv2 = this._v2[a];
    const te1 = this._ver1[a], te2 = this._ver2[a];
    const tpx = this._px[a], tpy = this._py[a], tpz = this._pz[a];
    this._cost[a] = this._cost[b]; this._v1[a] = this._v1[b]; this._v2[a] = this._v2[b];
    this._ver1[a] = this._ver1[b]; this._ver2[a] = this._ver2[b];
    this._px[a]   = this._px[b];   this._py[a]   = this._py[b];   this._pz[a]   = this._pz[b];
    this._cost[b] = tc; this._v1[b] = tv1; this._v2[b] = tv2;
    this._ver1[b] = te1; this._ver2[b] = te2;
    this._px[b]   = tpx; this._py[b]   = tpy; this._pz[b]   = tpz;
  }

  _bubbleUp(i) {
    const cost = this._cost;
    while (i > 1) {
      const p = i >> 1;
      if (cost[p] <= cost[i]) break;
      this._swap(p, i); i = p;
    }
  }

  _sinkDown(i) {
    const cost = this._cost;
    const n = this._len;
    for (;;) {
      let s = i;
      const l = i << 1, r = l | 1;
      if (l <= n && cost[l] < cost[s]) s = l;
      if (r <= n && cost[r] < cost[s]) s = r;
      if (s === i) break;
      this._swap(s, i); i = s;
    }
  }

  _grow() {
    const newCap = Math.ceil(this._cap * SOA_GROW) + 2;
    const resize = (old, Ctor) => { const n = new Ctor(newCap); n.set(old); return n; };
    this._cost = resize(this._cost, Float64Array);
    this._v1   = resize(this._v1,   Int32Array);
    this._v2   = resize(this._v2,   Int32Array);
    this._ver1 = resize(this._ver1, Uint32Array);
    this._ver2 = resize(this._ver2, Uint32Array);
    this._px   = resize(this._px,   Float64Array);
    this._py   = resize(this._py,   Float64Array);
    this._pz   = resize(this._pz,   Float64Array);
    this._cap  = newCap;
  }
}
