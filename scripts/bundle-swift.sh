#!/bin/bash
# Build the SwiftUI Setu.app: release Swift package + release `setu-rs`, assemble the bundle,
# ad-hoc sign inside-out and verify. Output: <repo>/target-swift/Setu.app
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/target-swift/Setu.app"
VERSION="$(sed -n 's/^version *= *"\(.*\)"/\1/p' "$ROOT/crates/setu/Cargo.toml" | head -1)"
: "${VERSION:?could not read the version from crates/setu/Cargo.toml}"

cd "$ROOT/apps/setu-swift"
swift build -c release
SWIFT_BIN="$(swift build -c release --show-bin-path)/SetuApp"

cd "$ROOT"
cargo build --release -p setu
RS_BIN="${CARGO_TARGET_DIR:-$ROOT/target}/release/setu-rs"

rm -rf "${APP:?}"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/bin"
cp "$SWIFT_BIN" "$APP/Contents/MacOS/SetuApp"
cp "$RS_BIN" "$APP/Contents/Resources/bin/setu-rs"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>dev.setu.app</string>
  <key>CFBundleName</key><string>Setu</string>
  <key>CFBundleDisplayName</key><string>Setu</string>
  <key>CFBundleExecutable</key><string>SetuApp</string>
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
codesign --force --sign - "$APP/Contents/Resources/bin/setu-rs"
codesign --force --sign - "$APP/Contents/MacOS/SetuApp"
codesign --force --sign - "$APP"
codesign -v --strict "$APP"
echo "built $APP"
