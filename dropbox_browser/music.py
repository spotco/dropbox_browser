"""Music player endpoint helpers.

The initial music endpoints are intentionally read-only and do not trigger
Dropbox listing work. Future library endpoints should use cached metadata only.
"""
from __future__ import annotations

import posixpath
import time
from http import HTTPStatus
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs

from .errors import BrowserError
from .formatting import parse_rclone_time
from .ignored import is_ignored_name
from .paths import child_remote_path, clean_rel_path, remote_target


MUSIC_ENDPOINT_PREFIX = "/music/endpoints/"
SUPPORTED_AUDIO_EXTENSIONS = (".mp3", ".m4a", ".aac", ".wav")


def _folder_id(remote_path: str) -> str:
    return "folder:" + remote_path


def _song_id(remote_path: str) -> str:
    return "song:" + remote_path


def _display_name_for_root(rel_path: str) -> str:
    return posixpath.basename(rel_path) if rel_path else "Dropbox"


def _item_name(item: dict[str, Any]) -> str:
    name = item.get("Name") or item.get("Path") or ""
    if not isinstance(name, str):
        return ""
    return posixpath.basename(name)


def _is_supported_song(name: str) -> bool:
    return Path(name).suffix.casefold() in SUPPORTED_AUDIO_EXTENSIONS


def _folder_cache_data(app: Any, remote_path: str) -> dict[str, Any]:
    cache = getattr(app, "folder_cache", None)
    if cache is None:
        return {}
    data = cache.get(remote_path)
    return data if isinstance(data, dict) else {}


def _folder_complete(app: Any, remote_path: str) -> bool:
    return bool(_folder_cache_data(app, remote_path).get("complete"))


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


def _direct_files(app: Any, remote_path: str) -> list[dict[str, Any]]:
    files = _folder_cache_data(app, remote_path).get("direct_files", [])
    return files if isinstance(files, list) else []


def _direct_folders(app: Any, remote_path: str) -> list[dict[str, Any]]:
    folders = _folder_cache_data(app, remote_path).get("direct_folders", [])
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
        "extension": Path(name).suffix.casefold(),
        "size": file_data.get("size"),
        "mtime": file_data.get("mtime"),
    }


def _library_endpoint(app: Any, query: str) -> tuple[HTTPStatus, dict]:
    params = parse_qs(query, keep_blank_values=True)
    root_rel_path = clean_rel_path(params.get("path", [""])[0])
    root_remote_path = remote_target(app.remote, root_rel_path)
    root_id = _folder_id(root_remote_path)
    listing_cache = getattr(app, "listing_cache", None)
    root_listing = listing_cache.get(root_remote_path) if listing_cache is not None else None
    root_direct_files = _direct_files(app, root_remote_path)
    root_direct_folders = _direct_folders(app, root_remote_path)

    root = {
        "id": root_id,
        "remote_path": root_remote_path,
        "rel_path": "",
        "stream_path": root_rel_path,
        "display_name": _display_name_for_root(root_rel_path),
    }

    if root_listing is None and not root_direct_files and not root_direct_folders:
        return HTTPStatus.OK, {
            "root": root,
            "status": {
                "cache_status": "unavailable",
                "complete": False,
                "message": "No cached listing is available for this folder yet.",
                "generated_at": time.time(),
                "missing_listing_count": 1,
            },
            "folders": [],
            "songs": [],
        }

    folders: list[dict[str, Any]] = []
    songs: list[dict[str, Any]] = []
    seen_song_remote_paths: set[str] = set()
    seen_folder_remote_paths: set[str] = set()
    missing_listing_count = 0

    def append_direct_file_songs(parent_id: str, folder_remote_path: str) -> None:
        for file_data in _direct_files(app, folder_remote_path):
            song = _song_from_direct_file(app, root_rel_path, parent_id, file_data)
            if song is None or song["remote_path"] in seen_song_remote_paths:
                continue
            seen_song_remote_paths.add(song["remote_path"])
            songs.append(song)

    def folder_node(parent_id: str, folder_rel_path: str, folder_stream_path: str, folder_remote_path: str, name: str, listing_cached: bool, metadata_cached: bool) -> dict[str, Any]:
        return {
            "id": _folder_id(folder_remote_path),
            "parent_id": parent_id,
            "remote_path": folder_remote_path,
            "rel_path": folder_rel_path,
            "stream_path": folder_stream_path,
            "display_name": name,
            "listing_cached": listing_cached,
            "metadata_cached": metadata_cached,
            "complete": _folder_complete(app, folder_remote_path),
        }

    def append_listing_song(parent_id: str, item_rel_path: str, item_stream_path: str, item_remote_path: str, item: dict[str, Any]) -> None:
        name = posixpath.basename(item_rel_path)
        if item_remote_path in seen_song_remote_paths or not _is_supported_song(name):
            return
        seen_song_remote_paths.add(item_remote_path)
        songs.append({
            "id": _song_id(item_remote_path),
            "parent_id": parent_id,
            "remote_path": item_remote_path,
            "stream_path": item_stream_path,
            "rel_path": item_rel_path,
            "display_name": name,
            "extension": Path(name).suffix.casefold(),
            "size": item.get("Size"),
            "mtime": parse_rclone_time(item.get("ModTime")),
        })

    def visit_metadata(parent_id: str, folder_rel_path: str, folder_remote_path: str) -> None:
        nonlocal missing_listing_count
        append_direct_file_songs(parent_id, folder_remote_path)
        for folder_data in _direct_folders(app, folder_remote_path):
            name = folder_data.get("name") or folder_data.get("path") or ""
            child_remote_path = folder_data.get("remote_path") or ""
            if not isinstance(name, str) or not isinstance(child_remote_path, str) or not name or child_remote_path in seen_folder_remote_paths:
                continue
            item_rel_path = child_remote_path_for_display(root_rel_path, folder_rel_path, name, child_remote_path)
            item_stream_path = _remote_rel_path(app.remote, child_remote_path)
            item_id = _folder_id(child_remote_path)
            seen_folder_remote_paths.add(child_remote_path)
            child_has_metadata = bool(_direct_files(app, child_remote_path) or _direct_folders(app, child_remote_path))
            child_listing = listing_cache.get(child_remote_path) if listing_cache is not None else None
            if child_listing is None and not child_has_metadata:
                missing_listing_count += 1
            folders.append(folder_node(parent_id, item_rel_path, item_stream_path, child_remote_path, name, child_listing is not None, child_has_metadata))
            if child_has_metadata:
                visit_metadata(item_id, item_rel_path, child_remote_path)
            elif child_listing is not None:
                visit(item_id, item_rel_path, child_remote_path, child_listing)

    def child_remote_path_for_display(root_rel_path: str, parent_rel_path: str, name: str, remote_path: str) -> str:
        stream_path = _remote_rel_path(app.remote, remote_path)
        if root_rel_path and stream_path.startswith(root_rel_path.rstrip("/") + "/"):
            return stream_path[len(root_rel_path.rstrip("/") + "/"):]
        return child_remote_path(parent_rel_path, name)

    def visit(parent_id: str, folder_rel_path: str, folder_remote_path: str, items: list[dict[str, Any]]) -> None:
        nonlocal missing_listing_count
        append_direct_file_songs(parent_id, folder_remote_path)
        for item in items:
            name = _item_name(item)
            if not name or "/" in name or is_ignored_name(name):
                continue
            item_rel_path = child_remote_path(folder_rel_path, name)
            item_stream_path = child_remote_path(root_rel_path, item_rel_path)
            item_remote_path = remote_target(app.remote, item_stream_path)
            if item.get("IsDir"):
                item_id = _folder_id(item_remote_path)
                if item_remote_path in seen_folder_remote_paths:
                    continue
                seen_folder_remote_paths.add(item_remote_path)
                child_listing = listing_cache.get(item_remote_path)
                metadata_cached = bool(_direct_files(app, item_remote_path) or _direct_folders(app, item_remote_path))
                listing_cached = child_listing is not None
                if not listing_cached and not metadata_cached:
                    missing_listing_count += 1
                folders.append(folder_node(parent_id, item_rel_path, item_stream_path, item_remote_path, name, listing_cached, metadata_cached))
                if metadata_cached:
                    visit_metadata(item_id, item_rel_path, item_remote_path)
                elif child_listing is not None:
                    visit(item_id, item_rel_path, item_remote_path, child_listing)
                continue
            append_listing_song(parent_id, item_rel_path, item_stream_path, item_remote_path, item)

    if root_listing is None:
        visit_metadata(root_id, "", root_remote_path)
    else:
        visit(root_id, "", root_remote_path, root_listing)
    complete = missing_listing_count == 0 and _folder_complete(app, root_remote_path)
    return HTTPStatus.OK, {
        "root": root,
        "status": {
            "cache_status": "complete" if complete else "partial",
            "complete": complete,
            "message": (
                "Cached library is complete."
                if complete
                else "Library may update as cached metadata arrives."
            ),
            "generated_at": time.time(),
            "missing_listing_count": missing_listing_count,
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
