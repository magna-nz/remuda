#!/usr/bin/env bash
# Build Remuda from source and install it to /Applications.
# Run from anywhere inside a checked-out copy of the repo.
#
# Usage:
#   ./scripts/build-and-install.sh          release build (slower, optimized)
#   ./scripts/build-and-install.sh --debug  debug build (faster, unoptimized)
set -euo pipefail

MODE="release"
if [ "${1:-}" = "--debug" ]; then
  MODE="debug"
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="Remuda.app"
BUNDLE_PATH="$REPO_ROOT/src-tauri/target/$MODE/bundle/macos/$APP_NAME"
INSTALL_PATH="/Applications/$APP_NAME"

for cmd in node npm cargo; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: '$cmd' is required but not found on PATH" >&2
    exit 1
  fi
done

if ! cargo tauri --version >/dev/null 2>&1; then
  echo "==> Installing tauri-cli (one-time)"
  cargo install tauri-cli --version "^2"
fi

echo "==> Installing frontend dependencies"
(cd "$REPO_ROOT/app" && npm install)

echo "==> Building $MODE bundle"
if [ "$MODE" = "debug" ]; then
  (cd "$REPO_ROOT/src-tauri" && cargo tauri build --debug)
else
  (cd "$REPO_ROOT/src-tauri" && cargo tauri build)
fi

if [ ! -d "$BUNDLE_PATH" ]; then
  echo "error: expected build output not found at $BUNDLE_PATH" >&2
  exit 1
fi

echo "==> Removing quarantine attribute (unsigned build)"
xattr -dr com.apple.quarantine "$BUNDLE_PATH"

if [ -d "$INSTALL_PATH" ]; then
  echo "==> Removing previous install at $INSTALL_PATH"
  rm -rf "$INSTALL_PATH"
fi

echo "==> Installing to $INSTALL_PATH"
cp -R "$BUNDLE_PATH" "$INSTALL_PATH"

echo "==> Done. Launching Remuda"
open "$INSTALL_PATH"
