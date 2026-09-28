# SocialFrag — Design Spec

Date: 2026-09-24
Status: Draft, awaiting review
Name: SocialFrag (chosen 2026-09-24).

## 1. Intent

A free, easy game-clip editor for Windows that turns raw gameplay into a 9:16 vertical video (TikTok / Reels / Shorts) in a few minutes, with no timeline and no editing skills. Reference product: DCOMP (drewui.com), a paid Windows app built on the same drop → preset → export idea.

### What the user said
- Free public tool (no billing, no accounts).
- Windows-only desktop app.
- Developed on a Mac; built and tested on the user's Windows gaming PC.
- v1 features: HUD reframe to 9:16, trim start/end, preset editor, text overlay captions.
- Launch game preset: WARDOGS (Steam, released 2026-09-10). No sample clips yet.
- Identity DadMadeAnApp. (Originally planned closed source; released as open source under GPL-3.0 on 2026-09-28.)
- Installers hosted in a public releases-only repo; unsigned for v1.
- Stack: Tauri 2 + React + bundled ffmpeg.

### Assumptions (correct these if wrong)
- Output is always 1080×1920 H.264 MP4.
- Users record with ShadowPlay, Medal, OBS or similar; sources are 1080p–4K, 30–240 fps, H.264 or HEVC.
- One clip per session; no multi-clip joining.

### Success criteria
- A first-time user goes from a raw clip to an exported vertical MP4 in under 3 minutes without reading instructions.
- Preview matches the exported file (same crops, same caption placement).
- Export of a 30 s 1080p60 clip finishes in under 30 s on a PC with an NVIDIA/AMD/Intel GPU.
- A user can build, save and share a custom preset for any game.

### Out of scope for v1
Auto captions / speech-to-text, multi-clip timeline, music, transitions, zoom/keyframe effects, direct upload to TikTok, macOS/Linux, accounts, telemetry, code signing, preset marketplace.

## 2. Identity

| Item | Value |
|---|---|
| App name | `SocialFrag` |
| Bundle identifier | `com.dadmadeanapp.socialfrag` |
| Code repo | `DadMadeAnApp/socialfrag` — private |
| Releases repo | `DadMadeAnApp/socialfrag-releases` — public, installers and updater feed only |
| Support contact | `support@dadmadeanapp.com` |
| Privacy contact | `privacy@dadmadeanapp.com` |

## 3. User flow

Single window, no timeline.

1. Drop a clip on the window (or click **Open**).
2. Pick a preset from the left rail (WARDOGS built-in + user presets).
3. Live 9:16 preview updates instantly.
4. Optional: drag trim handles on the scrub bar.
5. Optional: add a text caption, choose a style, drag it into place.
6. Click **Export** → progress bar → **Open folder**. The output is saved next to the source clip.

Preset editing is a second mode reached from the preset rail (**New** / **Edit a copy**).

## 4. Architecture

```
┌──────────────── WebView2 (React + TypeScript) ────────────────┐
│ PreviewCanvas  PresetRail  TrimBar  CaptionTool  PresetEditor │
│            │ Tauri invoke / events                            │
└────────────┼──────────────────────────────────────────────────┘
┌────────────▼──────── Rust core (Tauri 2) ─────────────────────┐
│ probe_clip  make_proxy  detect_encoders  export  presets_*    │
│            │ spawns                                           │
│   bundled ffmpeg.exe / ffprobe.exe (sidecar)                  │
└───────────────────────────────────────────────────────────────┘
```

### 4.1 UI units (React)
| Unit | Job | Depends on |
|---|---|---|
| `PreviewCanvas` | Draws the hidden `<video>` into a 1080×1920 canvas per the preset: background, each layer's `src`→`dst`, captions. rAF loop. | `render/compose.ts` |
| `render/compose.ts` | Pure function `(frameSource, preset, captions, ctx)` that draws one frame. Shared by the preview and the caption PNG renderer. | none |
| `PresetRail` | Lists built-in + user presets, select / new / duplicate / delete. | `presets` API |
| `TrimBar` | Scrub, in/out handles, `I`/`O`/Space keys. | video element |
| `CaptionTool` | Add / edit / style / position captions on the canvas. | `compose.ts` |
| `PresetEditor` | Split view: source frame (left) and 9:16 canvas (right), linked colored boxes per layer, snapping, nudge, layer list. | `editor/geometry.ts` |
| `editor/geometry.ts` | Pure math: fraction↔pixel, drag/resize, snapping. | none |
| `backend.ts` | Typed wrapper over Tauri `invoke`. A `FakeBackend` implementation lets the UI run in a normal browser on the Mac. | Tauri API |

### 4.2 Rust commands
| Command | Job |
|---|---|
| `probe_clip(path)` | ffprobe → `{width, height, fps, codec, duration, has_audio}` |
| `make_proxy(path)` | If WebView2 can't play the codec (e.g. HEVC without the Windows extension), transcode a low-res H.264 preview proxy into the cache dir. Export always uses the original. |
| `detect_encoders()` | Tries `h264_nvenc`, `h264_amf`, `h264_qsv` with a 1-frame test encode; caches the first that works; falls back to `libx264`. |
| `export(job)` | Builds the filter graph from preset + trim + caption PNGs, runs ffmpeg, emits `export://progress` events from `-progress pipe:1`, supports cancel. |
| `presets_list/save/delete/import/export` | Reads bundled presets (read-only) and user presets in `%APPDATA%\SocialFrag\presets\`. |

`filtergraph.rs` is a pure module: `(preset, source_info, trim, caption_pngs) → Vec<String> ffmpeg args`. It carries most of the correctness risk, so it gets golden tests.

### 4.3 No network
The app makes no network calls except the Tauri updater check against the public releases repo. No telemetry, no accounts.

## 5. Preset format

Output canvas fixed at 1080×1920. `src` = `[x, y, w, h]` as fractions (0–1) of the source frame, so one preset works at any resolution. `dst` = `[x, y, w, h]` in output pixels. Layers draw bottom to top.

```json
{
  "name": "WARDOGS – Default",
  "game": "WARDOGS",
  "version": 1,
  "builtin": true,
  "background": { "type": "blur", "amount": 30 },
  "layers": [
    { "id": "gameplay", "label": "Gameplay", "src": [0.28, 0.0, 0.44, 1.0], "dst": [0, 420, 1080, 1080], "fit": "cover" },
    { "id": "killfeed", "label": "Killfeed", "src": [0.75, 0.02, 0.23, 0.15], "dst": [60, 80, 960, 300], "fit": "contain", "radius": 16, "border": { "width": 4, "color": "#FFFFFF" } }
  ]
}
```

- `background.type`: `blur` (blurred, scaled-to-fill gameplay), `color` (`"color": "#000000"`), or `none` (black).
- `fit`: `cover` crops to fill `dst`; `contain` letterboxes inside `dst`.
- `version` lets a later app migrate old files. Unknown fields are ignored on load.
- Validation on load: fractions in [0,1], `src` inside the frame, `dst` inside the canvas, at least 1 layer. Invalid files are skipped with a visible warning, never a crash.
- The WARDOGS values above are placeholders. They get calibrated in the preset editor once the user supplies sample clips.

## 6. Preset editor

- Left: a paused source frame (scrub to choose it) with one colored box per layer = `src`.
- Right: the 9:16 canvas with the matching colored box = `dst`, showing the live composited result.
- Drag to move, handles to resize, snap to edges and center lines (hold Alt to disable snapping), arrows nudge 1 px, Shift+arrows 10 px.
- Layer list: add, delete, reorder (drag), rename, per-layer fit / radius / border.
- Background picker.
- **Save**, **Duplicate**, **Export .json**, **Import .json**. Built-in presets are read-only; editing one creates a copy.

## 7. Trim

- Scrub bar with in/out handles under the preview; `I` sets in, `O` sets out, Space plays/pauses, ←/→ step one frame.
- Export applies trim with a frame-accurate re-encode (`-ss` before `-i` plus `-t`, acceptable since everything is re-encoded).

## 8. Text captions

- One or more captions on the 9:16 canvas: drag to move, corner handle to resize, double-click to edit text.
- Styles: **TikTok** (bold white, black stroke), **Impact** (yellow, black stroke), **Boxed** (white on a rounded black box), **Plain**.
- Timing: whole clip (default), or "from current frame to end".
- Bundled open-license fonts: Inter, Anton, Bebas Neue. No system fonts.
- Export: each caption is rendered to a transparent 1080×1920 PNG with the same `compose.ts` code used by the preview, then overlaid by ffmpeg with `enable='between(t,a,b)'`. Preview and output match exactly, and ffmpeg's font handling is avoided.

## 9. Export

- 1080×1920 H.264 MP4, fps = source fps capped at 60, AAC 192 kbps if the source has audio.
- Quality: **High** (default) or **Smaller file**, mapped to per-encoder CQ/CRF values.
- Output: `<source name>_vertical.mp4` next to the source; on a name clash, append `-1`, `-2`, … Never overwrite.
- Progress bar with ETA; **Cancel** kills ffmpeg and deletes the partial file.

## 10. Error handling

| Case | Behavior |
|---|---|
| File ffprobe can't read | "This file isn't a video SocialFrag can read." |
| Codec WebView2 can't play | Auto `make_proxy`, with a spinner: "Preparing preview…" |
| GPU encoder fails mid-export | Retry once with `libx264`, show "GPU encode failed, used CPU instead." |
| Output folder not writable | Ask for a different folder with the save dialog. |
| Invalid preset file | Skip it, show a warning listing the file and the reason. |
| Any ffmpeg failure | Error dialog with a **Copy error details** button (last 50 lines of stderr + args). |

## 11. Testing

1. **Rust:** golden tests for `filtergraph.rs` (preset + trim + captions → exact args), preset validation tests, encoder fallback logic with a mocked runner.
2. **TypeScript:** Vitest for `editor/geometry.ts` (fraction↔pixel, drag, resize, snap) and preset validation.
3. **UI on the Mac:** the app runs in the browser pane with `FakeBackend` and a sample MP4, checking preset editor, trim and captions visually.
4. **Windows PC smoke test:** build the installer; export 1080p60 H.264 and 1440p HEVC samples on the GPU and on the CPU fallback; check output against preview screenshots.

## 12. Distribution

- Tauri bundler → NSIS `.exe` installer (WebView2 bootstrapper included), with ffmpeg/ffprobe as sidecars (LGPL build, dynamically linked, license text shipped in the app).
- Built on the Windows PC (or GitHub Actions `windows-latest` later) and uploaded to the public `DadMadeAnApp/socialfrag-releases` repo.
- Tauri updater reads `latest.json` from that repo's releases. Update packages are signed with a Tauri updater key (free; separate from Windows code signing).
- Unsigned for v1: the README tells users to click **More info → Run anyway** on the SmartScreen prompt. Revisit Azure Trusted Signing if adoption grows.
- A privacy statement in the releases repo README ("no data leaves your PC except the update check") pointing to `privacy@dadmadeanapp.com`.

## 13. Open items

- Final app name (updates the bundle id, repo names, and `%APPDATA%` folder).
- WARDOGS sample clips at the user's recording resolution, needed to calibrate the built-in preset.
