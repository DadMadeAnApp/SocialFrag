import { expect, test } from 'vitest';
import { groupWords } from './group';

const w = (text: string, startS: number, endS: number) => ({ text, startS, endS });

test('caps lines at 5 words', () => {
  const words = [w('a', 0, 0.15), w('b', 0.2, 0.35), w('c', 0.4, 0.55), w('d', 0.6, 0.75), w('e', 0.8, 0.95), w('f', 1, 1.15)];
  expect(groupWords(words)).toEqual([
    { text: 'a b c d e', start: 0, end: 0.95 },
    { text: 'f', start: 1, end: 1.15 },
  ]);
});

test('caps lines at 2.5 s and splits on a gap over 0.7 s', () => {
  expect(groupWords([w('one', 0, 1), w('two', 1, 2), w('three', 2, 2.6)])).toEqual([
    { text: 'one two', start: 0, end: 2 },
    { text: 'three', start: 2, end: 2.6 },
  ]);
  expect(groupWords([w('hi', 0, 0.3), w('there', 1.1, 1.4)])).toEqual([
    { text: 'hi', start: 0, end: 0.3 },
    { text: 'there', start: 1.1, end: 1.4 },
  ]);
});

test('keeps punctuation, trims whitespace, drops empty words', () => {
  expect(groupWords([w(' Nice,', 0, 0.3), w('  ', 0.3, 0.4), w(' shot!', 0.4, 0.8)])).toEqual([{ text: 'Nice, shot!', start: 0, end: 0.8 }]);
});
