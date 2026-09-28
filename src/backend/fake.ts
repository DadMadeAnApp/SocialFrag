import { presetFileName } from '../presets/presets';
import type { ClipInfo, ExportError, ExportJob, ExportProgress, ExportResult, Preset, RawPresetFile } from '../types';
import type { Backend, CacheInfo, PreparedTrack, TranscribeJob, TranscribeOutcome, WhisperModel, WhisperModelId } from './types';

const NO_WHISPER = 'Auto-captioning needs the desktop app.';

const STORE_KEY = 'socialfrag.fake.presets';

function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.click();
  });
}

/** Browser-only backend so the UI can be built and tested on the Mac without Tauri. */
export class FakeBackend implements Backend {
  readonly kind = 'fake' as const;
  private urls = new Map<string, string>();
  private cancelled = false;

  private register(file: File): string {
    const path = `fake://${file.name}`;
    this.urls.set(path, URL.createObjectURL(file));
    return path;
  }

  async pickClips() {
    return (await pickFiles('video/*', true)).map((f) => this.register(f));
  }

  async pickExportPath(defaultPath: string): Promise<string | null> {
    return defaultPath;
  }

  videoUrl(path: string) {
    const url = this.urls.get(path);
    if (!url) throw new Error(`unknown fake path ${path}`);
    return url;
  }

  probe(path: string): Promise<ClipInfo> {
    return new Promise((resolve, reject) => {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.onloadedmetadata = () => resolve({ width: v.videoWidth, height: v.videoHeight, fps: '60', codec: 'h264', duration: v.duration, hasAudio: true, audioTracks: [{ index: 0, label: 'Track 1', named: false, channels: 2 }] });
      v.onerror = () => reject(new Error("This file isn't a video SocialFrag can read."));
      v.src = this.videoUrl(path);
    });
  }

  async makeProxy(path: string, _durationS: number, _keep: string[], onProgress?: (fraction: number) => void) {
    onProgress?.(1);
    return path;
  }

  async prepareAudio(_path: string, _keep: string[]): Promise<PreparedTrack[]> {
    throw new Error('Audio preview needs the desktop app.');
  }

  async thumbnail(_path: string, _atS: number): Promise<string> {
    throw new Error('Thumbnails need the desktop app.');
  }

  async readPcm(_path: string, _startFrame: number, _frames: number): Promise<ArrayBuffer> {
    throw new Error('Audio preview needs the desktop app.');
  }

  private cache: CacheInfo = { bytes: 0, capGb: 10 };

  async cacheInfo() {
    return this.cache;
  }

  async setCacheCap(gb: number, _keep: string[]) {
    this.cache = { ...this.cache, capGb: gb };
    return this.cache;
  }

  async clearCache(_keep: string[]) {
    this.cache = { ...this.cache, bytes: 0 };
    return this.cache;
  }

  private readStore(): Record<string, string> {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  private writeStore(s: Record<string, string>) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(s));
    } catch {
      /* storage blocked: presets live for this page only */
    }
  }

  async listUserPresets(): Promise<RawPresetFile[]> {
    return Object.entries(this.readStore()).map(([id, contents]) => ({ file: `${id}.json`, contents }));
  }

  async savePreset(p: Preset) {
    const s = this.readStore();
    s[p.id] = JSON.stringify(p);
    this.writeStore(s);
  }

  async deletePreset(id: string) {
    const s = this.readStore();
    delete s[id];
    this.writeStore(s);
  }

  async importPreset() {
    const [f] = await pickFiles('.json,application/json', false);
    return f ? f.text() : null;
  }

  async exportPreset(p: Preset) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' }));
    a.download = presetFileName(p);
    a.click();
  }

  startExport(job: ExportJob, onProgress: (p: ExportProgress) => void): Promise<ExportResult> {
    this.cancelled = false;
    return new Promise((resolve, reject) => {
      let f = 0;
      const timer = setInterval(() => {
        if (this.cancelled) {
          clearInterval(timer);
          const err: ExportError = { code: 'cancelled', message: 'Export cancelled.', details: '' };
          reject(err);
          return;
        }
        f = Math.min(1, Math.round((f + 0.1) * 10) / 10);
        onProgress({ fraction: f, etaS: (1 - f) * 2 });
        if (f >= 1) {
          clearInterval(timer);
          resolve({ outputPath: job.outputPath, usedCpuFallback: false });
        }
      }, 200);
    });
  }

  async whisperModels(): Promise<WhisperModel[]> {
    throw new Error(NO_WHISPER);
  }

  async downloadWhisperModel(_id: WhisperModelId, _onProgress: (f: number) => void): Promise<void> {
    throw new Error(NO_WHISPER);
  }

  async transcribe(_job: TranscribeJob, _onProgress: (f: number) => void): Promise<TranscribeOutcome> {
    throw new Error(NO_WHISPER);
  }

  async cancelTranscribe(): Promise<void> {}

  async cancelExport() {
    this.cancelled = true;
  }

  async revealFile(path: string) {
    console.info('reveal', path);
  }

  onFileDrop(cb: (paths: string[]) => void) {
    const over = (e: DragEvent) => e.preventDefault();
    const drop = (e: DragEvent) => {
      e.preventDefault();
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length) cb(files.map((f) => this.register(f)));
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }
}
