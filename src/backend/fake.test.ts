import { afterEach, expect, test, vi } from 'vitest';
import { BUILTIN_PRESETS, duplicatePreset } from '../presets/presets';
import { FakeBackend } from './fake';
import type { ExportJob } from '../types';

afterEach(() => {
  localStorage.clear();
  vi.useRealTimers();
});

const job = { clips: [], quality: 'high', fps: 60, canvas: { w: 1080, h: 1920 }, outputPath: 'fake://clip_vertical.mp4' } as ExportJob;

test('user presets round-trip through localStorage', async () => {
  const b = new FakeBackend();
  const p = duplicatePreset(BUILTIN_PRESETS[0], 'u1');
  await b.savePreset(p);
  const files = await b.listUserPresets();
  expect(files.map((f) => f.file)).toEqual(['u1.json']);
  expect(JSON.parse(files[0].contents).id).toBe('u1');
  await b.deletePreset('u1');
  expect(await b.listUserPresets()).toEqual([]);
});

test('listUserPresets survives corrupt storage', async () => {
  localStorage.setItem('socialfrag.fake.presets', '{nope');
  expect(await new FakeBackend().listUserPresets()).toEqual([]);
});

test('startExport reports progress and resolves with an output path', async () => {
  vi.useFakeTimers();
  const b = new FakeBackend();
  const seen: number[] = [];
  const done = b.startExport(job, (p) => seen.push(p.fraction));
  await vi.advanceTimersByTimeAsync(2500);
  await expect(done).resolves.toEqual({ outputPath: 'fake://clip_vertical.mp4', usedCpuFallback: false });
  expect(seen.at(-1)).toBe(1);
});

test('fake prepareAudio rejects so the UI falls back to the video audio', async () => {
  await expect(new FakeBackend().prepareAudio('fake://a.mp4', [])).rejects.toThrow('desktop app');
});

test('pickExportPath returns the suggested path and thumbnails need the desktop app', async () => {
  const b = new FakeBackend();
  expect(await b.pickExportPath('C:/v/a_vertical.mp4')).toBe('C:/v/a_vertical.mp4');
  await expect(b.thumbnail('fake://a.mp4', 0)).rejects.toThrow('desktop app');
});

test('cancelExport rejects with code cancelled', async () => {
  vi.useFakeTimers();
  const b = new FakeBackend();
  const done = b.startExport(job, () => {});
  const assertion = expect(done).rejects.toMatchObject({ code: 'cancelled' });
  await b.cancelExport();
  await vi.advanceTimersByTimeAsync(300);
  await assertion;
});

test('whisper needs the desktop app; cancel is a no-op', async () => {
  const b = new FakeBackend();
  await expect(b.whisperModels()).rejects.toThrow('Auto-captioning needs the desktop app.');
  await expect(b.downloadWhisperModel('base.en', () => {})).rejects.toThrow('Auto-captioning needs the desktop app.');
  await expect(b.transcribe({ model: 'base.en', items: [] }, () => {})).rejects.toThrow('Auto-captioning needs the desktop app.');
  await expect(b.cancelTranscribe()).resolves.toBeUndefined();
});
