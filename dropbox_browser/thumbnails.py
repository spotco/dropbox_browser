from __future__ import annotations

from dataclasses import dataclass
from http import HTTPStatus
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tempfile
import threading
import time
from typing import Any

from .config import TEMP_DIR, THUMBNAIL_CACHE_DIR, ThumbnailConfig
from .errors import BrowserError
from .paths import child_remote_path, clean_rel_path, remote_target, safe_join_local
from .rclone import RcloneClient
from .windows_names import resolve_matching_local_path
from . import workertrace


# Keep this extension set aligned with
# dropbox_browser/assets/js/browse/image-hover-preview.js.
THUMBNAILABLE_IMAGE_EXTENSIONS = frozenset({
    ".apng",
    ".avif",
    ".bmp",
    ".gif",
    ".ico",
    ".jpeg",
    ".jpg",
    ".png",
    ".svg",
    ".webp",
})

THUMBNAIL_OUTPUT_FORMAT = "png"
THUMBNAILER_VERSION = "imagick-v1"
_IMAGE_MAGICK_INPUT_PREFIX = "thumbnail-src-"
_IMAGE_MAGICK_OUTPUT_PREFIX = "thumbnail-out-"
_IMAGE_MAGICK_OUTPUT_SUFFIX = ".png"
_ATOMIC_REPLACE_RETRIES = 8
_ATOMIC_REPLACE_RETRY_DELAY_SECONDS = 0.02


@dataclass(frozen=True)
class ThumbnailDescriptor:
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
class ThumbnailResult:
    status: str
    descriptor: ThumbnailDescriptor | None
    path: Path | None
    cache_hit: bool
    error_message: str | None = None

    @property
    def ok(self) -> bool:
        return self.path is not None and self.status in {"ready", "generated"}


def thumbnailable_image_extension(path: str) -> str:
    return PurePosixPath(path or "").suffix.lower()


def is_thumbnailable_image(path: str, is_dir: bool) -> bool:
    if is_dir:
        return False
    return thumbnailable_image_extension(path) in THUMBNAILABLE_IMAGE_EXTENSIONS


def thumbnail_source_for_row(row: dict[str, Any], status_label: str | None = None) -> str | None:
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


def build_thumbnail_cache_key(
    *,
    source: str,
    rel_path: str,
    size_bytes: int | None,
    modified_time: float | None,
    thumbnail_size: int,
    output_format: str = THUMBNAIL_OUTPUT_FORMAT,
    thumbnailer_version: str = THUMBNAILER_VERSION,
) -> str:
    normalized_rel_path = clean_rel_path(rel_path)
    payload = {
        "modified_time": None if modified_time is None else round(float(modified_time), 6),
        "output_format": str(output_format).lower(),
        "rel_path": normalized_rel_path,
        "size_bytes": None if size_bytes is None else int(size_bytes),
        "source": str(source),
        "thumbnail_size": int(thumbnail_size),
        "thumbnailer_version": str(thumbnailer_version),
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def thumbnail_cache_path(
    cache_key: str,
    *,
    output_format: str = THUMBNAIL_OUTPUT_FORMAT,
    cache_dir: Path | None = None,
) -> Path:
    normalized_format = str(output_format).lower().lstrip(".") or THUMBNAIL_OUTPUT_FORMAT
    cache_root = THUMBNAIL_CACHE_DIR if cache_dir is None else cache_dir
    return cache_root / cache_key[:2] / cache_key[2:4] / f"{cache_key}.{normalized_format}"


def _descriptor_from_parts(
    *,
    source: str,
    rel_path: str,
    local_path: Path | None,
    size_bytes: int | None,
    modified_time: float | None,
    thumbnail_size: int,
    output_format: str = THUMBNAIL_OUTPUT_FORMAT,
    thumbnailer_version: str = THUMBNAILER_VERSION,
    cache_dir: Path | None = None,
) -> ThumbnailDescriptor:
    cache_key = build_thumbnail_cache_key(
        source=source,
        rel_path=rel_path,
        size_bytes=None if size_bytes is None else int(size_bytes),
        modified_time=None if modified_time is None else float(modified_time),
        thumbnail_size=thumbnail_size,
        output_format=output_format,
        thumbnailer_version=thumbnailer_version,
    )
    return ThumbnailDescriptor(
        source=source,
        rel_path=clean_rel_path(rel_path),
        local_path=local_path,
        size_bytes=None if size_bytes is None else int(size_bytes),
        modified_time=None if modified_time is None else float(modified_time),
        thumbnail_size=int(thumbnail_size),
        output_format=str(output_format).lower(),
        thumbnailer_version=str(thumbnailer_version),
        cache_key=cache_key,
        cache_path=thumbnail_cache_path(cache_key, output_format=output_format, cache_dir=cache_dir),
    )


def thumbnail_descriptor_for_row(
    parent_rel_path: str,
    row: dict[str, Any],
    *,
    status_label: str | None = None,
    thumbnail_size: int,
    output_format: str = THUMBNAIL_OUTPUT_FORMAT,
    thumbnailer_version: str = THUMBNAILER_VERSION,
    cache_dir: Path | None = None,
) -> ThumbnailDescriptor | None:
    name = str(row.get("name") or "")
    if not is_thumbnailable_image(name, bool(row.get("is_dir"))):
        return None
    source = thumbnail_source_for_row(row, status_label=status_label)
    if source is None:
        return None
    rel_path = clean_rel_path(child_remote_path(parent_rel_path, name))
    local_path = Path(row["local_path"]) if source == "local" and row.get("local_path") else None
    size_bytes = row.get("local_size") if source == "local" else row.get("remote_size")
    modified_time = row.get("local_mtime") if source == "local" else row.get("remote_mtime")
    return _descriptor_from_parts(
        source=source,
        rel_path=rel_path,
        local_path=local_path,
        size_bytes=size_bytes,
        modified_time=modified_time,
        thumbnail_size=thumbnail_size,
        output_format=output_format,
        thumbnailer_version=thumbnailer_version,
        cache_dir=cache_dir,
    )


def _write_file_atomic(path: Path, source_path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            dir=path.parent,
            prefix="thumbnail-cache-",
            suffix=path.suffix,
            delete=False,
        ) as handle:
            tmp_path = Path(handle.name)
        shutil.copyfile(source_path, tmp_path)
        delay = _ATOMIC_REPLACE_RETRY_DELAY_SECONDS
        for attempt in range(_ATOMIC_REPLACE_RETRIES):
            try:
                tmp_path.replace(path)
                break
            except PermissionError:
                if attempt == _ATOMIC_REPLACE_RETRIES - 1:
                    raise
                threading.Event().wait(delay)
                delay *= 2
    finally:
        if tmp_path is not None:
            try:
                tmp_path.unlink(missing_ok=True)
            except OSError:
                pass


class ThumbnailService:
    def __init__(
        self,
        rclone: RcloneClient,
        remote: str,
        local_root: Path | None,
        thumbnail_config: ThumbnailConfig,
    ) -> None:
        self.rclone = rclone
        self.remote = remote
        self.local_root = local_root.resolve() if local_root else None
        self.thumbnail_config = thumbnail_config
        self._inflight_guard = threading.Lock()
        self._inflight: dict[str, dict[str, Any]] = {}

    def descriptor_for_path(self, rel_path: str, source: str) -> ThumbnailDescriptor | None:
        normalized_rel_path = clean_rel_path(rel_path)
        if not is_thumbnailable_image(normalized_rel_path, False):
            workertrace.append(
                "thumbnail_unsupported_format",
                rel_path=normalized_rel_path,
                source=source,
            )
            return None
        if source == "local":
            return self._local_descriptor(normalized_rel_path)
        if source == "remote":
            return self._remote_descriptor(normalized_rel_path)
        raise BrowserError(HTTPStatus.BAD_REQUEST, "Unsupported thumbnail source.")

    def ensure_thumbnail(self, descriptor: ThumbnailDescriptor | None) -> ThumbnailResult:
        if descriptor is None:
            return ThumbnailResult(status="unsupported", descriptor=None, path=None, cache_hit=False)
        if descriptor.cache_path.exists():
            self._trace_event("thumbnail_cache_hit", descriptor)
            return ThumbnailResult(status="ready", descriptor=descriptor, path=descriptor.cache_path, cache_hit=True)
        if not self.thumbnail_config.enabled or self.thumbnail_config.magick_exe is None:
            self._trace_event("thumbnail_magick_missing", descriptor)
            return ThumbnailResult(
                status="disabled",
                descriptor=descriptor,
                path=None,
                cache_hit=False,
                error_message="Vendored ImageMagick is not available.",
            )
        if (
            descriptor.size_bytes is not None
            and descriptor.size_bytes > int(self.thumbnail_config.max_input_bytes)
        ):
            self._trace_event("thumbnail_oversized_input", descriptor)
            return ThumbnailResult(
                status="oversized",
                descriptor=descriptor,
                path=None,
                cache_hit=False,
                error_message="Input exceeds thumbnail size limit.",
            )
        with self._inflight_guard:
            inflight = self._inflight.get(descriptor.cache_key)
            if inflight is None:
                inflight = {"event": threading.Event(), "result": None}
                self._inflight[descriptor.cache_key] = inflight
                owner = True
            else:
                owner = False
        if not owner:
            inflight["event"].wait()
            result = inflight.get("result")
            return result if isinstance(result, ThumbnailResult) else ThumbnailResult(
                status="failed",
                descriptor=descriptor,
                path=None,
                cache_hit=False,
                error_message="Thumbnail generation failed.",
            )
        try:
            self._trace_event("thumbnail_cache_miss", descriptor)
            result = self._generate_thumbnail(descriptor)
            inflight["result"] = result
            return result
        finally:
            inflight["event"].set()
            with self._inflight_guard:
                self._inflight.pop(descriptor.cache_key, None)

    def _local_descriptor(self, rel_path: str) -> ThumbnailDescriptor | None:
        if self.local_root is None:
            return None
        safe_join_local(self.local_root, rel_path)
        local_path = resolve_matching_local_path(self.local_root, rel_path)
        if not local_path.exists() or not local_path.is_file():
            return None
        stat = local_path.stat()
        return _descriptor_from_parts(
            source="local",
            rel_path=rel_path,
            local_path=local_path,
            size_bytes=stat.st_size,
            modified_time=stat.st_mtime,
            thumbnail_size=self.thumbnail_config.size,
        )

    def _remote_descriptor(self, rel_path: str) -> ThumbnailDescriptor | None:
        remote_path = remote_target(self.remote, rel_path)
        try:
            stat = self.rclone.stat(remote_path)
        except BrowserError as exc:
            if exc.status == HTTPStatus.NOT_FOUND:
                return None
            raise
        if bool(stat.get("IsDir")):
            return None
        name = str(stat.get("Name") or stat.get("Path") or rel_path)
        if not is_thumbnailable_image(name, False):
            return None
        return _descriptor_from_parts(
            source="remote",
            rel_path=rel_path,
            local_path=None,
            size_bytes=stat.get("Size"),
            modified_time=_parse_modified_time(stat.get("ModTime")),
            thumbnail_size=self.thumbnail_config.size,
        )

    def _generate_thumbnail(self, descriptor: ThumbnailDescriptor) -> ThumbnailResult:
        if descriptor.cache_path.exists():
            self._trace_event("thumbnail_cache_hit", descriptor)
            return ThumbnailResult(status="ready", descriptor=descriptor, path=descriptor.cache_path, cache_hit=True)
        source_path: Path | None = None
        temp_input_path: Path | None = None
        temp_output_path: Path | None = None
        started = time.perf_counter()
        try:
            source_path, temp_input_path = self._materialize_source(descriptor)
            temp_output_path = self._thumbnail_output_temp_path()
            proc = self._run_magick(source_path, temp_output_path, descriptor.thumbnail_size)
            if proc.returncode != 0:
                stderr = proc.stderr.decode("utf-8", "replace").strip()
                self._trace_event(
                    "thumbnail_generation_failure",
                    descriptor,
                    elapsed_ms=self._elapsed_ms_since(started),
                    error_message=stderr or "Thumbnail generation failed.",
                )
                return ThumbnailResult(
                    status="failed",
                    descriptor=descriptor,
                    path=None,
                    cache_hit=False,
                    error_message=stderr or "Thumbnail generation failed.",
                )
            if not temp_output_path.exists() or temp_output_path.stat().st_size <= 0:
                self._trace_event(
                    "thumbnail_generation_failure",
                    descriptor,
                    elapsed_ms=self._elapsed_ms_since(started),
                    error_message="Thumbnail generation produced no output.",
                )
                return ThumbnailResult(
                    status="failed",
                    descriptor=descriptor,
                    path=None,
                    cache_hit=False,
                    error_message="Thumbnail generation produced no output.",
                )
            output_size_bytes = temp_output_path.stat().st_size
            _write_file_atomic(descriptor.cache_path, temp_output_path)
            self._trace_event(
                "thumbnail_generation_success",
                descriptor,
                elapsed_ms=self._elapsed_ms_since(started),
                output_size_bytes=output_size_bytes,
            )
            return ThumbnailResult(
                status="generated",
                descriptor=descriptor,
                path=descriptor.cache_path,
                cache_hit=False,
            )
        except subprocess.TimeoutExpired:
            self._trace_event(
                "thumbnail_generation_timeout",
                descriptor,
                elapsed_ms=self._elapsed_ms_since(started),
            )
            return ThumbnailResult(
                status="timeout",
                descriptor=descriptor,
                path=None,
                cache_hit=False,
                error_message="Thumbnail generation timed out.",
            )
        except BrowserError as exc:
            self._trace_event(
                "thumbnail_generation_failure",
                descriptor,
                elapsed_ms=self._elapsed_ms_since(started),
                error_message=exc.message,
            )
            return ThumbnailResult(
                status="failed",
                descriptor=descriptor,
                path=None,
                cache_hit=False,
                error_message=exc.message,
            )
        except FileNotFoundError as exc:
            self._trace_event(
                "thumbnail_magick_missing",
                descriptor,
                elapsed_ms=self._elapsed_ms_since(started),
                error_message=str(exc),
            )
            return ThumbnailResult(
                status="disabled",
                descriptor=descriptor,
                path=None,
                cache_hit=False,
                error_message=str(exc),
            )
        finally:
            if temp_input_path is not None:
                try:
                    temp_input_path.unlink(missing_ok=True)
                except OSError:
                    pass
            if temp_output_path is not None:
                try:
                    temp_output_path.unlink(missing_ok=True)
                except OSError:
                    pass

    def _materialize_source(self, descriptor: ThumbnailDescriptor) -> tuple[Path, Path | None]:
        if descriptor.source == "local":
            if descriptor.local_path is None:
                raise BrowserError(HTTPStatus.NOT_FOUND, "Local thumbnail source is unavailable.")
            if not descriptor.local_path.exists() or not descriptor.local_path.is_file():
                raise BrowserError(HTTPStatus.NOT_FOUND, "Local thumbnail source was not found.")
            return descriptor.local_path, None
        if descriptor.source != "remote":
            raise BrowserError(HTTPStatus.BAD_REQUEST, "Unsupported thumbnail source.")
        TEMP_DIR.mkdir(parents=True, exist_ok=True)
        suffix = thumbnailable_image_extension(descriptor.rel_path) or ".bin"
        with tempfile.NamedTemporaryFile(
            dir=TEMP_DIR,
            prefix=_IMAGE_MAGICK_INPUT_PREFIX,
            suffix=suffix,
            delete=False,
        ) as handle:
            temp_input_path = Path(handle.name)
        self.rclone.copy_file_overwrite(
            remote_target(self.remote, descriptor.rel_path),
            temp_input_path,
            size_bytes=descriptor.size_bytes,
        )
        return temp_input_path, temp_input_path

    def _thumbnail_output_temp_path(self) -> Path:
        TEMP_DIR.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            dir=TEMP_DIR,
            prefix=_IMAGE_MAGICK_OUTPUT_PREFIX,
            suffix=_IMAGE_MAGICK_OUTPUT_SUFFIX,
            delete=False,
        ) as handle:
            return Path(handle.name)

    def _run_magick(self, input_path: Path, output_path: Path, thumbnail_size: int) -> subprocess.CompletedProcess[bytes]:
        assert self.thumbnail_config.magick_exe is not None
        geometry = f"{int(thumbnail_size)}x{int(thumbnail_size)}>"
        extent = f"{int(thumbnail_size)}x{int(thumbnail_size)}"
        command = [
            str(self.thumbnail_config.magick_exe),
            f"{input_path}[0]",
            "-auto-orient",
            "-thumbnail",
            geometry,
            "-background",
            "none",
            "-gravity",
            "center",
            "-extent",
            extent,
            f"png:{output_path}",
        ]
        return subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=float(self.thumbnail_config.timeout_seconds),
        )

    def _trace_event(self, event: str, descriptor: ThumbnailDescriptor, **fields: Any) -> None:
        workertrace.append(
            event,
            rel_path=descriptor.rel_path,
            source=descriptor.source,
            cache_key=descriptor.cache_key,
            thumbnail_size=descriptor.thumbnail_size,
            input_size_bytes=descriptor.size_bytes,
            **fields,
        )

    @staticmethod
    def _elapsed_ms_since(started: float) -> float:
        return round((time.perf_counter() - started) * 1000, 3)


def _parse_modified_time(value: Any) -> float | None:
    if not value:
        return None
    text = str(value).replace("Z", "+00:00")
    try:
        from datetime import datetime

        return datetime.fromisoformat(text).timestamp()
    except ValueError:
        return None
