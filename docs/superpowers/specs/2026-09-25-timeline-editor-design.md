# SocialFrag — Timeline Editor Design Spec

Date: 2026-09-25
Status: Approved design, awaiting spec review

## 1. Intent

SocialFrag today edits one clip against one game preset and exports one 9:16 video. This spec turns it into a multi-clip timeline editor with Concat/CapCut-style cutting, captions/text and keyframes/transitions, while keeping the one-drop preset workflow, and makes preview audio work for 30+ minute sources.

### What the user said
- Needs "the same kind of editing tools as Concat": chose **Cutting**, **Captions & text**, **Keyframes & transitions**. Not effects/filters, background removal or TTS.
- Load multiple videos and edit them together: **one timeline, one export** (montage), not a batch queue.
- Must handle **30+ minute** sources, including the chunked audio decoding deferred from the AudioBuffer preview fix (commit `8b13664`).
- Game preset applies **per clip** on the timeline.
- Rendering approach **A**: one shared timeline model, preview on the canvas, export as one ffmpeg filter graph built in Rust.
- 9:16 1080x1920 output now; **16:9 original export may be wanted later**, so canvas size must be a project setting, not a constant.

### Assumptions (confirmed by the user)
- One main (magnetic) video track + one text track + per-clip multi-track audio. No stacked video tracks in v1.
- Projects save to disk (`.sfproj`) with autosave; media referenced by path, never copied.
- Auto-captions use local whisper.cpp, downloaded once, offline.
- Keyframes animate x, y, scale, opacity of HUD layers and text, and clip volume. Transitions: cut, crossfade, slide, zoom.
- Windows first-class; macOS Apple Silicon.

### Evidence
- OpenCut (`deploy` branch, `apps/web/src/core/managers/audio-manager.ts`) plays preview audio from decoded `AudioBuffer`s scheduled with `createBufferSource()` on the `AudioContext` clock, with a 2 s lookahead and 1 s chunks; restarts on seek. Read for design only; no code copied.
- Concat (`jub0t/Concat`) is AGPL-3.0: nothing may be copied into closed-source SocialFrag.
- Example clips: HEVC 1920x1080 @ 120 fps, 4 AAC tracks (`Desktop Audio, Game, Discord, Mic`); `Mic` is silent (−91 dB) in all 6.

### Success criteria
- A 30-minute, 4-track source previews with no audio gaps, repeats or drift beyond 100 ms, and the preview's audio memory stays under 50 MB.
- A 10-clip timeline with cuts, one transition per join, keyframed HUD layers and captions exports in one ffmpeg run, and the export's cut and transition times match the preview's to within one frame.
- Dropping one clip on the welcome screen still produces today's result with no extra steps.
- Every export has 0 or 1 audio streams (unchanged).

## 2. Sub-projects and order

Each gets its own implementation plan and ships something usable.

1. **Streaming audio** (§3): raw PCM cache + chunked scheduler; cache pruning.
2. **Project + timeline + cutting** (§4, §5, §6, §7 cutting): project model, save/load/undo, multi-clip playback, multi-clip export, split/delete/trim/reorder/speed/freeze.
3. **Captions & text** (§7 text): text track, text items, whisper auto-captions.
4. **Keyframes & transitions** (§7 keyframes/transitions): keyframe model + curve lane, xfade transitions.

## 3. Streaming audio

- **Prepare** (`src-tauri/src/audio_prep.rs`): in the same single ffmpeg run that writes the envelope, also write one raw PCM file per track: `s16le`, 48 kHz, stereo, `track-{index}.pcm`. Replaces the `.m4a` output (the preview no longer needs a compressed file).
- **Read**: the frontend fetches byte ranges over the asset protocol (`Range: bytes=...`). Byte offset for time `t` = `round(t * 48000) * 4`. No decoding at playback.
- **Scheduler** (`src/audio/`, replaces the full-buffer `AudioPreview`): works on **segments** `{ trackUrl, srcStartS, timelineStartS, durationS, rate, gainCurve }`. A single clip is one segment per track. Keeps 2 s of 1 s chunks queued ahead of the playhead on the `AudioContext` clock, converting s16 to float into `AudioBuffer`s. Seek, rate or segment change: stop queued sources, refill from the new position. Drift check against the video clock stays (resync over 100 ms, at most once a second).
- **Memory**: bounded by the queue (about 3 s x tracks), independent of clip length.
- **Cache pruning**: LRU by last-opened source, default cap 10 GB (proxies + PCM + envelopes), configurable in Settings; plus a "Clear cache" action.
- **Rejected**: on-demand ffmpeg chunk decode (clicks at chunk seams); WebCodecs `AudioDecoder` in the webview (WebKit support on macOS not verified).

## 4. Project and timeline model

`src/types.ts`, mirrored in `src-tauri/src/job.rs`.

```ts
interface Project {
  version: 1;
  canvas: { w: number; h: number };        // 1080x1920 now; 1920x1080 later
  fps: 30 | 60;
  media: MediaRef[];
  main: TimelineClip[];                    // ordered; start times derived (magnetic)
  transitions: Transition[];               // between main[i] and main[i+1]
  texts: TextItem[];
}
interface MediaRef { id: string; path: string; info: ClipInfo; offline?: boolean }
interface TimelineClip {
  id: string;
  kind: 'video' | 'freeze';
  mediaId: string;
  inS: number; outS: number;               // source seconds; freeze: inS = frame time, outS - inS = hold length
  speed: number;                           // 0.25 to 4
  presetId: string;
  layers: Layer[];                         // per-clip working copy of the preset layout
  mix: AudioMix;                           // today's per-clip mix
  keyframes: Keyframes;                    // keyed by `${layerId}.${prop}` or 'volume'
}
interface Transition { afterClipId: string; type: 'crossfade' | 'slide' | 'zoom'; durationS: number }
interface TextItem { id: string; text: string; style: CaptionStyle; x: number; y: number; fontSize: number; startS: number; endS: number; source: 'manual' | 'auto'; keyframes: Keyframes }
type Ease = 'linear' | 'easeInOut' | 'hold';
type Keyframes = Record<string, { t: number; v: number; ease: Ease }[]>;  // t relative to the item's start
```

- Timeline duration of a clip = `(outS - inS) / speed`. A transition of `d` overlaps the two clips by `d`, so it shortens the total by `d`. `durationS` is clamped to half the shorter neighbour.
- Keyframe times are relative to the clip/text start, so moving an item carries its animation.
- Keyframe evaluation (`evalKeyframes(points, t)`) is a pure function, implemented in TS and Rust against one shared fixture file (§8).
- **Undo/redo**: immutable project updates; history stack capped at 200; Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z.
- **Save**: autosave to app data 2 s after the last change; File > Save As writes `.sfproj`; Recent projects on the welcome screen. Missing media opens as offline with a Relink action.
- **Single-clip path**: dropping one clip creates a one-clip project with the default preset. Today's single-clip state (`clip`, `trim`, `workingLayers`, `audioMix`) is replaced by the project; trim becomes the clip's `inS`/`outS`.
- Presets unchanged. A new clip copies its preset's layers; "Save layout to preset" still works per clip. New clips default to the last-used preset.

## 5. Preview playback

- **Two video elements (A/B)**: the active clip plays in one; the next clip is preloaded, paused at its in point, in the other. Swap at the cut. During a transition both play and the canvas blends them.
- **Clock**: the active clip's video element is master. `timelineT = clipStart + (video.currentTime - inS) / speed`. At the clip's out point the engine swaps elements itself. Audio segments follow that clock via §3.
- **Speed**: `video.playbackRate = speed` with pitch preserved; export uses `setpts` + `atempo`.
- **Scrub**: seek the element that owns the time, show the frame, audio silent until release. HEVC sources still use per-source proxies.
- **Canvas compose** (`src/render/compose.ts`): per frame, resolve the active clip(s), evaluate keyframes at the current time, draw the layout, apply the transition blend, draw active text items.
- Target: smooth 60 fps preview of 1080p60 sources on an M-series Mac and a mid-range Windows GPU; heavier sources fall back to proxies.

## 6. Export

- One ffmpeg run. Each timeline clip is its own input with input seeking (`-ss inS -t len`).
- **Per-clip video**: today's layout graph (`filtergraph.rs`) with keyframed layer x/y/scale/opacity as time expressions (piecewise, `eval=frame` where required), then `setpts` for speed, then normalise with `fps`, `format`, `settb` so clips can join.
- **Join**: `concat` for cuts, `xfade` (`fade`, `slideleft`, `zoomin`) for transitions.
- **Audio**: today's per-clip mix (`audio_mix.rs`), `atempo` for speed (chained for rates outside 0.5 to 2), `concat` for cuts, `acrossfade` for transitions. Output: one stereo AAC track.
- **Text**: rasterised in the app to transparent PNGs, overlaid with `enable='between(t,start,end)'`; keyframed position/scale as expressions.
- Encoder selection, progress (against total timeline duration) and cancel unchanged. Canvas size read from the project.

## 7. Editing tools and layout

- **Left rail**: tabs Media (imported sources, drag to the timeline) and Presets.
- **Centre**: preview. **Right panel**: inspector for the selection (clip: preset, HUD layers, audio mix, speed, keyframes; text: content, style, animation; transition: type, duration; nothing selected: Export).
- **Bottom**: full-width timeline with ruler, playhead, main track with thumbnails, text track, and the selected clip's audio lanes (today's `AudioLanes`).
- **Cutting**: `S` split at playhead; `Delete` ripple-delete; drag clip edges to trim; drag to reorder; speed field; `F` inserts a 3 s freeze frame; dropping several files appends them in file-name order.
- **Text**: `T` adds a text item at the playhead (3 s).
- **Auto-captions**: button in the text inspector. Choose the voice track (default: `Mic`, or the loudest non-desktop track when `Mic` is silent, which it is in the example clips) and model: base (about 140 MB, default), small, medium. Runs whisper.cpp via `whisper-rs` (MIT; models MIT), Metal on macOS, CPU on Windows, reading the §3 PCM cache resampled to 16 kHz. Word timestamps are grouped into lines of up to 5 words / 2.5 s, each an editable `TextItem` with `source: 'auto'` in the current caption style. Models download on first use to app data.
- **Keyframes**: a diamond button beside each animatable property adds/updates a keyframe at the playhead. The selected clip shows a keyframe lane with a value-over-time graph; points drag in time and value; per-point ease (linear, ease-in-out, hold).
- **Transitions**: click a join, pick crossfade, slide or zoom, and a duration (default 0.5 s).
- **Deferred**: active-word karaoke highlight, more transition types, stacked video tracks, effects, 16:9 export UI.

## 8. Testing

- **Shared golden fixtures** (`src/test/fixtures/timeline-golden.json`): keyframe evaluation, easing, clip start/duration with speed and transitions, text visibility windows, PCM byte offsets. Both Vitest and Rust tests assert against the same file.
- **Unit**: audio scheduler (chunk boundaries, seek, offset, rate), undo/redo, magnetic-track operations (split, ripple delete, trim, reorder), project load/save/relink, filter graph builder golden args.
- **Integration** (Rust, `#[ignore]`, real example clips): export a fixture project with 3 clips, a crossfade, keyframes and captions; check duration, a frame at each cut, one non-silent audio stream. PCM cache matches a direct ffmpeg decode to the sample.
- **Manual (user) at the end of each sub-project**: listening check on a 30-minute clip (sub-project 1); timeline cut/playback check (2); captions (3); keyframes/transitions (4).

## 9. Risks

- `xfade` needs identical size, fps and timebase on both inputs; handled by the normalise step, covered by the integration test.
- Long keyframe lists make long ffmpeg expressions; cap at 64 points per property and warn beyond it.
- Two-element swap may show a one-frame hitch in WebKit at cuts; if so, preload one frame earlier and draw the incoming frame from the preloaded element.
- whisper on Windows CPU is slow for 30-minute tracks (medium model); default to base and show progress with cancel.
