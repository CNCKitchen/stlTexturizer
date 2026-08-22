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
 * A plain single-file 3MF with only `slic3rpe:mmu_segmentation` attributes
 * (the previous approach here) opens fine in PrusaSlicer but shows no paint at
 * all in BambuStudio, OrcaSlicer, or Snapmaker Orca — confirmed by real-world
 * testing. The fix, verified against a real working reference (a genuine
 * Snapmaker-Orca export, see the hue-da-map project's reverse-engineering
 * notes), is a multi-file "components" project layout: a root model whose
 * object is just a `<component>` reference to a separate mesh model, plus
 * `Metadata/model_settings.config` and `Metadata/slice_info.config`. This is
 * the same structure PrusaSlicer's own multi-object project 3MFs use, so it
 * doesn't cost Prusa compatibility. `Metadata/project_settings.config` (a
 * printer/filament profile) is deliberately omitted: embedding even a minimal
 * one makes Bambu/Orca fabricate broken default presets on import.
 *
 * Each triangle carries BOTH `paint_color` (Bambu/Orca/Snapmaker Orca) and
 * `slic3rpe:mmu_segmentation` (PrusaSlicer) with the same computed code —
 * they're independently-named attributes over the same underlying
 * TriangleSelector whole-face state encoding.
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

  const posArr = painted.geometry.attributes.position.array;
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

  const fmt = (n) => {
    let s = n.toFixed(4);
    if (s.indexOf('.') !== -1) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s;
  };
  const vLines = [];
  for (let i = 0; i < uniqueXYZ.length; i += 3) {
    vLines.push('<vertex x="' + fmt(uniqueXYZ[i]) + '" y="' + fmt(uniqueXYZ[i + 1]) + '" z="' + fmt(uniqueXYZ[i + 2]) + '"/>');
  }
  const tLines = [];
  for (let i = 0; i < triCount; i++) {
    const b = i * 3;
    const mi = painted.materialIndices[i] || 0;
    const code = paintStateCode(mi);
    const attrs = code ? ' paint_color="' + code + '" slic3rpe:mmu_segmentation="' + code + '"' : '';
    tLines.push('<triangle v1="' + triIdx[b] + '" v2="' + triIdx[b + 1] + '" v3="' + triIdx[b + 2] + '"' + attrs + '/>');
  }

  const meshObjectId = 1;
  const rootObjectId = 2;

  const objectsModelXml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<model unit="millimeter" xml:lang="en-US" ' +
    'xmlns="' + NS_CORE + '" xmlns:BambuStudio="' + NS_BAMBU + '" ' +
    'xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06" xmlns:p="' + NS_PROD + '" requiredextensions="p">\n' +
    '<resources>\n' +
    '<object id="' + meshObjectId + '" p:UUID="' + uuid() + '" type="model">\n' +
    '<mesh>\n<vertices>\n' + vLines.join('\n') + '\n</vertices>\n' +
    '<triangles>\n' + tLines.join('\n') + '\n</triangles>\n</mesh>\n</object>\n' +
    '</resources>\n<build/>\n</model>\n';

  const rootModelXml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<model unit="millimeter" xml:lang="en-US" ' +
    'xmlns="' + NS_CORE + '" xmlns:BambuStudio="' + NS_BAMBU + '" xmlns:p="' + NS_PROD + '" requiredextensions="p">\n' +
    '<metadata name="Application">STL Texturizer</metadata>\n' +
    '<metadata name="BambuStudio:3mfVersion">1</metadata>\n' +
    '<resources>\n' +
    '<object id="' + rootObjectId + '" p:UUID="' + uuid() + '" type="model">\n' +
    '<components>\n' +
    '<component p:path="/3D/Objects/Object_1.model" objectid="' + meshObjectId + '" p:UUID="' + uuid() + '" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>\n' +
    '</components>\n</object>\n</resources>\n' +
    '<build p:UUID="' + uuid() + '">\n' +
    '<item objectid="' + rootObjectId + '" p:UUID="' + uuid() + '" printable="1"/>\n' +
    '</build>\n</model>\n';

  const modelSettingsXml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<config>\n' +
    '<object id="' + rootObjectId + '">\n' +
    '<metadata key="name" value="Painted Texture"/>\n' +
    '<metadata key="extruder" value="0"/>\n' +
    '<part id="' + meshObjectId + '" subtype="normal_part">\n' +
    '<metadata key="name" value="Painted Texture"/>\n' +
    '<metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n' +
    '<mesh_stat edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>\n' +
    '</part>\n</object>\n' +
    '<plate>\n' +
    '<metadata key="plater_id" value="1"/>\n' +
    '<metadata key="plater_name" value=""/>\n' +
    '<metadata key="locked" value="false"/>\n' +
    '<model_instance>\n' +
    '<metadata key="object_id" value="' + rootObjectId + '"/>\n' +
    '<metadata key="instance_id" value="0"/>\n' +
    '<metadata key="identify_id" value="1"/>\n' +
    '</model_instance>\n</plate>\n' +
    '<assemble>\n' +
    '<assemble_item object_id="' + rootObjectId + '" instance_id="0" transform="1 0 0 0 1 0 0 0 1 0 0 0" offset="0 0 0"/>\n' +
    '</assemble>\n</config>\n';

  const sliceInfoXml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<config>\n<header>\n' +
    '<header_item key="X-BBL-Client-Type" value="slicer"/>\n' +
    '<header_item key="X-BBL-Client-Version" value=""/>\n' +
    '</header>\n</config>\n';

  // Every part in an OPC package needs a resolvable content type or the whole
  // package is invalid — Metadata/*.config parts have no declared type below
  // without this entry. Bambu-family readers apparently don't enforce this
  // (they resolve those files by well-known path, not content type), but
  // PrusaSlicer's stricter OPC reader does; omitting it broke Prusa entirely.
  const contentTypesXml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n' +
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n' +
    '<Default Extension="config" ContentType="application/octet-stream"/>\n' +
    '</Types>\n';

  const rootRelsXml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
    '<Relationship Id="rel-1" Target="/3D/3dmodel.model" ' +
    'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n' +
    '</Relationships>\n';

  const modelRelsXml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
    '<Relationship Id="rel-1" Target="/3D/Objects/Object_1.model" ' +
    'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n' +
    '</Relationships>\n';

  const zipped = zipSync({
    '[Content_Types].xml':                strToU8(contentTypesXml),
    '_rels/.rels':                        strToU8(rootRelsXml),
    '3D/3dmodel.model':                   strToU8(rootModelXml),
    '3D/_rels/3dmodel.model.rels':        strToU8(modelRelsXml),
    '3D/Objects/Object_1.model':          strToU8(objectsModelXml),
    'Metadata/model_settings.config':     strToU8(modelSettingsXml),
    'Metadata/slice_info.config':         strToU8(sliceInfoXml),
  }, { level: 6 });

  triggerDownload(
    zipped,
    filename,
    'application/vnd.ms-package.3dmanufacturing-3dmodel+xml'
  );
}

const NS_CORE  = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const NS_BAMBU = 'http://schemas.bambulab.com/package/2021';
const NS_PROD  = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';

function uuid() {
  return (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : '00000000-0000-4000-8000-000000000000';
}

/**
 * Encode a material index as a TriangleSelector whole-face state code, shared
 * by BambuStudio/OrcaSlicer's `paint_color` and PrusaSlicer's
 * `slic3rpe:mmu_segmentation` (same underlying encoding, two attribute names).
 * materialIndex 0 (base) is extruder 1 — the object's implicit default — and
 * needs no override attribute. materialIndex N (N>=1) is extruder (N+1): slot
 * 1 is reserved for base, so the first configured color starts at extruder 2
 * (state 2, code "8"), matching a real reverse-engineered snorca export.
 *
 * Nibble math verified against PrusaSlicer/BambuStudio/OrcaSlicer's
 * TriangleSelector::serialize / FacetsAnnotation::get_triangle_as_string.
 * Capped at state 16 — OrcaSlicer's (and thus Snapmaker Orca's)
 * EnforcerBlockerType only defines extruders up to 16; BambuStudio and
 * PrusaSlicer tolerate more, but 16 is the safe ceiling across all of them.
 */
function paintStateCode(materialIndex) {
  if (materialIndex <= 0) return '';
  const state = materialIndex + 1;
  if (state > 16) {
    throw new Error(`Multicolor export: material index ${materialIndex} exceeds the 16-extruder ceiling shared by OrcaSlicer/Snapmaker Orca.`);
  }
  if (state === 1) return '4';
  if (state === 2) return '8';
  const rel = state - 3;
  const numF = Math.floor(rel / 15);
  const finalDigit = (rel % 15).toString(16).toUpperCase();
  return finalDigit + 'F'.repeat(numF) + 'C';
}
