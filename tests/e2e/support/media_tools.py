"""Resolve repo-local ffmpeg/ffprobe for e2e fixture generation and harnesses."""
from __future__ import annotations

import os
import platform
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]


def _is_usable_binary(path: Path) -> bool:
    if not path.is_file():
        return False
    # Git LFS pointer files are tiny text stubs.
    if path.stat().st_size < 4096:
        try:
            head = path.read_bytes()[:64]
        except OSError:
            return False
        if head.startswith(b"version https://git-lfs.github.com/spec/v1"):
            return False
    if os.name != "nt" and not os.access(path, os.X_OK):
        return False
    return True


def _platform_id() -> str | None:
    system = sys.platform
    machine = platform.machine().lower()
    if system == "win32" and machine in {"amd64", "x86_64", "x64", ""}:
        return "windows-x64"
    if system == "darwin" and machine in {"x86_64", "amd64"}:
        return "darwin-x64"
    if system.startswith("linux") and machine in {"x86_64", "amd64"}:
        return "linux-x64"
    return None


def _pack_tool_candidates(repo_root: Path, *names: str) -> list[Path]:
    platform_id = _platform_id()
    if not platform_id:
        return []
    root = repo_root / ".tools" / platform_id
    paths: list[Path] = []
    for name in names:
        paths.append(root / name)
        paths.append(root / "bin" / name)
    return paths


def resolve_ffmpeg(repo_root: Path | None = None) -> Path:
    root = repo_root or REPO_ROOT
    candidates = (
        *_pack_tool_candidates(root, "ffmpeg.exe", "ffmpeg"),
        root / "tools" / "osx-intel" / "bin" / "ffmpeg",
        root / "FFmpeg" / "bin" / "ffmpeg.exe",
        root / "FFmpeg" / "bin" / "ffmpeg",
    )
    for candidate in candidates:
        if _is_usable_binary(candidate):
            return candidate
    raise FileNotFoundError(
        "No usable ffmpeg found under .tools/, tools/osx-intel/bin, or FFmpeg/bin"
    )


def resolve_ffprobe(repo_root: Path | None = None) -> Path:
    root = repo_root or REPO_ROOT
    candidates = (
        *_pack_tool_candidates(root, "ffprobe.exe", "ffprobe"),
        root / "tools" / "osx-intel" / "bin" / "ffprobe",
        root / "FFmpeg" / "bin" / "ffprobe.exe",
        root / "FFmpeg" / "bin" / "ffprobe",
    )
    for candidate in candidates:
        if _is_usable_binary(candidate):
            return candidate
    raise FileNotFoundError(
        "No usable ffprobe found under .tools/, tools/osx-intel/bin, or FFmpeg/bin"
    )
