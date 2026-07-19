"""Shared media library listing helpers (recursive folder-cache walk).

Music and video library endpoints both use ``build_recursive_library_payload``.
"""
from __future__ import annotations

import inspect
import posixpath
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence
from urllib.parse import urlencode

from .paths import child_remote_path, clean_rel_path, remote_target

FileEnricher = Callable[[dict[str, Any]], dict[str, Any] | None]


class MediaLibrarySnapshotCache:
    """Small app-local LRU for recursive media-library response snapshots."""

    def __init__(self, max_entries: int = 8) -> None:
        self.max_entries = max(1, int(max_entries))
        self._entries: OrderedDict[tuple[Any, ...], tuple[int, dict[str, Any]]] = OrderedDict()

    def get(self, key: tuple[Any, ...], revision: int) -> dict[str, Any] | None:
        entry = self._entries.get(key)
        if entry is None:
            return None
        cached_revision, payload = entry
        if cached_revision != revision:
            self._entries.pop(key, None)
            return None
        self._entries.move_to_end(key)
        return payload

    def put(self, key: tuple[Any, ...], revision: int, payload: dict[str, Any]) -> None:
        self._entries[key] = (revision, payload)
        self._entries.move_to_end(key)
        while len(self._entries) > self.max_entries:
            self._entries.popitem(last=False)

    def __len__(self) -> int:
        return len(self._entries)


def display_name_for_root(rel_path: str) -> str:
    return posixpath.basename(rel_path) if rel_path else "Dropbox"


def is_supported_media(name: str, supported_extensions: Sequence[str]) -> bool:
    extensions = {ext.casefold() for ext in supported_extensions}
    return Path(name).suffix.casefold() in extensions


def folder_id(remote_path: str) -> str:
    return "folder:" + remote_path


def media_file_id(remote_path: str, *, id_prefix: str = "item") -> str:
    prefix = (id_prefix or "item").rstrip(":")
    return prefix + ":" + remote_path


def _folder_cache_data(
    app: Any,
    remote_path: str,
    record_lookup: Callable[[str], dict[str, Any] | None] | None = None,
) -> dict[str, Any]:
    cache = getattr(app, "folder_cache", None)
    if cache is None:
        return {}
    data = record_lookup(remote_path) if record_lookup is not None else cache.get(remote_path)
    return data if isinstance(data, dict) else {}


def _folder_cache_status(
    app: Any,
    remote_path: str,
    record_lookup: Callable[[str], dict[str, Any] | None] | None = None,
) -> str:
    cache = getattr(app, "folder_cache", None)
    if cache is None or not hasattr(cache, "status"):
        return "unavailable"
    if record_lookup is not None:
        data = record_lookup(remote_path)
        if isinstance(data, dict):
            return "complete" if data.get("complete") else "partial"
    status = cache.status(remote_path)
    return status if isinstance(status, str) else "unavailable"


def _folder_cache_revision(cache: Any) -> int:
    value = getattr(cache, "revision", 0)
    if callable(value):
        value = value()
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def _snapshot_cache_for_app(app: Any) -> MediaLibrarySnapshotCache:
    cache = getattr(app, "_media_library_snapshot_cache", None)
    if not isinstance(cache, MediaLibrarySnapshotCache):
        cache = MediaLibrarySnapshotCache()
        setattr(app, "_media_library_snapshot_cache", cache)
    return cache


def _accepts_keyword(function: Callable[..., Any], name: str) -> bool:
    try:
        parameters = inspect.signature(function).parameters.values()
    except (TypeError, ValueError):
        return False
    return any(
        parameter.name == name or parameter.kind == inspect.Parameter.VAR_KEYWORD
        for parameter in parameters
    )


def _remote_rel_path(remote_root: str, remote_path: str) -> str:
    remote_root = remote_root.rstrip("/")
    if remote_path == remote_root:
        return ""
    if remote_root.endswith(":"):
        prefix = remote_root
    else:
        prefix = remote_root.rstrip("/") + "/"
    if remote_path.startswith(prefix):
        return remote_path[len(prefix):].lstrip("/")
    return ""


def _direct_files(folder_data: dict[str, Any]) -> list[dict[str, Any]]:
    files = folder_data.get("direct_files", [])
    return files if isinstance(files, list) else []


def _direct_folders(folder_data: dict[str, Any]) -> list[dict[str, Any]]:
    folders = folder_data.get("direct_folders", [])
    return folders if isinstance(folders, list) else []


def _media_from_direct_file(
    app: Any,
    root_rel_path: str,
    parent_id: str,
    file_data: dict[str, Any],
    *,
    supported_extensions: Sequence[str],
    id_prefix: str,
    enrich_file: FileEnricher | None,
) -> dict[str, Any] | None:
    name = file_data.get("name") or file_data.get("path") or ""
    remote_path = file_data.get("remote_path") or ""
    if not isinstance(name, str) or not isinstance(remote_path, str):
        return None
    if not is_supported_media(name, supported_extensions):
        return None
    stream_path = _remote_rel_path(app.remote, remote_path)
    if not stream_path:
        return None
    if root_rel_path and stream_path.startswith(root_rel_path.rstrip("/") + "/"):
        rel_path = stream_path[len(root_rel_path.rstrip("/") + "/"):]
    elif stream_path == root_rel_path:
        rel_path = name
    else:
        rel_path = stream_path
    row: dict[str, Any] = {
        "id": media_file_id(remote_path, id_prefix=id_prefix),
        "parent_id": parent_id,
        "remote_path": remote_path,
        "stream_path": stream_path,
        "rel_path": rel_path,
        "display_name": name,
        "filename": name,
        "type": "file",
        "extension": Path(name).suffix.casefold(),
        "size": file_data.get("size"),
        "mtime": file_data.get("mtime"),
    }
    if enrich_file is not None:
        enriched = enrich_file(row)
        if enriched is None:
            return None
        row = enriched
    return row


def build_recursive_library_payload(
    app: Any,
    *,
    rel_path: str,
    supported_extensions: Sequence[str],
    id_prefix: str = "item",
    include_songs_key: bool = True,
    include_items_key: bool = True,
    enrich_file: FileEnricher | None = None,
    enrichment_mode: str | None = None,
) -> dict[str, Any]:
    """Recursive folder-cache library used by the shared media-library client.

    Emits ``folders`` plus media rows under ``songs`` and/or ``items`` (same list
    when both flags are true) so music keeps ``songs`` while shared code can read
    ``items``.
    """
    root_rel_path = clean_rel_path(rel_path)
    root_remote_path = remote_target(app.remote, root_rel_path)
    root_id = folder_id(root_remote_path)
    folder_cache = getattr(app, "folder_cache", None)
    revision = _folder_cache_revision(folder_cache)
    enrichment_key = enrichment_mode or ("plain" if enrich_file is None else f"custom:{id(enrich_file)}")
    snapshot_key = (
        root_remote_path,
        tuple(ext.casefold() for ext in supported_extensions),
        id_prefix,
        include_songs_key,
        include_items_key,
        enrichment_key,
    )
    snapshot_cache = _snapshot_cache_for_app(app)
    cached_payload = snapshot_cache.get(snapshot_key, revision)
    if cached_payload is not None:
        status = cached_payload.get("status")
        response = dict(cached_payload)
        if isinstance(status, dict):
            response_status = dict(status)
            response_status.update({
                "snapshot_cache_hit": True,
                "snapshot_build_count": 0,
                "recursive_record_read_count": 0,
                "recursive_traversal_folder_count": 0,
                "payload_build_elapsed_ms": 0.0,
                "snapshot_cache_revision": revision,
                "snapshot_cache_entry_count": len(snapshot_cache),
            })
            response["status"] = response_status
        return response

    build_started = time.perf_counter()
    record_cache: dict[str, dict[str, Any] | None] = {}

    def record_lookup(remote_path: str) -> dict[str, Any] | None:
        if remote_path not in record_cache:
            data = folder_cache.get(remote_path) if folder_cache is not None else None
            record_cache[remote_path] = data if isinstance(data, dict) else None
        return record_cache[remote_path]

    ensure_result: dict[str, int | float] = {
        "queued_folder_count": 0,
        "pending_folder_count": 0,
        "missing_folder_count": 0,
    }
    if (
        folder_cache is not None
        and hasattr(folder_cache, "page_epoch_for")
        and hasattr(folder_cache, "ensure_known_subtree")
    ):
        page_epoch = folder_cache.page_epoch_for(root_rel_path)
        ensure_method = folder_cache.ensure_known_subtree
        if (
            getattr(folder_cache, "supports_record_lookup", False)
            and _accepts_keyword(ensure_method, "record_lookup")
        ):
            ensure_kwargs = {"record_lookup": record_lookup}
            if _accepts_keyword(ensure_method, "trace_dedup"):
                ensure_kwargs["trace_dedup"] = False
            ensure_result = ensure_method(root_remote_path, page_epoch, **ensure_kwargs)
        else:
            ensure_result = ensure_method(root_remote_path, page_epoch)
    root_data = _folder_cache_data(app, root_remote_path, record_lookup)
    root_status = _folder_cache_status(app, root_remote_path, record_lookup)
    pending_folder_count = int(ensure_result.get("pending_folder_count", 0) or 0)
    queued_folder_count = int(ensure_result.get("queued_folder_count", 0) or 0)
    missing_folder_count = int(ensure_result.get("missing_folder_count", 0) or 0)

    root = {
        "id": root_id,
        "remote_path": root_remote_path,
        "rel_path": "",
        "stream_path": root_rel_path,
        "display_name": display_name_for_root(root_rel_path),
    }

    empty_media: list[dict[str, Any]] = []
    if not root_data:
        pending = pending_folder_count > 0
        payload: dict[str, Any] = {
            "root": root,
            "status": {
                "cache_status": "unavailable",
                "complete": False,
                "pending": pending,
                "pending_folder_count": pending_folder_count,
                "queued_folder_count": queued_folder_count,
                "missing_folder_count": missing_folder_count,
                "message": (
                    "Library metadata is loading."
                    if pending or root_status in {"pending", "calculating"}
                    else "No cached folder metadata is available for this folder yet."
                ),
                "generated_at": time.time(),
                "missing_listing_count": missing_folder_count or 1,
            },
            "folders": [],
            "supported_extensions": list(supported_extensions),
        }
        if include_songs_key:
            payload["songs"] = empty_media
        if include_items_key:
            payload["items"] = empty_media
        _complete_media_snapshot(
            app,
            snapshot_cache,
            snapshot_key,
            revision,
            payload,
            record_cache,
            0,
            build_started,
        )
        return payload

    folders: list[dict[str, Any]] = []
    media_items: list[dict[str, Any]] = []
    seen_media_remote_paths: set[str] = set()
    seen_folder_remote_paths: set[str] = set()
    incomplete_folder_count = 0
    traversal_folder_count = 0

    def append_direct_media(parent_id: str, folder_data: dict[str, Any]) -> None:
        for file_data in _direct_files(folder_data):
            item = _media_from_direct_file(
                app,
                root_rel_path,
                parent_id,
                file_data,
                supported_extensions=supported_extensions,
                id_prefix=id_prefix,
                enrich_file=enrich_file,
            )
            if item is None or item["remote_path"] in seen_media_remote_paths:
                continue
            seen_media_remote_paths.add(str(item["remote_path"]))
            media_items.append(item)

    def folder_node(
        parent_id: str,
        folder_rel_path: str,
        folder_stream_path: str,
        folder_remote_path: str,
        name: str,
        folder_mtime: float | None,
        folder_data: dict[str, Any] | None,
        folder_status: str,
    ) -> dict[str, Any]:
        metadata_cached = folder_data is not None
        return {
            "id": folder_id(folder_remote_path),
            "parent_id": parent_id,
            "remote_path": folder_remote_path,
            "rel_path": folder_rel_path,
            "stream_path": folder_stream_path,
            "display_name": name,
            "filename": name,
            "type": "folder",
            "listing_cached": metadata_cached,
            "metadata_cached": metadata_cached,
            "complete": bool(folder_data and folder_data.get("complete")),
            "pending": folder_status in {"pending", "calculating", "partial"},
            "mtime": folder_data.get("mtime") if folder_data and folder_data.get("mtime") is not None else folder_mtime,
            "recursive_mtime": folder_data.get("newest_mtime") if folder_data else None,
        }

    def child_remote_path_for_display(parent_rel_path: str, remote_path: str, name: str) -> str:
        stream_path = _remote_rel_path(app.remote, remote_path)
        if root_rel_path and stream_path.startswith(root_rel_path.rstrip("/") + "/"):
            return stream_path[len(root_rel_path.rstrip("/") + "/"):]
        return child_remote_path(parent_rel_path, name)

    def visit_folder(parent_id: str, folder_rel_path: str, folder_remote_path: str, folder_data: dict[str, Any]) -> None:
        nonlocal incomplete_folder_count, traversal_folder_count
        traversal_folder_count += 1
        append_direct_media(parent_id, folder_data)
        for child_folder in _direct_folders(folder_data):
            name = child_folder.get("name") or child_folder.get("path") or ""
            child_remote = child_folder.get("remote_path") or ""
            child_folder_mtime = child_folder.get("mtime")
            if (
                not isinstance(name, str)
                or not isinstance(child_remote, str)
                or not name
                or child_remote in seen_folder_remote_paths
            ):
                continue
            item_rel_path = child_remote_path_for_display(folder_rel_path, child_remote, name)
            item_stream_path = _remote_rel_path(app.remote, child_remote)
            child_data = _folder_cache_data(app, child_remote, record_lookup)
            child_status = _folder_cache_status(app, child_remote, record_lookup)
            seen_folder_remote_paths.add(child_remote)
            if child_data and not child_data.get("complete"):
                incomplete_folder_count += 1
            folders.append(
                folder_node(
                    parent_id,
                    item_rel_path,
                    item_stream_path,
                    child_remote,
                    name,
                    child_folder_mtime if isinstance(child_folder_mtime, (int, float)) else None,
                    child_data or None,
                    child_status,
                )
            )
            if child_data:
                visit_folder(folder_id(child_remote), item_rel_path, child_remote, child_data)

    if not root_data.get("complete"):
        incomplete_folder_count += 1
    visit_folder(root_id, "", root_remote_path, root_data)
    pending = pending_folder_count > 0
    complete = not pending and incomplete_folder_count == 0
    payload = {
        "root": root,
        "status": {
            "cache_status": "complete" if complete else "partial",
            "complete": complete,
            "pending": pending,
            "pending_folder_count": pending_folder_count,
            "queued_folder_count": queued_folder_count,
            "missing_folder_count": missing_folder_count,
            "message": (
                "Cached library is complete."
                if complete
                else "Library is loading cached metadata."
                if pending
                else "Library may update as cached metadata arrives."
            ),
            "generated_at": time.time(),
            "missing_listing_count": missing_folder_count,
        },
        "folders": folders,
        "supported_extensions": list(supported_extensions),
    }
    if include_songs_key:
        payload["songs"] = media_items
    if include_items_key:
        payload["items"] = media_items
    _complete_media_snapshot(
        app,
        snapshot_cache,
        snapshot_key,
        revision,
        payload,
        record_cache,
        traversal_folder_count,
        build_started,
    )
    return payload


def _complete_media_snapshot(
    app: Any,
    snapshot_cache: MediaLibrarySnapshotCache,
    snapshot_key: tuple[Any, ...],
    revision: int,
    payload: dict[str, Any],
    record_cache: dict[str, dict[str, Any] | None],
    traversal_folder_count: int,
    build_started: float,
) -> None:
    status = payload.get("status")
    if not isinstance(status, dict):
        return
    current_revision = _folder_cache_revision(getattr(app, "folder_cache", None))
    status.update({
        "snapshot_cache_hit": False,
        "snapshot_build_count": 1,
        "recursive_record_read_count": len(record_cache),
        "recursive_traversal_folder_count": traversal_folder_count,
        "payload_build_elapsed_ms": round((time.perf_counter() - build_started) * 1000, 3),
        "snapshot_cache_revision": revision,
    })
    if current_revision == revision:
        snapshot_cache.put(snapshot_key, revision, payload)
    status["snapshot_cache_entry_count"] = len(snapshot_cache)


def video_file_enricher(
    *,
    compatibility_expected_extensions: Iterable[str] | None = None,
) -> FileEnricher:
    """Add video-specific preview_url / compatibility flags to media rows."""
    expected = {
        ext.casefold()
        for ext in (compatibility_expected_extensions or ())
    }

    def enrich(row: dict[str, Any]) -> dict[str, Any]:
        stream_path = str(row.get("stream_path") or row.get("path") or "")
        extension = str(row.get("extension") or Path(str(row.get("filename") or "")).suffix).casefold()
        next_row = dict(row)
        if stream_path:
            next_row.setdefault("path", stream_path)
            next_row["preview_url"] = "/file?" + urlencode({"path": stream_path, "source": "remote"})
        next_row["compatibility_expected"] = extension in expected if expected else bool(row.get("compatibility_expected"))
        return next_row

    return enrich
