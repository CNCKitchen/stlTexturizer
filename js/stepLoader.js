/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// STEP (.step/.stp) import via meshStep (https://github.com/CNCKitchen/meshStep).
//
// The B-rep parse + tessellation runs in stepWorker.js so the UI stays live;
// this module owns the worker lifecycle and converts the returned triangle
// soup into the same { geometry, bounds, ... } contract the STL/OBJ/3MF
// loaders fulfil. Extra STEP-only data (conversion diagnostics, detected
// units) is returned under `step`.

import * as THREE from 'three';
import { setupGeometry, computeBounds } from './stlLoader.js';

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB, same guard as the other loaders

// A single reused worker: re-tessellation at another quality is a likely
// follow-up action and the CDN module fetch should only be paid once.
// importStep is synchronous inside the worker, so a job can only be cancelled
// by terminating the worker; the next import then boots a fresh one.
let _worker = null;
let _activeJob = null; // { reject } of the in-flight import

function _bootWorker() {
  return new Promise((resolve, reject) => {
    let w;
    try {
      w = new Worker(new URL('./stepWorker.js', import.meta.url), { type: 'module' });
    } catch (err) {
      reject(err);
      return;
    }
    const fail = (msg) => { try { w.terminate(); } catch {} reject(new Error(msg)); };
    const timer = setTimeout(() => fail('STEP worker init timeout'), 30000);
    w.onmessage = (e) => {
      if (e.data && e.data.type === 'ready') {
        clearTimeout(timer);
        w.onmessage = null;
        w.onerror = null;
        resolve(w);
      }
    };
    w.onerror = (e) => { clearTimeout(timer); fail((e && e.message) || 'STEP worker failed to load'); };
  });
}

/** Terminate any in-flight STEP import (rejects its promise with .stepCancelled). */
export function cancelStepImport() {
  if (!_activeJob) return;
  const err = new Error('STEP import cancelled');
  err.stepCancelled = true;
  try { _worker.terminate(); } catch {}
  _worker = null;
  const job = _activeJob;
  _activeJob = null;
  job.reject(err);
}

/**
 * Cheap size probe for the import dialog: boots the worker (warming it up for
 * the subsequent run) and returns { est: {diag, units}|null, auto } — meshStep's
 * size estimate and size-adaptive auto tolerances. Resolves null when a run is
 * already in flight or the worker can't answer.
 */
export async function estimateStep(text) {
  if (_activeJob) return null;
  try {
    if (!_worker) _worker = await _bootWorker();
  } catch {
    return null;
  }
  const w = _worker;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { w.onmessage = null; resolve(null); }, 15000);
    w.onmessage = (e) => {
      if (e.data && e.data.type === 'estimate') {
        clearTimeout(timer);
        w.onmessage = null;
        resolve(e.data);
      }
    };
    w.postMessage({ cmd: 'estimate', text });
  });
}

/**
 * Tessellate STEP source text into the standard loader result.
 * settings: { preset: 'coarse'|'standard'|'fine' } or explicit custom
 * { surfaceDeviation, normalDeviation, maxEdge } (resolved in stepConvert.js).
 * onProgress(stage, fraction) with stage 'parse' | 'tessellate' | 'finalize'.
 */
export async function loadSTEPText(text, { settings = { preset: 'standard' }, onProgress } = {}) {
  // A drop while a previous STEP import is still tessellating supersedes it.
  cancelStepImport();

  if (!_worker) _worker = await _bootWorker();
  const w = _worker;

  const result = await new Promise((resolve, reject) => {
    _activeJob = { reject };
    const cleanup = () => { w.onmessage = null; w.onerror = null; _activeJob = null; };
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') { if (onProgress) onProgress(m.stage, m.p); }
      else if (m.type === 'done') { cleanup(); resolve(m.result); }
      else if (m.type === 'error') {
        cleanup();
        // The worker survives an importStep throw (bad file ≠ broken worker).
        reject(new Error(m.message));
      }
    };
    w.onerror = (e) => {
      cleanup();
      try { w.terminate(); } catch {}
      _worker = null;
      reject(new Error((e && e.message) || 'STEP worker crashed'));
    };
    w.postMessage({ cmd: 'run', text, settings });
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(result.positions, 3));
  // Analytic B-rep normals: curved faces displace/shade along the true surface
  // normal instead of a faceted average. setupGeometry keeps them unless its
  // clean-up pass removed triangles (then it recomputes from the soup).
  if (result.normals) {
    geometry.setAttribute('normal', new THREE.BufferAttribute(result.normals, 3));
  }
  const { nanCount, degenerateCount, originOffset } = setupGeometry(geometry);
  const bounds = computeBounds(geometry);

  return {
    geometry, bounds, nanCount, degenerateCount, originOffset,
    step: {
      units: result.units,
      diagnostics: result.diagnostics,
    },
  };
}

/**
 * Load a STEP file. Same contract as loadSTLFile/load3MFFile, plus `step`.
 */
export function loadSTEPFile(file, opts = {}) {
  if (file.size > MAX_FILE_SIZE) {
    return Promise.reject(new Error(
      'File too large (' + Math.round(file.size / 1024 / 1024) + ' MB). Maximum supported: ' + (MAX_FILE_SIZE / 1024 / 1024) + ' MB.'
    ));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsText(file);
  }).then((text) => loadSTEPText(text, opts));
}
