/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * patternBrush.js — the decisions behind "Paint pattern", the mode in which
 * the brush lays the selected texture onto the model.
 *
 * It adds no new paint data: a painted pattern is an Include Only texture
 * layer, so preview, undo, projects and export work on it as on any layer.
 * What the mode changes is what a brush user expects from it:
 *
 *  - picking another texture loads the brush instead of swapping what is
 *    already painted, so each pattern gets a layer of its own;
 *  - paint replaces whatever pattern was on that spot, even one on a layer
 *    above the active one;
 *  - the eraser takes off every pattern, not just the active layer's.
 *
 * Pure functions, no THREE, no DOM: main.js applies the plans.
 */

/** True when a layer record uses the map `key` ({ name } or { customId }; null = a new upload). */
function usesMap(layer, key) {
  if (!key) return false;
  if (key.customId != null) return layer.customId === key.customId;
  return layer.customId == null && layer.mapName === key.name;
}

/**
 * How to start painting without losing anything already on the model.
 *
 * @param {object} o
 *   layers        layer records (includeOnly current for the active one too)
 *   activeIdx     index of the active layer
 *   activeHasPaint  the active layer has paint
 *   maxLayers     layer limit
 * @returns {{ action: 'keep' | 'convert' | 'addLayer' | 'activate' | 'full', idx?: number }}
 *   keep      the active layer already is a painted pattern
 *   convert   a lone, unpainted layer textures the whole model: make it Include
 *             Only, so the model starts bare and the brush reveals the pattern
 *   addLayer  the existing layers stay as they are, paint on a new one
 *   activate  no room for a layer: continue on the Include Only layer `idx`
 *   full      no room and no layer that could take the paint
 */
export function planPatternEntry({ layers, activeIdx, activeHasPaint, maxLayers }) {
  if (layers[activeIdx].includeOnly) return { action: 'keep' };
  if (layers.length === 1 && !activeHasPaint) return { action: 'convert' };
  if (layers.length < maxLayers) return { action: 'addLayer' };
  for (let i = layers.length - 1; i >= 0; i--) {
    if (layers[i].includeOnly) return { action: 'activate', idx: i };
  }
  return { action: 'full' };
}

/**
 * What picking a texture does while the brush is out.
 *
 * @param {object} o
 *   layers, activeIdx, activeHasPaint, maxLayers   see planPatternEntry
 *   key   the picked map: { name } or { customId }; null = a new upload
 * @returns {{ action: 'keep' | 'activate' | 'replace' | 'addLayer' | 'full', idx?: number }}
 *   keep      the brush already holds this pattern
 *   activate  another layer holds it: continue on layer `idx`
 *   replace   nothing painted with the current pattern: just swap it
 *   addLayer  keep the painted pattern, the new one gets its own layer
 *   full      every layer is taken
 */
export function planPatternPick({ layers, activeIdx, activeHasPaint, key, maxLayers }) {
  if (usesMap(layers[activeIdx], key)) return { action: 'keep' };
  const idx = layers.findIndex(L => L.includeOnly && usesMap(L, key));
  if (idx >= 0) return { action: 'activate', idx };
  if (!activeHasPaint) return { action: 'replace' };
  if (layers.length < maxLayers) return { action: 'addLayer' };
  return { action: 'full' };
}

/**
 * The layers one brush dab changes.
 *
 * Exclude-mode layers are left out: their paint means the opposite, so a dab
 * on them would add texture where the brush wants it gone. Hidden layers are
 * left out as well, nothing should change where the user cannot see it.
 *
 * @param {object} o
 *   layers     per layer: { slot, includeOnly, visible, blendAdd }
 *   activeIdx  index of the active layer
 *   erase      the brush is erasing
 * @returns {Array<{ slot: number, erase: boolean }>}
 */
export function patternStrokeTargets({ layers, activeIdx, erase }) {
  const targets = [];
  layers.forEach((L, i) => {
    const isActive = i === activeIdx;
    if (!L.includeOnly || (!L.visible && !isActive)) return;
    if (erase) targets.push({ slot: L.slot, erase: true });
    else if (isActive) targets.push({ slot: L.slot, erase: false });
    // A covering layer above would hide the new paint; an adding one doesn't.
    else if (i > activeIdx && !L.blendAdd) targets.push({ slot: L.slot, erase: true });
  });
  return targets;
}
