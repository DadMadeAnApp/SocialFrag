import { stackCaptions } from '../captions/stack';
import type { Canvas, Caption, CaptionFrame, ClipInfo, Overlay, Preset } from '../types';
import { drawCaption, toPx } from './captions';
import { drawLayerBorder, drawMask } from './compose';
import type { Ctx2D } from './ctx';
import { layoutLayer } from './fit';

export type CanvasFactory = (w: number, h: number) => { ctx: Ctx2D; encode(): Promise<string> };

async function blobToBase64(b: Blob): Promise<string> {
  const bytes = new Uint8Array(await b.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export const offscreenFactory: CanvasFactory = (w, h) => {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');
  return { ctx, encode: async () => blobToBase64(await canvas.convertToBlob({ type: 'image/png' })) };
};

/** Renders with the same drawing code as the preview so the exported video matches it. */
export async function buildExportAssets(
  preset: Preset,
  clip: ClipInfo,
  canvas: Canvas,
  make: CanvasFactory = offscreenFactory,
): Promise<{ layerMasks: Record<string, string>; overlays: Overlay[] }> {
  const layerMasks: Record<string, string> = {};
  for (const l of preset.layers) {
    if (l.hidden) continue;
    if (!l.radius || l.radius <= 0) continue;
    const { draw } = layoutLayer(l, clip.width, clip.height);
    const c = make(draw[2], draw[3]);
    drawMask(c.ctx, draw[2], draw[3], l.radius);
    layerMasks[l.id] = await c.encode();
  }

  const overlays: Overlay[] = [];
  if (preset.layers.some((l) => l.border && !l.hidden)) {
    const c = make(canvas.w, canvas.h);
    for (const l of preset.layers) if (!l.hidden) drawLayerBorder(c.ctx, clip.width, clip.height, l);
    overlays.push({ pngBase64: await c.encode(), start: 0 });
  }
  return { layerMasks, overlays };
}

/** Contiguous frames over [0, dur): one PNG per stretch where the same set of captions is on screen (blank stretches share one PNG). */
export async function buildCaptionFrames(captions: Caption[], windows: ([number, number] | null)[], dur: number, canvas: Canvas, make: CanvasFactory = offscreenFactory): Promise<CaptionFrame[]> {
  const live = captions.map((c, i) => ({ c, w: windows[i] })).filter((x): x is { c: Caption; w: [number, number] } => !!x.w && !!x.c.text.trim());
  if (!live.length) return [];
  const cuts = [...new Set([0, dur, ...live.flatMap((x) => x.w)])].filter((t) => t >= 0 && t <= dur).sort((a, b) => a - b);
  const frames: CaptionFrame[] = [];
  let blank: string | null = null;
  let prevKey = '';
  for (let i = 0; i + 1 < cuts.length; i++) {
    const [s, e] = [cuts[i], cuts[i + 1]];
    const mid = (s + e) / 2;
    const on = live.filter((x) => x.w[0] <= mid && mid < x.w[1]).map((x) => x.c);
    const key = on.map((c) => c.id).join('|');
    if (key === prevKey && frames.length) {
      frames[frames.length - 1].end = e;
      continue;
    }
    prevKey = key;
    let png: string;
    if (!on.length) png = blank ??= await make(canvas.w, canvas.h).encode();
    else {
      const k = make(canvas.w, canvas.h);
      for (const c of stackCaptions(k.ctx, on.map((c) => toPx(c, canvas)))) drawCaption(k.ctx, c);
      png = await k.encode();
    }
    frames.push({ pngBase64: png, start: s, end: e });
  }
  return frames;
}
