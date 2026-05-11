from __future__ import annotations

from http import HTTPStatus
from pathlib import Path
import posixpath
from urllib.parse import unquote

from .errors import BrowserError


def clean_rel_path(raw: str | None) -> str:
    if not raw:
        return ""
    raw = unquote(raw).replace("\\", "/")
    parts: list[str] = []
    for part in raw.split("/"):
        if not part or part == ".":
            continue
        if part == "..":
            raise BrowserError(HTTPStatus.BAD_REQUEST, "Parent path segments are not allowed.")
        parts.append(part)
    return "/".join(parts)


def safe_join_local(root: Path, rel_path: str) -> Path:
    candidate = (root / Path(*rel_path.split("/")) if rel_path else root).resolve()
    root_resolved = root.resolve()
    if candidate != root_resolved and root_resolved not in candidate.parents:
        raise BrowserError(HTTPStatus.BAD_REQUEST, "Path escapes the configured local folder.")
    return candidate


def remote_target(remote: str, rel_path: str) -> str:
    remote = remote.rstrip("/")
    if not rel_path:
        return remote
    return f"{remote.rstrip(':')}:{rel_path}" if remote.endswith(":") else f"{remote}/{rel_path}"


def child_remote_path(rel_path: str, name: str) -> str:
    return posixpath.join(rel_path, name) if rel_path else name
