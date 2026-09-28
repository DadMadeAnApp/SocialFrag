import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { App } from './App';
import type { PreparedTrack } from './backend/types';
import { FakeBackend } from './backend/fake';
import { BUILTIN_PRESETS, duplicatePreset } from './presets/presets';

afterEach(() => localStorage.clear());

const tracks = ['Desktop Audio', 'Game', 'Discord'].map((label, index) => ({ index, label, named: true, channels: 2 }));

function makeBackend() {
  const b = new FakeBackend();
  b.probe = async () => ({ width: 1920, height: 1080, fps: '60', codec: 'hevc', duration: 10, hasAudio: true, audioTracks: tracks });
  b.videoUrl = (p: string) => `url:${p}`;
  return b;
}

async function openClipIn(b: FakeBackend, path = 'C:/v/clip.mp4', n = 1) {
  b.pickClips = async () => [path];
  fireEvent.click(screen.getByRole('button', { name: /Open clip|Add clips/ }));
  await screen.findByRole('button', { name: `Clip ${n}: ${path.split('/').pop()}` });
  // The clip button is in the DOM as soon as React commits, but the player only gets the clips (and the
  // editor keys their listener) in the passive effects after it, which findBy can outrun. A seek before
  // then is dropped. The preview canvas only renders once the player has placed a clip, so wait for it.
  await screen.findByLabelText('Vertical preview');
}

function stubBackend() {
  let drop: (paths: string[]) => void = () => {};
  const b = new FakeBackend();
  b.probe = async () => ({ width: 1920, height: 1080, fps: '60', codec: 'hevc', duration: 10, hasAudio: true, audioTracks: [] });
  b.videoUrl = (p: string) => `url:${p}`;
  b.makeProxy = () => new Promise<string>(() => {});
  b.onFileDrop = (cb) => {
    drop = cb;
    return () => {};
  };
  return { b, drop: (...p: string[]) => drop(p) };
}

/** A copy of the built-in preset without radius/border, so export assets need no OffscreenCanvas (jsdom has none). */
async function saveSimplePreset(b: FakeBackend) {
  const simple = { ...duplicatePreset(BUILTIN_PRESETS[0], 'u1'), layers: BUILTIN_PRESETS[0].layers.map((l) => ({ id: l.id, label: l.label, src: l.src, dst: l.dst, fit: l.fit })) };
  await b.savePreset(simple);
}
const pickUserPreset = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /WARDOGS – Default \(copy\)/ }));
};

test('shows the drop zone and the WARDOGS preset on launch', () => {
  render(<App backend={new FakeBackend()} />);
  expect(screen.getByRole('heading', { name: 'Drop a clip' })).toBeTruthy();
  expect(screen.getByRole('button', { name: /WARDOGS – Default/ })).toBeTruthy();
});

test('lists saved user presets and warns about broken ones', async () => {
  const b = new FakeBackend();
  await b.savePreset(duplicatePreset(BUILTIN_PRESETS[0], 'u1'));
  localStorage.setItem('socialfrag.fake.presets', JSON.stringify({ ...JSON.parse(localStorage.getItem('socialfrag.fake.presets')!), bad: '{' }));
  render(<App backend={b} />);
  await waitFor(() => expect(screen.getByRole('button', { name: /WARDOGS – Default \(copy\)/ })).toBeTruthy());
  expect(screen.getByText('bad.json: not valid JSON')).toBeTruthy();
});

test('dropping two files appends them in file-name order and exports both', async () => {
  const s = stubBackend();
  await saveSimplePreset(s.b);
  s.b.startExport = vi.fn(async (job) => ({ outputPath: job.outputPath, usedCpuFallback: false }));
  render(<App backend={s.b} />);
  await pickUserPreset();
  await act(async () => s.drop('C:/v/b.mp4', 'C:/v/a.mp4'));
  expect(await screen.findByRole('button', { name: 'Clip 1: a.mp4' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Clip 2: b.mp4' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  await waitFor(() => expect(s.b.startExport).toHaveBeenCalled());
  const job = (s.b.startExport as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(job.clips.map((c: { source: string }) => c.source)).toEqual(['C:/v/a.mp4', 'C:/v/b.mp4']);
  expect(job.outputPath).toBe('C:/v/a_vertical.mp4');
});

test('a clip the webview cannot play shows a preview percentage while its proxy encodes', async () => {
  const s = stubBackend();
  let report: (f: number) => void = () => {};
  s.b.makeProxy = (_p, _d, _keep, onProgress) => {
    report = onProgress ?? (() => {});
    return new Promise<string>(() => {});
  };
  const { container } = render(<App backend={s.b} />);
  await act(async () => s.drop('A.mp4'));
  await waitFor(() => expect(container.querySelector('video.player-a')?.getAttribute('src')).toBe('url:A.mp4'));
  fireEvent.error(container.querySelector('video.player-a')!);
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Preparing preview'));
  await act(async () => report(0.42));
  expect(screen.getByRole('status').textContent).toContain('42%');
  expect((screen.getByLabelText('Preview progress') as HTMLProgressElement).value).toBeCloseTo(0.42);
});

test('S splits the clip at the playhead, Ctrl+Z undoes it, Delete removes the selected clip', async () => {
  const b = makeBackend();
  render(<App backend={b} />);
  await openClipIn(b);
  fireEvent.pointerDown(screen.getByLabelText('Timeline ruler'), { clientX: 250, pointerId: 1 }); // 5 s at 50 px/s
  fireEvent.pointerUp(screen.getByLabelText('Timeline ruler'), { clientX: 250, pointerId: 1 });
  fireEvent.keyDown(window, { key: 's' });
  expect(await screen.findByRole('button', { name: 'Clip 2: clip.mp4' })).toBeTruthy();
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Clip 2: clip.mp4' })).toBeNull());
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true });
  const second = await screen.findByRole('button', { name: 'Clip 2: clip.mp4' });
  fireEvent.pointerDown(second, { clientX: 300, pointerId: 1 });
  fireEvent.pointerUp(second, { clientX: 300, pointerId: 1 });
  fireEvent.keyDown(window, { key: 'Delete' });
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Clip 2: clip.mp4' })).toBeNull());
  expect(screen.getByRole('button', { name: 'Clip 1: clip.mp4' })).toBeTruthy();
});

test('clicking Split (S) produces two clips, and Undo (Ctrl+Z) brings it back to one', async () => {
  const b = makeBackend();
  render(<App backend={b} />);
  await openClipIn(b);
  fireEvent.pointerDown(screen.getByLabelText('Timeline ruler'), { clientX: 250, pointerId: 1 }); // 5 s at 50 px/s
  fireEvent.pointerUp(screen.getByLabelText('Timeline ruler'), { clientX: 250, pointerId: 1 });
  fireEvent.click(screen.getByRole('button', { name: 'Split (S)' }));
  expect(await screen.findByRole('button', { name: 'Clip 2: clip.mp4' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Undo (Ctrl+Z)' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Clip 2: clip.mp4' })).toBeNull());
});

test('export panel stays mounted (hidden) while the preset editor is open', async () => {
  const s = stubBackend();
  const { container } = render(<App backend={s.b} />);
  await act(async () => s.drop('A.mp4'));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Export' })).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Edit a copy' }));
  const side = container.querySelector('aside.side') as HTMLElement;
  expect(side).toBeTruthy();
  expect(side.hidden).toBe(true);
});

test('the format switch is disabled while the preset editor is open', async () => {
  const b = makeBackend();
  render(<App backend={b} />);
  await openClipIn(b);
  fireEvent.click(screen.getByRole('button', { name: 'New preset' }));
  expect((screen.getByRole('radio', { name: '16:9 Landscape' }) as HTMLInputElement).disabled).toBe(true);
});

test('opening a clip resolves the smart default mix', async () => {
  const b = makeBackend();
  render(<App backend={b} />);
  await openClipIn(b);
  expect(await screen.findByRole('button', { name: 'Restore Desktop Audio' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Remove Game' })).toBeTruthy();
});

test('switching presets does not re-register the file-drop listener', async () => {
  const b = makeBackend();
  await b.savePreset(duplicatePreset(BUILTIN_PRESETS[0], 'u1'));
  const onFileDrop = vi.spyOn(b, 'onFileDrop');
  render(<App backend={b} />);
  await waitFor(() => expect(screen.getByRole('button', { name: /WARDOGS – Default \(copy\)/ })).toBeTruthy());
  expect(onFileDrop).toHaveBeenCalledTimes(1);
  await pickUserPreset();
  await waitFor(() => expect(screen.getByRole('button', { name: /WARDOGS – Default \(copy\)/ }).className).toContain('selected'));
  expect(onFileDrop).toHaveBeenCalledTimes(1);
});

test('re-saving the selected preset unchanged does not reset an in-progress gain edit', async () => {
  const b = makeBackend();
  await b.savePreset(duplicatePreset(BUILTIN_PRESETS[0], 'u1'));
  render(<App backend={b} />);
  await pickUserPreset();
  await openClipIn(b);
  const gainInput = (await screen.findByLabelText('Desktop Audio gain %')) as HTMLInputElement;
  fireEvent.change(gainInput, { target: { value: '150' } });
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Save preset' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Save preset' })).toBeNull());
  expect((screen.getByLabelText('Desktop Audio gain %') as HTMLInputElement).value).toBe('150');
});

test('a failed prepareAudio clears a duck config carried from the preset, so export matches the UI', async () => {
  const b = makeBackend();
  await b.savePreset({
    ...duplicatePreset(BUILTIN_PRESETS[0], 'u-duck'),
    audio: {
      tracks: [{ label: 'Discord', enabled: true, gain: 1, ceilingDb: null, offsetS: 0 }],
      duck: { targets: ['Game'], triggers: ['Discord'], amountDb: -10, thresholdDb: -40, releaseS: 0.4 },
    },
  });
  let rejectPrepare!: (e: Error) => void;
  b.prepareAudio = vi.fn(() => new Promise<PreparedTrack[]>((_resolve, reject) => (rejectPrepare = reject)));
  render(<App backend={b} />);
  await pickUserPreset();
  await openClipIn(b);
  await waitFor(() => expect((screen.getByLabelText('Duck') as HTMLInputElement).checked).toBe(true));
  await act(async () => rejectPrepare(new Error('x')));
  await screen.findByText('Audio preview unavailable : export still uses your mix.');
  await waitFor(() => expect((screen.getByLabelText('Duck') as HTMLInputElement).checked).toBe(false));
});

test('a failed prepareAudio removes duck from the whole undo history, so undo does not bring it back', async () => {
  const b = makeBackend();
  await b.savePreset({
    ...duplicatePreset(BUILTIN_PRESETS[0], 'u-duck'),
    audio: {
      tracks: [{ label: 'Discord', enabled: true, gain: 1, ceilingDb: null, offsetS: 0 }],
      duck: { targets: ['Game'], triggers: ['Discord'], amountDb: -10, thresholdDb: -40, releaseS: 0.4 },
    },
  });
  let rejectPrepare!: (e: Error) => void;
  b.prepareAudio = vi.fn(() => new Promise<PreparedTrack[]>((_resolve, reject) => (rejectPrepare = reject)));
  render(<App backend={b} />);
  await pickUserPreset();
  await openClipIn(b);
  await waitFor(() => expect((screen.getByLabelText('Duck') as HTMLInputElement).checked).toBe(true));
  // an undoable edit before the failure, so there is a past step for the fix to reach
  const gainInput = (await screen.findByLabelText('Discord gain %')) as HTMLInputElement;
  fireEvent.change(gainInput, { target: { value: '150' } });
  await act(async () => rejectPrepare(new Error('x')));
  await screen.findByText('Audio preview unavailable : export still uses your mix.');
  await waitFor(() => expect((screen.getByLabelText('Duck') as HTMLInputElement).checked).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Undo (Ctrl+Z)' }));
  expect((screen.getByLabelText('Duck') as HTMLInputElement).checked).toBe(false);
});

test('a failed save while saving a draft preset shows an error', async () => {
  const b = makeBackend();
  await b.savePreset(duplicatePreset(BUILTIN_PRESETS[0], 'u1'));
  render(<App backend={b} />);
  await pickUserPreset();
  await openClipIn(b);
  await screen.findByLabelText('Desktop Audio gain %');
  b.savePreset = vi.fn(async () => {
    throw new Error('disk full');
  });
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Save preset' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('disk full'));
});

test('a failed save while importing a preset shows an error', async () => {
  const b = makeBackend();
  render(<App backend={b} />);
  b.importPreset = async () => JSON.stringify(BUILTIN_PRESETS[0]);
  b.savePreset = vi.fn(async () => {
    throw new Error('disk full');
  });
  fireEvent.click(screen.getByRole('button', { name: 'Import .json' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('disk full'));
});

test('picking a different preset for the selected clip re-resolves its mix', async () => {
  const b = makeBackend();
  await b.savePreset(duplicatePreset(BUILTIN_PRESETS[0], 'u1'));
  render(<App backend={b} />);
  await openClipIn(b);
  const gainInput = (await screen.findByLabelText('Desktop Audio gain %')) as HTMLInputElement;
  fireEvent.change(gainInput, { target: { value: '150' } });
  await pickUserPreset();
  await waitFor(() => expect((screen.getByLabelText('Desktop Audio gain %') as HTMLInputElement).value).not.toBe('150'));
});

test('saving the mix to a preset keeps its entry for a label not in this clip', async () => {
  const b = makeBackend();
  await b.savePreset({ ...duplicatePreset(BUILTIN_PRESETS[0], 'u1'), audio: { tracks: [{ label: 'Other Clip Track', enabled: false, gain: 0.3, ceilingDb: null, offsetS: 0 }], duck: null } });
  b.savePreset = vi.fn(async () => {});
  render(<App backend={b} />);
  await pickUserPreset();
  await openClipIn(b);
  fireEvent.click(await screen.findByRole('button', { name: 'Save mix to preset' }));
  await waitFor(() => expect(b.savePreset).toHaveBeenCalled());
  const saved = (b.savePreset as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(saved.id).toBe('u1');
  expect(saved.audio.tracks).toContainEqual({ label: 'Other Clip Track', enabled: false, gain: 0.3, ceilingDb: null, offsetS: 0 });
  expect(saved.audio.tracks.map((t: { label: string }) => t.label)).toEqual(expect.arrayContaining(['Desktop Audio', 'Game', 'Discord']));
});

test('save mix to a built-in preset saves a copy with audio', async () => {
  const b = makeBackend();
  b.savePreset = vi.fn(async () => {});
  render(<App backend={b} />);
  await openClipIn(b);
  fireEvent.click(await screen.findByRole('button', { name: 'Save mix to preset' }));
  await waitFor(() => expect(b.savePreset).toHaveBeenCalled());
  const saved = (b.savePreset as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(saved.builtin).toBe(false);
  expect(saved.name).toMatch(/\(copy\)$/);
  expect(saved.audio.tracks.map((t: { label: string; enabled: boolean }) => [t.label, t.enabled])).toEqual([['Desktop Audio', false], ['Game', true], ['Discord', true]]);
});

test('save layout to preset on a built-in preset saves a copy with the hidden layer', async () => {
  const b = makeBackend();
  b.savePreset = vi.fn(async () => {});
  render(<App backend={b} />);
  await openClipIn(b);
  fireEvent.click(await screen.findByLabelText('Show Killfeed'));
  fireEvent.click(screen.getByRole('button', { name: 'Save layout to preset' }));
  await waitFor(() => expect(b.savePreset).toHaveBeenCalled());
  const saved = (b.savePreset as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(saved.builtin).toBe(false);
  expect(saved.layers.find((l: { id: string }) => l.id === 'killfeed').hidden).toBe(true);
});

test('toggling a HUD layer off is reflected in the exported clip', async () => {
  const b = makeBackend();
  await saveSimplePreset(b);
  b.startExport = vi.fn(async () => ({ outputPath: '/out.mp4', usedCpuFallback: false }));
  render(<App backend={b} />);
  await pickUserPreset();
  await openClipIn(b);
  fireEvent.click(await screen.findByLabelText('Show Killfeed'));
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  await waitFor(() => expect(b.startExport).toHaveBeenCalled());
  const job = (b.startExport as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(job.clips[0].preset.layers.find((l: { id: string }) => l.id === 'killfeed').hidden).toBe(true);
});

test('library rail and sidebar collapse to strips and expand again; sizes are remembered', async () => {
  localStorage.removeItem('socialfrag.layout');
  const s = stubBackend();
  const first = render(<App backend={s.b} />);
  await act(async () => s.drop('A.mp4'));
  await waitFor(() => expect(screen.getByRole('separator', { name: 'Resize sidebar' })).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Hide library' }));
  expect(screen.queryByRole('navigation', { name: 'Presets' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Hide sidebar' }));
  expect(screen.queryByRole('separator', { name: 'Resize sidebar' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Show library' }));
  expect(screen.getByRole('navigation', { name: 'Presets' })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize library' }), { key: 'ArrowRight' });
  first.unmount();

  const s2 = stubBackend();
  render(<App backend={s2.b} />);
  expect(screen.getByRole('separator', { name: 'Resize library' }).getAttribute('aria-valuenow')).toBe('276');
  await act(async () => s2.drop('A.mp4'));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Show sidebar' })).toBeTruthy());
  localStorage.removeItem('socialfrag.layout');
});

test('the Media tab lists imported files and + appends another clip of one', async () => {
  const b = makeBackend();
  render(<App backend={b} />);
  await openClipIn(b);
  fireEvent.click(screen.getByRole('tab', { name: 'Media' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add clip.mp4 to the timeline' }));
  expect(await screen.findByRole('button', { name: 'Clip 2: clip.mp4' })).toBeTruthy();
});

test('the format switch changes the preview, greys out presets, and undoes', async () => {
  const b = makeBackend();
  render(<App backend={b} />);
  await openClipIn(b);
  fireEvent.click(screen.getByRole('radio', { name: '16:9 Landscape' }));
  expect(await screen.findByLabelText('Landscape preview')).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: 'Presets' }));
  expect(screen.getByText('Presets shape vertical exports. Switch to 9:16 to use them.')).toBeTruthy();
  expect((screen.getByRole('button', { name: /WARDOGS/ }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
  expect(await screen.findByLabelText('Vertical preview')).toBeTruthy();
});

test('the format switch is disabled while an export runs', async () => {
  const b = makeBackend();
  b.startExport = () => new Promise(() => {});
  b.pickExportPath = async () => '/o.mp4';
  await saveSimplePreset(b);
  render(<App backend={b} />);
  await pickUserPreset();
  await openClipIn(b);
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  await screen.findByRole('button', { name: 'Cancel' });
  await waitFor(() => expect((screen.getByRole('radio', { name: '16:9 Landscape' }) as HTMLInputElement).disabled).toBe(true));
});

function whisperBackend() {
  const b = makeBackend();
  const withMic = [...tracks, { index: 3, label: 'Mic', named: true, channels: 2 }];
  b.probe = async () => ({ width: 1920, height: 1080, fps: '60', codec: 'hevc', duration: 10, hasAudio: true, audioTracks: withMic });
  b.whisperModels = async () => [{ id: 'base.en', bytes: 1, downloaded: false }, { id: 'small.en', bytes: 1, downloaded: true }, { id: 'medium.en', bytes: 1, downloaded: false }];
  b.transcribe = async (job) => ({ items: job.items.map((it) => ({ key: it.key, words: [{ text: 'one', startS: 1, endS: 1.4 }, { text: 'two', startS: 1.5, endS: 2 }, { text: 'three', startS: 3, endS: 3.5 }] })), error: null });
  return b;
}

async function runAutoCaption() {
  fireEvent.click(screen.getByRole('button', { name: 'Auto-caption' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Auto-caption' })).toBeNull());
}

const captionRows = () => screen.queryAllByRole('textbox', { name: 'Caption text' }) as HTMLInputElement[];

test('auto-caption adds timed lines as one undo step; Delete acts on the selected caption, not the clip', async () => {
  const b = whisperBackend();
  render(<App backend={b} />);
  await openClipIn(b);
  fireEvent.click(screen.getByRole('button', { name: /^Clip 1:/ }));
  await runAutoCaption();
  expect(captionRows().map((r) => r.value)).toEqual(['one two', 'three']);
  fireEvent.click(screen.getByText('0:01.0–0:02.0'));
  fireEvent.keyDown(window, { key: 'Delete' });
  expect(captionRows().map((r) => r.value)).toEqual(['three']);
  expect(screen.getByRole('button', { name: /^Clip 1:/ })).toBeTruthy();
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
  expect(captionRows()).toHaveLength(2);
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
  expect(captionRows()).toHaveLength(0);
});

test('re-running auto-caption keeps an edited line', async () => {
  const b = whisperBackend();
  render(<App backend={b} />);
  await openClipIn(b);
  fireEvent.click(screen.getByRole('button', { name: /^Clip 1:/ }));
  await runAutoCaption();
  fireEvent.change(captionRows()[0], { target: { value: 'ONE TWO' } });
  await runAutoCaption();
  expect(captionRows().map((r) => r.value)).toEqual(['ONE TWO', 'three']);
});

test('the caption lane shows each line; clicking one selects it for Delete', async () => {
  const b = whisperBackend();
  render(<App backend={b} />);
  await openClipIn(b);
  fireEvent.click(screen.getByRole('button', { name: /^Clip 1:/ }));
  await runAutoCaption();
  fireEvent.click(screen.getByRole('button', { name: 'Caption: three' }));
  fireEvent.keyDown(window, { key: 'Delete' });
  expect(captionRows().map((r) => r.value)).toEqual(['one two']);
  expect(screen.queryByRole('button', { name: 'Caption: three' })).toBeNull();
});

test('after a re-run replaces the selected line, S splits the clip instead of doing nothing', async () => {
  const b = whisperBackend();
  render(<App backend={b} />);
  await openClipIn(b);
  fireEvent.click(screen.getByRole('button', { name: /^Clip 1:/ }));
  await runAutoCaption();
  fireEvent.click(screen.getByText('0:03.0–0:03.5'));
  await runAutoCaption(); // untouched lines are replaced with new ids
  fireEvent.pointerDown(screen.getByLabelText('Timeline ruler'), { clientX: 250, pointerId: 1 }); // 5 s
  fireEvent.pointerUp(screen.getByLabelText('Timeline ruler'), { clientX: 250, pointerId: 1 });
  fireEvent.keyDown(window, { key: 's' });
  await waitFor(() => expect(screen.getAllByRole('button', { name: /^Clip \d:/ }).length).toBe(2));
});

test('editor keys are off while the Auto-caption dialog is open', async () => {
  const b = whisperBackend();
  b.transcribe = () => new Promise(() => {});
  render(<App backend={b} />);
  await openClipIn(b);
  fireEvent.click(screen.getByRole('button', { name: /^Clip 1:/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Auto-caption' }));
  await screen.findByRole('dialog', { name: 'Auto-caption' });
  fireEvent.keyDown(window, { key: 'Delete' });
  expect(screen.getByRole('button', { name: /^Clip 1:/ })).toBeTruthy();
});
