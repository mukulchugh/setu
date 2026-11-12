#!/bin/bash
# End-to-end check of `setu-rs mcp` against a throwaway sandbox. Fake secret values only.
# Usage: CARGO_TARGET_DIR=... crates/setu/e2e/mcp-e2e.sh <path-to-setu-rs-binary>
set -euo pipefail
BIN="${1:?path to setu-rs binary}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SB=/tmp/setu-mcp-e2e
export SETU_HOME="$SB/home"
DAEMON_PID=""
cleanup() {
  [ -n "$DAEMON_PID" ] && kill "$DAEMON_PID" 2>/dev/null || true
  sleep 1
  # runs left behind by a failed assertion
  pkill -f "http.server .* --bind 127.0.0.1" 2>/dev/null || true
  rm -rf "${SB:?}"
}
trap cleanup EXIT
rm -rf "${SB:?}"
mkdir -p "$SB/seed" "$SETU_HOME/config/projects"
cd "$SB/seed"
git init -q -b main . && git -c user.email=e@e -c user.name=e commit -q --allow-empty -m init
git clone -q --bare "$SB/seed" "$SB/app.git"
git -C "$SB/app.git" worktree add -q "$SB/wt-main" main
cat > "$SETU_HOME/config/projects/e2e.toml" <<'TOML'
project = "e2e"
repo = "/tmp/setu-mcp-e2e/app.git"
domain = "e2e.local"

[ports.web]

[procs.web]
run = "echo token=$API_TOKEN; exec python3 -m http.server {port.web} --bind 127.0.0.1"
port = "web"
TOML
"$BIN" daemon >"$SB/daemon.log" 2>&1 &
DAEMON_PID=$!
sleep 1
"$BIN" env set project e2e 'API_TOKEN=sk-fake-MCPLEAK-0123456789' --secret
python3 -I "$HERE/mcp_e2e.py" "$BIN" "$SB/wt-main" "$SETU_HOME"
echo "audit log entries (names only):"
"$BIN" history --kind env --limit 20 | cut -c1-200
! "$BIN" history --kind env --limit 1000 --json | grep -q MCPLEAK
# the secret value is in no database file (main file, WAL or shared memory)
ls "$SETU_HOME/state"/setu.db* >/dev/null
! grep -q MCPLEAK "$SETU_HOME/state"/setu.db*
"$BIN" down e2e/wt-main >/dev/null 2>&1 || true
kill "$DAEMON_PID"; wait "$DAEMON_PID" 2>/dev/null || true; DAEMON_PID=""
echo "E2E OK"
