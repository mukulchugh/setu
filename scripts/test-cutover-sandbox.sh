#!/bin/bash
# Proof that `setu migrate` (and the scripts/setu-cutover.sh wrapper) works and is reversible, entirely inside a
# sandbox: its own HOME and SETU_HOME, fixture v1 files and fake bare repos, and PATH shims for launchctl, brew,
# lsof and sudo that only log (the shim launchctl starts the sandbox daemon). Nothing outside /tmp/setu-cutover-proof
# is touched. The fixtures cover: a v1 portal on a non-default port, MCP configs for Claude Code (global and per
# project), Codex, Cursor, Claude Desktop, Gemini and a repo-level .mcp.json (other servers hold secret-looking
# values that must never be printed and must come back byte for byte), and a second cycle with no Caddy at all.
# Usage: scripts/test-cutover-sandbox.sh <path-to-setu-binary>
set -euo pipefail
BIN="$(cd "$(dirname "${1:?path to setu binary}")" && pwd)/$(basename "$1")"
HERE="$(cd "$(dirname "$0")" && pwd)"
SB=/tmp/setu-cutover-proof
export HOME="$SB/home"
export SETU_HOME="$SB/setu"
export SETU_LINK_DIR="$SB/home/linkdir"
export SB BIN
export PATH="$SB/shims:$PATH"
cleanup() {
  [ -f "$SB/daemon.pid" ] && kill "$(cat "$SB/daemon.pid")" 2>/dev/null || true
  [ -f "$SB/portal.pids" ] && while read -r p; do kill "$p" 2>/dev/null || true; done < "$SB/portal.pids"
  sleep 1
  rm -rf "${SB:?}"
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo; echo "== $*"; }
MIG() { "$BIN" migrate "$@"; }
CUT="$HERE/setu-cutover.sh"
SECRETS='BETA-SECRET|CURSOR-SECRET|GEM-SECRET|PROJ-SECRET|GLOBAL-SECRET|DESK-SECRET|REPO-SECRET|DO-NOT-READ|CODEX-SECRET'
nosecrets() { if grep -Eq "$SECRETS" "$1"; then fail "a secret value leaked into $1"; fi; }

rm -rf "${SB:?}"
WS="$HOME/workspace"
mkdir -p "$SB/shims" "$WS" "$HOME/.setu" "$HOME/.bun/bin" "$HOME/.codex" "$HOME/.cursor" "$HOME/.gemini" "$HOME/Library/Application Support/Claude" "$SETU_HOME/config"
G="git -c user.email=e@e -c user.name=e -c commit.gpgsign=false -c protocol.file.allow=always"
seed() { mkdir -p "$SB/seed-$1"; (cd "$SB/seed-$1" && $G init -q -b main . && echo hi > README.md && $G add -A && $G commit -q -m init); $G clone -q --bare "$SB/seed-$1" "$WS/$1.git"; $G -C "$WS/$1.git" worktree add -q "$WS/$1/main" main; }
seed alpha; seed beta
$G -C "$WS/alpha.git" worktree add -q -b feat/one "$WS/alpha/feat/one" main
$G -C "$WS/beta.git" worktree add -q -b feat/two "$WS/beta/feat/two" main

# ---- fixtures (odd formatting on purpose: byte-for-byte restore is checked)
printf 'alpha:3000:acme/alpha:A\nbeta:3100:acme/beta:B\n' > "$WS/.projects"
printf 'alpha/main:42001\nalpha/feat/one:42002\nbeta/main:42003\n' > "$WS/.ports"
printf '{"workspace":"%s","localZone":"e2e.localhost","cfCredentials":"DO-NOT-READ"}' "$WS" > "$HOME/.setu.json"
printf 'import "caddy.d/*.caddy"\n' > "$WS/Caddyfile"
cat > "$HOME/.zshrc" <<'Z'
export FOO=1
setu() { if [ "$1" = "cd" ]; then cd "$(command setu path "$2" "$3")" || return; else command setu "$@"; fi; }
Z
# Claude Code: a global server, a project server, and a v1 URL on the portal's real (non-default) port under another name
printf '{\n    "numStartups": 7,\n    "mcpServers": {"setu": {"type": "http", "url": "http://localhost:2999/mcp"}, "other": {"command": "x", "env": {"T": "GLOBAL-SECRET"}}},\n    "projects": {\n        "/some/project": {"allowedTools": [], "mcpServers": {"setu": {"type": "http", "url": "http://localhost:2999/mcp"}, "keepme": {"type": "http", "url": "https://x.test/mcp", "headers": {"Authorization": "PROJ-SECRET"}}}},\n        "/other/project": {"mcpServers": {"legacy": {"type": "http", "url": "http://localhost:3010/mcp"}}}\n    }\n}' > "$HOME/.claude.json"
cat > "$HOME/.codex/config.toml" <<'T'
model = "gpt"

[mcp_servers.setu]
url = "http://localhost:2999/mcp"

[mcp_servers.other]
command = "y"
token = "CODEX-SECRET"
T
printf '{"mcpServers":{"setu-old":{"url":"http://localhost:3010/mcp"},"cursor-other":{"command":"z","env":{"KEY":"CURSOR-SECRET"}}}}\n' > "$HOME/.cursor/mcp.json"
printf '{\n  "mcpServers": {\n    "setu": {"command": "/old/setu-v1", "args": ["mcp"]},\n    "desk-other": {"command": "d", "env": {"K": "DESK-SECRET"}}\n  }\n}\n' > "$HOME/Library/Application Support/Claude/claude_desktop_config.json"
printf '{\n  "theme": "dark",\n  "mcpServers": {\n    "setu": {"httpUrl": "http://localhost:3010/mcp", "trust": true},\n    "g-other": {"command": "q", "env": {"T": "GEM-SECRET"}}\n  }\n}\n' > "$HOME/.gemini/settings.json"
printf '{"mcpServers":{"setu":{"type":"http","url":"http://localhost:2999/mcp"},"repo-other":{"command":"r","env":{"R":"REPO-SECRET"}}}}' > "$WS/alpha/main/.mcp.json"
# a client file that is not valid JSON and quotes a token: it is skipped with a fixed message, never parsed aloud
printf '{"mcpServers": {"setu": {"command": "x", "env": {"T": "BETA-SECRET"' > "$WS/beta/main/.mcp.json"
echo "// fake v1 cli" > "$SB/fake-cli.js"; ln -s "$SB/fake-cli.js" "$HOME/.bun/bin/setu"
printf 'while :; do sleep 1; done\n' > "$HOME/.setu/portal.js"
cat > "$SETU_HOME/config/config.toml" <<'T'
proxy_port = 17791
stop_runs_on_exit = true
dns_port = 25355
T

# ---- shims: log only. lsof says the v1 portal listens on 3010 (not the default 2999) and that :80 is free.
cat > "$SB/shims/launchctl" <<'S'
#!/bin/bash
echo "launchctl $*" >> "$SB/calls.log"
# A fake Caddy LaunchAgent (label com.example.caddy) is loaded while $SB/caddy-agent-loaded exists.
case "$*" in
  *caddy*)
    case "$1" in
      print) [ -f "$SB/caddy-agent-loaded" ] && exit 0; exit 1 ;;
      bootout) rm -f "$SB/caddy-agent-loaded"; exit 0 ;;
      bootstrap) touch "$SB/caddy-agent-loaded"; exit 0 ;;
    esac ;;
esac
case "$1" in
  bootstrap) nohup env HOME="$HOME" SETU_HOME="$SETU_HOME" "$BIN" daemon >"$SB/daemon.log" 2>&1 </dev/null & echo $! > "$SB/daemon.pid"; exit 0 ;;
  bootout) [ -f "$SB/daemon.pid" ] && kill "$(cat "$SB/daemon.pid")" 2>/dev/null; rm -f "$SB/daemon.pid"; sleep 1; exit 0 ;;
  print) [ -f "$SB/daemon.pid" ] && kill -0 "$(cat "$SB/daemon.pid")" 2>/dev/null && exit 0; exit 1 ;;
esac
exit 0
S
cat > "$SB/shims/brew" <<'S'
#!/bin/bash
echo "brew $*" >> "$SB/calls.log"
case "$1 $2" in
  "services list") echo "Name Status User File"; echo "dnsmasq started root /x"; [ -n "${NO_CADDY:-}" ] || [ -f "$SB/caddy-stopped" ] || echo "caddy started user /x" ;;
  "services stop") [ -n "${BREW_FAIL:-}" ] && exit 1; touch "$SB/caddy-stopped" ;;
  "services start") rm -f "$SB/caddy-stopped" ;;
esac
exit 0
S
cat > "$SB/shims/lsof" <<'S'
#!/bin/bash
case "$*" in *-Fn*) echo "n*:3010"; exit 0 ;; esac
exit 1
S
printf '#!/bin/bash\necho "sudo $*" >> "$SB/calls.log"\nexit 1\n' > "$SB/shims/sudo"
chmod +x "$SB/shims"/*
bash "$HOME/.setu/portal.js" >/dev/null 2>&1 </dev/null & sleep 0.5
PORTAL=$(pgrep -f "$HOME/.setu/portal.js" | head -1); [ -n "$PORTAL" ] || fail "fake portal did not start"
echo "$PORTAL" > "$SB/portal.pids"
: > "$SB/calls.log"

FILES=".zshrc .claude.json .codex/config.toml .cursor/mcp.json Library/Application\ Support/Claude/claude_desktop_config.json .gemini/settings.json workspace/alpha/main/.mcp.json workspace/beta/main/.mcp.json .setu.json workspace/.ports workspace/.projects workspace/Caddyfile"
snap() { (cd "$HOME" && eval "for f in $FILES; do shasum -a 256 \"\$f\"; done"; readlink .bun/bin/setu); }
snap > "$SB/before.sum"
# every fixture file must exist (a typo here would make the byte-identical check vacuous)
[ "$(wc -l < "$SB/before.sum" | tr -d ' ')" = "13" ] || fail "snapshot should cover 12 files and the v1 link"

step "plan changes nothing, shows what was found, and never prints another server's values"
MIG plan > "$SB/plan.out" 2>&1 || { cat "$SB/plan.out"; fail "plan failed"; }
MIG > "$SB/plan-default.out" 2>&1 || fail "no subcommand should mean plan"
head -60 "$SB/plan.out"
grep -q "import-v1 dry run" "$SB/plan.out" || fail "plan should show the dry run"
grep -q "old portal .*running, pid $PORTAL, port 3010" "$SB/plan.out" || fail "plan should find the portal and its non-default port"
grep -q "caddy .*started (brew services)" "$SB/plan.out" || fail "plan should find caddy"
grep -q "dnsmasq .*running" "$SB/plan.out" || fail "plan should find dnsmasq"
grep -q "v1 CLI link" "$SB/plan.out" || fail "plan should find the v1 link"
grep -q "Cursor .*1 entry repointed (setu-old)" "$SB/plan.out" || fail "plan should find the cursor entry by the portal port"
grep -q "Gemini .*1 entry repointed (setu)" "$SB/plan.out" || fail "plan should find gemini"
grep -q "Claude Desktop .*1 entry repointed (setu)" "$SB/plan.out" || fail "plan should find claude desktop"
grep -q "alpha .mcp.json .*1 entry repointed (setu)" "$SB/plan.out" || fail "plan should find the repo .mcp.json"
grep -q "beta .mcp.json .*not valid JSON/TOML; skipped" "$SB/plan.out" || fail "plan should skip a file that does not parse"
grep -q "Claude Code .*3 entries repointed" "$SB/plan.out" || fail "plan should count global + project entries"
nosecrets "$SB/plan.out"
snap | diff - "$SB/before.sum" || fail "plan changed a fixture"
[ ! -e "$SETU_HOME/cutover-ledger.jsonl" ] || fail "plan must not write the ledger"
ls "$SETU_HOME"/cutover-2* >/dev/null 2>&1 && fail "plan must not make a backup folder" || true
grep -Ev '^brew services list' "$SB/calls.log" | grep -v '^launchctl print' && fail "plan made a mutating call" || true
kill -0 "$PORTAL" || fail "plan stopped the portal"
"$CUT" plan --binary "$BIN" > "$SB/wrapper-plan.out" 2>&1 || fail "the wrapper plan failed"
grep -q "setu migrate plan" "$SB/wrapper-plan.out" || fail "the old script name should still plan"

step "run without the confirmation flag is refused"
if MIG run >/dev/null 2>&1; then fail "run must need --yes"; fi
if "$CUT" run --binary "$BIN" >/dev/null 2>&1; then fail "the wrapper must need its confirmation flag"; fi
kill -0 "$PORTAL" || fail "refused run stopped the portal"

step "run --yes"
MIG run --yes > "$SB/run.out" 2>&1 || { cat "$SB/run.out"; echo "--- calls"; cat "$SB/calls.log"; echo "--- daemon"; cat "$SB/daemon.log" 2>/dev/null; fail "run failed"; }
cat "$SB/run.out"
nosecrets "$SB/run.out"
kill -0 "$PORTAL" 2>/dev/null && fail "old portal should be stopped"
grep -q "brew services stop caddy" "$SB/calls.log" || fail "caddy not stopped"
grep -q "launchctl bootstrap" "$SB/calls.log" || fail "setup did not bootstrap"
[ ! -e "$HOME/.bun/bin/setu" ] || fail "v1 link should be gone"
INSTALLED="$SETU_HOME/bin/setu"
[ -x "$INSTALLED" ] && [ ! -L "$INSTALLED" ] || fail "the binary should be copied (not linked) to $INSTALLED"
cmp "$INSTALLED" "$BIN" || fail "the copy differs from the running binary"
[ "$(readlink "$SETU_LINK_DIR/setu")" = "$INSTALLED" ] || fail "setu link missing"
grep -q "$INSTALLED" "$HOME/Library/LaunchAgents/dev.setu.daemon.plist" || fail "the LaunchAgent must run the installed copy"
CMDPATH="$INSTALLED" python3 -I - "$HOME" <<'PY' || fail "client configs not repointed correctly"
import json, os, sys
home, cmd = sys.argv[1], os.environ["CMDPATH"]
J = lambda p: json.load(open(os.path.join(home, p)))
stdio = {"type": "stdio", "command": cmd, "args": ["mcp"]}
plain = {"command": cmd, "args": ["mcp"]}
c = J(".claude.json")
assert c["mcpServers"]["setu"] == stdio and c["mcpServers"]["other"] == {"command": "x", "env": {"T": "GLOBAL-SECRET"}} and c["numStartups"] == 7, c
p = c["projects"]
assert p["/some/project"]["mcpServers"]["setu"] == stdio and p["/some/project"]["allowedTools"] == []
assert p["/some/project"]["mcpServers"]["keepme"] == {"type": "http", "url": "https://x.test/mcp", "headers": {"Authorization": "PROJ-SECRET"}}
assert p["/other/project"]["mcpServers"]["legacy"] == stdio, "a v1 url on the portal's real port is repointed under its own name"
cu = J(".cursor/mcp.json")["mcpServers"]
assert cu["setu-old"] == plain and cu["cursor-other"] == {"command": "z", "env": {"KEY": "CURSOR-SECRET"}}, cu
d = J("Library/Application Support/Claude/claude_desktop_config.json")["mcpServers"]
assert d["setu"] == plain and d["desk-other"]["env"] == {"K": "DESK-SECRET"}, d
g = J(".gemini/settings.json")
assert g["theme"] == "dark" and g["mcpServers"]["setu"] == plain and g["mcpServers"]["g-other"]["env"] == {"T": "GEM-SECRET"}, g
r = J("workspace/alpha/main/.mcp.json")["mcpServers"]
assert r["setu"] == stdio and r["repo-other"]["env"] == {"R": "REPO-SECRET"}, r
PY
grep -q "command = \"$INSTALLED\"" "$HOME/.codex/config.toml" || fail "codex config not repointed"
grep -q 'args = \["mcp"\]' "$HOME/.codex/config.toml" || fail "codex args missing"
grep -q '^\[mcp_servers.other\]' "$HOME/.codex/config.toml" || fail "codex other table lost"
grep -q 'token = "CODEX-SECRET"' "$HOME/.codex/config.toml" || fail "codex other value lost"
! grep -q "localhost:2999" "$HOME/.codex/config.toml" || fail "codex still points at v1"
"$SETU_LINK_DIR/setu" ls
[ "$("$SETU_LINK_DIR/setu" ls --json | python3 -I -c 'import json,sys; print(len(json.load(sys.stdin)))')" = "4" ] || fail "expected 4 adopted runs"
L="$SETU_HOME/cutover-ledger.jsonl"
grep -q "beta/main/.mcp.json is not valid" "$SB/run.out" || fail "run should say it skipped the invalid file"
grep -q '"step":"7","status":"ok"' "$L" || fail "ledger missing step 7"
grep -q '"action":"adopted"' "$L" || fail "ledger missing adoptions"
nosecrets "$L"
cut -c1-150 "$L"

step "a second run is refused until rollback"
if MIG run --yes >/dev/null 2>&1; then fail "second run should be refused"; fi

step "rollback"
MIG rollback | tee "$SB/rollback.out"
nosecrets "$SB/rollback.out"
snap | diff - "$SB/before.sum" || fail "fixtures differ after rollback"
[ -L "$HOME/.bun/bin/setu" ] || fail "v1 link not restored"
[ ! -e "$SETU_LINK_DIR/setu" ] || fail "our link should be removed"
[ ! -e "$INSTALLED" ] || fail "the copied binary should be removed"
grep -q "brew services start caddy" "$SB/calls.log" || fail "caddy not restarted"
sleep 1; pgrep -f "$HOME/.setu/portal.js" >> "$SB/portal.pids" || fail "old portal not restarted"
[ ! -f "$SB/daemon.pid" ] || fail "daemon should be stopped by setup --undo"
[ ! -e "$HOME/Library/LaunchAgents/dev.setu.daemon.plist" ] || fail "plist should be removed"
MIG rollback > "$SB/rollback2.out" || fail "second rollback failed"
grep -q "already rolled back" "$SB/rollback2.out" || fail "second rollback should be a no-op"
echo "(byte-for-byte: all 12 fixture files and the v1 link identical to before the run)"

step "a config edited after the migration keeps the edit; only the Setu entries come back"
MIG run --yes >/dev/null 2>&1 || fail "run (3) failed"
python3 -I - "$HOME/.cursor/mcp.json" <<'PY'
import json, sys
p = sys.argv[1]; v = json.load(open(p)); v["mcpServers"]["added-later"] = {"command": "new"}; json.dump(v, open(p, "w"))
PY
MIG rollback > "$SB/rollback3.out" 2>&1 || { cat "$SB/rollback3.out"; fail "rollback (3) failed"; }
grep -q "changed since the migration" "$SB/rollback3.out" || fail "should say it restored only the entries"
python3 -I -c 'import json,sys; s=json.load(open(sys.argv[1]))["mcpServers"]; assert s["setu-old"]=={"url":"http://localhost:3010/mcp"} and s["added-later"]=={"command":"new"} and s["cursor-other"]["env"]=={"KEY":"CURSOR-SECRET"}, s' "$HOME/.cursor/mcp.json" || fail "partial restore wrong"
# put the cursor fixture back for the next checks
printf '{"mcpServers":{"setu-old":{"url":"http://localhost:3010/mcp"},"cursor-other":{"command":"z","env":{"KEY":"CURSOR-SECRET"}}}}\n' > "$HOME/.cursor/mcp.json"
sleep 1; pgrep -f "$HOME/.setu/portal.js" >> "$SB/portal.pids" || fail "old portal not restarted (3)"
snap | diff - "$SB/before.sum" || fail "fixtures differ after rollback (3)"

step "no Caddy at all: the Caddy step is skipped with a note, run and rollback still work"
: > "$SB/calls.log"
rm -f "$SB/caddy-stopped"
export NO_CADDY=1
MIG plan > "$SB/plan2.out" 2>&1 || fail "plan (no caddy) failed"
grep -q "caddy .*not found .*skips the Caddy step" "$SB/plan2.out" || fail "plan should say caddy was not found"
MIG run --yes > "$SB/run2.out" 2>&1 || { cat "$SB/run2.out"; fail "run without caddy failed"; }
grep -q "no caddy found; skipped" "$SB/run2.out" || fail "run should say it skipped caddy"
grep -q "brew services stop" "$SB/calls.log" && fail "no caddy: nothing may be stopped" || true
MIG rollback >/dev/null || fail "rollback without caddy failed"
grep -q "brew services start" "$SB/calls.log" && fail "no caddy: nothing may be started" || true
snap | diff - "$SB/before.sum" || fail "fixtures differ after the no-caddy rollback"
sleep 1; pgrep -f "$HOME/.setu/portal.js" >> "$SB/portal.pids" || fail "old portal not restarted (no caddy)"
unset NO_CADDY

step "Caddy as a LaunchAgent (no brew service): run unloads it, rollback reloads the same plist byte for byte"
AGENT_PLIST="$HOME/Library/LaunchAgents/com.example.caddy.plist"
mkdir -p "$HOME/Library/LaunchAgents"
printf '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>com.example.caddy</string>\n<key>ProgramArguments</key><array><string>/opt/homebrew/bin/caddy</string><string>run</string></array></dict></plist>' > "$AGENT_PLIST"
AGENT_SUM=$(shasum -a 256 "$AGENT_PLIST")
touch "$SB/caddy-agent-loaded"
: > "$SB/calls.log"
export NO_CADDY=1
MIG plan > "$SB/plan5.out" 2>&1 || fail "plan (caddy agent) failed"
grep -q "caddy .*LaunchAgent com.example.caddy .*unloads it" "$SB/plan5.out" || { cat "$SB/plan5.out"; fail "plan should find the caddy LaunchAgent"; }
MIG run --yes > "$SB/run5.out" 2>&1 || { cat "$SB/run5.out"; fail "run with a caddy LaunchAgent failed"; }
grep -q "caddy stopped (LaunchAgent com.example.caddy)" "$SB/run5.out" || fail "run should say it unloaded the agent"
grep -q "^launchctl bootout gui/[0-9]*/com.example.caddy$" "$SB/calls.log" || { cat "$SB/calls.log"; fail "run did not bootout the caddy agent"; }
[ ! -f "$SB/caddy-agent-loaded" ] || fail "the caddy agent should be unloaded after run"
grep -q "brew services stop" "$SB/calls.log" && fail "an agent-run caddy must not go through brew" || true
[ "$(shasum -a 256 "$AGENT_PLIST")" = "$AGENT_SUM" ] || fail "the caddy plist changed during run"
MIG rollback > "$SB/rollback5.out" 2>&1 || { cat "$SB/rollback5.out"; fail "rollback (caddy agent) failed"; }
grep -q "^launchctl bootstrap gui/[0-9]* $AGENT_PLIST$" "$SB/calls.log" || { cat "$SB/calls.log"; fail "rollback did not bootstrap the same caddy plist"; }
[ -f "$SB/caddy-agent-loaded" ] || fail "the caddy agent should be loaded again after rollback"
[ "$(shasum -a 256 "$AGENT_PLIST")" = "$AGENT_SUM" ] || fail "the caddy plist is not byte-identical after rollback"
grep -q "brew services start" "$SB/calls.log" && fail "an agent-run caddy must not be started through brew" || true
snap | diff - "$SB/before.sum" || fail "fixtures differ after the caddy-agent rollback"
sleep 1; pgrep -f "$HOME/.setu/portal.js" >> "$SB/portal.pids" || fail "old portal not restarted (caddy agent)"
rm -f "$AGENT_PLIST" "$SB/caddy-agent-loaded"
unset NO_CADDY

step "failure midway: caddy refuses to stop -> run stops, says how to roll back, rollback restores"
OUT=$(BREW_FAIL=1 MIG run --yes 2>&1) && fail "run should have failed"
echo "$OUT" | tail -4
echo "$OUT" | grep -q "rollback with: setu migrate rollback" || fail "failure must say how to roll back"
MIG rollback
snap | diff - "$SB/before.sum" || fail "fixtures differ after the second rollback"
[ -L "$HOME/.bun/bin/setu" ] || fail "v1 link not restored (2)"
[ ! -e "$INSTALLED" ] || fail "the copied binary should be removed (2)"
sleep 1; pgrep -f "$HOME/.setu/portal.js" >> "$SB/portal.pids" || fail "old portal not restarted (2)"
step "the install link path already holds the v1 link: it is replaced once, and rollback puts the v1 link back"
export SETU_LINK_DIR="$HOME/.bun/bin"
MIG plan > "$SB/plan4.out" 2>&1 || fail "plan (link at the v1 path) failed"
MIG run --yes > "$SB/run4.out" 2>&1 || { cat "$SB/run4.out"; fail "run with the link at the v1 path failed"; }
[ "$(readlink "$HOME/.bun/bin/setu")" = "$INSTALLED" ] || fail "the link at the v1 path should now point at the install"
MIG rollback > "$SB/rollback4.out" 2>&1 || { cat "$SB/rollback4.out"; fail "rollback (link at the v1 path) failed"; }
snap | diff - "$SB/before.sum" || fail "fixtures (or the v1 link) differ after rollback (link at the v1 path)"
sleep 1; pgrep -f "$HOME/.setu/portal.js" >> "$SB/portal.pids" || fail "old portal not restarted (link at the v1 path)"
export SETU_LINK_DIR="$SB/home/linkdir"

step "a migration made by the ORIGINAL bash script (different backup layout) is rolled back by setu migrate rollback"
LEG="$HERE/fixtures/setu-cutover-legacy.sh"
: > "$SB/calls.log"
"$LEG" run --binary "$BIN" --yes-i-have-reviewed-the-plan > "$SB/legacy.out" 2>&1 || { cat "$SB/legacy.out"; fail "the original script's run failed"; }
[ ! -e "$HOME/.bun/bin/setu" ] || fail "legacy run should have removed the v1 link"
grep -q "brew services stop caddy" "$SB/calls.log" || fail "legacy run should have stopped caddy"
ls "$SETU_HOME"/cutover-2*/flags/claude-touched >/dev/null 2>&1 || fail "this is not a legacy-layout backup"
MIG rollback > "$SB/legacy-rollback.out" 2>&1 || { cat "$SB/legacy-rollback.out"; fail "rollback of a legacy migration failed"; }
cat "$SB/legacy-rollback.out"
snap | diff - "$SB/before.sum" || fail "fixtures differ after rolling back a legacy migration"
[ -L "$HOME/.bun/bin/setu" ] || fail "legacy: v1 link not restored"
grep -q "brew services start caddy" "$SB/calls.log" || fail "legacy: caddy not restarted"
sleep 1; pgrep -f "$HOME/.setu/portal.js" >> "$SB/portal.pids" || fail "legacy: old portal not restarted"
[ ! -e "$SETU_LINK_DIR/setu" ] || fail "legacy: our link should be removed"
echo; echo "cutover sandbox proof: all checks passed"
