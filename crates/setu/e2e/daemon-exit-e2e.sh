#!/bin/bash
# A daemon exit (an upgrade, `launchctl kickstart -k`) must not stop dev servers: the managed run and a
# taken-over (external) server stay up, the next daemon adopts both and routes to them, and `setu down`
# still stops the managed one. With `stop_runs_on_exit = true` only Setu-started runs stop.
# Own HOME and SETU_HOME, proxy on a non-80 port. Fake data only. Cleanup kills recorded PIDs only.
# Usage: crates/setu/e2e/daemon-exit-e2e.sh <path-to-setu-binary>
set -euo pipefail
BIN="$(cd "$(dirname "${1:?path to setu binary}")" && pwd)/$(basename "$1")"
SB=/tmp/setu-daemon-exit-e2e
export HOME="$SB/home" SETU_HOME="$SB/setu"
DAEMON_PID=""; EXT_PID=""; MAN_PID=""
cleanup() {
  [ -n "$DAEMON_PID" ] && kill "$DAEMON_PID" 2>/dev/null || true
  for p in "$EXT_PID" "$MAN_PID"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  sleep 1; [ -n "${KEEP:-}" ] || rm -rf "${SB:?}"
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
rm -rf "${SB:?}"; mkdir -p "$SB/seed" "$HOME" "$SETU_HOME/config/projects"
G="git -c user.email=e@e -c user.name=e -c commit.gpgsign=false -c protocol.file.allow=always -c maintenance.auto=false -c gc.auto=0"
(cd "$SB/seed" && $G init -q -b main . && echo hi > README.md && $G add -A && $G commit -q -m init)
$G clone -q --bare "$SB/seed" "$SB/dx.git"
$G -C "$SB/dx.git" worktree add -q "$SB/dx/main" main
$G -C "$SB/dx.git" worktree add -q -b ext "$SB/dx/ext" main
printf 'proxy_port = 17787\ndns_port = 25358\n' > "$SETU_HOME/config/config.toml"
cat > "$SETU_HOME/config/projects/dx.toml" <<TOML
project = "dx"
repo = "$SB/dx.git"
domain = "dx.localhost"
preset = []
auto_install = false

[ports]
web = {}

[procs.web]
run = "exec python3 -m http.server {port.web} --bind 127.0.0.1"
port = "web"
TOML
start_daemon() {
  "$BIN" daemon >>"$SB/daemon.log" 2>&1 &
  DAEMON_PID=$!
  for _ in $(seq 1 50); do "$BIN" ls >/dev/null 2>&1 && return 0; sleep 0.2; done
  fail "daemon did not come up"
}
stop_daemon() { kill -TERM "$DAEMON_PID"; for _ in $(seq 1 50); do kill -0 "$DAEMON_PID" 2>/dev/null || { DAEMON_PID=""; return 0; }; sleep 0.2; done; fail "daemon did not exit"; }
field() { "$BIN" ls --json | python3 -I -c 'import json,sys; r=[x for x in json.load(sys.stdin) if x["run"]==sys.argv[1]][0]; v=r[sys.argv[2]]; print(v["web"] if isinstance(v,dict) else v)' "$1" "$2"; }
pid_of_port() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1; }
wait_status() { for _ in $(seq 1 100); do [ "$(field "$1" status)" = "$2" ] && return 0; sleep 0.2; done; return 1; }
code() { local h; h=$(field "$1" url | sed -E 's#^https?://##; s#[:/].*##'); curl -s -o /dev/null -m 10 -w '%{http_code}' -H "Host: $h" http://127.0.0.1:17787/; }

start_daemon
"$BIN" adopt "$SB/dx/main" >/dev/null; "$BIN" adopt "$SB/dx/ext" >/dev/null
echo "== a managed run and an external (taken-over) server are up"
"$BIN" up "$SB/dx/main" >/dev/null; wait_status dx/main running || fail "dx/main did not start"
MP=$(field dx/main ports); for _ in $(seq 1 50); do MAN_PID=$(pid_of_port "$MP"); [ -n "$MAN_PID" ] && break; sleep 0.2; done
EP=$(field dx/ext ports)
# a v1-style server: its own session, cwd in the worktree, orphaned to launchd (ppid 1)
python3 -I -c 'import os,sys,subprocess
if os.fork(): sys.exit(0)
os.setsid(); os.chdir(sys.argv[1])
subprocess.Popen(["python3","-m","http.server",sys.argv[2],"--bind","127.0.0.1"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
' "$SB/dx/ext" "$EP"
for _ in $(seq 1 50); do EXT_PID=$(pid_of_port "$EP"); [ -n "$EXT_PID" ] && break; sleep 0.2; done
[ -n "$EXT_PID" ] || fail "fixture external server did not start"
"$BIN" up "$SB/dx/ext" >/dev/null; wait_status dx/ext running || fail "dx/ext was not taken over"
[ "$(field dx/ext external)" = True ] || fail "dx/ext should be external"

echo "== daemon exits (default): both servers stay up"
stop_daemon
sleep 1
kill -0 "$MAN_PID" 2>/dev/null || fail "the managed dev server was stopped by a daemon exit"
kill -0 "$EXT_PID" 2>/dev/null || fail "the external dev server was stopped by a daemon exit"
grep -q "stay up" "$SB/daemon.log" || fail "the daemon should say runs stay up"

echo "== next daemon adopts both and routes to them"
start_daemon
wait_status dx/main running || fail "dx/main not adopted as running"
wait_status dx/ext running || fail "dx/ext not adopted as running"
[ "$(pid_of_port "$MP")" = "$MAN_PID" ] || fail "dx/main was respawned instead of adopted"
[ "$(code dx/main)" = 200 ] || fail "proxy does not reach the adopted managed run"
[ "$(code dx/ext)" = 200 ] || fail "proxy does not reach the adopted external run"

echo "== stop_runs_on_exit = true stops only Setu-started runs"
printf 'proxy_port = 17787\ndns_port = 25358\nstop_runs_on_exit = true\n' > "$SETU_HOME/config/config.toml"
stop_daemon
for _ in $(seq 1 50); do kill -0 "$MAN_PID" 2>/dev/null || break; sleep 0.2; done
kill -0 "$MAN_PID" 2>/dev/null && fail "stop_runs_on_exit should stop the managed run"
kill -0 "$EXT_PID" 2>/dev/null || fail "an external server must never be stopped by a daemon exit"
MAN_PID=""
echo "daemon-exit e2e: all checks passed"
