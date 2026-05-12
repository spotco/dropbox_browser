from __future__ import annotations

from http import HTTPStatus
from pathlib import Path
from typing import Any

from .errors import BrowserError
from .formatting import file_type, parse_rclone_time
from .listingcache import ListingCacheManager
from .paths import child_remote_path, remote_target, safe_join_local
from .rclone import RcloneClient


class DropboxBrowser:
    def __init__(self, rclone: RcloneClient, remote: str, local_root: Path | None, folder_cache: Any = None, listing_cache: ListingCacheManager | None = None):
        self.rclone = rclone
        self.remote = remote
        self.local_root = local_root.resolve() if local_root else None
        self.folder_cache = folder_cache
        self.listing_cache = listing_cache

    def list_entries(self, rel_path: str, force_refresh: bool = False) -> list[dict[str, Any]]:
        merged: dict[str, dict[str, Any]] = {}
        remote = remote_target(self.remote, rel_path)

        remote_items = None
        if self.listing_cache and not force_refresh:
            remote_items = self.listing_cache.get(remote)
        if remote_items is None:
            remote_items = self.rclone.lsjson(remote)
            if self.listing_cache:
                self.listing_cache.set(remote, remote_items)

        for item in remote_items:
            name = item.get("Name") or item.get("Path") or ""
            if not name or "/" in name:
                continue
            is_dir = bool(item.get("IsDir"))
            merged[name] = {
                "name": name,
                "is_dir": is_dir,
                "remote": True,
                "local": False,
                "remote_size": None if is_dir else item.get("Size"),
                "local_size": None,
                "remote_mtime": parse_rclone_time(item.get("ModTime")),
                "local_mtime": None,
            }

        if self.local_root:
            local_folder = safe_join_local(self.local_root, rel_path)
            if local_folder.exists() and local_folder.is_dir():
                for child in local_folder.iterdir():
                    stat = child.stat()
                    row = merged.setdefault(
                        child.name,
                        {
                            "name": child.name,
                            "is_dir": child.is_dir(),
                            "remote": False,
                            "local": False,
                            "remote_size": None,
                            "local_size": None,
                            "remote_mtime": None,
                            "local_mtime": None,
                        },
                    )
                    row["local"] = True
                    row["is_dir"] = bool(row["is_dir"] or child.is_dir())
                    row["local_size"] = None if child.is_dir() else stat.st_size
                    row["local_mtime"] = stat.st_mtime

        return list(merged.values())

    def sort_entries(self, entries: list[dict[str, Any]], sort_key: str, direction: str) -> list[dict[str, Any]]:
        reverse = direction == "desc"

        def key(row: dict[str, Any]) -> tuple[Any, str]:
            name = row["name"].lower()
            if sort_key == "type":
                primary = file_type(row["name"], row["is_dir"])
            elif sort_key == "date":
                primary = max(row.get("remote_mtime") or 0, row.get("local_mtime") or 0)
            elif sort_key == "size":
                if row["is_dir"]:
                    primary = row.get("cached_size") or 0
                else:
                    primary = row.get("remote_size") or row.get("local_size") or 0
            else:
                primary = name
            return (primary, name)

        folders = sorted((row for row in entries if row["is_dir"]), key=key, reverse=reverse)
        files = sorted((row for row in entries if not row["is_dir"]), key=key, reverse=reverse)
        return folders + files

    def name_exists_in_folder(self, rel_path: str, filename: str) -> tuple[bool, str | None]:
        remote_file = child_remote_path(rel_path, filename)
        if self.rclone.exists(remote_target(self.remote, remote_file)):
            return True, "Dropbox already has an item with that name."
        if self.local_root:
            local_file = safe_join_local(self.local_root, remote_file)
            if local_file.exists():
                return True, "The local folder already has an item with that name."
        return False, None

    def upload_new_file(self, rel_path: str, filename: str, temp_file: Path) -> None:
        filename = Path(filename).name
        if not filename:
            raise BrowserError(HTTPStatus.BAD_REQUEST, "The upload needs a filename.")
        exists, reason = self.name_exists_in_folder(rel_path, filename)
        if exists:
            raise BrowserError(HTTPStatus.CONFLICT, reason or "That name already exists.")
        remote_file = child_remote_path(rel_path, filename)
        self.rclone.copy_file_to_remote(temp_file, remote_target(self.remote, remote_file))
        if self.listing_cache:
            self.listing_cache.invalidate(remote_target(self.remote, rel_path))
