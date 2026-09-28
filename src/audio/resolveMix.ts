import type { AudioMix, AudioTrackInfo, Duck, Preset, PresetAudio, TrackMix } from '../types';

export const PRESET_MIX_NOTICE = "Couldn't apply the preset's audio mix — using all tracks.";
const DESKTOP = /desktop/i;

export const emptyMix = (): AudioMix => ({ tracks: [], duck: null });

function base(t: AudioTrackInfo, enabled: boolean): TrackMix {
  return { index: t.index, sourceLabel: t.label, label: t.label, enabled, gain: 1, ceilingDb: null, offsetS: 0, fadeInS: 0, fadeOutS: 0, mutes: [] };
}

function ruleB(t: AudioTrackInfo, all: AudioTrackInfo[]): TrackMix {
  const otherNamed = all.some((o) => o.index !== t.index && o.named && !DESKTOP.test(o.label));
  return base(t, !(t.named && DESKTOP.test(t.label) && otherNamed));
}

/** Per-clip edits (display label, fades, mutes) survive a re-resolve. */
function keepClipEdits(tracks: TrackMix[], keep?: AudioMix): TrackMix[] {
  if (!keep) return tracks;
  return tracks.map((t) => {
    const k = keep.tracks.find((o) => o.index === t.index && o.sourceLabel === t.sourceLabel);
    return k ? { ...t, label: k.label, fadeInS: k.fadeInS, fadeOutS: k.fadeOutS, mutes: k.mutes.map((m) => ({ ...m })) } : t;
  });
}

function mapDuck(tracks: AudioTrackInfo[], d: PresetAudio['duck']): Duck | null {
  if (!d) return null;
  const find = (labels: string[]) => tracks.filter((t) => labels.some((l) => l.toLowerCase() === t.label.toLowerCase())).map((t) => t.index);
  const targets = find(d.targets);
  const triggers = find(d.triggers);
  return targets.length && triggers.length ? { targets, triggers, amountDb: d.amountDb, thresholdDb: d.thresholdDb, releaseS: d.releaseS } : null;
}

export function resolveMix(tracks: AudioTrackInfo[], preset: Preset, keep?: AudioMix): { mix: AudioMix; notice: string | null } {
  const ruleA = () => keepClipEdits(tracks.map((t) => base(t, true)), keep);
  if (!tracks.some((t) => t.named)) return { mix: { tracks: ruleA(), duck: null }, notice: null };
  try {
    const audio = preset.audio;
    const resolved = tracks.map((t) => {
      const p = audio?.tracks.find((e) => e.label.toLowerCase() === t.label.toLowerCase());
      const d = ruleB(t, tracks);
      return p ? { ...d, enabled: p.enabled, gain: p.gain, ceilingDb: p.ceilingDb, offsetS: p.offsetS } : d;
    });
    return { mix: { tracks: keepClipEdits(resolved, keep), duck: mapDuck(tracks, audio?.duck ?? null) }, notice: null };
  } catch {
    return { mix: { tracks: ruleA(), duck: null }, notice: PRESET_MIX_NOTICE };
  }
}

export function mixToPresetAudio(mix: AudioMix): PresetAudio {
  const labelOf = (i: number) => mix.tracks.find((t) => t.index === i)?.sourceLabel;
  const labels = (ids: number[]) => ids.map(labelOf).filter((l): l is string => !!l);
  return {
    tracks: mix.tracks.map((t) => ({ label: t.sourceLabel, enabled: t.enabled, gain: t.gain, ceilingDb: t.ceilingDb, offsetS: t.offsetS })),
    duck: mix.duck ? { targets: labels(mix.duck.targets), triggers: labels(mix.duck.triggers), amountDb: mix.duck.amountDb, thresholdDb: mix.duck.thresholdDb, releaseS: mix.duck.releaseS } : null,
  };
}

/**
 * Merges this clip's mix into a preset's existing saved audio: entries for source labels this
 * clip doesn't have are kept untouched (they belong to other clips sharing the preset), entries
 * for this clip's labels are replaced, and duck is replaced wholesale (it's clip-specific).
 */
export function mergePresetAudio(existing: PresetAudio | undefined, mix: AudioMix): PresetAudio {
  const next = mixToPresetAudio(mix);
  const clipLabels = new Set(mix.tracks.map((t) => t.sourceLabel.toLowerCase()));
  const kept = (existing?.tracks ?? []).filter((t) => !clipLabels.has(t.label.toLowerCase()));
  return { tracks: [...kept, ...next.tracks], duck: next.duck };
}
