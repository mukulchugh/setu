#!/usr/bin/env bash
# setu — install
# curl -fsSL https://raw.githubusercontent.com/quivly/setu/main/install.sh | bash
set -e

if ! command -v bun &>/dev/null; then
  echo "Installing bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

if ! command -v gh &>/dev/null; then
  echo "gh CLI required — install from https://cli.github.com then run: gh auth login"
  exit 1
fi

if [ -d "$HOME/.setu" ]; then
  echo "Updating setu..."
  git -C "$HOME/.setu" pull --quiet
else
  echo "Installing setu..."
  gh repo clone quivly/setu "$HOME/.setu" -- --quiet
fi

cd "$HOME/.setu" && bun link
echo ""
echo "✓ setu ready — run: setu setup"
