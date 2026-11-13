#!/bin/bash
# Build the SwiftUI Setu.app: release Swift package + release `setu`, assemble the bundle,
# ad-hoc sign inside-out and verify. Output: <repo>/target-swift/Setu.app
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/target-swift/Setu.app"
VERSION="$(sed -n 's/^version *= *"\(.*\)"/\1/p' "$ROOT/crates/setu/Cargo.toml" | head -1)"
: "${VERSION:?could not read the version from crates/setu/Cargo.toml}"

# shellcheck source=swift-sdk.sh
. "$ROOT/scripts/swift-sdk.sh"
# SETU_APP_UNIVERSAL=1: one app for Apple silicon and Intel (release builds).
# SETU_APP_NO_CLI=1: don't bundle a `setu` binary (Homebrew installs the CLI; the app uses it).
cd "$ROOT/apps/setu-swift"
if [ "${SETU_APP_UNIVERSAL:-}" = 1 ]; then
  SLICES=()
  for triple in arm64-apple-macosx26.0 x86_64-apple-macosx26.0; do
    # A separate scratch dir per architecture: they would otherwise share one output folder.
    scratch=".build-universal/${triple%%-*}"
    swift build -c release ${SWIFT_SDK_ARGS[@]+"${SWIFT_SDK_ARGS[@]}"} --triple "$triple" --scratch-path "$scratch"
    SLICES+=("$(swift build -c release ${SWIFT_SDK_ARGS[@]+"${SWIFT_SDK_ARGS[@]}"} --triple "$triple" --scratch-path "$scratch" --show-bin-path)/SetuApp")
  done
  SWIFT_BIN="$(mktemp -d)/SetuApp"
  lipo -create "${SLICES[@]}" -output "$SWIFT_BIN"
else
  swift build -c release ${SWIFT_SDK_ARGS[@]+"${SWIFT_SDK_ARGS[@]}"}
  SWIFT_BIN="$(swift build -c release ${SWIFT_SDK_ARGS[@]+"${SWIFT_SDK_ARGS[@]}"} --show-bin-path)/SetuApp"
fi

rm -rf "${APP:?}"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$SWIFT_BIN" "$APP/Contents/MacOS/SetuApp"
if [ "${SETU_APP_NO_CLI:-}" != 1 ]; then
  cd "$ROOT"
  cargo build --release -p setu
  mkdir -p "$APP/Contents/Resources/bin"
  cp "${CARGO_TARGET_DIR:-$ROOT/target}/release/setu" "$APP/Contents/Resources/bin/setu"
fi
# App icon from the brand kit (brand/icon/Setu.iconset, made from brand/icon/setu-icon-1024.png).
ICONSET="$ROOT/brand/icon/Setu.iconset"
if [ -d "$ICONSET" ]; then
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/Setu.icns"
fi

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>dev.setu.app</string>
  <key>CFBundleName</key><string>Setu</string>
  <key>CFBundleDisplayName</key><string>Setu</string>
  <key>CFBundleExecutable</key><string>SetuApp</string>
  <key>CFBundleIconFile</key><string>Setu</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>26.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

# Inside-out: inner binaries first, then the bundle.
[ -f "$APP/Contents/Resources/bin/setu" ] && codesign --force --sign - "$APP/Contents/Resources/bin/setu"
codesign --force --sign - "$APP/Contents/MacOS/SetuApp"
codesign --force --sign - "$APP"
codesign -v --strict "$APP"
echo "built $APP"
