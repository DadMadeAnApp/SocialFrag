import { useState } from 'react';
import { STYLE_LABELS } from '../render/captions';
import { editCaption, newCaption, removeCaption, updateCaption } from '../state/captions';
import type { Caption, CaptionStyle, TrackCaptionStyle } from '../types';

interface Props {
  captions: Caption[];
  selectedId: string | null;
  video: HTMLVideoElement | null;
  onChange(captions: Caption[]): void;
  onSelect(id: string | null): void;
  onRun(scope: 'timeline' | 'clip'): void;
  onMerge(id: string): void;
  trackStyles: { trackIndex: number; label: string; style: TrackCaptionStyle }[];
  onTrackStyle(trackIndex: number, s: TrackCaptionStyle): void;
}

const STYLES = Object.keys(STYLE_LABELS) as CaptionStyle[];

const clock = (s: number) => {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
};
const range = (c: Caption) => `${clock(c.start)}–${c.end === undefined ? 'end' : clock(c.end)}`;

export function CaptionTool({ captions, selectedId, video, onChange, onSelect, onRun, onMerge, trackStyles, onTrackStyle }: Props) {
  const [scope, setScope] = useState<'timeline' | 'clip'>('timeline');
  const sel = captions.find((c) => c.id === selectedId) ?? null;
  const set = (c: Caption) => {
    const prev = captions.find((x) => x.id === c.id);
    onChange(updateCaption(captions, prev ? editCaption(prev, c) : c));
  };
  const rows = [...captions].sort((a, b) => a.start - b.start);

  const add = () => {
    const c = newCaption(crypto.randomUUID(), video?.currentTime ?? 0, 'whole');
    onChange([...captions, c]);
    onSelect(c.id);
  };

  return (
    <section className="panel">
      <h2>Captions</h2>
      <div className="row wrap">
        <button onClick={add}>Add caption</button>
        <select aria-label="Auto-caption scope" value={scope} onChange={(e) => setScope(e.target.value as 'timeline' | 'clip')}>
          <option value="timeline">Whole timeline</option>
          <option value="clip">This clip</option>
        </select>
        <button onClick={() => onRun(scope)}>Auto-caption</button>
      </div>
      {trackStyles.length > 0 && (
        <fieldset className="track-styles">
          <legend>Track styles</legend>
          {trackStyles.map((t) => (
            <div key={t.trackIndex} className="row">
              <span>{t.label}</span>
              <select aria-label={`${t.label} style`} value={t.style.style} onChange={(e) => onTrackStyle(t.trackIndex, { ...t.style, style: e.target.value as CaptionStyle })}>
                {STYLES.map((s) => (
                  <option key={s} value={s}>
                    {STYLE_LABELS[s]}
                  </option>
                ))}
              </select>
              <input type="color" aria-label={`${t.label} colour`} value={t.style.color.toLowerCase()} onChange={(e) => onTrackStyle(t.trackIndex, { ...t.style, color: e.target.value })} />
            </div>
          ))}
        </fieldset>
      )}
      <ul className="list caption-rows">
        {rows.map((c) => (
          <li key={c.id} className={c.id === selectedId ? 'selected' : ''}>
            <button className="caption-time" onClick={() => onSelect(c.id)}>
              {range(c)}
            </button>
            <input
              id={c.id === selectedId ? 'caption-text' : undefined}
              aria-label="Caption text"
              value={c.text}
              style={c.color ? { borderLeftColor: c.color } : undefined}
              onFocus={() => onSelect(c.id)}
              onChange={(e) => set({ ...c, text: e.target.value })}
            />
          </li>
        ))}
      </ul>
      {sel && (
        <div className="caption-edit">
          <div className="row">
            <button onClick={() => onMerge(sel.id)} disabled={rows[rows.length - 1]?.id === sel.id}>
              Merge with next
            </button>
            <button
              className="danger"
              onClick={() => {
                onChange(removeCaption(captions, sel.id));
                onSelect(null);
              }}
            >
              Delete
            </button>
          </div>
          <label className="row">
            Style
            <select aria-label="Style" value={sel.style} onChange={(e) => set({ ...sel, style: e.target.value as CaptionStyle })}>
              {STYLES.map((s) => (
                <option key={s} value={s}>
                  {STYLE_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          {sel.end === undefined && (
            <fieldset>
              <legend>Show</legend>
              <label>
                <input type="radio" name="caption-timing" checked={sel.start === 0} onChange={() => set({ ...sel, start: 0 })} /> Whole clip
              </label>
              <label>
                <input
                  type="radio"
                  name="caption-timing"
                  checked={sel.start > 0}
                  onChange={() => set({ ...sel, start: Math.max(0.001, video?.currentTime ?? 0) })}
                />{' '}
                From current frame to end
              </label>
            </fieldset>
          )}
        </div>
      )}
    </section>
  );
}
