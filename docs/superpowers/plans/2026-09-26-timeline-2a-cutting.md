# Timeline Editor 2a — Multi-clip Timeline and Cutting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the one-clip editor into a multi-clip timeline: import several clips, cut them (split, ripple delete, trim, reorder, speed, freeze frame), undo/redo, preview the whole timeline with streamed audio, and export it as one 9:16 video in one ffmpeg run.

**Architecture:** The editor's state becomes one immutable `Project` (media + ordered `main` track of clips) held in an undo history. Pure functions in `src/timeline/` lay clips out on the timeline and edit them. A `TimelinePlayer` drives two hidden `<video>` elements (A/B) and acts as the clock for a reworked `AudioPreview` that schedules one PCM segment per clip per track. Export sends every clip to Rust, which builds one filter graph per clip (today's layout graph plus speed and freeze handling) and joins them with `concat`.

**Tech Stack:** Tauri 2, React 19, TypeScript 6, Vitest 5 + Testing Library (jsdom), Rust (serde, base64), bundled ffmpeg 8.1.

**Spec:** `docs/superpowers/specs/2026-09-25-timeline-editor-design.md` (sub-project 2, first half). Decisions made on 2026-09-26 that refine the spec are listed under Global Constraints.

## Global Constraints

- Scope is sub-project **2a**: project model, undo/redo, cutting tools, multi-clip preview and multi-clip export. **Not in 2a** (sub-project 2b): `.sfproj` save/load, autosave, recent projects, relink. Also not here: text track and auto-captions (3), keyframes and transitions (4).
- Canvas is a project setting (`project.canvas`), fixed at 1080×1920 in 2a; Rust rejects any other size for now.
- Project frame rate is 30 or 60: 60 when any source is faster than 30.5 fps, else 30.
- Speed range 0.25 to 4. **Pitch follows speed in both preview and export** (user decision 2026-09-26): the preview resamples through Web Audio `playbackRate`, export uses `asetrate`. No `atempo`.
- **Captions stay per clip** until sub-project 3 (user decision 2026-09-26): `TimelineClip.captions`, `start` in source seconds, shown from `start` to the clip's end, moved and split with the clip.
- **Export asks for the output file with a Save dialog every time** (user decision 2026-09-26), defaulting to `<first clip name>_vertical.mp4` next to the first clip, then to the last path used.
- Every export has 0 or 1 audio streams (stereo AAC, 192k).
- Dropping one clip on the welcome screen still produces today's result (a one-clip project with the default preset, same layout and mix); the only new step is the Save dialog.
- Undo/redo: immutable project updates, history capped at 200, Ctrl/Cmd+Z undo, Shift+Ctrl/Cmd+Z and Ctrl+Y redo.
- Cache pruning must keep **every** media path in the project (`keep`), not only the file being prepared.
- No code copied from Concat (AGPL-3.0) or OpenCut. Source, DadMadeAnApp.
- Windows is first-class (WebView2); macOS Apple Silicon (WebKit). HTML5 drag-and-drop does not work on Windows while Tauri's `dragDropEnabled` is on, so dragging media onto the timeline uses pointer events, not the HTML5 drag API.
- Test commands: `npm test` (Vitest), `npm run build` (tsc + vite), `npm run lint` (oxlint), `cd src-tauri && cargo test`.
- **Between Task 9 and Task 11 the running app can't export** (the Rust job shape changes first). Don't run manual checks in that window.

## Review Focus

1. **Two cut-apart pieces of one file played back to back** (split clip): the swap must reuse the preloaded element, with no reload and no black frame. Pinned in Task 6 (`back-to-back clips of one file swap without reloading`).
2. **A project that mixes clips with audio, clips without audio tracks and freeze frames** must export exactly one audio stream, with silence where there is no audio and no error. Pinned in Task 8 (`freeze_and_silent_clips_get_generated_silence_when_others_have_audio`).
3. **Deleting or trimming the clip under the playhead while playing** must keep playing from the same timeline time without jumping or stalling. Pinned in Task 6 (`deleting the clip under the playhead while playing continues with the next clip`).
4. **Clips with different resolutions and frame rates in one export** (1080p60 next to 1440p120) must each be cropped against their own source size and joined without a concat error. Pinned in Task 8 (`clips_of_different_sizes_crop_against_their_own_source`) and the real export in Task 15.
5. **One undo after a long drag** (trim handle, gain slider, caption drag) must undo the whole drag, not one pixel of it. Pinned in Task 3 (`a continuous drag coalesces into one undo step`).

## File Structure

New frontend files:
- `src/timeline/model.ts` — `Project`, `MediaRef`, `TimelineClip`, layout (`layoutClips`, `clipAt`, `sourceTimeAt`), `projectFps`.
- `src/timeline/ops.ts` — pure edits: new clip, insert, split, ripple delete, trim, move, speed, freeze, apply preset.
- `src/timeline/history.ts` + `src/timeline/useHistory.ts` — undo/redo with drag coalescing.
- `src/timeline/player.ts` — `TimelinePlayer` (A/B video elements, freeze clock, clip swaps).
- `src/timeline/curves.ts` — per-clip gain curves (source time for export, timeline time for preview) with a memo.
- `src/timeline/segments.ts` — preview audio segments from the laid-out timeline.
- `src/timeline/exportJob.ts` — builds the Rust `ExportJob` from the project (replaces `src/state/exportJob.ts`).
- `src/state/useMedia.ts` — import, probe, proxy and audio-prep queues per media file.
- `src/state/useThumbnails.ts` — timeline thumbnails.
- `src/state/paths.ts` — `baseName`.
- `src/components/Timeline.tsx`, `MediaRail.tsx`, `ClipInspector.tsx`, `useEditorKeys.ts`.
- `src/test/fixtures/timeline-golden.json` — shared TS/Rust layout fixture.

Changed frontend files: `src/types.ts`, `src/backend/{types,tauri,fake}.ts`, `src/audio/{scheduler,AudioPreview}.ts`, `src/components/{ExportPanel,AudioMixer}.tsx`, `src/App.tsx`, `src/styles.css`, `src/test/setup.ts`, `src/state/trim.ts`.

Deleted: `src/components/TrimBar.tsx` (+test), `src/components/useTrimKeys.ts`, `src/state/exportJob.ts` (+test).

Rust: `job.rs` (ClipJob/ExportJob + validation), `audio_mix.rs` (per clip), `filtergraph.rs` (per clip graph + concat), `export.rs` (per-clip assets, chosen output path), `output_path.rs` (`mp4_path`), `commands.rs` (`keep` lists, `thumbnail`), new `thumbs.rs`, `cache.rs` (thumbs in the LRU), `lib.rs`.

---

### Task 1: Timeline model and shared golden fixture

**Files:**
- Create: `src/timeline/model.ts`
- Create: `src/test/fixtures/timeline-golden.json`
- Test: `src/timeline/model.test.ts`
- Modify: `src/types.ts` (add `ClipKind`)

**Interfaces:**
- Consumes: `ClipInfo`, `Layer`, `AudioMix`, `Caption`, `CANVAS_W`, `CANVAS_H` from `src/types.ts`; `parseFps` from `src/state/trim.ts`.
- Produces:
  - `type ClipKind = 'video' | 'freeze'` (in `src/types.ts`)
  - `interface MediaRef { id: string; path: string; info: ClipInfo }`
  - `interface TimelineClip { id; kind: ClipKind; mediaId; inS; outS; speed; presetId; layers: Layer[]; mix: AudioMix; captions: Caption[] }`
  - `interface Project { version: 1; canvas: { w: number; h: number }; fps: 30 | 60; media: MediaRef[]; main: TimelineClip[] }`
  - `interface LaidClip { clip: TimelineClip; index: number; startS: number; durS: number }`
  - `SPEED_LIMITS: readonly [0.25, 4]`
  - `emptyProject(): Project`, `clipDuration(c): number`, `layoutClips(clips): LaidClip[]`, `projectDuration(laid): number`, `clipAt(laid, t): LaidClip | null`, `sourceTimeAt(e, t): number`, `timelineTimeOf(e, srcT): number`, `projectFps(media): 30 | 60`

- [ ] **Step 1: Add `ClipKind` to `src/types.ts`**

Add after the `Trim` line:

```ts
/** video = a stretch of the source; freeze = one source frame held (inS = frame time, outS - inS = hold length). */
export type ClipKind = 'video' | 'freeze';
```

- [ ] **Step 2: Write the golden fixture**

Create `src/test/fixtures/timeline-golden.json` (Rust reads the same file in Task 7):

```json
{
  "layout": [
    {
      "name": "speed and freeze",
      "clips": [
        { "kind": "video", "inS": 2, "outS": 6, "speed": 2 },
        { "kind": "freeze", "inS": 5, "outS": 8, "speed": 1 },
        { "kind": "video", "inS": 0, "outS": 3, "speed": 0.5 }
      ],
      "starts": [0, 2, 5],
      "durations": [2, 3, 6],
      "total": 11
    },
    {
      "name": "single full clip",
      "clips": [{ "kind": "video", "inS": 0, "outS": 10, "speed": 1 }],
      "starts": [0],
      "durations": [10],
      "total": 10
    }
  ],
  "sourceAt": [
    { "clip": 0, "t": 1, "src": 4 },
    { "clip": 1, "t": 3.5, "src": 5 },
    { "clip": 2, "t": 7, "src": 1 }
  ]
}
```

- [ ] **Step 3: Write the failing tests**

Create `src/timeline/model.test.ts`:

```ts
import { expect, test } from 'vitest';
import golden from '../test/fixtures/timeline-golden.json';
import type { ClipKind } from '../types';
import { clipAt, layoutClips, projectDuration, projectFps, sourceTimeAt, timelineTimeOf, type MediaRef, type TimelineClip } from './model';

const mk = (kind: ClipKind, inS: number, outS: number, speed: number, id = `${kind}-${inS}`): TimelineClip => ({
  id, kind, mediaId: 'm', inS, outS, speed, presetId: 'p', layers: [], mix: { tracks: [], duck: null }, captions: [],
});
const fromGolden = (clips: { kind: string; inS: number; outS: number; speed: number }[]) =>
  clips.map((c, i) => mk(c.kind as ClipKind, c.inS, c.outS, c.speed, `c${i}`));

test.each(golden.layout)('layout: $name', (g) => {
  const laid = layoutClips(fromGolden(g.clips));
  expect(laid.map((e) => e.startS)).toEqual(g.starts);
  expect(laid.map((e) => e.durS)).toEqual(g.durations);
  expect(projectDuration(laid)).toBe(g.total);
});

test.each(golden.sourceAt)('source time at t=$t in clip $clip', (g) => {
  const laid = layoutClips(fromGolden(golden.layout[0].clips));
  expect(sourceTimeAt(laid[g.clip], g.t)).toBeCloseTo(g.src);
});

test('clipAt: a cut belongs to the later clip, past the end is the last clip, empty is null', () => {
  const laid = layoutClips(fromGolden(golden.layout[0].clips));
  expect(clipAt(laid, 0)!.index).toBe(0);
  expect(clipAt(laid, 2)!.index).toBe(1);
  expect(clipAt(laid, 1.999)!.index).toBe(0);
  expect(clipAt(laid, 50)!.index).toBe(2);
  expect(clipAt([], 1)).toBeNull();
});

test('sourceTimeAt clamps to the clip and timelineTimeOf inverts it', () => {
  const [a] = layoutClips([mk('video', 10, 20, 2)]);
  expect(sourceTimeAt(a, -1)).toBe(10);
  expect(sourceTimeAt(a, 99)).toBe(20);
  expect(timelineTimeOf(a, sourceTimeAt(a, 3))).toBeCloseTo(3);
});

test('projectFps is 60 when any source is faster than 30 fps', () => {
  const m = (fps: string): MediaRef => ({ id: fps, path: fps, info: { width: 1920, height: 1080, fps, codec: 'h264', duration: 1, hasAudio: false, audioTracks: [] } });
  expect(projectFps([m('30'), m('30000/1001')])).toBe(30);
  expect(projectFps([m('30'), m('120/1')])).toBe(60);
  expect(projectFps([m('60000/1001')])).toBe(60);
  expect(projectFps([])).toBe(30);
});
```

- [ ] **Step 4: Run the tests to see them fail**

Run: `npm test -- src/timeline/model.test.ts`
Expected: FAIL, `Failed to resolve import "./model"`.

- [ ] **Step 5: Write `src/timeline/model.ts`**

```ts
import { parseFps } from '../state/trim';
import { CANVAS_H, CANVAS_W, type AudioMix, type Caption, type ClipInfo, type ClipKind, type Layer } from '../types';

export interface MediaRef { id: string; path: string; info: ClipInfo }

/** inS/outS are source seconds. Freeze: inS = frame time, outS - inS = hold length, speed 1. */
export interface TimelineClip {
  id: string;
  kind: ClipKind;
  mediaId: string;
  inS: number;
  outS: number;
  speed: number;
  presetId: string;
  /** Per-clip working copy of the preset layout. */
  layers: Layer[];
  mix: AudioMix;
  /** Interim until the text track (sub-project 3): shown from `start` (source seconds) to the clip's end. */
  captions: Caption[];
}

export interface Project {
  version: 1;
  canvas: { w: number; h: number };
  fps: 30 | 60;
  media: MediaRef[];
  /** The magnetic main track: start times are derived, never stored. */
  main: TimelineClip[];
}

export interface LaidClip { clip: TimelineClip; index: number; startS: number; durS: number }

export const SPEED_LIMITS = [0.25, 4] as const;

export const emptyProject = (): Project => ({ version: 1, canvas: { w: CANVAS_W, h: CANVAS_H }, fps: 60, media: [], main: [] });

/** Timeline seconds a clip occupies. Mirrors Rust `ClipJob::duration`. */
export const clipDuration = (c: TimelineClip): number => (c.kind === 'freeze' ? c.outS - c.inS : (c.outS - c.inS) / c.speed);

export function layoutClips(clips: TimelineClip[]): LaidClip[] {
  let t = 0;
  return clips.map((clip, index) => {
    const durS = clipDuration(clip);
    const e = { clip, index, startS: t, durS };
    t += durS;
    return e;
  });
}

export function projectDuration(laid: LaidClip[]): number {
  const last = laid[laid.length - 1];
  return last ? last.startS + last.durS : 0;
}

/** Clip under timeline time t. A cut belongs to the later clip; at or past the end, the last clip. */
export function clipAt(laid: LaidClip[], t: number): LaidClip | null {
  for (let i = laid.length - 1; i > 0; i--) if (t >= laid[i].startS - 1e-9) return laid[i];
  return laid[0] ?? null;
}

/** Source seconds shown at timeline time t (clamped to the clip). */
export function sourceTimeAt(e: LaidClip, t: number): number {
  if (e.clip.kind === 'freeze') return e.clip.inS;
  const local = Math.min(Math.max(0, t - e.startS), e.durS);
  return e.clip.inS + local * e.clip.speed;
}

export function timelineTimeOf(e: LaidClip, srcT: number): number {
  return e.clip.kind === 'freeze' ? e.startS : e.startS + (srcT - e.clip.inS) / e.clip.speed;
}

/** 60 when any source is faster than 30 fps, else 30. */
export function projectFps(media: MediaRef[]): 30 | 60 {
  return media.some((m) => parseFps(m.info.fps) > 30.5) ? 60 : 30;
}
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `npm test -- src/timeline/model.test.ts`
Expected: PASS (all tests).

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/timeline/model.ts src/timeline/model.test.ts src/test/fixtures/timeline-golden.json
git commit -m "feat(timeline): project model, clip layout and golden fixture"
```

---

### Task 2: Timeline edit operations

**Files:**
- Create: `src/timeline/ops.ts`
- Test: `src/timeline/ops.test.ts`

**Interfaces:**
- Consumes: everything from Task 1; `resolveMix` from `src/audio/resolveMix.ts`; `Preset`, `AudioTrackInfo`, `AudioMix` from `src/types.ts`.
- Produces (all pure, return a new `Project`, or the same object when nothing changes):
  - `MIN_CLIP_S = 0.1`, `FREEZE_S = 3`, `MAX_FREEZE_S = 60`
  - `newClip(id: string, media: MediaRef, preset: Preset): TimelineClip`
  - `addMedia(p: Project, media: MediaRef[]): Project`
  - `insertClips(p: Project, index: number, clips: TimelineClip[]): Project`
  - `updateClip(p: Project, id: string, patch: Partial<TimelineClip>): Project`
  - `splitAt(p: Project, t: number, newId: string): Project`
  - `rippleDelete(p: Project, id: string): Project`
  - `trimClip(p: Project, id: string, edge: 'in' | 'out', srcT: number, sourceDuration: number): Project`
  - `setFreezeLength(p: Project, id: string, seconds: number): Project`
  - `moveClip(p: Project, id: string, toIndex: number): Project`
  - `setSpeed(p: Project, id: string, speed: number): Project`
  - `insertFreeze(p: Project, t: number, freezeId: string, splitId: string): Project`
  - `applyPresetToClip(c: TimelineClip, tracks: AudioTrackInfo[], preset: Preset, parts?: { layers: boolean; audio: boolean }): TimelineClip`
  - `applyPreset(p: Project, clipIds: string[], preset: Preset): Project`

- [ ] **Step 1: Write the failing tests**

Create `src/timeline/ops.test.ts`:

```ts
import { expect, test } from 'vitest';
import { BUILTIN_PRESETS } from '../presets/presets';
import type { TrackMix } from '../types';
import { emptyProject, layoutClips, type MediaRef, type Project, type TimelineClip } from './model';
import {
  FREEZE_S, MIN_CLIP_S, addMedia, applyPreset, insertClips, insertFreeze, moveClip, newClip, rippleDelete, setFreezeLength, setSpeed, splitAt, trimClip,
} from './ops';

const media = (id: string, duration = 20, fps = '60'): MediaRef => ({
  id, path: `C:/v/${id}.mp4`,
  info: { width: 1920, height: 1080, fps, codec: 'h264', duration, hasAudio: true, audioTracks: ['Desktop Audio', 'Game'].map((label, index) => ({ index, label, named: true, channels: 2 })) },
});
const preset = BUILTIN_PRESETS[0];
const track = (o: Partial<TrackMix> = {}): TrackMix => ({ index: 0, sourceLabel: 'Game', label: 'Game', enabled: true, gain: 1, ceilingDb: null, offsetS: 0, fadeInS: 0.5, fadeOutS: 0.5, mutes: [], ...o });

function project(...clips: Partial<TimelineClip>[]): Project {
  const m = media('m');
  return {
    ...addMedia(emptyProject(), [m]),
    main: clips.map((c, i) => ({ ...newClip(`c${i}`, m, preset), ...c })),
  };
}

test('newClip covers the whole source with the preset layout and smart default mix', () => {
  const c = newClip('a', media('m', 12), preset);
  expect([c.kind, c.inS, c.outS, c.speed, c.presetId]).toEqual(['video', 0, 12, 1, preset.id]);
  expect(c.layers).toBe(preset.layers);
  expect(c.mix.tracks.map((t) => [t.label, t.enabled])).toEqual([['Desktop Audio', false], ['Game', true]]);
});

test('addMedia skips media already in the project and sets the frame rate', () => {
  let p = addMedia(emptyProject(), [media('a', 5, '30')]);
  expect(p.fps).toBe(30);
  p = addMedia(p, [media('a', 5, '30'), media('b', 5, '120')]);
  expect(p.media.map((m) => m.id)).toEqual(['a', 'b']);
  expect(p.fps).toBe(60);
});

test('insertClips clamps the index', () => {
  const p = project({}, {});
  const extra = { ...p.main[0], id: 'x' };
  expect(insertClips(p, 99, [extra]).main.map((c) => c.id)).toEqual(['c0', 'c1', 'x']);
  expect(insertClips(p, -3, [extra]).main.map((c) => c.id)).toEqual(['x', 'c0', 'c1']);
});

test('splitAt cuts at the source time under the playhead, honouring speed', () => {
  const p = project({ inS: 2, outS: 6, speed: 2, mix: { tracks: [track()], duck: null }, captions: [{ id: 'k', text: 'hi', style: 'tiktok', x: 1, y: 1, fontSize: 80, start: 0 }] });
  const s = splitAt(p, 1, 'new');
  expect(s.main.map((c) => [c.id, c.inS, c.outS])).toEqual([['c0', 2, 4], ['new', 4, 6]]);
  // no fade at the cut: the halves play as one continuous stretch
  expect(s.main[0].mix.tracks[0]).toMatchObject({ fadeInS: 0.5, fadeOutS: 0 });
  expect(s.main[1].mix.tracks[0]).toMatchObject({ fadeInS: 0, fadeOutS: 0.5 });
  expect(s.main[1].captions[0].id).not.toBe(s.main[0].captions[0].id);
});

test('splitAt does nothing near a cut or on a freeze frame', () => {
  const p = project({ outS: 5 }, { kind: 'freeze', inS: 1, outS: 4 });
  expect(splitAt(p, MIN_CLIP_S / 2, 'n')).toBe(p);
  expect(splitAt(p, 5 - MIN_CLIP_S / 2, 'n')).toBe(p);
  expect(splitAt(p, 6, 'n')).toBe(p);
});

test('rippleDelete closes the gap', () => {
  const p = rippleDelete(project({ outS: 4 }, { outS: 3 }, { outS: 2 }), 'c1');
  expect(layoutClips(p.main).map((e) => [e.clip.id, e.startS])).toEqual([['c0', 0], ['c2', 4]]);
});

test('trimClip keeps at least MIN_CLIP_S of timeline and stays inside the source', () => {
  const p = project({ inS: 2, outS: 6, speed: 2 });
  expect(trimClip(p, 'c0', 'in', 5.95, 20).main[0].inS).toBeCloseTo(6 - MIN_CLIP_S * 2);
  expect(trimClip(p, 'c0', 'in', -1, 20).main[0].inS).toBe(0);
  expect(trimClip(p, 'c0', 'out', 99, 20).main[0].outS).toBe(20);
  expect(trimClip(p, 'c0', 'out', 1, 20).main[0].outS).toBeCloseTo(2 + MIN_CLIP_S * 2);
});

test('setFreezeLength clamps the hold', () => {
  const p = project({ kind: 'freeze', inS: 3, outS: 6 });
  expect(setFreezeLength(p, 'c0', 0).main[0].outS).toBeCloseTo(3 + MIN_CLIP_S);
  expect(setFreezeLength(p, 'c0', 500).main[0].outS).toBe(63);
});

test('moveClip reorders', () => {
  const p = project({}, {}, {});
  expect(moveClip(p, 'c0', 2).main.map((c) => c.id)).toEqual(['c1', 'c2', 'c0']);
  expect(moveClip(p, 'c2', 0).main.map((c) => c.id)).toEqual(['c2', 'c0', 'c1']);
});

test('setSpeed clamps to 0.25–4, rounds to 2 decimals and ignores freeze frames', () => {
  const p = project({}, { kind: 'freeze', inS: 1, outS: 4 });
  expect(setSpeed(p, 'c0', 9).main[0].speed).toBe(4);
  expect(setSpeed(p, 'c0', 0.1).main[0].speed).toBe(0.25);
  expect(setSpeed(p, 'c0', 1.234).main[0].speed).toBe(1.23);
  expect(setSpeed(p, 'c1', 2)).toBe(p);
});

test('insertFreeze inside a clip splits it and holds the frame under the playhead', () => {
  const p = project({ inS: 0, outS: 10 });
  const f = insertFreeze(p, 4, 'fz', 'rest');
  expect(f.main.map((c) => [c.id, c.kind, c.inS, c.outS])).toEqual([
    ['c0', 'video', 0, 4],
    ['fz', 'freeze', 4, 4 + FREEZE_S],
    ['rest', 'video', 4, 10],
  ]);
});

test('insertFreeze at the end of the timeline appends the last frame', () => {
  const p = project({ inS: 0, outS: 10 });
  const f = insertFreeze(p, 10, 'fz', 'unused');
  expect(f.main.map((c) => c.id)).toEqual(['c0', 'fz']);
  expect(f.main[1].inS).toBeCloseTo(9.95);
});

test('applyPreset switches the clip to the preset layout and re-resolves the mix', () => {
  const other = { ...preset, id: 'other', layers: preset.layers.slice(0, 1), audio: { tracks: [{ label: 'Game', enabled: true, gain: 0.4, ceilingDb: null, offsetS: 0 }], duck: null } };
  const p = applyPreset(project({}, {}), ['c1'], other);
  expect(p.main[0].presetId).toBe(preset.id);
  expect(p.main[1].presetId).toBe('other');
  expect(p.main[1].layers).toBe(other.layers);
  expect(p.main[1].mix.tracks.find((t) => t.label === 'Game')!.gain).toBe(0.4);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npm test -- src/timeline/ops.test.ts`
Expected: FAIL, `Failed to resolve import "./ops"`.

- [ ] **Step 3: Write `src/timeline/ops.ts`**

```ts
import { resolveMix } from '../audio/resolveMix';
import type { AudioMix, AudioTrackInfo, Preset } from '../types';
import { SPEED_LIMITS, clipAt, layoutClips, projectFps, sourceTimeAt, type MediaRef, type Project, type TimelineClip } from './model';

/** Shortest clip, in timeline seconds. */
export const MIN_CLIP_S = 0.1;
export const FREEZE_S = 3;
export const MAX_FREEZE_S = 60;
/** A freeze taken at a clip's very end uses a frame this far before the out point (ffmpeg can't seek to the end). */
const LAST_FRAME_S = 0.05;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function newClip(id: string, media: MediaRef, preset: Preset): TimelineClip {
  return {
    id, kind: 'video', mediaId: media.id, inS: 0, outS: media.info.duration, speed: 1, presetId: preset.id,
    layers: preset.layers, mix: resolveMix(media.info.audioTracks, preset).mix, captions: [],
  };
}

export function addMedia(p: Project, media: MediaRef[]): Project {
  const known = new Set(p.media.map((m) => m.id));
  const all = [...p.media, ...media.filter((m) => !known.has(m.id))];
  return { ...p, media: all, fps: projectFps(all) };
}

export function insertClips(p: Project, index: number, clips: TimelineClip[]): Project {
  const i = clamp(index, 0, p.main.length);
  return { ...p, main: [...p.main.slice(0, i), ...clips, ...p.main.slice(i)] };
}

export const updateClip = (p: Project, id: string, patch: Partial<TimelineClip>): Project => ({
  ...p,
  main: p.main.map((c) => (c.id === id ? { ...c, ...patch } : c)),
});

const withoutFade = (mix: AudioMix, which: 'fadeInS' | 'fadeOutS'): AudioMix => ({ ...mix, tracks: mix.tracks.map((t) => ({ ...t, [which]: 0 })) });

/** Split the clip under t at t. Unchanged when t is within MIN_CLIP_S of either end or on a freeze frame. */
export function splitAt(p: Project, t: number, newId: string): Project {
  const e = clipAt(layoutClips(p.main), t);
  if (!e || e.clip.kind !== 'video') return p;
  const local = t - e.startS;
  if (local < MIN_CLIP_S || e.durS - local < MIN_CLIP_S) return p;
  const cut = sourceTimeAt(e, t);
  const left: TimelineClip = { ...e.clip, outS: cut, mix: withoutFade(e.clip.mix, 'fadeOutS') };
  const right: TimelineClip = {
    ...e.clip, id: newId, inS: cut, mix: withoutFade(e.clip.mix, 'fadeInS'),
    captions: e.clip.captions.map((c) => ({ ...c, id: `${c.id}~${newId}` })),
  };
  return { ...p, main: [...p.main.slice(0, e.index), left, right, ...p.main.slice(e.index + 1)] };
}

export const rippleDelete = (p: Project, id: string): Project => ({ ...p, main: p.main.filter((c) => c.id !== id) });

export function trimClip(p: Project, id: string, edge: 'in' | 'out', srcT: number, sourceDuration: number): Project {
  const c = p.main.find((x) => x.id === id);
  if (!c || c.kind !== 'video') return p;
  const minSrc = MIN_CLIP_S * c.speed;
  return edge === 'in'
    ? updateClip(p, id, { inS: clamp(srcT, 0, c.outS - minSrc) })
    : updateClip(p, id, { outS: clamp(srcT, c.inS + minSrc, sourceDuration) });
}

export function setFreezeLength(p: Project, id: string, seconds: number): Project {
  const c = p.main.find((x) => x.id === id);
  if (!c || c.kind !== 'freeze') return p;
  return updateClip(p, id, { outS: c.inS + clamp(seconds, MIN_CLIP_S, MAX_FREEZE_S) });
}

/** toIndex = position in the list once the clip has been taken out. */
export function moveClip(p: Project, id: string, toIndex: number): Project {
  const c = p.main.find((x) => x.id === id);
  if (!c) return p;
  const rest = p.main.filter((x) => x.id !== id);
  const i = clamp(toIndex, 0, rest.length);
  return { ...p, main: [...rest.slice(0, i), c, ...rest.slice(i)] };
}

export function setSpeed(p: Project, id: string, speed: number): Project {
  const c = p.main.find((x) => x.id === id);
  if (!c || c.kind !== 'video' || !Number.isFinite(speed)) return p;
  return updateClip(p, id, { speed: Math.round(clamp(speed, SPEED_LIMITS[0], SPEED_LIMITS[1]) * 100) / 100 });
}

/**
 * Hold the frame under t for FREEZE_S. Inside a video clip (away from its ends) the clip is split and
 * the freeze goes between the halves; otherwise it goes before or after the clip, whichever end is nearer.
 */
export function insertFreeze(p: Project, t: number, freezeId: string, splitId: string): Project {
  const e = clipAt(layoutClips(p.main), t);
  if (!e) return p;
  const frame = e.clip.kind === 'freeze' ? e.clip.inS : clamp(sourceTimeAt(e, t), e.clip.inS, e.clip.outS - LAST_FRAME_S);
  const freeze: TimelineClip = {
    ...e.clip, id: freezeId, kind: 'freeze', inS: frame, outS: frame + FREEZE_S, speed: 1,
    captions: e.clip.captions.map((c) => ({ ...c, id: `${c.id}~${freezeId}` })),
  };
  const local = t - e.startS;
  if (e.clip.kind === 'video' && local >= MIN_CLIP_S && e.durS - local >= MIN_CLIP_S) {
    return insertClips(splitAt(p, t, splitId), e.index + 1, [freeze]);
  }
  return insertClips(p, local < e.durS / 2 ? e.index : e.index + 1, [freeze]);
}

/** parts: which halves of the preset to take (a clip switching to another preset takes both). */
export function applyPresetToClip(c: TimelineClip, tracks: AudioTrackInfo[], preset: Preset, parts = { layers: true, audio: true }): TimelineClip {
  return {
    ...c,
    presetId: preset.id,
    layers: parts.layers ? preset.layers : c.layers,
    mix: parts.audio ? resolveMix(tracks, preset, c.mix).mix : c.mix,
  };
}

export function applyPreset(p: Project, clipIds: string[], preset: Preset): Project {
  const info = new Map(p.media.map((m) => [m.id, m.info]));
  return { ...p, main: p.main.map((c) => (clipIds.includes(c.id) ? applyPresetToClip(c, info.get(c.mediaId)?.audioTracks ?? [], preset) : c)) };
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npm test -- src/timeline/ops.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/timeline/ops.ts src/timeline/ops.test.ts
git commit -m "feat(timeline): split, ripple delete, trim, move, speed and freeze operations"
```

---

### Task 3: Undo/redo history with drag coalescing

**Files:**
- Create: `src/timeline/history.ts`, `src/timeline/useHistory.ts`
- Test: `src/timeline/history.test.ts`

**Interfaces:**
- Produces:
  - `HISTORY_CAP = 200`, `COALESCE_MS = 1000`
  - `interface History<T> { past: T[]; present: T; future: T[]; key: string | null; at: number }`
  - `initHistory<T>(present: T): History<T>`
  - `push<T>(h, next: T, key?: string | null, now?: number): History<T>`
  - `replace<T>(h, next: T): History<T>` (no undo step)
  - `undo<T>(h): History<T>`, `redo<T>(h): History<T>`
  - `useHistory<T>(initial: () => T): { present: T; set(next: T | ((p: T) => T), key?: string | null): void; replace(next: T | ((p: T) => T)): void; undo(): void; redo(): void; canUndo: boolean; canRedo: boolean }` — `set`, `replace`, `undo`, `redo` are stable across renders.

- [ ] **Step 1: Write the failing tests**

Create `src/timeline/history.test.ts`:

```ts
import { act, renderHook } from '@testing-library/react';
import { expect, test } from 'vitest';
import { COALESCE_MS, HISTORY_CAP, initHistory, push, redo, replace, undo } from './history';
import { useHistory } from './useHistory';

test('push, undo and redo walk the history', () => {
  let h = initHistory(0);
  h = push(h, 1);
  h = push(h, 2);
  h = undo(h);
  expect(h.present).toBe(1);
  h = redo(h);
  expect(h.present).toBe(2);
  h = undo(undo(h));
  expect(h.present).toBe(0);
  expect(undo(h)).toBe(h);
});

test('a new edit after undo drops the redo branch', () => {
  let h = push(push(initHistory('a'), 'b'), 'c');
  h = push(undo(h), 'd');
  expect(h.future).toEqual([]);
  expect(redo(h)).toBe(h);
});

test('a continuous drag coalesces into one undo step', () => {
  let h = initHistory(0);
  for (let i = 1; i <= 50; i++) h = push(h, i, 'trim:c1', 1000 + i * 16);
  expect(h.present).toBe(50);
  expect(undo(h).present).toBe(0);
});

test('a different key, or a pause longer than COALESCE_MS, starts a new step', () => {
  let h = push(initHistory(0), 1, 'a', 0);
  h = push(h, 2, 'b', 10);
  h = push(h, 3, 'b', 10 + COALESCE_MS + 1);
  expect(h.past).toEqual([0, 1, 2]);
});

test('history keeps at most HISTORY_CAP undo steps', () => {
  let h = initHistory(0);
  for (let i = 1; i <= HISTORY_CAP + 50; i++) h = push(h, i);
  expect(h.past).toHaveLength(HISTORY_CAP);
  expect(h.past[0]).toBe(50);
});

test('pushing the same object is a no-op and replace adds no undo step', () => {
  const s = { v: 1 };
  const h = push(initHistory(s), s);
  expect(h.past).toEqual([]);
  expect(replace(h, { v: 2 }).past).toEqual([]);
});

test('useHistory applies updater functions and exposes undo/redo', () => {
  const { result } = renderHook(() => useHistory(() => 1));
  act(() => result.current.set((n) => n + 1));
  act(() => result.current.set((n) => n * 10));
  expect(result.current.present).toBe(20);
  act(() => result.current.undo());
  expect(result.current.present).toBe(2);
  expect(result.current.canRedo).toBe(true);
  act(() => result.current.replace((n) => n + 100));
  expect(result.current.present).toBe(102);
  act(() => result.current.undo());
  expect(result.current.present).toBe(1);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npm test -- src/timeline/history.test.ts`
Expected: FAIL, `Failed to resolve import "./history"`.

- [ ] **Step 3: Write `src/timeline/history.ts`**

```ts
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

export function undo<T>(h: History<T>): History<T> {
  if (!h.past.length) return h;
  return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future], key: null, at: 0 };
}

export function redo<T>(h: History<T>): History<T> {
  if (!h.future.length) return h;
  return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1), key: null, at: 0 };
}
```

- [ ] **Step 4: Write `src/timeline/useHistory.ts`**

```ts
import { useCallback, useState } from 'react';
import { initHistory, push, redo, replace, undo } from './history';

type Next<T> = T | ((prev: T) => T);
const resolve = <T>(next: Next<T>, prev: T): T => (typeof next === 'function' ? (next as (p: T) => T)(prev) : next);

export function useHistory<T>(initial: () => T) {
  const [h, setH] = useState(() => initHistory(initial()));
  const set = useCallback((next: Next<T>, key: string | null = null) => setH((x) => push(x, resolve(next, x.present), key)), []);
  const replaceNow = useCallback((next: Next<T>) => setH((x) => replace(x, resolve(next, x.present))), []);
  const undoNow = useCallback(() => setH((x) => undo(x)), []);
  const redoNow = useCallback(() => setH((x) => redo(x)), []);
  return { present: h.present, set, replace: replaceNow, undo: undoNow, redo: redoNow, canUndo: h.past.length > 0, canRedo: h.future.length > 0 };
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `npm test -- src/timeline/history.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/timeline/history.ts src/timeline/useHistory.ts src/timeline/history.test.ts
git commit -m "feat(timeline): undo/redo history with drag coalescing"
```

---

### Task 4: Scheduler segments carry their own rate and offset

**Files:**
- Modify: `src/audio/scheduler.ts`
- Modify: `src/audio/AudioPreview.ts:195-213` (the `restart()` call site only)
- Test: `src/audio/scheduler.test.ts` (rewrite)

**Interfaces:**
- Produces:
  - `interface Segment { pcmPath: string; totalFrames: number; srcStartS: number; timelineStartS: number; durationS: number; rate: number }` — `srcStartS` is the source second heard at `timelineStartS`, with the track offset already applied (may be negative); `rate` is the source rate (pitch follows it).
  - `startCursor(seg: Segment, t: number, now: number): Cursor | null` (no `rate` argument any more)
  - `planChunks(cursor, now, rate)` unchanged.

- [ ] **Step 1: Rewrite the tests**

Replace `src/audio/scheduler.test.ts` with:

```ts
import { expect, test } from 'vitest';
import { LOOKAHEAD_S, planChunks, startCursor, type Segment } from './scheduler';

const whole = (over: Partial<Segment> = {}): Segment => ({ pcmPath: 'p', totalFrames: 48000 * 100, srcStartS: 0, timelineStartS: 0, durationS: Infinity, rate: 1, ...over });

test('startCursor at the playhead starts now at the matching frame', () => {
  expect(startCursor(whole(), 12, 5)).toEqual({ frame: 576000, endFrame: 4800000, when: 5 });
});

test('a positive offset (negative srcStartS) delays the start and begins at frame 0', () => {
  expect(startCursor(whole({ srcStartS: -0.5 }), 0, 5)).toEqual({ frame: 0, endFrame: 4800000, when: 5.5 });
  expect(startCursor(whole({ srcStartS: -0.5, rate: 2 }), 0, 5)).toEqual({ frame: 0, endFrame: 4800000, when: 5.25 });
});

test('a negative offset starts later in the file', () => {
  expect(startCursor(whole({ srcStartS: 0.5 }), 1, 0)!.frame).toBe(72000);
});

test('startCursor returns null at or past the end of the audio', () => {
  expect(startCursor(whole(), 100, 0)).toBeNull();
  expect(startCursor(whole({ durationS: 10 }), 10, 0)).toBeNull();
});

test('a segment later on the timeline waits for its start', () => {
  expect(startCursor(whole({ timelineStartS: 20, srcStartS: 3, durationS: 5 }), 18, 0)).toEqual({ frame: 144000, endFrame: 384000, when: 2 });
});

test('a 2x segment reads twice the source per timeline second', () => {
  const c = startCursor(whole({ timelineStartS: 10, srcStartS: 30, durationS: 4, rate: 2 }), 11, 0)!;
  expect(c).toEqual({ frame: 32 * 48000, endFrame: 38 * 48000, when: 0 });
});

test('planChunks queues 1 s chunks up to 2 s ahead and advances the cursor', () => {
  const { chunks, cursor } = planChunks({ frame: 0, endFrame: 4800000, when: 0 }, 0, 1);
  expect(chunks).toEqual([
    { startFrame: 0, frames: 48000, when: 0 },
    { startFrame: 48000, frames: 48000, when: 1 },
  ]);
  expect(cursor).toEqual({ frame: 96000, endFrame: 4800000, when: 2 });
  expect(planChunks(cursor, 0, 1).chunks).toEqual([]);
  expect(planChunks(cursor, 0.5, 1).chunks).toEqual([{ startFrame: 96000, frames: 48000, when: 2 }]);
});

test('planChunks at 2x rate spaces chunks by half a second', () => {
  const { chunks } = planChunks({ frame: 0, endFrame: 4800000, when: 0 }, 0, 2);
  expect(chunks.map((c) => c.when)).toEqual([0, 0.5, 1, 1.5]);
});

test('the last chunk is partial and nothing is planned past the end', () => {
  const { chunks, cursor } = planChunks({ frame: 24000, endFrame: 60000, when: 0 }, 0, 1);
  expect(chunks).toEqual([{ startFrame: 24000, frames: 36000, when: 0 }]);
  expect(planChunks(cursor, 5, 1).chunks).toEqual([]);
});

test('a cursor far behind the clock jumps to now instead of planning the missed chunks', () => {
  const { chunks, cursor } = planChunks({ frame: 0, endFrame: 4800000, when: 0 }, 60, 1);
  expect(chunks.length).toBeLessThanOrEqual(LOOKAHEAD_S);
  expect(chunks[0]).toEqual({ startFrame: 2880000, frames: 48000, when: 60 });
  expect(cursor).toEqual({ frame: 2976000, endFrame: 4800000, when: 62 });
});

test('a cursor far behind at 2x skips twice the frames', () => {
  const { chunks } = planChunks({ frame: 0, endFrame: 4800000, when: 0 }, 10, 2);
  expect(chunks[0]).toEqual({ startFrame: 960000, frames: 48000, when: 10 });
});

test('a cursor that falls behind past its end plans nothing', () => {
  const { chunks, cursor } = planChunks({ frame: 0, endFrame: 96000, when: 0 }, 60, 1);
  expect(chunks).toEqual([]);
  expect(cursor.frame).toBe(96000);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npm test -- src/audio/scheduler.test.ts`
Expected: FAIL (`a 2x segment reads twice the source…` and the offset tests get the wrong frames, because `startCursor` still reads `offsetS`).

- [ ] **Step 3: Update `src/audio/scheduler.ts`**

Replace the `Segment` interface and `startCursor` with:

```ts
/**
 * A stretch of one track's PCM placed on the timeline: timeline time T plays source time
 * srcStartS + (T - timelineStartS) * rate, for T in [timelineStartS, timelineStartS + durationS).
 * srcStartS already includes the track's sync offset and may be negative (silence until source 0).
 * rate > 1 plays the source faster and higher, like the export's asetrate.
 */
export interface Segment { pcmPath: string; totalFrames: number; srcStartS: number; timelineStartS: number; durationS: number; rate: number }
/** Next source frame to queue, the frame to stop at, and the context time `frame` plays at. */
export interface Cursor { frame: number; endFrame: number; when: number }
export interface Chunk { startFrame: number; frames: number; when: number }

export function startCursor(seg: Segment, t: number, now: number): Cursor | null {
  if (t >= seg.timelineStartS + seg.durationS) return null;
  const from = Math.max(t, seg.timelineStartS);
  let srcT = seg.srcStartS + (from - seg.timelineStartS) * seg.rate;
  let when = now + (from - t);
  if (srcT < 0) {
    when += -srcT / seg.rate;
    srcT = 0;
  }
  const endFrame = Math.min(seg.totalFrames, Number.isFinite(seg.durationS) ? frameAt(seg.srcStartS + seg.durationS * seg.rate) : seg.totalFrames);
  const frame = frameAt(srcT);
  if (frame >= endFrame) return null;
  return { frame, endFrame, when };
}
```

Keep `planChunks`, `CHUNK_FRAMES` and `LOOKAHEAD_S` as they are.

- [ ] **Step 4: Keep `AudioPreview` compiling**

In `src/audio/AudioPreview.ts`, inside `restart()`, replace the `startCursor(...)` call with:

```ts
      n.cursor = startCursor(
        { pcmPath: n.track.pcmPath, totalFrames: n.track.frames, srcStartS: -n.mix.offsetS, timelineStartS: 0, durationS: Infinity, rate },
        videoT,
        now,
      );
```

(`AudioPreview` is rewritten in Task 5; this keeps today's behaviour until then.)

- [ ] **Step 5: Run the audio tests**

Run: `npm test -- src/audio`
Expected: PASS (scheduler and the existing AudioPreview tests).

- [ ] **Step 6: Commit**

```bash
git add src/audio/scheduler.ts src/audio/scheduler.test.ts src/audio/AudioPreview.ts
git commit -m "refactor(audio): segments carry their own source rate and baked-in offset"
```

---

### Task 5: AudioPreview plays timeline segments; per-clip curves and segments

**Files:**
- Modify: `src/audio/AudioPreview.ts` (rewrite)
- Test: `src/audio/AudioPreview.test.ts` (rewrite)
- Create: `src/timeline/curves.ts`, `src/timeline/segments.ts`
- Test: `src/timeline/curves.test.ts`, `src/timeline/segments.test.ts`
- Modify: `src/App.tsx:233-251` (interim adapter so today's single-clip App keeps working until Task 14)

**Interfaces:**
- Consumes: `Segment`, `startCursor`, `planChunks` (Task 4); `LaidClip`, `TimelineClip` (Task 1); `mixCurves`, `sliceCurve`, `curveLength` (`src/audio/curve.ts`); `duckCurve`; `enabledDuckTriggers`; `PreparedTrack`.
- Produces:
  - `interface Clock { readonly currentTime: number; readonly paused: boolean; addEventListener(type: string, fn: () => void): void; removeEventListener(type: string, fn: () => void): void }`
  - `interface AudioSegment extends Segment { key: string; ceilingDb: number | null; curve: Float32Array }` — `curve` = gain at 200 Hz in timeline time from `timelineStartS`.
  - `class AudioPreview { constructor(clock: Clock, readPcm: ReadPcm, makeContext?: () => AudioContext, onError?: () => void); setSegments(segs: AudioSegment[]): void; pump(): void; dispose(): void }` — no longer mutes anything; the caller mutes its video elements.
  - `curveFrom(curve, t)`, `driftExceeded(t, t0, ctxT0, ctxNow)` (exported for tests)
  - `interface ClipCurves { source: Map<number, Float32Array>; timeline: Map<number, Float32Array> }`
  - `resampleCurve(c: Float32Array, speed: number): Float32Array`
  - `computeClipCurves(clip: TimelineClip, sourceDuration: number, envelopes: Map<number, Float32Array> | null): ClipCurves`
  - `makeCurveCache(): (clip: TimelineClip, sourceDuration: number, envelopes: Map<number, Float32Array> | null) => ClipCurves`
  - `audioSegments(laid: LaidClip[], prepared: (mediaId: string) => PreparedTrack[] | null, curves: (clip: TimelineClip) => Map<number, Float32Array>): AudioSegment[]`

- [ ] **Step 1: Write the failing AudioPreview tests**

Replace `src/audio/AudioPreview.test.ts` with:

```ts
import { afterEach, expect, test, vi } from 'vitest';
import { AudioPreview, curveFrom, driftExceeded, type AudioSegment } from './AudioPreview';

function makeFakeClock() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    currentTime: 0,
    paused: true,
    addEventListener(ev: string, fn: () => void) {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev)!.add(fn);
    },
    removeEventListener(ev: string, fn: () => void) {
      listeners.get(ev)?.delete(fn);
    },
    fire(ev: string) {
      listeners.get(ev)?.forEach((fn) => fn());
    },
  };
}

type Started = { when: number; offset: number; frames: number; rate: number; stopped: boolean };
const param = () => ({ value: 0, cancelScheduledValues: () => {}, setValueAtTime: () => {}, setValueCurveAtTime: () => {} });
function makeFakeCtx() {
  const started: Started[] = [];
  const node = () => ({ connect: (n: unknown) => n, disconnect: () => {} });
  const ctx = {
    started,
    currentTime: 0,
    destination: {},
    createDynamicsCompressor: () => ({ ...node(), threshold: { value: 0 }, ratio: { value: 0 }, knee: { value: 0 }, attack: { value: 0 }, release: { value: 0 } }),
    createGain: () => ({ ...node(), gain: param() }),
    createBuffer: (_ch: number, frames: number) => ({ frames, copyToChannel: () => {} }),
    createBufferSource: () => {
      const rec: Started = { when: -1, offset: -1, frames: 0, rate: 1, stopped: false };
      return {
        buffer: null as null | { frames: number },
        playbackRate: { value: 1 },
        onended: null as null | (() => void),
        connect: () => {},
        disconnect: () => {},
        start(when: number, offset = 0) {
          rec.when = when;
          rec.offset = offset;
          rec.frames = this.buffer?.frames ?? 0;
          rec.rate = this.playbackRate.value;
          started.push(rec);
        },
        stop() {
          rec.stopped = true;
        },
      };
    },
    resume: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
  return ctx;
}

const seg = (o: Partial<AudioSegment> = {}): AudioSegment => ({
  key: 'a', pcmPath: '/c/audio/k/track-0.pcm', totalFrames: 48000 * 100, srcStartS: 0, timelineStartS: 0, durationS: Infinity, rate: 1, ceilingDb: null, curve: new Float32Array(), ...o,
});

/** readPcm stub: records requests; resolves immediately unless `hold` is set. */
function makeReader() {
  const calls: { path: string; startFrame: number; frames: number; resolve: () => void }[] = [];
  let hold = false;
  const read = (path: string, startFrame: number, frames: number) =>
    new Promise<ArrayBuffer>((resolve) => {
      const done = () => resolve(new ArrayBuffer(frames * 4));
      calls.push({ path, startFrame, frames, resolve: done });
      if (!hold) done();
    });
  return { read, calls, setHold: (h: boolean) => (hold = h) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(segs: AudioSegment[] = [seg()]) {
  const clock = makeFakeClock();
  const ctx = makeFakeCtx();
  const reader = makeReader();
  const preview = new AudioPreview(clock, reader.read, () => ctx as unknown as AudioContext);
  preview.setSegments(segs);
  return { clock, ctx, reader, preview };
}

async function play(s: { clock: ReturnType<typeof makeFakeClock> }, at = 0) {
  s.clock.currentTime = at;
  s.clock.paused = false;
  s.clock.fire('play');
  await flush();
}

test('curveFrom starts at the playhead sample', () => {
  const c = Float32Array.from({ length: 1000 }, (_, i) => i);
  expect(curveFrom(c, 2)[0]).toBe(400);
});

test('driftExceeded flags a clock more than 100 ms from the audio clock', () => {
  expect(driftExceeded(10.2, 10, 0, 0)).toBe(true);
  expect(driftExceeded(10.05, 10, 0, 0)).toBe(false);
});

test('play at 12 s reads two 1 s chunks from frame 576000 and schedules them back to back', async () => {
  const s = setup();
  await play(s, 12);
  expect(s.reader.calls.map((c) => c.startFrame)).toEqual([576000, 624000]);
  expect(s.ctx.started.map((x) => x.when)).toEqual([0, 1]);
  s.preview.dispose();
});

test('pump tops the queue up as the context clock advances', async () => {
  const s = setup();
  await play(s, 0);
  s.ctx.currentTime = 1;
  s.preview.pump();
  await flush();
  expect(s.reader.calls.map((c) => c.startFrame)).toEqual([0, 48000, 96000]);
  s.preview.dispose();
});

test('memory stays bounded: a long play never queues more than 3 chunks at once', async () => {
  const s = setup();
  await play(s, 0);
  for (let t = 0.25; t <= 20; t += 0.25) {
    s.ctx.currentTime = t;
    s.preview.pump();
    await flush();
  }
  expect(s.reader.calls.length).toBeGreaterThanOrEqual(20);
  const live = s.ctx.started.filter((x) => !x.stopped && x.when + 1 > s.ctx.currentTime);
  expect(live.length).toBeLessThanOrEqual(3);
  s.preview.dispose();
});

test('a segment later on the timeline reads nothing until it is inside the lookahead', async () => {
  const s = setup([seg({ timelineStartS: 10, srcStartS: 3, durationS: 5 })]);
  await play(s, 0);
  expect(s.reader.calls).toHaveLength(0);
  s.ctx.currentTime = 8.5;
  s.preview.pump();
  await flush();
  expect(s.reader.calls[0].startFrame).toBe(3 * 48000);
  expect(s.ctx.started[0].when).toBe(10);
  s.preview.dispose();
});

test('a 2x segment plays its chunks at playbackRate 2, half a second apart', async () => {
  const s = setup([seg({ rate: 2 })]);
  await play(s, 0);
  expect(s.ctx.started.map((x) => [x.when, x.rate])).toEqual([[0, 2], [0.5, 2], [1, 2], [1.5, 2]]);
  s.preview.dispose();
});

test('back-to-back segments on two files hand over at the cut', async () => {
  const s = setup([
    seg({ key: 'c1:0', pcmPath: '/a.pcm', durationS: 1.5 }),
    seg({ key: 'c2:0', pcmPath: '/b.pcm', timelineStartS: 1.5, srcStartS: 20, durationS: 5 }),
  ]);
  await play(s, 0);
  expect(s.reader.calls.map((c) => [c.path, c.startFrame, c.frames])).toEqual([
    ['/a.pcm', 0, 48000],
    ['/a.pcm', 48000, 24000],
    ['/b.pcm', 20 * 48000, 48000],
  ]);
  expect(s.ctx.started.map((x) => x.when)).toEqual([0, 1, 1.5]);
  s.preview.dispose();
});

test('stale chunk: a read that resolves after a seek is dropped', async () => {
  const s = setup();
  s.reader.setHold(true);
  await play(s, 0);
  const pending = s.reader.calls.slice();
  s.reader.setHold(false);
  s.clock.currentTime = 40;
  s.clock.fire('seeked');
  await flush();
  pending.forEach((c) => c.resolve());
  await flush();
  expect(s.reader.calls.at(-2)!.startFrame).toBe(1920000);
  expect(s.ctx.started).toHaveLength(2);
  s.preview.dispose();
});

test('late chunk: starts part-way in at the right position, or is dropped if fully late', async () => {
  const s = setup();
  s.reader.setHold(true);
  await play(s, 0);
  s.ctx.currentTime = 0.3;
  s.reader.calls[0].resolve();
  await flush();
  expect(s.ctx.started[0]).toMatchObject({ when: 0.3 });
  expect(s.ctx.started[0].offset).toBeCloseTo(0.3);
  s.ctx.currentTime = 2.5;
  s.reader.calls[1].resolve();
  await flush();
  expect(s.ctx.started).toHaveLength(1);
  s.preview.dispose();
});

test('positive offset: first chunk starts at frame 0, delayed by the offset', async () => {
  const s = setup([seg({ srcStartS: -0.5 })]);
  await play(s, 0);
  expect(s.reader.calls[0].startFrame).toBe(0);
  expect(s.ctx.started[0].when).toBeCloseTo(0.5);
  s.preview.dispose();
});

test('near the end: one partial chunk, nothing past the last frame', async () => {
  const s = setup([seg({ totalFrames: 60000 })]);
  await play(s, 0.5);
  s.ctx.currentTime = 3;
  s.preview.pump();
  await flush();
  expect(s.reader.calls.map((c) => [c.startFrame, c.frames])).toEqual([[24000, 36000]]);
  s.preview.dispose();
});

test('pause stops queued sources and stops reading', async () => {
  const s = setup();
  await play(s, 0);
  s.clock.paused = true;
  s.clock.fire('pause');
  const n = s.reader.calls.length;
  s.ctx.currentTime = 5;
  s.preview.pump();
  expect(s.ctx.started.every((x) => x.stopped)).toBe(true);
  expect(s.reader.calls).toHaveLength(n);
  s.preview.dispose();
});

test('no segments read nothing', async () => {
  const s = setup([]);
  await play(s, 0);
  expect(s.reader.calls).toHaveLength(0);
  s.preview.dispose();
});

test('a curve-only change keeps the queue; a timing change restarts it; a removed segment stops', async () => {
  const s = setup();
  await play(s, 0);
  const n = s.reader.calls.length;
  s.preview.setSegments([seg({ curve: new Float32Array([0.5, 0.5]) })]);
  expect(s.reader.calls).toHaveLength(n);
  s.preview.setSegments([seg({ srcStartS: -0.3 })]);
  await flush();
  expect(s.reader.calls.length).toBeGreaterThan(n);
  expect(s.ctx.started.slice(0, 2).every((x) => x.stopped)).toBe(true);
  s.preview.setSegments([]);
  expect(s.ctx.started.every((x) => x.stopped)).toBe(true);
  s.preview.dispose();
});

/** No rAF (window hidden/minimised) and a manual interval clock, so only explicit pumps and interval ticks refill. */
function withoutRaf() {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('returning after 60 s without refills reads at most the lookahead, not the missed minute', async () => {
  withoutRaf();
  const s = setup();
  await play(s, 0);
  const n = s.reader.calls.length;
  s.ctx.currentTime = 60;
  s.preview.pump();
  await flush();
  const fresh = s.reader.calls.slice(n);
  expect(fresh.length).toBeLessThanOrEqual(3);
  expect(fresh[0].startFrame).toBe(60 * 48000);
  s.preview.dispose();
});

test('the queue refills on a timer when rAF is not running', async () => {
  withoutRaf();
  const s = setup();
  await play(s, 0);
  const n = s.reader.calls.length;
  s.ctx.currentTime = 1;
  vi.advanceTimersByTime(250);
  await flush();
  expect(s.reader.calls.length).toBeGreaterThan(n);
  s.preview.dispose();
});

test('dispose stops the refill timer', async () => {
  withoutRaf();
  const s = setup();
  await play(s, 0);
  s.preview.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

/** Preview over `count` segments whose reads succeed or fail per `ok(path, callNo)`. */
function setupFailing(ok: (path: string, call: number) => boolean, count = 1) {
  const clock = makeFakeClock();
  const ctx = makeFakeCtx();
  const counts = new Map<string, number>();
  const read = (path: string, _start: number, frames: number) => {
    const call = (counts.get(path) ?? 0) + 1;
    counts.set(path, call);
    return ok(path, call) ? Promise.resolve(new ArrayBuffer(frames * 4)) : Promise.reject(new Error('gone'));
  };
  const onError = vi.fn();
  const preview = new AudioPreview(clock, read, () => ctx as unknown as AudioContext, onError);
  preview.setSegments(Array.from({ length: count }, (_, i) => seg({ key: `k${i}`, pcmPath: `/c/audio/k/track-${i}.pcm` })));
  return { clock, ctx, preview, onError, counts };
}

async function pumpFor(s: { ctx: { currentTime: number }; preview: AudioPreview }, seconds: number) {
  for (let t = s.ctx.currentTime + 1; t <= seconds; t++) {
    s.ctx.currentTime = t;
    s.preview.pump();
    await flush();
  }
}

test('reads that keep failing report once', async () => {
  withoutRaf();
  const s = setupFailing(() => false);
  await play(s, 0);
  await pumpFor(s, 10);
  expect(s.counts.get('/c/audio/k/track-0.pcm')).toBeGreaterThanOrEqual(6);
  expect(s.onError).toHaveBeenCalledTimes(1);
  s.preview.dispose();
});

test('two failures then a success report nothing', async () => {
  withoutRaf();
  const s = setupFailing((_p, call) => call > 2);
  await play(s, 0);
  await pumpFor(s, 10);
  expect(s.onError).not.toHaveBeenCalled();
  s.preview.dispose();
});

test('one failing segment out of two reports nothing', async () => {
  withoutRaf();
  const s = setupFailing((p) => p.endsWith('track-1.pcm'), 2);
  await play(s, 0);
  await pumpFor(s, 10);
  expect(s.onError).not.toHaveBeenCalled();
  s.preview.dispose();
});

test('a success after a report re-arms it', async () => {
  withoutRaf();
  const s = setupFailing((_p, call) => call === 4 || call > 7);
  await play(s, 0);
  await pumpFor(s, 12);
  expect(s.onError).toHaveBeenCalledTimes(2);
  s.preview.dispose();
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npm test -- src/audio/AudioPreview.test.ts`
Expected: FAIL (`setSegments is not a function`, wrong constructor arguments).

- [ ] **Step 3: Rewrite `src/audio/AudioPreview.ts`**

```ts
import { SAMPLE_RATE } from './curve';
import { PCM_RATE, s16StereoToPlanar } from './pcm';
import { planChunks, startCursor, type Cursor, type Segment } from './scheduler';

const MAX_DRIFT_S = 0.1;
/** Don't restart for drift more often than this; each restart is audible. */
const MIN_RESYNC_GAP_S = 1;
/** Refill period when rAF is paused (window hidden or minimised). */
const REFILL_MS = 250;
/** Consecutive failed reads on every segment that has read before the preview reports itself broken. */
const FAILS_TO_REPORT = 3;

/** The timeline clock audio follows (TimelinePlayer, or a plain video element). Always runs at 1x. */
export interface Clock {
  readonly currentTime: number;
  readonly paused: boolean;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

/** One clip's track on the timeline. curve = gain at SAMPLE_RATE, in timeline time from timelineStartS. */
export interface AudioSegment extends Segment { key: string; ceilingDb: number | null; curve: Float32Array }

export const curveFrom = (curve: Float32Array, t: number) => curve.subarray(Math.min(curve.length, Math.max(0, Math.floor(t * SAMPLE_RATE))));

/** Where the clock should be now given the (t0, ctxT0) anchor recorded at the last restart. */
export const expectedTime = (t0: number, ctxT0: number, ctxNow: number) => t0 + (ctxNow - ctxT0);
export const driftExceeded = (t: number, t0: number, ctxT0: number, ctxNow: number) => Math.abs(t - expectedTime(t0, ctxT0, ctxNow)) > MAX_DRIFT_S;

export type ReadPcm = (path: string, startFrame: number, frames: number) => Promise<ArrayBuffer>;

interface Node { seg: AudioSegment; cursor: Cursor | null; sources: Set<AudioBufferSourceNode>; gain: GainNode; ceiling: DynamicsCompressorNode; failures: number; tried: boolean }
interface Anchor { t0: number; ctxT0: number }

const timing = (s: Segment) => `${s.pcmPath}|${s.srcStartS}|${s.timelineStartS}|${s.durationS}|${s.rate}`;

/**
 * Streams each segment's PCM in 1 s chunks, scheduled back to back on the AudioContext clock with
 * 2 s queued ahead, through gain curve → ceiling → master limiter. The clock is the timeline:
 * play/seek and segment timing changes drop the queue and refill from the clock's position.
 * Memory is bounded by the queue, not by clip length or clip count.
 */
export class AudioPreview {
  private ctx: AudioContext;
  private master: DynamicsCompressorNode;
  private nodes = new Map<string, Node>();
  private raf = 0;
  private refill: ReturnType<typeof setInterval>;
  private readonly off: (() => void)[] = [];
  private clock: Clock;
  private readPcm: ReadPcm;
  /** Clock/context time pair of the last restart; drift is measured against it. */
  private anchor: Anchor | null = null;
  private lastResync = -Infinity;
  /** Bumped on every restart/stop so chunk reads that resolve afterwards are dropped. */
  private session = 0;
  private disposed = false;
  private onError?: () => void;
  /** onError has fired and no read has succeeded since. */
  private reported = false;

  constructor(clock: Clock, readPcm: ReadPcm, makeContext?: () => AudioContext, onError?: () => void) {
    this.clock = clock;
    this.readPcm = readPcm;
    this.onError = onError;
    this.ctx = makeContext ? makeContext() : new AudioContext({ sampleRate: PCM_RATE });
    this.master = this.ctx.createDynamicsCompressor();
    this.master.threshold.value = -1;
    this.master.ratio.value = 20;
    this.master.knee.value = 0;
    this.master.attack.value = 0.001;
    this.master.release.value = 0.05;
    this.master.connect(this.ctx.destination);
    const on = (ev: string, fn: () => void) => {
      clock.addEventListener(ev, fn);
      this.off.push(() => clock.removeEventListener(ev, fn));
    };
    on('play', () => void this.play());
    on('playing', () => this.restart());
    on('pause', () => this.stop());
    on('waiting', () => this.stop());
    on('seeked', () => (clock.paused ? this.schedule() : this.restart()));
    const tick = () => {
      if (!clock.paused && this.anchor && this.ctx.currentTime - this.lastResync > MIN_RESYNC_GAP_S) {
        if (driftExceeded(clock.currentTime, this.anchor.t0, this.anchor.ctxT0, this.ctx.currentTime)) this.restart();
      }
      this.pump();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
    this.refill = setInterval(() => this.pump(), REFILL_MS);
  }

  setSegments(segs: AudioSegment[]) {
    let restart = false;
    const keep = new Set(segs.map((s) => s.key));
    for (const [key, n] of this.nodes) {
      if (keep.has(key)) continue;
      this.dropNode(n);
      this.nodes.delete(key);
    }
    for (const s of segs) {
      let n = this.nodes.get(s.key);
      if (!n) {
        n = this.makeNode(s);
        this.nodes.set(s.key, n);
        restart = true;
      } else if (timing(n.seg) !== timing(s)) {
        restart = true;
      }
      n.seg = s;
      n.ceiling.threshold.value = s.ceilingDb ?? 0;
      n.ceiling.ratio.value = s.ceilingDb === null ? 1 : 20;
    }
    if (restart && !this.clock.paused) this.restart();
    else this.schedule();
  }

  private makeNode(seg: AudioSegment): Node {
    const gain = this.ctx.createGain();
    const ceiling = this.ctx.createDynamicsCompressor();
    ceiling.knee.value = 0;
    ceiling.attack.value = 0.001;
    ceiling.release.value = 0.05;
    gain.connect(ceiling).connect(this.master);
    return { seg, cursor: null, sources: new Set(), gain, ceiling, failures: 0, tried: false };
  }

  private dropNode(n: Node) {
    this.stopNode(n);
    n.gain.disconnect();
    n.ceiling.disconnect();
  }

  /** Queue chunks up to the lookahead for every segment with a cursor. Called every frame, every REFILL_MS and whenever a chunk ends; public for tests. */
  pump() {
    if (this.disposed || this.clock.paused) return;
    const now = this.ctx.currentTime;
    const session = this.session;
    for (const n of this.nodes.values()) {
      if (!n.cursor) continue;
      const rate = n.seg.rate;
      const plan = planChunks(n.cursor, now, rate);
      n.cursor = plan.cursor;
      for (const c of plan.chunks) {
        n.tried = true;
        this.readPcm(n.seg.pcmPath, c.startFrame, c.frames).then(
          (bytes) => {
            n.failures = 0;
            this.reported = false;
            this.playChunk(n, bytes, c.when, rate, session);
          },
          () => this.readFailed(n),
        );
      }
    }
  }

  private readFailed(n: Node) {
    if (this.disposed) return;
    n.failures++;
    const tried = [...this.nodes.values()].filter((x) => x.tried);
    if (this.reported || !tried.length || tried.some((x) => x.failures < FAILS_TO_REPORT)) return;
    this.reported = true;
    this.onError?.();
  }

  private playChunk(n: Node, bytes: ArrayBuffer, when: number, rate: number, session: number) {
    if (this.disposed || session !== this.session || !this.nodes.has(n.seg.key)) return;
    const [l, r] = s16StereoToPlanar(bytes);
    if (!l.length) return;
    const duration = l.length / PCM_RATE / rate;
    const now = this.ctx.currentTime;
    const late = Math.max(0, now - when);
    if (late >= duration) return;
    const buf = this.ctx.createBuffer(2, l.length, PCM_RATE);
    buf.copyToChannel(l, 0);
    buf.copyToChannel(r, 1);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    src.connect(n.gain);
    src.onended = () => {
      src.disconnect();
      n.sources.delete(src);
      this.pump();
    };
    src.start(Math.max(when, now), late * rate);
    n.sources.add(src);
  }

  private async play() {
    await this.ctx.resume();
    if (!this.clock.paused) this.restart();
  }

  private stopNode(n: Node) {
    for (const s of n.sources) {
      try {
        s.stop();
      } catch {
        // never started
      }
      s.disconnect();
    }
    n.sources.clear();
    n.cursor = null;
  }

  private stopSources() {
    this.session++;
    for (const n of this.nodes.values()) this.stopNode(n);
  }

  private stop() {
    this.stopSources();
    this.anchor = null;
    this.schedule();
  }

  /** Drop the queue and start every segment from the clock's current position. */
  private restart() {
    if (this.disposed) return;
    this.stopSources();
    const now = this.ctx.currentTime;
    const t = this.clock.currentTime;
    for (const n of this.nodes.values()) n.cursor = startCursor(n.seg, t, now);
    this.anchor = { t0: t, ctxT0: now };
    this.lastResync = now;
    this.schedule();
    this.pump();
  }

  /** Gain automation from the playhead onwards (future segments from their start); while paused just the current value. */
  private schedule() {
    const now = this.ctx.currentTime;
    const t = this.clock.currentTime;
    for (const n of this.nodes.values()) {
      n.gain.gain.cancelScheduledValues(now);
      const local = t - n.seg.timelineStartS;
      const rest = curveFrom(n.seg.curve, Math.max(0, local));
      if (this.clock.paused || rest.length < 2 || local >= n.seg.durationS) {
        n.gain.gain.setValueAtTime(rest[0] ?? 0, now);
      } else {
        n.gain.gain.setValueCurveAtTime(rest, now + Math.max(0, -local), rest.length / SAMPLE_RATE);
      }
    }
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    clearInterval(this.refill);
    this.off.forEach((f) => f());
    this.stopSources();
    void this.ctx.close();
  }
}
```

- [ ] **Step 4: Run the AudioPreview tests to see them pass**

Run: `npm test -- src/audio/AudioPreview.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing curve and segment tests**

Create `src/timeline/curves.test.ts`:

```ts
import { expect, test } from 'vitest';
import type { TrackMix } from '../types';
import { computeClipCurves, makeCurveCache, resampleCurve } from './curves';
import type { TimelineClip } from './model';

const track = (o: Partial<TrackMix> = {}): TrackMix => ({ index: 0, sourceLabel: 'G', label: 'G', enabled: true, gain: 1, ceilingDb: null, offsetS: 0, fadeInS: 0, fadeOutS: 0, mutes: [], ...o });
const clip = (o: Partial<TimelineClip> = {}): TimelineClip => ({
  id: 'c', kind: 'video', mediaId: 'm', inS: 2, outS: 6, speed: 1, presetId: 'p', layers: [], mix: { tracks: [track()], duck: null }, captions: [], ...o,
});

test('resampleCurve maps timeline samples onto source samples', () => {
  const c = Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7]);
  expect([...resampleCurve(c, 2)]).toEqual([0, 2, 4, 6]);
  expect([...resampleCurve(c, 0.5)]).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7]);
  expect(resampleCurve(c, 1)).toBe(c);
});

test('source curves cover the trim; timeline curves are shortened by speed', () => {
  const { source, timeline } = computeClipCurves(clip({ speed: 2, mix: { tracks: [track({ fadeInS: 1 })], duck: null } }), 20, null);
  expect(source.get(0)!.length).toBe(800);
  expect(source.get(0)![0]).toBe(0);
  expect(source.get(0)![200]).toBeCloseTo(1);
  expect(timeline.get(0)!.length).toBe(400);
});

test('a disabled track gets a silent curve', () => {
  const { source } = computeClipCurves(clip({ mix: { tracks: [track({ enabled: false })], duck: null } }), 20, null);
  expect(source.get(0)!.every((v) => v === 0)).toBe(true);
});

test('the cache returns the same curves for the same clip object and envelopes', () => {
  const get = makeCurveCache();
  const c = clip();
  const env = new Map<number, Float32Array>();
  expect(get(c, 20, env)).toBe(get(c, 20, env));
  expect(get(c, 20, new Map())).not.toBe(get(c, 20, env));
  expect(get({ ...c }, 20, env)).not.toBe(get(c, 20, env));
});
```

Create `src/timeline/segments.test.ts`:

```ts
import { expect, test } from 'vitest';
import type { PreparedTrack } from '../backend/types';
import type { TrackMix } from '../types';
import { layoutClips, type TimelineClip } from './model';
import { audioSegments } from './segments';

const track = (o: Partial<TrackMix> = {}): TrackMix => ({ index: 0, sourceLabel: 'G', label: 'G', enabled: true, gain: 1, ceilingDb: -3, offsetS: 0.25, fadeInS: 0, fadeOutS: 0, mutes: [], ...o });
const clip = (id: string, o: Partial<TimelineClip> = {}): TimelineClip => ({
  id, kind: 'video', mediaId: 'm', inS: 10, outS: 14, speed: 1, presetId: 'p', layers: [], mix: { tracks: [track(), track({ index: 1, enabled: false })], duck: null }, captions: [], ...o,
});
const prepared: PreparedTrack[] = [0, 1].map((index) => ({ index, pcmPath: `/p/track-${index}.pcm`, frames: 48000 * 60, envelope: new Float32Array() }));
const curve = new Float32Array([1, 1]);

test('one segment per enabled track, placed on the timeline with offset and speed', () => {
  const laid = layoutClips([clip('a'), clip('b', { speed: 2, inS: 30, outS: 34 })]);
  const segs = audioSegments(laid, () => prepared, () => new Map([[0, curve], [1, curve]]));
  expect(segs.map((s) => [s.key, s.pcmPath, s.srcStartS, s.timelineStartS, s.durationS, s.rate, s.ceilingDb])).toEqual([
    ['a:0', '/p/track-0.pcm', 9.75, 0, 4, 1, -3],
    ['b:0', '/p/track-0.pcm', 29.75, 4, 2, 2, -3],
  ]);
  expect(segs[0].curve).toBe(curve);
});

test('freeze frames and media without prepared audio have no segments', () => {
  const laid = layoutClips([clip('a', { kind: 'freeze', inS: 3, outS: 6 }), clip('b', { mediaId: 'other' })]);
  expect(audioSegments(laid, (id) => (id === 'm' ? prepared : null), () => new Map([[0, curve]]))).toEqual([]);
});
```

- [ ] **Step 6: Run them to see them fail**

Run: `npm test -- src/timeline/curves.test.ts src/timeline/segments.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 7: Write `src/timeline/curves.ts`**

```ts
import { curveLength, mixCurves, sliceCurve } from '../audio/curve';
import { duckCurve } from '../audio/duck';
import { enabledDuckTriggers } from '../audio/lanes';
import type { TimelineClip } from './model';

export interface ClipCurves {
  /** Export: gain per track in source time over [inS, outS). */
  source: Map<number, Float32Array>;
  /** Preview: the same gain in timeline time over the clip's duration. */
  timeline: Map<number, Float32Array>;
}

/** Timeline sample j plays source sample j * speed. */
export function resampleCurve(c: Float32Array, speed: number): Float32Array {
  if (speed === 1) return c;
  const out = new Float32Array(Math.max(0, Math.round(c.length / speed)));
  for (let j = 0; j < out.length; j++) out[j] = c[Math.min(c.length - 1, Math.floor(j * speed))];
  return out;
}

export function computeClipCurves(clip: TimelineClip, sourceDuration: number, envelopes: Map<number, Float32Array> | null): ClipCurves {
  const trim = { inS: clip.inS, outS: clip.outS };
  const triggers = envelopes
    ? enabledDuckTriggers(clip.mix)
        .map((i) => envelopes.get(i))
        .filter((e): e is Float32Array => !!e)
    : [];
  const duck = clip.mix.duck && triggers.length ? duckCurve(triggers, clip.mix.duck, curveLength(sourceDuration)) : null;
  const full = mixCurves(clip.mix, trim, sourceDuration, duck);
  const source = new Map([...full].map(([i, c]) => [i, sliceCurve(c, trim)] as const));
  const timeline = new Map([...source].map(([i, c]) => [i, resampleCurve(c, clip.speed)] as const));
  return { source, timeline };
}

/** Memo keyed by clip object identity: project edits are immutable, so untouched clips hit the cache. */
export function makeCurveCache() {
  const cache = new WeakMap<TimelineClip, { env: Map<number, Float32Array> | null; duration: number; value: ClipCurves }>();
  return (clip: TimelineClip, sourceDuration: number, envelopes: Map<number, Float32Array> | null): ClipCurves => {
    const hit = cache.get(clip);
    if (hit && hit.env === envelopes && hit.duration === sourceDuration) return hit.value;
    const value = computeClipCurves(clip, sourceDuration, envelopes);
    cache.set(clip, { env: envelopes, duration: sourceDuration, value });
    return value;
  };
}
```

- [ ] **Step 8: Write `src/timeline/segments.ts`**

```ts
import type { AudioSegment } from '../audio/AudioPreview';
import type { PreparedTrack } from '../backend/types';
import type { LaidClip, TimelineClip } from './model';

/** Preview audio: one segment per enabled track of every video clip whose media has prepared PCM. */
export function audioSegments(
  laid: LaidClip[],
  prepared: (mediaId: string) => PreparedTrack[] | null,
  curves: (clip: TimelineClip) => Map<number, Float32Array>,
): AudioSegment[] {
  const out: AudioSegment[] = [];
  for (const e of laid) {
    const { clip } = e;
    if (clip.kind !== 'video') continue;
    const tracks = prepared(clip.mediaId);
    if (!tracks) continue;
    const cs = curves(clip);
    for (const t of clip.mix.tracks) {
      if (!t.enabled) continue;
      const p = tracks.find((x) => x.index === t.index);
      const curve = cs.get(t.index);
      if (!p || !curve) continue;
      out.push({
        key: `${clip.id}:${t.index}`,
        pcmPath: p.pcmPath,
        totalFrames: p.frames,
        srcStartS: clip.inS - t.offsetS,
        timelineStartS: e.startS,
        durationS: e.durS,
        rate: clip.speed,
        ceilingDb: t.ceilingDb,
        curve,
      });
    }
  }
  return out;
}
```

- [ ] **Step 9: Keep today's App working (interim adapter)**

In `src/App.tsx`, replace the two effects that create and feed `AudioPreview` (from `const [audioPreview, setAudioPreview] = …` through `useEffect(() => audioPreview?.setMix(audioMix, curves), …);`) with:

```tsx
  // Interim until the timeline player (Task 14): the one open clip is one whole-file segment per track.
  const [audioPreview, setAudioPreview] = useState<AudioPreview | null>(null);
  useEffect(() => {
    if (!video || !prepared?.length) return;
    let p: AudioPreview;
    try {
      p = new AudioPreview(video, (path, start, frames) => backend.readPcm(path, start, frames), undefined, () =>
        setAudioError('Audio preview unavailable : export still uses your mix.'),
      );
    } catch {
      setAudioError('Audio preview unavailable : export still uses your mix.');
      return;
    }
    video.muted = true;
    setAudioPreview(p);
    return () => {
      p.dispose();
      video.muted = false;
      setAudioPreview(null);
    };
  }, [video, prepared, backend]);
  useEffect(() => {
    audioPreview?.setSegments(
      (prepared ?? []).flatMap((t) => {
        const m = audioMix.tracks.find((x) => x.index === t.index);
        const curve = curves.get(t.index);
        return m?.enabled && curve
          ? [{ key: String(t.index), pcmPath: t.pcmPath, totalFrames: t.frames, srcStartS: -m.offsetS, timelineStartS: 0, durationS: Infinity, rate: 1, ceilingDb: m.ceilingDb, curve }]
          : [];
      }),
    );
  }, [audioPreview, prepared, audioMix, curves]);
```

- [ ] **Step 10: Run the whole suite and the type check**

Run: `npm test && npx tsc -b`
Expected: all tests PASS; tsc prints nothing.

- [ ] **Step 11: Commit**

```bash
git add src/audio/AudioPreview.ts src/audio/AudioPreview.test.ts src/timeline/curves.ts src/timeline/curves.test.ts src/timeline/segments.ts src/timeline/segments.test.ts src/App.tsx
git commit -m "feat(audio): preview plays timeline segments on any clock; per-clip curves and segments"
```

---
### Task 6: TimelinePlayer (A/B video elements)

**Files:**
- Create: `src/timeline/player.ts`
- Test: `src/timeline/player.test.ts`

**Interfaces:**
- Consumes: `ClipKind` (`src/types.ts`).
- Produces:
  - `interface PlayerClip { id: string; kind: ClipKind; url: string; inS: number; startS: number; durS: number; speed: number }`
  - `interface PlayerVideo` — the subset of `HTMLVideoElement` the player drives (`src`, `currentTime`, `playbackRate`, `muted`, `paused`, `ended`, `videoWidth`, `play()`, `pause()`, `addEventListener`, `removeEventListener`).
  - `class TimelinePlayer extends EventTarget` (satisfies `Clock` from Task 5):
    - `constructor(a: PlayerVideo, b: PlayerVideo, now?: () => number)` — mutes both elements.
    - `setClips(clips: PlayerClip[]): void` — keeps the timeline time; call only when clip timing or URLs change.
    - `currentTime` (get/set, timeline seconds), `paused`, `duration`, `playbackRate` (always 1), `clipIndex` (-1 when empty), `activeElement`.
    - `play(): Promise<void>`, `pause(): void`, `tick(): void` (the owner calls it every animation frame), `dispose(): void`.
    - Events: `play`, `playing`, `pause`, `waiting`, `seeked`, `clipchange`, `mediaerror` (`CustomEvent<string>`, detail = failing URL).

- [ ] **Step 1: Write the failing tests**

Create `src/timeline/player.test.ts`:

```ts
import { expect, test } from 'vitest';
import type { ClipKind } from '../types';
import { TimelinePlayer, type PlayerClip } from './player';

class FakeVideo {
  private _src = '';
  srcSets = 0;
  currentTime = 0;
  playbackRate = 1;
  muted = false;
  paused = true;
  ended = false;
  videoWidth = 1920;
  private l = new Map<string, Set<() => void>>();
  get src() {
    return this._src;
  }
  set src(v: string) {
    this._src = v;
    this.srcSets++;
    this.paused = true; // loading a new source pauses a media element
    this.currentTime = 0;
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  addEventListener(t: string, fn: () => void) {
    if (!this.l.has(t)) this.l.set(t, new Set());
    this.l.get(t)!.add(fn);
  }
  removeEventListener(t: string, fn: () => void) {
    this.l.get(t)?.delete(fn);
  }
  fire(t: string) {
    this.l.get(t)?.forEach((f) => f());
  }
}

const clip = (id: string, url: string, inS: number, startS: number, durS: number, speed = 1, kind: ClipKind = 'video'): PlayerClip => ({ id, kind, url, inS, startS, durS, speed });

function setup(clips: PlayerClip[]) {
  const a = new FakeVideo();
  const b = new FakeVideo();
  let wall = 0;
  const p = new TimelinePlayer(a, b, () => wall);
  p.setClips(clips);
  const events: string[] = [];
  for (const e of ['play', 'playing', 'pause', 'seeked', 'waiting', 'clipchange']) p.addEventListener(e, () => events.push(e));
  return { a, b, p, events, setWall: (w: number) => (wall = w) };
}

const three = () => [clip('A', 'a', 10, 0, 5), clip('B', 'b', 2, 5, 4), clip('C', 'c', 0, 9, 3)];

test('both elements are muted and the first clip loads with the second preloaded', () => {
  const s = setup(three());
  expect([s.a.muted, s.b.muted]).toEqual([true, true]);
  expect([s.a.src, s.a.currentTime]).toEqual(['a', 10]);
  expect([s.b.src, s.b.currentTime]).toEqual(['b', 2]);
  expect(s.p.clipIndex).toBe(0);
  expect(s.p.duration).toBe(12);
});

test('seek into the preloaded clip switches to its element and preloads the next', () => {
  const s = setup(three());
  s.p.currentTime = 6;
  expect(s.p.clipIndex).toBe(1);
  expect(s.p.activeElement).toBe(s.b);
  expect(s.b.currentTime).toBe(3);
  expect([s.a.src, s.a.currentTime]).toEqual(['c', 0]);
  expect(s.events).toEqual(['clipchange', 'seeked']);
  expect(s.p.currentTime).toBe(6);
});

test('playing past a cut swaps to the preloaded element without a second playing event', async () => {
  const s = setup(three());
  await s.p.play();
  s.a.fire('playing');
  expect(s.events).toEqual(['play', 'playing']);
  s.a.currentTime = 14.99;
  s.p.tick();
  expect(s.p.activeElement).toBe(s.b);
  expect([s.a.paused, s.b.paused]).toEqual([true, false]);
  s.b.fire('playing');
  expect(s.events).toEqual(['play', 'playing', 'clipchange']);
  expect(s.p.currentTime).toBe(5);
  expect([s.a.src, s.a.currentTime]).toEqual(['c', 0]);
});

test('back-to-back clips of one file swap without reloading', async () => {
  const s = setup([clip('A', 'x', 0, 0, 5), clip('B', 'x', 5, 5, 5)]);
  expect([s.a.srcSets, s.b.srcSets]).toEqual([1, 1]);
  await s.p.play();
  s.a.currentTime = 4.99;
  s.p.tick();
  expect(s.p.activeElement).toBe(s.b);
  expect([s.a.srcSets, s.b.srcSets]).toEqual([1, 1]);
  expect([s.b.currentTime, s.b.paused]).toEqual([5, false]);
});

test('speed maps element time to timeline time', async () => {
  const s = setup([clip('A', 'a', 10, 0, 2, 2)]);
  expect(s.a.playbackRate).toBe(2);
  await s.p.play();
  s.a.currentTime = 12;
  expect(s.p.currentTime).toBe(1);
});

test('a freeze clip holds its frame and advances on the wall clock', async () => {
  const s = setup([clip('F', 'x', 3, 0, 2, 1, 'freeze'), clip('B', 'y', 0, 2, 3)]);
  await s.p.play();
  expect(s.events).toEqual(['play', 'playing']);
  expect([s.a.paused, s.a.currentTime]).toEqual([true, 3]);
  s.setWall(1);
  expect(s.p.currentTime).toBe(1);
  s.setWall(1.99);
  s.p.tick();
  expect(s.p.activeElement).toBe(s.b);
  expect(s.b.paused).toBe(false);
});

test('the end of the timeline pauses at the duration; play again restarts at 0', async () => {
  const s = setup([clip('A', 'a', 4, 0, 2)]);
  await s.p.play();
  s.a.currentTime = 5.999;
  s.p.tick();
  expect(s.p.paused).toBe(true);
  expect(s.p.currentTime).toBe(2);
  expect(s.events).toContain('pause');
  await s.p.play();
  expect(s.a.currentTime).toBe(4);
  expect(s.p.paused).toBe(false);
});

test('deleting the clip under the playhead while playing continues with the next clip', async () => {
  const s = setup(three());
  s.p.currentTime = 6;
  await s.p.play();
  expect(s.p.activeElement).toBe(s.b);
  s.b.currentTime = 3; // still 6 s into the timeline
  s.p.setClips([clip('A', 'a', 10, 0, 5), clip('C', 'c', 0, 5, 3)]);
  expect(s.p.clipIndex).toBe(1);
  const el = s.p.activeElement as unknown as FakeVideo;
  expect([el.src, el.currentTime, el.paused]).toEqual(['c', 1, false]);
  expect(s.p.paused).toBe(false);
});

test('setClips with the same timing leaves a playing element alone', async () => {
  const s = setup(three());
  await s.p.play();
  s.a.currentTime = 12;
  s.p.setClips(three());
  expect([s.a.srcSets, s.a.currentTime, s.a.paused]).toEqual([1, 12, false]);
});

test('waiting then playing on the active element relays both', async () => {
  const s = setup(three());
  await s.p.play();
  s.a.fire('playing');
  s.a.fire('waiting');
  s.a.fire('playing');
  expect(s.events).toEqual(['play', 'playing', 'waiting', 'playing']);
});

test('mediaerror carries the failing url, also for a picture-less load', () => {
  const s = setup(three());
  const urls: string[] = [];
  s.p.addEventListener('mediaerror', (e) => urls.push((e as CustomEvent<string>).detail));
  s.a.fire('error');
  s.b.videoWidth = 0;
  s.b.fire('loadedmetadata');
  expect(urls).toEqual(['a', 'b']);
});

test('an empty timeline has no clip and nothing to play', async () => {
  const s = setup([]);
  expect(s.p.clipIndex).toBe(-1);
  await s.p.play();
  expect(s.p.paused).toBe(true);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npm test -- src/timeline/player.test.ts`
Expected: FAIL, `Failed to resolve import "./player"`.

- [ ] **Step 3: Write `src/timeline/player.ts`**

```ts
import type { ClipKind } from '../types';

/** What the player needs per timeline clip (derived from the project and the media URLs). */
export interface PlayerClip { id: string; kind: ClipKind; url: string; inS: number; startS: number; durS: number; speed: number }

/** The subset of HTMLVideoElement the player drives; tests pass fakes. */
export interface PlayerVideo {
  src: string;
  currentTime: number;
  playbackRate: number;
  muted: boolean;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly videoWidth: number;
  play(): Promise<void> | void;
  pause(): void;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

/** Swap this close to a cut: rAF runs every ~16 ms, so waiting for the exact end would show frames past the out point. */
const SWAP_EARLY_S = 1 / 60;
/** After an edit, a playing element within this of where it should be is left alone (no audible re-seek). */
const RESEEK_S = 0.05;

/**
 * Plays the magnetic main track on two video elements (A/B): the clip under the playhead plays in
 * one while the next waits, paused at its in point, in the other; they swap at each cut. Freeze
 * clips hold a paused frame and advance on the wall clock. Looks like a media element to
 * AudioPreview (timeline currentTime, paused, play/playing/pause/waiting/seeked) and also emits
 * 'clipchange' and 'mediaerror' (detail = the URL that failed to play).
 */
export class TimelinePlayer extends EventTarget {
  readonly playbackRate = 1;
  private clips: PlayerClip[] = [];
  private readonly els: [PlayerVideo, PlayerVideo];
  private active = 0;
  private idx = -1;
  /** Timeline time while paused, and the time of the last seek/swap. */
  private t = 0;
  private playing = false;
  /** Wall-clock anchor while a freeze clip plays. */
  private wall: { at: number; t: number } | null = null;
  /** An element 'playing' is passed on after play() or a stall, not after a swap (audio is already scheduled across cuts). */
  private relayPlaying = false;
  private readonly urls = new Map<PlayerVideo, string>();
  private readonly loaded = new Map<PlayerVideo, number>();
  private readonly off: (() => void)[] = [];
  private readonly now: () => number;

  constructor(a: PlayerVideo, b: PlayerVideo, now = () => performance.now() / 1000) {
    super();
    this.els = [a, b];
    this.now = now;
    for (const el of this.els) {
      el.muted = true; // preview audio comes from AudioPreview
      const on = (type: string, fn: () => void) => {
        el.addEventListener(type, fn);
        this.off.push(() => el.removeEventListener(type, fn));
      };
      on('waiting', () => {
        if (!this.isActive(el) || !this.playing) return;
        this.relayPlaying = true;
        this.dispatchEvent(new Event('waiting'));
      });
      on('playing', () => {
        if (!this.isActive(el) || !this.playing || !this.relayPlaying) return;
        this.relayPlaying = false;
        this.dispatchEvent(new Event('playing'));
      });
      on('error', () => this.mediaError(el));
      // Loaded but no picture = the webview can't decode the video track.
      on('loadedmetadata', () => el.videoWidth === 0 && this.mediaError(el));
    }
  }

  get duration() {
    const last = this.clips[this.clips.length - 1];
    return last ? last.startS + last.durS : 0;
  }
  get paused() {
    return !this.playing;
  }
  get clipIndex() {
    return this.idx;
  }
  get activeElement(): PlayerVideo {
    return this.els[this.active];
  }
  get currentTime() {
    return this.playing ? this.liveTime() : this.t;
  }
  set currentTime(t: number) {
    this.seek(t);
  }

  setClips(clips: PlayerClip[]) {
    const t = this.currentTime;
    this.clips = clips;
    this.loaded.clear();
    if (!clips.length) {
      this.playing = false;
      this.wall = null;
      this.els.forEach((e) => e.pause());
      this.idx = -1;
      this.t = 0;
      this.dispatchEvent(new Event('clipchange'));
      return;
    }
    this.t = Math.min(t, this.duration);
    this.idx = -1;
    this.place(this.t, RESEEK_S);
    if (this.playing) this.resume();
  }

  play(): Promise<void> {
    if (this.playing || !this.clips.length) return Promise.resolve();
    if (this.t >= this.duration - 1e-6) {
      this.t = 0;
      this.place(0, 0);
    }
    this.playing = true;
    this.relayPlaying = true;
    this.dispatchEvent(new Event('play'));
    this.resume();
    if (this.clips[this.idx].kind === 'freeze') {
      this.relayPlaying = false;
      this.dispatchEvent(new Event('playing'));
    }
    return Promise.resolve();
  }

  pause() {
    if (!this.playing) return;
    this.t = this.liveTime();
    this.playing = false;
    this.wall = null;
    this.els[this.active].pause();
    this.dispatchEvent(new Event('pause'));
  }

  /** Called every animation frame: swaps elements at a cut and stops at the end. */
  tick() {
    if (!this.playing || this.idx < 0) return;
    const c = this.clips[this.idx];
    const end = c.startS + c.durS;
    const el = this.els[this.active];
    if (this.liveTime() < end - SWAP_EARLY_S && !(c.kind === 'video' && el.ended)) return;
    const next = this.idx + 1;
    if (next >= this.clips.length) {
      this.t = this.duration;
      this.playing = false;
      this.wall = null;
      el.pause();
      this.dispatchEvent(new Event('pause'));
      return;
    }
    this.t = end;
    const other = 1 - this.active;
    if (this.loaded.get(this.els[other]) !== next) this.load(this.els[other], next, this.clips[next].inS, 0);
    this.active = other;
    this.idx = next;
    this.resume();
    this.preload();
    this.dispatchEvent(new Event('clipchange'));
  }

  dispose() {
    this.off.forEach((f) => f());
    this.els.forEach((e) => e.pause());
    this.playing = false;
  }

  private seek(t: number) {
    if (!this.clips.length) return;
    this.t = Math.min(Math.max(0, t), this.duration);
    this.place(this.t, 0);
    if (this.playing) this.resume();
    this.dispatchEvent(new Event('seeked'));
  }

  private isActive(el: PlayerVideo) {
    return this.els[this.active] === el;
  }

  private mediaError(el: PlayerVideo) {
    const url = this.urls.get(el);
    if (url) this.dispatchEvent(new CustomEvent('mediaerror', { detail: url }));
  }

  private liveTime(): number {
    const c = this.clips[this.idx];
    if (!c) return this.t;
    const end = c.startS + c.durS;
    if (c.kind === 'freeze') return this.wall ? Math.min(end, this.wall.t + (this.now() - this.wall.at)) : this.t;
    const el = this.els[this.active];
    return Math.min(end, Math.max(c.startS, c.startS + (el.currentTime - c.inS) / c.speed));
  }

  private indexAt(t: number) {
    for (let i = this.clips.length - 1; i > 0; i--) if (t >= this.clips[i].startS - 1e-9) return i;
    return 0;
  }

  /** Put the clip under t in the active element (preferring the one that already holds it) and preload the next. */
  private place(t: number, tol: number) {
    const i = this.indexAt(t);
    const prevId = this.clips[this.idx]?.id;
    const prevEl = this.els[this.active];
    this.idx = i;
    const c = this.clips[i];
    const src = c.kind === 'freeze' ? c.inS : c.inS + (t - c.startS) * c.speed;
    const other = 1 - this.active;
    if (this.loaded.get(this.els[this.active]) !== i && this.loaded.get(this.els[other]) === i) this.active = other;
    this.load(this.els[this.active], i, src, tol);
    this.preload();
    if (c.id !== prevId || this.els[this.active] !== prevEl) this.dispatchEvent(new Event('clipchange'));
  }

  private load(el: PlayerVideo, i: number, srcT: number, tol: number) {
    const c = this.clips[i];
    if (this.urls.get(el) !== c.url) {
      el.src = c.url;
      this.urls.set(el, c.url);
    }
    el.playbackRate = c.kind === 'freeze' ? 1 : c.speed;
    if (Math.abs(el.currentTime - srcT) > tol) el.currentTime = srcT;
    this.loaded.set(el, i);
  }

  private preload() {
    const n = this.idx + 1;
    if (n < this.clips.length) this.load(this.els[1 - this.active], n, this.clips[n].inS, 0);
  }

  /** While playing: run the active element (or the freeze clock) and park the other one. */
  private resume() {
    const c = this.clips[this.idx];
    const el = this.els[this.active];
    this.els[1 - this.active].pause();
    if (c.kind === 'freeze') {
      el.pause();
      this.wall = { at: this.now(), t: this.t };
      return;
    }
    this.wall = null;
    if (el.paused) {
      const r = el.play();
      if (r) r.catch(() => {});
    }
  }
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npm test -- src/timeline/player.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/timeline/player.ts src/timeline/player.test.ts
git commit -m "feat(timeline): A/B timeline player with freeze clock and clip swaps"
```

---

### Task 7: Rust job model — ClipJob, ExportJob and validation

**Files:**
- Modify: `src-tauri/src/job.rs`
- Modify: `src-tauri/src/audio_mix.rs` (take `&ClipJob`)
- Modify: `src-tauri/src/filtergraph.rs`, `src-tauri/src/export.rs` (only what's needed to compile; rewritten in Tasks 8–9)

**Interfaces:**
- Produces (Rust, serde camelCase, matching the TS types written in Task 11):
  - `enum ClipKind { Video, Freeze }` (default `Video`)
  - `struct ClipJob { kind, source, clip: ClipInfo, preset: Preset, trim: Trim, speed: f64 (default 1), layer_masks, overlays: Vec<Overlay>, audio: AudioMix, gain_curves }` with `fn duration(&self) -> f64`
  - `struct Canvas { w: u32, h: u32 }`
  - `struct ExportJob { clips: Vec<ClipJob>, quality: Quality, fps: u32, canvas: Canvas, output_path: String }` with `fn duration(&self) -> f64`
  - `MAX_CLIPS = 200`, `MAX_FREEZE_S = 60.0`, `fn validate_job(job: &ExportJob) -> Result<(), String>`
  - `audio_mix::enabled_tracks(c: &ClipJob)`, `audio_mix::validate_mix(c: &ClipJob)` (freeze clips have no enabled tracks)
  - Test fixtures: `job::fixtures::clip() -> ClipJob` (the old single-clip fixture, trim 1..11) and `job::fixtures::job() -> ExportJob` (one clip, 60 fps, 1080×1920, output `C:/clips/in_vertical.mp4`).

- [ ] **Step 1: Write the failing tests in `job.rs`**

Replace the `tests` module at the bottom of `src-tauri/src/job.rs` with:

```rust
#[cfg(test)]
mod tests {
    use super::fixtures::{clip, job};
    use super::*;

    #[test]
    fn deserializes_ts_shaped_json() {
        let json = r#"{"clips":[{"kind":"freeze","source":"C:/a.mp4","clip":{"width":1920,"height":1080,"fps":"60","codec":"h264","duration":5,"hasAudio":false},
          "preset":{"id":"p","name":"P","version":1,"background":{"type":"none"},"layers":[{"id":"g","src":[0,0,1,1],"dst":[0,0,1080,1920]}]},
          "trim":{"inS":1,"outS":4},"speed":1,"layerMasks":{},"overlays":[{"pngBase64":"AA==","start":1.5}],"audio":{"tracks":[],"duck":null},"gainCurves":{}}],
          "quality":"small","fps":30,"canvas":{"w":1080,"h":1920},"outputPath":"C:/out.mp4"}"#;
        let j: ExportJob = serde_json::from_str(json).unwrap();
        assert_eq!(j.clips[0].kind, ClipKind::Freeze);
        assert_eq!(j.clips[0].overlays[0].start, 1.5);
        assert_eq!((j.fps, j.canvas.w, j.output_path.as_str()), (30, 1080, "C:/out.mp4"));
        assert_eq!(j.duration(), 3.0);
    }

    #[test]
    fn clip_json_without_kind_or_speed_is_a_normal_speed_video() {
        let json = r#"{"source":"a","clip":{"width":1920,"height":1080,"fps":"60","codec":"h264","duration":5,"hasAudio":false},
          "preset":{"id":"p","name":"P","version":1,"background":{"type":"none"},"layers":[{"id":"g","src":[0,0,1,1],"dst":[0,0,1080,1920]}]},
          "trim":{"inS":0,"outS":5},"layerMasks":{},"overlays":[]}"#;
        let c: ClipJob = serde_json::from_str(json).unwrap();
        assert_eq!((c.kind, c.speed), (ClipKind::Video, 1.0));
    }

    #[test]
    fn durations_match_the_shared_golden_fixture() {
        let g: serde_json::Value = serde_json::from_str(include_str!("../../src/test/fixtures/timeline-golden.json")).unwrap();
        for case in g["layout"].as_array().unwrap() {
            let clips: Vec<ClipJob> = case["clips"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| {
                    let mut x = clip();
                    x.kind = if c["kind"] == "freeze" { ClipKind::Freeze } else { ClipKind::Video };
                    x.trim = Trim { in_s: c["inS"].as_f64().unwrap(), out_s: c["outS"].as_f64().unwrap() };
                    x.speed = c["speed"].as_f64().unwrap();
                    x
                })
                .collect();
            let durations: Vec<f64> = clips.iter().map(ClipJob::duration).collect();
            let want: Vec<f64> = case["durations"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
            assert_eq!(durations, want, "{}", case["name"]);
            let j = ExportJob { clips, ..job() };
            assert_eq!(j.duration(), case["total"].as_f64().unwrap());
        }
    }

    #[test]
    fn a_valid_job_passes() {
        assert!(validate_job(&job()).is_ok());
    }

    #[test]
    fn rejects_bad_projects() {
        let mut j = job();
        j.clips.clear();
        assert!(validate_job(&j).unwrap_err().contains("1 to 200"));
        let mut j = job();
        j.clips = vec![clip(); MAX_CLIPS + 1];
        assert!(validate_job(&j).is_err());
        let mut j = job();
        j.fps = 24;
        assert!(validate_job(&j).unwrap_err().contains("fps"));
        let mut j = job();
        j.canvas = Canvas { w: 1920, h: 1080 };
        assert!(validate_job(&j).unwrap_err().contains("1080x1920"));
    }

    #[test]
    fn rejects_bad_clips_with_their_position() {
        let bad = |f: fn(&mut ClipJob)| {
            let mut j = job();
            j.clips.push(clip());
            f(&mut j.clips[1]);
            validate_job(&j).unwrap_err()
        };
        assert!(bad(|c| c.trim.out_s = 31.0).starts_with("clip 2:"));
        assert!(bad(|c| c.trim.in_s = 12.0).contains("in/out"));
        assert!(bad(|c| c.trim.in_s = f64::NAN).contains("in/out"));
        assert!(bad(|c| c.speed = 5.0).contains("speed"));
        assert!(bad(|c| {
            c.kind = ClipKind::Freeze;
            c.trim = Trim { in_s: 1.0, out_s: 62.0 };
        })
        .contains("freeze"));
        assert!(bad(|c| {
            c.kind = ClipKind::Freeze;
            c.speed = 2.0;
        })
        .contains("freeze"));
    }
}
```

- [ ] **Step 2: Run to see it fail**

Run: `cd src-tauri && cargo test job::`
Expected: compile errors (`ClipJob`, `ClipKind`, `Canvas`, `validate_job` not found).

- [ ] **Step 3: Replace `ExportJob` in `job.rs`**

Replace the `ExportJob` struct (lines 54–70) with:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClipKind {
    #[default]
    Video,
    /// One source frame (at trim.in_s) held for trim.out_s - trim.in_s seconds.
    Freeze,
}

fn one() -> f64 {
    1.0
}

/// One timeline clip: source window, layout and audio. Overlay starts are seconds into the clip's output.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipJob {
    #[serde(default)]
    pub kind: ClipKind,
    pub source: String,
    pub clip: ClipInfo,
    pub preset: Preset,
    pub trim: Trim,
    #[serde(default = "one")]
    pub speed: f64,
    pub layer_masks: HashMap<String, String>,
    pub overlays: Vec<Overlay>,
    #[serde(default)]
    pub audio: AudioMix,
    /// track index -> base64 f32le gain samples at 200 Hz covering the trim (source time)
    #[serde(default)]
    pub gain_curves: HashMap<u32, String>,
}

impl ClipJob {
    /// Output seconds this clip occupies. Mirrors TS `clipDuration`.
    pub fn duration(&self) -> f64 {
        match self.kind {
            ClipKind::Freeze => self.trim.out_s - self.trim.in_s,
            ClipKind::Video => (self.trim.out_s - self.trim.in_s) / self.speed,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Canvas {
    pub w: u32,
    pub h: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportJob {
    pub clips: Vec<ClipJob>,
    pub quality: Quality,
    pub fps: u32,
    pub canvas: Canvas,
    /// Chosen in the Save dialog; `.mp4` is added when missing.
    pub output_path: String,
}

impl ExportJob {
    pub fn duration(&self) -> f64 {
        self.clips.iter().map(ClipJob::duration).sum()
    }
}

pub const MAX_CLIPS: usize = 200;
pub const MAX_FREEZE_S: f64 = 60.0;
/// Source durations from ffprobe are rounded; allow an out point this far past them.
const DURATION_SLACK_S: f64 = 0.05;

pub fn validate_job(job: &ExportJob) -> Result<(), String> {
    if job.clips.is_empty() || job.clips.len() > MAX_CLIPS {
        return Err(format!("a timeline needs 1 to {MAX_CLIPS} clips"));
    }
    if job.fps != 30 && job.fps != 60 {
        return Err(format!("fps must be 30 or 60, got {}", job.fps));
    }
    if job.canvas != (Canvas { w: 1080, h: 1920 }) {
        return Err("only 1080x1920 output is supported".into());
    }
    for (n, c) in job.clips.iter().enumerate() {
        validate_clip(c).map_err(|e| format!("clip {}: {e}", n + 1))?;
    }
    Ok(())
}

fn validate_clip(c: &ClipJob) -> Result<(), String> {
    let (i, o) = (c.trim.in_s, c.trim.out_s);
    if !(i.is_finite() && o.is_finite() && i >= 0.0 && o > i) {
        return Err("in/out out of range".into());
    }
    match c.kind {
        ClipKind::Video => {
            if o > c.clip.duration + DURATION_SLACK_S {
                return Err("in/out out of range".into());
            }
            if !crate::preset::in_range(c.speed, 0.25, 4.0) {
                return Err("speed must be 0.25 to 4".into());
            }
        }
        ClipKind::Freeze => {
            if i > c.clip.duration || o - i > MAX_FREEZE_S || c.speed != 1.0 {
                return Err(format!("freeze frame must be inside the source, at most {MAX_FREEZE_S} s long, at speed 1"));
            }
        }
    }
    Ok(())
}
```

Replace the `fixtures` module with:

```rust
#[cfg(test)]
pub mod fixtures {
    use super::*;

    pub fn clip() -> ClipJob {
        ClipJob {
            kind: ClipKind::Video,
            source: "C:/clips/in.mp4".into(),
            clip: ClipInfo { width: 1920, height: 1080, fps: "60".into(), codec: "h264".into(), codec_tag: "avc1".into(), duration: 30.0, has_audio: true, audio_tracks: vec![] },
            preset: serde_json::from_str(include_str!("../../src/test/fixtures/preset-fixture.json")).unwrap(),
            trim: Trim { in_s: 1.0, out_s: 11.0 },
            speed: 1.0,
            layer_masks: HashMap::new(),
            overlays: vec![],
            audio: AudioMix::default(),
            gain_curves: HashMap::new(),
        }
    }

    pub fn job() -> ExportJob {
        ExportJob { clips: vec![clip()], quality: Quality::High, fps: 60, canvas: Canvas { w: 1080, h: 1920 }, output_path: "C:/clips/in_vertical.mp4".into() }
    }
}
```

- [ ] **Step 4: Make `audio_mix.rs` work per clip**

In `src-tauri/src/audio_mix.rs`:

- Change the import to `use crate::job::{ClipJob, ClipKind, Trim};`.
- Replace `enabled_tracks` and the first line of `validate_mix`:

```rust
/// Tracks that reach the export: enabled, present in the source, and not on a freeze frame (silent by design).
pub fn enabled_tracks(c: &ClipJob) -> Vec<&TrackMix> {
    if !c.clip.has_audio || c.kind == ClipKind::Freeze {
        return vec![];
    }
    c.audio.tracks.iter().filter(|t| t.enabled && c.clip.audio_tracks.iter().any(|a| a.index == t.index)).collect()
}

pub fn validate_mix(job: &ClipJob) -> Result<(), String> {
```

(the rest of `validate_mix` is unchanged; it already reads `job.audio`, `job.clip`, `job.trim`, `job.gain_curves`).

- In its tests module change `use crate::job::{fixtures::job, AudioTrackInfo};` to `use crate::job::{fixtures::clip as job, AudioTrackInfo, ClipJob, ClipKind};`, change `fn with_tracks() -> ExportJob` to `fn with_tracks() -> ClipJob`, change the two `let j: ExportJob = serde_json::from_str(…)` lines in `job_json_without_audio_still_parses` to `let j: ClipJob = …`, and add:

```rust
    #[test]
    fn freeze_frames_have_no_audio() {
        let mut j = with_tracks();
        j.kind = ClipKind::Freeze;
        assert!(enabled_tracks(&j).is_empty());
        j.gain_curves.clear();
        assert!(validate_mix(&j).is_ok());
    }
```

- [ ] **Step 5: Keep `filtergraph.rs` and `export.rs` compiling for now**

Tasks 8 and 9 rewrite these two files. For this task only, make them compile against the new types:

- In `filtergraph.rs` change `use crate::job::ExportJob;` to `use crate::job::ClipJob as ExportJob;`, change `args.extend(enc.args(job.quality));` in `build_args` to `args.extend(enc.args(crate::job::Quality::High));` (a clip has no quality of its own), and mark the whole tests module `#[cfg(any())]` (it is replaced in Task 8).
- In `export.rs` change `use crate::job::{ExportError, ExportJob, ExportProgress, ExportResult};` to `use crate::job::{ClipJob, ExportError, ExportJob, ExportProgress, ExportResult};`, change `write_assets(job: &ExportJob, …)` to `write_assets(job: &ClipJob, …)`, change `run_once(job: &ExportJob, …)` to `run_once(job: &ClipJob, …)`, and replace the body of `run_export` after the busy check with:

```rust
    crate::job::validate_job(&job).map_err(|e| ExportError::new("invalid_project", "This timeline can't be exported.", &e))?;
    Err(ExportError::new("ffmpeg", "Multi-clip export lands in Task 9.", ""))
```

Mark the export tests module `#[cfg(any())]` too (replaced in Task 9). `commands.rs` compiles unchanged because it only passes `ExportJob` through.

- [ ] **Step 6: Run the Rust tests**

Run: `cd src-tauri && cargo test`
Expected: PASS (job, audio_mix, probe, proxy, cache, presets and the other modules; filtergraph/export tests are temporarily compiled out).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/job.rs src-tauri/src/audio_mix.rs src-tauri/src/filtergraph.rs src-tauri/src/export.rs
git commit -m "feat(export): multi-clip job model with per-clip validation"
```

---

### Task 8: Rust filter graph — one graph per clip, speed, freeze, concat

**Files:**
- Modify: `src-tauri/src/filtergraph.rs` (rewrite)
- Modify: `src-tauri/src/export.rs` (add `ClipAssets`)

**Interfaces:**
- Consumes: `ClipJob`, `ClipKind`, `ExportJob`, `Canvas` (Task 7); `enabled_tracks`, `GAIN_RATE`; `layout_layer`.
- Produces:
  - `export::ClipAssets { masks: Vec<(String, PathBuf)>, overlays: Vec<(PathBuf, f64)>, gains: Vec<(u32, PathBuf)> }` (`#[derive(Default)]`)
  - `filtergraph::secs(v: f64) -> String`
  - `filtergraph::build_clip_video(c, n, v_in, masks, overlays, fps, canvas) -> String` → output label `[v{n}]`
  - `filtergraph::build_clip_audio(c, n, a_in, gain_inputs) -> Option<String>` → output label `[a{n}]`
  - `filtergraph::build_args(job: &ExportJob, assets: &[ClipAssets], enc: Encoder, out: &Path) -> Vec<String>`
  - `output_fps`/`parse_fps` are deleted (the project sets the frame rate).

- [ ] **Step 1: Add `ClipAssets` to `export.rs`**

Add below `WrittenAssets` (which Task 9 deletes):

```rust
/// Files written for one clip: layer masks, overlay PNGs (with clip-local start seconds) and gain curves.
#[derive(Debug, Default)]
pub struct ClipAssets {
    pub masks: Vec<(String, PathBuf)>,
    pub overlays: Vec<(PathBuf, f64)>,
    pub gains: Vec<(u32, PathBuf)>,
}
```

- [ ] **Step 2: Write the new filtergraph tests**

Replace the tests module of `src-tauri/src/filtergraph.rs` (remove the `#[cfg(any())]`) with:

```rust
#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::export::ClipAssets;
    use crate::job::fixtures::{clip, job};
    use crate::job::{ClipJob, ClipKind, Trim};

    const WARDOGS_FILTER: &str = "[0:v]fps=60,split=3[n0bg][n0s0][n0s1];\
[n0bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,scale=270:480,gblur=sigma=7.500,scale=1080:1920[n0b];\
[n0s0]crop=845:845:538:118:exact=1,scale=1080:1080[n0l0];\
[n0s1]crop=442:162:1440:22:exact=1,scale=819:300,format=rgba[n0l1p];[1:v]format=gray,scale=819:300[n0m1];[n0l1p][n0m1]alphamerge[n0l1];\
[n0b][n0l0]overlay=x=0:y=420[n0c0];[n0c0][n0l1]overlay=x=132:y=80[n0c1];\
[n0c1][2:v]overlay=x=0:y=0[n0o0];[n0o0][3:v]overlay=x=0:y=0:enable='gte(t,2.000)'[n0o1];\
[n0o1]trim=duration=10.000,format=yuv420p,setsar=1,settb=AVTB[v0];\
[v0]concat=n=1:v=1:a=0[vout]";

    fn wardogs_args() -> Vec<String> {
        let assets = ClipAssets {
            masks: vec![("killfeed".into(), PathBuf::from("/w/c0-mask-1.png"))],
            overlays: vec![(PathBuf::from("/w/c0-overlay-0.png"), 0.0), (PathBuf::from("/w/c0-overlay-1.png"), 2.0), (PathBuf::from("/w/c0-overlay-2.png"), 10.0)],
            gains: vec![],
        };
        build_args(&job(), &[assets], Encoder::Nvenc, Path::new("C:/clips/in_vertical.mp4"))
    }

    fn filter_of(args: &[String]) -> String {
        args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1].clone()
    }

    #[test]
    fn golden_wardogs_args() {
        let mut expected: Vec<&str> = vec!["-hide_banner", "-nostdin", "-y", "-nostats", "-progress", "pipe:1", "-ss", "1.000", "-t", "10.000", "-i", "C:/clips/in.mp4"];
        expected.extend(["-loop", "1", "-framerate", "60", "-t", "10.000", "-i", "/w/c0-mask-1.png"]);
        // overlays are single-frame inputs: overlay's eof_action=repeat holds them, no per-frame PNG decode
        expected.extend(["-i", "/w/c0-overlay-0.png", "-i", "/w/c0-overlay-1.png"]);
        expected.extend(["-filter_complex", WARDOGS_FILTER, "-map", "[vout]"]);
        expected.extend(["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "19", "-b:v", "0"]);
        expected.extend(["-an", "-movflags", "+faststart", "C:/clips/in_vertical.mp4"]);
        assert_eq!(wardogs_args(), expected);
    }

    #[test]
    fn an_overlay_starting_at_or_after_the_clip_end_is_dropped() {
        assert!(!wardogs_args().iter().any(|a| a.contains("overlay-2")));
    }

    fn four_track_clip() -> ClipJob {
        let mut c = clip(); // trim 1..11, dur 10
        c.clip.audio_tracks = ["Desktop", "Game", "Discord", "Mic"]
            .iter()
            .enumerate()
            .map(|(i, l)| crate::job::AudioTrackInfo { index: i as u32, label: (*l).into(), named: true, channels: if i == 3 { 1 } else { 2 } })
            .collect();
        c.audio = serde_json::from_str(r#"{"tracks":[
            {"index":0,"enabled":false,"ceilingDb":null,"offsetS":0},
            {"index":1,"enabled":true,"ceilingDb":-3,"offsetS":0},
            {"index":2,"enabled":true,"ceilingDb":null,"offsetS":0.25},
            {"index":3,"enabled":true,"ceilingDb":null,"offsetS":-0.5}]}"#).unwrap();
        c
    }

    fn gains_for(n: usize, tracks: &[u32]) -> ClipAssets {
        ClipAssets { gains: tracks.iter().map(|t| (*t, PathBuf::from(format!("/w/c{n}-gain-{t}.f32")))).collect(), ..Default::default() }
    }

    #[test]
    fn golden_four_track_audio_filter() {
        // audio input 1; gain inputs 2,3,4 for tracks 1,2,3. in=1 -> audio input starts at 0, lead=1.
        let f = build_clip_audio(&four_track_clip(), 0, 1, &[(1, 2), (2, 3), (3, 4)]).unwrap();
        let fmt = "aformat=sample_rates=48000:channel_layouts=stereo";
        let lim = "attack=1:release=50:level=0:latency=1";
        let expected = [
            format!("[1:a:1]atrim=start=1.000,asetpts=PTS-STARTPTS,{fmt},apad,atrim=duration=10.000[n0t0]"),
            format!("[2:a]aresample=48000,aformat=channel_layouts=stereo[n0g0]"),
            format!("[n0t0][n0g0]amultiply,alimiter=limit=0.708:{lim}[n0c0]"),
            format!("[1:a:2]atrim=start=0.750,asetpts=PTS-STARTPTS,{fmt},apad,atrim=duration=10.000[n0t1]"),
            format!("[3:a]aresample=48000,aformat=channel_layouts=stereo[n0g1]"),
            format!("[n0t1][n0g1]amultiply[n0c1]"),
            format!("[1:a:3]atrim=start=1.500,asetpts=PTS-STARTPTS,{fmt},apad,atrim=duration=10.000[n0t2]"),
            format!("[4:a]aresample=48000,aformat=channel_layouts=stereo[n0g2]"),
            format!("[n0t2][n0g2]amultiply[n0c2]"),
            "[n0c0][n0c1][n0c2]amix=inputs=3:normalize=0:duration=first,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0]".to_string(),
        ]
        .join(";");
        assert_eq!(f, expected);
    }

    #[test]
    fn positive_offset_past_the_lead_pads_with_silence() {
        let mut c = four_track_clip();
        c.trim = Trim { in_s: 0.2, out_s: 5.2 }; // lead = 0.2
        c.audio.tracks.retain(|t| t.index == 2); // offset +0.25 => start -0.05
        let f = build_clip_audio(&c, 0, 1, &[(2, 2)]).unwrap();
        assert!(f.starts_with("[1:a:2]aformat=sample_rates=48000:channel_layouts=stereo,adelay=delays=50:all=1,apad,atrim=duration=5.000[n0t0]"), "{f}");
        assert!(f.ends_with("[n0c0]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0]"), "{f}");
    }

    #[test]
    fn audio_args_open_the_source_again_and_map_one_track() {
        let mut j = job();
        j.clips = vec![four_track_clip()];
        let a = build_args(&j, &[gains_for(0, &[1, 2, 3])], Encoder::X264, Path::new("out.mp4"));
        let s = a.join(" ");
        assert!(s.contains("-ss 0.000 -t 14.000 -i C:/clips/in.mp4"), "{s}");
        assert!(s.contains("-f f32le -ar 200 -ac 1 -i /w/c0-gain-1.f32"));
        assert!(s.contains("-map [aout] -c:a aac -b:a 192k"));
        assert!(!s.contains("-an"));
        let f = filter_of(&a);
        assert!(f.ends_with("[v0][a0]concat=n=1:v=1:a=1[vout][acat];[acat]alimiter=limit=0.891:attack=1:release=50:level=0:latency=1[aout]"), "{f}");
    }

    #[test]
    fn no_enabled_tracks_means_no_audio() {
        let mut j = job();
        let mut c = four_track_clip();
        c.audio.tracks.iter_mut().for_each(|t| t.enabled = false);
        j.clips = vec![c];
        let a = build_args(&j, &[ClipAssets::default()], Encoder::X264, Path::new("out.mp4"));
        assert!(a.contains(&"-an".to_string()));
        assert!(!a.iter().any(|x| x.contains("aout")));
        assert_eq!(a.iter().filter(|x| *x == "-i").count(), 1);
    }

    #[test]
    fn two_clips_with_speed_concat_video_and_audio() {
        let a = four_track_clip();
        let mut b = four_track_clip();
        b.trim = Trim { in_s: 20.0, out_s: 24.0 };
        b.speed = 2.0;
        let mut j = job();
        j.clips = vec![a, b];
        // inputs: clip 0 video 0, audio 1, gain 2; clip 1 video 3, audio 4, gain 5
        let args = build_args(&j, &[gains_for(0, &[1]), gains_for(1, &[1])], Encoder::X264, Path::new("out.mp4"));
        let s = args.join(" ");
        assert!(s.contains("-ss 20.000 -t 4.000 -i C:/clips/in.mp4"), "{s}");
        assert!(s.contains("-ss 18.000 -t 8.000 -i C:/clips/in.mp4"), "{s}");
        let f = filter_of(&args);
        assert!(f.contains("[3:v]setpts=(PTS-STARTPTS)/2,fps=60,split=3[n1bg][n1s0][n1s1]"), "{f}");
        assert!(f.contains("[n1c1]trim=duration=2.000,format=yuv420p,setsar=1,settb=AVTB[v1]"), "{f}");
        assert!(f.contains("[n1c0]asetrate=96000,aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a1]"), "{f}");
        assert!(f.contains("[v0][a0][v1][a1]concat=n=2:v=1:a=1[vout][acat]"), "{f}");
    }

    #[test]
    fn freeze_and_silent_clips_get_generated_silence_when_others_have_audio() {
        let a = four_track_clip();
        let mut frz = four_track_clip();
        frz.kind = ClipKind::Freeze;
        frz.trim = Trim { in_s: 5.0, out_s: 8.0 };
        let mut silent = clip();
        silent.clip.has_audio = false;
        let mut j = job();
        j.clips = vec![a, frz, silent];
        let args = build_args(&j, &[gains_for(0, &[1]), ClipAssets::default(), ClipAssets::default()], Encoder::X264, Path::new("out.mp4"));
        let s = args.join(" ");
        assert!(s.contains("-ss 5.000 -t 1.000 -i C:/clips/in.mp4"), "{s}");
        let f = filter_of(&args);
        assert!(f.contains("[3:v]trim=end_frame=1,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=3.000,fps=60,split=3[n1bg]"), "{f}");
        assert!(f.contains("anullsrc=r=48000:cl=stereo,atrim=duration=3.000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a1]"), "{f}");
        assert!(f.contains("anullsrc=r=48000:cl=stereo,atrim=duration=10.000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a2]"), "{f}");
        assert!(f.contains("[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[vout][acat]"), "{f}");
        assert_eq!(args.iter().filter(|x| *x == "[aout]").count(), 1, "exactly one audio stream is mapped");
    }

    #[test]
    fn clips_of_different_sizes_crop_against_their_own_source() {
        let a = clip();
        let mut b = clip();
        b.clip.width = 2560;
        b.clip.height = 1440;
        b.clip.fps = "120".into();
        let mut j = job();
        j.clips = vec![a, b];
        let f = filter_of(&build_args(&j, &[ClipAssets::default(), ClipAssets::default()], Encoder::X264, Path::new("out.mp4")));
        assert!(f.contains("[n0s0]crop=845:845:538:118:exact=1,scale=1080:1080[n0l0]"), "{f}");
        assert!(f.contains("[n1s0]crop=1126:1126:717:157:exact=1,scale=1080:1080[n1l0]"), "{f}");
        // both leave at the project rate, size and timebase
        assert!(f.contains("[1:v]fps=60,") && f.contains("settb=AVTB[v1]"), "{f}");
    }

    #[test]
    fn source_path_with_spaces_and_quotes_is_one_argument() {
        let mut j = job();
        j.clips[0].source = r"C:\Users\José\Videos\Bob's clip (1).mp4".into();
        let args = build_args(&j, &[ClipAssets::default()], Encoder::X264, Path::new("out.mp4"));
        assert!(args.contains(&j.clips[0].source));
        assert!(!filter_of(&args).contains("José"));
    }

    #[test]
    fn hidden_layer_is_omitted_from_split_and_overlay_chain() {
        let mut c = clip();
        c.preset.layers[1].hidden = true; // killfeed
        let f = build_clip_video(&c, 0, 0, &HashMap::new(), &[], "60", &Canvas { w: 1080, h: 1920 });
        let expected = "[0:v]fps=60,split=2[n0bg][n0s0];\
[n0bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,scale=270:480,gblur=sigma=7.500,scale=1080:1920[n0b];\
[n0s0]crop=845:845:538:118:exact=1,scale=1080:1080[n0l0];\
[n0b][n0l0]overlay=x=0:y=420[n0c0];\
[n0c0]trim=duration=10.000,format=yuv420p,setsar=1,settb=AVTB[v0]";
        assert_eq!(f, expected);
    }

    #[test]
    fn color_and_none_backgrounds() {
        let canvas = Canvas { w: 1080, h: 1920 };
        let mut c = clip();
        c.preset.background = Background::Color { color: "#112233".into() };
        assert!(build_clip_video(&c, 0, 0, &HashMap::new(), &[], "60", &canvas).contains("[n0bg]scale=1080:1920,drawbox=x=0:y=0:w=iw:h=ih:color=#112233:t=fill[n0b]"));
        c.preset.background = Background::None;
        assert!(build_clip_video(&c, 0, 0, &HashMap::new(), &[], "60", &canvas).contains("color=black:t=fill[n0b]"));
    }
}
```

- [ ] **Step 3: Run to see it fail**

Run: `cd src-tauri && cargo test filtergraph`
Expected: compile errors (`build_clip_video`, `build_clip_audio` not found, `build_args` takes different arguments).

- [ ] **Step 4: Rewrite the body of `src-tauri/src/filtergraph.rs`**

Replace everything above the tests module with:

```rust
use std::collections::HashMap;
use std::path::Path;

use crate::audio_mix::{enabled_tracks, GAIN_RATE};
use crate::encoders::Encoder;
use crate::export::ClipAssets;
use crate::job::{Canvas, ClipJob, ClipKind, ExportJob};
use crate::preset::{layout_layer, Background, Layer, LayerLayout};

pub fn secs(v: f64) -> String {
    format!("{v:.3}")
}

/// Seconds of source audio opened before the in point so negative offsets have audio to use.
const AUDIO_LEAD: f64 = 2.0;
const LIMITER: &str = "attack=1:release=50:level=0:latency=1";
/// Every clip's audio leaves in this format so concat joins them without renegotiating.
const AFMT: &str = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";

fn is_one(speed: f64) -> bool {
    (speed - 1.0).abs() < 1e-9
}

/// Source seconds read for the clip's video: the trim, or a moment's worth for a freeze frame.
fn video_span(c: &ClipJob) -> f64 {
    match c.kind {
        ClipKind::Video => c.trim.out_s - c.trim.in_s,
        ClipKind::Freeze => 1.0,
    }
}

fn audio_seek(c: &ClipJob) -> f64 {
    (c.trim.in_s - AUDIO_LEAD).max(0.0)
}

/// One clip's picture on the canvas, labelled [v{n}]: speed and frame rate first (so 144/240 fps
/// sources aren't composed at full rate), then background, layers and overlays, then normalised
/// (length, pixel format, SAR, timebase) so concat can join clips from different sources.
pub fn build_clip_video(c: &ClipJob, n: usize, v_in: usize, masks: &HashMap<&str, usize>, overlays: &[(usize, f64)], fps: &str, canvas: &Canvas) -> String {
    let p = &c.preset;
    let (sw, sh) = (c.clip.width as i64, c.clip.height as i64);
    let (w, h) = (canvas.w, canvas.h);
    let dur = secs(c.duration());
    let visible: Vec<&Layer> = p.layers.iter().filter(|l| !l.hidden).collect();
    let layouts: Vec<LayerLayout> = visible.iter().map(|l| layout_layer(l.src, l.dst, l.fit, sw, sh)).collect();
    let mut parts: Vec<String> = Vec::new();

    let head = match c.kind {
        ClipKind::Video if is_one(c.speed) => format!("[{v_in}:v]fps={fps}"),
        ClipKind::Video => format!("[{v_in}:v]setpts=(PTS-STARTPTS)/{},fps={fps}", c.speed),
        ClipKind::Freeze => format!("[{v_in}:v]trim=end_frame=1,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration={dur},fps={fps}"),
    };
    let mut split = format!("{head},split={}[n{n}bg]", visible.len() + 1);
    for i in 0..visible.len() {
        split.push_str(&format!("[n{n}s{i}]"));
    }
    parts.push(split);

    parts.push(match &p.background {
        Background::Blur { amount } => format!(
            "[n{n}bg]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},scale={}:{},gblur=sigma={},scale={w}:{h}[n{n}b]",
            w / 4,
            h / 4,
            secs(amount / 4.0)
        ),
        Background::Color { color } => format!("[n{n}bg]scale={w}:{h},drawbox=x=0:y=0:w=iw:h=ih:color={color}:t=fill[n{n}b]"),
        Background::None => format!("[n{n}bg]scale={w}:{h},drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill[n{n}b]"),
    });

    for (i, (l, lay)) in visible.iter().zip(&layouts).enumerate() {
        let [cx, cy, cw, ch] = lay.crop;
        let [_, _, dw, dh] = lay.draw;
        let base = format!("[n{n}s{i}]crop={cw}:{ch}:{cx}:{cy}:exact=1,scale={dw}:{dh}");
        match masks.get(l.id.as_str()) {
            Some(m) => {
                parts.push(format!("{base},format=rgba[n{n}l{i}p]"));
                parts.push(format!("[{m}:v]format=gray,scale={dw}:{dh}[n{n}m{i}]"));
                parts.push(format!("[n{n}l{i}p][n{n}m{i}]alphamerge[n{n}l{i}]"));
            }
            None => parts.push(format!("{base}[n{n}l{i}]")),
        }
    }

    let mut last = format!("n{n}b");
    for (i, lay) in layouts.iter().enumerate() {
        parts.push(format!("[{last}][n{n}l{i}]overlay=x={}:y={}[n{n}c{i}]", lay.draw[0], lay.draw[1]));
        last = format!("n{n}c{i}");
    }
    for (k, (input, rel)) in overlays.iter().enumerate() {
        let enable = if *rel > 0.0005 { format!(":enable='gte(t,{})'", secs(*rel)) } else { String::new() };
        parts.push(format!("[{last}][{input}:v]overlay=x=0:y=0{enable}[n{n}o{k}]"));
        last = format!("n{n}o{k}");
    }
    parts.push(format!("[{last}]trim=duration={dur},format=yuv420p,setsar=1,settb=AVTB[v{n}]"));
    parts.join(";")
}

/// One clip's tracks mixed to stereo, labelled [a{n}]: per-track offset/trim, × gain curve, optional
/// ceiling, amix, then resampled for speed (pitch follows speed, as in the preview). No master
/// limiter here; that runs once after concat.
pub fn build_clip_audio(c: &ClipJob, n: usize, a_in: usize, gain_inputs: &[(u32, usize)]) -> Option<String> {
    let dur = c.trim.out_s - c.trim.in_s;
    let lead = c.trim.in_s - audio_seek(c);
    let fmt = "aformat=sample_rates=48000:channel_layouts=stereo";
    let mut parts = Vec::new();
    let mut outs = Vec::new();
    for (k, t) in enabled_tracks(c).into_iter().enumerate() {
        let Some(&(_, g)) = gain_inputs.iter().find(|(i, _)| *i == t.index) else { continue };
        let start = lead - t.offset_s;
        parts.push(if start >= 0.0 {
            format!("[{a_in}:a:{}]atrim=start={},asetpts=PTS-STARTPTS,{fmt},apad,atrim=duration={}[n{n}t{k}]", t.index, secs(start), secs(dur))
        } else {
            format!("[{a_in}:a:{}]{fmt},adelay=delays={}:all=1,apad,atrim=duration={}[n{n}t{k}]", t.index, (-start * 1000.0).round() as i64, secs(dur))
        });
        parts.push(format!("[{g}:a]aresample=48000,aformat=channel_layouts=stereo[n{n}g{k}]"));
        let ceiling = t.ceiling_db.map(|db| format!(",alimiter=limit={:.3}:{LIMITER}", 10f64.powf(db / 20.0))).unwrap_or_default();
        parts.push(format!("[n{n}t{k}][n{n}g{k}]amultiply{ceiling}[n{n}c{k}]"));
        outs.push(format!("[n{n}c{k}]"));
    }
    if outs.is_empty() {
        return None;
    }
    let speed = if is_one(c.speed) { String::new() } else { format!("asetrate={},aresample=48000,", (48000.0 * c.speed).round() as i64) };
    let tail = format!("{speed}{AFMT}[a{n}]");
    parts.push(if outs.len() == 1 {
        format!("{}{tail}", outs[0])
    } else {
        format!("{}amix=inputs={}:normalize=0:duration=first,{tail}", outs.join(""), outs.len())
    });
    Some(parts.join(";"))
}

pub fn build_args(job: &ExportJob, assets: &[ClipAssets], enc: Encoder, out: &Path) -> Vec<String> {
    let fps = job.fps.to_string();
    let mut args: Vec<String> = ["-hide_banner", "-nostdin", "-y", "-nostats", "-progress", "pipe:1"].map(String::from).to_vec();
    let mut next = 0usize;
    let mut graph: Vec<String> = Vec::new();
    let mut audio: Vec<Option<String>> = Vec::new();

    for (n, (c, a)) in job.clips.iter().zip(assets).enumerate() {
        let dur = c.duration();
        let v_in = next;
        next += 1;
        args.extend(["-ss".into(), secs(c.trim.in_s), "-t".into(), secs(video_span(c)), "-i".into(), c.source.clone()]);

        let mut mask_inputs: HashMap<&str, usize> = HashMap::new();
        for (id, p) in &a.masks {
            args.extend(["-loop".into(), "1".into(), "-framerate".into(), fps.clone(), "-t".into(), secs(dur), "-i".into(), p.to_string_lossy().into_owned()]);
            mask_inputs.insert(id.as_str(), next);
            next += 1;
        }
        let mut overlay_inputs = Vec::new();
        for (p, start) in &a.overlays {
            if *start >= dur {
                continue;
            }
            // Single frame: overlay's default eof_action=repeat holds it, so the PNG is decoded once, not per frame.
            args.extend(["-i".into(), p.to_string_lossy().into_owned()]);
            overlay_inputs.push((next, *start));
            next += 1;
        }

        let mut clip_audio = None;
        if !a.gains.is_empty() {
            let a_in = next;
            next += 1;
            args.extend(["-ss".into(), secs(audio_seek(c)), "-t".into(), secs(c.trim.out_s - c.trim.in_s + 2.0 * AUDIO_LEAD), "-i".into(), c.source.clone()]);
            let mut gain_inputs = Vec::new();
            for (idx, p) in &a.gains {
                args.extend(["-f", "f32le", "-ar", &format!("{GAIN_RATE}"), "-ac", "1", "-i"].map(String::from));
                args.push(p.to_string_lossy().into_owned());
                gain_inputs.push((*idx, next));
                next += 1;
            }
            clip_audio = build_clip_audio(c, n, a_in, &gain_inputs);
        }
        graph.push(build_clip_video(c, n, v_in, &mask_inputs, &overlay_inputs, &fps, &job.canvas));
        audio.push(clip_audio);
    }

    let has_audio = audio.iter().any(Option::is_some);
    let mut cat = String::new();
    for (n, a) in audio.into_iter().enumerate() {
        cat.push_str(&format!("[v{n}]"));
        if has_audio {
            graph.push(a.unwrap_or_else(|| format!("anullsrc=r=48000:cl=stereo,atrim=duration={},{AFMT}[a{n}]", secs(job.clips[n].duration()))));
            cat.push_str(&format!("[a{n}]"));
        }
    }
    let count = job.clips.len();
    if has_audio {
        graph.push(format!("{cat}concat=n={count}:v=1:a=1[vout][acat]"));
        graph.push(format!("[acat]alimiter=limit=0.891:{LIMITER}[aout]"));
    } else {
        graph.push(format!("{cat}concat=n={count}:v=1:a=0[vout]"));
    }

    args.push("-filter_complex".into());
    args.push(graph.join(";"));
    args.extend(["-map".into(), "[vout]".into()]);
    if has_audio {
        args.extend(["-map", "[aout]", "-c:a", "aac", "-b:a", "192k"].map(String::from));
    }
    args.extend(enc.args(job.quality));
    if !has_audio {
        args.push("-an".into());
    }
    args.extend(["-movflags", "+faststart"].map(String::from));
    args.push(out.to_string_lossy().into_owned());
    args
}
```

- [ ] **Step 5: Run the tests**

Run: `cd src-tauri && cargo test filtergraph`
Expected: PASS. (`export.rs` still calls the old `build_args` from `run_once`; if the compiler complains there, change that one call to `build_args(&crate::job::ExportJob { clips: vec![job.clone()], quality: crate::job::Quality::High, fps: 60, canvas: crate::job::Canvas { w: 1080, h: 1920 }, output_path: String::new() }, &[], enc, out)` — `run_once` is replaced in Task 9 and is unreachable until then.)

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/filtergraph.rs src-tauri/src/export.rs
git commit -m "feat(export): per-clip filter graphs with speed and freeze, joined by concat"
```

---

### Task 9: Rust export runner, output path, keep lists and thumbnails

**Files:**
- Modify: `src-tauri/src/export.rs` (rewrite `write_assets`, `run_once`, `run_export`, tests)
- Modify: `src-tauri/src/output_path.rs` (`mp4_path` replaces `unique_output_path`)
- Modify: `src-tauri/src/commands.rs` (`keep` on `make_proxy`/`prepare_audio`, new `thumbnail`)
- Create: `src-tauri/src/thumbs.rs`
- Modify: `src-tauri/src/cache.rs` (thumbnails are cache entries)
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `ExportJob`, `validate_job`, `ClipAssets`, `build_args`.
- Produces:
  - `export::write_assets(job: &ExportJob, dir: &Path) -> Result<Vec<ClipAssets>, ExportError>` — files `c{n}-mask-{i}.png`, `c{n}-overlay-{i}.png`, `c{n}-gain-{index}.f32`
  - `export::run_export(job, encoders, work_root, state, on_progress)` — same signature; progress is measured against the whole timeline; error code `invalid_project` for a bad timeline.
  - `output_path::mp4_path(p: &str) -> PathBuf`
  - Tauri commands: `make_proxy(path, duration, keep: Vec<String>, on_progress)`, `prepare_audio(path, keep: Vec<String>)`, `thumbnail(path, at_s) -> String` (a cached JPEG path, allowed in the asset scope).
  - `thumbs::thumb_path(cache, source, at_s)`, `thumbs::thumb_args(source, at_s, out)`, `thumbs::make_thumbnail(cache, source, at_s) -> Result<PathBuf, String>`

- [ ] **Step 1: Write the failing `output_path` test**

Replace the tests module of `src-tauri/src/output_path.rs` with:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mp4_path_adds_the_extension_only_when_missing() {
        assert_eq!(mp4_path("C:/v/clip"), PathBuf::from("C:/v/clip.mp4"));
        assert_eq!(mp4_path("C:/v/clip.MP4"), PathBuf::from("C:/v/clip.MP4"));
        assert_eq!(mp4_path("C:/v/clip.mov"), PathBuf::from("C:/v/clip.mov.mp4"));
        assert_eq!(mp4_path("C:/v/Bob's é.mp4"), PathBuf::from("C:/v/Bob's é.mp4"));
    }

    #[test]
    fn writable_checks() {
        let dir = tempfile::tempdir().unwrap();
        assert!(is_dir_writable(dir.path()));
        assert!(!is_dir_writable(&dir.path().join("missing")));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0, "probe file cleaned up");
    }
}
```

Replace `unique_output_path` with:

```rust
/// The path chosen in the Save dialog, with `.mp4` added when it has another or no extension.
pub fn mp4_path(p: &str) -> PathBuf {
    let path = PathBuf::from(p);
    if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("mp4")) {
        return path;
    }
    let mut s = path.into_os_string();
    s.push(".mp4");
    PathBuf::from(s)
}
```

and change the first line to `use std::path::{Path, PathBuf};` (unchanged if already there).

- [ ] **Step 2: Write the failing export tests**

Replace the tests module of `src-tauri/src/export.rs` (remove the `#[cfg(any())]`) with:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::job::fixtures::{clip, job};
    use crate::job::{ClipJob, ClipKind, Overlay, Trim};

    const PNG_1X1: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    fn some_encoder() -> EncoderSet {
        EncoderSet { gpu: None, cpu: Some(Encoder::X264) }
    }

    fn writable_job(dir: &Path) -> ExportJob {
        let mut j = job();
        j.output_path = dir.join("out.mp4").to_string_lossy().into_owned();
        j
    }

    #[test]
    fn write_assets_names_files_per_clip_and_keeps_overlay_starts() {
        let dir = tempfile::tempdir().unwrap();
        let mut j = job();
        j.clips[0].layer_masks.insert("killfeed".into(), PNG_1X1.into());
        j.clips[0].overlays = vec![Overlay { png_base64: PNG_1X1.into(), start: 0.0 }, Overlay { png_base64: PNG_1X1.into(), start: 4.0 }];
        j.clips.push(clip());
        j.clips[1].overlays = vec![Overlay { png_base64: PNG_1X1.into(), start: 1.0 }];
        let a = write_assets(&j, dir.path()).unwrap();
        assert_eq!(a.len(), 2);
        assert_eq!(a[0].masks[0].0, "killfeed");
        assert!(a[0].masks[0].1.ends_with("c0-mask-1.png"));
        assert_eq!(a[0].overlays.iter().map(|o| o.1).collect::<Vec<_>>(), [0.0, 4.0]);
        assert!(a[1].overlays[0].0.ends_with("c1-overlay-0.png"));
        assert!(std::fs::read(&a[0].overlays[1].0).unwrap().starts_with(b"\x89PNG"));
    }

    #[test]
    fn write_assets_writes_gain_curves_for_enabled_tracks_only() {
        let dir = tempfile::tempdir().unwrap();
        let mut j = job();
        j.clips[0].clip.audio_tracks = vec![crate::job::AudioTrackInfo { index: 0, label: "G".into(), named: true, channels: 2 }];
        j.clips[0].audio = serde_json::from_str(r#"{"tracks":[{"index":0,"enabled":true,"ceilingDb":null,"offsetS":0}]}"#).unwrap();
        j.clips[0].gain_curves.insert(0, "AACAPw==".into()); // one f32 = 1.0
        let mut frz = j.clips[0].clone();
        frz.kind = ClipKind::Freeze;
        j.clips.push(frz);
        let a = write_assets(&j, dir.path()).unwrap();
        assert_eq!(std::fs::read(&a[0].gains[0].1).unwrap(), 1.0f32.to_le_bytes());
        assert!(a[0].gains[0].1.ends_with("c0-gain-0.f32"));
        assert!(a[1].gains.is_empty(), "freeze frames are silent");
    }

    #[test]
    fn bad_base64_is_an_io_error() {
        let dir = tempfile::tempdir().unwrap();
        let mut j = job();
        j.clips[0].layer_masks.insert("killfeed".into(), "%%%".into());
        assert_eq!(write_assets(&j, dir.path()).err().unwrap().code, "io");
    }

    #[test]
    fn an_empty_timeline_is_an_invalid_project() {
        let dir = tempfile::tempdir().unwrap();
        let mut j = writable_job(dir.path());
        j.clips.clear();
        let e = run_export(j, &some_encoder(), dir.path(), &ExportState::default(), &|_| {}).unwrap_err();
        assert_eq!(e.code, "invalid_project");
    }

    #[test]
    fn invalid_audio_names_the_clip() {
        let dir = tempfile::tempdir().unwrap();
        let mut j = writable_job(dir.path());
        j.clips.push(clip());
        j.clips[1].clip.audio_tracks = vec![crate::job::AudioTrackInfo { index: 0, label: "G".into(), named: true, channels: 2 }];
        j.clips[1].audio = serde_json::from_str(r#"{"tracks":[{"index":0,"enabled":true,"ceilingDb":null,"offsetS":0}]}"#).unwrap();
        let e = run_export(j, &some_encoder(), dir.path(), &ExportState::default(), &|_| {}).unwrap_err();
        assert_eq!(e.code, "invalid_audio");
        assert!(e.details.starts_with("clip 2:"), "{}", e.details);
    }

    #[test]
    fn invalid_preset_is_rejected_before_ffmpeg() {
        let dir = tempfile::tempdir().unwrap();
        let mut j = writable_job(dir.path());
        j.clips[0].preset.layers.clear();
        let e = run_export(j, &some_encoder(), dir.path(), &ExportState::default(), &|_| {}).unwrap_err();
        assert_eq!(e.code, "invalid_preset");
    }

    #[test]
    fn missing_output_folder_is_not_writable() {
        let dir = tempfile::tempdir().unwrap();
        let mut j = job();
        j.output_path = dir.path().join("nope").join("out.mp4").to_string_lossy().into_owned();
        let e = run_export(j, &some_encoder(), dir.path(), &ExportState::default(), &|_| {}).unwrap_err();
        assert_eq!(e.code, "not_writable");
    }

    #[test]
    fn no_encoder_is_a_clear_error() {
        let dir = tempfile::tempdir().unwrap();
        let e = run_export(writable_job(dir.path()), &EncoderSet::default(), dir.path(), &ExportState::default(), &|_| {}).unwrap_err();
        assert!(e.message.contains("No H.264 encoder"));
    }

    #[test]
    fn second_export_while_one_runs_is_rejected_as_busy() {
        let dir = tempfile::tempdir().unwrap();
        let state = ExportState::default();
        state.running.store(true, Ordering::SeqCst);
        let e = run_export(writable_job(dir.path()), &some_encoder(), dir.path(), &state, &|_| {}).unwrap_err();
        assert_eq!(e.code, "busy");
        assert!(state.running.load(Ordering::SeqCst), "the running export keeps its flag");
    }

    #[test]
    fn running_flag_is_released_after_an_export_ends() {
        let dir = tempfile::tempdir().unwrap();
        let state = ExportState::default();
        let mut j = writable_job(dir.path());
        j.clips[0].preset.layers.clear();
        let _ = run_export(j, &some_encoder(), dir.path(), &state, &|_| {});
        assert!(!state.running.load(Ordering::SeqCst));
    }

    fn make_source(dir: &Path, name: &str, lavfi: &str, audio: bool) -> String {
        let src = dir.join(name);
        let mut c = tool_command("ffmpeg");
        c.args(["-hide_banner", "-y", "-f", "lavfi", "-i", lavfi]);
        if audio {
            c.args(["-f", "lavfi", "-i", "sine=d=6", "-c:a", "aac"]);
        }
        assert!(c.args(["-c:v", "mpeg4"]).arg(&src).status().unwrap().success());
        src.to_string_lossy().into_owned()
    }

    fn ones(t: &Trim) -> String {
        let n = crate::audio_mix::curve_samples(t);
        base64::engine::general_purpose::STANDARD.encode(vec![1.0f32; n].iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>())
    }

    /// Needs a real ffmpeg on PATH (Homebrew on the Mac) or SOCIALFRAG_FFMPEG_DIR. Run: cargo test -- --ignored
    /// Four clips: 1080p60 with audio, a freeze frame, 1440p120 without audio at 2x, the first source again at 0.5x.
    #[test]
    #[ignore]
    fn real_timeline_export() {
        let dir = tempfile::tempdir().unwrap();
        let a = make_source(dir.path(), "a clip é.mp4", "testsrc2=s=1920x1080:r=60:d=6", true);
        let b = make_source(dir.path(), "b.mp4", "testsrc2=s=2560x1440:r=120:d=4", false);
        let probe = |p: &str| crate::probe::probe_clip_file(p).unwrap();
        let with_audio = |mut c: ClipJob| {
            c.audio = serde_json::from_str(r#"{"tracks":[{"index":0,"enabled":true,"ceilingDb":null,"offsetS":0}]}"#).unwrap();
            c.gain_curves.insert(0, ones(&c.trim));
            c
        };
        let base = |src: &str, in_s: f64, out_s: f64, speed: f64, kind: ClipKind| ClipJob { kind, source: src.into(), clip: probe(src), trim: Trim { in_s, out_s }, speed, ..clip() };
        let mut j = job();
        j.output_path = dir.path().join("timeline").to_string_lossy().into_owned();
        j.clips = vec![
            with_audio(base(&a, 0.5, 2.5, 1.0, ClipKind::Video)), // 2 s
            base(&a, 1.0, 2.0, 1.0, ClipKind::Freeze),            // 1 s
            base(&b, 0.0, 2.0, 2.0, ClipKind::Video),             // 1 s
            with_audio(base(&a, 1.0, 3.0, 0.5, ClipKind::Video)), // 4 s
        ];
        j.clips[0].overlays = vec![Overlay { png_base64: PNG_1X1.into(), start: 1.0 }];
        let encoders = crate::encoders::detect(&crate::ffmpeg::RealRunner);
        let last = std::sync::Mutex::new(0.0);
        let r = run_export(j, &encoders, dir.path(), &ExportState::default(), &|p| *last.lock().unwrap() = p.fraction).unwrap_or_else(|e| panic!("{} {}", e.message, e.details));
        assert!(r.output_path.ends_with("timeline.mp4"));
        assert_eq!(*last.lock().unwrap(), 1.0);
        let info = crate::probe::probe_clip_file(&r.output_path).unwrap();
        assert_eq!((info.width, info.height, info.fps.as_str()), (1080, 1920, "60/1"));
        assert!((info.duration - 8.0).abs() < 0.2, "duration {}", info.duration);
        assert_eq!(info.audio_tracks.len(), 1, "exactly one mixed audio track");
    }

    /// Exports a 15 s slice of every .mp4 in SOCIALFRAG_CLIPS_DIR with the built-in WARDOGS preset.
    /// Run single-threaded: both tests export the same clip into the same folder.
    /// Run: SOCIALFRAG_CLIPS_DIR="../example clips" SOCIALFRAG_OUT_DIR=/tmp/out cargo test real_clip -- --ignored --nocapture --test-threads=1
    #[test]
    #[ignore]
    fn real_clips_export_with_wardogs() {
        let clips = std::env::var("SOCIALFRAG_CLIPS_DIR").expect("set SOCIALFRAG_CLIPS_DIR");
        let out_dir = std::env::var("SOCIALFRAG_OUT_DIR").expect("set SOCIALFRAG_OUT_DIR");
        let preset: crate::preset::Preset = serde_json::from_str(include_str!("../../src/presets/builtin/wardogs.json")).unwrap();
        let encoders = crate::encoders::detect(&crate::ffmpeg::RealRunner);
        let work = tempfile::tempdir().unwrap();
        let mut files: Vec<_> = std::fs::read_dir(&clips).unwrap().filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|x| x == "mp4")).collect();
        files.sort();
        assert!(!files.is_empty(), "no .mp4 in {clips}");
        for src in files {
            let source = src.to_string_lossy().into_owned();
            let info = crate::probe::probe_clip_file(&source).unwrap();
            let trim = Trim { in_s: 30.0, out_s: 45.0 };
            let tracks: Vec<crate::audio_mix::TrackMix> = info
                .audio_tracks
                .iter()
                .map(|a| crate::audio_mix::TrackMix { index: a.index, enabled: !a.label.to_lowercase().contains("desktop"), ceiling_db: Some(-3.0), offset_s: 0.0 })
                .collect();
            let gain_curves = tracks.iter().filter(|t| t.enabled).map(|t| (t.index, ones(&trim))).collect();
            let c = ClipJob { source: source.clone(), clip: info, preset: preset.clone(), trim, audio: crate::audio_mix::AudioMix { tracks }, gain_curves, ..clip() };
            let stem = src.file_stem().unwrap().to_string_lossy().into_owned();
            let j = ExportJob { clips: vec![c], output_path: format!("{out_dir}/{stem}_vertical.mp4"), ..job() };
            let t = Instant::now();
            let r = run_export(j, &encoders, work.path(), &ExportState::default(), &|_| {}).unwrap_or_else(|e| panic!("{source}: {} {}", e.message, e.details));
            let out = crate::probe::probe_clip_file(&r.output_path).unwrap();
            println!("{} -> {}x{} {} {:.2}s in {:.1}s", src.file_name().unwrap().to_string_lossy(), out.width, out.height, out.fps, out.duration, t.elapsed().as_secs_f64());
            assert_eq!((out.width, out.height), (1080, 1920));
            assert!((out.duration - 15.0).abs() < 0.2);
            assert!(out.has_audio);
            assert_eq!(out.audio_tracks.len(), 1, "exactly one mixed audio track");
        }
    }

    /// Mutes 5–8 s of the output on the first clip's "Game" track. Same env vars as above.
    /// Run: SOCIALFRAG_CLIPS_DIR="../example clips" SOCIALFRAG_OUT_DIR=/tmp/out cargo test real_clip -- --ignored --nocapture --test-threads=1
    #[test]
    #[ignore]
    fn real_clip_mute_range_is_silent() {
        let clips = std::env::var("SOCIALFRAG_CLIPS_DIR").expect("set SOCIALFRAG_CLIPS_DIR");
        let out_dir = std::env::var("SOCIALFRAG_OUT_DIR").expect("set SOCIALFRAG_OUT_DIR");
        let mut files: Vec<_> = std::fs::read_dir(&clips).unwrap().filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|x| x == "mp4")).collect();
        files.sort();
        let source = files[0].to_string_lossy().into_owned();
        let info = crate::probe::probe_clip_file(&source).unwrap();
        let game = info.audio_tracks.iter().find(|a| a.label == "Game").expect("clip has a Game track").index;
        let trim = Trim { in_s: 30.0, out_s: 45.0 };
        let curve: Vec<f32> = (0..crate::audio_mix::curve_samples(&trim)).map(|i| if (1000..1600).contains(&i) { 0.0 } else { 1.0 }).collect();
        let b64 = base64::engine::general_purpose::STANDARD.encode(curve.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>());
        let mut c = clip();
        c.source = source;
        c.clip = info;
        c.preset = serde_json::from_str(include_str!("../../src/presets/builtin/wardogs.json")).unwrap();
        c.trim = trim;
        c.audio = crate::audio_mix::AudioMix { tracks: vec![crate::audio_mix::TrackMix { index: game, enabled: true, ceiling_db: None, offset_s: 0.0 }] };
        c.gain_curves.insert(game, b64);
        let j = ExportJob { clips: vec![c], output_path: format!("{out_dir}/mute_check.mp4"), ..job() };
        let work = tempfile::tempdir().unwrap();
        let r = run_export(j, &crate::encoders::detect(&crate::ffmpeg::RealRunner), work.path(), &ExportState::default(), &|_| {}).unwrap();
        let max_db = |ss: &str, t: &str| -> f64 {
            let o = tool_command("ffmpeg").args(["-hide_banner", "-nostats", "-ss", ss, "-t", t, "-i", &r.output_path, "-vn", "-af", "volumedetect", "-f", "null", "-"]).output().unwrap();
            let e = String::from_utf8_lossy(&o.stderr);
            let line = e.lines().find(|l| l.contains("max_volume")).expect("volumedetect output");
            line.split("max_volume:").nth(1).unwrap().trim().trim_end_matches(" dB").parse().unwrap()
        };
        assert!(max_db("5.2", "2.6") < -60.0, "muted window should be silent");
        assert!(max_db("0", "4.5") > -50.0, "unmuted window should have audio");
    }
}
```

- [ ] **Step 3: Run to see it fail**

Run: `cd src-tauri && cargo test export::`
Expected: compile errors (`write_assets` returns the wrong type, `run_export` is the Task 7 stub, `mp4_path` unknown in export).

- [ ] **Step 4: Rewrite the export runner**

In `src-tauri/src/export.rs`:

- Imports: replace the `crate::…` imports with:

```rust
use crate::encoders::{Encoder, EncoderSet};
use crate::ffmpeg::tool_command;
use crate::filtergraph::build_args;
use crate::job::{validate_job, ExportError, ExportJob, ExportProgress, ExportResult};
use crate::output_path::{is_dir_writable, mp4_path};
use crate::preset::validate;
use crate::progress::{eta, parse_progress_line};
```

- Delete `WrittenAssets`. Replace `write_assets`, `run_once` and `run_export` with:

```rust
pub fn write_assets(job: &ExportJob, dir: &Path) -> Result<Vec<ClipAssets>, ExportError> {
    std::fs::create_dir_all(dir).map_err(io_err)?;
    let b64 = base64::engine::general_purpose::STANDARD;
    let write = |name: String, data: &str| -> Result<PathBuf, ExportError> {
        let p = dir.join(name);
        std::fs::write(&p, b64.decode(data).map_err(io_err)?).map_err(io_err)?;
        Ok(p)
    };
    let mut out = Vec::new();
    for (n, c) in job.clips.iter().enumerate() {
        let mut a = ClipAssets::default();
        for (i, layer) in c.preset.layers.iter().enumerate() {
            if layer.hidden {
                continue;
            }
            if let Some(data) = c.layer_masks.get(&layer.id) {
                a.masks.push((layer.id.clone(), write(format!("c{n}-mask-{i}.png"), data)?));
            }
        }
        for (i, o) in c.overlays.iter().enumerate() {
            a.overlays.push((write(format!("c{n}-overlay-{i}.png"), &o.png_base64)?, o.start));
        }
        for t in crate::audio_mix::enabled_tracks(c) {
            if let Some(data) = c.gain_curves.get(&t.index) {
                a.gains.push((t.index, write(format!("c{n}-gain-{}.f32", t.index), data)?));
            }
        }
        out.push(a);
    }
    Ok(out)
}

fn run_once(job: &ExportJob, assets: &[ClipAssets], enc: Encoder, out: &Path, state: &ExportState, on_progress: &dyn Fn(ExportProgress)) -> Result<(), ExportError> {
    let args = build_args(job, assets, enc, out);
```

Keep the rest of the old `run_once` body as it was, except the progress total:

```rust
    let total_us = job.duration() * 1_000_000.0;
```

Then `run_export`:

```rust
pub fn run_export(job: ExportJob, encoders: &EncoderSet, work_root: &Path, state: &ExportState, on_progress: &dyn Fn(ExportProgress)) -> Result<ExportResult, ExportError> {
    if state.running.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return Err(ExportError::new("busy", "An export is already running.", ""));
    }
    let _running = RunningGuard(&state.running);
    validate_job(&job).map_err(|e| ExportError::new("invalid_project", "This timeline can't be exported.", &e))?;
    for (n, c) in job.clips.iter().enumerate() {
        validate(&c.preset).map_err(|e| ExportError::new("invalid_preset", "This preset can't be exported.", &format!("clip {}: {e}", n + 1)))?;
        crate::audio_mix::validate_mix(c).map_err(|e| ExportError::new("invalid_audio", "The audio mix can't be exported.", &format!("clip {}: {e}", n + 1)))?;
    }
    let out = mp4_path(&job.output_path);
    let out_dir = out.parent().map(Path::to_path_buf).unwrap_or_default();
    if !is_dir_writable(&out_dir) {
        return Err(ExportError::new("not_writable", "Can't save to this folder. Pick another one.", &out_dir.to_string_lossy()));
    }
    let primary = encoders.primary().ok_or_else(|| ExportError::new("ffmpeg", "No H.264 encoder found in the bundled ffmpeg.", ""))?;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let work = work_root.join(format!("export-{stamp}"));
    let assets = write_assets(&job, &work)?;

    state.cancelled.store(false, Ordering::SeqCst);
    let result = match run_once(&job, &assets, primary, &out, state, on_progress) {
        Ok(()) => Ok(false),
        Err(e) if e.code == "ffmpeg" => match encoders.fallback_for(primary) {
            Some(cpu) => {
                let _ = std::fs::remove_file(&out);
                run_once(&job, &assets, cpu, &out, state, on_progress).map(|_| true)
            }
            None => Err(e),
        },
        Err(e) => Err(e),
    };
    let _ = std::fs::remove_dir_all(&work);
    match result {
        Ok(used_cpu_fallback) => Ok(ExportResult { output_path: out.to_string_lossy().into_owned(), used_cpu_fallback }),
        Err(e) => {
            let _ = std::fs::remove_file(&out);
            Err(e)
        }
    }
}
```

- [ ] **Step 5: Thumbnails**

Create `src-tauri/src/thumbs.rs`:

```rust
//! Small JPEG frames for the timeline, cached under `thumbs/<source_key>/<ms>.jpg`.
use std::path::{Path, PathBuf};
use std::process::Stdio;

use crate::ffmpeg::tool_command;
use crate::filtergraph::secs;
use crate::proxy::source_key;

pub const THUMB_HEIGHT: u32 = 96;

pub fn thumb_path(cache: &Path, source: &Path, at_s: f64) -> PathBuf {
    cache.join("thumbs").join(source_key(source)).join(format!("{}.jpg", (at_s * 1000.0).round() as i64))
}

pub fn thumb_args(source: &Path, at_s: f64, out: &Path) -> Vec<String> {
    let mut a: Vec<String> = ["-hide_banner", "-nostdin", "-y", "-ss"].map(String::from).to_vec();
    a.push(secs(at_s));
    a.push("-i".into());
    a.push(source.to_string_lossy().into_owned());
    a.extend(["-frames:v", "1", "-vf", &format!("scale=-2:{THUMB_HEIGHT}"), "-q:v", "5"].map(String::from));
    a.push(out.to_string_lossy().into_owned());
    a
}

pub fn make_thumbnail(cache: &Path, source: &Path, at_s: f64) -> Result<PathBuf, String> {
    if !(at_s.is_finite() && at_s >= 0.0) {
        return Err("bad thumbnail time".into());
    }
    let out = thumb_path(cache, source, at_s);
    if out.exists() {
        return Ok(out);
    }
    std::fs::create_dir_all(out.parent().unwrap()).map_err(|e| e.to_string())?;
    let ok = tool_command("ffmpeg").args(thumb_args(source, at_s, &out)).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().map_err(|e| e.to_string())?.success();
    if ok && out.exists() {
        Ok(out)
    } else {
        Err("Couldn't make a thumbnail.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thumb_path_is_per_source_and_millisecond() {
        let p = thumb_path(Path::new("/c"), Path::new("/v/a.mp4"), 12.3456);
        assert!(p.starts_with("/c/thumbs"));
        assert!(p.ends_with("12346.jpg"));
    }

    #[test]
    fn thumb_args_seek_then_grab_one_scaled_frame() {
        let a = thumb_args(Path::new("/v/a b.mp4"), 3.0, Path::new("/c/t.jpg")).join(" ");
        assert_eq!(a, "-hide_banner -nostdin -y -ss 3.000 -i /v/a b.mp4 -frames:v 1 -vf scale=-2:96 -q:v 5 /c/t.jpg");
    }

    #[test]
    fn rejects_negative_or_nan_times() {
        let d = tempfile::tempdir().unwrap();
        assert!(make_thumbnail(d.path(), Path::new("/v/a.mp4"), -1.0).is_err());
        assert!(make_thumbnail(d.path(), Path::new("/v/a.mp4"), f64::NAN).is_err());
    }
}
```

In `src-tauri/src/cache.rs`, update the module comment to mention `thumbs/<key>/`, and in `entries()` add after the `audio` loop:

```rust
    if let Ok(rd) = std::fs::read_dir(cache.join("thumbs")) {
        for e in rd.filter_map(|e| e.ok()) {
            map.entry(e.file_name().to_string_lossy().into_owned()).or_default().push(e.path());
        }
    }
```

and add this test to its tests module:

```rust
    #[test]
    fn thumbnails_count_and_are_pruned_with_their_source() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join("thumbs").join("k1");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("0.jpg"), vec![0u8; 100]).unwrap();
        assert_eq!(total_bytes(d.path()), 100);
        assert_eq!(prune(d.path(), 0, &[]), 100);
        assert!(!dir.exists());
    }
```

- [ ] **Step 6: Commands: keep lists and `thumbnail`**

In `src-tauri/src/commands.rs`:

- Import `use crate::thumbs::make_thumbnail;`.
- Replace `touch_and_prune` with:

```rust
/// Mark `source` used and trim the cache to the configured cap, keeping `source` and every path in `keep` (the open project's media).
fn touch_and_prune(cache: &Path, data: &Path, source: &str, keep: &[String]) {
    let key = source_key(Path::new(source));
    crate::cache::touch(cache, &key);
    let cap = (crate::settings::load(data).cache_cap_gb * GB) as u64;
    let mut kept = keys(keep);
    kept.push(key);
    crate::cache::prune(cache, cap, &kept);
}
```

- `make_proxy`: add a `keep: Vec<String>` parameter after `duration`, and call `touch_and_prune(&cache, &data, &path, &keep);`.
- `prepare_audio`: signature `pub async fn prepare_audio(app: AppHandle, path: String, keep: Vec<String>)`, and inside the blocking closure `touch_and_prune(&cache, &data, &p, &keep);`.
- Add:

```rust
/// A cached JPEG of the frame at `at_s`, readable by the webview.
#[tauri::command]
pub async fn thumbnail(app: AppHandle, path: String, at_s: f64) -> Result<String, String> {
    if !presets_store::is_video_path(&path) {
        return Err("This file isn't a video SocialFrag can read.".into());
    }
    let (cache, _) = app_dirs(&app)?;
    let p = path.clone();
    let out = tauri::async_runtime::spawn_blocking(move || make_thumbnail(&cache, Path::new(&p), at_s)).await.map_err(join_err)??;
    let out = out.to_string_lossy().into_owned();
    allow_asset(&app, &out)?;
    Ok(out)
}
```

In `src-tauri/src/lib.rs` add `pub mod thumbs;` and register `commands::thumbnail` in `generate_handler!`.

- [ ] **Step 7: Run all Rust tests**

Run: `cd src-tauri && cargo test`
Expected: PASS.

Run (needs ffmpeg; on Windows use the bundled one): `cd src-tauri && SOCIALFRAG_FFMPEG_DIR=binaries-dir cargo test real_timeline_export -- --ignored --nocapture` where `binaries-dir` holds `ffmpeg.exe`/`ffprobe.exe` (copy `binaries/ffmpeg-x86_64-pc-windows-msvc.exe` to a scratch folder as `ffmpeg.exe`, same for ffprobe), or on the Mac with Homebrew ffmpeg on PATH just `cargo test real_timeline_export -- --ignored`.
Expected: PASS (duration ≈ 8 s, 1080×1920, 60 fps, one audio track).

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src
git commit -m "feat(export): multi-clip export runner, Save-dialog output path, keep lists, timeline thumbnails"
```

---
### Task 10: Backend API for multi-file import, keep lists, thumbnails and the Save dialog

**Files:**
- Modify: `src/backend/types.ts`, `src/backend/tauri.ts`, `src/backend/fake.ts`
- Modify: `src/App.tsx` (call sites only), `src/App.test.tsx` (stubs only), `src/backend/fake.test.ts`

**Interfaces:**
- Produces (`Backend`):
  - `pickClips(): Promise<string[]>` (replaces `pickClip`; empty when cancelled)
  - `pickExportPath(defaultPath: string): Promise<string | null>` (native Save dialog, `.mp4` filter)
  - `makeProxy(path: string, durationS: number, keep: string[], onProgress?: (fraction: number) => void): Promise<string>`
  - `prepareAudio(path: string, keep: string[]): Promise<PreparedTrack[]>`
  - `thumbnail(path: string, atS: number): Promise<string>` (a file path; show it with `videoUrl`)
  - `onFileDrop(cb: (paths: string[]) => void): () => void`
  - `pickFolder` stays until Task 11 removes it.

- [ ] **Step 1: Write the failing fake-backend test**

In `src/backend/fake.test.ts` change `prepareAudio('fake://a.mp4')` to `prepareAudio('fake://a.mp4', [])` and add:

```ts
test('pickExportPath returns the suggested path and thumbnails need the desktop app', async () => {
  const b = new FakeBackend();
  expect(await b.pickExportPath('C:/v/a_vertical.mp4')).toBe('C:/v/a_vertical.mp4');
  await expect(b.thumbnail('fake://a.mp4', 0)).rejects.toThrow('desktop app');
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npm test -- src/backend/fake.test.ts`
Expected: FAIL, `b.pickExportPath is not a function`.

- [ ] **Step 3: Update `src/backend/types.ts`**

Replace the `pickClip`, `makeProxy`, `prepareAudio` and `onFileDrop` members and add the two new ones:

```ts
  /** Paths the user picked (several allowed); empty if they cancelled. */
  pickClips(): Promise<string[]>;
  pickFolder(): Promise<string | null>;
  /** Native Save dialog for the export (.mp4); null if cancelled. */
  pickExportPath(defaultPath: string): Promise<string | null>;
  videoUrl(path: string): string;
  /** Rejects with Error("This file isn't a video SocialFrag can read.") on unreadable files. */
  probe(path: string): Promise<ClipInfo>;
  /** Returns the path of an H.264 preview copy. onProgress receives 0..1 while ffmpeg encodes. keep = every media path in the project (never pruned). */
  makeProxy(path: string, durationS: number, keep: string[], onProgress?: (fraction: number) => void): Promise<string>;
  /** Per-track audio for the live preview. Rejects with Error when unavailable. keep as for makeProxy. */
  prepareAudio(path: string, keep: string[]): Promise<PreparedTrack[]>;
  /** Path of a small cached JPEG of the frame at atS. */
  thumbnail(path: string, atS: number): Promise<string>;
```

and

```ts
  /** Subscribes to OS file drops on the window; returns an unsubscribe function. */
  onFileDrop(cb: (paths: string[]) => void): () => void;
```

- [ ] **Step 4: Update `src/backend/tauri.ts`**

- Import: `import { open, save } from '@tauri-apps/plugin-dialog';`
- Replace `pickClip` with:

```ts
  async pickClips() {
    const p = await open({ multiple: true, directory: false, filters: [{ name: 'Video', extensions: VIDEO_EXTS }] });
    return Array.isArray(p) ? p : typeof p === 'string' ? [p] : [];
  }

  async pickExportPath(defaultPath: string) {
    const p = await save({ defaultPath, filters: [{ name: 'MP4 video', extensions: ['mp4'] }] });
    return typeof p === 'string' ? p : null;
  }
```

- `makeProxy(path: string, durationS: number, keep: string[], onProgress?: …)` and pass `{ path, duration: durationS, keep, onProgress: channel }` to `invoke`.
- `prepareAudio(path: string, keep: string[])` and pass `{ path, keep }`.
- Add:

```ts
  async thumbnail(path: string, atS: number) {
    try {
      return await invoke<string>('thumbnail', { path, atS });
    } catch (e) {
      throw new Error(String(e));
    }
  }
```

- In `onFileDrop`, change the type to `cb: (paths: string[]) => void` and the drop line to `if (e.payload.type === 'drop' && e.payload.paths.length) cb(e.payload.paths);`.

- [ ] **Step 5: Update `src/backend/fake.ts`**

Replace `pickFile` with a multi-file version and update its callers:

```ts
function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.click();
  });
}
```

```ts
  async pickClips() {
    return (await pickFiles('video/*', true)).map((f) => this.register(f));
  }

  async pickExportPath(defaultPath: string) {
    return defaultPath;
  }
```

```ts
  async makeProxy(path: string, _durationS: number, _keep: string[], onProgress?: (fraction: number) => void) {
    onProgress?.(1);
    return path;
  }

  async prepareAudio(_path: string, _keep: string[]): Promise<PreparedTrack[]> {
    throw new Error('Audio preview needs the desktop app.');
  }

  async thumbnail(_path: string, _atS: number): Promise<string> {
    throw new Error('Thumbnails need the desktop app.');
  }
```

`importPreset` becomes `const [f] = await pickFiles('.json,application/json', false); return f ? f.text() : null;`, and in `onFileDrop` the drop handler becomes:

```ts
    const drop = (e: DragEvent) => {
      e.preventDefault();
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length) cb(files.map((f) => this.register(f)));
    };
```

with `onFileDrop(cb: (paths: string[]) => void)`.

- [ ] **Step 6: Keep today's App on the new API (call sites only)**

In `src/App.tsx`:
- `openClip`: `const [p] = await backend.pickClips(); if (p) void loadClip(p);`
- file drop: `useEffect(() => backend.onFileDrop((paths) => { if (paths[0]) void loadClip(paths[0]); }), [backend, loadClip]);`
- `backend.makeProxy(path, clip.info.duration, [path], setBusyProgress)`
- `backend.prepareAudio(path, [path])`

In `src/App.test.tsx`:
- `openClipIn`: `b.pickClips = async () => [path];`
- `stubBackend`: `let drop: (paths: string[]) => void = () => {};`, and return `drop: (p: string) => drop([p])`.
- the progress test: `s.b.makeProxy = (_p, _d, _keep, onProgress) => {`

- [ ] **Step 7: Run everything**

Run: `npm test && npx tsc -b`
Expected: PASS, no type errors.

- [ ] **Step 8: Commit**

```bash
git add src/backend src/App.tsx src/App.test.tsx
git commit -m "feat(backend): multi-file pick and drop, keep lists, thumbnails, export Save dialog"
```

---

### Task 11: Export the project — job builder and Export panel

**Files:**
- Create: `src/timeline/exportJob.ts`
- Test: `src/timeline/exportJob.test.ts`
- Delete: `src/state/exportJob.ts`, `src/state/exportJob.test.ts`
- Modify: `src/types.ts` (export job types), `src/components/ExportPanel.tsx`, `src/components/ExportPanel.test.tsx`, `src/backend/{types,tauri,fake}.ts` (drop `pickFolder`), `src/App.tsx` (interim one-clip project), `src/App.test.tsx` (job shape)

**Interfaces:**
- Consumes: `Project`, `TimelineClip`, `clipDuration`, `layoutClips`, `projectDuration` (Task 1); `buildExportAssets`, `CanvasFactory`; `encodeCurve`; `Backend.pickExportPath` (Task 10).
- Produces:
  - `src/types.ts`: `interface ClipExport { kind: ClipKind; source: string; clip: ClipInfo; preset: Preset; trim: Trim; speed: number; layerMasks: Record<string, string>; overlays: Overlay[]; audio: AudioMix; gainCurves: Record<number, string> }`, `interface ExportJob { clips: ClipExport[]; quality: Quality; fps: 30 | 60; canvas: { w: number; h: number }; outputPath: string }`, `ExportErrorCode` gains `'invalid_project'`.
  - `localOverlays(overlays: Overlay[], clip: TimelineClip): Overlay[]`
  - `defaultExportPath(p: Project): string`
  - `buildExportJob(a: { project: Project; presetById(id: string): Preset; curves(clip: TimelineClip): Map<number, Float32Array>; quality: Quality; outputPath: string; make?: CanvasFactory }): Promise<ExportJob>`
  - `toExportError(e: unknown): ExportError` (moved from `src/state/exportJob.ts`)
  - `ExportPanel` props: `{ backend: Backend; project: Project; presetById(id: string): Preset; curves(clip: TimelineClip): Map<number, Float32Array>; blockedReason?: string | null }` — `curves` returns source-time curves over [inS, outS).

- [ ] **Step 1: Update the export types in `src/types.ts`**

Replace `Overlay` and `ExportJob`, and extend `ExportErrorCode`:

```ts
/** Full-canvas transparent PNG, shown from `start` seconds into its clip's output to the clip's end. */
export interface Overlay { pngBase64: string; start: number }
/** One timeline clip as the Rust export sees it. gainCurves: track index -> base64 f32le at 200 Hz over [trim.inS, trim.outS) in source time. */
export interface ClipExport {
  kind: ClipKind;
  source: string;
  clip: ClipInfo;
  preset: Preset;
  trim: Trim;
  speed: number;
  /** layer id -> PNG mask (white = visible) sized to the layer's draw rect */
  layerMasks: Record<string, string>;
  overlays: Overlay[];
  audio: AudioMix;
  gainCurves: Record<number, string>;
}
export interface ExportJob { clips: ClipExport[]; quality: Quality; fps: 30 | 60; canvas: { w: number; h: number }; outputPath: string }
```

```ts
export type ExportErrorCode = 'ffmpeg' | 'not_writable' | 'cancelled' | 'invalid_preset' | 'invalid_project' | 'io' | 'busy' | 'invalid_audio';
```

In `src/backend/fake.ts` `startExport`, resolve with `{ outputPath: job.outputPath, usedCpuFallback: false }`.

- [ ] **Step 2: Write the failing builder tests**

Create `src/timeline/exportJob.test.ts`:

```ts
import { expect, test } from 'vitest';
import { blankPreset } from '../presets/presets';
import type { TrackMix } from '../types';
import { buildExportJob, defaultExportPath, localOverlays, toExportError } from './exportJob';
import { emptyProject, type MediaRef, type Project, type TimelineClip } from './model';

const preset = blankPreset('p'); // no radius/border: no OffscreenCanvas needed in jsdom
const media: MediaRef = { id: 'm', path: 'C:/v/My clip.mp4', info: { width: 1920, height: 1080, fps: '60', codec: 'h264', duration: 30, hasAudio: true, audioTracks: [{ index: 0, label: 'Game', named: true, channels: 2 }] } };
const track: TrackMix = { index: 0, sourceLabel: 'Game', label: 'Game', enabled: true, gain: 1, ceilingDb: null, offsetS: 0, fadeInS: 0, fadeOutS: 0, mutes: [] };
const clip = (id: string, o: Partial<TimelineClip> = {}): TimelineClip => ({
  id, kind: 'video', mediaId: 'm', inS: 10, outS: 20, speed: 1, presetId: 'p', layers: preset.layers, mix: { tracks: [track], duck: null }, captions: [], ...o,
});
const project = (...main: TimelineClip[]): Project => ({ ...emptyProject(), media: [media], main });

test('overlay starts become seconds into the clip output, honouring speed', () => {
  const o = (start: number) => ({ pngBase64: 'x', start });
  expect(localOverlays([o(0), o(14), o(40)], clip('a', { speed: 2 })).map((x) => x.start)).toEqual([0, 2]);
});

test('a freeze frame keeps only overlays already showing at its frame', () => {
  const o = (start: number) => ({ pngBase64: 'x', start });
  expect(localOverlays([o(0), o(5), o(12)], clip('f', { kind: 'freeze', inS: 5, outS: 8 })).map((x) => x.start)).toEqual([0, 0]);
});

test('buildExportJob sends every clip with its own layout, trim, speed and curves', async () => {
  const layers = preset.layers.map((l) => ({ ...l, hidden: false }));
  const job = await buildExportJob({
    project: project(clip('a', { layers }), clip('f', { kind: 'freeze', inS: 12, outS: 15 }), clip('b', { speed: 2, inS: 0, outS: 4 })),
    presetById: () => preset,
    curves: () => new Map([[0, new Float32Array([1, 1])]]),
    quality: 'small',
    outputPath: 'D:/out/x.mp4',
  });
  expect(job).toMatchObject({ quality: 'small', fps: 60, canvas: { w: 1080, h: 1920 }, outputPath: 'D:/out/x.mp4' });
  expect(job.clips.map((c) => [c.kind, c.source, c.trim.inS, c.trim.outS, c.speed])).toEqual([
    ['video', 'C:/v/My clip.mp4', 10, 20, 1],
    ['freeze', 'C:/v/My clip.mp4', 12, 15, 1],
    ['video', 'C:/v/My clip.mp4', 0, 4, 2],
  ]);
  expect(job.clips[0].preset.layers).toBe(layers);
  expect(Object.keys(job.clips[0].gainCurves)).toEqual(['0']);
  expect(job.clips[1].gainCurves).toEqual({});
});

test('the default export path sits next to the first clip', () => {
  expect(defaultExportPath(project(clip('a')))).toBe('C:/v/My clip_vertical.mp4');
  expect(defaultExportPath(emptyProject())).toBe('SocialFrag_vertical.mp4');
});

test('toExportError passes backend errors through and wraps anything else', () => {
  expect(toExportError({ code: 'busy', message: 'm', details: '' }).code).toBe('busy');
  expect(toExportError(new Error('boom'))).toMatchObject({ code: 'ffmpeg', message: 'Export failed.' });
});
```

- [ ] **Step 3: Run to see it fail**

Run: `npm test -- src/timeline/exportJob.test.ts`
Expected: FAIL, `Failed to resolve import "./exportJob"`.

- [ ] **Step 4: Write `src/timeline/exportJob.ts`**

```ts
import { encodeCurve } from '../audio/curve';
import { buildExportAssets, type CanvasFactory } from '../render/exportAssets';
import type { ClipExport, ExportError, ExportJob, Overlay, Preset, Quality } from '../types';
import { clipDuration, type Project, type TimelineClip } from './model';

/**
 * buildExportAssets starts caption overlays at source seconds; the export wants seconds into the
 * clip's output. Overlays that start after the clip ends are dropped. A freeze frame keeps only
 * what is already showing at its frame.
 */
export function localOverlays(overlays: Overlay[], clip: TimelineClip): Overlay[] {
  const dur = clipDuration(clip);
  const out: Overlay[] = [];
  for (const o of overlays) {
    const rel = clip.kind === 'freeze' ? (o.start <= clip.inS + 1e-3 ? 0 : Infinity) : Math.max(0, (o.start - clip.inS) / clip.speed);
    if (rel < dur) out.push({ ...o, start: rel });
  }
  return out;
}

export function defaultExportPath(p: Project): string {
  const first = p.main[0] ? p.media.find((m) => m.id === p.main[0].mediaId) : undefined;
  return first ? `${first.path.replace(/\.[^./\\]+$/, '')}_vertical.mp4` : 'SocialFrag_vertical.mp4';
}

export async function buildExportJob(a: {
  project: Project;
  presetById(id: string): Preset;
  /** Source-time gain curves over [inS, outS) for a video clip. */
  curves(clip: TimelineClip): Map<number, Float32Array>;
  quality: Quality;
  outputPath: string;
  make?: CanvasFactory;
}): Promise<ExportJob> {
  const media = new Map(a.project.media.map((m) => [m.id, m]));
  const clips: ClipExport[] = [];
  for (const c of a.project.main) {
    const m = media.get(c.mediaId);
    if (!m) throw new Error(`Clip ${c.id} has no media.`);
    const preset = { ...a.presetById(c.presetId), layers: c.layers };
    const assets = await buildExportAssets(preset, m.info, c.captions, a.make);
    const gainCurves: Record<number, string> = {};
    if (c.kind === 'video') {
      const cs = a.curves(c);
      for (const t of c.mix.tracks) {
        const k = cs.get(t.index);
        if (t.enabled && k) gainCurves[t.index] = encodeCurve(k);
      }
    }
    clips.push({
      kind: c.kind, source: m.path, clip: m.info, preset, trim: { inS: c.inS, outS: c.outS }, speed: c.speed,
      layerMasks: assets.layerMasks, overlays: localOverlays(assets.overlays, c), audio: c.mix, gainCurves,
    });
  }
  return { clips, quality: a.quality, fps: a.project.fps, canvas: a.project.canvas, outputPath: a.outputPath };
}

export function toExportError(e: unknown): ExportError {
  if (e && typeof e === 'object' && 'code' in e && 'message' in e) return e as ExportError;
  const details = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
  return { code: 'ffmpeg', message: 'Export failed.', details };
}
```

Delete `src/state/exportJob.ts` and `src/state/exportJob.test.ts` (`git rm`).

- [ ] **Step 5: Run the builder tests**

Run: `npm test -- src/timeline/exportJob.test.ts`
Expected: PASS.

- [ ] **Step 6: Rewrite the Export panel tests**

Replace `src/components/ExportPanel.test.tsx` with:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { FakeBackend } from '../backend/fake';
import { blankPreset } from '../presets/presets';
import { emptyProject, type Project } from '../timeline/model';
import type { ExportJob } from '../types';
import { ExportPanel } from './ExportPanel';

// blankPreset has no radius/border and there are no captions, so no OffscreenCanvas is needed in jsdom.
const preset = blankPreset('p');
const project: Project = {
  ...emptyProject(),
  media: [{ id: 'm', path: 'C:/v/a.mp4', info: { width: 1920, height: 1080, fps: '60', codec: 'h264', duration: 10, hasAudio: true, audioTracks: [] } }],
  main: [{ id: 'c', kind: 'video', mediaId: 'm', inS: 1, outS: 9, speed: 1, presetId: 'p', layers: preset.layers, mix: { tracks: [], duck: null }, captions: [] }],
};
const panel = (backend: FakeBackend, blockedReason: string | null = null) =>
  render(<ExportPanel backend={backend} project={project} presetById={() => preset} curves={() => new Map()} blockedReason={blockedReason} />);

test('asks where to save, exports, shows progress and the saved file', async () => {
  const backend = new FakeBackend();
  const pick = vi.spyOn(backend, 'pickExportPath');
  let sent: ExportJob | null = null;
  backend.startExport = vi.fn(async (job, onProgress) => {
    sent = job;
    onProgress({ fraction: 0.5, etaS: 3 });
    return { outputPath: job.outputPath, usedCpuFallback: true };
  });
  panel(backend);
  expect(screen.getByText('1080×1920 MP4 · 0:08.0 · 1 clip')).toBeTruthy();
  fireEvent.click(screen.getByLabelText('Smaller file'));
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  await waitFor(() => expect(screen.getByText(/a_vertical\.mp4/)).toBeTruthy());
  expect(pick).toHaveBeenCalledWith('C:/v/a_vertical.mp4');
  expect(screen.getByText('GPU encode failed, used CPU instead.')).toBeTruthy();
  expect(sent!.quality).toBe('small');
  expect(sent!.outputPath).toBe('C:/v/a_vertical.mp4');
  expect(sent!.clips[0].trim).toEqual({ inS: 1, outS: 9 });
});

test('cancelling the Save dialog exports nothing', async () => {
  const backend = new FakeBackend();
  backend.pickExportPath = vi.fn(async () => null);
  backend.startExport = vi.fn();
  panel(backend);
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  await waitFor(() => expect(backend.pickExportPath).toHaveBeenCalled());
  expect(backend.startExport).not.toHaveBeenCalled();
});

test('a blockedReason disables Export and shows the reason', () => {
  panel(new FakeBackend(), 'Preparing audio…');
  expect((screen.getByRole('button', { name: 'Export' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('Preparing audio…')).toBeTruthy();
});

test('shows ffmpeg errors with copyable details', async () => {
  const backend = new FakeBackend();
  backend.startExport = vi.fn(async () => {
    throw { code: 'ffmpeg', message: 'Export failed.', details: 'stderr tail' };
  });
  panel(backend);
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Export failed.'));
  expect(screen.getByRole('button', { name: 'Copy error details' })).toBeTruthy();
});

test('not_writable asks for another place and retries there', async () => {
  const backend = new FakeBackend();
  backend.pickExportPath = vi.fn().mockResolvedValueOnce('C:/locked/a.mp4').mockResolvedValueOnce('D:/out/a.mp4');
  const jobs: ExportJob[] = [];
  backend.startExport = vi.fn(async (job) => {
    jobs.push(job);
    if (jobs.length === 1) throw { code: 'not_writable', message: "Can't save to this folder. Pick another one.", details: 'C:/locked' };
    return { outputPath: job.outputPath, usedCpuFallback: false };
  });
  panel(backend);
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  await waitFor(() => expect(screen.getByText('Saved: D:/out/a.mp4')).toBeTruthy());
  expect(jobs.map((j) => j.outputPath)).toEqual(['C:/locked/a.mp4', 'D:/out/a.mp4']);
});
```

- [ ] **Step 7: Rewrite `src/components/ExportPanel.tsx`**

```tsx
import { useRef, useState } from 'react';
import type { Backend } from '../backend/types';
import { ensureFonts } from '../render/fonts';
import { formatTime } from '../state/trim';
import { buildExportJob, defaultExportPath, toExportError } from '../timeline/exportJob';
import { layoutClips, projectDuration, type Project, type TimelineClip } from '../timeline/model';
import type { ExportError, ExportResult, Preset, Quality } from '../types';

type Status =
  | { kind: 'idle' }
  | { kind: 'running'; fraction: number; etaS: number | null }
  | { kind: 'done'; result: ExportResult }
  | { kind: 'error'; error: ExportError };

interface Props {
  backend: Backend;
  project: Project;
  presetById(id: string): Preset;
  /** Source-time gain curves over [inS, outS) for a video clip. */
  curves(clip: TimelineClip): Map<number, Float32Array>;
  /** Non-null while export must be disabled for a reason the user should see (e.g. audio still preparing). */
  blockedReason?: string | null;
}

export function ExportPanel({ backend, project, presetById, curves, blockedReason = null }: Props) {
  const [quality, setQuality] = useState<Quality>('high');
  const [lastPath, setLastPath] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  // Cancel can be clicked while fonts/PNGs are still being prepared, before ffmpeg exists.
  const cancelRequested = useRef(false);
  const count = project.main.length;
  const duration = projectDuration(layoutClips(project.main));
  const media = new Map(project.media.map((m) => [m.id, m]));
  const videoClips = project.main.filter((c) => c.kind === 'video');
  const hasAudio = videoClips.some((c) => (media.get(c.mediaId)?.info.audioTracks.length ?? 0) > 0);
  const anyEnabled = videoClips.some((c) => c.mix.tracks.some((t) => t.enabled));

  async function run(confirmed = false): Promise<void> {
    if (!count) return;
    if (hasAudio && !anyEnabled && !confirmed && !window.confirm('No audio will be exported. Continue?')) return;
    const outputPath = await backend.pickExportPath(lastPath ?? defaultExportPath(project));
    if (!outputPath) return;
    setLastPath(outputPath);
    cancelRequested.current = false;
    setStatus({ kind: 'running', fraction: 0, etaS: null });
    try {
      await ensureFonts();
      const job = await buildExportJob({ project, presetById, curves, quality, outputPath });
      if (cancelRequested.current) {
        setStatus({ kind: 'idle' });
        return;
      }
      const result = await backend.startExport(job, (p) => setStatus({ kind: 'running', fraction: p.fraction, etaS: p.etaS }));
      setStatus({ kind: 'done', result });
    } catch (e) {
      const err = toExportError(e);
      if (err.code === 'not_writable') {
        setStatus({ kind: 'error', error: err });
        return run(true);
      }
      setStatus(err.code === 'cancelled' ? { kind: 'idle' } : { kind: 'error', error: err });
    }
  }

  const running = status.kind === 'running';

  return (
    <section className="panel">
      <h2>Export</h2>
      <fieldset disabled={running}>
        <legend>Quality</legend>
        <label>
          <input type="radio" name="quality" checked={quality === 'high'} onChange={() => setQuality('high')} /> High
        </label>
        <label>
          <input type="radio" name="quality" checked={quality === 'small'} onChange={() => setQuality('small')} /> Smaller file
        </label>
      </fieldset>
      <p className="hint">
        {project.canvas.w}×{project.canvas.h} MP4 · {formatTime(duration)} · {count === 1 ? '1 clip' : `${count} clips`}
      </p>
      {running ? (
        <div className="progress">
          <progress value={status.fraction} max={1} />
          <span>
            {Math.round(status.fraction * 100)}%{status.etaS !== null ? ` · ${Math.ceil(status.etaS)}s left` : ''}
          </span>
          <button
            onClick={() => {
              cancelRequested.current = true;
              void backend.cancelExport();
            }}
          >
            Cancel
          </button>
        </div>
      ) : (
        <>
          <button className="primary" disabled={blockedReason !== null || !count} onClick={() => void run()}>
            Export
          </button>
          {blockedReason !== null && <p className="hint">{blockedReason}</p>}
        </>
      )}
      {status.kind === 'done' && (
        <div className="done">
          <p>Saved: {status.result.outputPath}</p>
          {status.result.usedCpuFallback && <p className="hint">GPU encode failed, used CPU instead.</p>}
          <button onClick={() => void backend.revealFile(status.result.outputPath)}>Open folder</button>
        </div>
      )}
      {status.kind === 'error' && (
        <div className="notice-inline error" role="alert">
          <p>{status.error.message}</p>
          <button onClick={() => void navigator.clipboard?.writeText(status.error.details)}>Copy error details</button>
        </div>
      )}
    </section>
  );
}
```

Remove `pickFolder` from `Backend` (`src/backend/types.ts`), `TauriBackend` and `FakeBackend`; nothing else calls it now.

- [ ] **Step 8: Feed the panel from today's App (interim one-clip project)**

In `src/App.tsx` add imports:

```tsx
import { sliceCurve } from './audio/curve';
import { emptyProject, projectFps, type Project, type TimelineClip } from './timeline/model';
```

Add above the `return`:

```tsx
  // Interim one-clip project for the export panel until the timeline replaces this state (Task 14).
  const exportProject = useMemo<Project>(() => {
    if (!clip) return emptyProject();
    const m = { id: 'm', path: clip.path, info: clip.info };
    return { ...emptyProject(), fps: projectFps([m]), media: [m], main: [{ id: 'c', kind: 'video', mediaId: 'm', inS: trim.inS, outS: trim.outS, speed: 1, presetId: preset.id, layers: workingLayers, mix: audioMix, captions }] };
  }, [clip, trim, preset.id, workingLayers, audioMix, captions]);
  const exportCurves = useCallback((c: TimelineClip) => new Map([...curves].map(([i, k]) => [i, sliceCurve(k, { inS: c.inS, outS: c.outS })] as const)), [curves]);
```

and replace the `<ExportPanel … />` element with:

```tsx
          <ExportPanel
            backend={backend}
            project={exportProject}
            presetById={() => preset}
            curves={exportCurves}
            blockedReason={audioMix.duck && prepared === null && audioError === null ? 'Preparing audio' : null}
          />
```

In `src/App.test.tsx`, in `toggling a HUD layer off is reflected in the exported job preset`, change `job.preset.layers` to `job.clips[0].preset.layers`.

- [ ] **Step 9: Run everything**

Run: `npm test && npx tsc -b`
Expected: PASS, no type errors.

- [ ] **Step 10: Commit**

```bash
git add -A src
git commit -m "feat(export): build the multi-clip job from the project; Save dialog on every export"
```

---

### Task 12: Media library hook — import, proxies and audio prep per file

**Files:**
- Create: `src/state/paths.ts`, `src/state/useMedia.ts`
- Test: `src/state/useMedia.test.ts`

**Interfaces:**
- Consumes: `Backend` (Task 10), `MediaRef` (Task 1), `webviewCanPlay` (`src/state/playback.ts`), `PreparedTrack`.
- Produces:
  - `baseName(path: string): string`
  - `AUDIO_UNAVAILABLE = 'Audio preview unavailable : export still uses your mix.'`
  - `interface MediaStatus { url: string; proxied: boolean; proxyProgress: number | null; prepared: PreparedTrack[] | null; audioError: string | null }`
  - `useMedia(backend, onAudioFailed: (mediaId: string) => void, onError: (message: string) => void): { status: Record<string, MediaStatus>; importPaths(paths: string[]): Promise<MediaRef[]>; onPlaybackError(mediaId: string): void; mediaIdForUrl(url: string): string | null; paths: string[] }` — `importPaths`, `onPlaybackError` and `mediaIdForUrl` are stable across renders. Proxies run one at a time; audio prep runs one at a time; both pass every imported path as `keep`.

- [ ] **Step 1: Write the failing tests**

Create `src/state/useMedia.test.ts`:

```ts
import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import type { PreparedTrack } from '../backend/types';
import { FakeBackend } from '../backend/fake';
import type { ClipInfo } from '../types';
import { baseName } from './paths';
import { AUDIO_UNAVAILABLE, useMedia } from './useMedia';

const info = (o: Partial<ClipInfo> = {}): ClipInfo => ({ width: 1920, height: 1080, fps: '60', codec: 'h264', duration: 10, hasAudio: true, audioTracks: [{ index: 0, label: 'Game', named: true, channels: 2 }], ...o });

function setup(probe: (path: string) => Promise<ClipInfo> = async () => info()) {
  const b = new FakeBackend();
  b.probe = probe;
  b.videoUrl = (p: string) => `url:${p}`;
  b.prepareAudio = vi.fn(async () => [] as PreparedTrack[]);
  const onAudioFailed = vi.fn();
  const onError = vi.fn();
  const hook = renderHook(() => useMedia(b, onAudioFailed, onError));
  return { b, onAudioFailed, onError, hook };
}

test('baseName handles both separators', () => {
  expect(baseName('C:\\v\\a.mp4')).toBe('a.mp4');
  expect(baseName('/v/b.mp4')).toBe('b.mp4');
});

test('imports in file-name order (numbers sort naturally) and reuses files already imported', async () => {
  const s = setup();
  let refs = await act(() => s.hook.result.current.importPaths(['C:/v/clip 10.mp4', 'C:/v/clip 2.mp4']));
  expect(refs.map((m) => baseName(m.path))).toEqual(['clip 2.mp4', 'clip 10.mp4']);
  const again = await act(() => s.hook.result.current.importPaths(['C:/v/clip 2.mp4']));
  expect(again[0].id).toBe(refs[0].id);
  refs = refs.concat(again);
  expect(s.hook.result.current.paths.sort()).toEqual(['C:/v/clip 10.mp4', 'C:/v/clip 2.mp4']);
  expect(s.hook.result.current.status[refs[0].id].url).toBe('url:C:/v/clip 2.mp4');
});

test('a file that fails to probe is reported by name and skipped', async () => {
  const s = setup(async (p) => {
    if (p.endsWith('bad.txt')) throw new Error("This file isn't a video SocialFrag can read.");
    return info();
  });
  const refs = await act(() => s.hook.result.current.importPaths(['C:/v/bad.txt', 'C:/v/good.mp4']));
  expect(refs).toHaveLength(1);
  expect(s.onError).toHaveBeenCalledWith("bad.txt: This file isn't a video SocialFrag can read.");
});

test('a clip the webview cannot play gets a proxy with progress; other media keep their URL', async () => {
  const s = setup(async (p) => info({ codecTag: p.includes('hevc') ? 'hev1' : undefined }));
  let report: (f: number) => void = () => {};
  let finish: (p: string) => void = () => {};
  s.b.makeProxy = vi.fn((_p: string, _d: number, _keep: string[], onProgress?: (f: number) => void) => {
    report = onProgress ?? (() => {});
    return new Promise<string>((r) => (finish = r));
  });
  const [a, b] = await act(() => s.hook.result.current.importPaths(['C:/v/a hevc.mp4', 'C:/v/b.mp4']));
  await waitFor(() => expect(s.b.makeProxy).toHaveBeenCalledTimes(1));
  act(() => report(0.42));
  expect(s.hook.result.current.status[a.id].proxyProgress).toBeCloseTo(0.42);
  await act(async () => finish('C:/cache/a.mp4'));
  expect(s.hook.result.current.status[a.id]).toMatchObject({ url: 'url:C:/cache/a.mp4', proxied: true, proxyProgress: null });
  expect(s.hook.result.current.status[b.id].url).toBe('url:C:/v/b.mp4');
});

test('audio prep runs one file at a time and keeps every imported file', async () => {
  const s = setup();
  const pending: ((t: PreparedTrack[]) => void)[] = [];
  s.b.prepareAudio = vi.fn(() => new Promise<PreparedTrack[]>((r) => pending.push(r)));
  const [a] = await act(() => s.hook.result.current.importPaths(['C:/v/a.mp4', 'C:/v/b.mp4']));
  await waitFor(() => expect(s.b.prepareAudio).toHaveBeenCalledTimes(1));
  expect((s.b.prepareAudio as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual(['C:/v/a.mp4', ['C:/v/a.mp4', 'C:/v/b.mp4']]);
  const tracks = [{ index: 0, pcmPath: '/p', frames: 1, envelope: new Float32Array() }];
  await act(async () => pending[0](tracks));
  await waitFor(() => expect(s.b.prepareAudio).toHaveBeenCalledTimes(2));
  expect(s.hook.result.current.status[a.id].prepared).toBe(tracks);
});

test('failed audio prep marks the media and tells the caller', async () => {
  const s = setup();
  s.b.prepareAudio = vi.fn(async () => {
    throw new Error('x');
  });
  const [a] = await act(() => s.hook.result.current.importPaths(['C:/v/a.mp4']));
  await waitFor(() => expect(s.onAudioFailed).toHaveBeenCalledWith(a.id));
  expect(s.hook.result.current.status[a.id].audioError).toBe(AUDIO_UNAVAILABLE);
});

test('a playback error asks for a proxy once; a failing proxy is reported', async () => {
  const s = setup();
  s.b.makeProxy = vi.fn(async () => 'C:/cache/a.mp4');
  const [a] = await act(() => s.hook.result.current.importPaths(['C:/v/a.mp4']));
  expect(s.hook.result.current.mediaIdForUrl('url:C:/v/a.mp4')).toBe(a.id);
  act(() => s.hook.result.current.onPlaybackError(a.id));
  await waitFor(() => expect(s.hook.result.current.status[a.id].proxied).toBe(true));
  act(() => s.hook.result.current.onPlaybackError(a.id));
  expect(s.onError).toHaveBeenCalledWith("This video can't be previewed.");
  expect(s.b.makeProxy).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npm test -- src/state/useMedia.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write `src/state/paths.ts`**

```ts
export const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;
```

- [ ] **Step 4: Write `src/state/useMedia.ts`**

```ts
import { useCallback, useMemo, useRef, useState } from 'react';
import type { Backend, PreparedTrack } from '../backend/types';
import type { MediaRef } from '../timeline/model';
import type { ClipInfo } from '../types';
import { baseName } from './paths';
import { webviewCanPlay } from './playback';

export const AUDIO_UNAVAILABLE = 'Audio preview unavailable : export still uses your mix.';

export interface MediaStatus {
  /** What the player loads: the source, or its H.264 proxy once made. */
  url: string;
  proxied: boolean;
  /** 0..1 while the proxy encodes, else null. */
  proxyProgress: number | null;
  prepared: PreparedTrack[] | null;
  audioError: string | null;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Runs jobs one after another: a second ffmpeg reading the same disk only slows both down. */
function serialQueue() {
  let tail: Promise<void> = Promise.resolve();
  return (job: () => Promise<void>) => {
    tail = tail.then(job, job);
  };
}

/** Every imported file: its preview URL (source or proxy), proxy progress and preview audio. */
export function useMedia(backend: Backend, onAudioFailed: (mediaId: string) => void, onError: (message: string) => void) {
  const [status, setStatus] = useState<Record<string, MediaStatus>>({});
  const statusRef = useRef(status);
  statusRef.current = status;
  const callbacks = useRef({ onAudioFailed, onError });
  callbacks.current = { onAudioFailed, onError };
  const refs = useRef(new Map<string, MediaRef>());
  const proxyAsked = useRef(new Set<string>());
  const proxyQueue = useMemo(serialQueue, []);
  const audioQueue = useMemo(serialQueue, []);
  const keep = () => [...refs.current.values()].map((m) => m.path);

  const patch = useCallback((id: string, p: Partial<MediaStatus>) => setStatus((s) => (s[id] ? { ...s, [id]: { ...s[id], ...p } } : s)), []);

  const makeProxy = useCallback(
    (m: MediaRef) => {
      if (proxyAsked.current.has(m.id)) return;
      proxyAsked.current.add(m.id);
      patch(m.id, { proxyProgress: 0 });
      proxyQueue(async () => {
        try {
          const proxy = await backend.makeProxy(m.path, m.info.duration, keep(), (f) => patch(m.id, { proxyProgress: f }));
          patch(m.id, { url: backend.videoUrl(proxy), proxied: true, proxyProgress: null });
        } catch (e) {
          patch(m.id, { proxyProgress: null });
          callbacks.current.onError(`Preview failed: ${message(e)}`);
        }
      });
    },
    [backend, patch, proxyQueue],
  );

  const importPaths = useCallback(
    async (paths: string[]): Promise<MediaRef[]> => {
      const sorted = [...paths].sort((a, b) => baseName(a).localeCompare(baseName(b), undefined, { numeric: true }));
      const out: MediaRef[] = [];
      const fresh: MediaRef[] = [];
      for (const path of sorted) {
        const known = [...refs.current.values()].find((m) => m.path === path);
        if (known) {
          out.push(known);
          continue;
        }
        let info: ClipInfo;
        try {
          info = await backend.probe(path);
        } catch (e) {
          callbacks.current.onError(`${baseName(path)}: ${message(e)}`);
          continue;
        }
        const m: MediaRef = { id: crypto.randomUUID(), path, info };
        refs.current.set(m.id, m);
        setStatus((s) => ({ ...s, [m.id]: { url: backend.videoUrl(path), proxied: false, proxyProgress: null, prepared: null, audioError: null } }));
        out.push(m);
        fresh.push(m);
      }
      // Queued after the whole batch is known, so every job's keep list covers all of it.
      for (const m of fresh) {
        // Silent-failure codecs (e.g. OBS hev1 HEVC in WebKit) never fire an error: go straight to the proxy.
        if (!webviewCanPlay(m.info, (t) => document.createElement('video').canPlayType(t))) makeProxy(m);
        if (!m.info.audioTracks.length) continue;
        audioQueue(async () => {
          try {
            patch(m.id, { prepared: await backend.prepareAudio(m.path, keep()) });
          } catch {
            patch(m.id, { audioError: AUDIO_UNAVAILABLE });
            callbacks.current.onAudioFailed(m.id);
          }
        });
      }
      return out;
    },
    [backend, makeProxy, patch, audioQueue],
  );

  const onPlaybackError = useCallback(
    (mediaId: string) => {
      const s = statusRef.current[mediaId];
      const m = refs.current.get(mediaId);
      if (!s || !m) return;
      if (s.proxied) callbacks.current.onError("This video can't be previewed.");
      else makeProxy(m);
    },
    [makeProxy],
  );

  const mediaIdForUrl = useCallback((url: string) => Object.entries(statusRef.current).find(([, s]) => s.url === url)?.[0] ?? null, []);
  const paths = useMemo(() => Object.keys(status).map((id) => refs.current.get(id)?.path ?? ''), [status]);

  return { status, importPaths, onPlaybackError, mediaIdForUrl, paths };
}
```

- [ ] **Step 5: Run the tests**

Run: `npm test -- src/state/useMedia.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/state/paths.ts src/state/useMedia.ts src/state/useMedia.test.ts
git commit -m "feat(media): per-file import with serial proxy and audio-prep queues"
```

---

### Task 13: Timeline, media rail, clip inspector, editor keys and thumbnails

**Files:**
- Create: `src/components/Timeline.tsx`, `src/components/MediaRail.tsx`, `src/components/ClipInspector.tsx`, `src/components/useEditorKeys.ts`, `src/state/useThumbnails.ts`
- Test: `src/components/Timeline.test.tsx`, `src/components/MediaRail.test.tsx`, `src/components/ClipInspector.test.tsx`, `src/components/useEditorKeys.test.ts`, `src/state/useThumbnails.test.ts`
- Modify: `src/components/AudioMixer.tsx` (export `NumberField`), `src/test/setup.ts` (PointerEvent polyfill)

**Interfaces:**
- Consumes: `LaidClip`, `TimelineClip`, `MediaRef`, `projectDuration` (Task 1); `TimelinePlayer` (Task 6); `MediaStatus` (Task 12); `formatTime`; `baseName`.
- Produces:
  - `Timeline` props: `{ player: TimelinePlayer | null; laid: LaidClip[]; nameOf(mediaId: string): string; thumbOf(clip: TimelineClip): string | null; selectedId: string | null; draggingMediaId: string | null; onSelect(id: string | null): void; onTrim(id: string, edge: 'in' | 'out', srcT: number): void; onFreezeLength(id: string, seconds: number): void; onMove(id: string, toIndex: number): void; onDropMedia(mediaId: string, index: number): void; onAdd(): void }`; exports `dropIndex(laid, t, skipId?)`, `tickStep(pps)`.
  - `MediaRail` props: `{ media: MediaRef[]; status: Record<string, MediaStatus>; onAdd(): void; onAppend(mediaId: string): void; onDragStart(mediaId: string): void }`; exports `mediaStatusText(info, status)`.
  - `ClipInspector` props: `{ clip: TimelineClip; name: string; onSpeed(speed: number): void; onFreezeLength(seconds: number): void; onDelete(): void }`.
  - `interface EditorKeyHandlers { togglePlay; split; remove; freeze; setIn; setOut; step(dir: -1 | 1); undo; redo }` and `useEditorKeys(h: EditorKeyHandlers, enabled: boolean)`.
  - `useThumbnails(backend, laid, media: Map<string, MediaRef>): (mediaId: string, inS: number) => string | null`.
  - `NumberField` exported from `AudioMixer.tsx`.

- [ ] **Step 1: Shared test setup and `NumberField` export**

Append to `src/test/setup.ts`:

```ts
// jsdom has no PointerEvent.
if (typeof (globalThis as { PointerEvent?: unknown }).PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 0;
    }
  }
  (globalThis as { PointerEvent?: unknown }).PointerEvent = PointerEventPolyfill;
}
```

In `src/components/AudioMixer.tsx` change `function NumberField(` to `export function NumberField(`.

- [ ] **Step 2: Write the failing component tests**

Create `src/components/Timeline.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { layoutClips, type TimelineClip } from '../timeline/model';
import type { TimelinePlayer } from '../timeline/player';
import { Timeline, dropIndex, tickStep } from './Timeline';

const clip = (id: string, o: Partial<TimelineClip> = {}): TimelineClip => ({
  id, kind: 'video', mediaId: 'm', inS: 0, outS: 4, speed: 1, presetId: 'p', layers: [], mix: { tracks: [], duck: null }, captions: [], ...o,
});

// jsdom lays nothing out: the track starts at x = 0 and the view isn't fitted, so it runs at 50 px per second.
function renderTimeline(clips: TimelineClip[], over: Record<string, unknown> = {}) {
  const props = {
    player: null as TimelinePlayer | null, laid: layoutClips(clips), nameOf: () => 'a.mp4', thumbOf: () => null, selectedId: null, draggingMediaId: null,
    onSelect: vi.fn(), onTrim: vi.fn(), onFreezeLength: vi.fn(), onMove: vi.fn(), onDropMedia: vi.fn(), onAdd: vi.fn(), ...over,
  };
  render(<Timeline {...props} />);
  return props;
}

test('clips sit at 50 px per second with their names, speed and freeze labels', () => {
  renderTimeline([clip('a'), clip('b', { speed: 2 }), clip('f', { kind: 'freeze', inS: 1, outS: 4 })]);
  const b = screen.getByRole('button', { name: 'Clip 2: a.mp4' });
  expect([b.style.left, b.style.width]).toEqual(['200px', '100px']);
  expect(b.textContent).toContain('2×');
  expect(screen.getByRole('button', { name: 'Clip 3: a.mp4' }).textContent).toContain('Freeze');
});

test('a click selects a clip; dragging it past the next clip’s middle reorders', () => {
  const p = renderTimeline([clip('a'), clip('b')]);
  const a = screen.getByRole('button', { name: 'Clip 1: a.mp4' });
  fireEvent.pointerDown(a, { clientX: 10, pointerId: 1 });
  fireEvent.pointerUp(a, { clientX: 10, pointerId: 1 });
  expect(p.onSelect).toHaveBeenCalledWith('a');
  fireEvent.pointerDown(a, { clientX: 10, pointerId: 1 });
  fireEvent.pointerMove(a, { clientX: 330, pointerId: 1 });
  fireEvent.pointerUp(a, { clientX: 330, pointerId: 1 });
  expect(p.onMove).toHaveBeenCalledWith('a', 1);
});

test('dragging an edge trims in source seconds, scaled by speed', () => {
  const p = renderTimeline([clip('a', { speed: 2 })]);
  const edge = screen.getByLabelText('Trim end of clip 1');
  fireEvent.pointerDown(edge, { clientX: 100, pointerId: 1 });
  fireEvent.pointerMove(edge, { clientX: 150, pointerId: 1 });
  expect(p.onTrim).toHaveBeenLastCalledWith('a', 'out', 6);
  const start = screen.getByLabelText('Trim start of clip 1');
  fireEvent.pointerDown(start, { clientX: 0, pointerId: 1 });
  fireEvent.pointerMove(start, { clientX: 25, pointerId: 1 });
  expect(p.onTrim).toHaveBeenLastCalledWith('a', 'in', 1);
});

test('dragging a freeze frame’s end changes its hold', () => {
  const p = renderTimeline([clip('f', { kind: 'freeze', inS: 2, outS: 5 })]);
  const edge = screen.getByLabelText('Trim end of clip 1');
  fireEvent.pointerDown(edge, { clientX: 150, pointerId: 1 });
  fireEvent.pointerMove(edge, { clientX: 200, pointerId: 1 });
  expect(p.onFreezeLength).toHaveBeenLastCalledWith('f', 4);
  expect(screen.queryByLabelText('Trim start of clip 1')).toBeNull();
});

test('releasing a dragged media item over the track drops it between clips', () => {
  const p = renderTimeline([clip('a'), clip('b')], { draggingMediaId: 'm2' });
  fireEvent.pointerUp(screen.getByLabelText('Main track'), { clientX: 250, pointerId: 1 });
  expect(p.onDropMedia).toHaveBeenCalledWith('m2', 1);
});

test('the ruler seeks the player', () => {
  const player = { currentTime: 0, paused: true } as unknown as TimelinePlayer;
  renderTimeline([clip('a')], { player });
  fireEvent.pointerDown(screen.getByLabelText('Timeline ruler'), { clientX: 100, pointerId: 1 });
  expect(player.currentTime).toBe(2);
});

test('dropIndex counts the clips whose middle is left of t; tickStep keeps labels apart', () => {
  const laid = layoutClips([clip('a'), clip('b'), clip('c')]);
  expect(dropIndex(laid, 0)).toBe(0);
  expect(dropIndex(laid, 7)).toBe(2);
  expect(dropIndex(laid, 7, 'a')).toBe(1);
  expect(tickStep(50)).toBe(2);
  expect(tickStep(1)).toBe(120);
});
```

Create `src/components/MediaRail.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import type { MediaStatus } from '../state/useMedia';
import type { MediaRef } from '../timeline/model';
import { MediaRail, mediaStatusText } from './MediaRail';

const info = { width: 1920, height: 1080, fps: '60', codec: 'h264', duration: 65, hasAudio: true, audioTracks: [{ index: 0, label: 'Game', named: true, channels: 2 }] };
const status = (o: Partial<MediaStatus> = {}): MediaStatus => ({ url: 'u', proxied: false, proxyProgress: null, prepared: null, audioError: null, ...o });

test('status text shows preview progress, audio prep and audio failure', () => {
  expect(mediaStatusText(info, status({ proxyProgress: 0.42 }))).toBe('Preparing preview 42%');
  expect(mediaStatusText(info, status())).toBe('Preparing audio…');
  expect(mediaStatusText(info, status({ audioError: 'x' }))).toBe('Audio preview unavailable');
  expect(mediaStatusText(info, status({ prepared: [] }))).toBeNull();
  expect(mediaStatusText({ ...info, audioTracks: [] }, status())).toBeNull();
});

test('lists media; + appends, pressing starts a drag, Import clips opens the picker', () => {
  const media: MediaRef[] = [{ id: 'm1', path: 'C:\\v\\a.mp4', info }];
  const p = { onAdd: vi.fn(), onAppend: vi.fn(), onDragStart: vi.fn() };
  render(<MediaRail media={media} status={{ m1: status({ prepared: [] }) }} {...p} />);
  expect(screen.getByText('a.mp4')).toBeTruthy();
  expect(screen.getByText('1:05.0')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Add a.mp4 to the timeline' }));
  expect(p.onAppend).toHaveBeenCalledWith('m1');
  expect(p.onDragStart).not.toHaveBeenCalled();
  fireEvent.pointerDown(screen.getByText('a.mp4'));
  expect(p.onDragStart).toHaveBeenCalledWith('m1');
  fireEvent.click(screen.getByRole('button', { name: 'Import clips' }));
  expect(p.onAdd).toHaveBeenCalled();
});
```

Create `src/components/ClipInspector.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import type { TimelineClip } from '../timeline/model';
import { ClipInspector } from './ClipInspector';

const clip = (o: Partial<TimelineClip> = {}): TimelineClip => ({
  id: 'c', kind: 'video', mediaId: 'm', inS: 2, outS: 6, speed: 1, presetId: 'p', layers: [], mix: { tracks: [], duck: null }, captions: [], ...o,
});

test('a video clip edits speed and can be deleted', () => {
  const p = { onSpeed: vi.fn(), onFreezeLength: vi.fn(), onDelete: vi.fn() };
  render(<ClipInspector clip={clip()} name="a.mp4" {...p} />);
  expect(screen.getByText('0:02.0 – 0:06.0 of the source')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Speed'), { target: { value: '2' } });
  expect(p.onSpeed).toHaveBeenLastCalledWith(2);
  fireEvent.click(screen.getByRole('button', { name: 'Delete clip' }));
  expect(p.onDelete).toHaveBeenCalled();
});

test('a freeze frame edits its hold instead of speed', () => {
  const p = { onSpeed: vi.fn(), onFreezeLength: vi.fn(), onDelete: vi.fn() };
  render(<ClipInspector clip={clip({ kind: 'freeze', inS: 3, outS: 6 })} name="a.mp4" {...p} />);
  expect(screen.queryByLabelText('Speed')).toBeNull();
  fireEvent.change(screen.getByLabelText('Hold seconds'), { target: { value: '5' } });
  expect(p.onFreezeLength).toHaveBeenLastCalledWith(5);
});
```

Create `src/components/useEditorKeys.test.ts`:

```ts
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
  key('s');
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
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true }));
  expect(h.split).not.toHaveBeenCalled();
  rerender({ on: false });
  key('s');
  expect(h.split).not.toHaveBeenCalled();
  input.remove();
});
```

Create `src/state/useThumbnails.test.ts`:

```ts
import { renderHook, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { FakeBackend } from '../backend/fake';
import { layoutClips, type MediaRef, type TimelineClip } from '../timeline/model';
import { useThumbnails } from './useThumbnails';

const m: MediaRef = { id: 'm', path: 'C:/v/a.mp4', info: { width: 1920, height: 1080, fps: '60', codec: 'h264', duration: 30, hasAudio: false, audioTracks: [] } };
const clip = (id: string, inS: number): TimelineClip => ({ id, kind: 'video', mediaId: 'm', inS, outS: inS + 2, speed: 1, presetId: 'p', layers: [], mix: { tracks: [], duck: null }, captions: [] });

test('one thumbnail per media and whole second, shown through videoUrl', async () => {
  const b = new FakeBackend();
  b.thumbnail = vi.fn(async (_p: string, at: number) => `C:/cache/${at}.jpg`);
  b.videoUrl = (p: string) => `url:${p}`;
  const media = new Map([['m', m]]);
  const { result } = renderHook(() => useThumbnails(b, layoutClips([clip('a', 3.2), clip('b', 3.9), clip('c', 7)]), media));
  await waitFor(() => expect(result.current('m', 3.5)).toBe('url:C:/cache/3.jpg'));
  expect(result.current('m', 7)).toBe('url:C:/cache/7.jpg');
  expect(b.thumbnail).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 3: Run to see them fail**

Run: `npm test -- src/components/Timeline.test.tsx src/components/MediaRail.test.tsx src/components/ClipInspector.test.tsx src/components/useEditorKeys.test.ts src/state/useThumbnails.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 4: Write `src/components/useEditorKeys.ts`**

```ts
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

/** Space play · S split · Delete/Backspace remove · F freeze · I/O trim to playhead · ←/→ frame · Ctrl/Cmd+Z undo · Shift+Ctrl/Cmd+Z or Ctrl+Y redo. */
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
      } else if (k === 's') x.split();
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
```

- [ ] **Step 5: Write `src/state/useThumbnails.ts`**

```ts
import { useEffect, useRef, useState } from 'react';
import type { Backend } from '../backend/types';
import type { LaidClip, MediaRef } from '../timeline/model';

/** One thumbnail per clip at its in point, on whole seconds so trimming reuses cached frames. */
export function useThumbnails(backend: Backend, laid: LaidClip[], media: Map<string, MediaRef>) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const asked = useRef(new Set<string>());
  useEffect(() => {
    for (const { clip } of laid) {
      const m = media.get(clip.mediaId);
      if (!m) continue;
      const at = Math.floor(clip.inS);
      const key = `${m.id}@${at}`;
      if (asked.current.has(key)) continue;
      asked.current.add(key);
      backend.thumbnail(m.path, at).then(
        (p) => setUrls((u) => ({ ...u, [key]: backend.videoUrl(p) })),
        () => {}, // a missing thumbnail just leaves the clip plain
      );
    }
  }, [backend, laid, media]);
  return (mediaId: string, inS: number): string | null => urls[`${mediaId}@${Math.floor(inS)}`] ?? null;
}
```

- [ ] **Step 6: Write `src/components/ClipInspector.tsx`**

```tsx
import { formatTime } from '../state/trim';
import type { TimelineClip } from '../timeline/model';
import { NumberField } from './AudioMixer';

interface Props {
  clip: TimelineClip;
  name: string;
  onSpeed(speed: number): void;
  onFreezeLength(seconds: number): void;
  onDelete(): void;
}

export function ClipInspector({ clip, name, onSpeed, onFreezeLength, onDelete }: Props) {
  const freeze = clip.kind === 'freeze';
  return (
    <section className="panel clip-inspector">
      <h2>{freeze ? 'Freeze frame' : 'Clip'}</h2>
      <p className="clip-name">{name}</p>
      <p className="hint">{freeze ? `Frame at ${formatTime(clip.inS)}` : `${formatTime(clip.inS)} – ${formatTime(clip.outS)} of the source`}</p>
      {freeze ? (
        <label className="row">
          Hold <NumberField aria-label="Hold seconds" value={Math.round((clip.outS - clip.inS) * 100) / 100} onCommit={onFreezeLength} /> s
        </label>
      ) : (
        <label className="row">
          Speed <NumberField aria-label="Speed" value={clip.speed} onCommit={onSpeed} /> ×
        </label>
      )}
      <button className="danger" onClick={onDelete}>
        Delete clip
      </button>
    </section>
  );
}
```

- [ ] **Step 7: Write `src/components/MediaRail.tsx`**

```tsx
import type { MediaStatus } from '../state/useMedia';
import { baseName } from '../state/paths';
import { formatTime } from '../state/trim';
import type { MediaRef } from '../timeline/model';
import type { ClipInfo } from '../types';

interface Props {
  media: MediaRef[];
  status: Record<string, MediaStatus>;
  onAdd(): void;
  onAppend(mediaId: string): void;
  /** Pointer pressed on an item: the timeline takes the drop on release (HTML5 drag-and-drop is off on Windows). */
  onDragStart(mediaId: string): void;
}

export function mediaStatusText(info: ClipInfo, s: MediaStatus | undefined): string | null {
  if (!s) return null;
  if (s.proxyProgress !== null) return `Preparing preview ${Math.round(s.proxyProgress * 100)}%`;
  if (s.audioError) return 'Audio preview unavailable';
  if (info.audioTracks.length && !s.prepared) return 'Preparing audio…';
  return null;
}

export function MediaRail({ media, status, onAdd, onAppend, onDragStart }: Props) {
  return (
    <nav className="rail" aria-label="Media">
      <h2>Media</h2>
      <p className="rail-description">Drag a clip onto the timeline.</p>
      <ul className="list">
        {media.map((m) => {
          const note = mediaStatusText(m.info, status[m.id]);
          const name = baseName(m.path);
          return (
            <li
              key={m.id}
              className="media-item"
              onPointerDown={(e) => {
                e.preventDefault();
                onDragStart(m.id);
              }}
            >
              <span className="media-name">{name}</span>
              <span className="media-meta">{formatTime(m.info.duration)}</span>
              {note && <span className="media-meta">{note}</span>}
              <button aria-label={`Add ${name} to the timeline`} onPointerDown={(e) => e.stopPropagation()} onClick={() => onAppend(m.id)}>
                +
              </button>
            </li>
          );
        })}
      </ul>
      <button onClick={onAdd}>Import clips</button>
    </nav>
  );
}
```

- [ ] **Step 8: Write `src/components/Timeline.tsx`**

```tsx
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { formatTime } from '../state/trim';
import { projectDuration, type LaidClip, type TimelineClip } from '../timeline/model';
import type { TimelinePlayer } from '../timeline/player';

const DEFAULT_PPS = 50;
const ZOOM_STEP = 1.5;
const PPS_LIMITS = [0.5, 400] as const;
const TICK_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const MIN_TICK_PX = 70;
const MOVE_THRESHOLD_PX = 4;
const END_PAD_PX = 16;

interface Props {
  player: TimelinePlayer | null;
  laid: LaidClip[];
  nameOf(mediaId: string): string;
  thumbOf(clip: TimelineClip): string | null;
  selectedId: string | null;
  /** A media item pressed in the rail; released over the track, it is dropped here. */
  draggingMediaId: string | null;
  onSelect(id: string | null): void;
  /** Edge drag: `srcT` is the new in or out point in source seconds. */
  onTrim(id: string, edge: 'in' | 'out', srcT: number): void;
  onFreezeLength(id: string, seconds: number): void;
  onMove(id: string, toIndex: number): void;
  onDropMedia(mediaId: string, index: number): void;
  onAdd(): void;
}

type Drag =
  | { kind: 'seek' }
  | { kind: 'trim'; e: LaidClip; edge: 'in' | 'out'; x0: number }
  | { kind: 'move'; e: LaidClip; x0: number; moved: boolean };

/** Where a clip dropped at timeline time t lands: after every other clip whose middle is left of t. */
export function dropIndex(laid: LaidClip[], t: number, skipId?: string): number {
  return laid.filter((e) => e.clip.id !== skipId && e.startS + e.durS / 2 < t).length;
}

export const tickStep = (pps: number) => TICK_STEPS.find((s) => s * pps >= MIN_TICK_PX) ?? TICK_STEPS[TICK_STEPS.length - 1];

function markerTime(laid: LaidClip[], index: number, total: number, skipId?: string) {
  const others = laid.filter((e) => e.clip.id !== skipId);
  return others[index]?.startS ?? total;
}

export function Timeline(props: Props) {
  const { player, laid, selectedId, draggingMediaId } = props;
  const total = projectDuration(laid);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [pps, setPps] = useState(DEFAULT_PPS);
  const [fitted, setFitted] = useState(false);
  const [now, setNow] = useState(0);
  const [paused, setPaused] = useState(true);
  const [insertAt, setInsertAt] = useState<number | null>(null);

  // Fit the whole timeline to the view the first time there is something to fit (and on "Fit").
  useEffect(() => {
    const w = scrollRef.current?.clientWidth ?? 0;
    if (fitted || w <= 0 || total <= 0) return;
    setPps(Math.min(PPS_LIMITS[1], Math.max(PPS_LIMITS[0], (w - END_PAD_PX) / total)));
    setFitted(true);
  }, [total, fitted]);

  useEffect(() => {
    if (!player) return;
    let raf = 0;
    const tick = () => {
      setNow(player.currentTime);
      setPaused(player.paused);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [player]);

  const timeAt = (clientX: number) => {
    const r = contentRef.current!.getBoundingClientRect();
    return Math.min(total, Math.max(0, (clientX - r.left) / pps));
  };
  const capture = (e: PointerEvent<HTMLElement>) => contentRef.current?.setPointerCapture?.(e.pointerId);

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = { kind: 'seek' };
    capture(e);
    if (player) player.currentTime = timeAt(e.clientX);
  };
  const startClip = (entry: LaidClip) => (e: PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    drag.current = { kind: 'move', e: entry, x0: e.clientX, moved: false };
    capture(e);
  };
  const startEdge = (entry: LaidClip, edge: 'in' | 'out') => (e: PointerEvent<HTMLSpanElement>) => {
    e.stopPropagation();
    drag.current = { kind: 'trim', e: entry, edge, x0: e.clientX };
    capture(e);
  };

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) {
      if (draggingMediaId) setInsertAt(markerTime(laid, dropIndex(laid, timeAt(e.clientX)), total));
      return;
    }
    if (d.kind === 'seek') {
      if (player) player.currentTime = timeAt(e.clientX);
      return;
    }
    const dt = (e.clientX - d.x0) / pps;
    const c = d.e.clip;
    if (d.kind === 'trim') {
      if (c.kind === 'freeze') props.onFreezeLength(c.id, d.e.durS + dt);
      else props.onTrim(c.id, d.edge, (d.edge === 'in' ? c.inS : c.outS) + dt * c.speed);
      return;
    }
    if (!d.moved && Math.abs(e.clientX - d.x0) < MOVE_THRESHOLD_PX) return;
    d.moved = true;
    setInsertAt(markerTime(laid, dropIndex(laid, timeAt(e.clientX), c.id), total, c.id));
  };

  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    setInsertAt(null);
    if (!d) {
      if (draggingMediaId) props.onDropMedia(draggingMediaId, dropIndex(laid, timeAt(e.clientX)));
      return;
    }
    if (d.kind !== 'move') return;
    if (!d.moved) props.onSelect(d.e.clip.id);
    else props.onMove(d.e.clip.id, dropIndex(laid, timeAt(e.clientX), d.e.clip.id));
  };

  const step = tickStep(pps);
  const ticks: number[] = [];
  for (let t = 0; t <= total && ticks.length < 2000; t += step) ticks.push(t);

  return (
    <div className="tl">
      <div className="tl-toolbar">
        <button className="play" aria-label={paused ? 'Play' : 'Pause'} disabled={!player || !laid.length} onClick={() => player && (player.paused ? void player.play() : player.pause())}>
          {paused ? '▶' : '❚❚'}
        </button>
        <span className="tl-time">
          {formatTime(now)} / {formatTime(total)}
        </span>
        <span className="tl-zoom">
          <button aria-label="Zoom out" onClick={() => setPps((p) => Math.max(PPS_LIMITS[0], p / ZOOM_STEP))}>−</button>
          <button onClick={() => setFitted(false)}>Fit</button>
          <button aria-label="Zoom in" onClick={() => setPps((p) => Math.min(PPS_LIMITS[1], p * ZOOM_STEP))}>+</button>
        </span>
        <button onClick={props.onAdd}>Add clips</button>
      </div>
      <div ref={scrollRef} className="tl-scroll">
        <div ref={contentRef} className="tl-content" style={{ width: `max(100%, ${total * pps + END_PAD_PX}px)` }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
          <div className="tl-ruler" aria-label="Timeline ruler">
            {ticks.map((t) => (
              <span key={t} className="tl-tick" style={{ left: `${t * pps}px` }}>
                {formatTime(t)}
              </span>
            ))}
          </div>
          <div className="tl-track" aria-label="Main track">
            {laid.map((e, i) => {
              const thumb = props.thumbOf(e.clip);
              const freeze = e.clip.kind === 'freeze';
              return (
                <div
                  key={e.clip.id}
                  role="button"
                  tabIndex={0}
                  aria-pressed={e.clip.id === selectedId}
                  aria-label={`Clip ${i + 1}: ${props.nameOf(e.clip.mediaId)}`}
                  className={`tl-clip${freeze ? ' freeze' : ''}${e.clip.id === selectedId ? ' selected' : ''}`}
                  style={{ left: `${e.startS * pps}px`, width: `${Math.max(2, e.durS * pps)}px` }}
                  onPointerDown={startClip(e)}
                  onKeyDown={(k) => k.key === 'Enter' && props.onSelect(e.clip.id)}
                >
                  {thumb && <img className="tl-thumb" src={thumb} alt="" draggable={false} />}
                  <span className="tl-label">
                    {freeze ? 'Freeze' : props.nameOf(e.clip.mediaId)}
                    {!freeze && e.clip.speed !== 1 ? ` · ${e.clip.speed}×` : ''}
                  </span>
                  {!freeze && <span className="tl-handle in" aria-label={`Trim start of clip ${i + 1}`} onPointerDown={startEdge(e, 'in')} />}
                  <span className="tl-handle out" aria-label={`Trim end of clip ${i + 1}`} onPointerDown={startEdge(e, 'out')} />
                </div>
              );
            })}
            {insertAt !== null && <div className="tl-insert" style={{ left: `${insertAt * pps}px` }} />}
          </div>
          <div className="tl-playhead" style={{ left: `${now * pps}px` }} />
        </div>
      </div>
      <div className="hint">Space play · S split · Delete remove · F freeze · I/O trim to playhead · ←/→ frame · Ctrl+Z undo · drag clips to reorder, edges to trim</div>
    </div>
  );
}
```

- [ ] **Step 9: Run the tests**

Run: `npm test -- src/components src/state`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/components src/state/useThumbnails.ts src/state/useThumbnails.test.ts src/test/setup.ts
git commit -m "feat(ui): timeline track, media rail, clip inspector, editor shortcuts and thumbnails"
```

---

### Task 14: Wire the App to the project, player and timeline

**Files:**
- Modify: `src/App.tsx` (rewrite), `src/App.test.tsx` (rewrite), `src/styles.css`, `src/test/setup.ts`, `src/state/trim.ts`, `src/state/trim.test.ts`
- Delete: `src/components/TrimBar.tsx`, `src/components/TrimBar.test.tsx`, `src/components/useTrimKeys.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: the finished 2a editor. Library rail with Media/Presets tabs (collapse labels `Show library` / `Hide library` / `Resize library`); preview of the clip under the playhead; timeline with the selected clip's audio lanes; inspector (clip, captions, HUD, audio) above an always-mounted Export panel.

- [ ] **Step 1: Stub media playback in the test setup**

Append to `src/test/setup.ts`:

```ts
// jsdom has no media playback: play/pause only log "not implemented".
HTMLMediaElement.prototype.play = function play() {
  return Promise.resolve();
};
HTMLMediaElement.prototype.pause = function pause() {};
```

- [ ] **Step 2: Rewrite the App tests**

Replace `src/App.test.tsx` with:

```tsx
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { App } from './App';
import type { PreparedTrack } from './backend/types';
import { FakeBackend } from './backend/fake';
import { BUILTIN_PRESETS, duplicatePreset } from './presets/presets';

afterEach(() => localStorage.clear());

const tracks = ['Desktop Audio', 'Game', 'Discord'].map((label, index) => ({ index, label, named: true, channels: 2 }));

function makeBackend() {
  const b = new FakeBackend();
  b.probe = async () => ({ width: 1920, height: 1080, fps: '60', codec: 'hevc', duration: 10, hasAudio: true, audioTracks: tracks });
  b.videoUrl = (p: string) => `url:${p}`;
  return b;
}

async function openClipIn(b: FakeBackend, path = 'C:/v/clip.mp4', n = 1) {
  b.pickClips = async () => [path];
  fireEvent.click(screen.getByRole('button', { name: /Open clip|Add clips/ }));
  await screen.findByRole('button', { name: `Clip ${n}: ${path.split('/').pop()}` });
}

function stubBackend() {
  let drop: (paths: string[]) => void = () => {};
  const b = new FakeBackend();
  b.probe = async () => ({ width: 1920, height: 1080, fps: '60', codec: 'hevc', duration: 10, hasAudio: true, audioTracks: [] });
  b.videoUrl = (p: string) => `url:${p}`;
  b.makeProxy = () => new Promise<string>(() => {});
  b.onFileDrop = (cb) => {
    drop = cb;
    return () => {};
  };
  return { b, drop: (...p: string[]) => drop(p) };
}

/** A copy of the built-in preset without radius/border, so export assets need no OffscreenCanvas (jsdom has none). */
async function saveSimplePreset(b: FakeBackend) {
  const simple = { ...duplicatePreset(BUILTIN_PRESETS[0], 'u1'), layers: BUILTIN_PRESETS[0].layers.map((l) => ({ id: l.id, label: l.label, src: l.src, dst: l.dst, fit: l.fit })) };
  await b.savePreset(simple);
}
const pickUserPreset = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /WARDOGS – Default \(copy\)/ }));
};

test('shows the drop zone and the WARDOGS preset on launch', () => {
  render(<App backend={new FakeBackend()} />);
  expect(screen.getByRole('heading', { name: 'Drop a clip' })).toBeTruthy();
  expect(screen.getByRole('button', { name: /WARDOGS – Default/ })).toBeTruthy();
});

test('lists saved user presets and warns about broken ones', async () => {
  const b = new FakeBackend();
  await b.savePreset(duplicatePreset(BUILTIN_PRESETS[0], 'u1'));
  localStorage.setItem('socialfrag.fake.presets', JSON.stringify({ ...JSON.parse(localStorage.getItem('socialfrag.fake.presets')!), bad: '{' }));
  render(<App backend={b} />);
  await waitFor(() => expect(screen.getByRole('button', { name: /WARDOGS – Default \(copy\)/ })).toBeTruthy());
  expect(screen.getByText('bad.json: not valid JSON')).toBeTruthy();
});

test('dropping two files appends them in file-name order and exports both', async () => {
  const s = stubBackend();
  await saveSimplePreset(s.b);
  s.b.startExport = vi.fn(async (job) => ({ outputPath: job.outputPath, usedCpuFallback: false }));
  render(<App backend={s.b} />);
  await pickUserPreset();
  await act(async () => s.drop('C:/v/b.mp4', 'C:/v/a.mp4'));
  expect(await screen.findByRole('button', { name: 'Clip 1: a.mp4' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Clip 2: b.mp4' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  await waitFor(() => expect(s.b.startExport).toHaveBeenCalled());
  const job = (s.b.startExport as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(job.clips.map((c: { source: string }) => c.source)).toEqual(['C:/v/a.mp4', 'C:/v/b.mp4']);
  expect(job.outputPath).toBe('C:/v/a_vertical.mp4');
});

test('a clip the webview cannot play shows a preview percentage while its proxy encodes', async () => {
  const s = stubBackend();
  let report: (f: number) => void = () => {};
  s.b.makeProxy = (_p, _d, _keep, onProgress) => {
    report = onProgress ?? (() => {});
    return new Promise<string>(() => {});
  };
  const { container } = render(<App backend={s.b} />);
  await act(async () => s.drop('A.mp4'));
  await waitFor(() => expect(container.querySelector('video.player-a')?.getAttribute('src')).toBe('url:A.mp4'));
  fireEvent.error(container.querySelector('video.player-a')!);
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Preparing preview'));
  await act(async () => report(0.42));
  expect(screen.getByRole('status').textContent).toContain('42%');
  expect((screen.getByLabelText('Preview progress') as HTMLProgressElement).value).toBeCloseTo(0.42);
});

test('S splits the clip at the playhead, Ctrl+Z undoes it, Delete removes the selected clip', async () => {
  const b = makeBackend();
  render(<App backend={b} />);
  await openClipIn(b);
  fireEvent.pointerDown(screen.getByLabelText('Timeline ruler'), { clientX: 250, pointerId: 1 }); // 5 s at 50 px/s
  fireEvent.pointerUp(screen.getByLabelText('Timeline ruler'), { clientX: 250, pointerId: 1 });
  fireEvent.keyDown(window, { key: 's' });
  expect(await screen.findByRole('button', { name: 'Clip 2: clip.mp4' })).toBeTruthy();
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Clip 2: clip.mp4' })).toBeNull());
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true });
  const second = await screen.findByRole('button', { name: 'Clip 2: clip.mp4' });
  fireEvent.pointerDown(second, { clientX: 300, pointerId: 1 });
  fireEvent.pointerUp(second, { clientX: 300, pointerId: 1 });
  fireEvent.keyDown(window, { key: 'Delete' });
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Clip 2: clip.mp4' })).toBeNull());
  expect(screen.getByRole('button', { name: 'Clip 1: clip.mp4' })).toBeTruthy();
});

test('export panel stays mounted (hidden) while the preset editor is open', async () => {
  const s = stubBackend();
  const { container } = render(<App backend={s.b} />);
  await act(async () => s.drop('A.mp4'));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Export' })).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Edit a copy' }));
  const side = container.querySelector('aside.side') as HTMLElement;
  expect(side).toBeTruthy();
  expect(side.hidden).toBe(true);
});

test('opening a clip resolves the smart default mix', async () => {
  const b = makeBackend();
  render(<App backend={b} />);
  await openClipIn(b);
  expect(await screen.findByRole('button', { name: 'Restore Desktop Audio' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Remove Game' })).toBeTruthy();
});

test('switching presets does not re-register the file-drop listener', async () => {
  const b = makeBackend();
  await b.savePreset(duplicatePreset(BUILTIN_PRESETS[0], 'u1'));
  const onFileDrop = vi.spyOn(b, 'onFileDrop');
  render(<App backend={b} />);
  await waitFor(() => expect(screen.getByRole('button', { name: /WARDOGS – Default \(copy\)/ })).toBeTruthy());
  expect(onFileDrop).toHaveBeenCalledTimes(1);
  await pickUserPreset();
  await waitFor(() => expect(screen.getByRole('button', { name: /WARDOGS – Default \(copy\)/ }).className).toContain('selected'));
  expect(onFileDrop).toHaveBeenCalledTimes(1);
});

test('re-saving the selected preset unchanged does not reset an in-progress gain edit', async () => {
  const b = makeBackend();
  await b.savePreset(duplicatePreset(BUILTIN_PRESETS[0], 'u1'));
  render(<App backend={b} />);
  await pickUserPreset();
  await openClipIn(b);
  const gainInput = (await screen.findByLabelText('Desktop Audio gain %')) as HTMLInputElement;
  fireEvent.change(gainInput, { target: { value: '150' } });
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Save preset' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Save preset' })).toBeNull());
  expect((screen.getByLabelText('Desktop Audio gain %') as HTMLInputElement).value).toBe('150');
});

test('a failed prepareAudio clears a duck config carried from the preset, so export matches the UI', async () => {
  const b = makeBackend();
  await b.savePreset({
    ...duplicatePreset(BUILTIN_PRESETS[0], 'u-duck'),
    audio: {
      tracks: [{ label: 'Discord', enabled: true, gain: 1, ceilingDb: null, offsetS: 0 }],
      duck: { targets: ['Game'], triggers: ['Discord'], amountDb: -10, thresholdDb: -40, releaseS: 0.4 },
    },
  });
  let rejectPrepare!: (e: Error) => void;
  b.prepareAudio = vi.fn(() => new Promise<PreparedTrack[]>((_resolve, reject) => (rejectPrepare = reject)));
  render(<App backend={b} />);
  await pickUserPreset();
  await openClipIn(b);
  await waitFor(() => expect((screen.getByLabelText('Duck') as HTMLInputElement).checked).toBe(true));
  await act(async () => rejectPrepare(new Error('x')));
  await screen.findByText('Audio preview unavailable : export still uses your mix.');
  await waitFor(() => expect((screen.getByLabelText('Duck') as HTMLInputElement).checked).toBe(false));
});

test('picking a different preset for the selected clip re-resolves its mix', async () => {
  const b = makeBackend();
  await b.savePreset(duplicatePreset(BUILTIN_PRESETS[0], 'u1'));
  render(<App backend={b} />);
  await openClipIn(b);
  const gainInput = (await screen.findByLabelText('Desktop Audio gain %')) as HTMLInputElement;
  fireEvent.change(gainInput, { target: { value: '150' } });
  await pickUserPreset();
  await waitFor(() => expect((screen.getByLabelText('Desktop Audio gain %') as HTMLInputElement).value).not.toBe('150'));
});

test('saving the mix to a preset keeps its entry for a label not in this clip', async () => {
  const b = makeBackend();
  await b.savePreset({ ...duplicatePreset(BUILTIN_PRESETS[0], 'u1'), audio: { tracks: [{ label: 'Other Clip Track', enabled: false, gain: 0.3, ceilingDb: null, offsetS: 0 }], duck: null } });
  b.savePreset = vi.fn(async () => {});
  render(<App backend={b} />);
  await pickUserPreset();
  await openClipIn(b);
  fireEvent.click(await screen.findByRole('button', { name: 'Save mix to preset' }));
  await waitFor(() => expect(b.savePreset).toHaveBeenCalled());
  const saved = (b.savePreset as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(saved.id).toBe('u1');
  expect(saved.audio.tracks).toContainEqual({ label: 'Other Clip Track', enabled: false, gain: 0.3, ceilingDb: null, offsetS: 0 });
  expect(saved.audio.tracks.map((t: { label: string }) => t.label)).toEqual(expect.arrayContaining(['Desktop Audio', 'Game', 'Discord']));
});

test('save mix to a built-in preset saves a copy with audio', async () => {
  const b = makeBackend();
  b.savePreset = vi.fn(async () => {});
  render(<App backend={b} />);
  await openClipIn(b);
  fireEvent.click(await screen.findByRole('button', { name: 'Save mix to preset' }));
  await waitFor(() => expect(b.savePreset).toHaveBeenCalled());
  const saved = (b.savePreset as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(saved.builtin).toBe(false);
  expect(saved.name).toMatch(/\(copy\)$/);
  expect(saved.audio.tracks.map((t: { label: string; enabled: boolean }) => [t.label, t.enabled])).toEqual([['Desktop Audio', false], ['Game', true], ['Discord', true]]);
});

test('save layout to preset on a built-in preset saves a copy with the hidden layer', async () => {
  const b = makeBackend();
  b.savePreset = vi.fn(async () => {});
  render(<App backend={b} />);
  await openClipIn(b);
  fireEvent.click(await screen.findByLabelText('Show Killfeed'));
  fireEvent.click(screen.getByRole('button', { name: 'Save layout to preset' }));
  await waitFor(() => expect(b.savePreset).toHaveBeenCalled());
  const saved = (b.savePreset as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(saved.builtin).toBe(false);
  expect(saved.layers.find((l: { id: string }) => l.id === 'killfeed').hidden).toBe(true);
});

test('toggling a HUD layer off is reflected in the exported clip', async () => {
  const b = makeBackend();
  await saveSimplePreset(b);
  b.startExport = vi.fn(async () => ({ outputPath: '/out.mp4', usedCpuFallback: false }));
  render(<App backend={b} />);
  await pickUserPreset();
  await openClipIn(b);
  fireEvent.click(await screen.findByLabelText('Show Killfeed'));
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  await waitFor(() => expect(b.startExport).toHaveBeenCalled());
  const job = (b.startExport as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(job.clips[0].preset.layers.find((l: { id: string }) => l.id === 'killfeed').hidden).toBe(true);
});

test('library rail and sidebar collapse to strips and expand again; sizes are remembered', async () => {
  localStorage.removeItem('socialfrag.layout');
  const s = stubBackend();
  const first = render(<App backend={s.b} />);
  await act(async () => s.drop('A.mp4'));
  await waitFor(() => expect(screen.getByRole('separator', { name: 'Resize sidebar' })).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Hide library' }));
  expect(screen.queryByRole('navigation', { name: 'Presets' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Hide sidebar' }));
  expect(screen.queryByRole('separator', { name: 'Resize sidebar' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Show library' }));
  expect(screen.getByRole('navigation', { name: 'Presets' })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize library' }), { key: 'ArrowRight' });
  first.unmount();

  const s2 = stubBackend();
  render(<App backend={s2.b} />);
  expect(screen.getByRole('separator', { name: 'Resize library' }).getAttribute('aria-valuenow')).toBe('276');
  await act(async () => s2.drop('A.mp4'));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Show sidebar' })).toBeTruthy());
  localStorage.removeItem('socialfrag.layout');
});

test('the Media tab lists imported files and + appends another clip of one', async () => {
  const b = makeBackend();
  render(<App backend={b} />);
  await openClipIn(b);
  fireEvent.click(screen.getByRole('tab', { name: 'Media' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add clip.mp4 to the timeline' }));
  expect(await screen.findByRole('button', { name: 'Clip 2: clip.mp4' })).toBeTruthy();
});
```

- [ ] **Step 3: Run to see them fail**

Run: `npm test -- src/App.test.tsx`
Expected: FAIL (no timeline clips, no `Hide library`, one `<video>` without `player-a`).

- [ ] **Step 4: Rewrite `src/App.tsx`**

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AudioPreview } from './audio/AudioPreview';
import { mergePresetAudio, resolveMix } from './audio/resolveMix';
import type { Backend, PreparedTrack } from './backend/types';
import { AudioLanes } from './components/AudioLanes';
import { AudioMixer } from './components/AudioMixer';
import { CaptionTool } from './components/CaptionTool';
import { ClipInspector } from './components/ClipInspector';
import { ExportPanel } from './components/ExportPanel';
import { HudPanel } from './components/HudPanel';
import { MediaRail } from './components/MediaRail';
import { PresetEditor } from './components/PresetEditor';
import { PresetRail } from './components/PresetRail';
import { PreviewCanvas } from './components/PreviewCanvas';
import { SettingsDialog } from './components/SettingsDialog';
import { Splitter } from './components/Splitter';
import { Timeline } from './components/Timeline';
import { useEditorKeys } from './components/useEditorKeys';
import { BUILTIN_PRESETS, blankPreset, duplicatePreset, loadUserPresets } from './presets/presets';
import { validatePreset } from './presets/validate';
import { updateCaption } from './state/captions';
import { COLLAPSED_W, DEFAULT_LAYOUT, LIMITS, loadLayout, safeStorage, saveLayout, type PanelLayout } from './state/layout';
import { baseName } from './state/paths';
import { AUDIO_UNAVAILABLE, useMedia } from './state/useMedia';
import { useThumbnails } from './state/useThumbnails';
import { makeCurveCache } from './timeline/curves';
import { clipAt, emptyProject, layoutClips, sourceTimeAt, type TimelineClip } from './timeline/model';
import {
  addMedia, applyPreset, applyPresetToClip, insertClips, insertFreeze, moveClip, newClip, rippleDelete, setFreezeLength, setSpeed, splitAt, trimClip, updateClip,
} from './timeline/ops';
import { TimelinePlayer, type PlayerClip } from './timeline/player';
import { audioSegments } from './timeline/segments';
import { useHistory } from './timeline/useHistory';
import type { AudioMix, Caption, Layer, Preset } from './types';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const NO_ENVELOPES = new Map<number, Float32Array>();
const uuid = () => crypto.randomUUID();
const ALL_PARTS = { layers: true, audio: true };

export function App({ backend }: { backend: Backend }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [userPresets, setUserPresets] = useState<Preset[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  /** Preset for newly added clips: the last one picked in the rail. */
  const [lastPresetId, setLastPresetId] = useState(BUILTIN_PRESETS[0].id);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedCaptionId, setSelectedCaptionId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Preset | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [railTab, setRailTab] = useState<'media' | 'presets'>('presets');
  const [previewAudioError, setPreviewAudioError] = useState<string | null>(null);
  const [mediaDrag, setMediaDrag] = useState<string | null>(null);
  const history = useHistory(emptyProject);
  const project = history.present;
  const edit = history.set;
  const replace = history.replace;

  const allPresets = useMemo(() => [...BUILTIN_PRESETS, ...userPresets], [userPresets]);
  const presetById = useCallback((id: string) => allPresets.find((p) => p.id === id) ?? BUILTIN_PRESETS[0], [allPresets]);
  // importPaths reads this instead of depending on the preset, so switching presets doesn't tear down and
  // re-register the (async) onFileDrop listener and drop a file dragged in that gap.
  const lastPresetRef = useRef(presetById(lastPresetId));
  useEffect(() => {
    lastPresetRef.current = presetById(lastPresetId);
  }, [presetById, lastPresetId]);

  const refreshPresets = useCallback(async () => {
    const loaded = loadUserPresets(await backend.listUserPresets());
    setUserPresets(loaded.presets);
    setWarnings(loaded.warnings);
  }, [backend]);
  useEffect(() => {
    void refreshPresets();
  }, [refreshPresets]);

  const onAudioFailed = useCallback(
    (mediaId: string) =>
      // Ducking needs envelopes from prepareAudio; without them the export has no duck curve, so match the UI.
      replace((p) => ({ ...p, main: p.main.map((c) => (c.mediaId === mediaId && c.mix.duck ? { ...c, mix: { ...c.mix, duck: null } } : c)) })),
    [replace],
  );
  const media = useMedia(backend, onAudioFailed, setError);
  const mediaById = useMemo(() => new Map(project.media.map((m) => [m.id, m])), [project.media]);
  const laid = useMemo(() => layoutClips(project.main), [project.main]);
  const selected = project.main.find((c) => c.id === selectedId) ?? null;
  const selectedMedia = selected ? (mediaById.get(selected.mediaId) ?? null) : null;
  const durationOf = (c: TimelineClip) => mediaById.get(c.mediaId)?.info.duration ?? 0;
  const tracksOf = (c: TimelineClip) => mediaById.get(c.mediaId)?.info.audioTracks ?? [];

  // --- playback: two hidden video elements driven by the timeline player
  const [elA, setElA] = useState<HTMLVideoElement | null>(null);
  const [elB, setElB] = useState<HTMLVideoElement | null>(null);
  const [player, setPlayer] = useState<TimelinePlayer | null>(null);
  useEffect(() => {
    if (!elA || !elB) return;
    const p = new TimelinePlayer(elA, elB);
    setPlayer(p);
    return () => {
      p.dispose();
      setPlayer(null);
    };
  }, [elA, elB]);
  const [active, setActive] = useState<{ index: number; el: HTMLVideoElement | null }>({ index: -1, el: null });
  const { onPlaybackError, mediaIdForUrl } = media;
  useEffect(() => {
    if (!player) return;
    const onClip = () => setActive({ index: player.clipIndex, el: player.activeElement as HTMLVideoElement });
    const onMediaError = (e: Event) => {
      const id = mediaIdForUrl((e as CustomEvent<string>).detail);
      if (id) onPlaybackError(id);
    };
    player.addEventListener('clipchange', onClip);
    player.addEventListener('mediaerror', onMediaError);
    let raf = 0;
    const tick = () => {
      player.tick();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      player.removeEventListener('clipchange', onClip);
      player.removeEventListener('mediaerror', onMediaError);
      cancelAnimationFrame(raf);
    };
  }, [player, onPlaybackError, mediaIdForUrl]);
  const playerClips = useMemo<PlayerClip[]>(
    () => laid.map((e) => ({ id: e.clip.id, kind: e.clip.kind, url: media.status[e.clip.mediaId]?.url ?? '', inS: e.clip.inS, startS: e.startS, durS: e.durS, speed: e.clip.speed })),
    [laid, media.status],
  );
  const playerKey = JSON.stringify(playerClips);
  useEffect(() => {
    player?.setClips(playerClips);
    // playerKey (not playerClips) is the intended dependency: proxy progress rebuilds the array without changing it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player, playerKey]);
  const activeEntry = laid[active.index] ?? null;
  const activeMedia = activeEntry ? (mediaById.get(activeEntry.clip.mediaId) ?? null) : null;
  const activeVideo = activeEntry ? active.el : null;
  const now = () => player?.currentTime ?? 0;

  // --- preview audio: one segment per clip per enabled track
  const envCache = useRef(new WeakMap<PreparedTrack[], Map<number, Float32Array>>());
  const envelopesOf = useCallback(
    (mediaId: string) => {
      const prepared = media.status[mediaId]?.prepared;
      if (!prepared) return null;
      let m = envCache.current.get(prepared);
      if (!m) {
        m = new Map(prepared.map((t) => [t.index, t.envelope]));
        envCache.current.set(prepared, m);
      }
      return m;
    },
    [media.status],
  );
  const curveCache = useMemo(() => makeCurveCache(), []);
  const curvesOf = useCallback((c: TimelineClip) => curveCache(c, mediaById.get(c.mediaId)?.info.duration ?? 0, envelopesOf(c.mediaId)), [curveCache, mediaById, envelopesOf]);
  const [audioPreview, setAudioPreview] = useState<AudioPreview | null>(null);
  useEffect(() => {
    if (!player) return;
    let p: AudioPreview;
    try {
      p = new AudioPreview(player, (path, start, frames) => backend.readPcm(path, start, frames), undefined, () => setPreviewAudioError(AUDIO_UNAVAILABLE));
    } catch {
      setPreviewAudioError(AUDIO_UNAVAILABLE);
      return;
    }
    setAudioPreview(p);
    return () => {
      p.dispose();
      setAudioPreview(null);
    };
  }, [player, backend]);
  useEffect(() => {
    audioPreview?.setSegments(audioSegments(laid, (id) => media.status[id]?.prepared ?? null, (c) => curvesOf(c).timeline));
  }, [audioPreview, laid, media.status, curvesOf]);

  // --- importing
  const selectClip = useCallback((id: string | null) => {
    setSelectedId(id);
    setSelectedCaptionId(null);
  }, []);
  const importMedia = media.importPaths;
  const importPaths = useCallback(
    async (paths: string[], at?: number) => {
      if (!paths.length) return;
      setError(null);
      setBusy('Opening clip');
      try {
        const refs = await importMedia(paths);
        if (!refs.length) return;
        const clips = refs.map((m) => newClip(uuid(), m, lastPresetRef.current));
        edit((p) => insertClips(addMedia(p, refs), at ?? p.main.length, clips));
        selectClip(clips[0].id);
      } finally {
        setBusy(null);
      }
    },
    [importMedia, edit, selectClip],
  );
  useEffect(() => backend.onFileDrop((paths) => void importPaths(paths)), [backend, importPaths]);
  async function addClips() {
    await importPaths(await backend.pickClips());
  }
  function appendMedia(mediaId: string, at?: number) {
    const m = mediaById.get(mediaId);
    if (!m) return;
    const c = newClip(uuid(), m, lastPresetRef.current);
    edit((p) => insertClips(p, at ?? p.main.length, [c]));
    selectClip(c.id);
  }
  useEffect(() => {
    if (!mediaDrag) return;
    const end = () => setMediaDrag(null);
    window.addEventListener('pointerup', end);
    return () => window.removeEventListener('pointerup', end);
  }, [mediaDrag]);

  // --- editing
  const setMix = (id: string, mix: AudioMix) => edit((p) => updateClip(p, id, { mix }), `mix:${id}`);
  const setLayer = (id: string, layer: Layer, key: string | null) =>
    edit((p) => updateClip(p, id, { layers: (p.main.find((c) => c.id === id)?.layers ?? []).map((l) => (l.id === layer.id ? layer : l)) }), key);
  const setCaptions = (id: string, captions: Caption[]) => edit((p) => updateClip(p, id, { captions }), `captions:${id}`);
  function trimAtPlayhead(edge: 'in' | 'out') {
    const t = now();
    const e = clipAt(laid, t);
    if (!e || e.clip.kind !== 'video') return;
    edit((p) => trimClip(p, e.clip.id, edge, sourceTimeAt(e, t), durationOf(e.clip)));
    if (edge === 'in' && player) player.currentTime = e.startS;
  }
  useEditorKeys(
    {
      togglePlay: () => {
        if (!player) return;
        if (player.paused) void player.play();
        else player.pause();
      },
      split: () => edit((p) => splitAt(p, now(), uuid())),
      remove: () => {
        if (!selectedId) return;
        edit((p) => rippleDelete(p, selectedId));
        selectClip(null);
      },
      freeze: () => edit((p) => insertFreeze(p, now(), uuid(), uuid())),
      setIn: () => trimAtPlayhead('in'),
      setOut: () => trimAtPlayhead('out'),
      step: (dir) => {
        if (!player) return;
        player.pause();
        player.currentTime = now() + dir / project.fps;
      },
      undo: history.undo,
      redo: history.redo,
    },
    draft === null && project.main.length > 0,
  );

  const onCaptionChange = (c: Caption) => {
    if (activeEntry) setCaptions(activeEntry.clip.id, updateCaption(activeEntry.clip.captions, c));
  };
  const onSelectCaption = (id: string | null) => {
    setSelectedCaptionId(id);
    if (id && activeEntry) setSelectedId(activeEntry.clip.id);
  };
  const onLayerChange = (layer: Layer) => {
    const c = activeEntry?.clip;
    if (!c) return;
    setSelectedId(c.id);
    setLayer(c.id, layer, `layers:${c.id}`);
  };

  // --- presets
  /**
   * After saving `saved` (previously `old`), clips on it pick up whichever half changed; clips in
   * `switchIds` move onto it, taking `switchParts`.
   */
  function applySaved(saved: Preset, old: Preset | undefined, switchIds: string[], switchParts = ALL_PARTS) {
    const layersChanged = !old || JSON.stringify(old.layers) !== JSON.stringify(saved.layers);
    const audioChanged = !old || JSON.stringify(old.audio ?? null) !== JSON.stringify(saved.audio ?? null);
    if (!switchIds.length && !layersChanged && !audioChanged) return;
    edit((p) => ({
      ...p,
      main: p.main.map((c) => {
        if (switchIds.includes(c.id) && c.presetId !== saved.id) return applyPresetToClip(c, tracksOf(c), saved, switchParts);
        if (c.presetId !== saved.id || (!layersChanged && !audioChanged)) return c;
        return applyPresetToClip(c, tracksOf(c), saved, { layers: layersChanged, audio: audioChanged });
      }),
    }));
  }
  function selectPreset(p: Preset) {
    setLastPresetId(p.id);
    if (selected && selected.presetId !== p.id) edit((x) => applyPreset(x, [selected.id], p));
  }
  const openEditor = (p: Preset) => {
    if (!activeEntry) {
      setError('Open a clip first so the editor has a frame to show.');
      return;
    }
    setDraft(p);
  };
  async function saveDraft() {
    if (!draft) return;
    const r = validatePreset(draft);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    const old = allPresets.find((p) => p.id === r.preset.id);
    await backend.savePreset(r.preset);
    await refreshPresets();
    setLastPresetId(r.preset.id);
    applySaved(r.preset, old, selectedId ? [selectedId] : []);
    setDraft(null);
  }
  async function deletePreset(id: string) {
    await backend.deletePreset(id);
    if (lastPresetId === id) setLastPresetId(BUILTIN_PRESETS[0].id);
    if (project.main.some((c) => c.presetId === id)) edit((p) => ({ ...p, main: p.main.map((c) => (c.presetId === id ? { ...c, presetId: BUILTIN_PRESETS[0].id } : c)) }));
    await refreshPresets();
  }
  async function importPreset() {
    const text = await backend.importPreset();
    if (text === null) return;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      setError('Import failed: not a JSON file.');
      return;
    }
    const r = validatePreset(raw);
    if (!r.ok) {
      setError(`Import failed: ${r.error}`);
      return;
    }
    const p = { ...r.preset, id: uuid(), builtin: false };
    await backend.savePreset(p);
    await refreshPresets();
    selectPreset(p);
  }
  async function savePresetFrom(target: Preset, old: Preset | undefined, parts: { layers: boolean; audio: boolean }) {
    if (!selected) return;
    const r = validatePreset(target);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    try {
      await backend.savePreset(r.preset);
      await refreshPresets();
      setLastPresetId(r.preset.id);
      applySaved(r.preset, old, [selected.id], parts);
    } catch (e) {
      setError(message(e));
    }
  }
  function saveMixToPreset() {
    if (!selected) return;
    const base = presetById(selected.presetId);
    const audio = mergePresetAudio(base.audio, selected.mix);
    void savePresetFrom(base.builtin ? { ...duplicatePreset(base, uuid()), audio } : { ...base, audio }, base.builtin ? undefined : base, { layers: false, audio: true });
  }
  function saveLayoutToPreset() {
    if (!selected) return;
    const base = presetById(selected.presetId);
    const withLayers = { ...base, layers: selected.layers };
    void savePresetFrom(base.builtin ? duplicatePreset(withLayers, uuid()) : withLayers, base.builtin ? undefined : base, { layers: true, audio: false });
  }

  // --- derived UI state
  const thumbAt = useThumbnails(backend, laid, mediaById);
  const status = selected ? media.status[selected.mediaId] : undefined;
  const audioNotice = selected && selectedMedia ? resolveMix(selectedMedia.info.audioTracks, presetById(selected.presetId)).notice : null;
  const blockedReason = project.main.some((c) => c.kind === 'video' && c.mix.duck && !media.status[c.mediaId]?.prepared && !media.status[c.mediaId]?.audioError) ? 'Preparing audio' : null;
  const proxying = Object.values(media.status).find((s) => s.proxyProgress !== null) ?? null;
  const notice = busy ?? (proxying ? 'Preparing preview' : null);
  const hasClips = project.main.length > 0;
  const sessionName = !hasClips ? 'Your next highlight starts here' : project.main.length === 1 ? baseName(mediaById.get(project.main[0].mediaId)?.path ?? '') : `${project.main.length} clips`;
  const selectedIsActive = !!selected && activeEntry?.clip.id === selected.id;

  const [winH, setWinH] = useState(() => window.innerHeight);
  const [layout, setLayout] = useState<PanelLayout>(() => loadLayout(safeStorage(), window.innerHeight));
  useEffect(() => {
    const onResize = () => setWinH(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useEffect(() => saveLayout(safeStorage(), layout), [layout]);
  const patchLayout = (p: Partial<PanelLayout>) => setLayout((l) => ({ ...l, ...p }));
  const timelineMax = Math.max(LIMITS.timelineMin, winH * LIMITS.timelineMaxFrac);
  const timelineH = Math.min(layout.timelineH, timelineMax);
  const showSide = hasClips && draft === null;
  const railCol = layout.railCollapsed ? `${COLLAPSED_W}px` : `${layout.railW}px 6px`;
  const sideCol = !showSide ? '' : layout.sideCollapsed ? `${COLLAPSED_W}px` : `6px ${layout.sideW}px`;

  return (
    <div className="workspace">
      <header className="app-header">
        <div className="brand">
          SocialFrag<span className="brand-slash" aria-hidden="true">/</span>
        </div>
        <span className="workspace-label">CLIP STUDIO</span>
        <div className="session-name">{sessionName}</div>
        <span className="format-badge">
          9:16 <span>VERTICAL</span>
        </span>
        <button className="link" onClick={() => setShowSettings(true)}>
          Settings
        </button>
      </header>
      <div className="app" style={{ gridTemplateColumns: `${railCol} minmax(0, 1fr) ${sideCol}` }}>
        {layout.railCollapsed ? (
          <div className="collapsed-strip">
            <button aria-label="Show library" onClick={() => patchLayout({ railCollapsed: false })}>
              »
            </button>
          </div>
        ) : (
          <>
            <div className="pane">
              <button className="collapse" aria-label="Hide library" onClick={() => patchLayout({ railCollapsed: true })}>
                «
              </button>
              <div className="rail-stack">
                <div className="rail-tabs" role="tablist" aria-label="Library">
                  <button role="tab" aria-selected={railTab === 'media'} className={railTab === 'media' ? 'selected' : ''} onClick={() => setRailTab('media')}>
                    Media
                  </button>
                  <button role="tab" aria-selected={railTab === 'presets'} className={railTab === 'presets' ? 'selected' : ''} onClick={() => setRailTab('presets')}>
                    Presets
                  </button>
                </div>
                {railTab === 'presets' ? (
                  <PresetRail
                    presets={allPresets}
                    selectedId={selected?.presetId ?? lastPresetId}
                    warnings={warnings}
                    onSelect={(id) => selectPreset(presetById(id))}
                    onNew={() => openEditor(blankPreset(uuid()))}
                    onEditCopy={(p) => openEditor(duplicatePreset(p, uuid()))}
                    onEdit={(p) => openEditor(structuredClone(p))}
                    onDelete={(id) => void deletePreset(id)}
                    onImport={() => void importPreset()}
                    onExport={(p) => void backend.exportPreset(p)}
                  />
                ) : (
                  <MediaRail media={project.media} status={media.status} onAdd={() => void addClips()} onAppend={(id) => appendMedia(id)} onDragStart={setMediaDrag} />
                )}
              </div>
            </div>
            <Splitter orientation="vertical" label="Resize library" value={layout.railW} min={LIMITS.railW[0]} max={LIMITS.railW[1]} direction={1} onChange={(v) => patchLayout({ railW: v })} onReset={() => patchLayout({ railW: DEFAULT_LAYOUT.railW })} />
          </>
        )}
        <main className={`stage${hasClips ? '' : ' empty'}`}>
          <video ref={setElA} className="source-video player-a" preload="auto" />
          <video ref={setElB} className="source-video player-b" preload="auto" />
          {hasClips ? (
            draft && activeMedia ? (
              <PresetEditor video={activeVideo} info={activeMedia.info} preset={draft} onChange={setDraft} onSave={() => void saveDraft()} onCancel={() => setDraft(null)} />
            ) : (
              <div className="stage-body" style={{ gridTemplateRows: `minmax(0, 1fr) 6px ${timelineH}px` }}>
                <div className="preview-box">
                  {activeEntry && activeMedia && (
                    <PreviewCanvas
                      video={activeVideo}
                      info={activeMedia.info}
                      preset={{ ...presetById(activeEntry.clip.presetId), layers: activeEntry.clip.layers }}
                      captions={activeEntry.clip.captions}
                      selectedCaptionId={selectedCaptionId}
                      onSelectCaption={onSelectCaption}
                      onCaptionChange={onCaptionChange}
                      onLayerChange={onLayerChange}
                    />
                  )}
                </div>
                <Splitter orientation="horizontal" label="Resize timeline" value={timelineH} min={LIMITS.timelineMin} max={timelineMax} direction={-1} onChange={(v) => patchLayout({ timelineH: v })} onReset={() => patchLayout({ timelineH: DEFAULT_LAYOUT.timelineH })} />
                <div className="timeline">
                  <Timeline
                    player={player}
                    laid={laid}
                    nameOf={(id) => baseName(mediaById.get(id)?.path ?? '')}
                    thumbOf={(c) => thumbAt(c.mediaId, c.inS)}
                    selectedId={selectedId}
                    draggingMediaId={mediaDrag}
                    onSelect={selectClip}
                    onTrim={(id, edge, srcT) => {
                      const c = project.main.find((x) => x.id === id);
                      if (c) edit((p) => trimClip(p, id, edge, srcT, durationOf(c)), `trim:${id}:${edge}`);
                    }}
                    onFreezeLength={(id, s) => edit((p) => setFreezeLength(p, id, s), `hold:${id}`)}
                    onMove={(id, i) => edit((p) => moveClip(p, id, i))}
                    onDropMedia={(id, i) => appendMedia(id, i)}
                    onAdd={() => void addClips()}
                  />
                  {selected?.kind === 'video' && selectedMedia && (
                    <AudioLanes
                      video={selectedIsActive ? activeVideo : null}
                      info={selectedMedia.info}
                      trim={{ inS: selected.inS, outS: selected.outS }}
                      mix={selected.mix}
                      envelopes={envelopesOf(selected.mediaId) ?? NO_ENVELOPES}
                      onChange={(mix) => setMix(selected.id, mix)}
                    />
                  )}
                </div>
              </div>
            )
          ) : (
            <div className="welcome">
              <p className="welcome-label">GOOD PLAYS DESERVE AN AUDIENCE</p>
              <h1>
                Make the play.
                <br />
                <span>Own the feed.</span>
              </h1>
              <p className="welcome-copy">
                Turn your gameplay into vertical highlights.
                <br />
                Keep the action, the HUD, and your voice.
              </p>
              <div className="dropzone">
                <span className="upload-symbol" aria-hidden="true">
                  ↑
                </span>
                <h2>Drop a clip</h2>
                <p>Drag your gameplay recordings here to get started</p>
                <button className="primary" onClick={() => void addClips()}>
                  Open clip <span aria-hidden="true">↗</span>
                </button>
              </div>
              <div className="workflow" aria-label="Editing workflow">
                <span>
                  <b>01</b> Pick a layout
                </span>
                <span>
                  <b>02</b> Make your cut
                </span>
                <span>
                  <b>03</b> Export your highlight
                </span>
              </div>
            </div>
          )}
          {notice && (
            <div className="notice" role="status">
              {notice}
              {!busy && proxying && (
                <span className="notice-progress">
                  <progress value={proxying.proxyProgress ?? 0} max={1} aria-label="Preview progress" />
                  <span>{Math.round((proxying.proxyProgress ?? 0) * 100)}%</span>
                </span>
              )}
            </div>
          )}
          {error && (
            <div className="notice error" role="alert">
              {error} <button onClick={() => setError(null)}>Dismiss</button>
            </div>
          )}
        </main>
        {showSide && !layout.sideCollapsed && (
          <Splitter orientation="vertical" label="Resize sidebar" value={layout.sideW} min={LIMITS.sideW[0]} max={LIMITS.sideW[1]} direction={-1} onChange={(v) => patchLayout({ sideW: v })} onReset={() => patchLayout({ sideW: DEFAULT_LAYOUT.sideW })} />
        )}
        {showSide && layout.sideCollapsed && (
          <div className="collapsed-strip">
            <button aria-label="Show sidebar" onClick={() => patchLayout({ sideCollapsed: false })}>
              «
            </button>
          </div>
        )}
        {hasClips && (
          // Stays mounted while editing presets or collapsed so a running export keeps its progress and Cancel button.
          <aside className="side" hidden={draft !== null || layout.sideCollapsed}>
            <button className="collapse" aria-label="Hide sidebar" onClick={() => patchLayout({ sideCollapsed: true })}>
              »
            </button>
            {selected && selectedMedia ? (
              <>
                <ClipInspector
                  clip={selected}
                  name={baseName(selectedMedia.path)}
                  onSpeed={(s) => edit((p) => setSpeed(p, selected.id, s), `speed:${selected.id}`)}
                  onFreezeLength={(s) => edit((p) => setFreezeLength(p, selected.id, s), `hold:${selected.id}`)}
                  onDelete={() => {
                    edit((p) => rippleDelete(p, selected.id));
                    selectClip(null);
                  }}
                />
                <CaptionTool captions={selected.captions} selectedId={selectedCaptionId} video={selectedIsActive ? activeVideo : null} onChange={(c) => setCaptions(selected.id, c)} onSelect={setSelectedCaptionId} />
                <HudPanel
                  layers={selected.layers}
                  onToggle={(l) => setLayer(selected.id, l, null)}
                  onReset={() => edit((p) => updateClip(p, selected.id, { layers: presetById(selected.presetId).layers }))}
                  onSave={saveLayoutToPreset}
                />
                {selected.kind === 'video' && (
                  <AudioMixer
                    mix={selected.mix}
                    notice={audioNotice}
                    previewError={status?.audioError ?? previewAudioError}
                    hasAudio={selectedMedia.info.audioTracks.length > 0}
                    canDuck={!!status?.prepared}
                    onChange={(mix) => setMix(selected.id, mix)}
                    onSaveToPreset={saveMixToPreset}
                  />
                )}
              </>
            ) : (
              <p className="hint">Select a clip on the timeline to edit it.</p>
            )}
            <ExportPanel backend={backend} project={project} presetById={presetById} curves={(c) => curvesOf(c).source} blockedReason={blockedReason} />
          </aside>
        )}
      </div>
      {showSettings && <SettingsDialog backend={backend} keep={media.paths} onClose={() => setShowSettings(false)} />}
    </div>
  );
}
```

`previewAudioError` is set when the webview has no `AudioContext` (the jsdom tests) as well as on repeated read failures; it only shows inside the Audio panel, where `AUDIO_UNAVAILABLE` is the right message in both cases.

- [ ] **Step 5: Styles**

Append to `src/styles.css`:

```css
/* library rail */
.rail-stack { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
.rail-stack > .rail { flex: 1; }
.rail-tabs { display: flex; gap: 4px; padding: 8px 12px 0; background: var(--panel); }
.rail-tabs button { flex: 1; }
.media-item { display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; align-items: center; padding: 6px 4px; border-bottom: 1px solid var(--line); cursor: grab; user-select: none; touch-action: none; }
.media-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.media-meta { grid-column: 1; font-size: 11px; color: var(--muted); }
.media-item button { grid-row: 1 / span 3; grid-column: 2; padding: 2px 8px; }

/* timeline */
.tl { width: 100%; display: flex; flex-direction: column; gap: 6px; }
.tl-toolbar { display: flex; align-items: center; gap: 10px; font-size: 12px; color: var(--muted); }
.tl-time { font-variant-numeric: tabular-nums; }
.tl-zoom { display: inline-flex; gap: 4px; margin-left: auto; }
.tl-scroll { overflow-x: auto; overflow-y: hidden; border: 1px solid var(--line); border-radius: 6px; background: rgba(255,255,255,.03); }
.tl-content { position: relative; height: 92px; touch-action: none; user-select: none; }
.tl-ruler { position: relative; height: 20px; border-bottom: 1px solid var(--line); cursor: pointer; }
.tl-tick { position: absolute; top: 3px; font-size: 10px; color: var(--muted); padding-left: 3px; border-left: 1px solid var(--line); }
.tl-track { position: relative; height: 64px; margin-top: 4px; }
.tl-clip { position: absolute; top: 0; bottom: 0; background: #2a3322; border: 1px solid #4c5d38; border-radius: 4px; overflow: hidden; cursor: grab; }
.tl-clip.selected { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.tl-clip.freeze { background: repeating-linear-gradient(45deg, #26303a 0 6px, #202830 6px 12px); border-color: #4a6178; }
.tl-thumb { position: absolute; left: 0; top: 0; height: 100%; opacity: .55; pointer-events: none; }
.tl-label { position: relative; display: block; padding: 4px 10px; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none; }
.tl-handle { position: absolute; top: 0; bottom: 0; width: 8px; cursor: ew-resize; background: rgba(196, 243, 107, .0); }
.tl-handle:hover { background: rgba(196, 243, 107, .5); }
.tl-handle.in { left: 0; }
.tl-handle.out { right: 0; }
.tl-insert { position: absolute; top: -4px; bottom: -4px; width: 3px; margin-left: -1px; background: var(--accent); pointer-events: none; }
.tl-playhead { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: var(--text); pointer-events: none; }
.clip-name { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

Remove the now-unused `.trim`, `.trim-bar`, `.trim-range`, `.trim-handle` and `.trim-times` rules.

- [ ] **Step 6: Delete what the timeline replaced**

```bash
git rm src/components/TrimBar.tsx src/components/TrimBar.test.tsx src/components/useTrimKeys.ts
```

In `src/state/trim.ts` delete `MIN_TRIM`, `clamp`, `fullTrim`, `setIn` and `setOut` (only `parseFps` and `formatTime` remain), and in `src/state/trim.test.ts` delete the tests for the removed functions.

- [ ] **Step 7: Run everything**

Run: `npm test && npm run build && npm run lint`
Expected: all tests PASS, build succeeds, no lint errors.

- [ ] **Step 8: Commit**

```bash
git add -A src
git commit -m "feat(timeline): multi-clip editor with timeline, A/B preview, undo and per-clip inspector"
```

---

### Task 15: Real-clip verification, the user's timeline check, tracker

**Files:**
- Modify: `project.md`

- [ ] **Step 1: Full automated run**

Run: `npm test && npm run build && npm run lint && cd src-tauri && cargo test`
Expected: everything PASS.

- [ ] **Step 2: Real ffmpeg tests**

With ffmpeg reachable (Mac: Homebrew on PATH; Windows: a folder holding the bundled `ffmpeg.exe`/`ffprobe.exe` in `SOCIALFRAG_FFMPEG_DIR`):

Run: `cd src-tauri && cargo test real_timeline_export -- --ignored --nocapture`
Expected: PASS.

Run: `cd src-tauri && SOCIALFRAG_CLIPS_DIR="<your OBS clips folder>" SOCIALFRAG_OUT_DIR="<scratch folder>" cargo test real_clip -- --ignored --nocapture --test-threads=1` (Mac: `SOCIALFRAG_CLIPS_DIR="../example clips"`)
Expected: PASS for every clip; one audio track each.

- [ ] **Step 3: Launch the app for the user's timeline check**

Run: `npm run tauri dev` (background). Ask the user to:
1. Drop one clip on the welcome screen and export it: same layout and mix as before; a Save dialog asks where (default `<clip>_vertical.mp4` next to it).
2. Drop three clips at once (for example two OBS replays and the 144 fps smoke-test clip): they appear in file-name order.
3. Play across the cuts: no black frame and no audio gap at a cut; audio stays in sync.
4. Press S mid-clip, Delete one half, drag a clip to a new place, drag an edge to trim, set Speed 2 on one clip, press F for a freeze frame. Undo each with Ctrl+Z and redo with Ctrl+Shift+Z.
5. Hide a HUD piece and add a caption on one clip only; the other clips keep their layout.
6. Export the timeline: one MP4, 1080×1920, cuts where the preview had them, audio pitch higher on the 2× clip, silence on the freeze frame.
7. Report pass/fail per step.

Do not claim success before the user reports back.

- [ ] **Step 4: Update the tracker and commit**

Only after the user confirms, in `project.md`:
- Now: `Timeline editor sub-project 2a (multi-clip timeline + cutting) merged; next: plan sub-project 2b (.sfproj save/load, autosave, recent projects, relink).` Remove the old "Sub-project 2 must pass every open media path as keep…" line (done in 2a).
- Done: `- 2026-MM-DD: Timeline editor 2a: multi-clip project with undo/redo, A/B timeline preview with streamed per-clip audio, split/ripple delete/trim/reorder/speed/freeze, media rail and thumbnails, one-run multi-clip export with a Save dialog; user timeline check passed` (use the real date).
- Next: remove the concurrent `prepare_audio` race item (audio prep is now serialised per app).

```bash
git add project.md
git commit -m "docs: tracker, timeline editor 2a shipped"
```
