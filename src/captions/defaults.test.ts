import { expect, test } from 'vitest';
import { defaultVoiceTracks, isVoiceSource, levelDb, trackStyle } from './defaults';

const env = (v: number, n = 400) => new Float32Array(n).fill(v);

test('levelDb converts RMS amplitude to dB', () => {
  expect(levelDb(env(1)).maxDb).toBeCloseTo(0, 5);
  expect(levelDb(env(0.001)).maxDb).toBeCloseTo(-60, 5);
  expect(levelDb(env(0)).maxDb).toBe(-Infinity);
});

test('Mic when it has signal; else the loudest non-desktop track; else the first non-desktop track', () => {
  const tracks = (mic: number) => [
    { label: 'Desktop Audio', env: env(0.5) }, { label: 'Game', env: env(0.05) }, { label: 'Discord', env: env(0.2) }, { label: 'Mic', env: env(mic) },
  ];
  expect(defaultVoiceTracks(tracks(0.1))).toEqual(['Mic']);
  expect(defaultVoiceTracks(tracks(0.0001))).toEqual(['Discord']);
  expect(defaultVoiceTracks([{ label: 'Desktop Audio' }, { label: 'Game' }, { label: 'Discord' }])).toEqual(['Game']);
  expect(defaultVoiceTracks([{ label: 'Desktop Audio' }])).toEqual([]);
});

test('track styles cycle white, yellow, cyan, green near the bottom', () => {
  expect([0, 1, 2, 3, 4].map((i) => trackStyle(i).color)).toEqual(['#FFFFFF', '#FFE14D', '#4DD8FF', '#7CFF6B', '#FFFFFF']);
  expect(trackStyle(0)).toMatchObject({ style: 'tiktok', y: 0.82 });
});

test('isVoiceSource: separate voice tracks by name', () => {
  expect(['Mic', 'Discord', 'Voice chat', 'Team Chat', 'Comms', 'TeamSpeak', 'mic 2'].map(isVoiceSource)).toEqual([true, true, true, true, true, true, true]);
  expect(['Game', 'Desktop Audio', 'Track 3', ''].map(isVoiceSource)).toEqual([false, false, false, false]);
});
