#!/bin/bash
# The one-command install: bare `setu` on a machine that is not set up, auto-setup and kickstart from other
# commands, MCP never installing anything, Setu.app auto-update (including the "app is running" case), and the
# daemon restarting itself after its binary is replaced. Entirely sandboxed: own HOME and SETU_HOME, PATH shims
# for launchctl, sudo and brew that only log (the launchctl shim starts the sandbox daemon), proxy and DNS on
# non-default ports, a fake Setu.app. Nothing outside /tmp/setu-onecmd-e2e is touched; cleanup kills recorded PIDs.
# Usage: crates/setu/e2e/onecmd-e2e.sh <path-to-setu-binary>
set -euo pipefail
BIN="$(cd "$(dirname "${1:?path to setu binary}")" && pwd)/$(basename "$1")"
SB=/tmp/setu-onecmd-e2e
export HOME="$SB/home" SETU_HOME="$SB/setu" SB BIN
export SETU_MAINTENANCE_SECS=1
export SETU_APP_SOURCE="$SB/pkg/Setu.app"
export PATH="$SB/shims:$PATH"
PIDS=()
cleanup() {
  "$BIN" down oc/main >/dev/null 2>&1 || true
  [ -f "$SB/daemon.pid" ] && kill "$(cat "$SB/daemon.pid")" 2>/dev/null || true
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  sleep 1; rm -rf "${SB:?}"
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo; echo "== $*"; }
fake() { # fake <dir> <version>: a minimal Setu.app bundle
  mkdir -p "$1/Setu.app/Contents/MacOS"
  printf '<plist><dict><key>CFBundleShortVersionString</key><string>%s</string></dict></plist>\n' "$2" > "$1/Setu.app/Contents/Info.plist"
  echo "$2" > "$1/Setu.app/Contents/MacOS/Setu"
}
app_is() { [ "$(app_version)" = "$1" ]; }
app_version() { sed -n 's/.*<string>\(.*\)<\/string>.*/\1/p' "$HOME/Applications/Setu.app/Contents/Info.plist"; }
wait_for() { # wait_for <seconds> <command...>
  local n=$(( $1 * 5 )); shift
  for _ in $(seq 1 "$n"); do "$@" && return 0; sleep 0.2; done; return 1
}
sock_down() { ! [ -S "$SETU_HOME/state/d.sock" ] || ! "$BIN" doctor --json 2>/dev/null | grep -q '"name": "daemon"' ; }

rm -rf "${SB:?}"; mkdir -p "$SB/shims" "$SB/seed" "$HOME" "$SETU_HOME/config/projects"
fake "$SB/pkg" 0.2.0
G="git -c user.email=e@e -c user.name=e -c commit.gpgsign=false -c protocol.file.allow=always -c maintenance.auto=false -c gc.auto=0"
(cd "$SB/seed" && $G init -q -b main . && echo hi > README.md && $G add -A && $G commit -q -m init)
$G clone -q --bare "$SB/seed" "$SB/oc.git"
$G -C "$SB/oc.git" worktree add -q "$SB/oc/main" main
printf 'proxy_port = 17811\ndns_port = 25371\n' > "$SETU_HOME/config/config.toml"
# a custom domain, so the first run has a resolver step that needs sudo
cat > "$SETU_HOME/config/projects/oc.toml" <<TOML
project = "oc"
repo = "$SB/oc.git"
domain = "onecmd.test"
preset = []
auto_install = false

[ports]
web = {}

[procs.web]
run = "exec python3 -m http.server {port.web} --bind 127.0.0.1"
port = "web"
TOML

cat > "$SB/shims/launchctl" <<'S'
#!/bin/bash
echo "launchctl $*" >> "$SB/calls.log"
start() { nohup env HOME="$HOME" SETU_HOME="$SETU_HOME" "$BIN" daemon >>"$SB/daemon.log" 2>&1 </dev/null & echo $! > "$SB/daemon.pid"; }
alive() { [ -f "$SB/daemon.pid" ] && kill -0 "$(cat "$SB/daemon.pid")" 2>/dev/null; }
case "$1" in
  bootstrap) start; exit 0 ;;
  kickstart) [ -f "$SB/kick-fail" ] && exit 113; alive || start; exit 0 ;;
  bootout) alive && kill "$(cat "$SB/daemon.pid")" 2>/dev/null; rm -f "$SB/daemon.pid"; sleep 1; exit 0 ;;
  print) alive && exit 0; exit 1 ;;
esac
exit 0
S
printf '#!/bin/bash\necho "sudo $*" >> "$SB/sudo.log"\nexit 1\n' > "$SB/shims/sudo"
printf '#!/bin/bash\necho "brew $*" >> "$SB/calls.log"\nexit 0\n' > "$SB/shims/brew"
chmod +x "$SB/shims"/*
: > "$SB/calls.log"; : > "$SB/sudo.log"
PLIST="$HOME/Library/LaunchAgents/dev.setu.daemon.plist"
count() { grep -c "$1" "$SB/calls.log" || true; }

step "bare setu, not set up: sets everything up without asking, then says what to do next"
[ ! -e "$PLIST" ] || fail "the sandbox must start with no LaunchAgent"
timeout 60 "$BIN" > "$SB/bare1.out" 2>&1 < /dev/null || { cat "$SB/bare1.out" "$SB/daemon.log"; fail "bare setu failed"; }
cat "$SB/bare1.out"
[ -f "$PLIST" ] || fail "the LaunchAgent plist was not written"
[ "$(count 'launchctl bootstrap')" = 1 ] || fail "the agent should be bootstrapped once"
grep -q "daemon is up" "$SB/bare1.out" || fail "should say the daemon is up"
[ "$(app_version)" = 0.2.0 ] || fail "the bundled Setu.app should be installed into ~/Applications"
grep -q "doctor: " "$SB/bare1.out" || fail "should print a doctor summary"
grep -q "Setu is ready" "$SB/bare1.out" && grep -q "$SETU_HOME/config/projects/myapp.toml" "$SB/bare1.out" || fail "should print the next steps with the config path"
grep -q '`setu ls`' "$SB/bare1.out" && grep -q "Spotlight" "$SB/bare1.out" || fail "next steps should mention setu ls and Spotlight"
grep -q "y/N" "$SB/bare1.out" && fail "bare setu must never ask y/N" || true
grep -q "skipped onecmd.test" "$SB/bare1.out" || fail "no terminal: the sudo resolver step should be skipped"
grep -q "sudo tee .*/onecmd.test" "$SB/bare1.out" || fail "the exact resolver command should be printed"
[ ! -s "$SB/sudo.log" ] || fail "sudo must not run without a terminal: $(cat "$SB/sudo.log")"
"$BIN" ls >/dev/null || fail "the daemon should answer after the first run"

step "a second bare setu lists runs, with the help hint, and sets nothing up again"
"$BIN" adopt "$SB/oc/main" >/dev/null
"$BIN" > "$SB/bare2.out" 2>&1 < /dev/null || { cat "$SB/bare2.out"; fail "second bare setu failed"; }
cat "$SB/bare2.out"
grep -q "oc/main" "$SB/bare2.out" || fail "should list the adopted run"
grep -q "setu help" "$SB/bare2.out" || fail "should hint at setu help"
grep -q "Setting it up" "$SB/bare2.out" && fail "already set up: no setup" || true
[ "$(count 'launchctl bootstrap')" = 1 ] || fail "no second bootstrap"

step "setup --undo says how to remove the app and leaves it"
"$BIN" setup --undo > "$SB/undo.out" 2>&1 || fail "undo failed"
grep -q 'setu app uninstall' "$SB/undo.out" || fail "undo should mention `setu app uninstall`"
[ ! -e "$PLIST" ] || fail "undo should remove the plist"
[ "$(app_version)" = 0.2.0 ] || fail "undo must leave Setu.app alone"
wait_for 10 sock_down || true

step "setup --dry-run lists the app step and changes nothing"
rm -rf "$HOME/Applications"
"$BIN" setup --dry-run > "$SB/dry.out" 2>&1 || fail "dry run failed"
cat "$SB/dry.out"
grep -q "Install Setu.app" "$SB/dry.out" || fail "the plan should list the app"
[ ! -e "$PLIST" ] && [ ! -e "$HOME/Applications" ] || fail "dry run changed something"

step "doctor, mcp, migrate and app never set anything up"
"$BIN" doctor >/dev/null 2>&1 || true
"$BIN" app path >/dev/null 2>&1 || true
"$BIN" migrate plan >/dev/null 2>&1 || true
[ ! -e "$PLIST" ] || fail "doctor/app/migrate must not install the agent"
printf '%s\n%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","clientInfo":{"name":"e2e"}}}' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"run_list","arguments":{}}}' | timeout 20 "$BIN" mcp > "$SB/mcp.out" 2>&1 || true
grep -q 'run `setu` once' "$SB/mcp.out" || { cat "$SB/mcp.out"; fail "mcp should say to run setu once"; }
[ ! -e "$PLIST" ] || fail "mcp must never install the LaunchAgent"
[ "$(count 'launchctl bootstrap')" = 1 ] || fail "mcp must not bootstrap anything"

step "setu ls when not set up: one line, then the setup, then the output (stdout stays clean)"
"$BIN" ls --json > "$SB/ls.out" 2> "$SB/ls.err" < /dev/null || { cat "$SB/ls.err"; fail "ls failed"; }
grep -q "Setu isn't set up yet; setting it up now..." "$SB/ls.err" || fail "should say it is setting up"
[ "$(grep -c "isn't set up yet" "$SB/ls.err")" = 1 ] || fail "the line is printed once"
python3 -I -c 'import json,sys; json.load(open(sys.argv[1]))' "$SB/ls.out" || fail "stdout must stay valid JSON"
[ -f "$PLIST" ] || fail "ls should have installed the agent"
[ "$(count 'launchctl bootstrap')" = 2 ] || fail "one more bootstrap"
[ "$(app_version)" = 0.2.0 ] || fail "auto-setup installs the app too"

step "agent installed, daemon down: ls kickstarts it and continues"
kill "$(cat "$SB/daemon.pid")"; rm -f "$SB/daemon.pid"
wait_for 10 sock_down || fail "the daemon should be down"
B=$(count 'launchctl bootstrap')
"$BIN" ls > "$SB/ls2.out" 2> "$SB/ls2.err" < /dev/null || { cat "$SB/ls2.err"; fail "ls should recover the daemon"; }
grep -q "launchctl kickstart gui/$(id -u)/dev.setu.daemon" "$SB/calls.log" || fail "should kickstart the LaunchAgent"
[ "$(count 'launchctl bootstrap')" = "$B" ] || fail "an installed agent is not set up again"
[ ! -s "$SB/ls2.err" ] || fail "a plain restart prints nothing: $(cat "$SB/ls2.err")"

step "kickstart fails: the error and setu doctor"
kill "$(cat "$SB/daemon.pid")"; rm -f "$SB/daemon.pid"
wait_for 10 sock_down || fail "the daemon should be down"
touch "$SB/kick-fail"
if "$BIN" ls > /dev/null 2> "$SB/ls3.err" < /dev/null; then fail "ls should fail when the daemon cannot start"; fi
grep -q "setu daemon is not running" "$SB/ls3.err" && grep -q "setu doctor" "$SB/ls3.err" || { cat "$SB/ls3.err"; fail "error should include the old message and setu doctor"; }
rm -f "$SB/kick-fail"
"$BIN" ls >/dev/null 2>&1 || fail "recovers once kickstart works"
"$BIN" down oc/main >/dev/null 2>&1 || true
kill "$(cat "$SB/daemon.pid")"; rm -f "$SB/daemon.pid"; wait_for 10 sock_down || true

step "daemon start updates an older installed Setu.app"
rm -rf "$HOME/Applications"; fake "$HOME/Applications" 0.1.0
: > "$SB/daemon.log"
"$BIN" daemon >> "$SB/daemon.log" 2>&1 &
D=$!; PIDS+=("$D")
wait_for 15 app_is 0.2.0 || { cat "$SB/daemon.log"; fail "the installed app should be updated to the bundled version"; }
grep -q "updated ~/Applications/Setu.app to 0.2.0" "$SB/daemon.log" || fail "one log line"
kill "$D"; wait "$D" 2>/dev/null || true

step "a running app is never touched: update pending until it quits, then it updates"
rm -rf "$HOME/Applications"; fake "$HOME/Applications" 0.1.0
# a real process whose executable is inside the installed bundle (an ad-hoc signed copy of sleep)
rm -f "$HOME/Applications/Setu.app/Contents/MacOS/Setu"; cp /bin/sleep "$HOME/Applications/Setu.app/Contents/MacOS/Setu"
codesign -s - --force "$HOME/Applications/Setu.app/Contents/MacOS/Setu" >/dev/null 2>&1
"$HOME/Applications/Setu.app/Contents/MacOS/Setu" 120 &
APP=$!; PIDS+=("$APP")
sleep 0.5
: > "$SB/daemon.log"
"$BIN" daemon >> "$SB/daemon.log" 2>&1 &
D=$!; PIDS+=("$D")
wait_for 15 grep -q "update pending" "$SB/daemon.log" || { cat "$SB/daemon.log"; fail "the daemon should record a pending update"; }
sleep 3
[ "$(app_version)" = 0.1.0 ] || fail "the running app must not be replaced"
DOC=$("$BIN" doctor 2>&1 || true)
grep -q "Setu.app .*update pending: quit Setu to finish" <<<"$DOC" || { echo "$DOC"; fail "doctor should show the pending update"; }
kill "$APP"; wait "$APP" 2>/dev/null || true
wait_for 20 app_is 0.2.0 || { cat "$SB/daemon.log"; fail "the update should finish once the app has quit"; }
grep -q "updated ~/Applications/Setu.app to 0.2.0" "$SB/daemon.log" || fail "one log line when it finishes"
kill "$D"; wait "$D" 2>/dev/null || true

step "the daemon restarts itself when its binary is replaced (non-zero exit, runs stay up)"
cp "$BIN" "$SB/watched"
export SETU_RESTART_WATCH="$SB/watched"
: > "$SB/daemon.log"
"$BIN" daemon >> "$SB/daemon.log" 2>&1 &
D=$!; PIDS+=("$D")
wait_for 15 "$BIN" ls >/dev/null 2>&1 || fail "the daemon should start"
"$BIN" adopt "$SB/oc/main" >/dev/null 2>&1 || true
"$BIN" up "$SB/oc/main" >/dev/null || fail "up failed"
wait_for 20 bash -c "\"$BIN\" ls | grep -q 'oc/main .*running'" || fail "the run should be running"
PORT=$("$BIN" ls --json | python3 -I -c 'import json,sys; print(json.load(sys.stdin)[0]["ports"]["web"])')
sleep 4
kill -0 "$D" 2>/dev/null || { cat "$SB/daemon.log"; fail "an unchanged binary must not restart the daemon"; }
cp "$SB/watched" "$SB/watched.new"; mv "$SB/watched.new" "$SB/watched"   # a new file under the same name, as brew does
CODE=0; wait "$D" || CODE=$?
[ "$CODE" = 75 ] || { cat "$SB/daemon.log"; fail "the self-restart must exit non-zero (75), got $CODE"; }
grep -q "binary was replaced" "$SB/daemon.log" || fail "should log why it exited"
[ ! -S "$SETU_HOME/state/d.sock" ] || fail "the socket should be removed on the way out"
lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || fail "the dev server must stay up across the self-restart"
# the next daemon (what launchd starts) adopts it
"$BIN" daemon >> "$SB/daemon.log" 2>&1 &
D=$!; PIDS+=("$D")
wait_for 15 "$BIN" ls >/dev/null 2>&1 || fail "the next daemon should start"
"$BIN" ls | grep -q 'oc/main .*running' || fail "the next daemon should adopt the run"
"$BIN" down oc/main >/dev/null
kill "$D"; wait "$D" 2>/dev/null || true
echo; echo "onecmd e2e: all checks passed"
