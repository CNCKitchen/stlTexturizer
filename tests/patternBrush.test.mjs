/*
 * Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planPatternEntry, planPatternPick, patternStrokeTargets } from '../js/patternBrush.js';

const MAX = 4;
const layer = (mapName, includeOnly = true, extra = {}) => ({ mapName, customId: null, includeOnly, ...extra });

test('entry: a lone unpainted layer turns bare, so the brush reveals the pattern', () => {
  const plan = planPatternEntry({ layers: [layer('Crystal', false)], activeIdx: 0, activeHasPaint: false, maxLayers: MAX });
  assert.deepEqual(plan, { action: 'convert' });
});

test('entry: a painted pattern layer is continued', () => {
  const plan = planPatternEntry({ layers: [layer('Crystal')], activeIdx: 0, activeHasPaint: true, maxLayers: MAX });
  assert.deepEqual(plan, { action: 'keep' });
});

test('entry: a painted Exclude mask survives, the pattern gets a new layer', () => {
  const plan = planPatternEntry({ layers: [layer('Crystal', false)], activeIdx: 0, activeHasPaint: true, maxLayers: MAX });
  assert.deepEqual(plan, { action: 'addLayer' });
});

test('entry: a base layer under other layers keeps covering the model', () => {
  const layers = [layer('Crystal', false), layer('Knurl')];
  const plan = planPatternEntry({ layers, activeIdx: 0, activeHasPaint: false, maxLayers: MAX });
  assert.deepEqual(plan, { action: 'addLayer' });
});

test('entry: without room it continues on the topmost pattern layer', () => {
  const layers = [layer('A', false), layer('B'), layer('C'), layer('D', false)];
  const plan = planPatternEntry({ layers, activeIdx: 3, activeHasPaint: false, maxLayers: MAX });
  assert.deepEqual(plan, { action: 'activate', idx: 2 });
});

test('entry: without room and without a pattern layer it gives up', () => {
  const layers = [layer('A', false), layer('B', false), layer('C', false), layer('D', false)];
  const plan = planPatternEntry({ layers, activeIdx: 0, activeHasPaint: true, maxLayers: MAX });
  assert.deepEqual(plan, { action: 'full' });
});

test('pick: the texture already on the brush changes nothing', () => {
  const plan = planPatternPick({ layers: [layer('Crystal')], activeIdx: 0, activeHasPaint: true, key: { name: 'Crystal' }, maxLayers: MAX });
  assert.deepEqual(plan, { action: 'keep' });
});

test('pick: a new texture never repaints what is on the model', () => {
  const plan = planPatternPick({ layers: [layer('Crystal')], activeIdx: 0, activeHasPaint: true, key: { name: 'Knurl' }, maxLayers: MAX });
  assert.deepEqual(plan, { action: 'addLayer' });
});

test('pick: before the first stroke the texture is simply swapped', () => {
  const plan = planPatternPick({ layers: [layer('Crystal')], activeIdx: 0, activeHasPaint: false, key: { name: 'Knurl' }, maxLayers: MAX });
  assert.deepEqual(plan, { action: 'replace' });
});

test('pick: a texture used by another pattern layer goes back to that layer', () => {
  const layers = [layer('Crystal'), layer('Knurl')];
  const plan = planPatternPick({ layers, activeIdx: 1, activeHasPaint: true, key: { name: 'Crystal' }, maxLayers: MAX });
  assert.deepEqual(plan, { action: 'activate', idx: 0 });
});

test('pick: an Exclude base layer with that texture is not painted on', () => {
  const layers = [layer('Crystal', false), layer('Knurl')];
  const plan = planPatternPick({ layers, activeIdx: 1, activeHasPaint: true, key: { name: 'Crystal' }, maxLayers: MAX });
  assert.deepEqual(plan, { action: 'addLayer' });
});

test('pick: a full stack refuses instead of replacing a painted pattern', () => {
  const layers = [layer('A'), layer('B'), layer('C'), layer('D')];
  const plan = planPatternPick({ layers, activeIdx: 3, activeHasPaint: true, key: { name: 'E' }, maxLayers: MAX });
  assert.deepEqual(plan, { action: 'full' });
});

test('pick: stored textures match by id, a preset of the same name is another map', () => {
  const layers = [layer('Logo', true, { customId: 'a1' })];
  const same = planPatternPick({ layers, activeIdx: 0, activeHasPaint: true, key: { customId: 'a1' }, maxLayers: MAX });
  const preset = planPatternPick({ layers, activeIdx: 0, activeHasPaint: true, key: { name: 'Logo' }, maxLayers: MAX });
  assert.equal(same.action, 'keep');
  assert.equal(preset.action, 'addLayer');
});

test('pick: a new upload always counts as a new pattern', () => {
  const plan = planPatternPick({ layers: [layer('Crystal')], activeIdx: 0, activeHasPaint: true, key: null, maxLayers: MAX });
  assert.deepEqual(plan, { action: 'addLayer' });
});

const strokeLayer = (slot, opts = {}) => ({ slot, includeOnly: true, visible: true, blendAdd: false, ...opts });

test('stroke: paint clears covering patterns above, the ones below stay', () => {
  const layers = [strokeLayer(0), strokeLayer(1), strokeLayer(2)];
  assert.deepEqual(patternStrokeTargets({ layers, activeIdx: 1, erase: false }), [
    { slot: 1, erase: false },
    { slot: 2, erase: true },
  ]);
});

test('stroke: a layer that adds its relief above does not hide the paint', () => {
  const layers = [strokeLayer(0), strokeLayer(1, { blendAdd: true })];
  assert.deepEqual(patternStrokeTargets({ layers, activeIdx: 0, erase: false }), [{ slot: 0, erase: false }]);
});

test('stroke: the eraser takes off every visible pattern', () => {
  const layers = [strokeLayer(0), strokeLayer(1, { visible: false }), strokeLayer(2)];
  assert.deepEqual(patternStrokeTargets({ layers, activeIdx: 2, erase: true }), [
    { slot: 0, erase: true },
    { slot: 2, erase: true },
  ]);
});

test('stroke: Exclude layers are never touched, their paint means the opposite', () => {
  const layers = [strokeLayer(0, { includeOnly: false }), strokeLayer(1), strokeLayer(2, { includeOnly: false })];
  assert.deepEqual(patternStrokeTargets({ layers, activeIdx: 1, erase: true }), [{ slot: 1, erase: true }]);
  assert.deepEqual(patternStrokeTargets({ layers, activeIdx: 1, erase: false }), [{ slot: 1, erase: false }]);
});

test('stroke: a hidden active layer still takes the paint', () => {
  const layers = [strokeLayer(0, { visible: false })];
  assert.deepEqual(patternStrokeTargets({ layers, activeIdx: 0, erase: false }), [{ slot: 0, erase: false }]);
});
