# Landscape (16:9) Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a project-wide 9:16 / 16:9 format switch; 16:9 exports the full original frame (fit on black) at 1080p or 1440p, with captions at the same relative position.

**Architecture:** `Project.canvas` becomes the format. In landscape, a generated one-layer `fullFramePreset(canvas)` replaces the clip's preset in both preview and export, so the existing compose/filtergraph pipeline renders it unchanged. Captions move to canvas fractions and are converted to pixels (`toPx`) only at draw time. Rust accepts three canvases and validates preset layers against the job's canvas.

**Tech Stack:** Tauri 2, React 19, TypeScript 6, Vitest 5 (jsdom + node projects), Rust (serde, cargo test).

**Spec:** `docs/superpowers/specs/2026-09-28-landscape-export-design.md`

## Global Constraints

- Default format is 9:16 (1080×1920) on every launch.
- Allowed export canvases, exactly: 1080×1920, 1920×1080, 2560×1440. Anything else is refused by Rust.
- Landscape preview canvas is 1920×1080; landscape export canvas is 1920×1080 (1080p, default) or 2560×1440 (1440p).
- Full-frame layout: `background: { type: 'none' }`, one layer `{ id: 'gameplay', label: 'Gameplay', src: [0,0,1,1], dst: [0,0,w,h], fit: 'contain' }`.
- Captions: `x`, `y` = fractions of canvas width/height (centre); `fontSize` = fraction of canvas height. Defaults `x: 0.5`, `y: 260/1920`, `fontSize: 80/1920`. Font size clamp `24/1920 … 240/1920`. Wrap width = `960/1080` of canvas width.
- Default Save names: `<stem>_vertical.mp4` (9:16), `<stem>_landscape.mp4` (16:9); no clips → `SocialFrag_vertical.mp4` / `SocialFrag_landscape.mp4`.
- Copy, verbatim: switch labels "9:16 Vertical" / "16:9 Landscape"; rail note "Presets shape vertical exports. Switch to 9:16 to use them."; resolution legend "Resolution"; options "1080p" / "1440p"; hint "Upscales clips recorded at 1080p".
- Presets and the preset editor stay 9:16 only (`validatePreset` keeps checking against 1080×1920).
- Work and commit directly on `main`. No feature branches. No attribution lines in commits.
- Run `npm test` from the repo root and `cargo test` from `src-tauri/`. New `.ts` tests that need a DOM must be added to `DOM_TS_TESTS` in `vite.config.ts` (none in this plan do).

## Review Focus

1. Switching format with a caption selected mid-drag — the caption must keep its fractional position; covered by Task 2 (drag maths in fractions) and Task 4 (preview drag test in landscape).
2. A 4:3 or ultrawide source in landscape — must letterbox/pillarbox, never crop or stretch; covered by Task 1 (`fit: 'contain'`) and Task 6 (filtergraph test with a 4:3 source).
3. Undo after switching format — Ctrl+Z must restore 9:16 and the vertical preview; covered by Task 5 (`setCanvas` undo) and Task 7 (App test).
4. Exporting at 1440p — captions and borders must render at 2560×1440, not 1920×1080 scaled; covered by Task 3 (overlay canvas size) and Task 5 (job canvas).
5. Clicking the format switch while an export runs — must be disabled; covered by Task 7 (App test).

---

### Task 1: Canvas constants and the full-frame preset

**Files:**
- Modify: `src/types.ts:38-42`
- Modify: `src/presets/presets.ts`
- Test: `src/presets/presets.test.ts` (create if absent; node project)

**Interfaces:**
- Produces: `export interface Canvas { w: number; h: number }`, `VERTICAL_CANVAS`, `LANDSCAPE_CANVAS`, `LANDSCAPE_1440_CANVAS` (types.ts); `formatOf(c: Canvas): 'vertical' | 'landscape'` (types.ts); `fullFramePreset(canvas: Canvas): Preset` (presets.ts). `CANVAS_W`/`CANVAS_H` stay as aliases of the vertical size until Task 3 removes their last renderer uses.

- [ ] **Step 1: Write the failing test** — add to `src/presets/presets.test.ts`:

```ts
import { expect, test } from 'vitest';
import { LANDSCAPE_1440_CANVAS, LANDSCAPE_CANVAS, VERTICAL_CANVAS, formatOf } from '../types';
import { fullFramePreset } from './presets';

test('fullFramePreset fits the whole frame on black at the given canvas', () => {
  const p = fullFramePreset(LANDSCAPE_1440_CANVAS);
  expect(p.background).toEqual({ type: 'none' });
  expect(p.layers).toEqual([{ id: 'gameplay', label: 'Gameplay', src: [0, 0, 1, 1], dst: [0, 0, 2560, 1440], fit: 'contain' }]);
  expect(p.builtin).toBe(true);
});

test('formatOf', () => {
  expect(formatOf(VERTICAL_CANVAS)).toBe('vertical');
  expect(formatOf(LANDSCAPE_CANVAS)).toBe('landscape');
  expect(formatOf(LANDSCAPE_1440_CANVAS)).toBe('landscape');
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/presets/presets.test.ts` → FAIL (no export `fullFramePreset`).

- [ ] **Step 3: Implement.** In `src/types.ts` replace the two constant lines with:

```ts
export interface Canvas { w: number; h: number }
export const VERTICAL_CANVAS: Canvas = { w: 1080, h: 1920 };
export const LANDSCAPE_CANVAS: Canvas = { w: 1920, h: 1080 };
export const LANDSCAPE_1440_CANVAS: Canvas = { w: 2560, h: 1440 };
export const formatOf = (c: Canvas): 'vertical' | 'landscape' => (c.w > c.h ? 'landscape' : 'vertical');
/** Presets are laid out on the vertical canvas. */
export const CANVAS_W = VERTICAL_CANVAS.w;
export const CANVAS_H = VERTICAL_CANVAS.h;
```

Change `ExportJob.canvas` to `canvas: Canvas`. In `src/presets/presets.ts` add (import `Canvas`):

```ts
/** Landscape mode: the source frame as recorded, fitted whole on black. Never saved or listed. */
export function fullFramePreset(canvas: Canvas): Preset {
  return {
    id: 'builtin-full-frame', name: 'Full frame', game: '', version: 1, builtin: true,
    background: { type: 'none' },
    layers: [{ id: 'gameplay', label: 'Gameplay', src: [0, 0, 1, 1], dst: [0, 0, canvas.w, canvas.h], fit: 'contain' }],
  };
}
```

- [ ] **Step 4: Run** — `npx vitest run src/presets/presets.test.ts` → PASS; `npx tsc -b` → clean.
- [ ] **Step 5: Commit** — `git add src/types.ts src/presets/presets.ts src/presets/presets.test.ts && git commit -m "feat(format): canvas constants and full-frame preset"`

---

### Task 2: Captions in canvas fractions

**Files:**
- Modify: `src/types.ts` (Caption doc comment)
- Modify: `src/state/captions.ts`
- Modify: `src/render/captions.ts`
- Test: `src/state/captions.test.ts`, `src/render/captions.test.ts`

**Interfaces:**
- Consumes: `Canvas` (Task 1).
- Produces: `CaptionPx` (a `Caption` whose `x`/`y`/`fontSize` are canvas pixels, plus `maxW`); `toPx(c: Caption, canvas: Canvas): CaptionPx`; `captionLayout(ctx, c: CaptionPx)`, `drawCaption(ctx, c: CaptionPx)`, `hitCaption(ctx, captions: CaptionPx[], x, y)`, `drawCaptionSelection(ctx, c: CaptionPx)`; `moveCaption(c, dxFrac, dyFrac)`, `resizeCaption(c, dyFrac)`.

- [ ] **Step 1: Write the failing tests.** Replace the body of `src/state/captions.test.ts` tests for new/move/resize with:

```ts
test('newCaption defaults are canvas fractions', () => {
  expect(newCaption('a', 0, 'whole')).toMatchObject({ x: 0.5, y: 260 / 1920, fontSize: 80 / 1920 });
});

test('moveCaption clamps to 0..1', () => {
  const c = newCaption('a', 0, 'whole');
  expect(moveCaption(c, 5, -5)).toMatchObject({ x: 1, y: 0 });
});

test('resizeCaption changes font size by half the drag, clamped 24/1920..240/1920', () => {
  const c = { ...newCaption('a', 0, 'whole'), fontSize: 80 / 1920 };
  expect(resizeCaption(c, 20 / 1920).fontSize).toBeCloseTo(90 / 1920, 9);
  expect(resizeCaption(c, -1).fontSize).toBeCloseTo(24 / 1920, 9);
  expect(resizeCaption(c, 1).fontSize).toBeCloseTo(240 / 1920, 9);
});
```

Add to `src/render/captions.test.ts`:

```ts
import { toPx } from './captions';

test('toPx scales fractions to the canvas; font size follows height, wrap width follows width', () => {
  const c = { id: 'a', text: 'Hi', style: 'plain' as const, x: 0.5, y: 0.25, fontSize: 0.05, start: 0 };
  expect(toPx(c, { w: 1080, h: 1920 })).toMatchObject({ x: 540, y: 480, fontSize: 96, maxW: 960 });
  expect(toPx(c, { w: 1920, h: 1080 })).toMatchObject({ x: 960, y: 270, fontSize: 54, maxW: 1920 * (960 / 1080) });
});
```

In the existing `cap()` factory in `src/render/captions.test.ts` add `maxW: 960` and type it `CaptionPx`.

- [ ] **Step 2: Run** — `npx vitest run src/state/captions.test.ts src/render/captions.test.ts` → FAIL.

- [ ] **Step 3: Implement.** `src/types.ts` Caption comment becomes: `/** x/y = caption centre as fractions of canvas width/height; fontSize = fraction of canvas height. start = absolute clip seconds; shown until the end. */`

`src/state/captions.ts`:

```ts
import type { Caption } from '../types';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const FONT_MIN = 24 / 1920;
const FONT_MAX = 240 / 1920;

export function newCaption(id: string, currentTime: number, timing: 'whole' | 'fromHere'): Caption {
  return { id, text: 'Your caption', style: 'tiktok', x: 0.5, y: 260 / 1920, fontSize: 80 / 1920, start: timing === 'whole' ? 0 : currentTime };
}

export const updateCaption = (list: Caption[], c: Caption): Caption[] => list.map((x) => (x.id === c.id ? c : x));
export const removeCaption = (list: Caption[], id: string): Caption[] => list.filter((x) => x.id !== id);

/** dx/dy are fractions of canvas width/height. */
export const moveCaption = (c: Caption, dx: number, dy: number): Caption => ({ ...c, x: clamp(c.x + dx, 0, 1), y: clamp(c.y + dy, 0, 1) });

/** dy is a fraction of canvas height; the font grows by half of it. */
export const resizeCaption = (c: Caption, dy: number): Caption => ({ ...c, fontSize: clamp(c.fontSize + dy * 0.5, FONT_MIN, FONT_MAX) });
```

`src/render/captions.ts`: replace `export const CAPTION_MAX_W = 960;` with

```ts
/** Wrap width as a share of canvas width (960 px on the 1080-wide vertical canvas). */
export const CAPTION_MAX_W_FRAC = 960 / 1080;

/** A caption in canvas pixels, ready to draw. */
export interface CaptionPx extends Caption { maxW: number }

export const toPx = (c: Caption, canvas: Canvas): CaptionPx => ({
  ...c, x: c.x * canvas.w, y: c.y * canvas.h, fontSize: c.fontSize * canvas.h, maxW: canvas.w * CAPTION_MAX_W_FRAC,
});
```

Import `Canvas` from `../types`. In `captionLayout` use `c.maxW` instead of `CAPTION_MAX_W`. Change the parameter type `Caption` → `CaptionPx` in `captionLayout`, `drawCaption`, `hitCaption` (array), `drawCaptionSelection`.

- [ ] **Step 4: Run** — same command → PASS. `npx tsc -b` will now report errors in `compose.ts`, `exportAssets.ts`, `PreviewCanvas.tsx`; Task 3 and Task 4 fix them.
- [ ] **Step 5: Commit** — `git add src/types.ts src/state/captions.ts src/state/captions.test.ts src/render/captions.ts src/render/captions.test.ts && git commit -m "feat(captions): store positions as canvas fractions"`

---

### Task 3: Compose and export assets take the canvas

**Files:**
- Modify: `src/render/compose.ts`
- Modify: `src/render/exportAssets.ts`
- Test: `src/render/compose.test.ts`, `src/render/exportAssets.test.ts`

**Interfaces:**
- Consumes: `Canvas`, `VERTICAL_CANVAS` (Task 1); `toPx`, `CaptionPx` (Task 2).
- Produces: `drawBackground(ctx, frame, srcW, srcH, bg, canvas, kx?, ky?)`; `drawFrame(ctx, frame, srcW, srcH, preset, captions, t, canvas, frameW?, frameH?)`; `buildExportAssets(preset, clip, captions, canvas, make?)`.

- [ ] **Step 1: Write the failing tests.** In `src/render/compose.test.ts` pass `VERTICAL_CANVAS` as the new 8th argument to every existing `drawFrame` call, convert the caption literal to fractions (`x: 0.5, y: 200 / 1920, fontSize: 60 / 1920`), and add:

```ts
test('drawFrame on the landscape canvas fills black and draws captions at fraction × canvas', () => {
  const { ctx, named } = recordingCtx();
  const cap = { id: 'c', text: 'Hi', style: 'plain' as const, x: 0.5, y: 0.5, fontSize: 0.05, start: 0 };
  drawFrame(ctx, frame, 1440, 1080, fullFramePreset(LANDSCAPE_CANVAS), [cap], 1, LANDSCAPE_CANVAS);
  expect(named('fillRect')[0]).toEqual([0, 0, 1920, 1080]);
  expect(named('drawImage')).toEqual([[frame, 0, 0, 1440, 1080, 240, 0, 1440, 1080]]);
  expect(named('fillText')).toEqual([['Hi', 960, 540]]);
});
```

In `src/render/exportAssets.test.ts` pass `VERTICAL_CANVAS` as the 4th argument in existing calls, convert caption literals (`x: 0.5, y: 200 / 1920, fontSize: 80 / 1920`; the `y: 400` one → `400 / 1920`), and add:

```ts
test('captions render on the export canvas size (1440p landscape)', async () => {
  const { make, made } = fakeFactory();
  const cap: Caption = { id: 'a', text: 'GG', style: 'tiktok', x: 0.5, y: 0.1, fontSize: 0.05, start: 0 };
  await buildExportAssets(fullFramePreset(LANDSCAPE_1440_CANVAS), clip, [cap], LANDSCAPE_1440_CANVAS, make);
  expect(made).toEqual([[2560, 1440]]);
});
```

- [ ] **Step 2: Run** — `npx vitest run src/render` → FAIL.

- [ ] **Step 3: Implement.** In `compose.ts` remove the `CANVAS_H, CANVAS_W` import, add `canvas: Canvas` as described in Interfaces; replace every `CANVAS_W`/`CANVAS_H` with `canvas.w`/`canvas.h`; in `drawFrame` pass `canvas` to `drawBackground` and draw captions as `drawCaption(ctx, toPx(c, canvas))`. In `exportAssets.ts` add the `canvas: Canvas` parameter before `make`, use `make(canvas.w, canvas.h)` for the border and caption canvases, and `drawCaption(c.ctx, toPx(cap, canvas))`.

- [ ] **Step 4: Run** — `npx vitest run src/render` → PASS.
- [ ] **Step 5: Commit** — `git add src/render && git commit -m "feat(render): compose and export assets on any canvas"`

---

### Task 4: Preview canvas follows the project canvas

**Files:**
- Modify: `src/components/PreviewCanvas.tsx`
- Modify: `src/styles.css:49`
- Test: `src/components/PreviewCanvas.test.tsx`

**Interfaces:**
- Consumes: `Canvas`, `formatOf` (Task 1); `toPx` (Task 2); `drawFrame(..., canvas, ...)` (Task 3).
- Produces: `PreviewCanvas` prop `canvas: Canvas`; aria-label "Vertical preview" (vertical) / "Landscape preview" (landscape).

- [ ] **Step 1: Write the failing test.** In `PreviewCanvas.test.tsx` add `canvas={VERTICAL_CANVAS}` to `setup`'s render; convert the caption literal at line 80 to `x: 200 / 1080, y: 200 / 1920, fontSize: 60 / 1920` and its expected move result to fractions. Add:

```ts
test('landscape: labelled, sized 1920x1080, caption drag moves by canvas fractions', () => {
  const cap: Caption = { id: 'c1', text: 'Hi', style: 'plain', x: 0.5, y: 0.5, fontSize: 0.05, start: 0 };
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
```

- [ ] **Step 2: Run** — `npx vitest run src/components/PreviewCanvas.test.tsx` → FAIL.

- [ ] **Step 3: Implement.** Add `canvas: Canvas` to `Props` and to `latest.current`. Replace `CANVAS_W`/`CANVAS_H` with `canvas.w`/`canvas.h` everywhere. Pass `canvas` to `drawFrame`. Keep a pixel list for hit-testing: `const px = captions.map((c) => toPx(c, canvas));` and use it in `hitCaption(ctx, px, p.x, p.y)` and `drawCaptionSelection(ctx, toPx(sel, canvas))`. Caption drag:

```ts
onCaptionChange(d.mode === 'move' ? moveCaption(d.orig, (p.x - d.x) / canvas.w, (p.y - d.y) / canvas.h) : resizeCaption(d.orig, (p.y - d.y) / canvas.h));
```

Canvas element: `width={canvas.w} height={canvas.h} aria-label={formatOf(canvas) === 'landscape' ? 'Landscape preview' : 'Vertical preview'} style={{ aspectRatio: `${canvas.w} / ${canvas.h}` }}`. In `styles.css` line 49 replace `height: min(100cqh, calc(100cqw * 16 / 9)); width: auto; aspect-ratio: 9 / 16;` with `max-height: 100cqh; max-width: 100cqw; height: auto; width: auto;` so the inline aspect ratio sizes it in both formats. Also update the comment on line 45 to "The preview fills whatever the panels leave: as large as fits, never cropped."

- [ ] **Step 4: Run** — `npx vitest run src/components/PreviewCanvas.test.tsx` → PASS.
- [ ] **Step 5: Commit** — `git add src/components/PreviewCanvas.tsx src/components/PreviewCanvas.test.tsx src/styles.css && git commit -m "feat(preview): preview canvas follows the project canvas"`

---

### Task 5: Project format op and the export job

**Files:**
- Modify: `src/timeline/ops.ts`
- Modify: `src/timeline/exportJob.ts`
- Modify: `src/timeline/model.ts:2,35` (use `VERTICAL_CANVAS`)
- Test: `src/timeline/ops.test.ts`, `src/timeline/exportJob.test.ts`, `src/timeline/history.test.ts`

**Interfaces:**
- Consumes: `Canvas`, `VERTICAL_CANVAS`, `LANDSCAPE_CANVAS`, `LANDSCAPE_1440_CANVAS`, `formatOf` (Task 1); `fullFramePreset` (Task 1); `buildExportAssets(preset, clip, captions, canvas, make?)` (Task 3).
- Produces: `export type Resolution = '1080p' | '1440p'`; `setFormat(p: Project, f: 'vertical' | 'landscape'): Project` (ops.ts); `exportCanvas(p: Project, r: Resolution): Canvas`, `defaultExportPath(p)` with the suffix rule, `buildExportJob({ ..., resolution: Resolution })` (exportJob.ts).

- [ ] **Step 1: Write the failing tests.** `ops.test.ts`:

```ts
test('setFormat switches the canvas and leaves clips alone', () => {
  const p = project({});
  const l = setFormat(p, 'landscape');
  expect(l.canvas).toEqual({ w: 1920, h: 1080 });
  expect(l.main).toBe(p.main);
  expect(setFormat(l, 'vertical').canvas).toEqual({ w: 1080, h: 1920 });
});
```

`history.test.ts`:

```ts
test('undo restores the format', () => {
  const h = push(initHistory(emptyProject()), setFormat(emptyProject(), 'landscape'));
  expect(undo(h).present.canvas).toEqual({ w: 1080, h: 1920 });
});
```

`exportJob.test.ts` (reuse the file's existing project/media helpers and fake factory; add a caption `{ id: 'k', text: 'GG', style: 'plain', x: 0.5, y: 0.5, fontSize: 0.05, start: 0 }` to the clip):

```ts
test('landscape jobs use the full-frame preset at the chosen resolution', async () => {
  const p = setFormat(projectWithOneClip(), 'landscape');
  for (const [r, canvas] of [['1080p', { w: 1920, h: 1080 }], ['1440p', { w: 2560, h: 1440 }]] as const) {
    const j = await buildExportJob({ project: p, presetById, curves: () => new Map(), quality: 'high', resolution: r, outputPath: '/o.mp4', make });
    expect(j.canvas).toEqual(canvas);
    expect(j.clips[0].preset.layers).toEqual([{ id: 'gameplay', label: 'Gameplay', src: [0, 0, 1, 1], dst: [0, 0, canvas.w, canvas.h], fit: 'contain' }]);
  }
});

test('vertical jobs ignore resolution and keep the clip preset', async () => {
  const j = await buildExportJob({ project: projectWithOneClip(), presetById, curves: () => new Map(), quality: 'high', resolution: '1440p', outputPath: '/o.mp4', make });
  expect(j.canvas).toEqual({ w: 1080, h: 1920 });
  expect(j.clips[0].preset.id).toBe(presetById('p').id);
});

test('default Save name follows the format', () => {
  expect(defaultExportPath(projectWithOneClip())).toMatch(/_vertical\.mp4$/);
  expect(defaultExportPath(setFormat(projectWithOneClip(), 'landscape'))).toMatch(/_landscape\.mp4$/);
  expect(defaultExportPath(setFormat(emptyProject(), 'landscape'))).toBe('SocialFrag_landscape.mp4');
});
```

If `exportJob.test.ts` has no `projectWithOneClip`, write it at the top of the file with `emptyProject`, `addMedia` and `insertClips(p, 0, [newClip('c1', media, preset)])`, using the file's existing media/preset fixtures.

- [ ] **Step 2: Run** — `npx vitest run src/timeline` → FAIL.

- [ ] **Step 3: Implement.** `ops.ts`:

```ts
/** The project's output shape. Captions are fractions, so they keep their relative spot. */
export const setFormat = (p: Project, f: 'vertical' | 'landscape'): Project => ({ ...p, canvas: f === 'landscape' ? LANDSCAPE_CANVAS : VERTICAL_CANVAS });
```

`exportJob.ts`:

```ts
export type Resolution = '1080p' | '1440p';

export const exportCanvas = (p: Project, r: Resolution): Canvas =>
  formatOf(p.canvas) === 'vertical' ? VERTICAL_CANVAS : r === '1440p' ? LANDSCAPE_1440_CANVAS : LANDSCAPE_CANVAS;

export function defaultExportPath(p: Project): string {
  const suffix = formatOf(p.canvas) === 'landscape' ? '_landscape.mp4' : '_vertical.mp4';
  const first = p.main[0] ? p.media.find((m) => m.id === p.main[0].mediaId) : undefined;
  return first ? `${first.path.replace(/\.[^./\\]+$/, '')}${suffix}` : `SocialFrag${suffix}`;
}
```

In `buildExportJob` add `resolution: Resolution` to the argument object, compute `const canvas = exportCanvas(a.project, a.resolution);`, pick the preset with

```ts
const preset = formatOf(canvas) === 'landscape' ? fullFramePreset(canvas) : { ...a.presetById(c.presetId), layers: c.layers };
```

pass `canvas` to `buildExportAssets(preset, m.info, c.captions, canvas, a.make)`, and return `canvas` instead of `a.project.canvas`. `model.ts`: `emptyProject` uses `canvas: VERTICAL_CANVAS` (import it; drop `CANVAS_H, CANVAS_W`).

- [ ] **Step 4: Run** — `npx vitest run src/timeline` → PASS.
- [ ] **Step 5: Commit** — `git add src/timeline && git commit -m "feat(export): landscape jobs, resolution and Save name"`

---

### Task 6: Rust accepts the landscape canvases

**Files:**
- Modify: `src-tauri/src/job.rs:126-140` and its test at `:283-285`
- Modify: `src-tauri/src/preset.rs:141,164`
- Modify: `src-tauri/src/export.rs:153`
- Modify: `src-tauri/src/export.rs` (new ignored real-clip test)
- Test: `src-tauri/src/job.rs`, `src-tauri/src/preset.rs`, `src-tauri/src/filtergraph.rs` tests

**Interfaces:**
- Produces: `pub const ALLOWED_CANVASES: [Canvas; 3]` (job.rs); `pub fn validate_on(p: &Preset, w: f64, h: f64) -> Result<(), String>` with `validate(p)` = `validate_on(p, CANVAS_W, CANVAS_H)` (preset.rs).

- [ ] **Step 1: Write the failing tests.** In `job.rs` replace the 1920×1080 refusal assertion at lines 283-285 with:

```rust
        for c in [Canvas { w: 1080, h: 1920 }, Canvas { w: 1920, h: 1080 }, Canvas { w: 2560, h: 1440 }] {
            let mut j = job();
            j.canvas = c;
            assert!(validate_job(&j).is_ok(), "{c:?}");
        }
        let mut j = job();
        j.canvas = Canvas { w: 1280, h: 720 };
        assert!(validate_job(&j).unwrap_err().contains("1080x1920, 1920x1080 or 2560x1440"));
```

In `preset.rs` tests:

```rust
    #[test]
    fn full_frame_landscape_layer_is_valid_on_its_canvas_only() {
        let mut p = sample();
        p.layers.truncate(1);
        p.layers[0].dst = [0.0, 0.0, 2560.0, 1440.0];
        assert!(validate_on(&p, 2560.0, 1440.0).is_ok());
        assert!(validate(&p).unwrap_err().contains("dst outside canvas"));
    }
```

(Use the test module's existing preset constructor if it is not called `sample()`.) In `filtergraph.rs` tests:

```rust
    #[test]
    fn landscape_full_frame_letterboxes_a_4x3_source() {
        let mut c = clip();
        c.clip.width = 1440;
        c.clip.height = 1080;
        c.preset.background = Background::None;
        c.preset.layers.truncate(1);
        c.preset.layers[0].src = [0.0, 0.0, 1.0, 1.0];
        c.preset.layers[0].dst = [0.0, 0.0, 1920.0, 1080.0];
        c.preset.layers[0].fit = Fit::Contain;
        let f = build_clip_video(&c, 0, 0, &HashMap::new(), &[], "60", &Canvas { w: 1920, h: 1080 });
        assert!(f.contains("[n0bg]scale=1920:1080,drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill[n0b]"), "{f}");
        assert!(f.contains("scale=1440:1080[n0l0]"), "{f}");
        assert!(f.contains("overlay=x=240:y=0"), "{f}");
    }
```

- [ ] **Step 2: Run** — `cd src-tauri && cargo test` → FAIL (compile error on `validate_on`, then assertion failures).

- [ ] **Step 3: Implement.** `job.rs`:

```rust
pub const ALLOWED_CANVASES: [Canvas; 3] = [Canvas { w: 1080, h: 1920 }, Canvas { w: 1920, h: 1080 }, Canvas { w: 2560, h: 1440 }];
```

and in `validate_job`:

```rust
    if !ALLOWED_CANVASES.contains(&job.canvas) {
        return Err("output must be 1080x1920, 1920x1080 or 2560x1440".into());
    }
```

`preset.rs`: rename the body of `validate` to `pub fn validate_on(p: &Preset, canvas_w: f64, canvas_h: f64)`, use `canvas_w`/`canvas_h` in the dst check, and add `pub fn validate(p: &Preset) -> Result<(), String> { validate_on(p, CANVAS_W, CANVAS_H) }`. `export.rs:153`: call `validate_on(&c.preset, job.canvas.w as f64, job.canvas.h as f64)` (update the `use crate::preset::validate;` import to `validate_on`).

Add an ignored real-clip test next to `real_clips_export_with_wardogs` in `export.rs`:

```rust
    /// Landscape: 10 s of the first clip in SOCIALFRAG_CLIPS_DIR at 1080p and 1440p. Same env vars as above.
    #[test]
    #[ignore]
    fn real_clip_landscape_exports() {
        let clips = std::env::var("SOCIALFRAG_CLIPS_DIR").expect("set SOCIALFRAG_CLIPS_DIR");
        let out_dir = std::env::var("SOCIALFRAG_OUT_DIR").expect("set SOCIALFRAG_OUT_DIR");
        let mut files: Vec<_> = std::fs::read_dir(&clips).unwrap().filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|x| x == "mp4")).collect();
        files.sort();
        let source = files[0].to_string_lossy().into_owned();
        let info = crate::probe::probe_clip_file(&source).unwrap();
        let encoders = crate::encoders::detect(&crate::ffmpeg::RealRunner);
        for (w, h) in [(1920u32, 1080u32), (2560, 1440)] {
            let mut c = clip();
            c.source = source.clone();
            c.clip = info.clone();
            c.trim = Trim { in_s: 30.0, out_s: 40.0 };
            c.preset.background = crate::preset::Background::None;
            c.preset.layers.truncate(1);
            c.preset.layers[0].src = [0.0, 0.0, 1.0, 1.0];
            c.preset.layers[0].dst = [0.0, 0.0, w as f64, h as f64];
            c.preset.layers[0].fit = crate::preset::Fit::Contain;
            let j = ExportJob { clips: vec![c], canvas: Canvas { w, h }, output_path: format!("{out_dir}/landscape_{h}p.mp4"), ..job() };
            let work = tempfile::tempdir().unwrap();
            let r = run_export(j, &encoders, work.path(), &ExportState::default(), &|_| {}).unwrap_or_else(|e| panic!("{} {}", e.message, e.details));
            let out = crate::probe::probe_clip_file(&r.output_path).unwrap();
            assert_eq!((out.width, out.height), (w, h));
            assert!((out.duration - 10.0).abs() < 0.2);
        }
    }
```

(Adjust `clip()`/`job()`/`Canvas` imports to the names the export test module already uses.)

- [ ] **Step 4: Run** — `cd src-tauri && cargo test` → PASS. Then the real-clip test on the Mac:

```bash
S=/private/tmp/sf-ff; mkdir -p $S/out && ln -sf "$PWD/binaries/ffmpeg-aarch64-apple-darwin" $S/ffmpeg && ln -sf "$PWD/binaries/ffprobe-aarch64-apple-darwin" $S/ffprobe
SOCIALFRAG_FFMPEG_DIR=$S SOCIALFRAG_CLIPS_DIR="../example clips" SOCIALFRAG_OUT_DIR=$S/out cargo test real_clip_landscape -- --ignored --nocapture
```

Expected: PASS, two files in `$S/out`.
- [ ] **Step 5: Commit** — `git add src-tauri/src && git commit -m "feat(export): accept 1920x1080 and 2560x1440 canvases"`

---

### Task 7: Format switch, disabled presets, resolution picker

**Files:**
- Modify: `src/App.tsx:411-423` (header), `:447-458` (PresetRail), `:477-486` (PreviewCanvas), `:604-609` (HudPanel), `:625` (ExportPanel)
- Modify: `src/components/PresetRail.tsx`, `src/components/HudPanel.tsx`
- Modify: `src/components/ExportPanel.tsx`
- Modify: `src/styles.css` (format switch, disabled rail)
- Test: `src/App.test.tsx`, `src/components/ExportPanel.test.tsx`

**Interfaces:**
- Consumes: `setFormat` (Task 5), `Resolution`, `buildExportJob({ resolution })` (Task 5), `fullFramePreset`, `formatOf` (Task 1), `PreviewCanvas` `canvas` prop (Task 4).
- Produces: `PresetRail` prop `disabledNote?: string`; `HudPanel` prop `disabled?: boolean`; `ExportPanel` prop `onRunningChange?(running: boolean): void`.

- [ ] **Step 1: Write the failing tests.** `App.test.tsx`:

```ts
test('the format switch changes the preview, greys out presets, and undoes', async () => {
  const b = makeBackend();
  render(<App backend={b} />);
  await openClipIn(b);
  fireEvent.click(screen.getByRole('radio', { name: '16:9 Landscape' }));
  expect(await screen.findByLabelText('Landscape preview')).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: 'Presets' }));
  expect(screen.getByText('Presets shape vertical exports. Switch to 9:16 to use them.')).toBeTruthy();
  expect((screen.getByRole('button', { name: /WARDOGS/ }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
  expect(await screen.findByLabelText('Vertical preview')).toBeTruthy();
});

test('the format switch is disabled while an export runs', async () => {
  const b = makeBackend();
  b.startExport = () => new Promise(() => {});
  b.pickExportPath = async () => '/o.mp4';
  render(<App backend={b} />);
  await openClipIn(b);
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  await screen.findByRole('button', { name: 'Cancel' });
  expect((screen.getByRole('radio', { name: '16:9 Landscape' }) as HTMLInputElement).disabled).toBe(true);
});
```

(Use the `render(...)` call the file's other tests use if `App` takes different props.) `ExportPanel.test.tsx` (reuse its render helper):

```ts
test('resolution picker only in landscape, defaults to 1080p, hints upscale for 1080p clips, and reaches the job', async () => {
  const { rerender, backend } = renderPanel(verticalProject);
  expect(screen.queryByRole('radio', { name: '1080p' })).toBeNull();
  rerender(landscapeProject);
  expect((screen.getByRole('radio', { name: '1080p' }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole('radio', { name: '1440p' }));
  expect(screen.getByText('Upscales clips recorded at 1080p')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  await waitFor(() => expect(backend.lastJob?.canvas).toEqual({ w: 2560, h: 1440 }));
});
```

Build `landscapeProject` with `setFormat(verticalProject, 'landscape')`; the clip media must be 1920×1080. If the fake backend does not record the job, capture it in the test: `backend.startExport = async (job) => { captured = job; return { outputPath: '/o.mp4', usedCpuFallback: false }; }`.

- [ ] **Step 2: Run** — `npx vitest run src/App.test.tsx src/components/ExportPanel.test.tsx` → FAIL.

- [ ] **Step 3: Implement.**

`App.tsx`:
- `const format = formatOf(project.canvas);` and `const [exporting, setExporting] = useState(false);`
- Header: replace the `format-badge` span with

```tsx
<fieldset className="format-switch" disabled={exporting}>
  <legend className="sr-only">Format</legend>
  {(['vertical', 'landscape'] as const).map((f) => (
    <label key={f} className={format === f ? 'selected' : ''}>
      <input type="radio" name="format" checked={format === f} onChange={() => edit((p) => setFormat(p, f))} />
      {f === 'vertical' ? '9:16 Vertical' : '16:9 Landscape'}
    </label>
  ))}
</fieldset>
```

- PresetRail: add `disabledNote={format === 'landscape' ? 'Presets shape vertical exports. Switch to 9:16 to use them.' : undefined}`.
- PreviewCanvas: `preset={format === 'landscape' ? fullFramePreset(project.canvas) : { ...presetById(activeEntry.clip.presetId), layers: activeEntry.clip.layers }}` and `canvas={project.canvas}`.
- HudPanel: `disabled={format === 'landscape'}`.
- ExportPanel: `onRunningChange={setExporting}`.

`PresetRail.tsx`: accept `disabledNote?: string`; when set, render `<p className="hint">{disabledNote}</p>` under the description and wrap the list and both button rows in `<fieldset className="rail-body" disabled>` (plain wrapper `<div className="rail-body">` when not set). `HudPanel.tsx`: accept `disabled?: boolean` and wrap its controls in `<fieldset disabled={disabled}>`.

`ExportPanel.tsx`:
- Props: `onRunningChange?(running: boolean): void`.
- State: `const [resolution, setResolution] = useState<Resolution>('1080p');`
- `useEffect(() => onRunningChange?.(status.kind === 'running'), [status.kind, onRunningChange]);`
- Pass `resolution` into `buildExportJob`.
- Under the Quality fieldset, when `formatOf(project.canvas) === 'landscape'`:

```tsx
<fieldset disabled={running}>
  <legend>Resolution</legend>
  {(['1080p', '1440p'] as const).map((r) => (
    <label key={r}>
      <input type="radio" name="resolution" checked={resolution === r} onChange={() => setResolution(r)} /> {r}
    </label>
  ))}
  {resolution === '1440p' && allAtMost1080 && <p className="hint">Upscales clips recorded at 1080p</p>}
</fieldset>
```

with `const allAtMost1080 = project.main.every((c) => (media.get(c.mediaId)?.info.height ?? 0) <= 1080);`.
- Size hint: `const out = exportCanvas(project, resolution);` and show `{out.w}×{out.h} MP4 · …` instead of `project.canvas`.

`styles.css`: `.format-switch { display: inline-flex; gap: 0; border: 1px solid var(--line); border-radius: 6px; padding: 0; margin: 0; } .format-switch label { padding: 4px 10px; cursor: pointer; font-size: 12px; } .format-switch label.selected { background: var(--accent-bg, #2a3322); color: var(--text); } .format-switch input { position: absolute; opacity: 0; pointer-events: none; } .rail-body { border: 0; padding: 0; margin: 0; min-width: 0; } .rail-body:disabled { opacity: 0.45; }` and add `.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }` if the file has none.

- [ ] **Step 4: Run** — `npm test` → all PASS; `npx tsc -b` clean; `npm run lint` shows no new warnings.
- [ ] **Step 5: Commit** — `git add src && git commit -m "feat(format): header format switch, landscape rail and resolution picker"`

---

### Task 8: Remove the last canvas constants and verify in the app

**Files:**
- Modify: `src/components/PresetEditor.tsx`, `src/presets/validate.ts` (switch to `VERTICAL_CANVAS`), `src/types.ts` (delete `CANVAS_W`/`CANVAS_H`)
- Modify: `project.md`

- [ ] **Step 1:** Replace `CANVAS_W`/`CANVAS_H` in `PresetEditor.tsx` and `validate.ts` with `VERTICAL_CANVAS.w`/`VERTICAL_CANVAS.h`; delete the two aliases from `types.ts`. Run `grep -rn "CANVAS_W\|CANVAS_H" src` → no matches. `npm test && npx tsc -b` → PASS.
- [ ] **Step 2:** `npm run tauri dev`. On the Mac: open two example clips; switch to 16:9 (preview becomes 16:9, presets greyed out, HUD section disabled); add a caption and drag it; switch back and forth (caption keeps its relative spot); Ctrl+Z restores 9:16; export 16:9 at 1080p and 1440p and 9:16; play each file. Then ask the user to run the same check on Windows.
- [ ] **Step 3:** Update `project.md`: Done entry for landscape export (date, what shipped, tests); remove it from Now/Next.
- [ ] **Step 4: Commit** — `git add src project.md && git commit -m "refactor: drop fixed canvas constants; tracker, landscape export"` and push to `origin/main` only when the user asks.
