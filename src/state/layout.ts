/** Resizable panel sizes, remembered per viewer in localStorage. */
export interface PanelLayout { railW: number; sideW: number; timelineH: number; railCollapsed: boolean; sideCollapsed: boolean }

export const DEFAULT_LAYOUT: PanelLayout = { railW: 260, sideW: 320, timelineH: 200, railCollapsed: false, sideCollapsed: false };
export const LIMITS = { railW: [180, 420], sideW: [260, 560], timelineMin: 80, timelineMaxFrac: 0.6 } as const;
export const COLLAPSED_W = 32;
const KEY = 'socialfrag.layout';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function clampLayout(l: PanelLayout, windowH: number): PanelLayout {
  return {
    railW: clamp(l.railW, LIMITS.railW[0], LIMITS.railW[1]),
    sideW: clamp(l.sideW, LIMITS.sideW[0], LIMITS.sideW[1]),
    timelineH: clamp(l.timelineH, LIMITS.timelineMin, Math.max(LIMITS.timelineMin, windowH * LIMITS.timelineMaxFrac)),
    railCollapsed: l.railCollapsed,
    sideCollapsed: l.sideCollapsed,
  };
}

export function loadLayout(storage: Pick<Storage, 'getItem'> | null, windowH: number): PanelLayout {
  try {
    const raw: unknown = JSON.parse(storage?.getItem(KEY) ?? 'null');
    if (!raw || typeof raw !== 'object') return clampLayout(DEFAULT_LAYOUT, windowH);
    const r = raw as Record<string, unknown>;
    const num = (k: keyof PanelLayout) => (typeof r[k] === 'number' && Number.isFinite(r[k]) ? (r[k] as number) : (DEFAULT_LAYOUT[k] as number));
    const bool = (k: keyof PanelLayout) => (typeof r[k] === 'boolean' ? (r[k] as boolean) : (DEFAULT_LAYOUT[k] as boolean));
    return clampLayout({ railW: num('railW'), sideW: num('sideW'), timelineH: num('timelineH'), railCollapsed: bool('railCollapsed'), sideCollapsed: bool('sideCollapsed') }, windowH);
  } catch {
    return clampLayout(DEFAULT_LAYOUT, windowH);
  }
}

export function saveLayout(storage: Pick<Storage, 'setItem'> | null, l: PanelLayout) {
  try {
    storage?.setItem(KEY, JSON.stringify(l));
  } catch {
    /* storage blocked: layout lasts for this session only */
  }
}

/** window.localStorage can throw on access (private mode, blocked site data). */
export function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
