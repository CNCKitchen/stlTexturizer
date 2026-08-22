/**
 * Grayscale-to-color 3MF painting helpers.
 *
 * Each color stop is a (value, color) pair where value is a percentage (0–100)
 * of the displacement texture's grayscale value (0% = black, 100% = white).
 * Stops sorted ascending by value partition [0, 100] into half-open ranges;
 * the base color owns everything below the lowest stop. Classification is
 * per-triangle (average of its 3 vertex grey values) — triangles are not
 * split at color boundaries, so boundary resolution is limited to existing
 * mesh triangle density.
 */

// OrcaSlicer's (and thus Snapmaker Orca's) EnforcerBlockerType only defines
// extruders up to 16; that's the tightest ceiling across Prusa/Bambu/Orca, so
// it's the one we enforce. materialIndex 0 is the base (extruder 1, no
// override), so at most 15 color stops (extruders 2-16) are addressable.
const MAX_MATERIAL_INDEX = 15;

export function getMulticolorConfig(settings) {
  const rawStops = Array.isArray(settings.multicolorStops) ? settings.multicolorStops : [];
  const stops = rawStops.slice().sort((a, b) => a.value - b.value);
  const baseColor = settings.multicolorBaseColor || '#b8bec8';
  const enabled = !!settings.multicolorEnabled;
  return {
    enabled,
    baseColor,
    stops,
    active: enabled && stops.length > 0,
  };
}

export function resolveMaterialsList(cfg) {
  return [
    { name: 'Base', color: cfg.baseColor },
    ...cfg.stops.map((s, i) => ({ name: `Color ${i + 1}`, color: s.color })),
  ];
}

/**
 * Classify a triangle-average grey value (0–1, or the −1 exclusion sentinel)
 * into a material index. 0 = base; i = 1-based index into cfg.stops.
 */
export function classifyHeight(avgHeight, cfg) {
  let materialIndex = 0;
  for (let i = 0; i < cfg.stops.length; i++) {
    if (avgHeight >= cfg.stops[i].value / 100) materialIndex = i + 1;
    else break;
  }
  return materialIndex;
}

/**
 * Build per-triangle material indices for the final displaced geometry.
 * Geometry is passed through unchanged — only materialIndices is new.
 */
export function buildMulticolorPaintedGeometry(geometry, settings) {
  const cfg = getMulticolorConfig(settings);
  if (!cfg.active) return null;

  if (cfg.stops.length > MAX_MATERIAL_INDEX) {
    throw new Error(`Multicolor export supports at most ${MAX_MATERIAL_INDEX} colors plus base (${cfg.stops.length} configured).`);
  }

  const heightAttr = geometry.attributes.displacementHeight;
  if (!heightAttr) {
    throw new Error('Multicolor export metadata is missing from the mesh.');
  }

  const height = heightAttr.array;
  const triCount = height.length / 3;
  const materialIndices = new Uint8Array(triCount);

  for (let t = 0; t < triCount; t++) {
    const b = t * 3;
    const avg = (height[b] + height[b + 1] + height[b + 2]) / 3;
    materialIndices[t] = classifyHeight(avg, cfg);
  }

  return {
    geometry,
    materialIndices,
    materials: resolveMaterialsList(cfg),
  };
}
