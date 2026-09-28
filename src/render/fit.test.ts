import { expect, test } from 'vitest';
import { layoutLayer } from './fit';

test('cover: gameplay column into a square', () => {
  expect(layoutLayer({ src: [0.28, 0, 0.44, 1], dst: [0, 420, 1080, 1080], fit: 'cover' }, 1920, 1080)).toEqual({
    crop: [538, 118, 845, 845],
    draw: [0, 420, 1080, 1080],
  });
});

test('contain: killfeed letterboxed and centred in its box', () => {
  expect(layoutLayer({ src: [0.75, 0.02, 0.23, 0.15], dst: [60, 80, 960, 300], fit: 'contain' }, 1920, 1080)).toEqual({
    crop: [1440, 22, 442, 162],
    draw: [132, 80, 819, 300],
  });
});

test('cover: full 16:9 frame into 9:16 canvas (blur background)', () => {
  expect(layoutLayer({ src: [0, 0, 1, 1], dst: [0, 0, 1080, 1920], fit: 'cover' }, 1920, 1080).crop).toEqual([656, 0, 608, 1080]);
});

test('edge_clamp: odd source size keeps crop inside the frame', () => {
  expect(layoutLayer({ src: [0.5, 0.5, 0.5, 0.5], dst: [0, 0, 1080, 1920], fit: 'contain' }, 2559, 1439)).toEqual({
    crop: [1280, 720, 1279, 719],
    draw: [0, 658, 1080, 607],
  });
});

test('draw position is always even (yuv420 overlay snaps odd x/y) and crops are at least 2px', () => {
  const l = layoutLayer({ src: [0.999, 0.999, 0.001, 0.001], dst: [101, 203, 300, 300], fit: 'contain' }, 1920, 1080);
  expect(l.draw[0] % 2).toBe(0);
  expect(l.draw[1] % 2).toBe(0);
  expect(l.crop[2]).toBeGreaterThanOrEqual(2);
  expect(l.crop[3]).toBeGreaterThanOrEqual(2);
  expect(l.crop[0] + l.crop[2]).toBeLessThanOrEqual(1920);
  expect(l.crop[1] + l.crop[3]).toBeLessThanOrEqual(1080);
});
