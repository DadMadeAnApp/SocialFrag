# Streaming Audio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preview audio for 30+ minute, multi-track sources with memory bounded by a small lookahead queue instead of the whole file, plus an LRU-pruned cache with a Clear cache action.

**Architecture:** `prepare_audio` writes one raw PCM file per track (s16le, 48 kHz, stereo) instead of an `.m4a`. The preview reads 1 s chunks of that file over binary IPC (same pattern as `audio_envelope`) and schedules them back to back on the `AudioContext` clock, keeping 2 s queued ahead of the playhead. The scheduler plans in terms of timeline **segments** so sub-project 2 (multi-clip timeline) can feed it several clips. A small Rust cache module tracks last use per source and prunes the proxy + audio cache to a cap stored in app settings.

**Tech Stack:** Tauri 2 (Rust), ffmpeg (bundled), React 19 + TypeScript, Web Audio API, Vitest, cargo test.

**Spec:** `docs/superpowers/specs/2026-09-25-timeline-editor-design.md` §3 (and §8 testing).

## Global Constraints

- PCM cache format: `s16le`, 48 kHz, stereo, `track-{index}.pcm`; byte offset for time `t` = `round(t * 48000) * 4`.
- Scheduler: 1 s chunks, 2 s lookahead, on the `AudioContext` clock; seek/rate/segment change stops queued sources and refills.
- Drift check against the video clock: resync over 100 ms, at most once a second (unchanged from `8b13664`).
- Preview audio memory bounded by the queue, independent of clip length (success criterion: under 50 MB for a 30-minute 4-track source).
- Cache cap default **10 GB** (proxies + PCM + envelopes), configurable in Settings; LRU by last-opened source; plus "Clear cache".
- Every export still has 0 or 1 audio streams (export reads the source, not the cache — do not touch `audio_mix.rs` / `export.rs`).
- No Claude attribution lines in commits (project memory rule).
- Frontend commands: `npm test`, `npm run build`, `npm run lint`. Rust: `cd src-tauri && cargo test`.

**Deviation from spec §3, flagged for the reviewer:** the spec says chunks are fetched "over the asset protocol (`Range`)". This plan reads them through a binary IPC command instead, because the codebase already does this for envelopes to avoid asset-protocol CORS (`src-tauri/src/commands.rs` `audio_envelope`). Same byte math, same memory profile, and the `asset:` entry added to `connect-src` in `8b13664` can be removed again.

## Review Focus

1. **Seeking to the last second of a clip**: chunk requests past the end are clamped; the last partial chunk plays; nothing is requested beyond `frames`. (Task 3, Task 4 tests.)
2. **A chunk resolving after the user seeked or paused**: it must be dropped, never played at its old time. That's the exact "repeating audio" symptom the user hit. (Task 4 test "stale chunk".)
3. **A chunk arriving after its scheduled time** (slow disk, first chunk after play): it starts part-way in at the correct audio position, and is dropped if it's fully late. It must not play late and push everything behind the video. (Task 4 test "late chunk".)
4. **Clear cache while a clip is open**: the open clip's PCM, envelope and proxy survive, and playback continues. (Task 5 test `prune_keeps_listed_keys`, Task 6 test.)
5. **Stale cache from the previous build** (a directory with `.m4a` files and no `.pcm`): it must regenerate, not error. (Task 1 test `regenerates_when_pcm_missing`.)

---

### Task 1: Write raw PCM per track in audio prep

**Files:**
- Modify: `src-tauri/src/audio_prep.rs` (whole file; `.m4a` output replaced by `.pcm`)
- Test: `src-tauri/src/audio_prep.rs` (`mod tests`)

**Interfaces:**
- Produces: `pub const PCM_RATE: u32 = 48000;` `pub const PCM_BYTES_PER_FRAME: u64 = 4;`
- Produces: `pub struct PreparedTrack { pub index: u32, pub pcm_path: String, pub frames: u64, pub envelope_path: String }` (serde camelCase → `{ index, pcmPath, frames, envelopePath }`)
- Produces: `pub fn track_paths(dir: &Path, index: u32) -> (PathBuf, PathBuf)` returning `(track-{i}.pcm, env-{i}.f32)`

- [ ] **Step 1: Update the path test and add the stale-cache test**

In `mod tests`, change `cache_paths_are_per_source_and_track`:

```rust
        assert!(track_paths(&d, 2).0.ends_with("track-2.pcm"));
        assert!(track_paths(&d, 2).1.ends_with("env-2.f32"));
```

Add:

```rust
    /// Needs ffmpeg on PATH. A cache dir left by the m4a build (no .pcm) must regenerate.
    #[test]
    #[ignore]
    fn regenerates_when_pcm_missing() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("one.mp4");
        assert!(crate::ffmpeg::tool_command("ffmpeg")
            .args(["-hide_banner", "-y", "-f", "lavfi", "-i", "sine=f=440:d=1", "-c:a", "aac"])
            .arg(&src).status().unwrap().success());
        let adir = audio_dir(dir.path(), &src);
        std::fs::create_dir_all(&adir).unwrap();
        std::fs::write(adir.join("track-0.m4a"), b"old").unwrap();
        std::fs::write(adir.join("env-0.f32"), [0u8; 8]).unwrap();
        let t = prepare_audio_files(dir.path(), &src, 1).unwrap();
        assert!(std::path::Path::new(&t[0].pcm_path).exists());
        assert!((47_000..=49_100).contains(&t[0].frames), "frames {}", t[0].frames);
    }
```

In `prepare_real_two_track_file`, replace the last assertion with:

```rust
        let pcm1 = std::fs::metadata(&t[1].pcm_path).unwrap().len();
        assert_eq!(pcm1 % PCM_BYTES_PER_FRAME, 0);
        assert_eq!(t[1].frames, pcm1 / PCM_BYTES_PER_FRAME);
        assert!((95_000..=97_100).contains(&t[0].frames), "2 s at 48 kHz, got {}", t[0].frames);
```

Add a sample-exactness test:

```rust
    /// PCM written by the multi-output run is byte-identical to a direct single-track decode.
    /// Run: cargo test pcm_matches_direct_decode -- --ignored
    #[test]
    #[ignore]
    fn pcm_matches_direct_decode() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("two.mp4");
        assert!(crate::ffmpeg::tool_command("ffmpeg")
            .args(["-hide_banner", "-y", "-f", "lavfi", "-i", "sine=f=440:d=2", "-f", "lavfi", "-i", "sine=f=220:d=2", "-map", "0:a", "-map", "1:a", "-c:a", "aac"])
            .arg(&src).status().unwrap().success());
        let t = prepare_audio_files(dir.path(), &src, 2).unwrap();
        let direct = crate::ffmpeg::tool_command("ffmpeg")
            .args(["-hide_banner", "-nostdin", "-i"]).arg(&src)
            .args(["-map", "0:a:1", "-vn", "-ac", "2", "-ar", "48000", "-f", "s16le", "-"])
            .output().unwrap().stdout;
        assert_eq!(std::fs::read(&t[1].pcm_path).unwrap(), direct);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test audio_prep && cargo test audio_prep -- --ignored`
Expected: compile errors (`pcm_path`, `frames`, `PCM_BYTES_PER_FRAME` not found).

- [ ] **Step 3: Implement**

In `src-tauri/src/audio_prep.rs`:

```rust
/// Preview playback PCM: interleaved s16le stereo at 48 kHz, so time t is at byte round(t*48000)*4.
pub const PCM_RATE: u32 = 48000;
pub const PCM_BYTES_PER_FRAME: u64 = 4;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedTrack {
    pub index: u32,
    pub pcm_path: String,
    pub frames: u64,
    pub envelope_path: String,
}

pub fn track_paths(dir: &Path, index: u32) -> (PathBuf, PathBuf) {
    (dir.join(format!("track-{index}.pcm")), dir.join(format!("env-{index}.f32")))
}
```

Rename `m4a_part` to `pcm_part` (suffix `.part.pcm`) and in `generate_all` replace the stream-copy output args with:

```rust
    for i in 0..count as usize {
        cmd.args(["-map", &format!("0:a:{i}"), "-vn", "-ac", "2", "-ar", &PCM_RATE.to_string(), "-f", "s16le"]).arg(&pcm_parts[i]);
    }
```

(rename the `m4a_parts` variable to `pcm_parts` throughout `generate_all`; update its doc comment to say "raw PCM (preview playback)").

In `prepare_audio_files`, build each `PreparedTrack` with the frame count:

```rust
    paths
        .into_iter()
        .enumerate()
        .map(|(i, (pcm, env))| {
            let bytes = std::fs::metadata(&pcm).map_err(|e| e.to_string())?.len();
            Ok(PreparedTrack { index: i as u32, pcm_path: pcm.to_string_lossy().into_owned(), frames: bytes / PCM_BYTES_PER_FRAME, envelope_path: env.to_string_lossy().into_owned() })
        })
        .collect()
```

Update its doc comment: "Per-track raw PCM (preview) plus a 200 Hz RMS envelope (waveforms, ducking)."

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test audio_prep && cargo test audio_prep -- --ignored`
Expected: all `audio_prep` tests PASS (the real-clip timing test needs `SOCIALFRAG_CLIPS_DIR`; run it with `SOCIALFRAG_CLIPS_DIR="../example clips" cargo test prepare_real_clip_under_3s -- --ignored` and expect PASS; if raw PCM pushes it over 3 s, note the measured time in the commit message instead of changing the threshold).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/audio_prep.rs
git commit -m "feat(audio-prep): write raw s16le 48 kHz PCM per track instead of m4a"
```

---

### Task 2: Binary IPC command to read a PCM range

**Files:**
- Modify: `src-tauri/src/audio_prep.rs` (add `read_pcm_range`)
- Modify: `src-tauri/src/commands.rs` (add `audio_pcm_chunk`, share cache-path guard with `audio_envelope`, stop `allow_asset` for audio)
- Modify: `src-tauri/src/lib.rs:22-34` (register command)
- Modify: `src-tauri/tauri.conf.json` (drop `asset: http://asset.localhost` from both `connect-src` lists)

**Interfaces:**
- Consumes: `PCM_BYTES_PER_FRAME` (Task 1)
- Produces: `pub fn read_pcm_range(path: &Path, start_frame: u64, frames: u64) -> Result<Vec<u8>, String>` — clamps to the file; returns `min(frames, MAX_CHUNK_FRAMES, total - start)` frames of bytes (empty past the end).
- Produces: Tauri command `audio_pcm_chunk { path: String, startFrame: u64, frames: u64 } -> raw bytes`.

- [ ] **Step 1: Write the failing test**

In `audio_prep.rs` `mod tests`:

```rust
    #[test]
    fn read_pcm_range_clamps_to_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.pcm");
        let bytes: Vec<u8> = (0..40u8).collect(); // 10 frames
        std::fs::write(&p, &bytes).unwrap();
        assert_eq!(read_pcm_range(&p, 2, 3).unwrap(), bytes[8..20].to_vec());
        assert_eq!(read_pcm_range(&p, 8, 5).unwrap(), bytes[32..40].to_vec());
        assert!(read_pcm_range(&p, 10, 5).unwrap().is_empty());
        assert!(read_pcm_range(&p, 99, 5).unwrap().is_empty());
    }

    #[test]
    fn read_pcm_range_ignores_a_truncated_trailing_frame() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.pcm");
        std::fs::write(&p, [1u8; 10]).unwrap(); // 2 whole frames + 2 stray bytes
        assert_eq!(read_pcm_range(&p, 0, 10).unwrap().len(), 8);
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && cargo test read_pcm_range`
Expected: FAIL, `read_pcm_range` not found.

- [ ] **Step 3: Implement**

In `audio_prep.rs` (add `use std::io::{Seek, SeekFrom};` to the imports):

```rust
/// Upper bound on one IPC chunk (5 s) so a bad request can't read a whole file into memory.
pub const MAX_CHUNK_FRAMES: u64 = PCM_RATE as u64 * 5;

pub fn read_pcm_range(path: &Path, start_frame: u64, frames: u64) -> Result<Vec<u8>, String> {
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let total = f.metadata().map_err(|e| e.to_string())?.len() / PCM_BYTES_PER_FRAME;
    let start = start_frame.min(total);
    let end = start.saturating_add(frames.min(MAX_CHUNK_FRAMES)).min(total);
    let mut buf = vec![0u8; ((end - start) * PCM_BYTES_PER_FRAME) as usize];
    f.seek(SeekFrom::Start(start * PCM_BYTES_PER_FRAME)).map_err(|e| e.to_string())?;
    f.read_exact(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}
```

In `commands.rs`, replace the body of `audio_envelope` with a shared guard and add the new command:

```rust
/// Only files inside the audio cache with the expected extension are readable from the webview.
fn audio_cache_file(app: &AppHandle, path: &str, ext: &str) -> Result<PathBuf, String> {
    let root = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("audio");
    let p = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    let root = std::fs::canonicalize(&root).map_err(|e| e.to_string())?;
    if !p.starts_with(&root) || p.extension().map_or(true, |x| x != ext) {
        return Err(format!("not an audio cache .{ext} file"));
    }
    Ok(p)
}

/// Raw f32le bytes over IPC; avoids asset-protocol CORS for fetch().
#[tauri::command]
pub fn audio_envelope(app: AppHandle, path: String) -> Result<tauri::ipc::Response, String> {
    let p = audio_cache_file(&app, &path, "f32")?;
    std::fs::read(&p).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

/// One chunk of preview PCM (s16le stereo 48 kHz) as raw bytes.
#[tauri::command]
pub fn audio_pcm_chunk(app: AppHandle, path: String, start_frame: u64, frames: u64) -> Result<tauri::ipc::Response, String> {
    let p = audio_cache_file(&app, &path, "pcm")?;
    crate::audio_prep::read_pcm_range(&p, start_frame, frames).map(tauri::ipc::Response::new)
}
```

In `prepare_audio`, delete the loop that calls `allow_asset` for `t.audio_path` (PCM is read over IPC, not the asset protocol).

In `lib.rs`, add `commands::audio_pcm_chunk,` after `commands::audio_envelope,`.

In `tauri.conf.json`, change both `connect-src 'self' ipc: http://ipc.localhost asset: http://asset.localhost` back to `connect-src 'self' ipc: http://ipc.localhost`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd src-tauri && cargo test && cargo build`
Expected: all non-ignored tests PASS, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/audio_prep.rs src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/tauri.conf.json
git commit -m "feat(audio): audio_pcm_chunk IPC command for ranged PCM reads"
```

---

### Task 3: Frontend PCM helpers and segment scheduler math

**Files:**
- Create: `src/audio/pcm.ts`
- Create: `src/audio/scheduler.ts`
- Test: `src/audio/pcm.test.ts`, `src/audio/scheduler.test.ts`

**Interfaces:**
- Produces (`pcm.ts`): `PCM_RATE = 48000`, `PCM_BYTES_PER_FRAME = 4`, `frameAt(seconds: number): number`, `s16StereoToPlanar(bytes: ArrayBuffer): [Float32Array, Float32Array]`
- Produces (`scheduler.ts`):
  - `CHUNK_FRAMES = 48000`, `LOOKAHEAD_S = 2`
  - `interface Segment { pcmPath: string; totalFrames: number; srcStartS: number; timelineStartS: number; durationS: number; offsetS: number }`
  - `interface Cursor { frame: number; endFrame: number; when: number }`
  - `interface Chunk { startFrame: number; frames: number; when: number }`
  - `startCursor(seg: Segment, t: number, now: number, rate: number): Cursor | null`
  - `planChunks(cursor: Cursor, now: number, rate: number): { chunks: Chunk[]; cursor: Cursor }`

- [ ] **Step 1: Write the failing tests**

`src/audio/pcm.test.ts`:

```ts
import { expect, test } from 'vitest';
import { frameAt, s16StereoToPlanar } from './pcm';

test('frameAt rounds seconds to 48 kHz frames and clamps negatives', () => {
  expect(frameAt(1)).toBe(48000);
  expect(frameAt(12.5)).toBe(600000);
  expect(frameAt(-3)).toBe(0);
});

test('s16StereoToPlanar splits interleaved little-endian s16 into two float channels', () => {
  const v = new DataView(new ArrayBuffer(8));
  v.setInt16(0, 16384, true);
  v.setInt16(2, -32768, true);
  v.setInt16(4, 0, true);
  v.setInt16(6, 32767, true);
  const [l, r] = s16StereoToPlanar(v.buffer);
  expect(Array.from(l)).toEqual([0.5, 0]);
  expect(r[0]).toBe(-1);
  expect(r[1]).toBeCloseTo(1, 4);
});

test('s16StereoToPlanar ignores a trailing partial frame', () => {
  const [l] = s16StereoToPlanar(new ArrayBuffer(6));
  expect(l.length).toBe(1);
});
```

`src/audio/scheduler.test.ts`:

```ts
import { expect, test } from 'vitest';
import { planChunks, startCursor, type Segment } from './scheduler';

const whole = (over: Partial<Segment> = {}): Segment => ({ pcmPath: 'p', totalFrames: 48000 * 100, srcStartS: 0, timelineStartS: 0, durationS: Infinity, offsetS: 0, ...over });

test('startCursor at the playhead starts now at the matching frame', () => {
  expect(startCursor(whole(), 12, 5, 1)).toEqual({ frame: 576000, endFrame: 4800000, when: 5 });
});

test('a positive offset delays the start and begins at frame 0', () => {
  expect(startCursor(whole({ offsetS: 0.5 }), 0, 5, 1)).toEqual({ frame: 0, endFrame: 4800000, when: 5.5 });
  expect(startCursor(whole({ offsetS: 0.5 }), 0, 5, 2)).toEqual({ frame: 0, endFrame: 4800000, when: 5.25 });
});

test('a negative offset starts later in the file', () => {
  expect(startCursor(whole({ offsetS: -0.5 }), 1, 0, 1)!.frame).toBe(72000);
});

test('startCursor returns null at or past the end of the audio', () => {
  expect(startCursor(whole(), 100, 0, 1)).toBeNull();
  expect(startCursor(whole({ durationS: 10 }), 10, 0, 1)).toBeNull();
});

test('a segment later on the timeline waits for its start', () => {
  const c = startCursor(whole({ timelineStartS: 20, srcStartS: 3, durationS: 5 }), 18, 0, 1)!;
  expect(c).toEqual({ frame: 144000, endFrame: 384000, when: 2 });
});

test('planChunks queues 1 s chunks up to 2 s ahead and advances the cursor', () => {
  const { chunks, cursor } = planChunks({ frame: 0, endFrame: 4800000, when: 0 }, 0, 1);
  expect(chunks).toEqual([
    { startFrame: 0, frames: 48000, when: 0 },
    { startFrame: 48000, frames: 48000, when: 1 },
  ]);
  expect(cursor).toEqual({ frame: 96000, endFrame: 4800000, when: 2 });
  expect(planChunks(cursor, 0.5, 1).chunks).toEqual([]);
  expect(planChunks(cursor, 1, 1).chunks).toEqual([{ startFrame: 96000, frames: 48000, when: 2 }]);
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/audio/pcm.test.ts src/audio/scheduler.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`src/audio/pcm.ts`:

```ts
/** Preview PCM written by prepare_audio: interleaved s16le stereo at 48 kHz. */
export const PCM_RATE = 48000;
export const PCM_BYTES_PER_FRAME = 4;

export const frameAt = (seconds: number) => Math.max(0, Math.round(seconds * PCM_RATE));

export function s16StereoToPlanar(bytes: ArrayBuffer): [Float32Array, Float32Array] {
  const n = Math.floor(bytes.byteLength / PCM_BYTES_PER_FRAME);
  const v = new DataView(bytes);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    l[i] = v.getInt16(i * 4, true) / 32768;
    r[i] = v.getInt16(i * 4 + 2, true) / 32768;
  }
  return [l, r];
}
```

`src/audio/scheduler.ts`:

```ts
import { PCM_RATE, frameAt } from './pcm';

export const CHUNK_FRAMES = PCM_RATE;
export const LOOKAHEAD_S = 2;

/**
 * A stretch of one track's PCM placed on the timeline: timeline time T plays source time
 * srcStartS + (T - timelineStartS) - offsetS, for T in [timelineStartS, timelineStartS + durationS).
 * A single open clip is one segment per track with timelineStartS = srcStartS = 0, durationS = Infinity.
 */
export interface Segment { pcmPath: string; totalFrames: number; srcStartS: number; timelineStartS: number; durationS: number; offsetS: number }
/** Next source frame to queue, the frame to stop at, and the context time `frame` plays at. */
export interface Cursor { frame: number; endFrame: number; when: number }
export interface Chunk { startFrame: number; frames: number; when: number }

export function startCursor(seg: Segment, t: number, now: number, rate: number): Cursor | null {
  if (t >= seg.timelineStartS + seg.durationS) return null;
  const srcT = seg.srcStartS + (t - seg.timelineStartS) - seg.offsetS;
  const wait = Math.max(0, seg.timelineStartS - t, seg.srcStartS - srcT);
  const endFrame = Math.min(seg.totalFrames, Number.isFinite(seg.durationS) ? frameAt(seg.srcStartS + seg.durationS - seg.offsetS) : seg.totalFrames);
  const frame = frameAt(srcT + wait);
  if (frame >= endFrame) return null;
  return { frame, endFrame, when: now + wait / rate };
}

export function planChunks(cursor: Cursor, now: number, rate: number): { chunks: Chunk[]; cursor: Cursor } {
  const chunks: Chunk[] = [];
  let { frame, when } = cursor;
  while (when < now + LOOKAHEAD_S && frame < cursor.endFrame) {
    const frames = Math.min(CHUNK_FRAMES, cursor.endFrame - frame);
    chunks.push({ startFrame: frame, frames, when });
    frame += frames;
    when += frames / PCM_RATE / rate;
  }
  return { chunks, cursor: { frame, endFrame: cursor.endFrame, when } };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/audio/pcm.test.ts src/audio/scheduler.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add src/audio/pcm.ts src/audio/scheduler.ts src/audio/pcm.test.ts src/audio/scheduler.test.ts
git commit -m "feat(audio): PCM helpers and segment chunk scheduler"
```

---

### Task 4: Stream chunks in AudioPreview; backend readPcm

**Files:**
- Modify: `src/backend/types.ts` (`PreparedTrack`, `Backend.readPcm`)
- Modify: `src/backend/tauri.ts` (`prepareAudio`, add `readPcm`)
- Modify: `src/backend/fake.ts` (add `readPcm`)
- Modify: `src/audio/AudioPreview.ts` (replace full-buffer decode with chunk streaming)
- Modify: `src/App.tsx:236` (pass the reader)
- Test: `src/audio/AudioPreview.test.ts` (rewrite), `src/App.test.tsx:115` (fixture shape)

**Interfaces:**
- Consumes: `startCursor`, `planChunks`, `Cursor`, `Segment` (Task 3); `PCM_RATE`, `s16StereoToPlanar` (Task 3); `audio_pcm_chunk` command (Task 2); `PreparedTrack { index, pcmPath, frames, envelopePath }` over IPC (Task 1)
- Produces: `interface PreparedTrack { index: number; pcmPath: string; frames: number; envelope: Float32Array }`
- Produces: `Backend.readPcm(path: string, startFrame: number, frames: number): Promise<ArrayBuffer>`
- Produces: `type ReadPcm = (path: string, startFrame: number, frames: number) => Promise<ArrayBuffer>`; `new AudioPreview(video, tracks, readPcm, makeContext?)`; public `pump(): void` (called every frame; public for tests)

- [ ] **Step 1: Rewrite the AudioPreview tests**

Replace `src/audio/AudioPreview.test.ts` with:

```ts
import { expect, test } from 'vitest';
import { AudioPreview, audioTargetTime, curveFrom, driftExceeded } from './AudioPreview';
import type { TrackMix } from '../types';

function makeFakeVideo() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    currentTime: 0,
    paused: true,
    playbackRate: 1,
    muted: false,
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

type Started = { when: number; offset: number; frames: number; stopped: boolean };
function makeFakeCtx() {
  const started: Started[] = [];
  const ctx = {
    started,
    currentTime: 0,
    destination: {},
    createDynamicsCompressor: () => ({ threshold: { value: 0 }, ratio: { value: 0 }, knee: { value: 0 }, attack: { value: 0 }, release: { value: 0 }, connect: (n: unknown) => n }),
    createGain: () => ({ gain: { value: 0, cancelScheduledValues: () => {}, setValueAtTime: () => {}, setValueCurveAtTime: () => {} }, connect: (n: unknown) => n }),
    createBuffer: (_ch: number, frames: number) => ({ frames, copyToChannel: () => {} }),
    createBufferSource: () => {
      const rec: Started = { when: -1, offset: -1, frames: 0, stopped: false };
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

const track = (overrides: Partial<TrackMix> = {}): TrackMix => ({
  index: 0, sourceLabel: 'A', label: 'A', enabled: true, gain: 1, ceilingDb: null, offsetS: 0, fadeInS: 0, fadeOutS: 0, mutes: [], ...overrides,
});

/** readPcm stub: records requests; resolves immediately unless `hold` is set. */
function makeReader() {
  const calls: { startFrame: number; frames: number; resolve: () => void }[] = [];
  let hold = false;
  const read = (_p: string, startFrame: number, frames: number) =>
    new Promise<ArrayBuffer>((resolve) => {
      const done = () => resolve(new ArrayBuffer(frames * 4));
      calls.push({ startFrame, frames, resolve: done });
      if (!hold) done();
    });
  return { read, calls, setHold: (h: boolean) => (hold = h) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(frames = 48000 * 100, mix = track()) {
  const video = makeFakeVideo();
  const ctx = makeFakeCtx();
  const reader = makeReader();
  const preview = new AudioPreview(
    video as unknown as HTMLVideoElement,
    [{ index: 0, pcmPath: '/c/audio/k/track-0.pcm', frames, envelope: new Float32Array() }],
    reader.read,
    () => ctx as unknown as AudioContext,
  );
  preview.setMix({ tracks: [mix], duck: null }, new Map());
  return { video, ctx, reader, preview };
}

async function play(s: ReturnType<typeof setup>, at = 0) {
  s.video.currentTime = at;
  s.video.paused = false;
  s.video.fire('play');
  await flush();
}

test('offset moves the audio later', () => {
  expect(audioTargetTime(10, 0.25)).toBeCloseTo(9.75);
});

test('curveFrom starts at the playhead sample', () => {
  const c = Float32Array.from({ length: 1000 }, (_, i) => i);
  expect(curveFrom(c, 2)[0]).toBe(400);
});

test('driftExceeded flags video more than 100 ms from the audio clock', () => {
  expect(driftExceeded(10.2, 10, 0, 0, 1)).toBe(true);
  expect(driftExceeded(10.05, 10, 0, 0, 1)).toBe(false);
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

test('stale chunk: a read that resolves after a seek is dropped', async () => {
  const s = setup();
  s.reader.setHold(true);
  await play(s, 0);
  const pending = s.reader.calls.slice();
  s.reader.setHold(false);
  s.video.currentTime = 40;
  s.video.fire('seeked');
  await flush();
  pending.forEach((c) => c.resolve());
  await flush();
  expect(s.ctx.started.every((x) => x.when >= 0)).toBe(true);
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
  const s = setup(48000 * 100, track({ offsetS: 0.5 }));
  await play(s, 0);
  expect(s.reader.calls[0].startFrame).toBe(0);
  expect(s.ctx.started[0].when).toBeCloseTo(0.5);
  s.preview.dispose();
});

test('near the end: one partial chunk, nothing past the last frame', async () => {
  const s = setup(60000);
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
  s.video.paused = true;
  s.video.fire('pause');
  const n = s.reader.calls.length;
  s.ctx.currentTime = 5;
  s.preview.pump();
  expect(s.ctx.started.every((x) => x.stopped)).toBe(true);
  expect(s.reader.calls).toHaveLength(n);
  s.preview.dispose();
});

test('a disabled track reads nothing', async () => {
  const s = setup(48000 * 100, track({ enabled: false }));
  await play(s, 0);
  expect(s.reader.calls).toHaveLength(0);
  s.preview.dispose();
});

test('gain edits while playing keep the queue; an offset change restarts it', async () => {
  const s = setup();
  await play(s, 0);
  const n = s.reader.calls.length;
  s.preview.setMix({ tracks: [track({ gain: 0.5 })], duck: null }, new Map());
  expect(s.reader.calls).toHaveLength(n);
  s.preview.setMix({ tracks: [track({ gain: 0.5, offsetS: 0.3 })], duck: null }, new Map());
  await flush();
  expect(s.reader.calls.length).toBeGreaterThan(n);
  expect(s.ctx.started.slice(0, 2).every((x) => x.stopped)).toBe(true);
  s.preview.dispose();
});
```

In `src/App.test.tsx:115` change the fixture to:

```ts
  resolveFirst([{ index: 0, pcmPath: '/c/a.pcm', frames: 480000, envelope: new Float32Array(10) }]);
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/audio/AudioPreview.test.ts`
Expected: FAIL (constructor signature / `pump` / `createBuffer` path not implemented).

- [ ] **Step 3: Implement the backend changes**

`src/backend/types.ts`:

```ts
/** Preview audio for one source track: raw PCM in the cache (read in chunks) plus its envelope. */
export interface PreparedTrack {
  index: number;
  pcmPath: string;
  frames: number;
  envelope: Float32Array;
}
```

and in `Backend`, after `prepareAudio`:

```ts
  /** Raw s16le stereo 48 kHz bytes for frames [startFrame, startFrame + frames), clamped to the file. */
  readPcm(path: string, startFrame: number, frames: number): Promise<ArrayBuffer>;
```

`src/backend/tauri.ts` `prepareAudio`:

```ts
      const tracks = await invoke<{ index: number; pcmPath: string; frames: number; envelopePath: string }[]>('prepare_audio', { path });
      return await Promise.all(
        tracks.map(async (t) => ({
          index: t.index,
          pcmPath: t.pcmPath,
          frames: t.frames,
          envelope: new Float32Array(await invoke<ArrayBuffer>('audio_envelope', { path: t.envelopePath })),
        })),
      );
```

and add:

```ts
  readPcm(path: string, startFrame: number, frames: number) {
    return invoke<ArrayBuffer>('audio_pcm_chunk', { path, startFrame, frames });
  }
```

`src/backend/fake.ts`, after `prepareAudio`:

```ts
  async readPcm(_path: string, _startFrame: number, _frames: number): Promise<ArrayBuffer> {
    throw new Error('Audio preview needs the desktop app.');
  }
```

- [ ] **Step 4: Implement streaming in AudioPreview**

Replace `src/audio/AudioPreview.ts` with:

```ts
import type { PreparedTrack } from '../backend/types';
import type { AudioMix, TrackMix } from '../types';
import { SAMPLE_RATE } from './curve';
import { PCM_RATE, s16StereoToPlanar } from './pcm';
import { planChunks, startCursor, type Cursor } from './scheduler';

const MAX_DRIFT_S = 0.1;
/** Don't restart for drift more often than this; each restart is audible. */
const MIN_RESYNC_GAP_S = 1;

export const audioTargetTime = (videoT: number, offsetS: number) => videoT - offsetS;
export const curveFrom = (curve: Float32Array, t: number) => curve.subarray(Math.min(curve.length, Math.max(0, Math.floor(t * SAMPLE_RATE))));

/** Where the video clock should be right now given the last (videoT0, ctxT0, rate) anchor recorded at start time. */
export const expectedVideoTime = (videoT0: number, ctxT0: number, ctxNow: number, rate: number) => videoT0 + (ctxNow - ctxT0) * rate;
export const driftExceeded = (videoT: number, videoT0: number, ctxT0: number, ctxNow: number, rate: number) =>
  Math.abs(videoT - expectedVideoTime(videoT0, ctxT0, ctxNow, rate)) > MAX_DRIFT_S;

export type ReadPcm = (path: string, startFrame: number, frames: number) => Promise<ArrayBuffer>;

interface Node { track: PreparedTrack; cursor: Cursor | null; sources: Set<AudioBufferSourceNode>; gain: GainNode; ceiling: DynamicsCompressorNode; mix: TrackMix | null; curve: Float32Array | null }
interface Anchor { videoT0: number; ctxT0: number; rate: number }

/**
 * Streams each prepared track's PCM in 1 s chunks, scheduled back to back on the AudioContext clock
 * with 2 s queued ahead, through gain curve → ceiling → master limiter. The (muted) video is the
 * timeline: play/seek/rate/offset changes drop the queue and refill from the video's position.
 * Memory is bounded by the queue, not the clip length.
 */
export class AudioPreview {
  private ctx: AudioContext;
  private nodes = new Map<number, Node>();
  private raf = 0;
  private readonly off: (() => void)[] = [];
  private video: HTMLVideoElement;
  /** Video/context time pair of the last restart; drift is measured against it. */
  private anchor: Anchor | null = null;
  private lastResync = -Infinity;
  /** Bumped on every restart/stop so chunk reads that resolve afterwards are dropped. */
  private session = 0;
  private disposed = false;

  constructor(video: HTMLVideoElement, tracks: PreparedTrack[], private readPcm: ReadPcm, makeContext?: () => AudioContext) {
    this.video = video;
    this.ctx = makeContext ? makeContext() : new AudioContext({ sampleRate: PCM_RATE });
    const master = this.ctx.createDynamicsCompressor();
    master.threshold.value = -1;
    master.ratio.value = 20;
    master.knee.value = 0;
    master.attack.value = 0.001;
    master.release.value = 0.05;
    master.connect(this.ctx.destination);
    for (const t of tracks) {
      const gain = this.ctx.createGain();
      const ceiling = this.ctx.createDynamicsCompressor();
      ceiling.knee.value = 0;
      ceiling.attack.value = 0.001;
      ceiling.release.value = 0.05;
      gain.connect(ceiling).connect(master);
      this.nodes.set(t.index, { track: t, cursor: null, sources: new Set(), gain, ceiling, mix: null, curve: null });
    }
    video.muted = true;
    const on = (ev: string, fn: () => void) => {
      video.addEventListener(ev, fn);
      this.off.push(() => video.removeEventListener(ev, fn));
    };
    on('play', () => void this.play());
    on('playing', () => this.restart());
    on('pause', () => this.stop());
    on('waiting', () => this.stop());
    on('seeked', () => (video.paused ? this.schedule() : this.restart()));
    on('ratechange', () => (video.paused ? undefined : this.restart()));
    const tick = () => {
      if (!video.paused && this.anchor && this.ctx.currentTime - this.lastResync > MIN_RESYNC_GAP_S) {
        if (driftExceeded(video.currentTime, this.anchor.videoT0, this.anchor.ctxT0, this.ctx.currentTime, this.anchor.rate)) this.restart();
      }
      this.pump();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  setMix(mix: AudioMix, curves: Map<number, Float32Array>) {
    let restart = false;
    for (const [index, n] of this.nodes) {
      const nextMix = mix.tracks.find((t) => t.index === index) ?? null;
      if (!n.mix || !nextMix || n.mix.offsetS !== nextMix.offsetS || n.mix.enabled !== nextMix.enabled) restart = true;
      n.mix = nextMix;
      n.curve = curves.get(index) ?? null;
      const db = n.mix?.ceilingDb;
      n.ceiling.threshold.value = db ?? 0;
      n.ceiling.ratio.value = db === null || db === undefined ? 1 : 20;
    }
    if (restart && !this.video.paused) this.restart();
    else this.schedule();
  }

  /** Queue chunks up to the lookahead for every track with a cursor. Called every frame; public for tests. */
  pump() {
    if (this.disposed || this.video.paused) return;
    const now = this.ctx.currentTime;
    const rate = this.video.playbackRate;
    const session = this.session;
    for (const n of this.nodes.values()) {
      if (!n.cursor) continue;
      const plan = planChunks(n.cursor, now, rate);
      n.cursor = plan.cursor;
      for (const c of plan.chunks) {
        this.readPcm(n.track.pcmPath, c.startFrame, c.frames).then(
          (bytes) => this.playChunk(n, bytes, c.when, rate, session),
          () => {},
        );
      }
    }
  }

  private playChunk(n: Node, bytes: ArrayBuffer, when: number, rate: number, session: number) {
    if (this.disposed || session !== this.session) return;
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
    };
    src.start(Math.max(when, now), late * rate);
    n.sources.add(src);
  }

  private async play() {
    await this.ctx.resume();
    if (!this.video.paused) this.restart();
  }

  private stopSources() {
    this.session++;
    for (const n of this.nodes.values()) {
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
  }

  private stop() {
    this.stopSources();
    this.anchor = null;
    this.schedule();
  }

  /** Drop the queue and start every enabled track at the video's current position. */
  private restart() {
    if (this.disposed) return;
    this.stopSources();
    const now = this.ctx.currentTime;
    const rate = this.video.playbackRate;
    const videoT = this.video.currentTime;
    for (const n of this.nodes.values()) {
      if (!n.mix?.enabled) continue;
      n.cursor = startCursor(
        { pcmPath: n.track.pcmPath, totalFrames: n.track.frames, srcStartS: 0, timelineStartS: 0, durationS: Infinity, offsetS: n.mix.offsetS },
        videoT,
        now,
        rate,
      );
    }
    this.anchor = { videoT0: videoT, ctxT0: now, rate };
    this.lastResync = now;
    this.schedule();
    this.pump();
  }

  /** Gain automation from the playhead onwards; while paused just the current value. */
  private schedule() {
    const now = this.ctx.currentTime;
    const t = this.video.currentTime;
    for (const n of this.nodes.values()) {
      n.gain.gain.cancelScheduledValues(now);
      const rest = n.curve && n.mix?.enabled ? curveFrom(n.curve, t) : null;
      if (!rest || rest.length < 2 || this.video.paused) {
        n.gain.gain.setValueAtTime(rest?.[0] ?? 0, now);
      } else {
        n.gain.gain.setValueCurveAtTime(rest, now, rest.length / SAMPLE_RATE / this.video.playbackRate);
      }
    }
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.off.forEach((f) => f());
    this.stopSources();
    void this.ctx.close();
    this.video.muted = false;
  }
}
```

In `src/App.tsx:236` change the construction to:

```ts
      p = new AudioPreview(video, prepared, (path, start, frames) => backend.readPcm(path, start, frames));
```

and add `backend` to that effect's dependency array: `}, [video, prepared, backend]);`

- [ ] **Step 5: Run to verify everything passes**

Run: `npm test && npm run build && npm run lint`
Expected: all tests PASS, build clean, no new lint warnings in `src/audio` or `src/backend`.

- [ ] **Step 6: Commit**

```bash
git add src/backend/types.ts src/backend/tauri.ts src/backend/fake.ts src/audio/AudioPreview.ts src/audio/AudioPreview.test.ts src/App.tsx src/App.test.tsx
git commit -m "feat(audio-preview): stream PCM in 1 s chunks with a 2 s lookahead"
```

---

### Task 5: Cache LRU tracking, pruning and settings (Rust)

**Files:**
- Create: `src-tauri/src/cache.rs`
- Create: `src-tauri/src/settings.rs`
- Modify: `src-tauri/src/lib.rs` (modules + commands)
- Modify: `src-tauri/src/commands.rs` (touch + prune in `prepare_audio` and `make_proxy`; new cache commands)

**Interfaces:**
- Consumes: `proxy::source_key(&Path) -> String`
- Produces (`cache.rs`): `pub fn touch(cache: &Path, key: &str)`, `pub fn total_bytes(cache: &Path) -> u64`, `pub fn prune(cache: &Path, cap_bytes: u64, keep: &[String]) -> u64` (returns bytes freed)
- Produces (`settings.rs`): `pub struct Settings { pub cache_cap_gb: f64 }` (serde camelCase, default 10.0), `pub fn load(dir: &Path) -> Settings`, `pub fn save(dir: &Path, s: &Settings) -> Result<(), String>`
- Produces commands: `cache_info() -> CacheInfo { bytes: u64, capGb: f64 }`, `cache_set_cap(gb: f64, keep: Vec<String>) -> CacheInfo`, `cache_clear(keep: Vec<String>) -> CacheInfo`. `keep` holds **source video paths** currently open; they're converted with `source_key`.

- [ ] **Step 1: Write the failing tests**

`src-tauri/src/cache.rs` test module (write it at the bottom of the new file):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    fn entry(cache: &Path, key: &str, audio_bytes: usize, proxy_bytes: usize, age_s: u64) {
        let a = cache.join("audio").join(key);
        std::fs::create_dir_all(&a).unwrap();
        std::fs::write(a.join("track-0.pcm"), vec![0u8; audio_bytes]).unwrap();
        if proxy_bytes > 0 {
            std::fs::create_dir_all(cache.join("proxies")).unwrap();
            std::fs::write(cache.join("proxies").join(format!("{key}.mp4")), vec![0u8; proxy_bytes]).unwrap();
        }
        touch(cache, key);
        let t = SystemTime::now() - Duration::from_secs(age_s);
        std::fs::File::options().write(true).open(cache.join("lru").join(key)).unwrap().set_modified(t).unwrap();
    }

    #[test]
    fn total_counts_audio_and_proxies_only() {
        let d = tempfile::tempdir().unwrap();
        entry(d.path(), "a", 100, 50, 0);
        std::fs::create_dir_all(d.path().join("WebKit")).unwrap();
        std::fs::write(d.path().join("WebKit").join("x"), vec![0u8; 999]).unwrap();
        assert_eq!(total_bytes(d.path()), 150);
    }

    #[test]
    fn prune_removes_least_recently_used_first_until_under_cap() {
        let d = tempfile::tempdir().unwrap();
        entry(d.path(), "old", 100, 0, 300);
        entry(d.path(), "mid", 100, 0, 200);
        entry(d.path(), "new", 100, 0, 100);
        assert_eq!(prune(d.path(), 150, &[]), 200);
        assert!(!d.path().join("audio/old").exists());
        assert!(!d.path().join("audio/mid").exists());
        assert!(d.path().join("audio/new").exists());
        assert!(!d.path().join("lru/old").exists());
    }

    #[test]
    fn prune_keeps_listed_keys() {
        let d = tempfile::tempdir().unwrap();
        entry(d.path(), "open", 100, 40, 999);
        entry(d.path(), "other", 100, 0, 1);
        assert_eq!(prune(d.path(), 0, &["open".to_string()]), 100);
        assert!(d.path().join("audio/open").exists());
        assert!(d.path().join("proxies/open.mp4").exists());
        assert!(!d.path().join("audio/other").exists());
    }

    #[test]
    fn prune_under_cap_does_nothing() {
        let d = tempfile::tempdir().unwrap();
        entry(d.path(), "a", 100, 0, 0);
        assert_eq!(prune(d.path(), 1000, &[]), 0);
        assert!(d.path().join("audio/a").exists());
    }

    #[test]
    fn entries_without_lru_marker_count_as_oldest() {
        let d = tempfile::tempdir().unwrap();
        entry(d.path(), "tracked", 100, 0, 5000);
        std::fs::create_dir_all(d.path().join("audio/legacy")).unwrap();
        std::fs::write(d.path().join("audio/legacy/track-0.m4a"), vec![0u8; 100]).unwrap();
        assert_eq!(prune(d.path(), 150, &[]), 100);
        assert!(!d.path().join("audio/legacy").exists());
    }
}
```

`src-tauri/src/settings.rs` test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_10_gb_when_missing_or_corrupt() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(load(d.path()).cache_cap_gb, 10.0);
        std::fs::write(d.path().join("settings.json"), "{not json").unwrap();
        assert_eq!(load(d.path()).cache_cap_gb, 10.0);
    }

    #[test]
    fn round_trips() {
        let d = tempfile::tempdir().unwrap();
        save(d.path(), &Settings { cache_cap_gb: 25.0 }).unwrap();
        assert_eq!(load(d.path()).cache_cap_gb, 25.0);
    }
}
```

- [ ] **Step 2: Run to verify they fail**

Add `pub mod cache;` and `pub mod settings;` to `src-tauri/src/lib.rs` (alphabetical, after `pub mod audio_prep;` and before `pub mod presets_store;` respectively).
Run: `cd src-tauri && cargo test cache:: settings::`
Expected: FAIL, functions not found.

- [ ] **Step 3: Implement `cache.rs`**

```rust
//! Proxy + preview-audio cache bookkeeping. Entries are keyed by `proxy::source_key`:
//! `audio/<key>/` and `proxies/<key>.mp4`. Last use is the mtime of `lru/<key>`.
use std::path::{Path, PathBuf};
use std::time::SystemTime;

struct Entry { key: String, bytes: u64, last_used: SystemTime, paths: Vec<PathBuf> }

fn size_of(p: &Path) -> u64 {
    match std::fs::metadata(p) {
        Ok(m) if m.is_dir() => std::fs::read_dir(p).map(|rd| rd.filter_map(|e| e.ok()).map(|e| size_of(&e.path())).sum()).unwrap_or(0),
        Ok(m) => m.len(),
        Err(_) => 0,
    }
}

/// Mark a source's cache entry as used now.
pub fn touch(cache: &Path, key: &str) {
    let dir = cache.join("lru");
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(dir.join(key), b"");
}

fn entries(cache: &Path) -> Vec<Entry> {
    let mut map: std::collections::BTreeMap<String, Vec<PathBuf>> = Default::default();
    if let Ok(rd) = std::fs::read_dir(cache.join("audio")) {
        for e in rd.filter_map(|e| e.ok()) {
            map.entry(e.file_name().to_string_lossy().into_owned()).or_default().push(e.path());
        }
    }
    if let Ok(rd) = std::fs::read_dir(cache.join("proxies")) {
        for e in rd.filter_map(|e| e.ok()) {
            let p = e.path();
            if let Some(stem) = p.file_stem() {
                let key = stem.to_string_lossy().split('.').next().unwrap_or_default().to_string();
                map.entry(key).or_default().push(p);
            }
        }
    }
    map.into_iter()
        .map(|(key, paths)| {
            let last_used = std::fs::metadata(cache.join("lru").join(&key)).and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH);
            let bytes = paths.iter().map(|p| size_of(p)).sum();
            Entry { key, bytes, last_used, paths }
        })
        .collect()
}

pub fn total_bytes(cache: &Path) -> u64 {
    entries(cache).iter().map(|e| e.bytes).sum()
}

/// Delete least-recently-used entries (never those in `keep`) until the total is at most `cap_bytes`.
pub fn prune(cache: &Path, cap_bytes: u64, keep: &[String]) -> u64 {
    let mut es = entries(cache);
    let mut total: u64 = es.iter().map(|e| e.bytes).sum();
    es.sort_by_key(|e| e.last_used);
    let mut freed = 0;
    for e in es {
        if total <= cap_bytes {
            break;
        }
        if keep.contains(&e.key) {
            continue;
        }
        for p in &e.paths {
            let _ = if p.is_dir() { std::fs::remove_dir_all(p) } else { std::fs::remove_file(p) };
        }
        let _ = std::fs::remove_file(cache.join("lru").join(&e.key));
        total -= e.bytes;
        freed += e.bytes;
    }
    freed
}
```

(the proxy key uses the text before the first `.` so in-progress `<key>.part.mp4` files group with their entry.)

- [ ] **Step 4: Implement `settings.rs`**

```rust
use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub cache_cap_gb: f64,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { cache_cap_gb: 10.0 }
    }
}

pub fn load(dir: &Path) -> Settings {
    std::fs::read_to_string(dir.join("settings.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

pub fn save(dir: &Path, s: &Settings) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("settings.json"), serde_json::to_string_pretty(s).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `cd src-tauri && cargo test cache:: settings::`
Expected: PASS (7 tests).

- [ ] **Step 6: Wire commands**

In `commands.rs` add:

```rust
use crate::proxy::source_key;

const GB: f64 = 1024.0 * 1024.0 * 1024.0;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheInfo { bytes: u64, cap_gb: f64 }

fn app_dirs(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let p = app.path();
    Ok((p.app_cache_dir().map_err(|e| e.to_string())?, p.app_data_dir().map_err(|e| e.to_string())?))
}

fn keys(paths: &[String]) -> Vec<String> {
    paths.iter().map(|p| source_key(std::path::Path::new(p))).collect()
}

/// Mark `source` used and trim the cache to the configured cap, keeping `source`.
fn touch_and_prune(cache: &std::path::Path, data: &std::path::Path, source: &str) {
    let key = source_key(std::path::Path::new(source));
    crate::cache::touch(cache, &key);
    let cap = (crate::settings::load(data).cache_cap_gb * GB) as u64;
    crate::cache::prune(cache, cap, &[key]);
}

fn info(cache: &std::path::Path, data: &std::path::Path) -> CacheInfo {
    CacheInfo { bytes: crate::cache::total_bytes(cache), cap_gb: crate::settings::load(data).cache_cap_gb }
}

#[tauri::command]
pub async fn cache_info(app: AppHandle) -> Result<CacheInfo, String> {
    let (cache, data) = app_dirs(&app)?;
    tauri::async_runtime::spawn_blocking(move || info(&cache, &data)).await.map_err(join_err)
}

#[tauri::command]
pub async fn cache_set_cap(app: AppHandle, gb: f64, keep: Vec<String>) -> Result<CacheInfo, String> {
    if !(1.0..=500.0).contains(&gb) {
        return Err("Cache limit must be between 1 and 500 GB.".into());
    }
    let (cache, data) = app_dirs(&app)?;
    crate::settings::save(&data, &crate::settings::Settings { cache_cap_gb: gb })?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::cache::prune(&cache, (gb * GB) as u64, &keys(&keep));
        info(&cache, &data)
    })
    .await
    .map_err(join_err)
}

#[tauri::command]
pub async fn cache_clear(app: AppHandle, keep: Vec<String>) -> Result<CacheInfo, String> {
    let (cache, data) = app_dirs(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::cache::prune(&cache, 0, &keys(&keep));
        info(&cache, &data)
    })
    .await
    .map_err(join_err)
}
```

In `prepare_audio`, inside the `spawn_blocking` closure after `prepare_audio_files` succeeds, call `touch_and_prune(&cache, &data, &p)` (compute `let (cache, data) = app_dirs(&app)?;` at the top instead of the current `cache` line):

```rust
    let (cache, data) = app_dirs(&app)?;
    let p = path.clone();
    let tracks = tauri::async_runtime::spawn_blocking(move || {
        let info = probe_clip_file(&p)?;
        let t = prepare_audio_files(&cache, &PathBuf::from(&p), info.audio_tracks.len() as u32)?;
        touch_and_prune(&cache, &data, &p);
        Ok::<_, String>(t)
    })
    .await
    .map_err(join_err)??;
    Ok(tracks)
```

In `make_proxy`, likewise replace the `cache` line with `let (cache, data) = app_dirs(&app)?;` and, inside the closure after `make_proxy_file(...)` returns `Ok`, call `touch_and_prune(&cache, &data, &path)` before mapping to a string:

```rust
        let out = make_proxy_file(&cache, &PathBuf::from(&path), enc, duration, &|f| {
            let _ = on_progress.send(f);
        })?;
        touch_and_prune(&cache, &data, &path);
        Ok::<_, String>(out.to_string_lossy().into_owned())
```

In `lib.rs` register `commands::cache_info, commands::cache_set_cap, commands::cache_clear,`.

- [ ] **Step 7: Build and run all Rust tests**

Run: `cd src-tauri && cargo test && cargo build`
Expected: PASS, build succeeds.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/cache.rs src-tauri/src/settings.rs src-tauri/src/lib.rs src-tauri/src/commands.rs
git commit -m "feat(cache): LRU pruning of proxy and audio cache with a 10 GB default cap"
```

---

### Task 6: Settings dialog with cache size, cap and Clear cache

**Files:**
- Create: `src/components/SettingsDialog.tsx`
- Test: `src/components/SettingsDialog.test.tsx`
- Modify: `src/backend/types.ts`, `src/backend/tauri.ts`, `src/backend/fake.ts` (cache methods)
- Modify: `src/App.tsx` (header Settings button + dialog)
- Modify: `src/styles.css` (dialog styles, using existing tokens)

**Interfaces:**
- Consumes: commands `cache_info`, `cache_set_cap`, `cache_clear` (Task 5)
- Produces: `interface CacheInfo { bytes: number; capGb: number }`; `Backend.cacheInfo(): Promise<CacheInfo>`; `Backend.setCacheCap(gb: number, keep: string[]): Promise<CacheInfo>`; `Backend.clearCache(keep: string[]): Promise<CacheInfo>`
- Produces: `<SettingsDialog backend={Backend} keep={string[]} onClose={() => void} />`

- [ ] **Step 1: Write the failing test**

`src/components/SettingsDialog.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { FakeBackend } from '../backend/fake';
import { SettingsDialog } from './SettingsDialog';

const GB = 1024 ** 3;

test('shows cache usage and the cap', async () => {
  const b = new FakeBackend();
  b.cacheInfo = async () => ({ bytes: 1.5 * GB, capGb: 10 });
  render(<SettingsDialog backend={b} keep={[]} onClose={() => {}} />);
  expect(await screen.findByText('1.5 GB used of 10 GB')).toBeTruthy();
});

test('Clear cache keeps the open clip and shows the new size', async () => {
  const b = new FakeBackend();
  b.cacheInfo = async () => ({ bytes: 4 * GB, capGb: 10 });
  const clear = vi.fn(async () => ({ bytes: 0.2 * GB, capGb: 10 }));
  b.clearCache = clear;
  render(<SettingsDialog backend={b} keep={['C:/v/open.mp4']} onClose={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Clear cache' }));
  await waitFor(() => expect(screen.getByText('0.2 GB used of 10 GB')).toBeTruthy());
  expect(clear).toHaveBeenCalledWith(['C:/v/open.mp4']);
});

test('changing the cap saves it on blur and rejects out-of-range values', async () => {
  const b = new FakeBackend();
  b.cacheInfo = async () => ({ bytes: GB, capGb: 10 });
  const setCap = vi.fn(async (gb: number) => ({ bytes: GB, capGb: gb }));
  b.setCacheCap = setCap;
  render(<SettingsDialog backend={b} keep={[]} onClose={() => {}} />);
  const input = (await screen.findByLabelText('Cache limit (GB)')) as HTMLInputElement;
  fireEvent.change(input, { target: { value: '0' } });
  fireEvent.blur(input);
  expect(setCap).not.toHaveBeenCalled();
  expect(screen.getByText('Enter 1 to 500 GB.')).toBeTruthy();
  fireEvent.change(input, { target: { value: '25' } });
  fireEvent.blur(input);
  await waitFor(() => expect(setCap).toHaveBeenCalledWith(25, []));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/SettingsDialog.test.tsx`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement backend methods**

`src/backend/types.ts`:

```ts
export interface CacheInfo { bytes: number; capGb: number }
```

and in `Backend`:

```ts
  cacheInfo(): Promise<CacheInfo>;
  /** keep = source paths currently open; their cache entries are never pruned. */
  setCacheCap(gb: number, keep: string[]): Promise<CacheInfo>;
  clearCache(keep: string[]): Promise<CacheInfo>;
```

`src/backend/tauri.ts`:

```ts
  cacheInfo() {
    return invoke<CacheInfo>('cache_info');
  }

  setCacheCap(gb: number, keep: string[]) {
    return invoke<CacheInfo>('cache_set_cap', { gb, keep });
  }

  clearCache(keep: string[]) {
    return invoke<CacheInfo>('cache_clear', { keep });
  }
```

(import `CacheInfo` from `./types`.)

`src/backend/fake.ts`:

```ts
  private cache: CacheInfo = { bytes: 0, capGb: 10 };

  async cacheInfo() {
    return this.cache;
  }

  async setCacheCap(gb: number, _keep: string[]) {
    this.cache = { ...this.cache, capGb: gb };
    return this.cache;
  }

  async clearCache(_keep: string[]) {
    this.cache = { ...this.cache, bytes: 0 };
    return this.cache;
  }
```

- [ ] **Step 4: Implement the dialog**

`src/components/SettingsDialog.tsx`:

```tsx
import { useEffect, useState } from 'react';
import type { Backend, CacheInfo } from '../backend/types';

const GB = 1024 ** 3;
const fmt = (bytes: number) => `${(bytes / GB).toFixed(1)} GB`;

export function SettingsDialog({ backend, keep, onClose }: { backend: Backend; keep: string[]; onClose: () => void }) {
  const [info, setInfo] = useState<CacheInfo | null>(null);
  const [cap, setCap] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void backend.cacheInfo().then((i) => {
      setInfo(i);
      setCap(String(i.capGb));
    });
  }, [backend]);

  async function saveCap() {
    const gb = Number(cap);
    if (!Number.isFinite(gb) || gb < 1 || gb > 500) {
      setError('Enter 1 to 500 GB.');
      return;
    }
    setError(null);
    if (gb !== info?.capGb) setInfo(await backend.setCacheCap(gb, keep));
  }

  async function clear() {
    setBusy(true);
    try {
      setInfo(await backend.clearCache(keep));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <section className="settings" role="dialog" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>
        <h3>Preview cache</h3>
        <p>{info ? `${fmt(info.bytes)} used of ${info.capGb} GB` : 'Checking cache size'}</p>
        <p className="hint">Preview copies and audio for clips you've opened. The oldest clips are removed when the cache is over the limit. Exports are never affected.</p>
        <label>
          Cache limit (GB)
          <input type="number" min={1} max={500} value={cap} onChange={(e) => setCap(e.target.value)} onBlur={() => void saveCap()} />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="settings-actions">
          <button onClick={() => void clear()} disabled={busy}>Clear cache</button>
          <button className="primary" onClick={onClose}>Done</button>
        </div>
      </section>
    </div>
  );
}
```

In `src/App.tsx`: add `const [showSettings, setShowSettings] = useState(false);`, import `SettingsDialog`, add a button at the end of `<header className="app-header">`:

```tsx
        <button className="link header-settings" onClick={() => setShowSettings(true)}>Settings</button>
```

and just before the final closing `</div>` of `.workspace`:

```tsx
      {showSettings && <SettingsDialog backend={backend} keep={clip ? [clip.path] : []} onClose={() => setShowSettings(false)} />}
```

In `src/styles.css`, add dialog styles using the existing custom properties (check `:root` for the token names in use and reuse them; do not add new colors):

```css
.settings-backdrop { position: fixed; inset: 0; display: grid; place-items: center; background: rgb(0 0 0 / 0.5); z-index: 50; }
.settings { width: min(420px, calc(100vw - 32px)); padding: 24px; border-radius: 12px; background: var(--panel, #1b1b1f); display: grid; gap: 12px; }
.settings label { display: grid; gap: 6px; }
.settings-actions { display: flex; justify-content: flex-end; gap: 8px; }
.header-settings { margin-left: auto; }
```

- [ ] **Step 5: Run to verify everything passes**

Run: `npm test && npm run build && npm run lint`
Expected: all tests PASS, build clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/SettingsDialog.tsx src/components/SettingsDialog.test.tsx src/backend/types.ts src/backend/tauri.ts src/backend/fake.ts src/App.tsx src/styles.css
git commit -m "feat(settings): cache size, limit and Clear cache"
```

---

### Task 7: Real-clip verification and 30-minute listening check

**Files:**
- Modify: `project.md` (milestone)

- [ ] **Step 1: Build a 30-minute 4-track test clip** (git-ignored folder)

```bash
cd "example clips"
for i in $(seq 1 15); do for f in Replay*.mp4; do echo "file '$PWD/$f'"; done; done | head -15 > /tmp/sf-long.txt
ffmpeg -hide_banner -f concat -safe 0 -i /tmp/sf-long.txt -map 0 -c copy long-30min.mp4
ffprobe -v error -show_entries format=duration -of csv=p=0 long-30min.mp4
```

Expected: duration about 1780 s; 4 audio streams (`ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 long-30min.mp4 | wc -l` prints 4).

- [ ] **Step 2: Run the Rust real-clip tests**

Run: `cd src-tauri && SOCIALFRAG_CLIPS_DIR="../example clips" cargo test -- --ignored --test-threads=1`
Expected: all PASS, including `pcm_matches_direct_decode` and `regenerates_when_pcm_missing`.

- [ ] **Step 3: Launch the app for the user's listening check**

Run: `npm run tauri dev` (background). Ask the user to:
1. Open `example clips/long-30min.mp4`, wait for audio prep, and play from the start for 20 s.
2. Scrub to about 25:00 and play for 20 s; scrub back to 2:00 and play.
3. Watch "SocialFrag Web Content" in Activity Monitor during steps 1–2: memory must stay flat (no growth tied to clip length).
4. Report: sound OK / gaps / repeats / out of sync.
5. Open Settings: cache shows about 1.4 GB+ used; Clear cache keeps playback working.

Do not claim success before the user reports back.

- [ ] **Step 4: Update the tracker and commit**

In `project.md` under Done add `- 2026-09-25: Streaming preview audio (raw PCM cache, 1 s chunks, 2 s lookahead) + cache LRU/limit/Clear cache; 30-min listening check passed` (only after the user confirms), and change the Now line to point at sub-project 2.

```bash
git add project.md
git commit -m "docs: tracker, streaming audio shipped"
```
