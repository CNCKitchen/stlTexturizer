import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { unzipSync } from 'fflate';
import * as THREE from 'three';

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB

const stlLoader = new STLLoader();
const objLoader = new OBJLoader();

/**
 * Load an STL from a File object.
 * Returns { geometry, bounds } where bounds = { min, max, center, size } (THREE.Vector3).
 * The geometry is translated so its bounding-box centre is at the world origin.
 */
export function loadSTLFile(file) {
  if (file.size > MAX_FILE_SIZE) {
    return Promise.reject(new Error(
      'File too large (' + Math.round(file.size / 1024 / 1024) + ' MB). Maximum supported: ' + (MAX_FILE_SIZE / 1024 / 1024) + ' MB.'
    ));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const geometry = stlLoader.parse(e.target.result);
        const { nanCount, degenerateCount, originOffset } = setupGeometry(geometry);
        const bounds = computeBounds(geometry);
        resolve({ geometry, bounds, nanCount, degenerateCount, originOffset });
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Scan a non-indexed geometry's position array and remove:
 *   - triangles with any non-finite (NaN / ±Infinity) coordinate
 *   - degenerate triangles whose area is below 1e-12 mm²
 *
 * Operates in-place by compacting the Float32Array and replacing the
 * BufferAttribute. Any existing normal attribute is deleted so that
 * setupGeometry will recompute it on the clean data.
 *
 * Returns { nanCount, degenerateCount } so callers can warn the user.
 */
function validateAndCleanGeometry(geometry) {
  const pos  = geometry.attributes.position;
  const src  = pos.array;           // Float32Array, 9 floats per triangle
  const triCount = src.length / 9;

  let writeIdx = 0;
  let nanCount = 0;
  let degenerateCount = 0;

  for (let t = 0; t < triCount; t++) {
    const b  = t * 9;
    const ax = src[b],   ay = src[b+1], az = src[b+2];
    const bx = src[b+3], by = src[b+4], bz = src[b+5];
    const cx = src[b+6], cy = src[b+7], cz = src[b+8];

    if (!isFinite(ax) || !isFinite(ay) || !isFinite(az) ||
        !isFinite(bx) || !isFinite(by) || !isFinite(bz) ||
        !isFinite(cx) || !isFinite(cy) || !isFinite(cz)) {
      nanCount++;
      continue;
    }

    // Cross product of (B−A) × (C−A); skip if area² < 1e-24 (area < 1e-12)
    const ux = bx-ax, uy = by-ay, uz = bz-az;
    const vx = cx-ax, vy = cy-ay, vz = cz-az;
    const area2 = (uy*vz-uz*vy)**2 + (uz*vx-ux*vz)**2 + (ux*vy-uy*vx)**2;
    if (area2 < 1e-24) {
      degenerateCount++;
      continue;
    }

    if (writeIdx !== b) {
      src[writeIdx]   = ax; src[writeIdx+1] = ay; src[writeIdx+2] = az;
      src[writeIdx+3] = bx; src[writeIdx+4] = by; src[writeIdx+5] = bz;
      src[writeIdx+6] = cx; src[writeIdx+7] = cy; src[writeIdx+8] = cz;
    }
    writeIdx += 9;
  }

  const removed = nanCount + degenerateCount;
  if (removed > 0) {
    geometry.setAttribute('position', new THREE.BufferAttribute(src.slice(0, writeIdx), 3));
    geometry.deleteAttribute('normal'); // stale — recomputed below
  }

  if (writeIdx === 0) {
    throw new Error(
      `All ${triCount} triangles in the mesh are invalid (${nanCount} NaN, ${degenerateCount} degenerate). Cannot load file.`
    );
  }

  return { nanCount, degenerateCount };
}

/**
 * Validate, centre, and compute normals for a freshly parsed geometry.
 * Returns { nanCount, degenerateCount, originOffset }: removed-triangle counts
 * for caller warnings, plus the translation that was subtracted to centre the
 * mesh. The app folds originOffset into its pose transform and undoes it on
 * export so files keep their original world coordinates and stay aligned with
 * sibling parts (issue #82).
 */
function setupGeometry(geometry) {
  const { nanCount, degenerateCount } = validateAndCleanGeometry(geometry);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const centre = new THREE.Vector3();
  box.getCenter(centre);
  geometry.translate(-centre.x, -centre.y, -centre.z);
  geometry.computeBoundingBox();
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  return { nanCount, degenerateCount, originOffset: centre };
}

/**
 * Compute the bounds object that all UV mapping functions depend on.
 * Must be called after the geometry has been centred.
 */
export function computeBounds(geometry) {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const min  = box.min.clone();
  const max  = box.max.clone();
  const size = new THREE.Vector3();
  box.getSize(size);
  const center = new THREE.Vector3();
  box.getCenter(center);
  return { min, max, center, size };
}

/**
 * Triangle count helper.
 */
export function getTriangleCount(geometry) {
  const pos = geometry.attributes.position;
  return geometry.index
    ? geometry.index.count / 3
    : pos.count / 3;
}

/**
 * Total surface area of a geometry, in the same units as the position attribute.
 * Sums ½‖(v1 − v0) × (v2 − v0)‖ over every triangle.  Handles both indexed and
 * non-indexed BufferGeometries.
 */
export function computeSurfaceArea(geometry) {
  const posAttr = geometry.attributes.position;
  if (!posAttr) return 0;
  const pos = posAttr.array;
  const idx = geometry.index ? geometry.index.array : null;
  let area = 0;

  const get = (vi, out) => {
    const o = vi * 3;
    out[0] = pos[o]; out[1] = pos[o + 1]; out[2] = pos[o + 2];
  };
  const a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0];

  const triCount = idx ? idx.length / 3 : pos.length / 9;
  for (let t = 0; t < triCount; t++) {
    if (idx) {
      get(idx[t * 3],     a);
      get(idx[t * 3 + 1], b);
      get(idx[t * 3 + 2], c);
    } else {
      const o = t * 9;
      a[0] = pos[o];     a[1] = pos[o + 1]; a[2] = pos[o + 2];
      b[0] = pos[o + 3]; b[1] = pos[o + 4]; b[2] = pos[o + 5];
      c[0] = pos[o + 6]; c[1] = pos[o + 7]; c[2] = pos[o + 8];
    }
    const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2];
    const e2x = c[0] - a[0], e2y = c[1] - a[1], e2z = c[2] - a[2];
    const cx = e1y * e2z - e1z * e2y;
    const cy = e1z * e2x - e1x * e2z;
    const cz = e1x * e2y - e1y * e2x;
    area += 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
  }
  return area;
}

/**
 * Load an OBJ from a File object.
 * Returns { geometry, bounds }.
 */
export function loadOBJFile(file) {
  if (file.size > MAX_FILE_SIZE) {
    return Promise.reject(new Error(
      'File too large (' + Math.round(file.size / 1024 / 1024) + ' MB). Maximum supported: ' + (MAX_FILE_SIZE / 1024 / 1024) + ' MB.'
    ));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const group = objLoader.parse(e.target.result);
        const geometry = mergeGroupGeometries(group);
        const { nanCount, degenerateCount, originOffset } = setupGeometry(geometry);
        const bounds = computeBounds(geometry);
        resolve({ geometry, bounds, nanCount, degenerateCount, originOffset });
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsText(file);
  });
}

/**
 * Load a 3MF from a File object.
 * Custom parser that handles Bambu Studio / PrusaSlicer multi-file 3MF
 * where meshes live in 3D/Objects/ subfiles referenced via the production
 * extension (p:path on <component> elements).
 * Returns { geometry, bounds }.
 */
export function load3MFFile(file) {
  if (file.size > MAX_FILE_SIZE) {
    return Promise.reject(new Error(
      'File too large (' + Math.round(file.size / 1024 / 1024) + ' MB). Maximum supported: ' + (MAX_FILE_SIZE / 1024 / 1024) + ' MB.'
    ));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const geometry = parse3MF(new Uint8Array(e.target.result));
        const { nanCount, degenerateCount, originOffset } = setupGeometry(geometry);
        const bounds = computeBounds(geometry);
        resolve({ geometry, bounds, nanCount, degenerateCount, originOffset });
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsArrayBuffer(file);
  });
}

const MAX_3MF_TRIANGLES = 10_000_000;
const MAX_3MF_DEPTH     = 32;

// ── Custom 3MF parser ────────────────────────────────────────────────────────

function parse3MF(data) {
  const files = unzipSync(data);
  const decoder = new TextDecoder();
  const parser  = new DOMParser();

  // Helper: read a file from the zip (keys may have or lack leading slash)
  function readXML(path) {
    const clean = path.replace(/^\//, '');
    const bytes = files[clean] || files['/' + clean];
    if (!bytes) return null;
    return parser.parseFromString(decoder.decode(bytes), 'application/xml');
  }

  // Namespace-aware element queries
  const NS_CORE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
  const NS_PROD = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';

  // 3MF Core Spec unit values → millimeters. Used to normalise incoming models
  // to this project's internal mm convention. Note: in multi-file production
  // 3MFs, per-spec each .model file could theoretically declare its own unit,
  // but in practice slicers always use one unit globally — we use the root
  // model's unit for the whole build.
  const UNIT_TO_MM = {
    micron:     0.001,
    millimeter: 1,
    centimeter: 10,
    inch:       25.4,
    foot:       304.8,
    meter:      1000,
  };

  // Parse all model files and collect objects by (filePath, id)
  // objectMap: "path#id" → { vertices: Float32Array, triangles: Uint32Array }
  const objectMap = new Map();

  // Find all .model files in the zip
  const modelPaths = Object.keys(files).filter(f => f.endsWith('.model'));

  for (const path of modelPaths) {
    const doc = readXML(path);
    if (!doc) continue;
    const objects = doc.getElementsByTagNameNS(NS_CORE, 'object');
    for (const obj of objects) {
      const id = obj.getAttribute('id');
      const meshEl = obj.getElementsByTagNameNS(NS_CORE, 'mesh')[0];
      if (!meshEl) continue; // component-only object, no inline mesh

      const vertEls  = meshEl.getElementsByTagNameNS(NS_CORE, 'vertex');
      const triEls   = meshEl.getElementsByTagNameNS(NS_CORE, 'triangle');
      const vertices = new Float32Array(vertEls.length * 3);
      for (let i = 0; i < vertEls.length; i++) {
        vertices[i * 3]     = parseFloat(vertEls[i].getAttribute('x'));
        vertices[i * 3 + 1] = parseFloat(vertEls[i].getAttribute('y'));
        vertices[i * 3 + 2] = parseFloat(vertEls[i].getAttribute('z'));
      }
      // Validate raw attrs before storing — Uint32Array coerces on write
      // (NaN→0, negatives wrap), so post-hoc checks can't catch bad input.
      const vertCount  = vertEls.length;
      const triangles  = new Uint32Array(triEls.length * 3);
      for (let i = 0; i < triEls.length; i++) {
        for (let j = 0; j < 3; j++) {
          const raw = triEls[i].getAttribute('v' + (j + 1));
          const idx = (raw !== null && /^[0-9]+$/.test(raw.trim())) ? Number(raw) : NaN;
          if (!Number.isInteger(idx) || idx >= vertCount) {
            throw new Error('Invalid triangle index in 3MF file');
          }
          triangles[i * 3 + j] = idx;
        }
      }

      // Normalise path for lookup (strip leading slash, use forward slashes)
      const normPath = path.replace(/^\//, '').replace(/\\/g, '/');
      objectMap.set(normPath + '#' + id, { vertices, triangles });
    }
  }

  if (objectMap.size === 0) throw new Error('No mesh data found in 3MF file');

  // Resolve the root model's build items → collect (objectRef, transform) pairs
  // Then recursively expand components to get final (meshRef, worldTransform) list.
  const rootPath = modelPaths.find(p => /^3D\/3dmodel\.model$/i.test(p.replace(/^\//, '')))
                || modelPaths[0];
  const rootDoc  = readXML(rootPath);

  // Read the model unit and build a uniform scale matrix that converts the
  // file's coordinates to millimeters. Pre-multiplying this into each build
  // item's transform propagates the scale through every nested component
  // transform — both rotation/scale parts and translation parts.
  const rootUnit  = (rootDoc.documentElement.getAttribute('unit') || 'millimeter').toLowerCase();
  const unitScale = UNIT_TO_MM[rootUnit] ?? 1;
  const unitMatrix = new THREE.Matrix4().makeScale(unitScale, unitScale, unitScale);

  // Collect final mesh instances: { meshKey, matrix }
  const instances = [];

  function parseTransform(str) {
    if (!str) return new THREE.Matrix4();
    const v = str.trim().split(/\s+/).map(Number);
    if (v.length === 12) {
      // 3MF row-major 3×4: m00 m01 m02  m10 m11 m12  m20 m21 m22  tx ty tz
      return new THREE.Matrix4().set(
        v[0], v[3], v[6], v[9],
        v[1], v[4], v[7], v[10],
        v[2], v[5], v[8], v[11],
        0,    0,    0,    1,
      );
    }
    return new THREE.Matrix4();
  }

  function resolveObject(filePath, objectId, parentMatrix, visiting = new Set(), depth = 0) {
    if (depth > MAX_3MF_DEPTH) {
      throw new Error('3MF component hierarchy too deep — possible cyclic reference');
    }

    const normFile = filePath.replace(/^\//, '').replace(/\\/g, '/');
    const key = normFile + '#' + objectId;

    if (visiting.has(key)) {
      throw new Error(`Cyclic component reference detected in 3MF file (${key})`);
    }
    visiting.add(key);

    // If this object has a mesh, emit an instance
    if (objectMap.has(key)) {
      instances.push({ meshKey: key, matrix: parentMatrix.clone() });
    }

    // Also check for components (the object may have both mesh + components,
    // or only components referencing other objects)
    const doc = readXML(filePath);
    if (!doc) { visiting.delete(key); return; }
    const objects = doc.getElementsByTagNameNS(NS_CORE, 'object');
    for (const obj of objects) {
      if (obj.getAttribute('id') !== objectId) continue;
      const components = obj.getElementsByTagNameNS(NS_CORE, 'component');
      for (const comp of components) {
        const compObjId = comp.getAttribute('objectid');
        // p:path attribute tells us which file the referenced object lives in
        let compPath = comp.getAttributeNS(NS_PROD, 'path')
                    || comp.getAttribute('p:path')
                    || filePath;
        if (!compPath.startsWith('/') && !compPath.startsWith('3D')) {
          compPath = '/' + compPath;
        }
        const compTransform = parseTransform(comp.getAttribute('transform'));
        const combined = parentMatrix.clone().multiply(compTransform);
        resolveObject(compPath, compObjId, combined, visiting, depth + 1);
      }
    }

    visiting.delete(key);
  }

  // Start from <build> items in root model
  const buildItems = rootDoc.getElementsByTagNameNS(NS_CORE, 'item');
  if (buildItems.length > 0) {
    for (const item of buildItems) {
      const objId = item.getAttribute('objectid');
      const itemTransform = parseTransform(item.getAttribute('transform'));
      const seedMatrix = unitMatrix.clone().multiply(itemTransform);
      resolveObject(rootPath, objId, seedMatrix);
    }
  } else {
    // No build section — just use all meshes directly with the unit scale applied
    for (const [key] of objectMap) {
      instances.push({ meshKey: key, matrix: unitMatrix.clone() });
    }
  }

  if (instances.length === 0) {
    // Fallback: use all parsed meshes with the unit scale applied
    for (const [key] of objectMap) {
      instances.push({ meshKey: key, matrix: unitMatrix.clone() });
    }
  }

  // Build non-indexed BufferGeometry from all instances
  let totalTris = 0;
  for (const inst of instances) {
    const mesh = objectMap.get(inst.meshKey);
    if (mesh) totalTris += mesh.triangles.length / 3;
  }

  if (totalTris > MAX_3MF_TRIANGLES) {
    throw new Error(
      `3MF file contains ${totalTris.toLocaleString()} triangles, exceeding the ${MAX_3MF_TRIANGLES.toLocaleString()} limit`
    );
  }

  const positions = new Float32Array(totalTris * 9);
  let writeOffset = 0;
  const tmpV = new THREE.Vector3();

  for (const inst of instances) {
    const mesh = objectMap.get(inst.meshKey);
    if (!mesh) continue;
    const { vertices, triangles } = mesh;
    for (let t = 0; t < triangles.length; t += 3) {
      for (let v = 0; v < 3; v++) {
        const vi = triangles[t + v];
        tmpV.set(vertices[vi * 3], vertices[vi * 3 + 1], vertices[vi * 3 + 2]);
        tmpV.applyMatrix4(inst.matrix);
        positions[writeOffset++] = tmpV.x;
        positions[writeOffset++] = tmpV.y;
        positions[writeOffset++] = tmpV.z;
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geometry;
}

/**
 * Unified loader: dispatches to the right parser based on file extension.
 */
export function loadModelFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'obj') return loadOBJFile(file);
  if (ext === '3mf') return load3MFFile(file);
  return loadSTLFile(file);
}

/**
 * Extract and merge all mesh geometries from a Group (OBJ/3MF) into a single
 * non-indexed BufferGeometry suitable for the texturizer pipeline.
 */
function mergeGroupGeometries(group) {
  const geometries = [];
  group.traverse((child) => {
    if (child.isMesh && child.geometry) {
      // Apply the mesh's world transform to the geometry
      const geo = child.geometry.clone();
      child.updateWorldMatrix(true, false);
      geo.applyMatrix4(child.matrixWorld);
      // Convert indexed → non-indexed so vertex layout matches our pipeline
      if (geo.index) {
        geometries.push(geo.toNonIndexed());
        geo.dispose();
      } else {
        geometries.push(geo);
      }
    }
  });
  if (geometries.length === 0) throw new Error('No mesh data found in file');
  if (geometries.length === 1) return geometries[0];

  // Merge multiple geometries into one
  const totalVerts = geometries.reduce((sum, g) => sum + g.attributes.position.count, 0);
  const mergedPos = new Float32Array(totalVerts * 3);
  let mergedNrm = null;
  const hasNormals = geometries.every(g => g.attributes.normal);
  if (hasNormals) mergedNrm = new Float32Array(totalVerts * 3);
  let offset = 0;
  for (const g of geometries) {
    const posArr = g.attributes.position.array;
    mergedPos.set(posArr, offset * 3);
    if (hasNormals && mergedNrm) {
      mergedNrm.set(g.attributes.normal.array, offset * 3);
    }
    offset += g.attributes.position.count;
    g.dispose();
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(mergedPos, 3));
  if (mergedNrm) merged.setAttribute('normal', new THREE.BufferAttribute(mergedNrm, 3));
  return merged;
}
