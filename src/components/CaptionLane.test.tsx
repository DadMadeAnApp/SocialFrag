import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { CaptionLane } from './CaptionLane';

if (typeof (globalThis as any).PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 0;
    }
  }
  (globalThis as any).PointerEvent = PointerEventPolyfill;
}

const clip = (over = {}) => ({ id: 'c1', kind: 'video', mediaId: 'm', inS: 10, outS: 20, speed: 2, presetId: 'p', layers: [], mix: { tracks: [], duck: null }, captionStyles: {},
  captions: [{ id: 'a', text: 'hi', style: 'plain', x: 0.5, y: 0.8, fontSize: 0.04, start: 12, end: 14, source: 'auto', trackIndex: 1, color: '#FFE14D' }], ...over });

test('blocks sit at timeline time (speed-aware) and take the caption colour', () => {
  render(<CaptionLane laid={[{ clip: clip() as never, index: 0, startS: 3, durS: 5 }]} pps={100} selectedCaptionId={null} onSelect={vi.fn()} onRetime={vi.fn()} />);
  const block = screen.getByRole('button', { name: 'Caption: hi' });
  expect(block.style.left).toBe('400px'); // 3 + (12-10)/2 = 4 s
  expect(block.style.width).toBe('100px'); // (14-12)/2 = 1 s
  expect(block.style.background).toContain('255, 225, 77');
});

test('dragging the right edge retimes the end in source seconds', () => {
  const onRetime = vi.fn();
  render(<CaptionLane laid={[{ clip: clip() as never, index: 0, startS: 3, durS: 5 }]} pps={100} selectedCaptionId="a" onSelect={vi.fn()} onRetime={onRetime} />);
  const handle = screen.getByLabelText('Caption end: hi');
  fireEvent.pointerDown(handle, { clientX: 500, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientX: 550, pointerId: 1 });
  expect(onRetime).toHaveBeenLastCalledWith('c1', 'a', 12, 15); // +0.5 s timeline = +1 s source at speed 2
});
