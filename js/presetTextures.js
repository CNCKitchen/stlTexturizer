/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as THREE from 'three';

const SIZE  = 512; // texture resolution for both preview and sampling
const THUMB = 80;

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCanvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width  = w;
  c.height = h;
  return c;
}

/** Return { w, h } capped at SIZE on the longest side, preserving aspect ratio. */
function fitDimensions(imgW, imgH) {
  const scale = Math.min(SIZE / imgW, SIZE / imgH, 1);
  return { w: Math.round(imgW * scale), h: Math.round(imgH * scale) };
}

// ── Image-based presets ───────────────────────────────────────────────────────

const IMAGE_PRESETS = [
  { name: 'Basket',       url: 'textures/basket.png',       thumb: 'textures/thumbs/basket.webp',       defaultScale: 0.5 },
  { name: 'Brick',        url: 'textures/brick.png',        thumb: 'textures/thumbs/brick.webp',        defaultScale: 0.5 },
  { name: 'Bubble',       url: 'textures/bubble.png',       thumb: 'textures/thumbs/bubble.webp',       defaultScale: 0.5 },
  { name: 'Carbon Fiber', url: 'textures/carbonFiber.jpg',  thumb: 'textures/thumbs/carbonFiber.webp',  defaultScale: 0.5 },
  { name: 'Crystal',      url: 'textures/crystal.png',      thumb: 'textures/thumbs/crystal.webp',      defaultScale: 0.5 },
  { name: 'Dots',         url: 'textures/dots.png',         thumb: 'textures/thumbs/dots.webp',         defaultScale: 0.1 },
  { name: 'Grid',         url: 'textures/grid.png',         thumb: 'textures/thumbs/grid.webp',         defaultScale: 1.0 },
  { name: 'Grip Surface', url: 'textures/gripSurface.jpg',  thumb: 'textures/thumbs/gripSurface.webp',  defaultScale: 0.5 },
  { name: 'Hexagon',      url: 'textures/hexagon.jpg',      thumb: 'textures/thumbs/hexagon.webp',      defaultScale: 0.5 },
  { name: 'Hexagons',     url: 'textures/hexagons.jpg',     thumb: 'textures/thumbs/hexagons.webp',     defaultScale: 1.0 },
  { name: 'Isogrid',      url: 'textures/isogrid.png',      thumb: 'textures/thumbs/isogrid.webp',      defaultScale: 0.5 },
  { name: 'Knitting',     url: 'textures/knitting.png',     thumb: 'textures/thumbs/knitting.webp',     defaultScale: 0.25 },
  { name: 'Knurling',     url: 'textures/knurling.jpg',     thumb: 'textures/thumbs/knurling.webp',     defaultScale: 0.15 },
  { name: 'Leather 2',    url: 'textures/leather2.png',     thumb: 'textures/thumbs/leather2.webp',     defaultScale: 0.5 },
  { name: 'Noise',        url: 'textures/noise.jpg',        thumb: 'textures/thumbs/noise.webp',        defaultScale: 0.3 },
  { name: 'Stripes 1',    url: 'textures/stripes.png',      thumb: 'textures/thumbs/stripes.webp',      defaultScale: 0.5 },
  { name: 'Stripes 2',    url: 'textures/stripes_02.png',   thumb: 'textures/thumbs/stripes_02.webp',   defaultScale: 1.0 },
  { name: 'Voronoi',      url: 'textures/voronoi.jpg',      thumb: 'textures/thumbs/voronoi.webp',      defaultScale: 0.5 },
  { name: 'Weave 1',      url: 'textures/weave.png',        thumb: 'textures/thumbs/weave.webp',        defaultScale: 0.5 },
  { name: 'Weave 2',      url: 'textures/weave_02.jpg',     thumb: 'textures/thumbs/weave_02.webp',     defaultScale: 0.5 },
  { name: 'Weave 3',      url: 'textures/weave_03.jpg',     thumb: 'textures/thumbs/weave_03.webp',     defaultScale: 0.5 },
  { name: 'Wood 1',       url: 'textures/wood.jpg',         thumb: 'textures/thumbs/wood.webp',         defaultScale: 0.5 },
  { name: 'Wood 2',       url: 'textures/woodgrain_02.jpg', thumb: 'textures/thumbs/woodgrain_02.webp', defaultScale: 1.0 },
  { name: 'Wood 3',       url: 'textures/woodgrain_03.jpg', thumb: 'textures/thumbs/woodgrain_03.webp', defaultScale: 1.0 },
];

// Cache for full-resolution preset data (keyed by index)
const _fullPresetCache = new Map();

/**
 * Load only the pre-computed thumbnail for a preset.
 * Returns { name, thumbCanvas, defaultScale }.
 */
function loadPresetThumbnail(preset) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const thumb = makeCanvas(THUMB);
      thumb.getContext('2d').drawImage(img, 0, 0, THUMB, THUMB);
      resolve({ name: preset.name, thumbCanvas: thumb, defaultScale: preset.defaultScale });
    };
    img.onerror = () => reject(new Error(`Failed to load thumbnail: ${preset.thumb}`));
    img.src = preset.thumb;
  });
}

/**
 * Load the full-resolution texture for a preset (on demand).
 * Returns the full entry: { name, thumbCanvas, fullCanvas, texture, imageData, width, height, defaultScale }.
 * Results are cached so repeated calls for the same index return instantly.
 */
export function loadFullPreset(idx) {
  if (_fullPresetCache.has(idx)) return Promise.resolve(_fullPresetCache.get(idx));
  const preset = IMAGE_PRESETS[idx];
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const { w, h } = fitDimensions(img.width, img.height);
      const full = makeCanvas(w, h);
      full.getContext('2d').drawImage(img, 0, 0, w, h);

      const imageData = full.getContext('2d').getImageData(0, 0, w, h);
      const texture   = new THREE.CanvasTexture(full);
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.name = preset.name;

      const entry = { name: preset.name, fullCanvas: full, texture, imageData, width: w, height: h, defaultScale: preset.defaultScale };
      _fullPresetCache.set(idx, entry);
      resolve(entry);
    };
    img.onerror = () => reject(new Error(`Failed to load preset image: ${preset.url}`));
    img.src = preset.url;
  });
}

/**
 * Load all thumbnails. Returns Promise<Array<{ name, thumbCanvas, defaultScale }|null>>.
 */
export function loadAllThumbnails() {
  return Promise.all(IMAGE_PRESETS.map(p =>
    loadPresetThumbnail(p).catch(() => null)
  ));
}

export { IMAGE_PRESETS };


/**
 * Build a THREE.CanvasTexture + ImageData from a user-uploaded image File.
 */
export function loadCustomTexture(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const { w, h } = fitDimensions(img.width, img.height);
      const canvas = makeCanvas(w, h);
      const ctx    = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      const imageData = ctx.getImageData(0, 0, w, h);
      const texture   = new THREE.CanvasTexture(canvas);
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.name = file.name;
      resolve({ name: file.name, fullCanvas: canvas, texture, imageData, width: w, height: h });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to load image')); };
    img.src = url;
  });
}
