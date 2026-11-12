#!/bin/bash
# setu-cutover is now `setu migrate` (Rust, ships in the binary). This wrapper keeps the old command line working.
#
#   setu-cutover plan     [--binary PATH]                                  = setu migrate plan
#   setu-cutover run      [--binary PATH] --yes-i-have-reviewed-the-plan   = setu migrate run --yes
#   setu-cutover rollback [--binary PATH]                                  = setu migrate rollback
#
# --binary picks which setu runs the migration (default: `setu` on PATH, or $SETU_BINARY).
# See docs/MIGRATING.md. Test hooks (HOME, SETU_HOME, SETU_LINK_DIR) are read by setu itself.
set -u
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
[ -n "$BIN" ] || BIN="$(command -v setu || true)"
[ -x "$BIN" ] || { echo "setu-cutover: no setu binary: pass --binary /path/to/setu" >&2; exit 1; }
case "$CMD" in
  plan) exec "$BIN" migrate plan ;;
  run)
    [ "$CONFIRMED" = yes ] || { echo "setu-cutover: refusing to run without --yes-i-have-reviewed-the-plan (review 'plan' first)" >&2; exit 1; }
    exec "$BIN" migrate run --yes ;;
  rollback) exec "$BIN" migrate rollback ;;
  *) sed -n '2,8p' "$0"; exit 2 ;;
esac
