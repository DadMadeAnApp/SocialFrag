import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import type { Layer } from '../types';
import { HudPanel } from './HudPanel';

const layers: Layer[] = [
  { id: 'gameplay', label: 'Gameplay', src: [0, 0, 1, 1], dst: [0, 0, 1080, 1920], fit: 'cover' },
  { id: 'killfeed', label: 'Killfeed', src: [0, 0, 1, 1], dst: [30, 150, 480, 255], fit: 'contain' },
  { id: 'minimap', label: 'Minimap', src: [0, 0, 1, 1], dst: [788, 130, 262, 300], fit: 'contain', hidden: true },
];

test('lists non-gameplay layers with checkboxes reflecting visibility', () => {
  render(<HudPanel layers={layers} onToggle={() => {}} onReset={() => {}} onSave={() => {}} />);
  expect(screen.queryByLabelText('Show Gameplay')).toBeNull();
  expect((screen.getByLabelText('Show Killfeed') as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText('Show Minimap') as HTMLInputElement).checked).toBe(false);
});

test('toggling a checkbox flips hidden on that layer', () => {
  const onToggle = vi.fn();
  render(<HudPanel layers={layers} onToggle={onToggle} onReset={() => {}} onSave={() => {}} />);
  fireEvent.click(screen.getByLabelText('Show Killfeed'));
  expect(onToggle).toHaveBeenCalledWith({ ...layers[1], hidden: true });
  fireEvent.click(screen.getByLabelText('Show Minimap'));
  expect(onToggle).toHaveBeenCalledWith({ ...layers[2], hidden: false });
});

test('reset and save buttons call their handlers', () => {
  const onReset = vi.fn();
  const onSave = vi.fn();
  render(<HudPanel layers={layers} onToggle={() => {}} onReset={onReset} onSave={onSave} />);
  fireEvent.click(screen.getByRole('button', { name: 'Reset to preset' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save layout to preset' }));
  expect(onReset).toHaveBeenCalled();
  expect(onSave).toHaveBeenCalled();
});
