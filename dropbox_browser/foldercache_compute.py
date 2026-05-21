"""Pure helpers for deriving folder-cache metadata from direct listings."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .formatting import parse_rclone_time
from .ignored import is_ignored_name


@dataclass(frozen=True)
class DirectListingMetadata:
    direct_size: int
    direct_count: int
    direct_mtime: float | None
    subfolders: list[str]
    remote_children: dict[str, dict[str, Any]]
    direct_items: list[dict[str, Any]]
    direct_files: list[dict[str, Any]]
    direct_folders: list[dict[str, Any]]


def parse_direct_listing(items: list[dict[str, Any]], remote_path: str) -> DirectListingMetadata:
    """Return direct folder metadata from one non-recursive rclone lsjson listing."""
    direct_size = 0
    direct_count = 0
    direct_mtime: float | None = None
    subfolders: list[str] = []
    remote_children: dict[str, dict[str, Any]] = {}
    direct_items: list[dict[str, Any]] = []
    direct_files: list[dict[str, Any]] = []
    direct_folders: list[dict[str, Any]] = []

    for item in items:
        name = item.get("Name") or item.get("Path") or ""
        if not name or "/" in name or is_ignored_name(name):
            continue
        remote_children[name] = item
        direct_items.append(dict(item))
        item_time = parse_rclone_time(item.get("ModTime"))
        if item_time and (direct_mtime is None or item_time > direct_mtime):
            direct_mtime = item_time
        if item.get("IsDir"):
            folder_name = item.get("Path") or item.get("Name", "")
            if folder_name:
                folder_remote_path = remote_path + folder_name if remote_path.endswith(":") else remote_path.rstrip("/") + "/" + folder_name
                subfolders.append(folder_remote_path)
                direct_folders.append({
                    "name": name,
                    "path": name,
                    "remote_path": folder_remote_path,
                    "mtime": item_time,
                })
        else:
            size = item.get("Size") or 0
            if size > 0:
                direct_size += size
            direct_count += 1
            file_remote_path = remote_path + name if remote_path.endswith(":") else remote_path.rstrip("/") + "/" + name
            direct_files.append({
                "name": name,
                "path": name,
                "remote_path": file_remote_path,
                "extension": Path(name).suffix.casefold(),
                "size": item.get("Size"),
                "mtime": item_time,
            })

    return DirectListingMetadata(
        direct_size=direct_size,
        direct_count=direct_count,
        direct_mtime=direct_mtime,
        subfolders=subfolders,
        remote_children=remote_children,
        direct_items=direct_items,
        direct_files=direct_files,
        direct_folders=direct_folders,
    )
