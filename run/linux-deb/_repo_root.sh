#!/usr/bin/env bash
# Resolve repository root from this script's location (run/linux-deb -> repo root).
_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$_SCRIPT_DIR/../.." && pwd)"
if [[ ! -f "$REPO_ROOT/dropbox_browser.py" ]]; then
  echo "error: could not resolve repo root from $_SCRIPT_DIR" >&2
  echo "expected dropbox_browser.py under $REPO_ROOT" >&2
  return 1 2>/dev/null || exit 1
fi
unset _SCRIPT_DIR
