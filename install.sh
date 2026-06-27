#!/usr/bin/env bash
# setu — install
# curl -fsSL https://raw.githubusercontent.com/quivly/setu/main/install.sh | bash
set -e

if ! command -v bun &>/dev/null; then
  echo "Installing bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

if [ -d "$HOME/.setu" ]; then
  echo "Updating setu..."
  git -C "$HOME/.setu" pull --quiet
else
  echo "Installing setu..."
  git clone git@github.com:quivly/setu.git "$HOME/.setu" --quiet
fi

cd "$HOME/.setu" && bun link --silent 2>/dev/null || bun link
echo ""
echo "✓ setu ready — run: setu setup"
