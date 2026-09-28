#!/usr/bin/env bash
# Builds, signs, notarizes and staples the Apple Silicon macOS .dmg (Intel Macs are not supported).
#
# One-time setup (run yourself; credentials never go through this repo):
#   1. Xcode > Settings > Accounts > (DadMadeAnApp team) > Manage Certificates > + > "Developer ID Application".
#   2. xcrun notarytool store-credentials socialfrag-notary --apple-id <apple-id> --team-id <TEAMID>
#      (use an app-specific password from account.apple.com when prompted)
# Then:
#   APPLE_SIGNING_IDENTITY="Developer ID Application: <Name> (<TEAMID>)" ./scripts/release-macos.sh
# Unsigned local build (ad-hoc, for testing on this Mac only):
#   UNSIGNED=1 ./scripts/release-macos.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${NOTARY_PROFILE:-socialfrag-notary}"
TARGET=aarch64-apple-darwin
cd "$ROOT"

for f in ffmpeg ffprobe; do
  [ -x "src-tauri/binaries/$f-$TARGET" ] || { echo "missing src-tauri/binaries/$f-$TARGET — run scripts/build-ffmpeg-macos.sh" >&2; exit 1; }
done

if [ "${UNSIGNED:-0}" = 1 ]; then
  export APPLE_SIGNING_IDENTITY="-"
else
  : "${APPLE_SIGNING_IDENTITY:?set APPLE_SIGNING_IDENTITY to your Developer ID Application identity}"
  case "$APPLE_SIGNING_IDENTITY" in "Developer ID Application:"*) ;; *) echo "APPLE_SIGNING_IDENTITY must be a Developer ID Application identity" >&2; exit 1;; esac
fi

npx tauri build --target "$TARGET" --bundles app,dmg

BUNDLE="src-tauri/target/$TARGET/release/bundle"
APP="$BUNDLE/macos/SocialFrag.app"
DMG="$(ls "$BUNDLE"/dmg/*.dmg | head -1)"
codesign --verify --deep --strict "$APP"

if [ "${UNSIGNED:-0}" = 1 ]; then
  echo "Unsigned build: $DMG (runs on this Mac only)"; exit 0
fi

codesign --force --sign "$APPLE_SIGNING_IDENTITY" --timestamp "$DMG"
xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait
xcrun stapler staple "$DMG"
spctl --assess --type open --context context:primary-signature -v "$DMG"
echo "Signed + notarized: $DMG"
