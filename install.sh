#!/usr/bin/env bash
# setu — one-line install
# curl -fsSL https://raw.githubusercontent.com/quivly/setu/main/install.sh | bash
set -e

if ! command -v bun &>/dev/null; then
  echo "Installing bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

echo "Installing setu..."
bun install -g github:quivly/setu

echo ""
echo "✓ setu installed — run: setu setup"
