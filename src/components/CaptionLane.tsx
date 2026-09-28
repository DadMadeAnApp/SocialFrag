import { useRef, type PointerEvent } from 'react';
import { TRACK_COLORS } from '../captions/defaults';
import type { LaidClip } from '../timeline/model';
import type { Caption } from '../types';

export interface CaptionLaneProps {
  laid: LaidClip[];
  pps: number;
  selectedCaptionId: string | null;
  onSelect(clipId: string, captionId: string): void;
  /** New start/end in source seconds (end undefined = to the clip's end). */
  onRetime(clipId: string, captionId: string, start: number, end: number | undefined): void;
}

const MIN_S = 0.1;

type Drag = { e: LaidClip; c: Caption; edge: 'start' | 'end'; x0: number };

/** One block per caption at its timeline time; drag an edge to retime it. */
export function CaptionLane({ laid, pps, selectedCaptionId, onSelect, onRetime }: CaptionLaneProps) {
  const drag = useRef<Drag | null>(null);

  const span = (e: LaidClip, c: Caption): [number, number] | null => {
    const clipEnd = e.startS + e.durS;
    if (e.clip.kind === 'freeze') return c.start <= e.clip.inS + 1e-3 && (c.end ?? Infinity) > e.clip.inS ? [e.startS, clipEnd] : null;
    const at = (s: number) => e.startS + (s - e.clip.inS) / e.clip.speed;
    const s = Math.max(e.startS, at(c.start));
    const t = Math.min(clipEnd, c.end === undefined ? clipEnd : at(c.end));
    return t > s ? [s, t] : null;
  };

  const startEdge = (e: LaidClip, c: Caption, edge: 'start' | 'end') => (ev: PointerEvent<HTMLSpanElement>) => {
    ev.stopPropagation();
    ev.currentTarget.setPointerCapture?.(ev.pointerId);
    drag.current = { e, c, edge, x0: ev.clientX };
  };

  const onMove = (ev: PointerEvent<HTMLSpanElement>) => {
    const d = drag.current;
    if (!d) return;
    const deltaSrc = ((ev.clientX - d.x0) / pps) * d.e.clip.speed;
    const { inS, outS } = d.e.clip;
    const end = d.c.end ?? outS;
    if (d.edge === 'start') {
      const start = Math.min(Math.max(inS, d.c.start + deltaSrc), end - MIN_S);
      onRetime(d.e.clip.id, d.c.id, start, d.c.end);
    } else {
      onRetime(d.e.clip.id, d.c.id, d.c.start, Math.max(Math.min(outS, end + deltaSrc), d.c.start + MIN_S));
    }
  };

  return (
    <div className="tl-captions" aria-label="Caption lane">
      {laid.flatMap((e) =>
        e.clip.captions.map((c) => {
          const s = span(e, c);
          if (!s) return null;
          return (
            <button
              key={`${e.clip.id}:${c.id}`}
              aria-label={`Caption: ${c.text}`}
              className={`tl-caption${c.id === selectedCaptionId ? ' selected' : ''}`}
              style={{ left: `${s[0] * pps}px`, width: `${Math.max(2, (s[1] - s[0]) * pps)}px`, background: c.color ?? TRACK_COLORS[0] }}
              onPointerDown={(ev) => ev.stopPropagation()}
              onClick={() => onSelect(e.clip.id, c.id)}
            >
              <span className="tl-caption-text">{c.text}</span>
              {e.clip.kind === 'video' && (
                <>
                  <span className="tl-caption-edge start" aria-label={`Caption start: ${c.text}`} onPointerDown={startEdge(e, c, 'start')} onPointerMove={onMove} onPointerUp={() => (drag.current = null)} />
                  <span className="tl-caption-edge end" aria-label={`Caption end: ${c.text}`} onPointerDown={startEdge(e, c, 'end')} onPointerMove={onMove} onPointerUp={() => (drag.current = null)} />
                </>
              )}
            </button>
          );
        }),
      )}
    </div>
  );
}
