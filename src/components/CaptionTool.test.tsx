import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { expect, test, vi } from 'vitest';
import type { Caption } from '../types';
import { CaptionTool } from './CaptionTool';

function Harness({ initial = [] as Caption[], onTrackStyle = vi.fn(), onRun = vi.fn(), onMerge = vi.fn() }) {
  const [captions, setCaptions] = useState<Caption[]>(initial);
  const [sel, setSel] = useState<string | null>(null);
  return (
    <CaptionTool captions={captions} selectedId={sel} video={null} onChange={setCaptions} onSelect={setSel}
      onRun={onRun} onMerge={onMerge} trackStyles={[{ trackIndex: 2, label: 'Discord', style: { style: 'tiktok', color: '#FFE14D', y: 0.82 } }]} onTrackStyle={onTrackStyle} />
  );
}

const auto = (id: string, text: string, start: number, end: number): Caption => ({ id, text, style: 'tiktok', x: 0.5, y: 0.82, fontSize: 80 / 1920, start, end, source: 'auto', trackIndex: 2 });

test('add, edit, restyle and delete a caption', () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Add caption' }));
  const text = screen.getByRole('textbox', { name: 'Caption text' }) as HTMLInputElement;
  expect(text.value).toBe('Your caption');
  fireEvent.change(text, { target: { value: 'CLUTCH' } });
  expect((screen.getByRole('textbox', { name: 'Caption text' }) as HTMLInputElement).value).toBe('CLUTCH');
  fireEvent.change(screen.getByLabelText('Style'), { target: { value: 'impact' } });
  expect((screen.getByLabelText('Style') as HTMLSelectElement).value).toBe('impact');
  expect((screen.getByLabelText('Whole clip') as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  expect(screen.queryByRole('textbox', { name: 'Caption text' })).toBeNull();
});

test('rows are in time order with their range; editing an auto-line marks it edited', () => {
  let latest: Caption[] = [];
  function Spy() {
    const [captions, setCaptions] = useState<Caption[]>([auto('b', 'two', 3, 4), auto('a', 'one', 1, 2)]);
    const [sel, setSel] = useState<string | null>(null);
    const onChange = (c: Caption[]) => {
      latest = c;
      setCaptions(c);
    };
    return <CaptionTool captions={captions} selectedId={sel} video={null} onChange={onChange} onSelect={setSel} onRun={vi.fn()} onMerge={vi.fn()} trackStyles={[]} onTrackStyle={vi.fn()} />;
  }
  render(<Spy />);
  const rows = screen.getAllByRole('textbox', { name: 'Caption text' }) as HTMLInputElement[];
  expect(rows.map((r) => r.value)).toEqual(['one', 'two']);
  expect(screen.getByText('0:01.0–0:02.0')).toBeTruthy();
  fireEvent.change(rows[0], { target: { value: 'ONE' } });
  expect(latest.find((c) => c.id === 'a')).toMatchObject({ text: 'ONE', edited: true });
});

test('Merge with next and Auto-caption scope reach their callbacks; track styles change', () => {
  const onMerge = vi.fn();
  const onRun = vi.fn();
  const onTrackStyle = vi.fn();
  render(<Harness initial={[auto('a', 'one', 1, 2), auto('b', 'two', 3, 4)]} onMerge={onMerge} onRun={onRun} onTrackStyle={onTrackStyle} />);
  fireEvent.click(screen.getByText('0:01.0–0:02.0'));
  fireEvent.click(screen.getByRole('button', { name: 'Merge with next' }));
  expect(onMerge).toHaveBeenCalledWith('a');
  fireEvent.change(screen.getByLabelText('Auto-caption scope'), { target: { value: 'clip' } });
  fireEvent.click(screen.getByRole('button', { name: 'Auto-caption' }));
  expect(onRun).toHaveBeenCalledWith('clip');
  fireEvent.change(screen.getByLabelText('Discord colour'), { target: { value: '#ff0000' } });
  expect(onTrackStyle).toHaveBeenCalledWith(2, { style: 'tiktok', color: '#ff0000', y: 0.82 });
});
