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
 * Fast binary STL byte-builder — writes directly from BufferGeometry arrays.
 * Pure: no DOM, no download. Returns the raw binary STL bytes.
 *
 * Eliminates Three.js STLExporter overhead:
 * - No Mesh/Material creation
 * - No identity matrix multiplication per vertex
 * - No redundant normal recomputation
 * - Bulk Uint8Array.set() instead of per-float DataView calls
 *
 * @param {THREE.BufferGeometry} geometry  – non-indexed with position + normal
 * @returns {Uint8Array}
 */
export function buildSTLBytes(geometry) {
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

  return bytes;
}

/**
 * Fast binary STL exporter — builds the bytes then triggers a browser download.
 *
 * @param {THREE.BufferGeometry} geometry  – non-indexed with position + normal
 * @param {string} [filename]
 */
export function exportSTL(geometry, filename = 'textured.stl') {
  const bytes = buildSTLBytes(geometry);
  triggerDownload(bytes.buffer, filename);
}

/**
 * 3MF byte-builder — builds a ZIP-packaged XML mesh in the Microsoft 3D
 * Manufacturing core format (2015/02). Pure: no DOM, no download.
 *
 * Vertices are deduplicated (positions quantized to 4 decimals, i.e. 0.0001 mm
 * tolerance) so the output is both smaller than binary STL and round-trippable
 * by this project's own 3MF loader.
 *
 * @param {THREE.BufferGeometry} geometry  – non-indexed with position attribute
 * @returns {Uint8Array}
 */
export function build3MFBytes(geometry) {
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

  // ── Zip ───────────────────────────────────────────────────────────────────
  const zipped = zipSync({
    '[Content_Types].xml': strToU8(contentTypesXml),
    '_rels/.rels':         strToU8(relsXml),
    '3D/3dmodel.model':    modelBytes,
  }, { level: 6 });

  return zipped;
}

/**
 * 3MF exporter — builds the zip bytes then triggers a browser download.
 *
 * @param {THREE.BufferGeometry} geometry  – non-indexed with position attribute
 * @param {string} [filename]
 */
export function export3MF(geometry, filename = 'textured.3mf') {
  const zipped = build3MFBytes(geometry);
  triggerDownload(
    zipped,
    filename,
    'application/vnd.ms-package.3dmanufacturing-3dmodel+xml'
  );
}
