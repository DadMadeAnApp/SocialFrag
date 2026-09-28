import { expect, test } from 'vitest';
import { dragRect, fracToPx, guidesFor, hitRect, hittableHudLayers, isGameplayLayer, nudgeRect, pxToFrac, snapRect } from './geometry';
import type { Layer } from '../types';

test('frac <-> px', () => {
  expect(fracToPx([0.5, 0.25, 0.1, 0.5], 1920, 1080)).toEqual([960, 270, 192, 540]);
  expect(pxToFrac([640, 360, 640, 360], 1920, 1080)).toEqual([0.33333, 0.33333, 0.33333, 0.33333]);
});

test('hitRect prefers the topmost rect and detects corners', () => {
  const rects = [
    { id: 'a', rect: [0, 0, 100, 100] as [number, number, number, number] },
    { id: 'b', rect: [50, 50, 100, 100] as [number, number, number, number] },
  ];
  expect(hitRect(rects, 60, 60, 6)).toEqual({ id: 'b', handle: 'move' });
  expect(hitRect(rects, 1, 1, 6)).toEqual({ id: 'a', handle: 'nw' });
  expect(hitRect(rects, 150, 150, 6)).toEqual({ id: 'b', handle: 'se' });
  expect(hitRect(rects, 300, 300, 6)).toBeNull();
});

test('dragRect moves within bounds and resizes with a minimum size', () => {
  expect(dragRect([900, 100, 200, 200], 'move', 100, 0, 1080, 1920)).toEqual([880, 100, 200, 200]);
  expect(dragRect([100, 100, 200, 200], 'nw', -50, -50, 1080, 1920)).toEqual([50, 50, 250, 250]);
  expect(dragRect([100, 100, 200, 200], 'se', -300, 0, 1080, 1920)).toEqual([100, 100, 8, 200]);
  expect(dragRect([100, 100, 200, 200], 'ne', 2000, -500, 1080, 1920)).toEqual([100, 0, 980, 300]);
});

test('snapRect snaps a moved rect centre to the canvas centre line', () => {
  const g = guidesFor(1080, 1920, []);
  expect(snapRect([433, 100, 200, 200], 'move', g, 8, 1080, 1920)).toEqual([440, 100, 200, 200]);
});

test('snapRect snaps only the dragged edge when resizing', () => {
  const g = guidesFor(1080, 1920, []);
  expect(snapRect([100, 100, 975, 300], 'se', g, 8, 1080, 1920)).toEqual([100, 100, 980, 300]);
});

test('guidesFor includes other rects edges', () => {
  expect(guidesFor(100, 200, [[10, 20, 30, 40]])).toEqual({ x: [0, 50, 100, 10, 40], y: [0, 100, 200, 20, 60] });
});

test('nudgeRect moves by step on arrow keys only', () => {
  expect(nudgeRect([0, 0, 10, 10], 'ArrowRight', 10, 100, 100)).toEqual([10, 0, 10, 10]);
  expect(nudgeRect([0, 0, 10, 10], 'ArrowUp', 1, 100, 100)).toEqual([0, 0, 10, 10]);
  expect(nudgeRect([0, 0, 10, 10], 'x', 1, 100, 100)).toBeNull();
});

const wardogsLayers = (): Layer[] => [
  { id: 'gameplay', label: 'Gameplay', src: [0, 0, 1, 1], dst: [0, 0, 1080, 1920], fit: 'cover' },
  { id: 'killfeed', label: 'Killfeed', src: [0, 0, 1, 1], dst: [30, 150, 480, 255], fit: 'contain' },
  { id: 'minimap', label: 'Minimap', src: [0, 0, 1, 1], dst: [788, 130, 262, 300], fit: 'contain', hidden: true },
];

test('isGameplayLayer identifies by id "gameplay", falling back to index 0', () => {
  const layers = wardogsLayers();
  expect(isGameplayLayer(layers, 0)).toBe(true);
  expect(isGameplayLayer(layers, 1)).toBe(false);
  const noNamed = [{ id: 'a' }, { id: 'b' }];
  expect(isGameplayLayer(noNamed, 0)).toBe(true);
  expect(isGameplayLayer(noNamed, 1)).toBe(false);
});

test('hittableHudLayers excludes gameplay and hidden layers, keeps draw order', () => {
  expect(hittableHudLayers(wardogsLayers())).toEqual([{ id: 'killfeed', rect: [30, 150, 480, 255] }]);
});

test('HUD rect can be hit, moved and resized like a preset-editor rect', () => {
  const rects = hittableHudLayers(wardogsLayers());
  const hit = hitRect(rects, 200, 250, 10);
  expect(hit).toEqual({ id: 'killfeed', handle: 'move' });
  const moved = dragRect([30, 150, 480, 255], 'move', 20, 10, 1080, 1920);
  expect(moved).toEqual([50, 160, 480, 255]);
  const resized = dragRect([30, 150, 480, 255], 'se', 20, 10, 1080, 1920);
  expect(resized).toEqual([30, 150, 500, 265]);
});

test('gameplay layer is never hittable, even at its corners', () => {
  const rects = hittableHudLayers(wardogsLayers());
  expect(hitRect(rects, 5, 5, 10)).toBeNull();
});
