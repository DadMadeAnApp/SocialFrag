import { expect, test } from 'vitest';
import { editCaption, moveCaption, newCaption, removeCaption, resizeCaption, updateCaption } from './captions';

test('newCaption: whole clip starts at 0, fromHere starts at current time', () => {
  expect(newCaption('a', 7.5, 'whole').start).toBe(0);
  expect(newCaption('a', 7.5, 'fromHere').start).toBe(7.5);
});

test('newCaption defaults are canvas fractions', () => {
  expect(newCaption('a', 0, 'whole')).toMatchObject({ x: 0.5, y: 260 / 1920, fontSize: 80 / 1920 });
});

test('moveCaption clamps to 0..1', () => {
  const c = newCaption('a', 0, 'whole');
  expect(moveCaption(c, 5, -5)).toMatchObject({ x: 1, y: 0 });
});

test('resizeCaption changes font size by half the drag, clamped 24/1920..240/1920', () => {
  const c = { ...newCaption('a', 0, 'whole'), fontSize: 80 / 1920 };
  expect(resizeCaption(c, 20 / 1920).fontSize).toBeCloseTo(90 / 1920, 9);
  expect(resizeCaption(c, -1).fontSize).toBeCloseTo(24 / 1920, 9);
  expect(resizeCaption(c, 1).fontSize).toBeCloseTo(240 / 1920, 9);
});

test('updateCaption / removeCaption', () => {
  const a = newCaption('a', 0, 'whole');
  const b = newCaption('b', 0, 'whole');
  expect(updateCaption([a, b], { ...b, text: 'x' })[1].text).toBe('x');
  expect(removeCaption([a, b], 'a')).toEqual([b]);
});

test('newCaption is manual and untimed', () => {
  const c = newCaption('a', 0, 'whole');
  expect(c.source).toBe('manual');
  expect(c.end).toBeUndefined();
});

test('editCaption marks a changed auto-line edited, and a style/position change as an override', () => {
  const auto = { ...newCaption('a', 0, 'whole'), source: 'auto' as const, trackIndex: 3, start: 1, end: 2 };
  const fixed = editCaption(auto, { ...auto, text: 'fixed' });
  expect(fixed.edited).toBe(true);
  expect(fixed.override).toBeUndefined();
  expect(editCaption(auto, { ...auto, y: 0.5 })).toMatchObject({ edited: true, override: true });
  expect(editCaption(auto, { ...auto, color: '#FF0000' })).toMatchObject({ edited: true, override: true });
  expect(editCaption(auto, { ...auto })).toEqual(auto);
  const manual = newCaption('m', 0, 'whole');
  expect(editCaption(manual, { ...manual, text: 'x' }).edited).toBeUndefined();
});
