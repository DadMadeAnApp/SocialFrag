import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import type { AudioMix } from '../types';
import { AudioMixer } from './AudioMixer';

const mix: AudioMix = {
  tracks: ['Game', 'Discord'].map((l, index) => ({ index, sourceLabel: l, label: l, enabled: true, gain: 1, ceilingDb: null, offsetS: 0, fadeInS: 0, fadeOutS: 0, mutes: [] })),
  duck: null,
};
const props = { mix, notice: null, previewError: null, hasAudio: true, canDuck: true, onSaveToPreset: () => {} };

test('gain, remove/restore, ceiling and rename update the mix', () => {
  const onChange = vi.fn();
  render(<AudioMixer {...props} onChange={onChange} />);
  fireEvent.change(screen.getByLabelText('Game gain %'), { target: { value: '150' } });
  expect(onChange.mock.calls.at(-1)![0].tracks[0].gain).toBeCloseTo(1.5);
  fireEvent.click(screen.getByRole('button', { name: 'Remove Discord' }));
  expect(onChange.mock.calls.at(-1)![0].tracks[1].enabled).toBe(false);
  fireEvent.click(screen.getByLabelText('Game ceiling on'));
  expect(onChange.mock.calls.at(-1)![0].tracks[0].ceilingDb).toBe(-3);
  fireEvent.change(screen.getByLabelText('Game name'), { target: { value: 'Game audio' } });
  expect(onChange.mock.calls.at(-1)![0].tracks[0]).toMatchObject({ label: 'Game audio', sourceLabel: 'Game' });
});

test('typing a partial "-" in offset does not clobber it, and "-0.5" commits', () => {
  const onChange = vi.fn();
  render(<AudioMixer {...props} onChange={onChange} />);
  const offset = screen.getByLabelText('Game offset') as HTMLInputElement;
  fireEvent.change(offset, { target: { value: '-' } });
  expect(offset.value).toBe('-');
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.change(offset, { target: { value: '-0.5' } });
  expect(offset.value).toBe('-0.5');
  expect(onChange.mock.calls.at(-1)![0].tracks[0].offsetS).toBeCloseTo(-0.5);
});

test('removed track shows Restore', () => {
  const onChange = vi.fn();
  const off = { ...mix, tracks: [{ ...mix.tracks[0], enabled: false }, mix.tracks[1]] };
  render(<AudioMixer {...props} mix={off} onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'Restore Game' }));
  expect(onChange.mock.calls[0][0].tracks[0].enabled).toBe(true);
});

test('enabling duck picks sensible defaults', () => {
  const onChange = vi.fn();
  render(<AudioMixer {...props} onChange={onChange} />);
  fireEvent.click(screen.getByLabelText('Duck'));
  expect(onChange.mock.calls[0][0].duck).toEqual({ targets: [0], triggers: [1], amountDb: -10, thresholdDb: -40, releaseS: 0.4 });
});

test('no audio and notices', () => {
  render(<AudioMixer {...props} hasAudio={false} onChange={() => {}} />);
  expect(screen.getByText('No audio in this clip.')).toBeTruthy();
});

test('save mix to preset', () => {
  const onSave = vi.fn();
  render(<AudioMixer {...props} onChange={() => {}} onSaveToPreset={onSave} notice="Couldn't apply the preset's audio mix — using all tracks." />);
  expect(screen.getByRole('status').textContent).toContain("Couldn't apply");
  fireEvent.click(screen.getByRole('button', { name: 'Save mix to preset' }));
  expect(onSave).toHaveBeenCalled();
});
