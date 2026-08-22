/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// STEP import worker.
//
// Tessellating a STEP B-rep is CPU-heavy (seconds for real parts), so it runs
// here instead of the main thread. meshStep is pure JS with zero dependencies,
// so unlike exportWorker there is no three.js/import-map dance — one pinned
// CDN module is the whole payload.
//
// Protocol (mirrors exportWorker.js):
//   worker → main:  { type:'ready' }                       — module loaded
//   main → worker:  { cmd:'estimate', text }               — cheap size probe for the import dialog
//   worker → main:  { type:'estimate', est, auto }         — { diag, units } | null + auto tolerances
//   main → worker:  { cmd:'run', text, settings }          — { preset } or custom { surfaceDeviation, normalDeviation, maxEdge }
//   worker → main:  { type:'progress', stage, p }          — stage: 'parse'|'tessellate'|'finalize'
//   worker → main:  { type:'done', result }                — soup arrays (transferred) + diagnostics
//   worker → main:  { type:'error', message }
//
// Cancellation is terminate-only: importStep runs synchronously, so this
// worker cannot process a cancel message mid-import. The main thread
// terminates and respawns instead (see stepLoader.js).

import {
  importStep,
  estimateStepSize,
  autoTessellation,
} from 'https://cdn.jsdelivr.net/npm/meshstep@0.1.0/+esm';
import { resolveStepSettings, stepResultToSoup, summarizeDiagnostics } from './stepConvert.js';

self.onmessage = (e) => {
  const msg = e.data;
  if (!msg) return;
  if (msg.cmd === 'estimate') {
    let est = null;
    try { est = estimateStepSize(msg.text); } catch {}
    self.postMessage({
      type: 'estimate',
      est:  est ? { diag: est.diag, units: est.units } : null,
      auto: est ? autoTessellation(est.diag) : null,
    });
    return;
  }
  if (msg.cmd !== 'run') return;
  try {
    const result = run(msg.text, msg.settings);
    const transfer = result.normals
      ? [result.positions.buffer, result.normals.buffer]
      : [result.positions.buffer];
    self.postMessage({ type: 'done', result }, transfer);
  } catch (err) {
    self.postMessage({ type: 'error', message: (err && err.message) || String(err) });
  }
};

function run(text, settings) {
  const est = estimateStepSize(text);
  const tol = resolveStepSettings(est ? autoTessellation(est.diag) : null, settings);

  self.postMessage({ type: 'progress', stage: 'parse', p: 0.03 });

  // Tessellation dominates the runtime; map its work-unit fraction onto
  // 5%..95% of the bar and throttle to whole-percent steps.
  let lastPct = -1;
  const r = importStep(text, {
    ...tol,
    vertexNormals: true,
    onProgress: (p) => {
      if (p.phase === 'tessellate' && p.total > 0) {
        const frac = 0.05 + 0.9 * (p.done / p.total);
        const pct  = Math.round(frac * 100);
        if (pct !== lastPct) {
          lastPct = pct;
          self.postMessage({ type: 'progress', stage: 'tessellate', p: frac });
        }
      } else if (p.phase === 'finalize') {
        self.postMessage({ type: 'progress', stage: 'finalize', p: 0.96 });
      }
    },
  });

  const soup = stepResultToSoup(r);
  return {
    positions: soup.positions,
    normals:   soup.normals,
    triCount:  soup.triCount,
    units:     r.units,
    diagnostics: summarizeDiagnostics(r.diagnostics),
  };
}

self.postMessage({ type: 'ready' });
