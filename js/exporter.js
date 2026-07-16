import { zipSync, strToU8 } from 'fflate';
import { QuantizedPointMap } from './meshIndex.js';

/**
 * Trigger a browser download for a binary buffer.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {string} filename
 * @param {string} [mime]
 */
function triggerDownload(buffer, filename, mime = 'application/octet-stream') {
  const blob = new Blob([buffer], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/**
 * Fast binary STL exporter — writes directly from BufferGeometry arrays.
 *
 * Eliminates Three.js STLExporter overhead:
 * - No Mesh/Material creation
 * - No identity matrix multiplication per vertex
 * - No redundant normal recomputation
 * - Bulk Uint8Array.set() instead of per-float DataView calls
 *
 * @param {THREE.BufferGeometry} geometry  – non-indexed with position + normal
 * @param {string} [filename]
 */
export function exportSTL(geometry, filename = 'textured.stl') {
  const posArr = geometry.attributes.position.array;
  const norArr = geometry.attributes.normal
    ? geometry.attributes.normal.array
    : null;
  const triCount = (posArr.length / 9) | 0;

  // Binary STL: 80-byte header + 4-byte tri count + 50 bytes per triangle
  const bufLen = 84 + 50 * triCount;
  const buffer = new ArrayBuffer(bufLen);
  const bytes  = new Uint8Array(buffer);
  const view   = new DataView(buffer);

  // Header: 80 bytes (already zero-filled)
  view.setUint32(80, triCount, true);

  // Reinterpret source arrays as raw bytes for bulk copy
  const posSrc = new Uint8Array(posArr.buffer, posArr.byteOffset, posArr.byteLength);
  const norSrc = norArr
    ? new Uint8Array(norArr.buffer, norArr.byteOffset, norArr.byteLength)
    : null;

  for (let i = 0; i < triCount; i++) {
    const dst    = 84 + i * 50;
    const srcOff = i * 36; // 9 floats * 4 bytes

    if (norSrc) {
      // Normal: copy first vertex normal (12 bytes) — flat shading, all 3 identical
      bytes.set(norSrc.subarray(srcOff, srcOff + 12), dst);
    } else {
      // Compute face normal from cross product
      const b = i * 9;
      const ux = posArr[b+3]-posArr[b], uy = posArr[b+4]-posArr[b+1], uz = posArr[b+5]-posArr[b+2];
      const vx = posArr[b+6]-posArr[b], vy = posArr[b+7]-posArr[b+1], vz = posArr[b+8]-posArr[b+2];
      const nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
      const len = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
      view.setFloat32(dst,     nx/len, true);
      view.setFloat32(dst + 4, ny/len, true);
      view.setFloat32(dst + 8, nz/len, true);
    }

    // Vertices: 36 bytes (3 vertices * 3 floats * 4 bytes)
    bytes.set(posSrc.subarray(srcOff, srcOff + 36), dst + 12);

    // Attribute byte count: 0 (already zero-filled)
  }

  triggerDownload(buffer, filename);
}

/**
 * 3MF exporter — builds a ZIP-packaged XML mesh in the Microsoft 3D
 * Manufacturing core format (2015/02).
 *
 * Vertices are deduplicated (positions quantized to 4 decimals, i.e. 0.0001 mm
 * tolerance) so the output is both smaller than binary STL and round-trippable
 * by this project's own 3MF loader.
 *
 * @param {THREE.BufferGeometry} geometry  – non-indexed with position attribute
 * @param {string} [filename]
 */
export function export3MF(geometry, filename = 'textured.3mf') {
  const posArr = geometry.attributes.position.array;
  const triCount = (posArr.length / 9) | 0;

  // ── Deduplicate vertices ─────────────────────────────────────────────────
  // Weld on the 1e4 grid (0.0001 mm cells), matching the 4-decimal precision
  // the coordinates are written with below — safely below the resolution of
  // any FDM/SLA printer and far tighter than float32 rounding noise from the
  // displacement pipeline. The pipeline snaps coordinates onto this exact
  // grid in resolveTJunctions before export, so welding here only merges
  // bit-identical (or grid-identical) points.
  const indexMap  = new QuantizedPointMap(1e4, Math.min(triCount * 3, 1 << 22));
  const uniqueXYZ = [];   // flat [x,y,z,x,y,z,...]
  const triIdx    = new Uint32Array(triCount * 3);

  for (let i = 0; i < triCount; i++) {
    for (let j = 0; j < 3; j++) {
      const b = i * 9 + j * 3;
      const x = posArr[b];
      const y = posArr[b + 1];
      const z = posArr[b + 2];
      const idx = indexMap.getOrSet(x, y, z, uniqueXYZ.length / 3);
      if (indexMap.inserted) uniqueXYZ.push(x, y, z);
      triIdx[i * 3 + j] = idx;
    }
  }

  const vertCount = uniqueXYZ.length / 3;

  // ── Build 3dmodel.model XML as Uint8Array chunks ─────────────────────────
  // A single concatenated string would exceed V8's max-string-length limit
  // (~512 MiB) for meshes around 10M+ triangles, throwing "Invalid string
  // length".  Encode chunks to UTF-8 bytes as we go, flushing the small
  // staging string every ~1 MiB so it never grows large enough to trip the
  // limit.  Final concat is byte-wise (no string-length cap).
  const enc = new TextEncoder();
  const byteChunks = [];
  let totalBytes = 0;
  let pending = '';
  const FLUSH_THRESHOLD = 1 << 20; // 1 MiB

  function flush() {
    if (!pending) return;
    const b = enc.encode(pending);
    byteChunks.push(b);
    totalBytes += b.length;
    pending = '';
  }
  function emit(s) {
    pending += s;
    if (pending.length >= FLUSH_THRESHOLD) flush();
  }

  emit(
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<model unit="millimeter" xml:lang="en-US" ' +
    'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n' +
    '<resources>\n' +
    '<object id="1" type="model">\n' +
    '<mesh>\n' +
    '<vertices>\n'
  );

  // Vertices: trim trailing zeros to keep the file compact.
  const fmt = (n) => {
    // 4 decimals matches the dedup precision; strip trailing zeros and ".".
    let s = n.toFixed(4);
    if (s.indexOf('.') !== -1) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s;
  };
  for (let i = 0; i < vertCount; i++) {
    const b = i * 3;
    emit(
      '<vertex x="' + fmt(uniqueXYZ[b]) +
      '" y="'       + fmt(uniqueXYZ[b + 1]) +
      '" z="'       + fmt(uniqueXYZ[b + 2]) +
      '"/>\n'
    );
  }

  emit('</vertices>\n<triangles>\n');

  for (let i = 0; i < triCount; i++) {
    const b = i * 3;
    emit(
      '<triangle v1="' + triIdx[b] +
      '" v2="'         + triIdx[b + 1] +
      '" v3="'         + triIdx[b + 2] +
      '"/>\n'
    );
  }

  emit(
    '</triangles>\n' +
    '</mesh>\n' +
    '</object>\n' +
    '</resources>\n' +
    '<build>\n<item objectid="1"/>\n</build>\n' +
    '</model>\n'
  );
  flush();

  const modelBytes = new Uint8Array(totalBytes);
  {
    let off = 0;
    for (const b of byteChunks) { modelBytes.set(b, off); off += b.length; }
  }

  // ── Static package files ─────────────────────────────────────────────────
  const contentTypesXml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n' +
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n' +
    '</Types>\n';

  const relsXml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
    '<Relationship Id="rel-1" Target="/3D/3dmodel.model" ' +
    'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n' +
    '</Relationships>\n';

  // ── Zip and download ─────────────────────────────────────────────────────
  const zipped = zipSync({
    '[Content_Types].xml': strToU8(contentTypesXml),
    '_rels/.rels':         strToU8(relsXml),
    '3D/3dmodel.model':    modelBytes,
  }, { level: 6 });

  triggerDownload(
    zipped,
    filename,
    'application/vnd.ms-package.3dmanufacturing-3dmodel+xml'
  );
}

/**
 * Painted 3MF exporter for slicer-visible color/filament assignment.
 *
 * Writes one non-overlapping mesh object and assigns a base material index per
 * triangle. Generic 3MF material properties are retained for viewers, while
 * Prusa/Orca `slic3rpe:mmu_segmentation` and Bambu/Orca `paint_color`
 * attributes are emitted for slicers that ignore core 3MF materials.
 *
 * @param {{
 *   geometry: THREE.BufferGeometry,
 *   materialIndices: Uint8Array,
 *   materials: Array<{name:string,color:string}>
 * }} painted
 * @param {string} [filename]
 */
export function export3MFPainted(painted, filename = 'textured-painted.3mf') {
  if (!painted || !painted.geometry || !painted.geometry.attributes.position) {
    throw new Error('No geometry available for painted 3MF export');
  }
  const triCount = painted.geometry.attributes.position.count / 3;
  if (!painted.materialIndices || painted.materialIndices.length !== triCount) {
    throw new Error('Painted 3MF material indices do not match the mesh triangle count');
  }

  const enc = new TextEncoder();
  const byteChunks = [];
  let totalBytes = 0;
  let pending = '';
  const FLUSH_THRESHOLD = 1 << 20;

  function flush() {
    if (!pending) return;
    const b = enc.encode(pending);
    byteChunks.push(b);
    totalBytes += b.length;
    pending = '';
  }
  function emit(s) {
    pending += s;
    if (pending.length >= FLUSH_THRESHOLD) flush();
  }

  emit(
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<model unit="millimeter" xml:lang="en-US" ' +
    'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" ' +
    'xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">\n' +
    '<metadata name="slic3rpe:Version3mf">1</metadata>\n' +
    '<metadata name="slic3rpe:MmPaintingVersion">1</metadata>\n' +
    '<metadata name="BambuStudio:3mfVersion">1</metadata>\n' +
    '<metadata name="BambuStudio:MmPaintingVersion">0</metadata>\n' +
    // Bambu/Orca only read `paint_color` through their Bambu-project import
    // path, which is gated by the generator metadata. Keep the real producer in
    // a namespaced metadata key below rather than losing it completely.
    '<metadata name="Application">BambuStudio-1.10.0</metadata>\n' +
    '<metadata name="STLTexturizer:Application">STL Texturizer</metadata>\n' +
    '<resources>\n' +
    '<basematerials id="1">\n'
  );
  for (const mat of painted.materials) {
    emit('<base name="' + xmlAttr(mat.name) + '" displaycolor="' + xmlAttr(mat.color || '#cccccc') + '"/>\n');
  }
  emit('</basematerials>\n');

  emitPaintedObject(emit, painted.geometry, painted.materialIndices, 2, 1);

  emit('</resources>\n<build>\n');
  emit('<item objectid="2" printable="1"/>\n');
  emit('</build>\n</model>\n');
  flush();

  const modelBytes = new Uint8Array(totalBytes);
  {
    let off = 0;
    for (const b of byteChunks) { modelBytes.set(b, off); off += b.length; }
  }

  const contentTypesXml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n' +
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n' +
    '</Types>\n';

  const relsXml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
    '<Relationship Id="rel-1" Target="/3D/3dmodel.model" ' +
    'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n' +
    '</Relationships>\n';

  const zipped = zipSync({
    '[Content_Types].xml': strToU8(contentTypesXml),
    '_rels/.rels':         strToU8(relsXml),
    '3D/3dmodel.model':    modelBytes,
  }, { level: 6 });

  triggerDownload(
    zipped,
    filename,
    'application/vnd.ms-package.3dmanufacturing-3dmodel+xml'
  );
}

function emitPaintedObject(emit, geometry, materialIndices, objectId, materialPid) {
  const posArr = geometry.attributes.position.array;
  const triCount = (posArr.length / 9) | 0;
  const indexMap  = new QuantizedPointMap(1e4, Math.min(triCount * 3, 1 << 22));
  const uniqueXYZ = [];
  const triIdx    = new Uint32Array(triCount * 3);

  for (let i = 0; i < triCount; i++) {
    for (let j = 0; j < 3; j++) {
      const b = i * 9 + j * 3;
      const x = posArr[b];
      const y = posArr[b + 1];
      const z = posArr[b + 2];
      const idx = indexMap.getOrSet(x, y, z, uniqueXYZ.length / 3);
      if (indexMap.inserted) uniqueXYZ.push(x, y, z);
      triIdx[i * 3 + j] = idx;
    }
  }

  emit('<object id="' + objectId + '" type="model" name="Painted Texture" pid="' + materialPid + '" pindex="0">\n<mesh>\n<vertices>\n');
  const fmt = (n) => {
    let s = n.toFixed(4);
    if (s.indexOf('.') !== -1) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s;
  };
  for (let i = 0; i < uniqueXYZ.length; i += 3) {
    emit(
      '<vertex x="' + fmt(uniqueXYZ[i]) +
      '" y="'       + fmt(uniqueXYZ[i + 1]) +
      '" z="'       + fmt(uniqueXYZ[i + 2]) +
      '"/>\n'
    );
  }
  emit('</vertices>\n<triangles>\n');
  for (let i = 0; i < triCount; i++) {
    const b = i * 3;
    const mi = materialIndices[i] || 0;
    const mmuSegmentation = orcaMmuSegmentationForMaterial(mi);
    const bambuPaintColor = bambuPaintColorForMaterial(mi);
    emit(
      '<triangle v1="' + triIdx[b] +
      '" v2="'         + triIdx[b + 1] +
      '" v3="'         + triIdx[b + 2] +
      '" pid="'        + materialPid +
      '" p1="'         + mi +
      '" p2="'         + mi +
      '" p3="'         + mi + '"' +
      (mmuSegmentation ? ' slic3rpe:mmu_segmentation="' + mmuSegmentation + '"' : '') +
      (bambuPaintColor ? ' paint_color="' + bambuPaintColor + '"' : '') +
      '/>\n'
    );
  }
  emit('</triangles>\n</mesh>\n</object>\n');
}

function orcaMmuSegmentationForMaterial(materialIndex) {
  return filamentPaintingCode(materialIndex);
}

function bambuPaintColorForMaterial(materialIndex) {
  return filamentPaintingCode(materialIndex);
}

function filamentPaintingCode(materialIndex) {
  // Orca/Bambu TriangleSelector whole-face state encoding:
  // state 2 => extruder 2 => "8"; state 3 => extruder 3 => "0C".
  if (materialIndex === 1) return '8';
  if (materialIndex === 2) return '0C';
  return '';
}

function xmlAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
