#!/bin/bash
# End-to-end check of `setu x trigger-dev` with a fake `bunx` on PATH: the CLI version follows the worktree's
# pinned SDK, --branch only where the installed core supports it, and a clear error when no SDK is pinned.
# Fake data only. Usage: crates/setu/e2e/x-trigger-dev-e2e.sh <path-to-setu-binary>
set -euo pipefail
BIN="$(cd "$(dirname "${1:?path to setu binary}")" && pwd)/$(basename "$1")"
SB=/tmp/setu-xtrigger-e2e
export HOME="$SB/home" SETU_HOME="$SB/setu"
DAEMON_PID=""
cleanup() {
  [ -n "$DAEMON_PID" ] && { "$BIN" down tp/main >/dev/null 2>&1 || true; kill "$DAEMON_PID" 2>/dev/null || true; }
  sleep 1; rm -rf "${SB:?}"
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
rm -rf "${SB:?}"; mkdir -p "$SB/shims" "$SB/wt" "$HOME"
printf '#!/bin/sh\nprintf "%%s\\n" "$*" > "$SB_OUT"\n' > "$SB/shims/bunx"
chmod +x "$SB/shims/bunx"
export SB_OUT="$SB/bunx.args" PATH="$SB/shims:$PATH"
cd "$SB/wt"
run() { rm -f "$SB_OUT"; "$BIN" x trigger-dev "$@" 2>"$SB/stderr"; cat "$SB_OUT"; }

echo "== no sdk pinned: a clear error, bunx never runs"
echo '{"dependencies":{"react":"^19"}}' > package.json
rm -f "$SB_OUT"
if "$BIN" x trigger-dev >/dev/null 2>"$SB/stderr"; then fail "should fail without a pinned sdk"; fi
grep -q "no @trigger.dev/sdk version pinned" "$SB/stderr" || { cat "$SB/stderr"; fail "unclear error"; }
[ ! -e "$SB_OUT" ] || fail "bunx must not run without a pinned sdk"
rm package.json
if "$BIN" x trigger-dev >/dev/null 2>"$SB/stderr"; then fail "should fail without package.json"; fi
grep -q "no package.json" "$SB/stderr" || fail "unclear error without package.json"

echo "== version follows package.json, ^ stripped; no --branch while the installed core lacks support"
echo '{"dependencies":{"@trigger.dev/sdk":"^4.4.6"}}' > package.json
[ "$(TRIGGER_DEV_BRANCH=feat-x run --max-concurrent-runs 2 --env-file apps/a/.env.local)" = "trigger.dev@4.4.6 dev --max-concurrent-runs 2 --env-file apps/a/.env.local" ] || fail "main-style worktree args"
grep -q "no dev-branch support" "$SB/stderr" || fail "should say why there is no branch"
mkdir -p node_modules/@trigger.dev/core/dist/esm/v3/apiClientManager
echo 'const a = process.env.UNRELATED;' > node_modules/@trigger.dev/core/dist/esm/v3/apiClientManager/index.js
[ "$(TRIGGER_DEV_BRANCH=feat-x run)" = "trigger.dev@4.4.6 dev" ] || fail "a probe file without TRIGGER_DEV_BRANCH means no --branch"

echo "== newer worktree: ~ stripped, --branch from TRIGGER_DEV_BRANCH when the probe mentions it"
echo '{"devDependencies":{"@trigger.dev/sdk":"~4.8.3"}}' > package.json
echo 'const a = process.env.TRIGGER_DEV_BRANCH;' > node_modules/@trigger.dev/core/dist/esm/v3/apiClientManager/index.js
[ "$(TRIGGER_DEV_BRANCH=feat-x run --max-concurrent-runs 3)" = "trigger.dev@4.8.3 dev --max-concurrent-runs 3 --branch feat-x" ] || fail "newer worktree args"
[ ! -s "$SB/stderr" ] || fail "no note when branches are supported"

echo "== the run name falls back to SETU_RUN; the commonjs probe counts too"
rm -rf node_modules; mkdir -p node_modules/@trigger.dev/core/dist/commonjs/v3/apiClientManager
echo 'TRIGGER_DEV_BRANCH' > node_modules/@trigger.dev/core/dist/commonjs/v3/apiClientManager/index.js
[ "$(SETU_RUN=feat-y run)" = "trigger.dev@4.8.3 dev --branch feat-y" ] || fail "SETU_RUN fallback"
echo "== through the daemon: the generated proc finds setu even though its install dir is not on the proc PATH"
G="git -c user.email=e@e -c user.name=e -c commit.gpgsign=false -c protocol.file.allow=always -c maintenance.auto=false"
mkdir -p "$SB/seed" "$SETU_HOME/config/projects"
(cd "$SB/seed" && $G init -q -b main . && echo '{"dependencies":{"@trigger.dev/sdk":"^4.8.3"}}' > package.json && $G add -A && $G commit -q -m init)
$G clone -q --bare "$SB/seed" "$SB/tp.git"
$G -C "$SB/tp.git" worktree add -q "$SB/tp/main" main
mkdir -p "$SB/tp/main/node_modules/@trigger.dev/core/dist/esm/v3/apiClientManager"
echo 'process.env.TRIGGER_DEV_BRANCH' > "$SB/tp/main/node_modules/@trigger.dev/core/dist/esm/v3/apiClientManager/index.js"
printf 'proxy_port = 17784\ndns_port = 25357\nstop_runs_on_exit = true\n' > "$SETU_HOME/config/config.toml"
cat > "$SETU_HOME/config/projects/tp.toml" <<TOML
project = "tp"
repo = "$SB/tp.git"
domain = "tp.localhost"
preset = []
auto_install = false

[ports]
web = {}

[env]
TRIGGER_DEV_BRANCH = "{run}"

[procs.web]
run = "exec python3 -m http.server {port.web} --bind 127.0.0.1"
port = "web"

[procs.trigger]
run = "setu x trigger-dev --max-concurrent-runs 2"
TOML
cat > "$SB/shims/bunx" <<SHIM
#!/bin/sh
printf '%s\n' "\$*" > "$SB/bunx.daemon.args"
exec sleep 30
SHIM
chmod +x "$SB/shims/bunx"
# the daemon's PATH has the shims and the system dirs only: no dir that holds setu
env PATH="$SB/shims:/usr/bin:/bin" "$BIN" daemon >"$SB/daemon.log" 2>&1 &
DAEMON_PID=$!
for _ in $(seq 1 50); do "$BIN" ls >/dev/null 2>&1 && break; sleep 0.2; done
"$BIN" adopt "$SB/tp/main" >/dev/null
"$BIN" up "$SB/tp/main" >/dev/null
for _ in $(seq 1 100); do [ -s "$SB/bunx.daemon.args" ] && break; sleep 0.2; done
[ -s "$SB/bunx.daemon.args" ] || { cat "$SETU_HOME/logs/tp/main/trigger.log" 2>/dev/null; fail "the trigger proc never reached bunx (setu not found on the proc PATH?)"; }
[ "$(cat "$SB/bunx.daemon.args")" = "trigger.dev@4.8.3 dev --max-concurrent-runs 2 --branch main" ] || fail "wrong args through the daemon: $(cat "$SB/bunx.daemon.args")"
echo "x trigger-dev e2e: all checks passed"
