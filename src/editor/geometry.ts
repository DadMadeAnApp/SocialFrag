import type { Layer, Rect } from '../types';

export type Handle = 'move' | 'nw' | 'ne' | 'sw' | 'se';
export interface Guides { x: number[]; y: number[] }
export const MIN_SIZE = 8;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const r5 = (v: number) => Math.round(v * 1e5) / 1e5;

export const fracToPx = (r: Rect, w: number, h: number): Rect => [r[0] * w, r[1] * h, r[2] * w, r[3] * h];
export const pxToFrac = (r: Rect, w: number, h: number): Rect => [r5(r[0] / w), r5(r[1] / h), r5(r[2] / w), r5(r[3] / h)];

export function hitRect(rects: { id: string; rect: Rect }[], x: number, y: number, handleSize: number): { id: string; handle: Handle } | null {
  for (let i = rects.length - 1; i >= 0; i--) {
    const [rx, ry, rw, rh] = rects[i].rect;
    const corners: [Handle, number, number][] = [
      ['nw', rx, ry],
      ['ne', rx + rw, ry],
      ['sw', rx, ry + rh],
      ['se', rx + rw, ry + rh],
    ];
    for (const [handle, cx, cy] of corners) {
      if (Math.abs(x - cx) <= handleSize && Math.abs(y - cy) <= handleSize) return { id: rects[i].id, handle };
    }
    if (x >= rx && x <= rx + rw && y >= ry && y <= ry + rh) return { id: rects[i].id, handle: 'move' };
  }
  return null;
}

export function dragRect(start: Rect, handle: Handle, dx: number, dy: number, bw: number, bh: number): Rect {
  const [x, y, w, h] = start;
  if (handle === 'move') return [clamp(x + dx, 0, bw - w), clamp(y + dy, 0, bh - h), w, h];
  let l = x;
  let t = y;
  let r = x + w;
  let b = y + h;
  if (handle.includes('w')) l = clamp(x + dx, 0, r - MIN_SIZE);
  if (handle.includes('e')) r = clamp(r + dx, l + MIN_SIZE, bw);
  if (handle.includes('n')) t = clamp(y + dy, 0, b - MIN_SIZE);
  if (handle.includes('s')) b = clamp(b + dy, t + MIN_SIZE, bh);
  return [l, t, r - l, b - t];
}

function nearestDelta(values: number[], targets: number[], th: number): number | null {
  let best: number | null = null;
  for (const v of values) {
    for (const t of targets) {
      const d = t - v;
      if (Math.abs(d) <= th && (best === null || Math.abs(d) < Math.abs(best))) best = d;
    }
  }
  return best;
}

export function snapRect(rect: Rect, handle: Handle, guides: Guides, th: number, bw: number, bh: number): Rect {
  let [x, y, w, h] = rect;
  if (handle === 'move') {
    const ddx = nearestDelta([x, x + w / 2, x + w], guides.x, th);
    if (ddx !== null) x = clamp(x + ddx, 0, bw - w);
    const ddy = nearestDelta([y, y + h / 2, y + h], guides.y, th);
    if (ddy !== null) y = clamp(y + ddy, 0, bh - h);
    return [x, y, w, h];
  }
  let l = x;
  let t = y;
  let r = x + w;
  let b = y + h;
  const edge = (value: number, targets: number[], ok: (v: number) => boolean) => {
    const d = nearestDelta([value], targets, th);
    return d !== null && ok(value + d) ? value + d : value;
  };
  if (handle.includes('w')) l = edge(l, guides.x, (v) => r - v >= MIN_SIZE);
  if (handle.includes('e')) r = edge(r, guides.x, (v) => v - l >= MIN_SIZE);
  if (handle.includes('n')) t = edge(t, guides.y, (v) => b - v >= MIN_SIZE);
  if (handle.includes('s')) b = edge(b, guides.y, (v) => v - t >= MIN_SIZE);
  return [l, t, r - l, b - t];
}

export function guidesFor(bw: number, bh: number, others: Rect[]): Guides {
  return {
    x: [0, bw / 2, bw, ...others.flatMap((o) => [o[0], o[0] + o[2]])],
    y: [0, bh / 2, bh, ...others.flatMap((o) => [o[1], o[1] + o[3]])],
  };
}

/** The gameplay layer is `id: "gameplay"` when present, otherwise index 0. Never draggable in the main preview. */
export function isGameplayLayer(layers: { id: string }[], index: number): boolean {
  return layers.some((l) => l.id === 'gameplay') ? layers[index]?.id === 'gameplay' : index === 0;
}

/** Non-gameplay, visible layers, in draw order (bottom → top). Feed straight into hitRect for topmost-first hit-testing. */
export function hittableHudLayers(layers: Layer[]): { id: string; rect: Rect }[] {
  return layers.filter((l, i) => !isGameplayLayer(layers, i) && !l.hidden).map((l) => ({ id: l.id, rect: l.dst }));
}

export function nudgeRect(rect: Rect, key: string, step: number, bw: number, bh: number): Rect | null {
  const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  const v = d[key];
  return v ? dragRect(rect, 'move', v[0], v[1], bw, bh) : null;
}
