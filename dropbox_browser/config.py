from __future__ import annotations

import json
import os
import platform
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
TEMP_DIR = PROJECT_ROOT / "Temp"
PHOTO_MAP_CACHE_DIR = PROJECT_ROOT / "Cache" / "PhotoMap"
PHOTO_MAP_CACHE_BATCH_LIMIT = 200
MUSIC_WAVEFORM_CACHE_ENTRY_LIMIT_DEFAULT = 20
MUSIC_WAVEFORM_CACHE_ENTRY_LIMIT_MAX = 100
MUSIC_WAVEFORM_MAX_RESOLUTION_DEFAULT = 256
MUSIC_WAVEFORM_MAX_RESOLUTION_MIN = 64
MUSIC_WAVEFORM_MAX_RESOLUTION_MAX = 512
THUMBNAIL_CACHE_DIR = PROJECT_ROOT / "ThumbnailCache"
TOOLS_EXTRACT_ROOT = PROJECT_ROOT / ".tools"
VENDORED_MAGICK_EXE = PROJECT_ROOT / "ImageMagick" / "magick.exe"
VENDORED_FFMPEG_EXE = PROJECT_ROOT / "FFmpeg" / "bin" / "ffmpeg.exe"
VENDORED_FFPROBE_EXE = PROJECT_ROOT / "FFmpeg" / "bin" / "ffprobe.exe"
# Legacy Intel macOS layout from the osx-intel branch (pre-pack).
LEGACY_OSX_INTEL_BIN = PROJECT_ROOT / "tools" / "osx-intel" / "bin"

_APP_CONFIG_DEFAULTS: dict = {
    "DropboxFolder": "./DropboxLocal",
    "RCloneConfig": "",
    # Empty = auto-discover (prefer .tools/<platform>/python, then repo python/, then PATH).
    "PythonPath": "",
    "MagickPath": "",
    "FFMpegPath": "",
    "FFProbePath": "",
    "VideoFFmpegReadRate": 1.1,
    "VideoFFmpegInitialBurstSeconds": 18.0,
    "VideoFFmpegCatchupReadRate": 1.3,
    "VideoFFmpegThreads": 0,
    "VideoFFmpegFilterThreads": 0,
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
    "MusicWaveformCacheEntryLimit": MUSIC_WAVEFORM_CACHE_ENTRY_LIMIT_DEFAULT,
    "MusicWaveformMaxResolution": MUSIC_WAVEFORM_MAX_RESOLUTION_DEFAULT,
    "VideoProbeProbeSizeBytes": 2 * 1024 * 1024,
    "VideoProbeAnalyzeDurationUs": 3_000_000,
    "CacheStaticAssets": True,
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
        "music-waveform": False,
        "photo-map": False,
    },
    "FolderCacheWorkers": 4,
    "SyncJobWorkers": 4,
    # Write rclone (rcat/copyto/mkdir) process timeout policy. Matches
    # dropbox_browser.rclone.DEFAULT_WRITE_RETRY_POLICY defaults.
    "RcloneWriteMaxAttempts": 25,
    "RcloneWriteMinTimeoutSeconds": 10.0,
    "RcloneWriteTimeoutPerGibSeconds": 20.0,
    "RcloneWriteMaxInitialTimeoutSeconds": 300.0,
    "RcloneWriteTimeoutMultiplier": 2.0,
    "RcloneWriteMaxTimeoutSeconds": 600.0,
    "FolderCacheTTLSeconds": 14 * 24 * 60 * 60,
    "ListingCacheTTLSeconds": 1800,
    "ThumbnailEnabled": True,
    "ThumbnailSize": 64,
    "ThumbnailMaxInputBytes": 64 * 1024 * 1024,
    "ThumbnailTimeoutSeconds": 15,
    "VideoThumbnailEnabled": True,
    "VideoThumbnailSize": 256,
    "VideoThumbnailMaxInputBytes": 2 * 1024 * 1024 * 1024,
    "VideoThumbnailTimeoutSeconds": 30,
}

_VIDEO_FFMPEG_READ_RATE_MAX = 16.0
_VIDEO_FFMPEG_INITIAL_BURST_SECONDS_MAX = 600.0
_VIDEO_FFMPEG_THREADS_MAX = 64
_VIDEO_SESSION_IDLE_TTL_SECONDS_MAX = 7 * 24 * 60 * 60.0
_VIDEO_BACKPRESSURE_SECONDS_MAX = 24 * 60 * 60.0
_VIDEO_FFMPEG_PROCESS_PRIORITIES = {"idle", "below_normal", "normal"}


def normalize_music_waveform_cache_entry_limit(value: object) -> int:
    """Return a bounded integer count for browser waveform cache entries."""
    try:
        if isinstance(value, bool):
            raise ValueError
        normalized = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError, OverflowError):
        normalized = MUSIC_WAVEFORM_CACHE_ENTRY_LIMIT_DEFAULT
    return min(max(normalized, 0), MUSIC_WAVEFORM_CACHE_ENTRY_LIMIT_MAX)


def normalize_music_waveform_max_resolution(value: object) -> int:
    """Return a bounded maximum resolution for browser waveform summaries."""
    try:
        if isinstance(value, bool):
            raise ValueError
        normalized = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError, OverflowError):
        normalized = MUSIC_WAVEFORM_MAX_RESOLUTION_DEFAULT
    return min(max(normalized, MUSIC_WAVEFORM_MAX_RESOLUTION_MIN), MUSIC_WAVEFORM_MAX_RESOLUTION_MAX)


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
    video_thumbnail_enabled: bool = True
    video_thumbnail_size: int = 256
    video_thumbnail_max_input_bytes: int = 2 * 1024 * 1024 * 1024
    video_thumbnail_timeout_seconds: float = 30.0

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


def runtime_platform_id() -> str | None:
    """Return the tool-pack platform id for this host, or None if unsupported."""
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


def tools_platform_root() -> Path | None:
    """Return ``.tools/<platform>/`` when a bootstrapped pack is present."""
    platform_id = runtime_platform_id()
    if not platform_id:
        return None
    path = TOOLS_EXTRACT_ROOT / platform_id
    if path.is_dir():
        return path
    return None


def _first_existing_path(candidates: list[Path]) -> Path | None:
    for candidate in candidates:
        if candidate.exists():
            return candidate.resolve()
    return None


def default_tools_python_path() -> Path:
    """Default relative portable Python path under the windows-x64 tool pack."""
    return TOOLS_EXTRACT_ROOT / "windows-x64" / "python" / "python.exe"


def find_python_exe(app_config: dict | None = None) -> str:
    """Resolve the Python interpreter used by Windows launchers and helpers.

    Order:
    1. ``DROPBOX_BROWSER_PYTHON`` env (absolute path)
    2. Config ``PythonPath`` when set
    3. Bootstrapped ``.tools/windows-x64/python/python.exe`` (and POSIX pack shapes)
    4. Legacy repo ``python/python.exe``
    5. ``PATH`` (``python`` / ``python3``)
    """
    env_value = str(os.environ.get("DROPBOX_BROWSER_PYTHON") or "").strip()
    if env_value:
        env_path = Path(os.path.expandvars(env_value)).expanduser()
        if env_path.is_file():
            return str(env_path.resolve())

    config = app_config if app_config is not None else load_app_config()
    configured = _resolve_configured_tool_path(config.get("PythonPath"))
    if configured is not None and configured.is_file():
        return str(configured)

    pack_root = tools_platform_root()
    pack_candidates: list[Path] = []
    if pack_root is not None:
        pack_candidates.extend(
            [
                pack_root / "python" / "python.exe",
                pack_root / "python" / "python",
                pack_root / "bin" / "python3",
                pack_root / "bin" / "python",
            ]
        )
    # Explicit windows-x64 default even if tools_platform_root is None on odd hosts.
    pack_candidates.append(default_tools_python_path())
    packed = _first_existing_path(pack_candidates)
    if packed is not None:
        return str(packed)

    legacy = _first_existing_path(
        [
            PROJECT_ROOT / "python" / "python.exe",
            PROJECT_ROOT / "python" / "python",
        ]
    )
    if legacy is not None:
        return str(legacy)

    for name in ("python", "python3", "python.exe"):
        found = shutil.which(name)
        if found:
            return found
    return "python.exe" if os.name == "nt" else "python3"


def find_default_rclone() -> str:
    pack_root = tools_platform_root()
    if pack_root is not None:
        packed = _first_existing_path(
            [
                pack_root / "rclone.exe",
                pack_root / "rclone",
                pack_root / "bin" / "rclone.exe",
                pack_root / "bin" / "rclone",
            ]
        )
        if packed is not None:
            return str(packed)

    local = PROJECT_ROOT / "rclone.exe"
    if local.exists():
        return str(local)

    legacy_osx = LEGACY_OSX_INTEL_BIN / "rclone"
    if legacy_osx.exists():
        return str(legacy_osx.resolve())

    found = shutil.which("rclone.exe" if os.name == "nt" else "rclone")
    return found or "rclone"


def _rclone_default_config() -> Path | None:
    """Return the path rclone uses by default when --config is not supplied."""
    appdata = os.environ.get("APPDATA")
    if appdata:
        return Path(appdata) / "rclone" / "rclone.conf"
    # POSIX default (~/.config/rclone/rclone.conf).
    xdg = os.environ.get("XDG_CONFIG_HOME")
    if xdg:
        return Path(xdg) / "rclone" / "rclone.conf"
    home = os.environ.get("HOME")
    if home:
        return Path(home) / ".config" / "rclone" / "rclone.conf"
    return None


def find_default_config() -> str | None:
    value = load_app_config().get("RCloneConfig", "").strip()
    if not value:
        return None
    # Packaged Windows %APPDATA% paths are not meaningful on POSIX hosts.
    if os.name != "nt" and (value.startswith("%") or "\\" in value):
        return None
    resolved = Path(os.path.expandvars(value)).expanduser().resolve()
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
    pack_root = tools_platform_root()
    if pack_root is not None:
        packed = _first_existing_path(
            [
                pack_root / "ImageMagick" / "magick.exe",
                pack_root / "ImageMagick" / "magick",
                pack_root / "bin" / "magick",
                pack_root / "magick",
                pack_root / "magick.exe",
            ]
        )
        if packed is not None:
            return packed
    if VENDORED_MAGICK_EXE.exists():
        return VENDORED_MAGICK_EXE
    legacy_osx = LEGACY_OSX_INTEL_BIN / "magick"
    if legacy_osx.exists():
        return legacy_osx.resolve()
    return None


def find_vendored_ffmpeg() -> Path | None:
    pack_root = tools_platform_root()
    if pack_root is not None:
        packed = _first_existing_path(
            [
                pack_root / "ffmpeg.exe",
                pack_root / "ffmpeg",
                pack_root / "bin" / "ffmpeg.exe",
                pack_root / "bin" / "ffmpeg",
            ]
        )
        if packed is not None:
            return packed
    if VENDORED_FFMPEG_EXE.exists():
        return VENDORED_FFMPEG_EXE
    legacy_osx = LEGACY_OSX_INTEL_BIN / "ffmpeg"
    if legacy_osx.exists():
        return legacy_osx.resolve()
    return None


def find_vendored_ffprobe() -> Path | None:
    pack_root = tools_platform_root()
    if pack_root is not None:
        packed = _first_existing_path(
            [
                pack_root / "ffprobe.exe",
                pack_root / "ffprobe",
                pack_root / "bin" / "ffprobe.exe",
                pack_root / "bin" / "ffprobe",
            ]
        )
        if packed is not None:
            return packed
    if VENDORED_FFPROBE_EXE.exists():
        return VENDORED_FFPROBE_EXE
    legacy_osx = LEGACY_OSX_INTEL_BIN / "ffprobe"
    if legacy_osx.exists():
        return legacy_osx.resolve()
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
        video_thumbnail_enabled=bool(config.get("VideoThumbnailEnabled", _APP_CONFIG_DEFAULTS["VideoThumbnailEnabled"])),
        video_thumbnail_size=max(
            16,
            _clamp_non_negative_int(
                config.get("VideoThumbnailSize", _APP_CONFIG_DEFAULTS["VideoThumbnailSize"]),
                default=int(_APP_CONFIG_DEFAULTS["VideoThumbnailSize"]),
                maximum=1024,
            ),
        ),
        video_thumbnail_max_input_bytes=_clamp_non_negative_int(
            config.get("VideoThumbnailMaxInputBytes", _APP_CONFIG_DEFAULTS["VideoThumbnailMaxInputBytes"]),
            default=int(_APP_CONFIG_DEFAULTS["VideoThumbnailMaxInputBytes"]),
            maximum=16 * 1024 * 1024 * 1024,
        ),
        video_thumbnail_timeout_seconds=max(
            1.0,
            _clamp_non_negative_float(
                config.get("VideoThumbnailTimeoutSeconds", _APP_CONFIG_DEFAULTS["VideoThumbnailTimeoutSeconds"]),
                default=float(_APP_CONFIG_DEFAULTS["VideoThumbnailTimeoutSeconds"]),
                maximum=300.0,
            ),
        ),
    )


def load_thumbnail_config(app_config: dict | None = None) -> ThumbnailConfig:
    config = app_config if app_config is not None else load_app_config()
    configured_enabled = bool(config.get("ThumbnailEnabled", _APP_CONFIG_DEFAULTS["ThumbnailEnabled"]))
    configured_magick = _resolve_configured_tool_path(config.get("MagickPath"))
    magick_name = "magick.exe" if os.name == "nt" else "magick"
    magick_exe = _discover_tool(
        magick_name,
        configured_path=configured_magick,
        vendored_path=find_vendored_magick(),
    )
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
