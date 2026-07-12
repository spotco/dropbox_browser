"""Music player endpoint helpers."""
from __future__ import annotations

from http import HTTPStatus
from typing import Any
from urllib.parse import parse_qs

from .errors import BrowserError
from .media_library import build_recursive_library_payload
from .paths import clean_rel_path


MUSIC_ENDPOINT_PREFIX = "/music/endpoints/"
SUPPORTED_AUDIO_EXTENSIONS = (".mp3", ".m4a", ".aac", ".wav")


def _library_endpoint(app: Any, query: str) -> tuple[HTTPStatus, dict]:
    params = parse_qs(query, keep_blank_values=True)
    root_rel_path = clean_rel_path(params.get("path", [""])[0])
    payload = build_recursive_library_payload(
        app,
        rel_path=root_rel_path,
        supported_extensions=SUPPORTED_AUDIO_EXTENSIONS,
        id_prefix="song",
        include_songs_key=True,
        include_items_key=True,
    )
    return HTTPStatus.OK, payload


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
