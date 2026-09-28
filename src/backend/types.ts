import type { ClipInfo, ExportJob, ExportProgress, ExportResult, Preset, RawPresetFile } from '../types';

/** Preview audio for one source track: raw PCM in the cache (read in chunks) plus its envelope. */
export interface PreparedTrack {
  index: number;
  pcmPath: string;
  frames: number;
  envelope: Float32Array;
}

export interface CacheInfo { bytes: number; capGb: number }

export type WhisperModelId = 'base.en' | 'small.en' | 'medium.en';
export interface WhisperModel { id: WhisperModelId; bytes: number; downloaded: boolean }
/** key identifies the clip and track (App uses `${clipId}:${trackIndex}`); inS/outS in source seconds. */
export interface TranscribeItem { key: string; source: string; track: number; inS: number; outS: number }
export interface TranscribeJob { model: WhisperModelId; items: TranscribeItem[] }
/** Words in source seconds. */
export interface ItemWords { key: string; words: { text: string; startS: number; endS: number }[] }
/** Items finished before a failure are kept; error says why the run stopped early. */
export interface TranscribeOutcome { items: ItemWords[]; error: string | null }

export interface Backend {
  readonly kind: 'tauri' | 'fake';
  /** Paths the user picked (several allowed); empty if they cancelled. */
  pickClips(): Promise<string[]>;
  /** Native Save dialog for the export (.mp4); null if cancelled. */
  pickExportPath(defaultPath: string): Promise<string | null>;
  videoUrl(path: string): string;
  /** Rejects with Error("This file isn't a video SocialFrag can read.") on unreadable files. */
  probe(path: string): Promise<ClipInfo>;
  /** Returns the path of an H.264 preview copy. onProgress receives 0..1 while ffmpeg encodes. keep = every media path in the project (never pruned). */
  makeProxy(path: string, durationS: number, keep: string[], onProgress?: (fraction: number) => void): Promise<string>;
  /** Per-track audio for the live preview. Rejects with Error when unavailable. keep as for makeProxy. */
  prepareAudio(path: string, keep: string[]): Promise<PreparedTrack[]>;
  /** Path of a small cached JPEG of the frame at atS. */
  thumbnail(path: string, atS: number): Promise<string>;
  /** Raw s16le stereo 48 kHz bytes for frames [startFrame, startFrame + frames), clamped to the file. */
  readPcm(path: string, startFrame: number, frames: number): Promise<ArrayBuffer>;
  cacheInfo(): Promise<CacheInfo>;
  /** keep = source paths currently open; their cache entries are never pruned. */
  setCacheCap(gb: number, keep: string[]): Promise<CacheInfo>;
  clearCache(keep: string[]): Promise<CacheInfo>;
  listUserPresets(): Promise<RawPresetFile[]>;
  savePreset(p: Preset): Promise<void>;
  deletePreset(id: string): Promise<void>;
  /** Raw JSON text chosen by the user, or null if cancelled. */
  importPreset(): Promise<string | null>;
  exportPreset(p: Preset): Promise<void>;
  /** Rejects with an ExportError object. */
  startExport(job: ExportJob, onProgress: (p: ExportProgress) => void): Promise<ExportResult>;
  cancelExport(): Promise<void>;
  revealFile(path: string): Promise<void>;
  /** Subscribes to OS file drops on the window; returns an unsubscribe function. */
  onFileDrop(cb: (paths: string[]) => void): () => void;
  whisperModels(): Promise<WhisperModel[]>;
  downloadWhisperModel(id: WhisperModelId, onProgress: (f: number) => void): Promise<void>;
  transcribe(job: TranscribeJob, onProgress: (f: number) => void): Promise<TranscribeOutcome>;
  cancelTranscribe(): Promise<void>;
}
