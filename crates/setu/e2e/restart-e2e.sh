#!/bin/bash
# End-to-end check of `setu restart` for a managed run and for an "external" run (a dev server that was
# already running outside Setu), plus the proxy answering over IPv6 loopback (::1) as well as IPv4.
# Own HOME and SETU_HOME, proxy on a non-80 port. Fake data only.
# Usage: crates/setu/e2e/restart-e2e.sh <path-to-setu-binary>
set -euo pipefail
BIN="$(cd "$(dirname "${1:?path to setu binary}")" && pwd)/$(basename "$1")"
SB=/tmp/setu-restart-e2e
export HOME="$SB/home" SETU_HOME="$SB/setu"
DAEMON_PID=""; EXT_PID=""
cleanup() {
  "$BIN" down rs/main >/dev/null 2>&1 || true
  "$BIN" down rs/ext >/dev/null 2>&1 || true
  [ -n "$DAEMON_PID" ] && kill "$DAEMON_PID" 2>/dev/null || true
  [ -n "$EXT_PID" ] && kill "$EXT_PID" 2>/dev/null || true
  sleep 1; rm -rf "${SB:?}"
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
rm -rf "${SB:?}"; mkdir -p "$SB/seed" "$HOME" "$SETU_HOME/config/projects"
G="git -c user.email=e@e -c user.name=e -c commit.gpgsign=false -c protocol.file.allow=always -c maintenance.auto=false -c gc.auto=0"
(cd "$SB/seed" && $G init -q -b main . && echo hi > README.md && $G add -A && $G commit -q -m init)
$G clone -q --bare "$SB/seed" "$SB/rs.git"
$G -C "$SB/rs.git" worktree add -q "$SB/rs/main" main
$G -C "$SB/rs.git" worktree add -q -b ext "$SB/rs/ext" main
printf 'proxy_port = 17783\ndns_port = 25356\nstop_runs_on_exit = true\n' > "$SETU_HOME/config/config.toml"
cat > "$SETU_HOME/config/projects/rs.toml" <<TOML
project = "rs"
repo = "$SB/rs.git"
domain = "rs.localhost"
preset = []
auto_install = false

[ports]
web = {}

[procs.web]
run = "exec python3 -m http.server {port.web} --bind 127.0.0.1"
port = "web"
TOML
"$BIN" daemon >"$SB/daemon.log" 2>&1 &
DAEMON_PID=$!
for _ in $(seq 1 50); do "$BIN" ls >/dev/null 2>&1 && break; sleep 0.2; done
"$BIN" adopt "$SB/rs/main" >/dev/null; "$BIN" adopt "$SB/rs/ext" >/dev/null
field() { "$BIN" ls --json | python3 -I -c 'import json,sys; r=[x for x in json.load(sys.stdin) if x["run"]==sys.argv[1]][0]; print(r[sys.argv[2]] if not isinstance(r[sys.argv[2]],dict) else r[sys.argv[2]]["web"])' "$1" "$2"; }
pid_of_port() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1; }
wait_up() { for _ in $(seq 1 100); do [ "$(field "$1" status)" = running ] && p=$(field "$1" ports) && [ -n "$(pid_of_port "$p")" ] && return 0; sleep 0.2; done; return 1; }

echo "== managed run: restart replaces its process"
"$BIN" up "$SB/rs/main" >/dev/null; wait_up rs/main || fail "rs/main did not start"
P=$(field rs/main ports); OLD=$(pid_of_port "$P")
OUT=$("$BIN" restart rs/main) || fail "restart failed"; echo "$OUT"
case "$OUT" in "rs/main restarted"*) ;; *) fail "unexpected restart output: $OUT" ;; esac
wait_up rs/main || fail "rs/main is not up after restart"
NEW=$(pid_of_port "$P")
[ -n "$NEW" ] && [ "$NEW" != "$OLD" ] || fail "restart must replace the process (old $OLD, new $NEW)"
[ "$(field rs/main external)" = False ] || fail "a managed run is not external"
cd "$SB/rs/main"; "$BIN" restart >/dev/null || fail "restart with no argument should use the current worktree"; cd "$SB"

echo "== the proxy answers over IPv6 loopback (::1) and IPv4"
wait_up rs/main || fail "rs/main not up for the proxy check"
for addr in '[::1]' '127.0.0.1'; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H 'Host: rs.rs.localhost' "http://$addr:17783/") || fail "no answer over $addr"
  [ "$code" = 200 ] || fail "expected 200 over $addr, got $code"
done
echo "routed over ::1 and 127.0.0.1"

echo "== external run: restart takes it over (stops the outside server, Setu owns the new one)"
EP=$(field rs/ext ports)
(cd "$SB/rs/ext" && exec python3 -m http.server "$EP" --bind 127.0.0.1 >/dev/null 2>&1) &
EXT_PID=$!
for _ in $(seq 1 50); do [ -n "$(pid_of_port "$EP")" ] && break; sleep 0.2; done
for _ in $(seq 1 50); do [ "$("$BIN" ls --json | python3 -I -c 'import json,sys; print([x for x in json.load(sys.stdin) if x["run"]=="rs/ext"][0]["external"])')" = True ] && break; "$BIN" up "$SB/rs/ext" >/dev/null 2>&1 || true; sleep 0.3; done
[ "$(field rs/ext external)" = True ] || fail "rs/ext should be adopted as running, external"
OUT=$("$BIN" restart rs/ext) || fail "restart of the external run failed"; echo "$OUT"
for _ in $(seq 1 50); do kill -0 "$EXT_PID" 2>/dev/null || break; sleep 0.1; done
if kill -0 "$EXT_PID" 2>/dev/null; then fail "the external server should have been stopped by restart"; fi
wait_up rs/ext || fail "rs/ext did not come back under Setu"
[ "$(field rs/ext external)" = False ] || fail "after restart Setu owns the run"
[ -n "$(pid_of_port "$EP")" ] && [ "$(pid_of_port "$EP")" != "$EXT_PID" ] || fail "a new server should hold the port"
echo "restart e2e: all checks passed"
