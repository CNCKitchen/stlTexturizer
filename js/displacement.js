/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { THREE } from './threeCompat.js';
import { computeUV, getDominantCubicAxis, getCubicBlendWeights, scaleMmToRelative } from './mapping.js';
import { QuantizedPointMap } from './meshIndex.js';

// ── Sharp-crease handling (see _findCreases / _creaseMoves) ─────────────────
// Buffer normals within this angle belong to the same smooth group
// (subdivision splits groups at 30°, and copies of one group are identical).
const CREASE_GROUP_COS = Math.cos(20 * Math.PI / 180);
// A position is mitred when two of its groups meet at this angle or more.
// Gentler facet breaks (coarse cylinders, chamfers) stay on the smooth path,
// whose groove is small there (1 − cos(φ/2): 3 % at 30°, 10 % at 50°) and
// whose blend-normal smoothing keeps the projection continuous across them.
const SHARP_CREASE_COS = Math.cos(50 * Math.PI / 180);
const MAX_GROUPS = 6;
// Acute wedges: the exact mitre runs away (h / cos(φ/2) → ∞ toward a knife
// edge), so the move is capped at this multiple of the largest group height.
const MITER_LIMIT = 2;
// Weight pulling the mitre toward the smooth-normal move. Only decides the
// directions the face planes leave free (along the edge line; the open side
// of a thin plate) — too small to shift a mitred corner noticeably.
const MITER_RIDGE = 0.01;

/**
 * Apply displacement to every vertex of a non-indexed BufferGeometry.
 *
 * For each vertex:
 *   1. Compute UV with the same math used in the GLSL preview shader (mapping.js).
 *   2. Bilinear-sample the greyscale ImageData at that UV.
 *   3. Move the vertex along its normal by:  (grey − 0.5) × 2 × amplitude
 *      so 50% grey = no displacement, white = outward, black = inward.
 *
 * Single-texture entry point (the legacy pipeline input). The per-layer
 * exclusion comes from the geometry's `excludeWeight` (hard mask + angle
 * mask, threaded through subdivision) and `softExclude` (soft-brush paint)
 * attributes. See applyDisplacementLayers for several textures at once.
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
  return applyDisplacementLayers(
    geometry,
    [{ imageData, imgWidth, imgHeight, settings, legacy: true }],
    settings, bounds, onProgress
  );
}

/**
 * Displace with several texture layers composited per vertex.
 *
 * Every layer samples its own height map with its own projection settings;
 * the per-vertex heights are then combined in layer order. A layer covers
 * the layers below it where its mask lets it through ("over"), or adds to
 * them when `blendAdd` is set. With one layer this is exactly the
 * single-texture displacement.
 *
 * Shared across layers (from `settings` / the geometry): the angle masks,
 * overhang protection, blend-normal smoothing, and the `excludeWeight`
 * attribute, which marks faces no layer textures (plus angle-masked faces)
 * — those are pinned in every layer.
 *
 * @param {THREE.BufferGeometry} geometry  – non-indexed (from subdivide())
 * @param {Array<object>} layers  in composition order (first = bottom):
 *   imageData, imgWidth, imgHeight
 *   settings   per-layer projection/displacement settings (mappingMode,
 *              scaleU/V, offsetU/V, rotation, amplitude, symmetricDisplacement,
 *              mappingBlend, seamBandWidth, capAngle, cylinder*, boundaryFalloff,
 *              boundaryFalloffCurve)
 *   exclude    Float32Array|null  per-corner exclusion amount on `geometry`
 *              (1 = untextured, 0 = full texture; between = soft brush)
 *   hardFaces  Uint8Array|null    per-triangle flag: fully untextured by the
 *              layer's hard mask (their positions pin the layer's boundary)
 *   blendAdd   boolean            add to the layers below instead of covering them
 *   legacy     boolean            read the mask from the geometry's
 *              excludeWeight / softExclude attributes instead
 * @param {object} settings  global settings (bottomAngleLimit, topAngleLimit,
 *                           noDownwardZ, blendNormalSmoothing)
 * @param {object} bounds
 * @param {function} [onProgress]
 * @returns {THREE.BufferGeometry}
 */
export function applyDisplacementLayers(geometry, layers, settings, bounds, onProgress) {
  const posAttr = geometry.attributes.position;
  const nrmAttr = geometry.attributes.normal;
  const count   = posAttr.count;
  const triCount = count / 3;

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

  // 10 nm vertex-dedup cells. Must match subdivision.js QUANTISE so the
  // displacement pipeline sees the same vertex-uniqueness that subdivision
  // produced — coarser cells (1e4) collapsed real fillet vertices on small
  // models, creating needle artifacts and non-manifold edges.
  const QUANT = 1e5;

  // ── WHY GAPS HAPPEN ────────────────────────────────────────────────────────
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
  // Moving along the averaged normal would round every hard edge off: a
  // vertex on a 90° cube edge travels 45° outward, so it ends up only
  // h·cos 45° ≈ 0.71 h from each face while its neighbours sit at h — a
  // notched groove along the edge. Vertices on sharp creases are therefore
  // mitred instead (see _findCreases / _creaseMoves): still one vector per
  // position, so still watertight.

  // ── Vertex dedup pass: position → numeric ID (allocation-free hash table) ─
  // idPos{X,Y,Z} are only populated when boundary falloff is enabled, since
  // they're only consumed by the falloff distance field. Pre-sized to `count`
  // (upper bound on uniqueCount); read by ID, so extra tail slots stay unused.
  const needIdPositions = layers.some(l => (l.settings.boundaryFalloff ?? 0) > 0);
  const _dedupMap = new QuantizedPointMap(QUANT, Math.min(count, 1 << 22));
  let _nextId = 0;
  const vertexId = new Uint32Array(count);
  const idPosX = needIdPositions ? new Float64Array(count) : null;
  const idPosY = needIdPositions ? new Float64Array(count) : null;
  const idPosZ = needIdPositions ? new Float64Array(count) : null;
  for (let i = 0; i < count; i++) {
    const x = posAttr.getX(i), y = posAttr.getY(i), z = posAttr.getZ(i);
    const id = _dedupMap.getOrSet(x, y, z, _nextId);
    if (_dedupMap.inserted) {
      _nextId++;
      if (needIdPositions) {
        idPosX[id] = x; idPosY[id] = y; idPosZ[id] = z;
      }
    }
    vertexId[i] = id;
  }
  const uniqueCount = _nextId;

  // Welded positions on a crease, with one normal per smooth group meeting
  // there (null when the mesh has none — the rest of the pass then runs
  // exactly as it did before creases were handled).
  let creases = nrmAttr ? _findCreases(nrmAttr, vertexId, uniqueCount) : null;

  // ── Pass 1: accumulate area-weighted smooth normals per unique position ───
  // Flat arrays indexed by vertex dedup ID (replaces Map<string, ...>)
  const smoothNrmX = new Float64Array(uniqueCount);
  const smoothNrmY = new Float64Array(uniqueCount);
  const smoothNrmZ = new Float64Array(uniqueCount);

  // zoneArea: per-axis face area for cubic mapping (replaces zoneAreaMap),
  // one set per cubic layer (the blend weights are per-layer settings).
  const cubicLayers = layers.filter(l => l.settings.mappingMode === 6);
  for (const l of cubicLayers) {
    l._zoneAreaX = new Float64Array(uniqueCount);
    l._zoneAreaY = new Float64Array(uniqueCount);
    l._zoneAreaZ = new Float64Array(uniqueCount);
  }

  // maskedFrac: [maskedArea, totalArea] per unique vertex (replaces maskedFracMap)
  const maskedFracMasked = new Float64Array(uniqueCount);
  const maskedFracTotal  = new Float64Array(uniqueCount);

  // Optional per-vertex exclusion weights threaded through by subdivision.js.
  // A face's user-exclusion flag = average of its 3 vertex weights > 0.99.
  const ewAttr = geometry.attributes.excludeWeight || null;
  // Positions that belong to at least one user-excluded face. Kept separate
  // from maskedFrac so that user-excluded faces do NOT bleed reduced
  // displacement into adjacent faces via shared vertices (maskedFrac is only
  // for angle-based blending): an excluded face's own positions are pinned,
  // its neighbours' other positions are not.
  const excludedPos = ewAttr ? new Uint8Array(uniqueCount) : null;

  // Per-layer mask state on the welded vertices. Copies of one position can
  // disagree where hard mask meets soft paint; the most-masked copy wins (the
  // same rule as the seal below), so every copy is displaced identically and
  // the result stays watertight.
  //   _softMax  Float32Array|null  max exclusion amount over a position's copies
  //   _hardPos  Uint8Array|null    position belongs to a face the layer's hard
  //                                mask excludes (pins the layer's boundary)
  for (const l of layers) {
    if (l.legacy) {
      const seAttr = geometry.attributes.softExclude || null;
      l._seAttr = seAttr;
      l._softMax = seAttr ? new Float32Array(uniqueCount) : null;
      l._hardPos = null; // the legacy layer's hard mask IS excludedPos
    } else {
      l._seAttr = null;
      l._softMax = l.exclude ? new Float32Array(uniqueCount) : null;
      l._hardPos = l.hardFaces ? new Uint8Array(uniqueCount) : null;
    }
  }

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
    // User exclusion is tracked per position in excludedPos and applied when
    // the layers are folded, so excluded faces don't reduce displacement on
    // their neighbours through shared boundary vertices.
    const faceMasked = angleMasked;

    // For cubic mapping: distribute this face's area across projection zones
    // proportionally to its blend weights.  When blend=0, getCubicBlendWeights
    // returns a one-hot vector (same as the old argmax), preserving sharp seams.
    // When blend>0, faces near a zone boundary contribute partial area to
    // adjacent zones, creating a smooth multi-vertex-wide gradient that matches
    // the preview shader.  The old single-zone approach only blended at the
    // one-vertex-wide boundary, leaving an abrupt seam in the export.
    let unitFaceNrm = null;
    if (cubicLayers.length && faceArea > 1e-12) {
      unitFaceNrm = { x: faceNrm.x / faceArea, y: faceNrm.y / faceArea, z: faceNrm.z / faceArea };
      for (const l of cubicLayers) {
        const cubicBlend = l.settings.mappingBlend ?? 0;
        const cubicBandWidth = l.settings.seamBandWidth ?? 0.35;
        const w = getCubicBlendWeights(unitFaceNrm, cubicBlend, cubicBandWidth);
        l._czX = w.x * faceArea;
        l._czY = w.y * faceArea;
        l._czZ = w.z * faceArea;
      }
    } else {
      for (const l of cubicLayers) { l._czX = 0; l._czY = 0; l._czZ = 0; }
    }

    let cenX = 0, cenY = 0, cenZ = 0;
    if (creases) {
      cenX = (vA.x + vB.x + vC.x) / 3; cenY = (vA.y + vB.y + vC.y) / 3; cenZ = (vA.z + vB.z + vC.z) / 3;
    }

    for (let v = 0; v < 3; v++) {
      const vid = vertexId[t + v];
      if (userExcluded && excludedPos) excludedPos[vid] = 1;
      for (const l of layers) {
        if (l._softMax) {
          const se = l.legacy ? l._seAttr.getX(t + v) : l.exclude[t + v];
          if (se > l._softMax[vid]) l._softMax[vid] = se;
        }
        if (l._hardPos && l.hardFaces[t / 3]) l._hardPos[vid] = 1;
      }
      // Use the buffer normal (from subdivision) weighted by face area.
      // The subdivision pipeline splits indexed vertices at sharp dihedral
      // edges (>30°), so the interpolated buffer normals are smooth across
      // soft edges (cylinder, sphere) but sharp across hard edges (cube).
      // This eliminates visible faceting steps on round surfaces while still
      // preserving hard edges.
      tmpNrm.fromBufferAttribute(nrmAttr, t + v);
      smoothNrmX[vid] += tmpNrm.x * faceArea;
      smoothNrmY[vid] += tmpNrm.y * faceArea;
      smoothNrmZ[vid] += tmpNrm.z * faceArea;
      for (const l of cubicLayers) {
        if (l._czX > 1e-12 || l._czY > 1e-12 || l._czZ > 1e-12) {
          l._zoneAreaX[vid] += l._czX;
          l._zoneAreaY[vid] += l._czY;
          l._zoneAreaZ[vid] += l._czZ;
        }
      }
      if (faceMasked) maskedFracMasked[vid] += faceArea;
      maskedFracTotal[vid] += faceArea;
      if (creases && creases.slotOf[vid] >= 0) {
        const k = creases.start[creases.slotOf[vid]] + creases.groupOf[t + v];
        const c = v === 0 ? vA : v === 1 ? vB : vC;
        creases.nrmX[k] += tmpNrm.x * faceArea;
        creases.nrmY[k] += tmpNrm.y * faceArea;
        creases.nrmZ[k] += tmpNrm.z * faceArea;
        creases.inX[k] += cenX - c.x;
        creases.inY[k] += cenY - c.y;
        creases.inZ[k] += cenZ - c.z;
        creases.area[k] += faceArea;
        if (faceMasked) creases.masked[k] += faceArea;
      }
    }
  }
  if (creases && !_finishCreases(creases)) creases = null;

  // Normalise each accumulated normal — also remember the pre-normalisation
  // magnitude relative to the total face area at that position. A ratio near
  // 1 means all neighbouring face normals point the same way (the smooth
  // normal is a reliable surface direction); near 0 means opposing normals
  // cancelled out (knife-edge / thin plate). The cubic sampler uses the ratio
  // to decide whether the smooth normal can drive blend weights or whether
  // the per-face zoneArea fallback is needed.
  const smoothNrmReliability = new Float64Array(uniqueCount);
  for (let id = 0; id < uniqueCount; id++) {
    const len = Math.sqrt(smoothNrmX[id]*smoothNrmX[id] + smoothNrmY[id]*smoothNrmY[id] + smoothNrmZ[id]*smoothNrmZ[id]);
    const tA  = maskedFracTotal[id];
    smoothNrmReliability[id] = (len > 0 && tA > 0) ? len / tA : 0;
    const inv = len > 0 ? 1 / len : 1;
    smoothNrmX[id] *= inv; smoothNrmY[id] *= inv; smoothNrmZ[id] *= inv;
  }

  // ── Pass 1.5: Laplacian-smoothed BLEND normal ─────────────────────────────
  // The displacement direction (Pass 3) must remain the accurate per-vertex
  // smooth normal — otherwise watertight copies of the same position move
  // differently and you get cracks. But the normal used to derive
  // *projection-direction blend weights* only needs to vary slowly across
  // the surface. On organic / sculpted meshes the smooth normal still has
  // high-frequency jitter (a few degrees vertex-to-vertex). Inside the
  // blend band (where ∂w/∂n is largest) that jitter multiplies the
  // difference between two unrelated heightmap samples (hA - hB), producing
  // visible seam noise even when the underlying texture is not at fault.
  //
  // Smoothing the blend normal kills this amplification at the source. On a
  // sphere the smoothing is a no-op (already smooth); on a noisy surface it
  // damps the jitter that drives ∂w. Direction info is preserved because we
  // re-normalise after each iteration.
  //
  // The graph runs over smooth-group nodes, not bare positions: a vertex on a
  // sharp crease is one node per face group meeting there (_nodeOf), so the
  // smoothing never carries a face's normal across a hard edge. Blending the
  // neighbouring face's normal in used to tilt a band of each cube face
  // toward 45°, where the other face's projection — edge-on there, a smear —
  // got mixed into the texture. Without creases node = welded position.
  const blendNrmIters = Math.max(0, Math.floor(settings.blendNormalSmoothing ?? 0));
  const nodeCount = creases ? uniqueCount + creases.extraNodes : uniqueCount;
  const nodeOf = creases ? (i) => _nodeOf(creases, vertexId, uniqueCount, i) : (i) => vertexId[i];
  let initX = smoothNrmX, initY = smoothNrmY, initZ = smoothNrmZ;
  if (creases) {
    initX = new Float64Array(nodeCount); initX.set(smoothNrmX);
    initY = new Float64Array(nodeCount); initY.set(smoothNrmY);
    initZ = new Float64Array(nodeCount); initZ.set(smoothNrmZ);
    for (let s = 0; s < creases.count; s++) {
      if (!creases.active[s]) continue;
      for (let g = 0; g < creases.groups[s]; g++) {
        const node = _groupNode(creases, uniqueCount, s, g);
        const k = creases.start[s] + g;
        initX[node] = creases.nrmX[k]; initY[node] = creases.nrmY[k]; initZ[node] = creases.nrmZ[k];
      }
    }
  }
  let blendNrmX = initX, blendNrmY = initY, blendNrmZ = initZ;
  if (blendNrmIters > 0) {
    // Build dedup-graph adjacency in CSR form: each triangle contributes
    // 3 directed edges; we build a multigraph (duplicates keep their natural
    // weight from how often two positions share an edge — i.e., shared
    // surfaces accumulate higher coupling, which is what we want).
    // For each node id, neighbors[csrStart[id]..csrStart[id+1]) is the
    // contiguous slice of neighbour ids.
    const degree = new Uint32Array(nodeCount);
    for (let t = 0; t < count; t += 3) {
      const a = nodeOf(t), b = nodeOf(t + 1), c = nodeOf(t + 2);
      if (a !== b) { degree[a]++; degree[b]++; }
      if (b !== c) { degree[b]++; degree[c]++; }
      if (c !== a) { degree[c]++; degree[a]++; }
    }
    const csrStart = new Uint32Array(nodeCount + 1);
    for (let id = 0; id < nodeCount; id++) csrStart[id + 1] = csrStart[id] + degree[id];
    const totalEdges = csrStart[nodeCount];
    const neighbors = new Uint32Array(totalEdges);
    const cursor = new Uint32Array(nodeCount);
    for (let t = 0; t < count; t += 3) {
      const a = nodeOf(t), b = nodeOf(t + 1), c = nodeOf(t + 2);
      if (a !== b) { neighbors[csrStart[a] + cursor[a]++] = b; neighbors[csrStart[b] + cursor[b]++] = a; }
      if (b !== c) { neighbors[csrStart[b] + cursor[b]++] = c; neighbors[csrStart[c] + cursor[c]++] = b; }
      if (c !== a) { neighbors[csrStart[c] + cursor[c]++] = a; neighbors[csrStart[a] + cursor[a]++] = c; }
    }

    // Laplacian smoothing on a writable copy. Read from current, write to
    // next, swap. Each iteration: average over neighbours, re-normalise.
    let curX = new Float64Array(initX);
    let curY = new Float64Array(initY);
    let curZ = new Float64Array(initZ);
    let nxtX = new Float64Array(nodeCount);
    let nxtY = new Float64Array(nodeCount);
    let nxtZ = new Float64Array(nodeCount);

    for (let iter = 0; iter < blendNrmIters; iter++) {
      for (let id = 0; id < nodeCount; id++) {
        const s = csrStart[id], e = csrStart[id + 1];
        if (e === s) {
          nxtX[id] = curX[id]; nxtY[id] = curY[id]; nxtZ[id] = curZ[id];
          continue;
        }
        let sx = 0, sy = 0, sz = 0;
        for (let k = s; k < e; k++) {
          const nb = neighbors[k];
          sx += curX[nb]; sy += curY[nb]; sz += curZ[nb];
        }
        const inv = 1 / (e - s);
        sx *= inv; sy *= inv; sz *= inv;
        const len = Math.sqrt(sx*sx + sy*sy + sz*sz);
        if (len > 1e-12) {
          const r = 1 / len;
          nxtX[id] = sx * r; nxtY[id] = sy * r; nxtZ[id] = sz * r;
        } else {
          // Neighbour normals cancelled (knife-edge) — keep current.
          nxtX[id] = curX[id]; nxtY[id] = curY[id]; nxtZ[id] = curZ[id];
        }
      }
      const tx = curX, ty = curY, tz = curZ;
      curX = nxtX; curY = nxtY; curZ = nxtZ;
      nxtX = tx;   nxtY = ty;   nxtZ = tz;
    }
    blendNrmX = curX; blendNrmY = curY; blendNrmZ = curZ;
  }
  if (creases) creases.groupOf = null; // per corner; only the graph above needed it

  // ── Composite displacement per unique position ────────────────────────────
  // Layers are folded in one at a time: sample the layer's height map at
  // every welded vertex, then combine it with what the layers below already
  // produced. Per-layer scratch arrays are released after each fold.
  const acc = new Float64Array(uniqueCount);
  // The same, per smooth group of every crease position: each group is
  // sampled with its own face normal (so each face's texture runs straight
  // up to the edge) and composited like any other position.
  const groupAcc = creases ? new Float64Array(creases.groupCount) : null;

  for (let li = 0; li < layers.length; li++) {
    const layer = layers[li];
    const lset = layer.settings;
    const { imageData, imgWidth, imgHeight } = layer;

    // Texture aspect correction so non-square textures keep their proportions.
    // The shorter axis gets aspect > 1 so it tiles faster, making each tile
    // proportionally shorter in world-space to match the texture's content.
    const tmax = Math.max(imgWidth, imgHeight, 1);
    const aspectU = tmax / Math.max(imgWidth, 1);
    const aspectV = tmax / Math.max(imgHeight, 1);
    const settingsWithAspect = { ...lset, textureAspectU: aspectU, textureAspectV: aspectV };

    // Positions this layer pins at zero: faces no layer textures / angle-
    // masked faces (excludedPos, from excludeWeight) plus the layer's own
    // hard mask. The legacy layer's hard mask is excludedPos itself.
    const hardPos = layer._hardPos;
    const isPinned = (id) => (excludedPos && excludedPos[id] === 1) || (hardPos && hardPos[id] === 1);

    const falloffArr = _buildFalloffField(
      layer, lset, uniqueCount, maskedFracMasked, maskedFracTotal, isPinned, idPosX, idPosY, idPosZ);

    // ── Pass 2: sample displacement texture once per unique position ────────
    const dispCacheVal = new Float64Array(uniqueCount);
    const dispCacheSet = new Uint8Array(uniqueCount);
    const groupGrey = creases ? new Float64Array(creases.groupCount) : null;

    const md = Math.max(bounds.size.x, bounds.size.y, bounds.size.z, 1e-6);
    const relScale = scaleMmToRelative(6, lset, bounds);
    const rotRad = (lset.rotation ?? 0) * Math.PI / 180;
    const cubicBlend = lset.mappingBlend ?? 0;
    const cubicBandWidth = lset.seamBandWidth ?? 0.35;
    const cubicGrey = (wX, wY, wZ, fx, fy, fz) => _cubicGrey(
      imageData.data, imgWidth, imgHeight, tmpPos, wX, wY, wZ, fx, fy, fz,
      bounds, md, relScale, lset, rotRad, aspectU, aspectV);

    for (let i = 0; i < count; i++) {
      const vid = vertexId[i];
      if (dispCacheSet[vid]) continue;
      dispCacheSet[vid] = 1;

      tmpPos.fromBufferAttribute(posAttr, i);

      // Crease position: one sample per face group meeting here, each with
      // that group's (smoothed) blend normal and its own normal for the
      // mirror decisions — never the averaged edge normal.
      const slot = creases ? creases.slotOf[vid] : -1;
      if (slot >= 0) {
        for (let g = 0; g < creases.groups[slot]; g++) {
          const k = creases.start[slot] + g;
          const node = _groupNode(creases, uniqueCount, slot, g);
          if (lset.mappingMode === 6 /* MODE_CUBIC */) {
            const w = getCubicBlendWeights(
              { x: blendNrmX[node], y: blendNrmY[node], z: blendNrmZ[node] }, cubicBlend, cubicBandWidth);
            groupGrey[k] = cubicGrey(w.x, w.y, w.z, creases.nrmX[k], creases.nrmY[k], creases.nrmZ[k]);
          } else {
            tmpNrm.set(blendNrmX[node], blendNrmY[node], blendNrmZ[node]);
            groupGrey[k] = _projectedGrey(imageData.data, imgWidth, imgHeight, tmpPos, tmpNrm,
              lset.mappingMode, settingsWithAspect, bounds);
          }
        }
        continue;
      }

      // Cubic: derive blend weights from the *smooth* per-vertex normal so that
      // adjacent vertices on a curved region (small fillets, rolled edges) see
      // smoothly varying weights — this matches the per-fragment behaviour of
      // the preview shader. The previous implementation summed per-face zone
      // weights into per-vertex zoneArea[X|Y|Z]; on small fillets those sums
      // change abruptly between neighbours because each face's dominant-axis
      // membership is binary, which produced jagged "needle" displacement.
      //
      // The thin-plate edge case (top + bottom face normals cancel at a shared
      // knife-edge vertex, leaving the smooth normal nearly zero) still needs
      // the per-face zoneArea path. We detect that via smoothNrmReliability —
      // length(rawSmoothNormal) / totalFaceArea, in [0, 1]. Surfaces with all
      // normals broadly aligned read ≈1; perfectly cancelling pairs read 0.
      // 0.5 is loose enough that a 90° cube edge (≈0.71) still uses the smooth
      // path, but a near-180° fold falls back to face-area zones.
      if (lset.mappingMode === 6 /* MODE_CUBIC */) {
        let wX = 0, wY = 0, wZ = 0;
        if (smoothNrmReliability[vid] > 0.5) {
          const sn = { x: blendNrmX[vid], y: blendNrmY[vid], z: blendNrmZ[vid] };
          const w = getCubicBlendWeights(sn, cubicBlend, cubicBandWidth);
          wX = w.x; wY = w.y; wZ = w.z;
        } else {
          const zaX = layer._zoneAreaX[vid], zaY = layer._zoneAreaY[vid], zaZ = layer._zoneAreaZ[vid];
          const total = zaX + zaY + zaZ;
          if (total > 0) { wX = zaX/total; wY = zaY/total; wZ = zaZ/total; }
        }

        if (wX + wY + wZ > 0) {
          // U-flip uses the *original* smoothNrm — it's a discrete sign decision
          // about which face of the cube this vertex sits on. The smoothed blend
          // normal can have small components flip sign during Laplacian smoothing
          // (e.g. for vertices near the equator x≈0), which would mirror their
          // texture sample relative to the true surface orientation.
          dispCacheVal[vid] = cubicGrey(wX, wY, wZ, smoothNrmX[vid], smoothNrmY[vid], smoothNrmZ[vid]);
          continue;
        }
      }

      // Triplanar / cylindrical seam blends use the SMOOTHED blend normal so
      // adjacent vertices in a blend zone don't see jittery weights driven by
      // mesh-noise. Other modes ignore the normal for blending, so this is a
      // no-op there. Displacement direction (Pass 3) stays on the unsmoothed
      // smooth normal — only blend weights change here.
      tmpNrm.set(blendNrmX[vid], blendNrmY[vid], blendNrmZ[vid]);
      dispCacheVal[vid] = _projectedGrey(imageData.data, imgWidth, imgHeight, tmpPos, tmpNrm,
        lset.mappingMode, settingsWithAspect, bounds);
    }

    // ── Fold this layer into the composite ──────────────────────────────────
    // User-excluded positions get zero displacement; only angle-based masking
    // uses the smooth per-vertex blend so neighbours are never unintentionally
    // dimmed. Pinning the positions an excluded face shares with its included
    // neighbours seals the open crack at the mask boundary so the mesh stays
    // watertight and the decimator cannot collapse the excluded patch to zero
    // faces.
    const softMax = layer._softMax;
    const symmetric = !!lset.symmetricDisplacement;
    const amplitude = lset.amplitude;
    const blendAdd = !!layer.blendAdd;
    for (let vid = 0; vid < uniqueCount; vid++) {
      const grey = dispCacheVal[vid];
      const pinned = isPinned(vid);
      const mfTotal = maskedFracTotal[vid];
      const maskedFrac = mfTotal > 0 ? maskedFracMasked[vid] / mfTotal : 0;
      const centeredGrey = symmetric ? (grey - 0.5) : grey;
      const falloffFactor = falloffArr ? falloffArr[vid] : 1.0;
      let disp = pinned ? 0 : falloffFactor * (1 - maskedFrac) * centeredGrey * amplitude;
      if (softMax) disp *= 1 - softMax[vid];
      if (li === 0) {
        acc[vid] = disp;
      } else if (blendAdd) {
        acc[vid] += disp;
      } else {
        // "Over": where this layer covers, the layers below fade out.
        const cover = pinned ? 0 : (softMax ? 1 - softMax[vid] : 1);
        acc[vid] = acc[vid] * (1 - cover) + disp;
      }
    }
    // Crease groups fold the same way; angle masking is per group (a face
    // group is masked or it isn't), everything else is per position.
    if (creases) {
      for (let s = 0; s < creases.count; s++) {
        if (!creases.active[s]) continue;
        const vid = creases.vidOf[s];
        const pinned = isPinned(vid);
        const falloffFactor = falloffArr ? falloffArr[vid] : 1.0;
        for (let g = 0; g < creases.groups[s]; g++) {
          const k = creases.start[s] + g;
          const gArea = creases.area[k];
          const maskedFrac = gArea > 0 ? creases.masked[k] / gArea : 0;
          const centeredGrey = symmetric ? (groupGrey[k] - 0.5) : groupGrey[k];
          let disp = pinned ? 0 : falloffFactor * (1 - maskedFrac) * centeredGrey * amplitude;
          if (softMax) disp *= 1 - softMax[vid];
          if (li === 0) {
            groupAcc[k] = disp;
          } else if (blendAdd) {
            groupAcc[k] += disp;
          } else {
            const cover = pinned ? 0 : (softMax ? 1 - softMax[vid] : 1);
            groupAcc[k] = groupAcc[k] * (1 - cover) + disp;
          }
        }
      }
    }

    layer._softMax = null; layer._hardPos = null;
    layer._zoneAreaX = layer._zoneAreaY = layer._zoneAreaZ = null;
    if (onProgress) onProgress(0.5 * (li + 1) / layers.length);
  }

  // ── Pass 3: displace every vertex copy by the same vector ─────────────────
  // Using the smooth normal for the displacement direction ensures all copies
  // of the same position land at exactly the same 3-D point.

  const REPORT_EVERY = 5000;
  const moves = creases ? _creaseMoves(creases, groupAcc, smoothNrmX, smoothNrmY, smoothNrmZ) : null;

  for (let i = 0; i < count; i++) {
    tmpPos.fromBufferAttribute(posAttr, i);
    tmpNrm.fromBufferAttribute(nrmAttr, i);

    const vid  = vertexId[i];
    const disp = acc[vid];
    const mfTotal = maskedFracTotal[vid];
    const maskedFrac = mfTotal > 0 ? maskedFracMasked[vid] / mfTotal : 0;

    const slot = creases ? creases.slotOf[vid] : -1;
    const newX = tmpPos.x + (slot >= 0 ? moves[slot * 3]     : smoothNrmX[vid] * disp);
    const newY = tmpPos.y + (slot >= 0 ? moves[slot * 3 + 1] : smoothNrmY[vid] * disp);
    let   newZ = tmpPos.z + (slot >= 0 ? moves[slot * 3 + 2] : smoothNrmZ[vid] * disp);

    // Prevent boundary vertices from poking through the masked surface in Z.
    // Only triggers for vertices that are partly masked (maskedFrac > 0) and
    // whose displacement would push them toward the masked surface direction.
    if (maskedFrac > 0) {
      if (settings.bottomAngleLimit > 0 && newZ < tmpPos.z) newZ = tmpPos.z;
      if (settings.topAngleLimit    > 0 && newZ > tmpPos.z) newZ = tmpPos.z;
    }

    // Overhang protection: never move a vertex below its original Z. X/Y
    // displacement is preserved so surface texture detail still appears,
    // it just gets pushed sideways instead of creating a new overhang.
    if (settings.noDownwardZ && newZ < tmpPos.z) newZ = tmpPos.z;

    // Bottom-plane flat clamp: with overhang protection on, also clamp
    // upward motion when the original vertex sat on the print bottom plane.
    // Without this, a downward-facing face (smoothNrm ≈ (0,0,-1)) pulls UP
    // when the texture sample is below mid-grey (centeredGrey < 0 makes
    // smoothNrm × disp positive in Z), so adjacent bottom-face vertices
    // end up at slightly different heights and slicers render the now-
    // tilted triangles with visibly varying shading. The clamp keeps the
    // bed-contact surface a single Z value while leaving any vertex above
    // the bottom plane (side fillets, etc.) free to follow texture detail.
    if (settings.noDownwardZ && tmpPos.z <= bounds.min.z + 1e-5) {
      newZ = tmpPos.z;
    }

    newPos[i*3]   = newX;
    newPos[i*3+1] = newY;
    newPos[i*3+2] = newZ;

    // Keep per-face normal for shading (recomputed below anyway)
    newNrm[i*3]   = tmpNrm.x;
    newNrm[i*3+1] = tmpNrm.y;
    newNrm[i*3+2] = tmpNrm.z;

    if (onProgress && i % REPORT_EVERY === 0) onProgress(0.5 + 0.5 * i / count);
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

// ── Sharp creases ────────────────────────────────────────────────────────────
// Subdivision splits a position into one indexed vertex per smooth group
// (faces within 30° of each other), so at a crease the non-indexed copies of
// one welded position carry different buffer normals. Grouping them again
// gives every face that meets at a crease its own normal: it is sampled with
// that normal (Pass 2) and the position is then moved to where the displaced
// faces meet (_creaseMoves), instead of along the averaged normal.
//
// Returns null when no position has more than one group. Otherwise, per
// candidate slot s (a welded position with ≥ 2 groups; slotOf[vid] = s):
//   groups[s]           number of groups (≤ MAX_GROUPS)
//   groupOf[corner]     group of each corner at a candidate position
//   nrm*, area, masked, in*   per group k = start[s] + g: area-weighted
//                       normal sum, face area, angle-masked area, and the sum
//                       of (triangle centroid − position) — which way the
//                       group's faces lie. Filled by Pass 1.
// _finishCreases then keeps only the sharp ones.
function _findCreases(nrmAttr, vertexId, uniqueCount) {
  const count = vertexId.length;
  const nrm = nrmAttr.array;
  const first = new Int32Array(uniqueCount).fill(-1);
  const cand = new Uint8Array(uniqueCount);
  let nCand = 0;
  for (let i = 0; i < count; i++) {
    const vid = vertexId[i];
    const f = first[vid];
    if (f < 0) { first[vid] = i; continue; }
    if (cand[vid]) continue;
    const dot = nrm[i*3] * nrm[f*3] + nrm[i*3+1] * nrm[f*3+1] + nrm[i*3+2] * nrm[f*3+2];
    if (dot < CREASE_GROUP_COS) { cand[vid] = 1; nCand++; }
  }
  if (nCand === 0) return null;

  const slotOf = new Int32Array(uniqueCount).fill(-1);
  const vidOf = new Uint32Array(nCand);
  for (let vid = 0, s = 0; vid < uniqueCount; vid++) {
    if (cand[vid]) { slotOf[vid] = s; vidOf[s] = vid; s++; }
  }

  const groupOf = new Uint8Array(count);
  const groups = new Uint8Array(nCand);
  const rep = new Float32Array(nCand * MAX_GROUPS * 3);
  for (let i = 0; i < count; i++) {
    const s = slotOf[vertexId[i]];
    if (s < 0) continue;
    const nx = nrm[i*3], ny = nrm[i*3+1], nz = nrm[i*3+2];
    const base = s * MAX_GROUPS;
    let best = -1, bestDot = -Infinity;
    for (let g = 0; g < groups[s]; g++) {
      const r = (base + g) * 3;
      const dot = nx * rep[r] + ny * rep[r+1] + nz * rep[r+2];
      if (dot > bestDot) { bestDot = dot; best = g; }
    }
    // A new group unless one is within the grouping angle; past MAX_GROUPS
    // the corner joins its closest group.
    if ((best < 0 || bestDot < CREASE_GROUP_COS) && groups[s] < MAX_GROUPS) {
      best = groups[s]++;
      const r = (base + best) * 3;
      rep[r] = nx; rep[r+1] = ny; rep[r+2] = nz;
    }
    groupOf[i] = best;
  }

  // Most crease positions have two groups: store them packed, not MAX_GROUPS
  // slots each.
  const start = new Int32Array(nCand + 1);
  for (let s = 0; s < nCand; s++) start[s + 1] = start[s] + groups[s];
  const n = start[nCand];
  return {
    count: nCand, slotOf, vidOf, groupOf, groups, start, groupCount: n,
    nrmX: new Float64Array(n), nrmY: new Float64Array(n), nrmZ: new Float64Array(n),
    inX: new Float64Array(n), inY: new Float64Array(n), inZ: new Float64Array(n),
    area: new Float64Array(n), masked: new Float64Array(n),
    active: null, extraStart: null, extraNodes: 0,
  };
}

// Normalise the group normals, drop candidates whose groups all meet at less
// than the sharp angle (slotOf → -1: they go down the smooth path exactly as
// before), turn the accumulated in-sums into unit directions into each face,
// and number the extra smoothing nodes. Returns false when nothing is sharp.
function _finishCreases(cr) {
  cr.active = new Uint8Array(cr.count);
  cr.extraStart = new Int32Array(cr.count);
  let extra = 0, active = 0;
  for (let s = 0; s < cr.count; s++) {
    const base = cr.start[s];
    const n = cr.groups[s];
    let valid = 0;
    for (let g = 0; g < n; g++) {
      const k = base + g;
      const len = Math.sqrt(cr.nrmX[k] * cr.nrmX[k] + cr.nrmY[k] * cr.nrmY[k] + cr.nrmZ[k] * cr.nrmZ[k]);
      if (len > 0 && cr.area[k] > 0) {
        cr.nrmX[k] /= len; cr.nrmY[k] /= len; cr.nrmZ[k] /= len;
        valid++;
      } else {
        // Degenerate faces only: no plane to honour.
        cr.area[k] = 0; cr.nrmX[k] = cr.nrmY[k] = cr.nrmZ[k] = 0;
      }
    }
    let minDot = 1;
    for (let a = 0; a < n; a++) {
      const ka = base + a;
      if (!(cr.area[ka] > 0)) continue;
      for (let b = a + 1; b < n; b++) {
        const kb = base + b;
        if (!(cr.area[kb] > 0)) continue;
        const d = cr.nrmX[ka] * cr.nrmX[kb] + cr.nrmY[ka] * cr.nrmY[kb] + cr.nrmZ[ka] * cr.nrmZ[kb];
        if (d < minDot) minDot = d;
      }
    }
    if (valid < 2 || minDot > SHARP_CREASE_COS) {
      cr.slotOf[cr.vidOf[s]] = -1;
      continue;
    }
    cr.active[s] = 1;
    active++;
    cr.extraStart[s] = extra;
    extra += n - 1;

    // With exactly two faces the position sits on one crease line; measure
    // "into the face" straight across it rather than along the average
    // centroid direction, which leans along the line with the triangulation.
    let ex = 0, ey = 0, ez = 0;
    if (valid === 2) {
      let ka = -1, kb = -1;
      for (let g = 0; g < n; g++) {
        if (cr.area[base + g] > 0) { if (ka < 0) ka = base + g; else kb = base + g; }
      }
      ex = cr.nrmY[ka] * cr.nrmZ[kb] - cr.nrmZ[ka] * cr.nrmY[kb];
      ey = cr.nrmZ[ka] * cr.nrmX[kb] - cr.nrmX[ka] * cr.nrmZ[kb];
      ez = cr.nrmX[ka] * cr.nrmY[kb] - cr.nrmY[ka] * cr.nrmX[kb];
      const el = Math.sqrt(ex * ex + ey * ey + ez * ez);
      if (el > 1e-9) { ex /= el; ey /= el; ez /= el; } else { ex = ey = ez = 0; }
    }
    for (let g = 0; g < n; g++) {
      const k = base + g;
      let tx = cr.inX[k], ty = cr.inY[k], tz = cr.inZ[k];
      const tn = tx * cr.nrmX[k] + ty * cr.nrmY[k] + tz * cr.nrmZ[k];
      tx -= tn * cr.nrmX[k]; ty -= tn * cr.nrmY[k]; tz -= tn * cr.nrmZ[k];
      const te = tx * ex + ty * ey + tz * ez;
      tx -= te * ex; ty -= te * ey; tz -= te * ez;
      const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
      if (cr.area[k] > 0 && tl > 1e-12) {
        cr.inX[k] = tx / tl; cr.inY[k] = ty / tl; cr.inZ[k] = tz / tl;
      } else {
        cr.inX[k] = cr.inY[k] = cr.inZ[k] = 0;
      }
    }
  }
  cr.extraNodes = extra;
  return active > 0;
}

// Blend-smoothing node of corner i: its welded position, or — on a sharp
// crease — one node per group (group 0 keeps the position's own id).
function _nodeOf(cr, vertexId, uniqueCount, i) {
  const vid = vertexId[i];
  const s = cr.slotOf[vid];
  if (s < 0) return vid;
  const g = cr.groupOf[i];
  return g === 0 ? vid : uniqueCount + cr.extraStart[s] + g - 1;
}

function _groupNode(cr, uniqueCount, s, g) {
  return g === 0 ? cr.vidOf[s] : uniqueCount + cr.extraStart[s] + g - 1;
}

// Displacement vector of every sharp crease position (xyz per slot).
//
// Each face group g wants its displaced surface at height h_g along its own
// normal n_g. The mitred position satisfies all of them — d·n_g = h_g — which
// on a 90° cube edge is d = h_A n_A + h_B n_B: both faces keep their full
// height right up to the edge, and the edge becomes the line where the two
// displaced faces meet. Solved in the least-squares sense (more groups at
// corners) with a small pull toward the old smooth-normal move to pin the
// directions the planes leave open.
//
// Two guards keep it well-behaved where the planes' meeting line lies away
// from the original edge:
//  * no intrusion — the position may not move INTO a face it bounds (along
//    that face, away from the edge), or it would pass the face's own nearby
//    vertices and fold the surface. That happens on concave edges, on
//    obtuse convex ones where one face rises well above the other, and with
//    symmetric displacement where one face sinks. The offending component
//    is removed: a convex edge then sits on the higher face's plane, a
//    concave one stays on its original line (a crisp inside corner).
//  * mitre limit — capped at MITER_LIMIT × the largest group height, so
//    acute wedges get bevelled instead of growing long spikes.
function _creaseMoves(cr, groupAcc, snX, snY, snZ) {
  const out = new Float64Array(cr.count * 3);
  for (let s = 0; s < cr.count; s++) {
    if (!cr.active[s]) continue;
    const base = cr.start[s];
    const n = cr.groups[s];

    let hSum = 0, aSum = 0, hMax = 0;
    for (let g = 0; g < n; g++) {
      const k = base + g;
      const a = cr.area[k];
      if (!(a > 0)) continue;
      const h = groupAcc[k];
      hSum += a * h; aSum += a;
      if (Math.abs(h) > hMax) hMax = Math.abs(h);
    }
    if (hMax === 0) continue;
    const vid = cr.vidOf[s];
    const hMean = aSum > 0 ? hSum / aSum : 0;
    const d0x = snX[vid] * hMean, d0y = snY[vid] * hMean, d0z = snZ[vid] * hMean;

    let m00 = MITER_RIDGE, m01 = 0, m02 = 0, m11 = MITER_RIDGE, m12 = 0, m22 = MITER_RIDGE;
    let rx = MITER_RIDGE * d0x, ry = MITER_RIDGE * d0y, rz = MITER_RIDGE * d0z;
    for (let g = 0; g < n; g++) {
      const k = base + g;
      if (!(cr.area[k] > 0)) continue;
      const nx = cr.nrmX[k], ny = cr.nrmY[k], nz = cr.nrmZ[k], h = groupAcc[k];
      m00 += nx * nx; m01 += nx * ny; m02 += nx * nz;
      m11 += ny * ny; m12 += ny * nz; m22 += nz * nz;
      rx += h * nx; ry += h * ny; rz += h * nz;
    }
    const c00 = m11 * m22 - m12 * m12, c01 = m02 * m12 - m01 * m22, c02 = m01 * m12 - m02 * m11;
    const det = m00 * c00 + m01 * c01 + m02 * c02;
    let dx = d0x, dy = d0y, dz = d0z;
    if (Math.abs(det) > 1e-12) {
      const c11 = m00 * m22 - m02 * m02, c12 = m01 * m02 - m00 * m12, c22 = m00 * m11 - m01 * m01;
      dx = (c00 * rx + c01 * ry + c02 * rz) / det;
      dy = (c01 * rx + c11 * ry + c12 * rz) / det;
      dz = (c02 * rx + c12 * ry + c22 * rz) / det;
    }

    for (let round = 0; round < 2; round++) {
      for (let g = 0; g < n; g++) {
        const k = base + g;
        const tx = cr.inX[k], ty = cr.inY[k], tz = cr.inZ[k];
        const dt = dx * tx + dy * ty + dz * tz;
        if (dt > 0) { dx -= dt * tx; dy -= dt * ty; dz -= dt * tz; }
      }
    }

    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const lim = MITER_LIMIT * hMax;
    if (len > lim) {
      const f = lim / len;
      dx *= f; dy *= f; dz *= f;
    }
    out[s * 3] = dx; out[s * 3 + 1] = dy; out[s * 3 + 2] = dz;
  }
  return out;
}

// ── Texture sampling helpers (Pass 2) ────────────────────────────────────────

/** Cubic projection: blend the three axis projections by (wX, wY, wZ); the
 *  sign of (fx, fy, fz) picks each projection's mirror side. */
function _cubicGrey(data, w, h, pos, wX, wY, wZ, fx, fy, fz, bounds, md, relScale, settings, rotRad, aspectU, aspectV) {
  let grey = 0;
  if (wX > 0) { // X-dominant → YZ projection
    let rawU = (pos.y-bounds.min.y)/md;
    if (fx < 0) rawU = -rawU;
    const uv = _cubicUV(rawU, (pos.z-bounds.min.z)/md, relScale, settings, rotRad, aspectU, aspectV);
    grey += sampleBilinear(data, w, h, uv.u, uv.v) * wX;
  }
  if (wY > 0) { // Y-dominant → XZ projection
    let rawU = (pos.x-bounds.min.x)/md;
    if (fy > 0) rawU = -rawU;
    const uv = _cubicUV(rawU, (pos.z-bounds.min.z)/md, relScale, settings, rotRad, aspectU, aspectV);
    grey += sampleBilinear(data, w, h, uv.u, uv.v) * wY;
  }
  if (wZ > 0) { // Z-dominant → XY projection
    let rawU = (pos.x-bounds.min.x)/md;
    if (fz < 0) rawU = -rawU;
    const uv = _cubicUV(rawU, (pos.y-bounds.min.y)/md, relScale, settings, rotRad, aspectU, aspectV);
    grey += sampleBilinear(data, w, h, uv.u, uv.v) * wZ;
  }
  return grey;
}

/** Every other mode: computeUV (mapping.js) with `nrm` as the blend normal. */
function _projectedGrey(data, w, h, pos, nrm, mode, settings, bounds) {
  const uvResult = computeUV(pos, nrm, mode, settings, bounds);
  if (uvResult.triplanar) {
    let grey = 0;
    for (const s of uvResult.samples) grey += sampleBilinear(data, w, h, s.u, s.v) * s.w;
    return grey;
  }
  return sampleBilinear(data, w, h, uvResult.u, uvResult.v);
}

// ── Boundary falloff distance field ──────────────────────────────────────────
// When the layer's boundaryFalloff > 0, identify boundary positions (vertices
// adjacent to both masked and unmasked faces, or on the layer's exclusion
// seam) and compute the Euclidean distance from every fully-textured vertex
// to its nearest boundary position.  The result is Float64Array[uniqueCount]
// where 0 means "at the boundary" and 1 means "at or beyond the falloff
// distance" — or null when the layer has no falloff.
function _buildFalloffField(layer, lset, uniqueCount, maskedFracMasked, maskedFracTotal, isPinned, idPosX, idPosY, idPosZ) {
  const boundaryFalloff = lset.boundaryFalloff ?? 0;
  if (!(boundaryFalloff > 0)) return null;

  // Collect boundary positions in a single pass, using upper-bound-sized
  // Float64Arrays and subarray() views to avoid double-iteration over uniqueCount.
  const bpXFull = new Float64Array(uniqueCount);
  const bpYFull = new Float64Array(uniqueCount);
  const bpZFull = new Float64Array(uniqueCount);
  let bpCount = 0;
  let gMinX = Infinity, gMinY = Infinity, gMinZ = Infinity;
  let gMaxX = -Infinity, gMaxY = -Infinity, gMaxZ = -Infinity;
  for (let id = 0; id < uniqueCount; id++) {
    const mfTotal = maskedFracTotal[id];
    const maskedFrac = mfTotal > 0 ? maskedFracMasked[id] / mfTotal : 0;
    const isOnExclBoundary = isPinned(id);
    if (isOnExclBoundary || (maskedFrac > 0 && maskedFrac < 1)) {
      const x = idPosX[id], y = idPosY[id], z = idPosZ[id];
      bpXFull[bpCount] = x; bpYFull[bpCount] = y; bpZFull[bpCount] = z;
      if (x < gMinX) gMinX = x; if (x > gMaxX) gMaxX = x;
      if (y < gMinY) gMinY = y; if (y > gMaxY) gMaxY = y;
      if (z < gMinZ) gMinZ = z; if (z > gMaxZ) gMaxZ = z;
      bpCount++;
    }
  }

  if (bpCount === 0) return null;

  const bpX = bpXFull.subarray(0, bpCount);
  const bpY = bpYFull.subarray(0, bpCount);
  const bpZ = bpZFull.subarray(0, bpCount);

  const gPad = boundaryFalloff + 1e-3;
  gMinX -= gPad; gMinY -= gPad; gMinZ -= gPad;
  gMaxX += gPad; gMaxY += gPad; gMaxZ += gPad;

  const gRes = Math.max(4, Math.min(128, Math.ceil(Math.cbrt(bpCount) * 2)));
  const gDx = (gMaxX - gMinX) / gRes || 1;
  const gDy = (gMaxY - gMinY) / gRes || 1;
  const gDz = (gMaxZ - gMinZ) / gRes || 1;
  const invDx = 1 / gDx, invDy = 1 / gDy, invDz = 1 / gDz;
  const gridSize = gRes * gRes * gRes;
  const gResMax = gRes - 1;

  // CSR-style spatial grid: cellStart/cellIdx give each cell a contiguous
  // slice of boundary indices. Replaces per-cell JS arrays with flat typed
  // arrays — no per-cell allocations, tight inner loop, better prefetching.
  const cellCount = new Uint32Array(gridSize);
  const bpCell = new Uint32Array(bpCount);
  for (let i = 0; i < bpCount; i++) {
    let ix = (bpX[i] - gMinX) * invDx | 0; if (ix < 0) ix = 0; else if (ix > gResMax) ix = gResMax;
    let iy = (bpY[i] - gMinY) * invDy | 0; if (iy < 0) iy = 0; else if (iy > gResMax) iy = gResMax;
    let iz = (bpZ[i] - gMinZ) * invDz | 0; if (iz < 0) iz = 0; else if (iz > gResMax) iz = gResMax;
    const ck = (ix * gRes + iy) * gRes + iz;
    bpCell[i] = ck;
    cellCount[ck]++;
  }
  const cellStart = new Uint32Array(gridSize + 1);
  for (let c = 0; c < gridSize; c++) cellStart[c + 1] = cellStart[c] + cellCount[c];
  const cursor = new Uint32Array(gridSize);
  const cellIdx = new Uint32Array(bpCount);
  for (let i = 0; i < bpCount; i++) {
    const ck = bpCell[i];
    cellIdx[cellStart[ck] + cursor[ck]++] = i;
  }

  // How many grid cells to search in each direction to cover boundaryFalloff distance
  const searchX = Math.ceil(boundaryFalloff * invDx);
  const searchY = Math.ceil(boundaryFalloff * invDy);
  const searchZ = Math.ceil(boundaryFalloff * invDz);
  const maxDist2 = boundaryFalloff * boundaryFalloff;
  const invFalloff = 1 / boundaryFalloff;
  // Transition curve shaping the 0→1 ramp — must match applyFalloffCurve
  // in main.js and the fragment shader in previewMaterial.js.
  const falloffCurve = lset.boundaryFalloffCurve ?? 'linear';

  const falloffArr = new Float64Array(uniqueCount);
  falloffArr.fill(1); // default: full displacement
  for (let id = 0; id < uniqueCount; id++) {
    const mfTotal = maskedFracTotal[id];
    const maskedFrac = mfTotal > 0 ? maskedFracMasked[id] / mfTotal : 0;
    const isOnExclBoundary = isPinned(id);
    // Only compute falloff for fully-textured, non-boundary positions
    if (maskedFrac > 0 || isOnExclBoundary) continue;

    const px = idPosX[id], py = idPosY[id], pz = idPosZ[id];
    let cix = (px - gMinX) * invDx | 0; if (cix < 0) cix = 0; else if (cix > gResMax) cix = gResMax;
    let ciy = (py - gMinY) * invDy | 0; if (ciy < 0) ciy = 0; else if (ciy > gResMax) ciy = gResMax;
    let ciz = (pz - gMinZ) * invDz | 0; if (ciz < 0) ciz = 0; else if (ciz > gResMax) ciz = gResMax;

    const nixLo = Math.max(0, cix - searchX), nixHi = Math.min(gResMax, cix + searchX);
    const niyLo = Math.max(0, ciy - searchY), niyHi = Math.min(gResMax, ciy + searchY);
    const nizLo = Math.max(0, ciz - searchZ), nizHi = Math.min(gResMax, ciz + searchZ);

    let minDist2 = maxDist2;
    for (let nix = nixLo; nix <= nixHi; nix++) {
      const baseX = nix * gRes;
      for (let niy = niyLo; niy <= niyHi; niy++) {
        const baseXY = (baseX + niy) * gRes;
        for (let niz = nizLo; niz <= nizHi; niz++) {
          const ck = baseXY + niz;
          const end = cellStart[ck + 1];
          for (let k = cellStart[ck]; k < end; k++) {
            const idx = cellIdx[k];
            const dx = px - bpX[idx], dy = py - bpY[idx], dz = pz - bpZ[idx];
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < minDist2) minDist2 = d2;
          }
        }
      }
    }
    if (minDist2 < maxDist2) {
      const t = Math.sqrt(minDist2) * invFalloff;
      falloffArr[id] = falloffCurve === 'scurve' ? t * t * (3 - 2 * t)
                     : falloffCurve === 'ease'   ? t * t
                     : t;
    }
  }
  return falloffArr;
}

// ── Bilinear sampler ─────────────────────────────────────────────────────────

/**
 * Sample a greyscale value (0–1) from raw RGBA ImageData using
 * bilinear interpolation. UV is tiled via mod 1.
 *
 * GL-exact (June 2026): texel centers sit at (i + 0.5) / w and the bilinear
 * neighbourhood WRAPS — matching texture2D with RepeatWrapping, which is what
 * the GPU preview shader samples. The previous u * (w - 1) mapping with
 * clamped neighbours stretched each tile by one texel, so at every tile
 * boundary the texture's first and last texel column both appeared ("start
 * and end overlap") and the bilinear blend never wrapped — a visible seam
 * groove on the exported mesh that the preview (correctly wrapping on the
 * GPU) never showed.
 */
function sampleBilinear(data, w, h, u, v) {
  // Ensure [0,1) — guard against floating-point edge cases
  u = ((u % 1) + 1) % 1;
  v = ((v % 1) + 1) % 1;
  // Flip V to match WebGL/Three.js texture convention (flipY=true means
  // v=0 is the bottom of the image, but ImageData row 0 is the top).
  v = 1 - v;

  const fx = u * w - 0.5;
  const fy = v * h - 0.5;
  let x0 = Math.floor(fx);
  let y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const x1 = (x0 + 1 + w) % w;
  const y1 = (y0 + 1 + h) % h;
  x0 = ((x0 % w) + w) % w;
  y0 = ((y0 % h) + h) % h;

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
 *  Mirrors the private applyTransform helper in mapping.js. `relScale` is the
 *  mm→relative conversion from scaleMmToRelative (constant per export). */
function _cubicUV(rawU, rawV, relScale, settings, rotRad, aspectU, aspectV) {
  let u = (rawU * aspectU) / relScale.u + settings.offsetU;
  let v = (rawV * aspectV) / relScale.v + settings.offsetV;
  if (rotRad !== 0) {
    const c = Math.cos(rotRad), s = Math.sin(rotRad);
    u -= 0.5; v -= 0.5;
    const ru = c*u - s*v, rv = s*u + c*v;
    u = ru + 0.5; v = rv + 0.5;
  }
  return { u: u - Math.floor(u), v: v - Math.floor(v) };
}
