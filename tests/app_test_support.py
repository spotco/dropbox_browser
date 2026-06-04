from __future__ import annotations

import time
from pathlib import Path
from urllib.parse import quote

from dropbox_browser.foldercache import FolderCacheManager
from dropbox_browser.listingcache import ListingCacheManager
from dropbox_browser.services import DropboxBrowser
from dropbox_browser.syncjobs import SyncJobManager

try:
    from tests.support import IsolatedPathsTestCase, SimulatedLsjsonResponse, SimulatedRclone, wait_until
except ImportError:
    from support import IsolatedPathsTestCase, SimulatedLsjsonResponse, SimulatedRclone, wait_until


class PreloadedFolderCache:
    def __init__(self, _rclone, workers=None, ttl_seconds=None, listing_cache=None, local_root=None, remote=None, **_kwargs):
        self._data = {
            "dropbox:older": {
                "complete": False,
                "size": 0,
                "file_count": 0,
                "newest_mtime": 1704067200.0,  # 2024-01-01
            },
            "dropbox:newer": {
                "complete": False,
                "size": 0,
                "file_count": 0,
                "newest_mtime": 1735689600.0,  # 2025-01-01
            },
        }
        self.requests: list[str] = []

    def notify_page_load(self, *_args, **_kwargs) -> None:
        return None

    def invalidate(self, remote_path: str) -> None:
        self._data.pop(remote_path, None)

    def get(self, remote_path: str) -> dict | None:
        data = self._data.get(remote_path)
        return dict(data) if data is not None else None

    def request(self, remote_path: str, *_args, **_kwargs) -> None:
        self.requests.append(remote_path)


class RecordingFolderCache:
    def __init__(self) -> None:
        self.notified: list[tuple[float, str | None, bool]] = []
        self.invalidated: list[str] = []
        self.invalidated_trees: list[str] = []
        self.requests: list[str] = []

    def notify_page_load(self, page_time: float, *, page_key: str | None = None, force: bool = False) -> None:
        self.notified.append((page_time, page_key, force))

    def invalidate(self, remote_path: str) -> None:
        self.invalidated.append(remote_path)

    def invalidate_tree(self, remote_path: str) -> list[str]:
        self.invalidated_trees.append(remote_path)
        return [remote_path, remote_path.rstrip("/") + "/child"]

    def request(self, remote_path: str, *_args, **_kwargs) -> None:
        self.requests.append(remote_path)


class AppTestCase(IsolatedPathsTestCase):
    def _build_app(
        self,
        rclone: SimulatedRclone,
        local_root: Path | None = None,
        workers: int = 2,
        sync_workers: int = 2,
        manager_cls=FolderCacheManager,
        **manager_kwargs,
    ) -> DropboxBrowser:
        listing_cache = ListingCacheManager(ttl_seconds=1800)
        folder_cache = manager_cls(
            rclone,
            workers=workers,
            ttl_seconds=86400,
            listing_cache=listing_cache,
            local_root=local_root,
            remote="dropbox:",
            **manager_kwargs,
        )
        app = DropboxBrowser(rclone, "dropbox:", local_root, folder_cache=folder_cache, listing_cache=listing_cache)
        app.sync_jobs = SyncJobManager(app, workers=sync_workers)
        self.addCleanup(app.shutdown)
        return app

    def _wait_folder_info(self, server, *, paths: list[str] | None = None, current: str | None = None, predicate=None):
        query_parts: list[str] = []
        if paths:
            query_parts.extend("paths=" + quote(path) for path in paths)
        if current is not None:
            query_parts.append("current=" + quote(current))
        path = "/folder-info"
        if query_parts:
            path += "?" + "&".join(query_parts)
        payload_holder = {}

        def _ready():
            payload_holder["value"] = server.get_json(path)["results"]
            return predicate(payload_holder["value"]) if predicate is not None else payload_holder["value"]

        try:
            wait_until(_ready, description=f"folder-info response for {path}")
        except AssertionError as exc:
            raise AssertionError(f"{exc}; last payload: {payload_holder.get('value')!r}") from exc
        return payload_holder["value"]

    def _remote_media_rclone(self) -> SimulatedRclone:
        return SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[{
                "Name": "movie.mp4",
                "Path": "movie.mp4",
                "IsDir": False,
                "Size": 10,
                "ModTime": "2024-01-01T12:00:00Z",
            }])],
            "dropbox:movie.mp4": [SimulatedLsjsonResponse(items=[{
                "Name": "movie.mp4",
                "Path": "movie.mp4",
                "IsDir": False,
                "Size": 10,
            }])],
        }, cat_data={"dropbox:movie.mp4": b"0123456789"})
