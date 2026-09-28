import { expect, test } from 'vitest';
import { BUILTIN_PRESETS } from '../presets/presets';
import type { Caption, TrackMix } from '../types';
import { emptyProject, layoutClips, type MediaRef, type Project, type TimelineClip } from './model';
import {
  FREEZE_S, MIN_CLIP_S, addMedia, applyPreset, applyTranscription, insertClips, insertFreeze, mergeCaptionWithNext, moveClip, newClip, rippleDelete, setFormat, setFreezeLength, setSpeed, setTrackStyle, splitAt, splitCaption, trimClip,
} from './ops';

const media = (id: string, duration = 20, fps = '60'): MediaRef => ({
  id, path: `C:/v/${id}.mp4`,
  info: { width: 1920, height: 1080, fps, codec: 'h264', duration, hasAudio: true, audioTracks: ['Desktop Audio', 'Game'].map((label, index) => ({ index, label, named: true, channels: 2 })) },
});
const preset = BUILTIN_PRESETS[0];
const track = (o: Partial<TrackMix> = {}): TrackMix => ({ index: 0, sourceLabel: 'Game', label: 'Game', enabled: true, gain: 1, ceilingDb: null, offsetS: 0, fadeInS: 0.5, fadeOutS: 0.5, mutes: [], ...o });

function project(...clips: Partial<TimelineClip>[]): Project {
  const m = media('m');
  return {
    ...addMedia(emptyProject(), [m]),
    main: clips.map((c, i) => ({ ...newClip(`c${i}`, m, preset), ...c })),
  };
}

test('newClip covers the whole source with the preset layout and smart default mix', () => {
  const c = newClip('a', media('m', 12), preset);
  expect([c.kind, c.inS, c.outS, c.speed, c.presetId]).toEqual(['video', 0, 12, 1, preset.id]);
  expect(c.layers).toBe(preset.layers);
  expect(c.mix.tracks.map((t) => [t.label, t.enabled])).toEqual([['Desktop Audio', false], ['Game', true]]);
});

test('addMedia skips media already in the project and sets the frame rate', () => {
  let p = addMedia(emptyProject(), [media('a', 5, '30')]);
  expect(p.fps).toBe(30);
  p = addMedia(p, [media('a', 5, '30'), media('b', 5, '120')]);
  expect(p.media.map((m) => m.id)).toEqual(['a', 'b']);
  expect(p.fps).toBe(60);
});

test('insertClips clamps the index', () => {
  const p = project({}, {});
  const extra = { ...p.main[0], id: 'x' };
  expect(insertClips(p, 99, [extra]).main.map((c) => c.id)).toEqual(['c0', 'c1', 'x']);
  expect(insertClips(p, -3, [extra]).main.map((c) => c.id)).toEqual(['x', 'c0', 'c1']);
});

test('splitAt cuts at the source time under the playhead, honouring speed', () => {
  const p = project({ inS: 2, outS: 6, speed: 2, mix: { tracks: [track()], duck: null }, captions: [{ id: 'k', text: 'hi', style: 'tiktok', x: 1, y: 1, fontSize: 80, start: 0, source: 'manual' as const }] });
  const s = splitAt(p, 1, 'new');
  expect(s.main.map((c) => [c.id, c.inS, c.outS])).toEqual([['c0', 2, 4], ['new', 4, 6]]);
  // no fade at the cut: the halves play as one continuous stretch
  expect(s.main[0].mix.tracks[0]).toMatchObject({ fadeInS: 0.5, fadeOutS: 0 });
  expect(s.main[1].mix.tracks[0]).toMatchObject({ fadeInS: 0, fadeOutS: 0.5 });
  expect(s.main[1].captions[0].id).not.toBe(s.main[0].captions[0].id);
});

test('splitAt does nothing near a cut or on a freeze frame', () => {
  const p = project({ outS: 5 }, { kind: 'freeze', inS: 1, outS: 4 });
  expect(splitAt(p, MIN_CLIP_S / 2, 'n')).toBe(p);
  expect(splitAt(p, 5 - MIN_CLIP_S / 2, 'n')).toBe(p);
  expect(splitAt(p, 6, 'n')).toBe(p);
});

test('rippleDelete closes the gap', () => {
  const p = rippleDelete(project({ outS: 4 }, { outS: 3 }, { outS: 2 }), 'c1');
  expect(layoutClips(p.main).map((e) => [e.clip.id, e.startS])).toEqual([['c0', 0], ['c2', 4]]);
});

test('trimClip keeps at least MIN_CLIP_S of timeline and stays inside the source', () => {
  const p = project({ inS: 2, outS: 6, speed: 2 });
  expect(trimClip(p, 'c0', 'in', 5.95, 20).main[0].inS).toBeCloseTo(6 - MIN_CLIP_S * 2);
  expect(trimClip(p, 'c0', 'in', -1, 20).main[0].inS).toBe(0);
  expect(trimClip(p, 'c0', 'out', 99, 20).main[0].outS).toBe(20);
  expect(trimClip(p, 'c0', 'out', 1, 20).main[0].outS).toBeCloseTo(2 + MIN_CLIP_S * 2);
});

test('setFreezeLength clamps the hold', () => {
  const p = project({ kind: 'freeze', inS: 3, outS: 6 });
  expect(setFreezeLength(p, 'c0', 0).main[0].outS).toBeCloseTo(3 + MIN_CLIP_S);
  expect(setFreezeLength(p, 'c0', 500).main[0].outS).toBe(63);
});

test('moveClip reorders', () => {
  const p = project({}, {}, {});
  expect(moveClip(p, 'c0', 2).main.map((c) => c.id)).toEqual(['c1', 'c2', 'c0']);
  expect(moveClip(p, 'c2', 0).main.map((c) => c.id)).toEqual(['c2', 'c0', 'c1']);
});

test('setSpeed clamps to 0.25–4, rounds to 2 decimals and ignores freeze frames', () => {
  const p = project({}, { kind: 'freeze', inS: 1, outS: 4 });
  expect(setSpeed(p, 'c0', 9).main[0].speed).toBe(4);
  expect(setSpeed(p, 'c0', 0.1).main[0].speed).toBe(0.25);
  expect(setSpeed(p, 'c0', 1.234).main[0].speed).toBe(1.23);
  expect(setSpeed(p, 'c1', 2)).toBe(p);
});

test('insertFreeze inside a clip splits it and holds the frame under the playhead', () => {
  const p = project({ inS: 0, outS: 10 });
  const f = insertFreeze(p, 4, 'fz', 'rest');
  expect(f.main.map((c) => [c.id, c.kind, c.inS, c.outS])).toEqual([
    ['c0', 'video', 0, 4],
    ['fz', 'freeze', 4, 4 + FREEZE_S],
    ['rest', 'video', 4, 10],
  ]);
});

test('insertFreeze at the end of the timeline appends the last frame', () => {
  const p = project({ inS: 0, outS: 10 });
  const f = insertFreeze(p, 10, 'fz', 'unused');
  expect(f.main.map((c) => c.id)).toEqual(['c0', 'fz']);
  expect(f.main[1].inS).toBeCloseTo(9.95);
});

test('applyPreset switches the clip to the preset layout and re-resolves the mix', () => {
  const other = { ...preset, id: 'other', layers: preset.layers.slice(0, 1), audio: { tracks: [{ label: 'Game', enabled: true, gain: 0.4, ceilingDb: null, offsetS: 0 }], duck: null } };
  const p = applyPreset(project({}, {}), ['c1'], other);
  expect(p.main[0].presetId).toBe(preset.id);
  expect(p.main[1].presetId).toBe('other');
  expect(p.main[1].layers).toBe(other.layers);
  expect(p.main[1].mix.tracks.find((t) => t.label === 'Game')!.gain).toBe(0.4);
});

test('setFormat switches the canvas and leaves clips alone', () => {
  const p = project({});
  const l = setFormat(p, 'landscape');
  expect(l.canvas).toEqual({ w: 1920, h: 1080 });
  expect(l.main).toBe(p.main);
  expect(setFormat(l, 'vertical').canvas).toEqual({ w: 1080, h: 1920 });
});

const timed = (id: string, start: number, end: number, over: Partial<Caption> = {}): Caption => ({
  id, text: `${id} one two`, style: 'tiktok', x: 0.5, y: 0.82, fontSize: 80 / 1920, start, end, source: 'auto', trackIndex: 1, ...over,
});

test('split: lines go to their side; a line across the cut is cut in two', () => {
  const p = project({ inS: 0, outS: 10, captions: [timed('l', 1, 2), timed('x', 4, 6), timed('r', 8, 9)] });
  const s = splitAt(p, 5, 'right');
  expect(s.main[0].captions.map((c) => [c.id, c.start, c.end])).toEqual([['l', 1, 2], ['x', 4, 5]]);
  expect(s.main[1].captions.map((c) => [c.start, c.end])).toEqual([[5, 6], [8, 9]]);
  expect(s.main[1].captions.every((c) => c.id.endsWith('~right'))).toBe(true);
});

test('trim keeps captions untouched, so dragging an edge in and back out loses nothing', () => {
  const m = { ...timed('m', 0, 0), end: undefined, source: 'manual' as const, trackIndex: undefined };
  const p = project({ inS: 0, outS: 10, captions: [timed('a', 1, 3), timed('b', 5, 6), m] });
  const id = p.main[0].id;
  const back = trimClip(trimClip(p, id, 'in', 5.5, 10), id, 'in', 0, 10);
  expect(back.main[0].captions).toEqual(p.main[0].captions);
});

test('split leaves a whole-clip caption on both halves without moving its start', () => {
  const m = { ...timed('m', 0, 0), end: undefined, source: 'manual' as const, trackIndex: undefined };
  const s = splitAt(project({ inS: 0, outS: 10, captions: [m] }), 5, 'right');
  expect(s.main.map((c) => c.captions.map((x) => [x.start, x.end]))).toEqual([[[0, undefined]], [[0, undefined]]]);
});

test('a track captioned in a later run gets the next colour, not white again', () => {
  const p = project({ inS: 0, outS: 10 });
  const id = p.main[0].id;
  let n = 0;
  const first = applyTranscription(p, [{ clipId: id, trackIndex: 2, lines: [{ text: 'a', start: 1, end: 2 }] }], () => `i${n++}`);
  const second = applyTranscription(first, [{ clipId: id, trackIndex: 3, lines: [{ text: 'b', start: 3, end: 4 }] }], () => `i${n++}`);
  expect(second.main[0].captionStyles[2].color).toBe('#FFFFFF');
  expect(second.main[0].captionStyles[3].color).toBe('#FFE14D');
});

test('merge with next joins the next line of the same track and keeps the later end', () => {
  const p = project({ inS: 0, outS: 10, captions: [timed('a', 0, 4, { text: 'one' }), timed('o', 1, 2, { text: 'other', trackIndex: 2 }), timed('b', 3, 3.5, { text: 'two' })] });
  const m = mergeCaptionWithNext(p, p.main[0].id, 'a');
  expect(m.main[0].captions.map((c) => [c.text, c.start, c.end])).toEqual([['one two', 0, 4], ['other', 1, 2]]);
});

test('caption ops on a missing caption leave the project unchanged', () => {
  const p = project({ inS: 0, outS: 10, captions: [timed('a', 0, 4)] });
  expect(splitCaption(p, p.main[0].id, 'gone', 2, 'x')).toBe(p);
  expect(mergeCaptionWithNext(p, p.main[0].id, 'gone')).toBe(p);
});

test('applyTranscription adds styled auto-lines per track, keeps edits, and sets default track styles', () => {
  const p = project({ inS: 0, outS: 10, captions: [timed('keep', 1, 2, { edited: true })] });
  let n = 0;
  const out = applyTranscription(p, [
    { clipId: p.main[0].id, trackIndex: 1, lines: [{ text: 'hello', start: 1.5, end: 2.5 }, { text: 'world', start: 3, end: 4 }] },
    { clipId: p.main[0].id, trackIndex: 2, lines: [{ text: 'gg', start: 3, end: 3.5 }] },
  ], () => `id${n++}`);
  const caps = out.main[0].captions;
  expect(caps.map((c) => c.text)).toEqual(['keep one two', 'world', 'gg']);
  expect(caps.find((c) => c.text === 'gg')).toMatchObject({ source: 'auto', trackIndex: 2, color: '#FFE14D', y: 0.82 });
  expect(out.main[0].captionStyles).toEqual({ 1: { style: 'tiktok', color: '#FFFFFF', y: 0.82 }, 2: { style: 'tiktok', color: '#FFE14D', y: 0.82 } });
});

test('splitCaption splits text at the word nearest the time fraction; mergeCaptionWithNext joins with the next line', () => {
  const p = project({ inS: 0, outS: 10, captions: [timed('a', 0, 4, { text: 'one two three four' }), timed('b', 5, 6, { text: 'five' })] });
  const id = p.main[0].id;
  const s = splitCaption(p, id, 'a', 2, 'a2');
  expect(s.main[0].captions.map((c) => [c.text, c.start, c.end, c.edited])).toEqual([['one two', 0, 2, true], ['three four', 2, 4, true], ['five', 5, 6, undefined]]);
  const m = mergeCaptionWithNext(s, id, 'a2');
  expect(m.main[0].captions.map((c) => [c.text, c.start, c.end])).toEqual([['one two', 0, 2], ['three four five', 2, 6]]);
});

test('setTrackStyle restyles that track except overrides', () => {
  const p = project({ inS: 0, outS: 10, captions: [timed('a', 0, 1), timed('b', 1, 2, { override: true, color: '#000000' }), timed('c', 2, 3, { trackIndex: 2 })] });
  const out = setTrackStyle(p, p.main[0].id, 1, { style: 'boxed', color: '#FF0000', y: 0.5 });
  expect(out.main[0].captions.map((c) => [c.id, c.style, c.color, c.y])).toEqual([['a', 'boxed', '#FF0000', 0.5], ['b', 'tiktok', '#000000', 0.82], ['c', 'tiktok', undefined, 0.82]]);
  expect(out.main[0].captionStyles[1]).toEqual({ style: 'boxed', color: '#FF0000', y: 0.5 });
});

test('splitCaption leaves a one-word line alone', () => {
  const p = project({ inS: 0, outS: 10, captions: [timed('a', 0, 4, { text: 'solo' })] });
  expect(splitCaption(p, p.main[0].id, 'a', 2, 'a2').main[0].captions.map((c) => c.text)).toEqual(['solo']);
});
