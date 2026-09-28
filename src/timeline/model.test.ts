import { expect, test } from 'vitest';
import golden from '../test/fixtures/timeline-golden.json';
import type { ClipKind } from '../types';
import { clipAt, layoutClips, projectDuration, projectFps, sourceTimeAt, timelineTimeOf, type MediaRef, type TimelineClip } from './model';

const mk = (kind: ClipKind, inS: number, outS: number, speed: number, id = `${kind}-${inS}`): TimelineClip => ({
  id, kind, mediaId: 'm', inS, outS, speed, presetId: 'p', layers: [], mix: { tracks: [], duck: null }, captions: [], captionStyles: {},
});
const fromGolden = (clips: { kind: string; inS: number; outS: number; speed: number }[]) =>
  clips.map((c, i) => mk(c.kind as ClipKind, c.inS, c.outS, c.speed, `c${i}`));

test.each(golden.layout)('layout: $name', (g) => {
  const laid = layoutClips(fromGolden(g.clips));
  expect(laid.map((e) => e.startS)).toEqual(g.starts);
  expect(laid.map((e) => e.durS)).toEqual(g.durations);
  expect(projectDuration(laid)).toBe(g.total);
});

test.each(golden.sourceAt)('source time at t=$t in clip $clip', (g) => {
  const laid = layoutClips(fromGolden(golden.layout[0].clips));
  expect(sourceTimeAt(laid[g.clip], g.t)).toBeCloseTo(g.src);
});

test('clipAt: a cut belongs to the later clip, past the end is the last clip, empty is null', () => {
  const laid = layoutClips(fromGolden(golden.layout[0].clips));
  expect(clipAt(laid, 0)!.index).toBe(0);
  expect(clipAt(laid, 2)!.index).toBe(1);
  expect(clipAt(laid, 1.999)!.index).toBe(0);
  expect(clipAt(laid, 50)!.index).toBe(2);
  expect(clipAt([], 1)).toBeNull();
});

test('sourceTimeAt clamps to the clip and timelineTimeOf inverts it', () => {
  const [a] = layoutClips([mk('video', 10, 20, 2)]);
  expect(sourceTimeAt(a, -1)).toBe(10);
  expect(sourceTimeAt(a, 99)).toBe(20);
  expect(timelineTimeOf(a, sourceTimeAt(a, 3))).toBeCloseTo(3);
});

test('projectFps is 60 when any source is faster than 30 fps', () => {
  const m = (fps: string): MediaRef => ({ id: fps, path: fps, info: { width: 1920, height: 1080, fps, codec: 'h264', duration: 1, hasAudio: false, audioTracks: [] } });
  expect(projectFps([m('30'), m('30000/1001')])).toBe(30);
  expect(projectFps([m('30'), m('120/1')])).toBe(60);
  expect(projectFps([m('60000/1001')])).toBe(60);
  expect(projectFps([])).toBe(30);
});
