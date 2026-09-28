import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { layoutClips, type TimelineClip } from '../timeline/model';
import type { TimelinePlayer } from '../timeline/player';
import { Timeline, dropIndex, tickStep } from './Timeline';

const clip = (id: string, o: Partial<TimelineClip> = {}): TimelineClip => ({
  id, kind: 'video', mediaId: 'm', inS: 0, outS: 4, speed: 1, presetId: 'p', layers: [], mix: { tracks: [], duck: null }, captions: [], captionStyles: {}, ...o,
});

// jsdom lays nothing out: the track starts at x = 0 and the view isn't fitted, so it runs at 50 px per second.
function renderTimeline(clips: TimelineClip[], over: Record<string, unknown> = {}) {
  const props = {
    player: null as TimelinePlayer | null, laid: layoutClips(clips), nameOf: () => 'a.mp4', thumbOf: () => null, selectedId: null, draggingMediaId: null,
    onSelect: vi.fn(), onTrim: vi.fn(), onFreezeLength: vi.fn(), onMove: vi.fn(), onDropMedia: vi.fn(), onAdd: vi.fn(),
    tools: {
      togglePlay: vi.fn(), split: vi.fn(), remove: vi.fn(), freeze: vi.fn(), setIn: vi.fn(), setOut: vi.fn(), step: vi.fn(), undo: vi.fn(), redo: vi.fn(),
      canUndo: true, canRedo: true,
    },
    ...over,
  };
  render(<Timeline {...props} />);
  return props;
}

test('clips sit at 50 px per second with their names, speed and freeze labels', () => {
  renderTimeline([clip('a'), clip('b', { speed: 2 }), clip('f', { kind: 'freeze', inS: 1, outS: 4 })]);
  const b = screen.getByRole('button', { name: 'Clip 2: a.mp4' });
  expect([b.style.left, b.style.width]).toEqual(['200px', '100px']);
  expect(b.textContent).toContain('2×');
  expect(screen.getByRole('button', { name: 'Clip 3: a.mp4' }).textContent).toContain('Freeze');
});

test('a click selects a clip; dragging it past the next clip’s middle reorders', () => {
  const p = renderTimeline([clip('a'), clip('b')]);
  const a = screen.getByRole('button', { name: 'Clip 1: a.mp4' });
  fireEvent.pointerDown(a, { clientX: 10, pointerId: 1 });
  fireEvent.pointerUp(a, { clientX: 10, pointerId: 1 });
  expect(p.onSelect).toHaveBeenCalledWith('a');
  fireEvent.pointerDown(a, { clientX: 10, pointerId: 1 });
  fireEvent.pointerMove(a, { clientX: 330, pointerId: 1 });
  fireEvent.pointerUp(a, { clientX: 330, pointerId: 1 });
  expect(p.onMove).toHaveBeenCalledWith('a', 1);
});

test('dragging an edge trims in source seconds, scaled by speed', () => {
  const p = renderTimeline([clip('a', { speed: 2 })]);
  const edge = screen.getByLabelText('Trim end of clip 1');
  fireEvent.pointerDown(edge, { clientX: 100, pointerId: 1 });
  fireEvent.pointerMove(edge, { clientX: 150, pointerId: 1 });
  expect(p.onTrim).toHaveBeenLastCalledWith('a', 'out', 6);
  const start = screen.getByLabelText('Trim start of clip 1');
  fireEvent.pointerDown(start, { clientX: 0, pointerId: 1 });
  fireEvent.pointerMove(start, { clientX: 25, pointerId: 1 });
  expect(p.onTrim).toHaveBeenLastCalledWith('a', 'in', 1);
});

test('dragging a freeze frame’s end changes its hold', () => {
  const p = renderTimeline([clip('f', { kind: 'freeze', inS: 2, outS: 5 })]);
  const edge = screen.getByLabelText('Trim end of clip 1');
  fireEvent.pointerDown(edge, { clientX: 150, pointerId: 1 });
  fireEvent.pointerMove(edge, { clientX: 200, pointerId: 1 });
  expect(p.onFreezeLength).toHaveBeenLastCalledWith('f', 4);
  expect(screen.queryByLabelText('Trim start of clip 1')).toBeNull();
});

test('releasing a dragged media item over the track drops it between clips', () => {
  const p = renderTimeline([clip('a'), clip('b')], { draggingMediaId: 'm2' });
  fireEvent.pointerUp(screen.getByLabelText('Main track'), { clientX: 250, pointerId: 1 });
  expect(p.onDropMedia).toHaveBeenCalledWith('m2', 1);
});

test('the ruler seeks the player', () => {
  const player = { currentTime: 0, paused: true } as unknown as TimelinePlayer;
  renderTimeline([clip('a')], { player });
  fireEvent.pointerDown(screen.getByLabelText('Timeline ruler'), { clientX: 100, pointerId: 1 });
  expect(player.currentTime).toBe(2);
});

test('dropIndex counts the clips whose middle is left of t; tickStep keeps labels apart', () => {
  const laid = layoutClips([clip('a'), clip('b'), clip('c')]);
  expect(dropIndex(laid, 0)).toBe(0);
  expect(dropIndex(laid, 7)).toBe(2);
  expect(dropIndex(laid, 7, 'a')).toBe(1);
  expect(tickStep(50)).toBe(2);
  expect(tickStep(1)).toBe(120);
});

const TOOL_BUTTONS: [string, string][] = [
  ['Previous frame (←)', 'step'],
  ['Next frame (→)', 'step'],
  ['Set in (I)', 'setIn'],
  ['Set out (O)', 'setOut'],
  ['Split (S)', 'split'],
  ['Delete clip (Delete)', 'remove'],
  ['Freeze frame (F)', 'freeze'],
  ['Undo (Ctrl+Z)', 'undo'],
  ['Redo (Ctrl+Shift+Z)', 'redo'],
];

test('each toolbar button calls its handler once when clicked', () => {
  const player = {} as unknown as TimelinePlayer;
  const p = renderTimeline([clip('a')], { player, selectedId: 'a' });
  for (const [label, key] of TOOL_BUTTONS) {
    const fn = (p.tools as unknown as Record<string, ReturnType<typeof vi.fn>>)[key];
    fn.mockClear();
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(fn).toHaveBeenCalledTimes(1);
  }
});

test('delete is disabled with no clip selected', () => {
  const player = {} as unknown as TimelinePlayer;
  renderTimeline([clip('a')], { player, selectedId: null });
  expect((screen.getByRole('button', { name: 'Delete clip (Delete)' }) as HTMLButtonElement).disabled).toBe(true);
});

test('undo and redo are disabled when canUndo/canRedo are false', () => {
  const player = {} as unknown as TimelinePlayer;
  renderTimeline([clip('a')], { player, tools: { togglePlay: vi.fn(), split: vi.fn(), remove: vi.fn(), freeze: vi.fn(), setIn: vi.fn(), setOut: vi.fn(), step: vi.fn(), undo: vi.fn(), redo: vi.fn(), canUndo: false, canRedo: false } });
  expect((screen.getByRole('button', { name: 'Undo (Ctrl+Z)' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Redo (Ctrl+Shift+Z)' }) as HTMLButtonElement).disabled).toBe(true);
});

test('clip tools are disabled with no clips', () => {
  renderTimeline([], {});
  for (const label of ['Previous frame (←)', 'Next frame (→)', 'Set in (I)', 'Set out (O)', 'Split (S)', 'Freeze frame (F)']) {
    expect((screen.getByRole('button', { name: label }) as HTMLButtonElement).disabled).toBe(true);
  }
});
