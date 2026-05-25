"""Music player endpoint helpers."""
from __future__ import annotations

import posixpath
import time
from http import HTTPStatus
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs

from .errors import BrowserError
from .paths import child_remote_path, clean_rel_path, remote_target


MUSIC_ENDPOINT_PREFIX = "/music/endpoints/"
SUPPORTED_AUDIO_EXTENSIONS = (".mp3", ".m4a", ".aac", ".wav")


def _folder_id(remote_path: str) -> str:
    return "folder:" + remote_path


def _song_id(remote_path: str) -> str:
    return "song:" + remote_path


def _display_name_for_root(rel_path: str) -> str:
    return posixpath.basename(rel_path) if rel_path else "Dropbox"


def _is_supported_song(name: str) -> bool:
    return Path(name).suffix.casefold() in SUPPORTED_AUDIO_EXTENSIONS


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


def _song_from_direct_file(app: Any, root_rel_path: str, parent_id: str, file_data: dict[str, Any]) -> dict[str, Any] | None:
    name = file_data.get("name") or file_data.get("path") or ""
    remote_path = file_data.get("remote_path") or ""
    if not isinstance(name, str) or not isinstance(remote_path, str) or not _is_supported_song(name):
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
    return {
        "id": _song_id(remote_path),
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


def _library_endpoint(app: Any, query: str) -> tuple[HTTPStatus, dict]:
    params = parse_qs(query, keep_blank_values=True)
    root_rel_path = clean_rel_path(params.get("path", [""])[0])
    root_remote_path = remote_target(app.remote, root_rel_path)
    root_id = _folder_id(root_remote_path)
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
        "display_name": _display_name_for_root(root_rel_path),
    }

    if not root_data:
        pending = pending_folder_count > 0
        return HTTPStatus.OK, {
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
            "songs": [],
        }

    folders: list[dict[str, Any]] = []
    songs: list[dict[str, Any]] = []
    seen_song_remote_paths: set[str] = set()
    seen_folder_remote_paths: set[str] = set()
    incomplete_folder_count = 0

    def append_direct_file_songs(parent_id: str, folder_data: dict[str, Any]) -> None:
        for file_data in _direct_files(folder_data):
            song = _song_from_direct_file(app, root_rel_path, parent_id, file_data)
            if song is None or song["remote_path"] in seen_song_remote_paths:
                continue
            seen_song_remote_paths.add(song["remote_path"])
            songs.append(song)

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
            "id": _folder_id(folder_remote_path),
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
        append_direct_file_songs(parent_id, folder_data)
        for child_folder in _direct_folders(folder_data):
            name = child_folder.get("name") or child_folder.get("path") or ""
            child_remote_path = child_folder.get("remote_path") or ""
            child_folder_mtime = child_folder.get("mtime")
            if not isinstance(name, str) or not isinstance(child_remote_path, str) or not name or child_remote_path in seen_folder_remote_paths:
                continue
            item_rel_path = child_remote_path_for_display(folder_rel_path, child_remote_path, name)
            item_stream_path = _remote_rel_path(app.remote, child_remote_path)
            child_data = _folder_cache_data(app, child_remote_path)
            child_status = _folder_cache_status(app, child_remote_path)
            seen_folder_remote_paths.add(child_remote_path)
            if child_data and not child_data.get("complete"):
                incomplete_folder_count += 1
            folders.append(
                folder_node(
                    parent_id,
                    item_rel_path,
                    item_stream_path,
                    child_remote_path,
                    name,
                    child_folder_mtime if isinstance(child_folder_mtime, (int, float)) else None,
                    child_data or None,
                    child_status,
                )
            )
            if child_data:
                visit_folder(_folder_id(child_remote_path), item_rel_path, child_remote_path, child_data)

    if not root_data.get("complete"):
        incomplete_folder_count += 1
    visit_folder(root_id, "", root_remote_path, root_data)
    pending = pending_folder_count > 0
    complete = not pending and incomplete_folder_count == 0
    return HTTPStatus.OK, {
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
        "songs": songs,
    }


def handle_music_get(app: Any, path: str, query: str) -> tuple[HTTPStatus, dict]:
    """Return the JSON response for a music GET endpoint."""
    endpoint = path.removeprefix(MUSIC_ENDPOINT_PREFIX)
    params = parse_qs(query, keep_blank_values=True)

    if endpoint == "library":
        return _library_endpoint(app, query)

    if endpoint == "status":
        return HTTPStatus.OK, {
            "status": "ok",
            "supported_extensions": list(SUPPORTED_AUDIO_EXTENSIONS),
            "endpoint_root": MUSIC_ENDPOINT_PREFIX.rstrip("/"),
            "query_keys": sorted(params),
        }

    raise BrowserError(HTTPStatus.NOT_FOUND, "Music endpoint not found.")
