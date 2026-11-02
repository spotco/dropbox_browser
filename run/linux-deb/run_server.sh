#!/usr/bin/env bash
# Start the Dropbox browser HTTP and HTTPS servers on Debian/Ubuntu Linux.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_repo_root.sh"
cd "$REPO_ROOT"

if [[ -n "${DROPBOX_BROWSER_PYTHON:-}" && -x "$DROPBOX_BROWSER_PYTHON" ]]; then
  PYTHON_EXE="$DROPBOX_BROWSER_PYTHON"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON_EXE="$(command -v python3)"
elif command -v python >/dev/null 2>&1; then
  PYTHON_EXE="$(command -v python)"
else
  echo "error: python3 (or python) not found on PATH" >&2
  exit 1
fi

if [[ ! -x "$REPO_ROOT/.tools/linux-x64/bin/rclone" ]]; then
  echo "warning: Linux rclone pack is missing; run $SCRIPT_DIR/setup_exe.sh first." >&2
fi

PORT="${DROPBOX_BROWSER_HTTP_PORT:-8000}"
HTTPS_ARGS=(--https)
if [[ "${DROPBOX_BROWSER_REQUIRE_HTTPS:-0}" == "1" ]]; then
  HTTPS_ARGS+=(--https-required)
else
  HTTPS_ARGS+=(--https-optional)
fi
TLS_DIR_ARGS=()
if [[ -n "${DROPBOX_BROWSER_TLS_DIR:-}" ]]; then
  TLS_DIR_ARGS=(--tls-dir "$DROPBOX_BROWSER_TLS_DIR")
fi

exec "$PYTHON_EXE" -m dropbox_browser.cli --host 0.0.0.0 --port "$PORT" --remote dropbox: "${HTTPS_ARGS[@]}" "${TLS_DIR_ARGS[@]}" "$@"
