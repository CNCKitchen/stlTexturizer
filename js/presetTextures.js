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
  { name: 'Basket',       url: 'textures/basket.jpg'       },
  { name: 'Brick',        url: 'textures/brick.jpg'        },
  { name: 'Bubble',       url: 'textures/bubble.jpg'       },
  { name: 'Crystal',      url: 'textures/crystal.jpg'      },
  { name: 'Grip Surface', url: 'textures/gripSurface.jpg'  },
  { name: 'Hexagon',      url: 'textures/hexagon.jpg'      },
  { name: 'Hexagons',     url: 'textures/hexagons.jpg'     },
  { name: 'Knitting',     url: 'textures/knitting.jpg'     },
  { name: 'Knurling',     url: 'textures/knurling.jpg'     },
  { name: 'Leather',      url: 'textures/leather.jpg'      },
  { name: 'Leather 2',    url: 'textures/leather2.jpg'     },
  { name: 'Melt',         url: 'textures/melt.jpg'         },
  { name: 'Noise',        url: 'textures/noise.jpg'        },
  { name: 'Rhombic',      url: 'textures/rhombic.jpg'      },
  { name: 'Voronoi',      url: 'textures/voronoi.jpg'      },
  { name: 'Weave',        url: 'textures/weave.jpg'        },
  { name: 'Weave 02',     url: 'textures/weave_02.jpg'     },
  { name: 'Wood',         url: 'textures/wood.jpg'         },
];

function loadImagePreset({ name, url }) {
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

      resolve({ name, thumbCanvas: thumb, fullCanvas: full, texture, imageData, width: w, height: h });
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
      resolve({ name: file.name, fullCanvas: canvas, texture, imageData, width: w, height: h });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to load image')); };
    img.src = url;
  });
}
