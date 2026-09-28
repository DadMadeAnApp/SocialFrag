import { useEffect, useRef, useState, type JSX, type PointerEvent } from 'react';
import { formatTime } from '../state/trim';
import { projectDuration, type LaidClip, type TimelineClip } from '../timeline/model';
import type { TimelinePlayer } from '../timeline/player';
import { CaptionLane, type CaptionLaneProps } from './CaptionLane';
import type { EditorKeyHandlers } from './useEditorKeys';

const DEFAULT_PPS = 50;
const ZOOM_STEP = 1.5;
const PPS_LIMITS = [0.5, 400] as const;
const TICK_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const MIN_TICK_PX = 70;
const MOVE_THRESHOLD_PX = 4;
const END_PAD_PX = 16;

/** Toolbar edit handlers plus undo/redo availability, shared with the keyboard shortcuts in `useEditorKeys`. */
export interface TimelineTools extends EditorKeyHandlers {
  canUndo: boolean;
  canRedo: boolean;
}

interface Props {
  player: TimelinePlayer | null;
  laid: LaidClip[];
  nameOf(mediaId: string): string;
  thumbOf(clip: TimelineClip): string | null;
  selectedId: string | null;
  /** A media item pressed in the rail; released over the track, it is dropped here. */
  draggingMediaId: string | null;
  onSelect(id: string | null): void;
  /** Edge drag: `srcT` is the new in or out point in source seconds. */
  onTrim(id: string, edge: 'in' | 'out', srcT: number): void;
  onFreezeLength(id: string, seconds: number): void;
  onMove(id: string, toIndex: number): void;
  onDropMedia(mediaId: string, index: number): void;
  onAdd(): void;
  tools: TimelineTools;
  /** Caption blocks under the main track, on the same time scale. */
  captionLane?: Omit<CaptionLaneProps, 'laid' | 'pps'>;
}

const ICONS: Record<string, JSX.Element> = {
  stepBack: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden="true">
      <path d="M4 3v10" strokeLinecap="round" />
      <path d="M12 4 6 8l6 4Z" strokeLinejoin="round" />
    </svg>
  ),
  stepFwd: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden="true">
      <path d="M12 3v10" strokeLinecap="round" />
      <path d="M4 4l6 4-6 4Z" strokeLinejoin="round" />
    </svg>
  ),
  setIn: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden="true">
      <path d="M4 2v12" strokeLinecap="round" />
      <path d="M6 5h6M6 11h6" strokeLinecap="round" />
    </svg>
  ),
  setOut: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden="true">
      <path d="M12 2v12" strokeLinecap="round" />
      <path d="M4 5h6M4 11h6" strokeLinecap="round" />
    </svg>
  ),
  split: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden="true">
      <circle cx="4" cy="4" r="1.6" />
      <circle cx="4" cy="12" r="1.6" />
      <path d="M5.3 5.2 13 13M13 3 9 7" strokeLinecap="round" />
    </svg>
  ),
  delete: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden="true">
      <path d="M3 4.5h10M6 4.5V3h4v1.5M6.5 7.5v4M9.5 7.5v4" strokeLinecap="round" />
      <path d="M4 4.5 4.6 13h6.8l.6-8.5" strokeLinejoin="round" />
    </svg>
  ),
  freeze: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden="true">
      <path d="M8 1.5v13M2.5 4.5l11 7M13.5 4.5l-11 7" strokeLinecap="round" />
    </svg>
  ),
  undo: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden="true">
      <path d="M4 4v4h4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4.5 8A5 5 0 1 1 5.6 12" strokeLinecap="round" />
    </svg>
  ),
  redo: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden="true">
      <path d="M12 4v4H8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11.5 8A5 5 0 1 0 10.4 12" strokeLinecap="round" />
    </svg>
  ),
};

/** Prevents a toolbar button press from stealing keyboard focus, so Space still toggles play, not the button. */
const noFocus = (e: PointerEvent<HTMLButtonElement>) => e.preventDefault();

function ToolButton(props: { icon: keyof typeof ICONS; label: string; onClick(): void; disabled?: boolean }) {
  return (
    <button type="button" className="tl-tool" aria-label={props.label} title={props.label} disabled={props.disabled} onPointerDown={noFocus} onClick={props.onClick}>
      {ICONS[props.icon]}
    </button>
  );
}

type Drag =
  | { kind: 'seek' }
  | { kind: 'trim'; e: LaidClip; edge: 'in' | 'out'; x0: number }
  | { kind: 'move'; e: LaidClip; x0: number; moved: boolean };

/** Where a clip dropped at timeline time t lands: after every other clip whose middle is left of t. */
export function dropIndex(laid: LaidClip[], t: number, skipId?: string): number {
  return laid.filter((e) => e.clip.id !== skipId && e.startS + e.durS / 2 < t).length;
}

export const tickStep = (pps: number) => TICK_STEPS.find((s) => s * pps >= MIN_TICK_PX) ?? TICK_STEPS[TICK_STEPS.length - 1];

function markerTime(laid: LaidClip[], index: number, total: number, skipId?: string) {
  const others = laid.filter((e) => e.clip.id !== skipId);
  return others[index]?.startS ?? total;
}

export function Timeline(props: Props) {
  const { player, laid, selectedId, draggingMediaId, tools } = props;
  const noClips = !laid.length || !player;
  const total = projectDuration(laid);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [pps, setPps] = useState(DEFAULT_PPS);
  const [fitted, setFitted] = useState(false);
  const [now, setNow] = useState(0);
  const [paused, setPaused] = useState(true);
  const [insertAt, setInsertAt] = useState<number | null>(null);

  // Fit the whole timeline to the view the first time there is something to fit (and on "Fit").
  useEffect(() => {
    const w = scrollRef.current?.clientWidth ?? 0;
    if (fitted || w <= 0 || total <= 0) return;
    setPps(Math.min(PPS_LIMITS[1], Math.max(PPS_LIMITS[0], (w - END_PAD_PX) / total)));
    setFitted(true);
  }, [total, fitted]);

  useEffect(() => {
    if (!player) return;
    let raf = 0;
    // Only set state on change, so a paused player doesn't re-render the timeline every frame.
    let lastNow = NaN;
    let lastPaused: boolean | null = null;
    const tick = () => {
      if (player.currentTime !== lastNow) setNow((lastNow = player.currentTime));
      if (player.paused !== lastPaused) setPaused((lastPaused = player.paused));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [player]);

  const timeAt = (clientX: number) => {
    const r = contentRef.current!.getBoundingClientRect();
    return Math.min(total, Math.max(0, (clientX - r.left) / pps));
  };
  const capture = (e: PointerEvent<HTMLElement>) => contentRef.current?.setPointerCapture?.(e.pointerId);

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = { kind: 'seek' };
    capture(e);
    if (player) player.currentTime = timeAt(e.clientX);
  };
  const startClip = (entry: LaidClip) => (e: PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    drag.current = { kind: 'move', e: entry, x0: e.clientX, moved: false };
    capture(e);
  };
  const startEdge = (entry: LaidClip, edge: 'in' | 'out') => (e: PointerEvent<HTMLSpanElement>) => {
    e.stopPropagation();
    drag.current = { kind: 'trim', e: entry, edge, x0: e.clientX };
    capture(e);
  };

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) {
      if (draggingMediaId) setInsertAt(markerTime(laid, dropIndex(laid, timeAt(e.clientX)), total));
      return;
    }
    if (d.kind === 'seek') {
      if (player) player.currentTime = timeAt(e.clientX);
      return;
    }
    const dt = (e.clientX - d.x0) / pps;
    const c = d.e.clip;
    if (d.kind === 'trim') {
      if (c.kind === 'freeze') props.onFreezeLength(c.id, d.e.durS + dt);
      else props.onTrim(c.id, d.edge, (d.edge === 'in' ? c.inS : c.outS) + dt * c.speed);
      return;
    }
    if (!d.moved && Math.abs(e.clientX - d.x0) < MOVE_THRESHOLD_PX) return;
    d.moved = true;
    setInsertAt(markerTime(laid, dropIndex(laid, timeAt(e.clientX), c.id), total, c.id));
  };

  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    setInsertAt(null);
    if (!d) {
      if (draggingMediaId) props.onDropMedia(draggingMediaId, dropIndex(laid, timeAt(e.clientX)));
      return;
    }
    if (d.kind !== 'move') return;
    if (!d.moved) props.onSelect(d.e.clip.id);
    else props.onMove(d.e.clip.id, dropIndex(laid, timeAt(e.clientX), d.e.clip.id));
  };

  const step = tickStep(pps);
  const ticks: number[] = [];
  for (let t = 0; t <= total && ticks.length < 2000; t += step) ticks.push(t);

  return (
    <div className="tl">
      <div className="tl-toolbar">
        <button className="play" aria-label={paused ? 'Play' : 'Pause'} disabled={!player || !laid.length} onClick={() => player && (player.paused ? void player.play() : player.pause())}>
          {paused ? '▶' : '❚❚'}
        </button>
        <span className="tl-time">
          {formatTime(now)} / {formatTime(total)}
        </span>
        <ToolButton icon="stepBack" label="Previous frame (←)" onClick={() => tools.step(-1)} disabled={noClips} />
        <ToolButton icon="stepFwd" label="Next frame (→)" onClick={() => tools.step(1)} disabled={noClips} />
        <span className="tl-sep" aria-hidden="true" />
        <ToolButton icon="setIn" label="Set in (I)" onClick={tools.setIn} disabled={noClips} />
        <ToolButton icon="setOut" label="Set out (O)" onClick={tools.setOut} disabled={noClips} />
        <span className="tl-sep" aria-hidden="true" />
        <ToolButton icon="split" label="Split (S)" onClick={tools.split} disabled={noClips} />
        <ToolButton icon="delete" label="Delete clip (Delete)" onClick={tools.remove} disabled={!selectedId} />
        <ToolButton icon="freeze" label="Freeze frame (F)" onClick={tools.freeze} disabled={noClips} />
        <span className="tl-sep" aria-hidden="true" />
        <ToolButton icon="undo" label="Undo (Ctrl+Z)" onClick={tools.undo} disabled={!tools.canUndo} />
        <ToolButton icon="redo" label="Redo (Ctrl+Shift+Z)" onClick={tools.redo} disabled={!tools.canRedo} />
        <span className="tl-zoom">
          <button aria-label="Zoom out" onClick={() => setPps((p) => Math.max(PPS_LIMITS[0], p / ZOOM_STEP))}>−</button>
          <button onClick={() => setFitted(false)}>Fit</button>
          <button aria-label="Zoom in" onClick={() => setPps((p) => Math.min(PPS_LIMITS[1], p * ZOOM_STEP))}>+</button>
        </span>
        <button onClick={props.onAdd}>Add clips</button>
      </div>
      <div ref={scrollRef} className="tl-scroll">
        <div ref={contentRef} className="tl-content" style={{ width: `max(100%, ${total * pps + END_PAD_PX}px)` }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
          <div className="tl-ruler" aria-label="Timeline ruler">
            {ticks.map((t) => (
              <span key={t} className="tl-tick" style={{ left: `${t * pps}px` }}>
                {formatTime(t)}
              </span>
            ))}
          </div>
          <div className="tl-track" aria-label="Main track">
            {laid.map((e, i) => {
              const thumb = props.thumbOf(e.clip);
              const freeze = e.clip.kind === 'freeze';
              return (
                <div
                  key={e.clip.id}
                  role="button"
                  tabIndex={0}
                  aria-pressed={e.clip.id === selectedId}
                  aria-label={`Clip ${i + 1}: ${props.nameOf(e.clip.mediaId)}`}
                  className={`tl-clip${freeze ? ' freeze' : ''}${e.clip.id === selectedId ? ' selected' : ''}`}
                  style={{ left: `${e.startS * pps}px`, width: `${Math.max(2, e.durS * pps)}px` }}
                  onPointerDown={startClip(e)}
                  onKeyDown={(k) => k.key === 'Enter' && props.onSelect(e.clip.id)}
                >
                  {thumb && <img className="tl-thumb" src={thumb} alt="" draggable={false} />}
                  <span className="tl-label">
                    {freeze ? 'Freeze' : props.nameOf(e.clip.mediaId)}
                    {!freeze && e.clip.speed !== 1 ? ` · ${e.clip.speed}×` : ''}
                  </span>
                  {!freeze && <span className="tl-handle in" aria-label={`Trim start of clip ${i + 1}`} onPointerDown={startEdge(e, 'in')} />}
                  <span className="tl-handle out" aria-label={`Trim end of clip ${i + 1}`} onPointerDown={startEdge(e, 'out')} />
                </div>
              );
            })}
            {insertAt !== null && <div className="tl-insert" style={{ left: `${insertAt * pps}px` }} />}
          </div>
          {props.captionLane && <CaptionLane laid={laid} pps={pps} {...props.captionLane} />}
          <div className="tl-playhead" style={{ left: `${now * pps}px` }} />
        </div>
      </div>
      <div className="hint">Space play · S split · Delete remove · F freeze · I/O trim to playhead · ←/→ frame · Ctrl+Z undo · drag clips to reorder, edges to trim</div>
    </div>
  );
}
