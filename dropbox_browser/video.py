"""Video player endpoint helpers."""
from __future__ import annotations

import hashlib
import io
import json
import math
import re
import shutil
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass
from http import HTTPStatus
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse

from . import config as config_module
from .config import TEMP_DIR
from .errors import BrowserError
from .namekeys import filename_compare_key
from .paths import clean_rel_path, remote_target
from .streaming import copy_exact
from .videocache import DiskCacheStore


VIDEO_ENDPOINT_PREFIX = "/video/endpoints/"
SUPPORTED_VIDEO_EXTENSIONS = (".mkv", ".mp4", ".m4v", ".webm", ".mov", ".avi", ".ts", ".m2ts", ".wmv")
COMPATIBILITY_EXPECTED_EXTENSIONS = (".mkv", ".avi", ".ts", ".m2ts", ".wmv")
VIDEO_SESSION_DIR = TEMP_DIR / "video_sessions"
SUBTITLE_CACHE_DIR = TEMP_DIR / "subtitle_cache"
HEADER_CACHE_SUBDIR = "video_header_cache"
PROBE_CACHE_SUBDIR = "probe_cache"
SUBTITLE_CACHE_VERSION = "webvtt-v1"
SUBTITLE_WINDOW_CACHE_VERSION = "webvtt-window-v1"
SUBTITLE_WINDOW_MANIFEST_VERSION = "webvtt-window-manifest-v1"
PROBE_CACHE_VERSION = "ffprobe-v3"
HEADER_CACHE_VERSION = "header-v1"
DEFAULT_PROBE_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60.0
DEFAULT_PROBE_CACHE_MAX_BYTES = 50 * 1024 * 1024
DEFAULT_SUBTITLE_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60.0
DEFAULT_SUBTITLE_CACHE_MAX_BYTES = 200 * 1024 * 1024
DEFAULT_HEADER_CACHE_TTL_SECONDS = 24 * 60 * 60.0
DEFAULT_HEADER_CACHE_MAX_BYTES = 500 * 1024 * 1024
DEFAULT_HEADER_CACHE_BYTES = 8 * 1024 * 1024
DEFAULT_PROBE_PROBE_SIZE_BYTES = 2 * 1024 * 1024
DEFAULT_PROBE_ANALYZE_DURATION_US = 3_000_000
HLS_PLAYLIST_NAME = "stream.m3u8"
HLS_SEGMENT_PATTERN = "segment_%05d.m4s"
HLS_SEGMENT_DURATION_SECONDS = 6.0
HLS_INIT_SEGMENT_NAME = "init.mp4"
HLS_SESSION_TTL_SECONDS = 15 * 60
HLS_MIN_READY_SEGMENTS = 1
HLS_READY_TIMEOUT_SECONDS = 20.0
HLS_ASSET_READY_TIMEOUT_SECONDS = 30.0
HLS_ASSET_READY_TIMEOUT_PROCESS_ALIVE_SECONDS = 120.0
HLS_READY_TIMEOUT_BURN_IN_SECONDS = 30.0
SUBTITLE_WINDOW_DURATION_SECONDS = 300.0
SUBTITLE_WINDOW_SEEK_LEAD_SECONDS = 15.0
SUBTITLE_WINDOW_SEEK_LAG_SECONDS = SUBTITLE_WINDOW_DURATION_SECONDS - SUBTITLE_WINDOW_SEEK_LEAD_SECONDS
SUBTITLE_WINDOW_OVERLAP_SECONDS = 1.0
SUBTITLE_WINDOW_GAP_ACTION = "pause-until-ready"
VIDEO_DEBUG_LOG_PATH = TEMP_DIR / "video_debug.jsonl"
_VIDEO_DEBUG_LOG_LOCK = threading.Lock()
_THREAD_LOCK_TYPE = type(threading.Lock())
_THREAD_EVENT_TYPE = type(threading.Event())


def _subtitle_window_inflight_guard(app: Any) -> threading.Lock:
    guard = getattr(app, "_subtitle_window_inflight_guard", None)
    if isinstance(guard, _THREAD_LOCK_TYPE):
        return guard
    guard = threading.Lock()
    setattr(app, "_subtitle_window_inflight_guard", guard)
    return guard


def _subtitle_window_inflight_map(app: Any) -> dict[str, dict[str, object]]:
    inflight = getattr(app, "_subtitle_window_inflight", None)
    if isinstance(inflight, dict):
        return inflight
    inflight = {}
    setattr(app, "_subtitle_window_inflight", inflight)
    return inflight


def _acquire_subtitle_window_inflight(app: Any, cache_key: str) -> tuple[bool, dict[str, object]]:
    with _subtitle_window_inflight_guard(app):
        inflight = _subtitle_window_inflight_map(app)
        entry = inflight.get(cache_key)
        if entry is None:
            entry = {"event": threading.Event(), "error": None}
            inflight[cache_key] = entry
            return True, entry
        return False, entry


def _release_subtitle_window_inflight(app: Any, cache_key: str, entry: dict[str, object]) -> None:
    event = entry.get("event")
    if isinstance(event, _THREAD_EVENT_TYPE):
        event.set()
    with _subtitle_window_inflight_guard(app):
        inflight = _subtitle_window_inflight_map(app)
        current = inflight.get(cache_key)
        if current is entry:
            inflight.pop(cache_key, None)


def _subtitle_backfill_guard(app: Any) -> threading.Lock:
    guard = getattr(app, "_subtitle_backfill_guard", None)
    if isinstance(guard, _THREAD_LOCK_TYPE):
        return guard
    guard = threading.Lock()
    setattr(app, "_subtitle_backfill_guard", guard)
    return guard


def _subtitle_backfill_jobs(app: Any) -> dict[str, threading.Thread]:
    jobs = getattr(app, "_subtitle_backfill_jobs", None)
    if isinstance(jobs, dict):
        return jobs
    jobs = {}
    setattr(app, "_subtitle_backfill_jobs", jobs)
    return jobs


def _subtitle_backfill_context_guard(app: Any) -> threading.Lock:
    guard = getattr(app, "_subtitle_backfill_context_guard", None)
    if isinstance(guard, _THREAD_LOCK_TYPE):
        return guard
    guard = threading.Lock()
    setattr(app, "_subtitle_backfill_context_guard", guard)
    return guard


def _subtitle_backfill_context(app: Any) -> dict[str, object] | None:
    context = getattr(app, "_subtitle_backfill_context", None)
    return context if isinstance(context, dict) else None


def _register_subtitle_backfill_context(
    app: Any,
    *,
    rel_path: str,
    subtitle_stream_index: int,
    playback_sync_token: int | None,
) -> None:
    with _subtitle_backfill_context_guard(app):
        setattr(app, "_subtitle_backfill_context", {
            "rel_path": clean_rel_path(rel_path),
            "subtitle_stream_index": int(subtitle_stream_index),
            "playback_sync_token": playback_sync_token,
        })


def _subtitle_backfill_request_is_current(
    app: Any,
    *,
    rel_path: str,
    subtitle_stream_index: int,
    playback_sync_token: int | None,
) -> bool:
    with _subtitle_backfill_context_guard(app):
        context = _subtitle_backfill_context(app)
        if context is None:
            return True
        return (
            context.get("rel_path") == clean_rel_path(rel_path)
            and int(context.get("subtitle_stream_index") or -1) == int(subtitle_stream_index)
            and context.get("playback_sync_token") == playback_sync_token
        )


def log_video_debug(app: Any, event: str, **fields: object) -> None:
    if not bool(getattr(app, "video_debug_logs", False)):
        return
    row = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "event": event,
        **fields,
    }
    try:
        VIDEO_DEBUG_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(row, ensure_ascii=False, sort_keys=True)
        with _VIDEO_DEBUG_LOG_LOCK:
            with VIDEO_DEBUG_LOG_PATH.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")
    except OSError:
        return


def _stream_title(tags: dict[str, object]) -> str | None:
    title = tags.get("title")
    return title if isinstance(title, str) and title.strip() else None


def _stream_language(tags: dict[str, object]) -> str | None:
    language = tags.get("language")
    return language if isinstance(language, str) and language.strip() else None


def _stream_disposition(stream_data: dict[str, object]) -> dict[str, int]:
    disposition = stream_data.get("disposition")
    if not isinstance(disposition, dict):
        return {"default": 0, "forced": 0}
    return {
        "default": int(disposition.get("default") or 0),
        "forced": int(disposition.get("forced") or 0),
    }


def _base_stream(stream_data: dict[str, object]) -> dict[str, object]:
    tags = stream_data.get("tags")
    tag_map = tags if isinstance(tags, dict) else {}
    disposition = _stream_disposition(stream_data)
    return {
        "index": int(stream_data.get("index") or 0),
        "codec_name": stream_data.get("codec_name"),
        "codec_long_name": stream_data.get("codec_long_name"),
        "language": _stream_language(tag_map),
        "title": _stream_title(tag_map),
        "default": bool(disposition["default"]),
        "forced": bool(disposition["forced"]),
    }


def _video_stream(stream_data: dict[str, object]) -> dict[str, object]:
    result = _base_stream(stream_data)
    result.update({
        "width": stream_data.get("width"),
        "height": stream_data.get("height"),
        "pix_fmt": stream_data.get("pix_fmt"),
    })
    return result


def _audio_stream(stream_data: dict[str, object]) -> dict[str, object]:
    result = _base_stream(stream_data)
    result.update({
        "channels": stream_data.get("channels"),
        "channel_layout": stream_data.get("channel_layout"),
        "sample_rate": stream_data.get("sample_rate"),
    })
    return result


_WEBVTT_INCOMPATIBLE_SUBTITLE_CODECS = frozenset({
    "dvd_subtitle",
    "dvb_subtitle",
    "hdmv_pgs_subtitle",
    "pgssub",
    "vobsub",
    "xsub",
})

_COPYABLE_TEXT_SUBTITLE_SUFFIXES = {
    "ass": ".ass",
    "ssa": ".ass",
    "subrip": ".srt",
    "srt": ".srt",
    "webvtt": ".vtt",
}


def subtitle_codec_supports_webvtt(codec_name: object) -> bool:
    if not isinstance(codec_name, str) or not codec_name.strip():
        return True
    return codec_name.casefold() not in _WEBVTT_INCOMPATIBLE_SUBTITLE_CODECS


def _subtitle_stream(stream_data: dict[str, object]) -> dict[str, object]:
    result = _base_stream(stream_data)
    result.update({
        "codec_tag_string": stream_data.get("codec_tag_string"),
        "webvtt_compatible": subtitle_codec_supports_webvtt(stream_data.get("codec_name")),
    })
    return result


def _recommended_audio_index(audio_streams: list[dict[str, object]]) -> int | None:
    for stream in audio_streams:
        if stream.get("default"):
            return int(stream["index"])
    if audio_streams:
        return int(audio_streams[0]["index"])
    return None


def _recommended_subtitle_index(subtitle_streams: list[dict[str, object]]) -> int | None:
    for stream in subtitle_streams:
        if stream.get("default") and stream.get("webvtt_compatible", True):
            return int(stream["index"])
    return None


def _duration_seconds(format_data: dict[str, object]) -> float | None:
    raw = format_data.get("duration")
    if raw in (None, ""):
        return None
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


def _format_ffmpeg_seconds(seconds: float) -> str:
    return f"{max(0.0, seconds):.3f}".rstrip("0").rstrip(".")


def parse_video_start_seconds(raw: str) -> float:
    if not raw.strip():
        return 0.0
    try:
        value = float(raw)
    except ValueError as exc:
        raise BrowserError(HTTPStatus.BAD_REQUEST, "Start time must be a number of seconds.") from exc
    if not math.isfinite(value):
        raise BrowserError(HTTPStatus.BAD_REQUEST, "Start time must be finite.")
    if value < 0:
        raise BrowserError(HTTPStatus.BAD_REQUEST, "Start time must not be negative.")
    return value


def parse_playback_sync_token(raw: object) -> int | None:
    text = str(raw or "").strip()
    if not text:
        return None
    try:
        value = int(text)
    except (TypeError, ValueError) as exc:
        raise BrowserError(HTTPStatus.BAD_REQUEST, "Playback sync token must be an integer.") from exc
    if value < 0:
        raise BrowserError(HTTPStatus.BAD_REQUEST, "Playback sync token must not be negative.")
    return value


def _require_finite_non_negative_seconds(value: float, field_name: str) -> float:
    try:
        normalized = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field_name} must be numeric.") from exc
    if not math.isfinite(normalized):
        raise ValueError(f"{field_name} must be finite.")
    if normalized < 0:
        raise ValueError(f"{field_name} must not be negative.")
    return normalized


def subtitle_window_end_seconds(window_start_seconds: float, window_duration_seconds: float) -> float:
    start = _require_finite_non_negative_seconds(window_start_seconds, "window_start_seconds")
    duration = _require_finite_non_negative_seconds(window_duration_seconds, "window_duration_seconds")
    return start + duration


def clamp_subtitle_window(
    window_start_seconds: float,
    window_duration_seconds: float,
    *,
    media_duration_seconds: float | None = None,
) -> dict[str, float]:
    start = _require_finite_non_negative_seconds(window_start_seconds, "window_start_seconds")
    duration = _require_finite_non_negative_seconds(window_duration_seconds, "window_duration_seconds")
    end = start + duration
    if media_duration_seconds is None:
        return {
            "window_start_seconds": start,
            "window_duration_seconds": duration,
            "window_end_seconds": end,
        }
    media_duration = _require_finite_non_negative_seconds(media_duration_seconds, "media_duration_seconds")
    if start > media_duration:
        start = media_duration
    end = min(end, media_duration)
    return {
        "window_start_seconds": start,
        "window_duration_seconds": max(0.0, end - start),
        "window_end_seconds": end,
    }


def expand_subtitle_window_for_extraction(
    window_start_seconds: float,
    window_duration_seconds: float,
    *,
    overlap_seconds: float = SUBTITLE_WINDOW_OVERLAP_SECONDS,
    media_duration_seconds: float | None = None,
) -> dict[str, float]:
    requested = clamp_subtitle_window(
        window_start_seconds,
        window_duration_seconds,
        media_duration_seconds=media_duration_seconds,
    )
    overlap = _require_finite_non_negative_seconds(overlap_seconds, "overlap_seconds")
    expanded_start = max(0.0, requested["window_start_seconds"] - overlap)
    expanded_end = requested["window_end_seconds"] + overlap
    if media_duration_seconds is not None:
        expanded_end = min(expanded_end, _require_finite_non_negative_seconds(media_duration_seconds, "media_duration_seconds"))
    return {
        "window_start_seconds": expanded_start,
        "window_duration_seconds": max(0.0, expanded_end - expanded_start),
        "window_end_seconds": expanded_end,
    }


def build_subtitle_window_request(
    *,
    rel_path: str,
    subtitle_stream_index: int,
    file_size: int | None,
    window_start_seconds: float,
    window_duration_seconds: float,
    window_status: str,
    playback_sync_token: int | None = None,
    media_duration_seconds: float | None = None,
) -> dict[str, object]:
    window = clamp_subtitle_window(
        window_start_seconds,
        window_duration_seconds,
        media_duration_seconds=media_duration_seconds,
    )
    return {
        "path": clean_rel_path(rel_path),
        "track": int(subtitle_stream_index),
        "file_size": None if file_size is None else int(file_size),
        "window_start_seconds": window["window_start_seconds"],
        "window_duration_seconds": window["window_duration_seconds"],
        "window_end_seconds": window["window_end_seconds"],
        "window_status": str(window_status or "requested"),
        **({"playback_sync_token": int(playback_sync_token)} if playback_sync_token is not None else {}),
    }


def build_startup_subtitle_window_request(
    *,
    rel_path: str,
    subtitle_stream_index: int,
    file_size: int | None,
    playback_sync_token: int | None = None,
    media_duration_seconds: float | None = None,
) -> dict[str, object]:
    return build_subtitle_window_request(
        rel_path=rel_path,
        subtitle_stream_index=subtitle_stream_index,
        file_size=file_size,
        window_start_seconds=0.0,
        window_duration_seconds=SUBTITLE_WINDOW_DURATION_SECONDS,
        window_status="startup",
        playback_sync_token=playback_sync_token,
        media_duration_seconds=media_duration_seconds,
    )


def build_seek_subtitle_window_request(
    *,
    rel_path: str,
    subtitle_stream_index: int,
    file_size: int | None,
    seek_target_seconds: float,
    playback_sync_token: int | None = None,
    media_duration_seconds: float | None = None,
) -> dict[str, object]:
    seek_target = _require_finite_non_negative_seconds(seek_target_seconds, "seek_target_seconds")
    return build_subtitle_window_request(
        rel_path=rel_path,
        subtitle_stream_index=subtitle_stream_index,
        file_size=file_size,
        window_start_seconds=max(0.0, seek_target - SUBTITLE_WINDOW_SEEK_LEAD_SECONDS),
        window_duration_seconds=SUBTITLE_WINDOW_DURATION_SECONDS,
        window_status="seek",
        playback_sync_token=playback_sync_token,
        media_duration_seconds=media_duration_seconds,
    )


def build_subtitle_window_response(
    *,
    track: int,
    window_start_seconds: float,
    window_duration_seconds: float,
    vtt: str,
    coverage_complete: bool,
    loaded_ranges: list[dict[str, float]] | None = None,
    status: str = "ok",
    window_status: str = "ready",
    media_duration_seconds: float | None = None,
) -> dict[str, object]:
    window = clamp_subtitle_window(
        window_start_seconds,
        window_duration_seconds,
        media_duration_seconds=media_duration_seconds,
    )
    normalized_ranges: list[dict[str, float]] = []
    for item in loaded_ranges or []:
        if not isinstance(item, dict):
            continue
        start = item.get("start_seconds")
        end = item.get("end_seconds")
        if start is None or end is None:
            continue
        clamped = clamp_subtitle_window(
            float(start),
            max(0.0, float(end) - float(start)),
            media_duration_seconds=media_duration_seconds,
        )
        normalized_ranges.append({
            "start_seconds": clamped["window_start_seconds"],
            "end_seconds": clamped["window_end_seconds"],
        })
    return {
        "status": str(status or "ok"),
        "track": int(track),
        "window_status": str(window_status or "ready"),
        "window_start_seconds": window["window_start_seconds"],
        "window_end_seconds": window["window_end_seconds"],
        "coverage_complete": bool(coverage_complete),
        "loaded_ranges": normalized_ranges,
        "gap_action": SUBTITLE_WINDOW_GAP_ACTION,
        "vtt": str(vtt or ""),
    }


def build_ffprobe_command(
    ffprobe_exe: Path,
    input_url: str,
    *,
    probe_size_bytes: int = DEFAULT_PROBE_PROBE_SIZE_BYTES,
    analyze_duration_us: int = DEFAULT_PROBE_ANALYZE_DURATION_US,
) -> list[str]:
    return [
        str(ffprobe_exe),
        "-v",
        "error",
        "-probesize",
        str(max(32, int(probe_size_bytes))),
        "-analyzeduration",
        str(max(0, int(analyze_duration_us))),
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        input_url,
    ]


_VTT_TIMING_LINE_RE = re.compile(
    r"(?P<start>\d{1,2}:\d{2}(?::\d{2})?\.\d{1,3})"
    r"\s*-->\s*"
    r"(?P<end>\d{1,2}:\d{2}(?::\d{2})?\.\d{1,3})"
    r"(?P<suffix>[^\n]*)",
)


def _parse_vtt_timestamp(raw: str) -> float:
    text = raw.strip()
    if not text:
        raise ValueError("empty VTT timestamp")
    chunks = text.split(":")
    if len(chunks) == 3:
        hours = int(chunks[0])
        minutes = int(chunks[1])
        seconds = float(chunks[2])
        return hours * 3600 + minutes * 60 + seconds
    if len(chunks) == 2:
        minutes = int(chunks[0])
        seconds = float(chunks[1])
        return minutes * 60 + seconds
    return float(text)


def _format_vtt_timestamp(seconds: float) -> str:
    clamped = max(0.0, seconds)
    whole = int(clamped)
    millis = int(round((clamped - whole) * 1000))
    if millis == 1000:
        whole += 1
        millis = 0
    hours = whole // 3600
    minutes = (whole % 3600) // 60
    remainder = whole % 60
    if hours > 0:
        return f"{hours:02d}:{minutes:02d}:{remainder:02d}.{millis:03d}"
    return f"{minutes:02d}:{remainder:02d}.{millis:03d}"


def _webvtt_cue_start_times(body: str) -> list[float]:
    starts: list[float] = []
    for match in _VTT_TIMING_LINE_RE.finditer(body):
        try:
            starts.append(_parse_vtt_timestamp(match.group("start")))
        except ValueError:
            continue
    return starts


def _webvtt_needs_rebase(cue_starts: list[float], start_time_seconds: float) -> bool:
    if start_time_seconds <= 0 or not cue_starts:
        return False
    min_start = min(cue_starts)
    if min_start < 1.0:
        return False
    return min_start >= max(2.0, start_time_seconds - 5.0)


def _shift_vtt_timing_match(match: re.Match[str], shift_seconds: float) -> str | None:
    start = _parse_vtt_timestamp(match.group("start"))
    end = _parse_vtt_timestamp(match.group("end"))
    shifted_start = start - shift_seconds
    shifted_end = end - shift_seconds
    if shifted_end <= 0:
        return None
    if shifted_start < 0:
        shifted_start = 0.0
    suffix = match.group("suffix") or ""
    return (
        f"{_format_vtt_timestamp(shifted_start)} --> {_format_vtt_timestamp(shifted_end)}"
        f"{suffix}"
    )


def _webvtt_interval_overlaps_window(
    cue_start_seconds: float,
    cue_end_seconds: float,
    window_start_seconds: float,
    window_end_seconds: float,
) -> bool:
    return cue_end_seconds > window_start_seconds and cue_start_seconds < window_end_seconds


def slice_webvtt_text_to_window(
    body: str,
    *,
    window_start_seconds: float,
    window_end_seconds: float,
) -> str:
    start = _require_finite_non_negative_seconds(window_start_seconds, "window_start_seconds")
    end = _require_finite_non_negative_seconds(window_end_seconds, "window_end_seconds")
    if end < start:
        raise ValueError("window_end_seconds must be greater than or equal to window_start_seconds.")
    normalized = str(body or "").replace("\r\n", "\n")
    blocks = re.split(r"\n\n+", normalized.strip())
    out_blocks: list[str] = []
    for block in blocks:
        trimmed = block.strip()
        if not trimmed:
            continue
        if trimmed.startswith("WEBVTT"):
            out_blocks.append(trimmed)
            continue
        lines = trimmed.split("\n")
        timing_idx = 0
        if len(lines) > 1 and "-->" not in lines[0] and "-->" in lines[1]:
            timing_idx = 1
        timing_match = _VTT_TIMING_LINE_RE.match(lines[timing_idx].strip())
        if timing_match is None:
            if lines[0].startswith(("STYLE", "REGION")):
                out_blocks.append(trimmed)
            continue
        cue_start = _parse_vtt_timestamp(timing_match.group("start"))
        cue_end = _parse_vtt_timestamp(timing_match.group("end"))
        if not _webvtt_interval_overlaps_window(cue_start, cue_end, start, end):
            continue
        out_blocks.append(trimmed)
    if not out_blocks:
        return "WEBVTT\n\n"
    return "\n\n".join(out_blocks) + "\n"


def build_subtitle_cache_key(
    *,
    rel_path: str,
    subtitle_stream_index: int,
    file_size: int | None = None,
    window_start_seconds: float | None = None,
    window_duration_seconds: float | None = None,
    cache_version: str = SUBTITLE_CACHE_VERSION,
) -> str:
    payload = {
        "cache_version": str(cache_version),
        "file_size": None if file_size is None else int(file_size),
        "rel_path": clean_rel_path(rel_path),
        "subtitle_stream_index": int(subtitle_stream_index),
        "window_duration_seconds": (
            None
            if window_duration_seconds is None
            else _require_finite_non_negative_seconds(window_duration_seconds, "window_duration_seconds")
        ),
        "window_start_seconds": (
            None
            if window_start_seconds is None
            else _require_finite_non_negative_seconds(window_start_seconds, "window_start_seconds")
        ),
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def build_subtitle_window_manifest_key(
    *,
    rel_path: str,
    subtitle_stream_index: int,
    file_size: int | None = None,
    cache_version: str = SUBTITLE_WINDOW_MANIFEST_VERSION,
) -> str:
    return build_subtitle_cache_key(
        rel_path=rel_path,
        subtitle_stream_index=subtitle_stream_index,
        file_size=file_size,
        cache_version=cache_version,
    )


def subtitle_cache_path(
    cache_key: str,
    *,
    cache_dir: Path | None = None,
) -> Path:
    cache_root = SUBTITLE_CACHE_DIR if cache_dir is None else cache_dir
    return cache_root / "files" / f"{cache_key}.vtt"


def _subtitle_cache_store(app: Any, *, cache_dir: Path | None = None) -> DiskCacheStore:
    cache_root = (_active_temp_dir() / "subtitle_cache") if cache_dir is None else cache_dir
    return DiskCacheStore(
        cache_root,
        ttl_seconds=_subtitle_cache_ttl_seconds(app),
        max_bytes=_subtitle_cache_max_bytes(app),
    )


def _read_subtitle_cache(app: Any, cache_key: str, *, cache_dir: Path | None = None) -> bytes | None:
    return _subtitle_cache_store(app, cache_dir=cache_dir).read_bytes(cache_key, suffix=".vtt")


def _write_subtitle_cache(app: Any, cache_key: str, body: bytes, *, cache_dir: Path | None = None) -> None:
    _subtitle_cache_store(app, cache_dir=cache_dir).write_bytes(cache_key, body, suffix=".vtt")


def _read_subtitle_cache_json(app: Any, cache_key: str, *, cache_dir: Path | None = None) -> Any | None:
    return _subtitle_cache_store(app, cache_dir=cache_dir).read_json(cache_key, suffix=".json")


def _write_subtitle_cache_json(app: Any, cache_key: str, payload: Any, *, cache_dir: Path | None = None) -> None:
    _subtitle_cache_store(app, cache_dir=cache_dir).write_json(cache_key, payload, suffix=".json")


def merge_subtitle_coverage_ranges(
    ranges: list[dict[str, float]] | None,
    *,
    overlap_seconds: float = SUBTITLE_WINDOW_OVERLAP_SECONDS,
) -> list[dict[str, float]]:
    normalized_overlap = _require_finite_non_negative_seconds(overlap_seconds, "overlap_seconds")
    normalized: list[tuple[float, float]] = []
    for item in ranges or []:
        if not isinstance(item, dict):
            continue
        start = item.get("start_seconds")
        end = item.get("end_seconds")
        if start is None or end is None:
            continue
        start_value = _require_finite_non_negative_seconds(float(start), "start_seconds")
        end_value = _require_finite_non_negative_seconds(float(end), "end_seconds")
        if end_value < start_value:
            continue
        normalized.append((start_value, end_value))
    if not normalized:
        return []
    normalized.sort(key=lambda item: (item[0], item[1]))
    merged: list[dict[str, float]] = []
    current_start, current_end = normalized[0]
    for start_value, end_value in normalized[1:]:
        if start_value <= current_end + normalized_overlap:
            current_end = max(current_end, end_value)
            continue
        merged.append({
            "start_seconds": current_start,
            "end_seconds": current_end,
        })
        current_start, current_end = start_value, end_value
    merged.append({
        "start_seconds": current_start,
        "end_seconds": current_end,
    })
    return merged


def subtitle_window_is_covered(
    coverage_ranges: list[dict[str, float]] | None,
    *,
    window_start_seconds: float,
    window_end_seconds: float,
    overlap_seconds: float = SUBTITLE_WINDOW_OVERLAP_SECONDS,
) -> bool:
    start = _require_finite_non_negative_seconds(window_start_seconds, "window_start_seconds")
    end = _require_finite_non_negative_seconds(window_end_seconds, "window_end_seconds")
    if end < start:
        return False
    for item in merge_subtitle_coverage_ranges(coverage_ranges, overlap_seconds=overlap_seconds):
        range_start = float(item["start_seconds"])
        range_end = float(item["end_seconds"])
        if start >= range_start and end <= range_end + overlap_seconds:
            return True
    return False


def _normalize_subtitle_window_manifest(
    payload: Any,
    *,
    rel_path: str,
    subtitle_stream_index: int,
    file_size: int | None,
) -> dict[str, object]:
    windows_raw = payload.get("windows") if isinstance(payload, dict) else None
    windows: list[dict[str, object]] = []
    for item in windows_raw if isinstance(windows_raw, list) else []:
        if not isinstance(item, dict):
            continue
        cache_key = item.get("cache_key")
        start = item.get("start_seconds")
        end = item.get("end_seconds")
        if not isinstance(cache_key, str) or start is None or end is None:
            continue
        start_value = _require_finite_non_negative_seconds(float(start), "start_seconds")
        end_value = _require_finite_non_negative_seconds(float(end), "end_seconds")
        if end_value < start_value:
            continue
        windows.append({
            "cache_key": cache_key,
            "start_seconds": start_value,
            "end_seconds": end_value,
        })
    merged_ranges = merge_subtitle_coverage_ranges([
        {
            "start_seconds": float(item["start_seconds"]),
            "end_seconds": float(item["end_seconds"]),
        }
        for item in windows
    ])
    return {
        "cache_version": SUBTITLE_WINDOW_MANIFEST_VERSION,
        "file_size": None if file_size is None else int(file_size),
        "path": clean_rel_path(rel_path),
        "track": int(subtitle_stream_index),
        "coverage_ranges": merged_ranges,
        "windows": windows,
    }


def read_subtitle_window_manifest(
    app: Any,
    *,
    rel_path: str,
    subtitle_stream_index: int,
    file_size: int | None = None,
    cache_dir: Path | None = None,
) -> dict[str, object]:
    manifest_key = build_subtitle_window_manifest_key(
        rel_path=rel_path,
        subtitle_stream_index=subtitle_stream_index,
        file_size=file_size,
    )
    cached_payload = _read_subtitle_cache_json(app, manifest_key, cache_dir=cache_dir)
    return _normalize_subtitle_window_manifest(
        cached_payload,
        rel_path=rel_path,
        subtitle_stream_index=subtitle_stream_index,
        file_size=file_size,
    )


def write_subtitle_window_manifest(
    app: Any,
    *,
    rel_path: str,
    subtitle_stream_index: int,
    file_size: int | None = None,
    windows: list[dict[str, object]] | None = None,
    cache_dir: Path | None = None,
) -> dict[str, object]:
    manifest = _normalize_subtitle_window_manifest(
        {"windows": windows or []},
        rel_path=rel_path,
        subtitle_stream_index=subtitle_stream_index,
        file_size=file_size,
    )
    manifest_key = build_subtitle_window_manifest_key(
        rel_path=rel_path,
        subtitle_stream_index=subtitle_stream_index,
        file_size=file_size,
    )
    _write_subtitle_cache_json(app, manifest_key, manifest, cache_dir=cache_dir)
    return manifest


def store_subtitle_window_cache_entry(
    app: Any,
    *,
    rel_path: str,
    subtitle_stream_index: int,
    file_size: int | None,
    window_start_seconds: float,
    window_duration_seconds: float,
    body: bytes,
    cache_dir: Path | None = None,
) -> tuple[str, dict[str, object]]:
    window = clamp_subtitle_window(window_start_seconds, window_duration_seconds)
    cache_key = build_subtitle_cache_key(
        rel_path=rel_path,
        subtitle_stream_index=subtitle_stream_index,
        file_size=file_size,
        window_start_seconds=window["window_start_seconds"],
        window_duration_seconds=window["window_duration_seconds"],
        cache_version=SUBTITLE_WINDOW_CACHE_VERSION,
    )
    _write_subtitle_cache(app, cache_key, body, cache_dir=cache_dir)
    manifest = read_subtitle_window_manifest(
        app,
        rel_path=rel_path,
        subtitle_stream_index=subtitle_stream_index,
        file_size=file_size,
        cache_dir=cache_dir,
    )
    windows = [
        item for item in manifest.get("windows", [])
        if isinstance(item, dict) and item.get("cache_key") != cache_key
    ]
    windows.append({
        "cache_key": cache_key,
        "start_seconds": window["window_start_seconds"],
        "end_seconds": window["window_end_seconds"],
    })
    updated_manifest = write_subtitle_window_manifest(
        app,
        rel_path=rel_path,
        subtitle_stream_index=subtitle_stream_index,
        file_size=file_size,
        windows=windows,
        cache_dir=cache_dir,
    )
    return cache_key, updated_manifest


def rebase_webvtt_text(body: str, start_time_seconds: float) -> str:
    if start_time_seconds <= 0:
        return body
    cue_starts = _webvtt_cue_start_times(body)
    if not _webvtt_needs_rebase(cue_starts, start_time_seconds):
        return body

    blocks = re.split(r"\n\n+", body.strip())
    out_blocks: list[str] = []
    for block in blocks:
        trimmed = block.strip()
        if not trimmed:
            continue
        if trimmed.startswith("WEBVTT"):
            out_blocks.append(trimmed)
            continue
        lines = trimmed.split("\n")
        timing_idx = 0
        if len(lines) > 1 and "-->" not in lines[0] and "-->" in lines[1]:
            timing_idx = 1
        timing_match = _VTT_TIMING_LINE_RE.match(lines[timing_idx].strip())
        if timing_match is None:
            out_blocks.append(trimmed)
            continue
        shifted_timing = _shift_vtt_timing_match(timing_match, start_time_seconds)
        if shifted_timing is None:
            continue
        lines[timing_idx] = shifted_timing
        out_blocks.append("\n".join(lines))
    if not out_blocks:
        return "WEBVTT\n\n"
    return "\n\n".join(out_blocks) + "\n"


def offset_webvtt_text(body: str, offset_seconds: float) -> str:
    if offset_seconds == 0:
        return body
    normalized = str(body or "").replace("\r\n", "\n")
    blocks = re.split(r"\n\n+", normalized.strip())
    out_blocks: list[str] = []
    for block in blocks:
        trimmed = block.strip()
        if not trimmed:
            continue
        if trimmed.startswith("WEBVTT"):
            out_blocks.append(trimmed)
            continue
        lines = trimmed.split("\n")
        timing_idx = 0
        if len(lines) > 1 and "-->" not in lines[0] and "-->" in lines[1]:
            timing_idx = 1
        timing_match = _VTT_TIMING_LINE_RE.match(lines[timing_idx].strip())
        if timing_match is None:
            out_blocks.append(trimmed)
            continue
        shifted_timing = _shift_vtt_timing_match(timing_match, -offset_seconds)
        if shifted_timing is None:
            continue
        lines[timing_idx] = shifted_timing
        out_blocks.append("\n".join(lines))
    if not out_blocks:
        return "WEBVTT\n\n"
    return "\n\n".join(out_blocks) + "\n"


def extracted_webvtt_needs_absolute_offset(
    body: str,
    *,
    start_time_seconds: float,
    window_duration_seconds: float | None = None,
) -> bool:
    if start_time_seconds <= 0:
        return False
    cue_starts = _webvtt_cue_start_times(body)
    if not cue_starts:
        return False
    min_start = min(cue_starts)
    max_start = max(cue_starts)
    if min_start >= max(2.0, start_time_seconds - 5.0):
        return False
    if window_duration_seconds is None:
        return min_start < 5.0
    window_duration = _require_finite_non_negative_seconds(window_duration_seconds, "window_duration_seconds")
    return min_start < 5.0 and max_start <= window_duration + 5.0


def _append_ffmpeg_time_bounds(
    command: list[str],
    *,
    start_time_seconds: float = 0.0,
    duration_seconds: float | None = None,
) -> None:
    if start_time_seconds > 0:
        command.extend(["-ss", _format_ffmpeg_seconds(start_time_seconds)])
    if duration_seconds is not None and duration_seconds > 0:
        command.extend(["-t", _format_ffmpeg_seconds(duration_seconds)])


def build_ffmpeg_webvtt_command(
    ffmpeg_exe: Path,
    input_url: str,
    subtitle_stream_index: int,
    *,
    start_time_seconds: float = 0.0,
    duration_seconds: float | None = None,
) -> list[str]:
    command = [
        str(ffmpeg_exe),
        "-v",
        "error",
    ]
    _append_ffmpeg_time_bounds(
        command,
        start_time_seconds=start_time_seconds,
        duration_seconds=duration_seconds,
    )
    command.extend([
        "-i",
        input_url,
        "-map",
        f"0:{subtitle_stream_index}",
        "-f",
        "webvtt",
        "-",
    ])
    return command


def parse_subtitle_window_duration_seconds(raw: str) -> float:
    text = str(raw or "").strip()
    if not text:
        return SUBTITLE_WINDOW_DURATION_SECONDS
    try:
        value = float(text)
    except ValueError as exc:
        raise BrowserError(HTTPStatus.BAD_REQUEST, "Subtitle window duration must be a number of seconds.") from exc
    if not math.isfinite(value):
        raise BrowserError(HTTPStatus.BAD_REQUEST, "Subtitle window duration must be finite.")
    if value <= 0:
        raise BrowserError(HTTPStatus.BAD_REQUEST, "Subtitle window duration must be greater than zero.")
    return value


def subtitle_codec_copy_suffix(codec_name: object) -> str | None:
    if not isinstance(codec_name, str):
        return None
    return _COPYABLE_TEXT_SUBTITLE_SUFFIXES.get(codec_name.casefold())


def build_ffmpeg_subtitle_copy_command(
    ffmpeg_exe: Path,
    input_url: str,
    subtitle_stream_index: int,
    output_path: Path,
    *,
    start_time_seconds: float = 0.0,
    duration_seconds: float | None = None,
) -> list[str]:
    command = [
        str(ffmpeg_exe),
        "-v",
        "error",
    ]
    _append_ffmpeg_time_bounds(
        command,
        start_time_seconds=start_time_seconds,
        duration_seconds=duration_seconds,
    )
    command.extend([
        "-i",
        input_url,
        "-map",
        f"0:{subtitle_stream_index}",
        "-vn",
        "-an",
        "-dn",
        "-c:s",
        "copy",
        str(output_path),
    ])
    return command


def build_ffmpeg_batch_subtitle_copy_command(
    ffmpeg_exe: Path,
    input_url: str,
    subtitle_stream_indices: list[int],
    output_paths: list[Path],
) -> list[str]:
    if len(subtitle_stream_indices) != len(output_paths):
        raise ValueError("subtitle stream indices and output paths must match.")
    command = [
        str(ffmpeg_exe),
        "-v",
        "error",
        "-i",
        input_url,
    ]
    for subtitle_stream_index, output_path in zip(subtitle_stream_indices, output_paths):
        command.extend([
            "-map",
            f"0:{subtitle_stream_index}",
            "-vn",
            "-an",
            "-dn",
            "-c:s",
            "copy",
            str(output_path),
        ])
    return command


def build_ffmpeg_batch_webvtt_command(
    ffmpeg_exe: Path,
    input_url: str,
    subtitle_stream_indices: list[int],
    output_paths: list[Path],
) -> list[str]:
    if len(subtitle_stream_indices) != len(output_paths):
        raise ValueError("subtitle stream indices and output paths must match.")
    command = [
        str(ffmpeg_exe),
        "-v",
        "error",
        "-i",
        input_url,
    ]
    for subtitle_stream_index, output_path in zip(subtitle_stream_indices, output_paths):
        command.extend([
            "-map",
            f"0:{subtitle_stream_index}",
            "-f",
            "webvtt",
            str(output_path),
        ])
    return command


def build_ffmpeg_hls_command(
    ffmpeg_exe: Path,
    input_url: str,
    playlist_path: Path,
    *,
    segment_base_url: str,
    audio_stream_index: int | None = None,
    subtitle_stream_index: int | None = None,
    start_time_seconds: float = 0.0,
) -> list[str]:
    segment_pattern = HLS_SEGMENT_PATTERN
    command = [
        str(ffmpeg_exe),
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
    ]
    if start_time_seconds > 0:
        command.extend(["-ss", _format_ffmpeg_seconds(start_time_seconds)])
    command.extend([
        "-i",
        input_url,
    ])
    if subtitle_stream_index is None:
        command.extend([
            "-map",
            "0:v:0",
        ])
    else:
        command.extend([
            "-filter_complex",
            f"[0:v:0][0:{subtitle_stream_index}]overlay[vout]",
            "-map",
            "[vout]",
        ])
    if audio_stream_index is None:
        command.extend(["-map", "0:a:0?"])
    else:
        command.extend(["-map", f"0:{audio_stream_index}?"])
    command.extend([
        "-sn",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        "-force_key_frames",
        "expr:gte(t,n_forced*6)",
        "-c:a",
        "aac",
        "-ac",
        "2",
        "-ar",
        "48000",
        "-f",
        "hls",
        "-hls_time",
        "6",
        "-hls_list_size",
        "0",
        "-hls_playlist_type",
        "event",
        "-hls_flags",
        "independent_segments+temp_file",
        "-hls_segment_type",
        "fmp4",
        "-hls_fmp4_init_filename",
        HLS_INIT_SEGMENT_NAME,
        "-hls_base_url",
        segment_base_url,
        "-hls_segment_filename",
        segment_pattern,
        str(playlist_path),
    ])
    return command


def _display_name_for_root(rel_path: str) -> str:
    return Path(rel_path).name if rel_path else "Dropbox"


def _is_supported_video(name: str) -> bool:
    return Path(name).suffix.casefold() in SUPPORTED_VIDEO_EXTENSIONS


def _compatibility_expected(extension: str) -> bool:
    return extension in COMPATIBILITY_EXPECTED_EXTENSIONS


def _sort_rows(rows: list[dict[str, object]]) -> list[dict[str, object]]:
    folders = sorted(
        (row for row in rows if row.get("type") == "folder"),
        key=lambda row: filename_compare_key(str(row.get("display_name") or "")),
    )
    files = sorted(
        (row for row in rows if row.get("type") == "file"),
        key=lambda row: filename_compare_key(str(row.get("display_name") or "")),
    )
    return folders + files


def _library_folder_row(rel_path: str, name: str) -> dict[str, object]:
    child_path = rel_path + "/" + name if rel_path else name
    return {
        "display_name": name,
        "filename": name,
        "type": "folder",
        "path": child_path,
        "stream_path": child_path,
        "remote_path": child_path,
    }


def _library_file_row(rel_path: str, row: dict[str, object]) -> dict[str, object] | None:
    name = row.get("name")
    if not isinstance(name, str) or not _is_supported_video(name):
        return None
    child_path = rel_path + "/" + name if rel_path else name
    extension = Path(name).suffix.casefold()
    size = row.get("remote_size")
    mtime = row.get("remote_mtime")
    return {
        "display_name": name,
        "filename": name,
        "type": "file",
        "path": child_path,
        "stream_path": child_path,
        "remote_path": child_path,
        "extension": extension,
        "size": size,
        "mtime": mtime,
        "preview_url": "/file?" + urlencode({"path": child_path, "source": "remote"}),
        "compatibility_expected": _compatibility_expected(extension),
    }


@dataclass
class VideoHlsSession:
    session_id: str
    rel_path: str
    session_dir: Path
    playlist_path: Path
    process: subprocess.Popen[bytes]
    command: list[str]
    created_at: float
    create_started_at: float
    last_accessed_at: float
    audio_stream_index: int | None
    subtitle_stream_index: int | None
    start_time_seconds: float

    def touch(self) -> None:
        self.last_accessed_at = time.time()


class VideoSessionManager:
    def __init__(self, app: Any) -> None:
        self.app = app
        self.root_dir = VIDEO_SESSION_DIR
        self.root_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._active_session: VideoHlsSession | None = None

    def shutdown(self) -> None:
        with self._lock:
            self._clear_active_locked()
        if self.root_dir.exists():
            shutil.rmtree(self.root_dir, ignore_errors=True)

    def create_session(
        self,
        *,
        rel_path: str,
        base_url: str,
        audio_stream_index: int | None = None,
        subtitle_stream_index: int | None = None,
        start_time_seconds: float = 0.0,
    ) -> dict[str, object]:
        video_config = getattr(self.app, "video_tools_config", None)
        ffmpeg_exe = getattr(video_config, "ffmpeg_exe", None)
        if ffmpeg_exe is None:
            raise BrowserError(HTTPStatus.SERVICE_UNAVAILABLE, "ffmpeg is not available.")

        input_url = base_url + "/file?" + urlencode({"path": rel_path, "source": "remote"})
        session_id = uuid.uuid4().hex
        create_started_at = time.monotonic()
        session_dir = self.root_dir / session_id
        session_dir.mkdir(parents=True, exist_ok=True)
        playlist_path = session_dir / HLS_PLAYLIST_NAME
        segment_base_url = "/video/endpoints/session/file?" + urlencode({"id": session_id, "name": ""})
        command = build_ffmpeg_hls_command(
            ffmpeg_exe,
            input_url,
            playlist_path,
            segment_base_url=segment_base_url,
            audio_stream_index=audio_stream_index,
            subtitle_stream_index=subtitle_stream_index,
            start_time_seconds=start_time_seconds,
        )
        log_video_debug(
            self.app,
            "session_create_start",
            session_id=session_id,
            path=rel_path,
            audio_stream_index=audio_stream_index,
            subtitle_stream_index=subtitle_stream_index,
            start_time_seconds=start_time_seconds,
            playlist=str(playlist_path),
            command=command,
        )
        try:
            process: subprocess.Popen[bytes] = subprocess.Popen(  # type: ignore[type-var]
                command,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                cwd=session_dir,
            )
        except FileNotFoundError as exc:
            shutil.rmtree(session_dir, ignore_errors=True)
            raise BrowserError(HTTPStatus.SERVICE_UNAVAILABLE, f"ffmpeg was not found: {exc}") from exc

        session = VideoHlsSession(
            session_id=session_id,
            rel_path=rel_path,
            session_dir=session_dir,
            playlist_path=playlist_path,
            process=process,
            command=command,
            created_at=time.time(),
            create_started_at=create_started_at,
            last_accessed_at=time.time(),
            audio_stream_index=audio_stream_index,
            subtitle_stream_index=subtitle_stream_index,
            start_time_seconds=start_time_seconds,
        )
        with self._lock:
            self._cleanup_expired_locked()
            self._clear_active_locked()
            self._active_session = session
        ready_timeout_seconds = (
            HLS_READY_TIMEOUT_BURN_IN_SECONDS
            if subtitle_stream_index is not None
            else HLS_READY_TIMEOUT_SECONDS
        )
        if not self._wait_for_playlist(session, timeout_seconds=ready_timeout_seconds):
            with self._lock:
                if self._active_session is session:
                    self._clear_active_locked()
            log_video_debug(self.app, "session_create_timeout", session_id=session_id, path=rel_path)
            raise BrowserError(HTTPStatus.BAD_GATEWAY, "ffmpeg did not produce an HLS playlist in time.")
        ready_elapsed_ms = round((time.monotonic() - session.create_started_at) * 1000, 3)
        log_video_debug(
            self.app,
            "session_create_ready",
            session_id=session_id,
            path=rel_path,
            playlist_bytes=session.playlist_path.stat().st_size if session.playlist_path.exists() else 0,
            elapsed_ms=ready_elapsed_ms,
        )
        return self._session_payload(session, ready_elapsed_ms=ready_elapsed_ms)

    def stop_active_session(self, session_id: str | None = None) -> dict[str, object]:
        with self._lock:
            self._cleanup_expired_locked()
            session = self._active_session
            if session is None:
                return {"status": "ok", "stopped": False}
            if session_id and session.session_id != session_id:
                return {"status": "ok", "stopped": False}
            self._clear_active_locked()
        return {"status": "ok", "stopped": True}

    def session_asset(self, session_id: str, name: str) -> tuple[Path, str]:
        with self._lock:
            self._cleanup_expired_locked()
            session = self._active_session
            if session is None or session.session_id != session_id:
                log_video_debug(self.app, "asset_missing_session", session_id=session_id, name=name)
                raise BrowserError(HTTPStatus.NOT_FOUND, "Video session not found.")
            asset_name = _safe_session_asset_name(name)
            asset_path = (session.session_dir / asset_name).resolve()
            try:
                asset_path.relative_to(session.session_dir.resolve())
            except ValueError as exc:
                log_video_debug(self.app, "asset_bad_path", session_id=session_id, name=name)
                raise BrowserError(HTTPStatus.NOT_FOUND, "Video session asset not found.") from exc
        existed_initially = asset_path.is_file()
        wait_started = time.monotonic()
        if not self._wait_for_asset(session, asset_path):
            wait_ms = round((time.monotonic() - wait_started) * 1000, 3)
            log_video_debug(
                self.app,
                "asset_missing_after_wait",
                session_id=session_id,
                name=asset_path.name,
                existed_initially=existed_initially,
                wait_ms=wait_ms,
                process_returncode=session.process.poll(),
            )
            raise BrowserError(HTTPStatus.NOT_FOUND, "Video session asset not found.")
        wait_ms = round((time.monotonic() - wait_started) * 1000, 3)
        with self._lock:
            if self._active_session is not session:
                log_video_debug(self.app, "asset_session_replaced", session_id=session_id, name=asset_path.name)
                raise BrowserError(HTTPStatus.NOT_FOUND, "Video session not found.")
            session.touch()
        content_type = _session_asset_content_type(asset_path.name)
        if asset_path.suffix.casefold() == ".m3u8" or not existed_initially or wait_ms >= 1:
            playlist_info = _playlist_info(asset_path) if asset_path.suffix.casefold() == ".m3u8" else {}
            log_video_debug(
                self.app,
                "asset_served",
                session_id=session_id,
                name=asset_path.name,
                bytes=asset_path.stat().st_size if asset_path.exists() else None,
                content_type=content_type,
                existed_initially=existed_initially,
                wait_ms=wait_ms,
                source_start_seconds=session.start_time_seconds,
                **playlist_info,
            )
        return asset_path, content_type

    def active_session_payload(self) -> dict[str, object] | None:
        with self._lock:
            self._cleanup_expired_locked()
            if self._active_session is None:
                return None
            return self._session_payload(self._active_session)

    def _encoded_media_end_seconds(self, session: VideoHlsSession) -> float:
        if not session.playlist_path.is_file():
            return 0.0
        segment_count = len(_playlist_segment_names(session.playlist_path))
        if segment_count <= 0:
            return 0.0
        return segment_count * HLS_SEGMENT_DURATION_SECONDS

    def _session_payload(
        self,
        session: VideoHlsSession,
        *,
        ready_elapsed_ms: float | None = None,
    ) -> dict[str, object]:
        if ready_elapsed_ms is None:
            ready_elapsed_ms = round((time.monotonic() - session.create_started_at) * 1000, 3)
        return {
            "status": "ok",
            "session_id": session.session_id,
            "path": session.rel_path,
            "playlist_name": session.playlist_path.name,
            "playlist_url": "/video/endpoints/session/file?"
            + urlencode({"id": session.session_id, "name": session.playlist_path.name}),
            "asset_root": "/video/endpoints/session/file?id=" + session.session_id + "&name=",
            "audio_stream_index": session.audio_stream_index,
            "subtitle_stream_index": session.subtitle_stream_index,
            "start_time_seconds": session.start_time_seconds,
            "encoded_media_end_seconds": self._encoded_media_end_seconds(session),
            "session_create_elapsed_ms": ready_elapsed_ms,
        }

    def _wait_for_playlist(self, session: VideoHlsSession, timeout_seconds: float = HLS_READY_TIMEOUT_SECONDS) -> bool:
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            if _playlist_ready_for_playback(session):
                return True
            return_code = session.process.poll()
            if return_code is not None:
                stderr = b""
                if session.process.stderr is not None:
                    stderr = session.process.stderr.read()
                message = stderr.decode("utf-8", "replace").strip() or "ffmpeg exited before HLS output was ready."
                log_video_debug(
                    self.app,
                    "session_create_ffmpeg_exit",
                    session_id=session.session_id,
                    returncode=return_code,
                    stderr=message[-4000:],
                )
                raise BrowserError(HTTPStatus.BAD_GATEWAY, message)
            time.sleep(0.05)
        return False

    def _asset_wait_timeout_seconds(self, session: VideoHlsSession) -> float:
        if session.process.poll() is None:
            return HLS_ASSET_READY_TIMEOUT_PROCESS_ALIVE_SECONDS
        return HLS_ASSET_READY_TIMEOUT_SECONDS

    def _wait_for_asset(
        self,
        session: VideoHlsSession,
        asset_path: Path,
        timeout_seconds: float | None = None,
    ) -> bool:
        wait_timeout_seconds = (
            self._asset_wait_timeout_seconds(session)
            if timeout_seconds is None
            else timeout_seconds
        )
        deadline = time.monotonic() + wait_timeout_seconds
        while time.monotonic() < deadline:
            with self._lock:
                if self._active_session is not session:
                    return False
            if asset_path.is_file():
                return True
            if session.process.poll() is None or _hls_asset_temp_path(asset_path).is_file():
                time.sleep(0.05)
                continue
            log_video_debug(
                self.app,
                "asset_wait_process_exited",
                session_id=session.session_id,
                name=asset_path.name,
                returncode=session.process.poll(),
            )
            return asset_path.is_file()
        return asset_path.is_file()

    def _cleanup_expired_locked(self) -> None:
        session = self._active_session
        if session is None:
            return
        if (time.time() - session.last_accessed_at) > HLS_SESSION_TTL_SECONDS:
            self._clear_active_locked()

    def _clear_active_locked(self) -> None:
        session = self._active_session
        self._active_session = None
        if session is None:
            return
        if session.process.poll() is None:
            try:
                session.process.kill()
            except OSError:
                pass
            try:
                session.process.wait(timeout=2)
            except Exception:
                pass
        if session.process.stderr is not None:
            try:
                session.process.stderr.close()
            except OSError:
                pass
        shutil.rmtree(session.session_dir, ignore_errors=True)


def _safe_session_asset_name(name: str) -> str:
    if not name or "/" in name or "\\" in name:
        raise BrowserError(HTTPStatus.NOT_FOUND, "Video session asset not found.")
    parts = Path(name).parts
    if len(parts) != 1 or parts[0] in {"", ".", ".."}:
        raise BrowserError(HTTPStatus.NOT_FOUND, "Video session asset not found.")
    if Path(name).suffix.casefold() not in {".m3u8", ".ts", ".m4s", ".mp4"}:
        raise BrowserError(HTTPStatus.NOT_FOUND, "Video session asset not found.")
    return name


def _session_asset_content_type(name: str) -> str:
    suffix = Path(name).suffix.casefold()
    if suffix == ".m3u8":
        return "application/vnd.apple.mpegurl"
    if suffix == ".ts":
        return "video/mp2t"
    if suffix in {".m4s", ".mp4"}:
        return "video/mp4"
    raise BrowserError(HTTPStatus.NOT_FOUND, "Video session asset not found.")


def _hls_asset_temp_path(asset_path: Path) -> Path:
    return asset_path.with_name(asset_path.name + ".tmp")


def _playlist_segment_names(playlist_path: Path) -> list[str]:
    try:
        text = playlist_path.read_text(encoding="utf-8")
    except OSError:
        return []
    names: list[str] = []
    for line in text.splitlines():
        value = line.strip()
        if not value or value.startswith("#"):
            continue
        asset_name = _playlist_segment_asset_name(value)
        if asset_name is not None:
            names.append(asset_name)
    return names


def _playlist_ready_for_playback(
    session: VideoHlsSession,
    *,
    min_segments: int = HLS_MIN_READY_SEGMENTS,
) -> bool:
    if min_segments <= 0:
        return False
    if not (session.session_dir / HLS_INIT_SEGMENT_NAME).is_file():
        return False
    segment_names = _playlist_segment_names(session.playlist_path)
    if len(segment_names) < min_segments:
        return False
    return all((session.session_dir / name).is_file() for name in segment_names[:min_segments])


def _first_ready_playlist_segment(playlist_path: Path) -> str | None:
    names = _playlist_segment_names(playlist_path)
    return names[0] if names else None


def _playlist_info(playlist_path: Path) -> dict[str, object]:
    try:
        text = playlist_path.read_text(encoding="utf-8")
    except OSError:
        return {}
    segment_count = 0
    edge_seconds = 0.0
    pending_duration: float | None = None
    for raw_line in text.splitlines():
        value = raw_line.strip()
        if value.startswith("#EXTINF:"):
            duration_text = value.removeprefix("#EXTINF:").split(",", 1)[0]
            try:
                pending_duration = float(duration_text)
            except ValueError:
                pending_duration = None
            continue
        if not value or value.startswith("#"):
            continue
        if _playlist_segment_asset_name(value) is not None:
            segment_count += 1
            if pending_duration is not None:
                edge_seconds += pending_duration
            pending_duration = None
    return {
        "playlist_segment_count": segment_count,
        "playlist_edge_seconds": round(edge_seconds, 3),
        "playlist_has_endlist": "#EXT-X-ENDLIST" in text,
    }


def _playlist_segment_asset_name(value: str) -> str | None:
    try:
        if "/" not in value and "\\" not in value:
            return _safe_session_asset_name(value) if Path(value).suffix.casefold() in {".ts", ".m4s"} else None
        parsed = urlparse(value)
        name = parse_qs(parsed.query, keep_blank_values=True).get("name", [""])[0]
        return _safe_session_asset_name(name) if Path(name).suffix.casefold() in {".ts", ".m4s"} else None
    except BrowserError:
        return None


def video_session_manager(app: Any) -> VideoSessionManager:
    manager = getattr(app, "_video_session_manager", None)
    if manager is None:
        manager = VideoSessionManager(app)
        setattr(app, "_video_session_manager", manager)
    return manager


def video_library_payload(app: Any, *, rel_path: str) -> dict[str, object]:
    entries = app.list_entries(rel_path)
    rows: list[dict[str, object]] = []
    for entry in entries:
        if not entry.get("remote"):
            continue
        name = entry.get("name")
        if not isinstance(name, str):
            continue
        if entry.get("is_dir"):
            rows.append(_library_folder_row(rel_path, name))
            continue
        video_row = _library_file_row(rel_path, entry)
        if video_row is not None:
            rows.append(video_row)
    sorted_rows = _sort_rows(rows)
    return {
        "status": "ok",
        "root": {
            "display_name": _display_name_for_root(rel_path),
            "path": rel_path,
            "stream_path": rel_path,
            "remote_path": remote_target(app.remote, rel_path),
        },
        "items": sorted_rows,
        "supported_extensions": list(SUPPORTED_VIDEO_EXTENSIONS),
    }


def build_probe_cache_key(
    rel_path: str,
    *,
    file_size: int | None = None,
    probe_size_bytes: int = DEFAULT_PROBE_PROBE_SIZE_BYTES,
    analyze_duration_us: int = DEFAULT_PROBE_ANALYZE_DURATION_US,
) -> str:
    payload = {
        "version": PROBE_CACHE_VERSION,
        "path": clean_rel_path(rel_path),
        "file_size": None if file_size is None else int(file_size),
        "probe_size_bytes": int(probe_size_bytes),
        "analyze_duration_us": int(analyze_duration_us),
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()


def build_header_cache_key(
    rel_path: str,
    file_size: int,
    *,
    header_bytes: int = DEFAULT_HEADER_CACHE_BYTES,
) -> str:
    payload = {
        "version": HEADER_CACHE_VERSION,
        "path": clean_rel_path(rel_path),
        "file_size": int(file_size),
        "header_bytes": int(header_bytes),
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()


def _probe_limits(app: Any) -> tuple[int, int]:
    probe_size_bytes = getattr(app, "video_probe_probe_size_bytes", DEFAULT_PROBE_PROBE_SIZE_BYTES)
    analyze_duration_us = getattr(app, "video_probe_analyze_duration_us", DEFAULT_PROBE_ANALYZE_DURATION_US)
    try:
        probe_size_bytes = int(probe_size_bytes)
    except (TypeError, ValueError):
        probe_size_bytes = DEFAULT_PROBE_PROBE_SIZE_BYTES
    try:
        analyze_duration_us = int(analyze_duration_us)
    except (TypeError, ValueError):
        analyze_duration_us = DEFAULT_PROBE_ANALYZE_DURATION_US
    return max(32, probe_size_bytes), max(0, analyze_duration_us)


def _active_temp_dir() -> Path:
    return config_module.TEMP_DIR


def probe_cache_path(cache_key: str) -> Path:
    return _active_temp_dir() / PROBE_CACHE_SUBDIR / "files" / f"{cache_key}.json"


def _probe_cache_ttl_seconds(app: Any) -> float:
    configured = getattr(app, "video_probe_cache_ttl_seconds", DEFAULT_PROBE_CACHE_TTL_SECONDS)
    try:
        ttl_seconds = float(configured)
    except (TypeError, ValueError):
        ttl_seconds = DEFAULT_PROBE_CACHE_TTL_SECONDS
    return max(0.0, ttl_seconds)


def _probe_cache_max_bytes(app: Any) -> int:
    configured = getattr(app, "video_probe_cache_max_bytes", DEFAULT_PROBE_CACHE_MAX_BYTES)
    try:
        max_bytes = int(configured)
    except (TypeError, ValueError):
        max_bytes = DEFAULT_PROBE_CACHE_MAX_BYTES
    return max(0, max_bytes)


def _subtitle_cache_ttl_seconds(app: Any) -> float:
    configured = getattr(app, "video_subtitle_cache_ttl_seconds", DEFAULT_SUBTITLE_CACHE_TTL_SECONDS)
    try:
        ttl_seconds = float(configured)
    except (TypeError, ValueError):
        ttl_seconds = DEFAULT_SUBTITLE_CACHE_TTL_SECONDS
    return max(0.0, ttl_seconds)


def _subtitle_cache_max_bytes(app: Any) -> int:
    configured = getattr(app, "video_subtitle_cache_max_bytes", DEFAULT_SUBTITLE_CACHE_MAX_BYTES)
    try:
        max_bytes = int(configured)
    except (TypeError, ValueError):
        max_bytes = DEFAULT_SUBTITLE_CACHE_MAX_BYTES
    return max(0, max_bytes)


def _header_cache_ttl_seconds(app: Any) -> float:
    configured = getattr(app, "video_header_cache_ttl_seconds", DEFAULT_HEADER_CACHE_TTL_SECONDS)
    try:
        ttl_seconds = float(configured)
    except (TypeError, ValueError):
        ttl_seconds = DEFAULT_HEADER_CACHE_TTL_SECONDS
    return max(0.0, ttl_seconds)


def _header_cache_max_bytes(app: Any) -> int:
    configured = getattr(app, "video_header_cache_max_bytes", DEFAULT_HEADER_CACHE_MAX_BYTES)
    try:
        max_bytes = int(configured)
    except (TypeError, ValueError):
        max_bytes = DEFAULT_HEADER_CACHE_MAX_BYTES
    return max(0, max_bytes)


def _header_cache_bytes(app: Any) -> int:
    configured = getattr(app, "video_header_cache_bytes", DEFAULT_HEADER_CACHE_BYTES)
    try:
        header_bytes = int(configured)
    except (TypeError, ValueError):
        header_bytes = DEFAULT_HEADER_CACHE_BYTES
    return max(0, header_bytes)


def _probe_cache_store(app: Any) -> DiskCacheStore:
    return DiskCacheStore(
        _active_temp_dir() / PROBE_CACHE_SUBDIR,
        ttl_seconds=_probe_cache_ttl_seconds(app),
        max_bytes=_probe_cache_max_bytes(app),
    )


def _header_cache_store(app: Any) -> DiskCacheStore:
    return DiskCacheStore(
        _active_temp_dir() / HEADER_CACHE_SUBDIR,
        ttl_seconds=_header_cache_ttl_seconds(app),
        max_bytes=_header_cache_max_bytes(app),
    )


def probe_payload_is_incomplete(payload: dict[str, object]) -> bool:
    duration = payload.get("duration_seconds")
    if duration in (None, ""):
        return False
    try:
        duration_seconds = float(duration)
    except (TypeError, ValueError):
        return False
    if not math.isfinite(duration_seconds) or duration_seconds <= 0:
        return False
    stream_groups = (
        payload.get("video_streams"),
        payload.get("audio_streams"),
        payload.get("subtitle_streams"),
    )
    for streams in stream_groups:
        if isinstance(streams, list) and streams:
            return False
    return True


def _read_probe_cache(app: Any, cache_key: str) -> dict[str, object] | None:
    payload = _probe_cache_store(app).read_json(cache_key, suffix=".json")
    if not isinstance(payload, dict):
        return None
    if probe_payload_is_incomplete(payload):
        _probe_cache_store(app).remove(cache_key)
        return None
    return payload


def _write_probe_cache(app: Any, cache_key: str, payload: dict[str, object]) -> None:
    if _probe_cache_ttl_seconds(app) <= 0 or probe_payload_is_incomplete(payload):
        return
    _probe_cache_store(app).write_json(cache_key, payload, suffix=".json")


def clear_video_disk_caches(app: Any) -> dict[str, bool]:
    _probe_cache_store(app).clear()
    _header_cache_store(app).clear()
    _subtitle_cache_store(app).clear()
    return {
        "probe_cache": True,
        "header_cache": True,
        "subtitle_cache": True,
    }


def ensure_remote_header_cache(
    app: Any,
    *,
    rel_path: str,
    file_size: int,
) -> Path | None:
    header_bytes = _header_cache_bytes(app)
    if header_bytes <= 0 or file_size <= 0:
        return None
    fetch_count = min(file_size, header_bytes)
    cache_key = build_header_cache_key(rel_path, file_size, header_bytes=header_bytes)
    store = _header_cache_store(app)
    cached_path = store.get_path(cache_key, suffix=".bin")
    if cached_path is not None:
        return cached_path
    target = remote_target(app.remote, rel_path)
    proc = app.rclone.open_cat(target, offset=0, count=fetch_count)
    assert proc.stdout is not None
    buffer = io.BytesIO()
    try:
        copy_exact(proc.stdout, buffer, fetch_count)
    finally:
        app.rclone.finish_cat(proc)
    data = buffer.getvalue()
    if not data:
        return None
    return store.write_bytes(cache_key, data, suffix=".bin")


def build_remote_file_probe_url(base_url: str, rel_path: str) -> str:
    return base_url + "/file?" + urlencode({"path": rel_path, "source": "remote"})


def resolve_probe_input_url(
    app: Any,
    *,
    rel_path: str,
    base_url: str,
    file_size: int | None,
) -> str:
    if file_size is not None and file_size > 0:
        header_path = ensure_remote_header_cache(app, rel_path=rel_path, file_size=file_size)
        if header_path is not None and header_path.is_file():
            return str(header_path.resolve())
    return build_remote_file_probe_url(base_url, rel_path)


def _run_ffprobe_json(
    ffprobe_exe: Path,
    input_url: str,
    *,
    probe_size_bytes: int,
    analyze_duration_us: int,
) -> dict[str, object]:
    cmd = build_ffprobe_command(
        ffprobe_exe,
        input_url,
        probe_size_bytes=probe_size_bytes,
        analyze_duration_us=analyze_duration_us,
    )
    try:
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=30,
        )
    except FileNotFoundError as exc:
        raise BrowserError(HTTPStatus.SERVICE_UNAVAILABLE, f"ffprobe was not found: {exc}") from exc
    except subprocess.TimeoutExpired as exc:
        raise BrowserError(HTTPStatus.BAD_GATEWAY, "ffprobe timed out while probing the remote file.") from exc
    if proc.returncode != 0:
        message = proc.stderr.decode("utf-8", "replace").strip() or "ffprobe failed to inspect the remote file."
        raise BrowserError(HTTPStatus.BAD_GATEWAY, message)
    try:
        raw_payload = json.loads(proc.stdout.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise BrowserError(HTTPStatus.BAD_GATEWAY, "ffprobe returned invalid JSON.") from exc
    if not isinstance(raw_payload, dict):
        raise BrowserError(HTTPStatus.BAD_GATEWAY, "ffprobe returned invalid JSON.")
    return raw_payload


def _probe_payload_from_ffprobe_output(
    rel_path: str,
    *,
    input_url: str,
    raw_payload: dict[str, object],
) -> dict[str, object]:
    streams = raw_payload.get("streams")
    if not isinstance(streams, list):
        streams = []
    format_data = raw_payload.get("format")
    format_map = format_data if isinstance(format_data, dict) else {}
    video_streams: list[dict[str, object]] = []
    audio_streams: list[dict[str, object]] = []
    subtitle_streams: list[dict[str, object]] = []
    for item in streams:
        if not isinstance(item, dict):
            continue
        codec_type = item.get("codec_type")
        if codec_type == "video":
            video_streams.append(_video_stream(item))
        elif codec_type == "audio":
            audio_streams.append(_audio_stream(item))
        elif codec_type == "subtitle":
            subtitle_streams.append(_subtitle_stream(item))
    return {
        "status": "ok",
        "source": "remote",
        "path": rel_path,
        "stream_path": rel_path,
        "probe_url": input_url,
        "duration_seconds": _duration_seconds(format_map),
        "video_streams": video_streams,
        "audio_streams": audio_streams,
        "subtitle_streams": subtitle_streams,
        "default_audio_stream_index": _recommended_audio_index(audio_streams),
        "default_subtitle_stream_index": _recommended_subtitle_index(subtitle_streams),
        "subtitle_off_default": _recommended_subtitle_index(subtitle_streams) is None,
    }


def probe_remote_media(
    app: Any,
    *,
    rel_path: str,
    base_url: str,
    file_size: int | None = None,
) -> dict[str, object]:
    video_config = getattr(app, "video_tools_config", None)
    ffprobe_exe = getattr(video_config, "ffprobe_exe", None)
    if ffprobe_exe is None:
        raise BrowserError(HTTPStatus.SERVICE_UNAVAILABLE, "ffprobe is not available.")
    probe_size_bytes, analyze_duration_us = _probe_limits(app)
    cache_key = build_probe_cache_key(
        rel_path,
        file_size=file_size,
        probe_size_bytes=probe_size_bytes,
        analyze_duration_us=analyze_duration_us,
    )
    cached_payload = _read_probe_cache(app, cache_key)
    if cached_payload is not None:
        return dict(cached_payload)
    header_input_url = resolve_probe_input_url(
        app,
        rel_path=rel_path,
        base_url=base_url,
        file_size=file_size,
    )
    file_input_url = build_remote_file_probe_url(base_url, rel_path)
    raw_payload = _run_ffprobe_json(
        ffprobe_exe,
        header_input_url,
        probe_size_bytes=probe_size_bytes,
        analyze_duration_us=analyze_duration_us,
    )
    response_payload = _probe_payload_from_ffprobe_output(
        rel_path,
        input_url=header_input_url,
        raw_payload=raw_payload,
    )
    if probe_payload_is_incomplete(response_payload) and header_input_url != file_input_url:
        raw_payload = _run_ffprobe_json(
            ffprobe_exe,
            file_input_url,
            probe_size_bytes=probe_size_bytes,
            analyze_duration_us=analyze_duration_us,
        )
        response_payload = _probe_payload_from_ffprobe_output(
            rel_path,
            input_url=file_input_url,
            raw_payload=raw_payload,
        )
    _write_probe_cache(app, cache_key, response_payload)
    return response_payload


def extract_remote_subtitles_to_webvtt(
    app: Any,
    *,
    rel_path: str,
    subtitle_stream_index: int,
    base_url: str,
    file_size: int | None = None,
) -> tuple[bytes, str]:
    video_config = getattr(app, "video_tools_config", None)
    ffmpeg_exe = getattr(video_config, "ffmpeg_exe", None)
    ffprobe_exe = getattr(video_config, "ffprobe_exe", None)
    if ffmpeg_exe is None:
        raise BrowserError(HTTPStatus.SERVICE_UNAVAILABLE, "ffmpeg is not available.")
    if ffprobe_exe is None:
        raise BrowserError(HTTPStatus.SERVICE_UNAVAILABLE, "ffprobe is not available.")
    probe_payload = probe_remote_media(
        app,
        rel_path=rel_path,
        base_url=base_url,
        file_size=file_size,
    )
    subtitle_streams = probe_payload.get("subtitle_streams") if isinstance(probe_payload, dict) else None
    subtitle_rows = subtitle_streams if isinstance(subtitle_streams, list) else []
    track_info = next(
        (row for row in subtitle_rows if isinstance(row, dict) and int(row.get("index") or -1) == subtitle_stream_index),
        None,
    )
    if track_info is None:
        raise BrowserError(HTTPStatus.BAD_REQUEST, "Subtitle track was not found in probe metadata.")
    if not subtitle_codec_supports_webvtt(track_info.get("codec_name")):
        raise BrowserError(HTTPStatus.BAD_REQUEST, "Subtitle track cannot be converted to WebVTT.")
    cache_key = build_subtitle_cache_key(
        rel_path=rel_path,
        subtitle_stream_index=subtitle_stream_index,
        file_size=file_size,
    )
    cached_body = _read_subtitle_cache(app, cache_key)
    if cached_body is not None:
        return cached_body, str(track_info.get("language") or "")
    input_url = base_url + "/file?" + urlencode({"path": rel_path, "source": "remote"})
    body = _run_ffmpeg_single_webvtt(
        ffmpeg_exe,
        input_url,
        subtitle_stream_index,
        codec_name=track_info.get("codec_name"),
    )
    if body is None:
        raise BrowserError(HTTPStatus.BAD_GATEWAY, "ffmpeg failed to convert subtitles to WebVTT.")
    _write_subtitle_cache(app, cache_key, body)
    return body, str(track_info.get("language") or "")


def extract_remote_subtitle_window_to_webvtt(
    app: Any,
    *,
    rel_path: str,
    subtitle_stream_index: int,
    base_url: str,
    file_size: int | None = None,
    window_start_seconds: float = 0.0,
    window_duration_seconds: float = SUBTITLE_WINDOW_DURATION_SECONDS,
    window_status: str = "requested",
    playback_sync_token: int | None = None,
) -> dict[str, object]:
    video_config = getattr(app, "video_tools_config", None)
    ffmpeg_exe = getattr(video_config, "ffmpeg_exe", None)
    ffprobe_exe = getattr(video_config, "ffprobe_exe", None)
    if ffmpeg_exe is None:
        raise BrowserError(HTTPStatus.SERVICE_UNAVAILABLE, "ffmpeg is not available.")
    if ffprobe_exe is None:
        raise BrowserError(HTTPStatus.SERVICE_UNAVAILABLE, "ffprobe is not available.")
    probe_payload = probe_remote_media(
        app,
        rel_path=rel_path,
        base_url=base_url,
        file_size=file_size,
    )
    media_duration_seconds = (
        float(probe_payload.get("duration_seconds"))
        if isinstance(probe_payload, dict) and probe_payload.get("duration_seconds") is not None
        else None
    )
    subtitle_streams = probe_payload.get("subtitle_streams") if isinstance(probe_payload, dict) else None
    subtitle_rows = subtitle_streams if isinstance(subtitle_streams, list) else []
    track_info = next(
        (row for row in subtitle_rows if isinstance(row, dict) and int(row.get("index") or -1) == subtitle_stream_index),
        None,
    )
    if track_info is None:
        raise BrowserError(HTTPStatus.BAD_REQUEST, "Subtitle track was not found in probe metadata.")
    if not subtitle_codec_supports_webvtt(track_info.get("codec_name")):
        raise BrowserError(HTTPStatus.BAD_REQUEST, "Subtitle track cannot be converted to WebVTT.")
    language = str(track_info.get("language") or "")
    window_request = build_subtitle_window_request(
        rel_path=rel_path,
        subtitle_stream_index=subtitle_stream_index,
        file_size=file_size,
        window_start_seconds=window_start_seconds,
        window_duration_seconds=window_duration_seconds,
        window_status=window_status,
        playback_sync_token=playback_sync_token,
        media_duration_seconds=media_duration_seconds,
    )
    if str(window_request.get("window_status") or "").strip().casefold() != "backfill":
        _register_subtitle_backfill_context(
            app,
            rel_path=rel_path,
            subtitle_stream_index=subtitle_stream_index,
            playback_sync_token=(
                int(window_request["playback_sync_token"])
                if window_request.get("playback_sync_token") is not None
                else None
            ),
        )
    extraction_window = expand_subtitle_window_for_extraction(
        float(window_request["window_start_seconds"]),
        float(window_request["window_duration_seconds"]),
        media_duration_seconds=media_duration_seconds,
    )
    cached_window_key = build_subtitle_cache_key(
        rel_path=rel_path,
        subtitle_stream_index=subtitle_stream_index,
        file_size=file_size,
        window_start_seconds=float(window_request["window_start_seconds"]),
        window_duration_seconds=float(window_request["window_duration_seconds"]),
        cache_version=SUBTITLE_WINDOW_CACHE_VERSION,
    )
    cached_window_body = _read_subtitle_cache(app, cached_window_key)
    manifest = read_subtitle_window_manifest(
        app,
        rel_path=rel_path,
        subtitle_stream_index=subtitle_stream_index,
        file_size=file_size,
    )
    if cached_window_body is not None:
        cached_window_text = cached_window_body.decode("utf-8", "replace")
        coverage_ranges = manifest.get("coverage_ranges", [])
        return_payload = build_subtitle_window_response(
            track=subtitle_stream_index,
            window_start_seconds=float(window_request["window_start_seconds"]),
            window_duration_seconds=float(window_request["window_duration_seconds"]),
            coverage_complete=subtitle_window_is_covered(
                coverage_ranges if isinstance(coverage_ranges, list) else [],
                window_start_seconds=float(window_request["window_start_seconds"]),
                window_end_seconds=float(window_request["window_end_seconds"]),
            ),
            loaded_ranges=coverage_ranges if isinstance(coverage_ranges, list) else [],
            vtt=cached_window_text,
            window_status="ready",
            media_duration_seconds=media_duration_seconds,
        )
        if language:
            return_payload["language"] = language
        return_payload["cache_hit"] = True
        return_payload["path"] = clean_rel_path(rel_path)
        return_payload["file_size"] = None if file_size is None else int(file_size)
        _maybe_schedule_subtitle_window_backfill(
            app,
            rel_path=rel_path,
            subtitle_stream_index=subtitle_stream_index,
            base_url=base_url,
            file_size=file_size,
            media_duration_seconds=media_duration_seconds,
            window_request=window_request,
            response_payload=return_payload,
            window_status=str(window_request.get("window_status") or ""),
        )
        return return_payload
    owner, inflight_entry = _acquire_subtitle_window_inflight(app, cached_window_key)
    if not owner:
        event = inflight_entry.get("event")
        if isinstance(event, _THREAD_EVENT_TYPE):
            event.wait()
        cached_window_body = _read_subtitle_cache(app, cached_window_key)
        manifest = read_subtitle_window_manifest(
            app,
            rel_path=rel_path,
            subtitle_stream_index=subtitle_stream_index,
            file_size=file_size,
        )
        if cached_window_body is not None:
            cached_window_text = cached_window_body.decode("utf-8", "replace")
            coverage_ranges = manifest.get("coverage_ranges", [])
            return_payload = build_subtitle_window_response(
                track=subtitle_stream_index,
                window_start_seconds=float(window_request["window_start_seconds"]),
                window_duration_seconds=float(window_request["window_duration_seconds"]),
                coverage_complete=subtitle_window_is_covered(
                    coverage_ranges if isinstance(coverage_ranges, list) else [],
                    window_start_seconds=float(window_request["window_start_seconds"]),
                    window_end_seconds=float(window_request["window_end_seconds"]),
                ),
                loaded_ranges=coverage_ranges if isinstance(coverage_ranges, list) else [],
                vtt=cached_window_text,
                window_status="ready",
                media_duration_seconds=media_duration_seconds,
            )
            if language:
                return_payload["language"] = language
            return_payload["cache_hit"] = True
            return_payload["path"] = clean_rel_path(rel_path)
            return_payload["file_size"] = None if file_size is None else int(file_size)
            _maybe_schedule_subtitle_window_backfill(
                app,
                rel_path=rel_path,
                subtitle_stream_index=subtitle_stream_index,
                base_url=base_url,
                file_size=file_size,
                media_duration_seconds=media_duration_seconds,
                window_request=window_request,
                response_payload=return_payload,
                window_status=str(window_request.get("window_status") or ""),
            )
            return return_payload
        error = inflight_entry.get("error")
        if isinstance(error, BaseException):
            raise error
        raise BrowserError(HTTPStatus.BAD_GATEWAY, "Subtitle window extraction did not produce a cache entry.")
    input_url = base_url + "/file?" + urlencode({"path": rel_path, "source": "remote"})
    try:
        extracted_body = _run_ffmpeg_single_webvtt(
            ffmpeg_exe,
            input_url,
            subtitle_stream_index,
            codec_name=track_info.get("codec_name"),
            start_time_seconds=float(extraction_window["window_start_seconds"]),
            duration_seconds=float(extraction_window["window_duration_seconds"]),
        )
        if extracted_body is None:
            raise BrowserError(HTTPStatus.BAD_GATEWAY, "ffmpeg failed to convert subtitles to WebVTT.")
        extracted_text = extracted_body.decode("utf-8", "replace")
        if extracted_webvtt_needs_absolute_offset(
            extracted_text,
            start_time_seconds=float(extraction_window["window_start_seconds"]),
            window_duration_seconds=float(extraction_window["window_duration_seconds"]),
        ):
            extracted_text = offset_webvtt_text(
                extracted_text,
                float(extraction_window["window_start_seconds"]),
            )
        windowed_text = slice_webvtt_text_to_window(
            extracted_text,
            window_start_seconds=float(window_request["window_start_seconds"]),
            window_end_seconds=float(window_request["window_end_seconds"]),
        )
        _, manifest = store_subtitle_window_cache_entry(
            app,
            rel_path=rel_path,
            subtitle_stream_index=subtitle_stream_index,
            file_size=file_size,
            window_start_seconds=float(window_request["window_start_seconds"]),
            window_duration_seconds=float(window_request["window_duration_seconds"]),
            body=windowed_text.encode("utf-8"),
        )
        response_payload = build_subtitle_window_response(
            track=subtitle_stream_index,
            window_start_seconds=float(window_request["window_start_seconds"]),
            window_duration_seconds=float(window_request["window_duration_seconds"]),
            coverage_complete=subtitle_window_is_covered(
                manifest.get("coverage_ranges", []) if isinstance(manifest.get("coverage_ranges"), list) else [],
                window_start_seconds=float(window_request["window_start_seconds"]),
                window_end_seconds=float(window_request["window_end_seconds"]),
            ),
            loaded_ranges=manifest.get("coverage_ranges", []) if isinstance(manifest.get("coverage_ranges"), list) else [],
            vtt=windowed_text,
            window_status="ready",
            media_duration_seconds=media_duration_seconds,
        )
        if language:
            response_payload["language"] = language
        response_payload["cache_hit"] = False
        response_payload["path"] = clean_rel_path(rel_path)
        response_payload["file_size"] = None if file_size is None else int(file_size)
        _maybe_schedule_subtitle_window_backfill(
            app,
            rel_path=rel_path,
            subtitle_stream_index=subtitle_stream_index,
            base_url=base_url,
            file_size=file_size,
            media_duration_seconds=media_duration_seconds,
            window_request=window_request,
            response_payload=response_payload,
            window_status=str(window_request.get("window_status") or ""),
        )
        return response_payload
    except BaseException as exc:
        inflight_entry["error"] = exc
        raise
    finally:
        _release_subtitle_window_inflight(app, cached_window_key, inflight_entry)


def _store_extracted_subtitle_track(
    app: Any,
    *,
    rel_path: str,
    subtitle_stream_index: int,
    file_size: int | None,
    row: dict[str, object],
    body: bytes,
) -> dict[str, str]:
    cache_key = build_subtitle_cache_key(
        rel_path=rel_path,
        subtitle_stream_index=subtitle_stream_index,
        file_size=file_size,
    )
    _write_subtitle_cache(app, cache_key, body)
    return {
        "vtt": body.decode("utf-8", "replace"),
        "language": str(row.get("language") or ""),
    }


def _subtitle_backfill_job_key(
    *,
    rel_path: str,
    subtitle_stream_index: int,
    file_size: int | None,
    playback_sync_token: int | None = None,
) -> str:
    return json.dumps(
        {
            "rel_path": clean_rel_path(rel_path),
            "subtitle_stream_index": int(subtitle_stream_index),
            "file_size": None if file_size is None else int(file_size),
            "playback_sync_token": playback_sync_token,
        },
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )


def _run_subtitle_window_backfill(
    app: Any,
    *,
    rel_path: str,
    subtitle_stream_index: int,
    base_url: str,
    file_size: int | None,
    next_window_start_seconds: float,
    window_duration_seconds: float,
    media_duration_seconds: float | None,
    playback_sync_token: int | None,
    job_key: str,
) -> None:
    try:
        cursor = max(0.0, float(next_window_start_seconds))
        while media_duration_seconds is None or cursor < media_duration_seconds:
            if not _subtitle_backfill_request_is_current(
                app,
                rel_path=rel_path,
                subtitle_stream_index=subtitle_stream_index,
                playback_sync_token=playback_sync_token,
            ):
                break
            payload = extract_remote_subtitle_window_to_webvtt(
                app,
                rel_path=rel_path,
                subtitle_stream_index=subtitle_stream_index,
                base_url=base_url,
                file_size=file_size,
                window_start_seconds=cursor,
                window_duration_seconds=window_duration_seconds,
                window_status="backfill",
                playback_sync_token=playback_sync_token,
            )
            window_end_seconds = float(payload.get("window_end_seconds") or cursor)
            if window_end_seconds <= cursor:
                break
            cursor = window_end_seconds
            if media_duration_seconds is not None and cursor >= media_duration_seconds:
                break
    except Exception as exc:
        log_video_debug(
            app,
            "subtitle_window_backfill_failed",
            rel_path=clean_rel_path(rel_path),
            subtitle_stream_index=int(subtitle_stream_index),
            error=str(exc),
        )
    finally:
        with _subtitle_backfill_guard(app):
            jobs = _subtitle_backfill_jobs(app)
            current = jobs.get(job_key)
            if current is threading.current_thread():
                jobs.pop(job_key, None)


def _maybe_schedule_subtitle_window_backfill(
    app: Any,
    *,
    rel_path: str,
    subtitle_stream_index: int,
    base_url: str,
    file_size: int | None,
    media_duration_seconds: float | None,
    window_request: dict[str, object],
    response_payload: dict[str, object],
    window_status: str,
) -> None:
    if str(window_status or "").strip().casefold() != "startup":
        return
    next_window_start_seconds = float(response_payload.get("window_end_seconds") or 0.0)
    if media_duration_seconds is not None and next_window_start_seconds >= media_duration_seconds:
        return
    coverage_ranges = response_payload.get("loaded_ranges")
    if (
        isinstance(coverage_ranges, list)
        and subtitle_window_is_covered(
            coverage_ranges,
            window_start_seconds=next_window_start_seconds,
            window_end_seconds=next_window_start_seconds + float(window_request["window_duration_seconds"]),
        )
    ):
        return
    job_key = _subtitle_backfill_job_key(
        rel_path=rel_path,
        subtitle_stream_index=subtitle_stream_index,
        file_size=file_size,
        playback_sync_token=(
            int(window_request["playback_sync_token"])
            if window_request.get("playback_sync_token") is not None
            else None
        ),
    )
    with _subtitle_backfill_guard(app):
        jobs = _subtitle_backfill_jobs(app)
        existing = jobs.get(job_key)
        if existing is not None and existing.is_alive():
            return
        thread = threading.Thread(
            target=_run_subtitle_window_backfill,
            kwargs={
                "app": app,
                "rel_path": rel_path,
                "subtitle_stream_index": subtitle_stream_index,
                "base_url": base_url,
                "file_size": file_size,
                "next_window_start_seconds": next_window_start_seconds,
                "window_duration_seconds": float(window_request["window_duration_seconds"]),
                "media_duration_seconds": media_duration_seconds,
                "playback_sync_token": (
                    int(window_request["playback_sync_token"])
                    if window_request.get("playback_sync_token") is not None
                    else None
                ),
                "job_key": job_key,
            },
            daemon=True,
            name=f"subtitle-window-backfill-{subtitle_stream_index}",
        )
        jobs[job_key] = thread
    thread.start()


def _run_subprocess_capture(
    command: list[str],
    *,
    not_found_message: str,
    failure_message: str,
) -> bytes:
    try:
        proc = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except FileNotFoundError as exc:
        raise BrowserError(HTTPStatus.SERVICE_UNAVAILABLE, f"{not_found_message}: {exc}") from exc
    if proc.returncode != 0:
        message = proc.stderr.decode("utf-8", "replace").strip() or failure_message
        raise BrowserError(HTTPStatus.BAD_GATEWAY, message)
    return proc.stdout


def _convert_subtitle_file_to_webvtt(
    ffmpeg_exe: Path,
    subtitle_path: Path,
) -> bytes:
    if subtitle_path.suffix.casefold() == ".vtt":
        return subtitle_path.read_bytes()
    command = [
        str(ffmpeg_exe),
        "-v",
        "error",
        "-i",
        str(subtitle_path),
        "-f",
        "webvtt",
        "-",
    ]
    return _run_subprocess_capture(
        command,
        not_found_message="ffmpeg was not found",
        failure_message="ffmpeg failed to convert subtitles to WebVTT.",
    )


def _extract_subtitle_via_copy_then_convert(
    ffmpeg_exe: Path,
    input_url: str,
    subtitle_stream_index: int,
    codec_name: object,
    *,
    start_time_seconds: float = 0.0,
    duration_seconds: float | None = None,
) -> bytes | None:
    suffix = subtitle_codec_copy_suffix(codec_name)
    if suffix is None:
        return None
    temp_path = SUBTITLE_CACHE_DIR / f"copy_{uuid.uuid4().hex}_{subtitle_stream_index}{suffix}"
    temp_path.parent.mkdir(parents=True, exist_ok=True)
    command = build_ffmpeg_subtitle_copy_command(
        ffmpeg_exe,
        input_url,
        subtitle_stream_index,
        temp_path,
        start_time_seconds=start_time_seconds,
        duration_seconds=duration_seconds,
    )
    try:
        _run_subprocess_capture(
            command,
            not_found_message="ffmpeg was not found",
            failure_message="ffmpeg failed to copy subtitle track.",
        )
        return _convert_subtitle_file_to_webvtt(ffmpeg_exe, temp_path)
    finally:
        try:
            temp_path.unlink(missing_ok=True)
        except OSError:
            pass


def _run_ffmpeg_single_webvtt(
    ffmpeg_exe: Path,
    input_url: str,
    subtitle_stream_index: int,
    *,
    codec_name: object = None,
    start_time_seconds: float = 0.0,
    duration_seconds: float | None = None,
) -> bytes | None:
    copied_body = _extract_subtitle_via_copy_then_convert(
        ffmpeg_exe,
        input_url,
        subtitle_stream_index,
        codec_name,
        start_time_seconds=start_time_seconds,
        duration_seconds=duration_seconds,
    )
    if copied_body is not None:
        return copied_body
    command = build_ffmpeg_webvtt_command(
        ffmpeg_exe,
        input_url,
        subtitle_stream_index,
        start_time_seconds=start_time_seconds,
        duration_seconds=duration_seconds,
    )
    try:
        proc = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except FileNotFoundError:
        return None
    if proc.returncode != 0:
        return None
    return proc.stdout


def _run_ffmpeg_batch_webvtt(
    ffmpeg_exe: Path,
    input_url: str,
    missing_rows: list[dict[str, object]],
) -> dict[int, bytes] | None:
    if not missing_rows:
        return {}
    temp_paths: list[Path] = []
    missing_indices: list[int] = []
    copyable_rows: list[dict[str, object]] = []
    try:
        for row in missing_rows:
            subtitle_stream_index = int(row.get("index") or -1)
            suffix = subtitle_codec_copy_suffix(row.get("codec_name"))
            if suffix is None:
                return None
            temp_path = SUBTITLE_CACHE_DIR / f"batch_{uuid.uuid4().hex}_{subtitle_stream_index}{suffix}"
            temp_path.parent.mkdir(parents=True, exist_ok=True)
            temp_paths.append(temp_path)
            missing_indices.append(subtitle_stream_index)
            copyable_rows.append(row)
        command = build_ffmpeg_batch_subtitle_copy_command(
            ffmpeg_exe,
            input_url,
            missing_indices,
            temp_paths,
        )
        try:
            proc = subprocess.run(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )
        except FileNotFoundError:
            return None
        if proc.returncode != 0:
            return None
        results: dict[int, bytes] = {}
        for row, temp_path in zip(copyable_rows, temp_paths):
            subtitle_stream_index = int(row.get("index") or -1)
            try:
                body = _convert_subtitle_file_to_webvtt(ffmpeg_exe, temp_path)
            except (BrowserError, OSError):
                return None
            if body:
                results[subtitle_stream_index] = body
        return results
    finally:
        for temp_path in temp_paths:
            try:
                temp_path.unlink(missing_ok=True)
            except OSError:
                pass


def extract_all_remote_subtitles_to_webvtt(
    app: Any,
    *,
    rel_path: str,
    base_url: str,
    file_size: int | None = None,
) -> dict[str, object]:
    video_config = getattr(app, "video_tools_config", None)
    ffmpeg_exe = getattr(video_config, "ffmpeg_exe", None)
    ffprobe_exe = getattr(video_config, "ffprobe_exe", None)
    if ffmpeg_exe is None:
        raise BrowserError(HTTPStatus.SERVICE_UNAVAILABLE, "ffmpeg is not available.")
    if ffprobe_exe is None:
        raise BrowserError(HTTPStatus.SERVICE_UNAVAILABLE, "ffprobe is not available.")
    probe_payload = probe_remote_media(
        app,
        rel_path=rel_path,
        base_url=base_url,
        file_size=file_size,
    )
    subtitle_streams = probe_payload.get("subtitle_streams") if isinstance(probe_payload, dict) else None
    subtitle_rows = subtitle_streams if isinstance(subtitle_streams, list) else []
    track_rows = [row for row in subtitle_rows if isinstance(row, dict)]
    compatible_rows = [
        row for row in track_rows
        if subtitle_codec_supports_webvtt(row.get("codec_name"))
    ]
    tracks: dict[str, dict[str, str]] = {}
    if not compatible_rows:
        return {"status": "ok", "tracks": tracks}

    missing_rows: list[dict[str, object]] = []
    for row in compatible_rows:
        subtitle_stream_index = int(row.get("index") or -1)
        if subtitle_stream_index < 0:
            continue
        cache_key = build_subtitle_cache_key(
            rel_path=rel_path,
            subtitle_stream_index=subtitle_stream_index,
            file_size=file_size,
        )
        cached_body = _read_subtitle_cache(app, cache_key)
        if cached_body is not None:
            tracks[str(subtitle_stream_index)] = {
                "vtt": cached_body.decode("utf-8", "replace"),
                "language": str(row.get("language") or ""),
            }
            continue
        missing_rows.append(row)

    if missing_rows:
        input_url = base_url + "/file?" + urlencode({"path": rel_path, "source": "remote"})
        batch_results = _run_ffmpeg_batch_webvtt(
            ffmpeg_exe,
            input_url,
            missing_rows,
        )
        if batch_results is None:
            log_video_debug(
                app,
                "subtitle_batch_extract_failed",
                rel_path=rel_path,
                track_count=len(missing_rows),
            )
            for row in missing_rows:
                subtitle_stream_index = int(row.get("index") or -1)
                body = _run_ffmpeg_single_webvtt(
                    ffmpeg_exe,
                    input_url,
                    subtitle_stream_index,
                    codec_name=row.get("codec_name"),
                )
                if body is None:
                    log_video_debug(
                        app,
                        "subtitle_track_extract_failed",
                        rel_path=rel_path,
                        subtitle_stream_index=subtitle_stream_index,
                    )
                    continue
                tracks[str(subtitle_stream_index)] = _store_extracted_subtitle_track(
                    app,
                    rel_path=rel_path,
                    subtitle_stream_index=subtitle_stream_index,
                    file_size=file_size,
                    row=row,
                    body=body,
                )
        else:
            for row in missing_rows:
                subtitle_stream_index = int(row.get("index") or -1)
                body = batch_results.get(subtitle_stream_index)
                if body is None:
                    continue
                tracks[str(subtitle_stream_index)] = _store_extracted_subtitle_track(
                    app,
                    rel_path=rel_path,
                    subtitle_stream_index=subtitle_stream_index,
                    file_size=file_size,
                    row=row,
                    body=body,
                )

    return {"status": "ok", "tracks": tracks}


def handle_video_get(app: Any, path: str, query: str) -> tuple[HTTPStatus, dict]:
    endpoint = path.removeprefix(VIDEO_ENDPOINT_PREFIX)
    params = parse_qs(query, keep_blank_values=True)

    if endpoint == "library":
        rel_path = clean_rel_path(params.get("path", [""])[0])
        return HTTPStatus.OK, video_library_payload(app, rel_path=rel_path)

    if endpoint == "status":
        video_config = getattr(app, "video_tools_config", None)
        ffmpeg_exe = getattr(video_config, "ffmpeg_exe", None)
        ffprobe_exe = getattr(video_config, "ffprobe_exe", None)
        compatibility_available = bool(
            getattr(video_config, "compatibility_available", False)
            if video_config is not None
            else False
        )
        session_payload = video_session_manager(app).active_session_payload()
        return HTTPStatus.OK, {
            "status": "ok",
            "ffmpeg_available": ffmpeg_exe is not None,
            "ffprobe_available": ffprobe_exe is not None,
            "compatibility_available": compatibility_available,
            "native_only": not compatibility_available,
            "ffmpeg_path": str(ffmpeg_exe) if ffmpeg_exe is not None else None,
            "ffprobe_path": str(ffprobe_exe) if ffprobe_exe is not None else None,
            "endpoint_root": VIDEO_ENDPOINT_PREFIX.rstrip("/"),
            "query_keys": sorted(params),
            "active_session": session_payload,
        }

    raise BrowserError(HTTPStatus.NOT_FOUND, "Video endpoint not found.")
