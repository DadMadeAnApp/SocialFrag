import { expect, test } from 'vitest';
import fixtureJson from '../test/fixtures/preset-fixture.json';
import { fullFramePreset } from '../presets/presets';
import { LANDSCAPE_CANVAS, VERTICAL_CANVAS, type Preset } from '../types';

const FIXTURE = fixtureJson as Preset;
import { recordingCtx } from '../test/recordingCtx';
import { drawFrame, drawMask } from './compose';

const frame = {} as CanvasImageSource;

test('drawFrame draws blurred background, then each layer at its layout', () => {
  const { ctx, named } = recordingCtx();
  drawFrame(ctx, frame, 1920, 1080, FIXTURE, [], 0, VERTICAL_CANVAS);
  expect(named('drawImage')).toEqual([
    [frame, 656, 0, 608, 1080, 0, 0, 1080, 1920],
    [frame, 538, 118, 845, 845, 0, 420, 1080, 1080],
    [frame, 1440, 22, 442, 162, 132, 80, 819, 300],
  ]);
  expect(named('set:filter')).toEqual([['blur(30px)']]);
  expect(named('roundRect')).toEqual([
    [132, 80, 819, 300, 16],
    [132, 80, 819, 300, 16],
  ]);
  expect(named('stroke')).toHaveLength(1);
});

test('drawFrame skips captions that start later than t', () => {
  const { ctx, named } = recordingCtx();
  const cap = { id: 'c', text: 'Hi', style: 'plain' as const, x: 0.5, y: 200 / 1920, fontSize: 60 / 1920, start: 5, source: 'manual' as const };
  drawFrame(ctx, frame, 1920, 1080, FIXTURE, [cap], 4, VERTICAL_CANVAS);
  expect(named('fillText')).toHaveLength(0);
  drawFrame(ctx, frame, 1920, 1080, FIXTURE, [cap], 5, VERTICAL_CANVAS);
  expect(named('fillText')).toHaveLength(1);
});

test('drawFrame skips a hidden layer entirely (no image, no border)', () => {
  const { ctx, named } = recordingCtx();
  const preset: Preset = { ...FIXTURE, layers: [FIXTURE.layers[0], { ...FIXTURE.layers[1], hidden: true }] };
  drawFrame(ctx, frame, 1920, 1080, preset, [], 0, VERTICAL_CANVAS);
  expect(named('drawImage')).toEqual([
    [frame, 656, 0, 608, 1080, 0, 0, 1080, 1920],
    [frame, 538, 118, 845, 845, 0, 420, 1080, 1080],
  ]);
  expect(named('stroke')).toHaveLength(0);
});

test('drawMask paints black then a white rounded rect', () => {
  const { ctx, named } = recordingCtx();
  drawMask(ctx, 819, 300, 16);
  expect(named('set:fillStyle')).toEqual([['#000000'], ['#ffffff']]);
  expect(named('roundRect')).toEqual([[0, 0, 819, 300, 16]]);
});

test('drawFrame scales crops to the decoded frame size (720p proxy of a 1080p clip)', () => {
  const { ctx, named } = recordingCtx();
  drawFrame(ctx, frame, 1920, 1080, FIXTURE, [], 0, VERTICAL_CANVAS, 1280, 720);
  const k = 1280 / 1920;
  expect(named('drawImage')[1]).toEqual([frame, 538 * k, 118 * k, 845 * k, 845 * k, 0, 420, 1080, 1080]);
  expect(named('drawImage')[0].slice(1, 5)).toEqual([656 * k, 0, 608 * k, 1080 * k]);
});

test('drawFrame on the landscape canvas fills black and draws captions at fraction × canvas', () => {
  const { ctx, named } = recordingCtx();
  const cap = { id: 'c', text: 'Hi', style: 'plain' as const, x: 0.5, y: 0.5, fontSize: 0.05, start: 0, source: 'manual' as const };
  drawFrame(ctx, frame, 1440, 1080, fullFramePreset(LANDSCAPE_CANVAS), [cap], 1, LANDSCAPE_CANVAS);
  expect(named('fillRect')[0]).toEqual([0, 0, 1920, 1080]);
  expect(named('drawImage')).toEqual([[frame, 0, 0, 1440, 1080, 240, 0, 1440, 1080]]);
  expect(named('fillText')).toEqual([['Hi', 960, 540]]);
});

test('drawFrame stacks captions that are on screen together', () => {
  const { ctx, named } = recordingCtx();
  const c = (id: string, trackIndex: number) => ({ id, text: 'Hi', style: 'plain' as const, x: 0.5, y: 0.8, fontSize: 0.04, start: 0, end: 5, source: 'auto' as const, trackIndex });
  drawFrame(ctx, frame, 1920, 1080, FIXTURE, [c('a', 1), c('b', 2)], 1, VERTICAL_CANVAS);
  const ys = named('fillText').map((a) => a[2] as number);
  expect(ys).toHaveLength(2);
  expect(ys[1]).toBeLessThan(ys[0]);
});
