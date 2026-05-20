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


def _library_endpoint(app: Any, query: str) -> tuple[HTTPStatus, dict]:
    params = parse_qs(query, keep_blank_values=True)
    root_rel_path = clean_rel_path(params.get("path", [""])[0])
    root_remote_path = remote_target(app.remote, root_rel_path)
    root_id = _folder_id(root_remote_path)
    listing_cache = getattr(app, "listing_cache", None)
    root_listing = listing_cache.get(root_remote_path) if listing_cache is not None else None

    root = {
        "id": root_id,
        "remote_path": root_remote_path,
        "rel_path": "",
        "stream_path": root_rel_path,
        "display_name": _display_name_for_root(root_rel_path),
    }

    if root_listing is None:
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
    missing_listing_count = 0

    def visit(parent_id: str, folder_rel_path: str, folder_remote_path: str, items: list[dict[str, Any]]) -> None:
        nonlocal missing_listing_count
        for item in items:
            name = _item_name(item)
            if not name or "/" in name or is_ignored_name(name):
                continue
            item_rel_path = child_remote_path(folder_rel_path, name)
            item_stream_path = child_remote_path(root_rel_path, item_rel_path)
            item_remote_path = remote_target(app.remote, item_stream_path)
            if item.get("IsDir"):
                item_id = _folder_id(item_remote_path)
                child_listing = listing_cache.get(item_remote_path)
                listing_cached = child_listing is not None
                if not listing_cached:
                    missing_listing_count += 1
                folders.append({
                    "id": item_id,
                    "parent_id": parent_id,
                    "remote_path": item_remote_path,
                    "rel_path": item_rel_path,
                    "stream_path": item_stream_path,
                    "display_name": name,
                    "listing_cached": listing_cached,
                    "complete": _folder_complete(app, item_remote_path),
                })
                if child_listing is not None:
                    visit(item_id, item_rel_path, item_remote_path, child_listing)
                continue
            if not _is_supported_song(name):
                continue
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
