/**
 * pipeline.mjs — headless glue between MCP tools and the real BumpMesh
 * pipeline modules in ../../js/*.js. No DOM, no WebGL: file -> geometry,
 * texture -> ImageData, run the pipeline, geometry -> file bytes.
 */

import './bootstrap.mjs'; // installs globalThis.DOMParser — MUST precede js/ imports

import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import { THREE } from '../../js/threeCompat.js';
import { parseModelBuffer, getTriangleCount, computeSurfaceArea } from '../../js/stlLoader.js';
import { buildAdjacency } from '../../js/exclusion.js';
import { runFastDiagnostics } from '../../js/meshValidation.js';
import { countAreaSlivers } from '../../js/meshRepair.js';
import { subdivide } from '../../js/subdivision.js';
import { decimate } from '../../js/decimation.js';
import { runExportPipeline } from '../../js/exportPipeline.js';
import { buildSTLBytes, build3MFBytes } from '../../js/exporter.js';

import { buildSettings, buildRegularizeOpts } from './settings.mjs';
import { resolveTexture, loadTextureImageData, validTextureNames } from './textures.mjs';

/** Load a mesh file (.stl/.obj/.3mf) into {geometry, bounds, ...}. */
export async function loadModel(filePath) {
  const buf = await readFile(filePath);
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return parseModelBuffer(arrayBuffer, ext);
}

/** Build a non-indexed THREE.BufferGeometry from raw position/normal arrays. */
export function geometryFromArrays(positions, normals) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (normals) geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  return geometry;
}

export function inferFormat(outputPath, explicitFormat) {
  if (explicitFormat) return explicitFormat;
  const ext = path.extname(outputPath).slice(1).toLowerCase();
  return ext === '3mf' ? '3mf' : 'stl';
}

export function bytesForFormat(geometry, format) {
  return format === '3mf' ? build3MFBytes(geometry) : buildSTLBytes(geometry);
}

/** Write bytes to a temp path in the same directory, then rename — never
 * leaves a partial file at `outputPath` on failure. */
export async function writeMeshFile(outputPath, bytes) {
  const dir = path.dirname(outputPath);
  const tmp = path.join(dir, `.${path.basename(outputPath)}.tmp-${process.pid}-${Date.now()}`);
  await writeFile(tmp, bytes);
  try {
    await rename(tmp, outputPath);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

function boundsToPlain(bounds) {
  return {
    min: { x: bounds.min.x, y: bounds.min.y, z: bounds.min.z },
    max: { x: bounds.max.x, y: bounds.max.y, z: bounds.max.z },
    size: { x: bounds.size.x, y: bounds.size.y, z: bounds.size.z },
  };
}

export async function inspectMeshAt(filePath) {
  const { geometry, bounds, nanCount, degenerateCount } = await loadModel(filePath);
  const triangles = getTriangleCount(geometry);
  const surfaceArea = computeSurfaceArea(geometry);
  const adjData = buildAdjacency(geometry);
  const fast = runFastDiagnostics(adjData, triangles);
  const warnings = [];
  if (nanCount > 0) warnings.push(`${nanCount} triangle(s) with non-finite coordinates were removed on load.`);
  if (degenerateCount > 0) warnings.push(`${degenerateCount} degenerate (near-zero-area) triangle(s) were removed on load.`);
  if (fast.shellCount > 1) warnings.push(`Mesh has ${fast.shellCount} disconnected shells.`);
  if (fast.openEdges > 0) warnings.push(`Mesh has ${fast.openEdges} open edge(s) — not watertight.`);
  if (fast.nonManifoldEdges > 0) warnings.push(`Mesh has ${fast.nonManifoldEdges} non-manifold edge(s).`);

  return {
    triangles,
    boundingBox: boundsToPlain(bounds),
    surfaceArea,
    watertight: fast.openEdges === 0 && fast.nonManifoldEdges === 0,
    shells: fast.shellCount,
    warnings,
  };
}

export async function validateMeshAt(filePath) {
  const { geometry } = await loadModel(filePath);
  const triangles = getTriangleCount(geometry);
  const adjData = buildAdjacency(geometry);
  const fast = runFastDiagnostics(adjData, triangles);
  const slivers = countAreaSlivers(geometry);
  return {
    openEdges: fast.openEdges,
    nonManifoldEdges: fast.nonManifoldEdges,
    shells: fast.shellCount,
    slivers,
    watertight: fast.openEdges === 0 && fast.nonManifoldEdges === 0,
  };
}

/**
 * Resolve the texture source to an absolute image path. EXACTLY ONE of
 * `texture` (preset name/filename, or a literal image path) or
 * `customImagePath` (explicit image path) must be provided.
 *
 * @returns {{ path: string, source: 'customImagePath'|'preset'|'texture-path', label: string }}
 */
function resolveTextureSource(params) {
  const hasTexture = params.texture !== undefined && params.texture !== null && params.texture !== '';
  const hasCustom =
    params.customImagePath !== undefined && params.customImagePath !== null && params.customImagePath !== '';

  if (hasTexture && hasCustom) {
    throw new Error(
      'Provide exactly one texture source: either `texture` (preset name/filename) OR ' +
        '`customImagePath` (image path), not both.'
    );
  }
  if (!hasTexture && !hasCustom) {
    throw new Error(
      'No texture source provided. Set `texture` to a built-in preset name ' +
        `(${validTextureNames().join(', ')}) or an image path, or set \`customImagePath\` to an image path.`
    );
  }

  if (hasCustom) {
    return { path: params.customImagePath, source: 'customImagePath', label: `customImagePath "${params.customImagePath}"` };
  }
  const preset = resolveTexture(params.texture);
  if (preset) {
    return { path: preset, source: 'preset', label: `preset "${params.texture}"` };
  }
  // Not a known preset — treat the string as a literal image path.
  return { path: params.texture, source: 'texture-path', label: `texture path "${params.texture}"` };
}

export async function runTexturize(params) {
  const { geometry, bounds } = await loadModel(params.input);
  const positions = geometry.attributes.position.array;

  const src = resolveTextureSource(params);
  let imageData;
  try {
    imageData = await loadTextureImageData(src.path, params.textureSmoothing ?? 0);
  } catch (err) {
    const hint =
      src.source === 'preset'
        ? ''
        : ` Valid built-in preset names: ${validTextureNames().join(', ')}.`;
    throw new Error(`Could not load ${src.label} (resolved to "${src.path}"): ${err.message}.${hint}`);
  }

  const settings = buildSettings(params);
  const regularizeOpts = buildRegularizeOpts(settings);

  const result = await runExportPipeline(
    {
      positions,
      faceWeights: null,
      imageData,
      imgWidth: imageData.width,
      imgHeight: imageData.height,
      settings,
      bounds,
      regularizeOpts,
      mode: 'export',
    },
    () => {},
    () => false
  );

  if (!result) throw new Error('Pipeline aborted unexpectedly.');

  const warnings = [];
  if (result.safetyCapHit) {
    warnings.push(
      'Subdivision hit the internal safety cap on triangle count; texture detail may be limited. Consider a larger refineLength.'
    );
  }
  if (result.repairStats && (result.repairStats.open > 0 || result.repairStats.nonManifold > 0)) {
    warnings.push(
      `Watertight repair left ${result.repairStats.open} open edge(s) and ${result.repairStats.nonManifold} non-manifold edge(s).`
    );
  }

  const minDim = Math.min(bounds.size.x, bounds.size.y, bounds.size.z);
  let overlapWarning;
  if (Math.abs(settings.amplitude) > minDim * 0.1) {
    overlapWarning =
      `Amplitude (${settings.amplitude} mm) exceeds 10% of the model's smallest bounding-box ` +
      `dimension (${minDim.toFixed(3)} mm); the texture may self-intersect or punch through thin walls.`;
    warnings.push(overlapWarning);
  }

  const outGeometry = geometryFromArrays(result.positions, result.normals);
  const format = inferFormat(params.output, params.format);
  const bytes = bytesForFormat(outGeometry, format);
  await writeMeshFile(params.output, bytes);

  const triangles = result.positions.length / 9;
  return {
    outputPath: path.resolve(params.output),
    triangles,
    bytes: bytes.byteLength,
    warnings,
    ...(overlapWarning ? { overlapWarning } : {}),
  };
}

export async function runSubdivide(params) {
  const { geometry } = await loadModel(params.input);
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  const { geometry: outGeom, safetyCapHit } = await subdivide(geometry, params.refineLength, () => {}, null);
  const format = inferFormat(params.output);
  const bytes = bytesForFormat(outGeom, format);
  await writeMeshFile(params.output, bytes);
  return {
    outputPath: path.resolve(params.output),
    triangles: getTriangleCount(outGeom),
    safetyCapHit,
  };
}

export async function runDecimate(params) {
  const { geometry } = await loadModel(params.input);
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  const outGeom = await decimate(geometry, params.targetTriangles, () => {}, true, 0.005);
  const format = inferFormat(params.output);
  const bytes = bytesForFormat(outGeom, format);
  await writeMeshFile(params.output, bytes);
  return {
    outputPath: path.resolve(params.output),
    triangles: getTriangleCount(outGeom),
  };
}

function faceNormalAndArea(pos, t) {
  const b = t * 9;
  const ax = pos[b], ay = pos[b + 1], az = pos[b + 2];
  const bx = pos[b + 3], by = pos[b + 4], bz = pos[b + 5];
  const cx = pos[b + 6], cy = pos[b + 7], cz = pos[b + 8];
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  return { nx: nx / len, ny: ny / len, nz: nz / len, area: len * 0.5, cz: (az + bz + cz) / 3 };
}

/**
 * Orient a mesh so a chosen face sits flat on the print bed (Z=0).
 *
 * No reusable pure helper exists upstream for this, so this is a simple,
 * self-contained implementation: pick a face normal, rotate the whole mesh
 * so that normal points to -Z, then translate the new minimum Z to 0.
 *
 *  - 'auto':   groups triangles by (quantized) face-normal direction and
 *              picks the direction with the largest total triangle area —
 *              the biggest flat facet becomes the base (best print stability).
 *  - 'lowest': picks whichever triangle's centroid currently has the
 *              smallest Z (already closest to the bed) and flattens onto it.
 *  - <index>:  an explicit 0-based triangle index (non-indexed geometry, so
 *              index i's triangle spans positions[i*9 .. i*9+9)).
 */
export async function runPlaceOnBed(params) {
  const { geometry } = await loadModel(params.input);
  const pos = geometry.attributes.position.array;
  const triCount = pos.length / 9;
  if (triCount === 0) throw new Error('Mesh has no triangles.');

  const faceParam = params.face ?? 'auto';
  let chosenNormal;
  let chosenFaceIndex = null;

  if (typeof faceParam === 'number') {
    const idx = Math.trunc(faceParam);
    if (idx < 0 || idx >= triCount) {
      throw new Error(`face index ${idx} out of range [0, ${triCount - 1}].`);
    }
    chosenFaceIndex = idx;
    const fa = faceNormalAndArea(pos, idx);
    chosenNormal = { x: fa.nx, y: fa.ny, z: fa.nz };
  } else if (faceParam === 'lowest') {
    let bestT = 0, bestCz = Infinity;
    for (let t = 0; t < triCount; t++) {
      const cz = (pos[t * 9 + 2] + pos[t * 9 + 5] + pos[t * 9 + 8]) / 3;
      if (cz < bestCz) { bestCz = cz; bestT = t; }
    }
    chosenFaceIndex = bestT;
    const fa = faceNormalAndArea(pos, bestT);
    chosenNormal = { x: fa.nx, y: fa.ny, z: fa.nz };
  } else if (faceParam === 'auto') {
    const buckets = new Map();
    const QN = 200; // direction-quantization steps
    for (let t = 0; t < triCount; t++) {
      const fa = faceNormalAndArea(pos, t);
      const key = `${Math.round(fa.nx * QN)}_${Math.round(fa.ny * QN)}_${Math.round(fa.nz * QN)}`;
      const entry = buckets.get(key) || { area: 0, nx: 0, ny: 0, nz: 0, n: 0 };
      entry.area += fa.area;
      entry.nx += fa.nx; entry.ny += fa.ny; entry.nz += fa.nz; entry.n++;
      buckets.set(key, entry);
    }
    let best = null;
    for (const entry of buckets.values()) {
      if (!best || entry.area > best.area) best = entry;
    }
    chosenNormal = { x: best.nx / best.n, y: best.ny / best.n, z: best.nz / best.n };
  } else {
    throw new Error(`Invalid face "${faceParam}". Use 'auto', 'lowest', or a triangle index.`);
  }

  const len = Math.hypot(chosenNormal.x, chosenNormal.y, chosenNormal.z) || 1;
  const from = new THREE.Vector3(chosenNormal.x / len, chosenNormal.y / len, chosenNormal.z / len);
  const target = new THREE.Vector3(0, 0, -1);
  const quat = new THREE.Quaternion().setFromUnitVectors(from, target);
  geometry.applyQuaternion(quat);

  geometry.computeBoundingBox();
  const minZ = geometry.boundingBox.min.z;
  geometry.translate(0, 0, -minZ);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();

  const bb = geometry.boundingBox;
  const format = inferFormat(params.output);
  const bytes = bytesForFormat(geometry, format);
  await writeMeshFile(params.output, bytes);

  return {
    outputPath: path.resolve(params.output),
    face: faceParam,
    chosenFaceIndex,
    triangles: getTriangleCount(geometry),
    boundingBox: {
      min: { x: bb.min.x, y: bb.min.y, z: bb.min.z },
      max: { x: bb.max.x, y: bb.max.y, z: bb.max.z },
    },
  };
}
