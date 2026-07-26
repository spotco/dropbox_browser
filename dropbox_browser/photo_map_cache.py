"""Validated, browser-owned Photo Map metadata cache."""

from __future__ import annotations

import hashlib
import json
import math
import os
import tempfile
import threading
from pathlib import Path
from typing import Any
from urllib.parse import unquote

from .config import PHOTO_MAP_CACHE_BATCH_LIMIT, PHOTO_MAP_CACHE_DIR
from .errors import BrowserError
from .paths import clean_rel_path


CACHE_DIR = PHOTO_MAP_CACHE_DIR
CACHE_SCHEMA_VERSION = 1
MAX_BATCH_ENTRIES = PHOTO_MAP_CACHE_BATCH_LIMIT
MAX_CACHED_ENTRIES = 50_000
MAX_CAPTURE_DATE_LENGTH = 128
_CACHE_LOCK = threading.RLock()


def _bad(message: str) -> BrowserError:
    from http import HTTPStatus

    return BrowserError(HTTPStatus.BAD_REQUEST, message)


def normalize_cache_path(raw: object, *, allow_empty: bool = False) -> str:
    value = unquote(str(raw or ""))
    if value.startswith(("/", "\\")) or (len(value) >= 2 and value[1] == ":"):
        raise _bad("Photo Map paths must be relative remote paths.")
    normalized = clean_rel_path(value)
    if not allow_empty and not normalized:
        raise _bad("Photo Map file path is required.")
    return normalized


def _is_direct_child(path: str, folder: str) -> bool:
    prefix = folder + "/" if folder else ""
    if not path.startswith(prefix):
        return False
    child = path[len(prefix):]
    return bool(child) and "/" not in child


def normalize_listing_identity(size: object, modified_time: object) -> tuple[int, float | None]:
    if isinstance(size, bool):
        raise _bad("Photo Map listing size must be a non-negative integer.")
    try:
        normalized_size = int(size)
    except (TypeError, ValueError, OverflowError) as exc:
        raise _bad("Photo Map listing size must be a non-negative integer.") from exc
    if normalized_size < 0 or normalized_size != size:
        raise _bad("Photo Map listing size must be a non-negative integer.")

    if modified_time is None:
        normalized_time = None
    elif isinstance(modified_time, bool):
        raise _bad("Photo Map modification time must be finite or null.")
    else:
        try:
            normalized_time = float(modified_time)
        except (TypeError, ValueError, OverflowError) as exc:
            raise _bad("Photo Map modification time must be finite or null.") from exc
        if not math.isfinite(normalized_time):
            raise _bad("Photo Map modification time must be finite or null.")
    return normalized_size, normalized_time


def photo_map_cache_key(path: object, size: object, modified_time: object) -> str:
    normalized_path = normalize_cache_path(path)
    normalized_size, normalized_time = normalize_listing_identity(size, modified_time)
    identity = {
        "modified_time": normalized_time,
        "path": normalized_path,
        "size": normalized_size,
    }
    encoded = json.dumps(identity, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _cache_file_path(folder: str) -> Path:
    digest = hashlib.sha256(folder.encode("utf-8")).hexdigest()
    return CACHE_DIR / digest[:2] / f"{digest}.json"


def _finite_optional(value: object, message: str) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool):
        raise _bad(message)
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise _bad(message) from exc
    if not math.isfinite(number):
        raise _bad(message)
    return number


def _validate_record(record: object, folder: str) -> dict[str, Any]:
    if not isinstance(record, dict):
        raise _bad("Each Photo Map cache entry must be an object.")
    path = normalize_cache_path(record.get("path"))
    if not _is_direct_child(path, folder):
        raise _bad("Photo Map cache entries must belong to the requested folder.")
    source_path = normalize_cache_path(record.get("source_path", path))
    if source_path != path:
        raise _bad("Photo Map source_path must match path.")
    size, modified_time = normalize_listing_identity(record.get("size"), record.get("modified_time"))
    status = str(record.get("status") or "")
    if status not in {"located", "no-location", "unsupported", "error"}:
        raise _bad("Unsupported Photo Map cache status.")

    latitude = _finite_optional(record.get("latitude"), "Photo Map latitude must be finite or null.")
    longitude = _finite_optional(record.get("longitude"), "Photo Map longitude must be finite or null.")
    if status == "located":
        if latitude is None or longitude is None or not (-90 <= latitude <= 90) or not (-180 <= longitude <= 180):
            raise _bad("Located Photo Map entries require valid coordinates.")
    elif latitude is not None or longitude is not None:
        raise _bad("Non-located Photo Map entries cannot contain coordinates.")

    capture_date = record.get("capture_date")
    if capture_date is not None and (not isinstance(capture_date, str) or len(capture_date) > MAX_CAPTURE_DATE_LENGTH):
        raise _bad("Photo Map capture_date must be a short string or null.")
    capture_date_ms = _finite_optional(record.get("capture_date_ms"), "Photo Map capture_date_ms must be finite or null.")
    listing_date_ms = _finite_optional(record.get("listing_date_ms"), "Photo Map listing_date_ms must be finite or null.")
    media_kind = record.get("media_kind")
    if media_kind is not None and media_kind not in {"photo", "video"}:
        raise _bad("Photo Map media_kind is invalid.")
    reason = record.get("reason")
    if reason is not None and (not isinstance(reason, str) or len(reason) > 128):
        raise _bad("Photo Map reason must be a short string or null.")
    quicktime_parser_version = record.get("quicktime_parser_version")
    if quicktime_parser_version is not None and (
        not isinstance(quicktime_parser_version, str) or len(quicktime_parser_version) > 128
    ):
        raise _bad("Photo Map QuickTime parser version must be a short string or null.")

    normalized = {
        "path": path,
        "source_path": source_path,
        "size": size,
        "modified_time": modified_time,
        "status": status,
        "media_kind": media_kind,
        "latitude": latitude,
        "longitude": longitude,
        "capture_date": capture_date,
        "capture_date_ms": capture_date_ms,
        "listing_date_ms": listing_date_ms,
        "reason": reason,
    }
    if quicktime_parser_version is not None:
        normalized["quicktime_parser_version"] = quicktime_parser_version
    normalized["cache_key"] = photo_map_cache_key(path, size, modified_time)
    return normalized


def _read_payload(path: Path, folder: str) -> dict[str, Any]:
    if not path.is_file():
        return {"schema_version": CACHE_SCHEMA_VERSION, "folder": folder, "entries": {}}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return {"schema_version": CACHE_SCHEMA_VERSION, "folder": folder, "entries": {}}
    if not isinstance(payload, dict) or payload.get("schema_version") != CACHE_SCHEMA_VERSION or payload.get("folder") != folder:
        return {"schema_version": CACHE_SCHEMA_VERSION, "folder": folder, "entries": {}}
    entries = payload.get("entries")
    if not isinstance(entries, dict):
        return {"schema_version": CACHE_SCHEMA_VERSION, "folder": folder, "entries": {}}
    return {"schema_version": CACHE_SCHEMA_VERSION, "folder": folder, "entries": entries}


def _write_payload(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix="photo-map-", suffix=".json", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        Path(temp_name).replace(path)
    finally:
        try:
            Path(temp_name).unlink(missing_ok=True)
        except OSError:
            pass


class PhotoMapCache:
    def read(self, folder_path: object) -> list[dict[str, Any]]:
        folder = normalize_cache_path(folder_path, allow_empty=True)
        with _CACHE_LOCK:
            payload = _read_payload(_cache_file_path(folder), folder)
        records = []
        for key, record in payload["entries"].items():
            try:
                normalized = _validate_record(record, folder)
            except BrowserError:
                continue
            if normalized["cache_key"] == key:
                records.append(normalized)
        records.sort(key=lambda item: (str(item["path"]).casefold(), item["cache_key"]))
        return records

    def write_batch(self, folder_path: object, records: object) -> int:
        folder = normalize_cache_path(folder_path, allow_empty=True)
        if not isinstance(records, list) or not records:
            raise _bad("Photo Map cache entries must be a non-empty array.")
        if len(records) > MAX_BATCH_ENTRIES:
            raise _bad(f"Photo Map cache batches are limited to {MAX_BATCH_ENTRIES} entries.")
        normalized_records = [_validate_record(record, folder) for record in records]
        with _CACHE_LOCK:
            path = _cache_file_path(folder)
            payload = _read_payload(path, folder)
            entries = dict(payload["entries"])
            paths_written = {record["path"] for record in normalized_records}
            for key, old_record in list(entries.items()):
                if isinstance(old_record, dict) and old_record.get("path") in paths_written:
                    del entries[key]
            for record in normalized_records:
                entries[record["cache_key"]] = record
            if len(entries) > MAX_CACHED_ENTRIES:
                raise _bad(f"Photo Map cache is limited to {MAX_CACHED_ENTRIES} entries per folder.")
            _write_payload(path, {"schema_version": CACHE_SCHEMA_VERSION, "folder": folder, "entries": entries})
        return len(normalized_records)
