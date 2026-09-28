import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import type { MediaStatus } from '../state/useMedia';
import type { MediaRef } from '../timeline/model';
import { MediaRail, mediaStatusText } from './MediaRail';

const info = { width: 1920, height: 1080, fps: '60', codec: 'h264', duration: 65, hasAudio: true, audioTracks: [{ index: 0, label: 'Game', named: true, channels: 2 }] };
const status = (o: Partial<MediaStatus> = {}): MediaStatus => ({ url: 'u', proxied: false, proxyProgress: null, prepared: null, audioError: null, ...o });

test('status text shows preview progress, audio prep and audio failure', () => {
  expect(mediaStatusText(info, status({ proxyProgress: 0.42 }))).toBe('Preparing preview 42%');
  expect(mediaStatusText(info, status())).toBe('Preparing audio…');
  expect(mediaStatusText(info, status({ audioError: 'x' }))).toBe('Audio preview unavailable');
  expect(mediaStatusText(info, status({ prepared: [] }))).toBeNull();
  expect(mediaStatusText({ ...info, audioTracks: [] }, status())).toBeNull();
});

test('lists media; + appends, pressing starts a drag, Import clips opens the picker', () => {
  const media: MediaRef[] = [{ id: 'm1', path: 'C:\\v\\a.mp4', info }];
  const p = { onAdd: vi.fn(), onAppend: vi.fn(), onDragStart: vi.fn() };
  render(<MediaRail media={media} status={{ m1: status({ prepared: [] }) }} {...p} />);
  expect(screen.getByText('a.mp4')).toBeTruthy();
  expect(screen.getByText('1:05.0')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Add a.mp4 to the timeline' }));
  expect(p.onAppend).toHaveBeenCalledWith('m1');
  expect(p.onDragStart).not.toHaveBeenCalled();
  fireEvent.pointerDown(screen.getByText('a.mp4'));
  expect(p.onDragStart).toHaveBeenCalledWith('m1');
  fireEvent.click(screen.getByRole('button', { name: 'Import clips' }));
  expect(p.onAdd).toHaveBeenCalled();
});
