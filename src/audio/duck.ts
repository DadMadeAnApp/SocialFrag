import type { Duck } from '../types';
import { SAMPLE_RATE } from './curve';

const ATTACK_S = 0.05;

/** Envelopes are linear RMS at SAMPLE_RATE. Returns a gain (1 = no duck) per sample. */
export function duckCurve(triggerEnvelopes: Float32Array[], duck: Duck, length: number): Float32Array {
  const out = new Float32Array(length);
  const floor = 10 ** (duck.amountDb / 20);
  const threshold = 10 ** (duck.thresholdDb / 20);
  const down = 1 - Math.exp(-1 / (ATTACK_S * SAMPLE_RATE));
  const up = 1 - Math.exp(-1 / (duck.releaseS * SAMPLE_RATE));
  let g = 1;
  for (let i = 0; i < length; i++) {
    let level = 0;
    for (const e of triggerEnvelopes) level = Math.max(level, e[i] ?? 0);
    const target = level > threshold ? floor : 1;
    g += (target - g) * (target < g ? down : up);
    out[i] = Math.abs(g - 1) < 1e-6 ? 1 : g;
  }
  return out;
}
