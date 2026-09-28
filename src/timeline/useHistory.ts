import { useCallback, useState } from 'react';
import { initHistory, push, redo, replace, rewrite, undo } from './history';

type Next<T> = T | ((prev: T) => T);
const resolve = <T>(next: Next<T>, prev: T): T => (typeof next === 'function' ? (next as (p: T) => T)(prev) : next);

export function useHistory<T>(initial: () => T) {
  const [h, setH] = useState(() => initHistory(initial()));
  const set = useCallback((next: Next<T>, key: string | null = null) => setH((x) => push(x, resolve(next, x.present), key)), []);
  const replaceNow = useCallback((next: Next<T>) => setH((x) => replace(x, resolve(next, x.present))), []);
  const rewriteNow = useCallback((fn: (t: T) => T) => setH((x) => rewrite(x, fn)), []);
  const undoNow = useCallback(() => setH((x) => undo(x)), []);
  const redoNow = useCallback(() => setH((x) => redo(x)), []);
  return { present: h.present, set, replace: replaceNow, rewrite: rewriteNow, undo: undoNow, redo: redoNow, canUndo: h.past.length > 0, canRedo: h.future.length > 0 };
}
