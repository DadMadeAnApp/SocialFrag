import { useEffect, useRef, useState } from 'react';
import type { Backend } from '../backend/types';
import { ensureFonts } from '../render/fonts';
import { formatTime } from '../state/trim';
import { buildExportJob, defaultExportPath, exportCanvas, toExportError, type Resolution } from '../timeline/exportJob';
import { layoutClips, projectDuration, type Project, type TimelineClip } from '../timeline/model';
import { formatOf, type ExportError, type ExportResult, type Preset, type Quality } from '../types';

type Status =
  | { kind: 'idle' }
  | { kind: 'running'; fraction: number; etaS: number | null }
  | { kind: 'done'; result: ExportResult }
  | { kind: 'error'; error: ExportError };

interface Props {
  backend: Backend;
  project: Project;
  presetById(id: string): Preset;
  /** Source-time gain curves over [inS, outS) for a video clip. */
  curves(clip: TimelineClip): Map<number, Float32Array>;
  /** Non-null while export must be disabled for a reason the user should see (e.g. audio still preparing). */
  blockedReason?: string | null;
  onRunningChange?(running: boolean): void;
}

export function ExportPanel({ backend, project, presetById, curves, blockedReason = null, onRunningChange }: Props) {
  const [quality, setQuality] = useState<Quality>('high');
  const [resolution, setResolution] = useState<Resolution>('1080p');
  const [lastPathByFormat, setLastPathByFormat] = useState<Record<'vertical' | 'landscape', string | null>>({ vertical: null, landscape: null });
  const format = formatOf(project.canvas);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  // Cancel can be clicked while fonts/PNGs are still being prepared, before ffmpeg exists.
  const cancelRequested = useRef(false);
  const count = project.main.length;
  const duration = projectDuration(layoutClips(project.main));
  const media = new Map(project.media.map((m) => [m.id, m]));
  const videoClips = project.main.filter((c) => c.kind === 'video');
  const hasAudio = videoClips.some((c) => (media.get(c.mediaId)?.info.audioTracks.length ?? 0) > 0);
  const anyEnabled = videoClips.some((c) => c.mix.tracks.some((t) => t.enabled));

  async function run(confirmed = false): Promise<void> {
    if (!count) return;
    if (hasAudio && !anyEnabled && !confirmed && !window.confirm('No audio will be exported. Continue?')) return;
    const outputPath = await backend.pickExportPath(lastPathByFormat[format] ?? defaultExportPath(project));
    if (!outputPath) return;
    setLastPathByFormat((m) => ({ ...m, [format]: outputPath }));
    cancelRequested.current = false;
    setStatus({ kind: 'running', fraction: 0, etaS: null });
    try {
      await ensureFonts();
      const job = await buildExportJob({ project, presetById, curves, quality, resolution, outputPath });
      if (cancelRequested.current) {
        setStatus({ kind: 'idle' });
        return;
      }
      const result = await backend.startExport(job, (p) => setStatus({ kind: 'running', fraction: p.fraction, etaS: p.etaS }));
      setStatus({ kind: 'done', result });
    } catch (e) {
      const err = toExportError(e);
      if (err.code === 'not_writable') {
        setStatus({ kind: 'error', error: err });
        return run(true);
      }
      setStatus(err.code === 'cancelled' ? { kind: 'idle' } : { kind: 'error', error: err });
    }
  }

  const running = status.kind === 'running';
  useEffect(() => onRunningChange?.(running), [running, onRunningChange]);
  useEffect(() => () => onRunningChange?.(false), [onRunningChange]);
  const out = exportCanvas(project, resolution);
  const allAtMost1080 = project.main.every((c) => (media.get(c.mediaId)?.info.height ?? 0) <= 1080);

  return (
    <section className="panel">
      <h2>Export</h2>
      <fieldset disabled={running}>
        <legend>Quality</legend>
        <label>
          <input type="radio" name="quality" checked={quality === 'high'} onChange={() => setQuality('high')} /> High
        </label>
        <label>
          <input type="radio" name="quality" checked={quality === 'small'} onChange={() => setQuality('small')} /> Smaller file
        </label>
      </fieldset>
      {format === 'landscape' && (
        <fieldset disabled={running}>
          <legend>Resolution</legend>
          {(['1080p', '1440p'] as const).map((r) => (
            <label key={r}>
              <input type="radio" name="resolution" checked={resolution === r} onChange={() => setResolution(r)} /> {r}
            </label>
          ))}
          {resolution === '1440p' && allAtMost1080 && <p className="hint">Upscales clips recorded at 1080p</p>}
        </fieldset>
      )}
      <p className="hint">
        {out.w}×{out.h} MP4 · {formatTime(duration)} · {count === 1 ? '1 clip' : `${count} clips`}
      </p>
      {running ? (
        <div className="progress">
          <progress value={status.fraction} max={1} />
          <span>
            {Math.round(status.fraction * 100)}%{status.etaS !== null ? ` · ${Math.ceil(status.etaS)}s left` : ''}
          </span>
          <button
            onClick={() => {
              cancelRequested.current = true;
              void backend.cancelExport();
            }}
          >
            Cancel
          </button>
        </div>
      ) : (
        <>
          <button className="primary" disabled={blockedReason !== null || !count} onClick={() => void run()}>
            Export
          </button>
          {blockedReason !== null && <p className="hint">{blockedReason}</p>}
        </>
      )}
      {status.kind === 'done' && (
        <div className="done">
          <p>Saved: {status.result.outputPath}</p>
          {status.result.usedCpuFallback && <p className="hint">GPU encode failed, used CPU instead.</p>}
          <button onClick={() => void backend.revealFile(status.result.outputPath)}>Open folder</button>
        </div>
      )}
      {status.kind === 'error' && (
        <div className="notice-inline error" role="alert">
          <p>{status.error.message}</p>
          <button onClick={() => void navigator.clipboard?.writeText(status.error.details)}>Copy error details</button>
        </div>
      )}
    </section>
  );
}
