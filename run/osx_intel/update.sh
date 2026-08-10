#!/usr/bin/env bash
# Pull latest master into this checkout (Intel macOS helper).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_repo_root.sh
source "$SCRIPT_DIR/_repo_root.sh"
cd "$REPO_ROOT"

echo "Updating from origin/master ..."
git pull origin master

echo
echo "Optional: refresh platform tools with:"
echo "  $SCRIPT_DIR/setup_exe.sh"
