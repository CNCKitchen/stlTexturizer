/**
 * exportWorker.js — dedicated module-worker entry for the export/bake mesh
 * pipeline. Keeps the multi-second subdivide/displace/decimate work off the
 * UI thread, and — because workers aren't subject to background-tab timer
 * throttling the way the page is — a backgrounded tab no longer stretches a
 * 30-second export into minutes.
 *
 * three.js resolves via threeCompat.js (workers ignore the page's import map,
 * so the compat shim falls back to the CDN URL here).
 *
 * Protocol:
 *   worker → main: {type:'ready'}                       once imports resolve
 *   main → worker: {cmd:'run', input}                   see exportPipeline.js
 *   worker → main: {type:'progress', stage, p, info}    forwarded events
 *   worker → main: {type:'done', result}                final buffers (transferred)
 *   worker → main: {type:'error', message}              pipeline threw
 *
 * Cancellation is handled by the main thread terminating the worker.
 */

import { runExportPipeline } from './exportPipeline.js';

self.onmessage = async (e) => {
  const msg = e.data;
  if (!msg || msg.cmd !== 'run') return;
  try {
    const result = await runExportPipeline(msg.input, (stage, p, info) => {
      self.postMessage({ type: 'progress', stage, p, info });
    });
    const transfers = [result.positions.buffer];
    if (result.normals) transfers.push(result.normals.buffer);
    if (result.faceParentId) transfers.push(result.faceParentId.buffer);
    self.postMessage({ type: 'done', result }, transfers);
  } catch (err) {
    self.postMessage({ type: 'error', message: (err && err.message) || String(err) });
  }
};

// Posted after the static imports above resolved — i.e. three.js loaded.
self.postMessage({ type: 'ready' });
