/**
 * textures.mjs — headless replacement for js/presetTextures.js (which needs
 * TextureLoader/Canvas2D/DOM). Reads the same 24 files from ../textures
 * directly off disk and decodes them via lib/imageData.mjs.
 *
 * Catalog data (name, url, defaultScale) is copied verbatim from
 * js/presetTextures.js `IMAGE_PRESETS` — see PIPELINE_CONTRACT.md. `category`
 * and `description` are new, MCP-only fields (not present upstream) added so
 * an agent can browse presets without opening every image.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeImageFile, toLuminance, capLongestSide, applySmoothing } from './imageData.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEXTURES_DIR = path.resolve(__dirname, '..', '..', 'textures');

export const TEXTURE_CATALOG = [
  { name: 'Basket',       file: 'basket.png',       category: 'Weave',      defaultScale: 0.5,  description: 'Woven basket-weave lattice.' },
  { name: 'Brick',        file: 'brick.png',        category: 'Masonry',    defaultScale: 0.5,  description: 'Running-bond brick courses.' },
  { name: 'Bubble',       file: 'bubble.png',       category: 'Organic',    defaultScale: 0.5,  description: 'Randomly packed circular bubbles.' },
  { name: 'Carbon Fiber', file: 'carbonFiber.jpg',  category: 'Industrial', defaultScale: 0.5,  description: 'Twill carbon-fiber weave.' },
  { name: 'Crystal',      file: 'crystal.png',      category: 'Geometric',  defaultScale: 0.5,  description: 'Faceted crystalline shards.' },
  { name: 'Dots',         file: 'dots.png',         category: 'Geometric',  defaultScale: 0.1,  description: 'Regular grid of round dots.' },
  { name: 'Grid',         file: 'grid.png',         category: 'Geometric',  defaultScale: 1.0,  description: 'Square grid lines.' },
  { name: 'Grip Surface', file: 'gripSurface.jpg',  category: 'Functional', defaultScale: 0.5,  description: 'Raised anti-slip grip bumps.' },
  { name: 'Hexagon',      file: 'hexagon.jpg',      category: 'Geometric',  defaultScale: 0.5,  description: 'Single-scale hexagon honeycomb.' },
  { name: 'Hexagons',     file: 'hexagons.jpg',     category: 'Geometric',  defaultScale: 1.0,  description: 'Dense hexagon honeycomb tiling.' },
  { name: 'Isogrid',      file: 'isogrid.png',      category: 'Industrial', defaultScale: 0.5,  description: 'Triangular isogrid stiffener pattern.' },
  { name: 'Knitting',     file: 'knitting.png',     category: 'Weave',      defaultScale: 0.25, description: 'Knitted-fabric loop stitches.' },
  { name: 'Knurling',     file: 'knurling.jpg',     category: 'Functional', defaultScale: 0.15, description: 'Diamond knurl grip pattern.' },
  { name: 'Leather 2',    file: 'leather2.png',     category: 'Organic',    defaultScale: 0.5,  description: 'Pebbled leather grain.' },
  { name: 'Noise',        file: 'noise.jpg',        category: 'Organic',    defaultScale: 0.3,  description: 'Fine random surface noise.' },
  { name: 'Stripes 1',    file: 'stripes.png',      category: 'Geometric',  defaultScale: 0.5,  description: 'Parallel straight stripes.' },
  { name: 'Stripes 2',    file: 'stripes_02.png',   category: 'Geometric',  defaultScale: 1.0,  description: 'Alternate-width parallel stripes.' },
  { name: 'Voronoi',      file: 'voronoi.jpg',      category: 'Organic',    defaultScale: 0.5,  description: 'Voronoi cell fracture pattern.' },
  { name: 'Weave 1',      file: 'weave.png',        category: 'Weave',      defaultScale: 0.5,  description: 'Plain over-under fabric weave.' },
  { name: 'Weave 2',      file: 'weave_02.jpg',     category: 'Weave',      defaultScale: 0.5,  description: 'Coarse basket-style fabric weave.' },
  { name: 'Weave 3',      file: 'weave_03.jpg',     category: 'Weave',      defaultScale: 0.5,  description: 'Fine twill fabric weave.' },
  { name: 'Wood 1',       file: 'wood.jpg',         category: 'Organic',    defaultScale: 0.5,  description: 'Straight wood grain.' },
  { name: 'Wood 2',       file: 'woodgrain_02.jpg', category: 'Organic',    defaultScale: 1.0,  description: 'Wavy wood grain with knots.' },
  { name: 'Wood 3',       file: 'woodgrain_03.jpg', category: 'Organic',    defaultScale: 1.0,  description: 'Coarse plank wood grain.' },
];

/** [{name, category, description, defaultScale}] for the list_textures tool. */
export function listTextures() {
  return TEXTURE_CATALOG.map(({ name, category, description, defaultScale }) => ({
    name,
    category,
    description,
    defaultScale,
  }));
}

export function validTextureNames() {
  return TEXTURE_CATALOG.map((t) => t.name);
}

function normalize(s) {
  return String(s).trim().toLowerCase();
}

/**
 * Resolve a texture parameter to an absolute file path under ../textures.
 * Accepts a preset name (case-insensitive, e.g. "hexagon") or the preset's
 * bare filename (e.g. "hexagon.jpg"). Returns null if it doesn't match any
 * built-in preset (the caller may then treat the string as a literal path).
 */
export function resolveTexture(nameOrFilename) {
  if (!nameOrFilename) return null;
  const key = normalize(nameOrFilename);
  const byName = TEXTURE_CATALOG.find((t) => normalize(t.name) === key);
  if (byName) return path.join(TEXTURES_DIR, byName.file);
  const byFile = TEXTURE_CATALOG.find(
    (t) => normalize(t.file) === key || normalize(path.basename(t.file)) === key
  );
  if (byFile) return path.join(TEXTURES_DIR, byFile.file);
  return null;
}

/**
 * Load a texture (preset or custom path) as a displacement-ready image:
 * decode -> greyscale luminance -> cap longest side to 512px -> optional blur.
 */
export async function loadTextureImageData(filePath, smoothing = 0) {
  let img = await decodeImageFile(filePath);
  img = toLuminance(img);
  img = capLongestSide(img, 512);
  img = applySmoothing(img, smoothing);
  return img;
}
