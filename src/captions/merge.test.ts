import { expect, test } from 'vitest';
import type { Caption } from '../types';
import { mergeRun } from './merge';

const c = (id: string, start: number, end: number, over: Partial<Caption> = {}): Caption => ({
  id, text: id, style: 'tiktok', x: 0.5, y: 0.82, fontSize: 80 / 1920, start, end, source: 'auto', trackIndex: 3, ...over,
});

test('replaces untouched auto-lines of the track, keeps edited, manual and other tracks, skips overlaps', () => {
  const existing = [
    c('old', 0, 1),
    c('edited', 2, 3, { edited: true }),
    c('manual', 4, 5, { source: 'manual', trackIndex: undefined }),
    c('other', 0, 1, { trackIndex: 2 }),
  ];
  const fresh = [c('n1', 0, 1), c('n2', 2.5, 3.5), c('n3', 6, 7)];
  expect(mergeRun(existing, 3, fresh).map((x) => x.id).sort()).toEqual(['edited', 'manual', 'n1', 'n3', 'other']);
});

test('result is sorted by start', () => {
  expect(mergeRun([c('b', 5, 6, { edited: true })], 3, [c('a', 1, 2)]).map((x) => x.id)).toEqual(['a', 'b']);
});
