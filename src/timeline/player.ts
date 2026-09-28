import type { ClipKind } from '../types';

/** What the player needs per timeline clip (derived from the project and the media URLs). */
export interface PlayerClip { id: string; kind: ClipKind; url: string; inS: number; startS: number; durS: number; speed: number }

/** The subset of HTMLVideoElement the player drives; tests pass fakes. */
export interface PlayerVideo {
  src: string;
  currentTime: number;
  playbackRate: number;
  muted: boolean;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly videoWidth: number;
  play(): Promise<void> | void;
  pause(): void;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

/** Swap this close to a cut: rAF runs every ~16 ms, so waiting for the exact end would show frames past the out point. */
const SWAP_EARLY_S = 1 / 60;
/** After an edit, a playing element within this of where it should be is left alone (no audible re-seek). */
const RESEEK_S = 0.05;

/**
 * Plays the magnetic main track on two video elements (A/B): the clip under the playhead plays in
 * one while the next waits, paused at its in point, in the other; they swap at each cut. Freeze
 * clips hold a paused frame and advance on the wall clock. Looks like a media element to
 * AudioPreview (timeline currentTime, paused, play/playing/pause/waiting/seeked) and also emits
 * 'clipchange' and 'mediaerror' (detail = the URL that failed to play).
 */
export class TimelinePlayer extends EventTarget {
  readonly playbackRate = 1;
  private clips: PlayerClip[] = [];
  private readonly els: [PlayerVideo, PlayerVideo];
  private active = 0;
  private idx = -1;
  /** Timeline time while paused, and the time of the last seek/swap. */
  private t = 0;
  private playing = false;
  /** Wall-clock anchor while a freeze clip plays. */
  private wall: { at: number; t: number } | null = null;
  /** An element 'playing' is passed on after play() or a stall, not after a swap (audio is already scheduled across cuts). */
  private relayPlaying = false;
  private readonly urls = new Map<PlayerVideo, string>();
  private readonly loaded = new Map<PlayerVideo, number>();
  private readonly off: (() => void)[] = [];
  private readonly now: () => number;

  constructor(a: PlayerVideo, b: PlayerVideo, now = () => performance.now() / 1000) {
    super();
    this.els = [a, b];
    this.now = now;
    for (const el of this.els) {
      el.muted = true; // preview audio comes from AudioPreview
      const on = (type: string, fn: () => void) => {
        el.addEventListener(type, fn);
        this.off.push(() => el.removeEventListener(type, fn));
      };
      on('waiting', () => {
        if (!this.isActive(el) || !this.playing) return;
        this.relayPlaying = true;
        this.dispatchEvent(new Event('waiting'));
      });
      on('playing', () => {
        if (!this.isActive(el) || !this.playing || !this.relayPlaying) return;
        this.relayPlaying = false;
        this.dispatchEvent(new Event('playing'));
      });
      on('error', () => this.mediaError(el));
      // Loaded but no picture = the webview can't decode the video track.
      on('loadedmetadata', () => el.videoWidth === 0 && this.mediaError(el));
    }
  }

  get duration() {
    const last = this.clips[this.clips.length - 1];
    return last ? last.startS + last.durS : 0;
  }
  get paused() {
    return !this.playing;
  }
  get clipIndex() {
    return this.idx;
  }
  get activeElement(): PlayerVideo {
    return this.els[this.active];
  }
  get currentTime() {
    return this.playing ? this.liveTime() : this.t;
  }
  set currentTime(t: number) {
    this.seek(t);
  }

  setClips(clips: PlayerClip[]) {
    const t = this.currentTime;
    this.clips = clips;
    this.loaded.clear();
    if (!clips.length) {
      this.playing = false;
      this.wall = null;
      this.els.forEach((e) => e.pause());
      this.idx = -1;
      this.t = 0;
      this.dispatchEvent(new Event('clipchange'));
      return;
    }
    this.t = Math.min(t, this.duration);
    this.idx = -1;
    this.place(this.t, RESEEK_S);
    if (this.playing) this.resume();
  }

  play(): Promise<void> {
    if (this.playing || !this.clips.length) return Promise.resolve();
    if (this.t >= this.duration - 1e-6) {
      this.t = 0;
      this.place(0, 0);
    }
    this.playing = true;
    this.relayPlaying = true;
    this.dispatchEvent(new Event('play'));
    this.resume();
    if (this.clips[this.idx].kind === 'freeze') {
      this.relayPlaying = false;
      this.dispatchEvent(new Event('playing'));
    }
    return Promise.resolve();
  }

  pause() {
    if (!this.playing) return;
    this.t = this.liveTime();
    this.playing = false;
    this.wall = null;
    this.els[this.active].pause();
    this.dispatchEvent(new Event('pause'));
  }

  /** Called every animation frame: swaps elements at a cut and stops at the end. */
  tick() {
    if (!this.playing || this.idx < 0) return;
    const c = this.clips[this.idx];
    const end = c.startS + c.durS;
    const el = this.els[this.active];
    if (this.liveTime() < end - SWAP_EARLY_S && !(c.kind === 'video' && el.ended)) return;
    const next = this.idx + 1;
    if (next >= this.clips.length) {
      this.t = this.duration;
      this.playing = false;
      this.wall = null;
      el.pause();
      this.dispatchEvent(new Event('pause'));
      return;
    }
    this.t = end;
    const other = 1 - this.active;
    if (this.loaded.get(this.els[other]) !== next) this.load(this.els[other], next, this.clips[next].inS, 0);
    this.active = other;
    this.idx = next;
    this.resume();
    this.preload();
    this.dispatchEvent(new Event('clipchange'));
  }

  dispose() {
    this.off.forEach((f) => f());
    this.els.forEach((e) => e.pause());
    this.playing = false;
  }

  private seek(t: number) {
    if (!this.clips.length) return;
    this.t = Math.min(Math.max(0, t), this.duration);
    this.place(this.t, 0);
    if (this.playing) this.resume();
    this.dispatchEvent(new Event('seeked'));
  }

  private isActive(el: PlayerVideo) {
    return this.els[this.active] === el;
  }

  private mediaError(el: PlayerVideo) {
    const url = this.urls.get(el);
    if (url) this.dispatchEvent(new CustomEvent('mediaerror', { detail: url }));
  }

  private liveTime(): number {
    const c = this.clips[this.idx];
    if (!c) return this.t;
    const end = c.startS + c.durS;
    if (c.kind === 'freeze') return this.wall ? Math.min(end, this.wall.t + (this.now() - this.wall.at)) : this.t;
    const el = this.els[this.active];
    return Math.min(end, Math.max(c.startS, c.startS + (el.currentTime - c.inS) / c.speed));
  }

  private indexAt(t: number) {
    for (let i = this.clips.length - 1; i > 0; i--) if (t >= this.clips[i].startS - 1e-9) return i;
    return 0;
  }

  /** Put the clip under t in the active element (preferring the one that already holds it) and preload the next. */
  private place(t: number, tol: number) {
    const i = this.indexAt(t);
    const prevId = this.clips[this.idx]?.id;
    const prevEl = this.els[this.active];
    this.idx = i;
    const c = this.clips[i];
    const src = c.kind === 'freeze' ? c.inS : c.inS + (t - c.startS) * c.speed;
    const other = 1 - this.active;
    if (this.loaded.get(this.els[this.active]) !== i && this.loaded.get(this.els[other]) === i) this.active = other;
    this.load(this.els[this.active], i, src, tol);
    this.preload();
    if (c.id !== prevId || this.els[this.active] !== prevEl) this.dispatchEvent(new Event('clipchange'));
  }

  private load(el: PlayerVideo, i: number, srcT: number, tol: number) {
    const c = this.clips[i];
    if (this.urls.get(el) !== c.url) {
      el.src = c.url;
      this.urls.set(el, c.url);
    }
    el.playbackRate = c.kind === 'freeze' ? 1 : c.speed;
    if (Math.abs(el.currentTime - srcT) > tol) el.currentTime = srcT;
    this.loaded.set(el, i);
  }

  private preload() {
    const n = this.idx + 1;
    if (n < this.clips.length) this.load(this.els[1 - this.active], n, this.clips[n].inS, 0);
  }

  /** While playing: run the active element (or the freeze clock) and park the other one. */
  private resume() {
    const c = this.clips[this.idx];
    const el = this.els[this.active];
    this.els[1 - this.active].pause();
    if (c.kind === 'freeze') {
      el.pause();
      this.wall = { at: this.now(), t: this.t };
      return;
    }
    this.wall = null;
    if (el.paused) {
      const r = el.play();
      if (r) r.catch(() => {});
    }
  }
}
