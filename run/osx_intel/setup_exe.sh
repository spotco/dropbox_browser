#!/usr/bin/env bash
# Bootstrap Intel macOS runtime tools into .tools/darwin-x64.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_repo_root.sh
source "$SCRIPT_DIR/_repo_root.sh"
cd "$REPO_ROOT"

if command -v python3 >/dev/null 2>&1; then
  PYTHON_EXE="$(command -v python3)"
elif command -v python >/dev/null 2>&1; then
  PYTHON_EXE="$(command -v python)"
else
  echo "error: python3 (or python) not found on PATH" >&2
  exit 1
fi

machine="$(uname -m 2>/dev/null || true)"
if [[ "$(uname -s 2>/dev/null || true)" != "Darwin" ]]; then
  echo "warning: setup_exe.sh under run/osx_intel is intended for macOS Intel; continuing anyway" >&2
elif [[ "$machine" != "x86_64" ]]; then
  echo "warning: host machine is '$machine' (expected x86_64 for darwin-x64 pack)" >&2
fi

echo "Installing darwin-x64 tool pack into .tools/darwin-x64 ..."
"$PYTHON_EXE" tools/bootstrap_tools.py --platform darwin-x64 "$@"

echo
echo "Done. Start the server with:"
echo "  $SCRIPT_DIR/run.sh"
echo "Or: $SCRIPT_DIR/run_server.sh"
