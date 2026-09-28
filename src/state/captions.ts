import type { Caption } from '../types';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const FONT_MIN = 24 / 1920;
const FONT_MAX = 240 / 1920;

export function newCaption(id: string, currentTime: number, timing: 'whole' | 'fromHere'): Caption {
  return { id, text: 'Your caption', style: 'tiktok', x: 0.5, y: 260 / 1920, fontSize: 80 / 1920, start: timing === 'whole' ? 0 : currentTime, source: 'manual' };
}

export const updateCaption = (list: Caption[], c: Caption): Caption[] => list.map((x) => (x.id === c.id ? c : x));
export const removeCaption = (list: Caption[], id: string): Caption[] => list.filter((x) => x.id !== id);

/** dx/dy are fractions of canvas width/height. */
export const moveCaption = (c: Caption, dx: number, dy: number): Caption => ({ ...c, x: clamp(c.x + dx, 0, 1), y: clamp(c.y + dy, 0, 1) });

/** dy is a fraction of canvas height; the font grows by half of it. */
export const resizeCaption = (c: Caption, dy: number): Caption => ({ ...c, fontSize: clamp(c.fontSize + dy * 0.5, FONT_MIN, FONT_MAX) });

const LOOK: (keyof Caption)[] = ['style', 'x', 'y', 'fontSize', 'color'];
const CONTENT: (keyof Caption)[] = ['text', 'start', 'end', ...LOOK];

/** An auto-line the user changes becomes `edited` (re-runs keep it); a look change also makes it an override. */
export function editCaption(prev: Caption, next: Caption): Caption {
  if (prev.source !== 'auto' || !CONTENT.some((k) => prev[k] !== next[k])) return next;
  return { ...next, edited: true, ...(LOOK.some((k) => prev[k] !== next[k]) ? { override: true } : {}) };
}
