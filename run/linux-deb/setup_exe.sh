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
for command_name in curl unzip tar sha256sum; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "error: required command not found: $command_name" >&2
    exit 1
  fi
done

PACK_ROOT="$REPO_ROOT/.tools/linux-x64"
TMP_DIR="$(mktemp -d -t dropbox-browser-linux-XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

RCLONE_URL="https://downloads.rclone.org/v1.75.0/rclone-v1.75.0-linux-amd64.zip"
RCLONE_SHA256="aa2804e08f48250e71009c727124b6341cd0288465804a9a09d14663cabafbaa"
FFMPEG_URL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"
FFMPEG_SHA256="abda8d77ce8309141f83ab8edf0596834087c52467f6badf376a6a2a4c87cf67"
MAGICK_URL="https://github.com/ImageMagick/ImageMagick/releases/download/7.1.2-29/ImageMagick-7.1.2-29-gcc-x86_64.AppImage"
MAGICK_SHA256="d43978debd8c25b12c26e368f93de827a8dc45fd13396126ae9b758cd3570485"

echo "Downloading native Linux tools into $PACK_ROOT ..."
curl -fL --retry 3 --connect-timeout 20 --max-time 300 -o "$TMP_DIR/rclone.zip" "$RCLONE_URL"
curl -fL --retry 3 --connect-timeout 20 --max-time 300 -o "$TMP_DIR/ffmpeg.tar.xz" "$FFMPEG_URL"
curl -fL --retry 3 --connect-timeout 20 --max-time 300 -o "$TMP_DIR/magick.AppImage" "$MAGICK_URL"

echo "$RCLONE_SHA256  $TMP_DIR/rclone.zip" | sha256sum -c -
echo "$FFMPEG_SHA256  $TMP_DIR/ffmpeg.tar.xz" | sha256sum -c -
echo "$MAGICK_SHA256  $TMP_DIR/magick.AppImage" | sha256sum -c -

mkdir -p "$TMP_DIR/rclone" "$TMP_DIR/ffmpeg" "$PACK_ROOT/bin"
unzip -q "$TMP_DIR/rclone.zip" -d "$TMP_DIR/rclone"
tar -xJf "$TMP_DIR/ffmpeg.tar.xz" -C "$TMP_DIR/ffmpeg"

RCLONE="$(find "$TMP_DIR/rclone" -type f -name rclone -print -quit)"
FFMPEG="$(find "$TMP_DIR/ffmpeg" -type f -name ffmpeg -print -quit)"
FFPROBE="$(find "$TMP_DIR/ffmpeg" -type f -name ffprobe -print -quit)"
if [[ -z "$RCLONE" || -z "$FFMPEG" || -z "$FFPROBE" ]]; then
  echo "error: downloaded archive did not contain the expected executables" >&2
  exit 1
fi
install -m 0755 "$RCLONE" "$PACK_ROOT/bin/rclone"
install -m 0755 "$FFMPEG" "$PACK_ROOT/bin/ffmpeg"
install -m 0755 "$FFPROBE" "$PACK_ROOT/bin/ffprobe"
install -m 0755 "$TMP_DIR/magick.AppImage" "$PACK_ROOT/bin/magick"

echo "Installed:"
"$PACK_ROOT/bin/rclone" version | sed -n '1,2p'
"$PACK_ROOT/bin/ffmpeg" -version | sed -n '1,1p'
"$PACK_ROOT/bin/magick" -version | sed -n '1,1p'
