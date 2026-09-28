#!/usr/bin/env bash
# Builds LGPL-only ffmpeg + ffprobe for Apple Silicon macOS as Tauri sidecars (Intel Macs are not supported).
# No GPL/nonfree code and no third-party libraries: only Apple frameworks
# (VideoToolbox for H.264 encode, AudioToolbox) plus ffmpeg's own decoders and AAC encoder.
# Output: src-tauri/binaries/{ffmpeg,ffprobe}-aarch64-apple-darwin
set -euo pipefail

VERSION="${FFMPEG_VERSION:-8.1.3}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${FFMPEG_WORK:-$ROOT/.ffmpeg-build}"
OUT="$ROOT/src-tauri/binaries"
MIN_MACOS=11.0
mkdir -p "$WORK" "$OUT"

TARBALL="$WORK/ffmpeg-$VERSION.tar.xz"
[ -f "$TARBALL" ] || curl -fL --retry 3 -o "$TARBALL" "https://ffmpeg.org/releases/ffmpeg-$VERSION.tar.xz"

FLAGS=(
  --disable-gpl --disable-nonfree --disable-version3
  --disable-autodetect            # never link Homebrew libs (x264 etc.) by accident
  --enable-videotoolbox --enable-audiotoolbox
  --enable-zlib                   # system libz: PNG masks and caption overlays
  --enable-static --disable-shared
  --disable-doc --disable-ffplay --disable-network --disable-debug
  --enable-pthreads
)

build_arch() {
  local arch="$1" triple="$2" src="$WORK/src-$1" prefix="$WORK/out-$1"
  rm -rf "$src" "$prefix"; mkdir -p "$src"
  tar -xJf "$TARBALL" -C "$src" --strip-components 1
  (cd "$src" && ./configure --prefix="$prefix" --cc="clang -arch $arch" \
      --extra-cflags="-mmacosx-version-min=$MIN_MACOS" --extra-ldflags="-mmacosx-version-min=$MIN_MACOS -arch $arch" \
      "${FLAGS[@]}" && make -j"$(sysctl -n hw.ncpu)" && make install)
  for tool in ffmpeg ffprobe; do cp "$prefix/bin/$tool" "$OUT/$tool-$triple"; done
}

build_arch arm64 aarch64-apple-darwin
mkdir -p "$ROOT/src-tauri/licenses" && cp "$WORK/src-arm64/COPYING.LGPLv2.1" "$ROOT/src-tauri/licenses/ffmpeg-LGPL-2.1.txt"

# Guard: LGPL build, no dylibs outside the OS.
grep -q -- "--disable-gpl" <<<"$("$OUT/ffmpeg-aarch64-apple-darwin" -hide_banner -buildconf)" || { echo "not an LGPL build" >&2; exit 1; }
if otool -L "$OUT/ffmpeg-aarch64-apple-darwin" | tail -n +2 | grep -vE "^\s*(/System/Library|/usr/lib)/"; then
  echo "unexpected non-system dylib dependency" >&2; exit 1
fi
# Guard: codecs/filters SocialFrag's export and proxy pipelines need.
for need in "decoders: png " "decoders: hevc " "encoders: h264_videotoolbox" "encoders: aac "; do
  kind="${need%%:*}"; name="${need#*: }"
  list="$("$OUT/ffmpeg-aarch64-apple-darwin" -hide_banner -"$kind" 2>/dev/null)"   # capture first: grep -q + pipefail = SIGPIPE false negative
  grep -q " $name" <<<"$list" || { echo "missing $kind $name" >&2; exit 1; }
done
echo "ffmpeg $VERSION (LGPL) built into $OUT"
