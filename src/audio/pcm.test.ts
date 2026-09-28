import { expect, test } from 'vitest';
import { frameAt, s16StereoToPlanar } from './pcm';

test('frameAt rounds seconds to 48 kHz frames and clamps negatives', () => {
  expect(frameAt(1)).toBe(48000);
  expect(frameAt(12.5)).toBe(600000);
  expect(frameAt(-3)).toBe(0);
});

test('s16StereoToPlanar splits interleaved little-endian s16 into two float channels', () => {
  const v = new DataView(new ArrayBuffer(8));
  v.setInt16(0, 16384, true);
  v.setInt16(2, -32768, true);
  v.setInt16(4, 0, true);
  v.setInt16(6, 32767, true);
  const [l, r] = s16StereoToPlanar(v.buffer);
  expect(Array.from(l)).toEqual([0.5, 0]);
  expect(r[0]).toBe(-1);
  expect(r[1]).toBeCloseTo(1, 4);
});

test('s16StereoToPlanar ignores a trailing partial frame', () => {
  const [l] = s16StereoToPlanar(new ArrayBuffer(6));
  expect(l.length).toBe(1);
});
