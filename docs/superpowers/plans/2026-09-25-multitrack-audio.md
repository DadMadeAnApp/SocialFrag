# Multi-track Audio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users mix a clip's labelled audio tracks (gain, ceiling, duck, mutes, fades, offset, remove, rename) with a live preview, and always export exactly one mixed audio track.

**Architecture:** Pure TypeScript turns each track's edits into one 200 Hz gain curve over the whole clip. The preview plays per-track `.m4a` stream copies through Web Audio and drives each `GainNode` with that curve. The export sends the trim slice of the same curve to Rust, which writes it as raw `f32le` and applies it with ffmpeg `amultiply`, then per-track `alimiter` ceilings, `amix`, and a −1 dB master limiter.

**Tech Stack:** Tauri 2, Rust (serde, base64), React 19 + TypeScript 6, Vitest 5 + Testing Library (jsdom), ffmpeg/ffprobe (Homebrew on Mac, bundled on Windows).

**Spec:** `docs/superpowers/specs/2026-09-25-multitrack-audio-design.md` (read §9 Revisions first)

## Global Constraints

- Branch: `feat/multitrack-audio`. Commit after every task. No attribution lines in commit messages.
- Curve sample rate: `200` samples/s everywhere (TS `SAMPLE_RATE`, Rust `GAIN_RATE`, ffmpeg `-ar 200`).
- Curve length for a span of `s` seconds: `Math.round(s * 200)`; Rust accepts ±1.
- Gain 0–2; ceiling `null` or −24…0 dB; offset −2…+2 s; duck amount −24…0 dB; threshold −60…0 dB; release 0.05–2 s; labels 1–64 chars.
- Mute edge ramps: 30 ms linear. Duck attack: 50 ms fixed.
- `alimiter` always with `attack=1:release=50:level=0:latency=1`. Master limit `0.891` (−1 dB).
- Output audio: exactly one stereo 48 kHz AAC 192 kbps track, or `-an`.
- Preset `version` stays `1`; `audio` is optional and matched by source label, case-insensitive.
- Mutes, fades and renames are per clip — never written to a preset.
- Rust `layout_layer` / TS `layoutLayer` untouched.
- Run before each commit: `npx vitest run` and `(cd src-tauri && cargo test)`; both must pass. `npx tsc -b` must be clean.

## Review Focus

1. **Asset-protocol CORS silences Web Audio.** `createMediaElementSource` on a cross-origin `<audio>` outputs silence. Expect: audible preview in `npm run tauri dev`. Pinned by Task 9 Step 6 (manual probe with an `AnalyserNode`) and the `decodeAudioData` fallback in the same task.
2. **Trim changes after edits.** User moves trim-in past a mute range or shortens the clip below fade lengths. Expect: fades start at the new trim edges, overlapping fades clamp, no NaN. Pinned by Task 3 test `fades follow trim and clamp when longer than the trim`.
3. **Long clips (30 min).** Expect: curve build + base64 encode stays fast. Pinned by Task 3 test `encodes a 30-minute curve quickly`.
4. **Switching clip while audio prepares.** Expect: late `prepareAudio` result for the old clip is ignored. Pinned by Task 11 test `ignores prepareAudio results for a clip that is no longer open`.
5. **Switching preset keeps per-clip edits.** Expect: mutes, fades and renames survive a preset change; gain/enabled/ceiling/offset/duck re-resolve. Pinned by Task 4 test `keeps per-clip edits when re-resolving`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/types.ts` (modify) | New audio types; `ClipInfo.audioTracks`; `Preset.audio`; `ExportJob.audio/gainCurves` |
| `src/presets/validate.ts` (modify) | Validate optional preset `audio` |
| `src/audio/curve.ts` (create) | `SAMPLE_RATE`, `curveLength`, `mergeMutes`, `buildCurve`, `sliceCurve`, `encodeCurve`, `mixCurves` |
| `src/audio/duck.ts` (create) | `duckCurve` |
| `src/audio/resolveMix.ts` (create) | Default-mix rules D/B/A, `mixToPresetAudio`, `emptyMix` |
| `src/audio/lanes.ts` (create) | Pure mute-range edit helpers for lanes |
| `src/audio/AudioPreview.ts` (create) | Web Audio playback synced to `<video>` |
| `src/components/AudioMixer.tsx` (create) | Sidebar mixer UI |
| `src/components/AudioLanes.tsx` (create) | Per-track timeline lanes |
| `src/backend/types.ts`, `tauri.ts`, `fake.ts` (modify) | `prepareAudio` |
| `src/state/exportJob.ts` (modify) | Put `audio` + `gainCurves` in the job |
| `src/components/ExportPanel.tsx` (modify) | Pass mix/curves; confirm when no audio |
| `src/App.tsx` (modify) | Mix state, prepare, preset re-resolve, save-mix-to-preset, wiring |
| `src-tauri/src/job.rs` (modify) | `AudioTrackInfo`, `ClipInfo.audio_tracks`, `ExportJob.audio/gain_curves` |
| `src-tauri/src/audio_mix.rs` (create) | Rust `AudioMix`/`TrackMix`, `validate_mix`, `GAIN_RATE` |
| `src-tauri/src/probe.rs` (modify) | Parse audio streams + labels |
| `src-tauri/src/preset.rs` (modify) | `PresetAudio` types + validation |
| `src-tauri/src/audio_prep.rs` (create) | Stream-copy m4a per track, RMS envelope |
| `src-tauri/src/proxy.rs` (modify) | Extract `source_key` for shared cache hashing |
| `src-tauri/src/filtergraph.rs` (modify) | Audio filter + args; drop `-map 0:a?` |
| `src-tauri/src/export.rs` (modify) | Write gain files; validate before ffmpeg; real-clip tests |
| `src-tauri/src/commands.rs`, `lib.rs` (modify) | `prepare_audio`, `audio_envelope` commands |

---

### Task 1: Audio track info from probe

**Files:**
- Modify: `src-tauri/src/job.rs`, `src-tauri/src/probe.rs`, `src/types.ts`, `src/backend/fake.ts`
- Modify (fixtures): `src/App.test.tsx:28`, `src/render/exportAssets.test.ts:10`, `src/state/exportJob.test.ts:6`, `src/components/ExportPanel.test.tsx:8`, `src-tauri/src/job.rs:86`

**Interfaces:**
- Produces (TS): `interface AudioTrackInfo { index: number; label: string; named: boolean; channels: number }`; `ClipInfo.audioTracks: AudioTrackInfo[]`.
- Produces (Rust): `pub struct AudioTrackInfo { pub index: u32, pub label: String, pub named: bool, pub channels: u32 }` (camelCase serde); `ClipInfo.audio_tracks: Vec<AudioTrackInfo>` with `#[serde(default)]`.

- [ ] **Step 1: Write failing Rust tests** — append to `mod tests` in `src-tauri/src/probe.rs`:

```rust
    #[test]
    fn reads_obs_track_labels_in_order() {
        let json = r#"{"streams":[{"codec_type":"video","codec_name":"hevc","width":1920,"height":1080,"r_frame_rate":"120/1"},
            {"codec_type":"audio","channels":2,"tags":{"name":"Desktop Audio"}},
            {"codec_type":"audio","channels":1,"tags":{"title":" Game "}},
            {"codec_type":"audio","channels":2,"tags":{"name":""}}],"format":{"duration":"10"}}"#;
        let c = parse_probe(json).unwrap();
        let t: Vec<_> = c.audio_tracks.iter().map(|a| (a.index, a.label.as_str(), a.named, a.channels)).collect();
        assert_eq!(t, vec![(0, "Desktop Audio", true, 2), (1, "Game", true, 1), (2, "Track 3", false, 2)]);
        assert!(c.has_audio);
    }

    #[test]
    fn no_audio_streams_gives_empty_track_list() {
        let json = r#"{"streams":[{"codec_type":"video","codec_name":"h264","width":1920,"height":1080,"r_frame_rate":"60/1"}],"format":{"duration":"1"}}"#;
        assert!(parse_probe(json).unwrap().audio_tracks.is_empty());
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && cargo test probe::`
Expected: compile error `no field audio_tracks on type ClipInfo`.

- [ ] **Step 3: Implement.** In `src-tauri/src/job.rs` add above `ClipInfo`:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioTrackInfo {
    pub index: u32,
    pub label: String,
    pub named: bool,
    pub channels: u32,
}
```

and add to `ClipInfo` after `has_audio`:

```rust
    #[serde(default)]
    pub audio_tracks: Vec<AudioTrackInfo>,
```

Update the fixture at `job.rs:86` to `..., has_audio: true, audio_tracks: vec![] }`.

In `src-tauri/src/probe.rs`, change the import to `use crate::job::{AudioTrackInfo, ClipInfo};` and replace the `Ok(ClipInfo { ... })` block with:

```rust
    let audio_tracks: Vec<AudioTrackInfo> = streams
        .iter()
        .filter(|s| s["codec_type"] == "audio")
        .enumerate()
        .map(|(i, s)| {
            let tag = |k: &str| s["tags"][k].as_str().map(str::trim).filter(|l| !l.is_empty()).map(String::from);
            let label = tag("name").or_else(|| tag("title"));
            AudioTrackInfo {
                index: i as u32,
                named: label.is_some(),
                label: label.unwrap_or_else(|| format!("Track {}", i + 1)),
                channels: s["channels"].as_u64().unwrap_or(2) as u32,
            }
        })
        .collect();
    Ok(ClipInfo {
        width,
        height,
        fps,
        codec: video["codec_name"].as_str().unwrap_or("unknown").into(),
        duration,
        has_audio: !audio_tracks.is_empty(),
        audio_tracks,
    })
```

In `src/types.ts` replace the `ClipInfo` line with:

```ts
/** index = audio ordinal (ffmpeg 0:a:N). named = label came from the file (e.g. OBS track name), not generated. */
export interface AudioTrackInfo { index: number; label: string; named: boolean; channels: number }
export interface ClipInfo { width: number; height: number; fps: string; codec: string; duration: number; hasAudio: boolean; audioTracks: AudioTrackInfo[] }
```

In `src/backend/fake.ts` probe resolve object add `audioTracks: [{ index: 0, label: 'Track 1', named: false, channels: 2 }]`. In the four TS fixtures listed above add `audioTracks: []` after `hasAudio: true`.

- [ ] **Step 4: Run tests**

Run: `(cd src-tauri && cargo test) && npx vitest run && npx tsc -b`
Expected: all pass, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add -A src src-tauri/src
git commit -m "feat(audio): probe audio tracks with OBS labels"
```

---

### Task 2: Preset `audio` section (types + TS/Rust validation)

**Files:**
- Modify: `src/types.ts`, `src/presets/validate.ts`, `src/presets/validate.test.ts`, `src-tauri/src/preset.rs`

**Interfaces:**
- Produces (TS):
  ```ts
  export interface PresetAudioTrack { label: string; enabled: boolean; gain: number; ceilingDb: number | null; offsetS: number }
  export interface PresetDuck { targets: string[]; triggers: string[]; amountDb: number; thresholdDb: number; releaseS: number }
  export interface PresetAudio { tracks: PresetAudioTrack[]; duck: PresetDuck | null }
  // Preset gains: audio?: PresetAudio
  export const AUDIO_LIMITS = { gain: [0, 2], ceilingDb: [-24, 0], offsetS: [-2, 2], amountDb: [-24, 0], thresholdDb: [-60, 0], releaseS: [0.05, 2] } as const;
  ```
- Produces (Rust): `PresetAudio`, `PresetAudioTrack`, `PresetDuck` (camelCase serde), `Preset.audio: Option<PresetAudio>`, `pub fn validate_preset_audio(a: &PresetAudio) -> Result<(), String>`, `pub fn in_range(v: f64, lo: f64, hi: f64) -> bool`.

- [ ] **Step 1: Write failing TS tests** — append to `src/presets/validate.test.ts` (check the file's existing imports; it imports `validatePreset` and a base preset — reuse its base object; if none exists, use `blankPreset('p')` from `./presets`):

```ts
import { blankPreset } from './presets';

const withAudio = (audio: unknown) => ({ ...blankPreset('p'), audio });
const goodAudio = {
  tracks: [{ label: 'Game', enabled: true, gain: 1.2, ceilingDb: -3, offsetS: 0.05 }],
  duck: { targets: ['Game'], triggers: ['Discord', 'Mic'], amountDb: -10, thresholdDb: -40, releaseS: 0.4 },
};

test('accepts and keeps a valid audio section', () => {
  const r = validatePreset(withAudio(goodAudio));
  expect(r.ok && r.preset.audio).toEqual(goodAudio);
});

test('preset without audio stays without audio', () => {
  const r = validatePreset(blankPreset('p'));
  expect(r.ok && 'audio' in r.preset).toBe(false);
});

test.each([
  [{ tracks: [{ ...goodAudio.tracks[0], gain: 2.5 }], duck: null }, 'gain'],
  [{ tracks: [{ ...goodAudio.tracks[0], ceilingDb: -30 }], duck: null }, 'ceiling'],
  [{ tracks: [{ ...goodAudio.tracks[0], offsetS: Number.NaN }], duck: null }, 'offset'],
  [{ tracks: [{ ...goodAudio.tracks[0], label: '' }], duck: null }, 'label'],
  [{ tracks: [], duck: { ...goodAudio.duck, releaseS: 0 } }, 'release'],
  [{ tracks: [], duck: { ...goodAudio.duck, triggers: [3] } }, 'trigger'],
  [{ tracks: 'x', duck: null }, 'tracks'],
])('rejects bad audio %#', (audio, word) => {
  const r = validatePreset(withAudio(audio));
  expect(r.ok).toBe(false);
  expect(!r.ok && r.error).toContain(word);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/presets/validate.test.ts`
Expected: FAIL (audio dropped / bad audio accepted).

- [ ] **Step 3: Implement TS.** In `src/types.ts` add the interfaces and `AUDIO_LIMITS` from the Interfaces block above, and add `audio?: PresetAudio;` as the last field of `Preset`.

In `src/presets/validate.ts` update the import to also bring `AUDIO_LIMITS, type PresetAudio, type PresetAudioTrack, type PresetDuck`, then add:

```ts
const inRange = (v: unknown, [lo, hi]: readonly [number, number]): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const isLabel = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 64;

function parseAudioTrack(v: any, i: number): PresetAudioTrack | string {
  if (!v || typeof v !== 'object') return `audio track ${i} is not an object`;
  if (!isLabel(v.label)) return `audio track ${i}: label must be 1-64 characters`;
  if (typeof v.enabled !== 'boolean') return `audio track ${v.label}: enabled must be true/false`;
  if (!inRange(v.gain, AUDIO_LIMITS.gain)) return `audio track ${v.label}: gain must be 0-2`;
  if (v.ceilingDb !== null && !inRange(v.ceilingDb, AUDIO_LIMITS.ceilingDb)) return `audio track ${v.label}: ceiling must be -24 to 0 dB or null`;
  if (!inRange(v.offsetS, AUDIO_LIMITS.offsetS)) return `audio track ${v.label}: offset must be -2 to 2 s`;
  return { label: v.label, enabled: v.enabled, gain: v.gain, ceilingDb: v.ceilingDb, offsetS: v.offsetS };
}

function parseDuck(v: any): PresetDuck | null | string {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object') return 'duck must be an object or null';
  if (!Array.isArray(v.targets) || !v.targets.every(isLabel)) return 'duck targets must be track labels';
  if (!Array.isArray(v.triggers) || !v.triggers.every(isLabel)) return 'duck triggers must be track labels';
  if (!inRange(v.amountDb, AUDIO_LIMITS.amountDb)) return 'duck amount must be -24 to 0 dB';
  if (!inRange(v.thresholdDb, AUDIO_LIMITS.thresholdDb)) return 'duck threshold must be -60 to 0 dB';
  if (!inRange(v.releaseS, AUDIO_LIMITS.releaseS)) return 'duck release must be 0.05 to 2 s';
  return { targets: [...v.targets], triggers: [...v.triggers], amountDb: v.amountDb, thresholdDb: v.thresholdDb, releaseS: v.releaseS };
}

function parseAudio(v: any): PresetAudio | string {
  if (!v || typeof v !== 'object' || !Array.isArray(v.tracks)) return 'audio tracks must be a list';
  const tracks: PresetAudioTrack[] = [];
  for (let i = 0; i < v.tracks.length; i++) {
    const t = parseAudioTrack(v.tracks[i], i);
    if (typeof t === 'string') return t;
    tracks.push(t);
  }
  const duck = parseDuck(v.duck);
  if (typeof duck === 'string') return duck;
  return { tracks, duck };
}
```

In `validatePreset`, before the final `return`, add:

```ts
  let audio: PresetAudio | undefined;
  if (v.audio !== undefined) {
    const a = parseAudio(v.audio);
    if (typeof a === 'string') return { ok: false, error: a };
    audio = a;
  }
```

and change the returned preset object to end with `layers, ...(audio ? { audio } : {}) }`.

- [ ] **Step 4: Write failing Rust tests** — append to `mod tests` in `src-tauri/src/preset.rs`:

```rust
    fn audio() -> PresetAudio {
        serde_json::from_str(r#"{"tracks":[{"label":"Game","enabled":true,"gain":1.2,"ceilingDb":-3,"offsetS":0.05}],
            "duck":{"targets":["Game"],"triggers":["Discord"],"amountDb":-10,"thresholdDb":-40,"releaseS":0.4}}"#).unwrap()
    }

    #[test]
    fn preset_audio_validates() {
        assert!(validate_preset_audio(&audio()).is_ok());
        let mut p = fixture();
        p.audio = Some(audio());
        assert!(validate(&p).is_ok());
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains("\"ceilingDb\":-3"));
        assert!(!serde_json::to_string(&fixture()).unwrap().contains("audio"));
    }

    #[test]
    fn preset_audio_rejects_out_of_range() {
        let mut a = audio();
        a.tracks[0].gain = 2.5;
        assert!(validate_preset_audio(&a).unwrap_err().contains("gain"));
        let mut a = audio();
        a.tracks[0].ceiling_db = Some(-30.0);
        assert!(validate_preset_audio(&a).unwrap_err().contains("ceiling"));
        let mut a = audio();
        a.tracks[0].offset_s = f64::NAN;
        assert!(validate_preset_audio(&a).unwrap_err().contains("offset"));
        let mut a = audio();
        a.duck.as_mut().unwrap().release_s = 0.0;
        assert!(validate_preset_audio(&a).unwrap_err().contains("release"));
        let mut a = audio();
        a.tracks[0].label = String::new();
        assert!(validate_preset_audio(&a).unwrap_err().contains("label"));
    }
```

- [ ] **Step 5: Implement Rust.** In `src-tauri/src/preset.rs` add after `Background`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetAudioTrack {
    pub label: String,
    pub enabled: bool,
    pub gain: f64,
    pub ceiling_db: Option<f64>,
    pub offset_s: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetDuck {
    pub targets: Vec<String>,
    pub triggers: Vec<String>,
    pub amount_db: f64,
    pub threshold_db: f64,
    pub release_s: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresetAudio {
    pub tracks: Vec<PresetAudioTrack>,
    #[serde(default)]
    pub duck: Option<PresetDuck>,
}

pub fn in_range(v: f64, lo: f64, hi: f64) -> bool {
    v.is_finite() && v >= lo && v <= hi
}

fn is_label(s: &str) -> bool {
    !s.is_empty() && s.chars().count() <= 64
}

pub fn validate_preset_audio(a: &PresetAudio) -> Result<(), String> {
    for t in &a.tracks {
        if !is_label(&t.label) {
            return Err("audio track label must be 1-64 characters".into());
        }
        if !in_range(t.gain, 0.0, 2.0) {
            return Err(format!("audio track {}: gain must be 0-2", t.label));
        }
        if let Some(c) = t.ceiling_db {
            if !in_range(c, -24.0, 0.0) {
                return Err(format!("audio track {}: ceiling must be -24 to 0 dB", t.label));
            }
        }
        if !in_range(t.offset_s, -2.0, 2.0) {
            return Err(format!("audio track {}: offset must be -2 to 2 s", t.label));
        }
    }
    if let Some(d) = &a.duck {
        if !d.targets.iter().chain(&d.triggers).all(|l| is_label(l)) {
            return Err("duck targets/triggers must be track labels".into());
        }
        if !in_range(d.amount_db, -24.0, 0.0) {
            return Err("duck amount must be -24 to 0 dB".into());
        }
        if !in_range(d.threshold_db, -60.0, 0.0) {
            return Err("duck threshold must be -60 to 0 dB".into());
        }
        if !in_range(d.release_s, 0.05, 2.0) {
            return Err("duck release must be 0.05 to 2 s".into());
        }
    }
    Ok(())
}
```

Add to `Preset` as last field:

```rust
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio: Option<PresetAudio>,
```

In `validate`, just before the final `Ok(())`, add:

```rust
    if let Some(a) = &p.audio {
        validate_preset_audio(a)?;
    }
```

- [ ] **Step 6: Run tests**

Run: `(cd src-tauri && cargo test) && npx vitest run && npx tsc -b`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add -A src src-tauri/src
git commit -m "feat(audio): optional preset audio section with validation"
```

---

### Task 3: Gain curves (pure TS)

**Files:**
- Modify: `src/types.ts`
- Create: `src/audio/curve.ts`, `src/audio/curve.test.ts`

**Interfaces:**
- Consumes: `Trim` from `src/types.ts`.
- Produces (types in `src/types.ts`):
  ```ts
  export interface MuteRange { startS: number; endS: number }
  export interface TrackMix { index: number; sourceLabel: string; label: string; enabled: boolean; gain: number; ceilingDb: number | null; offsetS: number; fadeInS: number; fadeOutS: number; mutes: MuteRange[] }
  export interface Duck { targets: number[]; triggers: number[]; amountDb: number; thresholdDb: number; releaseS: number }
  export interface AudioMix { tracks: TrackMix[]; duck: Duck | null }
  ```
- Produces (`src/audio/curve.ts`): `SAMPLE_RATE = 200`, `RAMP_S = 0.03`, `curveLength(seconds): number`, `mergeMutes(mutes, duration): MuteRange[]`, `buildCurve(track, trim, duration, duck?: Float32Array): Float32Array`, `sliceCurve(curve, trim): Float32Array`, `encodeCurve(curve): string`, `mixCurves(mix, trim, duration, duckGain: Float32Array | null): Map<number, Float32Array>`.

- [ ] **Step 1: Add the types** from the Interfaces block to `src/types.ts` (after `PresetAudio`).

- [ ] **Step 2: Write failing tests** — `src/audio/curve.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import type { TrackMix } from '../types';
import { SAMPLE_RATE, buildCurve, curveLength, encodeCurve, mergeMutes, mixCurves, sliceCurve } from './curve';

const track = (over: Partial<TrackMix> = {}): TrackMix => ({
  index: 0, sourceLabel: 'Game', label: 'Game', enabled: true, gain: 1, ceilingDb: null, offsetS: 0, fadeInS: 0, fadeOutS: 0, mutes: [], ...over,
});
const at = (c: Float32Array, t: number) => c[Math.round(t * SAMPLE_RATE)];
const trim = { inS: 0, outS: 10 };

describe('buildCurve', () => {
  test('covers the whole clip at 200 Hz with the track gain', () => {
    const c = buildCurve(track({ gain: 1.5 }), trim, 10);
    expect(c.length).toBe(2000);
    expect(at(c, 3)).toBeCloseTo(1.5);
  });

  test('disabled track is silent', () => {
    expect(buildCurve(track({ enabled: false }), trim, 10).every((v) => v === 0)).toBe(true);
  });

  test('mute range is silent with 30 ms ramps outside it', () => {
    const c = buildCurve(track({ mutes: [{ startS: 4, endS: 6 }] }), trim, 10);
    expect(at(c, 5)).toBe(0);
    expect(at(c, 4)).toBe(0);
    expect(at(c, 3.985)).toBeCloseTo(0.5, 1);
    expect(at(c, 3.9)).toBe(1);
    expect(at(c, 6.015)).toBeCloseTo(0.5, 1);
    expect(at(c, 6.1)).toBe(1);
  });

  test('fades follow trim and clamp when longer than the trim', () => {
    const c = buildCurve(track({ fadeInS: 2, fadeOutS: 2 }), { inS: 3, outS: 8 }, 10);
    expect(at(c, 3)).toBe(0);
    expect(at(c, 4)).toBeCloseTo(0.5);
    expect(at(c, 5.5)).toBe(1);
    expect(at(c, 7)).toBeCloseTo(0.5);
    const short = buildCurve(track({ fadeInS: 5, fadeOutS: 5 }), { inS: 0, outS: 1 }, 10);
    expect(Array.from(short).every(Number.isFinite)).toBe(true);
    expect(Math.max(...short.subarray(0, 200))).toBeLessThanOrEqual(1);
  });

  test('duck multiplies in', () => {
    const duck = new Float32Array(2000).fill(0.5);
    expect(at(buildCurve(track(), trim, 10, duck), 2)).toBeCloseTo(0.5);
  });
});

test('mergeMutes clamps, sorts, merges overlaps and drops empty ranges', () => {
  expect(mergeMutes([{ startS: 8, endS: 12 }, { startS: 1, endS: 3 }, { startS: 2, endS: 4 }, { startS: 5, endS: 5 }], 10)).toEqual([
    { startS: 1, endS: 4 },
    { startS: 8, endS: 10 },
  ]);
});

test('sliceCurve returns exactly the trim span', () => {
  const c = buildCurve(track({ mutes: [{ startS: 2, endS: 3 }] }), trim, 10);
  const s = sliceCurve(c, { inS: 1.5, outS: 4 });
  expect(s.length).toBe(curveLength(2.5));
  expect(at(s, 1)).toBe(0);
});

test('encodeCurve is little-endian f32 base64', () => {
  const bytes = Uint8Array.from(atob(encodeCurve(Float32Array.of(1, 0.5))), (ch) => ch.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  expect([view.getFloat32(0, true), view.getFloat32(4, true)]).toEqual([1, 0.5]);
});

test('encodes a 30-minute curve quickly', () => {
  const c = buildCurve(track({ mutes: [{ startS: 60, endS: 90 }] }), { inS: 0, outS: 1800 }, 1800);
  const t0 = performance.now();
  encodeCurve(c);
  expect(performance.now() - t0).toBeLessThan(500);
});

test('mixCurves returns a curve per track', () => {
  const m = mixCurves({ tracks: [track(), track({ index: 1, enabled: false })], duck: null }, trim, 10, null);
  expect([...m.keys()]).toEqual([0, 1]);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run src/audio/curve.test.ts`
Expected: FAIL `Cannot find module './curve'`.

- [ ] **Step 4: Implement** `src/audio/curve.ts`:

```ts
import type { AudioMix, MuteRange, TrackMix, Trim } from '../types';

/** Gain curves are sampled at 200 Hz; the Rust export and the preview use the same samples. */
export const SAMPLE_RATE = 200;
export const RAMP_S = 0.03;

export const curveLength = (seconds: number) => Math.max(0, Math.round(seconds * SAMPLE_RATE));

export function mergeMutes(mutes: MuteRange[], duration: number): MuteRange[] {
  const clamped = mutes
    .map((m) => ({ startS: Math.max(0, Math.min(m.startS, m.endS)), endS: Math.min(duration, Math.max(m.startS, m.endS)) }))
    .filter((m) => m.endS > m.startS)
    .sort((a, b) => a.startS - b.startS);
  const out: MuteRange[] = [];
  for (const m of clamped) {
    const last = out[out.length - 1];
    if (last && m.startS <= last.endS) last.endS = Math.max(last.endS, m.endS);
    else out.push({ ...m });
  }
  return out;
}

function muteMask(t: number, ranges: MuteRange[]): number {
  let g = 1;
  for (const r of ranges) {
    if (t >= r.startS && t <= r.endS) return 0;
    if (t < r.startS && r.startS - t < RAMP_S) g = Math.min(g, (r.startS - t) / RAMP_S);
    if (t > r.endS && t - r.endS < RAMP_S) g = Math.min(g, (t - r.endS) / RAMP_S);
  }
  return g;
}

function fadeMask(t: number, track: TrackMix, trim: Trim): number {
  let g = 1;
  const span = trim.outS - trim.inS;
  const fin = Math.min(track.fadeInS, span);
  const fout = Math.min(track.fadeOutS, span);
  if (fin > 0 && t >= trim.inS && t < trim.inS + fin) g *= (t - trim.inS) / fin;
  if (fout > 0 && t > trim.outS - fout) g *= Math.max(0, (trim.outS - t) / fout);
  return g;
}

/** Gain over the whole clip (video time): gain × mutes × fades × duck. Offsets are applied to the audio, not the curve. */
export function buildCurve(track: TrackMix, trim: Trim, duration: number, duck?: Float32Array): Float32Array {
  const c = new Float32Array(curveLength(duration));
  if (!track.enabled) return c;
  const ranges = mergeMutes(track.mutes, duration);
  for (let i = 0; i < c.length; i++) {
    const t = i / SAMPLE_RATE;
    c[i] = track.gain * muteMask(t, ranges) * fadeMask(t, track, trim) * (duck ? (duck[i] ?? 1) : 1);
  }
  return c;
}

export function sliceCurve(curve: Float32Array, trim: Trim): Float32Array {
  const start = Math.round(trim.inS * SAMPLE_RATE);
  const out = new Float32Array(curveLength(trim.outS - trim.inS));
  const last = curve.length ? curve[curve.length - 1] : 0;
  for (let i = 0; i < out.length; i++) out[i] = curve[start + i] ?? last;
  return out;
}

export function encodeCurve(curve: Float32Array): string {
  const bytes = new Uint8Array(curve.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < curve.length; i++) view.setFloat32(i * 4, curve[i], true);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** duckGain is applied only to the mix's duck targets. */
export function mixCurves(mix: AudioMix, trim: Trim, duration: number, duckGain: Float32Array | null): Map<number, Float32Array> {
  const targets = new Set(mix.duck?.targets ?? []);
  return new Map(mix.tracks.map((t) => [t.index, buildCurve(t, trim, duration, duckGain && targets.has(t.index) ? duckGain : undefined)]));
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/audio && npx tsc -b`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/audio
git commit -m "feat(audio): 200 Hz gain curves with mutes, fades and slicing"
```

---

### Task 4: Duck curve + default-mix resolution

**Files:**
- Create: `src/audio/duck.ts`, `src/audio/duck.test.ts`, `src/audio/resolveMix.ts`, `src/audio/resolveMix.test.ts`

**Interfaces:**
- Consumes: `AudioTrackInfo`, `AudioMix`, `TrackMix`, `Duck`, `Preset`, `PresetAudio` (types.ts); `SAMPLE_RATE` (curve.ts).
- Produces:
  - `duckCurve(triggerEnvelopes: Float32Array[], duck: Duck, length: number): Float32Array`
  - `emptyMix(): AudioMix`
  - `resolveMix(tracks: AudioTrackInfo[], preset: Preset, keep?: AudioMix): { mix: AudioMix; notice: string | null }`
  - `mixToPresetAudio(mix: AudioMix): PresetAudio`
  - `PRESET_MIX_NOTICE = "Couldn't apply the preset's audio mix — using all tracks."`

- [ ] **Step 1: Write failing tests** — `src/audio/duck.test.ts`:

```ts
import { expect, test } from 'vitest';
import { duckCurve } from './duck';

const duck = { targets: [1], triggers: [2], amountDb: -12, thresholdDb: -40, releaseS: 0.4 };

test('dips while a trigger is above threshold and recovers after release', () => {
  const env = new Float32Array(1000); // 5 s
  env.fill(0.1, 200, 400); // −20 dB from 1 s to 2 s
  const c = duckCurve([env], duck, 1000);
  expect(c[100]).toBe(1);
  expect(c[395]).toBeCloseTo(10 ** (-12 / 20), 2); // fully ducked
  expect(c[400 + 80]).toBeGreaterThan(c[400]); // recovering 0.4 s later
  expect(c[999]).toBeGreaterThan(0.95);
});

test('quiet trigger never ducks; missing envelope samples count as silence', () => {
  const env = new Float32Array(10).fill(0.001); // −60 dB
  expect(Array.from(duckCurve([env], duck, 50)).every((v) => v === 1)).toBe(true);
});
```

`src/audio/resolveMix.test.ts`:

```ts
import { expect, test } from 'vitest';
import { blankPreset } from '../presets/presets';
import type { AudioTrackInfo, Preset } from '../types';
import { PRESET_MIX_NOTICE, mixToPresetAudio, resolveMix } from './resolveMix';

const obs: AudioTrackInfo[] = ['Desktop Audio', 'Game', 'Discord', 'Mic'].map((label, index) => ({ index, label, named: true, channels: 2 }));
const unnamed: AudioTrackInfo[] = [0, 1].map((index) => ({ index, label: `Track ${index + 1}`, named: false, channels: 2 }));
const plain = blankPreset('p');
const withMix: Preset = {
  ...plain,
  audio: {
    tracks: [
      { label: 'game', enabled: true, gain: 1.2, ceilingDb: -3, offsetS: 0.1 },
      { label: 'Desktop Audio', enabled: true, gain: 0.5, ceilingDb: null, offsetS: 0 },
      { label: 'Not In Clip', enabled: false, gain: 0, ceilingDb: null, offsetS: 0 },
    ],
    duck: { targets: ['Game'], triggers: ['Discord', 'Mic', 'Nope'], amountDb: -10, thresholdDb: -40, releaseS: 0.4 },
  },
};

test('rule B: desktop audio off when other labelled tracks exist', () => {
  const { mix, notice } = resolveMix(obs, plain);
  expect(mix.tracks.map((t) => t.enabled)).toEqual([false, true, true, true]);
  expect(mix.tracks.every((t) => t.gain === 1 && t.ceilingDb === null && t.offsetS === 0)).toBe(true);
  expect(mix.duck).toBeNull();
  expect(notice).toBeNull();
});

test('rule B keeps desktop audio when it is the only named track', () => {
  const only = [{ index: 0, label: 'Desktop Audio', named: true, channels: 2 }, { index: 1, label: 'Track 2', named: false, channels: 2 }];
  expect(resolveMix(only, plain).mix.tracks[0].enabled).toBe(true);
});

test('rule A: unnamed tracks are all on', () => {
  const { mix, notice } = resolveMix(unnamed, withMix);
  expect(mix.tracks.map((t) => t.enabled)).toEqual([true, true]);
  expect(notice).toBeNull();
});

test('rule D: preset mix applies by label, case-insensitive; unmatched tracks use rule B', () => {
  const { mix } = resolveMix(obs, withMix);
  const [desktop, game, discord, mic] = mix.tracks;
  expect(game).toMatchObject({ enabled: true, gain: 1.2, ceilingDb: -3, offsetS: 0.1 });
  expect(desktop).toMatchObject({ enabled: true, gain: 0.5 });
  expect(discord).toMatchObject({ enabled: true, gain: 1 });
  expect(mic.enabled).toBe(true);
  expect(mix.duck).toEqual({ targets: [1], triggers: [2, 3], amountDb: -10, thresholdDb: -40, releaseS: 0.4 });
});

test('duck is dropped when no target or trigger matches', () => {
  const p: Preset = { ...withMix, audio: { tracks: [], duck: { targets: ['X'], triggers: ['Mic'], amountDb: -10, thresholdDb: -40, releaseS: 0.4 } } };
  expect(resolveMix(obs, p).mix.duck).toBeNull();
});

test('keeps per-clip edits when re-resolving', () => {
  const first = resolveMix(obs, plain).mix;
  first.tracks[2] = { ...first.tracks[2], label: 'Squad', fadeInS: 1, fadeOutS: 2, mutes: [{ startS: 1, endS: 2 }] };
  const again = resolveMix(obs, withMix, first).mix.tracks[2];
  expect(again).toMatchObject({ label: 'Squad', sourceLabel: 'Discord', fadeInS: 1, fadeOutS: 2, mutes: [{ startS: 1, endS: 2 }] });
});

test('rule A with notice when the preset mix cannot be applied', () => {
  const broken = { ...withMix, audio: { tracks: null, duck: null } } as unknown as Preset;
  const { mix, notice } = resolveMix(obs, broken);
  expect(mix.tracks.every((t) => t.enabled && t.gain === 1)).toBe(true);
  expect(notice).toBe(PRESET_MIX_NOTICE);
});

test('mixToPresetAudio saves per-setup settings by source label only', () => {
  const { mix } = resolveMix(obs, withMix);
  mix.tracks[1] = { ...mix.tracks[1], label: 'Renamed', mutes: [{ startS: 0, endS: 1 }], fadeInS: 3 };
  const a = mixToPresetAudio(mix);
  expect(a.tracks[1]).toEqual({ label: 'Game', enabled: true, gain: 1.2, ceilingDb: -3, offsetS: 0.1 });
  expect(a.duck).toEqual({ targets: ['Game'], triggers: ['Discord', 'Mic'], amountDb: -10, thresholdDb: -40, releaseS: 0.4 });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/audio`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement** `src/audio/duck.ts`:

```ts
import type { Duck } from '../types';
import { SAMPLE_RATE } from './curve';

const ATTACK_S = 0.05;

/** Envelopes are linear RMS at SAMPLE_RATE. Returns a gain (1 = no duck) per sample. */
export function duckCurve(triggerEnvelopes: Float32Array[], duck: Duck, length: number): Float32Array {
  const out = new Float32Array(length);
  const floor = 10 ** (duck.amountDb / 20);
  const threshold = 10 ** (duck.thresholdDb / 20);
  const down = 1 - Math.exp(-1 / (ATTACK_S * SAMPLE_RATE));
  const up = 1 - Math.exp(-1 / (duck.releaseS * SAMPLE_RATE));
  let g = 1;
  for (let i = 0; i < length; i++) {
    let level = 0;
    for (const e of triggerEnvelopes) level = Math.max(level, e[i] ?? 0);
    const target = level > threshold ? floor : 1;
    g += (target - g) * (target < g ? down : up);
    out[i] = Math.abs(g - 1) < 1e-6 ? 1 : g;
  }
  return out;
}
```

`src/audio/resolveMix.ts`:

```ts
import type { AudioMix, AudioTrackInfo, Duck, Preset, PresetAudio, TrackMix } from '../types';

export const PRESET_MIX_NOTICE = "Couldn't apply the preset's audio mix — using all tracks.";
const DESKTOP = /desktop/i;

export const emptyMix = (): AudioMix => ({ tracks: [], duck: null });

function base(t: AudioTrackInfo, enabled: boolean): TrackMix {
  return { index: t.index, sourceLabel: t.label, label: t.label, enabled, gain: 1, ceilingDb: null, offsetS: 0, fadeInS: 0, fadeOutS: 0, mutes: [] };
}

function ruleB(t: AudioTrackInfo, all: AudioTrackInfo[]): TrackMix {
  const otherNamed = all.some((o) => o.index !== t.index && o.named && !DESKTOP.test(o.label));
  return base(t, !(t.named && DESKTOP.test(t.label) && otherNamed));
}

/** Per-clip edits (display label, fades, mutes) survive a re-resolve. */
function keepClipEdits(tracks: TrackMix[], keep?: AudioMix): TrackMix[] {
  if (!keep) return tracks;
  return tracks.map((t) => {
    const k = keep.tracks.find((o) => o.index === t.index && o.sourceLabel === t.sourceLabel);
    return k ? { ...t, label: k.label, fadeInS: k.fadeInS, fadeOutS: k.fadeOutS, mutes: k.mutes.map((m) => ({ ...m })) } : t;
  });
}

function mapDuck(tracks: AudioTrackInfo[], d: PresetAudio['duck']): Duck | null {
  if (!d) return null;
  const find = (labels: string[]) => tracks.filter((t) => labels.some((l) => l.toLowerCase() === t.label.toLowerCase())).map((t) => t.index);
  const targets = find(d.targets);
  const triggers = find(d.triggers);
  return targets.length && triggers.length ? { targets, triggers, amountDb: d.amountDb, thresholdDb: d.thresholdDb, releaseS: d.releaseS } : null;
}

export function resolveMix(tracks: AudioTrackInfo[], preset: Preset, keep?: AudioMix): { mix: AudioMix; notice: string | null } {
  const ruleA = () => keepClipEdits(tracks.map((t) => base(t, true)), keep);
  if (!tracks.some((t) => t.named)) return { mix: { tracks: ruleA(), duck: null }, notice: null };
  try {
    const audio = preset.audio;
    const resolved = tracks.map((t) => {
      const p = audio?.tracks.find((e) => e.label.toLowerCase() === t.label.toLowerCase());
      const d = ruleB(t, tracks);
      return p ? { ...d, enabled: p.enabled, gain: p.gain, ceilingDb: p.ceilingDb, offsetS: p.offsetS } : d;
    });
    return { mix: { tracks: keepClipEdits(resolved, keep), duck: mapDuck(tracks, audio?.duck ?? null) }, notice: null };
  } catch {
    return { mix: { tracks: ruleA(), duck: null }, notice: PRESET_MIX_NOTICE };
  }
}

export function mixToPresetAudio(mix: AudioMix): PresetAudio {
  const labelOf = (i: number) => mix.tracks.find((t) => t.index === i)?.sourceLabel;
  const labels = (ids: number[]) => ids.map(labelOf).filter((l): l is string => !!l);
  return {
    tracks: mix.tracks.map((t) => ({ label: t.sourceLabel, enabled: t.enabled, gain: t.gain, ceilingDb: t.ceilingDb, offsetS: t.offsetS })),
    duck: mix.duck ? { targets: labels(mix.duck.targets), triggers: labels(mix.duck.triggers), amountDb: mix.duck.amountDb, thresholdDb: mix.duck.thresholdDb, releaseS: mix.duck.releaseS } : null,
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/audio && npx tsc -b`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/audio
git commit -m "feat(audio): duck curve and preset/smart/fallback mix resolution"
```

---

### Task 5: Rust `prepare_audio` + `audio_envelope` commands and TS backend

**Files:**
- Create: `src-tauri/src/audio_prep.rs`
- Modify: `src-tauri/src/proxy.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src/backend/types.ts`, `src/backend/tauri.ts`, `src/backend/fake.ts`, `src/backend/fake.test.ts`

**Interfaces:**
- Consumes: `probe_clip_file` (probe.rs), `tool_command` (ffmpeg.rs).
- Produces (Rust): `pub fn source_key(source: &Path) -> String` (proxy.rs); `pub struct PreparedTrack { index: u32, audio_path: String, envelope_path: String }` (camelCase); `pub fn rms_envelope(samples: &[f32], window: usize) -> Vec<f32>`; `pub fn prepare_audio_files(cache: &Path, source: &Path, count: u32) -> Result<Vec<PreparedTrack>, String>`; commands `prepare_audio(path) -> Vec<PreparedTrack>` and `audio_envelope(path) -> tauri::ipc::Response` (raw f32le bytes).
- Produces (TS): `interface PreparedTrack { index: number; audioUrl: string; envelope: Float32Array }`; `Backend.prepareAudio(path: string): Promise<PreparedTrack[]>` (rejects with `Error` on failure).

- [ ] **Step 1: Write failing Rust tests** — new file `src-tauri/src/audio_prep.rs` with only the test module first:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rms_envelope_windows_and_partial_tail() {
        let mut s = vec![0.5f32; 40];
        s.extend(vec![0.0f32; 40]);
        s.extend(vec![1.0f32; 10]);
        let e = rms_envelope(&s, 40);
        assert_eq!(e.len(), 3);
        assert!((e[0] - 0.5).abs() < 1e-6);
        assert_eq!(e[1], 0.0);
        assert!((e[2] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn cache_paths_are_per_source_and_track() {
        let d = audio_dir(Path::new("/cache"), Path::new("/v/a.mp4"));
        assert!(d.starts_with("/cache/audio"));
        assert_ne!(d, audio_dir(Path::new("/cache"), Path::new("/v/b.mp4")));
        assert!(track_paths(&d, 2).0.ends_with("track-2.m4a"));
        assert!(track_paths(&d, 2).1.ends_with("env-2.f32"));
    }

    /// Needs ffmpeg on PATH. Run: cargo test prepare_real -- --ignored
    #[test]
    #[ignore]
    fn prepare_real_two_track_file() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("two.mp4");
        let ok = crate::ffmpeg::tool_command("ffmpeg")
            .args(["-hide_banner", "-y", "-f", "lavfi", "-i", "sine=f=440:d=2", "-f", "lavfi", "-i", "anullsrc=d=2", "-map", "0:a", "-map", "1:a", "-c:a", "aac"])
            .arg(&src).status().unwrap().success();
        assert!(ok);
        let t = prepare_audio_files(dir.path(), &src, 2).unwrap();
        assert_eq!(t.len(), 2);
        let env0 = std::fs::read(&t[0].envelope_path).unwrap();
        let env1 = std::fs::read(&t[1].envelope_path).unwrap();
        assert!((env0.len() / 4) as i64 - 400 <= 2 && (env0.len() / 4) >= 398);
        let loud = f32::from_le_bytes(env0[400..404].try_into().unwrap());
        let quiet = f32::from_le_bytes(env1[400..404].try_into().unwrap());
        assert!(loud > 0.1 && quiet < 0.001);
        assert!(std::path::Path::new(&t[1].audio_path).exists());
    }
}
```

Add `pub mod audio_prep;` to `src-tauri/src/lib.rs`.

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && cargo test audio_prep`
Expected: compile errors (`rms_envelope`, `audio_dir`, `track_paths` not found).

- [ ] **Step 3: Implement.** In `src-tauri/src/proxy.rs` extract the hash so both caches share it:

```rust
/// Stable per source file (path + size + mtime); used for the proxy and audio caches.
pub fn source_key(source: &Path) -> String {
    let mut h = DefaultHasher::new();
    source.hash(&mut h);
    if let Ok(m) = std::fs::metadata(source) {
        m.len().hash(&mut h);
        if let Ok(t) = m.modified() {
            t.hash(&mut h);
        }
    }
    format!("{:016x}", h.finish())
}

pub fn proxy_path(cache: &Path, source: &Path) -> PathBuf {
    cache.join("proxies").join(format!("{}.mp4", source_key(source)))
}
```

Top of `src-tauri/src/audio_prep.rs` (above the test module):

```rust
use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::Serialize;

use crate::ffmpeg::tool_command;
use crate::proxy::source_key;

/// 8 kHz mono, 40-sample windows = 5 ms = 200 envelope values per second (matches the TS SAMPLE_RATE).
const ENV_RATE: &str = "8000";
const ENV_WINDOW: usize = 40;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedTrack {
    pub index: u32,
    pub audio_path: String,
    pub envelope_path: String,
}

pub fn audio_dir(cache: &Path, source: &Path) -> PathBuf {
    cache.join("audio").join(source_key(source))
}

pub fn track_paths(dir: &Path, index: u32) -> (PathBuf, PathBuf) {
    (dir.join(format!("track-{index}.m4a")), dir.join(format!("env-{index}.f32")))
}

pub fn rms_envelope(samples: &[f32], window: usize) -> Vec<f32> {
    samples.chunks(window).map(|c| (c.iter().map(|s| s * s).sum::<f32>() / c.len() as f32).sqrt()).collect()
}

fn ffmpeg_err(what: &str, stderr: &[u8]) -> String {
    let e = String::from_utf8_lossy(stderr);
    format!("Couldn't prepare {what}.\n{}", e.lines().rev().take(10).collect::<Vec<_>>().join("\n"))
}

fn extract_track(source: &Path, index: u32, out: &Path) -> Result<(), String> {
    let part = out.with_extension("part.m4a");
    let r = tool_command("ffmpeg")
        .args(["-hide_banner", "-nostdin", "-y", "-i"])
        .arg(source)
        .args(["-map", &format!("0:a:{index}"), "-vn", "-c:a", "copy"])
        .arg(&part)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("Couldn't run ffmpeg: {e}"))?;
    if !r.status.success() {
        let _ = std::fs::remove_file(&part);
        return Err(ffmpeg_err("audio track", &r.stderr));
    }
    std::fs::rename(&part, out).map_err(|e| e.to_string())
}

fn write_envelope(source: &Path, index: u32, out: &Path) -> Result<(), String> {
    let r = tool_command("ffmpeg")
        .args(["-hide_banner", "-nostdin", "-i"])
        .arg(source)
        .args(["-map", &format!("0:a:{index}"), "-vn", "-ac", "1", "-ar", ENV_RATE, "-f", "f32le", "pipe:1"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("Couldn't run ffmpeg: {e}"))?;
    if !r.status.success() {
        return Err(ffmpeg_err("audio waveform", &r.stderr));
    }
    let samples: Vec<f32> = r.stdout.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    let bytes: Vec<u8> = rms_envelope(&samples, ENV_WINDOW).iter().flat_map(|v| v.to_le_bytes()).collect();
    let part = out.with_extension("part");
    std::fs::write(&part, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&part, out).map_err(|e| e.to_string())
}

/// Per-track stream copy (for the preview) plus a 200 Hz RMS envelope (waveforms, ducking). Cached per source.
pub fn prepare_audio_files(cache: &Path, source: &Path, count: u32) -> Result<Vec<PreparedTrack>, String> {
    let dir = audio_dir(cache, source);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    (0..count)
        .map(|i| {
            let (audio, env) = track_paths(&dir, i);
            if !audio.exists() {
                extract_track(source, i, &audio)?;
            }
            if !env.exists() {
                write_envelope(source, i, &env)?;
            }
            Ok(PreparedTrack { index: i, audio_path: audio.to_string_lossy().into_owned(), envelope_path: env.to_string_lossy().into_owned() })
        })
        .collect()
}
```

In `src-tauri/src/commands.rs` add `use crate::audio_prep::{prepare_audio_files, PreparedTrack};` and:

```rust
#[tauri::command]
pub async fn prepare_audio(app: AppHandle, path: String) -> Result<Vec<PreparedTrack>, String> {
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    let p = path.clone();
    let tracks = tauri::async_runtime::spawn_blocking(move || {
        let info = probe_clip_file(&p)?;
        prepare_audio_files(&cache, &PathBuf::from(&p), info.audio_tracks.len() as u32)
    })
    .await
    .map_err(join_err)??;
    for t in &tracks {
        allow_asset(&app, &t.audio_path)?;
    }
    Ok(tracks)
}

/// Raw f32le bytes over IPC; avoids asset-protocol CORS for fetch(). Only files inside the audio cache are readable.
#[tauri::command]
pub fn audio_envelope(app: AppHandle, path: String) -> Result<tauri::ipc::Response, String> {
    let root = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("audio");
    let p = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
    let root = std::fs::canonicalize(&root).map_err(|e| e.to_string())?;
    if !p.starts_with(&root) || p.extension().map_or(true, |x| x != "f32") {
        return Err("not an envelope file".into());
    }
    std::fs::read(&p).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}
```

Register both in `lib.rs` `generate_handler![...]`: `commands::prepare_audio, commands::audio_envelope,`.

- [ ] **Step 4: Run Rust tests**

Run: `cd src-tauri && cargo test && cargo test prepare_real -- --ignored`
Expected: PASS (existing proxy test still passes).

- [ ] **Step 5: TS backend.** In `src/backend/types.ts` add to imports nothing new; add above `Backend`:

```ts
export interface PreparedTrack { index: number; audioUrl: string; envelope: Float32Array }
```

and to `Backend`:

```ts
  /** Per-track audio for the live preview. Rejects with Error when unavailable. */
  prepareAudio(path: string): Promise<PreparedTrack[]>;
```

In `src/backend/tauri.ts` import `type PreparedTrack` from `./types` and add:

```ts
  async prepareAudio(path: string): Promise<PreparedTrack[]> {
    try {
      const tracks = await invoke<{ index: number; audioPath: string; envelopePath: string }[]>('prepare_audio', { path });
      return await Promise.all(
        tracks.map(async (t) => ({
          index: t.index,
          audioUrl: convertFileSrc(t.audioPath),
          envelope: new Float32Array(await invoke<ArrayBuffer>('audio_envelope', { path: t.envelopePath })),
        })),
      );
    } catch (e) {
      throw new Error(String(e));
    }
  }
```

In `src/backend/fake.ts` add:

```ts
  async prepareAudio(): Promise<PreparedTrack[]> {
    throw new Error('Audio preview needs the desktop app.');
  }
```

(import `type PreparedTrack` from `./types`). Append to `src/backend/fake.test.ts`:

```ts
test('fake prepareAudio rejects so the UI falls back to the video audio', async () => {
  await expect(new FakeBackend().prepareAudio('fake://a.mp4')).rejects.toThrow('desktop app');
});
```

(ensure `FakeBackend`, `expect`, `test` are imported there already).

- [ ] **Step 6: Run all tests**

Run: `npx vitest run && npx tsc -b && (cd src-tauri && cargo test)`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A src src-tauri/src
git commit -m "feat(audio): cached per-track audio + RMS envelopes for preview"
```

---

### Task 6: Export job carries the mix + gain curves (TS and Rust validation)

**Files:**
- Modify: `src/types.ts`, `src/state/exportJob.ts`, `src/state/exportJob.test.ts`
- Create: `src-tauri/src/audio_mix.rs`
- Modify: `src-tauri/src/job.rs`, `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `sliceCurve`, `encodeCurve` (curve.ts); `AudioMix` (types.ts).
- Produces (TS): `ExportJob.audio: AudioMix`, `ExportJob.gainCurves: Record<number, string>`, `ExportErrorCode` gains `'invalid_audio'`; `buildExportJob({... , mix: AudioMix, curves: Map<number, Float32Array>})`.
- Produces (Rust `audio_mix.rs`): `pub const GAIN_RATE: f64 = 200.0;` `pub struct TrackMix { index: u32, enabled: bool, ceiling_db: Option<f64>, offset_s: f64 }`, `pub struct AudioMix { tracks: Vec<TrackMix> }` (camelCase, `Default`), `pub fn enabled_tracks(job: &ExportJob) -> Vec<&TrackMix>`, `pub fn curve_samples(trim: &Trim) -> usize`, `pub fn validate_mix(job: &ExportJob) -> Result<(), String>`. `ExportJob.audio: AudioMix` (`#[serde(default)]`), `ExportJob.gain_curves: HashMap<u32, String>` (`#[serde(default)]`).

- [ ] **Step 1: Write failing TS test** — append to `src/state/exportJob.test.ts` (reuse the file's `clip`, and whatever preset/asset fixtures it already has; `blankPreset('p')` + `{ layerMasks: {}, overlays: [] }` work):

```ts
import { SAMPLE_RATE } from '../audio/curve';
import type { AudioMix } from '../types';

test('job carries the mix and a trimmed, encoded curve per enabled track', () => {
  const mix: AudioMix = {
    tracks: [
      { index: 0, sourceLabel: 'Game', label: 'Game', enabled: true, gain: 1, ceilingDb: -3, offsetS: 0, fadeInS: 0, fadeOutS: 0, mutes: [] },
      { index: 1, sourceLabel: 'Mic', label: 'Mic', enabled: false, gain: 1, ceilingDb: null, offsetS: 0, fadeInS: 0, fadeOutS: 0, mutes: [] },
    ],
    duck: null,
  };
  const curves = new Map([[0, new Float32Array(30 * SAMPLE_RATE).fill(1)], [1, new Float32Array(30 * SAMPLE_RATE)]]);
  const job = buildExportJob({ source: 'a.mp4', clip, preset: blankPreset('p'), trim: { inS: 2, outS: 7 }, quality: 'high', assets: { layerMasks: {}, overlays: [] }, outputDir: null, mix, curves });
  expect(job.audio).toBe(mix);
  expect(Object.keys(job.gainCurves)).toEqual(['0']);
  expect(atob(job.gainCurves[0]).length).toBe(5 * SAMPLE_RATE * 4);
});
```

Update the existing `buildExportJob` calls in that file (and in `ExportPanel.tsx`, done in Task 8) by adding `mix: { tracks: [], duck: null }, curves: new Map()`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/state/exportJob.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement TS.** In `src/types.ts` add to `ExportJob`:

```ts
  audio: AudioMix;
  /** track index -> base64 little-endian f32 gain samples at 200 Hz covering [trim.inS, trim.outS) */
  gainCurves: Record<number, string>;
```

and change `ExportErrorCode` to include `| 'invalid_audio'`.

In `src/state/exportJob.ts`:

```ts
import { encodeCurve, sliceCurve } from '../audio/curve';
import type { AudioMix, ClipInfo, ExportError, ExportJob, Overlay, Preset, Quality, Trim } from '../types';

export function buildExportJob(a: {
  source: string;
  clip: ClipInfo;
  preset: Preset;
  trim: Trim;
  quality: Quality;
  assets: { layerMasks: Record<string, string>; overlays: Overlay[] };
  outputDir: string | null;
  mix: AudioMix;
  curves: Map<number, Float32Array>;
}): ExportJob {
  const gainCurves: Record<number, string> = {};
  for (const t of a.mix.tracks) {
    const c = a.curves.get(t.index);
    if (t.enabled && c) gainCurves[t.index] = encodeCurve(sliceCurve(c, a.trim));
  }
  return {
    source: a.source,
    clip: a.clip,
    preset: a.preset,
    trim: a.trim,
    quality: a.quality,
    layerMasks: a.assets.layerMasks,
    overlays: a.assets.overlays.filter((o) => o.start < a.trim.outS),
    outputDir: a.outputDir,
    audio: a.mix,
    gainCurves,
  };
}
```

- [ ] **Step 4: Write failing Rust tests** — create `src-tauri/src/audio_mix.rs` with tests first (add `pub mod audio_mix;` to `lib.rs`):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::job::{fixtures::job, AudioTrackInfo};
    use base64::Engine;

    pub fn ones(n: usize) -> String {
        base64::engine::general_purpose::STANDARD.encode(vec![1.0f32; n].iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>())
    }

    fn with_tracks() -> ExportJob {
        let mut j = job(); // trim 1..11 => 2000 samples
        j.clip.audio_tracks = (0..2).map(|i| AudioTrackInfo { index: i, label: format!("T{i}"), named: true, channels: 2 }).collect();
        j.audio = serde_json::from_str(r#"{"tracks":[{"index":0,"enabled":true,"ceilingDb":-3,"offsetS":0,"gain":1,"mutes":[]},{"index":1,"enabled":false,"ceilingDb":null,"offsetS":0}],"duck":null}"#).unwrap();
        j.gain_curves.insert(0, ones(2000));
        j
    }

    #[test]
    fn valid_mix_passes_and_ignores_ts_only_fields() {
        let j = with_tracks();
        assert!(validate_mix(&j).is_ok());
        assert_eq!(enabled_tracks(&j).iter().map(|t| t.index).collect::<Vec<_>>(), [0]);
        assert_eq!(curve_samples(&j.trim), 2000);
    }

    #[test]
    fn rejects_bad_mixes() {
        let mut j = with_tracks();
        j.gain_curves.insert(0, ones(1990));
        assert!(validate_mix(&j).unwrap_err().contains("curve"));
        let mut j = with_tracks();
        j.gain_curves.clear();
        assert!(validate_mix(&j).unwrap_err().contains("curve"));
        let mut j = with_tracks();
        j.audio.tracks[0].index = 7;
        assert!(validate_mix(&j).unwrap_err().contains("track"));
        let mut j = with_tracks();
        j.audio.tracks[1].index = 0;
        assert!(validate_mix(&j).unwrap_err().contains("duplicate"));
        let mut j = with_tracks();
        j.audio.tracks[0].ceiling_db = Some(-30.0);
        assert!(validate_mix(&j).unwrap_err().contains("ceiling"));
        let mut j = with_tracks();
        j.audio.tracks[0].offset_s = 3.0;
        assert!(validate_mix(&j).unwrap_err().contains("offset"));
        let mut j = with_tracks();
        j.gain_curves.insert(0, "%%%".into());
        assert!(validate_mix(&j).is_err());
    }

    #[test]
    fn job_json_without_audio_still_parses() {
        let j: ExportJob = serde_json::from_str(r#"{"source":"a","clip":{"width":1920,"height":1080,"fps":"60","codec":"h264","duration":5,"hasAudio":false},
          "preset":{"id":"p","name":"P","version":1,"background":{"type":"none"},"layers":[{"id":"g","src":[0,0,1,1],"dst":[0,0,1080,1920]}]},
          "trim":{"inS":0,"outS":5},"quality":"small","layerMasks":{},"overlays":[],"outputDir":null}"#).unwrap();
        assert!(j.audio.tracks.is_empty() && j.gain_curves.is_empty());
        let j: ExportJob = serde_json::from_str(r#"{"source":"a","clip":{"width":1920,"height":1080,"fps":"60","codec":"h264","duration":5,"hasAudio":true,"audioTracks":[{"index":0,"label":"G","named":true,"channels":2}]},
          "preset":{"id":"p","name":"P","version":1,"background":{"type":"none"},"layers":[{"id":"g","src":[0,0,1,1],"dst":[0,0,1080,1920]}]},
          "trim":{"inS":0,"outS":5},"quality":"small","layerMasks":{},"overlays":[],"outputDir":null,
          "audio":{"tracks":[{"index":0,"enabled":true,"ceilingDb":null,"offsetS":0}],"duck":null},"gainCurves":{"0":"AACAPw=="}}"#).unwrap();
        assert_eq!(j.gain_curves.len(), 1);
    }
}
```

- [ ] **Step 5: Implement Rust.** Top of `src-tauri/src/audio_mix.rs`:

```rust
use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::job::{ExportJob, Trim};
use crate::preset::in_range;

/// Samples per second of the gain curves sent by the frontend (TS SAMPLE_RATE).
pub const GAIN_RATE: f64 = 200.0;

/// Only what the export needs: gain, mutes, fades and ducking are already baked into the curve.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackMix {
    pub index: u32,
    pub enabled: bool,
    pub ceiling_db: Option<f64>,
    pub offset_s: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AudioMix {
    #[serde(default)]
    pub tracks: Vec<TrackMix>,
}

pub fn curve_samples(trim: &Trim) -> usize {
    ((trim.out_s - trim.in_s) * GAIN_RATE).round().max(0.0) as usize
}

pub fn enabled_tracks(job: &ExportJob) -> Vec<&TrackMix> {
    if !job.clip.has_audio {
        return vec![];
    }
    job.audio.tracks.iter().filter(|t| t.enabled && job.clip.audio_tracks.iter().any(|a| a.index == t.index)).collect()
}

pub fn validate_mix(job: &ExportJob) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    for t in &job.audio.tracks {
        if !seen.insert(t.index) {
            return Err(format!("duplicate audio track {}", t.index));
        }
        if !job.clip.audio_tracks.iter().any(|a| a.index == t.index) {
            return Err(format!("audio track {} is not in this clip", t.index));
        }
        if let Some(c) = t.ceiling_db {
            if !in_range(c, -24.0, 0.0) {
                return Err(format!("audio track {}: ceiling must be -24 to 0 dB", t.index));
            }
        }
        if !in_range(t.offset_s, -2.0, 2.0) {
            return Err(format!("audio track {}: offset must be -2 to 2 s", t.index));
        }
    }
    let want = curve_samples(&job.trim) as i64;
    for t in enabled_tracks(job) {
        let b64 = job.gain_curves.get(&t.index).ok_or_else(|| format!("audio track {}: missing gain curve", t.index))?;
        let bytes = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| format!("audio track {}: bad gain curve ({e})", t.index))?;
        let got = (bytes.len() / 4) as i64;
        if bytes.len() % 4 != 0 || (got - want).abs() > 1 {
            return Err(format!("audio track {}: gain curve has {got} samples, expected {want}", t.index));
        }
    }
    Ok(())
}
```

In `src-tauri/src/job.rs` add `use crate::audio_mix::AudioMix;` and to `ExportJob` (after `output_dir`):

```rust
    #[serde(default)]
    pub audio: AudioMix,
    /// track index -> base64 f32le gain samples at 200 Hz covering the trim
    #[serde(default)]
    pub gain_curves: HashMap<u32, String>,
```

and in `fixtures::job()` add `audio: AudioMix::default(), gain_curves: HashMap::new(),`.

- [ ] **Step 6: Run tests**

Run: `(cd src-tauri && cargo test) && npx vitest run src/state && npx tsc -b`
Expected: Rust PASS, the exportJob tests PASS. `tsc -b` will fail only in `ExportPanel.tsx` (missing `mix`/`curves`) — fixed in Task 8; if you want a clean tsc now, pass `mix: { tracks: [], duck: null }, curves: new Map()` in `ExportPanel.tsx` temporarily.

- [ ] **Step 7: Commit**

```bash
git add -A src src-tauri/src
git commit -m "feat(audio): export job carries mix + gain curves, validated in Rust"
```

---

### Task 7: Rust audio filtergraph + gain files (single output track)

**Files:**
- Modify: `src-tauri/src/filtergraph.rs`, `src-tauri/src/export.rs`

**Interfaces:**
- Consumes: `enabled_tracks`, `validate_mix`, `GAIN_RATE` (audio_mix.rs); `secs` (filtergraph.rs).
- Produces: `WrittenAssets.gains: Vec<(u32, PathBuf)>`; `build_args(job, masks, overlays, gains: &[(u32, PathBuf)], enc, out)`; `pub fn build_audio_filter(job: &ExportJob, audio_input: usize, gain_inputs: &[(u32, usize)]) -> Option<String>`; `ExportError` code `invalid_audio`.

- [ ] **Step 1: Write failing tests** — in `src-tauri/src/filtergraph.rs` tests module:

1. Change every existing `build_args(&j, &[], &[], Encoder::X264, ...)` call to `build_args(&j, &[], &[], &[], Encoder::X264, ...)`, and in `wardogs_args()` add `&[]` as the 4th argument.
2. In `golden_wardogs_args`, replace `"-map", "[vout]", "-map", "0:a?"` with `"-map", "[vout]"` and replace the audio args line with `expected.extend(["-an", "-movflags", "+faststart", "C:/clips/in_vertical.mp4"]);` (the fixture has no audio tracks).
3. Replace `no_audio_track_still_maps_optionally` with:

```rust
    fn four_track_job() -> ExportJob {
        let mut j = job(); // trim 1..11, dur 10
        j.clip.audio_tracks = ["Desktop", "Game", "Discord", "Mic"]
            .iter()
            .enumerate()
            .map(|(i, l)| crate::job::AudioTrackInfo { index: i as u32, label: (*l).into(), named: true, channels: if i == 3 { 1 } else { 2 } })
            .collect();
        j.audio = serde_json::from_str(r#"{"tracks":[
            {"index":0,"enabled":false,"ceilingDb":null,"offsetS":0},
            {"index":1,"enabled":true,"ceilingDb":-3,"offsetS":0},
            {"index":2,"enabled":true,"ceilingDb":null,"offsetS":0.25},
            {"index":3,"enabled":true,"ceilingDb":null,"offsetS":-0.5}]}"#).unwrap();
        j
    }

    #[test]
    fn golden_four_track_audio_filter() {
        // audio input 1; gain inputs 2,3,4 for tracks 1,2,3. in=1 -> audio input starts at 0, lead=1.
        let f = build_audio_filter(&four_track_job(), 1, &[(1, 2), (2, 3), (3, 4)]).unwrap();
        let fmt = "aformat=sample_rates=48000:channel_layouts=stereo";
        let lim = "attack=1:release=50:level=0:latency=1";
        let expected = [
            format!("[1:a:1]atrim=start=1.000,asetpts=PTS-STARTPTS,{fmt},apad,atrim=duration=10.000[t0]"),
            format!("[2:a]aresample=48000,aformat=channel_layouts=stereo[g0]"),
            format!("[t0][g0]amultiply,alimiter=limit=0.708:{lim}[c0]"),
            format!("[1:a:2]atrim=start=0.750,asetpts=PTS-STARTPTS,{fmt},apad,atrim=duration=10.000[t1]"),
            format!("[3:a]aresample=48000,aformat=channel_layouts=stereo[g1]"),
            format!("[t1][g1]amultiply[c1]"),
            format!("[1:a:3]atrim=start=1.500,asetpts=PTS-STARTPTS,{fmt},apad,atrim=duration=10.000[t2]"),
            format!("[4:a]aresample=48000,aformat=channel_layouts=stereo[g2]"),
            format!("[t2][g2]amultiply[c2]"),
            format!("[c0][c1][c2]amix=inputs=3:normalize=0:duration=first,alimiter=limit=0.891:{lim}[aout]"),
        ]
        .join(";");
        assert_eq!(f, expected);
    }

    #[test]
    fn positive_offset_past_the_lead_pads_with_silence() {
        let mut j = four_track_job();
        j.trim = crate::job::Trim { in_s: 0.2, out_s: 5.2 }; // lead = 0.2
        j.audio.tracks.retain(|t| t.index == 2); // offset +0.25 => start -0.05
        let f = build_audio_filter(&j, 1, &[(2, 2)]).unwrap();
        assert!(f.starts_with("[1:a:2]aformat=sample_rates=48000:channel_layouts=stereo,adelay=delays=50:all=1,apad,atrim=duration=5.000[t0]"), "{f}");
        assert!(f.ends_with("[c0]alimiter=limit=0.891:attack=1:release=50:level=0:latency=1[aout]"), "{f}");
    }

    #[test]
    fn audio_args_open_the_source_again_and_map_one_track() {
        let j = four_track_job();
        let gains = [(1, PathBuf::from("/w/gain-1.f32")), (2, PathBuf::from("/w/gain-2.f32")), (3, PathBuf::from("/w/gain-3.f32"))];
        let a = build_args(&j, &[], &[], &gains, Encoder::X264, Path::new("out.mp4"));
        let s = a.join(" ");
        assert!(s.contains("-ss 0.000 -t 14.000 -i C:/clips/in.mp4"), "{s}");
        assert!(s.contains("-f f32le -ar 200 -ac 1 -i /w/gain-1.f32"));
        assert!(s.contains("-map [aout] -c:a aac -b:a 192k"));
        assert!(!s.contains("0:a?") && !s.contains("-an"));
        assert!(a.iter().find(|x| x.contains("[vout]") && x.contains(";")).unwrap().contains("[aout]"));
    }

    #[test]
    fn no_enabled_tracks_means_no_audio() {
        let mut j = four_track_job();
        j.audio.tracks.iter_mut().for_each(|t| t.enabled = false);
        let a = build_args(&j, &[], &[], &[], Encoder::X264, Path::new("out.mp4"));
        assert!(a.contains(&"-an".to_string()));
        assert!(!a.iter().any(|x| x.contains("aout")));
        assert_eq!(a.iter().filter(|x| *x == "-i").count(), 1);
    }
```

In `src-tauri/src/export.rs` tests add:

```rust
    #[test]
    fn write_assets_writes_gain_curves_for_enabled_tracks() {
        let dir = tempfile::tempdir().unwrap();
        let mut j = job();
        j.clip.audio_tracks = vec![crate::job::AudioTrackInfo { index: 0, label: "G".into(), named: true, channels: 2 }];
        j.audio = serde_json::from_str(r#"{"tracks":[{"index":0,"enabled":true,"ceilingDb":null,"offsetS":0}]}"#).unwrap();
        j.gain_curves.insert(0, "AACAPw==".into()); // one f32 = 1.0
        let a = write_assets(&j, dir.path()).unwrap();
        assert_eq!(a.gains.len(), 1);
        assert_eq!(std::fs::read(&a.gains[0].1).unwrap(), 1.0f32.to_le_bytes());
    }

    #[test]
    fn invalid_audio_is_rejected_before_ffmpeg() {
        let dir = tempfile::tempdir().unwrap();
        let mut j = job();
        j.output_dir = Some(dir.path().to_string_lossy().into_owned());
        j.clip.audio_tracks = vec![crate::job::AudioTrackInfo { index: 0, label: "G".into(), named: true, channels: 2 }];
        j.audio = serde_json::from_str(r#"{"tracks":[{"index":0,"enabled":true,"ceilingDb":null,"offsetS":0}]}"#).unwrap();
        let e = run_export(j, &some_encoder(), dir.path(), &ExportState::default(), &|_| {}).unwrap_err();
        assert_eq!(e.code, "invalid_audio");
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && cargo test`
Expected: compile errors (`build_audio_filter`, `gains` not found; argument count).

- [ ] **Step 3: Implement.** In `src-tauri/src/filtergraph.rs` add `use crate::audio_mix::{enabled_tracks, GAIN_RATE};` and:

```rust
/// Seconds of source audio opened before trim-in so negative offsets have audio to use.
const AUDIO_LEAD: f64 = 2.0;
const LIMITER: &str = "attack=1:release=50:level=0:latency=1";

fn audio_seek(job: &ExportJob) -> f64 {
    (job.trim.in_s - AUDIO_LEAD).max(0.0)
}

/// One mixed stereo track: per-track offset/trim, × gain curve, optional ceiling, amix, −1 dB master limiter.
pub fn build_audio_filter(job: &ExportJob, audio_input: usize, gain_inputs: &[(u32, usize)]) -> Option<String> {
    let dur = job.trim.out_s - job.trim.in_s;
    let lead = job.trim.in_s - audio_seek(job);
    let fmt = "aformat=sample_rates=48000:channel_layouts=stereo";
    let mut parts = Vec::new();
    let mut outs = Vec::new();
    for (k, t) in enabled_tracks(job).into_iter().enumerate() {
        let Some(&(_, g)) = gain_inputs.iter().find(|(i, _)| *i == t.index) else { continue };
        let start = lead - t.offset_s;
        parts.push(if start >= 0.0 {
            format!("[{audio_input}:a:{}]atrim=start={},asetpts=PTS-STARTPTS,{fmt},apad,atrim=duration={}[t{k}]", t.index, secs(start), secs(dur))
        } else {
            format!("[{audio_input}:a:{}]{fmt},adelay=delays={}:all=1,apad,atrim=duration={}[t{k}]", t.index, (-start * 1000.0).round() as i64, secs(dur))
        });
        parts.push(format!("[{g}:a]aresample=48000,aformat=channel_layouts=stereo[g{k}]"));
        let ceiling = t.ceiling_db.map(|db| format!(",alimiter=limit={:.3}:{LIMITER}", 10f64.powf(db / 20.0))).unwrap_or_default();
        parts.push(format!("[t{k}][g{k}]amultiply{ceiling}[c{k}]"));
        outs.push(format!("[c{k}]"));
    }
    if outs.is_empty() {
        return None;
    }
    let master = format!("alimiter=limit=0.891:{LIMITER}[aout]");
    parts.push(if outs.len() == 1 {
        format!("{}{master}", outs[0])
    } else {
        format!("{}amix=inputs={}:normalize=0:duration=first,{master}", outs.join(""), outs.len())
    });
    Some(parts.join(";"))
}
```

Change `build_args` signature to `pub fn build_args(job: &ExportJob, masks: &[(String, PathBuf)], overlays: &[(PathBuf, f64)], gains: &[(u32, PathBuf)], enc: Encoder, out: &Path) -> Vec<String>`. After the overlay-input loop and before `args.push("-filter_complex".into());` add:

```rust
    let mut audio = None;
    if !gains.is_empty() {
        let a_in = next;
        next += 1;
        args.extend(["-ss".into(), secs(audio_seek(job)), "-t".into(), secs(dur + 2.0 * AUDIO_LEAD), "-i".into(), job.source.clone()]);
        let mut gain_inputs = Vec::new();
        for (idx, p) in gains {
            args.extend(["-f", "f32le", "-ar", &format!("{GAIN_RATE}"), "-ac", "1", "-i"].map(String::from));
            args.push(p.to_string_lossy().into_owned());
            gain_inputs.push((*idx, next));
            next += 1;
        }
        audio = build_audio_filter(job, a_in, &gain_inputs);
    }
```

Note `format!("{GAIN_RATE}")` for `200.0_f64` prints `200` — verify the test string `-ar 200`; if it prints `200`, fine; otherwise use `format!("{}", GAIN_RATE as u32)`.

Replace the filter/map/audio-codec lines with:

```rust
    let video = build_filter(job, &mask_inputs, &overlay_inputs, &fps);
    args.push("-filter_complex".into());
    args.push(match &audio {
        Some(a) => format!("{video};{a}"),
        None => video,
    });
    args.extend(["-map".into(), "[vout]".into()]);
    if audio.is_some() {
        args.extend(["-map", "[aout]"].map(String::from));
    }
    args.extend(enc.args(job.quality));
    if audio.is_some() {
        args.extend(["-c:a", "aac", "-b:a", "192k"].map(String::from));
    } else {
        args.push("-an".into());
    }
    args.extend(["-movflags", "+faststart"].map(String::from));
    args.push(out.to_string_lossy().into_owned());
    args
```

Mark `next` as `let mut next` (already is). In `src-tauri/src/export.rs`:
- `WrittenAssets` gains `pub gains: Vec<(u32, PathBuf)>,`.
- In `write_assets`, before `Ok(...)`:

```rust
    let mut gains = Vec::new();
    for t in crate::audio_mix::enabled_tracks(job) {
        if let Some(data) = job.gain_curves.get(&t.index) {
            let p = dir.join(format!("gain-{}.f32", t.index));
            std::fs::write(&p, b64.decode(data).map_err(io_err)?).map_err(io_err)?;
            gains.push((t.index, p));
        }
    }
    Ok(WrittenAssets { masks, overlays, gains })
```

- In `run_once`: `build_args(job, &assets.masks, &assets.overlays, &assets.gains, enc, out)`.
- In `run_export`, right after the `validate(&job.preset)` line:

```rust
    crate::audio_mix::validate_mix(&job).map_err(|e| ExportError::new("invalid_audio", "The audio mix can't be exported.", &e))?;
```

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test && cargo test real_export -- --ignored`
Expected: PASS. (The synthetic real export now has no audio tracks in `audio`, so its output has no audio — that test doesn't assert audio.)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src
git commit -m "feat(audio): mix enabled tracks into one AAC track via gain curves"
```

---

### Task 8: ExportPanel passes the mix; confirm when no audio

**Files:**
- Modify: `src/components/ExportPanel.tsx`, `src/components/ExportPanel.test.tsx`

**Interfaces:**
- Consumes: `buildExportJob({... mix, curves})` (Task 6).
- Produces: `ExportPanel` props gain `mix: AudioMix; curves: Map<number, Float32Array>`.

- [ ] **Step 1: Write failing tests** — in `ExportPanel.test.tsx`, add `mix={emptyMix} curves={new Map()}` to every existing `<ExportPanel ... />` render, define `const emptyMix = { tracks: [], duck: null };`, and append:

```tsx
const audioClip = { ...clip, info: { ...clip.info, audioTracks: [{ index: 0, label: 'Game', named: true, channels: 2 }] } };
const offMix = { tracks: [{ index: 0, sourceLabel: 'Game', label: 'Game', enabled: false, gain: 1, ceilingDb: null, offsetS: 0, fadeInS: 0, fadeOutS: 0, mutes: [] }], duck: null };

test('asks before exporting with every track removed, and stops on cancel', async () => {
  const backend = new FakeBackend();
  backend.startExport = vi.fn(async () => ({ outputPath: 'x', usedCpuFallback: false }));
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<ExportPanel backend={backend} clip={audioClip} preset={preset} trim={{ inS: 0, outS: 10 }} captions={[]} mix={offMix} curves={new Map()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  expect(confirm).toHaveBeenCalledWith('No audio will be exported. Continue?');
  expect(backend.startExport).not.toHaveBeenCalled();
  confirm.mockRestore();
});

test('sends the mix and curves with the job', async () => {
  const backend = new FakeBackend();
  let sent: ExportJob | null = null;
  backend.startExport = vi.fn(async (job) => {
    sent = job;
    return { outputPath: 'x', usedCpuFallback: false };
  });
  const onMix = { tracks: [{ ...offMix.tracks[0], enabled: true }], duck: null };
  render(<ExportPanel backend={backend} clip={audioClip} preset={preset} trim={{ inS: 0, outS: 1 }} captions={[]} mix={onMix} curves={new Map([[0, new Float32Array(2000).fill(1)]])} />);
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  await waitFor(() => expect(sent).not.toBeNull());
  expect(Object.keys(sent!.gainCurves)).toEqual(['0']);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/ExportPanel.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement.** In `ExportPanel.tsx`: import `type AudioMix`; `Props` gains `mix: AudioMix; curves: Map<number, Float32Array>`; destructure them. At the start of `run`, before `cancelRequested.current = false;`:

```ts
    const hasAudio = clip.info.audioTracks.length > 0;
    if (hasAudio && !mix.tracks.some((t) => t.enabled) && !window.confirm('No audio will be exported. Continue?')) return;
```

Pass `mix, curves` into `buildExportJob({ ..., mix, curves })`. Add `'invalid_audio'` needs no UI change (generic error path shows message + details).

Note: the not_writable retry calls `run(picked)` again and would re-confirm; acceptable (user just confirmed) — to avoid a double prompt, add a second parameter `confirmed = false` to `run`, skip the check when `true`, and call `run(picked, true)` in the retry.

- [ ] **Step 4: Run tests**

Run: `npx vitest run && npx tsc -b`
Expected: PASS except `App.tsx` type errors for missing `mix`/`curves` props → pass `mix={{ tracks: [], duck: null }} curves={new Map()}` in `App.tsx` for now (replaced in Task 11). Then tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat(audio): export panel sends the mix and confirms silent exports"
```

---

### Task 9: AudioPreview (Web Audio synced to the video)

**Files:**
- Create: `src/audio/AudioPreview.ts`, `src/audio/AudioPreview.test.ts`

**Interfaces:**
- Consumes: `PreparedTrack` (backend/types.ts), `AudioMix`, `SAMPLE_RATE`.
- Produces:
  - `export function audioTargetTime(videoT: number, offsetS: number): number` (= `videoT − offsetS`)
  - `export function needsResync(audioT: number, target: number): boolean` (> 0.05 s)
  - `export function curveFrom(curve: Float32Array, t: number): Float32Array` (subarray from `floor(t*200)`)
  - `export class AudioPreview { constructor(video: HTMLVideoElement, tracks: PreparedTrack[], makeContext?: () => AudioContext); setMix(mix: AudioMix, curves: Map<number, Float32Array>): void; dispose(): void }`

- [ ] **Step 1: Write failing tests** — `src/audio/AudioPreview.test.ts`:

```ts
import { expect, test } from 'vitest';
import { audioTargetTime, curveFrom, needsResync } from './AudioPreview';

test('offset moves the audio later', () => {
  expect(audioTargetTime(10, 0.25)).toBeCloseTo(9.75);
  expect(audioTargetTime(10, -0.5)).toBeCloseTo(10.5);
});

test('resyncs only beyond 50 ms drift', () => {
  expect(needsResync(10.04, 10)).toBe(false);
  expect(needsResync(10.06, 10)).toBe(true);
  expect(needsResync(9.9, 10)).toBe(true);
});

test('curveFrom starts at the playhead sample', () => {
  const c = Float32Array.from({ length: 1000 }, (_, i) => i);
  expect(curveFrom(c, 2)[0]).toBe(400);
  expect(curveFrom(c, 99).length).toBe(0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/audio/AudioPreview.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement** `src/audio/AudioPreview.ts`:

```ts
import type { PreparedTrack } from '../backend/types';
import type { AudioMix, TrackMix } from '../types';
import { SAMPLE_RATE } from './curve';

const MAX_DRIFT_S = 0.05;

export const audioTargetTime = (videoT: number, offsetS: number) => videoT - offsetS;
export const needsResync = (audioT: number, target: number) => Math.abs(audioT - target) > MAX_DRIFT_S;
export const curveFrom = (curve: Float32Array, t: number) => curve.subarray(Math.min(curve.length, Math.max(0, Math.floor(t * SAMPLE_RATE))));

interface Node { el: HTMLAudioElement; gain: GainNode; ceiling: DynamicsCompressorNode; mix: TrackMix | null; curve: Float32Array | null }

/** Plays each prepared track through gain curve → ceiling → master limiter, following the (muted) video. */
export class AudioPreview {
  private ctx: AudioContext;
  private nodes = new Map<number, Node>();
  private raf = 0;
  private readonly off: (() => void)[] = [];

  constructor(private video: HTMLVideoElement, tracks: PreparedTrack[], makeContext: () => AudioContext = () => new AudioContext()) {
    this.ctx = makeContext();
    const master = this.ctx.createDynamicsCompressor();
    master.threshold.value = -1;
    master.ratio.value = 20;
    master.knee.value = 0;
    master.attack.value = 0.001;
    master.release.value = 0.05;
    master.connect(this.ctx.destination);
    for (const t of tracks) {
      const el = new Audio();
      el.crossOrigin = 'anonymous';
      el.preload = 'auto';
      el.src = t.audioUrl;
      const gain = this.ctx.createGain();
      const ceiling = this.ctx.createDynamicsCompressor();
      ceiling.knee.value = 0;
      ceiling.attack.value = 0.001;
      ceiling.release.value = 0.05;
      this.ctx.createMediaElementSource(el).connect(gain);
      gain.connect(ceiling).connect(master);
      this.nodes.set(t.index, { el, gain, ceiling, mix: null, curve: null });
    }
    video.muted = true;
    const on = (ev: string, fn: () => void) => {
      video.addEventListener(ev, fn);
      this.off.push(() => video.removeEventListener(ev, fn));
    };
    on('play', () => void this.play());
    on('pause', () => this.pause());
    on('seeked', () => this.sync(true));
    on('ratechange', () => this.sync(true));
    const tick = () => {
      if (!video.paused) this.sync(false);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  setMix(mix: AudioMix, curves: Map<number, Float32Array>) {
    for (const [index, n] of this.nodes) {
      n.mix = mix.tracks.find((t) => t.index === index) ?? null;
      n.curve = curves.get(index) ?? null;
      const db = n.mix?.ceilingDb;
      n.ceiling.threshold.value = db ?? 0;
      n.ceiling.ratio.value = db === null || db === undefined ? 1 : 20;
    }
    this.sync(true);
  }

  private async play() {
    await this.ctx.resume();
    this.sync(true);
  }

  private pause() {
    for (const n of this.nodes.values()) n.el.pause();
    this.schedule();
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

  private sync(reschedule: boolean) {
    for (const n of this.nodes.values()) {
      if (!n.mix?.enabled) {
        n.el.pause();
        continue;
      }
      const target = audioTargetTime(this.video.currentTime, n.mix.offsetS);
      n.el.playbackRate = this.video.playbackRate;
      if (target < 0 || target >= (n.el.duration || Infinity)) {
        n.el.pause();
        continue;
      }
      if (reschedule || needsResync(n.el.currentTime, target)) n.el.currentTime = target;
      if (this.video.paused) n.el.pause();
      else if (n.el.paused) void n.el.play().catch(() => {});
    }
    if (reschedule) this.schedule();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.off.forEach((f) => f());
    for (const n of this.nodes.values()) {
      n.el.pause();
      n.el.removeAttribute('src');
    }
    void this.ctx.close();
    this.video.muted = false;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/audio && npx tsc -b`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/audio
git commit -m "feat(audio): Web Audio preview synced to the video"
```

- [ ] **Step 6: CORS probe (Review Focus 1) — after Task 11 wiring exists, run once on the Mac.**

Run: `npm run tauri dev`, open `example clips/Replay 2026-09-24 22-52-53.mp4`, press Space. In the webview devtools console run:

```js
const c = new AudioContext(); const a = new Audio(); a.crossOrigin = 'anonymous';
a.src = document.querySelector('video').src; const s = c.createMediaElementSource(a); const an = c.createAnalyser();
s.connect(an); a.play(); setTimeout(() => { const d = new Float32Array(an.fftSize); an.getFloatTimeDomainData(d); console.log('peak', Math.max(...d.map(Math.abs))); }, 1500);
```

Expected: `peak` > 0.001 → CORS fine, done. If `peak` is 0 (silence) or the console shows a CORS error: switch `AudioPreview` to buffers — add a Rust command `audio_track_bytes(path)` returning `tauri::ipc::Response` for `.m4a` files inside the audio cache (same guard as `audio_envelope`, extension `m4a`), add `audioBytes(index): Promise<ArrayBuffer>` to `PreparedTrack`, and in `AudioPreview` replace `<audio>` + `MediaElementSource` with `decodeAudioData` + an `AudioBufferSourceNode` restarted at `audioTargetTime` on play/seek (stop on pause). Commit as `fix(audio): decode preview tracks from IPC bytes (asset CORS)`.

---

### Task 10: AudioMixer and AudioLanes components

**Files:**
- Create: `src/audio/lanes.ts`, `src/audio/lanes.test.ts`, `src/components/AudioMixer.tsx`, `src/components/AudioMixer.test.tsx`, `src/components/AudioLanes.tsx`, `src/components/AudioLanes.test.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `AudioMix`, `TrackMix`, `Duck`, `MuteRange`, `AUDIO_LIMITS`, `ClipInfo`, `Trim`; `SAMPLE_RATE`; `mergeMutes`.
- Produces:
  - `lanes.ts`: `addMute(mutes, a, b, duration): MuteRange[]`, `resizeMute(mutes, i, edge: 'start' | 'end', t, duration): MuteRange[]`, `removeMute(mutes, i): MuteRange[]`, `updateTrack(mix, index, patch: Partial<TrackMix>): AudioMix`, `MIN_MUTE_S = 0.05`.
  - `<AudioMixer mix notice previewError hasAudio canDuck onChange(mix) onSaveToPreset() />`
  - `<AudioLanes video info trim mix envelopes: Map<number, Float32Array> onChange(mix) />`

- [ ] **Step 1: Write failing tests** — `src/audio/lanes.test.ts`:

```ts
import { expect, test } from 'vitest';
import { addMute, removeMute, resizeMute, updateTrack } from './lanes';

test('addMute orders the drag, merges and ignores tiny drags', () => {
  expect(addMute([{ startS: 1, endS: 2 }], 3, 1.5, 10)).toEqual([{ startS: 1, endS: 3 }]);
  expect(addMute([], 4, 4.01, 10)).toEqual([]);
});

test('resizeMute moves one edge and keeps a minimum length', () => {
  expect(resizeMute([{ startS: 1, endS: 3 }], 0, 'end', 5, 10)).toEqual([{ startS: 1, endS: 5 }]);
  expect(resizeMute([{ startS: 1, endS: 3 }], 0, 'start', 2.99, 10)).toEqual([{ startS: 2.95, endS: 3 }]);
});

test('removeMute and updateTrack', () => {
  expect(removeMute([{ startS: 1, endS: 2 }, { startS: 3, endS: 4 }], 0)).toEqual([{ startS: 3, endS: 4 }]);
  const mix = { tracks: [{ index: 0, sourceLabel: 'G', label: 'G', enabled: true, gain: 1, ceilingDb: null, offsetS: 0, fadeInS: 0, fadeOutS: 0, mutes: [] }], duck: null };
  expect(updateTrack(mix, 0, { gain: 0.5 }).tracks[0].gain).toBe(0.5);
  expect(mix.tracks[0].gain).toBe(1);
});
```

`src/components/AudioMixer.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import type { AudioMix } from '../types';
import { AudioMixer } from './AudioMixer';

const mix: AudioMix = {
  tracks: ['Game', 'Discord'].map((l, index) => ({ index, sourceLabel: l, label: l, enabled: true, gain: 1, ceilingDb: null, offsetS: 0, fadeInS: 0, fadeOutS: 0, mutes: [] })),
  duck: null,
};
const props = { mix, notice: null, previewError: null, hasAudio: true, canDuck: true, onSaveToPreset: () => {} };

test('gain, remove/restore, ceiling and rename update the mix', () => {
  const onChange = vi.fn();
  render(<AudioMixer {...props} onChange={onChange} />);
  fireEvent.change(screen.getByLabelText('Game gain %'), { target: { value: '150' } });
  expect(onChange.mock.calls.at(-1)![0].tracks[0].gain).toBeCloseTo(1.5);
  fireEvent.click(screen.getByRole('button', { name: 'Remove Discord' }));
  expect(onChange.mock.calls.at(-1)![0].tracks[1].enabled).toBe(false);
  fireEvent.click(screen.getByLabelText('Game ceiling on'));
  expect(onChange.mock.calls.at(-1)![0].tracks[0].ceilingDb).toBe(-3);
  fireEvent.change(screen.getByLabelText('Game name'), { target: { value: 'Game audio' } });
  expect(onChange.mock.calls.at(-1)![0].tracks[0]).toMatchObject({ label: 'Game audio', sourceLabel: 'Game' });
});

test('removed track shows Restore', () => {
  const onChange = vi.fn();
  const off = { ...mix, tracks: [{ ...mix.tracks[0], enabled: false }, mix.tracks[1]] };
  render(<AudioMixer {...props} mix={off} onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'Restore Game' }));
  expect(onChange.mock.calls[0][0].tracks[0].enabled).toBe(true);
});

test('enabling duck picks sensible defaults', () => {
  const onChange = vi.fn();
  render(<AudioMixer {...props} onChange={onChange} />);
  fireEvent.click(screen.getByLabelText('Duck'));
  expect(onChange.mock.calls[0][0].duck).toEqual({ targets: [0], triggers: [1], amountDb: -10, thresholdDb: -40, releaseS: 0.4 });
});

test('no audio and notices', () => {
  render(<AudioMixer {...props} hasAudio={false} onChange={() => {}} />);
  expect(screen.getByText('No audio in this clip.')).toBeTruthy();
});

test('save mix to preset', () => {
  const onSave = vi.fn();
  render(<AudioMixer {...props} onChange={() => {}} onSaveToPreset={onSave} notice="Couldn't apply the preset's audio mix — using all tracks." />);
  expect(screen.getByRole('status').textContent).toContain("Couldn't apply");
  fireEvent.click(screen.getByRole('button', { name: 'Save mix to preset' }));
  expect(onSave).toHaveBeenCalled();
});
```

`src/components/AudioLanes.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import type { AudioMix } from '../types';
import { AudioLanes } from './AudioLanes';

const info = { width: 1920, height: 1080, fps: '60', codec: 'h264', duration: 10, hasAudio: true, audioTracks: [{ index: 0, label: 'Game', named: true, channels: 2 }] };
const mix: AudioMix = { tracks: [{ index: 0, sourceLabel: 'Game', label: 'Game', enabled: true, gain: 1, ceilingDb: null, offsetS: 0, fadeInS: 0, fadeOutS: 0, mutes: [{ startS: 6, endS: 7 }] }], duck: null };

function lane() {
  const el = screen.getByLabelText('Game lane');
  el.getBoundingClientRect = () => ({ left: 0, width: 1000, top: 0, height: 40, right: 1000, bottom: 40, x: 0, y: 0, toJSON: () => ({}) });
  el.setPointerCapture = () => {};
  return el;
}

test('drag on an empty lane creates a mute range', () => {
  const onChange = vi.fn();
  render(<AudioLanes video={null} info={info} trim={{ inS: 0, outS: 10 }} mix={mix} envelopes={new Map()} onChange={onChange} />);
  const el = lane();
  fireEvent.pointerDown(el, { clientX: 200, pointerId: 1 });
  fireEvent.pointerMove(el, { clientX: 400, pointerId: 1 });
  fireEvent.pointerUp(el, { clientX: 400, pointerId: 1 });
  expect(onChange.mock.calls.at(-1)![0].tracks[0].mutes).toEqual([{ startS: 2, endS: 4 }, { startS: 6, endS: 7 }]);
});

test('× removes a mute range', () => {
  const onChange = vi.fn();
  render(<AudioLanes video={null} info={info} trim={{ inS: 0, outS: 10 }} mix={mix} envelopes={new Map()} onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'Remove mute 6.0–7.0 s' }));
  expect(onChange.mock.calls[0][0].tracks[0].mutes).toEqual([]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/audio/lanes.test.ts src/components/AudioMixer.test.tsx src/components/AudioLanes.test.tsx`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement** `src/audio/lanes.ts`:

```ts
import type { AudioMix, MuteRange, TrackMix } from '../types';
import { mergeMutes } from './curve';

export const MIN_MUTE_S = 0.05;

export function addMute(mutes: MuteRange[], a: number, b: number, duration: number): MuteRange[] {
  const startS = Math.min(a, b);
  const endS = Math.max(a, b);
  if (endS - startS < MIN_MUTE_S) return mutes;
  return mergeMutes([...mutes, { startS, endS }], duration);
}

export function resizeMute(mutes: MuteRange[], i: number, edge: 'start' | 'end', t: number, duration: number): MuteRange[] {
  const next = mutes.map((m) => ({ ...m }));
  const m = next[i];
  if (edge === 'start') m.startS = Math.min(t, m.endS - MIN_MUTE_S);
  else m.endS = Math.max(t, m.startS + MIN_MUTE_S);
  return mergeMutes(next, duration);
}

export const removeMute = (mutes: MuteRange[], i: number) => mutes.filter((_, j) => j !== i);

export const updateTrack = (mix: AudioMix, index: number, patch: Partial<TrackMix>): AudioMix => ({
  ...mix,
  tracks: mix.tracks.map((t) => (t.index === index ? { ...t, ...patch } : t)),
});
```

`src/components/AudioMixer.tsx`:

```tsx
import { updateTrack } from '../audio/lanes';
import { AUDIO_LIMITS, type AudioMix, type Duck, type TrackMix } from '../types';

interface Props {
  mix: AudioMix;
  notice: string | null;
  previewError: string | null;
  hasAudio: boolean;
  /** Ducking needs envelopes from prepareAudio. */
  canDuck: boolean;
  onChange(mix: AudioMix): void;
  onSaveToPreset(): void;
}

const num = (v: string, fallback: number) => (Number.isFinite(Number.parseFloat(v)) ? Number.parseFloat(v) : fallback);
const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));

function defaultDuck(tracks: TrackMix[]): Duck {
  const voice = tracks.filter((t) => /discord|mic|voice|chat/i.test(t.sourceLabel)).map((t) => t.index);
  const triggers = voice.length ? voice : tracks.slice(1).map((t) => t.index);
  const targets = tracks.filter((t) => !triggers.includes(t.index)).map((t) => t.index);
  return { targets, triggers, amountDb: -10, thresholdDb: -40, releaseS: 0.4 };
}

export function AudioMixer({ mix, notice, previewError, hasAudio, canDuck, onChange, onSaveToPreset }: Props) {
  if (!hasAudio) {
    return (
      <section className="panel">
        <h2>Audio</h2>
        <p className="hint">No audio in this clip.</p>
      </section>
    );
  }
  const set = (t: TrackMix, patch: Partial<TrackMix>) => onChange(updateTrack(mix, t.index, patch));
  const setDuck = (patch: Partial<Duck>) => mix.duck && onChange({ ...mix, duck: { ...mix.duck, ...patch } });
  const toggleIn = (list: number[], i: number) => (list.includes(i) ? list.filter((x) => x !== i) : [...list, i]);

  return (
    <section className="panel audio-mixer">
      <h2>Audio</h2>
      {notice && <p className="hint" role="status">{notice}</p>}
      {previewError && <p className="hint">{previewError}</p>}
      {mix.tracks.map((t) => (
        <div key={t.index} className={`track-row${t.enabled ? '' : ' removed'}`}>
          <div className="track-head">
            <input aria-label={`${t.sourceLabel} name`} value={t.label} maxLength={64} onChange={(e) => set(t, { label: e.target.value })} />
            {t.enabled ? (
              <button aria-label={`Remove ${t.label}`} onClick={() => set(t, { enabled: false })}>✕</button>
            ) : (
              <button aria-label={`Restore ${t.label}`} onClick={() => set(t, { enabled: true })}>Restore</button>
            )}
          </div>
          <fieldset disabled={!t.enabled}>
            <label>
              Gain
              <input type="range" min={0} max={200} step={1} value={Math.round(t.gain * 100)} onChange={(e) => set(t, { gain: clamp(num(e.target.value, 100) / 100, AUDIO_LIMITS.gain) })} />
              <input type="number" aria-label={`${t.label} gain %`} min={0} max={200} value={Math.round(t.gain * 100)} onChange={(e) => set(t, { gain: clamp(num(e.target.value, 100) / 100, AUDIO_LIMITS.gain) })} />
            </label>
            <label>
              <input type="checkbox" aria-label={`${t.label} ceiling on`} checked={t.ceilingDb !== null} onChange={(e) => set(t, { ceilingDb: e.target.checked ? -3 : null })} />
              Ceiling
              <input type="range" min={-24} max={0} step={0.5} disabled={t.ceilingDb === null} value={t.ceilingDb ?? 0} onChange={(e) => set(t, { ceilingDb: clamp(num(e.target.value, -3), AUDIO_LIMITS.ceilingDb) })} />
              <span>{t.ceilingDb === null ? 'off' : `${t.ceilingDb} dB`}</span>
            </label>
            <label>
              Offset (s)
              <input type="number" aria-label={`${t.label} offset`} min={-2} max={2} step={0.01} value={t.offsetS} onChange={(e) => set(t, { offsetS: clamp(num(e.target.value, 0), AUDIO_LIMITS.offsetS) })} />
            </label>
            <label>
              Fade in (s)
              <input type="number" aria-label={`${t.label} fade in`} min={0} step={0.1} value={t.fadeInS} onChange={(e) => set(t, { fadeInS: Math.max(0, num(e.target.value, 0)) })} />
            </label>
            <label>
              Fade out (s)
              <input type="number" aria-label={`${t.label} fade out`} min={0} step={0.1} value={t.fadeOutS} onChange={(e) => set(t, { fadeOutS: Math.max(0, num(e.target.value, 0)) })} />
            </label>
          </fieldset>
        </div>
      ))}
      <fieldset className="duck" disabled={!canDuck || mix.tracks.length < 2}>
        <label>
          <input type="checkbox" aria-label="Duck" checked={mix.duck !== null} onChange={(e) => onChange({ ...mix, duck: e.target.checked ? defaultDuck(mix.tracks) : null })} />
          Duck (lower some tracks while others talk)
        </label>
        {!canDuck && <p className="hint">Ducking needs the audio preview.</p>}
        {mix.duck && (
          <>
            {mix.tracks.map((t) => (
              <div key={t.index} className="duck-row">
                <span>{t.label}</span>
                <label><input type="checkbox" checked={mix.duck!.targets.includes(t.index)} onChange={() => setDuck({ targets: toggleIn(mix.duck!.targets, t.index) })} /> lowered</label>
                <label><input type="checkbox" checked={mix.duck!.triggers.includes(t.index)} onChange={() => setDuck({ triggers: toggleIn(mix.duck!.triggers, t.index) })} /> triggers</label>
              </div>
            ))}
            <label>
              Amount
              <input type="range" min={-24} max={0} step={1} value={mix.duck.amountDb} onChange={(e) => setDuck({ amountDb: clamp(num(e.target.value, -10), AUDIO_LIMITS.amountDb) })} />
              <span>{mix.duck.amountDb} dB</span>
            </label>
            <details>
              <summary>Advanced</summary>
              <label>
                Threshold (dB)
                <input type="number" min={-60} max={0} value={mix.duck.thresholdDb} onChange={(e) => setDuck({ thresholdDb: clamp(num(e.target.value, -40), AUDIO_LIMITS.thresholdDb) })} />
              </label>
              <label>
                Release (s)
                <input type="number" min={0.05} max={2} step={0.05} value={mix.duck.releaseS} onChange={(e) => setDuck({ releaseS: clamp(num(e.target.value, 0.4), AUDIO_LIMITS.releaseS) })} />
              </label>
            </details>
          </>
        )}
      </fieldset>
      <button onClick={onSaveToPreset}>Save mix to preset</button>
    </section>
  );
}
```

`src/components/AudioLanes.tsx`:

```tsx
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { SAMPLE_RATE } from '../audio/curve';
import { addMute, removeMute, resizeMute, updateTrack } from '../audio/lanes';
import type { AudioMix, ClipInfo, TrackMix, Trim } from '../types';

interface Props { video: HTMLVideoElement | null; info: ClipInfo; trim: Trim; mix: AudioMix; envelopes: Map<number, Float32Array>; onChange(mix: AudioMix): void }

type Drag =
  | { kind: 'new'; from: number; to: number }
  | { kind: 'edge'; i: number; edge: 'start' | 'end' }
  | { kind: 'fade'; which: 'in' | 'out' }
  | { kind: 'offset'; x0: number; offset0: number };

function Waveform({ env, duration }: { env: Float32Array | undefined; duration: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx || !env || !duration) return;
    const w = (c.width = c.clientWidth || 600);
    const h = (c.height = c.clientHeight || 40);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'currentColor';
    const per = Math.max(1, Math.floor(env.length / w));
    for (let x = 0; x < w; x++) {
      let peak = 0;
      for (let i = x * per; i < (x + 1) * per && i < env.length; i++) peak = Math.max(peak, env[i]);
      const bar = Math.min(1, peak * 3) * h;
      ctx.fillRect(x, (h - bar) / 2, 1, bar);
    }
  }, [env, duration]);
  return <canvas ref={ref} className="lane-wave" />;
}

function Lane({ track, props }: { track: TrackMix; props: Props }) {
  const { info, trim, mix, envelopes, onChange } = props;
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [preview, setPreview] = useState<{ from: number; to: number } | null>(null);
  const d = info.duration;
  const pct = (s: number) => `${(d > 0 ? s / d : 0) * 100}%`;
  const timeAt = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / (r.width || 1))) * d;
  };
  const set = (patch: Partial<TrackMix>) => onChange(updateTrack(mix, track.index, patch));

  const begin = (mode: Drag) => (e: PointerEvent<HTMLElement>) => {
    e.stopPropagation();
    drag.current = mode;
    ref.current!.setPointerCapture(e.pointerId);
  };
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!track.enabled) return;
    const t = timeAt(e.clientX);
    drag.current = e.altKey ? { kind: 'offset', x0: t, offset0: track.offsetS } : { kind: 'new', from: t, to: t };
    ref.current!.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const g = drag.current;
    if (!g) return;
    const t = timeAt(e.clientX);
    if (g.kind === 'new') {
      g.to = t;
      setPreview({ from: Math.min(g.from, t), to: Math.max(g.from, t) });
    } else if (g.kind === 'edge') set({ mutes: resizeMute(track.mutes, g.i, g.edge, t, d) });
    else if (g.kind === 'fade') set(g.which === 'in' ? { fadeInS: Math.max(0, t - trim.inS) } : { fadeOutS: Math.max(0, trim.outS - t) });
    else set({ offsetS: Math.min(2, Math.max(-2, Math.round((g.offset0 + t - g.x0) * 100) / 100)) });
  };
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    const g = drag.current;
    drag.current = null;
    setPreview(null);
    if (g?.kind === 'new') set({ mutes: addMute(track.mutes, g.from, timeAt(e.clientX), d) });
  };

  return (
    <div className={`lane${track.enabled ? '' : ' removed'}`}>
      <span className="lane-label">{track.label}</span>
      <div ref={ref} aria-label={`${track.label} lane`} className="lane-body" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
        <Waveform env={envelopes.get(track.index)} duration={d} />
        <div className="lane-trim" style={{ left: pct(trim.inS), width: pct(trim.outS - trim.inS) }} />
        {track.mutes.map((m, i) => (
          <div key={`${m.startS}-${m.endS}`} className="lane-mute" style={{ left: pct(m.startS), width: pct(m.endS - m.startS) }}>
            <span className="mute-edge start" onPointerDown={begin({ kind: 'edge', i, edge: 'start' })} />
            <button aria-label={`Remove mute ${m.startS.toFixed(1)}–${m.endS.toFixed(1)} s`} onPointerDown={(e) => e.stopPropagation()} onClick={() => set({ mutes: removeMute(track.mutes, i) })}>×</button>
            <span className="mute-edge end" onPointerDown={begin({ kind: 'edge', i, edge: 'end' })} />
          </div>
        ))}
        {preview && <div className="lane-mute pending" style={{ left: pct(preview.from), width: pct(preview.to - preview.from) }} />}
        <span className="fade-handle in" aria-label={`${track.label} fade in handle`} style={{ left: pct(trim.inS + track.fadeInS) }} onPointerDown={begin({ kind: 'fade', which: 'in' })} />
        <span className="fade-handle out" aria-label={`${track.label} fade out handle`} style={{ left: pct(trim.outS - track.fadeOutS) }} onPointerDown={begin({ kind: 'fade', which: 'out' })} />
      </div>
    </div>
  );
}

export function AudioLanes(props: Props) {
  const [now, setNow] = useState(0);
  const { video, info } = props;
  useEffect(() => {
    if (!video) return;
    let raf = 0;
    const tick = () => {
      setNow(video.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [video]);
  if (props.mix.tracks.length === 0) return null;
  return (
    <div className="lanes" style={{ ['--playhead' as string]: `${(info.duration ? now / info.duration : 0) * 100}%` }}>
      {props.mix.tracks.map((t) => (
        <Lane key={t.index} track={t} props={props} />
      ))}
      <div className="hint">Drag to mute · drag ▲ to fade · Alt+drag to shift sync · {SAMPLE_RATE} Hz curves</div>
    </div>
  );
}
```

Append to `src/styles.css` (match existing variable names in that file; if it defines colour tokens, use them instead of the literals):

```css
.audio-mixer .track-row { border-top: 1px solid rgba(255,255,255,.1); padding: 6px 0; }
.audio-mixer .track-row.removed { opacity: .45; }
.audio-mixer .track-head { display: flex; gap: 6px; }
.audio-mixer .track-head input { flex: 1; }
.audio-mixer label { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.audio-mixer input[type=number] { width: 64px; }
.lanes { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; position: relative; }
.lane { display: grid; grid-template-columns: 90px 1fr; align-items: center; gap: 6px; }
.lane.removed { opacity: .35; }
.lane-label { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lane-body { position: relative; height: 40px; background: rgba(255,255,255,.05); border-radius: 4px; touch-action: none; }
.lane-body::after { content: ''; position: absolute; top: 0; bottom: 0; left: var(--playhead); width: 1px; background: #fff; pointer-events: none; }
.lane-wave { position: absolute; inset: 0; width: 100%; height: 100%; color: rgba(120,200,255,.7); }
.lane-trim { position: absolute; top: 0; bottom: 0; background: rgba(255,255,255,.06); pointer-events: none; }
.lane-mute { position: absolute; top: 0; bottom: 0; background: repeating-linear-gradient(45deg, rgba(0,0,0,.55) 0 4px, rgba(0,0,0,.25) 4px 8px); }
.lane-mute.pending { opacity: .6; pointer-events: none; }
.lane-mute button { position: absolute; top: 2px; right: 2px; font-size: 10px; padding: 0 4px; }
.mute-edge { position: absolute; top: 0; bottom: 0; width: 6px; cursor: ew-resize; }
.mute-edge.start { left: -3px; } .mute-edge.end { right: -3px; }
.fade-handle { position: absolute; top: 0; width: 0; height: 0; border-left: 6px solid transparent; border-right: 6px solid transparent; border-top: 10px solid #fc0; transform: translateX(-6px); cursor: ew-resize; }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run && npx tsc -b && npm run lint`
Expected: tests PASS, tsc clean, lint: no new errors.

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat(audio): mixer panel and per-track timeline lanes"
```

---

### Task 11: Wire it into the App

**Files:**
- Modify: `src/App.tsx`, `src/App.test.tsx`

**Interfaces:**
- Consumes: `resolveMix`, `mixToPresetAudio`, `emptyMix` (Task 4); `duckCurve` (Task 4); `mixCurves`, `curveLength` (Task 3); `AudioPreview` (Task 9); `AudioMixer`, `AudioLanes` (Task 10); `Backend.prepareAudio` (Task 5); `ExportPanel` `mix`/`curves` (Task 8); `duplicatePreset` (presets.ts).
- Produces: final UI.

- [ ] **Step 1: Write failing tests** — append to `src/App.test.tsx` (it already builds a fake backend `b` with a stubbed `probe`; follow its helper pattern). Change that stub to return `audioTracks: ['Desktop Audio', 'Game', 'Discord'].map((label, index) => ({ index, label, named: true, channels: 2 }))` and `hasAudio: true`. Then add:

```tsx
test('opening a clip resolves the smart default mix', async () => {
  const b = makeBackend(); // use the file's existing backend factory / setup
  render(<App backend={b} />);
  await openClipIn(b); // use the file's existing way of opening a clip
  expect(await screen.findByRole('button', { name: 'Restore Desktop Audio' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Remove Game' })).toBeTruthy();
});

test('ignores prepareAudio results for a clip that is no longer open', async () => {
  const b = makeBackend();
  let resolveFirst!: (v: PreparedTrack[]) => void;
  b.prepareAudio = vi.fn().mockImplementationOnce(() => new Promise((r) => (resolveFirst = r))).mockRejectedValue(new Error('x'));
  render(<App backend={b} />);
  await openClipIn(b, 'C:/v/a.mp4');
  await openClipIn(b, 'C:/v/b.mp4');
  resolveFirst([{ index: 0, audioUrl: 'blob:a', envelope: new Float32Array(10) }]);
  expect(await screen.findByText('Audio preview unavailable — export still uses your mix.')).toBeTruthy();
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
```

`makeBackend` / `openClipIn` = whatever helper `App.test.tsx` already uses to create a FakeBackend with stubbed `probe`/`videoUrl`/`pickClip` and to open a clip (read the file first; if it inlines the steps, extract them into these two helpers in this step). Import `PreparedTrack` from `./backend/types` and `vi`, `waitFor`, `fireEvent` as needed.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/App.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement in `src/App.tsx`.**

Imports:

```tsx
import { AudioPreview } from './audio/AudioPreview';
import { curveLength, mixCurves } from './audio/curve';
import { duckCurve } from './audio/duck';
import { emptyMix, mixToPresetAudio, resolveMix } from './audio/resolveMix';
import type { PreparedTrack } from './backend/types';
import { AudioLanes } from './components/AudioLanes';
import { AudioMixer } from './components/AudioMixer';
import type { AudioMix } from './types';
```

(add `AudioMix` to the existing `./types` import instead of a second import line; add `duplicatePreset` is already imported).

State (next to the others):

```tsx
  const [audioMix, setAudioMix] = useState<AudioMix>(emptyMix());
  const [audioNotice, setAudioNotice] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<PreparedTrack[] | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const clipPath = useRef<string | null>(null);
```

(add `useRef` to the React import). In `loadClip`, after `setSelectedCaptionId(null);`:

```tsx
        clipPath.current = path;
        const r = resolveMix(info.audioTracks, preset);
        setAudioMix(r.mix);
        setAudioNotice(r.notice);
        setPrepared(null);
        setAudioError(null);
        if (info.audioTracks.length) {
          backend.prepareAudio(path).then(
            (t) => clipPath.current === path && setPrepared(t),
            () => clipPath.current === path && setAudioError('Audio preview unavailable — export still uses your mix.'),
          );
        }
```

Add `preset` to `loadClip`'s dependency list.

Re-resolve on preset change (keeps per-clip edits):

```tsx
  const clipTracks = clip?.info.audioTracks;
  useEffect(() => {
    if (!clipTracks) return;
    setAudioMix((m) => {
      const r = resolveMix(clipTracks, preset, m);
      setAudioNotice(r.notice);
      return r.mix;
    });
  }, [preset, clipTracks]);
```

Curves (duck needs envelopes):

```tsx
  const envelopes = useMemo(() => new Map((prepared ?? []).map((t) => [t.index, t.envelope])), [prepared]);
  const curves = useMemo(() => {
    if (!clip) return new Map<number, Float32Array>();
    const n = curveLength(clip.info.duration);
    const triggers = (audioMix.duck?.triggers ?? []).map((i) => envelopes.get(i)).filter((e): e is Float32Array => !!e);
    const duck = audioMix.duck && triggers.length ? duckCurve(triggers, audioMix.duck, n) : null;
    return mixCurves(audioMix, trim, clip.info.duration, duck);
  }, [clip, audioMix, trim, envelopes]);
```

Preview lifecycle:

```tsx
  const [audioPreview, setAudioPreview] = useState<AudioPreview | null>(null);
  useEffect(() => {
    if (!video || !prepared?.length) return;
    let p: AudioPreview;
    try {
      p = new AudioPreview(video, prepared);
    } catch {
      setAudioError('Audio preview unavailable — export still uses your mix.');
      return;
    }
    setAudioPreview(p);
    return () => {
      p.dispose();
      setAudioPreview(null);
    };
  }, [video, prepared]);
  useEffect(() => audioPreview?.setMix(audioMix, curves), [audioPreview, audioMix, curves]);
```

Save mix:

```tsx
  async function saveMixToPreset() {
    const audio = mixToPresetAudio(audioMix);
    const target = preset.builtin ? { ...duplicatePreset(preset, crypto.randomUUID()), audio } : { ...preset, audio };
    await backend.savePreset(target);
    await refreshPresets();
    setPresetId(target.id);
  }
```

JSX: under `<TrimBar ... />` add

```tsx
                <AudioLanes video={video} info={clip.info} trim={trim} mix={audioMix} envelopes={envelopes} onChange={setAudioMix} />
```

In the `<aside>` between `CaptionTool` and `ExportPanel`:

```tsx
          <AudioMixer
            mix={audioMix}
            notice={audioNotice}
            previewError={audioError}
            hasAudio={clip.info.audioTracks.length > 0}
            canDuck={prepared !== null}
            onChange={setAudioMix}
            onSaveToPreset={() => void saveMixToPreset()}
          />
```

and change `ExportPanel` to `mix={audioMix} curves={curves}`.

- [ ] **Step 4: Run tests + lint**

Run: `npx vitest run && npx tsc -b && npm run lint`
Expected: PASS; lint no new errors (the effect that calls `setAudioNotice` inside `setAudioMix`'s updater may warn under `react(set-state-in-effect)` like the existing `App.tsx:43` warning — acceptable, same pattern already present).

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat(audio): wire mixer, lanes, preview and preset save into the app"
```

---

### Task 12: Real-clip validation, docs, tracker

**Files:**
- Modify: `src-tauri/src/export.rs` (ignored tests), `project.md`, `docs/superpowers/specs/2026-09-25-multitrack-audio-design.md` (status line)

**Interfaces:**
- Consumes: everything above; `probe_clip_file`; `tool_command`.

- [ ] **Step 1: Extend the real-clip test.** In `real_clips_export_with_wardogs` build the job with all tracks enabled except `Desktop Audio` and all-ones curves, then assert one audio stream. Replace the `let job = ExportJob { ... };` block with:

```rust
            let n = crate::audio_mix::curve_samples(&crate::job::Trim { in_s: 30.0, out_s: 45.0 });
            let ones = base64::engine::general_purpose::STANDARD.encode(vec![1.0f32; n].iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>());
            let tracks: Vec<crate::audio_mix::TrackMix> = clip
                .audio_tracks
                .iter()
                .map(|a| crate::audio_mix::TrackMix { index: a.index, enabled: !a.label.to_lowercase().contains("desktop"), ceiling_db: Some(-3.0), offset_s: 0.0 })
                .collect();
            let gain_curves = tracks.iter().filter(|t| t.enabled).map(|t| (t.index, ones.clone())).collect();
            let job = ExportJob {
                source: source.clone(),
                clip,
                preset: preset.clone(),
                trim: crate::job::Trim { in_s: 30.0, out_s: 45.0 },
                quality: crate::job::Quality::High,
                layer_masks: Default::default(),
                overlays: vec![],
                output_dir: Some(out_dir.clone()),
                audio: crate::audio_mix::AudioMix { tracks },
                gain_curves,
            };
```

and after the existing asserts add `assert_eq!(info.audio_tracks.len(), 1, "exactly one mixed audio track");`. Add a mute test below it:

```rust
    /// Mutes 5–8 s of the trimmed output on the first clip's "Game" track. Same env vars as above.
    #[test]
    #[ignore]
    fn real_clip_mute_range_is_silent() {
        let clips = std::env::var("SOCIALFRAG_CLIPS_DIR").expect("set SOCIALFRAG_CLIPS_DIR");
        let out_dir = std::env::var("SOCIALFRAG_OUT_DIR").expect("set SOCIALFRAG_OUT_DIR");
        let mut files: Vec<_> = std::fs::read_dir(&clips).unwrap().filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|x| x == "mp4")).collect();
        files.sort();
        let source = files[0].to_string_lossy().into_owned();
        let clip = crate::probe::probe_clip_file(&source).unwrap();
        let game = clip.audio_tracks.iter().find(|a| a.label == "Game").expect("clip has a Game track").index;
        let trim = crate::job::Trim { in_s: 30.0, out_s: 45.0 };
        let curve: Vec<f32> = (0..crate::audio_mix::curve_samples(&trim)).map(|i| if (1000..1600).contains(&i) { 0.0 } else { 1.0 }).collect();
        let b64 = base64::engine::general_purpose::STANDARD.encode(curve.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>());
        let mut j = crate::job::fixtures::job();
        j.source = source;
        j.clip = clip;
        j.preset = serde_json::from_str(include_str!("../../src/presets/builtin/wardogs.json")).unwrap();
        j.trim = trim;
        j.output_dir = Some(out_dir);
        j.audio = crate::audio_mix::AudioMix { tracks: vec![crate::audio_mix::TrackMix { index: game, enabled: true, ceiling_db: None, offset_s: 0.0 }] };
        j.gain_curves.insert(game, b64);
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
```

- [ ] **Step 2: Run the real-clip tests**

Run:
```bash
cd src-tauri && SOCIALFRAG_CLIPS_DIR="../example clips" SOCIALFRAG_OUT_DIR="$TMPDIR/sf-out" sh -c 'mkdir -p "$SOCIALFRAG_OUT_DIR" && cargo test real_clip -- --ignored --nocapture'
```
Expected: `real_clips_export_with_wardogs ... ok` (6 lines of `1080x1920 60/1 15.00s`) and `real_clip_mute_range_is_silent ... ok`. Then `ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "$TMPDIR/sf-out/"*_vertical*.mp4 | sort | uniq -c` shows only index `1` (one audio stream per file).

- [ ] **Step 3: Manual preview check on the Mac** — `npm run tauri dev`, open `example clips/Replay 2026-09-24 22-52-53.mp4`:
  1. Mixer shows Desktop Audio removed; Game, Discord, Mic on.
  2. Waveforms appear in lanes; Mic lane is flat.
  3. Drag a mute on Game during a gunfight → silent there on playback.
  4. Alt+drag Discord → offset field changes, voice audibly shifts.
  5. Duck: tick Duck → Game dips while Discord talks.
  6. Export → output plays with one track; mute range silent.
  Record results in `project.md`. If step 2 or 3 is silent, run Task 9 Step 6.

- [ ] **Step 4: Full suite + docs**

Run: `npx vitest run && npx tsc -b && npm run lint && (cd src-tauri && cargo test)`
Expected: all pass.

Set the spec's `Status:` line to `Implemented on feat/multitrack-audio (2026-MM-DD)`. Update `project.md`: move "Multi-track audio: plan + implement" to Done with the date; add "Windows smoke test: audio preview sync (Task 17)" under Next.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/export.rs project.md docs/superpowers
git commit -m "test(audio): real-clip single-track + mute checks; docs"
```
