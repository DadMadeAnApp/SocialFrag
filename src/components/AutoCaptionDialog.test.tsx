import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { FakeBackend } from '../backend/fake';
import { AutoCaptionDialog } from './AutoCaptionDialog';

test('defaults to the voice track, downloads the model if needed, shows progress, returns results', async () => {
  const b = new FakeBackend();
  b.whisperModels = async () => [{ id: 'base.en', bytes: 147964211, downloaded: true }, { id: 'small.en', bytes: 487614201, downloaded: false }, { id: 'medium.en', bytes: 1533774781, downloaded: false }];
  const order: string[] = [];
  b.downloadWhisperModel = async (_id, p) => { order.push('download'); p(0.5); };
  b.transcribe = async (_job, p) => { order.push('transcribe'); p(1); return { items: [{ key: 'c1:2', words: [{ text: 'gg', startS: 1, endS: 1.3 }] }], error: null }; };
  const onResult = vi.fn();
  render(<AutoCaptionDialog backend={b} tracks={[{ label: 'Desktop Audio' }, { label: 'Game' }, { label: 'Discord' }]} scope="timeline"
    buildJob={(labels, model) => ({ model, items: labels.map((l) => ({ key: `c1:${l === 'Discord' ? 2 : 1}`, source: '/a.mp4', track: 2, inS: 0, outS: 10 })) })}
    onResult={onResult} onClose={vi.fn()} />);
  expect((await screen.findByRole('checkbox', { name: 'Game' }) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByText(/Downloaded/)).toBeTruthy(); // base.en row
  fireEvent.click(screen.getByRole('checkbox', { name: 'Discord' }));
  fireEvent.click(screen.getByRole('button', { name: 'Start' }));
  await waitFor(() => expect(onResult).toHaveBeenCalled());
  expect(order).toEqual(['download', 'transcribe']);
  expect(onResult.mock.calls[0][2]).toEqual(['Game', 'Discord']);
});

test('cancel stops the run and applies nothing', async () => {
  const b = new FakeBackend();
  b.whisperModels = async () => [{ id: 'base.en', bytes: 1, downloaded: false }, { id: 'small.en', bytes: 1, downloaded: true }, { id: 'medium.en', bytes: 1, downloaded: false }];
  let reject: (e: Error) => void = () => {};
  b.transcribe = () => new Promise((_, r) => (reject = r));
  b.cancelTranscribe = async () => reject(new Error('cancelled'));
  const onResult = vi.fn();
  render(<AutoCaptionDialog backend={b} tracks={[{ label: 'Mic' }]} scope="clip" buildJob={(_l, m) => ({ model: m, items: [] })} onResult={onResult} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull());
  expect(onResult).not.toHaveBeenCalled();
});

test('a failure shows the message and copyable details', async () => {
  const b = new FakeBackend();
  b.whisperModels = async () => [{ id: 'base.en', bytes: 1, downloaded: false }, { id: 'small.en', bytes: 1, downloaded: true }, { id: 'medium.en', bytes: 1, downloaded: false }];
  b.transcribe = async () => { throw new Error('Captioning failed.\nexit 1'); };
  render(<AutoCaptionDialog backend={b} tracks={[{ label: 'Mic' }]} scope="clip" buildJob={(_l, m) => ({ model: m, items: [] })} onResult={vi.fn()} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
  expect(await screen.findByText('Captioning failed.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Copy error details' })).toBeTruthy();
});

test('a failure part-way applies the finished clips and still shows the error', async () => {
  const b = new FakeBackend();
  b.whisperModels = async () => [{ id: 'base.en', bytes: 1, downloaded: false }, { id: 'small.en', bytes: 1, downloaded: true }, { id: 'medium.en', bytes: 1, downloaded: false }];
  b.transcribe = async () => ({ items: [{ key: 'c1:3', words: [{ text: 'hi', startS: 0, endS: 1 }] }], error: 'Captioning failed.\nexit 1' });
  const onResult = vi.fn();
  render(<AutoCaptionDialog backend={b} tracks={[{ label: 'Mic' }]} scope="timeline" buildJob={(_l, m) => ({ model: m, items: [] })} onResult={onResult} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
  expect(await screen.findByText('Captioning failed.')).toBeTruthy();
  expect(onResult.mock.calls[0][1]).toEqual([{ key: 'c1:3', words: [{ text: 'hi', startS: 0, endS: 1 }] }]);
});

test('small.en is the default model; base.en is offered as faster, less accurate', async () => {
  const b = new FakeBackend();
  b.whisperModels = async () => [{ id: 'base.en', bytes: 147964211, downloaded: true }, { id: 'small.en', bytes: 487614201, downloaded: false }, { id: 'medium.en', bytes: 1533774781, downloaded: false }];
  render(<AutoCaptionDialog backend={b} tracks={[{ label: 'Game' }]} scope="clip" buildJob={(_l, m) => ({ model: m, items: [] })} onResult={vi.fn()} onClose={vi.fn()} />);
  expect((await screen.findByRole('radio', { name: /small\.en/ }) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByText(/faster, less accurate/)).toBeTruthy();
});

test('warns when a ticked track is game audio, not a separate voice source', async () => {
  const b = new FakeBackend();
  b.whisperModels = async () => [{ id: 'base.en', bytes: 1, downloaded: false }, { id: 'small.en', bytes: 1, downloaded: true }, { id: 'medium.en', bytes: 1, downloaded: false }];
  render(<AutoCaptionDialog backend={b} tracks={[{ label: 'Desktop Audio' }, { label: 'Game' }, { label: 'Discord' }]} scope="clip" buildJob={(_l, m) => ({ model: m, items: [] })} onResult={vi.fn()} onClose={vi.fn()} />);
  const warn = () => screen.queryByText('Game audio lowers caption accuracy.');
  expect(await screen.findByText('Game audio lowers caption accuracy.')).toBeTruthy(); // Game is the default here
  fireEvent.click(screen.getByRole('checkbox', { name: 'Game' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Discord' }));
  expect(warn()).toBeNull();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Desktop Audio' }));
  expect(warn()).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(false);
});
