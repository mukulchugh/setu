#!/usr/bin/env bash
# Build (and optionally publish) a Setu release on this Mac. No CI is involved.
#
#   scripts/release.sh 0.1.3            # dry run: test, build both Mac binaries + the formula, show them
#   scripts/release.sh 0.1.3 --publish  # also: tag v0.1.3, create the GitHub release, update the tap
#
# Needs: cargo, rustup targets aarch64-apple-darwin and x86_64-apple-darwin, cargo-dist 0.34
# (`brew install cargo-dist`), and `gh` signed in with push access to mukulchugh/setu and
# mukulchugh/homebrew-tap. Builds from origin/main, never from local uncommitted work.
set -euo pipefail

VERSION="${1:?usage: scripts/release.sh <version> [--publish]}"
PUBLISH="${2:-}"
TAG="v${VERSION}"
REPO="mukulchugh/setu"
TAP="mukulchugh/homebrew-tap"

die() { echo "release: $*" >&2; exit 1; }
say() { echo "release: $*"; }

ROOT="$(git rev-parse --show-toplevel)"
COMMON="$(cd "$ROOT" && git rev-parse --path-format=absolute --git-common-dir)"
cd "$ROOT"
git fetch -q origin --tags
[ -z "$(git status --porcelain)" ] || die "working tree has changes; commit or move them first"

have() { command -v "$1" >/dev/null 2>&1 || die "$1 is not installed"; }
have dist; have gh; have rustup
for t in aarch64-apple-darwin x86_64-apple-darwin; do
  rustup target list --installed | grep -qx "$t" || die "rust target $t missing: rustup target add $t"
done

MAIN_VERSION="$(git show origin/main:crates/setu/Cargo.toml | sed -n 's/^version = "\(.*\)"$/\1/p' | head -1)"
[ "$MAIN_VERSION" = "$VERSION" ] || die "origin/main is at version $MAIN_VERSION, not $VERSION; bump crates/setu/Cargo.toml and merge first"

if [ "$PUBLISH" = "--publish" ] && git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  [ "$(git rev-parse "$TAG^{commit}")" = "$(git rev-parse origin/main)" ] || die "$TAG already exists and is not origin/main"
fi
if [ "$PUBLISH" = "--publish" ] && gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
  die "a GitHub release $TAG already exists"
fi

WORK="$(mktemp -d /tmp/setu-release.XXXXXX)"
cleanup() { git --git-dir="$COMMON" worktree remove --force "$WORK/src" >/dev/null 2>&1 || true; rm -rf "${WORK:?}"; }
trap cleanup EXIT

say "checking out origin/main ($(git rev-parse --short origin/main)) in $WORK/src"
git --git-dir="$COMMON" worktree add -q --detach "$WORK/src" origin/main
cd "$WORK/src"

# A persistent build cache: dependencies compile once, so later releases rebuild only Setu.
# (dist still writes its archives to the checkout's target/distrib.)
export CARGO_TARGET_DIR="${SETU_RELEASE_CACHE:-$HOME/Library/Caches/setu-release/target}"
mkdir -p "$CARGO_TARGET_DIR"

say "running cargo test"
cargo test -q 2>&1 | grep -E "^test result" || die "tests failed"

say "building Setu.app (universal, uses the Homebrew-installed setu)"
SETU_APP_UNIVERSAL=1 SETU_APP_NO_CLI=1 bash scripts/bundle-swift.sh > "$WORK/app.log" 2>&1 || { tail -20 "$WORK/app.log"; die "Setu.app build failed"; }
[ "$(lipo -archs target-swift/Setu.app/Contents/MacOS/SetuApp)" = "x86_64 arm64" ] || die "Setu.app is not universal"

say "building $TAG for Apple silicon and Intel"
dist build --tag "$TAG" --artifacts=all > "$WORK/dist.log" 2>&1 || { tail -20 "$WORK/dist.log"; die "dist build failed"; }
OUT="$WORK/src/target/distrib"
[ -d "$OUT" ] || OUT="$CARGO_TARGET_DIR/distrib"
for f in setu-aarch64-apple-darwin.tar.xz setu-x86_64-apple-darwin.tar.xz setu.rb sha256.sum; do
  [ -s "$OUT/$f" ] || die "missing artifact $f"
done
for a in aarch64 x86_64; do
  tar -tJf "$OUT/setu-$a-apple-darwin.tar.xz" | grep -q "Setu.app/Contents/MacOS/SetuApp" || die "Setu.app missing from the $a archive"
done
# One universal download for any Mac (Homebrew keeps using the per-architecture archives).
UNI="setu-universal-apple-darwin"
rm -rf "${OUT:?}/$UNI"; mkdir -p "$OUT/$UNI"
lipo -create "$OUT/setu-aarch64-apple-darwin/setu" "$OUT/setu-x86_64-apple-darwin/setu" -output "$OUT/$UNI/setu"
codesign --force --sign - "$OUT/$UNI/setu"
cp -R target-swift/Setu.app "$OUT/$UNI/"
cp README.md LICENSE "$OUT/$UNI/"
(cd "$OUT" && tar -cJf "$UNI.tar.xz" "$UNI" && shasum -a 256 "$UNI.tar.xz" > "$UNI.tar.xz.sha256" && cat "$UNI.tar.xz.sha256" >> sha256.sum)
[ "$(lipo -archs "$OUT/$UNI/setu")" = "x86_64 arm64" ] || die "the universal setu is not universal"
BUILT="$("$OUT/setu-aarch64-apple-darwin/setu" --version)"
[ "$BUILT" = "setu $VERSION" ] || die "built binary reports '$BUILT', expected 'setu $VERSION'"
say "built: $(cd "$OUT" && ls setu-*.tar.xz setu.rb | tr '\n' ' ')"

if [ "$PUBLISH" != "--publish" ]; then
  say "dry run complete; nothing was tagged or published. Re-run with --publish to release."
  exit 0
fi

if ! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  say "tagging $TAG at origin/main"
  git tag -a "$TAG" origin/main -m "setu $VERSION"
  git push -q origin "$TAG"
fi

say "creating the GitHub release"
(cd "$OUT" && gh release create "$TAG" -R "$REPO" --title "setu $VERSION" --generate-notes \
  setu-aarch64-apple-darwin.tar.xz setu-aarch64-apple-darwin.tar.xz.sha256 \
  setu-x86_64-apple-darwin.tar.xz setu-x86_64-apple-darwin.tar.xz.sha256 \
  setu-universal-apple-darwin.tar.xz setu-universal-apple-darwin.tar.xz.sha256 \
  sha256.sum source.tar.gz source.tar.gz.sha256 setu.rb)

say "updating the Homebrew tap"
git clone -q "https://github.com/$TAP.git" "$WORK/tap"
mkdir -p "$WORK/tap/Formula"
cp "$OUT/setu.rb" "$WORK/tap/Formula/setu.rb"
git -C "$WORK/tap" add Formula/setu.rb
git -C "$WORK/tap" commit -q -m "setu $VERSION"
git -C "$WORK/tap" push -q origin HEAD

say "done: brew update && brew upgrade setu && setu app   (then: launchctl kickstart -k gui/\$UID/dev.setu.daemon)"
