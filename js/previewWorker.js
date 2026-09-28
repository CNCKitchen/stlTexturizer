/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * previewWorker.js — dedicated module-worker entry for the 3D-preview mesh
 * build (previewPipeline.js).  Keeps the multi-second subdivide/regularize
 * work off the UI thread so the preview can afford a finer mesh.  Separate
 * from exportWorker.js so a preview build never queues behind (or cancels)
 * an export.
 *
 * Protocol:
 *   worker → main: {type:'ready'}                once imports resolve
 *   main → worker: {cmd:'run', input}            see previewPipeline.js
 *   worker → main: {type:'progress', stage}      between pipeline stages
 *   worker → main: {type:'done', result}         final buffers (transferred)
 *   worker → main: {type:'error', message}       pipeline threw
 *
 * Cancellation is handled by the main thread terminating the worker.
 */

import { runPreviewPipeline } from './previewPipeline.js';

self.onmessage = async (e) => {
  const msg = e.data;
  if (!msg || msg.cmd !== 'run') return;
  try {
    const result = await runPreviewPipeline(msg.input, (stage) => {
      self.postMessage({ type: 'progress', stage });
    });
    const transfers = new Set([
      result.positions.buffer, result.normals.buffer, result.smoothNormals.buffer,
      result.faceNormals.buffer, result.faceParentId.buffer,
    ]);
    self.postMessage({ type: 'done', result }, [...transfers]);
  } catch (err) {
    self.postMessage({ type: 'error', message: (err && err.message) || String(err) });
  }
};

// Posted after the static imports above resolved — i.e. three.js loaded.
self.postMessage({ type: 'ready' });
