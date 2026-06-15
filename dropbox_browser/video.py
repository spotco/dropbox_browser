"""Video player endpoint helpers."""
from __future__ import annotations

import json
import math
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

from .config import TEMP_DIR
from .errors import BrowserError
from .namekeys import filename_compare_key
from .paths import clean_rel_path, remote_target


VIDEO_ENDPOINT_PREFIX = "/video/endpoints/"
SUPPORTED_VIDEO_EXTENSIONS = (".mkv", ".mp4", ".m4v", ".webm", ".mov", ".avi", ".ts", ".m2ts", ".wmv")
COMPATIBILITY_EXPECTED_EXTENSIONS = (".mkv", ".avi", ".ts", ".m2ts", ".wmv")
VIDEO_SESSION_DIR = TEMP_DIR / "video_sessions"
HLS_PLAYLIST_NAME = "stream.m3u8"
HLS_SEGMENT_PATTERN = "segment_%05d.m4s"
HLS_INIT_SEGMENT_NAME = "init.mp4"
HLS_SESSION_TTL_SECONDS = 15 * 60
HLS_READY_TIMEOUT_SECONDS = 10.0
HLS_ASSET_READY_TIMEOUT_SECONDS = 8.0
VIDEO_DEBUG_LOG_PATH = TEMP_DIR / "video_debug.jsonl"
_VIDEO_DEBUG_LOG_LOCK = threading.Lock()


def log_video_debug(app: Any, event: str, **fields: object) -> None:
    if not bool(getattr(app, "video_debug_logs", True)):
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


def _subtitle_stream(stream_data: dict[str, object]) -> dict[str, object]:
    result = _base_stream(stream_data)
    result.update({
        "codec_tag_string": stream_data.get("codec_tag_string"),
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
        if stream.get("default"):
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


def build_ffprobe_command(ffprobe_exe: Path, input_url: str) -> list[str]:
    return [
        str(ffprobe_exe),
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        input_url,
    ]


def build_ffmpeg_webvtt_command(
    ffmpeg_exe: Path,
    input_url: str,
    subtitle_stream_index: int,
    *,
    start_time_seconds: float = 0.0,
) -> list[str]:
    command = [
        str(ffmpeg_exe),
        "-v",
        "error",
    ]
    if start_time_seconds > 0:
        command.extend(["-ss", _format_ffmpeg_seconds(start_time_seconds)])
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


def build_ffmpeg_hls_command(
    ffmpeg_exe: Path,
    input_url: str,
    playlist_path: Path,
    *,
    segment_base_url: str,
    audio_stream_index: int | None = None,
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
        "-map",
        "0:v:0",
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
        "veryfast",
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
    last_accessed_at: float
    audio_stream_index: int | None
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
        start_time_seconds: float = 0.0,
    ) -> dict[str, object]:
        video_config = getattr(self.app, "video_tools_config", None)
        ffmpeg_exe = getattr(video_config, "ffmpeg_exe", None)
        if ffmpeg_exe is None:
            raise BrowserError(HTTPStatus.SERVICE_UNAVAILABLE, "ffmpeg is not available.")

        input_url = base_url + "/file?" + urlencode({"path": rel_path, "source": "remote"})
        session_id = uuid.uuid4().hex
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
            start_time_seconds=start_time_seconds,
        )
        log_video_debug(
            self.app,
            "session_create_start",
            session_id=session_id,
            path=rel_path,
            audio_stream_index=audio_stream_index,
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
            last_accessed_at=time.time(),
            audio_stream_index=audio_stream_index,
            start_time_seconds=start_time_seconds,
        )
        with self._lock:
            self._cleanup_expired_locked()
            self._clear_active_locked()
            self._active_session = session
        if not self._wait_for_playlist(session):
            with self._lock:
                if self._active_session is session:
                    self._clear_active_locked()
            log_video_debug(self.app, "session_create_timeout", session_id=session_id, path=rel_path)
            raise BrowserError(HTTPStatus.BAD_GATEWAY, "ffmpeg did not produce an HLS playlist in time.")
        log_video_debug(
            self.app,
            "session_create_ready",
            session_id=session_id,
            path=rel_path,
            playlist_bytes=session.playlist_path.stat().st_size if session.playlist_path.exists() else 0,
        )
        return self._session_payload(session)

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

    def _session_payload(self, session: VideoHlsSession) -> dict[str, object]:
        return {
            "status": "ok",
            "session_id": session.session_id,
            "path": session.rel_path,
            "playlist_name": session.playlist_path.name,
            "playlist_url": "/video/endpoints/session/file?"
            + urlencode({"id": session.session_id, "name": session.playlist_path.name}),
            "asset_root": "/video/endpoints/session/file?id=" + session.session_id + "&name=",
            "audio_stream_index": session.audio_stream_index,
            "start_time_seconds": session.start_time_seconds,
        }

    def _wait_for_playlist(self, session: VideoHlsSession, timeout_seconds: float = HLS_READY_TIMEOUT_SECONDS) -> bool:
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            ready_segment = _first_ready_playlist_segment(session.playlist_path)
            if (
                ready_segment is not None
                and (session.session_dir / HLS_INIT_SEGMENT_NAME).is_file()
                and (session.session_dir / ready_segment).is_file()
            ):
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

    def _wait_for_asset(
        self,
        session: VideoHlsSession,
        asset_path: Path,
        timeout_seconds: float = HLS_ASSET_READY_TIMEOUT_SECONDS,
    ) -> bool:
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            with self._lock:
                if self._active_session is not session:
                    return False
            if asset_path.is_file():
                return True
            if session.process.poll() is not None:
                log_video_debug(
                    self.app,
                    "asset_wait_process_exited",
                    session_id=session.session_id,
                    name=asset_path.name,
                    returncode=session.process.poll(),
                )
                return asset_path.is_file()
            time.sleep(0.05)
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


def _first_ready_playlist_segment(playlist_path: Path) -> str | None:
    try:
        text = playlist_path.read_text(encoding="utf-8")
    except OSError:
        return None
    for line in text.splitlines():
        value = line.strip()
        if not value or value.startswith("#"):
            continue
        asset_name = _playlist_segment_asset_name(value)
        if asset_name is not None:
            return asset_name
    return None


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


def probe_remote_media(app: Any, *, rel_path: str, base_url: str) -> dict[str, object]:
    video_config = getattr(app, "video_tools_config", None)
    ffprobe_exe = getattr(video_config, "ffprobe_exe", None)
    if ffprobe_exe is None:
        raise BrowserError(HTTPStatus.SERVICE_UNAVAILABLE, "ffprobe is not available.")
    input_url = base_url + "/file?" + urlencode({"path": rel_path, "source": "remote"})
    cmd = build_ffprobe_command(ffprobe_exe, input_url)
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
        payload = json.loads(proc.stdout.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise BrowserError(HTTPStatus.BAD_GATEWAY, "ffprobe returned invalid JSON.") from exc
    streams = payload.get("streams")
    if not isinstance(streams, list):
        streams = []
    format_data = payload.get("format")
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


def extract_remote_subtitles_to_webvtt(
    app: Any,
    *,
    rel_path: str,
    subtitle_stream_index: int,
    base_url: str,
    start_time_seconds: float = 0.0,
) -> tuple[bytes, str]:
    video_config = getattr(app, "video_tools_config", None)
    ffmpeg_exe = getattr(video_config, "ffmpeg_exe", None)
    ffprobe_exe = getattr(video_config, "ffprobe_exe", None)
    if ffmpeg_exe is None:
        raise BrowserError(HTTPStatus.SERVICE_UNAVAILABLE, "ffmpeg is not available.")
    if ffprobe_exe is None:
        raise BrowserError(HTTPStatus.SERVICE_UNAVAILABLE, "ffprobe is not available.")
    probe_payload = probe_remote_media(app, rel_path=rel_path, base_url=base_url)
    subtitle_streams = probe_payload.get("subtitle_streams") if isinstance(probe_payload, dict) else None
    subtitle_rows = subtitle_streams if isinstance(subtitle_streams, list) else []
    track_info = next(
        (row for row in subtitle_rows if isinstance(row, dict) and int(row.get("index") or -1) == subtitle_stream_index),
        None,
    )
    if track_info is None:
        raise BrowserError(HTTPStatus.BAD_REQUEST, "Subtitle track was not found in probe metadata.")
    input_url = base_url + "/file?" + urlencode({"path": rel_path, "source": "remote"})
    command = build_ffmpeg_webvtt_command(
        ffmpeg_exe,
        input_url,
        subtitle_stream_index,
        start_time_seconds=start_time_seconds,
    )
    try:
        proc = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=30,
        )
    except FileNotFoundError as exc:
        raise BrowserError(HTTPStatus.SERVICE_UNAVAILABLE, f"ffmpeg was not found: {exc}") from exc
    except subprocess.TimeoutExpired as exc:
        raise BrowserError(HTTPStatus.BAD_GATEWAY, "ffmpeg timed out while converting subtitles.") from exc
    if proc.returncode != 0:
        message = proc.stderr.decode("utf-8", "replace").strip() or "ffmpeg failed to convert subtitles to WebVTT."
        raise BrowserError(HTTPStatus.BAD_GATEWAY, message)
    return proc.stdout, str(track_info.get("language") or "")


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
