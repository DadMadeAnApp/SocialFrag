import type { Caption } from '../types';

const overlaps = (a: Caption, b: Caption) => a.start < (b.end ?? Infinity) && b.start < (a.end ?? Infinity);

/** A re-run for one track: untouched auto-lines of that track go; edited and manual lines stay; new lines that overlap a kept line of the same track are skipped. */
export function mergeRun(existing: Caption[], trackIndex: number, fresh: Caption[]): Caption[] {
  const kept = existing.filter((c) => !(c.source === 'auto' && c.trackIndex === trackIndex && !c.edited));
  const blockers = kept.filter((c) => c.trackIndex === trackIndex);
  const added = fresh.filter((n) => !blockers.some((k) => overlaps(k, n)));
  return [...kept, ...added].sort((a, b) => a.start - b.start);
}
