import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { unzipSync } from 'fflate';
import * as THREE from 'three';

const stlLoader = new STLLoader();
const objLoader = new OBJLoader();

/**
 * Load an STL from a File object.
 * Returns { geometry, bounds } where bounds = { min, max, center, size } (THREE.Vector3).
 * The geometry is translated so its bounding-box centre is at the world origin.
 */
export function loadSTLFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const geometry = stlLoader.parse(e.target.result);
        setupGeometry(geometry);
        const bounds = computeBounds(geometry);
        resolve({ geometry, bounds });
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Ensure vertex normals exist, then centre the geometry on its bounding-box centroid.
 */
function setupGeometry(geometry) {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const centre = new THREE.Vector3();
  box.getCenter(centre);
  geometry.translate(-centre.x, -centre.y, -centre.z);
  geometry.computeBoundingBox();
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
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
 * Load an OBJ from a File object.
 * Returns { geometry, bounds }.
 */
export function loadOBJFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const group = objLoader.parse(e.target.result);
        const geometry = mergeGroupGeometries(group);
        setupGeometry(geometry);
        const bounds = computeBounds(geometry);
        resolve({ geometry, bounds });
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
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const geometry = parse3MF(new Uint8Array(e.target.result));
        setupGeometry(geometry);
        const bounds = computeBounds(geometry);
        resolve({ geometry, bounds });
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsArrayBuffer(file);
  });
}

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

  function getAttr(el, ns, name) {
    return el.getAttributeNS(ns, name) || el.getAttribute(ns.split('/').pop() + ':' + name);
  }

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
      const triangles = new Uint32Array(triEls.length * 3);
      for (let i = 0; i < triEls.length; i++) {
        triangles[i * 3]     = parseInt(triEls[i].getAttribute('v1'), 10);
        triangles[i * 3 + 1] = parseInt(triEls[i].getAttribute('v2'), 10);
        triangles[i * 3 + 2] = parseInt(triEls[i].getAttribute('v3'), 10);
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
  const rootNorm = rootPath.replace(/^\//, '').replace(/\\/g, '/');

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

  function resolveObject(filePath, objectId, parentMatrix) {
    const normFile = filePath.replace(/^\//, '').replace(/\\/g, '/');
    const key = normFile + '#' + objectId;

    // If this object has a mesh, emit an instance
    if (objectMap.has(key)) {
      instances.push({ meshKey: key, matrix: parentMatrix.clone() });
    }

    // Also check for components (the object may have both mesh + components,
    // or only components referencing other objects)
    const doc = readXML(filePath);
    if (!doc) return;
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
        resolveObject(compPath, compObjId, combined);
      }
    }
  }

  // Start from <build> items in root model
  const buildItems = rootDoc.getElementsByTagNameNS(NS_CORE, 'item');
  if (buildItems.length > 0) {
    for (const item of buildItems) {
      const objId = item.getAttribute('objectid');
      const itemTransform = parseTransform(item.getAttribute('transform'));
      resolveObject(rootPath, objId, itemTransform);
    }
  } else {
    // No build section — just use all meshes directly
    for (const [key] of objectMap) {
      instances.push({ meshKey: key, matrix: new THREE.Matrix4() });
    }
  }

  if (instances.length === 0) {
    // Fallback: use all parsed meshes
    for (const [key] of objectMap) {
      instances.push({ meshKey: key, matrix: new THREE.Matrix4() });
    }
  }

  // Build non-indexed BufferGeometry from all instances
  let totalTris = 0;
  for (const inst of instances) {
    const mesh = objectMap.get(inst.meshKey);
    if (mesh) totalTris += mesh.triangles.length / 3;
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
