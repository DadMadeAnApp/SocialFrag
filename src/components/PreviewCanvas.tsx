import { useEffect, useRef, type PointerEvent } from 'react';
import { dragRect, guidesFor, hitRect, hittableHudLayers, snapRect, type Handle } from '../editor/geometry';
import { drawCaptionSelection, hitCaption, toPx } from '../render/captions';
import { drawFrame } from '../render/compose';
import { moveCaption, resizeCaption } from '../state/captions';
import { formatOf, type Canvas, type Caption, type ClipInfo, type Layer, type Preset, type Rect } from '../types';

const HANDLE_SCREEN_PX = 10;
const SNAP_SCREEN_PX = 8;

interface Props {
  video: HTMLVideoElement | null;
  info: ClipInfo;
  preset: Preset;
  canvas: Canvas;
  captions: Caption[];
  selectedCaptionId: string | null;
  onSelectCaption(id: string | null): void;
  onCaptionChange(c: Caption): void;
  onLayerChange(layer: Layer): void;
}

type Drag =
  | { kind: 'caption'; mode: 'move' | 'resize'; x: number; y: number; orig: Caption }
  | { kind: 'layer'; id: string; handle: Handle; x: number; y: number; orig: Rect };

function drawHudHover(ctx: CanvasRenderingContext2D, l: Layer) {
  const [x, y, w, h] = l.dst;
  ctx.save();
  ctx.strokeStyle = '#4da3ff';
  ctx.lineWidth = 3;
  ctx.setLineDash([8, 6]);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);
  ctx.font = '600 24px Inter';
  const label = l.label;
  const pad = 6;
  const tw = ctx.measureText(label).width;
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.fillRect(x, Math.max(0, y - 30), tw + pad * 2, 28);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(label, x + pad, Math.max(0, y - 30) + 20);
  ctx.restore();
}

export function PreviewCanvas({ video, info, preset, canvas, captions, selectedCaptionId, onSelectCaption, onCaptionChange, onLayerChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const latest = useRef({ preset, captions, selectedCaptionId, canvas });
  latest.current = { preset, captions, selectedCaptionId, canvas };
  const drag = useRef<Drag | null>(null);
  const hover = useRef<string | null>(null);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx || !video) return;
    let raf = 0;
    const tick = () => {
      const { preset, captions, selectedCaptionId, canvas } = latest.current;
      if (video.readyState >= 2) drawFrame(ctx, video, info.width, info.height, preset, captions, video.currentTime, canvas, video.videoWidth || info.width, video.videoHeight || info.height);
      const sel = captions.find((c) => c.id === selectedCaptionId);
      if (sel) drawCaptionSelection(ctx, toPx(sel, canvas));
      if (!drag.current && hover.current) {
        const l = preset.layers.find((x) => x.id === hover.current);
        if (l && !l.hidden) drawHudHover(ctx, l);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [video, info]);

  const toCanvas = (e: PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * canvas.w) / r.width, y: ((e.clientY - r.top) * canvas.h) / r.height, k: canvas.w / r.width };
  };

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const p = toCanvas(e);
    const px = captions.map((c) => toPx(c, canvas));
    const hitCap = hitCaption(ctx, px, p.x, p.y);
    if (hitCap) {
      const orig = captions.find((c) => c.id === hitCap.id)!;
      onSelectCaption(orig.id);
      drag.current = { kind: 'caption', mode: hitCap.mode, x: p.x, y: p.y, orig };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    onSelectCaption(null);
    const rects = hittableHudLayers(preset.layers);
    const hitLayer = hitRect(rects, p.x, p.y, HANDLE_SCREEN_PX * p.k);
    if (!hitLayer) return;
    const layer = preset.layers.find((l) => l.id === hitLayer.id)!;
    drag.current = { kind: 'layer', id: layer.id, handle: hitLayer.handle, x: p.x, y: p.y, orig: layer.dst };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const p = toCanvas(e);
    const d = drag.current;
    if (!d) {
      const rects = hittableHudLayers(preset.layers);
      const hit = hitRect(rects, p.x, p.y, HANDLE_SCREEN_PX * p.k);
      hover.current = hit?.id ?? null;
      return;
    }
    if (d.kind === 'caption') {
      onCaptionChange(d.mode === 'move' ? moveCaption(d.orig, (p.x - d.x) / canvas.w, (p.y - d.y) / canvas.h) : resizeCaption(d.orig, (p.y - d.y) / canvas.h));
      return;
    }
    const layer = preset.layers.find((l) => l.id === d.id);
    if (!layer) return;
    let rect = dragRect(d.orig, d.handle, p.x - d.x, p.y - d.y, canvas.w, canvas.h);
    if (!e.altKey) {
      const others = preset.layers.filter((l) => l.id !== d.id && !l.hidden).map((l) => l.dst);
      rect = snapRect(rect, d.handle, guidesFor(canvas.w, canvas.h, others), SNAP_SCREEN_PX * p.k, canvas.w, canvas.h);
    }
    onLayerChange({ ...layer, dst: rect.map(Math.round) as Rect });
  };

  return (
    <canvas
      ref={canvasRef}
      className="preview"
      width={canvas.w}
      height={canvas.h}
      aria-label={formatOf(canvas) === 'landscape' ? 'Landscape preview' : 'Vertical preview'}
      style={{ aspectRatio: `${canvas.w} / ${canvas.h}` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => (drag.current = null)}
      onDoubleClick={() => document.getElementById('caption-text')?.focus()}
    />
  );
}
