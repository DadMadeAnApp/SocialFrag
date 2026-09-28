import { expect, test } from 'vitest';
import { DEFAULT_LAYOUT, clampLayout, loadLayout, saveLayout } from './layout';

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

test('clamps widths and timeline height to their limits', () => {
  const l = clampLayout({ ...DEFAULT_LAYOUT, railW: 50, sideW: 9999, timelineH: 5000 }, 1000);
  expect([l.railW, l.sideW, l.timelineH]).toEqual([180, 560, 600]);
  expect(clampLayout({ ...DEFAULT_LAYOUT, timelineH: 10 }, 1000).timelineH).toBe(80);
});

test('round-trips through storage', () => {
  const s = mem();
  saveLayout(s, { ...DEFAULT_LAYOUT, railW: 300, sideCollapsed: true });
  expect(loadLayout(s, 1000)).toEqual({ ...DEFAULT_LAYOUT, railW: 300, sideCollapsed: true });
});

test('corrupt, partial or missing storage falls back to defaults per field', () => {
  expect(loadLayout({ getItem: () => '{nope' }, 1000)).toEqual(DEFAULT_LAYOUT);
  expect(loadLayout({ getItem: () => '{"railW":"x","sideW":400}' }, 1000)).toEqual({ ...DEFAULT_LAYOUT, sideW: 400 });
  expect(loadLayout(null, 1000)).toEqual(DEFAULT_LAYOUT);
  expect(loadLayout({ getItem: () => { throw new Error('blocked'); } }, 1000)).toEqual(DEFAULT_LAYOUT);
});

test('saving swallows storage errors', () => {
  expect(() => saveLayout({ setItem: () => { throw new Error('quota'); } }, DEFAULT_LAYOUT)).not.toThrow();
});
