# Third-party notices

SocialFrag itself is licensed under the GNU General Public License v3.0 (see `LICENSE`). The components
below are bundled with it and keep their own licenses.

## FFmpeg

SocialFrag bundles unmodified `ffmpeg` and `ffprobe` executables from the FFmpeg project
(https://ffmpeg.org), licensed under the GNU Lesser General Public License, version 2.1 or later.
The full license text is in `licenses/ffmpeg-LGPL-2.1.txt`.

macOS build:

- Version: FFmpeg 8.1.3
- Source: https://ffmpeg.org/releases/ffmpeg-8.1.3.tar.xz
- Build: LGPL only (`--disable-gpl --disable-nonfree`), no third-party libraries.
  macOS builds use Apple VideoToolbox/AudioToolbox. The exact build script is
  `scripts/build-ffmpeg-macos.sh`; `ffmpeg -buildconf` prints the configuration of the bundled binary.
- License: LGPL v2.1 or later, text in `licenses/ffmpeg-LGPL-2.1.txt`.

Windows build:

- Version: FFmpeg n8.1 (BtbN win64 LGPL build, `ffmpeg-n8.1-latest-win64-lgpl-8.1.zip`)
- Source: https://github.com/BtbN/FFmpeg-Builds (build recipes) and https://ffmpeg.org/download.html
  (FFmpeg sources). Fetched by `scripts/fetch-ffmpeg.ps1`.
- Build: LGPL only (`--disable-gpl --disable-nonfree`) but configured with `--enable-version3`, so it
  is covered by the LGPL **version 3**; the text ships as `licenses/ffmpeg-LGPL-3.0.txt`. It links
  further LGPL/permissive libraries, including libopenh264, libkvazaar, libaom, libvpx, libopus,
  libmp3lame, dav1d, libass, libfreetype, libharfbuzz and zlib. Run `ffmpeg -buildconf` on the
  bundled binary for the exact list.

The FFmpeg executables run as separate programs; SocialFrag does not link against FFmpeg libraries.
You may replace the bundled executables with your own FFmpeg build.
Source code for the bundled FFmpeg version is available at the URL above; on request we will
provide it on a physical medium for the cost of distribution (support@dadmadeanapp.com).

## whisper.cpp

SocialFrag bundles the unmodified `whisper-cli` program from whisper.cpp
(https://github.com/ggml-org/whisper.cpp), © The ggml authors, licensed under the MIT License.
The license text is in `licenses/whisper.cpp-MIT.txt`.

- macOS build: whisper.cpp v1.9.4, built from source with Metal by `scripts/build-whisper-macos.sh`.
- Windows build: whisper.cpp v1.9.4 CPU binaries from release `b5130` (`whisper-bin-x64.zip`),
  fetched by `scripts/fetch-whisper.ps1`, with its `whisper`/`ggml` DLLs.

Speech models (`ggml-base.en.bin`, `ggml-small.en.bin`, `ggml-medium.en.bin`) are not bundled; they are
downloaded on first use from https://huggingface.co/ggerganov/whisper.cpp and are MIT licensed.

## Fonts

SocialFrag bundles the Inter, Anton and Bebas Neue typefaces via the `@fontsource` packages, each
licensed under the SIL Open Font License 1.1. The license texts ship as `licenses/OFL-Inter.txt`,
`licenses/OFL-Anton.txt` and `licenses/OFL-BebasNeue.txt`.
