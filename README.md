# SocialFrag

**Turn raw gameplay recordings into vertical highlights for TikTok, Shorts and Reels — or regular 16:9 videos — with offline auto-captions.**

SocialFrag is a free desktop clip editor for gamers. Drop in an OBS recording, pick a layout preset for your game, cut the good part, caption it and export. Everything runs on your own computer: no account, no upload, no watermark.

> Status: **v0.1.0, early release.** Windows 10/11 (x64) installer available; macOS (Apple Silicon) builds from source. Expect rough edges — please [open an issue](https://github.com/DadMadeAnApp/SocialFrag/issues) when you hit one.

## Download (Windows)

1. Go to [Releases](https://github.com/DadMadeAnApp/SocialFrag/releases) and download `SocialFrag_<version>_x64-setup.exe`.
2. Run it. It installs for your user account only (no admin rights needed).
3. The installer is **not code-signed yet**, so Windows SmartScreen may say "Windows protected your PC". Click **More info → Run anyway**. The installer is built by [GitHub Actions](.github/workflows/windows-release.yml) straight from this repository's source.

## Features

- **Two formats**
  - **9:16 vertical** (1080×1920, default): game-specific layout presets move HUD pieces — killfeed, minimap, cash, ammo & health — around the gameplay, over a blurred background. Toggle, drag and resize HUD pieces per clip.
  - **16:9 landscape**: the original frame as recorded, exported at 1080p or 1440p.
- **Timeline editing**: multiple clips on one timeline, cut (`C`), ripple delete, trim, reorder by dragging, speed changes (0.25×–4×), freeze frames (`F`), undo/redo.
- **Multi-track audio**: OBS clips with several audio tracks (e.g. Desktop Audio, Game, Discord, Mic) are mixed in the app — per-track gain, peak ceiling, mutes over ranges, fades, sync offset and auto-ducking — and exported as one mixed track. Live preview while you edit.
- **Captions**: add text captions in four styles (TikTok, Impact, Boxed, Plain), drag and resize them on the preview.
- **Offline auto-captions (Whisper)**: caption one or more audio tracks with [whisper.cpp](https://github.com/ggml-org/whisper.cpp), locally. English models download on first use (small.en by default). Each track gets its own colour so viewers can tell speakers apart. Edit everything afterwards: fix text, drag timing on the caption lane, split, merge, delete, restyle a line or a whole track. Re-running keeps your edits.
  - Accuracy is best on a **separate voice track** (Discord, mic). Speech mixed into game audio with gunfire and engines is often missed or misheard — the app warns you.
- **Presets**: WARDOGS preset included; make your own in the preset editor, import/export them as `.json`.
- **Fast export**: GPU encoding (NVIDIA NVENC, AMD AMF, Intel Quick Sync on Windows; VideoToolbox on macOS) with automatic CPU fallback. HEVC, high-frame-rate (120/144 fps) and very long recordings are supported.

## Using it

1. **Open clip** (or drag a video file onto the window).
2. Pick a **preset** in the left rail (9:16), or switch the header to **16:9 Landscape**.
3. Trim and cut on the timeline; adjust the audio mix in the side panel.
4. Add captions by hand, or click **Auto-caption**, tick the voice track(s) and **Start**.
5. **Export** and pick where to save the MP4.

Keyboard: `Space` play · `C` cut · `Delete` remove · `F` freeze · `I`/`O` trim to playhead · `←`/`→` frame step · `Ctrl+Z` undo · `Ctrl+Shift+Z` / `Ctrl+Y` redo.

## Build from source

Requirements: [Node.js](https://nodejs.org) 22+, [Rust](https://rustup.rs) (stable), and the [Tauri 2 prerequisites](https://tauri.app/start/prerequisites/) for your OS.

The app bundles `ffmpeg`, `ffprobe` and `whisper-cli` as sidecar programs; fetch or build them once:

**Windows (PowerShell):**

```powershell
npm ci
powershell -ExecutionPolicy Bypass -File scripts/fetch-ffmpeg.ps1
powershell -ExecutionPolicy Bypass -File scripts/fetch-whisper.ps1
npm run tauri dev                         # run
npm run tauri build -- --bundles nsis     # installer in src-tauri/target/release/bundle/nsis
```

**macOS (Apple Silicon):** needs Xcode command-line tools and CMake (`brew install cmake`).

```bash
npm ci
./scripts/build-ffmpeg-macos.sh
./scripts/build-whisper-macos.sh
npm run tauri dev
```

**Tests:** `npm test` (frontend) and `cd src-tauri && cargo test` (Rust). Tests that need real clips and binaries are `#[ignore]`d; see the comments on each for the environment variables they use.

### Project layout

- `src/` — React + TypeScript UI: timeline model and operations, preview rendering, audio preview, captions.
- `src-tauri/src/` — Rust backend: probing, proxies, audio preparation, ffmpeg filter-graph export, whisper transcription.
- `scripts/` — fetch/build scripts for the bundled binaries.
- `docs/superpowers/` — design specs and implementation plans for each feature.

## License

SocialFrag is free software, licensed under the **GNU General Public License v3.0** — see [LICENSE](LICENSE). You may use, study, share and modify it; if you distribute a modified version, you must publish its source under the same license.

Bundled third-party software (FFmpeg under the LGPL, whisper.cpp under MIT, fonts under the SIL Open Font License) keeps its own license — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Made by [DadMadeAnApp](https://github.com/DadMadeAnApp). Contact: support@dadmadeanapp.com
