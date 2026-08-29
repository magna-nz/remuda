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

# A Homebrew-installed Remuda owns $INSTALL_PATH as well, and this script would
# rm -rf it below. That leaves Homebrew's records pointing at an app it no
# longer controls, and the *next* `brew upgrade --cask remuda` dead-ends on
#   Error: It seems the App source '/Applications/Remuda.app' is not there.
# because the upgrade moves the old app back to staging before installing the
# new one. No cask change can recover from that — the uninstall runs against
# the installed version's receipt — so only `--force` clears it. Refuse up
# front rather than silently creating the state. Checked before the build so
# this fails in a second, not after a full release compile.
if command -v brew >/dev/null 2>&1 && brew list --cask remuda >/dev/null 2>&1; then
  cat >&2 <<EOF
error: Remuda is installed via Homebrew, which owns $INSTALL_PATH.
       Installing a local build over it would leave Homebrew's records stale
       and break the next 'brew upgrade --cask remuda'.

       Remove the Homebrew copy first:
         brew uninstall --cask remuda

       Then re-run this script.
EOF
  exit 1
fi

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
