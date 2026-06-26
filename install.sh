#!/usr/bin/env bash
# setu — install
# Usage: git clone git@github.com:quivly/setu.git /tmp/setu && bun install -g /tmp/setu && setu setup
set -e

if ! command -v bun &>/dev/null; then
  echo "Installing bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT

echo "Cloning quivly/setu..."
git clone git@github.com:quivly/setu.git "$TMP/setu" --quiet

bun install -g "$TMP/setu"
echo ""
echo "✓ setu installed — run: setu setup"
