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



class ListingMergeNameTests(AppTestCase):
    def test_cached_navigation_uses_windows_safe_local_name_matching(self) -> None:
        class DirectListingFolderCache:
            def get_direct_listing(self, _remote_path: str) -> list[dict]:
                return [
                    {
                        "Name": remote_name,
                        "Path": remote_name,
                        "IsDir": False,
                        "Size": len(b"audio"),
                        "ModTime": "2024-01-01T12:00:00Z",
                    },
                ]

        remote_name = "Sak Noel - Loca People (What the f*ck).mp3"
        local_name = "Sak Noel - Loca People (What the f\uff0ack).mp3"
        local_root = self.create_local_root({
            f"music/{local_name}": b"audio",
        })
        rclone = SimulatedRclone()
        app = DropboxBrowser(
            rclone,
            "dropbox:",
            local_root,
            folder_cache=DirectListingFolderCache(),
            listing_cache=ListingCacheManager(ttl_seconds=1800),
        )

        entries = app.list_entries("music")

        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["name"], remote_name)
        self.assertEqual(entries[0]["local_name"], local_name)
        self.assertEqual(entries[0]["local_path"], str(local_root / "music" / local_name))
        self.assertEqual(rclone.calls, [])

    def test_windows_safe_unicode_replacement_names_merge_for_page_and_live_status(self) -> None:
        remote_name = "Sak Noel - Loca People (What the f*ck).mp3"
        local_name = "Sak Noel - Loca People (What the f\uff0ack).mp3"
        local_root = self.create_local_root({
            f"music/{local_name}": b"audio",
        })
        rclone = SimulatedRclone({
            "dropbox:music": [SimulatedLsjsonResponse(items=[
                remote_file_item(remote_name, local_root / "music" / local_name),
            ])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            html = server.get_text("/?path=music")
            results = self._wait_folder_info(
                server,
                current="music",
                predicate=lambda data: data.get("music", {}).get("file_statuses", {}).get(remote_name),
            )
            info = results["music"]

        table_body = html.split("<tbody>", 1)[1].split("</tbody>", 1)[0]
        self.assertIn(remote_name, html)
        self.assertEqual(table_body.count("<tr"), 1)
        self.assertIn("Synced", table_body)
        self.assertNotIn("Dropbox Only", table_body)
        self.assertNotIn("Local Only", table_body)
        self.assertIn(f'data-copy-path="{local_root / "music" / local_name}"', html)
        self.assertNotIn(f'data-copy-path="{local_root / "music" / remote_name}"', html)
        self.assertEqual(info["file_statuses"], {remote_name: {"diff_status": "synced"}})

    def test_copy_filepath_uses_actual_local_unicode_replacement_name(self) -> None:
        remote_name = "*NSYNC - Bye Bye Bye.mp3"
        local_name = "\uff0aNSYNC - Bye Bye Bye.mp3"
        local_root = self.create_local_root({
            f"music/{local_name}": b"audio",
        })
        rclone = SimulatedRclone({
            "dropbox:music": [SimulatedLsjsonResponse(items=[
                remote_file_item(remote_name, local_root / "music" / local_name),
            ])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            html = server.get_text("/?path=music")

        self.assertIn(remote_name, html)
        self.assertIn(">Copy Filepath</button>", html)
        self.assertIn(f'data-copy-path="{local_root / "music" / local_name}"', html)
        self.assertNotIn(f'data-copy-path="{local_root / "music" / remote_name}"', html)

    def test_windows_safe_unicode_replacement_names_do_not_create_folder_cache_diffs(self) -> None:
        remote_name = "Sak Noel - Loca People (What the f*ck).mp3"
        local_name = "Sak Noel - Loca People (What the f\uff0ack).mp3"
        local_root = self.create_local_root({
            f"music/{local_name}": b"audio",
        })
        rclone = SimulatedRclone({
            "dropbox:music": [SimulatedLsjsonResponse(items=[
                remote_file_item(remote_name, local_root / "music" / local_name),
            ])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)
        cache = app.folder_cache
        assert cache is not None

        cache.request("dropbox:music", time.time())
        data = wait_until(
            lambda: cache.get("dropbox:music") if (cache.get("dropbox:music") or {}).get("complete") else None,
            description="unicode replacement folder completion",
        )

        self.assertEqual(data["diff_status"], "synced")
        self.assertEqual(data["file_statuses"], {remote_name: {"diff_status": "synced"}})
