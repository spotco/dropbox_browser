#!/usr/bin/env bash
# Start the server and open the default browser on Debian/Ubuntu Linux.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_repo_root.sh"
cd "$REPO_ROOT"

URL="http://127.0.0.1:8000/"
(
  for _ in $(seq 1 60); do
    if command -v curl >/dev/null 2>&1 && curl -fsS -o /dev/null --max-time 1 "$URL" 2>/dev/null; then
      if command -v xdg-open >/dev/null 2>&1; then
        xdg-open "$URL" >/dev/null 2>&1 || true
      fi
      exit 0
    fi
    sleep 0.5
  done
  echo "Server did not respond at $URL within 30 seconds." >&2
  exit 1
) &

exec "$SCRIPT_DIR/run_server.sh" "$@"
