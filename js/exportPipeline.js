/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * exportPipeline.js — the heavy mesh pipeline behind Export and Bake,
 * extracted from main.js so it can run EITHER on the main thread (fallback)
 * OR inside the export Web Worker (exportWorker.js). Pure data in/out: no
 * DOM, no i18n, no app state.
 *
 * Sequence (mirrors the old inline handleExport/bakeTextures exactly):
 *   subdivide → [regularize → re-subdivide] → displace
 *   → [decimate]                 (export mode only)
 *   → bottom clamp → smooth bottom
 *   → [resolveTJunctions]        (export mode, when decimation ran)
 *
 * @param {object} input
 *   positions     Float32Array  non-indexed triangle soup (xyz per vertex)
 *   faceWeights   Float32Array|null  per-vertex exclusion weights
 *   imageData     ImageData-like {data, width, height}
 *   imgWidth, imgHeight  texture dimensions
 *   settings      plain settings snapshot (structured-clone safe)
 *   bounds        {min,max,size,center} as {x,y,z} objects or Vector3s
 *   regularizeOpts  opts object for regularizeMesh
 *   mode          'export' | 'bake'
 * @param {function} [onEvent]  (stage, p, info) progress events; the caller
 *   maps stages to progress-bar fractions and translated labels.
 * @param {function} [shouldAbort]  checked between stages; true → return null.
 * @returns {Promise<null | {
 *   positions: Float32Array, normals: Float32Array|null,
 *   safetyCapHit: boolean, runDecimation: boolean, needsDecimation: boolean,
 *   lockedOverBudget: boolean,  // preserve-untextured beta: locked faces ≥ triangle target
 *   faceParentId: Int32Array|null,   // bake mode only
 *   repairStats: object|null,        // export mode, when repair ran
 * }>}
 */

import { THREE } from './threeCompat.js';
import { QuantizedPointMap } from './meshIndex.js';
import { subdivide } from './subdivision.js';
import { regularizeMesh } from './regularize.js';
import { applyDisplacement } from './displacement.js';
import { decimate } from './decimation.js';
import { resolveTJunctions, countEdgeDefects, countAreaSlivers } from './meshRepair.js';

const yieldFrame = () => new Promise(r => setTimeout(r, 0));

// Revive a structured-cloned bounds object ({x,y,z} plain objects) into real
// Vector3s — displacement/mapping only read .x/.y/.z, but real vectors keep
// any future method use safe.
function reviveBounds(b) {
  const v = (o) => new THREE.Vector3(o.x, o.y, o.z);
  return { min: v(b.min), max: v(b.max), size: v(b.size), center: v(b.center) };
}

// Flat-bottom clamp (bottomAngleLimit > 0): any vertex that ended up below the
// original model's bottom layer gets snapped back up to that Z. Single pass
// with selective normal recomputation. (Verbatim from the old inline code.)
function clampBelowBottom(geometry, bottomZ) {
  const pa = geometry.attributes.position.array;
  const na = geometry.attributes.normal ? geometry.attributes.normal.array : new Float32Array(pa.length);

  for (let i = 0; i < pa.length; i += 9) {
    let dirty = false;
    if (pa[i+2] < bottomZ) { pa[i+2] = bottomZ; dirty = true; }
    if (pa[i+5] < bottomZ) { pa[i+5] = bottomZ; dirty = true; }
    if (pa[i+8] < bottomZ) { pa[i+8] = bottomZ; dirty = true; }

    if (dirty) {
      const ux = pa[i+3]-pa[i],   uy = pa[i+4]-pa[i+1], uz = pa[i+5]-pa[i+2];
      const vx = pa[i+6]-pa[i],   vy = pa[i+7]-pa[i+1], vz = pa[i+8]-pa[i+2];
      const nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
      const len = Math.sqrt(nx*nx+ny*ny+nz*nz) || 1;
      na[i]   = na[i+3] = na[i+6] = nx/len;
      na[i+1] = na[i+4] = na[i+7] = ny/len;
      na[i+2] = na[i+5] = na[i+8] = nz/len;
    }
  }

  geometry.attributes.position.needsUpdate = true;
  if (!geometry.attributes.normal) geometry.setAttribute('normal', new THREE.Float32BufferAttribute(na, 3));
  else geometry.attributes.normal.needsUpdate = true;
}

// Smooth Bottom: snap near-bottom vertices onto the bottom plane so the
// bed-contact surface comes out perfectly flat; recompute face normals on
// touched triangles.
//
// Fold gate (June 2026): the original unconditional band-snap flattened ANY
// geometry hovering within `tol` of the plane — notably the undersides of
// texture bumps near the base — folding it coplanar INTO the bottom face.
// Folded faces overlap the plate, so welded edges there pick up 4 incident
// faces: non-manifold edges and phantom "disconnected shells" on re-import
// (measured on the parking rack + dots: 40 nm edges / 39 shells, all at the
// bottom plane; 0 / 2 with the snap off). The snap is now per-position and
// gated like a regularize/decimation collapse: all copies of a welded
// position move together, and the move is REJECTED if any incident triangle
// would become degenerate or rotate its normal by more than ~75°. Genuine
// bed-contact slivers — the reason this feature exists — rotate by fractions
// of a degree and still snap; bump undersides would fold ~90° and stay put.
export function snapBottomToFlat(geometry, bottomZ, tol = 0.1) {
  const pa = geometry.attributes.position.array;
  const na = geometry.attributes.normal
    ? geometry.attributes.normal.array
    : new Float32Array(pa.length);

  const vertCount = pa.length / 3;
  const triCount  = vertCount / 3;

  // Weld positions (1e6 — the decimation grid; copies of one position are
  // bit-identical at this point) and build per-position incident corner lists.
  const weld = new QuantizedPointMap(1e6, Math.min(vertCount, 1 << 22));
  const vid = new Uint32Array(vertCount);
  let nUnique = 0;
  for (let i = 0; i < vertCount; i++) {
    const id = weld.getOrSet(pa[i*3], pa[i*3+1], pa[i*3+2], nUnique);
    if (weld.inserted) nUnique++;
    vid[i] = id;
  }
  const start = new Uint32Array(nUnique + 1);
  for (let i = 0; i < vertCount; i++) start[vid[i] + 1]++;
  for (let id = 0; id < nUnique; id++) start[id + 1] += start[id];
  const inc = new Uint32Array(vertCount);
  const cursor = new Uint32Array(nUnique);
  for (let i = 0; i < vertCount; i++) inc[start[vid[i]] + cursor[vid[i]]++] = i;

  const FOLD_COS = Math.cos(75 * Math.PI / 180);
  const dirtyTri = new Uint8Array(triCount);
  const _zs = new Float64Array(3);

  for (let id = 0; id < nUnique; id++) {
    const first = inc[start[id]];
    const z = pa[first * 3 + 2];
    if (z === bottomZ || Math.abs(z - bottomZ) > tol) continue;

    // Gate: simulate moving this position to the plane; every incident
    // triangle must keep positive area and not fold (normal rotation ≤ ~75°).
    let ok = true;
    for (let k = start[id]; k < start[id + 1] && ok; k++) {
      const t = (inc[k] / 3) | 0;
      const b = t * 9;
      const c0 = t * 3;
      // Post-move z per corner: corners welded to this id land on the plane.
      for (let v = 0; v < 3; v++) _zs[v] = vid[c0 + v] === id ? bottomZ : pa[b + v * 3 + 2];

      const oux = pa[b+3]-pa[b], ouy = pa[b+4]-pa[b+1], ouz = pa[b+5]-pa[b+2];
      const ovx = pa[b+6]-pa[b], ovy = pa[b+7]-pa[b+1], ovz = pa[b+8]-pa[b+2];
      const onx = ouy*ovz - ouz*ovy, ony = ouz*ovx - oux*ovz, onz = oux*ovy - ouy*ovx;

      const nuz = _zs[1] - _zs[0], nvz = _zs[2] - _zs[0];
      const nnx = ouy*nvz - nuz*ovy, nny = nuz*ovx - oux*nvz, nnz = oux*ovy - ouy*ovx;

      const o2 = onx*onx + ony*ony + onz*onz;
      const n2 = nnx*nnx + nny*nny + nnz*nnz;
      if (n2 < 1e-20) { ok = false; break; }      // would collapse to zero area
      if (o2 < 1e-20) continue;                    // already degenerate — can't judge rotation
      const dot = onx*nnx + ony*nny + onz*nnz;
      if (dot < 0 || dot * dot < FOLD_COS * FOLD_COS * o2 * n2) ok = false; // would fold
    }
    if (!ok) continue;

    // Apply: snap all copies of this position; mark incident triangles dirty.
    for (let k = start[id]; k < start[id + 1]; k++) {
      pa[inc[k] * 3 + 2] = bottomZ;
      dirtyTri[(inc[k] / 3) | 0] = 1;
    }
  }

  // Recompute face normals on touched triangles.
  let dirtyTris = 0;
  for (let t = 0; t < triCount; t++) {
    if (!dirtyTri[t]) continue;
    dirtyTris++;
    const i = t * 9;
    const ux = pa[i+3]-pa[i],   uy = pa[i+4]-pa[i+1], uz = pa[i+5]-pa[i+2];
    const vx = pa[i+6]-pa[i],   vy = pa[i+7]-pa[i+1], vz = pa[i+8]-pa[i+2];
    const nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
    const len = Math.sqrt(nx*nx+ny*ny+nz*nz) || 1;
    na[i]   = na[i+3] = na[i+6] = nx/len;
    na[i+1] = na[i+4] = na[i+7] = ny/len;
    na[i+2] = na[i+5] = na[i+8] = nz/len;
  }

  if (dirtyTris > 0) {
    geometry.attributes.position.needsUpdate = true;
    if (!geometry.attributes.normal) {
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(na, 3));
    } else {
      geometry.attributes.normal.needsUpdate = true;
    }
  }
  return dirtyTris;
}

export async function runExportPipeline(input, onEvent = () => {}, shouldAbort = () => false) {
  const { settings, regularizeOpts } = input;
  const mode = input.mode === 'bake' ? 'bake' : 'export';
  const bounds = reviveBounds(input.bounds);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(input.positions, 3));

  // Hoist intermediates so the finally block can always dispose them.
  let subdivided    = null;
  let displaced     = null;
  let finalGeometry = null;
  let done          = false;

  try {
    onEvent('subdivide1', 0);
    await yieldFrame();
    if (shouldAbort()) return null;

    let safetyCapHit, faceParentId;
    ({ geometry: subdivided, safetyCapHit, faceParentId } = await subdivide(
      geometry, settings.refineLength,
      (p, triCount, longestEdge) => onEvent('subdivide1', p, { triCount, longestEdge }),
      input.faceWeights || null
    ));
    if (shouldAbort()) return null;

    // Regularize sub-slivers, then re-subdivide stretched edges. Skipped when
    // the Advanced toggle is off. Export mode passes a zero parent map (it
    // doesn't consume parents); bake mode threads + composes the real one.
    if (settings.regularizeEnabled) {
      onEvent('regularize', 0);
      await yieldFrame();
      const regParents = mode === 'bake'
        ? faceParentId
        : new Int32Array(subdivided.attributes.position.count / 3);
      const reg = regularizeMesh(subdivided, regParents, settings.refineLength, regularizeOpts);
      subdivided.dispose();
      const exclAttr = reg.geometry.attributes.excludeWeight;
      const secondPassWeights = exclAttr ? exclAttr.array : null;
      const { geometry: resub, faceParentId: resubParents } = await subdivide(
        reg.geometry, settings.refineLength * settings.regularizeSecondPassMul,
        (p, triCount, longestEdge) => onEvent('subdivide2', p, { triCount, longestEdge }),
        secondPassWeights, { fast: false }
      );
      reg.geometry.dispose();
      if (mode === 'bake') {
        const composed = new Int32Array(resubParents.length);
        for (let i = 0; i < resubParents.length; i++) {
          composed[i] = reg.faceParentId[resubParents[i]];
        }
        faceParentId = composed;
      }
      subdivided = resub;
    }
    if (shouldAbort()) return null;

    const subTriCount = subdivided.attributes.position.count / 3;
    onEvent('displace', 0, { triCount: subTriCount });
    await yieldFrame();
    displaced = applyDisplacement(
      subdivided,
      input.imageData,
      input.imgWidth,
      input.imgHeight,
      settings,
      bounds,
      (p) => onEvent('displace', p, { triCount: subTriCount })
    );
    if (shouldAbort()) return null;

    // Preserve-untextured (beta): capture the per-face exclusion mask before
    // the subdivided mesh is freed. Displacement keeps triangle count and
    // order, so the mask indexes the displaced mesh 1:1 and lets decimation
    // lock those faces in place.
    let lockedFaces = null;
    if (settings.preserveUntextured) {
      const ew = subdivided.attributes.excludeWeight;
      if (ew) {
        const triN = subdivided.attributes.position.count / 3;
        lockedFaces = new Uint8Array(triN);
        for (let t = 0; t < triN; t++) {
          if (ew.array[t * 3] > 0.99) lockedFaces[t] = 1;
        }
      }
    }

    // Free subdivided geometry — displacement created a separate copy.
    subdivided.dispose();
    subdivided = null;

    const dispTriCount = displaced.attributes.position.count / 3;
    const needsDecimation = dispTriCount > settings.maxTriangles;
    finalGeometry = displaced;

    // Decimation runs only in export mode (bake keeps the parent-face map,
    // which decimate drops): when over the target OR when flat-face harvesting
    // alone is wanted.
    const runDecimation = mode === 'export' && (needsDecimation || settings.harvestFlatFaces);
    let lockedOverBudget = false;
    if (runDecimation) {
      onEvent('decimate', 0, { from: dispTriCount, needsDecimation });
      await yieldFrame();
      finalGeometry = await decimate(
        displaced,
        settings.maxTriangles,
        (p) => onEvent('decimate', p, { from: dispTriCount, needsDecimation }),
        settings.harvestFlatFaces,
        settings.harvestTol,
        lockedFaces
      );
      // Capture before repair replaces the geometry (userData isn't carried over).
      lockedOverBudget = !!finalGeometry.userData.lockedOverBudget;
      // Free pre-decimation geometry — decimate created a separate copy.
      displaced.dispose();
      displaced = null;
      if (shouldAbort()) return null;
    }

    if (settings.bottomAngleLimit > 0) {
      clampBelowBottom(finalGeometry, bounds.min.z);
    }
    if (settings.smoothBottom) {
      snapBottomToFlat(finalGeometry, bounds.min.z, 0.1);
    }

    // Resolve T-junctions so the export is watertight & manifold. Only on the
    // decimated (sparse) mesh — welding the dense pre-decimation mesh at the
    // export grid would collapse fine detail into degenerates.
    let repairStats = null;
    if (runDecimation) {
      onEvent('repair', 0);
      await yieldFrame();
      const beforeSlivers = countAreaSlivers(finalGeometry);
      const repaired = resolveTJunctions(finalGeometry);
      finalGeometry.dispose();
      finalGeometry = repaired;
      const after = countEdgeDefects(finalGeometry);
      repairStats = {
        beforeSlivers,
        open: after.open,
        nonManifold: after.nonManifold,
        slivers: countAreaSlivers(finalGeometry),
        tris: after.tris,
      };
      if (shouldAbort()) return null;
    }

    done = true;
    return {
      positions: finalGeometry.attributes.position.array,
      normals: finalGeometry.attributes.normal ? finalGeometry.attributes.normal.array : null,
      safetyCapHit,
      lockedOverBudget,
      runDecimation,
      needsDecimation,
      faceParentId: mode === 'bake' ? faceParentId : null,
      repairStats,
    };
  } finally {
    // Dispose intermediates regardless of success, failure, or abort.
    // finalGeometry may alias displaced (no decimation) — avoid double-dispose.
    if (subdivided) subdivided.dispose();
    if (displaced && displaced !== subdivided) displaced.dispose();
    if (!done && finalGeometry && finalGeometry !== displaced && finalGeometry !== subdivided) {
      finalGeometry.dispose();
    }
  }
}
