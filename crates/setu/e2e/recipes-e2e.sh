#!/bin/bash
# End-to-end check of the shipped worker recipe's shell command with a fake `bunx` on PATH: the CLI version follows
# the worktree's pinned SDK (^ and ~ stripped), --branch only where the installed core supports it, a clear error
# when no SDK is pinned, and the same command running as a proc under the daemon. Also `setu recipes` and the gone
# `setu x`. Fake data only. Usage: crates/setu/e2e/recipes-e2e.sh <path-to-setu-binary>
set -euo pipefail
BIN="$(cd "$(dirname "${1:?path to setu binary}")" && pwd)/$(basename "$1")"
SB=/tmp/setu-recipes-e2e
export HOME="$SB/home" SETU_HOME="$SB/setu"
DAEMON_PID=""
cleanup() {
  [ -n "$DAEMON_PID" ] && { "$BIN" down tp/main >/dev/null 2>&1 || true; kill "$DAEMON_PID" 2>/dev/null || true; }
  sleep 1; rm -rf "${SB:?}"
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
rm -rf "${SB:?}"; mkdir -p "$SB/shims" "$SB/wt" "$HOME" "$SETU_HOME/config"
printf '#!/bin/sh\nprintf "%%s\\n" "$*" > "$SB_OUT"\n' > "$SB/shims/bunx"
chmod +x "$SB/shims/bunx"
export SB_OUT="$SB/bunx.args" PATH="$SB/shims:$PATH"

echo "== setu recipes: lists the shipped ones, shows source, rejects unknown names; setu x is gone"
LS="$("$BIN" recipes ls)"
for n in convex inngest next-env nx trigger workos-authkit; do grep -q "^$n " <<<"$LS" || fail "recipes ls misses $n: $LS"; done
SHOW="$("$BIN" recipes show trigger)"; grep -q '^name = "trigger"' <<<"$SHOW" || fail "recipes show prints the recipe"
if "$BIN" recipes show nope >/dev/null 2>&1; then fail "unknown recipe name should fail"; fi
if "$BIN" x trigger-dev >/dev/null 2>"$SB/stderr"; then fail "setu x should be gone"; fi
grep -q "helpers are gone" "$SB/stderr" || fail "unclear error for setu x"
mkdir -p "$SETU_HOME/config/recipes"
printf 'name = "trigger"\ndescription = "mine"\n[detect]\nany_of = [{ file = "x" }]\n' > "$SETU_HOME/config/recipes/trigger.toml"
LS="$("$BIN" recipes ls)"; grep -q "replaces the shipped one" <<<"$LS" || fail "a user recipe of the same name should be marked as replacing"
rm -rf "$SETU_HOME/config/recipes"

# The recipe's command: the body of `run = '''...'''` from the shipped recipe.
body() { "$BIN" recipes show trigger | awk "/^run = '''/{f=1;next} /^'''/{f=0} f"; }
body > "$SB/trigger.raw"
[ -s "$SB/trigger.raw" ] || fail "could not extract the recipe command"
cd "$SB/wt"
sed -e "s|{worktree}|$SB/wt|g" -e 's|{app_dir}|.|g' "$SB/trigger.raw" > "$SB/trigger.sh"
run() { rm -f "$SB_OUT"; sh "$SB/trigger.sh" 2>"$SB/stderr"; cat "$SB_OUT"; }

echo "== no sdk pinned: a clear error, bunx never runs"
echo '{"dependencies":{"react":"^19"}}' > package.json
rm -f "$SB_OUT"
if sh "$SB/trigger.sh" >/dev/null 2>"$SB/stderr"; then fail "should fail without a pinned sdk"; fi
grep -q "no @trigger.dev/sdk version pinned" "$SB/stderr" || { cat "$SB/stderr"; fail "unclear error"; }
[ ! -e "$SB_OUT" ] || fail "bunx must not run without a pinned sdk"
echo '{"dependencies":{"@trigger.dev/sdk":"workspace:*"}}' > package.json
if sh "$SB/trigger.sh" >/dev/null 2>"$SB/stderr"; then fail "should fail for a non-version spec"; fi
grep -q "not a version number" "$SB/stderr" || fail "unclear error for a non-version spec"
rm package.json
if sh "$SB/trigger.sh" >/dev/null 2>"$SB/stderr"; then fail "should fail without package.json"; fi
grep -q "no package.json" "$SB/stderr" || fail "unclear error without package.json"

echo "== version follows package.json, ^ stripped; no --branch while the installed core lacks support"
echo '{"dependencies":{"@trigger.dev/sdk":"^4.4.6"}}' > package.json
[ "$(TRIGGER_DEV_BRANCH=feat-x run)" = "trigger.dev@4.4.6 dev --max-concurrent-runs 2" ] || fail "main-style worktree args: $(cat "$SB_OUT")"
grep -q "no dev-branch support" "$SB/stderr" || fail "should say why there is no branch"
mkdir -p node_modules/@trigger.dev/core/dist/esm/v3/apiClientManager
echo 'const a = process.env.UNRELATED;' > node_modules/@trigger.dev/core/dist/esm/v3/apiClientManager/index.js
[ "$(TRIGGER_DEV_BRANCH=feat-x run)" = "trigger.dev@4.4.6 dev --max-concurrent-runs 2" ] || fail "a probe file without the branch variable means no --branch"

echo "== newer worktree: ~ stripped, --branch from the branch env when the probe mentions it"
echo '{"devDependencies":{"@trigger.dev/sdk":"~4.8.3"}}' > package.json
echo 'const a = process.env.TRIGGER_DEV_BRANCH;' > node_modules/@trigger.dev/core/dist/esm/v3/apiClientManager/index.js
[ "$(TRIGGER_DEV_BRANCH=feat-x run)" = "trigger.dev@4.8.3 dev --max-concurrent-runs 2 --branch feat-x" ] || fail "newer worktree args"
[ ! -s "$SB/stderr" ] || fail "no note when branches are supported"
[ "$(TRIGGER_PREVIEW_BRANCH=prev-z run)" = "trigger.dev@4.8.3 dev --max-concurrent-runs 2 --branch prev-z" ] || fail "preview branch fallback"
printf '{\n  "dependencies": {\n    "@trigger.dev/sdk": "4.9.0"\n  }\n}\n' > package.json
[ "$(TRIGGER_DEV_BRANCH=feat-x run)" = "trigger.dev@4.9.0 dev --max-concurrent-runs 2 --branch feat-x" ] || fail "pretty-printed package.json and an exact version"

echo "== the run name falls back to SETU_RUN; the commonjs probe counts too"
rm -rf node_modules; mkdir -p node_modules/@trigger.dev/core/dist/commonjs/v3/apiClientManager
echo 'TRIGGER_DEV_BRANCH' > node_modules/@trigger.dev/core/dist/commonjs/v3/apiClientManager/index.js
[ "$(SETU_RUN=feat-y run)" = "trigger.dev@4.9.0 dev --max-concurrent-runs 2 --branch feat-y" ] || fail "SETU_RUN fallback"
[ "$(run)" = "trigger.dev@4.9.0 dev --max-concurrent-runs 2" ] || fail "no run name at all"
grep -q "no run name" "$SB/stderr" || fail "should say why there is no branch"

echo "== the env file is passed when the app folder has one, found through {worktree}"
mkdir -p apps/a; : > apps/a/.env.local
sed -e "s|{worktree}|$SB/wt|g" -e 's|{app_dir}|apps/a|g' "$SB/trigger.raw" > "$SB/trigger.sh"
[ "$(SETU_RUN=feat-y run)" = "trigger.dev@4.9.0 dev --max-concurrent-runs 2 --branch feat-y --env-file $SB/wt/apps/a/.env.local" ] || fail "env file args: $(cat "$SB_OUT")"

echo "== through the daemon: a config with recipes = [\"trigger\"] runs the recipe's command as a proc, with the run name from its env"
G="git -c user.email=e@e -c user.name=e -c commit.gpgsign=false -c protocol.file.allow=always -c maintenance.auto=false"
mkdir -p "$SB/seed" "$SETU_HOME/config/projects"
(cd "$SB/seed" && $G init -q -b main . && echo '{"dependencies":{"@trigger.dev/sdk":"^4.8.3"}}' > package.json && $G add -A && $G commit -q -m init)
$G clone -q --bare "$SB/seed" "$SB/tp.git"
$G -C "$SB/tp.git" worktree add -q "$SB/tp/main" main
mkdir -p "$SB/tp/main/node_modules/@trigger.dev/core/dist/esm/v3/apiClientManager"
echo 'process.env.TRIGGER_DEV_BRANCH' > "$SB/tp/main/node_modules/@trigger.dev/core/dist/esm/v3/apiClientManager/index.js"
printf 'proxy_port = 17784\ndns_port = 25357\nstop_runs_on_exit = true\n' > "$SETU_HOME/config/config.toml"
# The project names the recipe; nothing of its command is pasted into the config.
cat > "$SETU_HOME/config/projects/tp.toml" <<TOML
project = "tp"
repo = "$SB/tp.git"
domain = "tp.localhost"
preset = []
auto_install = false
recipes = ["trigger"]

[ports]
web = {}

[procs.web]
run = "exec python3 -m http.server {port.web} --bind 127.0.0.1"
port = "web"
TOML
grep -q "bunx" "$SETU_HOME/config/projects/tp.toml" && fail "the config must not contain the recipe's command"
cat > "$SB/shims/bunx" <<SHIM
#!/bin/sh
printf '%s\n' "\$*" > "$SB/bunx.daemon.args"
exec sleep 30
SHIM
chmod +x "$SB/shims/bunx"
env PATH="$SB/shims:/usr/bin:/bin" "$BIN" daemon >"$SB/daemon.log" 2>&1 &
DAEMON_PID=$!
for _ in $(seq 1 50); do "$BIN" ls >/dev/null 2>&1 && break; sleep 0.2; done
"$BIN" adopt "$SB/tp/main" >/dev/null
"$BIN" up "$SB/tp/main" >/dev/null
for _ in $(seq 1 100); do [ -s "$SB/bunx.daemon.args" ] && break; sleep 0.2; done
[ -s "$SB/bunx.daemon.args" ] || { cat "$SETU_HOME/logs/tp/main/trigger.log" 2>/dev/null; fail "the trigger proc never reached bunx"; }
[ "$(cat "$SB/bunx.daemon.args")" = "trigger.dev@4.8.3 dev --max-concurrent-runs 2 --branch main" ] || fail "wrong args through the daemon: $(cat "$SB/bunx.daemon.args")"
echo "== doctor flags a leftover \`setu x\` proc and says to use recipes = [\"trigger\"]"
cat > "$SETU_HOME/config/projects/old.toml" <<TOML
project = "old"
repo = "$SB/tp.git"
domain = "old.localhost"
preset = []

[ports]
web = {}

[procs.web]
run = "exec python3 -m http.server {port.web}"
port = "web"

[procs.trigger]
run = "setu x trigger-dev --max-concurrent-runs 2"
TOML
DOC="$("$BIN" doctor 2>&1 || true)"
grep -q "old/trigger" <<<"$DOC" && grep -q "setu x. is gone" <<<"$DOC" && grep -qF 'recipes = ["trigger"]' <<<"$DOC" && grep -qF 'delete the old [procs.trigger] block' <<<"$DOC" || { echo "$DOC"; fail "doctor should flag setu x and name the recipe"; }
echo "recipes e2e: all checks passed"
