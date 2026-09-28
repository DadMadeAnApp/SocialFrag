import { resolveMix } from '../audio/resolveMix';
import { trackStyle } from '../captions/defaults';
import type { Line } from '../captions/group';
import { mergeRun } from '../captions/merge';
import { LANDSCAPE_CANVAS, VERTICAL_CANVAS, type AudioMix, type AudioTrackInfo, type Caption, type Preset, type TrackCaptionStyle } from '../types';
import { SPEED_LIMITS, clipAt, layoutClips, projectFps, sourceTimeAt, type MediaRef, type Project, type TimelineClip } from './model';

/** Shortest clip, in timeline seconds. */
export const MIN_CLIP_S = 0.1;
export const FREEZE_S = 3;
export const MAX_FREEZE_S = 60;
/** A freeze taken at a clip's very end uses a frame this far before the out point (ffmpeg can't seek to the end). */
const LAST_FRAME_S = 0.05;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function newClip(id: string, media: MediaRef, preset: Preset): TimelineClip {
  return {
    id, kind: 'video', mediaId: media.id, inS: 0, outS: media.info.duration, speed: 1, presetId: preset.id,
    layers: preset.layers, mix: resolveMix(media.info.audioTracks, preset).mix, captions: [], captionStyles: {},
  };
}

export function addMedia(p: Project, media: MediaRef[]): Project {
  const known = new Set(p.media.map((m) => m.id));
  const all = [...p.media, ...media.filter((m) => !known.has(m.id))];
  return { ...p, media: all, fps: projectFps(all) };
}

export function insertClips(p: Project, index: number, clips: TimelineClip[]): Project {
  const i = clamp(index, 0, p.main.length);
  return { ...p, main: [...p.main.slice(0, i), ...clips, ...p.main.slice(i)] };
}

export const updateClip = (p: Project, id: string, patch: Partial<TimelineClip>): Project => ({
  ...p,
  main: p.main.map((c) => (c.id === id ? { ...c, ...patch } : c)),
});

const withoutFade = (mix: AudioMix, which: 'fadeInS' | 'fadeOutS'): AudioMix => ({ ...mix, tracks: mix.tracks.map((t) => ({ ...t, [which]: 0 })) });

/** Captions kept for a source window [inS, outS): outside ones dropped, crossing ones clamped. Untimed ones clamp their start. */
function captionsIn(captions: Caption[], inS: number, outS: number): Caption[] {
  const out: Caption[] = [];
  for (const c of captions) {
    const end = c.end ?? Infinity;
    if (end <= inS + 1e-6 || c.start >= outS - 1e-6) continue;
    // Untimed captions keep their start: one set before the window still shows from the window's start.
    out.push(c.end === undefined ? c : { ...c, start: Math.max(c.start, inS), end: Math.min(c.end, outS) });
  }
  return out;
}

/** Split the clip under t at t. Unchanged when t is within MIN_CLIP_S of either end or on a freeze frame. */
export function splitAt(p: Project, t: number, newId: string): Project {
  const e = clipAt(layoutClips(p.main), t);
  if (!e || e.clip.kind !== 'video') return p;
  const local = t - e.startS;
  if (local < MIN_CLIP_S || e.durS - local < MIN_CLIP_S) return p;
  const cut = sourceTimeAt(e, t);
  const left: TimelineClip = { ...e.clip, outS: cut, mix: withoutFade(e.clip.mix, 'fadeOutS'), captions: captionsIn(e.clip.captions, e.clip.inS, cut) };
  const right: TimelineClip = {
    ...e.clip, id: newId, inS: cut, mix: withoutFade(e.clip.mix, 'fadeInS'),
    captions: captionsIn(e.clip.captions, cut, e.clip.outS).map((c) => ({ ...c, id: `${c.id}~${newId}` })),
  };
  return { ...p, main: [...p.main.slice(0, e.index), left, right, ...p.main.slice(e.index + 1)] };
}

export const rippleDelete = (p: Project, id: string): Project => ({ ...p, main: p.main.filter((c) => c.id !== id) });

export function trimClip(p: Project, id: string, edge: 'in' | 'out', srcT: number, sourceDuration: number): Project {
  const c = p.main.find((x) => x.id === id);
  if (!c || c.kind !== 'video') return p;
  const minSrc = MIN_CLIP_S * c.speed;
  const inS = edge === 'in' ? clamp(srcT, 0, c.outS - minSrc) : c.inS;
  const outS = edge === 'out' ? clamp(srcT, c.inS + minSrc, sourceDuration) : c.outS;
  // Captions stay as they are: preview, lane and export only show what falls inside [inS, outS), so a trim is reversible.
  return updateClip(p, id, { inS, outS });
}

export function setFreezeLength(p: Project, id: string, seconds: number): Project {
  const c = p.main.find((x) => x.id === id);
  if (!c || c.kind !== 'freeze') return p;
  return updateClip(p, id, { outS: c.inS + clamp(seconds, MIN_CLIP_S, MAX_FREEZE_S) });
}

/** toIndex = position in the list once the clip has been taken out. */
export function moveClip(p: Project, id: string, toIndex: number): Project {
  const c = p.main.find((x) => x.id === id);
  if (!c) return p;
  const rest = p.main.filter((x) => x.id !== id);
  const i = clamp(toIndex, 0, rest.length);
  return { ...p, main: [...rest.slice(0, i), c, ...rest.slice(i)] };
}

export function setSpeed(p: Project, id: string, speed: number): Project {
  const c = p.main.find((x) => x.id === id);
  if (!c || c.kind !== 'video' || !Number.isFinite(speed)) return p;
  return updateClip(p, id, { speed: Math.round(clamp(speed, SPEED_LIMITS[0], SPEED_LIMITS[1]) * 100) / 100 });
}

/**
 * Hold the frame under t for FREEZE_S. Inside a video clip (away from its ends) the clip is split and
 * the freeze goes between the halves; otherwise it goes before or after the clip, whichever end is nearer.
 */
export function insertFreeze(p: Project, t: number, freezeId: string, splitId: string): Project {
  const e = clipAt(layoutClips(p.main), t);
  if (!e) return p;
  const frame = e.clip.kind === 'freeze' ? e.clip.inS : clamp(sourceTimeAt(e, t), e.clip.inS, e.clip.outS - LAST_FRAME_S);
  const freeze: TimelineClip = {
    ...e.clip, id: freezeId, kind: 'freeze', inS: frame, outS: frame + FREEZE_S, speed: 1,
    captions: e.clip.captions.filter((c) => c.start <= frame + 1e-3 && (c.end ?? Infinity) > frame).map((c) => ({ ...c, id: `${c.id}~${freezeId}` })),
  };
  const local = t - e.startS;
  if (e.clip.kind === 'video' && local >= MIN_CLIP_S && e.durS - local >= MIN_CLIP_S) {
    return insertClips(splitAt(p, t, splitId), e.index + 1, [freeze]);
  }
  return insertClips(p, local < e.durS / 2 ? e.index : e.index + 1, [freeze]);
}

/** parts: which halves of the preset to take (a clip switching to another preset takes both). */
export function applyPresetToClip(c: TimelineClip, tracks: AudioTrackInfo[], preset: Preset, parts = { layers: true, audio: true }): TimelineClip {
  return {
    ...c,
    presetId: preset.id,
    layers: parts.layers ? preset.layers : c.layers,
    mix: parts.audio ? resolveMix(tracks, preset, c.mix).mix : c.mix,
  };
}

export function applyPreset(p: Project, clipIds: string[], preset: Preset): Project {
  const info = new Map(p.media.map((m) => [m.id, m.info]));
  return { ...p, main: p.main.map((c) => (clipIds.includes(c.id) ? applyPresetToClip(c, info.get(c.mediaId)?.audioTracks ?? [], preset) : c)) };
}

/** The project's output shape. Captions are fractions, so they keep their relative spot. */
export const setFormat = (p: Project, f: 'vertical' | 'landscape'): Project => ({ ...p, canvas: f === 'landscape' ? LANDSCAPE_CANVAS : VERTICAL_CANVAS });

export interface TrackLines { clipId: string; trackIndex: number; lines: Line[] }

/** One whisper run → captions, merged per clip and track (see mergeRun). Tracks get a default style the first time. */
export function applyTranscription(p: Project, runs: TrackLines[], newId: () => string): Project {
  const order = [...new Set(runs.map((r) => r.trackIndex))];
  // New tracks take the next colours after the tracks a clip already has, so speakers stay distinct across runs.
  const styleFor = (styles: Record<number, TrackCaptionStyle>, t: number) => trackStyle(Object.keys(styles).length + order.filter((x) => !(x in styles)).indexOf(t));
  return {
    ...p,
    main: p.main.map((clip) => {
      const mine = runs.filter((r) => r.clipId === clip.id);
      if (!mine.length) return clip;
      const styles = { ...clip.captionStyles };
      let captions = clip.captions;
      for (const r of mine) {
        const s = (styles[r.trackIndex] ??= styleFor(styles, r.trackIndex));
        const fresh: Caption[] = r.lines.map((l) => ({
          id: newId(), text: l.text, style: s.style, color: s.color, x: 0.5, y: s.y, fontSize: 80 / 1920,
          start: l.start, end: l.end, source: 'auto', trackIndex: r.trackIndex,
        }));
        captions = mergeRun(captions, r.trackIndex, captionsIn(fresh, clip.inS, clip.outS));
      }
      return { ...clip, captions, captionStyles: styles };
    }),
  };
}

/** Applies f to one clip; an empty patch returns p itself, so no-op edits add no undo step. */
function onClip(p: Project, clipId: string, f: (c: TimelineClip) => Partial<TimelineClip>): Project {
  const clip = p.main.find((c) => c.id === clipId);
  const patch = clip ? f(clip) : {};
  if (!Object.keys(patch).length) return p;
  return { ...p, main: p.main.map((c) => (c.id === clipId ? { ...c, ...patch } : c)) };
}

const touched = (c: Caption): Caption => (c.source === 'auto' ? { ...c, edited: true } : c);

export function splitCaption(p: Project, clipId: string, captionId: string, atSrc: number, newId: string): Project {
  return onClip(p, clipId, (clip) => {
    const i = clip.captions.findIndex((c) => c.id === captionId);
    const c = clip.captions[i];
    if (!c || c.end === undefined || atSrc <= c.start + 1e-3 || atSrc >= c.end - 1e-3) return {};
    const words = c.text.split(/\s+/).filter(Boolean);
    if (words.length < 2) return {};
    const k = Math.min(words.length - 1, Math.max(1, Math.round(((atSrc - c.start) / (c.end - c.start)) * words.length)));
    const a = touched({ ...c, text: words.slice(0, k).join(' '), end: atSrc });
    const b = touched({ ...c, id: newId, text: words.slice(k).join(' '), start: atSrc });
    return { captions: [...clip.captions.slice(0, i), a, b, ...clip.captions.slice(i + 1)] };
  });
}

export function mergeCaptionWithNext(p: Project, clipId: string, captionId: string): Project {
  return onClip(p, clipId, (clip) => {
    const a = clip.captions.find((c) => c.id === captionId);
    if (!a) return {};
    // The next line of the same speaker, not whatever another track says in between.
    const b = clip.captions.filter((c) => c.id !== a.id && c.trackIndex === a.trackIndex && c.start >= a.start).sort((x, y) => x.start - y.start)[0];
    if (!b) return {};
    const end = a.end === undefined || b.end === undefined ? undefined : Math.max(a.end, b.end);
    const merged = touched({ ...a, text: `${a.text} ${b.text}`.trim(), end });
    return { captions: clip.captions.filter((c) => c.id !== b.id).map((c) => (c.id === a.id ? merged : c)).sort((x, y) => x.start - y.start) };
  });
}

export function setTrackStyle(p: Project, clipId: string, trackIndex: number, s: TrackCaptionStyle): Project {
  return onClip(p, clipId, (clip) => ({
    captionStyles: { ...clip.captionStyles, [trackIndex]: s },
    captions: clip.captions.map((c) => (c.trackIndex === trackIndex && !c.override ? { ...c, style: s.style, color: s.color, y: s.y } : c)),
  }));
}
