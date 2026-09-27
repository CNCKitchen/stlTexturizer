/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * softMask.js — soft-brush (hardness < 100 %) surface masking.
 *
 * The hard brush and bucket fill mask whole triangles (excludedFaces). The
 * soft brush instead paints a coverage value in [0, 1] per welded vertex of
 * the painting mesh; values are interpolated linearly across triangles, so a
 * soft stroke fades out smoothly instead of stair-stepping along triangle
 * edges. Its resolution is the painting mesh's vertex spacing — Precision
 * masking refines it.
 *
 * For export the paint becomes a per-corner EXCLUSION amount (1 = untextured,
 * 0 = full texture) that is carried onto the refined mesh by interpolating
 * inside each corner's parent triangle (interpolateFromParents).
 *
 * Pure typed-array math (no THREE, no DOM) so the export worker can import it.
 */

/**
 * Brush coverage at `dist` from the brush centre: 1 inside the hard core
 * (hardness × radius), then a smoothstep fade to 0 at the rim.
 */
export function brushCoverage(dist, radius, hardness) {
  const core = radius * hardness;
  if (dist <= core) return 1;
  if (dist >= radius) return 0;
  const t = (dist - core) / (radius - core);
  return 1 - t * t * (3 - 2 * t);
}

/** True when any welded vertex carries soft paint. */
export function hasSoftPaint(values) {
  if (!values) return false;
  for (let i = 0; i < values.length; i++) if (values[i] > 0) return true;
  return false;
}

/** Expand per-welded-vertex values to one value per triangle corner. */
export function valuesToCorners(values, vertId) {
  const out = new Float32Array(vertId.length);
  for (let i = 0; i < vertId.length; i++) out[i] = values[vertId[i]];
  return out;
}

/**
 * Fold per-corner values onto welded vertices (max over each vertex's
 * corners, so a vertex is as painted as its most-painted copy).
 */
export function cornersToValues(corners, vertId, vertCount) {
  const out = new Float32Array(vertCount);
  for (let i = 0; i < vertId.length; i++) {
    if (corners[i] > out[vertId[i]]) out[vertId[i]] = corners[i];
  }
  return out;
}

/**
 * Per-corner exclusion amount for the export pipeline, combining the hard
 * face mask with soft paint. Exclude mode: painted = masked. Include-only
 * mode: painted = textured, so the amount is inverted.
 *
 * @param {Uint32Array}  vertId    welded vertex id per corner
 * @param {Float32Array} values    soft paint per welded vertex
 * @param {Set<number>}  hardFaces hard-painted triangle indices
 * @param {boolean}      include   include-only (selection) mode
 * @returns {Float32Array} one value per corner
 */
export function buildSoftExclusion(vertId, values, hardFaces, include) {
  const out = new Float32Array(vertId.length);
  const triCount = vertId.length / 3;
  for (let t = 0; t < triCount; t++) {
    const hard = hardFaces.has(t);
    for (let k = 0; k < 3; k++) {
      const i = t * 3 + k;
      const s = values[vertId[i]];
      out[i] = include ? (hard ? 0 : 1 - s) : (hard ? 1 : s);
    }
  }
  return out;
}

/** Per-triangle flag: 1 where any corner carries soft paint. */
export function softPaintedFaces(vertId, values) {
  const triCount = vertId.length / 3;
  const out = new Uint8Array(triCount);
  for (let t = 0; t < triCount; t++) {
    if (values[vertId[t * 3]] > 0 || values[vertId[t * 3 + 1]] > 0 || values[vertId[t * 3 + 2]] > 0) out[t] = 1;
  }
  return out;
}

/**
 * Carry per-corner values from a parent mesh onto a refined child mesh whose
 * triangles each lie inside one parent triangle (subdivision output, possibly
 * regularized). Every child corner gets the barycentric interpolation of its
 * parent's three corner values; points slightly outside the parent (a
 * regularize collapse can move a vertex across a parent edge) are clamped
 * back onto it.
 *
 * @param {Float32Array} childPos   child positions, 9 floats per triangle
 * @param {Int32Array}   parentId   parent triangle index per child triangle
 * @param {Float32Array} parentPos  parent positions, 9 floats per triangle
 * @param {Float32Array} parentVals parent values, one per corner
 * @returns {Float32Array} child values, one per corner
 */
export function interpolateFromParents(childPos, parentId, parentPos, parentVals) {
  const triCount = parentId.length;
  const out = new Float32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    const p = parentId[t];
    const va = parentVals[p * 3], vb = parentVals[p * 3 + 1], vc = parentVals[p * 3 + 2];
    // Uniform parent (the common case: unpainted or fully painted) — copy it
    // exactly rather than reassembling it from rounded barycentrics.
    if (va === vb && va === vc) {
      out[t * 3] = out[t * 3 + 1] = out[t * 3 + 2] = va;
      continue;
    }
    const b = p * 9;
    const ax = parentPos[b], ay = parentPos[b + 1], az = parentPos[b + 2];
    const e0x = parentPos[b + 3] - ax, e0y = parentPos[b + 4] - ay, e0z = parentPos[b + 5] - az;
    const e1x = parentPos[b + 6] - ax, e1y = parentPos[b + 7] - ay, e1z = parentPos[b + 8] - az;
    const d00 = e0x * e0x + e0y * e0y + e0z * e0z;
    const d01 = e0x * e1x + e0y * e1y + e0z * e1z;
    const d11 = e1x * e1x + e1y * e1y + e1z * e1z;
    const den = d00 * d11 - d01 * d01;
    const degenerate = !(den > 1e-12 * d00 * d11);
    for (let k = 0; k < 3; k++) {
      const c = t * 9 + k * 3;
      let u, v, w;
      if (degenerate) {
        u = v = w = 1 / 3;
      } else {
        const px = childPos[c] - ax, py = childPos[c + 1] - ay, pz = childPos[c + 2] - az;
        const d20 = px * e0x + py * e0y + pz * e0z;
        const d21 = px * e1x + py * e1y + pz * e1z;
        v = (d11 * d20 - d01 * d21) / den;
        w = (d00 * d21 - d01 * d20) / den;
        u = 1 - v - w;
        if (u < 0 || v < 0 || w < 0) {
          u = u > 0 ? u : 0; v = v > 0 ? v : 0; w = w > 0 ? w : 0;
          const s = u + v + w;
          if (s > 0) { u /= s; v /= s; w /= s; } else { u = v = w = 1 / 3; }
        }
      }
      const val = u * va + v * vb + w * vc;
      out[t * 3 + k] = val < 0 ? 0 : val > 1 ? 1 : val;
    }
  }
  return out;
}
