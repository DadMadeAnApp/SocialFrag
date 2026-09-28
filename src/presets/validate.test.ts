import { describe, expect, test } from 'vitest';
import wardogs from '../test/fixtures/preset-fixture.json';
import builtinWardogs from './builtin/wardogs.json';
import { validatePreset } from './validate';
import { blankPreset } from './presets';

const clone = () => structuredClone(wardogs) as any;

describe('validatePreset', () => {
  test('accepts the fixture preset', () => {
    const r = validatePreset(wardogs);
    expect(r.ok).toBe(true);
  });

  test('accepts the built-in WARDOGS preset', () => {
    expect(validatePreset(builtinWardogs).ok).toBe(true);
  });

  test('ignores unknown fields', () => {
    const p = clone();
    p.futureThing = 42;
    p.layers[0].sparkles = true;
    const r = validatePreset(p);
    expect(r.ok && 'futureThing' in r.preset).toBe(false);
    expect(r.ok && 'sparkles' in r.preset.layers[0]).toBe(false);
  });

  test('defaults label to id and fit to cover', () => {
    const p = clone();
    delete p.layers[0].label;
    delete p.layers[0].fit;
    const r = validatePreset(p);
    expect(r.ok && r.preset.layers[0].label).toBe('gameplay');
    expect(r.ok && r.preset.layers[0].fit).toBe('cover');
  });

  test.each([
    ['src outside frame', (p: any) => { p.layers[0].src = [0.8, 0, 0.3, 1]; }, 'src outside frame'],
    ['dst outside canvas', (p: any) => { p.layers[0].dst = [0, 1800, 1080, 200]; }, 'dst outside canvas'],
    ['NaN in src', (p: any) => { p.layers[0].src = [NaN, 0, 0.5, 1]; }, 'src must be 4 numbers'],
    ['bad border color', (p: any) => { p.layers[1].border.color = 'white'; }, 'border needs'],
    ['bad background color', (p: any) => { p.background = { type: 'color', color: 'red' }; }, '#RRGGBB'],
    ['version 2', (p: any) => { p.version = 2; }, 'unsupported preset version'],
    ['no layers', (p: any) => { p.layers = []; }, 'at least one layer'],
    ['duplicate layer ids', (p: any) => { p.layers[1].id = 'gameplay'; }, 'duplicate layer id'],
  ])('rejects %s', (_name, mutate, message) => {
    const p = clone();
    mutate(p);
    const r = validatePreset(p);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain(message);
  });

  test('keeps hidden: true on a layer', () => {
    const p = clone();
    p.layers[1].hidden = true;
    const r = validatePreset(p);
    expect(r.ok && r.preset.layers[1].hidden).toBe(true);
  });

  test('drops hidden when false and omits a non-boolean hidden', () => {
    const p = clone();
    p.layers[1].hidden = false;
    const r = validatePreset(p);
    expect(r.ok && 'hidden' in r.preset.layers[1]).toBe(false);

    const p2 = clone();
    p2.layers[1].hidden = 'yes';
    const r2 = validatePreset(p2);
    expect(r2.ok).toBe(false);
    expect(!r2.ok && r2.error).toContain('hidden');
  });

  test('rejects a preset with no visible layers', () => {
    const p = clone();
    p.layers[0].hidden = true;
    p.layers[1].hidden = true;
    const r = validatePreset(p);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('at least one visible layer');
  });

  const withAudio = (audio: unknown) => ({ ...blankPreset('p'), audio });
  const goodAudio = {
    tracks: [{ label: 'Game', enabled: true, gain: 1.2, ceilingDb: -3, offsetS: 0.05 }],
    duck: { targets: ['Game'], triggers: ['Discord', 'Mic'], amountDb: -10, thresholdDb: -40, releaseS: 0.4 },
  };

  test('accepts and keeps a valid audio section', () => {
    const r = validatePreset(withAudio(goodAudio));
    expect(r.ok && r.preset.audio).toEqual(goodAudio);
  });

  test('missing ceilingDb key defaults to null', () => {
    const audioNoCeiling = {
      tracks: [{ label: 'Game', enabled: true, gain: 1.2, offsetS: 0.05 }],
      duck: null,
    };
    const r = validatePreset(withAudio(audioNoCeiling));
    expect(r.ok && r.preset.audio?.tracks[0].ceilingDb).toBe(null);
  });

  test('preset without audio stays without audio', () => {
    const r = validatePreset(blankPreset('p'));
    expect(r.ok && 'audio' in r.preset).toBe(false);
  });

  test.each([
    [{ tracks: [{ ...goodAudio.tracks[0], gain: 2.5 }], duck: null }, 'gain'],
    [{ tracks: [{ ...goodAudio.tracks[0], ceilingDb: -30 }], duck: null }, 'ceiling'],
    [{ tracks: [{ ...goodAudio.tracks[0], offsetS: Number.NaN }], duck: null }, 'offset'],
    [{ tracks: [{ ...goodAudio.tracks[0], label: '' }], duck: null }, 'label'],
    [{ tracks: [], duck: { ...goodAudio.duck, releaseS: 0 } }, 'release'],
    [{ tracks: [], duck: { ...goodAudio.duck, triggers: [3] } }, 'trigger'],
    [{ tracks: 'x', duck: null }, 'tracks'],
  ])('rejects bad audio %#', (audio, word) => {
    const r = validatePreset(withAudio(audio));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain(word);
  });
});
