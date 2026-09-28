import type { AudioMix, MuteRange, TrackMix } from '../types';
import { mergeMutes } from './curve';

export const MIN_MUTE_S = 0.05;

export function addMute(mutes: MuteRange[], a: number, b: number, duration: number): MuteRange[] {
  const startS = Math.min(a, b);
  const endS = Math.max(a, b);
  if (endS - startS < MIN_MUTE_S) return mutes;
  return mergeMutes([...mutes, { startS, endS }], duration);
}

export function resizeMute(
  mutes: MuteRange[],
  i: number,
  edge: 'start' | 'end',
  t: number,
  duration: number,
): { mutes: MuteRange[]; i: number } {
  const next = mutes.map((m) => ({ ...m }));
  const m = next[i];
  if (!m) return { mutes: mergeMutes(next, duration), i: -1 };
  if (edge === 'start') m.startS = Math.min(t, m.endS - MIN_MUTE_S);
  else m.endS = Math.max(t, m.startS + MIN_MUTE_S);
  const merged = mergeMutes(next, duration);
  const draggedT = edge === 'start' ? m.startS : m.endS;
  const newI = merged.findIndex((r) => draggedT >= r.startS - 1e-9 && draggedT <= r.endS + 1e-9);
  return { mutes: merged, i: newI };
}

export const removeMute = (mutes: MuteRange[], i: number) => mutes.filter((_, j) => j !== i);

/** Duck triggers that are currently enabled in the mix (a removed track shouldn't drive ducking). */
export function enabledDuckTriggers(mix: AudioMix): number[] {
  const enabled = new Set(mix.tracks.filter((t) => t.enabled).map((t) => t.index));
  return (mix.duck?.triggers ?? []).filter((i) => enabled.has(i));
}

export const updateTrack = (mix: AudioMix, index: number, patch: Partial<TrackMix>): AudioMix => ({
  ...mix,
  tracks: mix.tracks.map((t) => (t.index === index ? { ...t, ...patch } : t)),
});
