import { renderHook } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { useEditorKeys, type EditorKeyHandlers } from './useEditorKeys';

const handlers = (): EditorKeyHandlers => ({
  togglePlay: vi.fn(), split: vi.fn(), remove: vi.fn(), freeze: vi.fn(), setIn: vi.fn(), setOut: vi.fn(), step: vi.fn(), undo: vi.fn(), redo: vi.fn(),
});
const key = (k: string, o: KeyboardEventInit = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, ...o }));

test('editing shortcuts call their handlers', () => {
  const h = handlers();
  renderHook(() => useEditorKeys(h, true));
  key(' ');
  key('c');
  key('c', { ctrlKey: true }); // Ctrl+C is copy, not cut
  key('Delete');
  key('Backspace');
  key('F');
  key('i');
  key('o');
  key('ArrowLeft');
  key('ArrowRight');
  key('z', { ctrlKey: true });
  key('Z', { ctrlKey: true, shiftKey: true });
  key('z', { metaKey: true });
  key('y', { ctrlKey: true });
  expect(h.togglePlay).toHaveBeenCalledTimes(1);
  expect(h.split).toHaveBeenCalledTimes(1);
  expect(h.remove).toHaveBeenCalledTimes(2);
  expect(h.freeze).toHaveBeenCalledTimes(1);
  expect([h.setIn, h.setOut].map((f) => (f as ReturnType<typeof vi.fn>).mock.calls.length)).toEqual([1, 1]);
  expect((h.step as ReturnType<typeof vi.fn>).mock.calls).toEqual([[-1], [1]]);
  expect(h.undo).toHaveBeenCalledTimes(2);
  expect(h.redo).toHaveBeenCalledTimes(2);
});

test('keys typed into a field, or with the hook disabled, do nothing', () => {
  const h = handlers();
  const { rerender } = renderHook(({ on }) => useEditorKeys(h, on), { initialProps: { on: true } });
  const input = document.createElement('input');
  document.body.appendChild(input);
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
  expect(h.split).not.toHaveBeenCalled();
  rerender({ on: false });
  key('s');
  expect(h.split).not.toHaveBeenCalled();
  input.remove();
});
