import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { Splitter } from './Splitter';

const setup = (direction: 1 | -1 = 1) => {
  const onChange = vi.fn();
  const onReset = vi.fn();
  render(<Splitter orientation="vertical" label="Resize rail" value={260} min={180} max={420} direction={direction} onChange={onChange} onReset={onReset} />);
  return { el: screen.getByRole('separator', { name: 'Resize rail' }), onChange, onReset };
};

test('drag changes the value by the pointer delta, clamped', () => {
  const { el, onChange } = setup();
  fireEvent.pointerDown(el, { clientX: 100, pointerId: 1 });
  fireEvent.pointerMove(el, { clientX: 140, pointerId: 1 });
  expect(onChange).toHaveBeenLastCalledWith(300);
  fireEvent.pointerMove(el, { clientX: 900, pointerId: 1 });
  expect(onChange).toHaveBeenLastCalledWith(420);
  fireEvent.pointerUp(el, { pointerId: 1 });
  fireEvent.pointerMove(el, { clientX: 0, pointerId: 1 });
  expect(onChange).toHaveBeenCalledTimes(2);
});

test('direction −1 shrinks when dragging right (right-hand sidebar)', () => {
  const { el, onChange } = setup(-1);
  fireEvent.pointerDown(el, { clientX: 100, pointerId: 1 });
  fireEvent.pointerMove(el, { clientX: 120, pointerId: 1 });
  expect(onChange).toHaveBeenLastCalledWith(240);
});

test('arrow keys step, shift steps ×4, double-click resets', () => {
  const { el, onChange, onReset } = setup();
  fireEvent.keyDown(el, { key: 'ArrowRight' });
  expect(onChange).toHaveBeenLastCalledWith(276);
  fireEvent.keyDown(el, { key: 'ArrowLeft', shiftKey: true });
  expect(onChange).toHaveBeenLastCalledWith(196);
  fireEvent.doubleClick(el);
  expect(onReset).toHaveBeenCalled();
});
