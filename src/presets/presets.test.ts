import { expect, test } from 'vitest';
import wardogs from '../test/fixtures/preset-fixture.json';
import { LANDSCAPE_1440_CANVAS, LANDSCAPE_CANVAS, VERTICAL_CANVAS, formatOf } from '../types';
import { BUILTIN_PRESETS, blankPreset, duplicatePreset, loadUserPresets, presetFileName, fullFramePreset } from './presets';

test('BUILTIN_PRESETS contains WARDOGS, marked builtin', () => {
  expect(BUILTIN_PRESETS.map((p) => p.id)).toEqual(['builtin-wardogs-default']);
  expect(BUILTIN_PRESETS[0].builtin).toBe(true);
});

test('loadUserPresets keeps valid files, warns on bad ones, forces builtin=false', () => {
  const good = { ...wardogs, id: 'u1', builtin: true };
  const { presets, warnings } = loadUserPresets([
    { file: 'u1.json', contents: JSON.stringify(good) },
    { file: 'broken.json', contents: '{not json' },
    { file: 'bad.json', contents: JSON.stringify({ ...wardogs, id: 'u2', layers: [] }) },
    { file: 'dupe.json', contents: JSON.stringify(good) },
  ]);
  expect(presets.map((p) => p.id)).toEqual(['u1']);
  expect(presets[0].builtin).toBe(false);
  expect(warnings).toEqual([
    'broken.json: not valid JSON',
    'bad.json: preset needs at least one layer',
    'dupe.json: duplicate preset id u1',
  ]);
});

test('duplicatePreset copies deeply with a new id', () => {
  const copy = duplicatePreset(BUILTIN_PRESETS[0], 'c1');
  expect(copy.id).toBe('c1');
  expect(copy.builtin).toBe(false);
  expect(copy.name).toBe('WARDOGS – Default (copy)');
  expect(copy.layers[0].dst[0]).toBe(BUILTIN_PRESETS[0].layers[0].dst[0]);
  const before = BUILTIN_PRESETS[0].layers[0].dst[0];
  copy.layers[0].dst[0] = 99;
  expect(BUILTIN_PRESETS[0].layers[0].dst[0]).toBe(before);
});

test('blankPreset is a valid single-layer preset', () => {
  expect(blankPreset('b1').layers).toHaveLength(1);
});

test('presetFileName strips unsafe characters', () => {
  expect(presetFileName({ ...blankPreset('x'), name: 'My: "Cool"/Preset' })).toBe('My-CoolPreset.json');
});

test('fullFramePreset fits the whole frame on black at the given canvas', () => {
  const p = fullFramePreset(LANDSCAPE_1440_CANVAS);
  expect(p.background).toEqual({ type: 'none' });
  expect(p.layers).toEqual([{ id: 'gameplay', label: 'Gameplay', src: [0, 0, 1, 1], dst: [0, 0, 2560, 1440], fit: 'contain' }]);
  expect(p.builtin).toBe(true);
});

test('formatOf', () => {
  expect(formatOf(VERTICAL_CANVAS)).toBe('vertical');
  expect(formatOf(LANDSCAPE_CANVAS)).toBe('landscape');
  expect(formatOf(LANDSCAPE_1440_CANVAS)).toBe('landscape');
});
