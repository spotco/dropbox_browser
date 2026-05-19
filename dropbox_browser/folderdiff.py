"""Direct Dropbox/local folder diff helpers for folder-cache workers."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .ignored import is_ignored_name
from .windows_names import match_dropbox_names_to_local_names

DIFF_LOADING = "loading"
DIFF_SYNCED = "synced"
DIFF_HAS_DIFFS = "has_diffs"
DIFF_DROPBOX_ONLY = "dropbox_only"
DIFF_UNAVAILABLE = "unavailable"


@dataclass(frozen=True)
class LocalChild:
    name: str
    is_dir: bool | None = None
    size: int | None = None
    readable: bool = True
    path: Path | None = None


@dataclass(frozen=True)
class LocalChildrenSnapshot:
    folder_exists: bool
    children: dict[str, LocalChild]


@dataclass(frozen=True)
class DirectDiffResult:
    diff_reason: str | None
    diff_status: str
    file_statuses: dict[str, dict[str, str]]


def enumerate_local_children(local_folder: Path | None) -> LocalChildrenSnapshot:
    """Return ignored-name-filtered local child metadata for one folder."""
    if local_folder is None or not local_folder.exists() or not local_folder.is_dir():
        return LocalChildrenSnapshot(folder_exists=False, children={})
    children: dict[str, LocalChild] = {}
    try:
        local_paths = list(local_folder.iterdir())
    except OSError:
        return LocalChildrenSnapshot(folder_exists=True, children={})
    for child in local_paths:
        if is_ignored_name(child.name):
            continue
        children[child.name] = LocalChild(
            name=child.name,
            path=child,
        )
    return LocalChildrenSnapshot(folder_exists=True, children=children)


def _local_child_is_dir(child: LocalChild) -> bool:
    if child.is_dir is not None:
        return child.is_dir
    if child.path is None:
        return False
    return child.path.is_dir()


def _local_child_size(child: LocalChild) -> int | None:
    if child.size is not None:
        return child.size
    if child.path is None:
        return None
    try:
        return child.path.stat().st_size
    except OSError:
        return None


def compare_direct_children(
    remote_children: dict[str, dict[str, Any]],
    local_children: dict[str, LocalChild],
    *,
    local_folder_exists: bool,
) -> DirectDiffResult:
    """Compare one direct Dropbox listing against one local folder snapshot."""
    diff_reason: str | None = None
    diff_status = DIFF_SYNCED
    file_statuses: dict[str, dict[str, str]] = {}

    def set_direct_diff(reason: str, status: str = DIFF_HAS_DIFFS) -> None:
        nonlocal diff_reason, diff_status
        if diff_reason is None:
            diff_reason = reason
            diff_status = status

    matches = match_dropbox_names_to_local_names(remote_children, local_children)
    matched_local_names = set(matches.values())
    missing_local = sorted((name for name in remote_children if name not in matches), key=str.casefold)
    missing_remote = sorted((name for name in local_children if name not in matched_local_names), key=str.casefold)

    if not local_folder_exists:
        set_direct_diff("Dropbox only", DIFF_DROPBOX_ONLY)
    if missing_local or missing_remote:
        if missing_local and not missing_remote and not local_children:
            set_direct_diff("Dropbox only", DIFF_DROPBOX_ONLY)
        elif missing_local:
            item = remote_children[missing_local[0]]
            set_direct_diff(f"Dropbox only: {item.get('Name') or item.get('Path')}")
        elif missing_remote:
            set_direct_diff(f"Local only: {local_children[missing_remote[0]].name}")

    for remote_name in sorted(matches, key=str.casefold):
        item = remote_children[remote_name]
        child = local_children[matches[remote_name]]
        name = item.get("Name") or item.get("Path") or child.name
        remote_is_dir = bool(item.get("IsDir"))
        local_is_dir = _local_child_is_dir(child)
        if remote_is_dir != local_is_dir:
            reason = f"Type differs: {name}"
            set_direct_diff(reason)
            if not remote_is_dir:
                file_statuses[name] = {"diff_status": DIFF_HAS_DIFFS, "reason": reason}
            continue
        if remote_is_dir:
            continue
        local_size = _local_child_size(child)
        if not child.readable or local_size is None:
            reason = f"Local unreadable: {name}"
            set_direct_diff(reason)
            file_statuses[name] = {"diff_status": DIFF_HAS_DIFFS, "reason": reason}
            continue
        remote_size = item.get("Size") or 0
        if remote_size != local_size:
            reason = f"Size differs: {name}"
            set_direct_diff(reason)
            file_statuses[name] = {"diff_status": DIFF_HAS_DIFFS, "reason": reason}
            continue
        file_statuses[name] = {"diff_status": DIFF_SYNCED}

    return DirectDiffResult(
        diff_reason=diff_reason,
        diff_status=diff_status,
        file_statuses=file_statuses,
    )
