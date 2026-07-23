/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Pure STEP-conversion helpers shared by stepWorker.js (browser) and the Node
// test harness (test-step-import.mjs). No DOM, no three.js, no meshstep
// import — callers pass meshStep's data in.

// Quality multipliers applied to meshStep's size-adaptive auto tolerances.
// Standard matches CAD-export defaults; the texturizer refines/subdivides on
// its own, so coarse is often enough as a displacement base.
export const STEP_QUALITY = {
  coarse:   { deviation: 5,    edge: 3   },
  standard: { deviation: 1,    edge: 1   },
  fine:     { deviation: 0.25, edge: 0.5 },
};

/** meshStep's default normal deviation (Fusion "Normal Deviation"), degrees. */
export const STEP_DEFAULT_NORMAL_DEV = 15;

/**
 * Resolve tessellation tolerances from a size estimate + the import dialog's
 * settings: either { preset: 'coarse'|'standard'|'fine' } (multiplier on the
 * size-adaptive auto tolerances) or explicit custom values
 * { surfaceDeviation, normalDeviation, maxEdge } (mm / ° / mm). Invalid or
 * missing custom numbers fall back to the auto/default value.
 */
export function resolveStepSettings(auto, settings) {
  const base = auto || { surfaceDeviation: 0.01, maxEdge: 1 };
  if (settings && settings.preset === undefined) {
    const num = (v, fallback) => (Number.isFinite(+v) && +v > 0) ? +v : fallback;
    return {
      surfaceDeviation: num(settings.surfaceDeviation, base.surfaceDeviation),
      normalDeviation:  Math.min(90, num(settings.normalDeviation, STEP_DEFAULT_NORMAL_DEV)),
      maxEdge:          num(settings.maxEdge, base.maxEdge),
    };
  }
  const q = STEP_QUALITY[settings && settings.preset] || STEP_QUALITY.standard;
  return {
    surfaceDeviation: base.surfaceDeviation * q.deviation,
    normalDeviation:  STEP_DEFAULT_NORMAL_DEV,
    maxEdge:          base.maxEdge * q.edge,
  };
}

/**
 * Expand meshStep's indexed result (Float64 positions + per-vertex analytic
 * normals) into the non-indexed Float32 triangle soup (9 floats per triangle)
 * that the whole texturizer pipeline is built around.
 */
export function stepResultToSoup(r) {
  const idx      = r.mesh.indices;
  const pos      = r.mesh.positions;   // 3 per vertex, always mm
  const nrm      = r.normals || null;  // analytic B-rep normals, 3 per vertex
  const triCount = idx.length / 3;
  const soupPos  = new Float32Array(triCount * 9);
  const soupNrm  = nrm ? new Float32Array(triCount * 9) : null;
  for (let i = 0; i < idx.length; i++) {
    const v = idx[i] * 3, o = i * 3;
    soupPos[o]     = pos[v];
    soupPos[o + 1] = pos[v + 1];
    soupPos[o + 2] = pos[v + 2];
    if (soupNrm) {
      soupNrm[o]     = nrm[v];
      soupNrm[o + 1] = nrm[v + 1];
      soupNrm[o + 2] = nrm[v + 2];
    }
  }
  return { positions: soupPos, normals: soupNrm, triCount };
}

/** Structured-clone-safe subset of meshStep's ImportDiagnostics. */
export function summarizeDiagnostics(d) {
  d = d || {};
  return {
    ok:               !!d.ok,
    openEdges:        d.openEdges        | 0,
    nonManifoldEdges: d.nonManifoldEdges | 0,
    facesDropped:     d.facesDropped     | 0,
    facesSkipped:     d.facesSkipped     | 0,
    warnings: (d.warnings || []).slice(0, 20).map(w => ({
      code: w.code, severity: w.severity, faceId: w.faceId, detail: w.detail,
    })),
  };
}
