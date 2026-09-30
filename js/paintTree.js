/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * paintTree.js — adaptive surface painting on a per-triangle split tree,
 * after PrusaSlicer's TriangleSelector (AGPL-3.0, like this project).
 *
 * The base mesh is never modified. Every base triangle is the root of a tree;
 * the circle brush splits the triangles it only partly covers along their
 * long edges (1, 2 or 3 edges → 2, 3 or 4 children, the same scheme as
 * subdivision.js) until the edges are shorter than the brush's edge limit
 * (radius / 5 for a hard brush), so a stroke has the same resolution on a
 * 12-triangle cube as on a scanned statue. Fully covered triangles are
 * painted whole; after every dab, children that came out uniform are merged
 * back into their parent, so the tree only keeps detail along mask edges.
 *
 * One tree is shared by all texture layers: the split structure is common,
 * paint is per layer — a hard state per node (painted or not) and, for the
 * soft brush, a coverage value per vertex. Splitting a node hands its state
 * to the children and gives a new midpoint the average coverage of its edge,
 * so no layer changes when another one paints.
 *
 * flatten() turns the leaves into a watertight non-indexed mesh (a neighbour's
 * midpoint hanging on an unsplit edge splits that leaf too, PrusaSlicer's
 * "T-joint" step) with a parent-face map and per-corner paint, which is what
 * the preview shows and the export pipeline refines further.
 *
 * Pure typed-array code, no THREE, no DOM: Node tests and workers can use it.
 */

import { IntPairMap } from './meshIndex.js';
import { brushCoverage } from './softMask.js';

const NO_CHILD = -1;

export class PaintTree {
  /**
   * @param {object} base
   *   positions   Float32Array  base mesh, non-indexed (xyz per corner)
   *   vertId      Uint32Array   welded vertex id per corner (exclusion.js buildAdjacency)
   *   vertCount   number        welded vertex count
   *   adjacency   Array<Array<{neighbor:number}>>  per base face
   *   faceNormals Float32Array  unit face normal per base face (xyz)
   */
  constructor({ positions, vertId, vertCount, adjacency, faceNormals }) {
    this.baseTriCount = positions.length / 9;
    this.baseVertCount = vertCount;
    this.vertId = vertId;
    this.adjacency = adjacency;
    this.faceNormals = faceNormals;
    this.basePositions = positions;

    // Vertices: base welded vertices first, then midpoints.
    this.vertCap = Math.max(64, vertCount * 2);
    this.vx = new Float64Array(this.vertCap);
    this.vy = new Float64Array(this.vertCap);
    this.vz = new Float64Array(this.vertCap);
    this.midRef = new Int32Array(this.vertCap);   // splits currently using this midpoint
    this.vertCount = vertCount;
    for (let i = 0; i < vertId.length; i++) {
      const v = vertId[i];
      this.vx[v] = positions[i * 3]; this.vy[v] = positions[i * 3 + 1]; this.vz[v] = positions[i * 3 + 2];
    }
    // Per-corner base normals for flatten's interpolated normals (optional).
    this.baseNormals = null;

    // Nodes: roots are the base faces (node id === face id).
    this.nodeCap = Math.max(64, this.baseTriCount * 2);
    this.nv = new Int32Array(this.nodeCap * 3);
    this.nChild = new Int32Array(this.nodeCap).fill(NO_CHILD);
    this.nCode = new Uint8Array(this.nodeCap);      // split code: edge mask (bits 0-2) | diagonal (bit 3); 0 = leaf
    this.nRoot = new Int32Array(this.nodeCap);      // base face of the node
    this.nodeCount = this.baseTriCount;
    for (let f = 0; f < this.baseTriCount; f++) {
      this.nv[f * 3] = vertId[f * 3]; this.nv[f * 3 + 1] = vertId[f * 3 + 1]; this.nv[f * 3 + 2] = vertId[f * 3 + 2];
      this.nRoot[f] = f;
    }
    this.garbage = 0;   // orphaned nodes since the last compaction

    // Midpoint map: sorted vertex pair → midpoint vertex id.
    this.mid = new IntPairMap(Math.max(256, this.baseTriCount));

    /** Layers: [{ id, state: Uint8Array(nodeCap), cov: Float32Array(vertCap)|null }] */
    this.layers = [];
    this.structureVersion = 0;   // bumps on split / merge / deserialize
    this.paintVersion = 0;       // bumps on any paint change
  }

  // ── Layers ────────────────────────────────────────────────────────────────

  addLayer(id) {
    if (this.layerSlot(id) >= 0) return this.layerSlot(id);
    this.layers.push({ id, state: new Uint8Array(this.nodeCap), cov: null });
    return this.layers.length - 1;
  }

  removeLayer(id) {
    const s = this.layerSlot(id);
    if (s < 0) return;
    this.layers.splice(s, 1);
    this._mergeAll();
  }

  layerSlot(id) {
    for (let i = 0; i < this.layers.length; i++) if (this.layers[i].id === id) return i;
    return -1;
  }

  /** Forget every stroke of a layer. */
  clearLayer(slot) {
    const L = this.layers[slot];
    if (!L) return;
    L.state.fill(0);
    L.cov = null;
    this.paintVersion++;
    this._mergeAll();
  }

  hasPaint(slot) {
    const L = this.layers[slot];
    if (!L) return false;
    for (let n = 0; n < this.nodeCount; n++) if (L.state[n] && this._isLive(n)) return true;
    if (L.cov) for (let v = 0; v < this.vertCount; v++) if (L.cov[v] > 0) return true;
    return false;
  }

  // ── Storage growth ────────────────────────────────────────────────────────

  _growNodes(need) {
    if (this.nodeCount + need <= this.nodeCap) return;
    let cap = this.nodeCap;
    while (cap < this.nodeCount + need) cap *= 2;
    const nv = new Int32Array(cap * 3); nv.set(this.nv); this.nv = nv;
    const nc = new Int32Array(cap).fill(NO_CHILD); nc.set(this.nChild); this.nChild = nc;
    const cd = new Uint8Array(cap); cd.set(this.nCode); this.nCode = cd;
    const nr = new Int32Array(cap); nr.set(this.nRoot); this.nRoot = nr;
    for (const L of this.layers) { const s = new Uint8Array(cap); s.set(L.state); L.state = s; }
    this.nodeCap = cap;
  }

  _growVerts(need) {
    if (this.vertCount + need <= this.vertCap) return;
    let cap = this.vertCap;
    while (cap < this.vertCount + need) cap *= 2;
    const gx = new Float64Array(cap); gx.set(this.vx); this.vx = gx;
    const gy = new Float64Array(cap); gy.set(this.vy); this.vy = gy;
    const gz = new Float64Array(cap); gz.set(this.vz); this.vz = gz;
    const mr = new Int32Array(cap); mr.set(this.midRef); this.midRef = mr;
    for (const L of this.layers) { if (L.cov) { const c = new Float32Array(cap); c.set(L.cov); L.cov = c; } }
    this.vertCap = cap;
  }

  _ensureCov(L) {
    if (!L.cov) L.cov = new Float32Array(this.vertCap);
    return L.cov;
  }

  // ── Splitting ─────────────────────────────────────────────────────────────

  /** Midpoint vertex of edge (a,b), shared with the neighbour across it. */
  _midpoint(a, b) {
    const lo = a < b ? a : b, hi = a < b ? b : a;
    const existing = this.mid.get(lo, hi);
    if (existing >= 0) {
      // A midpoint nobody uses any more comes back with fresh coverage: its
      // stored values date from before its edge was merged away.
      if (this.midRef[existing] === 0) {
        for (const L of this.layers) if (L.cov) L.cov[existing] = (L.cov[a] + L.cov[b]) * 0.5;
      }
      return existing;
    }
    this._growVerts(1);
    const v = this.vertCount++;
    this.vx[v] = (this.vx[a] + this.vx[b]) * 0.5;
    this.vy[v] = (this.vy[a] + this.vy[b]) * 0.5;
    this.vz[v] = (this.vz[a] + this.vz[b]) * 0.5;
    this.midRef[v] = 0;
    for (const L of this.layers) {
      if (L.cov) L.cov[v] = (L.cov[a] + L.cov[b]) * 0.5;
    }
    this.mid.getOrSet(lo, hi, v);
    return v;
  }

  _activeMidpoint(a, b) {
    const lo = a < b ? a : b, hi = a < b ? b : a;
    const v = this.mid.get(lo, hi);
    return (v >= 0 && this.midRef[v] > 0) ? v : -1;
  }

  _edgeLen2(a, b) {
    const dx = this.vx[a] - this.vx[b], dy = this.vy[a] - this.vy[b], dz = this.vz[a] - this.vz[b];
    return dx * dx + dy * dy + dz * dz;
  }

  /**
   * Split node `n` on the edges in `mask` (bit0: v0-v1, bit1: v1-v2, bit2:
   * v2-v0). `diag` picks the diagonal of the two-edge case (0/1; -1 = the
   * shorter one). Children inherit every layer's state. Returns the first
   * child id; children are contiguous.
   */
  _split(n, mask, diag = -1) {
    if (this.nChild[n] !== NO_CHILD || mask === 0) return this.nChild[n];
    const b = n * 3;
    let a0 = this.nv[b], a1 = this.nv[b + 1], a2 = this.nv[b + 2];
    // Rotate so the pattern is canonical: 1 edge → the split edge is (a0,a1);
    // 2 edges → the unsplit edge is (a2,a0). Rotation keeps the winding.
    let rot = 0;
    const bits = ((mask & 1) ? 1 : 0) + ((mask & 2) ? 1 : 0) + ((mask & 4) ? 1 : 0);
    if (bits === 1) rot = mask === 1 ? 0 : mask === 2 ? 1 : 2;
    else if (bits === 2) rot = mask === 3 ? 0 : mask === 6 ? 1 : 2;   // unsplit edge: 4 → rot 0, 1 → rot 1, 2 → rot 2
    for (let r = 0; r < rot; r++) { const t = a0; a0 = a1; a1 = a2; a2 = t; }

    const kids = [];   // child vertex triples
    if (bits === 1) {
      const m = this._midpoint(a0, a1); this.midRef[m]++;
      kids.push(a0, m, a2,  m, a1, a2);
    } else if (bits === 2) {
      const m0 = this._midpoint(a0, a1); this.midRef[m0]++;
      const m1 = this._midpoint(a1, a2); this.midRef[m1]++;
      if (diag < 0) diag = this._edgeLen2(a0, m1) <= this._edgeLen2(m0, a2) ? 0 : 1;
      kids.push(m0, a1, m1);
      if (diag === 0) kids.push(a0, m0, m1,  a0, m1, a2);
      else            kids.push(a0, m0, a2,  m0, m1, a2);
    } else {
      const m0 = this._midpoint(a0, a1); this.midRef[m0]++;
      const m1 = this._midpoint(a1, a2); this.midRef[m1]++;
      const m2 = this._midpoint(a2, a0); this.midRef[m2]++;
      kids.push(a0, m0, m2,  m0, a1, m1,  m2, m1, a2,  m0, m1, m2);
    }
    const count = kids.length / 3;
    this._growNodes(count);
    const first = this.nodeCount;
    this.nodeCount += count;
    for (let k = 0; k < count; k++) {
      const c = first + k;
      this.nv[c * 3] = kids[k * 3]; this.nv[c * 3 + 1] = kids[k * 3 + 1]; this.nv[c * 3 + 2] = kids[k * 3 + 2];
      this.nChild[c] = NO_CHILD;
      this.nCode[c] = 0;
      this.nRoot[c] = this.nRoot[n];
      for (const L of this.layers) L.state[c] = L.state[n];
    }
    this.nChild[n] = first;
    this.nCode[n] = mask | ((diag > 0 ? 1 : 0) << 3);
    this.structureVersion++;
    return first;
  }

  _childCount(n) {
    const mask = this.nCode[n] & 7;
    if (mask === 0) return 0;
    return 1 + ((mask & 1) ? 1 : 0) + ((mask & 2) ? 1 : 0) + ((mask & 4) ? 1 : 0);
  }

  /** Merge a node's children back when they are leaves and uniform in every layer. */
  _tryMerge(n) {
    const first = this.nChild[n];
    if (first === NO_CHILD) return false;
    const count = this._childCount(n);
    for (let k = 0; k < count; k++) if (this.nChild[first + k] !== NO_CHILD) return false;
    for (const L of this.layers) {
      const s = L.state[first];
      for (let k = 1; k < count; k++) if (L.state[first + k] !== s) return false;
      if (L.cov) {
        const c = L.cov[this.nv[first * 3]];
        for (let k = 0; k < count; k++) {
          const b = (first + k) * 3;
          if (L.cov[this.nv[b]] !== c || L.cov[this.nv[b + 1]] !== c || L.cov[this.nv[b + 2]] !== c) return false;
        }
      }
    }
    // Collapse: the node takes the children's state, the midpoints lose a user.
    for (const L of this.layers) L.state[n] = L.state[first];
    const mask = this.nCode[n] & 7;
    const b = n * 3;
    const v0 = this.nv[b], v1 = this.nv[b + 1], v2 = this.nv[b + 2];
    if (mask & 1) this.midRef[this._midpoint(v0, v1)]--;
    if (mask & 2) this.midRef[this._midpoint(v1, v2)]--;
    if (mask & 4) this.midRef[this._midpoint(v2, v0)]--;
    this.nChild[n] = NO_CHILD;
    this.nCode[n] = 0;
    this.garbage += count;
    this.structureVersion++;
    return true;
  }

  /** Bottom-up merge over the whole tree (after clears / layer removal). */
  _mergeAll() {
    for (let f = 0; f < this.baseTriCount; f++) this._mergeSubtree(f);
  }

  _mergeSubtree(n) {
    const first = this.nChild[n];
    if (first === NO_CHILD) return;
    const count = this._childCount(n);
    for (let k = 0; k < count; k++) this._mergeSubtree(first + k);
    this._tryMerge(n);
  }

  _setSubtreeState(n, L, value) {
    L.state[n] = value;
    const first = this.nChild[n];
    if (first === NO_CHILD) return;
    const count = this._childCount(n);
    for (let k = 0; k < count; k++) this._setSubtreeState(first + k, L, value);
  }

  _setSubtreeCov(n, cov, value) {
    const b = n * 3;
    cov[this.nv[b]] = value; cov[this.nv[b + 1]] = value; cov[this.nv[b + 2]] = value;
    const first = this.nChild[n];
    if (first === NO_CHILD) return;
    const count = this._childCount(n);
    for (let k = 0; k < count; k++) this._setSubtreeCov(first + k, cov, value);
  }

  // ── Painting ──────────────────────────────────────────────────────────────

  /**
   * Paint (or erase) whole base faces — the fill tool and the single-triangle
   * brush. Hard paint covers every leaf of the face; erasing also wipes soft
   * coverage there.
   */
  paintFaces(slot, faces, erase = false) {
    const L = this.layers[slot];
    if (!L) return;
    for (const f of faces) {
      if (f < 0 || f >= this.baseTriCount) continue;
      this._setSubtreeState(f, L, erase ? 0 : 1);
      if (erase && L.cov) this._setSubtreeCov(f, L.cov, 0);
      this._mergeSubtree(f);
    }
    this.paintVersion++;
  }

  /**
   * One brush dab, or the capsule swept from `from` to `to` (soft brush).
   * Distances are measured in the plane perpendicular to `view` (the screen
   * disk), like the previous circle brush. The walk starts at the base face
   * under the cursor and spreads over front-facing neighbours only, so a thin
   * wall never paints its hidden other side.
   *
   * @param {object} o
   *   slot       layer slot
   *   seedFace   base face under the cursor
   *   from, to   {x,y,z} stroke segment (from = to for a dab)
   *   radius     brush radius (mm)
   *   view       {x,y,z} unit view direction
   *   hardness   1 = hard (paint states); < 1 = soft (paint vertex coverage)
   *   erase      boolean
   *   edgeLimit  split edges longer than this (mm)
   */
  paintStroke(o) {
    const L = this.layers[o.slot];
    if (!L || o.seedFace < 0 || o.seedFace >= this.baseTriCount) return;
    const r = o.radius, r2 = r * r;
    const soft = o.hardness < 1;
    if (soft) this._ensureCov(L);
    // NOTE: read L.cov at use time — splitting can reallocate it.
    const vx = o.view.x, vy = o.view.y, vz = o.view.z;
    const tx = o.to.x, ty = o.to.y, tz = o.to.z;
    // Segment in the view plane through `to`, from s (= projected `from`) to the origin.
    let sx = o.from.x - tx, sy = o.from.y - ty, sz = o.from.z - tz;
    const sAlong = sx * vx + sy * vy + sz * vz;
    sx -= sAlong * vx; sy -= sAlong * vy; sz -= sAlong * vz;
    const segLen2 = sx * sx + sy * sy + sz * sz;
    const segLen = Math.sqrt(segLen2);
    // Squared distance of a point to the segment, measured in the view plane.
    const dist2 = (px, py, pz) => {
      px -= tx; py -= ty; pz -= tz;
      const along = px * vx + py * vy + pz * vz;
      px -= along * vx; py -= along * vy; pz -= along * vz;
      let u = segLen2 > 0 ? (px * sx + py * sy + pz * sz) / segLen2 : 0;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const dx = px - u * sx, dy = py - u * sy, dz = pz - u * sz;
      return dx * dx + dy * dy + dz * dz;
    };
    // Dab centres along the segment (in the view plane) for the overlap test.
    const nDabs = Math.max(1, Math.ceil(segLen / Math.max(r * 0.5, 1e-6)) + 1);
    const dabs = new Float64Array(nDabs * 3);
    for (let i = 0; i < nDabs; i++) {
      const u = nDabs === 1 ? 0 : i / (nDabs - 1);
      dabs[i * 3] = tx + sx * u; dabs[i * 3 + 1] = ty + sy * u; dabs[i * 3 + 2] = tz + sz * u;
    }
    // Soft paint is per vertex and interpolated across each leaf, so the
    // refinement must reach one edge-limit ring beyond the brush: otherwise a
    // rim vertex's coverage would fade across whatever big triangle lies
    // outside. Hard paint is per leaf and needs no halo.
    const rTest = soft ? r + o.edgeLimit : r;
    const reach = rTest + segLen * 0.5;
    const reach2 = reach * reach;
    const mx = tx + sx * 0.5, my = ty + sy * 0.5, mz = tz + sz * 0.5;
    const ctx = { L, soft, erase: !!o.erase, hardness: o.hardness, r, r2, rTest2: rTest * rTest,
                  edgeLimit2: o.edgeLimit * o.edgeLimit,
                  dist2, dabs, nDabs, vx, vy, vz, core2: (r * o.hardness) * (r * o.hardness), d: new Float64Array(3) };

    // BFS over base faces from the seed (front-facing, within reach).
    const adjacency = this.adjacency, faceNormals = this.faceNormals;
    const visited = new Set([o.seedFace]);
    const queue = [o.seedFace];
    const touched = [];
    let head = 0;
    while (head < queue.length) {
      const f = queue[head++];
      // Overlap test of the base face with the stroke's reach disk (any part inside).
      const b = f * 3;
      const d2 = this._triDist2Projected(this.nv[b], this.nv[b + 1], this.nv[b + 2], mx, my, mz, vx, vy, vz);
      if (d2 > reach2) continue;
      touched.push(f);
      const nbrs = adjacency[f];
      if (!nbrs) continue;
      for (let k = 0; k < nbrs.length; k++) {
        const nb = nbrs[k].neighbor;
        if (visited.has(nb)) continue;
        visited.add(nb);
        const nbi = nb * 3;
        const dotN = faceNormals[nbi] * vx + faceNormals[nbi + 1] * vy + faceNormals[nbi + 2] * vz;
        if (dotN >= 0) continue;   // back-facing: the silhouette stops the walk
        queue.push(nb);
      }
    }
    // Refine everything first, paint second: a split made after painting
    // would average a freshly painted vertex with a far one and plant
    // coverage outside the brush.
    for (const f of touched) this._refineNode(f, ctx);
    for (const f of touched) this._paintNode(f, ctx);
    for (const f of touched) this._mergeSubtree(f);
    this.paintVersion++;
  }

  /** Squared distance from a point to a triangle after projecting both onto the plane ⊥ view. */
  _triDist2Projected(a, b, c, px, py, pz, vx, vy, vz) {
    const proj = (v, out, o) => {
      const dx = this.vx[v] - px, dy = this.vy[v] - py, dz = this.vz[v] - pz;
      const along = dx * vx + dy * vy + dz * vz;
      out[o] = dx - along * vx; out[o + 1] = dy - along * vy; out[o + 2] = dz - along * vz;
    };
    const t = _tri9;
    proj(a, t, 0); proj(b, t, 3); proj(c, t, 6);
    return distSqPointToTri(0, 0, 0, t[0], t[1], t[2], t[3], t[4], t[5], t[6], t[7], t[8]);
  }

  /** Squared distance from the stroke (min over dab centres) to node n's projected triangle. */
  _nodeStrokeDist2(n, ctx) {
    const b = n * 3;
    let best = Infinity;
    for (let i = 0; i < ctx.nDabs; i++) {
      const d2 = this._triDist2Projected(this.nv[b], this.nv[b + 1], this.nv[b + 2],
        ctx.dabs[i * 3], ctx.dabs[i * 3 + 1], ctx.dabs[i * 3 + 2], ctx.vx, ctx.vy, ctx.vz);
      if (d2 < best) best = d2;
    }
    return best;
  }

  /**
   * How node n relates to the stroke: 2 = fully covered (paint the subtree
   * whole), 1 = partly covered (refine / paint leaves), 0 = outside.
   * Fills ctx.d with the three vertex distances².
   */
  _classify(n, ctx) {
    const b = n * 3;
    const v0 = this.nv[b], v1 = this.nv[b + 1], v2 = this.nv[b + 2];
    const d0 = ctx.dist2(this.vx[v0], this.vy[v0], this.vz[v0]);
    const d1 = ctx.dist2(this.vx[v1], this.vy[v1], this.vz[v1]);
    const d2 = ctx.dist2(this.vx[v2], this.vy[v2], this.vz[v2]);
    ctx.d[0] = d0; ctx.d[1] = d1; ctx.d[2] = d2;
    const rt2 = ctx.rTest2;
    const inside = (d0 <= rt2 ? 1 : 0) + (d1 <= rt2 ? 1 : 0) + (d2 <= rt2 ? 1 : 0);
    if (inside === 3) {
      if (!ctx.soft || (d0 <= ctx.core2 && d1 <= ctx.core2 && d2 <= ctx.core2)) return 2;
      return 1;
    }
    if (inside === 0 && this._nodeStrokeDist2(n, ctx) > rt2) return 0;
    return 1;
  }

  /** Pass 1: split partly covered nodes down to the edge limit. */
  _refineNode(n, ctx) {
    const c = this._classify(n, ctx);
    if (c !== 1) return;
    if (this.nChild[n] === NO_CHILD) {
      const b = n * 3;
      const v0 = this.nv[b], v1 = this.nv[b + 1], v2 = this.nv[b + 2];
      let mask = 0;
      if (this._edgeLen2(v0, v1) > ctx.edgeLimit2) mask |= 1;
      if (this._edgeLen2(v1, v2) > ctx.edgeLimit2) mask |= 2;
      if (this._edgeLen2(v2, v0) > ctx.edgeLimit2) mask |= 4;
      if (mask === 0) return;   // small enough
      this._split(n, mask);
    }
    const first = this.nChild[n];
    const count = this._childCount(n);
    for (let k = 0; k < count; k++) this._refineNode(first + k, ctx);
  }

  /** Pass 2: paint — whole subtrees where fully covered, leaves where partly. */
  _paintNode(n, ctx) {
    const c = this._classify(n, ctx);
    if (c === 0) return;
    if (c === 2) { this._paintSubtree(n, ctx); return; }
    if (this.nChild[n] === NO_CHILD) {
      this._paintLeaf(n, ctx, ctx.d[0], ctx.d[1], ctx.d[2]);
      return;
    }
    const first = this.nChild[n];
    const count = this._childCount(n);
    for (let k = 0; k < count; k++) this._paintNode(first + k, ctx);
  }

  /** Paint every node of a fully covered subtree. */
  _paintSubtree(n, ctx) {
    const L = ctx.L;
    if (ctx.soft) {
      // Inside the hard core: full coverage on every vertex of the subtree.
      this._setSubtreeCov(n, ctx.L.cov, ctx.erase ? 0 : 1);
      if (ctx.erase) this._setSubtreeState(n, L, 0);
    } else {
      this._setSubtreeState(n, L, ctx.erase ? 0 : 1);
      if (ctx.erase && ctx.L.cov) this._setSubtreeCov(n, ctx.L.cov, 0);
    }
  }

  /** A leaf too small to split: hard brush paints by its centroid, soft brush by vertex distance. */
  _paintLeaf(n, ctx, d0, d1, d2) {
    const L = ctx.L;
    const b = n * 3;
    if (ctx.soft) {
      // A soft eraser feathers hard paint: the leaf becomes full coverage first, then fades.
      if (ctx.erase && L.state[n]) {
        L.state[n] = 0;
        ctx.L.cov[this.nv[b]] = ctx.L.cov[this.nv[b + 1]] = ctx.L.cov[this.nv[b + 2]] = 1;
      }
      const ds = [d0, d1, d2];
      for (let k = 0; k < 3; k++) {
        if (ds[k] > ctx.r2) continue;
        const v = this.nv[b + k];
        const a = brushCoverage(Math.sqrt(ds[k]), ctx.r, ctx.hardness);
        if (ctx.erase) { if (1 - a < ctx.L.cov[v]) ctx.L.cov[v] = 1 - a; }
        else if (a > ctx.L.cov[v]) ctx.L.cov[v] = a;
      }
      return;
    }
    const cx = (this.vx[this.nv[b]] + this.vx[this.nv[b + 1]] + this.vx[this.nv[b + 2]]) / 3;
    const cy = (this.vy[this.nv[b]] + this.vy[this.nv[b + 1]] + this.vy[this.nv[b + 2]]) / 3;
    const cz = (this.vz[this.nv[b]] + this.vz[this.nv[b + 1]] + this.vz[this.nv[b + 2]]) / 3;
    if (ctx.dist2(cx, cy, cz) <= ctx.r2) {
      L.state[n] = ctx.erase ? 0 : 1;
      if (ctx.erase && ctx.L.cov) { ctx.L.cov[this.nv[b]] = ctx.L.cov[this.nv[b + 1]] = ctx.L.cov[this.nv[b + 2]] = 0; }
    }
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  /** Paint of layer `slot` at a leaf corner: 1 for a painted node, else the vertex's soft coverage. */
  _cornerPaint(L, n, v) {
    if (L.state[n]) return 1;
    return L.cov ? L.cov[v] : 0;
  }

  /**
   * Paint of layer `slot` at a point on base face `f` (0..1): descend to the
   * leaf containing the point, then its state or the interpolated coverage.
   */
  samplePaint(slot, f, x, y, z) {
    const L = this.layers[slot];
    if (!L) return 0;
    let n = f;
    const bc = _bary3;
    for (let guard = 0; guard < 64; guard++) {
      const first = this.nChild[n];
      if (first === NO_CHILD) break;
      const count = this._childCount(n);
      let best = -1, bestMin = -Infinity;
      for (let k = 0; k < count; k++) {
        const c = first + k;
        this._barycentric(c, x, y, z, bc);
        const m = Math.min(bc[0], bc[1], bc[2]);
        if (m > bestMin) { bestMin = m; best = c; }
      }
      n = best;
    }
    if (L.state[n]) return 1;
    if (!L.cov) return 0;
    this._barycentric(n, x, y, z, bc);
    const b = n * 3;
    let u = bc[0] < 0 ? 0 : bc[0], v = bc[1] < 0 ? 0 : bc[1], w = bc[2] < 0 ? 0 : bc[2];
    const s = u + v + w || 1;
    return (u * L.cov[this.nv[b]] + v * L.cov[this.nv[b + 1]] + w * L.cov[this.nv[b + 2]]) / s;
  }

  _barycentric(n, px, py, pz, out) {
    const b = n * 3;
    const a = this.nv[b], bb = this.nv[b + 1], c = this.nv[b + 2];
    const ax = this.vx[a], ay = this.vy[a], az = this.vz[a];
    const e0x = this.vx[bb] - ax, e0y = this.vy[bb] - ay, e0z = this.vz[bb] - az;
    const e1x = this.vx[c] - ax, e1y = this.vy[c] - ay, e1z = this.vz[c] - az;
    const d00 = e0x * e0x + e0y * e0y + e0z * e0z;
    const d01 = e0x * e1x + e0y * e1y + e0z * e1z;
    const d11 = e1x * e1x + e1y * e1y + e1z * e1z;
    const den = d00 * d11 - d01 * d01;
    if (!(den > 1e-18 * d00 * d11)) { out[0] = out[1] = out[2] = 1 / 3; return; }
    const qx = px - ax, qy = py - ay, qz = pz - az;
    const d20 = qx * e0x + qy * e0y + qz * e0z;
    const d21 = qx * e1x + qy * e1y + qz * e1z;
    const v = (d11 * d20 - d01 * d21) / den;
    const w = (d00 * d21 - d01 * d20) / den;
    out[0] = 1 - v - w; out[1] = v; out[2] = w;
  }

  /**
   * Paint of layer `slot` on the BASE mesh's corners (per corner 0..1, per
   * face hard flag) from the roots alone — meaningful while isFlat, i.e. no
   * face is split; the flattened mesh is then the base mesh.
   */
  basePaint(slot) {
    const L = this.layers[slot];
    const paint = new Float32Array(this.baseTriCount * 3);
    const hard = new Uint8Array(this.baseTriCount);
    if (!L) return { paint, hard };
    for (let f = 0; f < this.baseTriCount; f++) {
      if (L.state[f]) {
        paint[f * 3] = paint[f * 3 + 1] = paint[f * 3 + 2] = 1;
        hard[f] = 1;
      } else if (L.cov) {
        paint[f * 3]     = L.cov[this.vertId[f * 3]];
        paint[f * 3 + 1] = L.cov[this.vertId[f * 3 + 1]];
        paint[f * 3 + 2] = L.cov[this.vertId[f * 3 + 2]];
      }
    }
    return { paint, hard };
  }

  /**
   * Per base face: 1 when layer `slot` textures none of it (its root is an
   * unsplit leaf that is hard-masked in the layer's mode — painted in Exclude
   * mode, untouched in Include Only mode). Null when every face is textured.
   */
  baseFaceUntextured(slot, includeOnly) {
    const L = this.layers[slot];
    if (!L) return null;
    const out = new Uint8Array(this.baseTriCount);
    let any = false;
    for (let f = 0; f < this.baseTriCount; f++) {
      if (this.nChild[f] !== NO_CHILD) continue;   // split: partly textured either way
      let untextured;
      if (includeOnly) {
        untextured = !L.state[f] && (!L.cov ||
          (L.cov[this.vertId[f * 3]] === 0 && L.cov[this.vertId[f * 3 + 1]] === 0 && L.cov[this.vertId[f * 3 + 2]] === 0));
      } else {
        untextured = !!L.state[f];
      }
      if (untextured) { out[f] = 1; any = true; }
    }
    return any ? out : null;
  }

  /** Soft coverage on base vertices from per-corner values (max per welded vertex) — legacy project masks. */
  setBaseCoverage(slot, corners, values) {
    const L = this.layers[slot];
    if (!L) return;
    const cov = this._ensureCov(L);
    for (let j = 0; j < corners.length; j++) {
      const v = this.vertId[corners[j]];
      if (values[j] > cov[v]) cov[v] = values[j];
    }
    this.paintVersion++;
  }

  /** Painted leaf count and soft-painted vertex count of a layer (for the UI). */
  countPainted(slot) {
    const L = this.layers[slot];
    if (!L) return { faces: 0, softVertices: 0 };
    let faces = 0, softVertices = 0;
    // Walk the live leaves: merged-away nodes and their vertices don't count.
    const seen = L.cov ? new Uint8Array(this.vertCount) : null;
    const stack = [];
    for (let f = 0; f < this.baseTriCount; f++) {
      stack.length = 0;
      stack.push(f);
      while (stack.length) {
        const n = stack.pop();
        const first = this.nChild[n];
        if (first !== NO_CHILD) {
          const count = this._childCount(n);
          for (let k = 0; k < count; k++) stack.push(first + k);
          continue;
        }
        if (L.state[n]) faces++;
        if (seen) {
          for (let k = 0; k < 3; k++) {
            const v = this.nv[n * 3 + k];
            if (!seen[v]) { seen[v] = 1; if (L.cov[v] > 0) softVertices++; }
          }
        }
      }
    }
    return { faces, softVertices };
  }

  /** Orphaned nodes (merged away) are skipped by walking from the roots. */
  _isLive(n) {
    // Cheap check: roots are live; other nodes are live iff reachable. We keep
    // a lazily rebuilt live mask when garbage exists.
    if (n < this.baseTriCount) return true;
    if (this.garbage === 0) return true;
    if (this._liveVersion !== this.structureVersion) this._rebuildLive();
    return this._live[n] === 1;
  }

  _rebuildLive() {
    const live = new Uint8Array(this.nodeCount);
    const stack = [];
    for (let f = 0; f < this.baseTriCount; f++) stack.push(f);
    while (stack.length) {
      const n = stack.pop();
      live[n] = 1;
      const first = this.nChild[n];
      if (first === NO_CHILD) continue;
      const count = this._childCount(n);
      for (let k = 0; k < count; k++) stack.push(first + k);
    }
    this._live = live;
    this._liveVersion = this.structureVersion;
  }

  /** True when no base face was ever split (the flattened mesh is the base mesh). */
  get isFlat() {
    for (let f = 0; f < this.baseTriCount; f++) if (this.nChild[f] !== NO_CHILD) return false;
    return true;
  }

  // ── Flatten ───────────────────────────────────────────────────────────────

  /**
   * The leaves as a watertight non-indexed mesh. A neighbour's midpoint that
   * hangs on one of a leaf's edges splits the leaf's output triangle too
   * (recursively), so both sides of every base edge tessellate identically.
   *
   * @param {Float32Array|null} baseNormals  per-corner base normals to
   *   interpolate (barycentric inside the parent face); null → flat normals
   * @returns {{ positions: Float32Array, normals: Float32Array,
   *   faceParentId: Int32Array, leaf: Int32Array, cornerVert: Int32Array, triCount: number }}
   */
  flatten(baseNormals = null) {
    const outV = [];      // vertex ids, 3 per output triangle
    const outLeaf = [];
    const emit = (a, b, c, leaf) => {
      const m01 = this._activeMidpoint(a, b);
      if (m01 >= 0) { emit(a, m01, c, leaf); emit(m01, b, c, leaf); return; }
      const m12 = this._activeMidpoint(b, c);
      if (m12 >= 0) { emit(a, b, m12, leaf); emit(a, m12, c, leaf); return; }
      const m20 = this._activeMidpoint(c, a);
      if (m20 >= 0) { emit(a, b, m20, leaf); emit(m20, b, c, leaf); return; }
      outV.push(a, b, c); outLeaf.push(leaf);
    };
    const stack = [];
    for (let f = 0; f < this.baseTriCount; f++) {
      stack.length = 0;
      stack.push(f);
      while (stack.length) {
        const n = stack.pop();
        const first = this.nChild[n];
        if (first === NO_CHILD) {
          const b = n * 3;
          emit(this.nv[b], this.nv[b + 1], this.nv[b + 2], n);
          continue;
        }
        const count = this._childCount(n);
        // Push in reverse so children come out in order.
        for (let k = count - 1; k >= 0; k--) stack.push(first + k);
      }
    }
    const triCount = outLeaf.length;
    const positions = new Float32Array(triCount * 9);
    const normals = new Float32Array(triCount * 9);
    const faceParentId = new Int32Array(triCount);
    const leaf = Int32Array.from(outLeaf);
    const cornerVert = Int32Array.from(outV);
    const bc = _bary3;
    for (let t = 0; t < triCount; t++) {
      const f = this.nRoot[leaf[t]];
      faceParentId[t] = f;
      for (let k = 0; k < 3; k++) {
        const v = cornerVert[t * 3 + k];
        const o = t * 9 + k * 3;
        positions[o] = this.vx[v]; positions[o + 1] = this.vy[v]; positions[o + 2] = this.vz[v];
        if (baseNormals) {
          this._barycentric(f, this.vx[v], this.vy[v], this.vz[v], bc);
          const nb = f * 9;
          let nx = bc[0] * baseNormals[nb] + bc[1] * baseNormals[nb + 3] + bc[2] * baseNormals[nb + 6];
          let ny = bc[0] * baseNormals[nb + 1] + bc[1] * baseNormals[nb + 4] + bc[2] * baseNormals[nb + 7];
          let nz = bc[0] * baseNormals[nb + 2] + bc[1] * baseNormals[nb + 5] + bc[2] * baseNormals[nb + 8];
          const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
          normals[o] = nx / len; normals[o + 1] = ny / len; normals[o + 2] = nz / len;
        } else {
          const fb = f * 3;
          normals[o] = this.faceNormals[fb]; normals[o + 1] = this.faceNormals[fb + 1]; normals[o + 2] = this.faceNormals[fb + 2];
        }
      }
    }
    return { positions, normals, faceParentId, leaf, cornerVert, triCount };
  }

  /**
   * Per-corner paint (0..1) and per-triangle hard flag (1 = the leaf is
   * hard-painted) of layer `slot` on a flatten() result.
   */
  flatPaint(slot, flat) {
    const L = this.layers[slot];
    const paint = new Float32Array(flat.triCount * 3);
    const hard = new Uint8Array(flat.triCount);
    if (!L) return { paint, hard };
    for (let t = 0; t < flat.triCount; t++) {
      const n = flat.leaf[t];
      if (L.state[n]) {
        paint[t * 3] = paint[t * 3 + 1] = paint[t * 3 + 2] = 1;
        hard[t] = 1;
      } else if (L.cov) {
        paint[t * 3]     = L.cov[flat.cornerVert[t * 3]];
        paint[t * 3 + 1] = L.cov[flat.cornerVert[t * 3 + 1]];
        paint[t * 3 + 2] = L.cov[flat.cornerVert[t * 3 + 2]];
      }
    }
    return { paint, hard };
  }

  // ── Serialization (undo snapshots, project files, compaction) ─────────────

  /**
   * Compact encoding: per base face a depth-first stream of split codes
   * (0 = leaf), every layer's node states in the same order, and soft
   * coverage per vertex in replay order (base vertices first, then midpoints
   * in the order the replay creates them).
   */
  serialize() {
    const codes = new Uint8Array(this.nodeCount);
    const states = this.layers.map(() => new Uint8Array(this.nodeCount));
    let nOut = 0;
    // Compact vertex ids in replay order.
    const newId = new Int32Array(this.vertCount).fill(-1);
    let vOut = 0;
    for (let v = 0; v < this.baseVertCount; v++) newId[v] = vOut++;
    const order = [];   // old vertex id per new id (for coverage output)
    for (let v = 0; v < this.baseVertCount; v++) order.push(v);
    const stack = [];
    for (let f = 0; f < this.baseTriCount; f++) {
      stack.length = 0;
      stack.push(f);
      while (stack.length) {
        const n = stack.pop();
        codes[nOut] = this.nCode[n];
        for (let l = 0; l < this.layers.length; l++) states[l][nOut] = this.layers[l].state[n];
        nOut++;
        const first = this.nChild[n];
        if (first === NO_CHILD) continue;
        // Midpoints in the order _split creates them for this node.
        const mask = this.nCode[n] & 7;
        const b = n * 3;
        const v = [this.nv[b], this.nv[b + 1], this.nv[b + 2]];
        const bits = ((mask & 1) ? 1 : 0) + ((mask & 2) ? 1 : 0) + ((mask & 4) ? 1 : 0);
        let rot = 0;
        if (bits === 1) rot = mask === 1 ? 0 : mask === 2 ? 1 : 2;
        else if (bits === 2) rot = mask === 3 ? 0 : mask === 6 ? 1 : 2;
        for (let r = 0; r < rot; r++) v.push(v.shift());
        const mids = bits === 1 ? [[v[0], v[1]]] : bits === 2 ? [[v[0], v[1]], [v[1], v[2]]] : [[v[0], v[1]], [v[1], v[2]], [v[2], v[0]]];
        for (const [a, c] of mids) {
          const m = this._midpoint(a, c);
          if (newId[m] < 0) { newId[m] = vOut++; order.push(m); }
        }
        const count = this._childCount(n);
        for (let k = count - 1; k >= 0; k--) stack.push(first + k);
      }
    }
    const cov = this.layers.map((L) => {
      if (!L.cov) return null;
      const out = new Float32Array(vOut);
      let any = false;
      for (let i = 0; i < vOut; i++) { out[i] = L.cov[order[i]]; if (out[i] > 0) any = true; }
      return any ? out : null;
    });
    return {
      baseTriCount: this.baseTriCount,
      baseVertCount: this.baseVertCount,
      nodeCount: nOut,
      vertCount: vOut,
      codes: codes.subarray(0, nOut),
      layerIds: this.layers.map(L => L.id),
      states: states.map(s => s.subarray(0, nOut)),
      cov,
    };
  }

  /**
   * Rebuild the tree from serialize() output. Layers present in the data are
   * restored by id; layers of the current tree that the data lacks are kept,
   * empty. Also the compaction step: orphaned nodes and vertices disappear.
   */
  deserialize(data) {
    if (!data || data.baseTriCount !== this.baseTriCount || data.baseVertCount !== this.baseVertCount) return false;
    // Reset structure.
    const keepIds = this.layers.map(L => L.id);
    this.nodeCap = Math.max(64, Math.max(data.nodeCount, this.baseTriCount) + 16);
    this.nv = new Int32Array(this.nodeCap * 3);
    this.nChild = new Int32Array(this.nodeCap).fill(NO_CHILD);
    this.nCode = new Uint8Array(this.nodeCap);
    this.nRoot = new Int32Array(this.nodeCap);
    this.nodeCount = this.baseTriCount;
    this.vertCap = Math.max(64, Math.max(data.vertCount, this.baseVertCount) + 16);
    const vx = new Float64Array(this.vertCap), vy = new Float64Array(this.vertCap), vz = new Float64Array(this.vertCap);
    for (let v = 0; v < this.baseVertCount; v++) { vx[v] = this.vx[v]; vy[v] = this.vy[v]; vz[v] = this.vz[v]; }
    this.vx = vx; this.vy = vy; this.vz = vz;
    this.midRef = new Int32Array(this.vertCap);
    this.vertCount = this.baseVertCount;
    this.mid = new IntPairMap(Math.max(256, data.vertCount));
    this.garbage = 0;
    for (let f = 0; f < this.baseTriCount; f++) {
      this.nv[f * 3] = this.vertId[f * 3]; this.nv[f * 3 + 1] = this.vertId[f * 3 + 1]; this.nv[f * 3 + 2] = this.vertId[f * 3 + 2];
      this.nRoot[f] = f;
    }
    // Layers: those in the data (by id) get their states; others start empty.
    const ids = Array.from(new Set([...keepIds, ...(data.layerIds || [])]));
    this.layers = ids.map(id => ({ id, state: new Uint8Array(this.nodeCap), cov: null }));
    const dataSlot = new Map((data.layerIds || []).map((id, i) => [id, i]));

    // Replay: depth-first, codes consumed in order; splitting recreates the
    // midpoints in the same order, so vertex ids match serialize()'s.
    let pos = 0;
    const stack = [];
    for (let f = 0; f < this.baseTriCount; f++) {
      stack.length = 0;
      stack.push(f);
      while (stack.length) {
        const n = stack.pop();
        const code = data.codes[pos];
        for (const L of this.layers) {
          const ds = dataSlot.get(L.id);
          if (ds !== undefined) L.state[n] = data.states[ds][pos];
        }
        pos++;
        const mask = code & 7;
        if (mask === 0) continue;
        const diag = (code >> 3) & 1;
        const first = this._split(n, mask, diag);
        const count = this._childCount(n);
        for (let k = count - 1; k >= 0; k--) stack.push(first + k);
      }
    }
    for (const L of this.layers) {
      const ds = dataSlot.get(L.id);
      const c = ds !== undefined ? data.cov[ds] : null;
      if (c) { L.cov = new Float32Array(this.vertCap); L.cov.set(c.subarray(0, Math.min(c.length, this.vertCount))); }
    }
    this.structureVersion++;
    this.paintVersion++;
    return true;
  }

  /** Rebuild from the serialized form when merges left too much garbage. */
  compactIfNeeded() {
    if (this.garbage < 1024 || this.garbage < this.nodeCount * 0.5) return false;
    this.deserialize(this.serialize());
    return true;
  }

  /** Byte-level equality of two serialize() results (undo de-duplication). */
  static serializedEqual(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    if (a.nodeCount !== b.nodeCount || a.vertCount !== b.vertCount) return false;
    if (a.layerIds.length !== b.layerIds.length) return false;
    for (let i = 0; i < a.layerIds.length; i++) if (a.layerIds[i] !== b.layerIds[i]) return false;
    for (let i = 0; i < a.nodeCount; i++) if (a.codes[i] !== b.codes[i]) return false;
    for (let l = 0; l < a.states.length; l++) {
      const sa = a.states[l], sb = b.states[l];
      for (let i = 0; i < a.nodeCount; i++) if (sa[i] !== sb[i]) return false;
      const ca = a.cov[l], cb = b.cov[l];
      if (!ca !== !cb) return false;
      if (ca) for (let i = 0; i < a.vertCount; i++) if (ca[i] !== cb[i]) return false;
    }
    return true;
  }

  /** JSON-safe form of serialize() (project files). */
  static toJSON(data) {
    const b64 = (u8) => {
      let s = '';
      for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      return btoa(s);
    };
    return {
      version: 1,
      baseTriCount: data.baseTriCount, baseVertCount: data.baseVertCount,
      nodeCount: data.nodeCount, vertCount: data.vertCount,
      codes: b64(data.codes),
      layerIds: data.layerIds,
      states: data.states.map(s => b64(s)),
      cov: data.cov.map(c => c ? b64(new Uint8Array(c.buffer, c.byteOffset, c.byteLength)) : null),
    };
  }

  static fromJSON(j) {
    if (!j || j.version !== 1) return null;
    const u8 = (s) => { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
    return {
      baseTriCount: j.baseTriCount, baseVertCount: j.baseVertCount,
      nodeCount: j.nodeCount, vertCount: j.vertCount,
      codes: u8(j.codes),
      layerIds: j.layerIds,
      states: j.states.map(s => u8(s)),
      cov: j.cov.map(c => { if (!c) return null; const b = u8(c); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); }),
    };
  }
}

const _tri9 = new Float64Array(9);
const _bary3 = new Float64Array(3);

/**
 * Squared distance from point P to the closest point on triangle ABC.
 * Uses the Voronoi-region method (no allocations, pure arithmetic).
 */
export function distSqPointToTri(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx-ax, aby = by-ay, abz = bz-az;
  const acx = cx-ax, acy = cy-ay, acz = cz-az;
  const apx = px-ax, apy = py-ay, apz = pz-az;

  const d1 = abx*apx + aby*apy + abz*apz;
  const d2 = acx*apx + acy*apy + acz*apz;
  if (d1 <= 0 && d2 <= 0) return apx*apx + apy*apy + apz*apz; // vertex A

  const bpx = px-bx, bpy = py-by, bpz = pz-bz;
  const d3 = abx*bpx + aby*bpy + abz*bpz;
  const d4 = acx*bpx + acy*bpy + acz*bpz;
  if (d3 >= 0 && d4 <= d3) return bpx*bpx + bpy*bpy + bpz*bpz; // vertex B

  const cpx = px-cx, cpy = py-cy, cpz = pz-cz;
  const d5 = abx*cpx + aby*cpy + abz*cpz;
  const d6 = acx*cpx + acy*cpy + acz*cpz;
  if (d6 >= 0 && d5 <= d6) return cpx*cpx + cpy*cpy + cpz*cpz; // vertex C

  const vc = d1*d4 - d3*d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { // edge AB
    const v = d1 / (d1 - d3);
    const qx = ax+v*abx-px, qy = ay+v*aby-py, qz = az+v*abz-pz;
    return qx*qx + qy*qy + qz*qz;
  }

  const vb = d5*d2 - d1*d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { // edge AC
    const w = d2 / (d2 - d6);
    const qx = ax+w*acx-px, qy = ay+w*acy-py, qz = az+w*acz-pz;
    return qx*qx + qy*qy + qz*qz;
  }

  const va = d3*d6 - d5*d4;
  if (va <= 0 && (d4-d3) >= 0 && (d5-d6) >= 0) { // edge BC
    const w = (d4-d3) / ((d4-d3) + (d5-d6));
    const qx = bx+w*(cx-bx)-px, qy = by+w*(cy-by)-py, qz = bz+w*(cz-bz)-pz;
    return qx*qx + qy*qy + qz*qz;
  }

  // Inside triangle
  const den = 1 / (va + vb + vc);
  const v = vb*den, w = vc*den;
  const qx = ax+abx*v+acx*w-px, qy = ay+aby*v+acy*w-py, qz = az+abz*v+acz*w-pz;
  return qx*qx + qy*qy + qz*qz;
}
