import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { unzipSync } from 'fflate';
import * as THREE from 'three';
import { set3mfBodies, clear3mfBodies } from './exporter.js';

const MAX_FILE_SIZE = 500 * 1024 * 1024;

const stlLoader = new STLLoader();
const objLoader = new OBJLoader();

export function loadSTLFile(file) {
  if (file.size > MAX_FILE_SIZE) {
    return Promise.reject(new Error(
      'File too large (' + Math.round(file.size / 1024 / 1024) + ' MB). Maximum supported: ' + (MAX_FILE_SIZE / 1024 / 1024) + ' MB.'
    ));
  }
  clear3mfBodies();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const geometry = stlLoader.parse(e.target.result);
        const { nanCount, degenerateCount } = setupGeometry(geometry);
        const bounds = computeBounds(geometry);
        resolve({ geometry, bounds, nanCount, degenerateCount });
      } catch (err) { reject(err); }
    };
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsArrayBuffer(file);
  });
}

function validateAndCleanGeometry(geometry) {
  const src      = geometry.attributes.position.array;
  const triCount = (src.length / 9) | 0;
  let writeIdx = 0, nanCount = 0, degenerateCount = 0;

  for (let t = 0; t < triCount; t++) {
    const b  = t * 9;
    const ax = src[b],   ay = src[b+1], az = src[b+2];
    const bx = src[b+3], by = src[b+4], bz = src[b+5];
    const cx = src[b+6], cy = src[b+7], cz = src[b+8];

    if (!isFinite(ax)||!isFinite(ay)||!isFinite(az)||
        !isFinite(bx)||!isFinite(by)||!isFinite(bz)||
        !isFinite(cx)||!isFinite(cy)||!isFinite(cz)) { nanCount++; continue; }

    const ux=bx-ax,uy=by-ay,uz=bz-az, vx=cx-ax,vy=cy-ay,vz=cz-az;
    if ((uy*vz-uz*vy)**2+(uz*vx-ux*vz)**2+(ux*vy-uy*vx)**2 < 1e-24) { degenerateCount++; continue; }

    if (writeIdx !== t) {
      const outB = writeIdx * 9;
      src[outB]=ax; src[outB+1]=ay; src[outB+2]=az;
      src[outB+3]=bx; src[outB+4]=by; src[outB+5]=bz;
      src[outB+6]=cx; src[outB+7]=cy; src[outB+8]=cz;
    }
    writeIdx++;
  }

  if (nanCount + degenerateCount > 0) {
    geometry.setAttribute('position', new THREE.BufferAttribute(src.slice(0, writeIdx * 9), 3));
    geometry.deleteAttribute('normal');
  }
  if (writeIdx === 0) throw new Error(
    `All ${triCount} triangles invalid (${nanCount} NaN, ${degenerateCount} degenerate). Cannot load file.`
  );
  return { nanCount, degenerateCount };
}

function setupGeometry(geometry) {
  const result = validateAndCleanGeometry(geometry);
  geometry.computeBoundingBox();
  const centre = new THREE.Vector3();
  geometry.boundingBox.getCenter(centre);
  geometry.translate(-centre.x, -centre.y, -centre.z);
  geometry.computeBoundingBox();
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  return result;
}

export function computeBounds(geometry) {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const min = box.min.clone(), max = box.max.clone();
  const size = new THREE.Vector3(); box.getSize(size);
  const center = new THREE.Vector3(); box.getCenter(center);
  return { min, max, center, size };
}

export function getTriangleCount(geometry) {
  const pos = geometry.attributes.position;
  return geometry.index ? geometry.index.count / 3 : pos.count / 3;
}

export function computeSurfaceArea(geometry) {
  const posAttr = geometry.attributes.position;
  if (!posAttr) return 0;
  const pos = posAttr.array;
  const idx = geometry.index ? geometry.index.array : null;
  let area = 0;
  const a=[0,0,0],b=[0,0,0],c=[0,0,0];
  const get=(vi,o)=>{const p=vi*3;o[0]=pos[p];o[1]=pos[p+1];o[2]=pos[p+2];};
  const triCount = idx ? idx.length/3 : pos.length/9;
  for (let t=0;t<triCount;t++) {
    if(idx){get(idx[t*3],a);get(idx[t*3+1],b);get(idx[t*3+2],c);}
    else{const o=t*9;a[0]=pos[o];a[1]=pos[o+1];a[2]=pos[o+2];b[0]=pos[o+3];b[1]=pos[o+4];b[2]=pos[o+5];c[0]=pos[o+6];c[1]=pos[o+7];c[2]=pos[o+8];}
    const e1x=b[0]-a[0],e1y=b[1]-a[1],e1z=b[2]-a[2];
    const e2x=c[0]-a[0],e2y=c[1]-a[1],e2z=c[2]-a[2];
    const nx=e1y*e2z-e1z*e2y,ny=e1z*e2x-e1x*e2z,nz=e1x*e2y-e1y*e2x;
    area+=0.5*Math.sqrt(nx*nx+ny*ny+nz*nz);
  }
  return area;
}

export function loadOBJFile(file) {
  if (file.size > MAX_FILE_SIZE) {
    return Promise.reject(new Error(
      'File too large (' + Math.round(file.size / 1024 / 1024) + ' MB). Maximum supported: ' + (MAX_FILE_SIZE / 1024 / 1024) + ' MB.'
    ));
  }
  clear3mfBodies();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const group = objLoader.parse(e.target.result);
        const geometry = mergeGroupGeometries(group);
        const { nanCount, degenerateCount } = setupGeometry(geometry);
        const bounds = computeBounds(geometry);
        resolve({ geometry, bounds, nanCount, degenerateCount });
      } catch (err) { reject(err); }
    };
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsText(file);
  });
}

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
        const { geometry, bodyGeometries, centerOffset } = parse3MF(new Uint8Array(e.target.result));
        const { nanCount, degenerateCount } = setupGeometry(geometry);
        set3mfBodies(bodyGeometries, centerOffset);
        const bounds = computeBounds(geometry);
        resolve({ geometry, bounds, nanCount, degenerateCount });
      } catch (err) { reject(err); }
    };
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsArrayBuffer(file);
  });
}

const MAX_3MF_TRIANGLES = 10_000_000;
const MAX_3MF_DEPTH     = 32;

function parse3MF(data) {
  const files   = unzipSync(data);
  const decoder = new TextDecoder();
  const parser  = new DOMParser();

  function readXML(path) {
    const clean = path.replace(/^\//, '');
    const bytes = files[clean] || files['/' + clean];
    if (!bytes) return null;
    return parser.parseFromString(decoder.decode(bytes), 'application/xml');
  }

  const NS_CORE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
  const NS_PROD = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
  const UNIT_TO_MM = { micron:0.001, millimeter:1, centimeter:10, inch:25.4, foot:304.8, meter:1000 };

  const objectMap  = new Map();
  const modelPaths = Object.keys(files).filter(f => f.endsWith('.model'));

  for (const path of modelPaths) {
    const doc = readXML(path);
    if (!doc) continue;
    const objects = doc.getElementsByTagNameNS(NS_CORE, 'object');
    for (const obj of objects) {
      const id     = obj.getAttribute('id');
      const meshEl = obj.getElementsByTagNameNS(NS_CORE, 'mesh')[0];
      if (!meshEl) continue;
      const vertEls   = meshEl.getElementsByTagNameNS(NS_CORE, 'vertex');
      const triEls    = meshEl.getElementsByTagNameNS(NS_CORE, 'triangle');
      const vertices  = new Float32Array(vertEls.length * 3);
      const triangles = new Uint32Array(triEls.length * 3);
      for (let i=0;i<vertEls.length;i++) {
        vertices[i*3]  =parseFloat(vertEls[i].getAttribute('x'));
        vertices[i*3+1]=parseFloat(vertEls[i].getAttribute('y'));
        vertices[i*3+2]=parseFloat(vertEls[i].getAttribute('z'));
      }
      for (let i=0;i<triEls.length;i++) {
        triangles[i*3]  =parseInt(triEls[i].getAttribute('v1'),10);
        triangles[i*3+1]=parseInt(triEls[i].getAttribute('v2'),10);
        triangles[i*3+2]=parseInt(triEls[i].getAttribute('v3'),10);
      }
      const vc = vertEls.length;
      for (let i=0;i<triangles.length;i++) {
        if (triangles[i]<0||triangles[i]>=vc||isNaN(triangles[i]))
          throw new Error('Invalid triangle index in 3MF file');
      }
      const normPath = path.replace(/^\//, '').replace(/\\/g, '/');
      objectMap.set(normPath + '#' + id, { vertices, triangles });
    }
  }

  if (objectMap.size === 0) throw new Error('No mesh data found in 3MF file');

  const rootPath = modelPaths.find(p => /^3D\/3dmodel\.model$/i.test(p.replace(/^\//, ''))) || modelPaths[0];
  const rootDoc  = readXML(rootPath);
  const rootUnit  = (rootDoc.documentElement.getAttribute('unit') || 'millimeter').toLowerCase();
  const unitScale = UNIT_TO_MM[rootUnit] ?? 1;
  const unitMatrix = new THREE.Matrix4().makeScale(unitScale, unitScale, unitScale);

  const instances      = [];
  const itemTransforms = new Map();

  function parseTransform(str) {
    if (!str) return new THREE.Matrix4();
    const v = str.trim().split(/\s+/).map(Number);
    if (v.length === 12) return new THREE.Matrix4().set(
      v[0],v[3],v[6],v[9], v[1],v[4],v[7],v[10], v[2],v[5],v[8],v[11], 0,0,0,1
    );
    return new THREE.Matrix4();
  }

  function resolveObject(filePath, objectId, parentMatrix, buildItemIndex, objectName, visiting=new Set(), depth=0) {
    if (depth > MAX_3MF_DEPTH) throw new Error('3MF component hierarchy too deep');
    const normFile = filePath.replace(/^\//, '').replace(/\\/g, '/');
    const key = normFile + '#' + objectId;
    if (visiting.has(key)) throw new Error(`Cyclic component reference in 3MF (${key})`);
    visiting.add(key);
    if (objectMap.has(key))
      instances.push({ meshKey:key, matrix:parentMatrix.clone(), buildItemIndex, label:objectName||'' });
    const doc = readXML(filePath);
    if (!doc) { visiting.delete(key); return; }
    for (const obj of doc.getElementsByTagNameNS(NS_CORE, 'object')) {
      if (obj.getAttribute('id') !== objectId) continue;
      const thisName = objectName || obj.getAttribute('name') || '';
      for (const comp of obj.getElementsByTagNameNS(NS_CORE, 'component')) {
        const compObjId = comp.getAttribute('objectid');
        let compPath = comp.getAttributeNS(NS_PROD,'path') || comp.getAttribute('p:path') || filePath;
        if (!compPath.startsWith('/')&&!compPath.startsWith('3D')) compPath='/'+compPath;
        resolveObject(compPath, compObjId,
          parentMatrix.clone().multiply(parseTransform(comp.getAttribute('transform'))),
          buildItemIndex, thisName, visiting, depth+1);
      }
    }
    visiting.delete(key);
  }

  const buildItems = rootDoc.getElementsByTagNameNS(NS_CORE, 'item');
  if (buildItems.length > 0) {
    for (let bi=0; bi<buildItems.length; bi++) {
      const item   = buildItems[bi];
      const objId  = item.getAttribute('objectid');
      let itemName = item.getAttribute('p:name') || item.getAttribute('name') || '';
      if (!itemName) {
        outer: for (const path of modelPaths) {
          const doc = readXML(path); if (!doc) continue;
          for (const obj of doc.getElementsByTagNameNS(NS_CORE,'object')) {
            if (obj.getAttribute('id')===objId) { itemName=obj.getAttribute('name')||''; break outer; }
          }
        }
      }
      const seedMatrix = unitMatrix.clone().multiply(parseTransform(item.getAttribute('transform')));
      itemTransforms.set(bi, seedMatrix.clone());
      resolveObject(rootPath, objId, seedMatrix, bi, itemName);
    }
  } else {
    let bi=0;
    for (const [key] of objectMap) {
      const mat=unitMatrix.clone();
      itemTransforms.set(bi,mat.clone());
      instances.push({meshKey:key,matrix:mat,buildItemIndex:bi++,label:''});
    }
  }
  if (instances.length===0) {
    let bi=0;
    for (const [key] of objectMap) {
      const mat=unitMatrix.clone();
      itemTransforms.set(bi,mat.clone());
      instances.push({meshKey:key,matrix:mat,buildItemIndex:bi++,label:''});
    }
  }

  let totalTris=0;
  for (const inst of instances) { const m=objectMap.get(inst.meshKey); if(m) totalTris+=m.triangles.length/3; }
  if (totalTris>MAX_3MF_TRIANGLES)
    throw new Error(`3MF contains ${totalTris.toLocaleString()} triangles, exceeding the ${MAX_3MF_TRIANGLES.toLocaleString()} limit`);

  const mergedPositions = new Float32Array(totalTris * 9);

  const bodyOrder    = [];
  const bodyLabel    = new Map();
  const bodyChunks   = new Map();
  const bodyTriCount = new Map();

  let writeOffset = 0;
  const tmpV = new THREE.Vector3();

  for (const inst of instances) {
    const mesh = objectMap.get(inst.meshKey);
    if (!mesh) continue;
    const bi = inst.buildItemIndex;
    if (!bodyChunks.has(bi)) {
      bodyOrder.push(bi);
      bodyLabel.set(bi, inst.label);
      bodyChunks.set(bi, []);
      bodyTriCount.set(bi, 0);
    }
    const { vertices, triangles } = mesh;
    const tc = triangles.length / 3;
    const chunk = new Float32Array(tc * 9);
    let chunkOffset = 0;
    for (let t=0; t<triangles.length; t+=3) {
      for (let v=0; v<3; v++) {
        const vi = triangles[t+v];
        tmpV.set(vertices[vi*3], vertices[vi*3+1], vertices[vi*3+2]);
        tmpV.applyMatrix4(inst.matrix);
        mergedPositions[writeOffset]     = chunk[chunkOffset]     = tmpV.x;
        mergedPositions[writeOffset + 1] = chunk[chunkOffset + 1] = tmpV.y;
        mergedPositions[writeOffset + 2] = chunk[chunkOffset + 2] = tmpV.z;
        writeOffset  += 3;
        chunkOffset  += 3;
      }
    }
    bodyChunks.get(bi).push(chunk);
    bodyTriCount.set(bi, bodyTriCount.get(bi) + tc);
  }

  const mergedGeo = new THREE.BufferGeometry();
  mergedGeo.setAttribute('position', new THREE.BufferAttribute(mergedPositions, 3));
  mergedGeo.computeBoundingBox();
  const preCentreCenter = new THREE.Vector3();
  mergedGeo.boundingBox.getCenter(preCentreCenter);
  const cx = preCentreCenter.x, cy = preCentreCenter.y, cz = preCentreCenter.z;
  const centerOffset = { x: cx, y: cy, z: cz };

  const identity = new THREE.Matrix4();

  // Track running triangle offset so each body knows its startTri in the
  // merged geometry — used by handleExport to map excludedFaces per body.
  let runningTri = 0;

  const bodyGeometries = bodyOrder.map(bi => {
    const chunks   = bodyChunks.get(bi);
    const tc       = bodyTriCount.get(bi);
    const startTri = runningTri;
    runningTri += tc;

    const pos = new Float32Array(tc * 9);
    let off = 0;
    for (const chunk of chunks) { pos.set(chunk, off); off += chunk.length; }
    for (let i=0; i<pos.length; i+=3) { pos[i]-=cx; pos[i+1]-=cy; pos[i+2]-=cz; }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    return {
      name:        bodyLabel.get(bi) || '',
      matrix:      itemTransforms.get(bi) || identity,
      geometry:    geo,
      origGeometry: geo,
      startTri,
      triCount:    tc,
    };
  });

  return { geometry: mergedGeo, bodyGeometries, centerOffset };
}

export function loadModelFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'obj') return loadOBJFile(file);
  if (ext === '3mf') return load3MFFile(file);
  return loadSTLFile(file);
}

function mergeGroupGeometries(group) {
  const geometries = [];
  group.traverse((child) => {
    if (child.isMesh && child.geometry) {
      const geo = child.geometry.clone();
      child.updateWorldMatrix(true, false);
      geo.applyMatrix4(child.matrixWorld);
      geometries.push(geo.index ? geo.toNonIndexed() : geo);
      if (geo.index) geo.dispose();
    }
  });
  if (geometries.length === 0) throw new Error('No mesh data found in file');
  if (geometries.length === 1) return geometries[0];
  const totalVerts = geometries.reduce((s,g) => s+g.attributes.position.count, 0);
  const mergedPos  = new Float32Array(totalVerts * 3);
  const hasNormals = geometries.every(g => g.attributes.normal);
  const mergedNrm  = hasNormals ? new Float32Array(totalVerts * 3) : null;
  let offset = 0;
  for (const g of geometries) {
    mergedPos.set(g.attributes.position.array, offset*3);
    if (hasNormals&&mergedNrm) mergedNrm.set(g.attributes.normal.array, offset*3);
    offset += g.attributes.position.count;
    g.dispose();
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(mergedPos, 3));
  if (mergedNrm) merged.setAttribute('normal', new THREE.BufferAttribute(mergedNrm, 3));
  return merged;
}
