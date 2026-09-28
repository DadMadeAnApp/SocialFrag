import type { AudioMix, MuteRange, TrackMix, Trim } from '../types';

/** Gain curves are sampled at 200 Hz; the Rust export and the preview use the same samples. */
export const SAMPLE_RATE = 200;
export const RAMP_S = 0.03;

export const curveLength = (seconds: number) => Math.max(0, Math.round(seconds * SAMPLE_RATE));

export function mergeMutes(mutes: MuteRange[], duration: number): MuteRange[] {
  const clamped = mutes
    .map((m) => ({ startS: Math.max(0, Math.min(m.startS, m.endS)), endS: Math.min(duration, Math.max(m.startS, m.endS)) }))
    .filter((m) => m.endS > m.startS)
    .sort((a, b) => a.startS - b.startS);
  const out: MuteRange[] = [];
  for (const m of clamped) {
    const last = out[out.length - 1];
    if (last && m.startS <= last.endS) last.endS = Math.max(last.endS, m.endS);
    else out.push({ ...m });
  }
  return out;
}

function muteMask(t: number, ranges: MuteRange[]): number {
  let g = 1;
  for (const r of ranges) {
    if (t >= r.startS && t <= r.endS) return 0;
    if (t < r.startS && r.startS - t < RAMP_S) g = Math.min(g, (r.startS - t) / RAMP_S);
    if (t > r.endS && t - r.endS < RAMP_S) g = Math.min(g, (t - r.endS) / RAMP_S);
  }
  return g;
}

function fadeMask(t: number, track: TrackMix, trim: Trim): number {
  let g = 1;
  const span = trim.outS - trim.inS;
  const fin = Math.min(track.fadeInS, span);
  const fout = Math.min(track.fadeOutS, span);
  if (fin > 0 && t >= trim.inS && t < trim.inS + fin) g *= (t - trim.inS) / fin;
  if (fout > 0 && t > trim.outS - fout) g *= Math.max(0, (trim.outS - t) / fout);
  return g;
}

/** Gain over the whole clip (video time): gain × mutes × fades × duck. Offsets are applied to the audio, not the curve. */
export function buildCurve(track: TrackMix, trim: Trim, duration: number, duck?: Float32Array): Float32Array {
  const c = new Float32Array(curveLength(duration));
  if (!track.enabled) return c;
  const ranges = mergeMutes(track.mutes, duration);
  for (let i = 0; i < c.length; i++) {
    const t = i / SAMPLE_RATE;
    c[i] = track.gain * muteMask(t, ranges) * fadeMask(t, track, trim) * (duck ? (duck[i] ?? 1) : 1);
  }
  return c;
}

export function sliceCurve(curve: Float32Array, trim: Trim): Float32Array {
  const start = Math.round(trim.inS * SAMPLE_RATE);
  const out = new Float32Array(curveLength(trim.outS - trim.inS));
  const last = curve.length ? curve[curve.length - 1] : 0;
  for (let i = 0; i < out.length; i++) out[i] = curve[start + i] ?? last;
  return out;
}

export function encodeCurve(curve: Float32Array): string {
  const bytes = new Uint8Array(curve.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < curve.length; i++) view.setFloat32(i * 4, curve[i], true);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** duckGain is applied only to the mix's duck targets. */
export function mixCurves(mix: AudioMix, trim: Trim, duration: number, duckGain: Float32Array | null): Map<number, Float32Array> {
  const targets = new Set(mix.duck?.targets ?? []);
  return new Map(mix.tracks.map((t) => [t.index, buildCurve(t, trim, duration, duckGain && targets.has(t.index) ? duckGain : undefined)]));
}
