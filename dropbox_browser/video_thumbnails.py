from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from http import HTTPStatus
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tempfile
import threading
from typing import Any

from .config import TEMP_DIR, VideoToolsConfig
from .errors import BrowserError
from .paths import clean_rel_path, remote_target, safe_join_local
from .rclone import RcloneClient
from .windows_names import resolve_matching_local_path
from . import workertrace


VIDEO_THUMBNAIL_EXTENSIONS = frozenset({
    ".avi", ".m2ts", ".m4v", ".mkv", ".mov", ".mp4", ".ts", ".webm", ".wmv",
})
VIDEO_THUMBNAIL_OUTPUT_FORMAT = "jpeg"
VIDEO_THUMBNAILER_VERSION = "ffmpeg-v3-jpeg-pixfmt-end-fallback"
VIDEO_THUMBNAIL_FRAME_SECONDS = 1.0
# A frame a small distance before EOF is available even for sub-second media.
# This is used only after the ordinary one-second seek produces no frame.
VIDEO_THUMBNAIL_END_SEEK_SECONDS = 0.05


@dataclass(frozen=True)
class VideoThumbnailDescriptor:
    source: str
    rel_path: str
    local_path: Path | None
    size_bytes: int | None
    modified_time: float | None
    thumbnail_size: int
    output_format: str
    thumbnailer_version: str
    cache_key: str
    cache_path: Path


@dataclass(frozen=True)
class VideoThumbnailResult:
    status: str
    descriptor: VideoThumbnailDescriptor | None
    path: Path | None
    cache_hit: bool
    error_message: str | None = None

    @property
    def ok(self) -> bool:
        return self.path is not None and self.status in {"ready", "generated"}


def is_video_thumbnailable(path: str, is_dir: bool = False) -> bool:
    if is_dir:
        return False
    return PurePosixPath(path or "").suffix.casefold() in VIDEO_THUMBNAIL_EXTENSIONS


def video_thumbnail_source_for_row(row: dict[str, Any], status_label: str | None = None) -> str | None:
    if bool(row.get("is_dir")):
        return None
    status = status_label or str(row.get("status_label") or "")
    has_remote = bool(row.get("remote"))
    has_local = bool(row.get("local"))
    if has_remote and has_local and status == "Has Diffs":
        return "local"
    if has_remote:
        return "remote"
    if has_local:
        return "local"
    return None


def build_video_thumbnail_cache_key(
    *,
    source: str,
    rel_path: str,
    size_bytes: int | None,
    modified_time: float | None,
    thumbnail_size: int,
    output_format: str = VIDEO_THUMBNAIL_OUTPUT_FORMAT,
    thumbnailer_version: str = VIDEO_THUMBNAILER_VERSION,
) -> str:
    payload = {
        "frame_seconds": VIDEO_THUMBNAIL_FRAME_SECONDS,
        "modified_time": None if modified_time is None else round(float(modified_time), 6),
        "output_format": str(output_format).casefold(),
        "rel_path": clean_rel_path(rel_path),
        "size_bytes": None if size_bytes is None else int(size_bytes),
        "source": str(source),
        "thumbnail_size": int(thumbnail_size),
        "thumbnailer_version": str(thumbnailer_version),
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _modified_time(value: object) -> float | None:
    if value is None:
        return None
    try:
        text = str(value).strip()
        if not text:
            return None
        return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError, OverflowError):
        return None


class VideoThumbnailService:
    def __init__(
        self,
        rclone: RcloneClient,
        remote: str,
        local_root: Path | None,
        video_tools_config: VideoToolsConfig,
        *,
        cache_dir: Path,
    ) -> None:
        self.rclone = rclone
        self.remote = remote
        self.local_root = local_root.resolve() if local_root else None
        self.video_tools_config = video_tools_config
        self.cache_dir = cache_dir
        self._inflight_guard = threading.Lock()
        self._inflight: dict[str, dict[str, Any]] = {}

    def descriptor_for_path(self, rel_path: str, source: str) -> VideoThumbnailDescriptor | None:
        normalized = clean_rel_path(rel_path)
        if not is_video_thumbnailable(normalized):
            workertrace.append("video_thumbnail_unsupported_format", rel_path=normalized, source=source)
            return None
        if source == "local":
            return self._local_descriptor(normalized)
        if source == "remote":
            return self._remote_descriptor(normalized)
        raise BrowserError(HTTPStatus.BAD_REQUEST, "Unsupported video thumbnail source.")

    def ensure_thumbnail(
        self,
        descriptor: VideoThumbnailDescriptor | None,
        *,
        remote_input_url: str | None = None,
    ) -> VideoThumbnailResult:
        if descriptor is None:
            return VideoThumbnailResult("unsupported", None, None, False)
        if descriptor.cache_path.exists():
            self._trace("video_thumbnail_cache_hit", descriptor)
            return VideoThumbnailResult("ready", descriptor, descriptor.cache_path, True)
        if not self.video_tools_config.video_thumbnail_enabled or self.video_tools_config.ffmpeg_exe is None:
            return VideoThumbnailResult("disabled", descriptor, None, False, "ffmpeg video thumbnails are unavailable.")
        max_input = int(self.video_tools_config.video_thumbnail_max_input_bytes or 0)
        if max_input > 0 and descriptor.size_bytes is not None and descriptor.size_bytes > max_input:
            self._trace("video_thumbnail_oversized_input", descriptor)
            return VideoThumbnailResult("oversized", descriptor, None, False, "Input exceeds video thumbnail size limit.")
        with self._inflight_guard:
            state = self._inflight.get(descriptor.cache_key)
            if state is None:
                state = {"event": threading.Event(), "result": None}
                self._inflight[descriptor.cache_key] = state
                owner = True
            else:
                owner = False
        if not owner:
            state["event"].wait()
            result = state.get("result")
            return result if isinstance(result, VideoThumbnailResult) else VideoThumbnailResult(
                "failed", descriptor, None, False, "Video thumbnail generation failed."
            )
        try:
            result = self._generate(descriptor, remote_input_url=remote_input_url)
            state["result"] = result
            return result
        finally:
            state["event"].set()
            with self._inflight_guard:
                self._inflight.pop(descriptor.cache_key, None)

    def _local_descriptor(self, rel_path: str) -> VideoThumbnailDescriptor | None:
        if self.local_root is None:
            return None
        safe_join_local(self.local_root, rel_path)
        local_path = resolve_matching_local_path(self.local_root, rel_path)
        if not local_path.exists() or not local_path.is_file():
            return None
        stat = local_path.stat()
        return self._descriptor("local", rel_path, local_path, stat.st_size, stat.st_mtime)

    def _remote_descriptor(self, rel_path: str) -> VideoThumbnailDescriptor | None:
        stat = self.rclone.stat(remote_target(self.remote, rel_path))
        if bool(stat.get("IsDir")):
            return None
        name = str(stat.get("Name") or stat.get("Path") or rel_path)
        if not is_video_thumbnailable(name):
            return None
        return self._descriptor("remote", rel_path, None, stat.get("Size"), _modified_time(stat.get("ModTime")))

    def _descriptor(
        self,
        source: str,
        rel_path: str,
        local_path: Path | None,
        size_bytes: int | None,
        modified_time: float | None,
    ) -> VideoThumbnailDescriptor:
        size = max(16, int(self.video_tools_config.video_thumbnail_size or 256))
        key = build_video_thumbnail_cache_key(
            source=source,
            rel_path=rel_path,
            size_bytes=size_bytes,
            modified_time=modified_time,
            thumbnail_size=size,
        )
        return VideoThumbnailDescriptor(
            source=source,
            rel_path=clean_rel_path(rel_path),
            local_path=local_path,
            size_bytes=None if size_bytes is None else int(size_bytes),
            modified_time=modified_time,
            thumbnail_size=size,
            output_format=VIDEO_THUMBNAIL_OUTPUT_FORMAT,
            thumbnailer_version=VIDEO_THUMBNAILER_VERSION,
            cache_key=key,
            cache_path=self.cache_dir / "video" / key[:2] / key[2:4] / f"{key}.jpg",
        )

    def _generate(self, descriptor: VideoThumbnailDescriptor, *, remote_input_url: str | None) -> VideoThumbnailResult:
        if descriptor.source == "local":
            input_path = str(descriptor.local_path) if descriptor.local_path else ""
        else:
            input_path = str(remote_input_url or "")
        if not input_path:
            return VideoThumbnailResult("failed", descriptor, None, False, "Video thumbnail input is unavailable.")
        TEMP_DIR.mkdir(parents=True, exist_ok=True)
        output_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(dir=TEMP_DIR, prefix="video-thumbnail-out-", suffix=".jpg", delete=False) as handle:
                output_path = Path(handle.name)
            scale = int(descriptor.thumbnail_size)
            vf = f"scale={scale}:{scale}:force_original_aspect_ratio=decrease,pad={scale}:{scale}:(ow-iw)/2:(oh-ih)/2:color=black"
            def build_command(seek_args: list[str]) -> list[str]:
                return [
                    str(self.video_tools_config.ffmpeg_exe),
                    "-hide_banner", "-loglevel", "error", "-y",
                    *seek_args,
                    "-i", input_path,
                    "-map", "0:v:0",
                    "-frames:v", "1",
                    "-vf", vf,
                    "-an", "-c:v", "mjpeg", "-pix_fmt", "yuvj420p", "-q:v", "4",
                    str(output_path),
                ]

            def has_output(process: subprocess.CompletedProcess[bytes]) -> bool:
                return process.returncode == 0 and output_path is not None and output_path.exists() and output_path.stat().st_size > 0

            timeout = float(self.video_tools_config.video_thumbnail_timeout_seconds)
            command = build_command(["-ss", str(VIDEO_THUMBNAIL_FRAME_SECONDS)])
            proc = subprocess.run(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
                timeout=timeout,
            )
            if not has_output(proc):
                initial_error = proc.stderr.decode("utf-8", "replace").strip()
                fallback_command = build_command(["-sseof", f"-{VIDEO_THUMBNAIL_END_SEEK_SECONDS:g}"])
                fallback_proc = subprocess.run(
                    fallback_command,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    check=False,
                    timeout=timeout,
                )
                if has_output(fallback_proc):
                    self._trace(
                        "video_thumbnail_end_fallback",
                        descriptor,
                        seek_seconds=VIDEO_THUMBNAIL_END_SEEK_SECONDS,
                    )
                    proc = fallback_proc
                else:
                    error = (
                        fallback_proc.stderr.decode("utf-8", "replace").strip()
                        or initial_error
                        or "FFmpeg did not produce a video thumbnail."
                    )
                    self._trace("video_thumbnail_generation_failure", descriptor, error_message=error)
                    return VideoThumbnailResult("failed", descriptor, None, False, error)
            if not has_output(proc):
                error = proc.stderr.decode("utf-8", "replace").strip() or "FFmpeg did not produce a video thumbnail."
                self._trace("video_thumbnail_generation_failure", descriptor, error_message=error)
                return VideoThumbnailResult("failed", descriptor, None, False, error)
            descriptor.cache_path.parent.mkdir(parents=True, exist_ok=True)
            cache_temp: Path | None = None
            try:
                with tempfile.NamedTemporaryFile(
                    dir=descriptor.cache_path.parent,
                    prefix="video-thumbnail-cache-",
                    suffix=".jpg",
                    delete=False,
                ) as cache_handle:
                    cache_temp = Path(cache_handle.name)
                shutil.copyfile(output_path, cache_temp)
                cache_temp.replace(descriptor.cache_path)
            finally:
                if cache_temp is not None:
                    cache_temp.unlink(missing_ok=True)
            self._trace("video_thumbnail_generation_success", descriptor)
            return VideoThumbnailResult("generated", descriptor, descriptor.cache_path, False)
        except subprocess.TimeoutExpired:
            self._trace("video_thumbnail_generation_timeout", descriptor)
            return VideoThumbnailResult("timeout", descriptor, None, False, "Video thumbnail generation timed out.")
        except FileNotFoundError as exc:
            return VideoThumbnailResult("disabled", descriptor, None, False, str(exc))
        finally:
            if output_path is not None:
                try:
                    output_path.unlink(missing_ok=True)
                except OSError:
                    pass

    def _trace(self, event: str, descriptor: VideoThumbnailDescriptor, **fields: Any) -> None:
        workertrace.append(event, rel_path=descriptor.rel_path, source=descriptor.source, cache_key=descriptor.cache_key, **fields)
