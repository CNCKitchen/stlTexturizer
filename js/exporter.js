/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

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
 * Escape a string for use inside a double-quoted XML attribute. Part names come
 * from the imported file, so they can legitimately contain & < > and quotes.
 */
function xmlAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Strip control characters that are simply illegal in XML 1.0.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

/**
 * Render a palette colour as a 3MF displaycolor ("#RRGGBBAA"). Parts imported
 * without a colour still need a valid value here, so fall back to opaque white.
 */
function toDisplayColor(color) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(color || '');
  return '#' + (m ? m[1].toUpperCase() : 'FFFFFF') + 'FF';
}

/**
 * 3MF exporter — builds a ZIP-packaged XML mesh in the Microsoft 3D
 * Manufacturing core format (2015/02).
 *
 * Vertices are deduplicated (positions quantized to 4 decimals, i.e. 0.0001 mm
 * tolerance) so the output is both smaller than binary STL and round-trippable
 * by this project's own 3MF loader.
 *
 * When `materials` is supplied (multi-colour / multi-tool 3MF import), each
 * part is written as its own <object> carrying its original colour and
 * extruder assignment, wrapped in a components assembly — the layout Bambu
 * Studio, OrcaSlicer and PrusaSlicer all read back as separate painted bodies.
 * Without it the mesh is written as a single object exactly as before.
 *
 * @param {THREE.BufferGeometry} geometry  – non-indexed with position attribute
 * @param {string} [filename]
 * @param {{palette: Array<{name,color,extruder}>, faceMaterial: Uint16Array}|null} [materials]
 */
export function export3MF(geometry, filename = 'textured.3mf', materials = null) {
  const posArr = geometry.attributes.position.array;
  const triCount = (posArr.length / 9) | 0;

  // ── Decide single-object vs multi-part layout ────────────────────────────
  const palette = materials && materials.palette;
  const faceMat = materials && materials.faceMaterial;
  // Slots that survived the pipeline, in palette order. A part decimated out
  // of existence is simply dropped rather than emitted as an empty object.
  let partSlots = [];
  if (palette && faceMat && faceMat.length === triCount) {
    const counts = new Uint32Array(palette.length);
    for (let i = 0; i < triCount; i++) {
      const s = faceMat[i];
      if (s < palette.length) counts[s]++;
    }
    for (let s = 0; s < palette.length; s++) if (counts[s] > 0) partSlots.push(s);
  }
  // One surviving part carries no more information than a plain single object.
  const multi = partSlots.length > 1;
  if (!multi) partSlots = [];

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

  // Vertices: trim trailing zeros to keep the file compact.
  const fmt = (n) => {
    // 4 decimals matches the dedup precision; strip trailing zeros and ".".
    let s = n.toFixed(4);
    if (s.indexOf('.') !== -1) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s;
  };

  /**
   * Emit one <mesh> covering the triangles whose palette slot is `slot`
   * (or every triangle when `slot` is null).
   *
   * Deduplication is per-mesh: 3MF vertex indices are object-local, and
   * keeping each part's vertex list separate is also what makes the parts
   * independent bodies rather than one welded shell. Welds on the 1e4 grid
   * (0.0001 mm cells), matching the 4-decimal precision the coordinates are
   * written with — safely below any FDM/SLA printer's resolution and far
   * tighter than float32 rounding noise from the displacement pipeline. The
   * pipeline snaps coordinates onto this exact grid in resolveTJunctions
   * before export, so welding here only merges grid-identical points.
   */
  function emitMesh(slot) {
    const indexMap  = new QuantizedPointMap(1e4, Math.min(triCount * 3, 1 << 22));
    const uniqueXYZ = [];   // flat [x,y,z,x,y,z,...]
    const triIdx    = [];   // flat [i0,i1,i2,...] for the selected triangles

    for (let i = 0; i < triCount; i++) {
      if (slot !== null && faceMat[i] !== slot) continue;
      for (let j = 0; j < 3; j++) {
        const b = i * 9 + j * 3;
        const x = posArr[b];
        const y = posArr[b + 1];
        const z = posArr[b + 2];
        const idx = indexMap.getOrSet(x, y, z, uniqueXYZ.length / 3);
        if (indexMap.inserted) uniqueXYZ.push(x, y, z);
        triIdx.push(idx);
      }
    }

    emit('<mesh>\n<vertices>\n');
    for (let i = 0; i < uniqueXYZ.length; i += 3) {
      emit(
        '<vertex x="' + fmt(uniqueXYZ[i]) +
        '" y="'       + fmt(uniqueXYZ[i + 1]) +
        '" z="'       + fmt(uniqueXYZ[i + 2]) +
        '"/>\n'
      );
    }
    emit('</vertices>\n<triangles>\n');
    for (let i = 0; i < triIdx.length; i += 3) {
      emit(
        '<triangle v1="' + triIdx[i] +
        '" v2="'         + triIdx[i + 1] +
        '" v3="'         + triIdx[i + 2] +
        '"/>\n'
      );
    }
    emit('</triangles>\n</mesh>\n');
  }

  // Resource ids: basematerials 1, part objects 2..N+1, assembly N+2.
  const MAT_ID      = 1;
  const partObjId   = (k) => 2 + k;
  const assemblyId  = 2 + partSlots.length;

  emit(
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<model unit="millimeter" xml:lang="en-US" ' +
    'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"' +
    (multi ? ' xmlns:BambuStudio="http://schemas.bambulab.com/package/2021"' : '') +
    '>\n' +
    // Signals slicers to read Metadata/model_settings.config, where the
    // per-part extruder assignments live.
    (multi ? '<metadata name="BambuStudio:3mfVersion">1</metadata>\n' : '') +
    '<resources>\n'
  );

  if (multi) {
    emit('<basematerials id="' + MAT_ID + '">\n');
    for (const s of partSlots) {
      const p = palette[s];
      emit(
        '<base name="' + xmlAttr(p.name || '') +
        '" displaycolor="' + xmlAttr(toDisplayColor(p.color)) + '"/>\n'
      );
    }
    emit('</basematerials>\n');

    partSlots.forEach((s, k) => {
      emit('<object id="' + partObjId(k) + '" type="model" pid="' + MAT_ID + '" pindex="' + k + '">\n');
      emitMesh(s);
      emit('</object>\n');
    });

    // Assembly: one printable item made of all the parts, so the slicer shows
    // a single object with sub-parts rather than N unrelated plate items.
    emit('<object id="' + assemblyId + '" type="model">\n<components>\n');
    partSlots.forEach((_, k) => emit('<component objectid="' + partObjId(k) + '"/>\n'));
    emit('</components>\n</object>\n');
  } else {
    emit('<object id="1" type="model">\n');
    emitMesh(null);
    emit('</object>\n');
  }

  emit(
    '</resources>\n' +
    '<build>\n<item objectid="' + (multi ? assemblyId : 1) + '" printable="1"/>\n</build>\n' +
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

  // Slicer part metadata. The core spec's basematerials above already carries
  // the colours; this is what restores the *extruder* assignment, so a
  // re-imported file needs no repainting. Mirrors the layout Bambu Studio /
  // OrcaSlicer write (and, deliberately, their omission of a content-type
  // declaration for it — matching a known-good file is safer here than being
  // strictly OPC-correct).
  const files = {
    '[Content_Types].xml': strToU8(contentTypesXml),
    '_rels/.rels':         strToU8(relsXml),
    '3D/3dmodel.model':    modelBytes,
  };

  if (multi) {
    let cfg = '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n' +
              '<object id="' + assemblyId + '">\n';
    partSlots.forEach((s, k) => {
      const p = palette[s];
      cfg += '<part id="' + partObjId(k) + '" subtype="normal_part">\n' +
             '<metadata key="name" value="' + xmlAttr(p.name || ('Part ' + (k + 1))) + '"/>\n' +
             '<metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n';
      if (p.extruder !== null && p.extruder !== undefined) {
        cfg += '<metadata key="extruder" value="' + p.extruder + '"/>\n';
      }
      cfg += '</part>\n';
    });
    cfg += '</object>\n</config>\n';
    files['Metadata/model_settings.config'] = strToU8(cfg);
  }

  // ── Zip and download ─────────────────────────────────────────────────────
  const zipped = zipSync(files, { level: 6 });

  triggerDownload(
    zipped,
    filename,
    'application/vnd.ms-package.3dmanufacturing-3dmodel+xml'
  );
}
