/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * outlineWrapWorker.js — builds the outline wrap's tables (outlineWrap.js)
 * and the per-vertex places of a mesh off the UI thread (about 1.5 s per
 * million triangles). A places request carries its tables, so the places of
 * another mesh on the same surface (the 3D-preview mesh) need no rebuild, and
 * the worker holds no state.
 *
 * Protocol:
 *   worker → main: {type:'ready'}                         once imports resolve
 *   main → worker: {cmd:'build', id, positions}           tables of this mesh, and its places
 *   main → worker: {cmd:'places', id, positions, wrap}    places of a mesh on the tables `wrap`
 *   worker → main: {type:'done', id, wrap?, places}       places transferred
 *   worker → main: {type:'error', id, message}            the outline wrap cannot follow the mesh
 */

import { buildOutlineWrap, outlineWrapPlaces } from './outlineWrap.js';

self.onmessage = (e) => {
  const msg = e.data;
  if (!msg) return;
  try {
    if (msg.cmd === 'build') {
      const wrap = buildOutlineWrap(msg.positions);
      const places = outlineWrapPlaces(wrap, msg.positions);
      self.postMessage({ type: 'done', id: msg.id, wrap, places }, [places.buffer]);
    } else if (msg.cmd === 'places') {
      const places = outlineWrapPlaces(msg.wrap, msg.positions);
      self.postMessage({ type: 'done', id: msg.id, places }, [places.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: (err && err.message) || String(err) });
  }
};

// Posted after the static imports above resolved.
self.postMessage({ type: 'ready' });
