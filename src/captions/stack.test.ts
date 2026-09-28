import { expect, test } from 'vitest';
import { recordingCtx } from '../test/recordingCtx';
import { stackCaptions } from './stack';

const px = (id: string, trackIndex: number | undefined, y = 1600) => ({
  id, text: 'hi', style: 'plain' as const, x: 540, y, fontSize: 80, start: 0, source: 'auto' as const, trackIndex, maxW: 960,
});

test('overlapping lines stack upward in track order; separate lines stay put', () => {
  const { ctx } = recordingCtx();
  const [a, b] = stackCaptions(ctx, [px('b', 3), px('a', 2)]);
  expect(a.id).toBe('a');
  expect(a.y).toBe(1600);
  expect(b.y).toBeLessThan(1600 - 80); // moved above a's box
  const [c, d] = stackCaptions(ctx, [px('c', 2, 400), px('d', 3, 1600)]);
  expect([c.y, d.y]).toEqual([400, 1600]);
});
