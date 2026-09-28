import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { dragRect, fracToPx, guidesFor, hitRect, nudgeRect, pxToFrac, snapRect, type Handle } from '../editor/geometry';
import { drawFrame } from '../render/compose';
import type { Ctx2D } from '../render/ctx';
import { VERTICAL_CANVAS, type Background, type ClipInfo, type Fit, type Layer, type Preset, type Rect } from '../types';

const COLORS = ['#ff5c5c', '#4da3ff', '#ffd24d', '#5cff9d', '#c77dff', '#ff9f43'];
const HANDLE_SCREEN_PX = 10;
const SNAP_SCREEN_PX = 8;

type Side = 'src' | 'dst';

interface Props {
  video: HTMLVideoElement | null;
  info: ClipInfo;
  preset: Preset;
  onChange(p: Preset): void;
  onSave(): void;
  onCancel(): void;
}

function drawBox(ctx: Ctx2D, r: Rect, color: string, selected: boolean, scale: number) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = (selected ? 3 : 2) * scale;
  ctx.strokeRect(r[0], r[1], r[2], r[3]);
  if (selected) {
    const s = 8 * scale;
    ctx.fillStyle = color;
    for (const [cx, cy] of [[r[0], r[1]], [r[0] + r[2], r[1]], [r[0], r[1] + r[3]], [r[0] + r[2], r[1] + r[3]]]) ctx.fillRect(cx - s / 2, cy - s / 2, s, s);
  }
  ctx.restore();
}

export function PresetEditor({ video, info, preset, onChange, onSave, onCancel }: Props) {
  const srcRef = useRef<HTMLCanvasElement>(null);
  const dstRef = useRef<HTMLCanvasElement>(null);
  const [selected, setSelected] = useState<string | null>(preset.layers[0]?.id ?? null);
  const [side, setSide] = useState<Side>('src');
  const latest = useRef({ preset, selected });
  latest.current = { preset, selected };
  const drag = useRef<{ side: Side; id: string; handle: Handle; x: number; y: number; orig: Rect } | null>(null);

  useEffect(() => {
    const sctx = srcRef.current?.getContext('2d');
    const dctx = dstRef.current?.getContext('2d');
    if (!sctx || !dctx || !video) return;
    let raf = 0;
    const tick = () => {
      const { preset, selected } = latest.current;
      if (video.readyState >= 2) {
        sctx.drawImage(video, 0, 0, info.width, info.height);
        drawFrame(dctx, video, info.width, info.height, preset, [], video.currentTime, VERTICAL_CANVAS, video.videoWidth || info.width, video.videoHeight || info.height);
      }
      preset.layers.forEach((l, i) => {
        const color = COLORS[i % COLORS.length];
        drawBox(sctx, fracToPx(l.src, info.width, info.height), color, l.id === selected, info.width / 800);
        drawBox(dctx, l.dst, color, l.id === selected, VERTICAL_CANVAS.w / 400);
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [video, info]);

  const bounds = (s: Side): [number, number] => (s === 'src' ? [info.width, info.height] : [VERTICAL_CANVAS.w, VERTICAL_CANVAS.h]);
  const rectsFor = (s: Side) => preset.layers.map((l) => ({ id: l.id, rect: s === 'src' ? fracToPx(l.src, info.width, info.height) : l.dst }));
  const toPoint = (s: Side, e: PointerEvent) => {
    const c = (s === 'src' ? srcRef : dstRef).current!;
    const r = c.getBoundingClientRect();
    const k = c.width / r.width;
    return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k, k };
  };

  const updateLayer = (l: Layer) => onChange({ ...preset, layers: preset.layers.map((x) => (x.id === l.id ? l : x)) });
  const setRect = (s: Side, id: string, rect: Rect) => {
    const l = preset.layers.find((x) => x.id === id)!;
    updateLayer(s === 'src' ? { ...l, src: pxToFrac(rect, info.width, info.height) } : { ...l, dst: rect.map(Math.round) as Rect });
  };

  const down = (s: Side) => (e: PointerEvent<HTMLCanvasElement>) => {
    const p = toPoint(s, e);
    setSide(s);
    const rects = rectsFor(s);
    const hit = hitRect(rects, p.x, p.y, HANDLE_SCREEN_PX * p.k);
    if (!hit) return;
    setSelected(hit.id);
    drag.current = { side: s, id: hit.id, handle: hit.handle, x: p.x, y: p.y, orig: rects.find((r) => r.id === hit.id)!.rect };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const move = (s: Side) => (e: PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d || d.side !== s) return;
    const p = toPoint(s, e);
    const [bw, bh] = bounds(s);
    let r = dragRect(d.orig, d.handle, p.x - d.x, p.y - d.y, bw, bh);
    if (!e.altKey) {
      const others = rectsFor(s).filter((o) => o.id !== d.id).map((o) => o.rect);
      r = snapRect(r, d.handle, guidesFor(bw, bh, others), SNAP_SCREEN_PX * p.k, bw, bh);
    }
    setRect(s, d.id, r);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!selected || (e.target as HTMLElement).tagName === 'INPUT') return;
    const [bw, bh] = bounds(side);
    const cur = rectsFor(side).find((r) => r.id === selected);
    const next = cur && nudgeRect(cur.rect, e.key, e.shiftKey ? 10 : 1, bw, bh);
    if (next) {
      e.preventDefault();
      setRect(side, selected, next);
    }
  };

  const addLayer = () => {
    const id = `layer-${Date.now().toString(36)}`;
    onChange({ ...preset, layers: [...preset.layers, { id, label: 'New layer', src: [0.4, 0.4, 0.2, 0.2], dst: [340, 760, 400, 400], fit: 'contain' }] });
    setSelected(id);
  };
  const deleteLayer = (id: string) => {
    const layers = preset.layers.filter((l) => l.id !== id);
    onChange({ ...preset, layers });
    setSelected(layers[0]?.id ?? null);
  };
  const moveLayer = (id: string, dir: -1 | 1) => {
    const i = preset.layers.findIndex((l) => l.id === id);
    const j = i + dir;
    if (j < 0 || j >= preset.layers.length) return;
    const layers = [...preset.layers];
    [layers[i], layers[j]] = [layers[j], layers[i]];
    onChange({ ...preset, layers });
  };
  const setBackground = (type: Background['type']) =>
    onChange({ ...preset, background: type === 'blur' ? { type, amount: 30 } : type === 'color' ? { type, color: '#000000' } : { type } });

  const sel = preset.layers.find((l) => l.id === selected);

  return (
    <div className="editor" tabIndex={0} onKeyDown={onKeyDown}>
      <div className="editor-canvases">
        <canvas ref={srcRef} className="editor-src" width={info.width} height={info.height} aria-label="Source frame" onPointerDown={down('src')} onPointerMove={move('src')} onPointerUp={() => (drag.current = null)} />
        <canvas ref={dstRef} className="editor-dst" width={VERTICAL_CANVAS.w} height={VERTICAL_CANVAS.h} aria-label="Vertical layout" onPointerDown={down('dst')} onPointerMove={move('dst')} onPointerUp={() => (drag.current = null)} />
      </div>
      <div className="editor-panel">
        <label className="row">Name <input value={preset.name} onChange={(e) => onChange({ ...preset, name: e.target.value })} /></label>
        <label className="row">Game <input value={preset.game} onChange={(e) => onChange({ ...preset, game: e.target.value })} /></label>
        <label className="row">
          Background
          <select value={preset.background.type} onChange={(e) => setBackground(e.target.value as Background['type'])}>
            <option value="blur">Blurred gameplay</option>
            <option value="color">Solid color</option>
            <option value="none">None (black)</option>
          </select>
        </label>
        {preset.background.type === 'blur' && (
          <label className="row">Blur <input type="range" min={0} max={100} value={preset.background.amount} onChange={(e) => onChange({ ...preset, background: { type: 'blur', amount: Number(e.target.value) } })} /></label>
        )}
        {preset.background.type === 'color' && (
          <label className="row">Color <input type="color" value={preset.background.color} onChange={(e) => onChange({ ...preset, background: { type: 'color', color: e.target.value } })} /></label>
        )}
        <h2>Layers (bottom → top)</h2>
        <ul className="list">
          {preset.layers.map((l, i) => (
            <li key={l.id} className="row">
              <button className={l.id === selected ? 'selected' : ''} style={{ borderLeft: `4px solid ${COLORS[i % COLORS.length]}`, opacity: l.hidden ? 0.5 : 1 }} onClick={() => setSelected(l.id)}>{l.label}</button>
              <button aria-label={`Move ${l.label} down`} onClick={() => moveLayer(l.id, -1)}>↑</button>
              <button aria-label={`Move ${l.label} up`} onClick={() => moveLayer(l.id, 1)}>↓</button>
            </li>
          ))}
        </ul>
        <div className="row">
          <button onClick={addLayer}>Add layer</button>
          {sel && <button className="danger" disabled={preset.layers.length <= 1} onClick={() => deleteLayer(sel.id)}>Delete layer</button>}
        </div>
        {sel && (
          <div className="layer-edit">
            <label className="row">Label <input value={sel.label} onChange={(e) => updateLayer({ ...sel, label: e.target.value })} /></label>
            <label className="row">
              <input type="checkbox" checked={!sel.hidden} onChange={(e) => updateLayer({ ...sel, hidden: !e.target.checked })} /> Visible
            </label>
            <label className="row">
              Fit
              <select value={sel.fit} onChange={(e) => updateLayer({ ...sel, fit: e.target.value as Fit })}>
                <option value="cover">Fill box (crop)</option>
                <option value="contain">Fit inside box</option>
              </select>
            </label>
            <label className="row">Corner radius <input type="number" min={0} max={200} value={sel.radius ?? 0} onChange={(e) => updateLayer({ ...sel, radius: Math.max(0, Number(e.target.value)) || undefined })} /></label>
            <label className="row">
              <input type="checkbox" checked={!!sel.border} onChange={(e) => updateLayer({ ...sel, border: e.target.checked ? { width: 4, color: '#ffffff' } : undefined })} /> Border
            </label>
            {sel.border && (
              <div className="row">
                <input type="number" min={1} max={40} aria-label="Border width" value={sel.border.width} onChange={(e) => updateLayer({ ...sel, border: { ...sel.border!, width: Math.max(1, Number(e.target.value)) } })} />
                <input type="color" aria-label="Border color" value={sel.border.color} onChange={(e) => updateLayer({ ...sel, border: { ...sel.border!, color: e.target.value } })} />
              </div>
            )}
          </div>
        )}
        <p className="hint">Drag boxes to move, corners to resize. Hold Alt to turn off snapping. Arrow keys nudge 1px, Shift+arrow 10px.</p>
        <div className="row">
          <button onClick={onSave}>Save preset</button>
          <button onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
