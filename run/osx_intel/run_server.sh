#!/usr/bin/env bash
# Start the Dropbox browser HTTP and HTTPS servers (Intel macOS).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_repo_root.sh
source "$SCRIPT_DIR/_repo_root.sh"
cd "$REPO_ROOT"

if [[ -x "$REPO_ROOT/python/python.exe" ]]; then
  PYTHON_EXE="$REPO_ROOT/python/python.exe"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON_EXE="$(command -v python3)"
elif command -v python >/dev/null 2>&1; then
  PYTHON_EXE="$(command -v python)"
else
  echo "error: python3 (or python) not found on PATH" >&2
  exit 1
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

# Bind on all interfaces so LAN clients can connect when LocalhostOnlyAccess is false.
exec "$PYTHON_EXE" -c "import sys; sys.path.insert(0, r'''$REPO_ROOT'''); from dropbox_browser.cli import main; raise SystemExit(main())" \
  --host 0.0.0.0 --port "$PORT" --remote dropbox: "${HTTPS_ARGS[@]}" "${TLS_DIR_ARGS[@]}" "$@"
