from __future__ import annotations

import json
import threading
import time
from http import HTTPStatus
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

from dropbox_browser.errors import BrowserError
from dropbox_browser.foldercache import DIFF_CACHE_SCHEMA_VERSION
from dropbox_browser.listingcache import ListingCacheManager
from dropbox_browser.services import DropboxBrowser

try:
    from tests.app_test_support import AppTestCase, PreloadedFolderCache, RecordingFolderCache
    from tests.support import SimulatedLsjsonResponse, SimulatedRclone, TestServer, remote_dir_item, remote_file_item, wait_until
except ImportError:
    from app_test_support import AppTestCase, PreloadedFolderCache, RecordingFolderCache
    from support import SimulatedLsjsonResponse, SimulatedRclone, TestServer, remote_dir_item, remote_file_item, wait_until



class CacheInvalidationTests(AppTestCase):
    def test_list_entries_uses_folder_cache_direct_listing_when_listing_cache_misses(self) -> None:
        class DirectListingFolderCache:
            def __init__(self) -> None:
                self.requests: list[str] = []

            def get_direct_listing(self, remote_path: str) -> list[dict]:
                self.requests.append(remote_path)
                return [
                    {
                        "Name": "cached.txt",
                        "Path": "cached.txt",
                        "IsDir": False,
                        "Size": 6,
                        "ModTime": "2024-01-01T12:00:00Z",
                    },
                ]

        rclone = SimulatedRclone()
        listing_cache = ListingCacheManager(ttl_seconds=1800)
        folder_cache = DirectListingFolderCache()
        app = DropboxBrowser(rclone, "dropbox:", None, folder_cache=folder_cache, listing_cache=listing_cache)

        entries = app.list_entries("")

        self.assertEqual([entry["name"] for entry in entries], ["cached.txt"])
        self.assertEqual(entries[0]["remote_size"], 6)
        self.assertEqual(folder_cache.requests, ["dropbox:"])
        self.assertEqual(rclone.calls, [])

    def test_list_entries_force_refresh_bypasses_folder_cache_direct_listing(self) -> None:
        class DirectListingFolderCache:
            def __init__(self) -> None:
                self.requests: list[str] = []

            def get_direct_listing(self, remote_path: str) -> list[dict]:
                self.requests.append(remote_path)
                return [
                    {
                        "Name": "cached.txt",
                        "Path": "cached.txt",
                        "IsDir": False,
                        "Size": 6,
                        "ModTime": "2024-01-01T12:00:00Z",
                    },
                ]

        rclone = SimulatedRclone({
            "dropbox:": [
                SimulatedLsjsonResponse(items=[
                    {
                        "Name": "fresh.txt",
                        "Path": "fresh.txt",
                        "IsDir": False,
                        "Size": 9,
                        "ModTime": "2024-01-02T12:00:00Z",
                    },
                ]),
            ],
        })
        listing_cache = ListingCacheManager(ttl_seconds=1800)
        listing_cache.set("dropbox:", [
            {
                "Name": "listing-cache.txt",
                "Path": "listing-cache.txt",
                "IsDir": False,
                "Size": 1,
                "ModTime": "2024-01-01T12:00:00Z",
            },
        ])
        folder_cache = DirectListingFolderCache()
        app = DropboxBrowser(rclone, "dropbox:", None, folder_cache=folder_cache, listing_cache=listing_cache)

        entries = app.list_entries("", force_refresh=True)

        self.assertEqual([entry["name"] for entry in entries], ["fresh.txt"])
        self.assertEqual(folder_cache.requests, [])
        self.assertEqual([call["target"] for call in rclone.calls], ["dropbox:"])

    def test_refresh_cache_post_invalidates_current_folder_only(self) -> None:
        rclone = SimulatedRclone()
        listing_cache = ListingCacheManager(ttl_seconds=1800)
        folder_cache = RecordingFolderCache()
        app = DropboxBrowser(rclone, "dropbox:", None, folder_cache=folder_cache, listing_cache=listing_cache)
        listing_cache.set("dropbox:music", [{"Name": "old.txt"}])
        listing_cache.set("dropbox:music/child", [{"Name": "child.txt"}])

        with TestServer(app) as server:
            payload = server.post_json("/refresh-cache", {"path": "music", "recursive": "0"})

        self.assertEqual(payload["status"], "refreshing")
        self.assertFalse(payload["recursive"])
        self.assertIn("dropbox:music", payload["invalidated"])
        self.assertIsNone(listing_cache.get("dropbox:music"))
        self.assertIsNotNone(listing_cache.get("dropbox:music/child"))
        self.assertEqual(folder_cache.invalidated, ["dropbox:music"])
        self.assertEqual(folder_cache.invalidated_trees, [])
        self.assertEqual(folder_cache.requests, ["dropbox:music"])
        self.assertEqual(folder_cache.notified[0][1:], ("music", True))

    def test_refresh_cache_post_with_shift_invalidates_known_children(self) -> None:
        rclone = SimulatedRclone()
        listing_cache = ListingCacheManager(ttl_seconds=1800)
        folder_cache = RecordingFolderCache()
        app = DropboxBrowser(rclone, "dropbox:", None, folder_cache=folder_cache, listing_cache=listing_cache)
        listing_cache.set("dropbox:music", [{"Name": "old.txt"}])
        listing_cache.set("dropbox:music/child", [{"Name": "child.txt"}])
        listing_cache.set("dropbox:other", [{"Name": "other.txt"}])

        with TestServer(app) as server:
            payload = server.post_json("/refresh-cache", {"path": "music", "recursive": "1"})

        self.assertTrue(payload["recursive"])
        self.assertEqual(folder_cache.invalidated, [])
        self.assertEqual(folder_cache.invalidated_trees, ["dropbox:music"])
        self.assertIsNone(listing_cache.get("dropbox:music"))
        self.assertIsNone(listing_cache.get("dropbox:music/child"))
        self.assertIsNotNone(listing_cache.get("dropbox:other"))
        self.assertEqual(folder_cache.requests, ["dropbox:music"])

    def test_folder_cache_invalidate_tree_removes_current_and_known_child_files(self) -> None:
        rclone = SimulatedRclone()
        app = self._build_app(rclone, local_root=None, workers=1)
        cache = app.folder_cache
        assert cache is not None
        for remote_path in ("dropbox:music", "dropbox:music/child", "dropbox:other"):
            cache_file = cache._cache_path(remote_path)
            cache_file.parent.mkdir(parents=True, exist_ok=True)
            cache_file.write_text(json.dumps({
                "remote_path": remote_path,
                "schema_version": DIFF_CACHE_SCHEMA_VERSION,
                "local_root": None,
                "cached_at": time.time(),
                "complete": True,
                "diff_complete": True,
            }), encoding="utf-8")
        with cache._lock:
            cache._acc["dropbox:music/live"] = {}
            cache._direct_done["dropbox:music/live"] = time.time()

        invalidated = cache.invalidate_tree("dropbox:music")

        self.assertEqual(invalidated, ["dropbox:music", "dropbox:music/child", "dropbox:music/live"])
        self.assertFalse(cache._cache_path("dropbox:music").exists())
        self.assertFalse(cache._cache_path("dropbox:music/child").exists())
        self.assertTrue(cache._cache_path("dropbox:other").exists())
        self.assertNotIn("dropbox:music/live", cache._acc)

    def test_manual_refresh_invalidates_current_folder_metadata_cache(self) -> None:
        local_root = self.create_local_root({
            "dropbox_browser_test/audio_urls.txt": b"old urls",
        })
        changed_remote = {
            "Name": "audio_urls.txt",
            "Path": "audio_urls.txt",
            "IsDir": False,
            "Size": len(b"changed remote urls"),
            "ModTime": "2024-01-01T12:00:00Z",
        }
        rclone = SimulatedRclone({
            "dropbox:dropbox_browser_test": [
                SimulatedLsjsonResponse(items=[
                    remote_file_item("audio_urls.txt", local_root / "dropbox_browser_test" / "audio_urls.txt"),
                ]),
                SimulatedLsjsonResponse(items=[changed_remote]),
            ],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)
        cache = app.folder_cache
        assert cache is not None

        with TestServer(app) as server:
            server.get_text("/?path=dropbox_browser_test")
            self._wait_folder_info(
                server,
                current="dropbox_browser_test",
                predicate=lambda data: data.get("dropbox_browser_test", {}).get("diff_status") == "synced",
            )

            html = server.get_text("/?path=dropbox_browser_test&refresh=1")
            data = wait_until(
                lambda: cache.get("dropbox:dropbox_browser_test")
                if (cache.get("dropbox:dropbox_browser_test") or {}).get("diff_status") == "has_diffs"
                else None,
                description="refreshed folder diff recompute",
            )

        self.assertIn("Has Diffs", html)
        self.assertEqual(data["file_statuses"]["audio_urls.txt"]["diff_status"], "has_diffs")
        self.assertGreaterEqual(
            sum(1 for call in rclone.calls if call["target"] == "dropbox:dropbox_browser_test"),
            2,
        )
