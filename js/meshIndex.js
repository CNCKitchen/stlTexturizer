/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * meshIndex.js — shared vertex welding for the mesh pipeline.
 *
 * Every pipeline stage needs the same primitive: map a 3D position, quantised
 * onto a grid, to a small integer id so that bit-different copies of "the same
 * point" (non-indexed triangle soup, float round-trip noise) collapse to one
 * vertex.  Historically each module built `${x}_${y}_${z}` strings into a Map,
 * which allocates one short-lived string per vertex — gigabytes of GC churn
 * per export on multi-million-triangle meshes.
 *
 * QuantizedPointMap replaces that with an open-addressing hash table over
 * typed arrays: zero allocation per lookup, exact integer key comparison.
 * Quantised components are stored as Float64 (integers are exact in f64), so
 * coordinates of any magnitude behave identically to the old string keys.
 *
 * Values must be integers in [0, 2^31-1] (vertex/canonical ids). -1 is the
 * internal "empty" sentinel and is returned by get() on a miss.
 *
 * Grid policy note: callers pass their own `quant`. The app currently uses
 *   1e4 (0.1 µm cells) — export grid, masking, validation, repair
 *   1e5 (10 nm cells)  — subdivision, regularize, displacement
 *   1e6 (1 nm cells)   — decimation (own packed-BigInt welder)
 * Keep a call site's grid unchanged unless you intend to change behaviour.
 */

export class QuantizedPointMap {
  /**
   * @param {number} quant     – grid multiplier (e.g. 1e5 → 10 nm cells)
   * @param {number} expected  – expected number of unique points (sizing hint)
   */
  constructor(quant, expected = 256) {
    this.quant = quant;
    /** true when the last getOrSet() inserted a new key */
    this.inserted = false;
    this._size = 0;
    let cap = 16;
    const target = Math.max(16, Math.ceil(expected / 0.6));
    while (cap < target) cap *= 2;
    this._alloc(cap);
  }

  get size() { return this._size; }

  _alloc(cap) {
    this._cap = cap;
    this._mask = cap - 1;
    this._qx = new Float64Array(cap);
    this._qy = new Float64Array(cap);
    this._qz = new Float64Array(cap);
    this._val = new Int32Array(cap).fill(-1);
  }

  _slot(qx, qy, qz) {
    // Mix the (wrapped-to-32-bit) quantised components; equality is checked
    // against the exact f64-stored values, so hash wrapping is harmless.
    let h = Math.imul(qx | 0, 0x9E3779B1) ^ Math.imul(qy | 0, 0x85EBCA77) ^ Math.imul(qz | 0, 0xC2B2AE3D);
    h ^= h >>> 15;
    let i = h & this._mask;
    const qxA = this._qx, qyA = this._qy, qzA = this._qz, val = this._val, mask = this._mask;
    while (val[i] !== -1) {
      if (qxA[i] === qx && qyA[i] === qy && qzA[i] === qz) return i;
      i = (i + 1) & mask;
    }
    return i;
  }

  _grow() {
    const oqx = this._qx, oqy = this._qy, oqz = this._qz, oval = this._val, ocap = this._cap;
    this._alloc(ocap * 2);
    for (let i = 0; i < ocap; i++) {
      if (oval[i] === -1) continue;
      const s = this._slot(oqx[i], oqy[i], oqz[i]);
      this._qx[s] = oqx[i]; this._qy[s] = oqy[i]; this._qz[s] = oqz[i];
      this._val[s] = oval[i];
    }
  }

  /** Value stored for (x,y,z)'s grid cell, or -1 if absent. */
  get(x, y, z) {
    const q = this.quant;
    const i = this._slot(Math.round(x * q), Math.round(y * q), Math.round(z * q));
    return this._val[i];
  }

  /**
   * Return the value already stored for (x,y,z)'s grid cell; if absent, store
   * `value` and return it.  `this.inserted` tells which case occurred.
   */
  getOrSet(x, y, z, value) {
    const q = this.quant;
    const qx = Math.round(x * q), qy = Math.round(y * q), qz = Math.round(z * q);
    const i = this._slot(qx, qy, qz);
    const existing = this._val[i];
    if (existing !== -1) {
      this.inserted = false;
      return existing;
    }
    this._qx[i] = qx; this._qy[i] = qy; this._qz[i] = qz;
    this._val[i] = value;
    this.inserted = true;
    if (++this._size > this._cap * 0.7) this._grow();
    return value;
  }
}

/**
 * IntPairMap — open-addressing map keyed by an ORDERED PAIR OF INTEGERS.
 *
 * Several places key on two vertex ids rather than a 3-D point — edge tables,
 * above all.  The tempting shortcut is to pack the pair into one JS number as
 * `a * 2**32 + b` and use it in a Map.  **That is only correct up to
 * a = 2^21 = 2,097,152.**  float64 carries 53 bits of integer precision, so
 * beyond that the packed value rounds and distinct pairs collide — silently,
 * and only on meshes large enough that nobody checks by hand.  meshRepair.js
 * did exactly this and reported hundreds of thousands of non-manifold edges on
 * meshes that were provably manifold (see diag-edgekey-collision.mjs).
 *
 * This class keeps the two components as separate Int32s, so the key is exact
 * for every id the pipeline can produce (< 2^31), and it has no equivalent of
 * a JS Map's ~16.7 M entry cap.
 *
 * It is also 12 bytes per slot against QuantizedPointMap's 28 (3 × Float64 key
 * + Int32 value), which matters wherever an integer-pair table is sized by
 * triangle count.
 *
 * Values must be integers in [0, 2^31-1]; -1 is the "empty" sentinel and is
 * what get() returns on a miss — same contract as QuantizedPointMap.
 */
export class IntPairMap {
  /**
   * @param {number} expected – expected number of unique pairs (sizing hint)
   */
  constructor(expected = 256) {
    /** true when the last getOrSet() inserted a new key */
    this.inserted = false;
    this._size = 0;
    let cap = 16;
    const target = Math.max(16, Math.ceil(expected / 0.6));
    while (cap < target) cap *= 2;
    this._alloc(cap);
  }

  get size() { return this._size; }

  _alloc(cap) {
    this._cap = cap;
    this._mask = cap - 1;
    this._k1  = new Int32Array(cap);
    this._k2  = new Int32Array(cap);
    this._val = new Int32Array(cap).fill(-1);
  }

  _slot(a, b) {
    let h = Math.imul(a, 0x9E3779B1) ^ Math.imul(b, 0x85EBCA77);
    h ^= h >>> 15;
    let i = h & this._mask;
    const k1 = this._k1, k2 = this._k2, val = this._val, mask = this._mask;
    while (val[i] !== -1) {
      if (k1[i] === a && k2[i] === b) return i;
      i = (i + 1) & mask;
    }
    return i;
  }

  _grow() {
    const ok1 = this._k1, ok2 = this._k2, oval = this._val, ocap = this._cap;
    this._alloc(ocap * 2);
    for (let i = 0; i < ocap; i++) {
      if (oval[i] === -1) continue;
      const s = this._slot(ok1[i], ok2[i]);
      this._k1[s] = ok1[i]; this._k2[s] = ok2[i]; this._val[s] = oval[i];
    }
  }

  /** Value stored for the pair (a,b), or -1 if absent. */
  get(a, b) {
    return this._val[this._slot(a, b)];
  }

  /**
   * Return the value already stored for (a,b); if absent, store `value` and
   * return it.  `this.inserted` tells which case occurred.
   */
  getOrSet(a, b, value) {
    const i = this._slot(a, b);
    const existing = this._val[i];
    if (existing !== -1) {
      this.inserted = false;
      return existing;
    }
    this._k1[i] = a; this._k2[i] = b; this._val[i] = value;
    this.inserted = true;
    if (++this._size > this._cap * 0.7) this._grow();
    return value;
  }
}

/**
 * Weld a non-indexed position buffer: assign each vertex the sequential id of
 * its quantised position (first occurrence wins).
 *
 * @param {Float32Array|Float64Array} pos  – flat [x,y,z,...] positions
 * @param {number} count                   – vertex count (pos.length / 3)
 * @param {number} quant                   – grid multiplier
 * @returns {{ vertexId: Uint32Array, uniqueCount: number }}
 */
export function weldVertices(pos, count, quant) {
  const map = new QuantizedPointMap(quant, Math.min(count, 1 << 22));
  const vertexId = new Uint32Array(count);
  let nextId = 0;
  for (let i = 0; i < count; i++) {
    const id = map.getOrSet(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], nextId);
    if (map.inserted) nextId++;
    vertexId[i] = id;
  }
  return { vertexId, uniqueCount: nextId };
}
