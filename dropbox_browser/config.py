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
    "VideoFFmpegReadRate": 1.1,
    "VideoFFmpegInitialBurstSeconds": 18.0,
    "VideoFFmpegCatchupReadRate": 1.3,
    "VideoFFmpegThreads": 2,
    "VideoFFmpegFilterThreads": 1,
    "VideoFFmpegProcessPriority": "below_normal",
    "VideoMaxConcurrentSessions": 8,
    "VideoSessionIdleTTLSeconds": 15 * 60,
    "VideoBackpressureLowWaterSeconds": 45.0,
    "VideoBackpressureMediumWaterSeconds": 120.0,
    "VideoBackpressureHighWaterSeconds": 300.0,
    "VideoBackpressureMaxWaterSeconds": 600.0,
    "VideoSubtitleFontFamily": "Arial, Helvetica, sans-serif",
    "VideoSubtitleFontSizePx": 28,
    "VideoSubtitleBold": True,
    "VideoProbeCacheTTLSeconds": 7 * 24 * 60 * 60,
    "VideoProbeCacheMaxBytes": 50 * 1024 * 1024,
    "VideoSubtitleCacheTTLSeconds": 7 * 24 * 60 * 60,
    "VideoSubtitleCacheMaxBytes": 200 * 1024 * 1024,
    "VideoHeaderCacheTTLSeconds": 24 * 60 * 60,
    "VideoHeaderCacheMaxBytes": 500 * 1024 * 1024,
    "VideoHeaderCacheBytes": 8 * 1024 * 1024,
    "VideoProbeProbeSizeBytes": 2 * 1024 * 1024,
    "VideoProbeAnalyzeDurationUs": 3_000_000,
    "LocalhostOnlyAccess": True,
    "LogRcloneCommands": True,
    "LogHttpRequests": True,
    "LogVideoDebug": False,
    "ClientLogEnabled": True,
    "ClientLogSubsystems": {
        "video": True,
        "video-timing": True,
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

_VIDEO_FFMPEG_READ_RATE_MAX = 16.0
_VIDEO_FFMPEG_INITIAL_BURST_SECONDS_MAX = 600.0
_VIDEO_FFMPEG_THREADS_MAX = 64
_VIDEO_SESSION_IDLE_TTL_SECONDS_MAX = 7 * 24 * 60 * 60.0
_VIDEO_BACKPRESSURE_SECONDS_MAX = 24 * 60 * 60.0
_VIDEO_FFMPEG_PROCESS_PRIORITIES = {"idle", "below_normal", "normal"}


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
    ffmpeg_read_rate: float = 0.0
    ffmpeg_initial_burst_seconds: float = 0.0
    ffmpeg_catchup_read_rate: float = 0.0
    ffmpeg_threads: int = 0
    ffmpeg_filter_threads: int = 0
    ffmpeg_process_priority: str = "below_normal"
    max_concurrent_sessions: int = 8
    session_idle_ttl_seconds: float = 15 * 60.0
    backpressure_low_water_seconds: float = 45.0
    backpressure_medium_water_seconds: float = 120.0
    backpressure_high_water_seconds: float = 300.0
    backpressure_max_water_seconds: float = 600.0

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


def _merge_app_config_layers(*layers: dict) -> dict:
    result = dict(_APP_CONFIG_DEFAULTS)
    for layer in layers:
        merged = dict(result)
        merged.update(layer)
        default_subsystems = result.get("ClientLogSubsystems")
        layer_subsystems = layer.get("ClientLogSubsystems")
        if isinstance(default_subsystems, dict) and isinstance(layer_subsystems, dict):
            merged["ClientLogSubsystems"] = {
                **default_subsystems,
                **layer_subsystems,
            }
        result = merged
    return result


def load_app_config() -> dict:
    """Load config.json plus local overrides and return a dict merged with defaults."""
    return _merge_app_config_layers(
        _read_config_file(PROJECT_ROOT / "config.json"),
        _read_config_file(PROJECT_ROOT / "config_local.json"),
    )


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


def _clamp_non_negative_float(value: object, *, default: float, maximum: float) -> float:
    try:
        normalized = float(value)
    except (TypeError, ValueError):
        return default
    if normalized <= 0:
        return 0.0
    return min(normalized, maximum)


def _clamp_non_negative_int(value: object, *, default: int, maximum: int) -> int:
    try:
        normalized = int(value)
    except (TypeError, ValueError):
        return default
    if normalized <= 0:
        return 0
    return min(normalized, maximum)


def _normalize_video_process_priority(value: object, *, default: str) -> str:
    normalized = str(value or "").strip().lower().replace("-", "_")
    if normalized in _VIDEO_FFMPEG_PROCESS_PRIORITIES:
        return normalized
    return default


def _load_video_backpressure_thresholds(config: dict) -> tuple[float, float, float, float]:
    low = _clamp_non_negative_float(
        config.get("VideoBackpressureLowWaterSeconds", _APP_CONFIG_DEFAULTS["VideoBackpressureLowWaterSeconds"]),
        default=float(_APP_CONFIG_DEFAULTS["VideoBackpressureLowWaterSeconds"]),
        maximum=_VIDEO_BACKPRESSURE_SECONDS_MAX,
    )
    medium = _clamp_non_negative_float(
        config.get("VideoBackpressureMediumWaterSeconds", _APP_CONFIG_DEFAULTS["VideoBackpressureMediumWaterSeconds"]),
        default=float(_APP_CONFIG_DEFAULTS["VideoBackpressureMediumWaterSeconds"]),
        maximum=_VIDEO_BACKPRESSURE_SECONDS_MAX,
    )
    high = _clamp_non_negative_float(
        config.get("VideoBackpressureHighWaterSeconds", _APP_CONFIG_DEFAULTS["VideoBackpressureHighWaterSeconds"]),
        default=float(_APP_CONFIG_DEFAULTS["VideoBackpressureHighWaterSeconds"]),
        maximum=_VIDEO_BACKPRESSURE_SECONDS_MAX,
    )
    max_value = _clamp_non_negative_float(
        config.get("VideoBackpressureMaxWaterSeconds", _APP_CONFIG_DEFAULTS["VideoBackpressureMaxWaterSeconds"]),
        default=float(_APP_CONFIG_DEFAULTS["VideoBackpressureMaxWaterSeconds"]),
        maximum=_VIDEO_BACKPRESSURE_SECONDS_MAX,
    )
    medium = max(low, medium)
    high = max(medium, high)
    max_value = max(high, max_value)
    return low, medium, high, max_value


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
    (
        backpressure_low_water_seconds,
        backpressure_medium_water_seconds,
        backpressure_high_water_seconds,
        backpressure_max_water_seconds,
    ) = _load_video_backpressure_thresholds(config)
    return VideoToolsConfig(
        ffmpeg_exe=ffmpeg_exe,
        ffprobe_exe=ffprobe_exe,
        ffmpeg_read_rate=_clamp_non_negative_float(
            config.get("VideoFFmpegReadRate", _APP_CONFIG_DEFAULTS["VideoFFmpegReadRate"]),
            default=float(_APP_CONFIG_DEFAULTS["VideoFFmpegReadRate"]),
            maximum=_VIDEO_FFMPEG_READ_RATE_MAX,
        ),
        ffmpeg_initial_burst_seconds=_clamp_non_negative_float(
            config.get(
                "VideoFFmpegInitialBurstSeconds",
                _APP_CONFIG_DEFAULTS["VideoFFmpegInitialBurstSeconds"],
            ),
            default=float(_APP_CONFIG_DEFAULTS["VideoFFmpegInitialBurstSeconds"]),
            maximum=_VIDEO_FFMPEG_INITIAL_BURST_SECONDS_MAX,
        ),
        ffmpeg_catchup_read_rate=_clamp_non_negative_float(
            config.get(
                "VideoFFmpegCatchupReadRate",
                _APP_CONFIG_DEFAULTS["VideoFFmpegCatchupReadRate"],
            ),
            default=float(_APP_CONFIG_DEFAULTS["VideoFFmpegCatchupReadRate"]),
            maximum=_VIDEO_FFMPEG_READ_RATE_MAX,
        ),
        ffmpeg_threads=_clamp_non_negative_int(
            config.get("VideoFFmpegThreads", _APP_CONFIG_DEFAULTS["VideoFFmpegThreads"]),
            default=int(_APP_CONFIG_DEFAULTS["VideoFFmpegThreads"]),
            maximum=_VIDEO_FFMPEG_THREADS_MAX,
        ),
        ffmpeg_filter_threads=_clamp_non_negative_int(
            config.get("VideoFFmpegFilterThreads", _APP_CONFIG_DEFAULTS["VideoFFmpegFilterThreads"]),
            default=int(_APP_CONFIG_DEFAULTS["VideoFFmpegFilterThreads"]),
            maximum=_VIDEO_FFMPEG_THREADS_MAX,
        ),
        ffmpeg_process_priority=_normalize_video_process_priority(
            config.get(
                "VideoFFmpegProcessPriority",
                _APP_CONFIG_DEFAULTS["VideoFFmpegProcessPriority"],
            ),
            default=str(_APP_CONFIG_DEFAULTS["VideoFFmpegProcessPriority"]),
        ),
        max_concurrent_sessions=max(
            1,
            _clamp_non_negative_int(
                config.get("VideoMaxConcurrentSessions", _APP_CONFIG_DEFAULTS["VideoMaxConcurrentSessions"]),
                default=int(_APP_CONFIG_DEFAULTS["VideoMaxConcurrentSessions"]),
                maximum=_VIDEO_FFMPEG_THREADS_MAX,
            ),
        ),
        session_idle_ttl_seconds=max(
            1.0,
            _clamp_non_negative_float(
                config.get("VideoSessionIdleTTLSeconds", _APP_CONFIG_DEFAULTS["VideoSessionIdleTTLSeconds"]),
                default=float(_APP_CONFIG_DEFAULTS["VideoSessionIdleTTLSeconds"]),
                maximum=_VIDEO_SESSION_IDLE_TTL_SECONDS_MAX,
            ),
        ),
        backpressure_low_water_seconds=backpressure_low_water_seconds,
        backpressure_medium_water_seconds=backpressure_medium_water_seconds,
        backpressure_high_water_seconds=backpressure_high_water_seconds,
        backpressure_max_water_seconds=backpressure_max_water_seconds,
    )


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
