import * as THREE from 'three';

/**
 * Threshold-based 3MF painting helpers.
 *
 * The export pipeline carries a signed displacement value per vertex. For
 * multicolor export we split triangles where that scalar crosses the active
 * raised/inset thresholds, then assign one material index to each resulting
 * triangle. The positions stay on the final displaced surface, so the exported
 * 3MF remains one non-overlapping mesh; only the slicer paint annotations vary.
 */

const OUTWARD_DISABLED = 2.0;
const INWARD_DISABLED = -2.0;
const EPS = 1e-6;

export const MULTICOLOR_MATERIALS = [
  { name: 'Base', color: '#b8bec8' },
  { name: 'Raised Texture', color: '#f05a28' },
  { name: 'Inset Texture', color: '#2d79d8' },
];

/**
 * Resolve which threshold controls are visible and active for the current
 * displacement direction mode.
 */
export function getMulticolorConfig(settings) {
  const outwardRelevant = !!settings.symmetricDisplacement || !settings.invertDisplacement;
  const inwardRelevant = !!settings.symmetricDisplacement || !!settings.invertDisplacement;
  const outwardThreshold = Number.isFinite(settings.multicolorOutwardThreshold)
    ? settings.multicolorOutwardThreshold
    : OUTWARD_DISABLED;
  const inwardThreshold = Number.isFinite(settings.multicolorInwardThreshold)
    ? settings.multicolorInwardThreshold
    : INWARD_DISABLED;
  const outwardActive = outwardRelevant && outwardThreshold < OUTWARD_DISABLED - EPS;
  const inwardActive = inwardRelevant && inwardThreshold > INWARD_DISABLED + EPS;
  return {
    outwardThreshold,
    inwardThreshold,
    outwardRelevant,
    inwardRelevant,
    outwardActive,
    inwardActive,
    active: outwardActive || inwardActive,
  };
}

/**
 * Build a non-indexed geometry whose triangle boundaries follow active
 * displacement thresholds. The returned materialIndices array is one entry per
 * output triangle: 0 = base, 1 = raised, 2 = inset.
 */
export function buildMulticolorPaintedGeometry(geometry, settings) {
  const cfg = getMulticolorConfig(settings);
  if (!cfg.active) return null;

  const posAttr = geometry.attributes.position;
  const dispAttr = geometry.attributes.signedDisplacement;
  if (!posAttr || !dispAttr) {
    throw new Error('Multicolor export metadata is missing from the mesh.');
  }

  const pos = posAttr.array;
  const disp = dispAttr.array;
  const thresholds = [];
  if (cfg.inwardActive) thresholds.push(cfg.inwardThreshold);
  if (cfg.outwardActive) thresholds.push(cfg.outwardThreshold);
  thresholds.sort((a, b) => a - b);

  const positions = [];
  const materialIndices = [];
  const triCount = disp.length / 3;

  for (let t = 0; t < triCount; t++) {
    const base = t * 3;
    const tri = [
      readVertex(base, pos, disp),
      readVertex(base + 1, pos, disp),
      readVertex(base + 2, pos, disp),
    ];
    const pieces = splitPolygonAtThresholds(tri, thresholds);
    for (const poly of pieces) {
      if (poly.length < 3) continue;
      const materialIndex = classifyPolygon(poly, cfg);
      const p0 = poly[0].pos;
      for (let i = 1; i < poly.length - 1; i++) {
        if (pushTri(positions, p0, poly[i].pos, poly[i + 1].pos)) {
          materialIndices.push(materialIndex);
        }
      }
    }
  }

  if (positions.length < 9) {
    throw new Error('No multicolor triangles were generated.');
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  recomputeFlatNormals(out);
  return {
    geometry: out,
    materialIndices: new Uint8Array(materialIndices),
    materials: MULTICOLOR_MATERIALS,
  };
}

function readVertex(i, pos, disp) {
  const b = i * 3;
  return {
    pos: [pos[b], pos[b + 1], pos[b + 2]],
    d: disp[i],
  };
}

function splitPolygonAtThresholds(poly, thresholds) {
  let pieces = [poly];
  for (const threshold of thresholds) {
    const next = [];
    for (const piece of pieces) {
      const lower = clipPolygonByThreshold(piece, threshold, -1);
      const upper = clipPolygonByThreshold(piece, threshold, 1);
      if (lower.length >= 3) next.push(lower);
      if (upper.length >= 3) next.push(upper);
    }
    pieces = next;
  }
  return pieces;
}

function clipPolygonByThreshold(poly, threshold, side) {
  const inside = (v) => side < 0 ? v.d <= threshold + EPS : v.d >= threshold - EPS;
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i];
    const prev = poly[(i + poly.length - 1) % poly.length];
    const curIn = inside(cur);
    const prevIn = inside(prev);
    if (curIn !== prevIn) out.push(intersectAtThreshold(prev, cur, threshold));
    if (curIn) out.push(cur);
  }
  return out;
}

function intersectAtThreshold(a, b, threshold) {
  const span = b.d - a.d;
  const f = Math.abs(span) < EPS ? 0 : (threshold - a.d) / span;
  return {
    pos: lerp3(a.pos, b.pos, f),
    d: threshold,
  };
}

function classifyPolygon(poly, cfg) {
  let sum = 0;
  for (const v of poly) sum += v.d;
  const avg = sum / poly.length;
  if (cfg.outwardActive && avg > cfg.outwardThreshold + EPS) return 1;
  if (cfg.inwardActive && avg < cfg.inwardThreshold - EPS) return 2;
  return 0;
}

function lerp3(a, b, f) {
  return [
    a[0] + (b[0] - a[0]) * f,
    a[1] + (b[1] - a[1]) * f,
    a[2] + (b[2] - a[2]) * f,
  ];
}

function pushTri(out, a, b, c) {
  if (triangleAreaSq(a, b, c) < 1e-20) return false;
  out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  return true;
}

function triangleAreaSq(a, b, c) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  return nx * nx + ny * ny + nz * nz;
}

function recomputeFlatNormals(geo) {
  const pa = geo.attributes.position.array;
  const na = new Float32Array(pa.length);
  for (let i = 0; i < pa.length; i += 9) {
    const ux = pa[i + 3] - pa[i], uy = pa[i + 4] - pa[i + 1], uz = pa[i + 5] - pa[i + 2];
    const vx = pa[i + 6] - pa[i], vy = pa[i + 7] - pa[i + 1], vz = pa[i + 8] - pa[i + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    for (let v = 0; v < 3; v++) {
      na[i + v * 3]     = nx / len;
      na[i + v * 3 + 1] = ny / len;
      na[i + v * 3 + 2] = nz / len;
    }
  }
  geo.setAttribute('normal', new THREE.BufferAttribute(na, 3));
}
