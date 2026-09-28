import { encodeCurve } from '../audio/curve';
import { fullFramePreset } from '../presets/presets';
import { buildCaptionFrames, buildExportAssets, type CanvasFactory } from '../render/exportAssets';
import { formatOf, LANDSCAPE_1440_CANVAS, LANDSCAPE_CANVAS, VERTICAL_CANVAS, type Canvas, type Caption, type ClipExport, type ExportError, type ExportJob, type Overlay, type Preset, type Quality } from '../types';
import { clipDuration, projectFps, type MediaRef, type Project, type TimelineClip } from './model';

export type Resolution = '1080p' | '1440p';

export const exportCanvas = (p: Project, r: Resolution): Canvas =>
  formatOf(p.canvas) === 'vertical' ? VERTICAL_CANVAS : r === '1440p' ? LANDSCAPE_1440_CANVAS : LANDSCAPE_CANVAS;

/**
 * buildExportAssets starts caption overlays at source seconds; the export wants seconds into the
 * clip's output. Overlays that start after the clip ends are dropped. A freeze frame keeps only
 * what is already showing at its frame.
 */
export function localOverlays(overlays: Overlay[], clip: TimelineClip): Overlay[] {
  const dur = clipDuration(clip);
  const out: Overlay[] = [];
  for (const o of overlays) {
    const rel = clip.kind === 'freeze' ? (o.start <= clip.inS + 1e-3 ? 0 : Infinity) : Math.max(0, (o.start - clip.inS) / clip.speed);
    if (rel < dur) out.push({ ...o, start: rel });
  }
  return out;
}

/** A caption's on-screen window in the clip's output seconds, or null if it never shows. */
export function localCaptionWindow(c: Caption, clip: TimelineClip): [number, number] | null {
  const dur = clipDuration(clip);
  if (clip.kind === 'freeze') return c.start <= clip.inS + 1e-3 && (c.end ?? Infinity) > clip.inS ? [0, dur] : null;
  const s = Math.max(0, (c.start - clip.inS) / clip.speed);
  const e = Math.min(dur, ((c.end ?? Infinity) - clip.inS) / clip.speed);
  return e - s > 1e-3 ? [s, e] : null;
}

export function defaultExportPath(p: Project): string {
  const suffix = formatOf(p.canvas) === 'landscape' ? '_landscape.mp4' : '_vertical.mp4';
  const first = p.main[0] ? p.media.find((m) => m.id === p.main[0].mediaId) : undefined;
  return first ? `${first.path.replace(/\.[^./\\]+$/, '')}${suffix}` : `SocialFrag${suffix}`;
}

export async function buildExportJob(a: {
  project: Project;
  presetById(id: string): Preset;
  /** Source-time gain curves over [inS, outS) for a video clip. */
  curves(clip: TimelineClip): Map<number, Float32Array>;
  quality: Quality;
  resolution: Resolution;
  outputPath: string;
  make?: CanvasFactory;
}): Promise<ExportJob> {
  const canvas = exportCanvas(a.project, a.resolution);
  const media = new Map(a.project.media.map((m) => [m.id, m]));
  const clips: ClipExport[] = [];
  const used: MediaRef[] = [];
  for (const c of a.project.main) {
    const m = media.get(c.mediaId);
    if (!m) throw new Error(`Clip ${c.id} has no media.`);
    used.push(m);
    const preset = formatOf(canvas) === 'landscape' ? fullFramePreset(canvas) : { ...a.presetById(c.presetId), layers: c.layers };
    const assets = await buildExportAssets(preset, m.info, canvas, a.make);
    const captionFrames = await buildCaptionFrames(c.captions, c.captions.map((x) => localCaptionWindow(x, c)), clipDuration(c), canvas, a.make);
    const gainCurves: Record<number, string> = {};
    if (c.kind === 'video') {
      const cs = a.curves(c);
      for (const t of c.mix.tracks) {
        const k = cs.get(t.index);
        if (t.enabled && k) gainCurves[t.index] = encodeCurve(k);
      }
    }
    clips.push({
      kind: c.kind, source: m.path, clip: m.info, preset, trim: { inS: c.inS, outS: c.outS }, speed: c.speed,
      layerMasks: assets.layerMasks, overlays: localOverlays(assets.overlays, c), captionFrames, audio: c.mix, gainCurves,
    });
  }
  // Only media still on the timeline: project.fps also counts media whose clips were deleted.
  return { clips, quality: a.quality, fps: projectFps(used), canvas, outputPath: a.outputPath };
}

export function toExportError(e: unknown): ExportError {
  if (e && typeof e === 'object' && 'code' in e && 'message' in e) return e as ExportError;
  const details = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
  return { code: 'ffmpeg', message: 'Export failed.', details };
}
