import { useEffect, useRef } from 'react';

export interface EditorKeyHandlers {
  togglePlay(): void;
  split(): void;
  remove(): void;
  freeze(): void;
  setIn(): void;
  setOut(): void;
  step(dir: -1 | 1): void;
  undo(): void;
  redo(): void;
}

const typing = (el: EventTarget | null) => {
  const e = el as HTMLElement | null;
  return !!e && (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || e.tagName === 'SELECT' || e.isContentEditable);
};

/** Space play · C cut · Delete/Backspace remove · F freeze · I/O trim to playhead · ←/→ frame · Ctrl/Cmd+Z undo · Shift+Ctrl/Cmd+Z or Ctrl+Y redo. */
export function useEditorKeys(h: EditorKeyHandlers, enabled: boolean) {
  const ref = useRef(h);
  ref.current = h;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target)) return;
      const k = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      const x = ref.current;
      if (mod && k === 'z') {
        e.preventDefault();
        if (e.shiftKey) x.redo();
        else x.undo();
        return;
      }
      if (mod && k === 'y') {
        e.preventDefault();
        x.redo();
        return;
      }
      if (mod || e.altKey) return;
      if (k === ' ') {
        e.preventDefault();
        x.togglePlay();
      } else if (k === 'c') x.split();
      else if (k === 'delete' || k === 'backspace') {
        e.preventDefault();
        x.remove();
      } else if (k === 'f') x.freeze();
      else if (k === 'i') x.setIn();
      else if (k === 'o') x.setOut();
      else if (e.key === 'ArrowLeft') x.step(-1);
      else if (e.key === 'ArrowRight') x.step(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
