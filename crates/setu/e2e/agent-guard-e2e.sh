#!/bin/bash
# A sandboxed Setu (SETU_HOME set) must never install, reload or kickstart the machine-wide login
# service. A launchctl shim fails the test if anything calls it. Regression for a 0.1.4 test run that
# auto-set-up a sandbox and replaced the user's real dev.setu.daemon.
# Usage: crates/setu/e2e/agent-guard-e2e.sh <path-to-setu-binary>
set -euo pipefail
BIN="$(cd "$(dirname "${1:?path to setu binary}")" && pwd)/$(basename "$1")"
SB=/tmp/setu-agent-guard-e2e
cleanup() { rm -rf "${SB:?}"; }
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
rm -rf "${SB:?}"; mkdir -p "$SB/shims" "$SB/home"
export HOME="$SB/home" SETU_HOME="$SB/setu"
unset SETU_ALLOW_AGENT
for t in launchctl sudo; do
  printf '#!/bin/sh\necho "%s $*" >> "%s/calls.log"\nexit 0\n' "$t" "$SB" > "$SB/shims/$t"; chmod +x "$SB/shims/$t"
done
export PATH="$SB/shims:$PATH"
called() { [ -s "$SB/calls.log" ]; }

for cmd in "ls" "down x" "restart x" "new p b" "env ls global"; do
  out=$("$BIN" $cmd 2>&1) && fail "\`setu $cmd\` should fail without a daemon"
  echo "$out" | grep -q "SETU_HOME is set" || fail "\`setu $cmd\` should explain why it won't start the service: $out"
  called && fail "\`setu $cmd\` called: $(cat "$SB/calls.log")"
done
out=$("$BIN" 2>&1) && fail "bare setu should refuse under SETU_HOME"
called && fail "bare setu called: $(cat "$SB/calls.log")"
out=$("$BIN" setup --yes 2>&1) && fail "setup --yes should refuse under SETU_HOME"
out=$("$BIN" setup --undo 2>&1) && fail "setup --undo should refuse under SETU_HOME"
called && fail "setup called: $(cat "$SB/calls.log")"
[ ! -e "$HOME/Library/LaunchAgents/dev.setu.daemon.plist" ] || fail "no plist may be written"
"$BIN" setup --dry-run >/dev/null 2>&1 || true
called && fail "setup --dry-run called: $(cat "$SB/calls.log")"
echo "agent-guard e2e: all checks passed"
