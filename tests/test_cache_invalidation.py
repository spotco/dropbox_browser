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
    def test_browse_listing_endpoint_trace_includes_cache_counts_and_client_render_flag(self) -> None:
        class TracedFolderCache:
            def __init__(self) -> None:
                self.notified: list[tuple[str | None, bool]] = []

            def notify_page_load(self, _page_time: float, *, page_key: str | None = None, force: bool = False) -> None:
                self.notified.append((page_key, force))

            def invalidate(self, _remote_path: str) -> None:
                return None

            def request(self, _remote_path: str, *_args, **_kwargs) -> None:
                return None

            def get(self, remote_path: str) -> dict | None:
                if remote_path == "dropbox:folder":
                    return {
                        "complete": True,
                        "size": 10,
                        "file_count": 1,
                        "newest_mtime": 1704110400.0,
                    }
                return None

            def get_direct_listing(self, _remote_path: str) -> list[dict]:
                return [
                    {"Name": "folder", "Path": "folder", "IsDir": True, "Size": 0, "ModTime": "2024-01-01T12:00:00Z"},
                    {"Name": "file.txt", "Path": "file.txt", "IsDir": False, "Size": 6, "ModTime": "2024-01-01T12:01:00Z"},
                ]

        rclone = SimulatedRclone()
        app = DropboxBrowser(
            rclone,
            "dropbox:",
            None,
            folder_cache=TracedFolderCache(),
            listing_cache=ListingCacheManager(ttl_seconds=1800),
            client_render=True,
        )

        with TestServer(app) as server:
            server.get_json("/browse/endpoints/listing")

        events = [event for event in self.read_trace_events() if event.get("event") == "browse_listing_endpoint"]
        self.assertEqual(len(events), 1)
        event = events[0]
        self.assertEqual(event["rel_path"], "")
        self.assertEqual(event["remote_path"], "dropbox:")
        self.assertEqual(event["listing_source"], "folder_cache_direct")
        self.assertEqual(event["row_count"], 2)
        self.assertEqual(event["remote_folder_count"], 1)
        self.assertEqual(event["folder_cache_hits"], 1)
        self.assertEqual(event["folder_cache_missing"], 0)
        self.assertEqual(event["folder_cache_requests"], 0)
        self.assertEqual(event["client_render"], True)
        self.assertIsInstance(event["notify_elapsed_ms"], float)
        self.assertIsInstance(event["list_elapsed_ms"], float)
        self.assertIsInstance(event["current_cache_elapsed_ms"], float)
        self.assertIsInstance(event["folder_map_elapsed_ms"], float)
        self.assertIsInstance(event["status_elapsed_ms"], float)
        self.assertIsInstance(event["sort_elapsed_ms"], float)
        self.assertIsInstance(event["total_elapsed_ms"], float)
        self.assertEqual(rclone.calls, [])

    def test_browse_search_endpoint_trace_includes_cache_status_and_counts(self) -> None:
        class RecursiveSearchFolderCache:
            def __init__(self, records: dict[str, dict]) -> None:
                self.records = records

            def get(self, remote_path: str) -> dict | None:
                return self.records.get(remote_path)

            def status(self, remote_path: str) -> str:
                data = self.records.get(remote_path)
                if data is None:
                    return "pending"
                return "complete" if data.get("complete") else "partial"

            def page_epoch_for(self, _page_key: str) -> float:
                return 1234.5

            def ensure_known_subtree(self, _remote_path: str, page_epoch: float) -> dict[str, int | float]:
                return {
                    "page_epoch": page_epoch,
                    "queued_folder_count": 1,
                    "pending_folder_count": 1,
                    "missing_folder_count": 1,
                }

        rclone = SimulatedRclone()
        app = DropboxBrowser(
            rclone,
            "dropbox:",
            None,
            folder_cache=RecursiveSearchFolderCache({
                "dropbox:Music": {
                    "complete": True,
                    "direct_items": [
                        {"Name": "Known", "Path": "Known", "IsDir": True, "Size": 0, "ModTime": "2024-01-01T12:00:00Z"},
                    ],
                    "direct_files": [],
                    "direct_folders": [
                        {"name": "Known", "path": "Known", "remote_path": "dropbox:Music/Known", "mtime": 1704110400.0},
                    ],
                },
            }),
            listing_cache=ListingCacheManager(ttl_seconds=1800),
            client_render=True,
        )

        with TestServer(app) as server:
            server.get_json("/browse/endpoints/search?path=Music&recursive=1&query=known")

        events = [event for event in self.read_trace_events() if event.get("event") == "browse_search_endpoint"]
        self.assertEqual(len(events), 1)
        event = events[0]
        self.assertEqual(event["rel_path"], "Music")
        self.assertEqual(event["remote_path"], "dropbox:Music")
        self.assertEqual(event["recursive"], True)
        self.assertEqual(event["query"], "known")
        self.assertEqual(event["cache_status"], "partial")
        self.assertEqual(event["complete"], False)
        self.assertEqual(event["pending"], True)
        self.assertEqual(event["result_count"], 1)
        self.assertEqual(event["scanned_folder_count"], 1)
        self.assertEqual(event["queued_folder_count"], 1)
        self.assertEqual(event["pending_folder_count"], 1)
        self.assertEqual(event["missing_folder_count"], 1)
        self.assertEqual(event["missing_listing_count"], 1)
        self.assertEqual(event["client_render"], True)
        self.assertIsInstance(event["total_elapsed_ms"], float)
        self.assertEqual(rclone.calls, [])

    def test_browse_search_endpoint_uses_cached_recursive_subtree_without_rclone_calls(self) -> None:
        class RecursiveSearchFolderCache:
            def __init__(self, records: dict[str, dict]) -> None:
                self.records = records
                self.page_epoch_calls: list[str] = []
                self.ensure_calls: list[tuple[str, float]] = []

            def get(self, remote_path: str) -> dict | None:
                return self.records.get(remote_path)

            def status(self, remote_path: str) -> str:
                data = self.records.get(remote_path)
                if data is None:
                    return "pending"
                return "complete" if data.get("complete") else "partial"

            def page_epoch_for(self, page_key: str) -> float:
                self.page_epoch_calls.append(page_key)
                return 1234.5

            def ensure_known_subtree(self, remote_path: str, page_epoch: float) -> dict[str, int | float]:
                self.ensure_calls.append((remote_path, page_epoch))
                return {
                    "page_epoch": page_epoch,
                    "queued_folder_count": 0,
                    "pending_folder_count": 0,
                    "missing_folder_count": 0,
                }

        rclone = SimulatedRclone()
        folder_cache = RecursiveSearchFolderCache({
            "dropbox:Music": {
                "complete": True,
                "direct_items": [
                    {"Name": "Album", "Path": "Album", "IsDir": True, "Size": 0, "ModTime": "2024-01-01T12:00:00Z"},
                    {"Name": "Loose.MP3", "Path": "Loose.MP3", "IsDir": False, "Size": 10, "ModTime": "2024-01-01T12:01:00Z"},
                ],
                "direct_files": [
                    {"name": "Loose.MP3", "path": "Loose.MP3", "remote_path": "dropbox:Music/Loose.MP3", "size": 10, "mtime": 1704110460.0},
                ],
                "direct_folders": [
                    {"name": "Album", "path": "Album", "remote_path": "dropbox:Music/Album", "mtime": 1704110400.0},
                ],
            },
            "dropbox:Music/Album": {
                "complete": True,
                "direct_items": [
                    {"Name": "Track.m4a", "Path": "Track.m4a", "IsDir": False, "Size": 11, "ModTime": "2024-01-01T12:02:00Z"},
                ],
                "direct_files": [
                    {"name": "Track.m4a", "path": "Track.m4a", "remote_path": "dropbox:Music/Album/Track.m4a", "size": 11, "mtime": 1704110520.0},
                ],
                "direct_folders": [],
            },
        })
        app = DropboxBrowser(rclone, "dropbox:", None, folder_cache=folder_cache, listing_cache=ListingCacheManager(ttl_seconds=1800))

        with TestServer(app) as server:
            payload = server.get_json("/browse/endpoints/search?path=Music&recursive=1&query=track")

        self.assertEqual(payload["root"], {
            "remote_path": "dropbox:Music",
            "path": "Music",
            "display_name": "Music",
        })
        self.assertEqual(payload["search"]["query"], "track")
        self.assertEqual(payload["search"]["result_count"], 1)
        self.assertEqual(payload["search"]["scanned_folder_count"], 2)
        self.assertEqual(payload["status"]["cache_status"], "complete")
        self.assertTrue(payload["status"]["complete"])
        self.assertFalse(payload["status"]["pending"])
        self.assertEqual(folder_cache.page_epoch_calls, ["Music"])
        self.assertEqual(folder_cache.ensure_calls, [("dropbox:Music", 1234.5)])
        self.assertEqual(payload["results"][0]["display_name"], "Track.m4a")
        self.assertEqual(payload["results"][0]["path"], "Music/Album/Track.m4a")
        self.assertEqual(payload["results"][0]["relative_path"], "Album/Track.m4a")
        self.assertEqual(payload["results"][0]["preview_href"], "/file?path=Music%2FAlbum%2FTrack.m4a&source=remote")
        self.assertEqual(rclone.calls, [])

    def test_browse_search_endpoint_uses_listing_cache_without_rclone_calls(self) -> None:
        class EmptyFolderCache:
            def __init__(self) -> None:
                self.page_epoch_calls: list[str] = []
                self.ensure_calls: list[tuple[str, float]] = []

            def get(self, _remote_path: str) -> dict | None:
                return None

            def status(self, _remote_path: str) -> str:
                return "unavailable"

            def page_epoch_for(self, page_key: str) -> float:
                self.page_epoch_calls.append(page_key)
                return 999.0

            def ensure_known_subtree(self, remote_path: str, page_epoch: float) -> dict[str, int | float]:
                self.ensure_calls.append((remote_path, page_epoch))
                return {
                    "page_epoch": page_epoch,
                    "queued_folder_count": 0,
                    "pending_folder_count": 0,
                    "missing_folder_count": 0,
                }

        rclone = SimulatedRclone()
        listing_cache = ListingCacheManager(ttl_seconds=1800)
        listing_cache.set("dropbox:Music", [
            {"Name": "Album", "Path": "Album", "IsDir": True, "Size": 0, "ModTime": "2024-01-01T12:00:00Z"},
        ])
        listing_cache.set("dropbox:Music/Album", [
            {"Name": "Track.m4a", "Path": "Track.m4a", "IsDir": False, "Size": 11, "ModTime": "2024-01-01T12:02:00Z"},
        ])
        folder_cache = EmptyFolderCache()
        app = DropboxBrowser(rclone, "dropbox:", None, folder_cache=folder_cache, listing_cache=listing_cache)

        with TestServer(app) as server:
            payload = server.get_json("/browse/endpoints/search?path=Music&recursive=1&query=track")

        self.assertEqual(payload["status"]["cache_status"], "complete")
        self.assertTrue(payload["status"]["complete"])
        self.assertEqual(payload["search"]["scanned_folder_count"], 2)
        self.assertEqual([row["path"] for row in payload["results"]], ["Music/Album/Track.m4a"])
        self.assertEqual(folder_cache.page_epoch_calls, ["Music"])
        self.assertEqual(folder_cache.ensure_calls, [("dropbox:Music", 999.0)])
        self.assertEqual(rclone.calls, [])

    def test_browse_search_endpoint_reports_partial_status_for_missing_cached_child_listing(self) -> None:
        class PartialFolderCache:
            def __init__(self, records: dict[str, dict]) -> None:
                self.records = records

            def get(self, remote_path: str) -> dict | None:
                return self.records.get(remote_path)

            def status(self, remote_path: str) -> str:
                data = self.records.get(remote_path)
                if data is None:
                    return "pending"
                return "complete" if data.get("complete") else "partial"

            def page_epoch_for(self, _page_key: str) -> float:
                return 555.0

            def ensure_known_subtree(self, _remote_path: str, page_epoch: float) -> dict[str, int | float]:
                return {
                    "page_epoch": page_epoch,
                    "queued_folder_count": 1,
                    "pending_folder_count": 1,
                    "missing_folder_count": 1,
                }

        rclone = SimulatedRclone()
        folder_cache = PartialFolderCache({
            "dropbox:Music": {
                "complete": True,
                "direct_items": [
                    {"Name": "Known", "Path": "Known", "IsDir": True, "Size": 0, "ModTime": "2024-01-01T12:00:00Z"},
                ],
                "direct_files": [],
                "direct_folders": [
                    {"name": "Known", "path": "Known", "remote_path": "dropbox:Music/Known", "mtime": 1704110400.0},
                ],
            },
        })
        app = DropboxBrowser(rclone, "dropbox:", None, folder_cache=folder_cache, listing_cache=ListingCacheManager(ttl_seconds=1800))

        with TestServer(app) as server:
            payload = server.get_json("/browse/endpoints/search?path=Music&recursive=1&query=known")

        self.assertEqual(payload["status"]["cache_status"], "partial")
        self.assertFalse(payload["status"]["complete"])
        self.assertTrue(payload["status"]["pending"])
        self.assertEqual(payload["status"]["pending_folder_count"], 1)
        self.assertEqual(payload["status"]["queued_folder_count"], 1)
        self.assertEqual(payload["status"]["missing_folder_count"], 1)
        self.assertEqual(payload["status"]["missing_listing_count"], 1)
        self.assertEqual(payload["results"][0]["display_name"], "Known")
        self.assertEqual(payload["results"][0]["path"], "Music/Known")
        self.assertEqual(payload["results"][0]["relative_path"], "Known")
        self.assertEqual(rclone.calls, [])

    def test_browse_search_endpoint_rejects_parent_segments(self) -> None:
        rclone = SimulatedRclone()
        app = self._build_app(rclone, local_root=None, workers=1)

        with TestServer(app) as server:
            with self.assertRaises(HTTPError) as ctx:
                server.get_text("/browse/endpoints/search?path=..&recursive=1&query=test")

        self.assertEqual(ctx.exception.code, HTTPStatus.BAD_REQUEST)
        self.assertEqual(rclone.calls, [])

    def test_browse_listing_endpoint_reuses_listing_cache_without_rclone_call(self) -> None:
        rclone = SimulatedRclone()
        listing_cache = ListingCacheManager(ttl_seconds=1800)
        listing_cache.set("dropbox:", [
            {
                "Name": "cached.txt",
                "Path": "cached.txt",
                "IsDir": False,
                "Size": 6,
                "ModTime": "2024-01-01T12:00:00Z",
            },
        ])
        app = DropboxBrowser(rclone, "dropbox:", None, folder_cache=None, listing_cache=listing_cache)

        with TestServer(app) as server:
            payload = server.get_json("/browse/endpoints/listing")

        self.assertEqual(payload["listing"]["source"], "listing_cache")
        self.assertEqual([row["display_name"] for row in payload["rows"]], ["cached.txt"])
        self.assertEqual(rclone.calls, [])

    def test_browse_listing_endpoint_reuses_folder_cache_direct_listing_without_rclone_call(self) -> None:
        class DirectListingFolderCache:
            def __init__(self) -> None:
                self.notified: list[tuple[str | None, bool]] = []
                self.requests: list[str] = []

            def notify_page_load(self, _page_time: float, *, page_key: str | None = None, force: bool = False) -> None:
                self.notified.append((page_key, force))

            def invalidate(self, _remote_path: str) -> None:
                return None

            def get(self, _remote_path: str) -> dict | None:
                return None

            def request(self, remote_path: str, *_args, **_kwargs) -> None:
                self.requests.append(remote_path)

            def get_direct_listing(self, remote_path: str) -> list[dict]:
                self.requests.append(f"direct:{remote_path}")
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

        with TestServer(app) as server:
            payload = server.get_json("/browse/endpoints/listing")

        self.assertEqual(payload["listing"]["source"], "folder_cache_direct")
        self.assertEqual(payload["rows"][0]["display_name"], "cached.txt")
        self.assertEqual(folder_cache.notified, [("", False)])
        self.assertEqual(folder_cache.requests, ["direct:dropbox:"])
        self.assertEqual(rclone.calls, [])

    def test_browse_listing_endpoint_refresh_invalidates_same_caches_as_server_render(self) -> None:
        class TrackingFolderCache:
            def __init__(self) -> None:
                self.invalidated: list[str] = []
                self.notified: list[tuple[str | None, bool]] = []

            def notify_page_load(self, _page_time: float, *, page_key: str | None = None, force: bool = False) -> None:
                self.notified.append((page_key, force))

            def invalidate(self, remote_path: str) -> None:
                self.invalidated.append(remote_path)

            def get(self, _remote_path: str) -> dict | None:
                return None

            def request(self, *_args, **_kwargs) -> None:
                return None

        rclone = SimulatedRclone({
            "dropbox:music": [SimulatedLsjsonResponse(items=[remote_dir_item("album")])],
        })
        listing_cache = ListingCacheManager(ttl_seconds=1800)
        listing_cache.set("dropbox:music", [{"Name": "stale.txt"}])
        folder_cache = TrackingFolderCache()
        app = DropboxBrowser(rclone, "dropbox:", None, folder_cache=folder_cache, listing_cache=listing_cache)

        with TestServer(app) as server:
            payload = server.get_json("/browse/endpoints/listing?path=music&refresh=1")

        self.assertEqual(payload["listing"]["source"], "rclone")
        self.assertEqual(payload["pending_metadata_paths"], ["music/album"])
        self.assertEqual(
            listing_cache.get("dropbox:music"),
            [{"Name": "album", "Path": "album", "IsDir": True, "Size": 0, "ModTime": "2024-01-01T12:00:00Z"}],
        )
        self.assertEqual(folder_cache.notified, [("music", True)])
        self.assertEqual(folder_cache.invalidated, ["dropbox:music", "dropbox:music/album"])

    def test_browse_listing_endpoint_uses_resolved_local_path_for_windows_renamed_match(self) -> None:
        local_root = self.create_local_root({
            "contains？question.txt": b"local",
        })
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[{
                "Name": "contains?question.txt",
                "Path": "contains?question.txt",
                "IsDir": False,
                "Size": 5,
                "ModTime": "2024-01-01T12:00:00Z",
            }])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            payload = server.get_json("/browse/endpoints/listing")

        row = payload["rows"][0]
        self.assertEqual(row["display_name"], "contains?question.txt")
        self.assertEqual(row["local_copy_path"], str(local_root / "contains？question.txt"))

    def test_browse_listing_endpoint_rejects_parent_segments(self) -> None:
        rclone = SimulatedRclone()
        app = self._build_app(rclone, local_root=None, workers=1)

        with TestServer(app) as server:
            with self.assertRaises(HTTPError) as ctx:
                server.get_text("/browse/endpoints/listing?path=..")

        self.assertEqual(ctx.exception.code, HTTPStatus.BAD_REQUEST)
        self.assertEqual(rclone.calls, [])

    def test_browse_listing_endpoint_row_fields_match_representative_html_rows(self) -> None:
        local_root = self.create_local_root({
            "folder/inside.txt": b"inside",
            "both.txt": b"both",
            "local-only.txt": b"local",
        })
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[
                remote_dir_item("folder"),
                remote_file_item("both.txt", local_root / "both.txt"),
                {
                    "Name": "remote-only.txt",
                    "Path": "remote-only.txt",
                    "IsDir": False,
                    "Size": 10,
                    "ModTime": "2024-01-02T12:00:00Z",
                },
            ])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            payload = server.get_json("/browse/endpoints/listing")

        local_root_prefix = str(local_root.parent)
        if local_root_prefix and local_root_prefix != "." and not local_root_prefix.endswith(("\\", "/")):
            local_root_prefix += "\\"
        self.assertEqual(payload["page"]["title"], "SDB: Dropbox (dropbox:)")
        self.assertEqual(payload["page"]["current_local_folder"], str(local_root))
        self.assertEqual(payload["page"]["local_root_prefix"], local_root_prefix)
        self.assertEqual(payload["page"]["local_root_name"], local_root.name)
        self.assertEqual(payload["page"]["dropbox_home_url"], "https://www.dropbox.com/home")
        self.assertEqual(payload["breadcrumbs"], [{"name": "Dropbox", "path": "", "href": "/"}])
        self.assertEqual(payload["sort"]["current_key"], "name")
        self.assertEqual(payload["sort"]["current_direction"], "asc")
        self.assertTrue(payload["current_folder_info"]["poll_current_file_statuses"])

        folder_row = next(row for row in payload["rows"] if row["display_name"] == "folder")
        self.assertEqual(folder_row["id"], "folder:folder")
        self.assertEqual(folder_row["kind"], "folder")
        self.assertTrue(folder_row["is_dir"])
        self.assertEqual(folder_row["type_label"], "folder")
        self.assertEqual(folder_row["icon_name"], "folder-base.svg")
        self.assertEqual(folder_row["icon_href"], "/assets/icons/material-icon-theme/folder-base.svg")
        self.assertEqual(folder_row["status_label"], "Loading")
        self.assertEqual(folder_row["status_class"], "loading")
        self.assertEqual(folder_row["size_display"], "—")
        self.assertEqual(folder_row["date_display"], "")
        self.assertEqual(folder_row["sort_name"], "folder")
        self.assertEqual(folder_row["sort_type"], "folder")
        self.assertEqual(folder_row["sort_status"], "Loading")
        self.assertEqual(folder_row["sort_size"], 0)
        self.assertIsInstance(folder_row["sort_date"], float)
        self.assertEqual(folder_row["local_copy_path"], str(local_root / "folder"))
        self.assertEqual(folder_row["folder_href"], "/?path=folder")
        self.assertEqual(folder_row["sync"], {"allowed": False, "directions": []})
        both_row = next(row for row in payload["rows"] if row["display_name"] == "both.txt")
        self.assertEqual(both_row["icon_name"], "document.svg")
        self.assertEqual(both_row["status_label"], "Synced")
        self.assertEqual(both_row["status_class"], "both")
        self.assertEqual(both_row["source"], "remote")
        self.assertEqual(both_row["size_display"], "4 B")
        self.assertEqual(both_row["preview_href"], "/file?path=both.txt&source=remote")
        self.assertEqual(both_row["download_href"], "/download?path=both.txt&source=remote")
        self.assertEqual(both_row["local_copy_path"], str(local_root / "both.txt"))
        self.assertEqual(both_row["sync"], {"allowed": False, "directions": []})
        remote_only_row = next(row for row in payload["rows"] if row["display_name"] == "remote-only.txt")
        self.assertEqual(remote_only_row["status_label"], "Dropbox Only")
        self.assertEqual(remote_only_row["sync"], {"allowed": True, "directions": ["dropbox_to_local"]})
        local_only_row = next(row for row in payload["rows"] if row["display_name"] == "local-only.txt")
        self.assertEqual(local_only_row["source"], "local")
        self.assertEqual(local_only_row["status_label"], "Local Only")
        self.assertEqual(local_only_row["preview_href"], "/file?path=local-only.txt&source=local")
        self.assertEqual(local_only_row["download_href"], "/download?path=local-only.txt&source=local")
        self.assertEqual(local_only_row["sync"], {"allowed": True, "directions": ["local_to_dropbox"]})

    def test_browse_listing_endpoint_serializes_local_only_folder_metadata_as_final_values(self) -> None:
        local_root = self.create_local_root({
            "albums-local/track.txt": b"track",
        })
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            payload = server.get_json("/browse/endpoints/listing")

        folder_row = next(row for row in payload["rows"] if row["display_name"] == "albums-local")
        self.assertEqual(folder_row["status_label"], "Local Only")
        self.assertEqual(folder_row["size_display"], "—")
        self.assertEqual(folder_row["count_display"], "")
        self.assertTrue(folder_row["date_display"])
        self.assertTrue(folder_row["metadata_complete"])
        self.assertEqual(folder_row["sort_date"], (local_root / "albums-local").stat().st_mtime)
        self.assertEqual(payload["pending_metadata_paths"], [])

    def test_browse_listing_endpoint_keeps_partial_folder_rows_pending_and_serializes_in_progress_values(self) -> None:
        local_root = self.create_local_root({
            "music/Album/track.mp3": b"track",
            "music/Album/Disc 1/song.mp3": b"song!!",
        })
        rclone = SimulatedRclone({
            "dropbox:music": [SimulatedLsjsonResponse(items=[remote_dir_item("Album")])],
            "dropbox:music/Album": [SimulatedLsjsonResponse(items=[
                remote_file_item("track.mp3", local_root / "music" / "Album" / "track.mp3", mod_time="2024-01-02T12:00:00Z"),
                remote_dir_item("Disc 1", mod_time="2024-01-01T12:00:00Z"),
            ])],
            "dropbox:music/Album/Disc 1": [SimulatedLsjsonResponse(
                items=[remote_file_item("song.mp3", local_root / "music" / "Album" / "Disc 1" / "song.mp3", mod_time="2024-01-03T12:00:00Z")],
                delay=0.25,
            )],
        })
        app = self._build_app(rclone, local_root=local_root, workers=2)
        assert app.folder_cache is not None

        with TestServer(app) as server:
            server.get_text("/?path=music")
            wait_until(
                lambda: (
                    app.folder_cache.get("dropbox:music/Album")
                    if (app.folder_cache.get("dropbox:music/Album") or {}).get("complete") is False
                    else None
                ),
                description="partial album folder cache",
            )
            payload = server.get_json("/browse/endpoints/listing?path=music")

        album_row = next(row for row in payload["rows"] if row["display_name"] == "Album")
        self.assertEqual(album_row["size_display"], "5 B")
        self.assertEqual(album_row["count_display"], "1 files")
        self.assertEqual(album_row["date_display"], "2024-01-02 07:00")
        self.assertFalse(album_row["metadata_complete"])
        self.assertEqual(payload["pending_metadata_paths"], ["music/Album"])

    def test_build_browse_snapshot_reuses_folder_cache_direct_listing_and_sorts_rows(self) -> None:
        class DirectListingFolderCache:
            def __init__(self) -> None:
                self.notified: list[tuple[str | None, bool]] = []
                self.requests: list[str] = []

            def notify_page_load(self, _page_time: float, *, page_key: str | None = None, force: bool = False) -> None:
                self.notified.append((page_key, force))

            def invalidate(self, _remote_path: str) -> None:
                return None

            def get(self, _remote_path: str) -> dict | None:
                return None

            def request(self, remote_path: str, *_args, **_kwargs) -> None:
                self.requests.append(remote_path)

            def get_direct_listing(self, remote_path: str) -> list[dict]:
                self.requests.append(f"direct:{remote_path}")
                return [
                    {
                        "Name": "b.txt",
                        "Path": "b.txt",
                        "IsDir": False,
                        "Size": 2,
                        "ModTime": "2024-01-02T12:00:00Z",
                    },
                    {
                        "Name": "a.txt",
                        "Path": "a.txt",
                        "IsDir": False,
                        "Size": 1,
                        "ModTime": "2024-01-01T12:00:00Z",
                    },
                ]

        rclone = SimulatedRclone()
        listing_cache = ListingCacheManager(ttl_seconds=1800)
        folder_cache = DirectListingFolderCache()
        app = DropboxBrowser(rclone, "dropbox:", None, folder_cache=folder_cache, listing_cache=listing_cache)

        snapshot = app.build_browse_snapshot("", "name", "asc", page_time=1234.5)

        self.assertEqual(snapshot.listing_source, "folder_cache_direct")
        self.assertEqual([entry["name"] for entry in snapshot.entries], ["a.txt", "b.txt"])
        self.assertEqual(snapshot.sort_key, "name")
        self.assertEqual(snapshot.direction, "asc")
        self.assertEqual(snapshot.remote_path, "dropbox:")
        self.assertEqual(folder_cache.notified, [("", False)])
        self.assertEqual(folder_cache.requests, ["direct:dropbox:"])
        self.assertEqual(rclone.calls, [])

    def test_build_browse_snapshot_force_refresh_invalidates_current_and_child_folder_metadata(self) -> None:
        class TrackingFolderCache:
            def __init__(self) -> None:
                self.invalidated: list[str] = []
                self.notified: list[tuple[str | None, bool]] = []

            def notify_page_load(self, _page_time: float, *, page_key: str | None = None, force: bool = False) -> None:
                self.notified.append((page_key, force))

            def invalidate(self, remote_path: str) -> None:
                self.invalidated.append(remote_path)

            def get(self, _remote_path: str) -> dict | None:
                return None

            def request(self, *_args, **_kwargs) -> None:
                return None

        rclone = SimulatedRclone({
            "dropbox:music": [SimulatedLsjsonResponse(items=[remote_dir_item("album")])],
        })
        listing_cache = ListingCacheManager(ttl_seconds=1800)
        folder_cache = TrackingFolderCache()
        app = DropboxBrowser(rclone, "dropbox:", None, folder_cache=folder_cache, listing_cache=listing_cache)

        snapshot = app.build_browse_snapshot("music", "name", "asc", force_refresh=True, page_time=1234.5)

        self.assertEqual(snapshot.remote_folder_count, 1)
        self.assertEqual(snapshot.folder_cache_missing, 1)
        self.assertEqual(snapshot.folder_cache_map, {"album": None})
        self.assertEqual(folder_cache.notified, [("music", True)])
        self.assertEqual(folder_cache.invalidated, ["dropbox:music", "dropbox:music/album"])

    def test_build_browse_snapshot_uses_resolved_local_path_for_windows_renamed_match(self) -> None:
        local_root = self.create_local_root({
            "contains？question.txt": b"local",
        })
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[
                {
                    "Name": "contains?question.txt",
                    "Path": "contains?question.txt",
                    "IsDir": False,
                    "Size": 5,
                    "ModTime": "2024-01-01T12:00:00Z",
                },
            ])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        snapshot = app.build_browse_snapshot("", "name", "asc")

        self.assertEqual(len(snapshot.entries), 1)
        self.assertEqual(snapshot.entries[0]["name"], "contains?question.txt")
        self.assertEqual(snapshot.entries[0]["local_path"], str(local_root / "contains？question.txt"))

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
        self.assertEqual(folder_cache.requests, [])

    def test_recursive_refresh_does_not_enqueue_recursive_folder_rebuild(self) -> None:
        started = threading.Event()
        wait_event = threading.Event()
        rclone = SimulatedRclone({
            "dropbox:music": [
                SimulatedLsjsonResponse(
                    items=[remote_dir_item("child")],
                    started_event=started,
                    wait_event=wait_event,
                ),
            ],
        })
        app = self._build_app(rclone, local_root=None, workers=1)
        assert app.folder_cache is not None

        with TestServer(app) as server:
            server.post_json("/refresh-cache", {"path": "music", "recursive": "1"})

            cache = app.folder_cache
            with cache._lock:
                self.assertNotIn("dropbox:music", cache._in_progress)

            self.assertFalse(started.wait(0.05))
            self.assertEqual(rclone.calls, [])

        wait_event.set()

    def test_refresh_reload_primes_current_folder_direct_listing_for_music(self) -> None:
        for recursive in ("0", "1"):
            with self.subTest(recursive=recursive):
                rclone = SimulatedRclone({
                    "dropbox:music": [
                        SimulatedLsjsonResponse(items=[remote_dir_item("album")]),
                    ],
                })
                app = self._build_app(rclone, local_root=None, workers=1)
                cache = app.folder_cache
                assert cache is not None

                with TestServer(app) as server:
                    server.post_json("/refresh-cache", {"path": "music", "recursive": recursive})
                    server.get_text("/?path=music")

                data = cache.get("dropbox:music") or {}
                self.assertEqual(
                    [(folder["name"], folder["remote_path"]) for folder in data.get("direct_folders", [])],
                    [("album", "dropbox:music/album")],
                )

    def test_listing_cache_invalidate_tree_marks_descendants_stale_without_scanning(self) -> None:
        cache = ListingCacheManager(ttl_seconds=1800)
        cache.set("dropbox:music", [{"Name": "old.txt"}])
        cache.set("dropbox:music/child", [{"Name": "child.txt"}])
        cache.set("dropbox:other", [{"Name": "other.txt"}])

        invalidated = cache.invalidate_tree("dropbox:music")

        self.assertEqual(invalidated, ["dropbox:music"])
        self.assertIsNone(cache.get("dropbox:music"))
        self.assertIsNone(cache.get("dropbox:music/child"))
        self.assertIsNotNone(cache.get("dropbox:other"))

        cache.set("dropbox:music/child", [{"Name": "fresh.txt"}])
        self.assertEqual(cache.get("dropbox:music/child"), [{"Name": "fresh.txt"}])

    def test_listing_cache_invalidate_tree_handles_remote_root_descendants(self) -> None:
        cache = ListingCacheManager(ttl_seconds=1800)
        cache.set("dropbox:", [{"Name": "old-root.txt"}])
        cache.set("dropbox:music", [{"Name": "old-child.txt"}])

        invalidated = cache.invalidate_tree("dropbox:")

        self.assertEqual(invalidated, ["dropbox:"])
        self.assertIsNone(cache.get("dropbox:"))
        self.assertIsNone(cache.get("dropbox:music"))

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

        self.assertEqual(invalidated, ["dropbox:music", "dropbox:music/live"])
        self.assertFalse(cache._cache_path("dropbox:music").exists())
        self.assertIsNone(cache.get("dropbox:music/child"))
        self.assertTrue(cache._cache_path("dropbox:other").exists())
        self.assertNotIn("dropbox:music/live", cache._acc)

        with cache._lock:
            cache._acc["dropbox:music/child"] = {
                "size": 0,
                "count": 0,
                "mtime": None,
                "diff_status": "unavailable",
                "diff_complete": True,
                "first_diff_path": None,
                "file_statuses": {},
                "direct_items": [],
                "direct_files": [],
                "direct_folders": [],
            }
            cache._write_cache("dropbox:music/child", complete=True)
        self.assertIsNotNone(cache.get("dropbox:music/child"))

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
