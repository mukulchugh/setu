#!/bin/bash
# FIXTURE: the original bash cutover script, kept only so test-cutover-sandbox.sh can prove that `setu migrate rollback`
# undoes a migration made by it (its backup folder has a different layout from the one `setu migrate` writes).
# setu-cutover: move this machine from the old JS Setu (v1) to the Rust Setu. Plan: docs/slices/10-cutover.md.
#
#   setu-cutover plan     [--binary PATH]                               read-only preflight + import-v1 dry run
#   setu-cutover run      [--binary PATH] --yes-i-have-reviewed-the-plan   do it (stops at the first failure)
#   setu-cutover rollback                                                 undo it from the step-0 backups
#
# Every step is appended to the ledger ($DATA/cutover-ledger.jsonl, shared with `setu import-v1`).
# Backups go to $DATA/cutover-<ts>/. $DATA is $SETU_HOME if set, else ~/.local/share/setu.
#
# Order. The doc lists "adopt worktrees" as step 2, but adoption writes through the new daemon, and
# the daemon should come up on :80 first (otherwise every adopted run would carry a :7777 URL).
# So the steps run as: 0 preflight, 1 review, 3 install, 4 stop v1, 5 setup, 2 adopt, 6 MCP, 7 verify.
#
# Test hooks (used by the sandboxed proof, harmless otherwise): HOME, SETU_HOME, SETU_LINK_DIR
# (where the `setu` symlink goes, default ~/.local/bin).
set -u

HOME_DIR="${HOME:?HOME must be set}"
DATA="${SETU_HOME:-$HOME_DIR/.local/share/setu}"
LEDGER="$DATA/cutover-ledger.jsonl"
LINK_DIR="${SETU_LINK_DIR:-$HOME_DIR/.local/bin}"
BIN="${SETU_BINARY:-}"
CMD="${1:-}"; shift || true
CONFIRMED=no
while [ $# -gt 0 ]; do
  case "$1" in
    --binary) BIN="${2:?--binary needs a path}"; shift 2 ;;
    --yes-i-have-reviewed-the-plan) CONFIRMED=yes; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf 'setu-cutover: %s\n' "$*" >&2; exit 1; }
esc() { local s=${1//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/ }; printf '%s' "$s"; }
led() { # led <step> <status> [detail]
  mkdir -p "$DATA"
  printf '{"ts":%s,"source":"setu-cutover","step":"%s","status":"%s","detail":"%s"}\n' "$(date +%s)" "$(esc "$1")" "$(esc "$2")" "$(esc "${3:-}")" >> "$LEDGER"
}

# ---- v1 locations (only the workspace key of ~/.setu.json is read)
workspace() {
  local w=""
  if [ -f "$HOME_DIR/.setu.json" ]; then
    w=$(python3 -I -c 'import json,sys; v=json.load(open(sys.argv[1])); print(v.get("workspace","") if isinstance(v.get("workspace",""),str) else "")' "$HOME_DIR/.setu.json" 2>/dev/null || true)
  fi
  [ -n "$w" ] || w="$HOME_DIR/workspace"
  case "$w" in "~/"*) w="$HOME_DIR/${w#\~/}" ;; esac
  printf '%s' "$w"
}
WS="$(workspace)"
PORTAL_JS="$HOME_DIR/.setu/portal.js"
BUN_LINK="$HOME_DIR/.bun/bin/setu"
CLAUDE_JSON="$HOME_DIR/.claude.json"
CODEX_TOML="$HOME_DIR/.codex/config.toml"
FILES_TO_BACK_UP=("$HOME_DIR/.zshrc" "$CLAUDE_JSON" "$CODEX_TOML" "$HOME_DIR/.setu.json" "$WS/.ports" "$WS/.projects" "$WS/Caddyfile")

port80_holder() { lsof -nP -iTCP:80 -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print $1" (pid "$2")"}'; }
portal_pid() { pgrep -f "$PORTAL_JS" 2>/dev/null | head -1; }
portal_pids() { pgrep -f "$PORTAL_JS" 2>/dev/null; }
caddy_started() { brew services list 2>/dev/null | awk '$1=="caddy"{print $2}' | grep -qx started; }

check_binary() {
  [ -n "$BIN" ] || die "no new binary: pass --binary /path/to/setu (the release build)"
  [ -x "$BIN" ] || die "$BIN is not executable"
  local v; v=$("$BIN" --version 2>&1) || die "$BIN --version failed: $v"
  case "$v" in setu\ *) ;; *) die "$BIN does not look like the new setu ($v)";; esac
}

# ---- JSON/TOML edits for the agent MCP configs (python3 stdlib only; never prints values)
mcp_edit() { python3 -I - "$@" <<'PY'
import json, os, re, shutil, sys, tempfile
mode, path, arg = sys.argv[1], sys.argv[2], sys.argv[3]

def atomic_write(p, text):
    d = os.path.dirname(p) or "."
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".setu-cutover-")
    with os.fdopen(fd, "w") as f:
        f.write(text)
    if os.path.exists(p):
        shutil.copymode(p, tmp)
    os.replace(tmp, p)

def codex_block(text):
    """(start, end) of the [mcp_servers.setu] table and its sub-tables, or None."""
    lines = text.split("\n")
    start = None
    for i, l in enumerate(lines):
        if l.strip() == "[mcp_servers.setu]":
            start = i
            break
    if start is None:
        return lines, None, None
    end = len(lines)
    for j in range(start + 1, len(lines)):
        s = lines[j].strip()
        if s.startswith("[") and not s.startswith("[mcp_servers.setu."):
            end = j
            break
    return lines, start, end

if mode == "claude-set":
    data = json.load(open(path))
    data.setdefault("mcpServers", {})["setu"] = {"type": "stdio", "command": arg, "args": ["mcp"]}
    atomic_write(path, json.dumps(data, indent=2) + "\n")
elif mode == "claude-restore":
    cur = json.load(open(path))
    old = json.load(open(arg)).get("mcpServers", {}).get("setu", None) if os.path.exists(arg) else None
    servers = cur.setdefault("mcpServers", {})
    if old is None:
        servers.pop("setu", None)
    else:
        servers["setu"] = old
    atomic_write(path, json.dumps(cur, indent=2) + "\n")
elif mode == "codex-set":
    text = open(path).read() if os.path.exists(path) else ""
    new = ['[mcp_servers.setu]', 'command = %s' % json.dumps(arg), 'args = ["mcp"]', ""]
    lines, s, e = codex_block(text)
    if s is None:
        out = text.rstrip("\n") + ("\n\n" if text.strip() else "") + "\n".join(new)
    else:
        out = "\n".join(lines[:s] + new + lines[e:])
    atomic_write(path, out)
elif mode == "codex-restore":
    text = open(path).read()
    btext = open(arg).read() if os.path.exists(arg) else ""
    _, bs, be = codex_block(btext)
    old = btext.split("\n")[bs:be] if bs is not None else []
    lines, s, e = codex_block(text)
    if s is None:
        out = text if not old else text.rstrip("\n") + "\n\n" + "\n".join(old) + "\n"
    else:
        out = "\n".join(lines[:s] + old + lines[e:])
    atomic_write(path, out)
else:
    sys.exit("bad mode")
PY
}

sha() { shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1; }

latest_backup() { ls -d "$DATA"/cutover-2* 2>/dev/null | sort | tail -1; }

# =====================================================================================
cmd_plan() {
  say "setu-cutover plan (read-only: nothing is changed)"
  say "  HOME: $HOME_DIR   workspace: $WS   data: $DATA"
  local missing=0
  for f in "${FILES_TO_BACK_UP[@]}"; do
    if [ -e "$f" ]; then say "  will back up: $f"; else say "  absent (nothing to back up): $f"; fi
  done
  say "  backups go to: $DATA/cutover-<timestamp>/"
  local prior; prior=$(latest_backup)
  if [ -n "$prior" ] && [ ! -e "$prior/flags/rolled-back" ]; then
    say "  WARNING: an earlier cutover exists at $prior and was not rolled back; 'run' will refuse until it is"
  fi
  local pid; pid=$(portal_pid)
  if [ -n "$pid" ]; then say "  old portal: running (pid $pid), will be stopped"; else say "  old portal: not running"; fi
  if caddy_started; then say "  caddy: started (brew services), will be stopped"; else say "  caddy: not started"; fi
  local h; h=$(port80_holder)
  if [ -n "$h" ]; then say "  port 80: held by $h"; else say "  port 80: free"; fi
  if [ -L "$BUN_LINK" ]; then say "  v1 CLI link: $BUN_LINK -> $(readlink "$BUN_LINK") (will be removed; rollback relinks)"; fi
  if [ -f "$HOME_DIR/.zshrc" ] && grep -q 'command setu path' "$HOME_DIR/.zshrc"; then
    say "  zsh function: found (calls 'command setu path'; compatible, left as is)"
  else
    say "  zsh function: NOT found in ~/.zshrc; 'setu cd' will not work until it is added"
  fi
  if [ -z "$BIN" ]; then
    say "  binary: none given. Pass --binary to include the import-v1 dry run and the setup sudo check."
    return 0
  fi
  check_binary
  say "  binary: $BIN ($("$BIN" --version))"
  say ""
  say "setu setup would:"
  "$BIN" setup --dry-run 2>&1 | sed 's/^/  /'
  say ""
  say "import-v1 dry run:"
  "$BIN" import-v1 2>&1 | sed 's/^/  /'
  say ""
  say "Nothing was changed. To go ahead: setu-cutover run --binary $BIN --yes-i-have-reviewed-the-plan"
}

# =====================================================================================
BK=""        # backup dir of this run
flag() { mkdir -p "$BK/flags"; printf '%s\n' "${2:-1}" > "$BK/flags/$1"; }
flagged() { [ -e "$BK/flags/$1" ]; }

step_fail() { # step_fail <step> <message>
  led "$1" failed "$2"
  printf '\nsetu-cutover: step %s FAILED: %s\n' "$1" "$2" >&2
  printf 'rollback with: setu-cutover rollback\n' >&2
  exit 1
}

step0_preflight() {
  led 0 start "preflight and backups"
  check_binary 2>&1 || step_fail 0 "binary check failed"
  local prior; prior=$(latest_backup)
  if [ -n "$prior" ] && [ ! -e "$prior/flags/rolled-back" ]; then
    step_fail 0 "an earlier cutover at $prior was not rolled back; run: setu-cutover rollback"
  fi
  local ts; ts=$(date +%Y%m%d-%H%M%S)
  BK="$DATA/cutover-$ts"
  mkdir -p "$BK/files" "$BK/flags" || step_fail 0 "cannot create $BK"
  chmod 700 "$BK" "$BK/files"
  : > "$BK/manifest"
  local f n=0
  for f in "${FILES_TO_BACK_UP[@]}"; do
    if [ -e "$f" ]; then
      n=$((n+1))
      cp -p "$f" "$BK/files/$n" || step_fail 0 "cannot back up $f"
      printf '%s\t%s\n' "$n" "$f" >> "$BK/manifest"
    fi
  done
  printf '%s\n' "$BIN" > "$BK/binary"
  # the new setu's own database, if any (point-in-time copy; restoring it is a manual step)
  if [ -d "${SETU_HOME:+$SETU_HOME/state}" ] || [ -d "$HOME_DIR/Library/Application Support/Setu" ]; then
    local sd="${SETU_HOME:+$SETU_HOME/state}"; [ -n "$sd" ] || sd="$HOME_DIR/Library/Application Support/Setu"
    mkdir -p "$BK/db"; cp -p "$sd"/setu.db* "$BK/db/" 2>/dev/null || true
  fi
  # v1 state needed to undo steps 3, 4
  [ -L "$BUN_LINK" ] && readlink "$BUN_LINK" > "$BK/bun-link-target"
  local pid; pid=$(portal_pid)
  if [ -n "$pid" ]; then ps -o command= -p "$pid" > "$BK/portal-command"; printf '%s\n' "$pid" > "$BK/portal-pid"; fi
  if caddy_started; then flag caddy-was-started; fi
  led 0 ok "backups in $BK ($n files)"
  say "step 0 ok: preflight passed, backups in $BK"
}

step1_review() {
  led 1 start "import-v1 dry run"
  "$BIN" import-v1 > "$BK/import-plan.txt" 2>&1 || step_fail 1 "import-v1 dry run failed: $(tail -3 "$BK/import-plan.txt")"
  led 1 ok "plan saved to $BK/import-plan.txt"
  say "step 1 ok: import-v1 dry run saved to $BK/import-plan.txt ($(wc -l < "$BK/import-plan.txt" | tr -d ' ') lines)"
}

step3_install() {
  led 3 start "install $BIN to $LINK_DIR/setu, remove v1 link"
  mkdir -p "$LINK_DIR" || step_fail 3 "cannot create $LINK_DIR"
  local dest="$LINK_DIR/setu"
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    if [ -L "$dest" ]; then
      readlink "$dest" > "$BK/install-prev-target"
    else
      step_fail 3 "$dest exists and is not a symlink; move it away first"
    fi
  fi
  ln -sfn "$BIN" "$dest" || step_fail 3 "cannot link $dest"
  flag installed "$dest"
  if [ -L "$BUN_LINK" ]; then
    rm "$BUN_LINK" || step_fail 3 "cannot remove $BUN_LINK"
    flag bun-link-removed
  fi
  led 3 ok "linked $dest -> $BIN"
  say "step 3 ok: $dest -> $BIN; v1 link removed (if there was one)"
}

wait_port80_free() {
  local i
  for i in $(seq 1 20); do
    [ -z "$(port80_holder)" ] && return 0
    sleep 0.5
  done
  return 1
}

step4_stop_v1() {
  led 4 start "stop old portal and caddy"
  local pid pids; pid=$(portal_pid); pids=$(portal_pids)
  if [ -n "$pid" ]; then
    local p
    for p in $pids; do
      case "$(ps -o command= -p "$p" 2>/dev/null)" in *portal.js*) ;; *) step_fail 4 "pid $p is not the old portal";; esac
    done
    flag portal-stopped
    for p in $pids; do kill -TERM "$p" 2>/dev/null; done
    local i; for i in $(seq 1 20); do [ -z "$(portal_pids)" ] && break; sleep 0.5; done
    if [ -n "$(portal_pids)" ]; then step_fail 4 "the old portal (pid $pid) did not stop"; fi
  fi
  if caddy_started; then
    flag caddy-stopped
    brew services stop caddy >/dev/null 2>&1 || step_fail 4 "brew services stop caddy failed"
    wait_port80_free || step_fail 4 "port 80 is still held by $(port80_holder) after stopping caddy"
  fi
  led 4 ok "portal ${pid:-none}; caddy $(flagged caddy-stopped && echo stopped || echo 'was not running')"
  say "step 4 ok: old portal and caddy stopped"
}

step5_setup() {
  led 5 start "setu setup"
  local plan; plan=$("$SETU" setup --dry-run 2>&1) || step_fail 5 "setu setup --dry-run failed: $plan"
  if printf '%s' "$plan" | grep -q '\[sudo\]'; then
    step_fail 5 "setup needs sudo steps (shown below); run 'setu setup' yourself, then re-run: $plan"
  fi
  flag setup-attempted
  "$SETU" setup --yes >"$BK/setup.out" 2>&1 || step_fail 5 "setu setup failed: $(tail -3 "$BK/setup.out")"
  local i
  for i in $(seq 1 40); do "$SETU" ls >/dev/null 2>&1 && break; sleep 0.5; done
  "$SETU" ls >/dev/null 2>&1 || step_fail 5 "the daemon did not answer after setup"
  flag setup-done
  led 5 ok "daemon up"
  say "step 5 ok: setup done, daemon answering"
}

step2_adopt() {
  led 2 start "adopt worktrees and import port leases"
  "$SETU" import-v1 --apply > "$BK/import-apply.txt" 2>&1 || step_fail 2 "import-v1 --apply failed: $(tail -3 "$BK/import-apply.txt")"
  flag imported
  led 2 ok "$(tail -3 "$BK/import-apply.txt" | head -1)"
  say "step 2 ok: $(grep -E '^adopted [0-9]+ worktree' "$BK/import-apply.txt" | tail -1)"
}

step6_mcp() {
  led 6 start "repoint agent MCP to setu mcp"
  local cmd="$LINK_DIR/setu"
  if [ -f "$CLAUDE_JSON" ]; then
    flag claude-touched
    mcp_edit claude-set "$CLAUDE_JSON" "$cmd" || step_fail 6 "could not edit $CLAUDE_JSON"
    sha "$CLAUDE_JSON" > "$BK/flags/claude-sha"
  fi
  if [ -f "$CODEX_TOML" ]; then
    flag codex-touched
    mcp_edit codex-set "$CODEX_TOML" "$cmd" || step_fail 6 "could not edit $CODEX_TOML"
    sha "$CODEX_TOML" > "$BK/flags/codex-sha"
  fi
  led 6 ok "claude: $(flagged claude-touched && echo repointed || echo 'no file'); codex: $(flagged codex-touched && echo repointed || echo 'no file')"
  say "step 6 ok: MCP configs repoint to '$cmd mcp' (restart Claude Code and Codex to pick it up)"
}

step7_verify() {
  led 7 start "verify"
  "$SETU" doctor >"$BK/doctor.out" 2>&1 || step_fail 7 "doctor reported problems: $(grep -E '^FAIL|fix:' "$BK/doctor.out" | head -6 | tr '\n' ' ')"
  local n; n=$("$SETU" ls --json 2>/dev/null | python3 -I -c 'import json,sys; print(len(json.load(sys.stdin)))' 2>/dev/null || echo 0)
  [ "${n:-0}" -gt 0 ] || step_fail 7 "setu ls shows no runs"
  # one main URL and one branch URL must be answered by the proxy (any HTTP status; a browser-style request
  # gets an immediate "Starting..." page instead of waiting, and the run starts on demand)
  local urls; urls=$("$SETU" ls --json | python3 -I -c '
import json,sys
rs=json.load(sys.stdin)
main=[r for r in rs if r["run"].endswith("/main")][:1]
br=[r for r in rs if not r["run"].endswith("/main")][:1]
for r in main+br: print(r["url"])')
  local u code host port
  for u in $urls; do
    host=${u#http://}; host=${host%%/*}; port=80
    case "$host" in *:*) port=${host##*:}; host=${host%%:*};; esac
    code=$(curl -s -o /dev/null -H 'Accept: text/html' -w '%{http_code}' --max-time 30 --resolve "$host:$port:127.0.0.1" "$u/" 2>/dev/null)
    case "$code" in 000|"") step_fail 7 "$u did not answer through the proxy";; esac
    say "  $u answered HTTP $code"
  done
  # MCP: the stdio server must list run_list
  local tools; tools=$(printf '%s\n%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"cutover","version":"0"}}}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | "$SETU" mcp 2>/dev/null)
  printf '%s' "$tools" | grep -q 'run_list' || step_fail 7 "setu mcp did not list run_list"
  flag verified
  led 7 ok "doctor ok, $n runs, URLs answered, mcp lists run_list"
  say "step 7 ok: doctor passes, $n runs, URLs answered, MCP lists run_list"
  say ""
  say "Still by hand: one sign-in through :80, and MCP run_list from Claude and from Codex after restarting them."
}

cmd_run() {
  [ "$CONFIRMED" = yes ] || die "refusing to run without --yes-i-have-reviewed-the-plan (review 'setu-cutover plan' first)"
  step0_preflight
  SETU="$LINK_DIR/setu"
  step1_review
  step3_install
  step4_stop_v1
  step5_setup
  step2_adopt
  step6_mcp
  step7_verify
  flag complete
  led run complete "cutover done; backups in $BK"
  say ""
  say "cutover complete. Undo with: setu-cutover rollback"
}

# =====================================================================================
cmd_rollback() {
  BK=$(latest_backup)
  [ -n "$BK" ] || die "no cutover backup found in $DATA; nothing to roll back"
  if flagged rolled-back; then say "already rolled back ($BK)"; return 0; fi
  [ -s "$BK/binary" ] || die "$BK has no recorded binary"
  local bin; bin=$(cat "$BK/binary")
  local setu="$bin"
  led rollback start "from $BK"
  local fails=0
  rb() { # rb <label> <command...>
    local label=$1; shift
    if "$@" >>"$BK/rollback.out" 2>&1; then say "  rollback: $label"; else say "  rollback FAILED: $label (see $BK/rollback.out)"; fails=$((fails+1)); fi
  }
  # 1. setu setup --undo (stops the daemon, removes the LaunchAgent)
  if flagged setup-attempted; then rb "setu setup --undo" "$setu" setup --undo; fi
  # 2. caddy back
  if flagged caddy-stopped; then rb "brew services start caddy" brew services start caddy; fi
  # 3. old portal back
  if flagged portal-stopped && [ -s "$BK/portal-command" ]; then
    local pcmd; pcmd=$(cat "$BK/portal-command")
    if [ -z "$(portal_pid)" ]; then
      # shellcheck disable=SC2086  # the recorded command line is split back into words on purpose
      rb "start old portal" sh -c 'cd "$1" && shift && (nohup "$@" >/dev/null 2>&1 </dev/null &)' sh "$HOME_DIR/.setu" $pcmd
    fi
  fi
  # 4. MCP configs: byte-exact restore if nobody changed the file since we did, else only our key
  local which file label
  for which in claude codex; do
    flagged "$which-touched" || continue
    if [ "$which" = claude ]; then file="$CLAUDE_JSON"; else file="$CODEX_TOML"; fi
    local orig; orig=$(awk -F'\t' -v f="$file" '$2==f{print $1}' "$BK/manifest")
    local backup="$BK/files/${orig:-none}"
    if [ -n "$orig" ] && [ "$(sha "$file")" = "$(cat "$BK/flags/$which-sha" 2>/dev/null)" ]; then
      rb "restore $file from backup" cp -p "$backup" "$file"
    else
      say "  note: $file changed since the cutover; restoring only the setu entry"
      rb "restore setu entry in $file" mcp_edit "$which-restore" "$file" "$backup"
    fi
  done
  # (~/.zshrc is never modified by the cutover; its backup is kept for reference)
  # 5. relink the v1 CLI, remove our link
  if flagged installed; then
    local dest; dest=$(cat "$BK/flags/installed")
    if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$bin" ]; then
      if [ -s "$BK/install-prev-target" ]; then rb "restore $dest" ln -sfn "$(cat "$BK/install-prev-target")" "$dest"; else rb "remove $dest" rm "$dest"; fi
    fi
  fi
  if flagged bun-link-removed && [ -s "$BK/bun-link-target" ]; then
    mkdir -p "$(dirname "$BUN_LINK")"
    rb "relink $BUN_LINK" ln -sfn "$(cat "$BK/bun-link-target")" "$BUN_LINK"
  fi
  if [ "$fails" -gt 0 ]; then
    led rollback failed "$fails action(s) failed"
    die "rollback had $fails failure(s); see $BK/rollback.out and fix by hand. Backups are in $BK"
  fi
  flag rolled-back
  led rollback ok "rolled back from $BK"
  say "rolled back. Backups kept in $BK. The new Setu's configs and database were left in place (unused)."
}

case "$CMD" in
  plan) cmd_plan ;;
  run) cmd_run ;;
  rollback) cmd_rollback ;;
  *) sed -n '2,8p' "$0"; exit 2 ;;
esac
