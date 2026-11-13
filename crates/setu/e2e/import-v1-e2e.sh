#!/bin/bash
# End-to-end check of `setu import-v1` and `setu path` on fixtures in a throwaway sandbox
# (own HOME and SETU_HOME). Fake data only; never touches a real repo or the live Setu.
# Usage: CARGO_TARGET_DIR=... crates/setu/e2e/import-v1-e2e.sh <path-to-setu-binary>
set -euo pipefail
BIN="${1:?path to setu binary}"
SB=/tmp/setu-import-e2e
export HOME="$SB/home"
export SETU_HOME="$SB/setu"
DAEMON_PID=""; BUSY_PID=""; V1_PID=""
cleanup() {
  [ -n "$DAEMON_PID" ] && kill "$DAEMON_PID" 2>/dev/null || true
  [ -n "$BUSY_PID" ] && kill "$BUSY_PID" 2>/dev/null || true
  [ -n "$V1_PID" ] && kill "$V1_PID" 2>/dev/null || true
  sleep 1
  rm -rf "${SB:?}"
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo; echo "== $*"; }
has() { grep -q -- "$2" <<<"$1" || fail "expected '$2' in: $1"; }
hasnt() { if grep -q -- "$2" <<<"$1"; then fail "did not expect '$2' in: $1"; fi; }

rm -rf "${SB:?}"
WS="$HOME/workspace"
mkdir -p "$WS" "$SETU_HOME/config/projects" "$SB/seed-full" "$SB/seed-app" "$SB/seed-plain" "$SB/seed-keep" "$SB/seed-dot1" "$SB/seed-dot2"
G="git -c user.email=e@e -c user.name=e -c commit.gpgsign=false -c protocol.file.allow=always -c maintenance.auto=false -c gc.auto=0"
seed() { # seed <name> <seed-dir>: a bare repo <name>.git with a main worktree at workspace/<name>/main
  (cd "$2" && $G init -q -b main . && echo hi > README.md && $G add -A && $G commit -q -m init)
  $G clone -q --bare "$2" "$WS/$1.git"
  $G -C "$WS/$1.git" worktree add -q "$WS/$1/main" main
}
echo '{"scripts":{"dev":"next dev"}}' > "$SB/seed-app/package.json"; touch "$SB/seed-app/bun.lock"
seed app "$SB/seed-app"
seed plain "$SB/seed-plain"   # no recognisable stack
echo '{"scripts":{"dev":"vite"}}' > "$SB/seed-keep/package.json"
seed keep "$SB/seed-keep"
# v1 projects whose names contain dots: not valid Setu project names
echo '{"scripts":{"dev":"next dev"}}' > "$SB/seed-dot1/package.json"; touch "$SB/seed-dot1/bun.lock"
seed mukulchugh.com "$SB/seed-dot1"
echo '{"scripts":{"dev":"vite"}}' > "$SB/seed-dot2/package.json"
seed quivly-site2.0 "$SB/seed-dot2"
$G -C "$WS/quivly-site2.0.git" worktree add -q -b feat/dot "$WS/quivly-site2.0/feat/dot" main
# full: a repo that used Trigger.dev, Inngest and WorkOS under v1 (no v1 file records sidecars, so they come from the repo)
echo '{"scripts":{"dev":"next dev"},"dependencies":{"@trigger.dev/sdk":"^4.4.6","inngest":"^3","@workos-inc/authkit-nextjs":"^2","next":"16"}}' > "$SB/seed-full/package.json"
touch "$SB/seed-full/bun.lock"; echo '{}' > "$SB/seed-full/nx.json"; echo 'export default {}' > "$SB/seed-full/trigger.config.ts"
seed full "$SB/seed-full"
# app: a branch with a slash, a busy-port branch, a claude-owned one, a locked one, a prunable one
$G -C "$WS/app.git" worktree add -q -b feat/x "$WS/app/feat/x" main
$G -C "$WS/app.git" worktree add -q -b busy "$WS/app/busy" main
$G -C "$WS/app.git" worktree add -q -b claudey "$WS/app/.claude/worktrees/claudey" main
$G -C "$WS/app.git" worktree add -q -b lockme "$WS/app/lockme" main
$G -C "$WS/app.git" worktree lock "$WS/app/lockme"
$G -C "$WS/app.git" worktree add -q -b gone "$WS/app/gone" main
rm -rf "$WS/app/gone"

# v1 files. keep: an existing, hand-written config that must stay byte-identical.
cat > "$WS/.projects" <<'P'
app:3500:acme/app:App
plain:3600:acme/plain:Plain
keep:3700:acme/keep:Keep
norepo:3800:acme/norepo:Nothing
mukulchugh.com:3900:acme/mc:MC
quivly-site2.0:3100:acme/qs:QS
full:3950:acme/full:Full
P
python3 - "$WS/.ports" <<'PY'
import sys
open(sys.argv[1], "w").write("""app/main:41311
app/feat/x:41312
app/busy:41313
app/claudey:41314
app/lockme:41315
plain/main:41316
keep/main:41317
mukulchugh.com/main:41320
quivly-site2.0/main:41321
quivly-site2.0/feat/dot:41322
full/main:41330
app/stale-removed:41399
""")
PY
echo '{"workspace":"~/workspace","localZone":"e2e.local","cfCredentials":"SECRET-MUST-NOT-APPEAR"}' > "$HOME/.setu.json"
cat > "$SETU_HOME/config/projects/keep.toml" <<TOML
project = "keep"
repo = "$WS/keep.git"
domain = "keep.test"
preset = []

[ports]
web = {}

[procs.web]
run = "exec python3 -m http.server {port.web} --bind 127.0.0.1"
port = "web"
TOML
cp "$SETU_HOME/config/projects/keep.toml" "$SB/keep.toml.orig"
cat > "$SETU_HOME/config/config.toml" <<'TOML'
proxy_port = 17782
stop_runs_on_exit = true
dns_port = 25354
TOML

# a v1 dev server is still running on app/busy's port
python3 -m http.server 41313 --bind 127.0.0.1 >/dev/null 2>&1 &
BUSY_PID=$!
# and one inside app/feat/x's own worktree on its v1 port: that one is kept, and shows as running
(cd "$WS/app/feat/x" && exec python3 -m http.server 41312 --bind 127.0.0.1 >/dev/null 2>&1) &
V1_PID=$!
sleep 1

step "dry run (no daemon): table, and nothing is written"
OUT=$("$BIN" import-v1 2>&1); echo "$OUT"
has "$OUT" "PROJECT"
has "$OUT" "app  .*main .*http://app.e2e.local:17782 .*41311 (kept) .*generated"
has "$OUT" "feat-x .*http://feat-x.e2e.local:17782 .*41312 (kept, running)"
has "$OUT" "busy .*new (41313 in use)"
has "$OUT" "claudey .*skipped (claude-owned)"
has "$OUT" "lockme .*skipped (locked)"
has "$OUT" "gone .*skipped (prunable)"
has "$OUT" "plain .*41316 (kept) .*needs review"
has "$OUT" "keep.test:17782 .*41317 (kept) .*existing"
has "$OUT" "norepo: no bare repo"
# dotted v1 names: imported under dashed names, the v1 main host kept as an alias
has "$OUT" "mukulchugh.com: not a valid Setu project name; imported as mukulchugh-com"
has "$OUT" "quivly-site2.0: not a valid Setu project name; imported as quivly-site2-0"
has "$OUT" "mukulchugh-com: main also answers at http://mukulchugh.com.e2e.local:17782"
has "$OUT" "quivly-site2-0: main also answers at http://quivly-site2.0.e2e.local:17782"
has "$OUT" "mukulchugh-com .*main .*http://mukulchugh-com.e2e.local:17782 .*41320 (kept) .*generated"
has "$OUT" "quivly-site2-0 .*feat-dot .*41322 (kept)"
hasnt "$OUT" "not a valid project name, skipped"
hasnt "$OUT" "stale-removed"
hasnt "$OUT" "SECRET-MUST-NOT-APPEAR"
[ ! -e "$SETU_HOME/config/projects/app.toml" ] || fail "dry run must not write configs"
[ ! -e "$SETU_HOME/archive/../cutover-ledger.jsonl" ] || fail "dry run must not write the ledger"

step "--apply without a daemon is refused"
if "$BIN" import-v1 --apply >/dev/null 2>&1; then fail "apply needs the daemon"; fi

"$BIN" daemon >"$SB/daemon.log" 2>&1 &
DAEMON_PID=$!
for _ in $(seq 1 50); do "$BIN" ls >/dev/null 2>&1 && break; sleep 0.2; done

step "--apply"
OUT=$("$BIN" import-v1 --apply 2>&1) || { echo "$OUT"; cat "$SB/daemon.log"; fail "apply"; }; echo "$OUT"
grep -q 'run  = "bun run dev"' "$SETU_HOME/config/projects/app.toml" || fail "app dev command should be bun run dev"
grep -q 'NEEDS REVIEW' "$SETU_HOME/config/projects/plain.toml" || fail "plain should be flagged"
grep -q '^project = "mukulchugh-com"' "$SETU_HOME/config/projects/mukulchugh-com.toml" || fail "dotted project config under the dashed name"
grep -q 'aliases = \["mukulchugh.com.e2e.local"\]' "$SETU_HOME/config/projects/mukulchugh-com.toml" || fail "v1 host alias missing"
grep -q 'aliases = \["quivly-site2.0.e2e.local"\]' "$SETU_HOME/config/projects/quivly-site2-0.toml" || fail "v1 host alias missing (site2)"
grep -q 'quivly-site2.0.git' "$SETU_HOME/config/projects/quivly-site2-0.toml" || fail "config must still point at the dotted v1 repo"
cmp "$SETU_HOME/config/projects/keep.toml" "$SB/keep.toml.orig" || fail "existing config must stay byte-identical"
# a repo with trigger.config.ts, an inngest dependency and authkit names those recipes instead of pasting their commands
FULL="$SETU_HOME/config/projects/full.toml"
grep -qF 'recipes = ["inngest", "next-env", "nx", "trigger", "workos-authkit"]' "$FULL" || { cat "$FULL"; fail "full.toml should name its recipes"; }
for pasted in '^\[procs.inngest\]' '^\[procs.trigger\]' '^\[env\]' 'exec bunx' 'NX_DAEMON' 'inngest dev -p'; do
  ! grep -q -- "$pasted" "$FULL" || { cat "$FULL"; fail "full.toml must not paste the recipe: $pasted"; }
done
! grep -q 'setu x' "$FULL" || fail "generated configs must not use the removed setu x helpers"
! grep -q 'procs.convex' "$FULL" || fail "no convex dependency, so no convex proc"
! grep -q 'WORKOS\|TRIGGER\|INNGEST' "$SETU_HOME/config/projects/app.toml" || fail "app uses none of them, so it gets none"
grep -qF 'recipes = ["next-env"]' "$SETU_HOME/config/projects/app.toml" || fail "a JS app still gets its base URL, through the next-env recipe"
has "$("$BIN" env effective app/main)" 'NEXT_PUBLIC_APP_BASE_URL'
"$BIN" env effective full/main > "$SB/env-full.out"
has "$(cat "$SB/env-full.out")" "TRIGGER_DEV_BRANCH .*main"
has "$(cat "$SB/env-full.out")" "NX_DAEMON .*false"
has "$(cat "$SB/env-full.out")" "INNGEST_BASE_URL .*http://127.0.0.1:"
has "$(cat "$SB/env-full.out")" "NEXT_PUBLIC_WORKOS_REDIRECT_URI .*http://full.e2e.local:17782/authentication/callback"
LS=$("$BIN" ls)
has "$LS" "mukulchugh-com/main"; has "$LS" "quivly-site2-0/main"; has "$LS" "quivly-site2-0/feat-dot"
has "$LS" "full/main"; has "$LS" "app/main"; has "$LS" "app/feat-x"; has "$LS" "app/busy"; has "$LS" "keep/main"; has "$LS" "plain/main"
hasnt "$LS" "claudey"; hasnt "$LS" "lockme"; hasnt "$LS" "app/gone"
"$BIN" ls --json | python3 -I -c '
import json,sys
r={x["run"]:x for x in json.load(sys.stdin)}
assert r["app/main"]["ports"]["web"]==41311, r["app/main"]
assert r["app/feat-x"]["ports"]["web"]==41312
assert r["app/feat-x"]["status"]=="running" and r["app/feat-x"]["external"] is True, r["app/feat-x"]
# a project with no procs (plain: no recognisable stack) is no-server, with no URL
assert r["plain/main"]["status"]=="no-server" and r["plain/main"]["url"] is None, r["plain/main"]
assert all(x["status"]=="stopped" for k,x in r.items() if k not in ("app/feat-x","plain/main")), r
assert not any(x["external"] for k,x in r.items() if k!="app/feat-x")
assert r["app/busy"]["ports"]["web"]!=41313 and 4000<=r["app/busy"]["ports"]["web"]<=4999, r["app/busy"]
assert r["keep/main"]["ports"]["web"]==41317
assert r["app/main"]["url"]=="http://app.e2e.local:17782", r["app/main"]["url"]
assert r["mukulchugh-com/main"]["ports"]["web"]==41320, r["mukulchugh-com/main"]
assert r["mukulchugh-com/main"]["aliases"]==["mukulchugh.com.e2e.local"], r["mukulchugh-com/main"]
assert r["quivly-site2-0/main"]["aliases"]==["quivly-site2.0.e2e.local"], r["quivly-site2-0/main"]
assert r["quivly-site2-0/main"]["url"]=="http://quivly-site2-0.e2e.local:17782", r["quivly-site2-0/main"]["url"]
assert r["quivly-site2-0/feat-dot"]["aliases"]==[], "aliases belong to main only"
print("leases ok")'
LEDGER="$SETU_HOME/cutover-ledger.jsonl"
[ -f "$LEDGER" ] || fail "ledger missing at $LEDGER"
grep -q '"action":"adopted"' "$LEDGER" || fail "ledger should record adoptions"
hasnt "$(cat "$LEDGER")" "SECRET-MUST-NOT-APPEAR"

step "down stops the external v1 server (only after re-proving its cwd and port); the busy stranger is never touched"
"$BIN" down app/feat-x >/dev/null || fail "down of the external run"
for _ in $(seq 1 50); do kill -0 "$V1_PID" 2>/dev/null || break; sleep 0.1; done
if kill -0 "$V1_PID" 2>/dev/null; then fail "the external server should have been stopped by down"; fi
kill -0 "$BUSY_PID" 2>/dev/null || fail "an unrelated listener must never be signalled"

step "idempotent: second apply adopts nothing, changes no config"
OUT=$("$BIN" import-v1 --apply 2>&1); echo "$OUT" | tail -4
has "$OUT" "0 to adopt"
ADOPTED=$(grep -c '"action":"adopted"' "$LEDGER"); [ "$ADOPTED" = "9" ] || fail "expected 9 adoptions in the ledger, got $ADOPTED"
cmp "$SETU_HOME/config/projects/keep.toml" "$SB/keep.toml.orig" || fail "existing config changed"
has "$("$BIN" import-v1)" "registered"

step "setu path"
[ "$("$BIN" path app)" = "$(cd "$WS/app/main" && pwd -P)" ] || fail "path app -> main"
[ "$("$BIN" path app main)" = "$(cd "$WS/app/main" && pwd -P)" ] || fail "path app main"
[ "$("$BIN" path app '')" = "$(cd "$WS/app/main" && pwd -P)" ] || fail "path app ''"
EXPECT="$(cd "$WS/app/feat/x" && pwd -P)"
[ "$("$BIN" path app feat/x)" = "$EXPECT" ] || fail "path by branch with slash"
[ "$("$BIN" path app feat-x)" = "$EXPECT" ] || fail "path by run name"
out=$("$BIN" path app nope 2>&1) && fail "unknown run should fail"; has "$out" "no worktree nope"
# the zsh `setu cd quivly-site2.0 feat/dot` keeps working with the v1 dotted name
[ "$("$BIN" path quivly-site2.0 feat/dot)" = "$(cd "$WS/quivly-site2.0/feat/dot" && pwd -P)" ] || fail "path by v1 dotted project name"
[ "$("$BIN" path quivly-site2-0 main)" = "$(cd "$WS/quivly-site2.0/main" && pwd -P)" ] || fail "path by dashed project name"
echo "import-v1 e2e: all checks passed"
