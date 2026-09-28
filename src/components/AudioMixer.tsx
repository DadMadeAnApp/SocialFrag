import { useEffect, useRef, useState, type InputHTMLAttributes } from 'react';
import { updateTrack } from '../audio/lanes';
import { AUDIO_LIMITS, type AudioMix, type Duck, type TrackMix } from '../types';

interface Props {
  mix: AudioMix;
  notice: string | null;
  previewError: string | null;
  hasAudio: boolean;
  /** Ducking needs envelopes from prepareAudio. */
  canDuck: boolean;
  onChange(mix: AudioMix): void;
  onSaveToPreset(): void;
}

const num = (v: string, fallback: number) => (Number.isFinite(Number.parseFloat(v)) ? Number.parseFloat(v) : fallback);
const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));

interface NumberFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> {
  value: number;
  onCommit(n: number): void;
}

/**
 * A number input that holds its own string while typing, so a partial or in-progress entry
 * (clearing the field, typing just "-") isn't clobbered by the committed numeric value on every
 * keystroke. Commits (calls onCommit) as soon as the text parses to a finite number, and also on
 * blur/Enter; an unparseable value on blur reverts to the last committed value.
 */
export function NumberField({ value, onCommit, ...rest }: NumberFieldProps) {
  const [text, setText] = useState(String(value));
  const lastCommitted = useRef(value);
  useEffect(() => {
    if (value !== lastCommitted.current) {
      lastCommitted.current = value;
      setText(String(value));
    }
  }, [value]);
  const commit = () => {
    const n = Number.parseFloat(text);
    if (Number.isFinite(n)) {
      lastCommitted.current = n;
      onCommit(n);
    } else {
      setText(String(value));
    }
  };
  return (
    <input
      // type="text": a native type="number" input silently coerces an in-progress value like "-"
      // to "" (it isn't a valid float yet), so it can never render what the user is mid-typing.
      type="text"
      inputMode="decimal"
      {...rest}
      value={text}
      onChange={(e) => {
        const t = e.target.value;
        setText(t);
        const n = Number.parseFloat(t);
        if (Number.isFinite(n) && t.trim() !== '') {
          lastCommitted.current = n;
          onCommit(n);
        }
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
    />
  );
}

function defaultDuck(tracks: TrackMix[]): Duck {
  const voice = tracks.filter((t) => /discord|mic|voice|chat/i.test(t.sourceLabel)).map((t) => t.index);
  const triggers = voice.length ? voice : tracks.slice(1).map((t) => t.index);
  const targets = tracks.filter((t) => !triggers.includes(t.index)).map((t) => t.index);
  return { targets, triggers, amountDb: -10, thresholdDb: -40, releaseS: 0.4 };
}

export function AudioMixer({ mix, notice, previewError, hasAudio, canDuck, onChange, onSaveToPreset }: Props) {
  if (!hasAudio) {
    return (
      <section className="panel">
        <h2>Audio</h2>
        <p className="hint">No audio in this clip.</p>
      </section>
    );
  }
  const set = (t: TrackMix, patch: Partial<TrackMix>) => onChange(updateTrack(mix, t.index, patch));
  const setDuck = (patch: Partial<Duck>) => mix.duck && onChange({ ...mix, duck: { ...mix.duck, ...patch } });
  const toggleIn = (list: number[], i: number) => (list.includes(i) ? list.filter((x) => x !== i) : [...list, i]);

  return (
    <section className="panel audio-mixer">
      <h2>Audio</h2>
      {notice && <p className="hint" role="status">{notice}</p>}
      {previewError && <p className="hint">{previewError}</p>}
      {mix.tracks.map((t) => (
        <div key={t.index} className={`track-row${t.enabled ? '' : ' removed'}`}>
          <div className="track-head">
            <input aria-label={`${t.sourceLabel} name`} value={t.label} maxLength={64} onChange={(e) => set(t, { label: e.target.value })} />
            {t.enabled ? (
              <button aria-label={`Remove ${t.label}`} onClick={() => set(t, { enabled: false })}>✕</button>
            ) : (
              <button aria-label={`Restore ${t.label}`} onClick={() => set(t, { enabled: true })}>Restore</button>
            )}
          </div>
          <fieldset disabled={!t.enabled}>
            <label>
              Gain
              <input type="range" min={0} max={200} step={1} value={Math.round(t.gain * 100)} onChange={(e) => set(t, { gain: clamp(num(e.target.value, 100) / 100, AUDIO_LIMITS.gain) })} />
              <NumberField aria-label={`${t.label} gain %`} min={0} max={200} value={Math.round(t.gain * 100)} onCommit={(v) => set(t, { gain: clamp(v / 100, AUDIO_LIMITS.gain) })} />
            </label>
            <label>
              <input type="checkbox" aria-label={`${t.label} ceiling on`} checked={t.ceilingDb !== null} onChange={(e) => set(t, { ceilingDb: e.target.checked ? -3 : null })} />
              Ceiling
              <input type="range" min={-24} max={0} step={0.5} disabled={t.ceilingDb === null} value={t.ceilingDb ?? 0} onChange={(e) => set(t, { ceilingDb: clamp(num(e.target.value, -3), AUDIO_LIMITS.ceilingDb) })} />
              <span>{t.ceilingDb === null ? 'off' : `${t.ceilingDb} dB`}</span>
            </label>
            <label>
              Offset (s)
              <NumberField aria-label={`${t.label} offset`} min={-2} max={2} step={0.01} value={t.offsetS} onCommit={(v) => set(t, { offsetS: clamp(v, AUDIO_LIMITS.offsetS) })} />
            </label>
            <label>
              Fade in (s)
              <NumberField aria-label={`${t.label} fade in`} min={0} step={0.1} value={t.fadeInS} onCommit={(v) => set(t, { fadeInS: Math.max(0, v) })} />
            </label>
            <label>
              Fade out (s)
              <NumberField aria-label={`${t.label} fade out`} min={0} step={0.1} value={t.fadeOutS} onCommit={(v) => set(t, { fadeOutS: Math.max(0, v) })} />
            </label>
          </fieldset>
        </div>
      ))}
      <fieldset className="duck" disabled={!canDuck || mix.tracks.length < 2}>
        <label>
          <input type="checkbox" aria-label="Duck" checked={mix.duck !== null} onChange={(e) => onChange({ ...mix, duck: e.target.checked ? defaultDuck(mix.tracks) : null })} />
          Duck (lower some tracks while others talk)
        </label>
        {!canDuck && <p className="hint">Ducking needs the audio preview.</p>}
        {mix.duck && (
          <>
            {mix.tracks.map((t) => (
              <div key={t.index} className="duck-row">
                <span>{t.label}</span>
                <label><input type="checkbox" checked={mix.duck!.targets.includes(t.index)} onChange={() => setDuck({ targets: toggleIn(mix.duck!.targets, t.index) })} /> lowered</label>
                <label><input type="checkbox" checked={mix.duck!.triggers.includes(t.index)} onChange={() => setDuck({ triggers: toggleIn(mix.duck!.triggers, t.index) })} /> triggers</label>
              </div>
            ))}
            <label>
              Amount
              <input type="range" min={-24} max={0} step={1} value={mix.duck.amountDb} onChange={(e) => setDuck({ amountDb: clamp(num(e.target.value, -10), AUDIO_LIMITS.amountDb) })} />
              <span>{mix.duck.amountDb} dB</span>
            </label>
            <details>
              <summary>Advanced</summary>
              <label>
                Threshold (dB)
                <NumberField min={-60} max={0} value={mix.duck.thresholdDb} onCommit={(v) => setDuck({ thresholdDb: clamp(v, AUDIO_LIMITS.thresholdDb) })} />
              </label>
              <label>
                Release (s)
                <NumberField min={0.05} max={2} step={0.05} value={mix.duck.releaseS} onCommit={(v) => setDuck({ releaseS: clamp(v, AUDIO_LIMITS.releaseS) })} />
              </label>
            </details>
          </>
        )}
      </fieldset>
      <button onClick={onSaveToPreset}>Save mix to preset</button>
    </section>
  );
}
