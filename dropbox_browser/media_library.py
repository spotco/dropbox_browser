"""Shared media library listing helpers (recursive folder-cache + flat folder).

Music uses the recursive folder-cache tree. Video keeps a flat current-folder
listing until Phase 5 wires the shared client, but both call into this module.
"""
from __future__ import annotations

import posixpath
import time
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence
from urllib.parse import urlencode

from .paths import child_remote_path, clean_rel_path, remote_target

FileEnricher = Callable[[dict[str, Any]], dict[str, Any] | None]


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


def _folder_cache_data(app: Any, remote_path: str) -> dict[str, Any]:
    cache = getattr(app, "folder_cache", None)
    if cache is None:
        return {}
    data = cache.get(remote_path)
    return data if isinstance(data, dict) else {}


def _folder_cache_status(app: Any, remote_path: str) -> str:
    cache = getattr(app, "folder_cache", None)
    if cache is None or not hasattr(cache, "status"):
        return "unavailable"
    status = cache.status(remote_path)
    return status if isinstance(status, str) else "unavailable"


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
) -> dict[str, Any]:
    """Recursive folder-cache library used by the shared media-library client.

    Emits ``folders`` plus media rows under ``songs`` and/or ``items`` (same list
    when both flags are true) so music keeps ``songs`` while shared code can read
    ``items``.
    """
    root_rel_path = clean_rel_path(rel_path)
    root_remote_path = remote_target(app.remote, root_rel_path)
    root_id = folder_id(root_remote_path)
    ensure_result: dict[str, int | float] = {
        "queued_folder_count": 0,
        "pending_folder_count": 0,
        "missing_folder_count": 0,
    }
    folder_cache = getattr(app, "folder_cache", None)
    if (
        folder_cache is not None
        and hasattr(folder_cache, "page_epoch_for")
        and hasattr(folder_cache, "ensure_known_subtree")
    ):
        page_epoch = folder_cache.page_epoch_for(root_rel_path)
        ensure_result = folder_cache.ensure_known_subtree(root_remote_path, page_epoch)
    root_data = _folder_cache_data(app, root_remote_path)
    root_status = _folder_cache_status(app, root_remote_path)
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
        return payload

    folders: list[dict[str, Any]] = []
    media_items: list[dict[str, Any]] = []
    seen_media_remote_paths: set[str] = set()
    seen_folder_remote_paths: set[str] = set()
    incomplete_folder_count = 0

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
        nonlocal incomplete_folder_count
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
            child_data = _folder_cache_data(app, child_remote)
            child_status = _folder_cache_status(app, child_remote)
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
    return payload


def build_flat_folder_library_payload(
    app: Any,
    *,
    rel_path: str,
    supported_extensions: Sequence[str],
    enrich_file: FileEnricher | None = None,
    sort_rows: Callable[[list[dict[str, Any]]], list[dict[str, Any]]] | None = None,
) -> dict[str, Any]:
    """Flat current-folder library (legacy video player UI until Phase 5)."""
    root_rel_path = clean_rel_path(rel_path)
    entries = app.list_entries(root_rel_path)
    rows: list[dict[str, Any]] = []
    for entry in entries:
        if not entry.get("remote"):
            continue
        name = entry.get("name")
        if not isinstance(name, str):
            continue
        if entry.get("is_dir"):
            child_path = root_rel_path + "/" + name if root_rel_path else name
            rows.append({
                "display_name": name,
                "filename": name,
                "type": "folder",
                "path": child_path,
                "stream_path": child_path,
                "remote_path": child_path,
            })
            continue
        if not is_supported_media(name, supported_extensions):
            continue
        child_path = root_rel_path + "/" + name if root_rel_path else name
        extension = Path(name).suffix.casefold()
        row: dict[str, Any] = {
            "display_name": name,
            "filename": name,
            "type": "file",
            "path": child_path,
            "stream_path": child_path,
            "remote_path": child_path,
            "extension": extension,
            "size": entry.get("remote_size"),
            "mtime": entry.get("remote_mtime"),
        }
        if enrich_file is not None:
            enriched = enrich_file(row)
            if enriched is None:
                continue
            row = enriched
        rows.append(row)
    sorted_rows = sort_rows(rows) if sort_rows is not None else rows
    return {
        "status": "ok",
        "root": {
            "display_name": display_name_for_root(root_rel_path),
            "path": root_rel_path,
            "stream_path": root_rel_path,
            "remote_path": remote_target(app.remote, root_rel_path),
        },
        "items": sorted_rows,
        "supported_extensions": list(supported_extensions),
    }


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
