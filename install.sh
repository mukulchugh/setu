#!/usr/bin/env bash
# setu — install
# curl -fsSL https://raw.githubusercontent.com/quivly/setu/main/install.sh | bash
set -e

if ! command -v bun &>/dev/null; then
  echo "Installing bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

SETU_DIR="$HOME/.setu"

clone_or_update() {
  if [ -d "$SETU_DIR" ]; then
    echo "Updating setu..."
    git -C "$SETU_DIR" pull --quiet
    return 0
  fi

  # Try gh first (HTTPS auth), fall back to SSH
  if command -v gh &>/dev/null && gh auth status &>/dev/null 2>&1; then
    echo "Installing setu via gh..."
    gh repo clone quivly/setu "$SETU_DIR" -- --quiet
  else
    echo "Installing setu via SSH..."
    git clone git@github.com:quivly/setu.git "$SETU_DIR" --quiet
  fi
}

clone_or_update
cd "$SETU_DIR" && bun link
echo ""
echo "✓ setu ready — run: setu setup"
