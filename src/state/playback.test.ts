import { expect, test } from 'vitest';
import type { ClipInfo } from '../types';
import { webviewCanPlay } from './playback';

const clip = (codecTag?: string): ClipInfo => ({ width: 1920, height: 1080, fps: '120/1', codec: 'hevc', codecTag, duration: 10, hasAudio: false, audioTracks: [] });
const webkit = (type: string) => (type.includes('hev1') ? '' : 'probably');

test('hev1 HEVC is unplayable in WebKit, hvc1 and avc1 are fine', () => {
  expect(webviewCanPlay(clip('hev1'), webkit)).toBe(false);
  expect(webviewCanPlay(clip('hvc1'), webkit)).toBe(true);
  expect(webviewCanPlay(clip('avc1'), webkit)).toBe(true);
});

test('unknown tag falls back to trying the original file', () => {
  expect(webviewCanPlay(clip(undefined), () => '')).toBe(true);
});
