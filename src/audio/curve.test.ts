import { describe, expect, test } from 'vitest';
import type { TrackMix } from '../types';
import { SAMPLE_RATE, buildCurve, curveLength, encodeCurve, mergeMutes, mixCurves, sliceCurve } from './curve';

const track = (over: Partial<TrackMix> = {}): TrackMix => ({
  index: 0, sourceLabel: 'Game', label: 'Game', enabled: true, gain: 1, ceilingDb: null, offsetS: 0, fadeInS: 0, fadeOutS: 0, mutes: [], ...over,
});
const at = (c: Float32Array, t: number) => c[Math.round(t * SAMPLE_RATE)];
const trim = { inS: 0, outS: 10 };

describe('buildCurve', () => {
  test('covers the whole clip at 200 Hz with the track gain', () => {
    const c = buildCurve(track({ gain: 1.5 }), trim, 10);
    expect(c.length).toBe(2000);
    expect(at(c, 3)).toBeCloseTo(1.5);
  });

  test('disabled track is silent', () => {
    expect(buildCurve(track({ enabled: false }), trim, 10).every((v) => v === 0)).toBe(true);
  });

  test('mute range is silent with 30 ms ramps outside it', () => {
    const c = buildCurve(track({ mutes: [{ startS: 4, endS: 6 }] }), trim, 10);
    expect(at(c, 5)).toBe(0);
    expect(at(c, 4)).toBe(0);
    expect(at(c, 3.985)).toBeCloseTo(0.5, 1);
    expect(at(c, 3.9)).toBe(1);
    expect(at(c, 6.015)).toBeCloseTo(0.5, 1);
    expect(at(c, 6.1)).toBe(1);
  });

  test('fades follow trim and clamp when longer than the trim', () => {
    const c = buildCurve(track({ fadeInS: 2, fadeOutS: 2 }), { inS: 3, outS: 8 }, 10);
    expect(at(c, 3)).toBe(0);
    expect(at(c, 4)).toBeCloseTo(0.5);
    expect(at(c, 5.5)).toBe(1);
    expect(at(c, 7)).toBeCloseTo(0.5);
    const short = buildCurve(track({ fadeInS: 5, fadeOutS: 5 }), { inS: 0, outS: 1 }, 10);
    expect(Array.from(short).every(Number.isFinite)).toBe(true);
    expect(Math.max(...short.subarray(0, 200))).toBeLessThanOrEqual(1);
  });

  test('duck multiplies in', () => {
    const duck = new Float32Array(2000).fill(0.5);
    expect(at(buildCurve(track(), trim, 10, duck), 2)).toBeCloseTo(0.5);
  });
});

test('mergeMutes clamps, sorts, merges overlaps and drops empty ranges', () => {
  expect(mergeMutes([{ startS: 8, endS: 12 }, { startS: 1, endS: 3 }, { startS: 2, endS: 4 }, { startS: 5, endS: 5 }], 10)).toEqual([
    { startS: 1, endS: 4 },
    { startS: 8, endS: 10 },
  ]);
});

test('sliceCurve returns exactly the trim span', () => {
  const c = buildCurve(track({ mutes: [{ startS: 2, endS: 3 }] }), trim, 10);
  const s = sliceCurve(c, { inS: 1.5, outS: 4 });
  expect(s.length).toBe(curveLength(2.5));
  expect(at(s, 1)).toBe(0);
});

test('encodeCurve is little-endian f32 base64', () => {
  const bytes = Uint8Array.from(atob(encodeCurve(Float32Array.of(1, 0.5))), (ch) => ch.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  expect([view.getFloat32(0, true), view.getFloat32(4, true)]).toEqual([1, 0.5]);
});

test('encodes a 30-minute curve quickly', () => {
  const c = buildCurve(track({ mutes: [{ startS: 60, endS: 90 }] }), { inS: 0, outS: 1800 }, 1800);
  const t0 = performance.now();
  encodeCurve(c);
  expect(performance.now() - t0).toBeLessThan(500);
});

test('mixCurves returns a curve per track', () => {
  const m = mixCurves({ tracks: [track(), track({ index: 1, enabled: false })], duck: null }, trim, 10, null);
  expect([...m.keys()]).toEqual([0, 1]);
});
