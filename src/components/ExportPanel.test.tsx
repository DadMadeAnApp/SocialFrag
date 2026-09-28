import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { FakeBackend } from '../backend/fake';
import { blankPreset } from '../presets/presets';
import { emptyProject, type Project } from '../timeline/model';
import type { ExportJob } from '../types';
import { ExportPanel } from './ExportPanel';

// blankPreset has no radius/border and there are no captions, so no OffscreenCanvas is needed in jsdom.
const preset = blankPreset('p');
const project: Project = {
  ...emptyProject(),
  media: [{ id: 'm', path: 'C:/v/a.mp4', info: { width: 1920, height: 1080, fps: '60', codec: 'h264', duration: 10, hasAudio: true, audioTracks: [] } }],
  main: [{ id: 'c', kind: 'video', mediaId: 'm', inS: 1, outS: 9, speed: 1, presetId: 'p', layers: preset.layers, mix: { tracks: [], duck: null }, captions: [], captionStyles: {} }],
};
const panel = (backend: FakeBackend, blockedReason: string | null = null) =>
  render(<ExportPanel backend={backend} project={project} presetById={() => preset} curves={() => new Map()} blockedReason={blockedReason} />);

test('asks where to save, exports, shows progress and the saved file', async () => {
  const backend = new FakeBackend();
  const pick = vi.spyOn(backend, 'pickExportPath');
  let sent: ExportJob | null = null;
  backend.startExport = vi.fn(async (job, onProgress) => {
    sent = job;
    onProgress({ fraction: 0.5, etaS: 3 });
    return { outputPath: job.outputPath, usedCpuFallback: true };
  });
  panel(backend);
  expect(screen.getByText('1080×1920 MP4 · 0:08.0 · 1 clip')).toBeTruthy();
  fireEvent.click(screen.getByLabelText('Smaller file'));
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  await waitFor(() => expect(screen.getByText(/a_vertical\.mp4/)).toBeTruthy());
  expect(pick).toHaveBeenCalledWith('C:/v/a_vertical.mp4');
  expect(screen.getByText('GPU encode failed, used CPU instead.')).toBeTruthy();
  expect(sent!.quality).toBe('small');
  expect(sent!.outputPath).toBe('C:/v/a_vertical.mp4');
  expect(sent!.clips[0].trim).toEqual({ inS: 1, outS: 9 });
});

test('cancelling the Save dialog exports nothing', async () => {
  const backend = new FakeBackend();
  backend.pickExportPath = vi.fn(async () => null);
  backend.startExport = vi.fn();
  panel(backend);
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  await waitFor(() => expect(backend.pickExportPath).toHaveBeenCalled());
  expect(backend.startExport).not.toHaveBeenCalled();
});

test('a blockedReason disables Export and shows the reason', () => {
  panel(new FakeBackend(), 'Preparing audio…');
  expect((screen.getByRole('button', { name: 'Export' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('Preparing audio…')).toBeTruthy();
});

test('shows ffmpeg errors with copyable details', async () => {
  const backend = new FakeBackend();
  backend.startExport = vi.fn(async () => {
    throw { code: 'ffmpeg', message: 'Export failed.', details: 'stderr tail' };
  });
  panel(backend);
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Export failed.'));
  expect(screen.getByRole('button', { name: 'Copy error details' })).toBeTruthy();
});

test('not_writable asks for another place and retries there', async () => {
  const backend = new FakeBackend();
  backend.pickExportPath = vi.fn().mockResolvedValueOnce('C:/locked/a.mp4').mockResolvedValueOnce('D:/out/a.mp4');
  const jobs: ExportJob[] = [];
  backend.startExport = vi.fn(async (job) => {
    jobs.push(job);
    if (jobs.length === 1) throw { code: 'not_writable', message: "Can't save to this folder. Pick another one.", details: 'C:/locked' };
    return { outputPath: job.outputPath, usedCpuFallback: false };
  });
  panel(backend);
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  await waitFor(() => expect(screen.getByText('Saved: D:/out/a.mp4')).toBeTruthy());
  expect(jobs.map((j) => j.outputPath)).toEqual(['C:/locked/a.mp4', 'D:/out/a.mp4']);
});

test('same_as_source shows why the file name was refused', async () => {
  const backend = new FakeBackend();
  backend.startExport = vi.fn(async () => {
    throw { code: 'same_as_source', message: 'Pick a different file name — this is one of your clips.', details: 'C:/v/My clip.mp4' };
  });
  panel(backend);
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Pick a different file name — this is one of your clips.'));
});

test('bad_extension shows why the file name was refused', async () => {
  const backend = new FakeBackend();
  backend.startExport = vi.fn(async () => {
    throw { code: 'bad_extension', message: 'The file name must end in .mp4.', details: 'C:/v/clip.mov' };
  });
  panel(backend);
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('The file name must end in .mp4.'));
});

test('remembers the last Save path per format', async () => {
  const backend = new FakeBackend();
  backend.pickExportPath = vi.fn(async (suggested) => `/v/${suggested.split('/').pop()}`);
  backend.startExport = vi.fn(async (job) => ({ outputPath: job.outputPath, usedCpuFallback: false }));
  const { rerender } = panel(backend);
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  await waitFor(() => expect(backend.pickExportPath).toHaveBeenCalledWith('C:/v/a_vertical.mp4'));
  await waitFor(() => expect(screen.getByText(/Saved:/)).toBeTruthy());

  const landscapeProject: Project = { ...project, canvas: { w: 1920, h: 1080 } };
  rerender(<ExportPanel backend={backend} project={landscapeProject} presetById={() => preset} curves={() => new Map()} blockedReason={null} />);
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  await waitFor(() => expect(backend.pickExportPath).toHaveBeenLastCalledWith(expect.stringMatching(/_landscape\.mp4$/)));
  await waitFor(() => expect(screen.getByText(/Saved:/)).toBeTruthy());

  rerender(<ExportPanel backend={backend} project={project} presetById={() => preset} curves={() => new Map()} blockedReason={null} />);
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  await waitFor(() => expect(backend.pickExportPath).toHaveBeenLastCalledWith('/v/a_vertical.mp4'));
});

test('unmounting mid-export reports running as false', async () => {
  const backend = new FakeBackend();
  let resolveStart: (r: { outputPath: string; usedCpuFallback: boolean }) => void = () => {};
  backend.startExport = vi.fn(() => new Promise<{ outputPath: string; usedCpuFallback: boolean }>((resolve) => { resolveStart = resolve; }));
  const onRunningChange = vi.fn();
  const { unmount } = render(<ExportPanel backend={backend} project={project} presetById={() => preset} curves={() => new Map()} onRunningChange={onRunningChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  await waitFor(() => expect(onRunningChange).toHaveBeenCalledWith(true));
  unmount();
  expect(onRunningChange).toHaveBeenLastCalledWith(false);
  resolveStart({ outputPath: 'x', usedCpuFallback: false });
});

test('resolution picker only in landscape, defaults to 1080p, hints upscale for 1080p clips, and reaches the job', async () => {
  const backend = new FakeBackend();
  let captured: ExportJob | null = null;
  backend.startExport = vi.fn(async (job) => {
    captured = job;
    return { outputPath: job.outputPath, usedCpuFallback: false };
  });
  const { rerender } = panel(backend);
  expect(screen.queryByRole('radio', { name: '1080p' })).toBeNull();

  const landscapeProject: Project = { ...project, canvas: { w: 1920, h: 1080 } };
  rerender(<ExportPanel backend={backend} project={landscapeProject} presetById={() => preset} curves={() => new Map()} blockedReason={null} />);
  expect((screen.getByRole('radio', { name: '1080p' }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole('radio', { name: '1440p' }));
  expect(screen.getByText('Upscales clips recorded at 1080p')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  await waitFor(() => expect(captured?.canvas).toEqual({ w: 2560, h: 1440 }));
});
