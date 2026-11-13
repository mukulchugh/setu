#!/bin/bash
# End-to-end check of slice 7 (worktrees and claims) in a throwaway sandbox: temp bare "origin",
# a bare project repo, a fake setup step, fake files only. Never touches a real repo.
# Usage: CARGO_TARGET_DIR=... crates/setu/e2e/worktree-e2e.sh <path-to-setu-binary>
set -euo pipefail
BIN="${1:?path to setu binary}"
SB=/tmp/setu-wt-e2e
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
expect_fail() { # expect_fail <substring> <cmd...>
  local want="$1"; shift
  local out
  if out=$("$@" 2>&1); then fail "expected failure: $*  (got: $out)"; fi
  echo "$out" | grep -q "$want" || fail "expected '$want' in: $out"
  echo "refused as expected: $(echo "$out" | head -c 220)"
}

rm -rf "${SB:?}"
mkdir -p "$SB/seed" "$SETU_HOME/config/projects"
G="git -c user.email=e@e -c user.name=e -c commit.gpgsign=false -c protocol.file.allow=always -c maintenance.auto=false -c gc.auto=0"
cd "$SB/seed"
$G init -q -b main .
printf 'local.db\n.env.local\nsetup-*.txt\n' > .gitignore
echo hello > README.md
$G add . && $G commit -q -m init
cd "$SB"
$G clone -q --bare seed origin.git
$G clone -q --bare origin.git app.git
$G -C app.git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
$G -C app.git fetch -q origin
$G -C app.git rev-parse origin/main >/dev/null || fail "origin/main must resolve"
$G -C app.git worktree add -q "$SB/app/main" main
echo 'TOKEN=fake-value' > "$SB/app/main/.env.local"

cat > "$SETU_HOME/config/config.toml" <<'TOML'
proxy_port = 17780
stop_runs_on_exit = true
dns_port = 25353
TOML
cat > "$SETU_HOME/config/projects/e2e.toml" <<'TOML'
project = "e2e"
repo = "/tmp/setu-wt-e2e/app.git"
domain = "e2e.local"
preset = []

[ports.web]

[procs.web]
run = "exec python3 -m http.server {port.web} --bind 127.0.0.1"
port = "web"

[worktree]
link = [".env.local"]
min_free = "1MiB"

[[setup.step]]
name = "fake-install"
run = "echo installing for $SETU_RUN; echo done > setup-install.txt"
TOML

"$BIN" daemon >"$SB/daemon.log" 2>&1 &
DAEMON_PID=$!
for _ in $(seq 1 50); do "$BIN" ls >/dev/null 2>&1 && break; sleep 0.2; done

step "new feat/one --start (fetch, worktree add, link, fake setup, start)"
"$BIN" new e2e feat/one --start
WT="$SB/app/feat/one"
[ -L "$WT/.env.local" ] || fail ".env.local should be a symlink"
[ -f "$WT/setup-install.txt" ] || fail "setup step did not run"
grep -q "installing for feat-one" "$SETU_HOME/logs/e2e/feat-one/setup.log" || fail "setup.log missing output"
[ -z "$(git -C "$WT" status --porcelain)" ] || fail "new worktree should be clean"
for _ in $(seq 1 50); do "$BIN" ls | grep -q "e2e/feat-one *running" && break; sleep 0.3; done
"$BIN" ls | grep "e2e/feat-one" | grep -q running || fail "run did not reach running"
"$BIN" ls

step "custom URL: a branch run answers at demo.e2e.local (setu alias)"
"$BIN" alias e2e/feat-one Demo.e2e.local | tee "$SB/alias.out"
grep -q "now also answers at http://demo.e2e.local:17780" "$SB/alias.out" || fail "alias add output"
for _ in $(seq 1 30); do curl -s -H "Host: demo.e2e.local" http://127.0.0.1:17780/ | grep -q "Directory listing" && break; sleep 0.3; done
curl -s -H "Host: demo.e2e.local" http://127.0.0.1:17780/ | grep -q "Directory listing" || fail "alias host did not reach the run"
curl -s -H "Host: feat-one.e2e.local" http://127.0.0.1:17780/ | grep -q "Directory listing" || fail "main host stopped working"
expect_fail "main URL" "$BIN" alias e2e/feat-one feat-one.e2e.local
expect_fail "IP address" "$BIN" alias e2e/feat-one 10.1.2.3
"$BIN" alias ls e2e/feat-one | grep -q "demo.e2e.local" || fail "alias ls"
"$BIN" ls | grep "e2e/feat-one" | grep -q " +1" || fail "ls should show +1"
"$BIN" ls --json | python3 -I -c 'import json,sys; r=[x for x in json.load(sys.stdin) if x["run"]=="e2e/feat-one"][0]; assert r["aliases"]==["demo.e2e.local"] and r["alias_sources"]==[{"host":"demo.e2e.local","source":"custom"}], r; print("ls json aliases ok")'
(cd "$SB/app/feat/one" && "$BIN" alias . second.e2e.local >/dev/null && "$BIN" alias rm . second.e2e.local >/dev/null) || fail "alias with ."
for _ in $(seq 1 30); do HIST=$("$BIN" history e2e/feat-one --kind worktree); case "$HIST" in *alias-add*) break;; esac; sleep 0.2; done
case "$HIST" in *alias-add*alias-add*) ;; *alias-add*) ;; *) fail "alias-add event missing";; esac

step "ignored local data appears"
echo "precious rows" > "$WT/local.db"

step "claim (agent-a), then destructive actions are refused"
"$BIN" claim e2e/feat-one --as agent-a
"$BIN" claims
"$BIN" ls --json | python3 -I -c 'import json,sys; r=[x for x in json.load(sys.stdin) if x["run"]=="e2e/feat-one"][0]; assert r["claim"]["holder"]=="agent-a" and r["claim"]["stale"] is False, r; print("ls claim:", r["claim"]["holder"], "stale=", r["claim"]["stale"])'
expect_fail "claim" "$BIN" rm e2e/feat-one
expect_fail "claim" "$BIN" rm e2e/feat-one --force
expect_fail "live writer claim" "$BIN" down e2e/feat-one
expect_fail "claimed by" "$BIN" claim e2e/feat-one --as agent-b
"$BIN" ls | grep "e2e/feat-one" | grep -q running || fail "refused actions must leave the run up"
[ -d "$WT" ] || fail "worktree must still exist"
# Turso holds an exclusive lock on the live database, so read a point-in-time copy (db + wal) instead.
SNAP="$SB/snap"; rm -rf "$SNAP"; mkdir -p "$SNAP"; cp "$SETU_HOME/state"/setu.db "$SETU_HOME/state"/setu.db-wal "$SNAP"/ 2>/dev/null || true
[ "$(sqlite3 "$SNAP/setu.db" "select count(*) from removal_ops where run_key='e2e/feat-one'")" = "0" ] || fail "a refused rm must persist nothing"
rm -rf "$SNAP"

step "release, then rm (stops the run, archives local.db, removes, keeps branch)"
"$BIN" release e2e/feat-one
"$BIN" rm e2e/feat-one | tee "$SB/rm.out"
grep -q "custom URL(s) dropped: demo.e2e.local" "$SB/rm.out" || fail "rm should name the dropped custom URL"
[ ! -e "$WT" ] || fail "worktree dir should be gone"
git -C "$SB/app.git" show-ref --verify refs/heads/feat/one >/dev/null || fail "branch must be kept"
ARCH=$(ls "$SETU_HOME"/archive/e2e/feat-one/*.tar)
tar -tf "$ARCH" | grep -q "local.db" || fail "archive should hold local.db"
if "$BIN" ls | grep -q "e2e/feat-one"; then fail "run should be dropped from ls"; fi
echo "archive: $ARCH ($(tar -tf "$ARCH" | tr '\n' ' '))"
OUT2=$("$BIN" rm e2e/feat-one 2>&1 || true); echo "second rm: $OUT2"; case "$OUT2" in *"already removed"*) ;; *) fail "second rm should be a no-op";; esac

step "restore (branch checked out again, local.db back)"
"$BIN" restore e2e/feat-one | tee "$SB/restore.out"
grep -q "custom URLs added with .setu alias. are not restored" "$SB/restore.out" || fail "restore must say aliases are not restored"
[ "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: demo.e2e.local' http://127.0.0.1:17780/)" != "200" ] || fail "alias must not survive rm/restore"
[ "$(cat "$WT/local.db")" = "precious rows" ] || fail "local.db not restored"
[ -L "$WT/.env.local" ] || fail "link not recreated"
[ "$(git -C "$WT" rev-parse --abbrev-ref HEAD)" = "feat/one" ] || fail "wrong branch after restore"
"$BIN" ls | grep -q "e2e/feat-one" || fail "restored run should be listed"

step "main is never removable; stale claim by dead pid can be taken over"
"$BIN" adopt "$SB/app/main"
expect_fail "main worktree is never removed" "$BIN" rm e2e/main --force
sleep 300 & DEAD=$!
"$BIN" claim e2e/feat-one --as agent-c --pid "$DEAD"
kill "$DEAD"; wait "$DEAD" 2>/dev/null || true
"$BIN" claims | grep -q STALE || fail "claim should show stale after its pid died"
"$BIN" claim e2e/feat-one --as agent-d
"$BIN" release e2e/feat-one

step "worktree audit log (names only)"
"$BIN" history --kind worktree --limit 50 | cut -c1-170
! "$BIN" history --limit 1000 --json | grep -q "fake-value" || fail "no values in audit"
! grep -q "fake-value" "$SETU_HOME/state"/setu.db* || fail "no values in the database"

"$BIN" down e2e/feat-one >/dev/null 2>&1 || true
kill "$DAEMON_PID"; wait "$DAEMON_PID" 2>/dev/null || true; DAEMON_PID=""
echo; echo "WORKTREE E2E OK"
