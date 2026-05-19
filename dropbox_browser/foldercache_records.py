"""Folder-cache record schema, serialization, and validation helpers."""
from __future__ import annotations

from .folderdiff import DIFF_LOADING, DIFF_UNAVAILABLE

DIFF_CACHE_SCHEMA_VERSION = 6


def build_cache_record(
    remote_path: str,
    acc: dict,
    *,
    complete: bool,
    local_root: str | None,
    now: float,
) -> dict:
    """Build the on-disk folder-cache record for one accumulated state."""
    return {
        "remote_path": remote_path,
        "schema_version": DIFF_CACHE_SCHEMA_VERSION,
        "local_root": local_root,
        "size": acc.get("size", 0),
        "file_count": acc.get("count", 0),
        "newest_mtime": acc.get("mtime"),
        "diff_status": acc.get("diff_status", DIFF_UNAVAILABLE if local_root is None else DIFF_LOADING),
        "diff_complete": acc.get("diff_complete", local_root is None),
        "first_diff_path": acc.get("first_diff_path"),
        "file_statuses": acc.get("file_statuses", {}),
        "complete": complete,
        "cached_at": now,
    }


def validate_cache_record(
    data: dict,
    *,
    expected_local_root: str | None,
    ttl_seconds: float,
    now: float,
) -> dict | None:
    """Return a usable cache record, or None when schema/context/TTL rules reject it."""
    if data.get("local_root") != expected_local_root:
        return None
    if expected_local_root is not None and data.get("schema_version") != DIFF_CACHE_SCHEMA_VERSION:
        return None
    if data.get("complete") and data.get("diff_complete") and any(
        (status or {}).get("diff_status") == DIFF_LOADING
        for status in (data.get("file_statuses") or {}).values()
    ):
        return None
    if data.get("complete") and now - data.get("cached_at", 0) > ttl_seconds:
        return None
    return data
