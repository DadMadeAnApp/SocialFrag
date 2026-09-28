import { expect, test } from 'vitest';
import type { TrackMix } from '../types';
import { computeClipCurves, makeCurveCache, resampleCurve } from './curves';
import type { TimelineClip } from './model';

const track = (o: Partial<TrackMix> = {}): TrackMix => ({ index: 0, sourceLabel: 'G', label: 'G', enabled: true, gain: 1, ceilingDb: null, offsetS: 0, fadeInS: 0, fadeOutS: 0, mutes: [], ...o });
const clip = (o: Partial<TimelineClip> = {}): TimelineClip => ({
  id: 'c', kind: 'video', mediaId: 'm', inS: 2, outS: 6, speed: 1, presetId: 'p', layers: [], mix: { tracks: [track()], duck: null }, captions: [], captionStyles: {}, ...o,
});

test('resampleCurve maps timeline samples onto source samples', () => {
  const c = Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7]);
  expect([...resampleCurve(c, 2)]).toEqual([0, 2, 4, 6]);
  expect([...resampleCurve(c, 0.5)]).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7]);
  expect(resampleCurve(c, 1)).toBe(c);
});

test('source curves cover the trim; timeline curves are shortened by speed', () => {
  const { source, timeline } = computeClipCurves(clip({ speed: 2, mix: { tracks: [track({ fadeInS: 1 })], duck: null } }), 20, null);
  expect(source.get(0)!.length).toBe(800);
  expect(source.get(0)![0]).toBe(0);
  expect(source.get(0)![200]).toBeCloseTo(1);
  expect(timeline.get(0)!.length).toBe(400);
});

test('a disabled track gets a silent curve', () => {
  const { source } = computeClipCurves(clip({ mix: { tracks: [track({ enabled: false })], duck: null } }), 20, null);
  expect(source.get(0)!.every((v) => v === 0)).toBe(true);
});

test('the cache returns the same curves for the same clip object and envelopes', () => {
  const get = makeCurveCache();
  const c = clip();
  const env = new Map<number, Float32Array>();
  expect(get(c, 20, env)).toBe(get(c, 20, env));
  expect(get(c, 20, new Map())).not.toBe(get(c, 20, env));
  expect(get({ ...c }, 20, env)).not.toBe(get(c, 20, env));
});
