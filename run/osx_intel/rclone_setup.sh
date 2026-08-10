#!/usr/bin/env bash
# Interactive rclone Dropbox remote setup (Intel macOS).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_repo_root.sh
source "$SCRIPT_DIR/_repo_root.sh"
cd "$REPO_ROOT"

echo "rclone Dropbox Setup"

RCLONE=""
if [[ -x "$REPO_ROOT/.tools/darwin-x64/bin/rclone" ]]; then
  RCLONE="$REPO_ROOT/.tools/darwin-x64/bin/rclone"
elif [[ -x "$REPO_ROOT/.tools/darwin-x64/rclone" ]]; then
  RCLONE="$REPO_ROOT/.tools/darwin-x64/rclone"
elif [[ -x "$REPO_ROOT/tools/osx-intel/bin/rclone" ]]; then
  RCLONE="$REPO_ROOT/tools/osx-intel/bin/rclone"
elif command -v rclone >/dev/null 2>&1; then
  RCLONE="$(command -v rclone)"
fi

if [[ -z "$RCLONE" ]]; then
  echo "error: rclone not found. Run $SCRIPT_DIR/setup_exe.sh first." >&2
  exit 1
fi

echo "Using: $RCLONE"
exec "$RCLONE" config create dropbox dropbox
