import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { FakeBackend } from '../backend/fake';
import { SettingsDialog } from './SettingsDialog';

const GB = 1024 ** 3;

test('shows cache usage and the cap', async () => {
  const b = new FakeBackend();
  b.cacheInfo = async () => ({ bytes: 1.5 * GB, capGb: 10 });
  render(<SettingsDialog backend={b} keep={[]} onClose={() => {}} />);
  expect(await screen.findByText('1.5 GB used of 10 GB')).toBeTruthy();
});

test('Clear cache keeps the open clip and shows the new size', async () => {
  const b = new FakeBackend();
  b.cacheInfo = async () => ({ bytes: 4 * GB, capGb: 10 });
  const clear = vi.fn(async () => ({ bytes: 0.2 * GB, capGb: 10 }));
  b.clearCache = clear;
  render(<SettingsDialog backend={b} keep={['C:/v/open.mp4']} onClose={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Clear cache' }));
  await waitFor(() => expect(screen.getByText('0.2 GB used of 10 GB')).toBeTruthy());
  expect(clear).toHaveBeenCalledWith(['C:/v/open.mp4']);
});

test('changing the cap saves it on blur and rejects out-of-range values', async () => {
  const b = new FakeBackend();
  b.cacheInfo = async () => ({ bytes: GB, capGb: 10 });
  const setCap = vi.fn(async (gb: number) => ({ bytes: GB, capGb: gb }));
  b.setCacheCap = setCap;
  render(<SettingsDialog backend={b} keep={[]} onClose={() => {}} />);
  const input = (await screen.findByLabelText('Cache limit (GB)')) as HTMLInputElement;
  fireEvent.change(input, { target: { value: '0' } });
  fireEvent.blur(input);
  expect(setCap).not.toHaveBeenCalled();
  expect(screen.getByText('Enter 1 to 500 GB.')).toBeTruthy();
  fireEvent.change(input, { target: { value: '25' } });
  fireEvent.blur(input);
  await waitFor(() => expect(setCap).toHaveBeenCalledWith(25, []));
});

test('a rejected setCacheCap shows its message', async () => {
  const b = new FakeBackend();
  b.cacheInfo = async () => ({ bytes: GB, capGb: 10 });
  b.setCacheCap = async () => {
    throw new Error('Cache limit must be between 1 and 500 GB.');
  };
  render(<SettingsDialog backend={b} keep={[]} onClose={() => {}} />);
  const input = (await screen.findByLabelText('Cache limit (GB)')) as HTMLInputElement;
  fireEvent.change(input, { target: { value: '25' } });
  fireEvent.blur(input);
  await waitFor(() => expect(screen.getByText('Cache limit must be between 1 and 500 GB.')).toBeTruthy());
});

test('a rejected clearCache shows its message and re-enables the button', async () => {
  const b = new FakeBackend();
  b.cacheInfo = async () => ({ bytes: GB, capGb: 10 });
  b.clearCache = async () => {
    throw new Error('Could not clear the cache.');
  };
  render(<SettingsDialog backend={b} keep={[]} onClose={() => {}} />);
  const button = await screen.findByRole('button', { name: 'Clear cache' });
  fireEvent.click(button);
  await waitFor(() => expect(screen.getByText('Could not clear the cache.')).toBeTruthy());
  expect((button as HTMLButtonElement).disabled).toBe(false);
});

test('Escape closes the dialog', async () => {
  const b = new FakeBackend();
  b.cacheInfo = async () => ({ bytes: GB, capGb: 10 });
  const onClose = vi.fn();
  render(<SettingsDialog backend={b} keep={[]} onClose={onClose} />);
  await screen.findByLabelText('Cache limit (GB)');
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).toHaveBeenCalled();
});

test('the cap input has focus after opening', async () => {
  const b = new FakeBackend();
  b.cacheInfo = async () => ({ bytes: GB, capGb: 10 });
  render(<SettingsDialog backend={b} keep={[]} onClose={() => {}} />);
  const input = await screen.findByLabelText('Cache limit (GB)');
  await waitFor(() => expect(document.activeElement).toBe(input));
});

test('Enter in the cap input saves it', async () => {
  const b = new FakeBackend();
  b.cacheInfo = async () => ({ bytes: GB, capGb: 10 });
  const setCap = vi.fn(async (gb: number) => ({ bytes: GB, capGb: gb }));
  b.setCacheCap = setCap;
  render(<SettingsDialog backend={b} keep={[]} onClose={() => {}} />);
  const input = (await screen.findByLabelText('Cache limit (GB)')) as HTMLInputElement;
  await waitFor(() => expect(input.value).toBe('10'));
  fireEvent.change(input, { target: { value: '30' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(setCap).toHaveBeenCalledWith(30, []));
});

test('the dialog is modal', async () => {
  render(<SettingsDialog backend={new FakeBackend()} keep={[]} onClose={() => {}} />);
  expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true');
});
