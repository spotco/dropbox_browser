#!/usr/bin/env bash
# Download native Linux x86_64 runtime tools into .tools/linux-x64.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_repo_root.sh"
cd "$REPO_ROOT"

if [[ "$(uname -s 2>/dev/null || true)" != "Linux" ]]; then
  echo "error: run/linux-deb/setup_exe.sh requires Linux." >&2
  exit 1
fi
if [[ "$(uname -m 2>/dev/null || true)" != "x86_64" ]]; then
  echo "error: this launcher currently supports Linux x86_64 only." >&2
  exit 1
fi
for command_name in python3; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "error: required command not found: $command_name" >&2
    exit 1
  fi
done

PYTHON_EXE="$(command -v python3)"
echo "Downloading and installing the linux-x64 tool pack from GitHub tools-v1 ..."
"$PYTHON_EXE" "$REPO_ROOT/tools/bootstrap_tools.py" --platform linux-x64

PACK_ROOT="$REPO_ROOT/.tools/linux-x64"

echo "Installed:"
"$PACK_ROOT/bin/rclone" version | sed -n '1,2p'
"$PACK_ROOT/bin/ffmpeg" -version | sed -n '1,1p'
"$PACK_ROOT/bin/magick" -version | sed -n '1,1p'
