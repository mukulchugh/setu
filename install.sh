#!/usr/bin/env bash
# setu — install
# curl -fsSL https://raw.githubusercontent.com/mukulchugh/setu/main/install.sh | bash
set -e

SETU_DIR="${SETU_INSTALL_DIR:-$HOME/.setu}"

# Existing checkouts must use the guarded updater before source/dependency edits.
# An older checkout without the handshake cannot safely update its running portal.
if [ -e "$SETU_DIR" ]; then
  if ! command -v bun &>/dev/null || [ ! -f "$SETU_DIR/update-command.js" ]; then
    echo "Update refused: this installation has no guarded updater. Stop and inspect the old portal through a separately approved manual cutover."
    exit 1
  fi
  exec bun "$SETU_DIR/update-command.js" "$@"
fi

if ! command -v bun &>/dev/null; then
  echo "Installing bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

clone_or_update() {
  # Try gh first (HTTPS auth), fall back to SSH
  if command -v gh &>/dev/null && gh auth status &>/dev/null 2>&1; then
    echo "Installing setu via gh..."
    gh repo clone mukulchugh/setu "$SETU_DIR" -- --quiet
  else
    echo "Installing setu via SSH..."
    git clone git@github.com:mukulchugh/setu.git "$SETU_DIR" --quiet
  fi
}

clone_or_update
cd "$SETU_DIR" && bun install && bun link
echo ""
echo "✓ setu ready — run: setu setup   (or: setu setup --name <you> --yes for non-interactive)"
echo "  setu setup also checks for Raycast and, if it's installed, prints the one manual"
echo "  step to load the Setu Raycast extension (cd raycast && bun install && bunx ray develop)"
