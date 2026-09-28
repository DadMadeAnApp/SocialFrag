import { parseFps } from '../state/trim';
import { VERTICAL_CANVAS, type AudioMix, type Caption, type ClipInfo, type TrackCaptionStyle, type ClipKind, type Layer } from '../types';

export interface MediaRef { id: string; path: string; info: ClipInfo }

/** inS/outS are source seconds. Freeze: inS = frame time, outS - inS = hold length, speed 1. */
export interface TimelineClip {
  id: string;
  kind: ClipKind;
  mediaId: string;
  inS: number;
  outS: number;
  speed: number;
  presetId: string;
  /** Per-clip working copy of the preset layout. */
  layers: Layer[];
  mix: AudioMix;
  /** Interim until the text track (sub-project 3): shown from `start` (source seconds) to the clip's end. */
  captions: Caption[];
  /** Auto-caption style per audio track index. */
  captionStyles: Record<number, TrackCaptionStyle>;
}

export interface Project {
  version: 1;
  canvas: { w: number; h: number };
  fps: 30 | 60;
  media: MediaRef[];
  /** The magnetic main track: start times are derived, never stored. */
  main: TimelineClip[];
}

export interface LaidClip { clip: TimelineClip; index: number; startS: number; durS: number }

export const SPEED_LIMITS = [0.25, 4] as const;

export const emptyProject = (): Project => ({ version: 1, canvas: VERTICAL_CANVAS, fps: 60, media: [], main: [] });

/** Timeline seconds a clip occupies. Mirrors Rust `ClipJob::duration`. */
export const clipDuration = (c: TimelineClip): number => (c.kind === 'freeze' ? c.outS - c.inS : (c.outS - c.inS) / c.speed);

export function layoutClips(clips: TimelineClip[]): LaidClip[] {
  let t = 0;
  return clips.map((clip, index) => {
    const durS = clipDuration(clip);
    const e = { clip, index, startS: t, durS };
    t += durS;
    return e;
  });
}

export function projectDuration(laid: LaidClip[]): number {
  const last = laid[laid.length - 1];
  return last ? last.startS + last.durS : 0;
}

/** Clip under timeline time t. A cut belongs to the later clip; at or past the end, the last clip. */
export function clipAt(laid: LaidClip[], t: number): LaidClip | null {
  for (let i = laid.length - 1; i > 0; i--) if (t >= laid[i].startS - 1e-9) return laid[i];
  return laid[0] ?? null;
}

/** Source seconds shown at timeline time t (clamped to the clip). */
export function sourceTimeAt(e: LaidClip, t: number): number {
  if (e.clip.kind === 'freeze') return e.clip.inS;
  const local = Math.min(Math.max(0, t - e.startS), e.durS);
  return e.clip.inS + local * e.clip.speed;
}

export function timelineTimeOf(e: LaidClip, srcT: number): number {
  return e.clip.kind === 'freeze' ? e.startS : e.startS + (srcT - e.clip.inS) / e.clip.speed;
}

/** 60 when any source is faster than 30 fps, else 30. */
export function projectFps(media: MediaRef[]): 30 | 60 {
  return media.some((m) => parseFps(m.info.fps) > 30.5) ? 60 : 30;
}
