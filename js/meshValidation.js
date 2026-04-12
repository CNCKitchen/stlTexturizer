/**
 * meshValidation.js — mesh quality diagnostics
 *
 * Fast checks (open edges, shell count) run automatically after load.
 * Expensive checks (intersections, overlaps) are triggered on demand.
 */

const yieldFrame = () => new Promise(r => setTimeout(r, 0));

// ── Fast diagnostics ─────────────────────────────────────────────────────────

/**
 * Count disconnected mesh shells via BFS on the adjacency graph.
 * @param {Array<Array<{neighbor:number}>>} adjacency - from buildAdjacency
 * @param {number} triCount
 * @returns {number} number of disconnected components
 */
function countShells(adjacency, triCount) {
  const visited = new Uint8Array(triCount);
  let shellCount = 0;
  for (let seed = 0; seed < triCount; seed++) {
    if (visited[seed]) continue;
    shellCount++;
    const queue = [seed];
    visited[seed] = 1;
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      const neighbors = adjacency[cur];
      if (!neighbors) continue;
      for (const { neighbor } of neighbors) {
        if (!visited[neighbor]) {
          visited[neighbor] = 1;
          queue.push(neighbor);
        }
      }
    }
  }
  return shellCount;
}

/**
 * Run all fast mesh diagnostics (synchronous, negligible cost on top of
 * buildAdjacency which the caller already performed).
 *
 * @param {{ adjacency, openEdgeCount:number, nonManifoldEdgeCount:number }} adjData
 * @param {number} triCount
 * @returns {{ openEdges:number, nonManifoldEdges:number, shellCount:number }}
 */
export function runFastDiagnostics(adjData, triCount) {
  return {
    openEdges: adjData.openEdgeCount,
    nonManifoldEdges: adjData.nonManifoldEdgeCount,
    shellCount: countShells(adjData.adjacency, triCount),
  };
}

// ── Expensive diagnostics ────────────────────────────────────────────────────

/**
 * Find pairs of intersecting triangles using spatial hashing for the broad
 * phase and the Separating Axis Theorem for the narrow phase.
 * Skips triangle pairs that share any vertex (topological neighbors).
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {{ get:() => number }} token  - abort when token.get() !== startValue
 * @returns {Promise<number>} count of intersecting triangle pairs
 */
async function findIntersectingTriangles(geometry, token) {
  const startToken = token.get();
  const pos = geometry.attributes.position.array;
  const triCount = pos.length / 9;

  // Assign a numeric ID to each unique vertex position (quantized).
  // Two triangles that share any vertex are topological neighbors and must be
  // skipped — they touch at that vertex and SAT would flag them otherwise.
  const QUANT = 1e4;
  const posToId = new Map();
  let nextVId = 0;
  const triVerts = new Uint32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    const b = t * 9;
    for (let v = 0; v < 3; v++) {
      const off = b + v * 3;
      const key = `${Math.round(pos[off] * QUANT)}_${Math.round(pos[off+1] * QUANT)}_${Math.round(pos[off+2] * QUANT)}`;
      let id = posToId.get(key);
      if (id === undefined) { id = nextVId++; posToId.set(key, id); }
      triVerts[t * 3 + v] = id;
    }
  }

  function sharesVertex(a, b) {
    const aBase = a * 3, bBase = b * 3;
    for (let i = 0; i < 3; i++) {
      const vid = triVerts[aBase + i];
      if (vid === triVerts[bBase] || vid === triVerts[bBase + 1] || vid === triVerts[bBase + 2]) return true;
    }
    return false;
  }

  // Build per-triangle AABB
  const minX = new Float32Array(triCount);
  const minY = new Float32Array(triCount);
  const minZ = new Float32Array(triCount);
  const maxX = new Float32Array(triCount);
  const maxY = new Float32Array(triCount);
  const maxZ = new Float32Array(triCount);

  for (let t = 0; t < triCount; t++) {
    const b = t * 9;
    const ax = pos[b], ay = pos[b+1], az = pos[b+2];
    const bx = pos[b+3], by = pos[b+4], bz = pos[b+5];
    const cx = pos[b+6], cy = pos[b+7], cz = pos[b+8];
    minX[t] = Math.min(ax, bx, cx); maxX[t] = Math.max(ax, bx, cx);
    minY[t] = Math.min(ay, by, cy); maxY[t] = Math.max(ay, by, cy);
    minZ[t] = Math.min(az, bz, cz); maxZ[t] = Math.max(az, bz, cz);
  }

  // Determine grid cell size from median AABB extent
  const extents = new Float32Array(triCount);
  for (let t = 0; t < triCount; t++) {
    extents[t] = Math.max(maxX[t] - minX[t], maxY[t] - minY[t], maxZ[t] - minZ[t]);
  }
  extents.sort();
  const cellSize = Math.max(extents[triCount >> 1] * 2, 1e-6);
  const invCell = 1 / cellSize;

  // Insert triangles into spatial grid (each triangle may span multiple cells)
  const grid = new Map();
  const cellKey = (ix, iy, iz) => `${ix}_${iy}_${iz}`;

  for (let t = 0; t < triCount; t++) {
    const ix0 = Math.floor(minX[t] * invCell);
    const iy0 = Math.floor(minY[t] * invCell);
    const iz0 = Math.floor(minZ[t] * invCell);
    const ix1 = Math.floor(maxX[t] * invCell);
    const iy1 = Math.floor(maxY[t] * invCell);
    const iz1 = Math.floor(maxZ[t] * invCell);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let iz = iz0; iz <= iz1; iz++) {
          const k = cellKey(ix, iy, iz);
          let list = grid.get(k);
          if (!list) { list = []; grid.set(k, list); }
          list.push(t);
        }
      }
    }
  }

  // Narrow phase: test candidate pairs from same grid cells
  const testedPairs = new Set();
  let intersectCount = 0;
  let pairsTested = 0;
  const intersectFaces = new Set();

  for (const [, tris] of grid) {
    for (let i = 0; i < tris.length; i++) {
      for (let j = i + 1; j < tris.length; j++) {
        const tA = tris[i], tB = tris[j];
        const a = Math.min(tA, tB), b = Math.max(tA, tB);
        const pairKey = a * triCount + b;

        if (testedPairs.has(pairKey)) continue;
        testedPairs.add(pairKey);

        // Skip triangles sharing any vertex (topological neighbors)
        if (sharesVertex(a, b)) continue;

        // AABB overlap test
        if (minX[a] > maxX[b] || minX[b] > maxX[a] ||
            minY[a] > maxY[b] || minY[b] > maxY[a] ||
            minZ[a] > maxZ[b] || minZ[b] > maxZ[a]) continue;

        // SAT triangle-triangle intersection
        if (trianglesIntersectSAT(pos, a, b)) {
          intersectCount++;
          intersectFaces.add(a);
          intersectFaces.add(b);
        }

        if (++pairsTested % 10000 === 0) {
          await yieldFrame();
          if (token.get() !== startToken) return -1; // aborted
        }
      }
    }
  }

  return { count: intersectCount, faces: intersectFaces };
}

/**
 * Separating Axis Theorem test for two triangles.
 * Tests 13 axes: 2 face normals + 9 edge cross products.
 * Also handles coplanar case via 2D edge-normal axes.
 */
function trianglesIntersectSAT(pos, tA, tB) {
  const bA = tA * 9, bB = tB * 9;

  // Triangle A vertices
  const a0x = pos[bA],   a0y = pos[bA+1], a0z = pos[bA+2];
  const a1x = pos[bA+3], a1y = pos[bA+4], a1z = pos[bA+5];
  const a2x = pos[bA+6], a2y = pos[bA+7], a2z = pos[bA+8];

  // Triangle B vertices
  const b0x = pos[bB],   b0y = pos[bB+1], b0z = pos[bB+2];
  const b1x = pos[bB+3], b1y = pos[bB+4], b1z = pos[bB+5];
  const b2x = pos[bB+6], b2y = pos[bB+7], b2z = pos[bB+8];

  // Edge vectors for A
  const eA0x = a1x-a0x, eA0y = a1y-a0y, eA0z = a1z-a0z;
  const eA1x = a2x-a1x, eA1y = a2y-a1y, eA1z = a2z-a1z;
  const eA2x = a0x-a2x, eA2y = a0y-a2y, eA2z = a0z-a2z;

  // Edge vectors for B
  const eB0x = b1x-b0x, eB0y = b1y-b0y, eB0z = b1z-b0z;
  const eB1x = b2x-b1x, eB1y = b2y-b1y, eB1z = b2z-b1z;
  const eB2x = b0x-b2x, eB2y = b0y-b2y, eB2z = b0z-b2z;

  // Face normals
  const nAx = eA0y*eA2z - eA0z*eA2y; // eA0 x (-eA2) = eA0 x (a0-a2)
  const nAy = eA0z*eA2x - eA0x*eA2z;
  const nAz = eA0x*eA2y - eA0y*eA2x;

  const nBx = eB0y*eB2z - eB0z*eB2y;
  const nBy = eB0z*eB2x - eB0x*eB2z;
  const nBz = eB0x*eB2y - eB0y*eB2x;

  // Helper: project 6 vertices onto axis, return true if separated
  function separated(ax, ay, az) {
    const lenSq = ax*ax + ay*ay + az*az;
    if (lenSq < 1e-20) return false; // degenerate axis, skip

    const pA0 = a0x*ax + a0y*ay + a0z*az;
    const pA1 = a1x*ax + a1y*ay + a1z*az;
    const pA2 = a2x*ax + a2y*ay + a2z*az;
    const pB0 = b0x*ax + b0y*ay + b0z*az;
    const pB1 = b1x*ax + b1y*ay + b1z*az;
    const pB2 = b2x*ax + b2y*ay + b2z*az;

    const minA = Math.min(pA0, pA1, pA2), maxA = Math.max(pA0, pA1, pA2);
    const minB = Math.min(pB0, pB1, pB2), maxB = Math.max(pB0, pB1, pB2);

    // Use a relative epsilon for the overlap test
    const eps = 1e-8 * Math.max(Math.abs(maxA), Math.abs(maxB), Math.abs(minA), Math.abs(minB), 1);
    return maxA < minB - eps || maxB < minA - eps;
  }

  // Test face normal of A
  if (separated(nAx, nAy, nAz)) return false;
  // Test face normal of B
  if (separated(nBx, nBy, nBz)) return false;

  // 9 edge cross products
  const edgesA = [[eA0x,eA0y,eA0z],[eA1x,eA1y,eA1z],[eA2x,eA2y,eA2z]];
  const edgesB = [[eB0x,eB0y,eB0z],[eB1x,eB1y,eB1z],[eB2x,eB2y,eB2z]];

  for (const eA of edgesA) {
    for (const eB of edgesB) {
      const cx = eA[1]*eB[2] - eA[2]*eB[1];
      const cy = eA[2]*eB[0] - eA[0]*eB[2];
      const cz = eA[0]*eB[1] - eA[1]*eB[0];
      if (separated(cx, cy, cz)) return false;
    }
  }

  // If we get here, the 13 standard SAT axes found no separator.
  // Before reporting an intersection, verify that each triangle actually
  // straddles the other's plane with meaningful penetration.  Triangles
  // that merely touch at a shared edge/vertex, or are coplanar, produce
  // SAT false positives because the projection ranges just barely overlap.
  //
  // A true surface-crossing intersection requires both:
  //   - B's vertices span BOTH sides of A's plane (B straddles A)
  //   - A's vertices span BOTH sides of B's plane (A straddles B)
  // We use a tolerance relative to each triangle's size.

  const nAlen = Math.sqrt(nAx*nAx + nAy*nAy + nAz*nAz);
  const nBlen = Math.sqrt(nBx*nBx + nBy*nBy + nBz*nBz);
  if (nAlen < 1e-20 || nBlen < 1e-20) return false; // degenerate triangle

  // Signed distances of B's verts from A's plane (normalized)
  const dA = nAx*a0x + nAy*a0y + nAz*a0z;
  const db0 = (nAx*b0x + nAy*b0y + nAz*b0z - dA) / nAlen;
  const db1 = (nAx*b1x + nAy*b1y + nAz*b1z - dA) / nAlen;
  const db2 = (nAx*b2x + nAy*b2y + nAz*b2z - dA) / nAlen;

  // Signed distances of A's verts from B's plane (normalized)
  const dB = nBx*b0x + nBy*b0y + nBz*b0z;
  const da0 = (nBx*a0x + nBy*a0y + nBz*a0z - dB) / nBlen;
  const da1 = (nBx*a1x + nBy*a1y + nBz*a1z - dB) / nBlen;
  const da2 = (nBx*a2x + nBy*a2y + nBz*a2z - dB) / nBlen;

  // Tolerance: a small fraction of the smaller triangle's longest edge.
  // This catches touching/grazing without missing real penetrations.
  const maxEdgeA = Math.max(
    eA0x*eA0x + eA0y*eA0y + eA0z*eA0z,
    eA1x*eA1x + eA1y*eA1y + eA1z*eA1z,
    eA2x*eA2x + eA2y*eA2y + eA2z*eA2z);
  const maxEdgeB = Math.max(
    eB0x*eB0x + eB0y*eB0y + eB0z*eB0z,
    eB1x*eB1x + eB1y*eB1y + eB1z*eB1z,
    eB2x*eB2x + eB2y*eB2y + eB2z*eB2z);
  const eps = 1e-4 * Math.sqrt(Math.min(maxEdgeA, maxEdgeB));

  // B must straddle A's plane: needs verts on both sides beyond tolerance
  const bMin = Math.min(db0, db1, db2), bMax = Math.max(db0, db1, db2);
  if (bMin > -eps || bMax < eps) return false; // B is entirely on one side

  // A must straddle B's plane
  const aMin = Math.min(da0, da1, da2), aMax = Math.max(da0, da1, da2);
  if (aMin > -eps || aMax < eps) return false; // A is entirely on one side

  return true;
}

/**
 * Find duplicate triangles by exact vertex comparison.
 * Two triangles are duplicates if they share the same three vertex positions
 * (bit-identical floats), regardless of winding order.
 * Also collects the face indices of duplicates for highlighting.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {{ get:() => number }} token
 * @returns {Promise<{ count:number, faces:Set<number> }|number>}
 *          -1 if aborted
 */
async function findOverlappingTriangles(geometry, token) {
  const startToken = token.get();
  const pos = geometry.attributes.position.array;
  const triCount = pos.length / 9;

  // Use a DataView to read float32 bits as uint32 for exact hashing
  const dv = new DataView(pos.buffer, pos.byteOffset, pos.byteLength);

  // Build a sortable key per vertex from raw float bits (exact, no quantization)
  function vertKey(offset) {
    // Read the 3 float32 values as uint32 bit patterns
    const bx = dv.getUint32(offset, true);
    const by = dv.getUint32(offset + 4, true);
    const bz = dv.getUint32(offset + 8, true);
    return `${bx}_${by}_${bz}`;
  }

  const triHashMap = new Map();
  const overlapFaces = new Set();

  for (let t = 0; t < triCount; t++) {
    const byteBase = t * 9 * 4; // 9 floats × 4 bytes
    const verts = [
      vertKey(byteBase),
      vertKey(byteBase + 12),
      vertKey(byteBase + 24),
    ];
    verts.sort();
    const key = verts[0] + '|' + verts[1] + '|' + verts[2];
    const existing = triHashMap.get(key);
    if (existing !== undefined) {
      overlapFaces.add(existing);
      overlapFaces.add(t);
    } else {
      triHashMap.set(key, t);
    }

    if (t % 50000 === 0 && t > 0) {
      await yieldFrame();
      if (token.get() !== startToken) return -1;
    }
  }

  return { count: overlapFaces.size > 0 ? overlapFaces.size : 0, faces: overlapFaces };
}

/**
 * Run expensive mesh diagnostics (intersections + overlaps).
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {{ get:() => number }} token  - abort guard
 * @returns {Promise<{ intersectingPairs:number, overlappingPairs:number, overlapFaces:Set<number> }|null>}
 *          null if aborted
 */
export async function runExpensiveDiagnostics(geometry, token) {
  const overlapResult = await findOverlappingTriangles(geometry, token);
  if (overlapResult === -1) return null;

  const intersectResult = await findIntersectingTriangles(geometry, token);
  if (intersectResult === -1) return null;

  return {
    intersectingPairs: intersectResult.count,
    intersectFaces: intersectResult.faces,
    overlappingPairs: overlapResult.count,
    overlapFaces: overlapResult.faces,
  };
}

// ── Highlight data extraction ────────────────────────────────────────────────

/**
 * Return line-segment positions for open and non-manifold edges.
 * Each edge = 6 floats (two 3D endpoints).
 *
 * @param {THREE.BufferGeometry} geometry  – non-indexed
 * @returns {{ open: Float32Array, nonManifold: Float32Array }}
 */
export function getEdgePositions(geometry) {
  const posAttr = geometry.attributes.position;
  const triCount = posAttr.count / 3;
  const QUANT = 1e4;

  // Vertex dedup (same approach as buildAdjacency)
  const posToId = new Map();
  let nextId = 0;
  const vertId = new Uint32Array(triCount * 3);
  for (let i = 0; i < triCount * 3; i++) {
    const x = posAttr.getX(i), y = posAttr.getY(i), z = posAttr.getZ(i);
    const key = `${Math.round(x * QUANT)}_${Math.round(y * QUANT)}_${Math.round(z * QUANT)}`;
    let id = posToId.get(key);
    if (id === undefined) { id = nextId++; posToId.set(key, id); }
    vertId[i] = id;
  }

  const numEdgeKey = (a, b) => a < b ? a * nextId + b : b * nextId + a;
  const edgePairs = [0, 1, 0, 2, 1, 2];

  // edgeMap: numericKey → { count, v0idx, v1idx } (first occurrence vertex indices)
  const edgeMap = new Map();
  for (let t = 0; t < triCount; t++) {
    const base = t * 3;
    for (let e = 0; e < 6; e += 2) {
      const vi0 = base + edgePairs[e], vi1 = base + edgePairs[e + 1];
      const ek = numEdgeKey(vertId[vi0], vertId[vi1]);
      const entry = edgeMap.get(ek);
      if (entry) {
        entry.count++;
      } else {
        edgeMap.set(ek, { count: 1, v0: vi0, v1: vi1 });
      }
    }
  }

  // Collect edge positions
  const openList = [];
  const nmList = [];
  for (const [, { count, v0, v1 }] of edgeMap) {
    if (count === 1) {
      openList.push(
        posAttr.getX(v0), posAttr.getY(v0), posAttr.getZ(v0),
        posAttr.getX(v1), posAttr.getY(v1), posAttr.getZ(v1)
      );
    } else if (count > 2) {
      nmList.push(
        posAttr.getX(v0), posAttr.getY(v0), posAttr.getZ(v0),
        posAttr.getX(v1), posAttr.getY(v1), posAttr.getZ(v1)
      );
    }
  }

  return {
    open: new Float32Array(openList),
    nonManifold: new Float32Array(nmList),
  };
}

/**
 * Return per-triangle shell ID (0-based) via BFS on the adjacency graph.
 *
 * @param {Array<Array<{neighbor:number}>>} adjacency
 * @param {number} triCount
 * @returns {Uint32Array}  shellId[t] = 0-based shell index for triangle t
 */
export function getShellAssignments(adjacency, triCount) {
  const shellId = new Uint32Array(triCount); // default 0
  const visited = new Uint8Array(triCount);
  let nextShell = 0;
  for (let seed = 0; seed < triCount; seed++) {
    if (visited[seed]) continue;
    const id = nextShell++;
    const queue = [seed];
    visited[seed] = 1;
    shellId[seed] = id;
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      const neighbors = adjacency[cur];
      if (!neighbors) continue;
      for (const { neighbor } of neighbors) {
        if (!visited[neighbor]) {
          visited[neighbor] = 1;
          shellId[neighbor] = id;
          queue.push(neighbor);
        }
      }
    }
  }
  return shellId;
}
