import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import type { TimelineClip } from '../timeline/model';
import { ClipInspector } from './ClipInspector';

const clip = (o: Partial<TimelineClip> = {}): TimelineClip => ({
  id: 'c', kind: 'video', mediaId: 'm', inS: 2, outS: 6, speed: 1, presetId: 'p', layers: [], mix: { tracks: [], duck: null }, captions: [], captionStyles: {}, ...o,
});

test('a video clip edits speed and can be deleted', () => {
  const p = { onSpeed: vi.fn(), onFreezeLength: vi.fn(), onDelete: vi.fn() };
  render(<ClipInspector clip={clip()} name="a.mp4" {...p} />);
  expect(screen.getByText('0:02.0 – 0:06.0 of the source')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Speed'), { target: { value: '2' } });
  expect(p.onSpeed).toHaveBeenLastCalledWith(2);
  fireEvent.click(screen.getByRole('button', { name: 'Delete clip' }));
  expect(p.onDelete).toHaveBeenCalled();
});

test('a freeze frame edits its hold instead of speed', () => {
  const p = { onSpeed: vi.fn(), onFreezeLength: vi.fn(), onDelete: vi.fn() };
  render(<ClipInspector clip={clip({ kind: 'freeze', inS: 3, outS: 6 })} name="a.mp4" {...p} />);
  expect(screen.queryByLabelText('Speed')).toBeNull();
  fireEvent.change(screen.getByLabelText('Hold seconds'), { target: { value: '5' } });
  expect(p.onFreezeLength).toHaveBeenLastCalledWith(5);
});
