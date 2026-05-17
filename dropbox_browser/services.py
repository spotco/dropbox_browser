from __future__ import annotations

from http import HTTPStatus
import shutil
from pathlib import Path
from typing import Any

from .errors import BrowserError
from .formatting import file_type, parse_rclone_time
from .ignored import is_ignored_name
from .listingcache import ListingCacheManager
from .namekeys import filename_compare_key
from .paths import remote_target, safe_join_local
from .rclone import RcloneClient


def diff_label(status: str | None) -> str:
    return {
        "synced": "Synced",
        "has_diffs": "Has Diffs",
        "dropbox_only": "Dropbox Only",
        "local_only": "Local Only",
        "loading": "Loading",
    }.get(status or "", "Loading")


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
            key = filename_compare_key(name)
            merged_keys[key] = name
            merged[name] = {
                "name": name,
                "remote_name": name,
                "local_name": None,
                "local_path": None,
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
                    compare_key = filename_compare_key(child.name)
                    key = merged_keys.get(compare_key, child.name)
                    merged_keys.setdefault(compare_key, key)
                    row = merged.setdefault(
                        key,
                        {
                            "name": child.name,
                            "remote_name": None,
                            "local_name": child.name,
                            "local_path": str(child),
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
                    row["local_name"] = child.name
                    row["local_path"] = str(child)
                    row["is_dir"] = bool(row["is_dir"] or child.is_dir())
                    row["local_size"] = None if child.is_dir() else stat.st_size
                    row["local_mtime"] = stat.st_mtime

        return list(merged.values())

    def local_display_path(self, rel_path: str) -> Path | None:
        """Return the actual local path for a displayed Dropbox-relative path.

        Names shown in the browser may come from Dropbox, while Windows local
        files can use compatibility replacements for characters such as ``*``.
        Walk each segment with the same comparison key used by listings so copy
        actions use the path that actually exists on disk when possible.
        """
        if self.local_root is None:
            return None
        current = self.local_root
        for part in [part for part in rel_path.split("/") if part]:
            if not current.exists() or not current.is_dir():
                return current / part
            wanted = filename_compare_key(part)
            try:
                match = next((child for child in current.iterdir() if filename_compare_key(child.name) == wanted), None)
            except OSError:
                match = None
            current = match if match is not None else current / part
        return current

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
            elif sort_key == "status":
                primary = row.get("status_label") or ""
            else:
                primary = name
            return (primary, name)

        folders = sorted((row for row in entries if row["is_dir"]), key=key, reverse=reverse)
        files = sorted((row for row in entries if not row["is_dir"]), key=key, reverse=reverse)
        return folders + files

    def status_label_for_entry(
        self,
        row: dict[str, Any],
        folder_cache_map: dict | None = None,
        current_folder_cache: dict | None = None,
    ) -> str:
        status = "Both" if row["remote"] and row["local"] else "Dropbox Only" if row["remote"] else "Local Only"
        if self.local_root is None:
            return status

        name = row["name"]
        if row["is_dir"]:
            if not row["remote"]:
                return "Local Only"
            if not row["local"]:
                return "Dropbox Only"
            cached = (folder_cache_map or {}).get(name)
            if cached is not None and cached.get("diff_complete"):
                return diff_label(cached.get("diff_status"))
            return "Loading"

        if not row["remote"]:
            return "Local Only"
        if not row["local"]:
            return "Dropbox Only"
        file_status = ((current_folder_cache or {}).get("file_statuses") or {}).get(name, {})
        return diff_label(file_status.get("diff_status"))

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

    def _direct_batch_rows(self, rel_path: str) -> list[dict[str, Any]]:
        entries = self.list_entries(rel_path, force_refresh=True)
        rows: list[dict[str, Any]] = []
        for row in entries:
            name = row["name"]
            child_path = f"{rel_path}/{name}" if rel_path else name
            if row["is_dir"]:
                if not row["remote"]:
                    rows.append({
                        "status": "local_only_dir",
                        "path": child_path,
                        "local_path": row.get("local_path") or str(safe_join_local(self.local_root, child_path)),
                        "remote_path": remote_target(self.remote, child_path),
                    })
                continue
            if not row["remote"]:
                rows.append({
                    "status": "local_only",
                    "path": child_path,
                    "local_path": row.get("local_path") or str(safe_join_local(self.local_root, child_path)),
                    "remote_path": remote_target(self.remote, child_path),
                })
            elif not row["local"]:
                rows.append({
                    "status": "dropbox_only",
                    "path": child_path,
                    "local_path": str(safe_join_local(self.local_root, child_path)),
                    "remote_path": remote_target(self.remote, child_path),
                })
            elif (row.get("remote_size") or 0) != (row.get("local_size") or 0):
                rows.append({
                    "status": "has_diffs",
                    "path": child_path,
                    "local_path": row.get("local_path") or str(safe_join_local(self.local_root, child_path)),
                    "remote_path": remote_target(self.remote, child_path),
                })
        return rows

    def _child_folder_paths(self, rel_path: str) -> list[str]:
        children: dict[str, str] = {}
        remote = remote_target(self.remote, rel_path)
        try:
            for item in self.rclone.lsjson(remote):
                name = item.get("Name") or item.get("Path") or ""
                if name and "/" not in name and not is_ignored_name(name) and item.get("IsDir"):
                    children[filename_compare_key(name)] = f"{rel_path}/{name}" if rel_path else name
        except BrowserError:
            pass
        local_folder = safe_join_local(self.local_root, rel_path) if self.local_root else None
        if local_folder is not None and local_folder.exists() and local_folder.is_dir():
            for child in local_folder.iterdir():
                if child.is_dir() and not is_ignored_name(child.name):
                    key = filename_compare_key(child.name)
                    children.setdefault(key, f"{rel_path}/{child.name}" if rel_path else child.name)
        return sorted(children.values(), key=str.casefold)

    def _batch_rows(self, rel_path: str, recursive: bool) -> list[dict[str, Any]]:
        if recursive:
            rows: list[dict[str, Any]] = []
            for child in self._child_folder_paths(rel_path):
                rows.extend(self._batch_rows(child, recursive=True))
            rows.extend(self._direct_batch_rows(rel_path))
        else:
            rows = self._direct_batch_rows(rel_path)
        return rows

    def plan_batch_sync(self, rel_path: str, action: str, recursive: bool) -> dict[str, Any]:
        if self.local_root is None:
            raise BrowserError(HTTPStatus.BAD_REQUEST, "Local comparison is not configured.")
        if action not in {"local_to_dropbox_all", "delete_local_only_all", "dropbox_only_to_local_all"}:
            raise BrowserError(HTTPStatus.BAD_REQUEST, "Unsupported batch sync action.")

        rows = self._batch_rows(rel_path, recursive)
        groups: dict[str, list[dict[str, str]]] = {
            "local_to_dropbox": [],
            "dropbox_to_local": [],
            "delete_local": [],
        }
        for row in rows:
            item = {
                "path": row["path"],
                "local_path": row["local_path"],
                "remote_path": row["remote_path"],
            }
            if action == "local_to_dropbox_all":
                if row["status"] in {"local_only", "has_diffs"}:
                    groups["local_to_dropbox"].append(item)
            elif action == "delete_local_only_all":
                if row["status"] in {"local_only", "local_only_dir"}:
                    groups["delete_local"].append(item)
            elif row["status"] == "dropbox_only":
                groups["dropbox_to_local"].append(item)
        return {
            "action": action,
            "recursive": recursive,
            "groups": groups,
            "total": sum(len(items) for items in groups.values()),
        }

    def run_batch_sync(self, plan: dict[str, Any], progress: Any | None = None) -> list[str]:
        errors: list[str] = []
        operations: list[tuple[str, dict[str, str]]] = []
        for kind in ("local_to_dropbox", "dropbox_to_local", "delete_local"):
            operations.extend((kind, item) for item in plan.get("groups", {}).get(kind, []))
        total = len(operations)
        for index, (kind, item) in enumerate(operations, start=1):
            rel_path = item["path"]
            local_path = Path(item["local_path"])
            remote_path = item["remote_path"]
            try:
                if kind == "local_to_dropbox":
                    command = f"rclone copyto -- {local_path} {remote_path}"
                    if progress:
                        progress(index, total, f"Copying local to Dropbox: {rel_path}", command)
                    self.rclone.copy_file_overwrite(local_path, remote_path)
                elif kind == "dropbox_to_local":
                    command = f"rclone copyto -- {remote_path} {local_path}"
                    if progress:
                        progress(index, total, f"Copying Dropbox to local: {rel_path}", command)
                    local_path.parent.mkdir(parents=True, exist_ok=True)
                    self.rclone.copy_file_overwrite(remote_path, local_path)
                else:
                    command = f"delete local -- {local_path}"
                    if progress:
                        progress(index, total, f"Deleting local-only item: {rel_path}", command)
                    if local_path.is_dir():
                        shutil.rmtree(local_path)
                    else:
                        local_path.unlink()
            except Exception as exc:
                errors.append(f"{rel_path}: {exc}")
        rels = {str(Path(item["path"]).parent).replace("\\", "/") for _, item in operations}
        for parent in rels:
            if parent == ".":
                parent = ""
            if self.listing_cache:
                self.listing_cache.invalidate(remote_target(self.remote, parent))
            self.invalidate_folder_metadata(parent)
        return errors

    def sync_item(self, rel_path: str, direction: str) -> None:
        if self.local_root is None:
            raise BrowserError(HTTPStatus.BAD_REQUEST, "Local comparison is not configured.")
        if direction not in {"local_to_dropbox", "dropbox_to_local"}:
            raise BrowserError(HTTPStatus.BAD_REQUEST, "Unsupported sync direction.")

        local_path = safe_join_local(self.local_root, rel_path)
        remote_path = remote_target(self.remote, rel_path)
        if direction == "local_to_dropbox":
            if not local_path.is_file():
                raise BrowserError(HTTPStatus.NOT_FOUND, "Local file not found.")
            self.rclone.copy_file_overwrite(local_path, remote_path)
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
        self.invalidate_folder_metadata(parent_rel)
