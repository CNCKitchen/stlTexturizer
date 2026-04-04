import * as THREE from 'three';
import { computeUV, getDominantCubicAxis, getCubicBlendWeights } from './mapping.js';

/**
 * Apply displacement to every vertex of a non-indexed BufferGeometry.
 *
 * For each vertex:
 *   1. Compute UV with the same math used in the GLSL preview shader (mapping.js).
 *   2. Bilinear-sample the greyscale ImageData at that UV.
 *   3. Move the vertex along its normal by:  (grey − 0.5) × 2 × amplitude
 *      so 50% grey = no displacement, white = outward, black = inward.
 *
 * @param {THREE.BufferGeometry} geometry  – non-indexed (from subdivide())
 * @param {ImageData}            imageData – raw pixel data from Canvas2D
 * @param {number}               imgWidth
 * @param {number}               imgHeight
 * @param {object}               settings  – { mappingMode, scaleU, scaleV, amplitude, offsetU, offsetV }
 * @param {object}               bounds    – { min, max, center, size } (THREE.Vector3)
 * @param {function}             [onProgress]
 * @returns {THREE.BufferGeometry}  new non-indexed geometry with displaced positions
 */
export function applyDisplacement(geometry, imageData, imgWidth, imgHeight, settings, bounds, onProgress) {
  const posAttr = geometry.attributes.position;
  const nrmAttr = geometry.attributes.normal;
  const count   = posAttr.count;

  const newPos = new Float32Array(count * 3);
  const newNrm = new Float32Array(count * 3);

  const tmpPos  = new THREE.Vector3();
  const tmpNrm  = new THREE.Vector3();
  const vA      = new THREE.Vector3();
  const vB      = new THREE.Vector3();
  const vC      = new THREE.Vector3();
  const edge1   = new THREE.Vector3();
  const edge2   = new THREE.Vector3();
  const faceNrm = new THREE.Vector3();

  // Texture aspect correction so non-square textures keep their proportions.
  // The shorter axis gets aspect > 1 so it tiles faster, making each tile
  // proportionally shorter in world-space to match the texture's content.
  const tmax = Math.max(imgWidth, imgHeight, 1);
  const aspectU = tmax / Math.max(imgWidth, 1);
  const aspectV = tmax / Math.max(imgHeight, 1);
  const settingsWithAspect = { ...settings, textureAspectU: aspectU, textureAspectV: aspectV };

  const QUANT = 1e4;
  const posKey = (x, y, z) =>
    `${Math.round(x * QUANT)}_${Math.round(y * QUANT)}_${Math.round(z * QUANT)}`;

  // ── WHY GAPS HAPPEN ───────────────────────────────────────────────────────
  // The mesh is non-indexed (unrolled): every triangle has its own copy of
  // each vertex.  At a shared edge two triangles have the same position but
  // different face normals.  Displacing each copy along its own face normal
  // moves them to DIFFERENT final positions → crack / gap.
  //
  // THE FIX: every copy of the same position must arrive at the exact same
  // displaced point.  We achieve this by computing a single *smooth* (area-
  // weighted average) normal per unique position and using that both for the
  // texture UV lookup and for the displacement direction.  All copies of the
  // same position then move by the same vector → watertight result.
  //
  // The tradeoff is that displaced normals are smooth at hard edges, but the
  // underlying geometry is still faceted (the subdivision didn't change it),
  // so printed edges remain sharp.

  // ── Pass 1: accumulate area-weighted smooth normals per unique position ───
  // Map: posKey → [nx, ny, nz] (unnormalised sum)
  const smoothNrmMap = new Map();
  // zoneAreaMap: posKey → [xArea, yArea, zArea]  (cubic mapping only)
  // Tracks the total adjacent face area in each cubic projection zone (X/Y/Z dominant).
  // Seam-edge vertices that border two zones get a blend proportional to face area,
  // eliminating the mixed-projection artefact on seam-crossing triangles.
  const zoneAreaMap = new Map();
  // maskedFracMap: posKey → [maskedArea, totalArea]
  // Tracks the fraction of surrounding face area that is masked so boundary
  // vertices get a smooth displacement blend instead of a hard on/off cutoff.
  const maskedFracMap = new Map();

  // Optional per-vertex exclusion weights threaded through by subdivision.js.
  // A face's user-exclusion flag = average of its 3 vertex weights > 0.99.
  const ewAttr = geometry.attributes.excludeWeight || null;
  // Per-face user-exclusion flag: stored separately from maskedFracMap so that
  // user-excluded faces do NOT bleed reduced displacement into adjacent faces
  // via shared vertices (maskedFracMap is only for angle-based blending).
  const userExcludedFaces = ewAttr ? new Uint8Array(count / 3) : null;
  // Positions that belong to at least one user-excluded face.  Any included-face
  // vertex whose original position is in this set sits on the seam boundary; we
  // pin it to zero displacement so both sides of the seam end up at the same
  // final position.  Without this the mesh has an open crack at the mask
  // boundary, which causes the QEM decimator to treat the excluded patch as an
  // isolated open-mesh island and collapse it to nothing (missing triangles).
  const excludedPosSet = ewAttr ? new Set() : null;

  for (let t = 0; t < count; t += 3) {
    vA.fromBufferAttribute(posAttr, t);
    vB.fromBufferAttribute(posAttr, t + 1);
    vC.fromBufferAttribute(posAttr, t + 2);
    edge1.subVectors(vB, vA);
    edge2.subVectors(vC, vA);
    faceNrm.crossVectors(edge1, edge2); // length = 2× triangle area → natural area weighting

    // Determine if this face is masked (used to build the per-vertex blend weight).
    // Combines angle-based masking with optional user-painted exclusion.
    const faceArea   = faceNrm.length();                               // ∝ 2× triangle area
    const faceNzNorm = faceArea > 1e-12 ? faceNrm.z / faceArea : 0;  // unit-normal Z component
    const faceAngle  = Math.acos(Math.abs(faceNzNorm)) * (180 / Math.PI);
    const angleMasked = faceNzNorm < 0
      ? (settings.bottomAngleLimit > 0 && faceAngle <= settings.bottomAngleLimit)
      : (settings.topAngleLimit    > 0 && faceAngle <= settings.topAngleLimit);
    // Threshold >0.99 (not 0.5) prevents shared-vertex MAX-propagation from
    // accidentally marking adjacent faces as excluded on closed meshes (e.g. a
    // cube): adjacent faces have 2/3 vertices at weight 1.0 → avg ≈ 0.67 which
    // would wrongly trigger the old 0.5 threshold.
    const userExcluded = ewAttr
      ? (ewAttr.getX(t) + ewAttr.getX(t + 1) + ewAttr.getX(t + 2)) / 3 > 0.99
      : false;
    // maskedFracMap is ONLY used for angle-based blending at surface boundaries.
    // User exclusion is tracked per-face in userExcludedFaces and applied
    // directly in Pass 3, so excluded faces don't reduce displacement on their
    // neighbours through shared boundary vertices.
    const faceMasked = angleMasked;
    if (userExcluded && userExcludedFaces) userExcludedFaces[t / 3] = 1;

    // For cubic mapping: distribute this face's area across projection zones
    // proportionally to its blend weights.  When blend=0, getCubicBlendWeights
    // returns a one-hot vector (same as the old argmax), preserving sharp seams.
    // When blend>0, faces near a zone boundary contribute partial area to
    // adjacent zones, creating a smooth multi-vertex-wide gradient that matches
    // the preview shader.  The old single-zone approach only blended at the
    // one-vertex-wide boundary, leaving an abrupt seam in the export.
    let czX = 0, czY = 0, czZ = 0;
    if (settings.mappingMode === 6 && faceArea > 1e-12) {
      const cubicBlend = settings.mappingBlend ?? 0;
      const cubicBandWidth = settings.seamBandWidth ?? 0.35;
      const unitFaceNrm = { x: faceNrm.x / faceArea, y: faceNrm.y / faceArea, z: faceNrm.z / faceArea };
      const w = getCubicBlendWeights(unitFaceNrm, cubicBlend, cubicBandWidth);
      czX = w.x * faceArea;
      czY = w.y * faceArea;
      czZ = w.z * faceArea;
    }

    for (let v = 0; v < 3; v++) {
      tmpPos.fromBufferAttribute(posAttr, t + v);
      const k = posKey(tmpPos.x, tmpPos.y, tmpPos.z);
      if (userExcluded && excludedPosSet) excludedPosSet.add(k);
      // Use the buffer normal (from subdivision) weighted by face area.
      // The subdivision pipeline splits indexed vertices at sharp dihedral
      // edges (>30°), so the interpolated buffer normals are smooth across
      // soft edges (cylinder, sphere) but sharp across hard edges (cube).
      // This eliminates visible faceting steps on round surfaces while still
      // preserving hard edges.
      tmpNrm.fromBufferAttribute(nrmAttr, t + v);
      const existing = smoothNrmMap.get(k);
      if (existing) {
        existing[0] += tmpNrm.x * faceArea;
        existing[1] += tmpNrm.y * faceArea;
        existing[2] += tmpNrm.z * faceArea;
      } else {
        smoothNrmMap.set(k, [tmpNrm.x * faceArea, tmpNrm.y * faceArea, tmpNrm.z * faceArea]);
      }
      if (czX > 1e-12 || czY > 1e-12 || czZ > 1e-12) {
        const za = zoneAreaMap.get(k);
        if (za) { za[0] += czX; za[1] += czY; za[2] += czZ; }
        else { zoneAreaMap.set(k, [czX, czY, czZ]); }
      }
      const mf = maskedFracMap.get(k);
      if (mf) {
        if (faceMasked) mf[0] += faceArea;
        mf[1] += faceArea;
      } else {
        maskedFracMap.set(k, [faceMasked ? faceArea : 0, faceArea]);
      }
    }
  }

  // Normalise each accumulated normal
  smoothNrmMap.forEach((n) => {
    const len = Math.sqrt(n[0]*n[0] + n[1]*n[1] + n[2]*n[2]) || 1;
    n[0] /= len; n[1] /= len; n[2] /= len;
  });

  // ── Pass 2: sample displacement texture once per unique position ──────────
  const dispCache = new Map(); // posKey → grey [0, 1]

  for (let i = 0; i < count; i++) {
    tmpPos.fromBufferAttribute(posAttr, i);
    const k = posKey(tmpPos.x, tmpPos.y, tmpPos.z);
    if (dispCache.has(k)) continue;

    const sn = smoothNrmMap.get(k);

    // Cubic: zone-area-weighted sampling with a stable per-face dominant axis.
    // Non-seam vertices use their single zone purely; seam-edge vertices that
    // adjoin two zones get a face-area-proportional blend.  This guarantees all
    // three vertices of every triangle receive consistent displacement, making
    // the mesh watertight with no mixed-projection artefact rows at the seam.
    //
    // Always use this path regardless of mappingBlend.  The smooth normals from
    // subdivision can be wrong on thin structures (e.g. a flat base plate) where
    // top (0,0,1) and bottom (0,0,-1) face normals cancel at shared edge vertices,
    // leaving a horizontal smooth normal.  computeUV would then pick the wrong
    // cubic projection axis, making those faces appear untextured.  The face-
    // normal-based zoneAreaMap is immune to this because it classifies faces by
    // their geometric cross-product normal, not the averaged vertex normal.
    if (settings.mappingMode === 6 /* MODE_CUBIC */) {
      const za = zoneAreaMap.get(k);
      const total = za ? za[0] + za[1] + za[2] : 0;
      if (total > 0) {
        const md = Math.max(bounds.size.x, bounds.size.y, bounds.size.z, 1e-6);
        const rotRad = (settings.rotation ?? 0) * Math.PI / 180;
        let grey = 0;
        if (za[0] > 0) { // X-dominant zone → YZ projection
          let rawU = (tmpPos.y-bounds.min.y)/md;
          if (sn[0] < 0) rawU = -rawU; // flip U for -X faces
          const uv = _cubicUV(rawU, (tmpPos.z-bounds.min.z)/md, settings, rotRad, aspectU, aspectV);
          grey += sampleBilinear(imageData.data, imgWidth, imgHeight, uv.u, uv.v) * (za[0]/total);
        }
        if (za[1] > 0) { // Y-dominant zone → XZ projection
          let rawU = (tmpPos.x-bounds.min.x)/md;
          if (sn[1] > 0) rawU = -rawU; // flip U for +Y faces
          const uv = _cubicUV(rawU, (tmpPos.z-bounds.min.z)/md, settings, rotRad, aspectU, aspectV);
          grey += sampleBilinear(imageData.data, imgWidth, imgHeight, uv.u, uv.v) * (za[1]/total);
        }
        if (za[2] > 0) { // Z-dominant zone → XY projection
          let rawU = (tmpPos.x-bounds.min.x)/md;
          if (sn[2] < 0) rawU = -rawU; // flip U for -Z faces
          const uv = _cubicUV(rawU, (tmpPos.y-bounds.min.y)/md, settings, rotRad, aspectU, aspectV);
          grey += sampleBilinear(imageData.data, imgWidth, imgHeight, uv.u, uv.v) * (za[2]/total);
        }
        dispCache.set(k, grey);
        continue;
      }
    }

    tmpNrm.set(sn[0], sn[1], sn[2]);

    const uvResult = computeUV(tmpPos, tmpNrm, settings.mappingMode, settingsWithAspect, bounds);
    let grey;
    if (uvResult.triplanar) {
      grey = 0;
      for (const s of uvResult.samples) {
        grey += sampleBilinear(imageData.data, imgWidth, imgHeight, s.u, s.v) * s.w;
      }
    } else {
      grey = sampleBilinear(imageData.data, imgWidth, imgHeight, uvResult.u, uvResult.v);
    }
    dispCache.set(k, grey);
  }

  // ── Pass 3: displace every vertex copy by the same vector ─────────────────
  // Using the smooth normal for the displacement direction ensures all copies
  // of the same position land at exactly the same 3-D point.

  const REPORT_EVERY = 5000;

  for (let i = 0; i < count; i++) {
    tmpPos.fromBufferAttribute(posAttr, i);
    tmpNrm.fromBufferAttribute(nrmAttr, i);

    const k    = posKey(tmpPos.x, tmpPos.y, tmpPos.z);
    const sn   = smoothNrmMap.get(k);
    const grey = dispCache.get(k);

    // User-excluded faces get zero displacement; only angle-based masking uses
    // the smooth per-vertex blend so neighbours are never unintentionally dimmed.
    const isFaceExcluded = userExcludedFaces && userExcludedFaces[Math.floor(i / 3)];
    // Pin included-face vertices that share a position with an excluded face.
    // This seals the open crack at the mask boundary so the mesh stays watertight
    // and the decimator cannot collapse the excluded patch to zero faces.
    const isSealedBoundary = !isFaceExcluded && excludedPosSet && excludedPosSet.has(k);
    const mf         = maskedFracMap.get(k) || [0, 1];
    const maskedFrac = mf[1] > 0 ? mf[0] / mf[1] : 0;
    const centeredGrey = settings.symmetricDisplacement ? (grey - 0.5) : grey;
    const disp = (isFaceExcluded || isSealedBoundary) ? 0 : (1 - maskedFrac) * centeredGrey * settings.amplitude;

    const newX = tmpPos.x + sn[0] * disp;
    const newY = tmpPos.y + sn[1] * disp;
    let   newZ = tmpPos.z + sn[2] * disp;

    // Prevent boundary vertices from poking through the masked surface in Z.
    // Only triggers for vertices that are partly masked (maskedFrac > 0) and
    // whose displacement would push them toward the masked surface direction.
    if (maskedFrac > 0) {
      if (settings.bottomAngleLimit > 0 && newZ < tmpPos.z) newZ = tmpPos.z;
      if (settings.topAngleLimit    > 0 && newZ > tmpPos.z) newZ = tmpPos.z;
    }

    newPos[i*3]   = newX;
    newPos[i*3+1] = newY;
    newPos[i*3+2] = newZ;

    // Keep per-face normal for shading (recomputed below anyway)
    newNrm[i*3]   = tmpNrm.x;
    newNrm[i*3+1] = tmpNrm.y;
    newNrm[i*3+2] = tmpNrm.z;

    if (onProgress && i % REPORT_EVERY === 0) onProgress(i / count);
  }

  // Compute exact per-face normals from the displaced positions.
  // Using computeVertexNormals() would average across shared positions, which
  // can flip normals on excluded faces whose neighbours were displaced outward.
  // A direct cross-product per triangle is unambiguous and matches winding order.
  const eA = new THREE.Vector3();
  const eB = new THREE.Vector3();
  const fn = new THREE.Vector3();
  for (let t = 0; t < count; t += 3) {
    const ax = newPos[t*3],   ay = newPos[t*3+1],   az = newPos[t*3+2];
    const bx = newPos[t*3+3], by = newPos[t*3+4],   bz = newPos[t*3+5];
    const cx = newPos[t*3+6], cy = newPos[t*3+7],   cz = newPos[t*3+8];
    eA.set(bx - ax, by - ay, bz - az);
    eB.set(cx - ax, cy - ay, cz - az);
    fn.crossVectors(eA, eB).normalize();
    for (let v = 0; v < 3; v++) {
      newNrm[(t + v) * 3]     = fn.x;
      newNrm[(t + v) * 3 + 1] = fn.y;
      newNrm[(t + v) * 3 + 2] = fn.z;
    }
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(newPos, 3));
  out.setAttribute('normal',   new THREE.BufferAttribute(newNrm, 3));
  return out;
}

// ── Bilinear sampler ─────────────────────────────────────────────────────────

/**
 * Sample a greyscale value (0–1) from raw RGBA ImageData using
 * bilinear interpolation. UV is tiled via mod 1.
 */
function sampleBilinear(data, w, h, u, v) {
  // Ensure [0,1) — guard against floating-point edge cases
  u = ((u % 1) + 1) % 1;
  v = ((v % 1) + 1) % 1;
  // Flip V to match WebGL/Three.js texture convention (flipY=true means
  // v=0 is the bottom of the image, but ImageData row 0 is the top).
  v = 1 - v;

  const fx = u * (w - 1);
  const fy = v * (h - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const tx = fx - x0;
  const ty = fy - y0;

  // Red channel — image is greyscale so R == G == B
  const v00 = data[(y0 * w + x0) * 4] / 255;
  const v10 = data[(y0 * w + x1) * 4] / 255;
  const v01 = data[(y1 * w + x0) * 4] / 255;
  const v11 = data[(y1 * w + x1) * 4] / 255;

  return v00 * (1-tx) * (1-ty)
       + v10 * tx * (1-ty)
       + v01 * (1-tx) * ty
       + v11 * tx * ty;
}

/** Apply scale/offset/rotation to raw UV for cubic projection.
 *  Mirrors the private applyTransform helper in mapping.js. */
function _cubicUV(rawU, rawV, settings, rotRad, aspectU, aspectV) {
  let u = (rawU * aspectU) / settings.scaleU + settings.offsetU;
  let v = (rawV * aspectV) / settings.scaleV + settings.offsetV;
  if (rotRad !== 0) {
    const c = Math.cos(rotRad), s = Math.sin(rotRad);
    u -= 0.5; v -= 0.5;
    const ru = c*u - s*v, rv = s*u + c*v;
    u = ru + 0.5; v = rv + 0.5;
  }
  return { u: u - Math.floor(u), v: v - Math.floor(v) };
}
