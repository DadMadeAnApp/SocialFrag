import { curveLength, mixCurves, sliceCurve } from '../audio/curve';
import { duckCurve } from '../audio/duck';
import { enabledDuckTriggers } from '../audio/lanes';
import type { TimelineClip } from './model';

export interface ClipCurves {
  /** Export: gain per track in source time over [inS, outS). */
  source: Map<number, Float32Array>;
  /** Preview: the same gain in timeline time over the clip's duration. */
  timeline: Map<number, Float32Array>;
}

/** Timeline sample j plays source sample j * speed. */
export function resampleCurve(c: Float32Array, speed: number): Float32Array {
  if (speed === 1) return c;
  const out = new Float32Array(Math.max(0, Math.round(c.length / speed)));
  for (let j = 0; j < out.length; j++) out[j] = c[Math.min(c.length - 1, Math.floor(j * speed))];
  return out;
}

export function computeClipCurves(clip: TimelineClip, sourceDuration: number, envelopes: Map<number, Float32Array> | null): ClipCurves {
  const trim = { inS: clip.inS, outS: clip.outS };
  const triggers = envelopes
    ? enabledDuckTriggers(clip.mix)
        .map((i) => envelopes.get(i))
        .filter((e): e is Float32Array => !!e)
    : [];
  const duck = clip.mix.duck && triggers.length ? duckCurve(triggers, clip.mix.duck, curveLength(sourceDuration)) : null;
  const full = mixCurves(clip.mix, trim, sourceDuration, duck);
  const source = new Map([...full].map(([i, c]) => [i, sliceCurve(c, trim)] as const));
  const timeline = new Map([...source].map(([i, c]) => [i, resampleCurve(c, clip.speed)] as const));
  return { source, timeline };
}

/** Memo keyed by clip object identity: project edits are immutable, so untouched clips hit the cache. */
export function makeCurveCache() {
  const cache = new WeakMap<TimelineClip, { env: Map<number, Float32Array> | null; duration: number; value: ClipCurves }>();
  return (clip: TimelineClip, sourceDuration: number, envelopes: Map<number, Float32Array> | null): ClipCurves => {
    const hit = cache.get(clip);
    if (hit && hit.env === envelopes && hit.duration === sourceDuration) return hit.value;
    const value = computeClipCurves(clip, sourceDuration, envelopes);
    cache.set(clip, { env: envelopes, duration: sourceDuration, value });
    return value;
  };
}
