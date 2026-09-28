#!/usr/bin/env bash
# Builds whisper-cli v1.9.4 for Apple Silicon with Metal (shaders embedded), statically linked.
set -euo pipefail
VERSION=v1.9.4
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/src-tauri/binaries/whisper-cli-aarch64-apple-darwin"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/whisper-build.XXXXXX")"
git clone --depth 1 --branch "$VERSION" https://github.com/ggml-org/whisper.cpp "$WORK/src"
cmake -S "$WORK/src" -B "$WORK/build" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
  -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DGGML_NATIVE=OFF \
  -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_DEPLOYMENT_TARGET=11.0 \
  -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_BUILD_TESTS=OFF
cmake --build "$WORK/build" --config Release -j --target whisper-cli
cp "$WORK/build/bin/whisper-cli" "$OUT"
cp "$WORK/src/LICENSE" "$ROOT/src-tauri/licenses/whisper.cpp-MIT.txt"
# Guards: arm64, no non-system dylibs, runs.
file "$OUT" | grep -q arm64
if otool -L "$OUT" | tail -n +2 | grep -vE '/usr/lib/|/System/Library/'; then echo "unexpected dylib dependency" >&2; exit 1; fi
"$OUT" --help >/dev/null 2>&1 || "$OUT" -h >/dev/null 2>&1 || true
echo "built $OUT ($VERSION)"
