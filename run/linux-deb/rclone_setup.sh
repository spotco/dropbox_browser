#!/usr/bin/env bash
# Interactive rclone Dropbox remote setup (Debian/Ubuntu Linux).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_repo_root.sh"
cd "$REPO_ROOT"

RCLONE="$REPO_ROOT/.tools/linux-x64/bin/rclone"
if [[ ! -x "$RCLONE" ]]; then
  if command -v rclone >/dev/null 2>&1; then
    RCLONE="$(command -v rclone)"
  else
    echo "error: rclone not found. Run $SCRIPT_DIR/setup_exe.sh first." >&2
    exit 1
  fi
fi

echo "Using: $RCLONE"
exec "$RCLONE" config create dropbox dropbox
