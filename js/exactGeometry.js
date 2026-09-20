/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { QuantizedPointMap } from './meshIndex.js';

/** Index Float32 positions by their actual bits, never by a distance tolerance. */
export function indexExactPositions(positions) {
  if (!(positions instanceof Float32Array)) {
    throw new TypeError('Expected Float32Array positions');
  }
  if (positions.length % 9) {
    throw new RangeError('Expected complete triangles');
  }
  const bits = new Uint32Array(positions.buffer, positions.byteOffset, positions.length);
  const map = new QuantizedPointMap(1, Math.min(positions.length / 3, 1 << 20));
  const indices = new Uint32Array(positions.length / 3);
  const vertices = new Float32Array(positions.length);
  let count = 0;
  for (let i = 0; i < positions.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      if (!Number.isFinite(positions[i + c])) {
        throw new RangeError('Positions must be finite');
      }
    }
    // +0 and -0 describe the same point; retain the first occurrence's bytes.
    const id = map.getOrSet(
      positions[i] === 0 ? 0 : bits[i],
      positions[i + 1] === 0 ? 0 : bits[i + 1],
      positions[i + 2] === 0 ? 0 : bits[i + 2],
      count
    );
    if (map.inserted) {
      vertices.set(positions.subarray(i, i + 3), count * 3);
      count++;
    }
    indices[i / 3] = id;
  }
  return { vertices: vertices.slice(0, count * 3), indices };
}
