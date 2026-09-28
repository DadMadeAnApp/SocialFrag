# Whisper Auto-Captions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Offline auto-captions: pick one or more audio tracks, run whisper.cpp (`whisper-cli` sidecar), get timed, per-track-styled captions that are fully editable (text, timing, split, merge, delete, restyle) on a caption lane and a caption list, exported efficiently.

**Architecture:** Rust extracts each clip's trimmed track range to a 16 kHz mono WAV with ffmpeg, runs `whisper-cli` for word-level JSON, and returns words in source seconds. The frontend groups words into lines, merges them into the clip's captions (re-run keeps edited/manual lines), and renders them. Captions gain `end`/`source`/`trackIndex`/`edited`/`color`/`override`. Export stops sending one PNG per caption: each clip sends a contiguous list of "on-screen interval" frames, which Rust feeds to ffmpeg as one ffconcat image-sequence input.

**Tech Stack:** Tauri 2, React 19, TypeScript 6, Vitest 5, Rust (serde, `ureq` 3 + `sha2` new), whisper.cpp v1.9.4 CLI, ffmpeg (bundled).

**Spec:** `docs/superpowers/specs/2026-09-28-whisper-captions-design.md`

## Global Constraints

- whisper.cpp pinned to **v1.9.4**; Windows binaries from release tag **`b5130`** asset `whisper-bin-x64.zip`; Mac built from tag `v1.9.4`.
- `whisper-cli` args, exactly: `-m <model> -f <wav> -l en -ml 1 -sow -oj -of <out_base> -pp -np` (JSON written to `<out_base>.json`; progress on stderr as `…progress = NN%`).
- Models (English only), URL `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/<file>`:
  - `base.en` → `ggml-base.en.bin`, 147964211 bytes, sha256 `a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002` (default)
  - `small.en` → `ggml-small.en.bin`, 487614201 bytes, sha256 `c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d`
  - `medium.en` → `ggml-medium.en.bin`, 1533774781 bytes, sha256 `cc37e93478338ec7700281a7ac30a10128929eb8f427dda2e865faa8f6da4356`
- Models stored in `app_data_dir()/whisper-models/` (never the cache dir; Clear cache must not touch them). Download to `<file>.part`, verify size + sha256, rename.
- WAV extraction: `ffmpeg -hide_banner -nostdin -y -ss <inS> -t <len> -i <src> -map 0:a:<N> -ac 1 -ar 16000 -c:a pcm_s16le <wav>`. Freeze clips are skipped.
- Line grouping: max 5 words, max 2.5 s, new line after a gap > 0.7 s.
- Default voice track: `Mic` unless silent (max envelope level < −60 dB) or missing; else the loudest (mean dB) track whose label is not `Desktop Audio`.
- Per-track default styles, in the order tracks are captioned: style `tiktok`, colours `#FFFFFF`, `#FFE14D`, `#4DD8FF`, `#7CFF6B`; `x: 0.5`, `y: 0.82`, `fontSize: 80/1920`.
- Re-run: remove the run's tracks' auto-lines that are not `edited`; add new lines, skipping any overlapping a kept caption of the same track.
- A run is ONE undo step: `edit(fn)` with no coalescing key.
- Caption visibility: `start − 1e-3 ≤ t` and (`end` absent or `t < end`), times in source seconds.
- Copy, verbatim: button "Auto-caption"; scopes "Whole timeline" / "This clip"; models "base.en", "small.en", "medium.en"; "Downloaded"; "Captioning failed."; "No speech found on <label>"; "Merge with next"; "Delete"; "Track styles"; fake backend error "Auto-captioning needs the desktop app."
- Commit directly on `main`; never create branches; never push; no attribution lines in commits.
- Tests: `npm test` (repo root), `cd src-tauri && cargo test`. `.ts` tests needing a DOM go in `DOM_TS_TESTS` (`vite.config.ts`).

## Review Focus

1. A 30-minute clip captioned on two tracks (≈600 lines) must export in one ffmpeg run without hundreds of inputs — Task 4 golden test with 300 captions asserts one concat input and one caption overlay per clip.
2. Pressing `S` or `Delete` while a caption is selected must act on the caption, never split or delete the clip — Task 9 App test.
3. Re-running after editing some lines must keep every edited line exactly — Task 2 `mergeRun` test and Task 9 App test (edit, re-run, assert).
4. Cancel mid-run leaves captions exactly as before and removes temp files — Task 6 cancel test (temp dir empty) and Task 9 dialog test (no edit applied).
5. A split of a clip through the middle of a caption line must leave one line on each side, not duplicates of every caption — Task 3 split test.

---

### Task 1: Timed, coloured, sourced captions

**Files:**
- Modify: `src/types.ts` (Caption, TrackCaptionStyle)
- Modify: `src/timeline/model.ts` (TimelineClip.captionStyles), `src/timeline/ops.ts:14-18` (`newClip` gets `captionStyles: {}`)
- Modify: `src/state/captions.ts` (newCaption `source: 'manual'`; new `editCaption`)
- Modify: `src/render/captions.ts` (`isCaptionVisible` honours `end`; `drawCaption` uses `c.color`)
- Test: `src/state/captions.test.ts`, `src/render/captions.test.ts`

**Interfaces:**
- Produces: `Caption` fields `end?`, `source`, `trackIndex?`, `edited?`, `color?`, `override?`; `interface TrackCaptionStyle { style: CaptionStyle; color: string; y: number }`; `TimelineClip.captionStyles: Record<number, TrackCaptionStyle>`; `editCaption(prev: Caption, next: Caption): Caption`.

- [ ] **Step 1: Failing tests.** `src/state/captions.test.ts` add:

```ts
test('newCaption is manual and untimed', () => {
  const c = newCaption('a', 0, 'whole');
  expect(c.source).toBe('manual');
  expect(c.end).toBeUndefined();
});

test('editCaption marks a changed auto-line edited, and a style/position change as an override', () => {
  const auto = { ...newCaption('a', 0, 'whole'), source: 'auto' as const, trackIndex: 3, start: 1, end: 2 };
  expect(editCaption(auto, { ...auto, text: 'fixed' })).toMatchObject({ edited: true, override: undefined });
  expect(editCaption(auto, { ...auto, y: 0.5 })).toMatchObject({ edited: true, override: true });
  expect(editCaption(auto, { ...auto, color: '#FF0000' })).toMatchObject({ edited: true, override: true });
  expect(editCaption(auto, { ...auto })).toEqual(auto);
  const manual = newCaption('m', 0, 'whole');
  expect(editCaption(manual, { ...manual, text: 'x' }).edited).toBeUndefined();
});
```

`src/render/captions.test.ts` add:

```ts
test('isCaptionVisible honours end', () => {
  const c = { ...cap(), start: 1, end: 2 };
  expect(isCaptionVisible(c, 0.5)).toBe(false);
  expect(isCaptionVisible(c, 1)).toBe(true);
  expect(isCaptionVisible(c, 1.999)).toBe(true);
  expect(isCaptionVisible(c, 2)).toBe(false);
  expect(isCaptionVisible({ ...c, end: undefined }, 99)).toBe(true);
});

test('drawCaption fills with the caption colour when set', () => {
  const { ctx, named } = recordingCtx();
  drawCaption(ctx, { ...cap(), style: 'tiktok', color: '#FFE14D' });
  expect(named('set:fillStyle')).toContainEqual(['#FFE14D']);
});
```

(The `cap()` factory in that file must add `source: 'manual'`.)

- [ ] **Step 2: Run** `npx vitest run src/state/captions.test.ts src/render/captions.test.ts` → FAIL.
- [ ] **Step 3: Implement.** `src/types.ts`:

```ts
/** x/y = caption centre as fractions of canvas width/height; fontSize = fraction of canvas height.
 * start/end = source seconds; no end = shown to the clip's end. */
export interface Caption {
  id: string; text: string; style: CaptionStyle; x: number; y: number; fontSize: number; start: number;
  end?: number;
  source: 'manual' | 'auto';
  /** Audio track (ffmpeg 0:a:N) an auto-line came from. */
  trackIndex?: number;
  /** An auto-line the user changed; re-runs keep it. */
  edited?: boolean;
  /** Fill colour; absent = the style's own. */
  color?: string;
  /** Style/position set on this line, so track-style changes skip it. */
  override?: boolean;
}
export interface TrackCaptionStyle { style: CaptionStyle; color: string; y: number }
```

`model.ts` `TimelineClip` gains `/** Auto-caption style per audio track index. */ captionStyles: Record<number, TrackCaptionStyle>;`. Every place that builds a `TimelineClip` literal (`newClip`, test helpers) adds `captionStyles: {}` — run `npx tsc -b` to find them.

`state/captions.ts`: `newCaption` adds `source: 'manual'`, and:

```ts
const LOOK: (keyof Caption)[] = ['style', 'x', 'y', 'fontSize', 'color'];
const CONTENT: (keyof Caption)[] = ['text', 'start', 'end', ...LOOK];

/** An auto-line the user changes becomes `edited` (re-runs keep it); a look change also makes it an override. */
export function editCaption(prev: Caption, next: Caption): Caption {
  if (prev.source !== 'auto' || !CONTENT.some((k) => prev[k] !== next[k])) return next;
  return { ...next, edited: true, ...(LOOK.some((k) => prev[k] !== next[k]) ? { override: true } : {}) };
}
```

`render/captions.ts`: `export const isCaptionVisible = (c: Caption, t: number): boolean => t >= c.start - 1e-3 && (c.end === undefined || t < c.end);` and in `drawCaption` use `ctx.fillStyle = c.color ?? st.fill;`.

- [ ] **Step 4: Run** focused tests → PASS; `npx tsc -b` clean; `npm test` green.
- [ ] **Step 5: Commit** `git commit -m "feat(captions): timed, coloured, sourced captions"`

---

### Task 2: Caption logic — grouping, re-run merge, default track, stacking

**Files:**
- Create: `src/captions/group.ts`, `src/captions/merge.ts`, `src/captions/defaults.ts`, `src/captions/stack.ts`
- Test: `src/captions/group.test.ts`, `merge.test.ts`, `defaults.test.ts`, `stack.test.ts` (node project)

**Interfaces:**
- Consumes: `Caption`, `TrackCaptionStyle` (Task 1); `captionLayout`, `CaptionPx` (`src/render/captions.ts`).
- Produces:
  - `interface Word { text: string; startS: number; endS: number }`, `interface Line { text: string; start: number; end: number }`, `groupWords(words: Word[], o?: { maxWords?: number; maxS?: number; gapS?: number }): Line[]`
  - `mergeRun(existing: Caption[], trackIndex: number, fresh: Caption[]): Caption[]`
  - `TRACK_COLORS`, `trackStyle(order: number): TrackCaptionStyle`, `levelDb(env: Float32Array): { maxDb: number; meanDb: number }`, `defaultVoiceTracks(tracks: { label: string; env?: Float32Array }[]): string[]` (returns labels)
  - `stackCaptions(ctx: Ctx2D, lines: CaptionPx[]): CaptionPx[]`

- [ ] **Step 1: Failing tests.**

`group.test.ts`:

```ts
import { expect, test } from 'vitest';
import { groupWords } from './group';

const w = (text: string, startS: number, endS: number) => ({ text, startS, endS });

test('caps lines at 5 words', () => {
  const words = ['a', 'b', 'c', 'd', 'e', 'f'].map((t, i) => w(t, i * 0.2, i * 0.2 + 0.15));
  expect(groupWords(words)).toEqual([
    { text: 'a b c d e', start: 0, end: 0.95 },
    { text: 'f', start: 1, end: 1.15 },
  ]);
});

test('caps lines at 2.5 s and splits on a gap over 0.7 s', () => {
  expect(groupWords([w('one', 0, 1), w('two', 1, 2), w('three', 2, 2.6)])).toEqual([
    { text: 'one two', start: 0, end: 2 },
    { text: 'three', start: 2, end: 2.6 },
  ]);
  expect(groupWords([w('hi', 0, 0.3), w('there', 1.1, 1.4)])).toEqual([
    { text: 'hi', start: 0, end: 0.3 },
    { text: 'there', start: 1.1, end: 1.4 },
  ]);
});

test('keeps punctuation, trims whitespace, drops empty words', () => {
  expect(groupWords([w(' Nice,', 0, 0.3), w('  ', 0.3, 0.4), w(' shot!', 0.4, 0.8)])).toEqual([{ text: 'Nice, shot!', start: 0, end: 0.8 }]);
});
```

`merge.test.ts`:

```ts
import { expect, test } from 'vitest';
import type { Caption } from '../types';
import { mergeRun } from './merge';

const c = (id: string, start: number, end: number, over: Partial<Caption> = {}): Caption => ({
  id, text: id, style: 'tiktok', x: 0.5, y: 0.82, fontSize: 80 / 1920, start, end, source: 'auto', trackIndex: 3, ...over,
});

test('replaces untouched auto-lines of the track, keeps edited, manual and other tracks, skips overlaps', () => {
  const existing = [
    c('old', 0, 1),
    c('edited', 2, 3, { edited: true }),
    c('manual', 4, 5, { source: 'manual', trackIndex: undefined }),
    c('other', 0, 1, { trackIndex: 2 }),
  ];
  const fresh = [c('n1', 0, 1), c('n2', 2.5, 3.5), c('n3', 6, 7)];
  expect(mergeRun(existing, 3, fresh).map((x) => x.id).sort()).toEqual(['edited', 'manual', 'n1', 'n3', 'other']);
});

test('result is sorted by start', () => {
  expect(mergeRun([c('b', 5, 6, { edited: true })], 3, [c('a', 1, 2)]).map((x) => x.id)).toEqual(['a', 'b']);
});
```

(A manual caption with no `end` counts as covering `[start, ∞)` for the overlap check only against same-track lines; manual lines have no track, so they never block auto-lines. The test above encodes that `n3` at 6–7 is kept despite `manual` having `end: 5`.)

`defaults.test.ts`:

```ts
import { expect, test } from 'vitest';
import { defaultVoiceTracks, levelDb, trackStyle } from './defaults';

const env = (v: number, n = 400) => new Float32Array(n).fill(v);

test('levelDb converts RMS amplitude to dB', () => {
  expect(levelDb(env(1)).maxDb).toBeCloseTo(0, 5);
  expect(levelDb(env(0.001)).maxDb).toBeCloseTo(-60, 5);
  expect(levelDb(env(0)).maxDb).toBe(-Infinity);
});

test('Mic when it has signal; else the loudest non-desktop track; else the first non-desktop track', () => {
  const tracks = (mic: number) => [
    { label: 'Desktop Audio', env: env(0.5) }, { label: 'Game', env: env(0.05) }, { label: 'Discord', env: env(0.2) }, { label: 'Mic', env: env(mic) },
  ];
  expect(defaultVoiceTracks(tracks(0.1))).toEqual(['Mic']);
  expect(defaultVoiceTracks(tracks(0.0001))).toEqual(['Discord']);
  expect(defaultVoiceTracks([{ label: 'Desktop Audio' }, { label: 'Game' }, { label: 'Discord' }])).toEqual(['Game']);
  expect(defaultVoiceTracks([{ label: 'Desktop Audio' }])).toEqual([]);
});

test('track styles cycle white, yellow, cyan, green near the bottom', () => {
  expect([0, 1, 2, 3, 4].map((i) => trackStyle(i).color)).toEqual(['#FFFFFF', '#FFE14D', '#4DD8FF', '#7CFF6B', '#FFFFFF']);
  expect(trackStyle(0)).toMatchObject({ style: 'tiktok', y: 0.82 });
});
```

`stack.test.ts`:

```ts
import { expect, test } from 'vitest';
import { recordingCtx } from '../test/recordingCtx';
import { stackCaptions } from './stack';

const px = (id: string, trackIndex: number | undefined, y = 1600) => ({
  id, text: 'hi', style: 'plain' as const, x: 540, y, fontSize: 80, start: 0, source: 'auto' as const, trackIndex, maxW: 960,
});

test('overlapping lines stack upward in track order; separate lines stay put', () => {
  const { ctx } = recordingCtx();
  const [a, b] = stackCaptions(ctx, [px('b', 3), px('a', 2)]);
  expect(a.id).toBe('a');
  expect(a.y).toBe(1600);
  expect(b.y).toBeLessThan(1600 - 80); // moved above a's box
  const [c, d] = stackCaptions(ctx, [px('c', 2, 400), px('d', 3, 1600)]);
  expect([c.y, d.y]).toEqual([400, 1600]);
});
```

- [ ] **Step 2: Run** `npx vitest run src/captions` → FAIL.
- [ ] **Step 3: Implement.**

`group.ts`:

```ts
export interface Word { text: string; startS: number; endS: number }
export interface Line { text: string; start: number; end: number }

/** Whisper words → caption lines: at most maxWords words and maxS seconds, broken at silences over gapS. */
export function groupWords(words: Word[], o: { maxWords?: number; maxS?: number; gapS?: number } = {}): Line[] {
  const { maxWords = 5, maxS = 2.5, gapS = 0.7 } = o;
  const out: Line[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (cur.length) out.push({ text: cur.map((x) => x.text).join(' '), start: cur[0].startS, end: cur[cur.length - 1].endS });
    cur = [];
  };
  for (const raw of words) {
    const text = raw.text.trim();
    if (!text) continue;
    const word = { ...raw, text };
    const last = cur[cur.length - 1];
    if (last && (cur.length >= maxWords || word.endS - cur[0].startS > maxS || word.startS - last.endS > gapS)) flush();
    cur.push(word);
  }
  flush();
  return out;
}
```

`merge.ts`:

```ts
import type { Caption } from '../types';

const overlaps = (a: Caption, b: Caption) => a.start < (b.end ?? Infinity) && b.start < (a.end ?? Infinity);

/** A re-run for one track: untouched auto-lines of that track go; edited and manual lines stay; new lines that overlap a kept line of the same track are skipped. */
export function mergeRun(existing: Caption[], trackIndex: number, fresh: Caption[]): Caption[] {
  const kept = existing.filter((c) => !(c.source === 'auto' && c.trackIndex === trackIndex && !c.edited));
  const blockers = kept.filter((c) => c.trackIndex === trackIndex);
  const added = fresh.filter((n) => !blockers.some((k) => overlaps(k, n)));
  return [...kept, ...added].sort((a, b) => a.start - b.start);
}
```

`defaults.ts`:

```ts
import type { TrackCaptionStyle } from '../types';

export const TRACK_COLORS = ['#FFFFFF', '#FFE14D', '#4DD8FF', '#7CFF6B'];
const SILENT_DB = -60;

export const trackStyle = (order: number): TrackCaptionStyle => ({ style: 'tiktok', color: TRACK_COLORS[order % TRACK_COLORS.length], y: 0.82 });

const db = (v: number) => 20 * Math.log10(v);

/** env = RMS amplitude envelope (0..1, 200 per second, from prepareAudio). */
export function levelDb(env: Float32Array): { maxDb: number; meanDb: number } {
  let max = 0;
  let sum = 0;
  for (const v of env) {
    if (v > max) max = v;
    sum += v;
  }
  return { maxDb: db(max), meanDb: db(env.length ? sum / env.length : 0) };
}

/** Mic if it has any signal; else the loudest track that isn't Desktop Audio (the full mix); without envelopes, the first such track. */
export function defaultVoiceTracks(tracks: { label: string; env?: Float32Array }[]): string[] {
  const mic = tracks.find((t) => t.label === 'Mic');
  if (mic && (!mic.env || levelDb(mic.env).maxDb >= SILENT_DB)) return ['Mic'];
  const voices = tracks.filter((t) => t.label !== 'Desktop Audio' && t !== mic);
  if (!voices.length) return [];
  if (voices.every((t) => t.env)) {
    const loudest = voices.reduce((a, b) => (levelDb(b.env!).meanDb > levelDb(a.env!).meanDb ? b : a));
    return [loudest.label];
  }
  return [voices[0].label];
}
```

`stack.ts`:

```ts
import { captionLayout, type CaptionPx } from '../render/captions';
import type { Ctx2D } from '../render/ctx';

const GAP = 0.2; // × font size between stacked lines

/** Lines on screen together: placed in track order (manual first); a line whose box overlaps one already placed moves up above it. */
export function stackCaptions(ctx: Ctx2D, lines: CaptionPx[]): CaptionPx[] {
  const order = [...lines].sort((a, b) => (a.trackIndex ?? -1) - (b.trackIndex ?? -1));
  const placed: { c: CaptionPx; top: number; bottom: number; left: number; right: number }[] = [];
  for (const line of order) {
    let c = line;
    for (;;) {
      const { box } = captionLayout(ctx, c);
      const hit = placed.find((p) => box.x < p.right && p.left < box.x + box.w && box.y < p.bottom && p.top < box.y + box.h);
      if (!hit) {
        placed.push({ c, top: box.y, bottom: box.y + box.h, left: box.x, right: box.x + box.w });
        break;
      }
      c = { ...c, y: hit.top - GAP * c.fontSize - box.h / 2 };
    }
  }
  return placed.map((p) => p.c);
}
```

- [ ] **Step 4: Run** `npx vitest run src/captions` → PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(captions): grouping, re-run merge, default track, stacking"`

---

### Task 3: Timeline ops for timed captions

**Files:**
- Modify: `src/timeline/ops.ts` (`splitAt`, `insertFreeze`, `trimClip`; new `applyTranscription`, `splitCaption`, `mergeCaptionWithNext`, `setTrackStyle`)
- Test: `src/timeline/ops.test.ts`

**Interfaces:**
- Consumes: `Caption`, `TrackCaptionStyle` (Task 1); `Line`, `mergeRun`, `trackStyle` (Task 2).
- Produces:
  - `interface TrackLines { clipId: string; trackIndex: number; lines: Line[] }`
  - `applyTranscription(p: Project, runs: TrackLines[], newId: () => string): Project`
  - `splitCaption(p: Project, clipId: string, captionId: string, atSrc: number, newId: string): Project`
  - `mergeCaptionWithNext(p: Project, clipId: string, captionId: string): Project`
  - `setTrackStyle(p: Project, clipId: string, trackIndex: number, s: TrackCaptionStyle): Project`
  - internal `captionsIn(captions: Caption[], inS: number, outS: number): Caption[]` (drop outside, clamp crossing)

- [ ] **Step 1: Failing tests** (use the file's existing `project()` / `track()` helpers; add `captionStyles: {}` where they build clips):

```ts
const timed = (id: string, start: number, end: number, over: Partial<Caption> = {}): Caption => ({
  id, text: `${id} one two`, style: 'tiktok', x: 0.5, y: 0.82, fontSize: 80 / 1920, start, end, source: 'auto', trackIndex: 1, ...over,
});

test('split: lines go to their side; a line across the cut is cut in two', () => {
  const p = project({ inS: 0, outS: 10, captions: [timed('l', 1, 2), timed('x', 4, 6), timed('r', 8, 9)] });
  const s = splitAt(p, 5, 'right');
  expect(s.main[0].captions.map((c) => [c.id, c.start, c.end])).toEqual([['l', 1, 2], ['x', 4, 5]]);
  expect(s.main[1].captions.map((c) => [c.start, c.end])).toEqual([[5, 6], [8, 9]]);
  expect(s.main[1].captions.every((c) => c.id.endsWith('~right'))).toBe(true);
});

test('trim drops captions outside the range and clamps the ones crossing it', () => {
  const p = project({ inS: 0, outS: 10, captions: [timed('a', 1, 3), timed('b', 5, 6), { ...timed('m', 0, 0), end: undefined, source: 'manual', trackIndex: undefined }] });
  const t = trimClip(p, p.main[0].id, 'in', 2, 10);
  expect(t.main[0].captions.map((c) => [c.id, c.start, c.end])).toEqual([['a', 2, 3], ['b', 5, 6], ['m', 2, undefined]]);
});

test('applyTranscription adds styled auto-lines per track, keeps edits, and sets default track styles', () => {
  const p = project({ inS: 0, outS: 10, captions: [timed('keep', 1, 2, { edited: true })] });
  let n = 0;
  const out = applyTranscription(p, [
    { clipId: p.main[0].id, trackIndex: 1, lines: [{ text: 'hello', start: 1.5, end: 2.5 }, { text: 'world', start: 3, end: 4 }] },
    { clipId: p.main[0].id, trackIndex: 2, lines: [{ text: 'gg', start: 3, end: 3.5 }] },
  ], () => `id${n++}`);
  const caps = out.main[0].captions;
  expect(caps.map((c) => c.text)).toEqual(['keep one two', 'world', 'gg']);
  expect(caps.find((c) => c.text === 'gg')).toMatchObject({ source: 'auto', trackIndex: 2, color: '#FFE14D', y: 0.82 });
  expect(out.main[0].captionStyles).toEqual({ 1: { style: 'tiktok', color: '#FFFFFF', y: 0.82 }, 2: { style: 'tiktok', color: '#FFE14D', y: 0.82 } });
});

test('splitCaption splits text at the word nearest the time fraction; mergeCaptionWithNext joins with the next line', () => {
  const p = project({ inS: 0, outS: 10, captions: [timed('a', 0, 4, { text: 'one two three four' }), timed('b', 5, 6, { text: 'five' })] });
  const id = p.main[0].id;
  const s = splitCaption(p, id, 'a', 2, 'a2');
  expect(s.main[0].captions.map((c) => [c.text, c.start, c.end, c.edited])).toEqual([['one two', 0, 2, true], ['three four', 2, 4, true], ['five', 5, 6, undefined]]);
  const m = mergeCaptionWithNext(s, id, 'a2');
  expect(m.main[0].captions.map((c) => [c.text, c.start, c.end])).toEqual([['one two', 0, 2], ['three four five', 2, 6]]);
});

test('setTrackStyle restyles that track except overrides', () => {
  const p = project({ inS: 0, outS: 10, captions: [timed('a', 0, 1), timed('b', 1, 2, { override: true, color: '#000000' }), timed('c', 2, 3, { trackIndex: 2 })] });
  const out = setTrackStyle(p, p.main[0].id, 1, { style: 'boxed', color: '#FF0000', y: 0.5 });
  expect(out.main[0].captions.map((c) => [c.id, c.style, c.color, c.y])).toEqual([['a', 'boxed', '#FF0000', 0.5], ['b', 'tiktok', '#000000', 0.82], ['c', 'tiktok', undefined, 0.82]]);
  expect(out.main[0].captionStyles[1]).toEqual({ style: 'boxed', color: '#FF0000', y: 0.5 });
});
```

- [ ] **Step 2: Run** `npx vitest run src/timeline/ops.test.ts` → FAIL.
- [ ] **Step 3: Implement** in `ops.ts`:

```ts
/** Captions kept for a source window [inS, outS): outside ones dropped, crossing ones clamped. Untimed ones clamp their start. */
function captionsIn(captions: Caption[], inS: number, outS: number): Caption[] {
  const out: Caption[] = [];
  for (const c of captions) {
    const end = c.end ?? Infinity;
    if (end <= inS + 1e-6 || c.start >= outS - 1e-6) continue;
    out.push({ ...c, start: Math.max(c.start, inS), ...(c.end !== undefined ? { end: Math.min(c.end, outS) } : {}) });
  }
  return out;
}
```

`splitAt`: `left.captions = captionsIn(e.clip.captions, e.clip.inS, cut)`, `right.captions = captionsIn(e.clip.captions, cut, e.clip.outS).map((c) => ({ ...c, id: `${c.id}~${newId}` }))`. `insertFreeze`: the freeze clip keeps only captions visible at its frame (`c.start <= frame + 1e-3 && (c.end ?? Infinity) > frame`), ids suffixed as today. `trimClip`: after computing the new in/out, `captions: captionsIn(c.captions, newIn, newOut)`.

```ts
export interface TrackLines { clipId: string; trackIndex: number; lines: Line[] }

/** One whisper run → captions, merged per clip and track (see mergeRun). Tracks get a default style the first time. */
export function applyTranscription(p: Project, runs: TrackLines[], newId: () => string): Project {
  const order = [...new Set(runs.map((r) => r.trackIndex))];
  return {
    ...p,
    main: p.main.map((clip) => {
      const mine = runs.filter((r) => r.clipId === clip.id);
      if (!mine.length) return clip;
      const styles = { ...clip.captionStyles };
      let captions = clip.captions;
      for (const r of mine) {
        const s = (styles[r.trackIndex] ??= trackStyle(order.indexOf(r.trackIndex)));
        const fresh: Caption[] = r.lines.map((l) => ({
          id: newId(), text: l.text, style: s.style, color: s.color, x: 0.5, y: s.y, fontSize: 80 / 1920,
          start: l.start, end: l.end, source: 'auto', trackIndex: r.trackIndex,
        }));
        captions = mergeRun(captions, r.trackIndex, captionsIn(fresh, clip.inS, clip.outS));
      }
      return { ...clip, captions, captionStyles: styles };
    }),
  };
}

const onClip = (p: Project, clipId: string, f: (c: TimelineClip) => Partial<TimelineClip>): Project =>
  ({ ...p, main: p.main.map((c) => (c.id === clipId ? { ...c, ...f(c) } : c)) });

const touched = (c: Caption): Caption => (c.source === 'auto' ? { ...c, edited: true } : c);

export function splitCaption(p: Project, clipId: string, captionId: string, atSrc: number, newId: string): Project {
  return onClip(p, clipId, (clip) => {
    const i = clip.captions.findIndex((c) => c.id === captionId);
    const c = clip.captions[i];
    if (!c || c.end === undefined || atSrc <= c.start + 1e-3 || atSrc >= c.end - 1e-3) return {};
    const words = c.text.split(/\s+/).filter(Boolean);
    const k = Math.min(words.length - 1, Math.max(1, Math.round(((atSrc - c.start) / (c.end - c.start)) * words.length)));
    const a = touched({ ...c, text: words.slice(0, k).join(' '), end: atSrc });
    const b = touched({ ...c, id: newId, text: words.slice(k).join(' '), start: atSrc });
    return { captions: [...clip.captions.slice(0, i), a, b, ...clip.captions.slice(i + 1)] };
  });
}

export function mergeCaptionWithNext(p: Project, clipId: string, captionId: string): Project {
  return onClip(p, clipId, (clip) => {
    const sorted = [...clip.captions].sort((x, y) => x.start - y.start);
    const i = sorted.findIndex((c) => c.id === captionId);
    if (i < 0 || i === sorted.length - 1) return {};
    const [a, b] = [sorted[i], sorted[i + 1]];
    const merged = touched({ ...a, text: `${a.text} ${b.text}`.trim(), end: b.end });
    return { captions: [...sorted.slice(0, i), merged, ...sorted.slice(i + 2)] };
  });
}

export function setTrackStyle(p: Project, clipId: string, trackIndex: number, s: TrackCaptionStyle): Project {
  return onClip(p, clipId, (clip) => ({
    captionStyles: { ...clip.captionStyles, [trackIndex]: s },
    captions: clip.captions.map((c) => (c.trackIndex === trackIndex && !c.override ? { ...c, style: s.style, color: s.color, y: s.y } : c)),
  }));
}
```

(`splitCaption` with a 1-word line: `k` clamps so both halves are non-empty only when there are ≥ 2 words; if `words.length < 2` return `{}`.)

- [ ] **Step 4: Run** `npx vitest run src/timeline` → PASS; `npm test` green.
- [ ] **Step 5: Commit** `git commit -m "feat(captions): timeline ops for timed captions and whisper runs"`

---

### Task 4: Captions exported as one image sequence per clip

**Files:**
- Modify: `src/types.ts` (`CaptionFrame`, `ClipExport.captionFrames`), `src/render/exportAssets.ts`, `src/timeline/exportJob.ts`, `src/render/compose.ts` (preview stacks via `stackCaptions`)
- Modify: `src-tauri/src/job.rs` (`CaptionFrame`, `ClipJob.caption_frames`), `src-tauri/src/export.rs` (`write_assets` writes frames + `c{n}-captions.ffconcat`), `src-tauri/src/filtergraph.rs` (one concat input + one overlay)
- Test: `src/render/exportAssets.test.ts`, `src/timeline/exportJob.test.ts`, `src/render/compose.test.ts`, `src-tauri/src/filtergraph.rs`, `src-tauri/src/export.rs`

**Interfaces:**
- Consumes: `isCaptionVisible` with `end` (Task 1), `stackCaptions` (Task 2).
- Produces: TS `interface CaptionFrame { pngBase64: string; start: number; end: number }` (clip-output seconds, contiguous from 0 to the clip duration, first frame may be blank); `ClipExport.captionFrames: CaptionFrame[]` (empty when the clip has no captions); `buildExportAssets` stops putting captions in `overlays` and returns `captionFrames`; `localCaptionWindow(c: Caption, clip: TimelineClip): [number, number] | null`. Rust `pub struct CaptionFrame { pub png_base64: String, pub start: f64, pub end: f64 }`, `ClipJob.caption_frames: Vec<CaptionFrame>` (`#[serde(default)]`), `ClipAssets.captions: Option<PathBuf>` (the ffconcat file).

- [ ] **Step 1: Failing tests.**

`exportJob.test.ts`:

```ts
test('captions become contiguous on-screen intervals in clip-output time', async () => {
  const p = projectWithOneClip(); // existing helper; clip inS 0, speed 1
  const clip = p.main[0];
  clip.captions = [
    { id: 'a', text: 'A', style: 'plain', x: 0.5, y: 0.8, fontSize: 0.04, start: 1, end: 3, source: 'auto', trackIndex: 1 },
    { id: 'b', text: 'B', style: 'plain', x: 0.5, y: 0.8, fontSize: 0.04, start: 2, end: 4, source: 'auto', trackIndex: 2 },
  ];
  const j = await buildExportJob({ project: p, presetById, curves: () => new Map(), quality: 'high', resolution: '1080p', outputPath: '/o.mp4', make });
  expect(j.clips[0].captionFrames.map((f) => [f.start, f.end])).toEqual([[0, 1], [1, 2], [2, 3], [3, 4], [4, clipDuration(clip)]]);
  expect(j.clips[0].overlays.length).toBe(0); // WARDOGS-free fixture preset has no borders
});
```

(Adjust the last expectation to the fixture's border overlay count if its preset has borders; the point is captions are no longer in `overlays`.)

`filtergraph.rs` tests:

```rust
    #[test]
    fn captions_are_one_concat_input_and_one_overlay_even_with_300_lines() {
        let c = clip();
        let a = ClipAssets { captions: Some(PathBuf::from("/w/c0-captions.ffconcat")), ..Default::default() };
        let mut j = job();
        j.clips = vec![c];
        let args = build_args(&j, &[a], &crate::encoders::Encoder::Nvenc, "/o.mp4");
        let s = args.join(" ");
        assert_eq!(s.matches("-f concat -safe 0 -i /w/c0-captions.ffconcat").count(), 1, "{s}");
        let f = filter_of(&args);
        assert_eq!(f.matches("overlay=x=0:y=0:eof_action=pass").count(), 1, "{f}");
    }
```

(Use the module's real builder function name — `build_args` stands for whatever `wardogs_args()` calls; the frame count lives only in the ffconcat file, so 300 lines = still one input.)

`export.rs` tests:

```rust
    #[test]
    fn caption_frames_become_an_ffconcat_list_with_the_last_file_repeated() {
        let dir = tempfile::tempdir().unwrap();
        let mut j = job();
        let png = base64::engine::general_purpose::STANDARD.encode(b"png");
        j.clips[0].caption_frames = (0..300).map(|i| CaptionFrame { png_base64: png.clone(), start: i as f64 * 0.1, end: (i + 1) as f64 * 0.1 }).collect();
        let a = write_assets(&j, dir.path()).unwrap();
        let list = std::fs::read_to_string(a[0].captions.as_ref().unwrap()).unwrap();
        assert!(list.starts_with("ffconcat version 1.0\n"));
        assert_eq!(list.matches("duration 0.100").count(), 300);
        assert_eq!(list.matches("file 'c0-cap-").count(), 301, "last file repeated so its duration applies");
    }
```

- [ ] **Step 2: Run** `npx vitest run src/timeline src/render` and `cd src-tauri && cargo test` → FAIL.

- [ ] **Step 3: Implement.**

TS `exportJob.ts`:

```ts
/** A caption's on-screen window in the clip's output seconds, or null if it never shows. */
export function localCaptionWindow(c: Caption, clip: TimelineClip): [number, number] | null {
  const dur = clipDuration(clip);
  if (clip.kind === 'freeze') return c.start <= clip.inS + 1e-3 && (c.end ?? Infinity) > clip.inS ? [0, dur] : null;
  const s = Math.max(0, (c.start - clip.inS) / clip.speed);
  const e = Math.min(dur, ((c.end ?? Infinity) - clip.inS) / clip.speed);
  return e - s > 1e-3 ? [s, e] : null;
}
```

`buildExportAssets(preset, clip, captions, canvas, make, windows?)` — rename is not needed; add a separate exported `buildCaptionFrames(captions: Caption[], windows: ([number, number] | null)[], dur: number, canvas: Canvas, make = offscreenFactory): Promise<CaptionFrame[]>` in `exportAssets.ts`:

```ts
/** Contiguous frames over [0, dur): one PNG per stretch where the same set of captions is on screen (blank stretches share one PNG). */
export async function buildCaptionFrames(captions: Caption[], windows: ([number, number] | null)[], dur: number, canvas: Canvas, make: CanvasFactory = offscreenFactory): Promise<CaptionFrame[]> {
  const live = captions.map((c, i) => ({ c, w: windows[i] })).filter((x): x is { c: Caption; w: [number, number] } => !!x.w && !!x.c.text.trim());
  if (!live.length) return [];
  const cuts = [...new Set([0, dur, ...live.flatMap((x) => x.w)])].filter((t) => t >= 0 && t <= dur).sort((a, b) => a - b);
  const frames: CaptionFrame[] = [];
  let blank: string | null = null;
  let prevKey = '';
  for (let i = 0; i + 1 < cuts.length; i++) {
    const [s, e] = [cuts[i], cuts[i + 1]];
    const mid = (s + e) / 2;
    const on = live.filter((x) => x.w[0] <= mid && mid < x.w[1]).map((x) => x.c);
    const key = on.map((c) => c.id).join('|');
    if (key === prevKey && frames.length) {
      frames[frames.length - 1].end = e;
      continue;
    }
    prevKey = key;
    let png: string;
    if (!on.length) png = blank ??= await make(canvas.w, canvas.h).encode();
    else {
      const k = make(canvas.w, canvas.h);
      for (const c of stackCaptions(k.ctx, on.map((c) => toPx(c, canvas)))) drawCaption(k.ctx, c);
      png = await k.encode();
    }
    frames.push({ pngBase64: png, start: s, end: e });
  }
  return frames;
}
```

In `buildExportAssets` delete the caption loop (captions no longer go to `overlays`; drop the `captions` parameter and update callers/tests). `buildExportJob` calls `buildCaptionFrames(c.captions, c.captions.map((x) => localCaptionWindow(x, c)), clipDuration(c), canvas, a.make)` and sets `captionFrames` on each `ClipExport`; `localOverlays` now only handles border overlays (unchanged logic).

`compose.ts` `drawFrame`: replace the per-caption loop with
`for (const c of stackCaptions(ctx, captions.filter((c) => isCaptionVisible(c, t)).map((c) => toPx(c, canvas)))) drawCaption(ctx, c);`

Rust `job.rs`:

```rust
/// A stretch of the clip's output (seconds) showing one caption image. Frames are contiguous from 0.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionFrame {
    pub png_base64: String,
    pub start: f64,
    pub end: f64,
}
```

`ClipJob` gains `#[serde(default)] pub caption_frames: Vec<CaptionFrame>,` (fixture `clip()` gets `caption_frames: vec![]`).

`export.rs` `ClipAssets` gains `pub captions: Option<PathBuf>`. In `write_assets`, per clip with non-empty `caption_frames`: write each frame as `c{n}-cap-{i}.png`, then `c{n}-captions.ffconcat`:

```rust
            if !c.caption_frames.is_empty() {
                let mut list = String::from("ffconcat version 1.0\n");
                for (i, f) in c.caption_frames.iter().enumerate() {
                    let p = write(format!("c{n}-cap-{i}.png"), &f.png_base64)?;
                    list.push_str(&format!("file '{}'\nduration {:.3}\n", p.file_name().unwrap().to_string_lossy(), f.end - f.start));
                }
                // The concat demuxer ignores the last entry's duration unless the file is listed again.
                let last = c.caption_frames.len() - 1;
                list.push_str(&format!("file 'c{n}-cap-{last}.png'\n"));
                let lp = dir.join(format!("c{n}-captions.ffconcat"));
                std::fs::write(&lp, list).map_err(io_err)?;
                a.captions = Some(lp);
            }
```

`filtergraph.rs`: after the overlay inputs, if `a.captions` is `Some(p)`: `args.extend(["-f", "concat", "-safe", "0", "-i", p])` recording its input index; in `build_clip_video` after the border overlays and before the final `trim`, add
`[{last}][{cap}:v]setpts=PTS-STARTPTS,format=rgba[n{n}cap];` then `[{last}][n{n}cap]overlay=x=0:y=0:eof_action=pass[n{n}ov]` (write it as two parts in the `parts` vector exactly like the existing chain; `eof_action=pass` so nothing sticks after the last frame). Pass the caption input index into `build_clip_video` the same way overlay inputs are passed today.

- [ ] **Step 4: Run** focused TS + Rust tests → PASS; full `npm test` and `cargo test` green (update the golden/overlay tests that asserted caption PNG overlays: they now assert border overlays only). Then run the existing ignored real-clip export tests on the Mac to prove the concat input works in real ffmpeg:

```bash
S=/private/tmp/claude-501/sf-ff; mkdir -p $S/out && ln -sf "$PWD/binaries/ffmpeg-aarch64-apple-darwin" $S/ffmpeg && ln -sf "$PWD/binaries/ffprobe-aarch64-apple-darwin" $S/ffprobe
SOCIALFRAG_FFMPEG_DIR=$S SOCIALFRAG_CLIPS_DIR="../example clips" SOCIALFRAG_OUT_DIR=$S/out cargo test real_ -- --ignored --nocapture --test-threads=1
```

and add one ignored test `real_clip_exports_timed_captions` in `export.rs` (first example clip, trim 30–40 s, three caption frames `[0,2) blank, [2,5) png, [5,10) blank` using a 1080×1920 transparent PNG generated by ffmpeg in the test with `-f lavfi -i color=c=black@0.0:s=1080x1920,format=rgba -frames:v 1`) asserting the export succeeds with duration 10 ± 0.2 s.
- [ ] **Step 5: Commit** `git commit -m "feat(export): captions as one image-sequence input per clip"`

---

### Task 5: Rust whisper core — models, download, args, JSON parse

**Files:**
- Create: `src-tauri/src/whisper.rs`; Modify: `src-tauri/src/lib.rs` (`pub mod whisper;`), `src-tauri/Cargo.toml` (`ureq = "3"`, `sha2 = "0.10"`)
- Create: `src-tauri/src/testdata/whisper-sample.json`
- Test: in `whisper.rs`

**Interfaces:**
- Produces:
  - `pub struct ModelSpec { pub id: &'static str, pub file: &'static str, pub bytes: u64, pub sha256: &'static str }`, `pub const MODELS: [ModelSpec; 3]`, `pub fn spec(id: &str) -> Option<&'static ModelSpec>`
  - `pub fn models_dir(data: &Path) -> PathBuf` (= `data.join("whisper-models")`), `pub fn model_path(data: &Path, s: &ModelSpec) -> PathBuf`, `pub fn is_downloaded(data: &Path, s: &ModelSpec) -> bool` (exists and size matches)
  - `pub trait Fetch { fn open(&self, url: &str) -> Result<Box<dyn std::io::Read>, String>; }`, `pub struct HttpFetch;`
  - `pub fn download_model(data: &Path, s: &ModelSpec, fetch: &dyn Fetch, cancelled: &AtomicBool, on_progress: &dyn Fn(f64)) -> Result<PathBuf, String>`
  - `pub fn whisper_args(model: &Path, wav: &Path, out_base: &Path) -> Vec<String>`
  - `#[derive(Serialize)] #[serde(rename_all = "camelCase")] pub struct Word { pub text: String, pub start_s: f64, pub end_s: f64 }`, `pub fn parse_words(json: &str) -> Result<Vec<Word>, String>`
  - `pub fn parse_progress(line: &str) -> Option<f64>` (0..1)

- [ ] **Step 1: Failing tests.** Create `src-tauri/src/testdata/whisper-sample.json` (the v1.9.4 `-oj` shape):

```json
{
  "systeminfo": "AVX = 0",
  "model": { "type": "base" },
  "params": { "model": "ggml-base.en.bin", "language": "en", "translate": false },
  "result": { "language": "en" },
  "transcription": [
    { "timestamps": { "from": "00:00:00,000", "to": "00:00:00,320" }, "offsets": { "from": 0, "to": 320 }, "text": " Nice" },
    { "timestamps": { "from": "00:00:00,320", "to": "00:00:00,610" }, "offsets": { "from": 320, "to": 610 }, "text": " shot!" },
    { "timestamps": { "from": "00:00:01,000", "to": "00:00:02,000" }, "offsets": { "from": 1000, "to": 2000 }, "text": " [BLANK_AUDIO]" },
    { "timestamps": { "from": "00:00:02,000", "to": "00:00:02,000" }, "offsets": { "from": 2000, "to": 2000 }, "text": "" },
    { "timestamps": { "from": "00:00:02,100", "to": "00:00:02,500" }, "offsets": { "from": 2100, "to": 2500 }, "text": " (laughs)" },
    { "timestamps": { "from": "00:00:03,000", "to": "00:00:03,400" }, "offsets": { "from": 3000, "to": 3400 }, "text": " GG" }
  ]
}
```

Tests in `whisper.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn model_table_matches_the_spec() {
        let b = spec("base.en").unwrap();
        assert_eq!((b.file, b.bytes), ("ggml-base.en.bin", 147_964_211));
        assert_eq!(b.sha256, "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002");
        assert_eq!(MODELS.map(|m| m.id), ["base.en", "small.en", "medium.en"]);
        assert!(spec("large").is_none());
    }

    #[test]
    fn args_are_pinned() {
        let a = whisper_args(Path::new("/m/ggml-base.en.bin"), Path::new("/t/a.wav"), Path::new("/t/a"));
        assert_eq!(a, ["-m", "/m/ggml-base.en.bin", "-f", "/t/a.wav", "-l", "en", "-ml", "1", "-sow", "-oj", "-of", "/t/a", "-pp", "-np"]);
    }

    #[test]
    fn parses_words_and_drops_blanks_and_non_speech() {
        let w = parse_words(include_str!("testdata/whisper-sample.json")).unwrap();
        let got: Vec<(&str, f64, f64)> = w.iter().map(|w| (w.text.as_str(), w.start_s, w.end_s)).collect();
        assert_eq!(got, [("Nice", 0.0, 0.32), ("shot!", 0.32, 0.61), ("GG", 3.0, 3.4)]);
    }

    #[test]
    fn parses_progress_lines() {
        assert_eq!(parse_progress("whisper_print_progress_callback: progress =  45%"), Some(0.45));
        assert_eq!(parse_progress("whisper_init_from_file: loading model"), None);
    }

    struct Bytes(Vec<u8>);
    impl Fetch for Bytes {
        fn open(&self, _url: &str) -> Result<Box<dyn std::io::Read>, String> {
            Ok(Box::new(std::io::Cursor::new(self.0.clone())))
        }
    }

    #[test]
    fn download_verifies_size_and_hash_and_leaves_no_part_file() {
        let dir = tempfile::tempdir().unwrap();
        let bad = ModelSpec { id: "t", file: "t.bin", bytes: 3, sha256: "0000000000000000000000000000000000000000000000000000000000000000" };
        let err = download_model(dir.path(), &bad, &Bytes(b"abc".to_vec()), &AtomicBool::new(false), &|_| {}).unwrap_err();
        assert!(err.contains("checksum"), "{err}");
        assert!(!models_dir(dir.path()).join("t.bin.part").exists());
        assert!(!models_dir(dir.path()).join("t.bin").exists());
        // sha256("abc")
        let good = ModelSpec { sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", ..bad };
        let p = download_model(dir.path(), &good, &Bytes(b"abc".to_vec()), &AtomicBool::new(false), &|_| {}).unwrap();
        assert_eq!(std::fs::read(p).unwrap(), b"abc");
        assert!(is_downloaded(dir.path(), &good));
    }

    #[test]
    fn download_stops_when_cancelled() {
        let dir = tempfile::tempdir().unwrap();
        let s = ModelSpec { id: "t", file: "t.bin", bytes: 3, sha256: "x" };
        let err = download_model(dir.path(), &s, &Bytes(b"abc".to_vec()), &AtomicBool::new(true), &|_| {}).unwrap_err();
        assert_eq!(err, "cancelled");
        assert!(!models_dir(dir.path()).join("t.bin.part").exists());
    }
}
```

(`ModelSpec` needs `Clone, Copy` for the struct-update syntax; `id`/`file`/`sha256` are `&'static str`.)

- [ ] **Step 2: Run** `cd src-tauri && cargo test whisper` → FAIL (module missing).
- [ ] **Step 3: Implement** `whisper.rs`:
  - `MODELS` exactly as Global Constraints; `URL_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/"`.
  - `HttpFetch::open`: `ureq::get(url).call().map_err(|e| e.to_string())?.into_body().into_reader()` boxed. **Before coding, confirm the ureq 3 API** with `cargo doc -p ureq --open` or docs.rs for the version Cargo resolves (`Response<Body>`, `Body::into_reader`); adapt the one call if it differs.
  - `download_model`: `create_dir_all(models_dir)`; stream `open()` into `<file>.part` in 1 MiB chunks, updating a `sha2::Sha256` and calling `on_progress(done / bytes)`; check `cancelled` before each chunk (on true: delete `.part`, return `Err("cancelled")`); after EOF, size != bytes or hex digest != sha256 → delete `.part`, `Err(format!("{}: checksum or size mismatch", s.file))`; else rename to the final name and return it.
  - `whisper_args`: the exact vector in the test.
  - `parse_words`: `serde_json::from_str::<serde_json::Value>`; iterate `transcription[]`; `text = entry.text.trim()`; skip empty, and skip text fully wrapped in `[...]` or `(...)`; `start_s = offsets.from / 1000`, `end_s = offsets.to / 1000`. Missing `transcription` → `Err("whisper output has no transcription")`.
  - `parse_progress`: find `"progress ="`, parse the integer before `%`, return `n / 100`.
- [ ] **Step 4: Run** `cargo test whisper` → PASS; full `cargo test` green.
- [ ] **Step 5: Commit** `git commit -m "feat(whisper): model table, download with checksum, args and JSON parsing"`

---

### Task 6: Rust transcription job, state and commands

**Files:**
- Create: `src-tauri/src/transcribe.rs`; Modify: `src-tauri/src/lib.rs` (`pub mod transcribe;` + 4 commands in `generate_handler!`), `src-tauri/src/commands.rs` (`AppState.transcribe`, commands)
- Test: in `transcribe.rs`

**Interfaces:**
- Consumes: `whisper::{spec, model_path, is_downloaded, download_model, HttpFetch, whisper_args, parse_words, parse_progress, Word, MODELS}` (Task 5); `ffmpeg::tool_command`.
- Produces:
  - `#[derive(Deserialize)] #[serde(rename_all = "camelCase")] pub struct TranscribeItem { pub key: String, pub source: String, pub track: u32, pub in_s: f64, pub out_s: f64 }`
  - `#[derive(Deserialize)] pub struct TranscribeJob { pub model: String, pub items: Vec<TranscribeItem> }`
  - `#[derive(Serialize)] pub struct ItemWords { pub key: String, pub words: Vec<Word> }`
  - `#[derive(Default)] pub struct TranscribeState { pub child: Mutex<Option<Child>>, pub cancelled: AtomicBool, pub running: AtomicBool }` with `cancel()` (same shape as `ExportState`)
  - `pub trait Tools { fn run(&self, name: &str, args: &[String], state: &TranscribeState, on_line: &dyn Fn(&str)) -> Result<(), String>; }` + `RealTools` (spawns `tool_command(name)`, stores the child in `state.child`, reads stderr lines into `on_line`, waits; non-zero exit → `Err` with the last 20 stderr lines)
  - `pub fn wav_args(item: &TranscribeItem, wav: &Path) -> Vec<String>`
  - `pub fn run_transcribe(job: &TranscribeJob, model: &Path, work: &Path, tools: &dyn Tools, state: &TranscribeState, on_progress: &dyn Fn(f64)) -> Result<Vec<ItemWords>, String>`
  - Commands: `whisper_models(app) -> Vec<ModelInfo { id, bytes, downloaded }>`, `download_whisper_model(app, state, model: String, on_progress: Channel<f64>) -> Result<(), String>`, `transcribe(app, state, job: TranscribeJob, on_progress: Channel<f64>) -> Result<Vec<ItemWords>, String>`, `cancel_transcribe(state)`

- [ ] **Step 1: Failing tests.**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn item(key: &str) -> TranscribeItem {
        TranscribeItem { key: key.into(), source: "/c/in.mp4".into(), track: 3, in_s: 30.0, out_s: 40.0 }
    }

    #[test]
    fn wav_args_cut_the_track_range_to_16k_mono() {
        let a = wav_args(&item("k"), Path::new("/t/k.wav"));
        assert_eq!(a, ["-hide_banner", "-nostdin", "-y", "-ss", "30.000", "-t", "10.000", "-i", "/c/in.mp4", "-map", "0:a:3", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "/t/k.wav"]);
    }

    /// ffmpeg: touch the wav. whisper-cli: write the sample JSON next to -of, print progress.
    struct Fake { calls: RefCell<Vec<String>>, fail_whisper: bool, cancel_on_first: Option<std::sync::Arc<TranscribeState>> }
    impl Tools for Fake {
        fn run(&self, name: &str, args: &[String], state: &TranscribeState, on_line: &dyn Fn(&str)) -> Result<(), String> {
            self.calls.borrow_mut().push(name.into());
            if name == "ffmpeg" {
                std::fs::write(args.last().unwrap(), b"RIFF").unwrap();
                return Ok(());
            }
            if let Some(s) = &self.cancel_on_first { s.cancel(); let _ = state; return Err("killed".into()); }
            if self.fail_whisper { return Err("exit 1".into()); }
            on_line("whisper_print_progress_callback: progress =  50%");
            let of = &args[args.iter().position(|a| a == "-of").unwrap() + 1];
            std::fs::write(format!("{of}.json"), include_str!("testdata/whisper-sample.json")).unwrap();
            Ok(())
        }
    }

    #[test]
    fn words_come_back_in_source_seconds_per_item_and_temp_files_are_removed() {
        let work = tempfile::tempdir().unwrap();
        let job = TranscribeJob { model: "base.en".into(), items: vec![item("a"), item("b")] };
        let tools = Fake { calls: RefCell::new(vec![]), fail_whisper: false, cancel_on_first: None };
        let last = std::sync::Mutex::new(0.0);
        let out = run_transcribe(&job, Path::new("/m.bin"), work.path(), &tools, &TranscribeState::default(), &|f| *last.lock().unwrap() = f).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].key, "a");
        assert_eq!((out[0].words[0].text.as_str(), out[0].words[0].start_s), ("Nice", 30.0));
        assert_eq!(*tools.calls.borrow(), ["ffmpeg", "whisper-cli", "ffmpeg", "whisper-cli"]);
        assert_eq!(*last.lock().unwrap(), 1.0);
        assert_eq!(std::fs::read_dir(work.path()).unwrap().count(), 0);
    }

    #[test]
    fn cancel_returns_cancelled_and_removes_temp_files() {
        let work = tempfile::tempdir().unwrap();
        let state = std::sync::Arc::new(TranscribeState::default());
        let tools = Fake { calls: RefCell::new(vec![]), fail_whisper: false, cancel_on_first: Some(state.clone()) };
        let job = TranscribeJob { model: "base.en".into(), items: vec![item("a")] };
        let err = run_transcribe(&job, Path::new("/m.bin"), work.path(), &tools, &state, &|_| {}).unwrap_err();
        assert_eq!(err, "cancelled");
        assert_eq!(std::fs::read_dir(work.path()).unwrap().count(), 0);
    }

    #[test]
    fn a_whisper_failure_is_reported_with_details() {
        let work = tempfile::tempdir().unwrap();
        let tools = Fake { calls: RefCell::new(vec![]), fail_whisper: true, cancel_on_first: None };
        let job = TranscribeJob { model: "base.en".into(), items: vec![item("a")] };
        let err = run_transcribe(&job, Path::new("/m.bin"), work.path(), &tools, &TranscribeState::default(), &|_| {}).unwrap_err();
        assert!(err.starts_with("Captioning failed."), "{err}");
        assert!(err.contains("exit 1"));
    }
}
```

- [ ] **Step 2: Run** `cargo test transcribe` → FAIL.
- [ ] **Step 3: Implement.**
  - `wav_args`: exactly the vector above (`format!("{:.3}")` for times, `-t` = `out_s - in_s`, map `0:a:{track}`).
  - `run_transcribe`: `state.cancelled.store(false)`; for item `i` of `n`: paths `work/<i>.wav`, out base `work/<i>`; `tools.run("ffmpeg", wav_args)`, then `tools.run("whisper-cli", whisper_args(model, wav, base), state, &|l| if let Some(f) = parse_progress(l) { on_progress((i as f64 + f) / n as f64) })`; read `base.json`, `parse_words`, add `in_s` to every `start_s`/`end_s`, push `ItemWords`; delete that item's `.wav`/`.json` right away. After any error or at the end, remove every remaining file this run created (`remove_file` ignoring errors) — use a small guard struct whose `Drop` deletes the work files so every exit path cleans up. If `state.cancelled` is set when a tool returns (Ok or Err) → `Err("cancelled")`. Any other tool error → `Err(format!("Captioning failed.\n{e}"))`. `on_progress(1.0)` at the end.
  - `TranscribeState::cancel` mirrors `ExportState::cancel` (set flag, kill child). `RealTools::run` stores the child in `state.child` after spawn and re-checks `cancelled` right after (the late-cancel race handled like `export.rs:115-117`), clears it after wait.
  - `commands.rs`: `AppState` gains `pub transcribe: Arc<TranscribeState>`. Commands (each heavy one in `spawn_blocking`, same as `make_proxy`; one run at a time via `running` like `ExportState`, error `"A captioning run is already in progress."`):
    - `whisper_models`: `app_data_dir`, map `MODELS` to `{ id, bytes, downloaded: is_downloaded(..) }` (`#[serde(rename_all = "camelCase")]`).
    - `download_whisper_model`: unknown id → `Err`; `download_model(&data, spec, &HttpFetch, &state.transcribe.cancelled, &|f| on_progress.send(f))` (reset `cancelled` first).
    - `transcribe`: model must be downloaded (`Err("Model not downloaded.")`); work dir `app_cache_dir()/transcribe` (create; it is not one of the cache's managed subfolders so pruning ignores it); `run_transcribe(.., &RealTools, ..)`.
    - `cancel_transcribe`: `state.transcribe.cancel()`.
  - Register all four in `lib.rs` `generate_handler!`.
- [ ] **Step 4: Run** `cargo test` → PASS (all).
- [ ] **Step 5: Commit** `git commit -m "feat(whisper): transcription job, cancel and commands"`

---

### Task 7: Bundle whisper-cli (Mac build, Windows fetch, notices) and prove it on a real clip

**Files:**
- Create: `scripts/build-whisper-macos.sh`, `scripts/fetch-whisper.ps1`, `src-tauri/licenses/whisper.cpp-MIT.txt`
- Modify: `src-tauri/tauri.conf.json` (`externalBin` + Windows DLL resources), `THIRD_PARTY_NOTICES.md`, `.gitignore` if `src-tauri/binaries/whisper-*` large files are not meant to be committed (follow how ffmpeg binaries are handled: check `git ls-files src-tauri/binaries`)
- Test: ignored real test in `src-tauri/src/transcribe.rs`

- [ ] **Step 1: Mac build script** `scripts/build-whisper-macos.sh` (mirror `scripts/build-ffmpeg-macos.sh` style: `set -euo pipefail`, work dir under `/tmp`, guard checks at the end):

```bash
#!/usr/bin/env bash
# Builds whisper-cli v1.9.4 for Apple Silicon with Metal (shaders embedded), statically linked.
set -euo pipefail
VERSION=v1.9.4
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/src-tauri/binaries/whisper-cli-aarch64-apple-darwin"
WORK="$(mktemp -d /tmp/whisper-build.XXXXXX)"
git clone --depth 1 --branch "$VERSION" https://github.com/ggml-org/whisper.cpp "$WORK/src"
cmake -S "$WORK/src" -B "$WORK/build" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
  -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DGGML_NATIVE=OFF \
  -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_DEPLOYMENT_TARGET=11.0 \
  -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_BUILD_TESTS=OFF
cmake --build "$WORK/build" --config Release -j --target whisper-cli
cp "$WORK/build/bin/whisper-cli" "$OUT"
cp "$WORK/src/LICENSE" "$ROOT/src-tauri/licenses/whisper.cpp-MIT.txt"
# Guards: arm64, no non-system dylibs, runs.
file "$OUT" | grep -q arm64
if otool -L "$OUT" | tail -n +2 | grep -vE '/usr/lib/|/System/Library/'; then echo "unexpected dylib dependency" >&2; exit 1; fi
"$OUT" --help >/dev/null 2>&1 || "$OUT" -h >/dev/null 2>&1 || true
echo "built $OUT ($VERSION)"
```

Run it (needs Xcode CLT + CMake; if `cmake` is missing, `brew install cmake`). Expected: `built …/whisper-cli-aarch64-apple-darwin (v1.9.4)`.

- [ ] **Step 2: Windows fetch script** `scripts/fetch-whisper.ps1` (mirror `scripts/fetch-ffmpeg.ps1`): download `https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-x64.zip`, extract, copy `Release/whisper-cli.exe` → `src-tauri/binaries/whisper-cli-x86_64-pc-windows-msvc.exe`, and copy `whisper.dll`, `ggml.dll`, `ggml-base.dll` and every `ggml-cpu-*.dll` → `src-tauri/binaries/whisper-dlls/`; write `whisper-source.txt` provenance (URL, tag, date). This script is run on the Windows PC by the user later; on the Mac just write it.

- [ ] **Step 3: tauri.conf.json.** `externalBin` → `["binaries/ffmpeg", "binaries/ffprobe", "binaries/whisper-cli"]`. Add resource `"licenses/whisper.cpp-MIT.txt": "licenses/whisper.cpp-MIT.txt"`. The Windows DLLs must sit next to the installed exe: add a Windows-only config `src-tauri/tauri.windows.conf.json` with `{ "bundle": { "resources": { "binaries/whisper-dlls/*": "./" } } }` (Tauri merges platform config files; confirm the merge semantics for `resources` in the Tauri v2 config docs before relying on it — if a platform file replaces the whole `resources` map, repeat the shared entries there too). Mac needs no DLLs (static).

- [ ] **Step 4: Notices.** `THIRD_PARTY_NOTICES.md` gets a `## whisper.cpp` section: MIT, © The ggml authors, source `https://github.com/ggml-org/whisper.cpp` (v1.9.4; Windows binaries from release `b5130`), license text in `licenses/whisper.cpp-MIT.txt`; models `ggml-*.en.bin` downloaded at run time from `https://huggingface.co/ggerganov/whisper.cpp` (MIT), not bundled.

- [ ] **Step 5: Real test.** Add to `transcribe.rs` tests:

```rust
    /// Needs the built whisper-cli (SOCIALFRAG_FFMPEG_DIR holding ffmpeg + whisper-cli), a downloaded base.en in
    /// SOCIALFRAG_WHISPER_MODEL, and SOCIALFRAG_CLIPS_DIR with the example clips.
    #[test]
    #[ignore]
    fn real_clip_discord_track_has_words() {
        let clips = std::env::var("SOCIALFRAG_CLIPS_DIR").unwrap();
        let model = std::env::var("SOCIALFRAG_WHISPER_MODEL").unwrap();
        let mut files: Vec<_> = std::fs::read_dir(&clips).unwrap().filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|x| x == "mp4")).collect();
        files.sort();
        let src = files[0].to_string_lossy().into_owned();
        let info = crate::probe::probe_clip_file(&src).unwrap();
        let discord = info.audio_tracks.iter().find(|a| a.label == "Discord").unwrap().index;
        let job = TranscribeJob { model: "base.en".into(), items: vec![TranscribeItem { key: "k".into(), source: src, track: discord, in_s: 30.0, out_s: 50.0 }] };
        let work = tempfile::tempdir().unwrap();
        let out = run_transcribe(&job, Path::new(&model), work.path(), &RealTools, &TranscribeState::default(), &|_| {}).unwrap();
        let w = &out[0].words;
        println!("{} words: {:?}", w.len(), w.iter().take(8).map(|w| &w.text).collect::<Vec<_>>());
        assert!(!w.is_empty(), "no words on the Discord track");
        assert!(w.windows(2).all(|p| p[0].start_s <= p[1].start_s));
        assert!(w.iter().all(|x| x.start_s >= 30.0 - 0.01 && x.end_s <= 50.0 + 0.5));
    }
```

Run on the Mac: download base.en once (`curl -L -o /private/tmp/claude-501/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin` and check `shasum -a 256` equals the constraint value), symlink ffmpeg/ffprobe/whisper-cli (plain names) into `/private/tmp/claude-501/sf-ff`, then `SOCIALFRAG_FFMPEG_DIR=/private/tmp/claude-501/sf-ff SOCIALFRAG_WHISPER_MODEL=/private/tmp/claude-501/ggml-base.en.bin SOCIALFRAG_CLIPS_DIR="../example clips" cargo test real_clip_discord -- --ignored --nocapture`. If `-np` suppresses the progress lines (check stderr in this run), drop `-np` from `whisper_args` and its test, and say so in the report. If the Discord range has no speech, try other 20 s ranges of the same clip and record the one used.
- [ ] **Step 6: Commit** `git add scripts src-tauri THIRD_PARTY_NOTICES.md && git commit -m "build(whisper): bundle whisper-cli v1.9.4 sidecar"` (binaries follow the ffmpeg binaries' tracked/ignored status).

---

### Task 8: Backend interface for whisper

**Files:**
- Modify: `src/backend/types.ts`, `src/backend/tauri.ts`, `src/backend/fake.ts`
- Test: `src/backend/tauri.test.ts`, `src/backend/fake.test.ts`

**Interfaces:**
- Produces (types.ts):

```ts
export type WhisperModelId = 'base.en' | 'small.en' | 'medium.en';
export interface WhisperModel { id: WhisperModelId; bytes: number; downloaded: boolean }
export interface TranscribeItem { key: string; source: string; track: number; inS: number; outS: number }
export interface TranscribeJob { model: WhisperModelId; items: TranscribeItem[] }
export interface ItemWords { key: string; words: { text: string; startS: number; endS: number }[] }
// Backend gains:
whisperModels(): Promise<WhisperModel[]>;
downloadWhisperModel(id: WhisperModelId, onProgress: (f: number) => void): Promise<void>;
transcribe(job: TranscribeJob, onProgress: (f: number) => void): Promise<ItemWords[]>;
cancelTranscribe(): Promise<void>;
```

- [ ] **Step 1: Failing tests.** `tauri.test.ts` (reuse its Channel/invoke mocks): `transcribe` and `downloadWhisperModel` ignore progress that arrives after the command resolves (same shape as the existing makeProxy test); `whisperModels` calls `invoke('whisper_models')`. `fake.test.ts`: the four methods reject/throw `'Auto-captioning needs the desktop app.'` except `cancelTranscribe` (resolves).
- [ ] **Step 2: Run** `npx vitest run src/backend` → FAIL.
- [ ] **Step 3: Implement.** tauri.ts: `whisperModels: () => invoke<WhisperModel[]>('whisper_models')`; `downloadWhisperModel: (id, p) => invokeWithProgress<void, number>('download_whisper_model', { model: id }, p)`; `transcribe: (job, p) => invokeWithProgress<ItemWords[], number>('transcribe', { job }, p)`; `cancelTranscribe: () => invoke('cancel_transcribe')`. Errors wrapped `new Error(String(e))` like `makeProxy`. fake.ts: throw per constraint; `cancelTranscribe` no-op.
- [ ] **Step 4: Run** → PASS; `npx tsc -b` clean.
- [ ] **Step 5: Commit** `git commit -m "feat(whisper): backend interface"`

---

### Task 9: Auto-caption dialog, caption list and App wiring

**Files:**
- Create: `src/components/AutoCaptionDialog.tsx`, `src/components/AutoCaptionDialog.test.tsx`
- Modify: `src/components/CaptionTool.tsx` (+ test), `src/App.tsx` (+ `App.test.tsx`), `src/styles.css`

**Interfaces:**
- Consumes: Backend whisper methods (Task 8), `groupWords` / `defaultVoiceTracks` (Task 2), `applyTranscription`, `splitCaption`, `mergeCaptionWithNext`, `setTrackStyle` (Task 3), `editCaption` (Task 1).
- Produces:
  - `AutoCaptionDialog` props: `{ backend: Backend; tracks: { label: string; env?: Float32Array }[]; scope: 'timeline' | 'clip'; buildJob(labels: string[], model: WhisperModelId): TranscribeJob; onResult(job: TranscribeJob, results: ItemWords[], labels: string[]): void; onClose(): void }`
  - `CaptionTool` gains props `onRun(scope)`, `onMerge(id)`, `onDelete(id)`, `trackStyles: { trackIndex: number; label: string; style: TrackCaptionStyle }[]`, `onTrackStyle(trackIndex, s)`; list rows are `<input aria-label="Caption text">` in time order with the time range; "Merge with next" and "Delete" buttons act on the selected row.

- [ ] **Step 1: Failing tests.**

`AutoCaptionDialog.test.tsx`:

```tsx
test('defaults to the voice track, downloads the model if needed, shows progress, returns results', async () => {
  const b = new FakeBackend();
  b.whisperModels = async () => [{ id: 'base.en', bytes: 147964211, downloaded: false }, { id: 'small.en', bytes: 487614201, downloaded: true }, { id: 'medium.en', bytes: 1533774781, downloaded: false }];
  const order: string[] = [];
  b.downloadWhisperModel = async (_id, p) => { order.push('download'); p(0.5); };
  b.transcribe = async (_job, p) => { order.push('transcribe'); p(1); return [{ key: 'c1:2', words: [{ text: 'gg', startS: 1, endS: 1.3 }] }]; };
  const onResult = vi.fn();
  render(<AutoCaptionDialog backend={b} tracks={[{ label: 'Desktop Audio' }, { label: 'Game' }, { label: 'Discord' }]} scope="timeline"
    buildJob={(labels, model) => ({ model, items: labels.map((l) => ({ key: `c1:${l === 'Discord' ? 2 : 1}`, source: '/a.mp4', track: 2, inS: 0, outS: 10 })) })}
    onResult={onResult} onClose={vi.fn()} />);
  expect((await screen.findByRole('checkbox', { name: 'Game' }) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByText('Downloaded')).toBeTruthy(); // small.en row
  fireEvent.click(screen.getByRole('checkbox', { name: 'Discord' }));
  fireEvent.click(screen.getByRole('button', { name: 'Start' }));
  await waitFor(() => expect(onResult).toHaveBeenCalled());
  expect(order).toEqual(['download', 'transcribe']);
  expect(onResult.mock.calls[0][2]).toEqual(['Game', 'Discord']);
});

test('cancel stops the run and applies nothing', async () => {
  const b = new FakeBackend();
  b.whisperModels = async () => [{ id: 'base.en', bytes: 1, downloaded: true }, { id: 'small.en', bytes: 1, downloaded: false }, { id: 'medium.en', bytes: 1, downloaded: false }];
  let reject: (e: Error) => void = () => {};
  b.transcribe = () => new Promise((_, r) => (reject = r));
  b.cancelTranscribe = async () => reject(new Error('cancelled'));
  const onResult = vi.fn();
  render(<AutoCaptionDialog backend={b} tracks={[{ label: 'Mic' }]} scope="clip" buildJob={(l, m) => ({ model: m, items: [] })} onResult={onResult} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull());
  expect(onResult).not.toHaveBeenCalled();
});

test('a failure shows the message and copyable details', async () => {
  const b = new FakeBackend();
  b.whisperModels = async () => [{ id: 'base.en', bytes: 1, downloaded: true }, { id: 'small.en', bytes: 1, downloaded: false }, { id: 'medium.en', bytes: 1, downloaded: false }];
  b.transcribe = async () => { throw new Error('Captioning failed.\nexit 1'); };
  render(<AutoCaptionDialog backend={b} tracks={[{ label: 'Mic' }]} scope="clip" buildJob={(l, m) => ({ model: m, items: [] })} onResult={vi.fn()} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
  expect(await screen.findByText('Captioning failed.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Copy error details' })).toBeTruthy();
});
```

`App.test.tsx` (extend `makeBackend` with a `Mic` track at index 3 and whisper fakes returning words for key `<clipId>:3`):

```tsx
test('auto-caption adds timed lines as one undo step; S and Delete act on the selected caption, not the clip', async () => {
  const b = makeBackend(); // tracks now include Mic (index 3)
  b.whisperModels = async () => [{ id: 'base.en', bytes: 1, downloaded: true }, { id: 'small.en', bytes: 1, downloaded: false }, { id: 'medium.en', bytes: 1, downloaded: false }];
  b.transcribe = async (job) => job.items.map((it) => ({ key: it.key, words: [{ text: 'one', startS: 1, endS: 1.4 }, { text: 'two', startS: 1.5, endS: 2 }, { text: 'three', startS: 3, endS: 3.5 }] }));
  render(<App backend={b} />);
  await openClipIn(b);
  fireEvent.click(screen.getByRole('button', { name: 'Auto-caption' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
  const rows = await screen.findAllByRole('textbox', { name: 'Caption text' });
  expect(rows.map((r) => (r as HTMLInputElement).value)).toEqual(['one two', 'three']);
  fireEvent.click(rows[0]);
  fireEvent.keyDown(window, { key: 'Delete' });
  expect(screen.getAllByRole('textbox', { name: 'Caption text' })).toHaveLength(1);
  expect(screen.getByRole('button', { name: /^Clip 1:/ })).toBeTruthy(); // clip not deleted
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
  expect(screen.queryAllByRole('textbox', { name: 'Caption text' })).toHaveLength(0); // whole run undone in one step
});

test('re-running keeps an edited line', async () => {
  // same setup; run once, edit row 0 text to 'ONE TWO', run again, rows are ['ONE TWO', 'three']
});
```

(Selecting a row focuses its text input, and `useEditorKeys` ignores keys while an input has focus. Select the caption so that focus leaves the input — click the row's time label rather than the input, or blur the input — so the Delete key reaches the editor keys; keep the assertion that the clip survives.)

(Write the second test fully in the same style: after the first run, `fireEvent.change(rows[0], { target: { value: 'ONE TWO' } })`, click Auto-caption → Start again, assert values `['ONE TWO', 'three']`.)

- [ ] **Step 2: Run** `npx vitest run src/components/AutoCaptionDialog.test.tsx src/App.test.tsx src/components/CaptionTool.test.tsx` → FAIL.

- [ ] **Step 3: Implement.**
  - `AutoCaptionDialog.tsx`: `role="dialog" aria-modal="true" aria-label="Auto-caption"` (match `SettingsDialog`'s pattern). On mount load `whisperModels()`. Track checkboxes (label text = track label), initial checks = `defaultVoiceTracks(tracks)`. Model radios `base.en` / `small.en` / `medium.en` with "Downloaded" or the size in MB (`Math.round(bytes / 1e6)`), default `base.en`. **Start** (disabled with no track checked): if the chosen model is not downloaded → `downloadWhisperModel` (progress bar labelled "Downloading model"), then `transcribe(buildJob(labels, model), setProgress)` (progress bar "Captioning"), then `onResult(job, results, labels)` and `onClose()`. **Cancel** while running → `cancelTranscribe()`; an error whose message is `cancelled` returns the dialog to its idle state silently. Other errors → first line of the message as text (e.g. "Captioning failed.") + "Copy error details" (copies the full message) + Close. After results, for each checked label whose items all returned zero words show "No speech found on <label>" before closing (the dialog closes only when the user clicks Close in that case).
  - `App.tsx`:
    - State `autoCaption: null | 'timeline' | 'clip'`.
    - Tracks for the dialog: union of `audioTracks` labels over the clips in scope (video clips only), with `env` from `media.status[mediaId]?.prepared?.find((t) => t.index === track.index)?.envelope` of the first clip that has it.
    - `buildJob(labels, model)`: for each video clip in scope and each label present in its media's `audioTracks`: `{ key: `${clip.id}:${index}`, source: media.path, track: index, inS: clip.inS, outS: clip.outS }`.
    - `onResult`: `edit((p) => applyTranscription(p, results.map((r) => { const [clipId, t] = r.key.split(':'); return { clipId, trackIndex: Number(t), lines: groupWords(r.words) }; }), uuid))` — **no coalescing key**.
    - Caption edits from `CaptionTool`, `PreviewCanvas` and the lane go through `editCaption(prev, next)` before `setCaptions`.
    - Editor keys: pass `useEditorKeys` handlers where `split` = `selectedCaptionId ? splitCaption at the playhead's source time (sourceTimeAt(activeEntry, now())) : current clip split`, and `remove` = `selectedCaptionId ? delete that caption : current clip delete`. Selecting a clip on the main track clears `selectedCaptionId`.
  - `CaptionTool.tsx`: "Auto-caption" button (scope choice: a small `<select aria-label="Auto-caption scope">` with "Whole timeline" / "This clip", default whole timeline, next to it); caption rows sorted by `start`, each an `<input aria-label="Caption text">` + a time label `m:ss.s–m:ss.s` (or "to end"); clicking a row selects it; "Merge with next" and "Delete" for the selected row; a "Track styles" row per entry of `trackStyles` (label, style `<select>`, colour `<input type="color">`) calling `onTrackStyle`. The existing single-caption editor (style, Show radios) stays for the selected caption.
- [ ] **Step 4: Run** the three test files → PASS; `npm test`, `npx tsc -b`, `npm run lint` (no new warnings vs 15).
- [ ] **Step 5: Commit** `git commit -m "feat(captions): auto-caption dialog, caption list and caption-aware keys"`

---

### Task 10: Caption lane on the timeline

**Files:**
- Create: `src/components/CaptionLane.tsx`, `src/components/CaptionLane.test.tsx`
- Modify: `src/components/Timeline.tsx` (render the lane inside `.tl-content` under the main track, sharing `pps`), `src/App.tsx` (props), `src/styles.css`

**Interfaces:**
- Consumes: `LaidClip` (`timeline/model.ts`), `TRACK_COLORS` (Task 2), `editCaption` (Task 1).
- Produces: `CaptionLane` props `{ laid: LaidClip[]; pps: number; selectedCaptionId: string | null; onSelect(clipId: string, captionId: string): void; onRetime(clipId: string, captionId: string, start: number, end: number | undefined): void }`; Timeline passes through `captionLane?: Omit<CaptionLaneProps, 'laid' | 'pps'>`.

- [ ] **Step 1: Failing tests** (`CaptionLane.test.tsx`, pointer polyfill as in `PreviewCanvas.test.tsx`):

```tsx
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
```

- [ ] **Step 2: Run** `npx vitest run src/components/CaptionLane.test.tsx` → FAIL.
- [ ] **Step 3: Implement.** Timeline time of source `s` in laid clip `e`: `e.startS + (s - e.clip.inS) / e.clip.speed` (freeze clips: the whole block `[e.startS, e.startS + e.durS)` for captions visible at the frame). Untimed captions end at the clip end. Block: `<button aria-label="Caption: {text}" style={{ left, width, background: c.color ?? TRACK_COLORS[0] }}>`; edge handles `<span aria-label="Caption start: {text}">` / `"Caption end: {text}"` with pointer capture; drag delta px → timeline s (`dx / pps`) → source s (`× speed`), clamped to `[clip.inS, clip.outS]` and to keep `end − start ≥ 0.1`. Click → `onSelect(clip.id, c.id)`. Selected block gets class `selected`. In `Timeline.tsx` render `<CaptionLane laid={laid} pps={pps} {...captionLane} />` inside `.tl-content` right under the `tl-track` main track row. In `App.tsx` pass `onSelect` (sets both `selectedId` and `selectedCaptionId`) and `onRetime` (`setCaptions` with `editCaption(prev, { ...prev, start, end })`).
- [ ] **Step 4: Run** → PASS; `npm test`, `tsc`, lint.
- [ ] **Step 5: Commit** `git commit -m "feat(captions): caption lane on the timeline"`

---

### Task 11: Verify in the app and update the tracker

- [ ] **Step 1:** `npm test`, `npx tsc -b`, `cd src-tauri && cargo test` all green; the ignored real tests from Tasks 4 and 7 pass on the Mac.
- [ ] **Step 2:** `npm run tauri dev` on the Mac with the Task 7 binary in place. User check: open an example clip; Auto-caption → Discord (and Game) → base.en (first run downloads); see coloured lines on the lane and in the list; edit text, drag an edge, `S` split, Merge with next, Delete, restyle one line and one track; re-run and confirm edits stay; Ctrl+Z undoes a run; export 9:16 and 16:9 and play them. Then the same on Windows after `scripts/fetch-whisper.ps1`.
- [ ] **Step 3:** `project.md`: Done entry (date, what shipped, tests), Next: Windows check, and note the earlier timeline spec's `whisper-rs` line is superseded.
- [ ] **Step 4: Commit** `git commit -m "docs: tracker, whisper auto-captions"`; push only when the user asks.
