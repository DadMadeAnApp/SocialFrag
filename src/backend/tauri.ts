import { Channel, convertFileSrc, invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open, save } from '@tauri-apps/plugin-dialog';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { presetFileName } from '../presets/presets';
import type { ClipInfo, ExportJob, ExportProgress, ExportResult, Preset, RawPresetFile } from '../types';
import type { Backend, CacheInfo, PreparedTrack, TranscribeJob, TranscribeOutcome, WhisperModel, WhisperModelId } from './types';

const VIDEO_EXTS = ['mp4', 'mkv', 'mov', 'webm', 'avi'];

/** Runs a command with a progress channel. Tauri orders a channel's messages among themselves but not against
 * the reply, so a last message can land after the command resolves: drop it, or it would undo the caller's "done". */
async function invokeWithProgress<T, P>(cmd: string, args: Record<string, unknown>, onProgress?: (p: P) => void) {
  let open = true;
  const channel = new Channel<P>();
  channel.onmessage = (p) => {
    if (open) onProgress?.(p);
  };
  try {
    return await invoke<T>(cmd, { ...args, onProgress: channel });
  } finally {
    open = false;
  }
}

export class TauriBackend implements Backend {
  readonly kind = 'tauri' as const;

  async pickClips() {
    const p = await open({ multiple: true, directory: false, filters: [{ name: 'Video', extensions: VIDEO_EXTS }] });
    return Array.isArray(p) ? p : typeof p === 'string' ? [p] : [];
  }

  async pickExportPath(defaultPath: string) {
    const p = await save({ defaultPath, filters: [{ name: 'MP4 video', extensions: ['mp4'] }] });
    return typeof p === 'string' ? p : null;
  }

  videoUrl(path: string) {
    return convertFileSrc(path);
  }

  async probe(path: string) {
    try {
      return await invoke<ClipInfo>('probe_clip', { path });
    } catch (e) {
      throw new Error(String(e));
    }
  }

  async makeProxy(path: string, durationS: number, keep: string[], onProgress?: (fraction: number) => void) {
    try {
      return await invokeWithProgress<string, number>('make_proxy', { path, duration: durationS, keep }, onProgress);
    } catch (e) {
      throw new Error(String(e));
    }
  }

  async prepareAudio(path: string, keep: string[]): Promise<PreparedTrack[]> {
    try {
      const tracks = await invoke<{ index: number; pcmPath: string; frames: number; envelopePath: string }[]>('prepare_audio', { path, keep });
      return await Promise.all(
        tracks.map(async (t) => ({
          index: t.index,
          pcmPath: t.pcmPath,
          frames: t.frames,
          envelope: new Float32Array(await invoke<ArrayBuffer>('audio_envelope', { path: t.envelopePath })),
        })),
      );
    } catch (e) {
      throw new Error(String(e));
    }
  }

  async thumbnail(path: string, atS: number) {
    try {
      return await invoke<string>('thumbnail', { path, atS });
    } catch (e) {
      throw new Error(String(e));
    }
  }

  async readPcm(path: string, startFrame: number, frames: number) {
    try {
      return await invoke<ArrayBuffer>('audio_pcm_chunk', { path, startFrame, frames });
    } catch (e) {
      throw new Error(String(e));
    }
  }

  cacheInfo() {
    return invoke<CacheInfo>('cache_info');
  }

  setCacheCap(gb: number, keep: string[]) {
    return invoke<CacheInfo>('cache_set_cap', { gb, keep });
  }

  clearCache(keep: string[]) {
    return invoke<CacheInfo>('cache_clear', { keep });
  }

  listUserPresets() {
    return invoke<RawPresetFile[]>('presets_list_user');
  }

  async savePreset(p: Preset) {
    await invoke('preset_save', { id: p.id, contents: JSON.stringify(p, null, 2) });
  }

  async deletePreset(id: string) {
    await invoke('preset_delete', { id });
  }

  importPreset() {
    return invoke<string | null>('preset_import_dialog');
  }

  async exportPreset(p: Preset) {
    await invoke('preset_export_dialog', { defaultName: presetFileName(p), contents: JSON.stringify(p, null, 2) });
  }

  startExport(job: ExportJob, onProgress: (p: ExportProgress) => void) {
    return invokeWithProgress<ExportResult, ExportProgress>('export_clip', { job }, onProgress);
  }

  async cancelExport() {
    await invoke('cancel_export');
  }

  whisperModels() {
    return invoke<WhisperModel[]>('whisper_models');
  }

  async downloadWhisperModel(id: WhisperModelId, onProgress: (f: number) => void) {
    try {
      await invokeWithProgress<void, number>('download_whisper_model', { model: id }, onProgress);
    } catch (e) {
      throw new Error(String(e));
    }
  }

  async transcribe(job: TranscribeJob, onProgress: (f: number) => void) {
    try {
      return await invokeWithProgress<TranscribeOutcome, number>('transcribe', { job }, onProgress);
    } catch (e) {
      throw new Error(String(e));
    }
  }

  async cancelTranscribe() {
    await invoke('cancel_transcribe');
  }

  revealFile(path: string) {
    return revealItemInDir(path);
  }

  onFileDrop(cb: (paths: string[]) => void) {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void getCurrentWebview()
      .onDragDropEvent((e) => {
        if (e.payload.type === 'drop' && e.payload.paths.length) cb(e.payload.paths);
      })
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }
}
