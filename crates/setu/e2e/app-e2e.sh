#!/bin/bash
# `setu app` with a fake Setu.app bundle and a sandboxed HOME: install, update over an old version, path,
# the missing-bundle error, uninstall. Never opens anything. Usage: crates/setu/e2e/app-e2e.sh <path-to-setu-binary>
set -euo pipefail
BIN="$(cd "$(dirname "${1:?path to setu binary}")" && pwd)/$(basename "$1")"
SB=/tmp/setu-app-e2e
export HOME="$SB/home" SETU_HOME="$SB/setu"
trap 'rm -rf "${SB:?}"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
fake() { # fake <dir> <version>
  mkdir -p "$1/Setu.app/Contents/MacOS"
  printf '<plist><dict><key>CFBundleShortVersionString</key><string>%s</string></dict></plist>\n' "$2" > "$1/Setu.app/Contents/Info.plist"
  echo "$2" > "$1/Setu.app/Contents/MacOS/Setu"
}
rm -rf "${SB:?}"; mkdir -p "$HOME" "$SETU_HOME"
fake "$SB/pkg" 0.2.0

echo "== no bundled app: a clear error pointing at the bundle script"
if env -u SETU_APP_SOURCE "$BIN" app >/dev/null 2>"$SB/err"; then fail "should fail without a bundled app"; fi
grep -q "scripts/bundle-swift.sh" "$SB/err" || { cat "$SB/err"; fail "unclear error"; }
[ ! -e "$HOME/Applications" ] || fail "nothing may be created on failure"

echo "== install, then update over an older version"
export SETU_APP_SOURCE="$SB/pkg/Setu.app"
OUT="$("$BIN" app)"
grep -q "installed Setu.app 0.2.0 to ~/Applications" <<<"$OUT" || fail "install message: $OUT"
[ "$(cat "$HOME/Applications/Setu.app/Contents/MacOS/Setu")" = 0.2.0 ] || fail "app not copied"
rm -rf "$HOME/Applications/Setu.app"; fake "$HOME/Applications" 0.1.0
PATHS="$("$BIN" app path)"
grep -q "installed:.*version 0.1.0" <<<"$PATHS" && grep -q "bundled:.*version 0.2.0" <<<"$PATHS" || fail "path output: $PATHS"
"$BIN" app install >/dev/null
[ "$(cat "$HOME/Applications/Setu.app/Contents/MacOS/Setu")" = 0.2.0 ] || fail "app not updated"
[ "$(ls -A "$HOME/Applications")" = "Setu.app" ] || fail "temp files left behind"

echo "== uninstall"
"$BIN" app uninstall >/dev/null
[ ! -e "$HOME/Applications/Setu.app" ] || fail "app not removed"
"$BIN" app uninstall | grep -q "not installed" || fail "second uninstall should say so"
if "$BIN" app nonsense >/dev/null 2>&1; then fail "unknown subcommand should fail"; fi
echo "app e2e: all checks passed"
