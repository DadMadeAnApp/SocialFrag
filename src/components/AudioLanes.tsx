import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { SAMPLE_RATE } from '../audio/curve';
import { addMute, removeMute, resizeMute, updateTrack } from '../audio/lanes';
import type { AudioMix, ClipInfo, TrackMix, Trim } from '../types';

interface Props { video: HTMLVideoElement | null; info: ClipInfo; trim: Trim; mix: AudioMix; envelopes: Map<number, Float32Array>; onChange(mix: AudioMix): void }

type Drag =
  | { kind: 'new'; from: number; to: number }
  | { kind: 'edge'; i: number; edge: 'start' | 'end' }
  | { kind: 'fade'; which: 'in' | 'out' }
  | { kind: 'offset'; x0: number; offset0: number };

function Waveform({ env, duration }: { env: Float32Array | undefined; duration: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx || !env || !duration) return;
    const w = (c.width = c.clientWidth || 600);
    const h = (c.height = c.clientHeight || 40);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'currentColor';
    const per = Math.max(1, Math.floor(env.length / w));
    for (let x = 0; x < w; x++) {
      let peak = 0;
      for (let i = x * per; i < (x + 1) * per && i < env.length; i++) peak = Math.max(peak, env[i]);
      const bar = Math.min(1, peak * 3) * h;
      ctx.fillRect(x, (h - bar) / 2, 1, bar);
    }
  }, [env, duration]);
  return <canvas ref={ref} className="lane-wave" />;
}

function Lane({ track, props }: { track: TrackMix; props: Props }) {
  const { info, trim, mix, envelopes, onChange } = props;
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [preview, setPreview] = useState<{ from: number; to: number } | null>(null);
  const d = info.duration;
  const pct = (s: number) => `${(d > 0 ? s / d : 0) * 100}%`;
  const timeAt = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / (r.width || 1))) * d;
  };
  const set = (patch: Partial<TrackMix>) => onChange(updateTrack(mix, track.index, patch));

  const begin = (mode: Drag) => (e: PointerEvent<HTMLElement>) => {
    e.stopPropagation();
    drag.current = mode;
    ref.current!.setPointerCapture(e.pointerId);
  };
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!track.enabled) return;
    const t = timeAt(e.clientX);
    drag.current = e.altKey ? { kind: 'offset', x0: t, offset0: track.offsetS } : { kind: 'new', from: t, to: t };
    ref.current!.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const g = drag.current;
    if (!g) return;
    const t = timeAt(e.clientX);
    if (g.kind === 'new') {
      g.to = t;
      setPreview({ from: Math.min(g.from, t), to: Math.max(g.from, t) });
    } else if (g.kind === 'edge') {
      const { mutes, i } = resizeMute(track.mutes, g.i, g.edge, t, d);
      set({ mutes });
      if (i === -1) drag.current = null;
      else g.i = i;
    }
    else if (g.kind === 'fade') set(g.which === 'in' ? { fadeInS: Math.max(0, t - trim.inS) } : { fadeOutS: Math.max(0, trim.outS - t) });
    else set({ offsetS: Math.min(2, Math.max(-2, Math.round((g.offset0 + t - g.x0) * 100) / 100)) });
  };
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    const g = drag.current;
    drag.current = null;
    setPreview(null);
    if (g?.kind === 'new') set({ mutes: addMute(track.mutes, g.from, timeAt(e.clientX), d) });
  };

  return (
    <div className={`lane${track.enabled ? '' : ' removed'}`}>
      <span className="lane-label">{track.label}</span>
      <div ref={ref} aria-label={`${track.label} lane`} className="lane-body" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
        <Waveform env={envelopes.get(track.index)} duration={d} />
        <div className="lane-trim" style={{ left: pct(trim.inS), width: pct(trim.outS - trim.inS) }} />
        {track.mutes.map((m, i) => (
          <div key={`${m.startS}-${m.endS}`} className="lane-mute" style={{ left: pct(m.startS), width: pct(m.endS - m.startS) }}>
            <span className="mute-edge start" onPointerDown={begin({ kind: 'edge', i, edge: 'start' })} />
            <button aria-label={`Remove mute ${m.startS.toFixed(1)}–${m.endS.toFixed(1)} s`} onPointerDown={(e) => e.stopPropagation()} onClick={() => set({ mutes: removeMute(track.mutes, i) })}>×</button>
            <span className="mute-edge end" onPointerDown={begin({ kind: 'edge', i, edge: 'end' })} />
          </div>
        ))}
        {preview && <div className="lane-mute pending" style={{ left: pct(preview.from), width: pct(preview.to - preview.from) }} />}
        <span className="fade-handle in" aria-label={`${track.label} fade in handle`} style={{ left: pct(trim.inS + track.fadeInS) }} onPointerDown={begin({ kind: 'fade', which: 'in' })} />
        <span className="fade-handle out" aria-label={`${track.label} fade out handle`} style={{ left: pct(trim.outS - track.fadeOutS) }} onPointerDown={begin({ kind: 'fade', which: 'out' })} />
      </div>
    </div>
  );
}

export function AudioLanes(props: Props) {
  const [now, setNow] = useState(0);
  const { video, info } = props;
  useEffect(() => {
    if (!video) return;
    let raf = 0;
    const tick = () => {
      setNow(video.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [video]);
  if (props.mix.tracks.length === 0) return null;
  return (
    <div className="lanes" style={{ ['--playhead' as string]: `${(info.duration ? now / info.duration : 0) * 100}%` }}>
      {props.mix.tracks.map((t) => (
        <Lane key={t.index} track={t} props={props} />
      ))}
      <div className="hint">Drag to mute · drag ▲ to fade · Alt+drag to shift sync · {SAMPLE_RATE} Hz curves</div>
    </div>
  );
}
