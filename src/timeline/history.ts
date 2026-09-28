export const HISTORY_CAP = 200;
/** Pushes with the same key closer together than this merge into one undo step (drags, typing). */
export const COALESCE_MS = 1000;

export interface History<T> { past: T[]; present: T; future: T[]; key: string | null; at: number }

export const initHistory = <T>(present: T): History<T> => ({ past: [], present, future: [], key: null, at: 0 });

export function push<T>(h: History<T>, next: T, key: string | null = null, now = Date.now()): History<T> {
  if (next === h.present) return h;
  if (key !== null && key === h.key && now - h.at <= COALESCE_MS) return { ...h, present: next, future: [], at: now };
  return { past: [...h.past, h.present].slice(-HISTORY_CAP), present: next, future: [], key, at: now };
}

/** A change the user didn't make (e.g. ducking dropped after audio prep failed): no undo step. */
export const replace = <T>(h: History<T>, next: T): History<T> => ({ ...h, present: next });

/** Applies `fn` to every entry in the whole undo history, so a change reaches past and future steps too. */
export const rewrite = <T>(h: History<T>, fn: (t: T) => T): History<T> => ({
  ...h,
  past: h.past.map(fn),
  present: fn(h.present),
  future: h.future.map(fn),
});

export function undo<T>(h: History<T>): History<T> {
  if (!h.past.length) return h;
  return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future], key: null, at: 0 };
}

export function redo<T>(h: History<T>): History<T> {
  if (!h.future.length) return h;
  return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1), key: null, at: 0 };
}
