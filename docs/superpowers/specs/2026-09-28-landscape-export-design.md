# SocialFrag — Landscape (16:9) Export Design Spec

Date: 2026-09-28
Status: Design approved in chat 2026-09-28; spec awaiting user review

## 1. Intent

SocialFrag only exports 9:16 vertical video (1080×1920) built from a preset layout. Users also want a "regular" 16:9 export of the same edit — the original gameplay frame as recorded — for YouTube and similar. 9:16 stays the default.

### What the user said
- Add a 16:9 export; the default mode stays social media (9:16).
- 16:9 content is the **original gameplay frame as recorded**: no crop, no HUD rearranging. Trims, speed, freeze, captions and the audio mix still apply.
- Output resolution is **chosen at export** with a 1080p / 1440p picker.
- The format is a **project-wide switch in the header**; the preview changes shape so the user sees what will export.
- Captions keep the **same relative position** in both formats (stored as canvas fractions, font size scales with canvas height); one set of captions serves both formats.
- Approach: a generated full-frame layout reused by the existing pipeline, not a separate Rust render path.

### Evidence
- Rust export is already canvas-parameterised (`Canvas { w, h }` in `filtergraph.rs`); only `validate_job` (`job.rs:133`) pins 1080×1920.
- `Project.canvas` already exists (`timeline/model.ts:35`) and flows into the export job (`timeline/exportJob.ts:58`).
- `Background::None` already renders black (`filtergraph.rs:67`); `fit: "contain"` already letterboxes layers.
- Captions live only in the in-memory project (project files are sub-project 2b, not built) and presets hold no captions, so there is no stored caption data to migrate.
- All 7 Mac example clips and the maintainer's Windows clip library are 1920×1080. **1440p export therefore upscales these clips**; it only adds detail for sources recorded above 1080p.

### Assumptions (not stated by the user)
- The app starts in 9:16 on every launch. Once 2b lands, the format is saved in the `.sfproj` project file.
- Non-16:9 sources (e.g. ultrawide, 4:3) are fitted whole with black bars.
- The 1080p / 1440p picker defaults to 1080p and is hidden in 9:16 mode (vertical stays 1080×1920 only).
- Default Save name suffix is `_landscape.mp4` in 16:9 (`_vertical.mp4` stays for 9:16).
- The preset editor stays 9:16 only; presets shape vertical exports only.
- Switching format is undoable, is disabled while an export runs, and the 1440p option shows an upscale hint for ≤1080p clips (added in the spec, not discussed in chat).

## 2. Behaviour

### Format switch
- The header's static "9:16 VERTICAL" label becomes a two-option switch: **9:16 Vertical** / **16:9 Landscape**. Default 9:16.
- Switching is an undoable project edit (it changes `project.canvas`), so Ctrl+Z switches back.
- Switching never touches clips, trims, audio or captions.

### 16:9 mode
- Preview is 16:9 and shows the full source frame fitted (`contain`) on black.
- Preset layers, HUD toggles, per-clip layout drag/resize and the blur background do not apply. The preset rail and HUD section are disabled with the note: "Presets shape vertical exports. Switch to 9:16 to use them."
- Captions render and drag exactly as in 9:16, at their relative position.
- Export panel shows **Resolution: 1080p / 1440p** (default 1080p). The 1440p option carries the hint "Upscales clips recorded at 1080p" when every clip on the timeline is ≤1080 px tall.

### 9:16 mode
- Unchanged from today.

## 3. Data model

- `Project.canvas` is the single source of truth for format: `{ w: 1080, h: 1920 }` (vertical) or `{ w: 1920, h: 1080 }` (landscape). Helper `formatOf(canvas): 'vertical' | 'landscape'`.
- Export resolution is export-panel state, not project state: `resolution: '1080p' | '1440p'`. `buildExportJob` sets `job.canvas` to `project.canvas` in vertical, and to `1920×1080` or `2560×1440` in landscape.
- `Caption.x`, `Caption.y`: 0..1 fractions of canvas width / height (centre). `Caption.fontSize`: fraction of canvas height. New-caption defaults convert today's pixels: `x: 0.5`, `y: 260/1920`, `fontSize: 80/1920`.
- New `fullFramePreset(canvas): Preset` in `presets/presets.ts`: `background: { type: 'none' }`, one layer `{ id: 'gameplay', src: [0,0,1,1], dst: [0,0,canvas.w,canvas.h], fit: 'contain' }`. Used by preview composition and `buildExportJob` in landscape; never saved, never shown in the preset rail.

## 4. Code changes

### TypeScript
- `types.ts`: remove `CANVAS_W`/`CANVAS_H` as general constants. Keep a `VERTICAL_CANVAS` (1080×1920) and add `LANDSCAPE_CANVAS` (1920×1080); caption doc comment updated to fractions.
- `state/captions.ts`: defaults and drag clamp in fractions (clamp 0..1).
- `render/compose.ts`: take the canvas as a parameter; draw captions by multiplying fractions by the canvas size.
- `components/PreviewCanvas.tsx`: canvas size from props; pointer maths and snapping use it; CSS aspect ratio follows the canvas.
- `render/exportAssets.ts`: render overlays and masks at `job.canvas` size so 1440p captions are sharp.
- `presets/validate.ts`: keeps validating presets against `VERTICAL_CANVAS`.
- `timeline/model.ts`: `setCanvas` op (undoable).
- `timeline/exportJob.ts`: pick the preset per format (clip preset vs `fullFramePreset`), set `job.canvas` from format + resolution, `_landscape.mp4` default name.
- UI: header format switch (`App.tsx`), disabled preset rail + HUD section in landscape, resolution picker in `ExportPanel.tsx`, `styles.css` preview aspect from a CSS variable.

### Rust
- `job.rs`: `validate_job` accepts exactly 1080×1920, 1920×1080 and 2560×1440; the error names the allowed sizes.
- `preset.rs`: preset layer bounds are checked against the job's canvas (`validate_on`), not a fixed 1080×1920, so the full-frame layer validates at 1920×1080 and 2560×1440. Found while planning (`preset.rs:164`).
- No other Rust change is expected: filtergraph, encoders and audio are canvas-agnostic.

## 5. Error handling
- An export job with any other canvas is refused by Rust with the allowed-sizes message (the UI never builds one).
- A caption dragged past the edge is clamped to 0..1 in both formats.
- Switching format mid-export is blocked: the switch is disabled while an export runs.

## 6. Testing
- TS unit: `fullFramePreset` layer and background; caption fraction defaults and clamp; compose draws captions at `fraction × canvas`; `buildExportJob` canvas for vertical / landscape-1080p / landscape-1440p and preset choice; default Save names; `setCanvas` undo/redo.
- Component: header switch toggles the preview aspect; preset rail and HUD disabled in landscape; resolution picker shown only in landscape, defaults to 1080p, shows the upscale hint for ≤1080p clips; switch disabled during export.
- Golden fixture `src/test/fixtures/timeline-golden.json` updated for fractional captions.
- Rust: `validate_job` accepts the three sizes and refuses others; filtergraph golden for a 1920×1080 full-frame job (contain on black).
- Real-clip (ignored): export a 15 s slice of each example clip in landscape at 1080p and 1440p; assert output size and duration.
- Manual: on Mac and on Windows, switch formats, place a caption, export both formats, play the files.

## 7. Out of scope
- 16:9 preset layouts, HUD callouts or effects in landscape.
- Other aspect ratios (1:1, 4:5) or 4K output.
- Saving the format (arrives with 2b project files).
