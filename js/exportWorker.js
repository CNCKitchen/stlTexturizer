/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

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
 *   main → worker: {cmd:'refine', input}                optimize posed export buffers
 *   worker → main: {type:'progress', stage, p, info}    forwarded events
 *   worker → main: {type:'done', result}                final buffers (transferred)
 *   worker → main: {type:'error', message}              pipeline threw
 *
 * Cancellation is handled by the main thread terminating the worker.
 */

import { runExportPipeline } from './exportPipeline.js';
import { refineExportMesh } from './exportRefinement.js';

self.onmessage = async (e) => {
  const msg = e.data;
  if (!msg || (msg.cmd !== 'run' && msg.cmd !== 'refine')) return;
  try {
    const emit = (stage, p, info) => {
      self.postMessage({ type: 'progress', stage, p, info });
    };
    if (msg.cmd === 'refine') emit('refine', 0);
    const result = msg.cmd === 'refine'
      ? await refineExportMesh(msg.input)
      : await runExportPipeline(msg.input, emit);
    const transfers = [result.positions.buffer];
    if (result.normals) transfers.push(result.normals.buffer);
    if (result.faceParentId) transfers.push(result.faceParentId.buffer);
    if (result.lockedFaces) transfers.push(result.lockedFaces.buffer);
    self.postMessage({ type: 'done', result }, transfers);
  } catch (err) {
    self.postMessage({ type: 'error', message: (err && err.message) || String(err) });
  }
};

// Posted after the static imports above resolved — i.e. three.js loaded.
self.postMessage({ type: 'ready' });
