import { expect, test } from 'vitest';
import fixtureJson from '../test/fixtures/preset-fixture.json';
import { LANDSCAPE_1440_CANVAS, VERTICAL_CANVAS, type Preset } from '../types';

const FIXTURE = fixtureJson as Preset;
import { recordingCtx } from '../test/recordingCtx';
import type { Caption, ClipInfo } from '../types';
import { buildCaptionFrames, buildExportAssets, type CanvasFactory } from './exportAssets';

const clip: ClipInfo = { width: 1920, height: 1080, fps: '60', codec: 'h264', duration: 30, hasAudio: true, audioTracks: [] };

function fakeFactory() {
  const made: [number, number][] = [];
  const make: CanvasFactory = (w, h) => {
    made.push([w, h]);
    return { ctx: recordingCtx().ctx, encode: async () => `png-${made.length}` };
  };
  return { make, made };
}

test('WARDOGS: one mask for the rounded killfeed, one border overlay at t=0', async () => {
  const { make, made } = fakeFactory();
  const r = await buildExportAssets(FIXTURE, clip, VERTICAL_CANVAS, make);
  expect(r.layerMasks).toEqual({ killfeed: 'png-1' });
  expect(r.overlays).toEqual([{ pngBase64: 'png-2', start: 0 }]);
  expect(made).toEqual([[819, 300], [1080, 1920]]);
});

test('a hidden layer gets no mask and no border overlay', async () => {
  const { make, made } = fakeFactory();
  const preset: Preset = { ...FIXTURE, layers: [FIXTURE.layers[0], { ...FIXTURE.layers[1], hidden: true }] };
  const r = await buildExportAssets(preset, clip, VERTICAL_CANVAS, make);
  expect(r.layerMasks).toEqual({});
  expect(r.overlays).toEqual([]);
  expect(made).toEqual([]);
});

const cap = (id: string, text = id): Caption => ({ id, text, style: 'tiktok', x: 0.5, y: 0.8, fontSize: 0.04, start: 0, source: 'manual' });

test('caption frames cover the clip contiguously, one image per on-screen set, blanks shared', async () => {
  const { make, made } = fakeFactory();
  const f = await buildCaptionFrames([cap('a'), cap('b'), cap('e', '   ')], [[1, 3], [2, 4], [0, 9]], 6, VERTICAL_CANVAS, make);
  expect(f.map((x) => [x.start, x.end])).toEqual([[0, 1], [1, 2], [2, 3], [3, 4], [4, 6]]);
  expect(f[0].pngBase64).toBe(f[4].pngBase64); // one blank image reused
  expect(made).toHaveLength(4); // blank, a, a+b, b
});

test('no visible captions means no frames', async () => {
  const { make } = fakeFactory();
  expect(await buildCaptionFrames([cap('a')], [null], 6, VERTICAL_CANVAS, make)).toEqual([]);
});

test('caption frames render on the export canvas size (1440p landscape)', async () => {
  const { make, made } = fakeFactory();
  await buildCaptionFrames([cap('a')], [[0, 2]], 2, LANDSCAPE_1440_CANVAS, make);
  expect(made).toEqual([[2560, 1440]]);
});
