#!/usr/bin/env bash
# setu — install
# Usage: bash <(curl -fsSL https://raw.githubusercontent.com/quivly/setu/main/install.sh)
# Or just: bun install -g git@github.com:quivly/setu.git && setu setup
set -e

if ! command -v bun &>/dev/null; then
  echo "Installing bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

bun install -g git@github.com:quivly/setu.git
echo ""
echo "✓ setu installed — run: setu setup"
