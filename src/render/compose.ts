import type { Background, Canvas, Caption, Layer, Preset } from '../types';
import { stackCaptions } from '../captions/stack';
import { drawCaption, isCaptionVisible, toPx } from './captions';
import type { Ctx2D } from './ctx';
import { layoutLayer } from './fit';

/** kx/ky map layout (original clip) pixels to the decoded frame, which is smaller when a preview proxy is playing. */
export function drawBackground(ctx: Ctx2D, frame: CanvasImageSource, srcW: number, srcH: number, bg: Background, canvas: Canvas, kx = 1, ky = 1): void {
  if (bg.type === 'blur') {
    const { crop } = layoutLayer({ src: [0, 0, 1, 1], dst: [0, 0, canvas.w, canvas.h], fit: 'cover' }, srcW, srcH);
    ctx.save();
    ctx.filter = `blur(${bg.amount}px)`;
    ctx.drawImage(frame, crop[0] * kx, crop[1] * ky, crop[2] * kx, crop[3] * ky, 0, 0, canvas.w, canvas.h);
    ctx.restore();
    return;
  }
  ctx.fillStyle = bg.type === 'color' ? bg.color : '#000000';
  ctx.fillRect(0, 0, canvas.w, canvas.h);
}

export function drawLayerImage(ctx: Ctx2D, frame: CanvasImageSource, srcW: number, srcH: number, layer: Layer, kx = 1, ky = 1): void {
  const { crop, draw } = layoutLayer(layer, srcW, srcH);
  ctx.save();
  if (layer.radius) {
    ctx.beginPath();
    ctx.roundRect(draw[0], draw[1], draw[2], draw[3], layer.radius);
    ctx.clip();
  }
  ctx.drawImage(frame, crop[0] * kx, crop[1] * ky, crop[2] * kx, crop[3] * ky, draw[0], draw[1], draw[2], draw[3]);
  ctx.restore();
}

export function drawLayerBorder(ctx: Ctx2D, srcW: number, srcH: number, layer: Layer): void {
  if (!layer.border) return;
  const { draw } = layoutLayer(layer, srcW, srcH);
  ctx.save();
  ctx.strokeStyle = layer.border.color;
  ctx.lineWidth = layer.border.width;
  ctx.beginPath();
  ctx.roundRect(draw[0], draw[1], draw[2], draw[3], layer.radius ?? 0);
  ctx.stroke();
  ctx.restore();
}

/** White = visible. Used by ffmpeg alphamerge for rounded corners. */
export function drawMask(ctx: Ctx2D, w: number, h: number, radius: number): void {
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, radius);
  ctx.fill();
}

/** frameW/frameH = decoded size of `frame` (video.videoWidth/Height); differs from srcW/srcH under a preview proxy. */
export function drawFrame(
  ctx: Ctx2D,
  frame: CanvasImageSource,
  srcW: number,
  srcH: number,
  preset: Preset,
  captions: Caption[],
  t: number,
  canvas: Canvas,
  frameW = srcW,
  frameH = srcH,
): void {
  const kx = frameW / srcW;
  const ky = frameH / srcH;
  drawBackground(ctx, frame, srcW, srcH, preset.background, canvas, kx, ky);
  for (const l of preset.layers) if (!l.hidden) drawLayerImage(ctx, frame, srcW, srcH, l, kx, ky);
  for (const l of preset.layers) if (!l.hidden) drawLayerBorder(ctx, srcW, srcH, l);
  for (const c of stackCaptions(ctx, captions.filter((c) => isCaptionVisible(c, t)).map((c) => toPx(c, canvas)))) drawCaption(ctx, c);
}
