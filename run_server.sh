#!/usr/bin/env bash
# POSIX equivalent of run_server.bat: start the Dropbox browser HTTP server.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
APP_ROOT="$SCRIPT_DIR"

# Prefer a repo-local Python if present (Windows bundle layout); otherwise system Python.
if [[ -x "$SCRIPT_DIR/python/python.exe" ]]; then
  PYTHON_EXE="$SCRIPT_DIR/python/python.exe"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON_EXE="$(command -v python3)"
elif command -v python >/dev/null 2>&1; then
  PYTHON_EXE="$(command -v python)"
else
  echo "error: python3 (or python) not found on PATH" >&2
  exit 1
fi

# Bind on all interfaces so LAN clients can connect when LocalhostOnlyAccess is false.
exec "$PYTHON_EXE" -c "import sys; sys.path.insert(0, r'''$APP_ROOT'''); from dropbox_browser.cli import main; raise SystemExit(main())" --host 0.0.0.0 --port 8000 --remote dropbox:
