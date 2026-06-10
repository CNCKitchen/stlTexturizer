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
 *   faceParentId: Int32Array|null,   // bake mode only
 *   repairStats: object|null,        // export mode, when repair ran
 * }>}
 */

import { THREE } from './threeCompat.js';
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

// Smooth Bottom: snap every vertex within `tol` of the bottom plane onto it so
// the bed-contact surface comes out perfectly flat; recompute face normals on
// touched triangles. (Verbatim from the old main.js snapBottomToFlat.)
export function snapBottomToFlat(geometry, bottomZ, tol = 0.1) {
  const pa = geometry.attributes.position.array;
  const na = geometry.attributes.normal
    ? geometry.attributes.normal.array
    : new Float32Array(pa.length);
  let dirtyTris = 0;

  for (let i = 0; i < pa.length; i += 9) {
    let dirty = false;
    if (Math.abs(pa[i+2] - bottomZ) <= tol) { pa[i+2] = bottomZ; dirty = true; }
    if (Math.abs(pa[i+5] - bottomZ) <= tol) { pa[i+5] = bottomZ; dirty = true; }
    if (Math.abs(pa[i+8] - bottomZ) <= tol) { pa[i+8] = bottomZ; dirty = true; }
    if (dirty) {
      dirtyTris++;
      const ux = pa[i+3]-pa[i],   uy = pa[i+4]-pa[i+1], uz = pa[i+5]-pa[i+2];
      const vx = pa[i+6]-pa[i],   vy = pa[i+7]-pa[i+1], vz = pa[i+8]-pa[i+2];
      const nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
      const len = Math.sqrt(nx*nx+ny*ny+nz*nz) || 1;
      na[i]   = na[i+3] = na[i+6] = nx/len;
      na[i+1] = na[i+4] = na[i+7] = ny/len;
      na[i+2] = na[i+5] = na[i+8] = nz/len;
    }
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
    if (runDecimation) {
      onEvent('decimate', 0, { from: dispTriCount, needsDecimation });
      await yieldFrame();
      finalGeometry = await decimate(
        displaced,
        settings.maxTriangles,
        (p) => onEvent('decimate', p, { from: dispTriCount, needsDecimation }),
        settings.harvestFlatFaces,
        settings.harvestTol
      );
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
