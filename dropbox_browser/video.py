"""Video player endpoint helpers."""
from __future__ import annotations

import hashlib
import io
import json
import math
import os
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
SUBTITLE_CACHE_VERSION = "webvtt-v2-ass-cleanup"
SUBTITLE_WINDOW_CACHE_VERSION = "webvtt-window-v2-ass-cleanup"
SUBTITLE_WINDOW_MANIFEST_VERSION = "webvtt-window-manifest-v2-ass-cleanup"
PROBE_CACHE_VERSION = "ffprobe-v4"
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
VIDEO_BACKPRESSURE_STEADY_SLEEP_SECONDS = 0.05
VIDEO_BACKPRESSURE_SLOW_SLEEP_SECONDS = 0.15
VIDEO_BACKPRESSURE_HEAVY_SLEEP_SECONDS = 0.75
VIDEO_BACKPRESSURE_PAUSE_SLEEP_SECONDS = 2.0
SUBTITLE_WINDOW_DURATION_SECONDS = 300.0
SUBTITLE_WINDOW_SEEK_LEAD_SECONDS = 15.0
SUBTITLE_WINDOW_SEEK_LAG_SECONDS = SUBTITLE_WINDOW_DURATION_SECONDS - SUBTITLE_WINDOW_SEEK_LEAD_SECONDS
SUBTITLE_WINDOW_OVERLAP_SECONDS = 1.0
SUBTITLE_WINDOW_GAP_ACTION = "pause-until-ready"
VIDEO_DEBUG_LOG_PATH = TEMP_DIR / "video_debug.jsonl"
_VIDEO_DEBUG_LOG_LOCK = threading.Lock()
_THREAD_LOCK_TYPE = type(threading.Lock())
_THREAD_EVENT_TYPE = type(threading.Event())


def _video_session_dir() -> Path:
    return TEMP_DIR / "video_sessions"


def ffmpeg_popen_kwargs_for_priority(priority: str) -> dict[str, int]:
    normalized = str(priority or "").strip().lower().replace("-", "_")
    if os.name != "nt" or normalized == "normal":
        return {}
    if normalized == "idle":
        creation_flags = getattr(subprocess, "IDLE_PRIORITY_CLASS", None)
    elif normalized == "below_normal":
        creation_flags = getattr(subprocess, "BELOW_NORMAL_PRIORITY_CLASS", None)
    else:
        creation_flags = None
    if creation_flags is None:
        return {}
    return {"creationflags": int(creation_flags)}


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


def _peek_subtitle_window_inflight(app: Any, cache_key: str) -> dict[str, object] | None:
    with _subtitle_window_inflight_guard(app):
        inflight = _subtitle_window_inflight_map(app)
        entry = inflight.get(cache_key)
        return entry if isinstance(entry, dict) else None


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


def _log_subtitle_conversion_debug(
    app: Any | None,
    *,
    event: str,
    rel_path: str,
    subtitle_stream_index: int | None,
    codec_name: object,
    subtitle_path: Path | None = None,
    conversion_mode: str = "",
    start_time_seconds: float = 0.0,
    duration_seconds: float | None = None,
    raw_subtitle_text: str | None = None,
    converted_webvtt_text: str | None = None,
    reason: str = "",
) -> None:
    if app is None:
        return
    log_video_debug(
        app,
        event,
        rel_path=clean_rel_path(rel_path),
        subtitle_stream_index=(
            int(subtitle_stream_index)
            if subtitle_stream_index is not None
            else None
        ),
        codec_name=(None if codec_name is None else str(codec_name)),
        subtitle_path=(str(subtitle_path) if subtitle_path is not None else ""),
        conversion_mode=str(conversion_mode or ""),
        start_time_seconds=float(start_time_seconds),
        duration_seconds=(
            None
            if duration_seconds is None
            else float(duration_seconds)
        ),
        raw_subtitle_text=("" if raw_subtitle_text is None else str(raw_subtitle_text)),
        converted_webvtt_text=("" if converted_webvtt_text is None else str(converted_webvtt_text)),
        reason=str(reason or ""),
    )


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
    copy_compatible, copy_reason = video_stream_supports_h264_copy(result)
    result.update({
        "hls_video_copy_compatible": copy_compatible,
        "hls_video_copy_reason": copy_reason,
    })
    return result


def _audio_stream(stream_data: dict[str, object]) -> dict[str, object]:
    result = _base_stream(stream_data)
    result.update({
        "channels": stream_data.get("channels"),
        "channel_layout": stream_data.get("channel_layout"),
        "sample_rate": stream_data.get("sample_rate"),
    })
    copy_compatible, copy_reason = audio_stream_supports_aac_copy(result)
    result.update({
        "hls_audio_copy_compatible": copy_compatible,
        "hls_audio_copy_reason": copy_reason,
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

_H264_COPY_SAFE_PIXEL_FORMATS = frozenset({
    "nv12",
    "yuv420p",
    "yuvj420p",
})
_AAC_COPY_SAFE_EXTENSIONS = frozenset({
    ".m4v",
    ".mp4",
})
_ASS_SUBTITLE_CODECS = frozenset({
    "ass",
    "ssa",
})
_ASS_EVENT_TYPES = frozenset({
    "dialogue",
})
_ASS_DRAWING_OVERRIDE_PATTERN = re.compile(r"\\p\s*[1-9]\d*", re.IGNORECASE)
_ASS_DRAWING_MODE_OVERRIDE_RE = re.compile(r"\\p\s*(-?\d+)", re.IGNORECASE)
_ASS_OVERRIDE_BLOCK_RE = re.compile(r"\{[^}]*\}")
_ASS_DRAWING_TEXT_ONLY_RE = re.compile(r"^[mnlbspc\s0-9\.\-]+$", re.IGNORECASE)
_ASS_SIMPLE_STYLE_TAGS = ("b", "i", "u")
_ASS_SIMPLE_STYLE_OVERRIDE_RE = re.compile(r"\\([biur])(?:\s*([^\s\\{}]+))?", re.IGNORECASE)


def video_stream_supports_h264_copy(stream_data: dict[str, object]) -> tuple[bool, str]:
    codec_name = str(stream_data.get("codec_name") or "").strip().casefold()
    if codec_name != "h264":
        return False, "video_codec_not_h264"
    pix_fmt = str(stream_data.get("pix_fmt") or "").strip().casefold()
    if not pix_fmt:
        return False, "video_pix_fmt_unknown"
    if pix_fmt not in _H264_COPY_SAFE_PIXEL_FORMATS:
        return False, "video_pix_fmt_not_copy_safe"
    return True, "selected_h264_stream_copy_safe"


def audio_stream_supports_aac_copy(stream_data: dict[str, object]) -> tuple[bool, str]:
    codec_name = str(stream_data.get("codec_name") or "").strip().casefold()
    if codec_name != "aac":
        return False, "audio_codec_not_aac"
    return True, "selected_aac_stream_copy_safe"


def _probe_video_height(probe_payload: dict[str, object] | None) -> int | None:
    """Best-effort video frame height from probe metadata."""
    if not isinstance(probe_payload, dict):
        return None
    video_streams = probe_payload.get("video_streams")
    if not isinstance(video_streams, list) or not video_streams:
        return None
    first = video_streams[0]
    if not isinstance(first, dict):
        return None
    try:
        height = int(first.get("height") or 0)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return height or None


def compatibility_video_mode_for_probe(
    probe_payload: dict[str, object] | None,
    *,
    subtitle_stream_index: int | None,
    force_video_transcode: bool = False,
) -> tuple[str, str]:
    if force_video_transcode:
        return "video_transcode", "forced_video_transcode"
    if subtitle_stream_index is not None:
        return "video_transcode", "subtitle_burn_in_requires_filter"
    if not isinstance(probe_payload, dict):
        return "video_transcode", "probe_payload_missing"
    video_streams = probe_payload.get("video_streams")
    if not isinstance(video_streams, list) or not video_streams:
        return "video_transcode", "video_stream_missing"
    first_stream = video_streams[0]
    if not isinstance(first_stream, dict):
        return "video_transcode", "video_stream_missing"
    copy_compatible = bool(first_stream.get("hls_video_copy_compatible"))
    copy_reason = str(first_stream.get("hls_video_copy_reason") or "")
    if copy_compatible:
        return "video_copy", copy_reason or "selected_h264_stream_copy_safe"
    return "video_transcode", copy_reason or "video_copy_not_supported"


def compatibility_audio_mode_for_probe(
    probe_payload: dict[str, object] | None,
    *,
    rel_path: str = "",
    audio_stream_index: int | None,
    force_audio_transcode: bool = False,
) -> tuple[str, str]:
    if force_audio_transcode:
        return "audio_transcode", "forced_audio_transcode"
    if not isinstance(probe_payload, dict):
        return "audio_transcode", "probe_payload_missing"
    audio_streams = probe_payload.get("audio_streams")
    if not isinstance(audio_streams, list) or not audio_streams:
        return "audio_transcode", "audio_stream_missing"
    selected_index = audio_stream_index
    if selected_index is None:
        default_audio_stream_index = probe_payload.get("default_audio_stream_index")
        if default_audio_stream_index is not None:
            try:
                selected_index = int(default_audio_stream_index)
            except (TypeError, ValueError):
                selected_index = None
    selected_stream: dict[str, object] | None = None
    for stream in audio_streams:
        if not isinstance(stream, dict):
            continue
        if selected_index is None or int(stream.get("index") or -1) == selected_index:
            selected_stream = stream
            if selected_index is not None:
                break
    if not isinstance(selected_stream, dict):
        return "audio_transcode", "audio_stream_missing"
    copy_compatible = bool(selected_stream.get("hls_audio_copy_compatible"))
    copy_reason = str(selected_stream.get("hls_audio_copy_reason") or "")
    path_extension = Path(str(rel_path or "")).suffix.casefold()
    if copy_compatible and path_extension not in _AAC_COPY_SAFE_EXTENSIONS:
        return "audio_transcode", "audio_container_not_copy_safe"
    if copy_compatible:
        return "audio_copy", copy_reason or "selected_aac_stream_copy_safe"
    return "audio_transcode", copy_reason or "audio_copy_not_supported"


def subtitle_codec_supports_webvtt(codec_name: object) -> bool:
    if not isinstance(codec_name, str) or not codec_name.strip():
        return True
    return codec_name.casefold() not in _WEBVTT_INCOMPATIBLE_SUBTITLE_CODECS


def _stream_index_value(value: object) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _ass_split_fields(payload: str, field_count: int) -> list[str]:
    if field_count <= 1:
        return [payload]
    values = payload.split(",", field_count - 1)
    if len(values) < field_count:
        values.extend([""] * (field_count - len(values)))
    return [value.strip() for value in values[:field_count]]


def _ass_parse_section_fields(line: str) -> list[str]:
    _, _, raw_fields = line.partition(":")
    return [field.strip().casefold() for field in raw_fields.split(",") if field.strip()]


def _ass_parse_row(line: str, field_names: list[str]) -> dict[str, str] | None:
    _, _, raw_values = line.partition(":")
    if not field_names:
        return None
    values = _ass_split_fields(raw_values.lstrip(), len(field_names))
    if len(values) != len(field_names):
        return None
    return dict(zip(field_names, values))


def _ass_event_time_seconds(raw_value: str) -> float | None:
    parts = str(raw_value or "").strip().split(":")
    if len(parts) != 3:
        return None
    try:
        hours = int(parts[0])
        minutes = int(parts[1])
        seconds = float(parts[2])
    except (TypeError, ValueError):
        return None
    return (hours * 3600.0) + (minutes * 60.0) + seconds


def _ass_simple_style_state() -> dict[str, bool]:
    return {tag_name: False for tag_name in _ASS_SIMPLE_STYLE_TAGS}


def _ass_normalize_text_segment(text: str) -> str:
    normalized = str(text or "").replace("\\N", "\n").replace("\\n", "\n").replace("\\h", " ")
    normalized = normalized.replace("\r", "")
    normalized_lines = [
        re.sub(r"[ \t]+", " ", line).strip()
        for line in normalized.split("\n")
    ]
    return "\n".join(line for line in normalized_lines if line)


def _append_ass_style_transitions(parts: list[str], current_state: dict[str, bool], next_state: dict[str, bool]) -> None:
    for tag_name in reversed(_ASS_SIMPLE_STYLE_TAGS):
        if current_state[tag_name] and not next_state[tag_name]:
            parts.append(f"</{tag_name}>")
    for tag_name in _ASS_SIMPLE_STYLE_TAGS:
        if next_state[tag_name] and not current_state[tag_name]:
            parts.append(f"<{tag_name}>")


def _parse_ass_override_block(content: str, current_state: dict[str, bool], drawing_mode: int) -> tuple[dict[str, bool], int]:
    next_state = dict(current_state)
    for match in _ASS_SIMPLE_STYLE_OVERRIDE_RE.finditer(content):
        tag_name = str(match.group(1) or "").lower()
        raw_value = str(match.group(2) or "").strip()
        if tag_name == "r":
            next_state = _ass_simple_style_state()
            continue
        if tag_name not in next_state:
            continue
        if not raw_value:
            next_state[tag_name] = True
            continue
        try:
            next_state[tag_name] = int(raw_value) != 0
        except ValueError:
            next_state[tag_name] = False
    for match in _ASS_DRAWING_MODE_OVERRIDE_RE.finditer(content):
        raw_value = str(match.group(1) or "").strip()
        try:
            drawing_mode = max(0, int(raw_value))
        except ValueError:
            continue
    return next_state, drawing_mode


def _clean_ass_dialogue_text(raw_text: str) -> str:
    text = str(raw_text or "")
    parts: list[str] = []
    current_state = _ass_simple_style_state()
    drawing_mode = 0
    cursor = 0
    for match in _ASS_OVERRIDE_BLOCK_RE.finditer(text):
        if match.start() > cursor and drawing_mode <= 0:
            segment = _ass_normalize_text_segment(text[cursor:match.start()])
            if segment:
                parts.append(segment)
        override_content = match.group(0)[1:-1]
        next_state, drawing_mode = _parse_ass_override_block(override_content, current_state, drawing_mode)
        _append_ass_style_transitions(parts, current_state, next_state)
        current_state = next_state
        cursor = match.end()
    if cursor < len(text) and drawing_mode <= 0:
        segment = _ass_normalize_text_segment(text[cursor:])
        if segment:
            parts.append(segment)
    _append_ass_style_transitions(parts, current_state, _ass_simple_style_state())
    cleaned = "".join(parts).strip()
    cleaned_lines = [line for line in cleaned.split("\n") if line.strip()]
    return "\n".join(cleaned_lines).strip()


def _ass_text_is_drawing_only(raw_text: str, cleaned_text: str) -> bool:
    if not _ASS_DRAWING_OVERRIDE_PATTERN.search(str(raw_text or "")):
        return False
    candidate = " ".join(str(cleaned_text or "").split()).strip()
    if not candidate:
        return True
    return bool(_ASS_DRAWING_TEXT_ONLY_RE.fullmatch(candidate))


def convert_ass_text_to_webvtt(ass_text: str) -> bytes:
    text = str(ass_text or "").lstrip("\ufeff")
    if not text.strip():
        return b"WEBVTT\n\n"

    section_name = ""
    event_fields: list[str] = []
    cues: list[str] = []

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith(";"):
            continue
        if line.startswith("[") and line.endswith("]"):
            section_name = line.casefold()
            continue
        if section_name != "[events]":
            continue
        lower_line = line.casefold()
        if lower_line.startswith("format:"):
            event_fields = _ass_parse_section_fields(line)
            continue

        event_type, separator, _ = line.partition(":")
        if not separator or event_type.strip().casefold() not in _ASS_EVENT_TYPES:
            continue
        event_row = _ass_parse_row(line, event_fields)
        if event_row is None:
            continue

        start_seconds = _ass_event_time_seconds(str(event_row.get("start") or ""))
        end_seconds = _ass_event_time_seconds(str(event_row.get("end") or ""))
        if start_seconds is None or end_seconds is None or end_seconds <= start_seconds:
            continue

        raw_body = str(event_row.get("text") or "")
        cleaned_body = _clean_ass_dialogue_text(raw_body)
        if not cleaned_body:
            continue
        if _ass_text_is_drawing_only(raw_body, cleaned_body):
            continue

        cues.append(
            f"{_format_vtt_timestamp(start_seconds)} --> {_format_vtt_timestamp(end_seconds)}\n{cleaned_body}"
        )

    if not cues:
        return b"WEBVTT\n\n"
    return ("WEBVTT\n\n" + "\n\n".join(cues) + "\n").encode("utf-8")


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


def parse_video_transition_token(raw: object) -> int | None:
    text = str(raw or "").strip()
    if not text:
        return None
    try:
        value = int(text)
    except (TypeError, ValueError) as exc:
        raise BrowserError(HTTPStatus.BAD_REQUEST, "Video transition token must be an integer.") from exc
    if value < 0:
        raise BrowserError(HTTPStatus.BAD_REQUEST, "Video transition token must not be negative.")
    return value


def parse_video_playback_seconds(raw: object) -> float:
    text = str(raw or "").strip()
    if not text:
        raise BrowserError(HTTPStatus.BAD_REQUEST, "Playback seconds are required.")
    try:
        value = float(text)
    except (TypeError, ValueError) as exc:
        raise BrowserError(HTTPStatus.BAD_REQUEST, "Playback seconds must be a number of seconds.") from exc
    if not math.isfinite(value):
        raise BrowserError(HTTPStatus.BAD_REQUEST, "Playback seconds must be finite.")
    if value < 0:
        raise BrowserError(HTTPStatus.BAD_REQUEST, "Playback seconds must not be negative.")
    return value


def parse_optional_video_playback_seconds(raw: object) -> float | None:
    text = str(raw or "").strip()
    if not text:
        return None
    return parse_video_playback_seconds(text)


def parse_video_playback_state(raw: object) -> str:
    normalized = str(raw or "").strip().casefold()
    if not normalized:
        return "unknown"
    if normalized in {"playing", "paused", "unknown"}:
        return normalized
    raise BrowserError(HTTPStatus.BAD_REQUEST, "Playback state must be one of: playing, paused, unknown.")


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


def _subtitle_window_payload(
    *,
    rel_path: str,
    subtitle_stream_index: int,
    file_size: int | None,
    language: str,
    window_request: Mapping[str, object],
    media_duration_seconds: float | None,
    coverage_ranges: object,
    vtt_text: str,
    cache_hit: bool,
) -> dict[str, object]:
    normalized_coverage_ranges = coverage_ranges if isinstance(coverage_ranges, list) else []
    response_payload = build_subtitle_window_response(
        track=subtitle_stream_index,
        window_start_seconds=float(window_request["window_start_seconds"]),
        window_duration_seconds=float(window_request["window_duration_seconds"]),
        coverage_complete=subtitle_window_is_covered(
            normalized_coverage_ranges,
            window_start_seconds=float(window_request["window_start_seconds"]),
            window_end_seconds=float(window_request["window_end_seconds"]),
        ),
        loaded_ranges=normalized_coverage_ranges,
        vtt=vtt_text,
        window_status="ready",
        media_duration_seconds=media_duration_seconds,
    )
    if language:
        response_payload["language"] = language
    response_payload["cache_hit"] = bool(cache_hit)
    response_payload["path"] = clean_rel_path(rel_path)
    response_payload["file_size"] = None if file_size is None else int(file_size)
    return response_payload


def _log_subtitle_window_request(
    app: Any,
    *,
    rel_path: str,
    subtitle_stream_index: int,
    requested_window_status: str,
    window_request: Mapping[str, object],
    cache_hit: bool,
    inflight_waited: bool,
    request_started_at: float,
    response_payload: Mapping[str, object],
    background_backfill_scheduled: bool,
) -> None:
    loaded_ranges = response_payload.get("loaded_ranges")
    log_video_debug(
        app,
        "subtitle_window_request",
        rel_path=clean_rel_path(rel_path),
        subtitle_stream_index=int(subtitle_stream_index),
        window_status=str(requested_window_status or ""),
        request_window_start_seconds=float(window_request["window_start_seconds"]),
        request_window_end_seconds=float(window_request["window_end_seconds"]),
        cache_hit=bool(cache_hit),
        inflight_waited=bool(inflight_waited),
        extraction_duration_ms=round((time.perf_counter() - request_started_at) * 1000, 3),
        loaded_range_count=len(loaded_ranges) if isinstance(loaded_ranges, list) else 0,
        coverage_complete=bool(response_payload.get("coverage_complete")),
        background_backfill_scheduled=bool(background_backfill_scheduled),
    )


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
    subtitle_stroke_enabled: bool = True,
    subtitle_shadow_enabled: bool = True,
    start_time_seconds: float = 0.0,
    read_rate: float = 0.0,
    read_rate_initial_burst_seconds: float = 0.0,
    read_rate_catchup: float = 0.0,
    threads: int = 0,
    filter_threads: int = 0,
    copy_video: bool = False,
    copy_audio: bool = False,
    extra_video_filter: str | None = None,
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
    if read_rate > 0:
        command.extend(["-readrate", _format_ffmpeg_seconds(read_rate)])
        if read_rate_initial_burst_seconds > 0:
            command.extend([
                "-readrate_initial_burst",
                _format_ffmpeg_seconds(read_rate_initial_burst_seconds),
            ])
        if read_rate_catchup > 0:
            command.extend(["-readrate_catchup", _format_ffmpeg_seconds(read_rate_catchup)])
    command.extend([
        "-i",
        input_url,
    ])
    if filter_threads > 0:
        filter_thread_count = str(int(filter_threads))
        command.extend([
            "-filter_threads",
            filter_thread_count,
            "-filter_complex_threads",
            filter_thread_count,
        ])
    if extra_video_filter:
        # Forced text-subtitle burn-in: the caller already composed the
        # subtitles-filter graph (see dropbox_browser/video_burnin.py).
        command.extend([
            "-filter_complex",
            f"[0:v:0]{extra_video_filter}[vout]",
            "-map",
            "[vout]",
        ])
    elif subtitle_stream_index is None:
        command.extend([
            "-map",
            "0:v:0",
        ])
    else:
        # Burned-in styling currently supports stroke and shadow toggles only.
        # Subtitle size and vertical offset are WebVTT overlay controls and are
        # not yet applied to the ffmpeg overlay filter graph.
        if subtitle_stroke_enabled and subtitle_shadow_enabled:
            subtitle_filter = (
                f"[0:{subtitle_stream_index}]format=rgba,split=6"
                "[sub_main][sub_shadow_src][sub_stroke_left_src][sub_stroke_right_src]"
                "[sub_stroke_up_src][sub_stroke_down_src];"
                "[sub_shadow_src]colorchannelmixer=rr=0:gg=0:bb=0:aa=0.85[sub_shadow];"
                "[sub_stroke_left_src]colorchannelmixer=rr=0:gg=0:bb=0:aa=0.9[sub_stroke_left];"
                "[sub_stroke_right_src]colorchannelmixer=rr=0:gg=0:bb=0:aa=0.9[sub_stroke_right];"
                "[sub_stroke_up_src]colorchannelmixer=rr=0:gg=0:bb=0:aa=0.9[sub_stroke_up];"
                "[sub_stroke_down_src]colorchannelmixer=rr=0:gg=0:bb=0:aa=0.9[sub_stroke_down];"
                "[0:v:0][sub_stroke_left]overlay=-1:0[tmp1];"
                "[tmp1][sub_stroke_right]overlay=1:0[tmp2];"
                "[tmp2][sub_stroke_up]overlay=0:-1[tmp3];"
                "[tmp3][sub_stroke_down]overlay=0:1[tmp4];"
                "[tmp4][sub_shadow]overlay=2:2[tmp5];"
                "[tmp5][sub_main]overlay[vout]"
            )
        elif subtitle_stroke_enabled:
            subtitle_filter = (
                f"[0:{subtitle_stream_index}]format=rgba,split=5"
                "[sub_main][sub_stroke_left_src][sub_stroke_right_src]"
                "[sub_stroke_up_src][sub_stroke_down_src];"
                "[sub_stroke_left_src]colorchannelmixer=rr=0:gg=0:bb=0:aa=0.9[sub_stroke_left];"
                "[sub_stroke_right_src]colorchannelmixer=rr=0:gg=0:bb=0:aa=0.9[sub_stroke_right];"
                "[sub_stroke_up_src]colorchannelmixer=rr=0:gg=0:bb=0:aa=0.9[sub_stroke_up];"
                "[sub_stroke_down_src]colorchannelmixer=rr=0:gg=0:bb=0:aa=0.9[sub_stroke_down];"
                "[0:v:0][sub_stroke_left]overlay=-1:0[tmp1];"
                "[tmp1][sub_stroke_right]overlay=1:0[tmp2];"
                "[tmp2][sub_stroke_up]overlay=0:-1[tmp3];"
                "[tmp3][sub_stroke_down]overlay=0:1[tmp4];"
                "[tmp4][sub_main]overlay[vout]"
            )
        elif subtitle_shadow_enabled:
            subtitle_filter = (
                f"[0:{subtitle_stream_index}]format=rgba,split=2[sub_main][sub_shadow_src];"
                "[sub_shadow_src]colorchannelmixer=rr=0:gg=0:bb=0:aa=0.85[sub_shadow];"
                "[0:v:0][sub_shadow]overlay=2:2[tmp];"
                "[tmp][sub_main]overlay[vout]"
            )
        else:
            subtitle_filter = (
                f"[0:{subtitle_stream_index}]format=rgba[sub_main];"
                "[0:v:0][sub_main]overlay[vout]"
            )
        command.extend([
            "-filter_complex",
            subtitle_filter,
            "-map",
            "[vout]",
        ])
    if audio_stream_index is None:
        command.extend(["-map", "0:a:0?"])
    else:
        command.extend(["-map", f"0:{audio_stream_index}?"])
    if threads > 0:
        command.extend(["-threads", str(int(threads))])
    command.extend(["-sn"])
    if copy_video and subtitle_stream_index is None:
        command.extend([
            "-c:v",
            "copy",
        ])
    else:
        command.extend([
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
        ])
    if copy_audio:
        command.extend([
            "-c:a",
            "copy",
        ])
    else:
        command.extend([
            "-c:a",
            "aac",
            "-ac",
            "2",
            "-ar",
            "48000",
        ])
    command.extend([
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
    from .media_library import display_name_for_root

    return display_name_for_root(rel_path)


def _is_supported_video(name: str) -> bool:
    from .media_library import is_supported_media

    return is_supported_media(name, SUPPORTED_VIDEO_EXTENSIONS)


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


@dataclass
class VideoHlsSession:
    session_id: str
    rel_path: str
    file_size: int | None
    session_dir: Path
    playlist_path: Path
    process: subprocess.Popen[bytes]
    command: list[str]
    created_at: float
    create_started_at: float
    last_accessed_at: float
    client_id: str
    audio_stream_index: int | None
    subtitle_stream_index: int | None
    start_time_seconds: float
    video_mode: str
    video_mode_reason: str
    audio_mode: str
    audio_mode_reason: str
    reported_playback_seconds: float | None = None
    reported_media_seconds: float | None = None
    reported_playback_state: str = "unknown"
    reported_playback_updated_at: float | None = None
    reported_playback_sync_token: int | None = None

    def touch(self) -> None:
        self.last_accessed_at = time.time()


@dataclass(frozen=True)
class VideoInputThrottleDecision:
    cancel: bool = False
    sleep_seconds: float = 0.0
    throttle_mode: str = "unthrottled"
    ahead_seconds: float | None = None


@dataclass(frozen=True)
class TaggedInputFileMetadata:
    session_id: str
    rel_path: str
    file_size: int
    session: VideoHlsSession


class VideoSessionManager:
    def __init__(self, app: Any) -> None:
        self.app = app
        self.root_dir = _video_session_dir()
        self.root_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._sessions: dict[str, VideoHlsSession] = {}
        self._active_session_id: str | None = None
        self._session_lifecycle: dict[str, dict[str, object]] = {}
        self._pending_session_creations = 0
        self._deferred_session_stops: list[VideoHlsSession] = []
        self._client_stop_generations: dict[str, int] = {}
        self._client_transition_tokens: dict[str, int] = {}
        self._client_stop_tokens: dict[str, int] = {}

    def shutdown(self) -> None:
        with self._lock:
            for session_id in list(self._sessions):
                self._remove_session_locked(session_id)
        self._drain_deferred_session_stops()
        if self.root_dir.exists():
            shutil.rmtree(self.root_dir, ignore_errors=True)

    def create_session(
        self,
        *,
        rel_path: str,
        base_url: str,
        file_size: int | None = None,
        client_id: str = "",
        audio_stream_index: int | None = None,
        subtitle_stream_index: int | None = None,
        subtitle_stroke_enabled: bool = True,
        subtitle_shadow_enabled: bool = True,
        subtitle_font_size_px: int | None = None,
        subtitle_offset_px: int | None = None,
        subtitle_display_height_px: int | None = None,
        force_subtitle_burn_in: bool = False,
        start_time_seconds: float = 0.0,
        force_video_transcode: bool = False,
        force_audio_transcode: bool = False,
        transition_token: int | None = None,
    ) -> dict[str, object]:
        video_config = getattr(self.app, "video_tools_config", None)
        ffmpeg_exe = getattr(video_config, "ffmpeg_exe", None)
        if ffmpeg_exe is None:
            raise BrowserError(HTTPStatus.SERVICE_UNAVAILABLE, "ffmpeg is not available.")
        max_session_count = int(getattr(video_config, "max_concurrent_sessions", 8) or 8)
        if max_session_count <= 0:
            max_session_count = 1
        evicted_session_id: str | None = None
        normalized_client_id = str(client_id or "")
        with self._lock:
            self._cleanup_expired_locked()
            client_stop_generation = self._client_stop_generations.get(normalized_client_id, 0)
            if normalized_client_id and transition_token is not None:
                current_transition_token = self._client_transition_tokens.get(normalized_client_id, -1)
                if transition_token > current_transition_token:
                    self._client_transition_tokens[normalized_client_id] = transition_token
            active_count = len(self._sessions)
            pending_count = self._pending_session_creations
            if (active_count + pending_count) >= max_session_count:
                evictable_session = self._oldest_idle_session_locked()
                if evictable_session is not None:
                    evicted_session_id = evictable_session.session_id
                    self._remove_session_locked(evictable_session.session_id, reason="evicted")
                    active_count = len(self._sessions)
                if (active_count + pending_count) >= max_session_count:
                    log_video_debug(
                        self.app,
                        "session_cap_reached",
                        path=rel_path,
                        active_session_count=active_count,
                        pending_session_count=pending_count,
                        max_session_count=max_session_count,
                        rejection_reason="all_sessions_active",
                    )
                    raise BrowserError(
                        HTTPStatus.TOO_MANY_REQUESTS,
                        f"Video session limit reached ({max_session_count} max concurrent sessions; all session slots are currently active).",
                        details={
                            "error_code": "session_cap_reached",
                            "session_error_reason": "all_sessions_active",
                            "max_session_count": max_session_count,
                            "active_session_count": active_count,
                            "pending_session_count": pending_count,
                        },
                    )
            self._pending_session_creations += 1
        self._drain_deferred_session_stops()
        reservation_active = True

        try:
            probe_payload: dict[str, object] | None = None
            try:
                probe_payload = probe_remote_media(
                    self.app,
                    rel_path=rel_path,
                    base_url=base_url,
                    file_size=file_size,
                )
            except Exception:
                probe_payload = None
            video_mode, video_mode_reason = compatibility_video_mode_for_probe(
                probe_payload,
                subtitle_stream_index=subtitle_stream_index,
                force_video_transcode=force_video_transcode,
            )
            audio_mode, audio_mode_reason = compatibility_audio_mode_for_probe(
                probe_payload,
                rel_path=rel_path,
                audio_stream_index=audio_stream_index,
                force_audio_transcode=force_audio_transcode,
            )
            session_id = uuid.uuid4().hex
            input_url = base_url + "/file?" + urlencode({
                "path": rel_path,
                "source": "remote",
                "video_session_id": session_id,
            })
            create_started_at = time.monotonic()
            session_dir = self.root_dir / session_id
            session_dir.mkdir(parents=True, exist_ok=True)
            playlist_path = session_dir / HLS_PLAYLIST_NAME
            segment_base_url = "/video/endpoints/session/file?" + urlencode({"id": session_id, "name": ""})
            extra_video_filter: str | None = None
            burnin_mode: str | None = None
            burnin_srt_name: str | None = None
            if (
                force_subtitle_burn_in
                and subtitle_stream_index is not None
            ):
                try:
                    from .video_burnin import (
                        build_text_subtitle_burnin_filter,
                        extract_subtitle_stream_to_srt,
                        scale_burnin_font_size,
                        scale_burnin_offset_px,
                    )

                    # The extraction runs before this session is registered, so
                    # it must NOT use the tagged input URL: tagged requests are
                    # cancelled while their session is unknown to the manager.
                    extraction_url = base_url + "/file?" + urlencode({
                        "path": rel_path,
                        "source": "remote",
                    })
                    scaled_font_size = scale_burnin_font_size(
                        subtitle_font_size_px,
                        subtitle_display_height_px,
                        _probe_video_height(probe_payload),
                    )
                    srt_path = session_dir / "burnin.srt"
                    extract_subtitle_stream_to_srt(
                        ffmpeg_exe,
                        extraction_url,
                        srt_path,
                        subtitle_stream_index=int(subtitle_stream_index),
                        start_time_seconds=start_time_seconds,
                    )
                    extra_video_filter = build_text_subtitle_burnin_filter(
                        srt_path.name,
                        stroke_enabled=subtitle_stroke_enabled,
                        shadow_enabled=subtitle_shadow_enabled,
                        font_size_px=scaled_font_size,
                        offset_px=scale_burnin_offset_px(
                            subtitle_offset_px,
                            subtitle_display_height_px,
                            _probe_video_height(probe_payload),
                        ),
                    )
                    burnin_mode = "text_subtitles_filter"
                    burnin_srt_name = srt_path.name
                except RuntimeError:
                    shutil.rmtree(session_dir, ignore_errors=True)
                    raise BrowserError(
                        HTTPStatus.SERVICE_UNAVAILABLE,
                        "Forced subtitle burn-in extraction failed.",
                    )
            command = build_ffmpeg_hls_command(
                ffmpeg_exe,
                input_url,
                playlist_path,
                segment_base_url=segment_base_url,
                audio_stream_index=audio_stream_index,
                subtitle_stream_index=subtitle_stream_index,
                subtitle_stroke_enabled=subtitle_stroke_enabled,
                subtitle_shadow_enabled=subtitle_shadow_enabled,
                start_time_seconds=start_time_seconds,
                read_rate=float(getattr(video_config, "ffmpeg_read_rate", 0.0) or 0.0),
                read_rate_initial_burst_seconds=float(
                    getattr(video_config, "ffmpeg_initial_burst_seconds", 0.0) or 0.0
                ),
                read_rate_catchup=float(getattr(video_config, "ffmpeg_catchup_read_rate", 0.0) or 0.0),
                threads=int(getattr(video_config, "ffmpeg_threads", 0) or 0),
                filter_threads=int(getattr(video_config, "ffmpeg_filter_threads", 0) or 0),
                copy_video=video_mode == "video_copy",
                copy_audio=audio_mode == "audio_copy",
                extra_video_filter=extra_video_filter,
            )
            process_priority = str(getattr(video_config, "ffmpeg_process_priority", "below_normal") or "below_normal")
            priority_popen_kwargs = ffmpeg_popen_kwargs_for_priority(process_priority)
            log_video_debug(
                self.app,
                "session_create_start",
                session_id=session_id,
                path=rel_path,
                audio_stream_index=audio_stream_index,
                subtitle_stream_index=subtitle_stream_index,
                subtitle_stroke_enabled=subtitle_stroke_enabled,
                subtitle_shadow_enabled=subtitle_shadow_enabled,
                start_time_seconds=start_time_seconds,
                force_video_transcode=force_video_transcode,
                force_audio_transcode=force_audio_transcode,
                video_mode=video_mode,
                video_mode_reason=video_mode_reason,
                audio_mode=audio_mode,
                audio_mode_reason=audio_mode_reason,
                evicted_session_id=evicted_session_id,
                playlist=str(playlist_path),
                command=command,
                ffmpeg_process_priority=process_priority,
                force_subtitle_burn_in=bool(force_subtitle_burn_in and extra_video_filter is not None),
                burnin_mode=burnin_mode,
                burnin_subtitle_file=burnin_srt_name,
            )
            try:
                process: subprocess.Popen[bytes] = subprocess.Popen(  # type: ignore[type-var]
                    command,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                    cwd=session_dir,
                    **priority_popen_kwargs,
                )
            except FileNotFoundError as exc:
                shutil.rmtree(session_dir, ignore_errors=True)
                raise BrowserError(HTTPStatus.SERVICE_UNAVAILABLE, f"ffmpeg was not found: {exc}") from exc

            session = VideoHlsSession(
                session_id=session_id,
                rel_path=rel_path,
                file_size=(None if file_size is None else int(file_size)),
                session_dir=session_dir,
                playlist_path=playlist_path,
                process=process,
                command=command,
                created_at=time.time(),
                create_started_at=create_started_at,
                last_accessed_at=time.time(),
                client_id=str(client_id or ""),
                audio_stream_index=audio_stream_index,
                subtitle_stream_index=subtitle_stream_index,
                start_time_seconds=start_time_seconds,
                video_mode=video_mode,
                video_mode_reason=video_mode_reason,
                audio_mode=audio_mode,
                audio_mode_reason=audio_mode_reason,
            )
            with self._lock:
                self._cleanup_expired_locked()
                self._pending_session_creations = max(0, self._pending_session_creations - 1)
                reservation_active = False
                client_stop_cancelled = (
                    bool(normalized_client_id)
                    and self._client_stop_generations.get(normalized_client_id, 0) != client_stop_generation
                )
                if normalized_client_id and transition_token is not None:
                    current_transition_token = self._client_transition_tokens.get(normalized_client_id, -1)
                    last_stop_token = self._client_stop_tokens.get(normalized_client_id, -1)
                    client_stop_cancelled = client_stop_cancelled or transition_token < current_transition_token
                    client_stop_cancelled = client_stop_cancelled or transition_token < last_stop_token
                if not client_stop_cancelled:
                    self._sessions[session_id] = session
                    self._active_session_id = session_id
            self._drain_deferred_session_stops()
            if client_stop_cancelled:
                self._stop_session_resources(session)
                raise BrowserError(HTTPStatus.CONFLICT, "Video session was stopped before it became ready.")
            ready_timeout_seconds = (
                HLS_READY_TIMEOUT_BURN_IN_SECONDS
                if subtitle_stream_index is not None
                else HLS_READY_TIMEOUT_SECONDS
            )
            try:
                playlist_ready = self._wait_for_playlist(session, timeout_seconds=ready_timeout_seconds)
            except BrowserError:
                with self._lock:
                    self._remove_session_locked(session_id, reason="create_failed")
                self._drain_deferred_session_stops()
                raise
            if not playlist_ready:
                with self._lock:
                    self._remove_session_locked(session_id, reason="create_timeout")
                self._drain_deferred_session_stops()
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
        finally:
            if reservation_active:
                with self._lock:
                    self._pending_session_creations = max(0, self._pending_session_creations - 1)
            self._drain_deferred_session_stops()

    def stop_session(
        self,
        session_id: str | None = None,
        *,
        client_id: str = "",
        transition_token: int | None = None,
    ) -> dict[str, object]:
        with self._lock:
            self._cleanup_expired_locked()
            normalized_client_id = str(client_id or "")
            current_transition_token = self._client_transition_tokens.get(normalized_client_id, -1)
            stale_transition = (
                bool(normalized_client_id)
                and transition_token is not None
                and transition_token < current_transition_token
            )
            if normalized_client_id and not stale_transition:
                if transition_token is not None:
                    self._client_transition_tokens[normalized_client_id] = max(
                        current_transition_token,
                        transition_token,
                    )
                    self._client_stop_tokens[normalized_client_id] = max(
                        self._client_stop_tokens.get(normalized_client_id, -1),
                        transition_token,
                    )
                # An exact-session cleanup must not invalidate an unrelated
                # create that is already in flight. A stale response from an
                # older transition can arrive after the newer create starts;
                # its session id is safe to remove, but its missing token must
                # not become a client-wide cancellation generation. Stops
                # carrying the current transition token still cancel pending
                # work for that transition (for example pagehide cleanup).
                if not session_id or transition_token is not None:
                    self._client_stop_generations[normalized_client_id] = (
                        self._client_stop_generations.get(normalized_client_id, 0) + 1
                    )
            if session_id:
                session = self._get_session_locked(session_id)
                sessions = [session] if session is not None else []
            elif normalized_client_id and not stale_transition:
                sessions = [
                    session
                    for session in self._sessions.values()
                    if session.client_id == normalized_client_id
                ]
            else:
                sessions = []
            if not sessions:
                result = {"status": "ok", "stopped": False}
            else:
                for session in sessions:
                    self._remove_session_locked(session.session_id, reason="stopped")
                result = {"status": "ok", "stopped": True}
        self._drain_deferred_session_stops()
        return result

    def session_asset(self, session_id: str, name: str) -> tuple[Path, str]:
        asset_error: BrowserError | None = None
        with self._lock:
            self._cleanup_expired_locked()
            session = self._get_session_locked(session_id)
            if session is None:
                missing_payload = self._session_missing_payload_locked(session_id)
                log_video_debug(
                    self.app,
                    "asset_missing_session",
                    session_id=session_id,
                    name=name,
                    session_state=missing_payload["session_state"],
                    session_state_message=missing_payload["session_state_message"],
                )
                asset_error = BrowserError(
                    HTTPStatus.NOT_FOUND,
                    str(missing_payload["session_state_message"]),
                    details={
                        "error_code": "session_missing",
                        **missing_payload,
                    },
                )
            asset_name = _safe_session_asset_name(name)
            asset_path = (
                (session.session_dir / asset_name).resolve()
                if session is not None
                else Path()
            )
            try:
                if session is not None:
                    asset_path.relative_to(session.session_dir.resolve())
            except ValueError:
                log_video_debug(self.app, "asset_bad_path", session_id=session_id, name=name)
                asset_error = BrowserError(HTTPStatus.NOT_FOUND, "Video session asset not found.")
        self._drain_deferred_session_stops()
        if asset_error is not None:
            raise asset_error
        assert session is not None
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
            if self._get_session_locked(session.session_id) is not session:
                missing_payload = self._session_missing_payload_locked(session_id)
                log_video_debug(
                    self.app,
                    "asset_session_replaced",
                    session_id=session_id,
                    name=asset_path.name,
                    session_state=missing_payload["session_state"],
                    session_state_message=missing_payload["session_state_message"],
                )
                raise BrowserError(
                    HTTPStatus.NOT_FOUND,
                    str(missing_payload["session_state_message"]),
                    details={
                        "error_code": "session_missing",
                        **missing_payload,
                    },
                )
            session.touch()
            self._active_session_id = session.session_id
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
            session = self._active_session_locked()
            if session is None:
                payload = None
            else:
                payload = self._session_summary_payload(session)
        self._drain_deferred_session_stops()
        return payload

    def session_status_payload(self, session_id: str | None = None) -> dict[str, object]:
        with self._lock:
            self._cleanup_expired_locked()
            active_session = self._active_session_locked()
            active_sessions = self._session_summaries_locked(session_id)
            if session_id:
                active_session_payload = active_sessions[0] if active_sessions else None
            else:
                active_session_payload = (
                    self._session_summary_payload(active_session)
                    if active_session is not None
                    else None
                )
            payload = {
                "active_session": active_session_payload,
                "active_sessions": active_sessions,
                "session_count": len(active_sessions),
            }
        self._drain_deferred_session_stops()
        return payload

    def tagged_input_session(self, session_id: str | None, rel_path: str) -> VideoHlsSession | None:
        matched_session, _reason = self.tagged_input_session_status(session_id, rel_path)
        return matched_session

    def tagged_input_file_metadata(
        self,
        session_id: str | None,
        rel_path: str,
    ) -> tuple[TaggedInputFileMetadata | None, str]:
        normalized_session_id = str(session_id or "").strip()
        if not normalized_session_id:
            return None, "untagged"
        normalized_rel_path = clean_rel_path(rel_path)
        with self._lock:
            self._cleanup_expired_locked()
            session = self._get_session_locked(normalized_session_id)
            if session is None:
                log_video_debug(
                    self.app,
                    "tagged_input_session_miss",
                    session_id=normalized_session_id,
                    rel_path=normalized_rel_path,
                    reason="session_missing",
                )
                metadata = None
                reason = "session_missing"
            elif clean_rel_path(session.rel_path) != normalized_rel_path:
                log_video_debug(
                    self.app,
                    "tagged_input_session_miss",
                    session_id=normalized_session_id,
                    rel_path=normalized_rel_path,
                    active_rel_path=clean_rel_path(session.rel_path),
                    reason="path_mismatch",
                )
                metadata = None
                reason = "path_mismatch"
            elif session.file_size is None:
                log_video_debug(
                    self.app,
                    "tagged_input_session_miss",
                    session_id=normalized_session_id,
                    rel_path=normalized_rel_path,
                    reason="metadata_missing",
                )
                metadata = None
                reason = "metadata_missing"
            else:
                session.touch()
                self._active_session_id = session.session_id
                canonical_rel_path = clean_rel_path(session.rel_path)
                log_video_debug(
                    self.app,
                    "tagged_input_session_match",
                    session_id=normalized_session_id,
                    rel_path=canonical_rel_path,
                )
                metadata = TaggedInputFileMetadata(
                    session_id=session.session_id,
                    rel_path=canonical_rel_path,
                    file_size=int(session.file_size),
                    session=session,
                )
                reason = "matched"
        self._drain_deferred_session_stops()
        return metadata, reason

    def tagged_input_session_status(self, session_id: str | None, rel_path: str) -> tuple[VideoHlsSession | None, str]:
        metadata, reason = self.tagged_input_file_metadata(session_id, rel_path)
        return (None if metadata is None else metadata.session), reason

    def tagged_input_throttle_decision(self, session_id: str | None, rel_path: str) -> VideoInputThrottleDecision:
        normalized_session_id = str(session_id or "").strip()
        if not normalized_session_id:
            return VideoInputThrottleDecision(cancel=False, throttle_mode="untagged")
        normalized_rel_path = clean_rel_path(rel_path)
        with self._lock:
            self._cleanup_expired_locked()
            session = self._get_session_locked(normalized_session_id)
            if session is None:
                decision = VideoInputThrottleDecision(cancel=True, throttle_mode="session_missing")
            elif clean_rel_path(session.rel_path) != normalized_rel_path:
                decision = VideoInputThrottleDecision(cancel=True, throttle_mode="path_mismatch")
            else:
                reported_playback_seconds = session.reported_playback_seconds
                ahead_seconds = None
                if reported_playback_seconds is not None:
                    ahead_seconds = max(
                        0.0,
                        session.start_time_seconds
                        + self._encoded_media_end_seconds(session)
                        - float(reported_playback_seconds),
                    )
                decision = self._backpressure_decision_for_session(session, ahead_seconds=ahead_seconds)
        self._drain_deferred_session_stops()
        return decision

    def update_session_progress(
        self,
        *,
        session_id: str,
        playback_seconds: float,
        media_seconds: float | None = None,
        playback_state: str,
        playback_sync_token: int | None = None,
        client_id: str = "",
    ) -> dict[str, object]:
        updated_at = time.time()
        with self._lock:
            self._cleanup_expired_locked()
            session = self._get_session_locked(session_id)
            if session is None:
                active_session = self._active_session_locked()
                missing_payload = self._session_missing_payload_locked(session_id)
                payload = {
                    "status": "ok",
                    "updated": False,
                    "stale": True,
                    "session_id": session_id,
                    "session_state": missing_payload["session_state"],
                    "session_state_message": missing_payload["session_state_message"],
                    "stale_reason": missing_payload["session_state"],
                    "active_session_id": active_session.session_id if active_session is not None else None,
                }
            else:
                session.reported_playback_seconds = float(playback_seconds)
                session.reported_media_seconds = None if media_seconds is None else float(media_seconds)
                session.reported_playback_state = str(playback_state or "unknown")
                session.reported_playback_updated_at = updated_at
                session.reported_playback_sync_token = playback_sync_token
                session.touch()
                self._active_session_id = session.session_id
                playback_payload = self._session_playback_payload(session)
                payload = {
                    "status": "ok",
                    "updated": True,
                    "stale": False,
                    "session_id": session_id,
                    "client_playback": playback_payload,
                }
        self._drain_deferred_session_stops()
        if not payload.get("updated"):
            return payload
        log_video_debug(
            self.app,
            "session_progress_update",
            session_id=session_id,
            client_id=str(client_id or ""),
            playback_seconds=float(playback_seconds),
            media_seconds=media_seconds,
            playback_state=str(playback_state or "unknown"),
            playback_sync_token=playback_sync_token,
        )
        return payload

    def _encoded_media_end_seconds(self, session: VideoHlsSession) -> float:
        if not session.playlist_path.is_file():
            return 0.0
        segment_count = len(_playlist_segment_names(session.playlist_path))
        if segment_count <= 0:
            return 0.0
        return segment_count * HLS_SEGMENT_DURATION_SECONDS

    def _backpressure_thresholds(self) -> tuple[float, float, float, float]:
        video_config = getattr(self.app, "video_tools_config", None)
        low = float(getattr(video_config, "backpressure_low_water_seconds", 45.0) or 0.0)
        medium = float(getattr(video_config, "backpressure_medium_water_seconds", 120.0) or 0.0)
        high = float(getattr(video_config, "backpressure_high_water_seconds", 300.0) or 0.0)
        maximum = float(getattr(video_config, "backpressure_max_water_seconds", 600.0) or 0.0)
        low = max(0.0, low)
        medium = max(low, medium)
        high = max(medium, high)
        maximum = max(high, maximum)
        return low, medium, high, maximum

    def _backpressure_decision_for_session(
        self,
        session: VideoHlsSession,
        *,
        ahead_seconds: float | None,
    ) -> VideoInputThrottleDecision:
        if ahead_seconds is None:
            return VideoInputThrottleDecision(cancel=False, throttle_mode="unthrottled", ahead_seconds=None)
        low, medium, high, maximum = self._backpressure_thresholds()
        playback_state = str(session.reported_playback_state or "unknown").strip().casefold()
        paused = playback_state == "paused"
        if ahead_seconds < low:
            return VideoInputThrottleDecision(cancel=False, throttle_mode="unthrottled", ahead_seconds=ahead_seconds)
        if ahead_seconds >= maximum:
            return VideoInputThrottleDecision(
                cancel=False,
                sleep_seconds=VIDEO_BACKPRESSURE_PAUSE_SLEEP_SECONDS,
                throttle_mode="pause_input",
                ahead_seconds=ahead_seconds,
            )
        if ahead_seconds >= high:
            if paused:
                return VideoInputThrottleDecision(
                    cancel=False,
                    sleep_seconds=VIDEO_BACKPRESSURE_PAUSE_SLEEP_SECONDS,
                    throttle_mode="pause_input",
                    ahead_seconds=ahead_seconds,
                )
            return VideoInputThrottleDecision(
                cancel=False,
                sleep_seconds=VIDEO_BACKPRESSURE_HEAVY_SLEEP_SECONDS,
                throttle_mode="heavy_throttle",
                ahead_seconds=ahead_seconds,
            )
        if ahead_seconds >= medium:
            if paused:
                return VideoInputThrottleDecision(
                    cancel=False,
                    sleep_seconds=VIDEO_BACKPRESSURE_HEAVY_SLEEP_SECONDS,
                    throttle_mode="heavy_throttle",
                    ahead_seconds=ahead_seconds,
                )
            return VideoInputThrottleDecision(
                cancel=False,
                sleep_seconds=VIDEO_BACKPRESSURE_SLOW_SLEEP_SECONDS,
                throttle_mode="slow_background",
                ahead_seconds=ahead_seconds,
            )
        if paused:
            return VideoInputThrottleDecision(
                cancel=False,
                sleep_seconds=VIDEO_BACKPRESSURE_SLOW_SLEEP_SECONDS,
                throttle_mode="slow_background",
                ahead_seconds=ahead_seconds,
            )
        return VideoInputThrottleDecision(
            cancel=False,
            sleep_seconds=VIDEO_BACKPRESSURE_STEADY_SLEEP_SECONDS,
            throttle_mode="steady_background",
            ahead_seconds=ahead_seconds,
        )

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
            "client_id": session.client_id,
            "playlist_name": session.playlist_path.name,
            "playlist_url": "/video/endpoints/session/file?"
            + urlencode({"id": session.session_id, "name": session.playlist_path.name}),
            "asset_root": "/video/endpoints/session/file?id=" + session.session_id + "&name=",
            "audio_stream_index": session.audio_stream_index,
            "subtitle_stream_index": session.subtitle_stream_index,
            "start_time_seconds": session.start_time_seconds,
            "video_mode": session.video_mode,
            "video_mode_reason": session.video_mode_reason,
            "audio_mode": session.audio_mode,
            "audio_mode_reason": session.audio_mode_reason,
            "encoded_media_end_seconds": self._encoded_media_end_seconds(session),
            "hls_segment_duration_seconds": HLS_SEGMENT_DURATION_SECONDS,
            "session_create_elapsed_ms": ready_elapsed_ms,
            "ffmpeg_pid": getattr(session.process, "pid", None),
            "client_playback": self._session_playback_payload(session),
        }

    def _session_summary_payload(self, session: VideoHlsSession) -> dict[str, object]:
        payload = self._session_payload(session)
        payload["created_at"] = _format_video_timestamp(session.created_at)
        payload["created_at_unix_ms"] = int(round(session.created_at * 1000))
        payload["last_accessed_at"] = _format_video_timestamp(session.last_accessed_at)
        payload["last_accessed_at_unix_ms"] = int(round(session.last_accessed_at * 1000))
        payload["state"] = "active" if session.process.poll() is None else "stopped"
        return payload

    def _session_playback_payload(self, session: VideoHlsSession) -> dict[str, object]:
        updated_at = session.reported_playback_updated_at
        return {
            "reported_seconds": session.reported_playback_seconds,
            "media_seconds": session.reported_media_seconds,
            "state": session.reported_playback_state,
            "reported_at": _format_video_timestamp(updated_at),
            "reported_at_unix_ms": int(round(updated_at * 1000)) if updated_at is not None else None,
            "playback_sync_token": session.reported_playback_sync_token,
            "client_id": session.client_id,
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
                if self._get_session_locked(session.session_id) is not session:
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
        session_idle_ttl_seconds = self._session_idle_ttl_seconds()
        expired_ids = [
            session_id
            for session_id, session in self._sessions.items()
            if (time.time() - self._session_activity_at_locked(session)) > session_idle_ttl_seconds
        ]
        for session_id in expired_ids:
            self._remove_session_locked(session_id, reason="expired")

    def _session_idle_ttl_seconds(self) -> float:
        return float(
            getattr(getattr(self.app, "video_tools_config", None), "session_idle_ttl_seconds", HLS_SESSION_TTL_SECONDS)
            or HLS_SESSION_TTL_SECONDS
        )

    def _session_activity_at_locked(self, session: VideoHlsSession) -> float:
        activity_at = float(session.last_accessed_at or 0.0)
        playback_state = str(session.reported_playback_state or "unknown").strip().casefold()
        if playback_state in {"playing", "paused"} and session.reported_playback_updated_at is not None:
            activity_at = max(activity_at, float(session.reported_playback_updated_at))
        return activity_at

    def _session_is_recently_active_locked(self, session: VideoHlsSession, now: float | None = None) -> bool:
        # A finite HLS input can exit after producing its playlist while the
        # session remains registered until its idle cleanup/eviction pass. Its
        # last client progress must not keep an exited process counted as
        # active against the concurrent-session limit.
        if session.process.poll() is not None:
            return False
        playback_state = str(session.reported_playback_state or "unknown").strip().casefold()
        if playback_state not in {"playing", "paused"}:
            return False
        updated_at = session.reported_playback_updated_at
        if updated_at is None:
            return False
        if now is None:
            now = time.time()
        return (float(now) - float(updated_at)) <= self._session_idle_ttl_seconds()

    def _oldest_idle_session_locked(self) -> VideoHlsSession | None:
        if not self._sessions:
            return None
        now = time.time()
        idle_sessions = [
            session
            for session in self._sessions.values()
            if not self._session_is_recently_active_locked(session, now=now)
        ]
        if not idle_sessions:
            return None
        return min(
            idle_sessions,
            key=lambda item: (self._session_activity_at_locked(item), item.created_at),
        )

    def _active_session_locked(self) -> VideoHlsSession | None:
        if not self._sessions:
            self._active_session_id = None
            return None
        session = max(
            self._sessions.values(),
            key=lambda item: (self._session_activity_at_locked(item), item.created_at),
        )
        self._active_session_id = session.session_id
        return session

    def _get_session_locked(self, session_id: str | None) -> VideoHlsSession | None:
        normalized_session_id = str(session_id or "").strip()
        if not normalized_session_id:
            return None
        return self._sessions.get(normalized_session_id)

    def _remove_session_locked(self, session_id: str, reason: str = "removed") -> None:
        session = self._sessions.pop(session_id, None)
        if self._active_session_id == session_id:
            self._active_session_id = None
        if session is None:
            return
        self._session_lifecycle[session_id] = {
            "reason": reason,
            "removed_at": time.time(),
            "path": session.rel_path,
        }
        log_video_debug(self.app, "session_removed", session_id=session_id, reason=reason, path=session.rel_path)
        self._deferred_session_stops.append(session)

    def _drain_deferred_session_stops(self) -> None:
        with self._lock:
            sessions = self._deferred_session_stops
            self._deferred_session_stops = []
        for session in sessions:
            self._stop_session_resources(session)

    def _stop_session_resources(self, session: VideoHlsSession) -> None:
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

    def _session_summaries_locked(self, session_id: str | None = None) -> list[dict[str, object]]:
        if session_id is not None:
            session = self._get_session_locked(session_id)
            if session is None:
                return []
            return [self._session_summary_payload(session)]
        sessions = sorted(
            self._sessions.values(),
            key=lambda item: (self._session_activity_at_locked(item), item.created_at),
            reverse=True,
        )
        return [self._session_summary_payload(session) for session in sessions]

    def _session_state_for_missing_locked(self, session_id: str) -> str:
        lifecycle = self._session_lifecycle.get(session_id)
        if lifecycle is None:
            return "missing"
        reason = str(lifecycle.get("reason") or "missing").strip().casefold()
        if reason in {"stopped", "expired", "evicted"}:
            return reason
        return "missing"

    def _session_missing_payload_locked(self, session_id: str) -> dict[str, object]:
        session_state = self._session_state_for_missing_locked(session_id)
        return {
            "session_state": session_state,
            "session_state_message": self._session_state_message(session_state),
        }

    def _session_state_message(self, session_state: str) -> str:
        normalized_state = str(session_state or "missing").strip().casefold()
        if normalized_state == "stopped":
            return "Video session was stopped."
        if normalized_state == "expired":
            return "Video session expired after being idle."
        if normalized_state == "evicted":
            return "Video session was evicted to free server capacity."
        return "Video session was not found."


def _format_video_timestamp(timestamp: float | None) -> str | None:
    if timestamp is None:
        return None
    return time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(timestamp))


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
    """Recursive folder-cache library for the shared media-library client.

    Emits music-compatible ``folders`` / ``songs`` / ``items`` (items aliases
    songs) so video.js can host the shared library UI.
    """
    from .media_library import build_recursive_library_payload, video_file_enricher

    return build_recursive_library_payload(
        app,
        rel_path=rel_path,
        supported_extensions=SUPPORTED_VIDEO_EXTENSIONS,
        # Shared client treats media rows as song:* ids (music-compatible).
        id_prefix="song",
        include_songs_key=True,
        include_items_key=True,
        enrich_file=video_file_enricher(
            compatibility_expected_extensions=COMPATIBILITY_EXPECTED_EXTENSIONS,
        ),
        enrichment_mode="video",
    )


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


def header_probe_duration_unreliable(
    raw_payload: dict[str, object],
    *,
    file_size: int | None,
    header_bytes: int,
) -> bool:
    """Return True when a header-cache ffprobe duration looks stub-sized.

    AVI and similar formats often report a positive duration from a truncated
    prefix that is really size/bitrate of the stub, not the full remote file.
    """
    if file_size is None or file_size <= 0 or header_bytes <= 0:
        return False
    if file_size <= header_bytes:
        # Header cache already covers the whole object.
        return False
    format_data = raw_payload.get("format")
    if not isinstance(format_data, dict):
        return False
    duration = _duration_seconds(format_data)
    if duration is None or duration <= 0:
        return False
    streams = raw_payload.get("streams")
    if not isinstance(streams, list) or not streams:
        # Incomplete (no streams) is handled separately.
        return False

    stub_size_limit = max(float(header_bytes) * 1.25, 1.0)
    file_size_threshold = float(file_size) * 0.9

    reported_size: float | None = None
    raw_size = format_data.get("size")
    if raw_size not in (None, ""):
        try:
            reported_size = float(raw_size)
        except (TypeError, ValueError):
            reported_size = None
    if (
        reported_size is not None
        and reported_size > 0
        and reported_size <= stub_size_limit
        and reported_size < file_size_threshold
    ):
        return True

    bit_rate: float | None = None
    raw_bit_rate = format_data.get("bit_rate")
    if raw_bit_rate not in (None, ""):
        try:
            bit_rate = float(raw_bit_rate)
        except (TypeError, ValueError):
            bit_rate = None
    if bit_rate is not None and bit_rate > 0:
        implied_size = duration * bit_rate / 8.0
        if implied_size <= stub_size_limit and implied_size < file_size_threshold:
            return True
    return False


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
    header_bytes = _header_cache_bytes(app)
    used_header_input = header_input_url != file_input_url
    try:
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
    except BrowserError:
        if not used_header_input:
            raise
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
        used_header_input = False
    needs_full_file_probe = used_header_input and (
        probe_payload_is_incomplete(response_payload)
        or header_probe_duration_unreliable(
            raw_payload,
            file_size=file_size,
            header_bytes=header_bytes,
        )
    )
    if needs_full_file_probe:
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
        (
            row for row in subtitle_rows
            if isinstance(row, dict) and _stream_index_value(row.get("index")) == subtitle_stream_index
        ),
        None,
    )
    if track_info is None:
        raise BrowserError(HTTPStatus.BAD_REQUEST, "Subtitle track was not found in probe metadata.")
    if not subtitle_codec_supports_webvtt(track_info.get("codec_name")):
        _log_subtitle_conversion_debug(
            app,
            event="subtitle_track_rejected_for_webvtt",
            rel_path=rel_path,
            subtitle_stream_index=subtitle_stream_index,
            codec_name=track_info.get("codec_name"),
            reason="subtitle_track_cannot_be_converted_to_webvtt",
        )
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
        app=app,
        rel_path=rel_path,
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
    request_started_at = time.perf_counter()
    requested_window_status = str(window_status or "requested")
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
        (
            row for row in subtitle_rows
            if isinstance(row, dict) and _stream_index_value(row.get("index")) == subtitle_stream_index
        ),
        None,
    )
    if track_info is None:
        raise BrowserError(HTTPStatus.BAD_REQUEST, "Subtitle track was not found in probe metadata.")
    if not subtitle_codec_supports_webvtt(track_info.get("codec_name")):
        _log_subtitle_conversion_debug(
            app,
            event="subtitle_track_rejected_for_webvtt",
            rel_path=rel_path,
            subtitle_stream_index=subtitle_stream_index,
            codec_name=track_info.get("codec_name"),
            reason="subtitle_track_cannot_be_converted_to_webvtt",
        )
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
    clean_path = clean_rel_path(rel_path)
    if cached_window_body is not None:
        cached_window_text = cached_window_body.decode("utf-8", "replace")
        coverage_ranges = manifest.get("coverage_ranges", [])
        return_payload = _subtitle_window_payload(
            rel_path=clean_path,
            subtitle_stream_index=subtitle_stream_index,
            file_size=file_size,
            language=language,
            window_request=window_request,
            media_duration_seconds=media_duration_seconds,
            coverage_ranges=coverage_ranges,
            vtt_text=cached_window_text,
            cache_hit=True,
        )
        backfill_scheduled = _maybe_schedule_subtitle_window_backfill(
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
        _log_subtitle_window_request(
            app,
            rel_path=clean_path,
            subtitle_stream_index=subtitle_stream_index,
            requested_window_status=requested_window_status,
            window_request=window_request,
            cache_hit=True,
            inflight_waited=False,
            request_started_at=request_started_at,
            response_payload=return_payload,
            background_backfill_scheduled=backfill_scheduled,
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
        # A concurrent request can observe the cached VTT body before the owner
        # has finished writing the updated coverage manifest. If the window is
        # not yet covered and an inflight extraction still exists, wait for it
        # to finish so cache-hit callers see the finalized manifest.
        coverage_ranges = manifest.get("coverage_ranges", [])
        if not subtitle_window_is_covered(
            coverage_ranges,
            window_start_seconds=float(window_request["window_start_seconds"]),
            window_end_seconds=float(window_request["window_end_seconds"]),
        ):
            inflight_entry = _peek_subtitle_window_inflight(app, cached_window_key)
            event = inflight_entry.get("event") if isinstance(inflight_entry, dict) else None
            if isinstance(event, _THREAD_EVENT_TYPE):
                event.wait()
                cached_window_body = _read_subtitle_cache(app, cached_window_key)
                manifest = read_subtitle_window_manifest(
                    app,
                    rel_path=rel_path,
                    subtitle_stream_index=subtitle_stream_index,
                    file_size=file_size,
                )
        cached_window_text = cached_window_body.decode("utf-8", "replace")
        coverage_ranges = manifest.get("coverage_ranges", [])
        return_payload = _subtitle_window_payload(
            rel_path=clean_path,
            subtitle_stream_index=subtitle_stream_index,
            file_size=file_size,
            language=language,
            window_request=window_request,
            media_duration_seconds=media_duration_seconds,
            coverage_ranges=coverage_ranges,
            vtt_text=cached_window_text,
            cache_hit=True,
        )
        backfill_scheduled = _maybe_schedule_subtitle_window_backfill(
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
        _log_subtitle_window_request(
            app,
            rel_path=clean_path,
            subtitle_stream_index=subtitle_stream_index,
            requested_window_status=requested_window_status,
            window_request=window_request,
            cache_hit=True,
            inflight_waited=True,
            request_started_at=request_started_at,
            response_payload=return_payload,
            background_backfill_scheduled=backfill_scheduled,
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
            app=app,
            rel_path=rel_path,
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
        response_payload = _subtitle_window_payload(
            rel_path=clean_path,
            subtitle_stream_index=subtitle_stream_index,
            file_size=file_size,
            language=language,
            window_request=window_request,
            media_duration_seconds=media_duration_seconds,
            coverage_ranges=manifest.get("coverage_ranges", []),
            vtt_text=windowed_text,
            cache_hit=False,
        )
        backfill_scheduled = _maybe_schedule_subtitle_window_backfill(
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
        _log_subtitle_window_request(
            app,
            rel_path=clean_path,
            subtitle_stream_index=subtitle_stream_index,
            requested_window_status=requested_window_status,
            window_request=window_request,
            cache_hit=False,
            inflight_waited=False,
            request_started_at=request_started_at,
            response_payload=response_payload,
            background_backfill_scheduled=backfill_scheduled,
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
) -> bool:
    if str(window_status or "").strip().casefold() != "startup":
        return False
    next_window_start_seconds = float(response_payload.get("window_end_seconds") or 0.0)
    if media_duration_seconds is not None and next_window_start_seconds >= media_duration_seconds:
        return False
    coverage_ranges = response_payload.get("loaded_ranges")
    if (
        isinstance(coverage_ranges, list)
        and subtitle_window_is_covered(
            coverage_ranges,
            window_start_seconds=next_window_start_seconds,
            window_end_seconds=next_window_start_seconds + float(window_request["window_duration_seconds"]),
        )
    ):
        return False
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
            return False
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
    log_video_debug(
        app,
        "subtitle_window_backfill_scheduled",
        rel_path=clean_rel_path(rel_path),
        subtitle_stream_index=int(subtitle_stream_index),
        next_window_start_seconds=next_window_start_seconds,
        window_duration_seconds=float(window_request["window_duration_seconds"]),
        playback_sync_token=(
            int(window_request["playback_sync_token"])
            if window_request.get("playback_sync_token") is not None
            else None
        ),
    )
    thread.start()
    return True


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
    *,
    app: Any | None = None,
    rel_path: str = "",
    subtitle_stream_index: int | None = None,
    codec_name: object = None,
    start_time_seconds: float = 0.0,
    duration_seconds: float | None = None,
) -> bytes:
    suffix = subtitle_path.suffix.casefold()
    raw_body = subtitle_path.read_bytes()
    if raw_body.lstrip().startswith(b"WEBVTT"):
        _log_subtitle_conversion_debug(
            app,
            event="subtitle_conversion_debug",
            rel_path=rel_path,
            subtitle_stream_index=subtitle_stream_index,
            codec_name=codec_name,
            subtitle_path=subtitle_path,
            conversion_mode="webvtt_passthrough",
            start_time_seconds=start_time_seconds,
            duration_seconds=duration_seconds,
            raw_subtitle_text=raw_body.decode("utf-8", "replace"),
            converted_webvtt_text=raw_body.decode("utf-8", "replace"),
        )
        return raw_body
    if suffix == ".vtt":
        _log_subtitle_conversion_debug(
            app,
            event="subtitle_conversion_debug",
            rel_path=rel_path,
            subtitle_stream_index=subtitle_stream_index,
            codec_name=codec_name,
            subtitle_path=subtitle_path,
            conversion_mode="vtt_suffix_passthrough",
            start_time_seconds=start_time_seconds,
            duration_seconds=duration_seconds,
            raw_subtitle_text=raw_body.decode("utf-8", "replace"),
            converted_webvtt_text=raw_body.decode("utf-8", "replace"),
        )
        return raw_body
    if suffix in {".ass", ".ssa"}:
        converted = convert_ass_text_to_webvtt(raw_body.decode("utf-8", "replace"))
        _log_subtitle_conversion_debug(
            app,
            event="subtitle_conversion_debug",
            rel_path=rel_path,
            subtitle_stream_index=subtitle_stream_index,
            codec_name=codec_name,
            subtitle_path=subtitle_path,
            conversion_mode="ass_parser",
            start_time_seconds=start_time_seconds,
            duration_seconds=duration_seconds,
            raw_subtitle_text=raw_body.decode("utf-8", "replace"),
            converted_webvtt_text=converted.decode("utf-8", "replace"),
        )
        return converted
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
    converted = _run_subprocess_capture(
        command,
        not_found_message="ffmpeg was not found",
        failure_message="ffmpeg failed to convert subtitles to WebVTT.",
    )
    _log_subtitle_conversion_debug(
        app,
        event="subtitle_conversion_debug",
        rel_path=rel_path,
        subtitle_stream_index=subtitle_stream_index,
        codec_name=codec_name,
        subtitle_path=subtitle_path,
        conversion_mode="ffmpeg_text_to_webvtt",
        start_time_seconds=start_time_seconds,
        duration_seconds=duration_seconds,
        raw_subtitle_text=raw_body.decode("utf-8", "replace"),
        converted_webvtt_text=converted.decode("utf-8", "replace"),
    )
    return converted


def _extract_subtitle_via_copy_then_convert(
    ffmpeg_exe: Path,
    input_url: str,
    subtitle_stream_index: int,
    codec_name: object,
    *,
    app: Any | None = None,
    rel_path: str = "",
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
        return _convert_subtitle_file_to_webvtt(
            ffmpeg_exe,
            temp_path,
            app=app,
            rel_path=rel_path,
            subtitle_stream_index=subtitle_stream_index,
            codec_name=codec_name,
            start_time_seconds=start_time_seconds,
            duration_seconds=duration_seconds,
        )
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
    app: Any | None = None,
    rel_path: str = "",
    codec_name: object = None,
    start_time_seconds: float = 0.0,
    duration_seconds: float | None = None,
) -> bytes | None:
    copied_body = _extract_subtitle_via_copy_then_convert(
        ffmpeg_exe,
        input_url,
        subtitle_stream_index,
        codec_name,
        app=app,
        rel_path=rel_path,
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
    _log_subtitle_conversion_debug(
        app,
        event="subtitle_conversion_debug",
        rel_path=rel_path,
        subtitle_stream_index=subtitle_stream_index,
        codec_name=codec_name,
        conversion_mode="ffmpeg_direct_webvtt",
        start_time_seconds=start_time_seconds,
        duration_seconds=duration_seconds,
        converted_webvtt_text=proc.stdout.decode("utf-8", "replace"),
    )
    return proc.stdout


def _run_ffmpeg_batch_webvtt(
    ffmpeg_exe: Path,
    input_url: str,
    missing_rows: list[dict[str, object]],
    *,
    app: Any | None = None,
    rel_path: str = "",
) -> dict[int, bytes] | None:
    if not missing_rows:
        return {}
    temp_paths: list[Path] = []
    missing_indices: list[int] = []
    copyable_rows: list[dict[str, object]] = []
    try:
        for row in missing_rows:
            subtitle_stream_index = _stream_index_value(row.get("index"))
            if subtitle_stream_index is None:
                return None
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
            subtitle_stream_index = _stream_index_value(row.get("index"))
            if subtitle_stream_index is None:
                return None
            try:
                body = _convert_subtitle_file_to_webvtt(
                    ffmpeg_exe,
                    temp_path,
                    app=app,
                    rel_path=rel_path,
                    subtitle_stream_index=subtitle_stream_index,
                    codec_name=row.get("codec_name"),
                )
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
        subtitle_stream_index = _stream_index_value(row.get("index"))
        if subtitle_stream_index is None or subtitle_stream_index < 0:
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
            app=app,
            rel_path=rel_path,
        )
        if batch_results is None:
            log_video_debug(
                app,
                "subtitle_batch_extract_failed",
                rel_path=rel_path,
                track_count=len(missing_rows),
            )
            for row in missing_rows:
                subtitle_stream_index = _stream_index_value(row.get("index"))
                if subtitle_stream_index is None:
                    continue
                body = _run_ffmpeg_single_webvtt(
                    ffmpeg_exe,
                    input_url,
                    subtitle_stream_index,
                    app=app,
                    rel_path=rel_path,
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
                subtitle_stream_index = _stream_index_value(row.get("index"))
                if subtitle_stream_index is None:
                    continue
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
        status_session_id = params.get("id", [""])[0]
        session_status = video_session_manager(app).session_status_payload(status_session_id or None)
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
            "backpressure_thresholds": {
                "low_water_seconds": float(getattr(video_config, "backpressure_low_water_seconds", 45.0) or 0.0),
                "medium_water_seconds": float(getattr(video_config, "backpressure_medium_water_seconds", 120.0) or 0.0),
                "high_water_seconds": float(getattr(video_config, "backpressure_high_water_seconds", 300.0) or 0.0),
                "max_water_seconds": float(getattr(video_config, "backpressure_max_water_seconds", 600.0) or 0.0),
            },
            "max_session_count": int(getattr(video_config, "max_concurrent_sessions", 8) or 8),
            "active_session": session_status["active_session"],
            "active_sessions": session_status["active_sessions"],
            "session_count": session_status["session_count"],
        }

    raise BrowserError(HTTPStatus.NOT_FOUND, "Video endpoint not found.")
