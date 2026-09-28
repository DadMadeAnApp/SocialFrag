import type { Canvas, Caption, CaptionStyle } from '../types';
import type { Ctx2D } from './ctx';

/** Wrap width as a share of canvas width (960 px on the 1080-wide vertical canvas). */
export const CAPTION_MAX_W_FRAC = 960 / 1080;

/** A caption in canvas pixels, ready to draw. */
export interface CaptionPx extends Caption { maxW: number }

export const toPx = (c: Caption, canvas: Canvas): CaptionPx => ({
  ...c, x: c.x * canvas.w, y: c.y * canvas.h, fontSize: c.fontSize * canvas.h, maxW: canvas.w * CAPTION_MAX_W_FRAC,
});

export const LINE_HEIGHT = 1.15;
export const HANDLE = 28;

interface StyleDef {
  font(size: number): string;
  fill: string;
  stroke?: { color: string; width(size: number): number };
  box?: { color: string; padX(size: number): number; padY(size: number): number; radius(size: number): number };
}

export const CAPTION_STYLES: Record<CaptionStyle, StyleDef> = {
  tiktok: { font: (s) => `800 ${s}px Inter`, fill: '#ffffff', stroke: { color: '#000000', width: (s) => s * 0.12 } },
  impact: { font: (s) => `${s}px Anton`, fill: '#ffe14d', stroke: { color: '#000000', width: (s) => s * 0.1 } },
  boxed: {
    font: (s) => `${s}px "Bebas Neue"`,
    fill: '#ffffff',
    box: { color: 'rgba(0,0,0,0.75)', padX: (s) => s * 0.4, padY: (s) => s * 0.25, radius: (s) => s * 0.3 },
  },
  plain: { font: (s) => `600 ${s}px Inter`, fill: '#ffffff' },
};

export const STYLE_LABELS: Record<CaptionStyle, string> = { tiktok: 'TikTok', impact: 'Impact', boxed: 'Boxed', plain: 'Plain' };

export interface Box { x: number; y: number; w: number; h: number }

export function wrapLines(measure: (s: string) => number, text: string, maxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push('');
      continue;
    }
    let line = words[0];
    for (const word of words.slice(1)) {
      const next = `${line} ${word}`;
      if (measure(next) <= maxW) line = next;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

export function captionLayout(ctx: Ctx2D, c: CaptionPx): { lines: string[]; box: Box } {
  const st = CAPTION_STYLES[c.style];
  ctx.font = st.font(c.fontSize);
  const lines = wrapLines((s) => ctx.measureText(s).width, c.text, c.maxW);
  const textW = Math.max(1, ...lines.map((l) => ctx.measureText(l).width));
  const lh = c.fontSize * LINE_HEIGHT;
  const padX = st.box ? st.box.padX(c.fontSize) : 0;
  const padY = st.box ? st.box.padY(c.fontSize) : 0;
  const w = textW + padX * 2;
  const h = lh * lines.length + padY * 2;
  return { lines, box: { x: c.x - w / 2, y: c.y - h / 2, w, h } };
}

export function drawCaption(ctx: Ctx2D, c: CaptionPx): void {
  if (!c.text.trim()) return;
  const st = CAPTION_STYLES[c.style];
  const { lines, box } = captionLayout(ctx, c);
  ctx.save();
  if (st.box) {
    ctx.fillStyle = st.box.color;
    ctx.beginPath();
    ctx.roundRect(box.x, box.y, box.w, box.h, st.box.radius(c.fontSize));
    ctx.fill();
  }
  ctx.font = st.font(c.fontSize);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const lh = c.fontSize * LINE_HEIGHT;
  const top = c.y - (lh * lines.length) / 2 + lh / 2;
  lines.forEach((line, i) => {
    const y = top + i * lh;
    if (st.stroke) {
      ctx.strokeStyle = st.stroke.color;
      ctx.lineWidth = st.stroke.width(c.fontSize);
      ctx.strokeText(line, c.x, y);
    }
    ctx.fillStyle = c.color ?? st.fill;
    ctx.fillText(line, c.x, y);
  });
  ctx.restore();
}

export const isCaptionVisible = (c: Caption, t: number): boolean => t >= c.start - 1e-3 && (c.end === undefined || t < c.end);

export function hitCaption(ctx: Ctx2D, captions: CaptionPx[], x: number, y: number): { id: string; mode: 'move' | 'resize' } | null {
  for (let i = captions.length - 1; i >= 0; i--) {
    const { box } = captionLayout(ctx, captions[i]);
    const right = box.x + box.w;
    const bottom = box.y + box.h;
    if (Math.abs(x - right) <= HANDLE && Math.abs(y - bottom) <= HANDLE) return { id: captions[i].id, mode: 'resize' };
    if (x >= box.x && x <= right && y >= box.y && y <= bottom) return { id: captions[i].id, mode: 'move' };
  }
  return null;
}

export function drawCaptionSelection(ctx: Ctx2D, c: CaptionPx): void {
  const { box } = captionLayout(ctx, c);
  ctx.save();
  ctx.strokeStyle = '#4da3ff';
  ctx.lineWidth = 4;
  ctx.setLineDash([12, 8]);
  ctx.strokeRect(box.x, box.y, box.w, box.h);
  ctx.setLineDash([]);
  ctx.fillStyle = '#4da3ff';
  ctx.fillRect(box.x + box.w - HANDLE / 2, box.y + box.h - HANDLE / 2, HANDLE, HANDLE);
  ctx.restore();
}
