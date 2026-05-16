from __future__ import annotations

from http import HTTPStatus
from pathlib import Path
from typing import Any

from .errors import BrowserError
from .formatting import file_type, parse_rclone_time
from .ignored import is_ignored_name
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
        merged_keys: dict[str, str] = {}
        remote = remote_target(self.remote, rel_path)
        local_folder = safe_join_local(self.local_root, rel_path) if self.local_root else None

        remote_items = None
        if self.listing_cache and not force_refresh:
            remote_items = self.listing_cache.get(remote)
        if remote_items is None:
            try:
                remote_items = self.rclone.lsjson(remote)
            except BrowserError:
                if not (local_folder and local_folder.exists() and local_folder.is_dir()):
                    raise
                remote_items = []
            else:
                if self.listing_cache:
                    self.listing_cache.set(remote, remote_items)

        for item in remote_items:
            name = item.get("Name") or item.get("Path") or ""
            if not name or "/" in name or is_ignored_name(name):
                continue
            is_dir = bool(item.get("IsDir"))
            key = name.casefold()
            merged_keys[key] = name
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

        if local_folder:
            if local_folder.exists() and local_folder.is_dir():
                for child in local_folder.iterdir():
                    if is_ignored_name(child.name):
                        continue
                    stat = child.stat()
                    key = merged_keys.get(child.name.casefold(), child.name)
                    merged_keys.setdefault(child.name.casefold(), key)
                    row = merged.setdefault(
                        key,
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

    def invalidate_folder_metadata(self, rel_path: str) -> None:
        """Invalidate cached folder totals for this folder and its ancestors."""
        if not self.folder_cache:
            return
        parts = [part for part in rel_path.split("/") if part]
        rel_paths = ["/".join(parts[:i]) for i in range(len(parts), -1, -1)]
        for path in rel_paths:
            self.folder_cache.invalidate(remote_target(self.remote, path))

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

    def file_statuses_for_entries(self, entries: list[dict[str, Any]]) -> dict[str, dict[str, str]]:
        """Compute direct file diff status from the live merged listing.

        Folder subtree status is cached, but file rows can be compared cheaply
        from the current direct Dropbox listing and local stat data. This keeps
        local edits made outside the browser from being hidden by stale folder
        cache entries.
        """
        if self.local_root is None:
            return {}
        statuses: dict[str, dict[str, str]] = {}
        for row in entries:
            if row["is_dir"]:
                continue
            name = row["name"]
            if not row["remote"]:
                statuses[name] = {"diff_status": "local_only", "reason": f"Local only: {name}"}
            elif not row["local"]:
                statuses[name] = {"diff_status": "dropbox_only", "reason": f"Dropbox only: {name}"}
            elif (row.get("remote_size") or 0) != (row.get("local_size") or 0):
                statuses[name] = {"diff_status": "has_diffs", "reason": f"Size differs: {name}"}
            else:
                statuses[name] = {"diff_status": "synced"}
        return statuses

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
        self.invalidate_folder_metadata(rel_path)

    def sync_item(self, rel_path: str, direction: str, kind: str) -> None:
        if self.local_root is None:
            raise BrowserError(HTTPStatus.BAD_REQUEST, "Local comparison is not configured.")
        if direction not in {"local_to_dropbox", "dropbox_to_local"}:
            raise BrowserError(HTTPStatus.BAD_REQUEST, "Unsupported sync direction.")
        if kind not in {"file", "folder"}:
            raise BrowserError(HTTPStatus.BAD_REQUEST, "Unsupported sync item type.")

        local_path = safe_join_local(self.local_root, rel_path)
        remote_path = remote_target(self.remote, rel_path)
        if direction == "local_to_dropbox":
            if kind == "folder":
                if not local_path.is_dir():
                    raise BrowserError(HTTPStatus.NOT_FOUND, "Local folder not found.")
                self.rclone.copy_folder_overwrite(local_path, remote_path)
            else:
                if not local_path.is_file():
                    raise BrowserError(HTTPStatus.NOT_FOUND, "Local file not found.")
                self.rclone.copy_file_overwrite(local_path, remote_path)
        else:
            if kind == "folder":
                local_path.mkdir(parents=True, exist_ok=True)
                self.rclone.copy_folder_overwrite(remote_path, local_path)
            else:
                local_path.parent.mkdir(parents=True, exist_ok=True)
                self.rclone.copy_file_overwrite(remote_path, local_path)

        # Sync is copy-only: it overwrites destination files selected by the
        # user, but intentionally never deletes destination-only files.
        parent_rel = str(Path(rel_path).parent).replace("\\", "/")
        if parent_rel == ".":
            parent_rel = ""
        if self.listing_cache:
            self.listing_cache.invalidate(remote_target(self.remote, parent_rel))
            if kind == "folder":
                self.listing_cache.invalidate(remote_path)
        self.invalidate_folder_metadata(parent_rel)
        if kind == "folder":
            self.invalidate_folder_metadata(rel_path)
