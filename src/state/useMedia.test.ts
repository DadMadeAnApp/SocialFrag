import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import type { PreparedTrack } from '../backend/types';
import { FakeBackend } from '../backend/fake';
import type { ClipInfo } from '../types';
import { baseName } from './paths';
import { AUDIO_UNAVAILABLE, useMedia } from './useMedia';

const info = (o: Partial<ClipInfo> = {}): ClipInfo => ({ width: 1920, height: 1080, fps: '60', codec: 'h264', duration: 10, hasAudio: true, audioTracks: [{ index: 0, label: 'Game', named: true, channels: 2 }], ...o });

function setup(probe: (path: string) => Promise<ClipInfo> = async () => info()) {
  const b = new FakeBackend();
  b.probe = probe;
  b.videoUrl = (p: string) => `url:${p}`;
  b.prepareAudio = vi.fn(async () => [] as PreparedTrack[]);
  const onAudioFailed = vi.fn();
  const onError = vi.fn();
  const hook = renderHook(() => useMedia(b, onAudioFailed, onError));
  return { b, onAudioFailed, onError, hook };
}

test('baseName handles both separators', () => {
  expect(baseName('C:\\v\\a.mp4')).toBe('a.mp4');
  expect(baseName('/v/b.mp4')).toBe('b.mp4');
});

test('imports in file-name order (numbers sort naturally) and reuses files already imported', async () => {
  const s = setup();
  let refs = await act(() => s.hook.result.current.importPaths(['C:/v/clip 10.mp4', 'C:/v/clip 2.mp4']));
  expect(refs.map((m) => baseName(m.path))).toEqual(['clip 2.mp4', 'clip 10.mp4']);
  const again = await act(() => s.hook.result.current.importPaths(['C:/v/clip 2.mp4']));
  expect(again[0].id).toBe(refs[0].id);
  refs = refs.concat(again);
  expect(s.hook.result.current.paths.sort()).toEqual(['C:/v/clip 10.mp4', 'C:/v/clip 2.mp4']);
  expect(s.hook.result.current.status[refs[0].id].url).toBe('url:C:/v/clip 2.mp4');
});

test('a file that fails to probe is reported by name and skipped', async () => {
  const s = setup(async (p) => {
    if (p.endsWith('bad.txt')) throw new Error("This file isn't a video SocialFrag can read.");
    return info();
  });
  const refs = await act(() => s.hook.result.current.importPaths(['C:/v/bad.txt', 'C:/v/good.mp4']));
  expect(refs).toHaveLength(1);
  expect(s.onError).toHaveBeenCalledWith("bad.txt: This file isn't a video SocialFrag can read.");
});

test('a clip the webview cannot play gets a proxy with progress; other media keep their URL', async () => {
  const s = setup(async (p) => info({ codecTag: p.includes('hevc') ? 'hev1' : undefined }));
  let report: (f: number) => void = () => {};
  let finish: (p: string) => void = () => {};
  s.b.makeProxy = vi.fn((_p: string, _d: number, _keep: string[], onProgress?: (f: number) => void) => {
    report = onProgress ?? (() => {});
    return new Promise<string>((r) => (finish = r));
  });
  const [a, b] = await act(() => s.hook.result.current.importPaths(['C:/v/a hevc.mp4', 'C:/v/b.mp4']));
  await waitFor(() => expect(s.b.makeProxy).toHaveBeenCalledTimes(1));
  act(() => report(0.42));
  expect(s.hook.result.current.status[a.id].proxyProgress).toBeCloseTo(0.42);
  await act(async () => finish('C:/cache/a.mp4'));
  expect(s.hook.result.current.status[a.id]).toMatchObject({ url: 'url:C:/cache/a.mp4', proxied: true, proxyProgress: null });
  expect(s.hook.result.current.status[b.id].url).toBe('url:C:/v/b.mp4');
});

test('audio prep runs one file at a time and keeps every imported file', async () => {
  const s = setup();
  const pending: ((t: PreparedTrack[]) => void)[] = [];
  s.b.prepareAudio = vi.fn(() => new Promise<PreparedTrack[]>((r) => pending.push(r)));
  const [a] = await act(() => s.hook.result.current.importPaths(['C:/v/a.mp4', 'C:/v/b.mp4']));
  await waitFor(() => expect(s.b.prepareAudio).toHaveBeenCalledTimes(1));
  expect((s.b.prepareAudio as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual(['C:/v/a.mp4', ['C:/v/a.mp4', 'C:/v/b.mp4']]);
  const tracks = [{ index: 0, pcmPath: '/p', frames: 1, envelope: new Float32Array() }];
  await act(async () => pending[0](tracks));
  await waitFor(() => expect(s.b.prepareAudio).toHaveBeenCalledTimes(2));
  expect(s.hook.result.current.status[a.id].prepared).toBe(tracks);
});

test('failed audio prep marks the media and tells the caller', async () => {
  const s = setup();
  s.b.prepareAudio = vi.fn(async () => {
    throw new Error('x');
  });
  const [a] = await act(() => s.hook.result.current.importPaths(['C:/v/a.mp4']));
  await waitFor(() => expect(s.onAudioFailed).toHaveBeenCalledWith(a.id));
  expect(s.hook.result.current.status[a.id].audioError).toBe(AUDIO_UNAVAILABLE);
});

test('a playback error asks for a proxy once; a failing proxy is reported', async () => {
  const s = setup();
  s.b.makeProxy = vi.fn(async () => 'C:/cache/a.mp4');
  const [a] = await act(() => s.hook.result.current.importPaths(['C:/v/a.mp4']));
  expect(s.hook.result.current.mediaIdForUrl('url:C:/v/a.mp4')).toBe(a.id);
  act(() => s.hook.result.current.onPlaybackError(a.id));
  await waitFor(() => expect(s.hook.result.current.status[a.id].proxied).toBe(true));
  act(() => s.hook.result.current.onPlaybackError(a.id));
  expect(s.onError).toHaveBeenCalledWith("This video can't be previewed.");
  expect(s.b.makeProxy).toHaveBeenCalledTimes(1);
});
