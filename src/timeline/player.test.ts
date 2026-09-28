import { expect, test } from 'vitest';
import type { ClipKind } from '../types';
import { TimelinePlayer, type PlayerClip } from './player';

class FakeVideo {
  private _src = '';
  srcSets = 0;
  currentTime = 0;
  playbackRate = 1;
  muted = false;
  paused = true;
  ended = false;
  videoWidth = 1920;
  private l = new Map<string, Set<() => void>>();
  get src() {
    return this._src;
  }
  set src(v: string) {
    this._src = v;
    this.srcSets++;
    this.paused = true; // loading a new source pauses a media element
    this.currentTime = 0;
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  addEventListener(t: string, fn: () => void) {
    if (!this.l.has(t)) this.l.set(t, new Set());
    this.l.get(t)!.add(fn);
  }
  removeEventListener(t: string, fn: () => void) {
    this.l.get(t)?.delete(fn);
  }
  fire(t: string) {
    this.l.get(t)?.forEach((f) => f());
  }
}

const clip = (id: string, url: string, inS: number, startS: number, durS: number, speed = 1, kind: ClipKind = 'video'): PlayerClip => ({ id, kind, url, inS, startS, durS, speed });

function setup(clips: PlayerClip[]) {
  const a = new FakeVideo();
  const b = new FakeVideo();
  let wall = 0;
  const p = new TimelinePlayer(a, b, () => wall);
  p.setClips(clips);
  const events: string[] = [];
  for (const e of ['play', 'playing', 'pause', 'seeked', 'waiting', 'clipchange']) p.addEventListener(e, () => events.push(e));
  return { a, b, p, events, setWall: (w: number) => (wall = w) };
}

const three = () => [clip('A', 'a', 10, 0, 5), clip('B', 'b', 2, 5, 4), clip('C', 'c', 0, 9, 3)];

test('both elements are muted and the first clip loads with the second preloaded', () => {
  const s = setup(three());
  expect([s.a.muted, s.b.muted]).toEqual([true, true]);
  expect([s.a.src, s.a.currentTime]).toEqual(['a', 10]);
  expect([s.b.src, s.b.currentTime]).toEqual(['b', 2]);
  expect(s.p.clipIndex).toBe(0);
  expect(s.p.duration).toBe(12);
});

test('seek into the preloaded clip switches to its element and preloads the next', () => {
  const s = setup(three());
  s.p.currentTime = 6;
  expect(s.p.clipIndex).toBe(1);
  expect(s.p.activeElement).toBe(s.b);
  expect(s.b.currentTime).toBe(3);
  expect([s.a.src, s.a.currentTime]).toEqual(['c', 0]);
  expect(s.events).toEqual(['clipchange', 'seeked']);
  expect(s.p.currentTime).toBe(6);
});

test('playing past a cut swaps to the preloaded element without a second playing event', async () => {
  const s = setup(three());
  await s.p.play();
  s.a.fire('playing');
  expect(s.events).toEqual(['play', 'playing']);
  s.a.currentTime = 14.99;
  s.p.tick();
  expect(s.p.activeElement).toBe(s.b);
  expect([s.a.paused, s.b.paused]).toEqual([true, false]);
  s.b.fire('playing');
  expect(s.events).toEqual(['play', 'playing', 'clipchange']);
  expect(s.p.currentTime).toBe(5);
  expect([s.a.src, s.a.currentTime]).toEqual(['c', 0]);
});

test('back-to-back clips of one file swap without reloading', async () => {
  const s = setup([clip('A', 'x', 0, 0, 5), clip('B', 'x', 5, 5, 5)]);
  expect([s.a.srcSets, s.b.srcSets]).toEqual([1, 1]);
  await s.p.play();
  s.a.currentTime = 4.99;
  s.p.tick();
  expect(s.p.activeElement).toBe(s.b);
  expect([s.a.srcSets, s.b.srcSets]).toEqual([1, 1]);
  expect([s.b.currentTime, s.b.paused]).toEqual([5, false]);
});

test('speed maps element time to timeline time', async () => {
  const s = setup([clip('A', 'a', 10, 0, 2, 2)]);
  expect(s.a.playbackRate).toBe(2);
  await s.p.play();
  s.a.currentTime = 12;
  expect(s.p.currentTime).toBe(1);
});

test('a freeze clip holds its frame and advances on the wall clock', async () => {
  const s = setup([clip('F', 'x', 3, 0, 2, 1, 'freeze'), clip('B', 'y', 0, 2, 3)]);
  await s.p.play();
  expect(s.events).toEqual(['play', 'playing']);
  expect([s.a.paused, s.a.currentTime]).toEqual([true, 3]);
  s.setWall(1);
  expect(s.p.currentTime).toBe(1);
  s.setWall(1.99);
  s.p.tick();
  expect(s.p.activeElement).toBe(s.b);
  expect(s.b.paused).toBe(false);
});

test('the end of the timeline pauses at the duration; play again restarts at 0', async () => {
  const s = setup([clip('A', 'a', 4, 0, 2)]);
  await s.p.play();
  s.a.currentTime = 5.999;
  s.p.tick();
  expect(s.p.paused).toBe(true);
  expect(s.p.currentTime).toBe(2);
  expect(s.events).toContain('pause');
  await s.p.play();
  expect(s.a.currentTime).toBe(4);
  expect(s.p.paused).toBe(false);
});

test('deleting the clip under the playhead while playing continues with the next clip', async () => {
  const s = setup(three());
  s.p.currentTime = 6;
  await s.p.play();
  expect(s.p.activeElement).toBe(s.b);
  s.b.currentTime = 3; // still 6 s into the timeline
  s.p.setClips([clip('A', 'a', 10, 0, 5), clip('C', 'c', 0, 5, 3)]);
  expect(s.p.clipIndex).toBe(1);
  const el = s.p.activeElement as unknown as FakeVideo;
  expect([el.src, el.currentTime, el.paused]).toEqual(['c', 1, false]);
  expect(s.p.paused).toBe(false);
});

test('setClips with the same timing leaves a playing element alone', async () => {
  const s = setup(three());
  await s.p.play();
  s.a.currentTime = 12;
  s.p.setClips(three());
  expect([s.a.srcSets, s.a.currentTime, s.a.paused]).toEqual([1, 12, false]);
});

test('waiting then playing on the active element relays both', async () => {
  const s = setup(three());
  await s.p.play();
  s.a.fire('playing');
  s.a.fire('waiting');
  s.a.fire('playing');
  expect(s.events).toEqual(['play', 'playing', 'waiting', 'playing']);
});

test('mediaerror carries the failing url, also for a picture-less load', () => {
  const s = setup(three());
  const urls: string[] = [];
  s.p.addEventListener('mediaerror', (e) => urls.push((e as CustomEvent<string>).detail));
  s.a.fire('error');
  s.b.videoWidth = 0;
  s.b.fire('loadedmetadata');
  expect(urls).toEqual(['a', 'b']);
});

test('an empty timeline has no clip and nothing to play', async () => {
  const s = setup([]);
  expect(s.p.clipIndex).toBe(-1);
  await s.p.play();
  expect(s.p.paused).toBe(true);
});
