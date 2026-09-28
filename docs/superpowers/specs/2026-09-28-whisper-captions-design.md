# SocialFrag — Whisper Auto-Captions Design Spec

Date: 2026-09-28
Status: Design approved in chat 2026-09-28; spec awaiting user review

## 1. Intent

Users want spoken audio in their clips turned into captions automatically, offline, and then fixed up by hand. Gameplay recordings carry several labelled voice tracks (OBS: `Desktop Audio`, `Game`, `Discord`, `Mic`), so the user picks which tracks to caption, and viewers must be able to tell speakers apart.

### What the user said
- Whisper can caption **one specific track or several tracks**.
- Captions must be **editable after creation**: edit text, delete a line, change timing, split / merge lines, restyle a single line.
- Several tracks → **one merged stream in time order, styled per track** (e.g. Mic white, Discord yellow); overlapping lines stack.
- Language: **English only** (English models).
- Scope of a run: **both** — whole timeline (default) or "this clip only".
- Re-run: **replace untouched auto-lines only**; keep edited auto-lines and hand-made captions; skip new lines that overlap a kept line.
- Editing UI: **caption lane on the timeline + caption list in the side panel**, selection synced.
- Runtime: **bundled whisper.cpp CLI** (`whisper-cli`) as a sidecar next to ffmpeg, not `whisper-rs`.

### Change to an earlier spec
`2026-09-25-timeline-editor-design.md` §7 says whisper runs via `whisper-rs`. This spec replaces that with the bundled `whisper-cli` sidecar (user decision 2026-09-28): no C++/CMake step in `cargo build`, a whisper crash cannot take the app down, and cancel is a process kill. The rest of that section (local, offline, models downloaded on first use, default voice track, 5 words / 2.5 s lines) stands. Its text-track redesign (sub-project 3) is **not** part of this spec: captions stay per clip.

### Evidence (checked 2026-09-28)
- whisper.cpp latest release **v1.9.4** (2026-09-11); binaries are attached to build tag **`b5130`**, including `whisper-bin-x64.zip` (Windows CPU), `whisper-blas-bin-x64.zip`, `whisper-cublas-12.4.0-bin-x64.zip`. No macOS CLI binary is published (only an xcframework), so the Mac build is ours.
- `examples/cli/cli.cpp` at v1.9.4: `-m/--model`, `-f/--file`, `-l/--language`, `-ml/--max-len N`, `-sow/--split-on-word`, `-oj/--output-json`, `-ojf/--output-json-full`, `-of/--output-file`, `-pp/--print-progress` (stderr lines `…: progress = %3d%%`, 5 % steps), `-np/--no-prints`. Input formats: flac, mp3, ogg, wav; 16 kHz internally. JSON `transcription[]` entries carry `offsets.from` / `offsets.to` in milliseconds and `text`.
- Models: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/<file>`:

| Model | File | Bytes | SHA-256 |
|---|---|---|---|
| base.en (default) | `ggml-base.en.bin` | 147964211 | `a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002` |
| small.en | `ggml-small.en.bin` | 487614201 | `c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d` |
| medium.en | `ggml-medium.en.bin` | 1533774781 | `cc37e93478338ec7700281a7ac30a10128929eb8f427dda2e865faa8f6da4356` |

- whisper.cpp and the ggml models are MIT licensed.
- Example clips: `Mic` is silent (−91 dB) in all of them; `Discord` carries voice.
- Today each caption is exported as its own full-canvas PNG ffmpeg input (`filtergraph.rs:90`, `enable='gte(t,…)'`). Hundreds of auto-lines would mean hundreds of ffmpeg inputs.

### Revision 2026-09-28 (after the user's listening check)
In-game voice under gunfire (Game track, `Replay 2026-09-24 22-52-53`) was mostly missed and mistimed by base.en on raw audio. Measured against the user's confirmed lines: base.en raw ≈ half the words, all near the end; small.en on voice-filtered audio with `-mc 0 -sns` = all of them. Silero VAD (`--vad`) dropped speech under gunfire at every threshold, and `-nth` below the default added invented text, so neither is used. Changes (user-approved):
- WAV extraction adds `-af highpass=f=150,lowpass=f=4000,afftdn=nf=-25,dynaudnorm=f=200:g=15`.
- `whisper-cli` args add `-mc 0 -sns`: `-m <model> -f <wav> -l en -ml 1 -sow -mc 0 -sns -oj -of <out_base> -pp -np`.
- A phrase of 1–12 words repeated 3+ times in a row is kept once (decoding loops).
- Default model is **small.en**; base.en is labelled "faster, less accurate".
- Known limits: a line can still be invented from pure noise (user deletes it); where whisper cannot place words in heavy noise their timing is approximate.

### Assumptions (not stated by the user)
- Per-track default styles: 1st captioned track = the current default style in white, 2nd yellow `#FFE14D`, 3rd cyan `#4DD8FF`, 4th green `#7CFF6B`; all centred horizontally near the bottom (y = 0.82); overlapping lines stack upward.
- Word grouping: up to 5 words or 2.5 s per line, and a new line after a silence gap over 0.7 s.
- Whisper runs on CPU on Windows (the CPU build `whisper-bin-x64.zip`); GPU builds are out of scope.
- Models live in the app data folder under `whisper-models/`; they are not counted against the media cache limit and are not removed by Clear cache.

## 2. Behaviour

### Starting a run
- The side panel's Captions section gets an **Auto-caption** button with a scope choice: **Whole timeline** (default) or **This clip** (enabled when a clip is selected).
- Dialog:
  - **Tracks**: a checkbox per audio track of the clips in scope (by label). Default: `Mic`; if `Mic` is silent (every sample of its audio envelope under −60 dB) or missing, the loudest non-`Desktop Audio` track.
  - **Model**: small.en (default, 488 MB), base.en (148 MB, "faster, less accurate"), medium.en (1.5 GB), each showing "Downloaded" or its size.
  - **Start** → progress (model download first if needed, then one bar for the whole run) and **Cancel**.
- Only each clip's trimmed range is transcribed. Freeze clips are skipped.
- Cancel keeps nothing from the run. A failure shows an error with "Copy error details"; clips done before the failure are kept.

### Result
- Each line becomes a caption with `start` and `end`, `source: 'auto'`, the track it came from, and its track's style.
- The run is one undoable edit (Ctrl+Z removes the whole run).

### Editing
- **Caption lane** (timeline, under the video track): one block per timed caption, coloured by its track; untimed hand-made captions show from their start to the clip end. Drag a block's edges to change `start`/`end`; click selects; `S` splits the selected line at the playhead (words stay in text order; the split point in the text is the word nearest the playhead fraction); `Delete` removes it.
- **Caption list** (side panel): every caption of the selected clip in time order, text editable in place, with **Merge with next** and **Delete**. Selecting in the list selects on the lane and preview, and vice versa.
- **Per-line restyle**: the existing caption style/position controls apply to the selected line and set an override on it.
- **Per-track style**: a small "Track styles" row per captioned track (style, colour) changes all its lines that have no override.
- Any change to an auto-line marks it `edited`.

### Re-runs
- For each clip and track in the run: delete that track's auto-lines that are not `edited`, then add the new lines, skipping any whose time range overlaps a kept caption of the same track.

### Timeline operations
- Split: captions entirely left or right go to that side; a caption spanning the cut is cut into two (text copied to both, both marked as they were).
- Trim / ripple delete: captions outside the new range are dropped; ones crossing the edge are clamped.

### Preview and export
- A caption with `end` shows for `start ≤ t < end`; without `end`, from `start` to the clip end (today's behaviour).
- Lines of different tracks overlapping in time stack upward from their track's `y`, using the same layout in preview and export.
- Works in both 9:16 and 16:9 (captions are canvas fractions).

## 3. Data model

```ts
export interface Caption {
  id: string; text: string; style: CaptionStyle; x: number; y: number; fontSize: number;
  start: number;          // source seconds
  end?: number;           // source seconds; absent = to the clip's end
  source: 'manual' | 'auto';
  trackIndex?: number;    // audio track (ffmpeg 0:a:N) an auto-line came from
  edited?: boolean;       // an auto-line the user changed
  color?: string;         // override; absent = style/track default
  override?: boolean;     // style/position set on this line, not from its track
}
export interface TrackCaptionStyle { style: CaptionStyle; color: string; y: number }
// TimelineClip gains:
captionStyles: Record<number, TrackCaptionStyle>;   // by trackIndex
```

Existing captions load as `source: 'manual'` (projects are in memory only today; the field defaults on creation).

## 4. Components

### Rust (`src-tauri/src/`)
- `whisper.rs`: model table (§1), `model_path`, `download_model(model, on_progress)` (streamed to `<file>.part`, size + SHA-256 checked, then renamed; resumable not required), `whisper_args(model, wav, out_base)` → `-m <model> -f <wav> -l en -ml 1 -sow -oj -of <out_base> -pp -np`, `parse_words(json) -> Vec<Word { text, start_s, end_s }>` (drops empty/blank-token segments, trims text).
- `transcribe.rs`: `transcribe(job, on_progress, cancel)` — for each (clip, track): ffmpeg `-ss inS -t len -i src -map 0:a:N -ac 1 -ar 16000 -c:a pcm_s16le <tmp>.wav`, run `whisper-cli`, parse, shift word times by `inS` (source time); overall progress = done clips/tracks + current `progress = N%`; cancel kills the running child and removes temp files.
- Commands: `whisper_models()` (downloaded state + sizes), `download_whisper_model(model, on_progress: Channel<f64>)`, `transcribe(job, on_progress: Channel<TranscribeProgress>) -> Vec<ClipWords>`, `cancel_transcribe()`.
- Sidecar `whisper-cli` in `externalBin`; `tool_command("whisper-cli")` like ffmpeg (hidden console on Windows).
- Export: captions of one clip are rendered to PNGs per **on-screen interval** (every boundary where the set of visible captions changes) and passed as a single ffconcat image-sequence input with durations, overlaid once per clip. Replaces one input per caption.

### Packaging
- `scripts/fetch-whisper.ps1`: downloads `whisper-bin-x64.zip` from tag `b5130`, extracts `whisper-cli.exe` + its DLLs to `src-tauri/binaries/` (`whisper-cli-x86_64-pc-windows-msvc.exe`; DLLs as resources).
- `scripts/build-whisper-macos.sh`: builds v1.9.4 with CMake, Metal on, static, arm64, outputs `src-tauri/binaries/whisper-cli-aarch64-apple-darwin`.
- `THIRD_PARTY_NOTICES.md` + `licenses/whisper.cpp-MIT.txt`.

### Frontend (`src/`)
- `captions/group.ts`: `groupWords(words, { maxWords: 5, maxS: 2.5, gapS: 0.7 })` → lines `{ text, start, end }`.
- `captions/merge.ts`: `mergeRun(existing, trackIndex, newLines)` implementing §2 Re-runs.
- `captions/defaults.ts`: default voice track choice; per-track default styles.
- `captions/stack.ts`: vertical stacking of overlapping lines (shared by preview and export).
- Timeline ops (`timeline/ops.ts`): split/trim/ripple rules for timed captions; `applyTranscription`.
- UI: `AutoCaptionDialog.tsx`, `CaptionLane.tsx` (timeline), `CaptionList.tsx` (side panel), track-style row in `CaptionTool.tsx`; `isCaptionVisible` honours `end`.
- Backend interface (`backend/types.ts` + `tauri.ts` + `fake.ts`): `whisperModels`, `downloadWhisperModel`, `transcribe`, `cancelTranscribe` (progress channels use the late-message guard from `invokeWithProgress`).

## 5. Error handling
- Model download: network error or checksum mismatch → error in the dialog, `.part` deleted, Retry.
- `whisper-cli` missing, non-zero exit, or unparseable JSON → run stops with "Captioning failed." and copyable details (args, exit code, stderr tail); earlier clips' results kept.
- A track with no speech → no lines, no error; the dialog's summary says "No speech found on <track>" for that track.
- Cancel → nothing applied; temp WAV/JSON removed.

## 6. Testing
- TS unit: `groupWords` (5-word cap, 2.5 s cap, gap split, punctuation kept); `mergeRun` (untouched replaced, edited kept, manual kept, overlap skipped); default voice track (Mic silent → loudest non-desktop); stacking; split/trim/ripple of timed captions; `isCaptionVisible` with `end`; undo of a run.
- Components: dialog defaults and model states; lane edge drag changes `start`/`end` and marks `edited`; list text edit; Merge with next; Delete; selection sync.
- Rust: `whisper_args` golden; `parse_words` against a checked-in sample JSON produced by v1.9.4; progress line parser; download checksum mismatch path (local file server or temp file); export filtergraph with 300 timed captions uses one image-sequence input per clip.
- Real (ignored): transcribe 20 s of the `Discord` track of an example clip with base.en → non-empty words, increasing times inside the range.
- Manual: user captions a real clip on Mac and on Windows, edits (text, timing, split, merge, delete, restyle), re-runs, exports 9:16 and 16:9.

## 7. Risks
- Windows CPU speed on long clips with small/medium: base.en default, progress + cancel.
- `whisper-cli` flag drift: pinned to v1.9.4 / `b5130`; args covered by a golden test.
- Word timestamps from `-ml 1 -sow` can be approximate at segment edges: lines are editable; `-dtw` is out of scope.
- Mac build needs Xcode command-line tools + CMake on the build machine (build-time only).

## 8. Out of scope
- Other languages / auto-detect, translation.
- GPU (CUDA/BLAS) Whisper builds on Windows.
- Separate text track (sub-project 3), karaoke word highlight, speaker diarisation within one track.
