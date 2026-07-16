import * as THREE from 'three';

const OUTWARD_DISABLED = 2.0;
const INWARD_DISABLED = -2.0;
const EPS = 1e-6;

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

export function buildMulticolorPartGeometries(geometry, settings) {
  const cfg = getMulticolorConfig(settings);
  if (!cfg.active) return null;

  const posAttr = geometry.attributes.position;
  const origAttr = geometry.attributes.originalPosition;
  const normAttr = geometry.attributes.displacementNormal;
  const dispAttr = geometry.attributes.signedDisplacement;
  if (!posAttr || !origAttr || !normAttr || !dispAttr) {
    throw new Error('Multicolor export metadata is missing from the mesh.');
  }

  const base = buildBaseGeometry(posAttr.array, origAttr.array, normAttr.array, dispAttr.array, cfg);
  const parts = [{ name: 'Base', color: '#b8bec8', geometry: base }];

  if (cfg.outwardActive) {
    const raised = buildThresholdShell(posAttr.array, origAttr.array, normAttr.array, dispAttr.array, cfg.outwardThreshold, 1);
    if (raised && raised.attributes.position.count >= 3) {
      parts.push({ name: 'Raised Texture', color: '#f05a28', geometry: raised });
    }
  }
  if (cfg.inwardActive) {
    const inset = buildThresholdShell(posAttr.array, origAttr.array, normAttr.array, dispAttr.array, cfg.inwardThreshold, -1);
    if (inset && inset.attributes.position.count >= 3) {
      parts.push({ name: 'Inset Texture', color: '#2d79d8', geometry: inset });
    }
  }

  return parts;
}

function buildBaseGeometry(pos, orig, norm, disp, cfg) {
  const positions = [];
  const thresholds = [];
  if (cfg.inwardActive) thresholds.push(cfg.inwardThreshold);
  if (cfg.outwardActive) thresholds.push(cfg.outwardThreshold);

  const triCount = disp.length / 3;
  for (let t = 0; t < triCount; t++) {
    const base = t * 3;
    const tri = [
      readVertex(base, pos, orig, norm, disp),
      readVertex(base + 1, pos, orig, norm, disp),
      readVertex(base + 2, pos, orig, norm, disp),
    ];
    const pieces = splitPolygonAtThresholds(tri, thresholds);
    for (const poly of pieces) {
      if (poly.length < 3) continue;
      const p0 = basePoint(poly[0], cfg);
      for (let i = 1; i < poly.length - 1; i++) {
        pushTri(positions, p0, basePoint(poly[i], cfg), basePoint(poly[i + 1], cfg));
      }
    }
  }
  return makeGeometry(new Float32Array(positions));
}

function buildThresholdShell(pos, orig, norm, disp, threshold, direction) {
  const positions = [];
  const sideEdges = new Map();
  const triCount = disp.length / 3;

  for (let t = 0; t < triCount; t++) {
    const base = t * 3;
    const tri = [
      readVertex(base, pos, orig, norm, disp),
      readVertex(base + 1, pos, orig, norm, disp),
      readVertex(base + 2, pos, orig, norm, disp),
    ];
    const poly = clipTriangle(tri, threshold, direction);
    if (poly.length < 3) continue;

    const top0 = topPoint(poly[0]);
    const bot0 = thresholdPoint(poly[0], threshold);
    for (let i = 1; i < poly.length - 1; i++) {
      pushTri(positions, top0, topPoint(poly[i]), topPoint(poly[i + 1]));
      pushTri(positions, bot0, thresholdPoint(poly[i + 1], threshold), thresholdPoint(poly[i], threshold));
    }

    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const key = sideKey(a, b, threshold);
      if (sideEdges.has(key)) sideEdges.delete(key);
      else sideEdges.set(key, { a, b });
    }
  }

  for (const { a, b } of sideEdges.values()) {
    const at = topPoint(a);
    const bt = topPoint(b);
    const ab = thresholdPoint(a, threshold);
    const bb = thresholdPoint(b, threshold);
    if (distanceSq(at, ab) < EPS * EPS && distanceSq(bt, bb) < EPS * EPS) continue;
    pushTri(positions, at, bt, bb);
    pushTri(positions, at, bb, ab);
  }

  if (positions.length < 9) return null;
  return makeGeometry(new Float32Array(positions));
}

function readVertex(i, pos, orig, norm, disp) {
  const b = i * 3;
  return {
    top: [pos[b], pos[b + 1], pos[b + 2]],
    orig: [orig[b], orig[b + 1], orig[b + 2]],
    norm: [norm[b], norm[b + 1], norm[b + 2]],
    d: disp[i],
  };
}

function clipTriangle(tri, threshold, direction) {
  const inside = (v) => direction > 0 ? v.d > threshold + EPS : v.d < threshold - EPS;
  let out = [];
  for (let i = 0; i < tri.length; i++) {
    const cur = tri[i];
    const prev = tri[(i + tri.length - 1) % tri.length];
    const curIn = inside(cur);
    const prevIn = inside(prev);
    if (curIn !== prevIn) out.push(intersectAtThreshold(prev, cur, threshold));
    if (curIn) out.push(cur);
  }
  return out;
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

function basePoint(v, cfg) {
  let d = v.d;
  if (cfg.outwardActive && d > cfg.outwardThreshold) d = cfg.outwardThreshold;
  if (cfg.inwardActive && d < cfg.inwardThreshold) d = cfg.inwardThreshold;
  return [
    v.orig[0] + v.norm[0] * d,
    v.orig[1] + v.norm[1] * d,
    v.orig[2] + v.norm[2] * d,
  ];
}

function intersectAtThreshold(a, b, threshold) {
  const span = b.d - a.d;
  const f = Math.abs(span) < EPS ? 0 : (threshold - a.d) / span;
  const orig = lerp3(a.orig, b.orig, f);
  const norm = normalize3(lerp3(a.norm, b.norm, f));
  return {
    top: [
      orig[0] + norm[0] * threshold,
      orig[1] + norm[1] * threshold,
      orig[2] + norm[2] * threshold,
    ],
    orig,
    norm,
    d: threshold,
  };
}

function topPoint(v) {
  return v.top;
}

function thresholdPoint(v, threshold) {
  return [
    v.orig[0] + v.norm[0] * threshold,
    v.orig[1] + v.norm[1] * threshold,
    v.orig[2] + v.norm[2] * threshold,
  ];
}

function sideKey(a, b, threshold) {
  const ka = columnKey(a, threshold);
  const kb = columnKey(b, threshold);
  return ka < kb ? ka + '|' + kb : kb + '|' + ka;
}

function columnKey(v, threshold) {
  const t = topPoint(v);
  const b = thresholdPoint(v, threshold);
  return [
    q(t[0]), q(t[1]), q(t[2]),
    q(b[0]), q(b[1]), q(b[2]),
  ].join(',');
}

function q(n) {
  return Math.round(n * 1e5);
}

function lerp3(a, b, f) {
  return [
    a[0] + (b[0] - a[0]) * f,
    a[1] + (b[1] - a[1]) * f,
    a[2] + (b[2] - a[2]) * f,
  ];
}

function normalize3(v) {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (len < EPS) return [0, 0, 1];
  return [v[0] / len, v[1] / len, v[2] / len];
}

function pushTri(out, a, b, c) {
  if (triangleAreaSq(a, b, c) < 1e-20) return;
  out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
}

function triangleAreaSq(a, b, c) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  return nx * nx + ny * ny + nz * nz;
}

function distanceSq(a, b) {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

function makeGeometry(posArray) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
  recomputeFlatNormals(geo);
  return geo;
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
