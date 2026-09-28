import { beforeEach, describe, expect, it, vi } from 'vitest';

// A channel message can reach the webview after the command's reply (Tauri orders a channel's
// messages among themselves, not against the invoke result). The fake lets a test deliver one late.
const h = vi.hoisted(() => ({ channels: [] as { onmessage: (m: unknown) => void }[], reply: (): unknown => '/cache/proxy.mp4' }));

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {
    onmessage: (m: unknown) => void = () => {};
    constructor() {
      h.channels.push(this);
    }
  },
  convertFileSrc: (p: string) => p,
  invoke: vi.fn(async () => h.reply()),
}));
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock('@tauri-apps/plugin-opener', () => ({ revealItemInDir: vi.fn() }));

import { invoke } from '@tauri-apps/api/core';
import { TauriBackend } from './tauri';
import type { ExportJob } from '../types';

beforeEach(() => {
  h.channels.length = 0;
  h.reply = () => '/cache/proxy.mp4';
});

describe('TauriBackend progress channels', () => {
  it('makeProxy ignores progress that arrives after the proxy is ready', async () => {
    const seen: number[] = [];
    await new TauriBackend().makeProxy('/clip.mp4', 60, [], (f) => seen.push(f));
    h.channels[0].onmessage(1);
    expect(seen).toEqual([]);
  });

  it('makeProxy passes progress through while the proxy encodes', async () => {
    const seen: number[] = [];
    h.reply = () => {
      h.channels[0].onmessage(0.5);
      return '/cache/proxy.mp4';
    };
    await new TauriBackend().makeProxy('/clip.mp4', 60, [], (f) => seen.push(f));
    expect(seen).toEqual([0.5]);
  });

  it('startExport ignores progress that arrives after the export finished', async () => {
    const seen: number[] = [];
    h.reply = () => ({ outputPath: '/out.mp4' });
    await new TauriBackend().startExport({} as ExportJob, (p) => seen.push(p.fraction));
    h.channels[0].onmessage({ fraction: 1, etaS: 0 });
    expect(seen).toEqual([]);
  });
});

describe('TauriBackend whisper', () => {
  it('whisperModels lists models from the backend', async () => {
    h.reply = () => [{ id: 'base.en', bytes: 1, downloaded: true }];
    expect(await new TauriBackend().whisperModels()).toEqual([{ id: 'base.en', bytes: 1, downloaded: true }]);
    expect(invoke).toHaveBeenLastCalledWith('whisper_models');
  });

  it('transcribe and downloadWhisperModel ignore progress after they finish', async () => {
    const seen: number[] = [];
    h.reply = () => [];
    await new TauriBackend().transcribe({ model: 'base.en', items: [] }, (f) => seen.push(f));
    h.channels[0].onmessage(1);
    h.reply = () => null;
    await new TauriBackend().downloadWhisperModel('base.en', (f) => seen.push(f));
    h.channels[1].onmessage(1);
    expect(seen).toEqual([]);
    expect(invoke).toHaveBeenLastCalledWith('download_whisper_model', expect.objectContaining({ model: 'base.en' }));
  });

  it('cancelTranscribe calls cancel_transcribe', async () => {
    h.reply = () => null;
    await new TauriBackend().cancelTranscribe();
    expect(invoke).toHaveBeenLastCalledWith('cancel_transcribe');
  });
});
