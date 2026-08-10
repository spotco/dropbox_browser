"""Shared helpers for platform runtime tool packs.

Pack layout (zip root is the platform id):

  windows-x64/
    rclone.exe
    ffmpeg.exe
    ffprobe.exe
    ImageMagick/magick.exe   (+ xml/icc/licenses)
  darwin-x64/
    bin/rclone
    bin/ffmpeg
    bin/ffprobe
    bin/magick               (launcher)
    imagemagick7/...         (relocatable runtime, no static libs/docs)

Extracted trees live under ``.tools/<platform-id>/`` (gitignored).
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import sys
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parent.parent
TOOLS_DIR = PROJECT_ROOT / "tools"
PACKS_DIR = PROJECT_ROOT / "tools-packs"
EXTRACT_ROOT = PROJECT_ROOT / ".tools"
MANIFEST_PATH = TOOLS_DIR / "runtime_manifest.json"
STAMP_NAME = ".pack-sha256"

PACK_FORMAT = "dropbox-browser-tool-packs-v1"
DEFAULT_RELEASE_TAG = "tools-v1"
DEFAULT_REPOSITORY = "spotco/dropbox_browser"

# Windows ImageMagick: single multi-call entrypoint + config/resources only.
WINDOWS_IMAGEMAGICK_FILES = (
    "magick.exe",
    "LICENSE.txt",
    "NOTICE.txt",
    "colors.xml",
    "configure.xml",
    "delegates.xml",
    "english.xml",
    "locale.xml",
    "log.xml",
    "mime.xml",
    "policy.xml",
    "sRGB.icc",
    "thresholds.xml",
    "type-ghostscript.xml",
    "type.xml",
)


def runtime_platform_id() -> str | None:
    """Return the pack platform id for this machine, or None if unsupported."""
    system = sys.platform
    machine = platform.machine().lower()
    if system == "win32":
        if machine in {"amd64", "x86_64", "x64", ""}:
            return "windows-x64"
        return None
    if system == "darwin":
        if machine in {"x86_64", "amd64"}:
            return "darwin-x64"
        if machine in {"arm64", "aarch64"}:
            return "darwin-arm64"
        return None
    if system.startswith("linux"):
        if machine in {"x86_64", "amd64"}:
            return "linux-x64"
        if machine in {"aarch64", "arm64"}:
            return "linux-arm64"
        return None
    return None


def tools_platform_root(project_root: Path | None = None) -> Path | None:
    """Return ``.tools/<platform>/`` when that directory exists."""
    root = (project_root or PROJECT_ROOT).resolve()
    platform_id = runtime_platform_id()
    if not platform_id:
        return None
    path = root / ".tools" / platform_id
    if path.is_dir():
        return path
    return None


def load_manifest(path: Path | None = None) -> dict[str, Any]:
    manifest_path = path or MANIFEST_PATH
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    if data.get("format") != PACK_FORMAT:
        raise ValueError(f"unsupported tool pack manifest format: {data.get('format')!r}")
    return data


def save_manifest(data: dict[str, Any], path: Path | None = None) -> None:
    manifest_path = path or MANIFEST_PATH
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, indent=2, sort_keys=False) + "\n"
    manifest_path.write_text(text, encoding="utf-8")


def sha256_file(path: Path, *, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(chunk_size)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def release_asset_url(manifest: dict[str, Any], platform_id: str) -> str:
    platforms = manifest.get("platforms") or {}
    entry = platforms.get(platform_id)
    if not isinstance(entry, dict):
        raise KeyError(f"platform {platform_id!r} not in manifest")
    asset = str(entry.get("asset") or "").strip()
    if not asset:
        raise KeyError(f"platform {platform_id!r} missing asset name")
    explicit = str(entry.get("url") or "").strip()
    if explicit:
        return explicit
    base = str(manifest.get("base_url") or "").rstrip("/")
    if base:
        return f"{base}/{asset}"
    repo = str(manifest.get("repository") or DEFAULT_REPOSITORY).strip()
    tag = str(manifest.get("release_tag") or DEFAULT_RELEASE_TAG).strip()
    return f"https://github.com/{repo}/releases/download/{tag}/{asset}"


def pack_zip_name(platform_id: str, release_tag: str) -> str:
    version = release_tag.removeprefix("tools-") if release_tag.startswith("tools-") else release_tag
    return f"dropbox-browser-tools-{platform_id}-{version}.zip"


def first_existing(candidates: list[Path]) -> Path | None:
    for candidate in candidates:
        if candidate.exists():
            return candidate.resolve()
    return None


def find_tool_in_platform_root(platform_root: Path, *relative_names: str) -> Path | None:
    return first_existing([platform_root / name for name in relative_names])


def read_stamp(platform_root: Path) -> str | None:
    stamp = platform_root / STAMP_NAME
    if not stamp.is_file():
        return None
    return stamp.read_text(encoding="utf-8").strip() or None


def write_stamp(platform_root: Path, sha256: str) -> None:
    platform_root.mkdir(parents=True, exist_ok=True)
    (platform_root / STAMP_NAME).write_text(sha256.strip() + "\n", encoding="utf-8")


def empty_manifest(release_tag: str = DEFAULT_RELEASE_TAG, repository: str = DEFAULT_REPOSITORY) -> dict[str, Any]:
    return {
        "format": PACK_FORMAT,
        "release_tag": release_tag,
        "repository": repository,
        "base_url": f"https://github.com/{repository}/releases/download/{release_tag}",
        "platforms": {},
    }


def is_darwin_imagemagick_keep(rel_posix: str) -> bool:
    """Return True when an osx-intel ImageMagick path should ship in the pack."""
    lower = rel_posix.lower()
    # Drop bulk that is not needed at runtime for magick convert/thumbnail work.
    if lower.endswith(".a"):
        return False
    skip_parts = (
        "/include/",
        "/share/doc/",
        "/share/man/",
        "/man/",
        "/perl5/",
        "/pkgconfig/",
        "/downloads/",
        "/.turd_",
    )
    if any(part in lower for part in skip_parts):
        return False
    if lower.endswith(".pc"):
        return False
    # Keep dylibs, modules, config xml, magick.bin, launcher deps.
    return True
