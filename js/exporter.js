import { zipSync, strToU8 } from 'fflate';

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
 * @param {{palette?: Uint8Array, triPaletteIndices?: Uint16Array}} [options]
 *   Optional 3MF Materials Extension v1.0.1 colorgroup data:
 *   - `palette`: flat `Uint8Array(N*3)` of RGB triplets (0..255 each).
 *   - `triPaletteIndices`: `Uint16Array(triCount)` mapping each triangle to a
 *     palette entry. When both present and `palette.length > 0`, the model
 *     declares the `m` namespace, emits an `<m:colorgroup id="3">` block
 *     before the `<object>`, and adds `pid="3" p1="<idx>"` per triangle.
 *   When absent or empty, the emitted XML is byte-identical to the
 *   geometry-only output (backward-compat path).
 */
export function export3MF(geometry, filename = 'textured.3mf', options = {}) {
  const posArr = geometry.attributes.position.array;
  const triCount = (posArr.length / 9) | 0;

  // ── Color export prep (3MF Materials Extension v1.0.1) ───────────────────
  // Activate only when the caller provided BOTH a non-empty palette AND a
  // matching per-triangle index buffer. Anything else falls through to the
  // unchanged geometry-only path below.
  const palette = options && options.palette;
  const triPidx = options && options.triPaletteIndices;
  const hasColor = !!(
    palette && palette.length > 0 &&
    triPidx && triPidx.length >= triCount
  );

  // ── Deduplicate vertices ─────────────────────────────────────────────────
  // Key on fixed-precision position strings. 4 decimals = 0.0001 mm, safely
  // below the resolution of any FDM/SLA printer and far tighter than float32
  // rounding noise from the displacement pipeline.
  const indexMap  = new Map();
  const uniqueXYZ = [];   // flat [x,y,z,x,y,z,...]
  const triIdx    = new Uint32Array(triCount * 3);

  for (let i = 0; i < triCount; i++) {
    for (let j = 0; j < 3; j++) {
      const b = i * 9 + j * 3;
      const x = posArr[b];
      const y = posArr[b + 1];
      const z = posArr[b + 2];
      const key = x.toFixed(4) + ',' + y.toFixed(4) + ',' + z.toFixed(4);
      let idx = indexMap.get(key);
      if (idx === undefined) {
        idx = uniqueXYZ.length / 3;
        uniqueXYZ.push(x, y, z);
        indexMap.set(key, idx);
      }
      triIdx[i * 3 + j] = idx;
    }
  }

  const vertCount = uniqueXYZ.length / 3;

  // ── Build 3dmodel.model XML ──────────────────────────────────────────────
  // Stream into an array of string chunks then join once — much faster than
  // repeated concatenation for large meshes.
  const chunks = [];
  if (hasColor) {
    // Materials-extended model header: declare the `m` namespace and require
    // the extension so compliant readers know to honor pid/p1 attributes.
    chunks.push(
      '<?xml version="1.0" encoding="UTF-8"?>\n',
      '<model unit="millimeter" xml:lang="en-US" ',
      'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" ',
      'xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02" ',
      'requiredextensions="m">\n',
      '<resources>\n'
    );
    // Colorgroup MUST precede <object> per the Materials Extension spec.
    // id="3" leaves room for a future basematerials block at id=2; the
    // object below stays at id=1.
    const palCount = (palette.length / 3) | 0;
    chunks.push('<m:colorgroup id="3">\n');
    const hex2 = (n) => {
      // Uppercase 2-char hex; clamp defensively.
      const v = n < 0 ? 0 : n > 255 ? 255 : n | 0;
      const s = v.toString(16).toUpperCase();
      return s.length === 1 ? '0' + s : s;
    };
    for (let i = 0; i < palCount; i++) {
      const b = i * 3;
      // Slicers (Bambu/Orca/Prusa) want 8-char RGBA; alpha is always FF.
      chunks.push(
        '<m:color color="#',
        hex2(palette[b]),
        hex2(palette[b + 1]),
        hex2(palette[b + 2]),
        'FF"/>\n'
      );
    }
    chunks.push('</m:colorgroup>\n');
    // The per-triangle pid is sufficient — do NOT put pid on <object>.
    chunks.push(
      '<object id="1" type="model">\n',
      '<mesh>\n',
      '<vertices>\n'
    );
  } else {
    chunks.push(
      '<?xml version="1.0" encoding="UTF-8"?>\n',
      '<model unit="millimeter" xml:lang="en-US" ',
      'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n',
      '<resources>\n',
      '<object id="1" type="model">\n',
      '<mesh>\n',
      '<vertices>\n'
    );
  }

  // Vertices: trim trailing zeros to keep the file compact.
  const fmt = (n) => {
    // 4 decimals matches the dedup precision; strip trailing zeros and ".".
    let s = n.toFixed(4);
    if (s.indexOf('.') !== -1) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s;
  };
  for (let i = 0; i < vertCount; i++) {
    const b = i * 3;
    chunks.push(
      '<vertex x="', fmt(uniqueXYZ[b]),
      '" y="', fmt(uniqueXYZ[b + 1]),
      '" z="', fmt(uniqueXYZ[b + 2]),
      '"/>\n'
    );
  }

  chunks.push('</vertices>\n<triangles>\n');

  if (hasColor) {
    // Per-triangle color: pid references the colorgroup (id="3"); p1 is the
    // palette entry index for v1. Omitting p2/p3 means flat-coloring the
    // whole triangle from p1, which is exactly what we want.
    for (let i = 0; i < triCount; i++) {
      const b = i * 3;
      chunks.push(
        '<triangle v1="', triIdx[b],
        '" v2="', triIdx[b + 1],
        '" v3="', triIdx[b + 2],
        '" pid="3" p1="', triPidx[i],
        '"/>\n'
      );
    }
  } else {
    for (let i = 0; i < triCount; i++) {
      const b = i * 3;
      chunks.push(
        '<triangle v1="', triIdx[b],
        '" v2="', triIdx[b + 1],
        '" v3="', triIdx[b + 2],
        '"/>\n'
      );
    }
  }

  chunks.push(
    '</triangles>\n',
    '</mesh>\n',
    '</object>\n',
    '</resources>\n',
    '<build>\n<item objectid="1"/>\n</build>\n',
    '</model>\n'
  );

  const modelXml = chunks.join('');

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
    '3D/3dmodel.model':    strToU8(modelXml),
  }, { level: 6 });

  triggerDownload(
    zipped,
    filename,
    'application/vnd.ms-package.3dmanufacturing-3dmodel+xml'
  );
}
