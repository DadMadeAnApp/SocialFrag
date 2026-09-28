import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { fullFramePreset } from '../presets/presets';
import { recordingCtx } from '../test/recordingCtx';
import { LANDSCAPE_CANVAS, VERTICAL_CANVAS, type Caption, type ClipInfo, type Preset } from '../types';
import { PreviewCanvas } from './PreviewCanvas';

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

const info: ClipInfo = { width: 1920, height: 1080, fps: '60', codec: 'h264', duration: 10, hasAudio: false, audioTracks: [] };

const preset: Preset = {
  id: 'p',
  name: 'P',
  game: '',
  version: 1,
  builtin: true,
  background: { type: 'none' },
  layers: [
    { id: 'gameplay', label: 'Gameplay', src: [0, 0, 1, 1], dst: [0, 0, 1080, 1920], fit: 'cover' },
    { id: 'killfeed', label: 'Killfeed', src: [0, 0, 1, 1], dst: [30, 150, 480, 255], fit: 'contain' },
  ],
};

function setup(props: Partial<Parameters<typeof PreviewCanvas>[0]> = {}, captions: Caption[] = []) {
  const { ctx } = recordingCtx();
  (globalThis as any).HTMLCanvasElement.prototype.getContext = () => ctx;
  const onLayerChange = vi.fn();
  const onCaptionChange = vi.fn();
  const onSelectCaption = vi.fn();
  render(
    <PreviewCanvas
      video={null}
      info={info}
      preset={preset}
      captions={captions}
      selectedCaptionId={null}
      onSelectCaption={onSelectCaption}
      onCaptionChange={onCaptionChange}
      onLayerChange={onLayerChange}
      canvas={VERTICAL_CANVAS}
      {...props}
    />,
  );
  const canvas = screen.getByLabelText('Vertical preview') as HTMLCanvasElement;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1080, height: 1920, right: 1080, bottom: 1920, x: 0, y: 0, toJSON: () => ({}) });
  canvas.setPointerCapture = () => {};
  return { canvas, onLayerChange, onCaptionChange, onSelectCaption };
}

test('dragging the body of a HUD rect moves it', () => {
  const { canvas, onLayerChange } = setup();
  fireEvent.pointerDown(canvas, { clientX: 200, clientY: 200, pointerId: 1 });
  fireEvent.pointerMove(canvas, { clientX: 220, clientY: 210, pointerId: 1 });
  expect(onLayerChange).toHaveBeenCalledWith(expect.objectContaining({ id: 'killfeed', dst: [50, 160, 480, 255] }));
});

test('dragging a corner resizes the HUD rect', () => {
  const { canvas, onLayerChange } = setup();
  fireEvent.pointerDown(canvas, { clientX: 510, clientY: 405, pointerId: 1 });
  fireEvent.pointerMove(canvas, { clientX: 530, clientY: 415, pointerId: 1 });
  expect(onLayerChange).toHaveBeenCalledWith(expect.objectContaining({ id: 'killfeed', dst: [30, 150, 500, 265] }));
});

test('the gameplay layer is never draggable in the main preview', () => {
  const { canvas, onLayerChange } = setup();
  fireEvent.pointerDown(canvas, { clientX: 900, clientY: 900, pointerId: 1 });
  fireEvent.pointerMove(canvas, { clientX: 950, clientY: 950, pointerId: 1 });
  expect(onLayerChange).not.toHaveBeenCalled();
});

test('captions take hit-test priority over HUD layers underneath them', () => {
  const cap: Caption = { id: 'c1', text: 'Hi', style: 'plain', x: 200 / 1080, y: 200 / 1920, fontSize: 60 / 1920, start: 0, source: 'manual' as const };
  const { canvas, onSelectCaption, onLayerChange, onCaptionChange } = setup({}, [cap]);
  fireEvent.pointerDown(canvas, { clientX: 200, clientY: 200, pointerId: 1 });
  expect(onSelectCaption).toHaveBeenCalledWith('c1');
  fireEvent.pointerMove(canvas, { clientX: 210, clientY: 210, pointerId: 1 });
  expect(onCaptionChange).toHaveBeenCalled();
  expect(onLayerChange).not.toHaveBeenCalled();
});

test('landscape: labelled, sized 1920x1080, caption drag moves by canvas fractions', () => {
  const cap: Caption = { id: 'c1', text: 'Hi', style: 'plain', x: 0.5, y: 0.5, fontSize: 0.05, start: 0, source: 'manual' as const };
  const { ctx } = recordingCtx();
  (globalThis as any).HTMLCanvasElement.prototype.getContext = () => ctx;
  const onCaptionChange = vi.fn();
  render(<PreviewCanvas video={null} info={info} preset={fullFramePreset(LANDSCAPE_CANVAS)} canvas={LANDSCAPE_CANVAS} captions={[cap]} selectedCaptionId={null} onSelectCaption={vi.fn()} onCaptionChange={onCaptionChange} onLayerChange={vi.fn()} />);
  const canvas = screen.getByLabelText('Landscape preview') as HTMLCanvasElement;
  expect([canvas.width, canvas.height]).toEqual([1920, 1080]);
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 960, height: 540, right: 960, bottom: 540, x: 0, y: 0, toJSON: () => ({}) });
  canvas.setPointerCapture = () => {};
  fireEvent.pointerDown(canvas, { clientX: 480, clientY: 270, pointerId: 1 });
  fireEvent.pointerMove(canvas, { clientX: 576, clientY: 270, pointerId: 1 });
  expect(onCaptionChange).toHaveBeenLastCalledWith(expect.objectContaining({ x: 0.6, y: 0.5 }));
});
