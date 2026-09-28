import { expect, test } from 'vitest';
import { formatTime, parseFps } from './trim';

test('parseFps handles ratios, integers and junk', () => {
  expect(parseFps('60000/1001')).toBeCloseTo(59.94, 2);
  expect(parseFps('144')).toBe(144);
  expect(parseFps('0/0')).toBe(60);
  expect(parseFps('abc')).toBe(60);
});

test('formatTime renders m:ss.t', () => {
  expect(formatTime(0)).toBe('0:00.0');
  expect(formatTime(75.26)).toBe('1:15.3');
});
