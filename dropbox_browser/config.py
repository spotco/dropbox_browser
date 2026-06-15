from __future__ import annotations

import json
import os
import shutil
from dataclasses import dataclass
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
TEMP_DIR = PROJECT_ROOT / "Temp"
THUMBNAIL_CACHE_DIR = PROJECT_ROOT / "ThumbnailCache"
VENDORED_MAGICK_EXE = PROJECT_ROOT / "ImageMagick" / "magick.exe"
VENDORED_FFMPEG_EXE = PROJECT_ROOT / "FFmpeg" / "bin" / "ffmpeg.exe"
VENDORED_FFPROBE_EXE = PROJECT_ROOT / "FFmpeg" / "bin" / "ffprobe.exe"

_APP_CONFIG_DEFAULTS: dict = {
    "DropboxFolder": "./DropboxLocal",
    "RCloneConfig": "",
    "FFMpegPath": "",
    "FFProbePath": "",
    "LocalhostOnlyAccess": True,
    "LogRcloneCommands": True,
    "LogHttpRequests": True,
    "LogVideoDebug": True,
    "ClientLogEnabled": True,
    "ClientLogSubsystems": {
        "video": True,
        "video-subtitles": False,
        "browse-reveal": False,
        "file-search": False,
        "music-metadata": False,
    },
    "FolderCacheWorkers": 4,
    "SyncJobWorkers": 4,
    "FolderCacheTTLSeconds": 14 * 24 * 60 * 60,
    "ListingCacheTTLSeconds": 1800,
    "ThumbnailEnabled": True,
    "ThumbnailSize": 64,
    "ThumbnailMaxInputBytes": 64 * 1024 * 1024,
    "ThumbnailTimeoutSeconds": 15,
}


@dataclass(frozen=True)
class ThumbnailConfig:
    enabled: bool
    configured_enabled: bool
    cache_dir: Path
    magick_exe: Path | None
    size: int
    max_input_bytes: int
    timeout_seconds: float


@dataclass(frozen=True)
class VideoToolsConfig:
    ffmpeg_exe: Path | None
    ffprobe_exe: Path | None

    @property
    def ffmpeg_available(self) -> bool:
        return self.ffmpeg_exe is not None

    @property
    def ffprobe_available(self) -> bool:
        return self.ffprobe_exe is not None

    @property
    def compatibility_available(self) -> bool:
        return self.ffmpeg_available and self.ffprobe_available


def _read_config_file(path: Path) -> dict:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8-sig"))


def load_app_config() -> dict:
    """Load config.json plus local overrides and return a dict merged with defaults."""
    result = dict(_APP_CONFIG_DEFAULTS)
    result.update(_read_config_file(PROJECT_ROOT / "config.json"))
    result.update(_read_config_file(PROJECT_ROOT / "config_local.json"))
    return result


def find_default_rclone() -> str:
    local = PROJECT_ROOT / "rclone.exe"
    if local.exists():
        return str(local)
    found = shutil.which("rclone")
    return found or "rclone"


def _rclone_default_config() -> Path | None:
    """Return the path rclone uses by default when --config is not supplied."""
    appdata = os.environ.get("APPDATA")
    if appdata:
        return Path(appdata) / "rclone" / "rclone.conf"
    return None


def find_default_config() -> str | None:
    value = load_app_config().get("RCloneConfig", "").strip()
    if not value:
        return None
    resolved = Path(os.path.expandvars(value)).resolve()
    default = _rclone_default_config()
    if default is not None and resolved == default.resolve():
        return None  # matches rclone's own default; omit --config
    return str(resolved)


def find_dropbox_folder(app_config: dict | None = None) -> Path:
    config = app_config if app_config is not None else load_app_config()
    value = str(config.get("DropboxFolder") or _APP_CONFIG_DEFAULTS["DropboxFolder"]).strip()
    if not value:
        value = _APP_CONFIG_DEFAULTS["DropboxFolder"]
    expanded = Path(os.path.expandvars(value)).expanduser()
    if not expanded.is_absolute():
        expanded = PROJECT_ROOT / expanded
    return expanded.resolve()


def find_vendored_magick() -> Path | None:
    if VENDORED_MAGICK_EXE.exists():
        return VENDORED_MAGICK_EXE
    return None


def find_vendored_ffmpeg() -> Path | None:
    if VENDORED_FFMPEG_EXE.exists():
        return VENDORED_FFMPEG_EXE
    return None


def find_vendored_ffprobe() -> Path | None:
    if VENDORED_FFPROBE_EXE.exists():
        return VENDORED_FFPROBE_EXE
    return None


def _resolve_configured_tool_path(value: object) -> Path | None:
    text = str(value or "").strip()
    if not text:
        return None
    return Path(os.path.expandvars(text)).expanduser().resolve()


def _adjacent_tool_path(path: Path | None, sibling_name: str) -> Path | None:
    if path is None:
        return None
    candidate = path.with_name(sibling_name)
    if candidate.exists():
        return candidate
    return None


def _discover_tool(tool_name: str, *, configured_path: Path | None, vendored_path: Path | None) -> Path | None:
    if vendored_path is not None:
        return vendored_path
    if configured_path is not None and configured_path.exists():
        return configured_path
    if configured_path is not None:
        adjacent = _adjacent_tool_path(configured_path, tool_name)
        if adjacent is not None:
            return adjacent
    found = shutil.which(tool_name)
    if found:
        return Path(found).resolve()
    return None


def load_video_tools_config(app_config: dict | None = None) -> VideoToolsConfig:
    config = app_config if app_config is not None else load_app_config()
    configured_ffmpeg = _resolve_configured_tool_path(config.get("FFMpegPath"))
    configured_ffprobe = _resolve_configured_tool_path(config.get("FFProbePath"))
    ffmpeg_name = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
    ffprobe_name = "ffprobe.exe" if os.name == "nt" else "ffprobe"
    if configured_ffmpeg is not None and configured_ffprobe is None:
        configured_ffprobe = _adjacent_tool_path(configured_ffmpeg, ffprobe_name)
    if configured_ffprobe is not None and configured_ffmpeg is None:
        configured_ffmpeg = _adjacent_tool_path(configured_ffprobe, ffmpeg_name)
    vendored_ffmpeg = find_vendored_ffmpeg()
    vendored_ffprobe = find_vendored_ffprobe()
    ffmpeg_exe = _discover_tool("ffmpeg", configured_path=configured_ffmpeg, vendored_path=vendored_ffmpeg)
    ffprobe_exe = _discover_tool("ffprobe", configured_path=configured_ffprobe, vendored_path=vendored_ffprobe)
    if ffmpeg_exe is None:
        ffmpeg_exe = _adjacent_tool_path(ffprobe_exe, ffmpeg_name)
    if ffprobe_exe is None:
        ffprobe_exe = _adjacent_tool_path(ffmpeg_exe, ffprobe_name)
    return VideoToolsConfig(ffmpeg_exe=ffmpeg_exe, ffprobe_exe=ffprobe_exe)


def load_thumbnail_config(app_config: dict | None = None) -> ThumbnailConfig:
    config = app_config if app_config is not None else load_app_config()
    configured_enabled = bool(config.get("ThumbnailEnabled", _APP_CONFIG_DEFAULTS["ThumbnailEnabled"]))
    magick_exe = find_vendored_magick()
    return ThumbnailConfig(
        enabled=bool(configured_enabled and magick_exe is not None),
        configured_enabled=configured_enabled,
        cache_dir=THUMBNAIL_CACHE_DIR,
        magick_exe=magick_exe,
        size=int(config.get("ThumbnailSize", _APP_CONFIG_DEFAULTS["ThumbnailSize"])),
        max_input_bytes=int(
            config.get("ThumbnailMaxInputBytes", _APP_CONFIG_DEFAULTS["ThumbnailMaxInputBytes"])
        ),
        timeout_seconds=float(
            config.get("ThumbnailTimeoutSeconds", _APP_CONFIG_DEFAULTS["ThumbnailTimeoutSeconds"])
        ),
    )
