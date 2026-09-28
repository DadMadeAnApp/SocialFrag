import { expect, test } from 'vitest';
import { blankPreset } from '../presets/presets';
import type { AudioTrackInfo, Preset } from '../types';
import { PRESET_MIX_NOTICE, mergePresetAudio, mixToPresetAudio, resolveMix } from './resolveMix';

const obs: AudioTrackInfo[] = ['Desktop Audio', 'Game', 'Discord', 'Mic'].map((label, index) => ({ index, label, named: true, channels: 2 }));
const unnamed: AudioTrackInfo[] = [0, 1].map((index) => ({ index, label: `Track ${index + 1}`, named: false, channels: 2 }));
const plain = blankPreset('p');
const withMix: Preset = {
  ...plain,
  audio: {
    tracks: [
      { label: 'game', enabled: true, gain: 1.2, ceilingDb: -3, offsetS: 0.1 },
      { label: 'Desktop Audio', enabled: true, gain: 0.5, ceilingDb: null, offsetS: 0 },
      { label: 'Not In Clip', enabled: false, gain: 0, ceilingDb: null, offsetS: 0 },
    ],
    duck: { targets: ['Game'], triggers: ['Discord', 'Mic', 'Nope'], amountDb: -10, thresholdDb: -40, releaseS: 0.4 },
  },
};

test('rule B: desktop audio off when other labelled tracks exist', () => {
  const { mix, notice } = resolveMix(obs, plain);
  expect(mix.tracks.map((t) => t.enabled)).toEqual([false, true, true, true]);
  expect(mix.tracks.every((t) => t.gain === 1 && t.ceilingDb === null && t.offsetS === 0)).toBe(true);
  expect(mix.duck).toBeNull();
  expect(notice).toBeNull();
});

test('rule B keeps desktop audio when it is the only named track', () => {
  const only = [{ index: 0, label: 'Desktop Audio', named: true, channels: 2 }, { index: 1, label: 'Track 2', named: false, channels: 2 }];
  expect(resolveMix(only, plain).mix.tracks[0].enabled).toBe(true);
});

test('rule A: unnamed tracks are all on', () => {
  const { mix, notice } = resolveMix(unnamed, withMix);
  expect(mix.tracks.map((t) => t.enabled)).toEqual([true, true]);
  expect(notice).toBeNull();
});

test('rule D: preset mix applies by label, case-insensitive; unmatched tracks use rule B', () => {
  const { mix } = resolveMix(obs, withMix);
  const [desktop, game, discord, mic] = mix.tracks;
  expect(game).toMatchObject({ enabled: true, gain: 1.2, ceilingDb: -3, offsetS: 0.1 });
  expect(desktop).toMatchObject({ enabled: true, gain: 0.5 });
  expect(discord).toMatchObject({ enabled: true, gain: 1 });
  expect(mic.enabled).toBe(true);
  expect(mix.duck).toEqual({ targets: [1], triggers: [2, 3], amountDb: -10, thresholdDb: -40, releaseS: 0.4 });
});

test('duck is dropped when no target or trigger matches', () => {
  const p: Preset = { ...withMix, audio: { tracks: [], duck: { targets: ['X'], triggers: ['Mic'], amountDb: -10, thresholdDb: -40, releaseS: 0.4 } } };
  expect(resolveMix(obs, p).mix.duck).toBeNull();
});

test('keeps per-clip edits when re-resolving', () => {
  const first = resolveMix(obs, plain).mix;
  first.tracks[2] = { ...first.tracks[2], label: 'Squad', fadeInS: 1, fadeOutS: 2, mutes: [{ startS: 1, endS: 2 }] };
  const again = resolveMix(obs, withMix, first).mix.tracks[2];
  expect(again).toMatchObject({ label: 'Squad', sourceLabel: 'Discord', fadeInS: 1, fadeOutS: 2, mutes: [{ startS: 1, endS: 2 }] });
});

test('rule A with notice when the preset mix cannot be applied', () => {
  const broken = { ...withMix, audio: { tracks: null, duck: null } } as unknown as Preset;
  const { mix, notice } = resolveMix(obs, broken);
  expect(mix.tracks.every((t) => t.enabled && t.gain === 1)).toBe(true);
  expect(notice).toBe(PRESET_MIX_NOTICE);
});

test('mergePresetAudio keeps entries for labels outside this clip and replaces this clip\'s tracks and duck', () => {
  const { mix } = resolveMix(obs, withMix);
  const merged = mergePresetAudio(withMix.audio, mix);
  expect(merged.tracks.find((t) => t.label === 'Not In Clip')).toEqual({ label: 'Not In Clip', enabled: false, gain: 0, ceilingDb: null, offsetS: 0 });
  expect(merged.tracks.find((t) => t.label === 'Desktop Audio')).toMatchObject({ gain: 0.5 });
  expect(merged.tracks.filter((t) => t.label.toLowerCase() === 'game')).toHaveLength(1);
  expect(merged.duck).toEqual(mixToPresetAudio(mix).duck);
});

test('mergePresetAudio with no existing audio just uses the clip mix', () => {
  const { mix } = resolveMix(obs, plain);
  expect(mergePresetAudio(undefined, mix)).toEqual(mixToPresetAudio(mix));
});

test('mixToPresetAudio saves per-setup settings by source label only', () => {
  const { mix } = resolveMix(obs, withMix);
  mix.tracks[1] = { ...mix.tracks[1], label: 'Renamed', mutes: [{ startS: 0, endS: 1 }], fadeInS: 3 };
  const a = mixToPresetAudio(mix);
  expect(a.tracks[1]).toEqual({ label: 'Game', enabled: true, gain: 1.2, ceilingDb: -3, offsetS: 0.1 });
  expect(a.duck).toEqual({ targets: ['Game'], triggers: ['Discord', 'Mic'], amountDb: -10, thresholdDb: -40, releaseS: 0.4 });
});
