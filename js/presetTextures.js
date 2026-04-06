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

/** Draw img into a square canvas using cover-scaling (preserves aspect ratio, center-crops). */
function drawCover(ctx, img, size) {
  const scale = Math.max(size / img.width, size / img.height);
  const w = img.width  * scale;
  const h = img.height * scale;
  ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
}

/** Return { w, h } capped at SIZE on the longest side, preserving aspect ratio. */
function fitDimensions(imgW, imgH) {
  const scale = Math.min(SIZE / imgW, SIZE / imgH, 1);
  return { w: Math.round(imgW * scale), h: Math.round(imgH * scale) };
}

// ── Image-based presets ───────────────────────────────────────────────────────

const IMAGE_PRESETS = [
  { name: 'Basket',       url: 'textures/basket.jpg',       defaultScale: 0.5 },
  { name: 'Brick',        url: 'textures/brick.jpg',        defaultScale: 0.5 },
  { name: 'Bubble',       url: 'textures/bubble.jpg',       defaultScale: 0.5 },
  { name: 'Carbon Fiber', url: 'textures/carbonFiber.jpg',  defaultScale: 0.5 },
  { name: 'Crystal',      url: 'textures/crystal.jpg',      defaultScale: 0.5 },
  { name: 'Dots',         url: 'textures/dots.jpg',         defaultScale: 0.1 },
  { name: 'Grid',         url: 'textures/grid.png',         defaultScale: 1.0 },
  { name: 'Grip Surface', url: 'textures/gripSurface.jpg',  defaultScale: 0.5 },
  { name: 'Hexagon',      url: 'textures/hexagon.jpg',      defaultScale: 0.5 },
  { name: 'Hexagons',     url: 'textures/hexagons.jpg',     defaultScale: 1.0 },
  { name: 'Isogrid',      url: 'textures/isogrid.png',      defaultScale: 0.5 },
  { name: 'Knitting',     url: 'textures/knitting.jpg',     defaultScale: 0.25 },
  { name: 'Knurling',     url: 'textures/knurling.jpg',     defaultScale: 0.15 },
  { name: 'Leather 2',    url: 'textures/leather2.jpg',     defaultScale: 0.5 },
  { name: 'Noise',        url: 'textures/noise.jpg',        defaultScale: 0.3 },
  { name: 'Stripes 1',      url: 'textures/stripes.png',      defaultScale: 0.5 },
  { name: 'Stripes 2',   url: 'textures/stripes_02.png',   defaultScale: 1.0 },
  { name: 'Voronoi',      url: 'textures/voronoi.jpg',      defaultScale: 0.5 },
  { name: 'Weave 1',        url: 'textures/weave.jpg',        defaultScale: 0.5 },
  { name: 'Weave 2',     url: 'textures/weave_02.jpg',     defaultScale: 0.5 },
  { name: 'Weave 3',     url: 'textures/weave_03.jpg',     defaultScale: 0.5 },
  { name: 'Wood 1',         url: 'textures/wood.jpg',         defaultScale: 0.5 },
  { name: 'Wood 2',       url: 'textures/woodgrain_02.jpg', defaultScale: 1.0 },
  { name: 'Wood 3',       url: 'textures/woodgrain_03.jpg', defaultScale: 1.0 },
];

function loadImagePreset(preset) {
  const { name, url } = preset;
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const { w, h } = fitDimensions(img.width, img.height);
      const full = makeCanvas(w, h);
      full.getContext('2d').drawImage(img, 0, 0, w, h);

      const thumb = makeCanvas(THUMB);
      drawCover(thumb.getContext('2d'), img, THUMB);

      const imageData = full.getContext('2d').getImageData(0, 0, w, h);
      const texture   = new THREE.CanvasTexture(full);
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.name = name;

      resolve({ name, thumbCanvas: thumb, fullCanvas: full, texture, imageData, width: w, height: h, defaultScale: preset.defaultScale });
    };
    img.onerror = () => reject(new Error(`Failed to load preset image: ${url}`));
    img.src = url;
  });
}

export function loadPresets() {
  return Promise.all(IMAGE_PRESETS.map(loadImagePreset));
}


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

      const thumb = makeCanvas(THUMB);
      drawCover(thumb.getContext('2d'), img, THUMB);

      resolve({ name: file.name, thumbCanvas: thumb, fullCanvas: canvas, texture, imageData, width: w, height: h, isCustom: true });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to load image')); };
    img.src = url;
  });
}

/**
 * Load a texture from a remote URL (e.g. raw GitHub content).
 */
export function loadTextureFromUrl(url, name) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const { w, h } = fitDimensions(img.width, img.height);
      const canvas = makeCanvas(w, h);
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      const imageData = canvas.getContext('2d').getImageData(0, 0, w, h);
      const texture   = new THREE.CanvasTexture(canvas);
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.name = name;

      const thumb = makeCanvas(THUMB);
      drawCover(thumb.getContext('2d'), img, THUMB);

      resolve({ name, thumbCanvas: thumb, fullCanvas: canvas, texture, imageData, width: w, height: h, isCustom: true });
    };
    img.onerror = () => reject(new Error(`Failed to load texture: ${name}`));
    img.src = url;
  });
}
