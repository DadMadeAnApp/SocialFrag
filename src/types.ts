export type Rect = [number, number, number, number];
export type Fit = 'cover' | 'contain';
export interface Border { width: number; color: string }
export interface Layer {
  id: string;
  label: string;
  src: Rect;
  dst: Rect;
  fit: Fit;
  radius?: number;
  border?: Border;
  hidden?: boolean;
}
export type Background = { type: 'blur'; amount: number } | { type: 'color'; color: string } | { type: 'none' };

export interface PresetAudioTrack { label: string; enabled: boolean; gain: number; ceilingDb: number | null; offsetS: number }
export interface PresetDuck { targets: string[]; triggers: string[]; amountDb: number; thresholdDb: number; releaseS: number }
export interface PresetAudio { tracks: PresetAudioTrack[]; duck: PresetDuck | null }

export const AUDIO_LIMITS = { gain: [0, 2], ceilingDb: [-24, 0], offsetS: [-2, 2], amountDb: [-24, 0], thresholdDb: [-60, 0], releaseS: [0.05, 2] } as const;

export interface MuteRange { startS: number; endS: number }
export interface TrackMix { index: number; sourceLabel: string; label: string; enabled: boolean; gain: number; ceilingDb: number | null; offsetS: number; fadeInS: number; fadeOutS: number; mutes: MuteRange[] }
export interface Duck { targets: number[]; triggers: number[]; amountDb: number; thresholdDb: number; releaseS: number }
export interface AudioMix { tracks: TrackMix[]; duck: Duck | null }

export interface Preset {
  id: string;
  name: string;
  game: string;
  version: 1;
  builtin: boolean;
  background: Background;
  layers: Layer[];
  audio?: PresetAudio;
}

export interface Canvas { w: number; h: number }
export const VERTICAL_CANVAS: Readonly<Canvas> = Object.freeze({ w: 1080, h: 1920 });
export const LANDSCAPE_CANVAS: Readonly<Canvas> = Object.freeze({ w: 1920, h: 1080 });
export const LANDSCAPE_1440_CANVAS: Readonly<Canvas> = Object.freeze({ w: 2560, h: 1440 });
export const formatOf = (c: Readonly<Canvas>): 'vertical' | 'landscape' => (c.w > c.h ? 'landscape' : 'vertical');

export type CaptionStyle = 'tiktok' | 'impact' | 'boxed' | 'plain';
/** x/y = caption centre as fractions of canvas width/height; fontSize = fraction of canvas height.
 * start/end = source seconds; no end = shown to the clip's end. */
export interface Caption {
  id: string; text: string; style: CaptionStyle; x: number; y: number; fontSize: number; start: number;
  end?: number;
  source: 'manual' | 'auto';
  /** Audio track (ffmpeg 0:a:N) an auto-line came from. */
  trackIndex?: number;
  /** An auto-line the user changed; re-runs keep it. */
  edited?: boolean;
  /** Fill colour; absent = the style's own. */
  color?: string;
  /** Style/position set on this line, so track-style changes skip it. */
  override?: boolean;
}
export interface TrackCaptionStyle { style: CaptionStyle; color: string; y: number }

/** index = audio ordinal (ffmpeg 0:a:N). named = label came from the file (e.g. OBS track name), not generated. */
export interface AudioTrackInfo { index: number; label: string; named: boolean; channels: number }
/** codecTag = container tag (hev1/hvc1/avc1); absent from older backends. */
export interface ClipInfo { width: number; height: number; fps: string; codec: string; codecTag?: string; duration: number; hasAudio: boolean; audioTracks: AudioTrackInfo[] }
export interface Trim { inS: number; outS: number }
/** video = a stretch of the source; freeze = one source frame held (inS = frame time, outS - inS = hold length). */
export type ClipKind = 'video' | 'freeze';
export type Quality = 'high' | 'small';

/** Full-canvas transparent PNG, shown from `start` seconds into its clip's output to the clip's end. */
export interface Overlay { pngBase64: string; start: number }
/** One stretch of a clip's output (seconds) showing one caption image. A clip's frames are contiguous from 0. */
export interface CaptionFrame { pngBase64: string; start: number; end: number }
/** One timeline clip as the Rust export sees it. gainCurves: track index -> base64 f32le at 200 Hz over [trim.inS, trim.outS) in source time. */
export interface ClipExport {
  kind: ClipKind;
  source: string;
  clip: ClipInfo;
  preset: Preset;
  trim: Trim;
  speed: number;
  /** layer id -> PNG mask (white = visible) sized to the layer's draw rect */
  layerMasks: Record<string, string>;
  overlays: Overlay[];
  captionFrames: CaptionFrame[];
  audio: AudioMix;
  gainCurves: Record<number, string>;
}
export interface ExportJob { clips: ClipExport[]; quality: Quality; fps: 30 | 60; canvas: Canvas; outputPath: string }
export interface ExportProgress { fraction: number; etaS: number | null }
export interface ExportResult { outputPath: string; usedCpuFallback: boolean }
export type ExportErrorCode = 'ffmpeg' | 'not_writable' | 'cancelled' | 'invalid_preset' | 'invalid_project' | 'io' | 'busy' | 'invalid_audio' | 'same_as_source' | 'bad_extension';
export interface ExportError { code: ExportErrorCode; message: string; details: string }

export interface RawPresetFile { file: string; contents: string }
