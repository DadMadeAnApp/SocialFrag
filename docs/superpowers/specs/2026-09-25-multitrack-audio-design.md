# SocialFrag — Multi-track Audio Design Spec

Date: 2026-09-25
Status: Implemented on feat/multitrack-audio (2026-09-25); manual preview check pending

## 1. Intent

Recorders like OBS write several labelled audio tracks into one MP4 (e.g. `Desktop Audio`, `Game`, `Discord`, `Mic`). Today the export maps every source track (`-map 0:a?`), so the output carries 4 AAC tracks, social platforms play only the first, and the user has no control over the mix. This feature lets the user mix the tracks in-app and always exports **one** mixed track.

### What the user said
- Users with multiple audio tracks must be supported.
- Per track: set volume limits, remove tracks, edit tracks.
- "Edit" means all of: rename/label, fades in/out, mute over part of the timeline, trim/offset (sync nudge).
- "Volume limits" means gain slider **and** peak ceiling per track by default, with optional auto-ducking.
- Track labels should come from the clip (OBS writes them).
- Default mix: the preset's saved mix (D); if the preset has none, smart default (B); if anything goes wrong, all tracks on at 100% (A).
- Live preview of the mix (Web Audio), not rendered preview.
- UI: mixer in the sidebar, per-track timeline lanes under the trim bar.
- Implementation approach: one sampled gain curve per track shared by preview and export.
- "Save mix to preset" on a built-in preset saves a copy; WARDOGS ships with no mix.
- Per-track sync offset belongs in the preset.

### Evidence from the example clips (2026-09-25)
- All 6 clips: HEVC 1920×1080 @ 120 fps, 4 AAC stereo 48 kHz tracks.
- ffprobe exposes the OBS label as stream `tags.name` (MP4 `trak/udta/name`): `Desktop Audio, Game, Discord, Mic`.
- `Mic` measured −91 dB (silent) in all 6 clips; `Desktop Audio` is ~2 dB louder than `Game`, i.e. it very likely already contains Game + Discord.

### Assumptions
- Rename is a display label per clip (and the label the preset matches on is the **source** label, not the renamed one).
- Mixer output is stereo 48 kHz AAC 192 kbps (unchanged bitrate).

### Success criteria
- Every export has exactly 0 or 1 audio streams.
- Preview and export apply identical gain over time (same curve samples); only the ceiling limiter is an approximation in the preview.
- Opening an OBS clip with a WARDOGS preset that has a saved mix reproduces that mix with no user action.
- Preparing audio for a 2-minute 4-track clip takes under 3 s on the dev Mac.

## 2. Data model (`src/types.ts`, mirrored in `src-tauri/src/job.rs` / `preset.rs`)

```ts
interface AudioTrackInfo { index: number; label: string; named: boolean; channels: number }
// index = audio ordinal (ffmpeg 0:a:N); label = tags.name (or tags.title), else "Track N+1" with named=false
// ClipInfo gains audioTracks: AudioTrackInfo[]; hasAudio stays (= audioTracks.length > 0)

interface MuteRange { startS: number; endS: number }          // absolute clip seconds
interface TrackMix {
  index: number;
  sourceLabel: string;       // from the clip, used for preset matching
  label: string;             // display label, user-editable
  enabled: boolean;          // false = removed (row greyed, Restore)
  gain: number;              // 0–2 (0–200 %)
  ceilingDb: number | null;  // −24…0, null = off
  offsetS: number;           // −2…+2, + = audio later
  fadeInS: number;           // ≥ 0, from trim-in
  fadeOutS: number;          // ≥ 0, into trim-out
  mutes: MuteRange[];
}
interface Duck {
  targets: number[];         // track indexes that dip
  triggers: number[];        // track indexes whose loudness causes the dip
  amountDb: number;          // −24…0
  thresholdDb: number;       // −60…0, default −40
  releaseS: number;          // 0.05–2, default 0.4 (attack fixed 50 ms)
}
interface AudioMix { tracks: TrackMix[]; duck: Duck | null }
```

`ExportJob` gains:
```ts
audio: AudioMix;
/** track index -> base64 little-endian f32 gain samples at 200 Hz covering [trim.inS, trim.outS) */
gainCurves: Record<number, string>;
```

### Preset `audio` section (optional; preset `version` stays 1)
```json
"audio": {
  "tracks": [{ "label": "Game", "enabled": true, "gain": 1.0, "ceilingDb": -3, "offsetS": 0 }],
  "duck": { "targets": ["Game"], "triggers": ["Discord", "Mic"], "amountDb": -10, "thresholdDb": -40, "releaseS": 0.4 }
}
```
Holds per-setup settings only (enabled, gain, ceiling, offset, duck). Mutes, fades and display renames are per clip and never saved to a preset. Labels match clip `sourceLabel` case-insensitively.

## 3. Default mix resolution (`resolveMix(tracks, preset) → { mix, notice? }`)

1. **Preset mix (D):** preset has `audio` → each clip track whose `sourceLabel` matches a preset entry takes that entry's settings. Clip tracks with no entry fall to rule 2 for that track. Preset entries with no matching clip track are ignored. Duck applies with labels mapped to indexes; if no target or no trigger matches, duck is `null`.
2. **Smart default (B):** all tracks enabled at gain 1, no ceiling, offset 0, except tracks whose label matches `/desktop/i`, which are disabled when at least one other labelled track exists.
3. **Fallback (A):** if the clip's tracks have no labels (all generated `Track N`), or the preset mix cannot be applied (throws / invalid), every track enabled at gain 1 and `notice = "Couldn't apply the preset's audio mix — using all tracks."` (no notice when there are simply no labels; A is then the natural result of rule 2).

Switching preset re-resolves enabled/gain/ceiling/offset/duck; per-clip mutes, fades and renames are kept.

"Save mix to preset": writes `audio` from the current mix into the selected user preset; for a built-in preset it saves a copy (same flow as "Edit copy") and selects it.

## 4. Backend (Rust)

### Probe (`probe.rs`)
Parse every `codec_type == "audio"` stream in order → `audioTracks` with `index` = ordinal, `label` = `tags.name` (trimmed, non-empty) else `Track N+1`, `channels`.

### `prepare_audio(path) → Vec<{ index, audioPath, envelopePath }>` (new command, cached like proxies, key = proxy hash + track index)
1. Per track: `ffmpeg -i src -map 0:a:N -c:a copy -vn track-N.m4a` (stream copy).
2. Per track envelope: `ffmpeg -i src -map 0:a:N -ac 1 -ar 8000 -f f32le pipe:1`, RMS per 40-sample (5 ms) window, stored as `env-N.f32` (200 values/s, linear RMS). Written to `.part` then renamed.
Fails as a whole with a message; the frontend falls back (see §7).

### Export (`filtergraph.rs`, `export.rs`)
- `write_assets` also writes `gain-N.f32` for each enabled track from `gainCurves`.
- Validation before ffmpeg: every enabled track has a curve whose sample count is `round((outS − inS) × 200)` ± 1, else `invalid_audio`.
- A second input opens the source for audio: `-ss max(0, inS − 2) -t (dur + 4) -i src` (index A). `lead = inS − max(0, inS − 2)`.
- Gain inputs: `-f f32le -ar 200 -ac 1 -i gain-N.f32`.
- Per enabled track:
  `[A:a:N]atrim=start=(lead − offsetS):duration=dur,asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo[tN]` — when `lead − offsetS < 0`, use `adelay` for the missing part (silence pad) and `atrim=start=0`; `apad` + `atrim=duration=dur` guarantees exact length.
  `[G:a]aresample=48000,aformat=channel_layouts=stereo[gN]; [tN][gN]amultiply[mN]`
  then `alimiter=limit=10^(ceilingDb/20):attack=1:release=50:level=0:latency=1` when a ceiling is set.
- Mix: `[m…]amix=inputs=K:normalize=0:duration=first,alimiter=limit=0.891:attack=1:release=50:level=0:latency=1[aout]` (single track: skip `amix`, keep master limiter).
- `-map [aout] -c:a aac -b:a 192k`. No enabled tracks or no audio → `-an`. `-map 0:a?` removed.

### Preset validation (`preset.rs` `validate`, and TS `validatePreset`)
`audio` optional. Each track: `label` 1–64 chars, `gain` finite 0–2, `ceilingDb` null or finite −24…0, `offsetS` finite −2…2. Duck: arrays of 1–64-char strings, `amountDb` −24…0, `thresholdDb` −60…0, `releaseS` 0.05…2. Same checks apply to `ExportJob.audio` (plus indexes must exist in `clip.audioTracks` and be unique). Mutes, fades, gain and duck are baked into the gain curves, so Rust validates only the curve length; TS `buildCurve` clamps/merges mute ranges.

## 5. Curves (`src/audio/`, pure TS)

- `SAMPLE_RATE = 200`.
- `duckCurve(triggerEnvelopes, duck, length) → Float32Array`: `level = max(trigger RMS)` per sample, in dB; above `thresholdDb` → target gain `10^(amountDb/20)`, else 1; smoothed with 50 ms attack (moving down) and `releaseS` release (moving up).
- `buildCurve(track, trim, clipDuration, duck?) → Float32Array` over the **whole clip**: `gain × muteMask × fadeMask × duck`. Mute ranges clamped to `[0, duration]`, overlaps merged, 30 ms linear ramps at each edge. Fade in: linear 0→1 over `fadeInS` from `trim.inS`; fade out: 1→0 ending at `trim.outS`. Offsets do not shift the curve (the curve is in output/video time).
- `sliceCurve(curve, trim) → Float32Array` for the export; `encodeCurve` → base64 f32le.

## 6. Preview (`src/audio/AudioPreview.ts`) and UI

### AudioPreview
```
<audio track-N.m4a> → MediaElementSource → Gain(curve) → DynamicsCompressor(threshold=ceilingDb, ratio 20, knee 0, attack 0.001, release 0.05)
   … per enabled track → master Gain → master DynamicsCompressor(−1 dB) → destination
```
- Video element muted while AudioPreview is active.
- Mirrors video `play`, `pause`, `seeked`, `ratechange`. Each animation frame: for each track, if `|audio.currentTime − (video.currentTime − offsetS)| > 0.05` reset `audio.currentTime`. Negative target time → track paused until reached.
- On play and on any mix edit while playing: `cancelScheduledValues`, then `setValueCurveAtTime(curve from video.currentTime to end, ctx.currentTime, remaining)`. Paused: `gain.value = curve[t]`.
- Disabled tracks: element paused, not connected.

### AudioMixer (sidebar, between CaptionTool and ExportPanel)
Per track row: editable label, ✕ / Restore, gain slider 0–200 % + number, ceiling toggle + slider −24…0 dB, offset ±2 s (10 ms step), fade in / fade out (s). Duck panel: ☐ Duck, target and trigger checkboxes per track, amount slider, "Advanced": threshold, release. Buttons: "Save mix to preset". Notices from `resolveMix` shown at the top. No audio → "No audio in this clip."

### AudioLanes (under TrimBar)
One lane per track: waveform drawn from the envelope, trim region highlighted, playhead, mute ranges shaded. Drag on empty lane → new mute range; drag range edges → resize; × on a range → delete. Triangle handles at trim edges → fade lengths. Alt+drag waveform → offset. Disabled tracks greyed. No envelope → flat lane, editing still works.

## 7. Errors and edge cases

| Case | Behaviour |
|---|---|
| No audio streams | Mixer shows "No audio in this clip"; export `-an` |
| `prepare_audio` fails | Notice "Audio preview unavailable — export still uses your mix"; video plays its own audio; lanes without waveforms; ducking disabled (needs envelopes) with a hint |
| No labels / preset mix can't apply | Rule A (+ notice when applicable) |
| All tracks removed | Export shows a confirm "No audio will be exported"; export `-an` |
| Mono / 5.1 track | `aformat` to stereo |
| Mute range outside clip / overlaps | Clamped, merged |
| Offset beyond clip edges | Silence pad |
| Invalid preset `audio` | Rejected by TS and Rust validation with a clear message |
| Curve length mismatch | Rust `invalid_audio` before ffmpeg |

## 8. Testing

- **Vitest (pure):** `resolveMix` (rules D/B/A, case-insensitive, partial match, unmatched entries, duck mapping); `buildCurve` (gain, mute ramps, overlap merge, fades, clamping); `duckCurve` (threshold, attack, release); `sliceCurve`/`encodeCurve`; preset `audio` validation.
- **Vitest (components, fake backend):** AudioMixer edits update mix; remove/restore; Save mix to preset on built-in creates a copy; AudioLanes drag creates/resizes/deletes a mute range; fake backend `prepareAudio`.
- **Cargo:** probe parses `tags.name` and falls back to `Track N`; golden filtergraph for 4 tracks (one disabled, one with ceiling, one with positive and one with negative offset); single-track path; `-an` when none enabled; curve length validation; preset `audio` validation; `prepare_audio` envelope RMS math on a synthetic buffer.
- **Ignored real tests:** `real_clips_export_with_wardogs` asserts exactly 1 audio stream; new `real_clip_mute_range_is_silent` mutes `Game` 5–8 s with only `Game` enabled and checks `volumedetect` max < −60 dB in that window; `prepare_audio` on a real clip under 3 s.
- **Manual (Windows smoke test, Task 17):** preview stays in sync over a 2-minute clip; seek/scrub; offset audibly moves Discord.

## 9. Revisions (2026-09-25, during planning)
- Ceiling range is −24…0 dB: ffmpeg `alimiter` rejects `limit` below 0.0625 (−24.08 dB). `alimiter` auto-level defaults on, so `level=0` is required; `latency=1` keeps sync.
- `AudioTrackInfo.named` added so rule A/B can tell real labels from generated `Track N`.
- Envelopes reach the webview as raw bytes over IPC (`audio_envelope` command), not `fetch`, to avoid asset-protocol CORS.
- Spike verified the `amultiply` chain on a real clip: muted window −91 dB, unmuted windows unchanged.

## 10. Out of scope
- Per-track EQ, noise reduction, or effects beyond gain/ceiling/duck.
- Adding external audio files (music) — separate feature.
- Multiple output audio tracks.
