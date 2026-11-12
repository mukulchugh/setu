#!/bin/bash
# End-to-end check of auto-removal (slice 7, part 2) in a throwaway sandbox: temp bare "origin",
# a bare project repo, fake files only. Never touches a real repo. Durations are tiny.
# Usage: CARGO_TARGET_DIR=... crates/setu/e2e/autoremove-e2e.sh <path-to-setu-rs-binary>
set -euo pipefail
BIN="${1:?path to setu-rs binary}"
SB=/tmp/setu-ar-e2e
export SETU_HOME="$SB/home"
DAEMON_PID=""
cleanup() {
  [ -n "$DAEMON_PID" ] && kill "$DAEMON_PID" 2>/dev/null || true
  sleep 1
  rm -rf "${SB:?}"
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo; echo "== $*"; }
wait_for() { # wait_for <seconds> <cmd...>
  local n=$(( $1 * 5 )); shift
  for _ in $(seq 1 "$n"); do "$@" >/dev/null 2>&1 && return 0; sleep 0.2; done
  return 1
}
is_running() { "$BIN" ls | grep -q "$1 *running"; }

rm -rf "${SB:?}"
mkdir -p "$SB/seed" "$SETU_HOME/config/projects"
G="git -c user.email=e@e -c user.name=e -c commit.gpgsign=false -c protocol.file.allow=always"
cd "$SB/seed"
$G init -q -b main .
printf 'local.db\n.env.local\n' > .gitignore
echo hello > README.md
$G add . && $G commit -q -m init
cd "$SB"
$G clone -q --bare seed origin.git
$G clone -q --bare origin.git app.git
$G -C app.git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
$G -C app.git fetch -q origin
$G -C app.git worktree add -q "$SB/app/main" main

# merged_after = 0s: any recorded stop makes a merged branch old enough. grace = 2s.
cat > "$SETU_HOME/config/config.toml" <<'TOML'
proxy_port = 17781
dns_port = 25354

[auto_remove]
enabled = true
merged_after = "0s"
idle_after = "14d"
grace = "2s"
daily_cap = 5
TOML
cat > "$SETU_HOME/config/projects/ar.toml" <<'TOML'
project = "ar"
repo = "/tmp/setu-ar-e2e/app.git"
domain = "ar.local"
preset = []

[ports.web]

[procs.web]
run = "exec python3 -m http.server {port.web} --bind 127.0.0.1"
port = "web"

[worktree]
min_free = "1MiB"
TOML

"$BIN" daemon >"$SB/daemon.log" 2>&1 &
DAEMON_PID=$!
wait_for 10 "$BIN" ls || fail "daemon did not come up"

step "create two worktrees: feat/merged (pushed and merged into origin main) and feat/dirty (unmerged, dirty)"
"$BIN" new ar feat/merged --start
"$BIN" new ar feat/dirty --start
M="$SB/app/feat/merged"
D="$SB/app/feat/dirty"
echo 'SECRET=1' > "$M/.env.local"                 # ignored file: must be archived, not lost
echo feature > "$M/feature.txt"
$G -C "$M" add feature.txt && $G -C "$M" commit -q -m feature
$G -C "$M" push -q origin HEAD:refs/heads/feat/merged
$G -C "$SB/origin.git" update-ref refs/heads/main "$($G -C "$M" rev-parse HEAD)"   # the "merge"
echo wip > "$D/wip.txt"                           # untracked: dirty
wait_for 20 is_running ar/feat-merged || fail "merged run did not start"
wait_for 20 is_running ar/feat-dirty || fail "dirty run did not start"
"$BIN" down ar/feat-merged
"$BIN" down ar/feat-dirty

step "dry run: reports, changes nothing"
OUT=$("$BIN" autoremove --dry-run); echo "$OUT"
echo "$OUT" | grep -q "ar/feat-merged .*candidate-added" || fail "merged branch should be reported as a candidate"
[ -d "$M" ] || fail "dry run removed something"
if "$BIN" ls --json | grep -q '"candidate_since"'; then fail "dry run must not record a candidate"; fi

step "real run: becomes a candidate, visible in ls; the dirty one is skipped"
OUT=$("$BIN" autoremove); echo "$OUT"
echo "$OUT" | grep -q "ar/feat-merged .*candidate-added" || fail "expected candidate-added"
echo "$OUT" | grep -q "ar/feat-dirty .*skipped.*\[dirty\]" || fail "dirty branch should be skipped with its reason"
[ -d "$M" ] || fail "must not be removed before grace"
"$BIN" ls | tee "$SB/ls.txt"
grep -q "will be removed in .*merged (ancestor)" "$SB/ls.txt" || fail "ls should show the pending removal"
grep -q 'pin ar/feat-merged' "$SB/ls.txt" || fail "ls should say how to keep it"
"$BIN" ls --json | grep -q '"candidate_since"' || fail "ls --json should carry removal.candidate_since"

step "before grace ends: still kept"
OUT=$("$BIN" autoremove); echo "$OUT"
if echo "$OUT" | grep -q "ar/feat-merged .*removed"; then
  echo "(grace already elapsed on this machine)"
else
  echo "$OUT" | grep -q "candidate-kept" || fail "expected candidate-kept"
  [ -d "$M" ] || fail "removed before grace"
fi

step "after grace: removed with an archive; the branch is kept"
if [ -d "$M" ]; then
  sleep 3
  OUT=$("$BIN" autoremove); echo "$OUT"
  echo "$OUT" | grep -q "ar/feat-merged .*removed" || fail "expected removed after grace"
fi
[ ! -d "$M" ] || fail "merged worktree should be gone"
ARC=$(ls "$SETU_HOME"/archive/ar/feat-merged/*.tar) || fail "archive missing"
echo "archive: $ARC"
tar -tf "$ARC" | grep -q '.env.local' || fail "archive should hold the ignored .env.local"
$G -C "$SB/app.git" rev-parse --verify -q refs/heads/feat/merged >/dev/null || fail "branch must be kept"
EV=$("$BIN" history --kind autoremove --limit 200 --json)
echo "$EV" | grep -q '"op": "autoremove-candidate"' || fail "candidate not audited"
echo "$EV" | grep -q '"op": "autoremove-removed"' || fail "removal not audited"
echo "$EV" | grep -q '"op": "autoremove-skipped"' || fail "skip not audited"

step "the unmerged dirty branch was never touched"
[ -f "$D/wip.txt" ] || fail "dirty worktree was touched"
"$BIN" ls | grep -q 'ar/feat-dirty' || fail "dirty run should still be registered"

step "pin keeps a candidate: restore, make it a candidate, pin, and it survives past grace"
"$BIN" restore ar/feat-merged >/dev/null
"$BIN" up "$M" >/dev/null
wait_for 20 is_running ar/feat-merged || fail "restored run did not start"
"$BIN" down ar/feat-merged
"$BIN" autoremove | grep -q "candidate-added" || fail "expected a new candidate"
"$BIN" pin ar/feat-merged >/dev/null
sleep 3
OUT=$("$BIN" autoremove); echo "$OUT"
echo "$OUT" | grep -q "ar/feat-merged .*candidate-cleared.*pinned" || fail "pin should reset the candidate"
[ -d "$M" ] || fail "pinned worktree was removed"

step "disabled means off"
sed -i.bak 's/enabled = true/enabled = false/' "$SETU_HOME/config/config.toml"
refusal=$("$BIN" autoremove 2>&1 || true)
echo "$refusal" | grep -q "auto_remove is off" || fail "disabled run should refuse: $refusal"
echo "$refusal"

echo; echo "ALL OK"
