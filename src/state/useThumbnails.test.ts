import { renderHook, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { FakeBackend } from '../backend/fake';
import { layoutClips, type MediaRef, type TimelineClip } from '../timeline/model';
import { useThumbnails } from './useThumbnails';

const m: MediaRef = { id: 'm', path: 'C:/v/a.mp4', info: { width: 1920, height: 1080, fps: '60', codec: 'h264', duration: 30, hasAudio: false, audioTracks: [] } };
const clip = (id: string, inS: number): TimelineClip => ({ id, kind: 'video', mediaId: 'm', inS, outS: inS + 2, speed: 1, presetId: 'p', layers: [], mix: { tracks: [], duck: null }, captions: [], captionStyles: {} });

test('one thumbnail per media and whole second, shown through videoUrl', async () => {
  const b = new FakeBackend();
  b.thumbnail = vi.fn(async (_p: string, at: number) => `C:/cache/${at}.jpg`);
  b.videoUrl = (p: string) => `url:${p}`;
  const media = new Map([['m', m]]);
  const { result } = renderHook(() => useThumbnails(b, layoutClips([clip('a', 3.2), clip('b', 3.9), clip('c', 7)]), media));
  await waitFor(() => expect(result.current('m', 3.5)).toBe('url:C:/cache/3.jpg'));
  expect(result.current('m', 7)).toBe('url:C:/cache/7.jpg');
  expect(b.thumbnail).toHaveBeenCalledTimes(2);
});
