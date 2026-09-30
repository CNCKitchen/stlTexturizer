/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as THREE from 'three';

const SIZE  = 512; // preset texture resolution for both preview and sampling
// Custom uploads keep up to 2048 px (#89): squeezing an 8K heightmap into
// 512 px left it blocky. 2048² stays inside every GPU and canvas limit and
// costs ~16 MB per RGBA copy. Texture smoothing and Smart Resolution
// normalise to 512 px (see REF_TEXTURE_SIZE in textureAnalysis.js), so their
// behaviour doesn't shift with the map's pixel count.
const CUSTOM_SIZE = 2048;

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCanvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width  = w;
  c.height = h;
  return c;
}

/** Return { w, h } capped at maxSize on the longest side, preserving aspect ratio. */
function fitDimensions(imgW, imgH, maxSize = SIZE) {
  const scale = Math.min(maxSize / imgW, maxSize / imgH, 1);
  return { w: Math.round(imgW * scale), h: Math.round(imgH * scale) };
}

// ── Image-based presets ───────────────────────────────────────────────────────
// category: gallery filter group (see PRESET_CATEGORIES).
// credit:   'hero' = derived from Hero Patterns (CC BY 4.0, attribution required),
//           'cc0'  = public-domain map from ambientCG / Poly Haven (`source` = asset page),
//           'ff'   = made with Filter Forge.

const IMAGE_PRESETS = [
  { name: 'Armor',                url: 'textures/armor.png',                      thumb: 'textures/thumbs/armor.webp',                      defaultScale: 0.5,  category: 'natural' },
  { name: 'Art Deco',             url: 'textures/artDeco.png',                    thumb: 'textures/thumbs/artDeco.webp',                    defaultScale: 0.5,  category: 'patterns' },
  { name: 'Autumn',               url: 'textures/hero-autumn.png',                thumb: 'textures/thumbs/hero-autumn.webp',                defaultScale: 0.75, category: 'patterns', credit: 'hero' },
  { name: 'Aztec',                url: 'textures/hero-aztec.png',                 thumb: 'textures/thumbs/hero-aztec.webp',                 defaultScale: 0.5,  category: 'patterns', credit: 'hero' },
  { name: 'Bamboo',               url: 'textures/hero-bamboo.png',                thumb: 'textures/thumbs/hero-bamboo.webp',                defaultScale: 0.25, category: 'patterns', credit: 'hero' },
  { name: 'Bamboo Culms',         url: 'textures/bambooCulms.png',                thumb: 'textures/thumbs/bambooCulms.webp',                defaultScale: 0.5,  category: 'natural' },
  { name: 'Bank Note',            url: 'textures/hero-bank-note.png',             thumb: 'textures/thumbs/hero-bank-note.webp',             defaultScale: 0.8,  category: 'patterns', credit: 'hero' },
  { name: 'Bark',                 url: 'textures/bark.png',                       thumb: 'textures/thumbs/bark.webp',                       defaultScale: 0.5,  category: 'natural', credit: 'cc0', source: 'https://ambientcg.com/view?id=Bark001' },
  { name: 'Basket',               url: 'textures/basket.png',                     thumb: 'textures/thumbs/basket.webp',                     defaultScale: 0.5,  category: 'fabric', credit: 'ff' },
  { name: 'Basket 2',             url: 'textures/basket_02.png',                  thumb: 'textures/thumbs/basket_02.webp',                  defaultScale: 0.5,  category: 'fabric' },
  { name: 'Brick',                url: 'textures/brick.png',                      thumb: 'textures/thumbs/brick.webp',                      defaultScale: 0.5,  category: 'geometric', credit: 'ff' },
  { name: 'Brick 2',              url: 'textures/brick_02.png',                   thumb: 'textures/thumbs/brick_02.webp',                   defaultScale: 0.5,  category: 'geometric' },
  { name: 'Brushed',              url: 'textures/brushed.png',                    thumb: 'textures/thumbs/brushed.webp',                    defaultScale: 1.0,  category: 'mold' },
  { name: 'Bubble',               url: 'textures/bubble.png',                     thumb: 'textures/thumbs/bubble.webp',                     defaultScale: 0.5,  category: 'organic', credit: 'ff' },
  { name: 'Bubbles',              url: 'textures/hero-bubbles.png',               thumb: 'textures/thumbs/hero-bubbles.webp',               defaultScale: 0.8,  category: 'patterns', credit: 'hero' },
  { name: 'Cage',                 url: 'textures/hero-cage.png',                  thumb: 'textures/thumbs/hero-cage.webp',                  defaultScale: 0.25, category: 'geometric', credit: 'hero' },
  { name: 'Carbon Fiber',         url: 'textures/carbonFiber.jpg',                thumb: 'textures/thumbs/carbonFiber.webp',                defaultScale: 0.5,  category: 'fabric' },
  { name: 'Carbon Twill',         url: 'textures/carbonTwill.png',                thumb: 'textures/thumbs/carbonTwill.webp',                defaultScale: 0.75, category: 'fabric' },
  { name: 'Chainmail',            url: 'textures/chainmail.png',                  thumb: 'textures/thumbs/chainmail.webp',                  defaultScale: 0.4,  category: 'fabric' },
  { name: 'Chevron',              url: 'textures/chevron.png',                    thumb: 'textures/thumbs/chevron.webp',                    defaultScale: 0.5,  category: 'geometric' },
  { name: 'Circles',              url: 'textures/circles.png',                    thumb: 'textures/thumbs/circles.webp',                    defaultScale: 0.35, category: 'geometric' },
  { name: 'Classic Flutes',       url: 'textures/flutes.png',                     thumb: 'textures/thumbs/flutes.webp',                     defaultScale: 0.35, category: 'geometric' },
  { name: 'Cobblestone',          url: 'textures/cobblestone.png',                thumb: 'textures/thumbs/cobblestone.webp',                defaultScale: 0.5,  category: 'natural' },
  { name: 'Concrete',             url: 'textures/concrete.png',                   thumb: 'textures/thumbs/concrete.webp',                   defaultScale: 0.75, category: 'mold' },
  { name: 'Connections',          url: 'textures/hero-connections.png',           thumb: 'textures/thumbs/hero-connections.webp',           defaultScale: 0.3,  category: 'patterns', credit: 'hero' },
  { name: 'Crystal',              url: 'textures/crystal.png',                    thumb: 'textures/thumbs/crystal.webp',                    defaultScale: 0.5,  category: 'organic', credit: 'ff' },
  { name: 'Cubes',                url: 'textures/cubes.png',                      thumb: 'textures/thumbs/cubes.webp',                      defaultScale: 0.5,  category: 'geometric' },
  { name: 'Current',              url: 'textures/hero-current.png',               thumb: 'textures/thumbs/hero-current.webp',               defaultScale: 0.6,  category: 'patterns', credit: 'hero' },
  { name: 'Curtain',              url: 'textures/hero-curtain.png',               thumb: 'textures/thumbs/hero-curtain.webp',               defaultScale: 0.4,  category: 'patterns', credit: 'hero' },
  { name: 'Death Star',           url: 'textures/hero-death-star.png',            thumb: 'textures/thumbs/hero-death-star.webp',            defaultScale: 1.0,  category: 'patterns', credit: 'hero' },
  { name: 'Dots',                 url: 'textures/dots.png',                       thumb: 'textures/thumbs/dots.webp',                       defaultScale: 0.1,  category: 'geometric' },
  { name: 'Endless Clouds',       url: 'textures/hero-endless-clouds.png',        thumb: 'textures/thumbs/hero-endless-clouds.webp',        defaultScale: 0.45, category: 'patterns', credit: 'hero' },
  { name: 'Eyes',                 url: 'textures/hero-eyes.png',                  thumb: 'textures/thumbs/hero-eyes.webp',                  defaultScale: 0.3,  category: 'patterns', credit: 'hero' },
  { name: 'Falling Triangles',    url: 'textures/hero-falling-triangles.png',     thumb: 'textures/thumbs/hero-falling-triangles.webp',     defaultScale: 0.55, category: 'geometric', credit: 'hero' },
  { name: 'Fine Leather',         url: 'textures/fineLeather.png',                thumb: 'textures/thumbs/fineLeather.webp',                defaultScale: 0.6,  category: 'mold' },
  { name: 'Fine Ribs',            url: 'textures/fineRibs.png',                   thumb: 'textures/thumbs/fineRibs.webp',                   defaultScale: 0.35, category: 'geometric' },
  { name: 'Fine Stipple',         url: 'textures/fineStipple.png',                thumb: 'textures/thumbs/fineStipple.webp',                defaultScale: 0.6,  category: 'mold' },
  { name: 'Fish Scales',          url: 'textures/fishScales.png',                 thumb: 'textures/thumbs/fishScales.webp',                 defaultScale: 0.4,  category: 'natural' },
  { name: 'Flagstone',            url: 'textures/flagstone.png',                  thumb: 'textures/thumbs/flagstone.webp',                  defaultScale: 0.75, category: 'natural' },
  { name: 'Flipped Diamonds',     url: 'textures/hero-flipped-diamonds.png',      thumb: 'textures/thumbs/hero-flipped-diamonds.webp',      defaultScale: 0.5,  category: 'geometric', credit: 'hero' },
  { name: 'Floating Cogs',        url: 'textures/hero-floating-cogs.png',         thumb: 'textures/thumbs/hero-floating-cogs.webp',         defaultScale: 1.0,  category: 'patterns', credit: 'hero' },
  { name: 'Formal Invitation',    url: 'textures/hero-formal-invitation.png',     thumb: 'textures/thumbs/hero-formal-invitation.webp',     defaultScale: 0.85, category: 'patterns', credit: 'hero' },
  { name: 'Four Point Stars',     url: 'textures/hero-four-point-stars.png',      thumb: 'textures/thumbs/hero-four-point-stars.webp',      defaultScale: 0.2,  category: 'geometric', credit: 'hero' },
  { name: 'Grid',                 url: 'textures/grid.png',                       thumb: 'textures/thumbs/grid.webp',                       defaultScale: 1.0,  category: 'geometric' },
  { name: 'Grip Surface',         url: 'textures/gripSurface.png',                thumb: 'textures/thumbs/gripSurface.webp',                defaultScale: 0.5,  category: 'grip' },
  { name: 'Groovy',               url: 'textures/hero-groovy.png',                thumb: 'textures/thumbs/hero-groovy.webp',                defaultScale: 0.6,  category: 'patterns', credit: 'hero' },
  { name: 'Haircell',             url: 'textures/haircell.png',                   thumb: 'textures/thumbs/haircell.webp',                   defaultScale: 0.6,  category: 'mold' },
  { name: 'Hammered',             url: 'textures/hammered.png',                   thumb: 'textures/thumbs/hammered.webp',                   defaultScale: 0.75, category: 'mold' },
  { name: 'Happy Intersection',   url: 'textures/hero-happy-intersection.png',    thumb: 'textures/thumbs/hero-happy-intersection.webp',    defaultScale: 0.7,  category: 'patterns', credit: 'hero' },
  { name: 'Hexagon',              url: 'textures/hexagon.png',                    thumb: 'textures/thumbs/hexagon.webp',                    defaultScale: 0.5,  category: 'geometric' },
  { name: 'Hexagon Outline',      url: 'textures/hero-hexagons.png',              thumb: 'textures/thumbs/hero-hexagons.webp',              defaultScale: 0.45, category: 'geometric', credit: 'hero' },
  { name: 'Hexagons',             url: 'textures/hexagons.png',                   thumb: 'textures/thumbs/hexagons.webp',                   defaultScale: 1.0,  category: 'geometric' },
  { name: 'Intersecting Circles', url: 'textures/hero-intersecting-circles.png',  thumb: 'textures/thumbs/hero-intersecting-circles.webp',  defaultScale: 0.25, category: 'geometric', credit: 'hero' },
  { name: 'Isogrid',              url: 'textures/isogrid.png',                    thumb: 'textures/thumbs/isogrid.webp',                    defaultScale: 0.5,  category: 'grip' },
  { name: 'Knitting',             url: 'textures/knitting.png',                   thumb: 'textures/thumbs/knitting.webp',                   defaultScale: 0.25, category: 'fabric' },
  { name: 'Knurling',             url: 'textures/knurling.png',                   thumb: 'textures/thumbs/knurling.webp',                   defaultScale: 0.15, category: 'grip' },
  { name: 'Labyrinth',            url: 'textures/labyrinth.png',                  thumb: 'textures/thumbs/labyrinth.webp',                  defaultScale: 0.75, category: 'organic' },
  { name: 'Leather 2',            url: 'textures/leather2.png',                   thumb: 'textures/thumbs/leather2.webp',                   defaultScale: 0.5,  category: 'natural', credit: 'ff' },
  { name: 'Leaves',               url: 'textures/leaves.png',                     thumb: 'textures/thumbs/leaves.webp',                     defaultScale: 0.5,  category: 'natural', credit: 'cc0', source: 'https://ambientcg.com/view?id=ScatteredLeaves007' },
  { name: 'Lips',                 url: 'textures/hero-lips.png',                  thumb: 'textures/thumbs/hero-lips.webp',                  defaultScale: 0.9,  category: 'patterns', credit: 'hero' },
  { name: 'Lisbon',               url: 'textures/hero-lisbon.png',                thumb: 'textures/thumbs/hero-lisbon.webp',                defaultScale: 0.6,  category: 'patterns', credit: 'hero' },
  { name: 'Melt',                 url: 'textures/hero-melt.png',                  thumb: 'textures/thumbs/hero-melt.webp',                  defaultScale: 0.2,  category: 'patterns', credit: 'hero' },
  { name: 'Noise',                url: 'textures/noise.png',                      thumb: 'textures/thumbs/noise.webp',                      defaultScale: 0.3,  category: 'organic' },
  { name: 'Pine Bark',            url: 'textures/pineBark.png',                   thumb: 'textures/thumbs/pineBark.webp',                   defaultScale: 0.75, category: 'natural', credit: 'cc0', source: 'https://polyhaven.com/a/pine_bark' },
  { name: 'Plain Weave',          url: 'textures/plainWeave.png',                 thumb: 'textures/thumbs/plainWeave.webp',                 defaultScale: 0.5,  category: 'fabric' },
  { name: 'Plus',                 url: 'textures/plus.png',                       thumb: 'textures/thumbs/plus.webp',                       defaultScale: 0.5,  category: 'geometric' },
  { name: 'Rain',                 url: 'textures/hero-rain.png',                  thumb: 'textures/thumbs/hero-rain.webp',                  defaultScale: 0.4,  category: 'geometric', credit: 'hero' },
  { name: 'Roof Tiles',           url: 'textures/roofTiles.png',                  thumb: 'textures/thumbs/roofTiles.webp',                  defaultScale: 0.5,  category: 'natural', credit: 'cc0', source: 'https://ambientcg.com/view?id=RoofingTiles002' },
  { name: 'Roof Tiles 2',         url: 'textures/roofTiles_02.png',               thumb: 'textures/thumbs/roofTiles_02.webp',               defaultScale: 0.75, category: 'natural', credit: 'cc0', source: 'https://ambientcg.com/view?id=RoofingTiles004' },
  { name: 'Sand Matte',           url: 'textures/sandMatte.png',                  thumb: 'textures/thumbs/sandMatte.webp',                  defaultScale: 0.75, category: 'mold' },
  { name: 'Sazanami Ripples',     url: 'textures/sazanami.png',                   thumb: 'textures/thumbs/sazanami.webp',                   defaultScale: 0.5,  category: 'organic' },
  { name: 'Sazanami S-Wave',      url: 'textures/sazanamiSWave.png',              thumb: 'textures/thumbs/sazanamiSWave.webp',              defaultScale: 1.0,  category: 'organic' },
  { name: 'Shingles',             url: 'textures/shingles.png',                   thumb: 'textures/thumbs/shingles.webp',                   defaultScale: 0.5,  category: 'natural', credit: 'cc0', source: 'https://ambientcg.com/view?id=RoofingTiles001' },
  { name: 'Signal',               url: 'textures/hero-signal.png',                thumb: 'textures/thumbs/hero-signal.webp',                defaultScale: 0.75, category: 'geometric', credit: 'hero' },
  { name: 'Spark Erosion',        url: 'textures/sparkErosion.png',               thumb: 'textures/thumbs/sparkErosion.webp',               defaultScale: 0.6,  category: 'mold' },
  { name: 'Speckle',              url: 'textures/hero-texture.png',               thumb: 'textures/thumbs/hero-texture.webp',               defaultScale: 0.1,  category: 'geometric', credit: 'hero' },
  { name: 'Square Setts',         url: 'textures/setts.png',                      thumb: 'textures/thumbs/setts.webp',                      defaultScale: 0.5,  category: 'natural' },
  { name: 'Straw',                url: 'textures/straw.png',                      thumb: 'textures/thumbs/straw.webp',                      defaultScale: 0.5,  category: 'natural', credit: 'cc0', source: 'https://polyhaven.com/a/thatch_roof_angled' },
  { name: 'Stripes 1',            url: 'textures/stripes.png',                    thumb: 'textures/thumbs/stripes.webp',                    defaultScale: 0.5,  category: 'geometric' },
  { name: 'Stripes 2',            url: 'textures/stripes_02.png',                 thumb: 'textures/thumbs/stripes_02.webp',                 defaultScale: 1.0,  category: 'geometric' },
  { name: 'Tachiwaki',            url: 'textures/tachiwaki.png',                  thumb: 'textures/thumbs/tachiwaki.webp',                  defaultScale: 0.4,  category: 'patterns' },
  { name: 'Tiles',                url: 'textures/tiles.png',                      thumb: 'textures/thumbs/tiles.webp',                      defaultScale: 0.5,  category: 'geometric' },
  { name: 'Tiny Checkers',        url: 'textures/hero-tiny-checkers.png',         thumb: 'textures/thumbs/hero-tiny-checkers.webp',         defaultScale: 0.1,  category: 'geometric', credit: 'hero' },
  { name: 'Twill',                url: 'textures/twill.png',                      thumb: 'textures/thumbs/twill.webp',                      defaultScale: 0.75, category: 'fabric', credit: 'cc0', source: 'https://ambientcg.com/view?id=Fabric004' },
  { name: 'Twill 2',              url: 'textures/twill_02.png',                   thumb: 'textures/thumbs/twill_02.webp',                   defaultScale: 1.0,  category: 'fabric', credit: 'cc0', source: 'https://ambientcg.com/view?id=Fabric015' },
  { name: 'Voronoi',              url: 'textures/voronoi.png',                    thumb: 'textures/thumbs/voronoi.webp',                    defaultScale: 0.5,  category: 'organic' },
  { name: 'Wavy Reeds',           url: 'textures/wavyReeds.png',                  thumb: 'textures/thumbs/wavyReeds.webp',                  defaultScale: 0.4,  category: 'geometric' },
  { name: 'Weave 1',              url: 'textures/weave.png',                      thumb: 'textures/thumbs/weave.webp',                      defaultScale: 0.5,  category: 'fabric' },
  { name: 'Weave 2',              url: 'textures/weave_02.png',                   thumb: 'textures/thumbs/weave_02.webp',                   defaultScale: 0.5,  category: 'fabric' },
  { name: 'Weave 3',              url: 'textures/weave_03.png',                   thumb: 'textures/thumbs/weave_03.webp',                   defaultScale: 0.5,  category: 'fabric', credit: 'ff' },
  { name: 'Wicker',               url: 'textures/wicker.png',                     thumb: 'textures/thumbs/wicker.webp',                     defaultScale: 1.0,  category: 'fabric', credit: 'cc0', source: 'https://ambientcg.com/view?id=Wicker001' },
  { name: 'Wicker 2',             url: 'textures/wicker_02.png',                  thumb: 'textures/thumbs/wicker_02.webp',                  defaultScale: 0.5,  category: 'fabric', credit: 'cc0', source: 'https://ambientcg.com/view?id=Wicker009A' },
  { name: 'Wood 1',               url: 'textures/wood.png',                       thumb: 'textures/thumbs/wood.webp',                       defaultScale: 0.5,  category: 'natural' },
  { name: 'Wood 2',               url: 'textures/woodgrain_02.jpg',               thumb: 'textures/thumbs/woodgrain_02.webp',               defaultScale: 1.0,  category: 'natural' },
  { name: 'Wood 3',               url: 'textures/woodgrain_03.png',               thumb: 'textures/thumbs/woodgrain_03.webp',               defaultScale: 1.0,  category: 'natural' },
  { name: 'YYY',                  url: 'textures/hero-yyy.png',                   thumb: 'textures/thumbs/hero-yyy.webp',                   defaultScale: 1.0,  category: 'patterns', credit: 'hero' },
];

// Gallery filter groups, in display order. Labels are i18n keys.
const PRESET_CATEGORIES = [
  { id: 'geometric', label: 'gallery.catGeometric' },
  { id: 'patterns',  label: 'gallery.catPatterns' },
  { id: 'organic',   label: 'gallery.catOrganic' },
  { id: 'fabric',    label: 'gallery.catFabric' },
  { id: 'natural',   label: 'gallery.catNatural' },
  { id: 'grip',      label: 'gallery.catGrip' },
  { id: 'mold',      label: 'gallery.catMold' },
];

// Default panel favourites (a 4×3 grid); users star their own in the gallery, and each extra 4
// favourites add another row.
const DEFAULT_FAVOURITES = [
  'Crystal',   'Knurling',     'Carbon Fiber', 'Hexagons',
  'Voronoi',   'Leather 2',    'Weave 1',      'Grip Surface',
  'Labyrinth', 'Square Setts', 'Brick',        'Wood 1',
];

// Cache for full-resolution preset data (keyed by index)
const _fullPresetCache = new Map();

/**
 * Load the full-resolution texture for a preset (on demand).
 * Returns the full entry: { name, fullCanvas, texture, imageData, width, height, defaultScale }.
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

export { IMAGE_PRESETS, PRESET_CATEGORIES, DEFAULT_FAVOURITES };


/**
 * ideaMaker .texture files are JSON with the heightmap as a base64 PNG in
 * `image_data` (white = raised, same as ours). Their repeat/rotation/offset
 * settings don't map onto our mm-based scale, so only the image is used.
 * The result is named after the embedded image (never *.texture), because
 * project export saves that name and re-imports the PNG under it.
 */
async function unwrapIdeaMakerTexture(file) {
  const json = JSON.parse(await file.text());
  if (typeof json?.image_data !== 'string') throw new Error('No image data in .texture file');
  const bytes = Uint8Array.from(atob(json.image_data), c => c.charCodeAt(0));
  const name  = (json.header?.texture_name || file.name).replace(/\.texture$/i, '.png');
  return new File([bytes], name);
}

/**
 * Build a THREE.CanvasTexture + ImageData from a user-uploaded image File
 * (or an ideaMaker .texture file).
 */
export async function loadCustomTexture(file) {
  if (/\.texture$/i.test(file.name)) file = await unwrapIdeaMakerTexture(file);
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      // Reject instead of throwing inside onload, which would leave the
      // promise pending forever (e.g. a sizeless SVG decodes as 0×0 in Firefox).
      try {
        if (!img.naturalWidth || !img.naturalHeight) throw new Error('Image has no size');
        const { w, h } = fitDimensions(img.width, img.height, CUSTOM_SIZE);
        const canvas = makeCanvas(w, h);
        const ctx    = canvas.getContext('2d');
        // The default 'low' quality is plain bilinear: on a big downscale
        // (8K → 2048) it skips most source pixels and aliases fine detail
        // into fake moiré and noise, especially on GPU canvases (#89).
        // Presets keep the default — they were QA'd against it.
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, w, h);
        const imageData = ctx.getImageData(0, 0, w, h);
        const texture   = new THREE.CanvasTexture(canvas);
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.name = file.name;
        resolve({ name: file.name, fullCanvas: canvas, texture, imageData, width: w, height: h });
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to load image')); };
    img.src = url;
  });
}
