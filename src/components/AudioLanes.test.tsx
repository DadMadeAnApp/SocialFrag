import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import type { AudioMix } from '../types';
import { AudioLanes } from './AudioLanes';

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

const info = { width: 1920, height: 1080, fps: '60', codec: 'h264', duration: 10, hasAudio: true, audioTracks: [{ index: 0, label: 'Game', named: true, channels: 2 }] };
const mix: AudioMix = { tracks: [{ index: 0, sourceLabel: 'Game', label: 'Game', enabled: true, gain: 1, ceilingDb: null, offsetS: 0, fadeInS: 0, fadeOutS: 0, mutes: [{ startS: 6, endS: 7 }] }], duck: null };

function lane() {
  const el = screen.getByLabelText('Game lane');
  el.getBoundingClientRect = () => ({ left: 0, width: 1000, top: 0, height: 40, right: 1000, bottom: 40, x: 0, y: 0, toJSON: () => ({}) });
  el.setPointerCapture = () => {};
  return el;
}

test('drag on an empty lane creates a mute range', () => {
  const onChange = vi.fn();
  render(<AudioLanes video={null} info={info} trim={{ inS: 0, outS: 10 }} mix={mix} envelopes={new Map()} onChange={onChange} />);
  const el = lane();
  fireEvent.pointerDown(el, { clientX: 200, pointerId: 1 });
  fireEvent.pointerMove(el, { clientX: 400, pointerId: 1 });
  fireEvent.pointerUp(el, { clientX: 400, pointerId: 1 });
  expect(onChange.mock.calls.at(-1)![0].tracks[0].mutes).toEqual([{ startS: 2, endS: 4 }, { startS: 6, endS: 7 }]);
});

test('× removes a mute range', () => {
  const onChange = vi.fn();
  render(<AudioLanes video={null} info={info} trim={{ inS: 0, outS: 10 }} mix={mix} envelopes={new Map()} onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'Remove mute 6.0–7.0 s' }));
  expect(onChange.mock.calls[0][0].tracks[0].mutes).toEqual([]);
});
