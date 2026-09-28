import { expect, test } from 'vitest';
import { addMute, enabledDuckTriggers, removeMute, resizeMute, updateTrack } from './lanes';
import type { AudioMix, TrackMix } from '../types';

const track = (index: number, enabled: boolean): TrackMix => ({ index, sourceLabel: `${index}`, label: `${index}`, enabled, gain: 1, ceilingDb: null, offsetS: 0, fadeInS: 0, fadeOutS: 0, mutes: [] });

test('addMute orders the drag, merges and ignores tiny drags', () => {
  expect(addMute([{ startS: 1, endS: 2 }], 3, 1.5, 10)).toEqual([{ startS: 1, endS: 3 }]);
  expect(addMute([], 4, 4.01, 10)).toEqual([]);
});

test('resizeMute moves one edge and keeps a minimum length', () => {
  expect(resizeMute([{ startS: 1, endS: 3 }], 0, 'end', 5, 10)).toEqual({ mutes: [{ startS: 1, endS: 5 }], i: 0 });
  expect(resizeMute([{ startS: 1, endS: 3 }], 0, 'start', 2.99, 10)).toEqual({ mutes: [{ startS: 2.95, endS: 3 }], i: 0 });
});

test('resizeMute after a merge returns the index of the range containing the dragged edge, and does not throw on a second drag', () => {
  const first = resizeMute([{ startS: 1, endS: 2 }, { startS: 3, endS: 4 }], 1, 'start', 1.5, 10);
  expect(first.mutes).toEqual([{ startS: 1, endS: 4 }]);
  expect(first.i).toBe(0);
  // simulate AudioLanes continuing the drag with the corrected index
  expect(() => resizeMute(first.mutes, first.i, 'start', 1.2, 10)).not.toThrow();
  const second = resizeMute(first.mutes, first.i, 'start', 1.2, 10);
  expect(second.mutes).toEqual([{ startS: 1.2, endS: 4 }]);
  expect(second.i).toBe(0);
});

test('resizeMute returns i: -1 when the dragged range no longer exists', () => {
  expect(resizeMute([], 0, 'start', 1, 10).i).toBe(-1);
});

test('enabledDuckTriggers drops triggers for removed tracks', () => {
  const mix: AudioMix = { tracks: [track(0, true), track(1, false), track(2, true)], duck: { targets: [0], triggers: [1, 2], amountDb: -10, thresholdDb: -40, releaseS: 0.4 } };
  expect(enabledDuckTriggers(mix)).toEqual([2]);
  expect(enabledDuckTriggers({ tracks: mix.tracks, duck: null })).toEqual([]);
});

test('removeMute and updateTrack', () => {
  expect(removeMute([{ startS: 1, endS: 2 }, { startS: 3, endS: 4 }], 0)).toEqual([{ startS: 3, endS: 4 }]);
  const mix = { tracks: [{ index: 0, sourceLabel: 'G', label: 'G', enabled: true, gain: 1, ceilingDb: null, offsetS: 0, fadeInS: 0, fadeOutS: 0, mutes: [] }], duck: null };
  expect(updateTrack(mix, 0, { gain: 0.5 }).tracks[0].gain).toBe(0.5);
  expect(mix.tracks[0].gain).toBe(1);
});
