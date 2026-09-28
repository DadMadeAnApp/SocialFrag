import { act, renderHook } from '@testing-library/react';
import { expect, test } from 'vitest';
import { COALESCE_MS, HISTORY_CAP, initHistory, push, redo, replace, rewrite, undo } from './history';
import { emptyProject } from './model';
import { setFormat } from './ops';
import { useHistory } from './useHistory';

test('push, undo and redo walk the history', () => {
  let h = initHistory(0);
  h = push(h, 1);
  h = push(h, 2);
  h = undo(h);
  expect(h.present).toBe(1);
  h = redo(h);
  expect(h.present).toBe(2);
  h = undo(undo(h));
  expect(h.present).toBe(0);
  expect(undo(h)).toBe(h);
});

test('a new edit after undo drops the redo branch', () => {
  let h = push(push(initHistory('a'), 'b'), 'c');
  h = push(undo(h), 'd');
  expect(h.future).toEqual([]);
  expect(redo(h)).toBe(h);
});

test('a continuous drag coalesces into one undo step', () => {
  let h = initHistory(0);
  for (let i = 1; i <= 50; i++) h = push(h, i, 'trim:c1', 1000 + i * 16);
  expect(h.present).toBe(50);
  expect(undo(h).present).toBe(0);
});

test('a different key, or a pause longer than COALESCE_MS, starts a new step', () => {
  let h = push(initHistory(0), 1, 'a', 0);
  h = push(h, 2, 'b', 10);
  h = push(h, 3, 'b', 10 + COALESCE_MS + 1);
  expect(h.past).toEqual([0, 1, 2]);
});

test('history keeps at most HISTORY_CAP undo steps', () => {
  let h = initHistory(0);
  for (let i = 1; i <= HISTORY_CAP + 50; i++) h = push(h, i);
  expect(h.past).toHaveLength(HISTORY_CAP);
  expect(h.past[0]).toBe(50);
});

test('pushing the same object is a no-op and replace adds no undo step', () => {
  const s = { v: 1 };
  const h = push(initHistory(s), s);
  expect(h.past).toEqual([]);
  expect(replace(h, { v: 2 }).past).toEqual([]);
});

test('rewrite maps past, present and future, and preserves coalescing', () => {
  let h = push(initHistory(0), 1, 'trim:c1', 10);
  h = push(h, 2, 'trim:c1', 20);
  h = push(h, 3);
  h = undo(h);
  const before = { key: h.key, at: h.at };
  const r = rewrite(h, (n: number) => n * 10);
  expect(r.past).toEqual([0]);
  expect(r.present).toBe(20);
  expect(r.future).toEqual([30]);
  expect({ key: r.key, at: r.at }).toEqual(before);
});

test('useHistory applies updater functions and exposes undo/redo', () => {
  const { result } = renderHook(() => useHistory(() => 1));
  act(() => result.current.set((n) => n + 1));
  act(() => result.current.set((n) => n * 10));
  expect(result.current.present).toBe(20);
  act(() => result.current.undo());
  expect(result.current.present).toBe(2);
  expect(result.current.canRedo).toBe(true);
  act(() => result.current.replace((n) => n + 100));
  expect(result.current.present).toBe(102);
  act(() => result.current.undo());
  expect(result.current.present).toBe(1);
});

test('undo restores the format', () => {
  const h = push(initHistory(emptyProject()), setFormat(emptyProject(), 'landscape'));
  expect(undo(h).present.canvas).toEqual({ w: 1080, h: 1920 });
});
