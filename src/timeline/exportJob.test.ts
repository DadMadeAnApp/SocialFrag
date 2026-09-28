import { expect, test } from 'vitest';
import { blankPreset } from '../presets/presets';
import type { TrackMix } from '../types';
import { buildExportJob, defaultExportPath, localCaptionWindow, localOverlays, toExportError } from './exportJob';
import { clipDuration, emptyProject, type MediaRef, type Project, type TimelineClip } from './model';
import { addMedia, insertClips, newClip, setFormat } from './ops';
import { recordingCtx } from '../test/recordingCtx';

const preset = blankPreset('p'); // no radius/border: no OffscreenCanvas needed in jsdom
const media: MediaRef = { id: 'm', path: 'C:/v/My clip.mp4', info: { width: 1920, height: 1080, fps: '60', codec: 'h264', duration: 30, hasAudio: true, audioTracks: [{ index: 0, label: 'Game', named: true, channels: 2 }] } };
const track: TrackMix = { index: 0, sourceLabel: 'Game', label: 'Game', enabled: true, gain: 1, ceilingDb: null, offsetS: 0, fadeInS: 0, fadeOutS: 0, mutes: [] };
const clip = (id: string, o: Partial<TimelineClip> = {}): TimelineClip => ({
  id, kind: 'video', mediaId: 'm', inS: 10, outS: 20, speed: 1, presetId: 'p', layers: preset.layers, mix: { tracks: [track], duck: null }, captions: [], captionStyles: {}, ...o,
});
const project = (...main: TimelineClip[]): Project => ({ ...emptyProject(), media: [media], main });

const presetById = (_id: string) => preset;

const make = (_w: number, _h: number) => ({
  ctx: recordingCtx().ctx as never,
  encode: async () => 'x',
});

function projectWithOneClip(): Project {
  const p = addMedia(emptyProject(), [media]);
  const c = { ...newClip('c1', media, preset), captions: [{ id: 'k', text: 'GG', style: 'plain' as const, x: 0.5, y: 0.5, fontSize: 0.05, start: 0, source: 'manual' as const }] };
  return insertClips(p, 0, [c]);
}

test('overlay starts become seconds into the clip output, honouring speed', () => {
  const o = (start: number) => ({ pngBase64: 'x', start });
  expect(localOverlays([o(0), o(14), o(40)], clip('a', { speed: 2 })).map((x) => x.start)).toEqual([0, 2]);
});

test('a freeze frame keeps only overlays already showing at its frame', () => {
  const o = (start: number) => ({ pngBase64: 'x', start });
  expect(localOverlays([o(0), o(5), o(12)], clip('f', { kind: 'freeze', inS: 5, outS: 8 })).map((x) => x.start)).toEqual([0, 0]);
});

test('buildExportJob sends every clip with its own layout, trim, speed and curves', async () => {
  const layers = preset.layers.map((l) => ({ ...l, hidden: false }));
  const job = await buildExportJob({
    project: project(clip('a', { layers }), clip('f', { kind: 'freeze', inS: 12, outS: 15 }), clip('b', { speed: 2, inS: 0, outS: 4 })),
    presetById: () => preset,
    curves: () => new Map([[0, new Float32Array([1, 1])]]),
    quality: 'small',
    resolution: '1080p',
    outputPath: 'D:/out/x.mp4',
  });
  expect(job).toMatchObject({ quality: 'small', fps: 60, canvas: { w: 1080, h: 1920 }, outputPath: 'D:/out/x.mp4' });
  expect(job.clips.map((c) => [c.kind, c.source, c.trim.inS, c.trim.outS, c.speed])).toEqual([
    ['video', 'C:/v/My clip.mp4', 10, 20, 1],
    ['freeze', 'C:/v/My clip.mp4', 12, 15, 1],
    ['video', 'C:/v/My clip.mp4', 0, 4, 2],
  ]);
  expect(job.clips[0].preset.layers).toBe(layers);
  expect(Object.keys(job.clips[0].gainCurves)).toEqual(['0']);
  expect(job.clips[1].gainCurves).toEqual({});
});

test('the default export path sits next to the first clip', () => {
  expect(defaultExportPath(project(clip('a')))).toBe('C:/v/My clip_vertical.mp4');
  expect(defaultExportPath(emptyProject())).toBe('SocialFrag_vertical.mp4');
});

test('toExportError passes backend errors through and wraps anything else', () => {
  expect(toExportError({ code: 'busy', message: 'm', details: '' }).code).toBe('busy');
  expect(toExportError(new Error('boom'))).toMatchObject({ code: 'ffmpeg', message: 'Export failed.' });
});

test('export fps follows only the media still on the timeline', async () => {
  const slow: MediaRef = { ...media, id: 's', info: { ...media.info, fps: '30' } };
  const fast: MediaRef = { ...media, id: 'f', info: { ...media.info, fps: '120' } };
  const job = await buildExportJob({
    project: { ...emptyProject(), fps: 60, media: [slow, fast], main: [clip('a', { mediaId: 's' })] },
    presetById: () => preset,
    curves: () => new Map(),
    quality: 'high',
    resolution: '1080p',
    outputPath: 'D:/out/x.mp4',
  });
  expect(job.fps).toBe(30);
});

test('landscape jobs use the full-frame preset at the chosen resolution', async () => {
  const p = setFormat(projectWithOneClip(), 'landscape');
  for (const [r, canvas] of [['1080p', { w: 1920, h: 1080 }], ['1440p', { w: 2560, h: 1440 }]] as const) {
    const j = await buildExportJob({ project: p, presetById, curves: () => new Map(), quality: 'high', resolution: r, outputPath: '/o.mp4', make });
    expect(j.canvas).toEqual(canvas);
    expect(j.clips[0].preset.layers).toEqual([{ id: 'gameplay', label: 'Gameplay', src: [0, 0, 1, 1], dst: [0, 0, canvas.w, canvas.h], fit: 'contain' }]);
  }
});

test('vertical jobs ignore resolution and keep the clip preset', async () => {
  const j = await buildExportJob({ project: projectWithOneClip(), presetById, curves: () => new Map(), quality: 'high', resolution: '1440p', outputPath: '/o.mp4', make });
  expect(j.canvas).toEqual({ w: 1080, h: 1920 });
  expect(j.clips[0].preset.id).toBe(presetById('p').id);
});

test('default Save name follows the format', () => {
  expect(defaultExportPath(projectWithOneClip())).toMatch(/_vertical\.mp4$/);
  expect(defaultExportPath(setFormat(projectWithOneClip(), 'landscape'))).toMatch(/_landscape\.mp4$/);
  expect(defaultExportPath(setFormat(emptyProject(), 'landscape'))).toBe('SocialFrag_landscape.mp4');
});

test('captions become contiguous on-screen intervals in clip-output time', async () => {
  const p = projectWithOneClip();
  const c = p.main[0];
  c.captions = [
    { id: 'a', text: 'A', style: 'plain', x: 0.5, y: 0.8, fontSize: 0.04, start: 1, end: 3, source: 'auto', trackIndex: 1 },
    { id: 'b', text: 'B', style: 'plain', x: 0.5, y: 0.8, fontSize: 0.04, start: 2, end: 4, source: 'auto', trackIndex: 2 },
  ];
  const j = await buildExportJob({ project: p, presetById, curves: () => new Map(), quality: 'high', resolution: '1080p', outputPath: '/o.mp4', make });
  expect(j.clips[0].captionFrames.map((f) => [f.start, f.end])).toEqual([[0, 1], [1, 2], [2, 3], [3, 4], [4, clipDuration(c)]]);
  expect(j.clips[0].overlays).toEqual([]);
});

test('localCaptionWindow maps source seconds to clip output, honouring speed and freeze', () => {
  const c = { id: 'a', text: 'A', style: 'plain' as const, x: 0.5, y: 0.8, fontSize: 0.04, start: 12, end: 16, source: 'auto' as const };
  expect(localCaptionWindow(c, clip('v', { speed: 2 }))).toEqual([1, 3]);
  expect(localCaptionWindow({ ...c, end: undefined }, clip('v'))).toEqual([2, 10]);
  expect(localCaptionWindow(c, clip('v', { inS: 17 }))).toBeNull();
  expect(localCaptionWindow(c, clip('f', { kind: 'freeze', inS: 13, outS: 16 }))).toEqual([0, 3]);
  expect(localCaptionWindow(c, clip('f', { kind: 'freeze', inS: 17, outS: 20 }))).toBeNull();
});
