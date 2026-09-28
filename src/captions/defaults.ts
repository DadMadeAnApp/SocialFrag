import type { TrackCaptionStyle } from '../types';

export const TRACK_COLORS = ['#FFFFFF', '#FFE14D', '#4DD8FF', '#7CFF6B'];
const SILENT_DB = -60;

export const trackStyle = (order: number): TrackCaptionStyle => ({ style: 'tiktok', color: TRACK_COLORS[order % TRACK_COLORS.length], y: 0.82 });

const db = (v: number) => 20 * Math.log10(v);

/** env = RMS amplitude envelope (0..1, 200 per second, from prepareAudio). */
export function levelDb(env: Float32Array): { maxDb: number; meanDb: number } {
  let max = 0;
  let sum = 0;
  for (const v of env) {
    if (v > max) max = v;
    sum += v;
  }
  return { maxDb: db(max), meanDb: db(env.length ? sum / env.length : 0) };
}

/** Mic if it has any signal; else the loudest track that isn't Desktop Audio (the full mix); without envelopes, the first such track. */
export function defaultVoiceTracks(tracks: { label: string; env?: Float32Array }[]): string[] {
  const mic = tracks.find((t) => t.label === 'Mic');
  if (mic && (!mic.env || levelDb(mic.env).maxDb >= SILENT_DB)) return ['Mic'];
  const voices = tracks.filter((t) => t.label !== 'Desktop Audio' && t !== mic);
  if (!voices.length) return [];
  if (voices.every((t) => t.env)) {
    const loudest = voices.reduce((a, b) => (levelDb(b.env!).meanDb > levelDb(a.env!).meanDb ? b : a));
    return [loudest.label];
  }
  return [voices[0].label];
}

const VOICE_LABEL = /mic|discord|voice|chat|comms|teamspeak/i;

/** A track recorded from its own voice source (by its OBS name), rather than game or desktop audio. */
export const isVoiceSource = (label: string): boolean => VOICE_LABEL.test(label);
