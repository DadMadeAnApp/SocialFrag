import { expect, test } from 'vitest';
import { recordingCtx } from '../test/recordingCtx';
import { captionLayout, drawCaption, hitCaption, isCaptionVisible, toPx, wrapLines } from './captions';
import type { CaptionPx } from './captions';

const measure = (s: string) => s.length * 10;
const cap = (over: Partial<CaptionPx> = {}): CaptionPx => ({ id: 'a', text: 'Hello world', style: 'tiktok', x: 540, y: 300, fontSize: 72, start: 0, source: 'manual', maxW: 960, ...over });

test('toPx scales fractions to the canvas; font size follows height, wrap width follows width', () => {
  const c = { id: 'a', text: 'Hi', style: 'plain' as const, x: 0.5, y: 0.25, fontSize: 0.05, start: 0, source: 'manual' as const };
  expect(toPx(c, { w: 1080, h: 1920 })).toMatchObject({ x: 540, y: 480, fontSize: 96, maxW: 960 });
  expect(toPx(c, { w: 1920, h: 1080 })).toMatchObject({ x: 960, y: 270, fontSize: 54, maxW: 1920 * (960 / 1080) });
});

test('wrapLines breaks on width and keeps explicit newlines', () => {
  expect(wrapLines(measure, 'aaa bbb ccc', 70)).toEqual(['aaa bbb', 'ccc']);
  expect(wrapLines(measure, 'one\ntwo', 1000)).toEqual(['one', 'two']);
  expect(wrapLines(measure, 'x\n\ny', 1000)).toEqual(['x', '', 'y']);
});

test('captionLayout centres the box on x/y', () => {
  const { ctx } = recordingCtx();
  const { lines, box } = captionLayout(ctx, cap());
  expect(lines).toEqual(['Hello world']);
  expect(box.w).toBe(110);
  expect(box.h).toBeCloseTo(82.8);
  expect(box.x).toBe(485);
  expect(box.y).toBeCloseTo(258.6);
});

test('boxed style adds padding', () => {
  const { ctx } = recordingCtx();
  const { box } = captionLayout(ctx, cap({ style: 'boxed' }));
  expect(box.w).toBeCloseTo(110 + 72 * 0.4 * 2);
});

test('hitCaption: body = move, bottom-right corner = resize, elsewhere = null', () => {
  const { ctx } = recordingCtx();
  const c = cap();
  expect(hitCaption(ctx, [c], 540, 300)).toEqual({ id: 'a', mode: 'move' });
  expect(hitCaption(ctx, [c], 595, 341)).toEqual({ id: 'a', mode: 'resize' });
  expect(hitCaption(ctx, [c], 100, 1500)).toBeNull();
});

test('isCaptionVisible honours end', () => {
  const c = { ...cap(), start: 1, end: 2 };
  expect(isCaptionVisible(c, 0.5)).toBe(false);
  expect(isCaptionVisible(c, 1)).toBe(true);
  expect(isCaptionVisible(c, 1.999)).toBe(true);
  expect(isCaptionVisible(c, 2)).toBe(false);
  expect(isCaptionVisible({ ...c, end: undefined }, 99)).toBe(true);
});

test('drawCaption fills with the caption colour when set', () => {
  const { ctx, named } = recordingCtx();
  drawCaption(ctx, { ...cap(), style: 'tiktok', color: '#FFE14D' });
  expect(named('set:fillStyle')).toContainEqual(['#FFE14D']);
});
