from __future__ import annotations

import threading
import time
from http import HTTPStatus
from pathlib import Path
from typing import Any
from urllib.parse import quote
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from dropbox_browser.errors import BrowserError
from dropbox_browser.foldercache import FolderCacheManager
from dropbox_browser.listingcache import ListingCacheManager
from dropbox_browser.services import DropboxBrowser
from dropbox_browser.syncjobs import SyncJobManager

try:
    from tests.support import (
        IsolatedPathsTestCase,
        SimulatedLsjsonResponse,
        SimulatedRclone,
        TestServer,
        remote_dir_item,
        remote_file_item,
        wait_until,
    )
except ImportError:
    from support import (
        IsolatedPathsTestCase,
        SimulatedLsjsonResponse,
        SimulatedRclone,
        TestServer,
        remote_dir_item,
        remote_file_item,
        wait_until,
    )


class _PreloadedFolderCache:
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


class AppBehaviorTests(IsolatedPathsTestCase):
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
        return app

    def _wait_folder_info(self, server: TestServer, *, paths: list[str] | None = None, current: str | None = None, predicate=None):
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

        wait_until(_ready, description=f"folder-info response for {path}")
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
        }, cat_data={"dropbox:movie.mp4": b"0123456789"})

    def test_page_load_and_background_poll_return_expected_data(self) -> None:
        local_root = self.create_local_root({
            "shared.txt": b"root data",
            "sub/child.txt": b"child data",
        })
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[
                remote_file_item("shared.txt", local_root / "shared.txt"),
                remote_dir_item("sub"),
            ])],
            "dropbox:sub": [SimulatedLsjsonResponse(items=[remote_file_item("child.txt", local_root / "sub" / "child.txt")])],
        })
        app = self._build_app(rclone, local_root=local_root)

        with TestServer(app) as server:
            html = server.get_text("/")
            self.assertIn("shared.txt", html)
            self.assertIn('<span class="entry-name">sub</span>', html)
            self.assertIn('/assets/icons/material-icon-theme/folder-base.svg', html)
            self.assertIn("Loading", html)

            results = self._wait_folder_info(
                server,
                paths=["sub"],
                current="",
                predicate=lambda data: (
                    data.get("sub", {}).get("complete")
                    and data.get("sub", {}).get("diff_status") == "synced"
                    and data.get("", {}).get("diff_complete")
                    and data.get("", {}).get("file_statuses", {}).get("shared.txt", {}).get("diff_status") == "synced"
                ),
            )

        self.assertEqual(results["sub"]["diff_status"], "synced")
        self.assertTrue(results["sub"]["complete"])
        self.assertEqual(results[""]["file_statuses"]["shared.txt"]["diff_status"], "synced")
        events = self.read_trace_events()
        self.assertTrue(any(event["event"] == "job_queued" for event in events))
        self.assertTrue(any(event["event"] == "subtree_complete" and event.get("remote_path") == "dropbox:sub" for event in events))

    def test_ignored_metadata_files_are_not_listed_or_compared(self) -> None:
        local_root = self.create_local_root({
            "music/.DS_Store": b"mac metadata",
            "music/Thumbs.db": b"windows thumbnails",
            "music/desktop.ini": b"windows folder metadata",
            "music/ehthumbs.db": b"windows media thumbnails",
            "music/._song.mp3": b"mac resource fork",
            "music/song.mp3": b"audio",
        })
        rclone = SimulatedRclone({
            "dropbox:music": [SimulatedLsjsonResponse(items=[
                remote_file_item(".DS_Store", local_root / "music" / ".DS_Store"),
                remote_file_item("Thumbs.db", local_root / "music" / "Thumbs.db"),
                remote_file_item("desktop.ini", local_root / "music" / "desktop.ini"),
                remote_file_item("ehthumbs.db", local_root / "music" / "ehthumbs.db"),
                remote_file_item("._song.mp3", local_root / "music" / "._song.mp3"),
                remote_file_item("song.mp3", local_root / "music" / "song.mp3"),
            ])],
        })
        app = self._build_app(rclone, local_root=local_root)

        with TestServer(app) as server:
            html = server.get_text("/?path=music")
            results = self._wait_folder_info(
                server,
                current="music",
                predicate=lambda data: data.get("music", {}).get("file_statuses", {}).get("song.mp3"),
            )
            info = results["music"]

        self.assertIn("song.mp3", html)
        self.assertNotIn(".DS_Store", html)
        self.assertNotIn("Thumbs.db", html)
        self.assertNotIn("desktop.ini", html)
        self.assertNotIn("ehthumbs.db", html)
        self.assertNotIn("._song.mp3", html)
        self.assertEqual(info.get("file_statuses", {}).get("song.mp3", {}).get("diff_status"), "synced")
        self.assertNotIn(".DS_Store", info.get("file_statuses", {}))
        self.assertNotIn("Thumbs.db", info.get("file_statuses", {}))
        self.assertNotIn("._song.mp3", info.get("file_statuses", {}))

    def test_ignored_metadata_files_do_not_create_folder_cache_diffs(self) -> None:
        local_root = self.create_local_root({
            "music/song.mp3": b"audio",
            "music/.DS_Store": b"local mac metadata",
            "music/Thumbs.db": b"local windows metadata",
            "music/._song.mp3": b"local mac resource fork",
        })
        rclone = SimulatedRclone({
            "dropbox:music": [SimulatedLsjsonResponse(items=[
                remote_file_item("song.mp3", local_root / "music" / "song.mp3"),
                {
                    "Name": "desktop.ini",
                    "Path": "desktop.ini",
                    "IsDir": False,
                    "Size": 12,
                    "ModTime": "2024-01-01T12:00:00Z",
                },
                {
                    "Name": "._remote.mp3",
                    "Path": "._remote.mp3",
                    "IsDir": False,
                    "Size": 9,
                    "ModTime": "2024-01-01T12:00:00Z",
                },
            ])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)
        cache = app.folder_cache
        assert cache is not None

        cache.request("dropbox:music", time.time())
        data = wait_until(
            lambda: cache.get("dropbox:music") if (cache.get("dropbox:music") or {}).get("complete") else None,
            description="ignored metadata folder completion",
        )

        self.assertEqual(data["diff_status"], "synced")
        self.assertEqual(data["file_statuses"], {"song.mp3": {"diff_status": "synced"}})

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

    def test_status_column_sorts_direct_file_statuses(self) -> None:
        local_root = self.create_local_root({
            "local.txt": b"local",
            "changed.txt": b"local",
            "synced.txt": b"synced",
        })
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[
                {
                    "Name": "changed.txt",
                    "Path": "changed.txt",
                    "IsDir": False,
                    "Size": 99,
                    "ModTime": "2024-01-01T12:00:00Z",
                },
                {
                    "Name": "remote.txt",
                    "Path": "remote.txt",
                    "IsDir": False,
                    "Size": 6,
                    "ModTime": "2024-01-01T12:00:00Z",
                },
                remote_file_item("synced.txt", local_root / "synced.txt"),
            ])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            html = server.get_text("/?sort=status&dir=asc")

        self.assertIn('<a href="/?path=&sort=status&dir=desc">Status ^</a>', html)
        table_body = html.split("<tbody>", 1)[1].split("</tbody>", 1)[0]
        status_labels = [
            row.split('<span class="status ', 1)[1].split(">", 1)[1].split("</span>", 1)[0]
            for row in table_body.split("<tr")
            if '<span class="status ' in row
        ]
        self.assertEqual(status_labels, ["Dropbox Only", "Has Diffs", "Local Only", "Synced"])

    def test_date_desc_sort_uses_loading_folder_cached_dates(self) -> None:
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[
                {
                    "Name": "older",
                    "Path": "older",
                    "IsDir": True,
                    "Size": 0,
                    "ModTime": "2025-01-01T00:00:00Z",
                },
                {
                    "Name": "newer",
                    "Path": "newer",
                    "IsDir": True,
                    "Size": 0,
                    "ModTime": "2024-01-01T00:00:00Z",
                },
            ])],
        })
        app = self._build_app(rclone, manager_cls=_PreloadedFolderCache)

        with TestServer(app) as server:
            html = server.get_text("/?sort=date&dir=desc")

        table_body = html.split("<tbody>", 1)[1].split("</tbody>", 1)[0]
        names = [
            row.split('<span class="entry-name">', 1)[1].split("</span>", 1)[0]
            for row in table_body.split("<tr")
            if 'data-row-kind="folder"' in row
        ]
        self.assertEqual(names, ["newer", "older"])
        self.assertIn('data-sort-date="1735689600.0"', table_body)
        self.assertIn('data-sort-date="1704067200.0"', table_body)
        self.assertIn("spinner", table_body)

    def test_slow_background_folder_reports_calculating_then_completes(self) -> None:
        local_root = self.create_local_root({
            "shared.txt": b"root data",
            "slow/child.txt": b"slow child",
        })
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[
                remote_file_item("shared.txt", local_root / "shared.txt"),
                remote_dir_item("slow"),
            ])],
            "dropbox:slow": [SimulatedLsjsonResponse(
                items=[remote_file_item("child.txt", local_root / "slow" / "child.txt")],
                delay=0.25,
            )],
        })
        app = self._build_app(rclone, local_root=local_root)

        with TestServer(app) as server:
            server.get_text("/")
            immediate = server.get_json("/folder-info?paths=slow")["results"]["slow"]
            self.assertIn(immediate["status"], {"calculating", "partial"})

            results = self._wait_folder_info(
                server,
                paths=["slow"],
                predicate=lambda data: data.get("slow", {}).get("complete"),
            )

        self.assertEqual(results["slow"]["diff_status"], "synced")
        self.assertTrue(results["slow"]["complete"])

    def test_folder_info_paths_support_names_with_commas(self) -> None:
        folder_name = "Paco de Lucia - Entre Dos Aguas 1981 - 320Kbps - Flamenco, Latino # DrBn"
        local_root = self.create_local_root({
            f"music/{folder_name}/Cover/front.jpg": b"cover front",
            f"music/{folder_name}/Cover/back.jpg": b"cover back",
            "music/Other Album/song.mp3": b"other song",
        })
        rclone = SimulatedRclone({
            "dropbox:music": [SimulatedLsjsonResponse(items=[
                remote_dir_item(folder_name),
                remote_dir_item("Other Album"),
            ])],
            f"dropbox:music/{folder_name}": [SimulatedLsjsonResponse(items=[
                remote_dir_item("Cover"),
            ])],
            f"dropbox:music/{folder_name}/Cover": [SimulatedLsjsonResponse(items=[
                remote_file_item("front.jpg", local_root / "music" / folder_name / "Cover" / "front.jpg"),
                remote_file_item("back.jpg", local_root / "music" / folder_name / "Cover" / "back.jpg"),
            ])],
            "dropbox:music/Other Album": [SimulatedLsjsonResponse(items=[
                remote_file_item("song.mp3", local_root / "music" / "Other Album" / "song.mp3"),
            ])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            html = server.get_text("/?path=music")
            results = self._wait_folder_info(
                server,
                paths=[folder_name, "Other Album"],
                predicate=lambda data: (
                    data.get(folder_name, {}).get("complete")
                    and data.get("Other Album", {}).get("complete")
                ),
            )

        self.assertIn(folder_name, html)
        self.assertTrue(results[folder_name]["complete"])
        self.assertIn(results[folder_name]["diff_status"], {"synced", "has_diffs"})
        self.assertTrue(results["Other Album"]["complete"])
        self.assertNotIn("Paco de Lucia - Entre Dos Aguas 1981 - 320Kbps - Flamenco", results)
        self.assertNotIn(" Latino # DrBn", results)

    def test_local_file_size_change_overrides_stale_synced_folder_cache(self) -> None:
        local_root = self.create_local_root({
            "dropbox_browser_test/audio_urls.txt": b"old urls",
        })
        rclone = SimulatedRclone({
            "dropbox:dropbox_browser_test": [SimulatedLsjsonResponse(items=[
                remote_file_item("audio_urls.txt", local_root / "dropbox_browser_test" / "audio_urls.txt"),
            ])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            server.get_text("/?path=dropbox_browser_test")
            results = self._wait_folder_info(
                server,
                current="dropbox_browser_test",
                predicate=lambda data: data.get("dropbox_browser_test", {}).get("diff_complete"),
            )
            self.assertEqual(
                results["dropbox_browser_test"]["file_statuses"]["audio_urls.txt"]["diff_status"],
                "synced",
            )

            (local_root / "dropbox_browser_test" / "audio_urls.txt").write_bytes(b"changed local urls")
            html = server.get_text("/?path=dropbox_browser_test")
            info = server.get_json("/folder-info?current=dropbox_browser_test")["results"]["dropbox_browser_test"]

        self.assertIn('data-file-status-path="dropbox_browser_test/audio_urls.txt"', html)
        self.assertIn("Has Diffs", html)
        self.assertEqual(info["file_statuses"]["audio_urls.txt"]["diff_status"], "has_diffs")

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

    def test_same_page_reload_does_not_rerun_identical_child_listing(self) -> None:
        local_root = self.create_local_root({
            "slow/child.txt": b"slow child",
        })
        slow_started = threading.Event()
        slow_release = threading.Event()
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[remote_dir_item("slow")])],
            "dropbox:slow": [
                SimulatedLsjsonResponse(
                    items=[remote_file_item("child.txt", local_root / "slow" / "child.txt")],
                    wait_event=slow_release,
                    started_event=slow_started,
                ),
                SimulatedLsjsonResponse(items=[remote_file_item("child.txt", local_root / "slow" / "child.txt")]),
            ],
        })
        app = self._build_app(rclone, local_root=local_root, workers=2)

        with TestServer(app) as server:
            server.get_text("/")
            wait_until(slow_started.is_set, description="slow child listing to start")
            server.get_text("/")
            slow_release.set()
            results = self._wait_folder_info(
                server,
                paths=["slow"],
                predicate=lambda data: data.get("slow", {}).get("complete"),
            )

        self.assertEqual(results["slow"]["diff_status"], "synced")
        self.assertEqual(sum(1 for call in rclone.calls if call["target"] == "dropbox:slow"), 1)

    def test_newer_page_load_cancels_stale_folder_job_and_allows_new_page_to_finish(self) -> None:
        a_started = threading.Event()
        a_release = threading.Event()
        rclone = SimulatedRclone({
            "dropbox:a": [SimulatedLsjsonResponse(items=[], wait_event=a_release, started_event=a_started)],
            "dropbox:b": [SimulatedLsjsonResponse(items=[])],
        })
        app = self._build_app(rclone, local_root=None, workers=2)
        cache = app.folder_cache
        assert cache is not None

        page1 = time.time()
        cache.request("dropbox:a", page1)
        wait_until(a_started.is_set, description="folder a to start")

        page2 = page1 + 1
        cache.notify_page_load(page2)
        cache.request("dropbox:b", page2)
        a_release.set()

        wait_until(lambda: (cache.get("dropbox:b") or {}).get("complete"), description="folder b completion")
        wait_until(lambda: cache.status("dropbox:a") != "calculating", description="folder a cancellation")

        self.assertTrue((cache.get("dropbox:b") or {}).get("complete"))
        self.assertNotEqual(cache.status("dropbox:a"), "calculating")
        events = self.read_trace_events()
        self.assertTrue(any(event["event"] == "job_canceled_running" and event.get("remote_path") == "dropbox:a" for event in events))

    def test_stale_parent_with_subfolders_does_not_persist_complete_zero_metadata(self) -> None:
        root_started = threading.Event()
        root_release = threading.Event()
        local_root = self.create_local_root({
            "root/child/file.txt": b"child data",
            "other/ok.txt": b"ok",
        })
        rclone = SimulatedRclone({
            "dropbox:root": [
                SimulatedLsjsonResponse(
                    items=[remote_dir_item("child")],
                    wait_event=root_release,
                    started_event=root_started,
                ),
                SimulatedLsjsonResponse(items=[remote_dir_item("child")]),
            ],
            "dropbox:root/child": [
                SimulatedLsjsonResponse(items=[
                    remote_file_item("file.txt", local_root / "root" / "child" / "file.txt"),
                ]),
            ],
            "dropbox:other": [
                SimulatedLsjsonResponse(items=[
                    remote_file_item("ok.txt", local_root / "other" / "ok.txt"),
                ]),
            ],
        })
        app = self._build_app(rclone, local_root=local_root, workers=2)
        cache = app.folder_cache
        assert cache is not None

        page1 = time.time()
        cache.request("dropbox:root", page1)
        wait_until(root_started.is_set, description="root folder to start")

        page2 = page1 + 1
        cache.request("dropbox:other", page2)
        root_release.set()
        wait_until(lambda: cache.status("dropbox:root") != "calculating", description="stale root job to finish")

        stale_data = cache.get("dropbox:root") or {}
        self.assertFalse(stale_data.get("complete"))
        self.assertEqual(stale_data.get("size"), 0)

        page3 = page2 + 1
        cache.request("dropbox:root", page3)
        root_data = wait_until(
            lambda: cache.get("dropbox:root") if (cache.get("dropbox:root") or {}).get("complete") else None,
            description="root recompletion after stale partial",
        )

        self.assertEqual(root_data["diff_status"], "synced")
        self.assertTrue(root_data["complete"])
        self.assertEqual(root_data["size"], len(b"child data"))
        self.assertEqual(root_data["file_count"], 1)

    def test_size_only_folder_can_be_requeued_after_newer_page(self) -> None:
        local_root = self.create_local_root({
            "a/one.txt": b"one",
            "a/two.txt": b"two",
            "b/ok.txt": b"ok",
        })
        rclone = SimulatedRclone({
            "dropbox:a": [SimulatedLsjsonResponse(items=[
                remote_file_item("one.txt", local_root / "a" / "one.txt"),
                remote_file_item("two.txt", local_root / "a" / "two.txt"),
            ])],
            "dropbox:b": [SimulatedLsjsonResponse(items=[remote_file_item("ok.txt", local_root / "b" / "ok.txt")])],
        })
        app = self._build_app(
            rclone,
            local_root=local_root,
            workers=2,
        )
        cache = app.folder_cache
        assert cache is not None

        page1 = time.time()
        cache.request("dropbox:a", page1)
        wait_until(lambda: (cache.get("dropbox:a") or {}).get("complete"), description="folder a initial completion")

        page2 = page1 + 1
        cache.notify_page_load(page2)
        cache.request("dropbox:b", page2)

        wait_until(lambda: (cache.get("dropbox:b") or {}).get("complete"), description="folder b completion")
        wait_until(lambda: cache.status("dropbox:a") != "calculating", description="folder a ready after page change")

        page3 = page2 + 1
        cache.request("dropbox:a", page3)
        wait_until(lambda: (cache.get("dropbox:a") or {}).get("complete"), description="folder a requeue completion")

        a_data = cache.get("dropbox:a") or {}
        self.assertEqual(a_data.get("diff_status"), "synced")
        self.assertTrue(a_data.get("complete"))
        events = self.read_trace_events()
        self.assertFalse(any(event["event"] == "job_queued" and event.get("job_type") == "hash" for event in events))

    def test_canceled_child_rerun_allows_parent_tree_to_complete(self) -> None:
        extras_started = threading.Event()
        extras_release = threading.Event()
        local_root = self.create_local_root({
            "root/season/episode.mkv": b"episode",
            "root/season/extras/bonus.mkv": b"bonus",
        })
        rclone = SimulatedRclone({
            "dropbox:root": [SimulatedLsjsonResponse(items=[remote_dir_item("season")])],
            "dropbox:root/season": [SimulatedLsjsonResponse(items=[
                remote_file_item("episode.mkv", local_root / "root" / "season" / "episode.mkv"),
                remote_dir_item("extras"),
            ])],
            "dropbox:root/season/extras": [
                SimulatedLsjsonResponse(
                    items=[remote_file_item("bonus.mkv", local_root / "root" / "season" / "extras" / "bonus.mkv")],
                    wait_event=extras_release,
                    started_event=extras_started,
                ),
                SimulatedLsjsonResponse(items=[
                    remote_file_item("bonus.mkv", local_root / "root" / "season" / "extras" / "bonus.mkv"),
                ]),
            ],
        })
        app = self._build_app(rclone, local_root=local_root, workers=2)
        cache = app.folder_cache
        assert cache is not None

        page1 = time.time()
        cache.request("dropbox:root", page1)
        wait_until(extras_started.is_set, description="extras folder to start")

        page2 = page1 + 1
        cache.notify_page_load(page2)
        cache.request("dropbox:root", page2)
        extras_release.set()

        root_data = wait_until(
            lambda: cache.get("dropbox:root") if (cache.get("dropbox:root") or {}).get("complete") else None,
            description="root completion after canceled child rerun",
        )
        season_data = cache.get("dropbox:root/season") or {}
        extras_data = cache.get("dropbox:root/season/extras") or {}

        self.assertEqual(root_data["diff_status"], "synced")
        self.assertTrue(root_data["complete"])
        self.assertEqual(season_data.get("diff_status"), "synced")
        self.assertTrue(season_data.get("complete"))
        self.assertEqual(extras_data.get("diff_status"), "synced")
        self.assertTrue(extras_data.get("complete"))
        self.assertGreaterEqual(
            sum(1 for call in rclone.calls if call["target"] == "dropbox:root/season/extras"),
            2,
        )

    def test_refreshed_queued_root_is_reenqueued_after_old_job_canceled(self) -> None:
        block_started = threading.Event()
        block_release = threading.Event()
        local_root = self.create_local_root({
            "root/file.txt": b"ok",
        })
        rclone = SimulatedRclone({
            "dropbox:block": [SimulatedLsjsonResponse(items=[], wait_event=block_release, started_event=block_started)],
            "dropbox:root": [SimulatedLsjsonResponse(items=[
                remote_file_item("file.txt", local_root / "root" / "file.txt"),
            ])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)
        cache = app.folder_cache
        assert cache is not None

        page0 = time.time()
        cache.request("dropbox:block", page0)
        wait_until(block_started.is_set, description="block folder to start")

        page1 = page0 + 1
        cache.request("dropbox:root", page1)

        page2 = page1 + 1
        cache.request("dropbox:root", page2)

        page3 = page2 + 1
        cache.notify_page_load(page3)
        block_release.set()
        wait_until(lambda: cache.status("dropbox:block") != "calculating", description="block folder cancellation")

        page4 = page3 + 1
        cache.request("dropbox:root", page4)

        data = wait_until(
            lambda: cache.get("dropbox:root") if (cache.get("dropbox:root") or {}).get("complete") else None,
            description="root completion after queued job cancellation",
        )

        self.assertEqual(data["diff_status"], "synced")
        self.assertTrue(data["complete"])
        self.assertGreaterEqual(
            sum(1 for call in rclone.calls if call["target"] == "dropbox:root"),
            1,
        )

    def test_size_only_sync_queues_no_hash_jobs(self) -> None:
        local_root = self.create_local_root({
            "many/alpha.txt": b"alpha",
            "many/bravo.txt": b"bravo",
            "many/charlie.txt": b"charlie",
        })
        rclone = SimulatedRclone({
            "dropbox:many": [SimulatedLsjsonResponse(items=[
                remote_file_item("alpha.txt", local_root / "many" / "alpha.txt"),
                remote_file_item("bravo.txt", local_root / "many" / "bravo.txt"),
                remote_file_item("charlie.txt", local_root / "many" / "charlie.txt"),
            ])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=2)
        cache = app.folder_cache
        assert cache is not None

        cache.request("dropbox:many", time.time())
        data = wait_until(
            lambda: cache.get("dropbox:many") if (cache.get("dropbox:many") or {}).get("complete") else None,
            description="folder completion",
        )

        self.assertEqual(data["diff_status"], "synced")
        events = self.read_trace_events()
        queued_hash = [
            event for event in events
            if event["event"] == "job_queued"
            and event.get("remote_path") == "dropbox:many"
            and event.get("job_type") == "hash"
        ]
        self.assertEqual(queued_hash, [])
        self.assertEqual(data["file_statuses"]["alpha.txt"]["diff_status"], "synced")
        self.assertEqual(data["file_statuses"]["bravo.txt"]["diff_status"], "synced")
        self.assertEqual(data["file_statuses"]["charlie.txt"]["diff_status"], "synced")

    def test_extra_local_file_does_not_leave_matched_remote_files_loading(self) -> None:
        local_root = self.create_local_root({
            "af_vid_dl/af_audio_download.py": b"print('ok')\n",
            "af_vid_dl/af_audio_download (1).py": b"print('extra')\n",
        })
        rclone = SimulatedRclone({
            "dropbox:af_vid_dl": [SimulatedLsjsonResponse(items=[
                remote_file_item("af_audio_download.py", local_root / "af_vid_dl" / "af_audio_download.py"),
            ])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)
        cache = app.folder_cache
        assert cache is not None

        cache.request("dropbox:af_vid_dl", time.time())
        data = wait_until(
            lambda: cache.get("dropbox:af_vid_dl") if (cache.get("dropbox:af_vid_dl") or {}).get("complete") else None,
            description="af_vid_dl completion",
        )

        self.assertEqual(data["diff_status"], "has_diffs")
        self.assertEqual(data["first_diff_path"], "Local only: af_audio_download (1).py")
        self.assertEqual(data["file_statuses"]["af_audio_download.py"]["diff_status"], "synced")

    def test_direct_diff_does_not_complete_before_recursive_size_finishes(self) -> None:
        local_root = self.create_local_root({
            "af_vid_dl/af_audio_download.py": b"print('ok')\n",
            "af_vid_dl/af_audio_download (1).py": b"print('extra')\n",
            "af_vid_dl/nested/video.mp4": b"x" * 4096,
        })
        rclone = SimulatedRclone({
            "dropbox:af_vid_dl": [SimulatedLsjsonResponse(items=[
                remote_file_item("af_audio_download.py", local_root / "af_vid_dl" / "af_audio_download.py"),
                remote_dir_item("nested"),
            ])],
            "dropbox:af_vid_dl/nested": [SimulatedLsjsonResponse(items=[
                remote_file_item("video.mp4", local_root / "af_vid_dl" / "nested" / "video.mp4"),
            ])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)
        cache = app.folder_cache
        assert cache is not None

        cache.request("dropbox:af_vid_dl", time.time())
        data = wait_until(
            lambda: cache.get("dropbox:af_vid_dl") if (cache.get("dropbox:af_vid_dl") or {}).get("complete") else None,
            description="af_vid_dl recursive metadata completion",
        )

        self.assertEqual(data["diff_status"], "has_diffs")
        self.assertEqual(data["first_diff_path"], "Local only: af_audio_download (1).py")
        self.assertEqual(data["size"], len(b"print('ok')\n") + 4096)
        self.assertEqual(data["file_count"], 2)
        self.assertTrue(any(call["target"] == "dropbox:af_vid_dl/nested" for call in rclone.calls))

    def test_folder_worker_exception_completes_with_failure_state(self) -> None:
        local_root = self.create_local_root({})
        rclone = SimulatedRclone({
            "dropbox:broken": [SimulatedLsjsonResponse(exception=RuntimeError("boom"))],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)
        cache = app.folder_cache
        assert cache is not None

        cache.request("dropbox:broken", time.time())
        data = wait_until(
            lambda: cache.get("dropbox:broken") if (cache.get("dropbox:broken") or {}).get("complete") else None,
            description="broken folder completion",
        )

        self.assertEqual(data["first_diff_path"], "Background folder job failed")
        self.assertEqual(data["diff_status"], "has_diffs")
        self.assertNotEqual(cache.status("dropbox:broken"), "calculating")

    def test_dropbox_only_folder_finishes_without_hanging(self) -> None:
        local_root = self.create_local_root({})
        remote_file = {
            "Name": "only.txt",
            "Path": "only.txt",
            "IsDir": False,
            "Size": 4,
            "ModTime": "2024-01-01T12:00:00Z",
        }
        rclone = SimulatedRclone({
            "dropbox:only": [SimulatedLsjsonResponse(items=[remote_file])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)
        cache = app.folder_cache
        assert cache is not None

        cache.request("dropbox:only", time.time())
        data = wait_until(
            lambda: cache.get("dropbox:only") if (cache.get("dropbox:only") or {}).get("complete") else None,
            description="dropbox-only completion",
        )

        self.assertEqual(data["diff_status"], "dropbox_only")
        self.assertEqual(cache.status("dropbox:only"), "complete")

    def test_dropbox_only_folder_with_subfolder_keeps_status_and_completes_size(self) -> None:
        local_root = self.create_local_root({})
        rclone = SimulatedRclone({
            "dropbox:only": [SimulatedLsjsonResponse(items=[
                remote_dir_item("nested"),
            ])],
            "dropbox:only/nested": [SimulatedLsjsonResponse(items=[
                {
                    "Name": "child.txt",
                    "Path": "child.txt",
                    "IsDir": False,
                    "Size": 7,
                    "ModTime": "2024-01-01T12:00:00Z",
                },
            ])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)
        cache = app.folder_cache
        assert cache is not None

        cache.request("dropbox:only", time.time())
        data = wait_until(
            lambda: cache.get("dropbox:only") if (cache.get("dropbox:only") or {}).get("complete") else None,
            description="dropbox-only nested completion",
        )

        self.assertEqual(data["diff_status"], "dropbox_only")
        self.assertEqual(data["size"], 7)
        self.assertEqual(data["file_count"], 1)

    def test_sync_controls_render_in_separate_view_and_sync_columns(self) -> None:
        local_root = self.create_local_root({
            "local.txt": b"local",
            "folder/inside.txt": b"inside",
        })
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[
                remote_dir_item("folder"),
            ])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            html = server.get_text("/")

        self.assertIn("<th>View</th>", html)
        self.assertIn("<th>Sync</th>", html)
        self.assertNotIn('action="/upload', html)
        self.assertNotIn("Upload New File", html)
        self.assertIn("spotco's Dropbox Browser", html)
        self.assertIn('id="enable-to-local"', html)
        self.assertIn('id="enable-write-dropbox"', html)
        self.assertIn("Enable sync to local", html)
        self.assertIn("Enable sync to Dropbox", html)
        self.assertIn("Copy Local -&gt; Dropbox", html)
        self.assertIn('data-sync-direction="local_to_dropbox"', html)
        self.assertIn('name="enable_to_local" value="0"', html)
        self.assertIn('name="enable_write_dropbox" value="0"', html)
        self.assertIn("body.sync-to-local-enabled .sync-form[data-sync-direction=\"dropbox_to_local\"]", html)
        self.assertIn("body.sync-to-dropbox-enabled .sync-form[data-sync-direction=\"local_to_dropbox\"]", html)
        self.assertIn("Settings.get('sync-enable-to-local', false)", html)
        self.assertIn("Settings.get('sync-enable-write-dropbox', false)", html)
        self.assertIn("Settings.set('sync-enable-to-local', enableToLocal.checked)", html)
        self.assertIn("Settings.set('sync-enable-write-dropbox', enableWriteDropbox.checked)", html)
        self.assertIn("var syncBusyCount = 0", html)
        self.assertIn("setSyncBusy(true)", html)
        self.assertIn(".sync-form button, .batch-sync, #batch-confirm-run, #batch-confirm-cancel", html)
        self.assertIn("button.disabled = busy || baseDisabled", html)
        self.assertIn("if (syncBusyCount > 0) return;", html)
        self.assertIn('id="batch-recursive"', html)
        self.assertIn("width: calc(100% - 32px)", html)
        self.assertIn("max-width: none", html)
        self.assertIn("Sync All Local to Dropbox", html)
        self.assertIn("Delete all Local-Only Files", html)
        self.assertIn("Copy all Dropbox-Only Files to Local", html)
        self.assertIn('data-batch-action="delete_local_only_all"', html)
        self.assertIn('data-batch-action="dropbox_only_to_local_all"', html)
        self.assertIn(".batch-delete-local", html)
        self.assertIn("body.sync-to-local-enabled .recursive-toggle", html)
        self.assertIn("body.sync-to-dropbox-enabled .recursive-toggle", html)
        self.assertIn("'[' + data.current + '/' + data.total + '] '", html)
        self.assertIn("function scrollLogToBottom()", html)
        self.assertIn("if (!collapsed) {", html)
        self.assertIn("scrollLogToBottom();", html)
        self.assertIn("sync-batch-plan", html)
        self.assertIn("batch-confirm-list", html)
        self.assertIn("setBaseDisabled(batchRun, !plan.total)", html)
        folder_row = html.split('<span class="entry-name">folder</span></a></td>', 1)[1].split("</tr>", 1)[0]
        self.assertIn('data-sync-kind="folder"', folder_row)
        self.assertNotIn("sync-form", folder_row)

    def test_entry_rows_render_material_file_type_icons(self) -> None:
        local_root = self.create_local_root({
            "archive.rar": b"archive",
            "movie.mkv": b"video",
            "program.exe": b"exe",
            "unknown.bin": b"bin",
            "folder/inside.txt": b"inside",
        })
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[
                remote_file_item("archive.rar", local_root / "archive.rar"),
                remote_file_item("movie.mkv", local_root / "movie.mkv"),
                remote_file_item("program.exe", local_root / "program.exe"),
                remote_file_item("unknown.bin", local_root / "unknown.bin"),
                remote_dir_item("folder"),
            ])],
        })
        app = self._build_app(rclone, local_root=local_root)

        with TestServer(app) as server:
            html = server.get_text("/")
            icon_svg = server.get_text("/assets/icons/material-icon-theme/folder-base.svg")
            favicon_svg = server.get_text("/assets/icons/material-icon-theme/box-favicon.svg")

        self.assertIn('<link rel="icon" type="image/svg+xml" href="/assets/icons/material-icon-theme/box-favicon.svg">', html)
        self.assertIn('src="/assets/icons/material-icon-theme/folder-base.svg"', html)
        self.assertIn('src="/assets/icons/material-icon-theme/zip.svg"', html)
        self.assertIn('src="/assets/icons/material-icon-theme/video.svg"', html)
        self.assertIn('src="/assets/icons/material-icon-theme/exe.svg"', html)
        self.assertIn('src="/assets/icons/material-icon-theme/document.svg"', html)
        self.assertIn("<svg", icon_svg)
        self.assertIn("<svg", favicon_svg)

    def test_head_requests_for_page_and_icon_return_headers_without_body(self) -> None:
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[])],
        })
        app = self._build_app(rclone, local_root=None, workers=1)

        with TestServer(app) as server:
            page_request = Request(server.base_url + "/", method="HEAD")
            with urlopen(page_request, timeout=5) as response:
                page_body = response.read()
                page_headers = response.headers
                page_status = response.status

            icon_request = Request(
                server.base_url + "/assets/icons/material-icon-theme/video.svg",
                method="HEAD",
            )
            with urlopen(icon_request, timeout=5) as response:
                icon_body = response.read()
                icon_headers = response.headers
                icon_status = response.status

        self.assertEqual(page_status, HTTPStatus.OK)
        self.assertEqual(page_body, b"")
        self.assertEqual(page_headers["Content-Type"], "text/html; charset=utf-8")
        self.assertGreater(int(page_headers["Content-Length"]), 0)
        self.assertEqual(icon_status, HTTPStatus.OK)
        self.assertEqual(icon_body, b"")
        self.assertEqual(icon_headers["Content-Type"], "image/svg+xml; charset=utf-8")
        self.assertGreater(int(icon_headers["Content-Length"]), 0)

    def test_copy_buttons_cover_current_folder_and_local_file_paths(self) -> None:
        local_root = self.create_local_root({
            "both.txt": b"both",
            "local.txt": b"local",
            "folder/inside.txt": b"inside",
        })
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[
                remote_file_item("both.txt", local_root / "both.txt"),
                {
                    "Name": "remote.txt",
                    "Path": "remote.txt",
                    "IsDir": False,
                    "Size": 6,
                    "ModTime": "2024-01-01T12:00:00Z",
                },
            ])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            html = server.get_text("/")

        self.assertIn('<div class="topbar-actions">', html)
        self.assertIn(">Copy Folder Path</button>", html)
        self.assertIn('href="https://www.dropbox.com/home"', html)
        self.assertIn('target="_blank"', html)
        self.assertIn(">Copy Filepath</button>", html)
        self.assertIn('class="copy-path"', html)
        self.assertIn(f'data-copy-path="{local_root}"', html)
        self.assertIn(f'data-copy-path="{local_root / "both.txt"}"', html)
        self.assertIn(f'data-copy-path="{local_root / "local.txt"}"', html)
        self.assertIn("navigator.clipboard.writeText(path)", html)
        self.assertIn("document.execCommand('copy')", html)
        remote_row = html.split('<span class="entry-name">remote.txt</span></a></td>', 1)[1].split("</tr>", 1)[0]
        self.assertNotIn("copy-path", remote_row)

    def test_local_file_streams_full_response_with_range_support_headers(self) -> None:
        local_root = self.create_local_root({"movie.mp4": b"0123456789"})
        rclone = SimulatedRclone({})
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            with urlopen(server.base_url + "/file?path=movie.mp4&source=local", timeout=5) as response:
                body = response.read()
                status = response.status
                headers = response.headers

        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(body, b"0123456789")
        self.assertEqual(headers["Accept-Ranges"], "bytes")
        self.assertEqual(headers["Content-Length"], "10")

    def test_local_file_streams_requested_byte_range(self) -> None:
        local_root = self.create_local_root({"movie.mp4": b"0123456789"})
        rclone = SimulatedRclone({})
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            request = Request(
                server.base_url + "/file?path=movie.mp4&source=local",
                headers={"Range": "bytes=2-5"},
            )
            with urlopen(request, timeout=5) as response:
                body = response.read()
                status = response.status
                headers = response.headers

        self.assertEqual(status, HTTPStatus.PARTIAL_CONTENT)
        self.assertEqual(body, b"2345")
        self.assertEqual(headers["Content-Range"], "bytes 2-5/10")
        self.assertEqual(headers["Content-Length"], "4")
        self.assertEqual(headers["Accept-Ranges"], "bytes")

    def test_local_file_streams_suffix_range(self) -> None:
        local_root = self.create_local_root({"song.mp3": b"0123456789"})
        rclone = SimulatedRclone({})
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            request = Request(
                server.base_url + "/file?path=song.mp3&source=local",
                headers={"Range": "bytes=-4"},
            )
            with urlopen(request, timeout=5) as response:
                body = response.read()
                headers = response.headers

        self.assertEqual(body, b"6789")
        self.assertEqual(headers["Content-Range"], "bytes 6-9/10")

    def test_local_file_head_returns_range_headers_without_body(self) -> None:
        local_root = self.create_local_root({"song.mp3": b"0123456789"})
        rclone = SimulatedRclone({})
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            request = Request(
                server.base_url + "/file?path=song.mp3&source=local",
                method="HEAD",
                headers={"Range": "bytes=1-3"},
            )
            with urlopen(request, timeout=5) as response:
                body = response.read()
                status = response.status
                headers = response.headers

        self.assertEqual(status, HTTPStatus.PARTIAL_CONTENT)
        self.assertEqual(body, b"")
        self.assertEqual(headers["Content-Range"], "bytes 1-3/10")
        self.assertEqual(headers["Content-Length"], "3")

    def test_local_file_invalid_range_returns_416(self) -> None:
        local_root = self.create_local_root({"song.mp3": b"0123456789"})
        rclone = SimulatedRclone({})
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            request = Request(
                server.base_url + "/file?path=song.mp3&source=local",
                headers={"Range": "bytes=99-"},
            )
            with self.assertRaises(HTTPError) as raised:
                urlopen(request, timeout=5)

        self.assertEqual(raised.exception.code, HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
        self.assertEqual(raised.exception.headers["Content-Range"], "bytes */10")
        try:
            self.assertEqual(raised.exception.read(), b"")
        finally:
            raised.exception.close()

    def test_remote_file_range_uses_rclone_offset_and_count(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(rclone, local_root=None, workers=1)

        with TestServer(app) as server:
            request = Request(
                server.base_url + "/file?path=movie.mp4",
                headers={"Range": "bytes=3-6"},
            )
            with urlopen(request, timeout=5) as response:
                body = response.read()
                headers = response.headers

        self.assertEqual(body, b"3456")
        self.assertEqual(headers["Content-Range"], "bytes 3-6/10")
        self.assertTrue(any(
            call["args"] == ("cat", "--offset", "3", "--count", "4", "--", "dropbox:movie.mp4")
            for call in rclone.calls
        ))

    def test_nested_remote_file_range_lists_parent_and_streams_nested_target(self) -> None:
        rclone = SimulatedRclone({
            "dropbox:Albums/Live Set": [SimulatedLsjsonResponse(items=[{
                "Name": "clip.mp4",
                "Path": "clip.mp4",
                "IsDir": False,
                "Size": 10,
                "ModTime": "2024-01-01T12:00:00Z",
            }])],
        }, cat_data={"dropbox:Albums/Live Set/clip.mp4": b"0123456789"})
        app = self._build_app(rclone, local_root=None, workers=1)

        with TestServer(app) as server:
            request = Request(
                server.base_url + "/file?path=Albums%2FLive%20Set%2Fclip.mp4",
                headers={"Range": "bytes=4-7"},
            )
            with urlopen(request, timeout=5) as response:
                body = response.read()
                headers = response.headers

        self.assertEqual(body, b"4567")
        self.assertEqual(headers["Content-Range"], "bytes 4-7/10")
        self.assertTrue(any(
            call["args"] == ("lsjson", "--", "dropbox:Albums/Live Set")
            for call in rclone.calls
        ))
        self.assertTrue(any(
            call["args"] == (
                "cat",
                "--offset",
                "4",
                "--count",
                "4",
                "--",
                "dropbox:Albums/Live Set/clip.mp4",
            )
            for call in rclone.calls
        ))

    def test_remote_file_full_response_uses_plain_rclone_cat(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(rclone, local_root=None, workers=1)

        with TestServer(app) as server:
            with urlopen(server.base_url + "/file?path=movie.mp4", timeout=5) as response:
                body = response.read()
                status = response.status
                headers = response.headers

        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(body, b"0123456789")
        self.assertEqual(headers["Content-Length"], "10")
        self.assertEqual(headers["Accept-Ranges"], "bytes")
        self.assertTrue(any(
            call["args"] == ("cat", "--", "dropbox:movie.mp4")
            for call in rclone.calls
        ))

    def test_remote_file_open_ended_range_uses_rclone_offset_and_count(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(rclone, local_root=None, workers=1)

        with TestServer(app) as server:
            request = Request(
                server.base_url + "/file?path=movie.mp4",
                headers={"Range": "bytes=7-"},
            )
            with urlopen(request, timeout=5) as response:
                body = response.read()
                headers = response.headers

        self.assertEqual(body, b"789")
        self.assertEqual(headers["Content-Range"], "bytes 7-9/10")
        self.assertTrue(any(
            call["args"] == ("cat", "--offset", "7", "--count", "3", "--", "dropbox:movie.mp4")
            for call in rclone.calls
        ))

    def test_remote_file_suffix_range_uses_rclone_offset_and_count(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(rclone, local_root=None, workers=1)

        with TestServer(app) as server:
            request = Request(
                server.base_url + "/file?path=movie.mp4",
                headers={"Range": "bytes=-4"},
            )
            with urlopen(request, timeout=5) as response:
                body = response.read()
                headers = response.headers

        self.assertEqual(body, b"6789")
        self.assertEqual(headers["Content-Range"], "bytes 6-9/10")
        self.assertTrue(any(
            call["args"] == ("cat", "--offset", "6", "--count", "4", "--", "dropbox:movie.mp4")
            for call in rclone.calls
        ))

    def test_remote_file_head_does_not_open_rclone_cat(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(rclone, local_root=None, workers=1)

        with TestServer(app) as server:
            request = Request(
                server.base_url + "/file?path=movie.mp4",
                method="HEAD",
                headers={"Range": "bytes=1-3"},
            )
            with urlopen(request, timeout=5) as response:
                body = response.read()
                status = response.status
                headers = response.headers

        self.assertEqual(status, HTTPStatus.PARTIAL_CONTENT)
        self.assertEqual(body, b"")
        self.assertEqual(headers["Content-Range"], "bytes 1-3/10")
        self.assertEqual(headers["Content-Length"], "3")
        self.assertFalse(any(call["args"][0] == "cat" for call in rclone.calls))

    def test_remote_file_invalid_range_returns_416_without_rclone_cat(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(rclone, local_root=None, workers=1)

        with TestServer(app) as server:
            request = Request(
                server.base_url + "/file?path=movie.mp4",
                headers={"Range": "bytes=99-"},
            )
            with self.assertRaises(HTTPError) as raised:
                urlopen(request, timeout=5)

        self.assertEqual(raised.exception.code, HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
        self.assertEqual(raised.exception.headers["Content-Range"], "bytes */10")
        try:
            self.assertEqual(raised.exception.read(), b"")
        finally:
            raised.exception.close()
        self.assertFalse(any(call["args"][0] == "cat" for call in rclone.calls))

    def test_download_route_supports_byte_ranges_and_attachment_disposition(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(rclone, local_root=None, workers=1)

        with TestServer(app) as server:
            request = Request(
                server.base_url + "/download?path=movie.mp4",
                headers={"Range": "bytes=2-5"},
            )
            with urlopen(request, timeout=5) as response:
                body = response.read()
                status = response.status
                headers = response.headers

        self.assertEqual(status, HTTPStatus.PARTIAL_CONTENT)
        self.assertEqual(body, b"2345")
        self.assertEqual(headers["Content-Range"], "bytes 2-5/10")
        self.assertEqual(
            headers["Content-Disposition"],
            'attachment; filename="movie.mp4"; filename*=UTF-8\'\'movie.mp4',
        )

    def test_download_route_uses_utf8_filename_disposition(self) -> None:
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[{
                "Name": "café mix.mp3",
                "Path": "café mix.mp3",
                "IsDir": False,
                "Size": 5,
                "ModTime": "2024-01-01T12:00:00Z",
            }])],
        }, cat_data={"dropbox:café mix.mp3": b"audio"})
        app = self._build_app(rclone, local_root=None, workers=1)

        with TestServer(app) as server:
            with urlopen(server.base_url + "/download?path=" + quote("café mix.mp3"), timeout=5) as response:
                body = response.read()
                headers = response.headers

        self.assertEqual(body, b"audio")
        self.assertEqual(
            headers["Content-Disposition"],
            'attachment; filename="caf? mix.mp3"; filename*=UTF-8\'\'caf%C3%A9%20mix.mp3',
        )

    def test_go_to_dropbox_link_encodes_current_folder_path(self) -> None:
        local_root = self.create_local_root({
            "THE DUMP/Garcello & Slynk/Garcello/local.txt": b"local",
            "Plus+Folder/local.txt": b"plus",
        })
        rclone = SimulatedRclone({
            "dropbox:THE DUMP/Garcello & Slynk/Garcello": [SimulatedLsjsonResponse(items=[])],
            "dropbox:Plus+Folder": [SimulatedLsjsonResponse(items=[])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            html = server.get_text("/?path=THE%20DUMP%2FGarcello%20%26%20Slynk%2FGarcello")
            plus_html = server.get_text("/?path=Plus%2BFolder")

        self.assertIn(
            'href="https://www.dropbox.com/home/THE%20DUMP/Garcello%20%26%20Slynk/Garcello"',
            html,
        )
        self.assertIn('href="https://www.dropbox.com/home/Plus%2BFolder"', plus_html)

    def test_sync_post_requires_enabled_guard(self) -> None:
        local_root = self.create_local_root({
            "local.txt": b"local",
        })
        rclone = SimulatedRclone({})
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            body = b"path=local.txt&kind=file&direction=local_to_dropbox&enable_write_dropbox=0"
            request = Request(
                server.base_url + "/sync",
                data=body,
                method="POST",
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            with self.assertRaises(HTTPError) as ctx:
                urlopen(request, timeout=5)

        self.assertEqual(ctx.exception.code, 403)
        ctx.exception.close()

    def test_upload_endpoint_is_not_available(self) -> None:
        local_root = self.create_local_root({})
        rclone = SimulatedRclone({})
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            request = Request(
                server.base_url + "/upload",
                data=b"",
                method="POST",
                headers={"Content-Type": "multipart/form-data; boundary=x"},
            )
            with self.assertRaises(HTTPError) as ctx:
                urlopen(request, timeout=5)

        self.assertEqual(ctx.exception.code, 404)
        ctx.exception.close()

    def test_sync_post_requires_direction_specific_enabled_guard(self) -> None:
        local_root = self.create_local_root({})
        rclone = SimulatedRclone(cat_data={
            "dropbox:remote.txt": b"remote",
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            body = b"path=remote.txt&kind=file&direction=dropbox_to_local&enable_to_local=0&enable_write_dropbox=1"
            request = Request(
                server.base_url + "/sync",
                data=body,
                method="POST",
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            with self.assertRaises(HTTPError) as ctx:
                urlopen(request, timeout=5)

        self.assertEqual(ctx.exception.code, 403)
        ctx.exception.close()

    def test_sync_post_rejects_folder_kind(self) -> None:
        local_root = self.create_local_root({
            "folder/inside.txt": b"inside",
        })
        rclone = SimulatedRclone({})
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            body = b"path=folder&kind=folder&direction=local_to_dropbox&enable_write_dropbox=1"
            request = Request(
                server.base_url + "/sync",
                data=body,
                method="POST",
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            with self.assertRaises(HTTPError) as ctx:
                urlopen(request, timeout=5)

        self.assertEqual(ctx.exception.code, 400)
        ctx.exception.close()

    def test_sync_local_only_file_copies_local_to_dropbox(self) -> None:
        local_root = self.create_local_root({
            "local.txt": b"local",
        })
        rclone = SimulatedRclone({})
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            payload = server.post_json("/sync", {
                "path": "local.txt",
                "kind": "file",
                "direction": "local_to_dropbox",
                "enable_write_dropbox": "1",
            })
            result = wait_until(
                lambda: server.get_json("/sync-status?id=" + payload["id"])
                if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
                else None,
                description="local-to-dropbox sync completion",
            )

        self.assertEqual(result["status"], "complete")
        self.assertEqual(rclone.cat_data["dropbox:local.txt"], b"local")
        self.assertTrue(any(call["args"][0] == "copyto" and call["target"] == "dropbox:local.txt" for call in rclone.calls))

    def test_sync_dropbox_only_file_copies_dropbox_to_local(self) -> None:
        local_root = self.create_local_root({})
        rclone = SimulatedRclone(cat_data={
            "dropbox:remote.txt": b"remote",
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            payload = server.post_json("/sync", {
                "path": "remote.txt",
                "kind": "file",
                "direction": "dropbox_to_local",
                "enable_to_local": "1",
            })
            result = wait_until(
                lambda: server.get_json("/sync-status?id=" + payload["id"])
                if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
                else None,
                description="dropbox-to-local sync completion",
            )

        self.assertEqual(result["status"], "complete")
        self.assertEqual((local_root / "remote.txt").read_bytes(), b"remote")
        self.assertTrue(any(call["args"][0] == "copyto" and call["target"] == str(local_root / "remote.txt") for call in rclone.calls))

    def test_sync_dropbox_only_nested_file_does_not_copy_to_partial_ancestor_path(self) -> None:
        local_root = self.create_local_root({
            "conan/Season Pack": b"misplaced episode bytes",
        })
        rclone = SimulatedRclone(cat_data={
            "dropbox:conan/Season Pack/Episodes/episode 001.mkv": b"episode",
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            payload = server.post_json("/sync", {
                "path": "conan/Season Pack/Episodes/episode 001.mkv",
                "kind": "file",
                "direction": "dropbox_to_local",
                "enable_to_local": "1",
            })
            result = wait_until(
                lambda: server.get_json("/sync-status?id=" + payload["id"])
                if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
                else None,
                description="nested dropbox-to-local sync completion",
            )

        expected = local_root / "conan" / "Season Pack" / "Episodes" / "episode 001.mkv"
        bad_partial = local_root / "conan" / "Season Pack"
        self.assertEqual(result["status"], "error")
        self.assertEqual(bad_partial.read_bytes(), b"misplaced episode bytes")
        self.assertFalse(expected.exists())
        self.assertFalse(any(
            call["args"][0] == "copyto" and call["target"] == str(bad_partial)
            for call in rclone.calls
        ))

    def test_sync_dropbox_only_nested_file_uses_full_safe_destination_path(self) -> None:
        local_root = self.create_local_root({})
        rclone = SimulatedRclone(cat_data={
            "dropbox:conan/Season Pack/Episodes/episode 001.mkv": b"episode",
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            payload = server.post_json("/sync", {
                "path": "conan/Season Pack/Episodes/episode 001.mkv",
                "kind": "file",
                "direction": "dropbox_to_local",
                "enable_to_local": "1",
            })
            result = wait_until(
                lambda: server.get_json("/sync-status?id=" + payload["id"])
                if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
                else None,
                description="nested dropbox-to-local sync completion",
            )

        expected = local_root / "conan" / "Season Pack" / "Episodes" / "episode 001.mkv"
        self.assertEqual(result["status"], "complete")
        self.assertEqual(expected.read_bytes(), b"episode")
        self.assertTrue(any(
            call["args"][0] == "copyto" and call["target"] == str(expected)
            for call in rclone.calls
        ))

    def test_batch_plan_lists_current_folder_files_by_action(self) -> None:
        local_root = self.create_local_root({
            "local.txt": b"local",
            "changed.txt": b"local",
            "synced.txt": b"synced",
            "child/local-child.txt": b"child",
            ".DS_Store": b"ignored",
        })
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[
                {"Name": "changed.txt", "Path": "changed.txt", "IsDir": False, "Size": 99, "ModTime": "2024-01-01T12:00:00Z"},
                {"Name": "remote.txt", "Path": "remote.txt", "IsDir": False, "Size": 6, "ModTime": "2024-01-01T12:00:00Z"},
                remote_file_item("synced.txt", local_root / "synced.txt"),
                remote_dir_item("child"),
            ])],
            "dropbox:child": [SimulatedLsjsonResponse(items=[
                {"Name": "remote-child.txt", "Path": "child/remote-child.txt", "IsDir": False, "Size": 7, "ModTime": "2024-01-01T12:00:00Z"},
            ])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            nonrecursive = server.post_json("/sync-batch-plan", {
                "action": "local_to_dropbox_all",
                "recursive": "0",
                "enable_write_dropbox": "1",
            })
            recursive = server.post_json("/sync-batch-plan", {
                "action": "local_to_dropbox_all",
                "recursive": "1",
                "enable_write_dropbox": "1",
            })
            delete_local = server.post_json("/sync-batch-plan", {
                "action": "delete_local_only_all",
                "recursive": "0",
                "enable_to_local": "1",
            })
            copy_to_local = server.post_json("/sync-batch-plan", {
                "action": "dropbox_only_to_local_all",
                "recursive": "0",
                "enable_to_local": "1",
            })
            copy_to_local_recursive = server.post_json("/sync-batch-plan", {
                "action": "dropbox_only_to_local_all",
                "recursive": "1",
                "enable_to_local": "1",
            })

        self.assertEqual([item["path"] for item in nonrecursive["groups"]["local_to_dropbox"]], ["changed.txt", "local.txt"])
        self.assertEqual([item["path"] for item in recursive["groups"]["local_to_dropbox"]], ["child/local-child.txt", "changed.txt", "local.txt"])
        self.assertEqual([item["path"] for item in delete_local["groups"]["delete_local"]], ["local.txt"])
        self.assertEqual([item["path"] for item in copy_to_local["groups"]["dropbox_to_local"]], ["remote.txt"])
        self.assertEqual([item["path"] for item in copy_to_local_recursive["groups"]["dropbox_to_local"]], ["child/remote-child.txt", "remote.txt"])
        self.assertNotIn(".DS_Store", str(nonrecursive))

    def test_recursive_batch_plan_uses_sync_worker_concurrency(self) -> None:
        local_root = self.create_local_root({})
        release = threading.Event()
        started_a = threading.Event()
        started_b = threading.Event()
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[
                remote_dir_item("a"),
                remote_dir_item("b"),
            ]), SimulatedLsjsonResponse(items=[
                remote_dir_item("a"),
                remote_dir_item("b"),
            ])],
            "dropbox:a": [
                SimulatedLsjsonResponse(items=[], wait_event=release, started_event=started_a),
                SimulatedLsjsonResponse(items=[]),
            ],
            "dropbox:b": [
                SimulatedLsjsonResponse(items=[], wait_event=release, started_event=started_b),
                SimulatedLsjsonResponse(items=[]),
            ],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1, sync_workers=2)
        plan_holder: dict[str, Any] = {}

        def run_plan() -> None:
            plan_holder["plan"] = app.plan_batch_sync("", "dropbox_only_to_local_all", recursive=True)

        thread = threading.Thread(target=run_plan)
        thread.start()
        try:
            wait_until(started_a.is_set, description="first child planning listing")
            wait_until(started_b.is_set, description="second child planning listing")
        finally:
            release.set()
            thread.join(timeout=5)

        self.assertFalse(thread.is_alive())
        self.assertEqual(
            [item["path"] for item in plan_holder["plan"]["groups"]["dropbox_dir_to_local"]],
            ["a", "b"],
        )

    def test_batch_delete_local_only_runs_per_file(self) -> None:
        local_root = self.create_local_root({
            "local.txt": b"local",
            "local-folder/inside.txt": b"inside",
            "changed.txt": b"local",
            "synced.txt": b"synced",
        })
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[
                {"Name": "changed.txt", "Path": "changed.txt", "IsDir": False, "Size": 6, "ModTime": "2024-01-01T12:00:00Z"},
                remote_file_item("synced.txt", local_root / "synced.txt"),
            ])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            payload = server.post_json("/sync-batch", {
                "action": "delete_local_only_all",
                "recursive": "0",
                "enable_to_local": "1",
            })
            result = wait_until(
                lambda: server.get_json("/sync-status?id=" + payload["id"])
                if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
                else None,
                description="batch delete completion",
            )

        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["message"], "Batch sync complete")
        self.assertFalse((local_root / "local.txt").exists())
        self.assertFalse((local_root / "local-folder").exists())
        self.assertEqual((local_root / "changed.txt").read_bytes(), b"local")
        self.assertFalse(any(call["args"][0] == "copyto" and call["target"] == str(local_root / "changed.txt") for call in rclone.calls))

    def test_batch_copy_dropbox_only_to_local_runs_per_file(self) -> None:
        local_root = self.create_local_root({
            "changed.txt": b"local",
            "synced.txt": b"synced",
        })
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[
                {"Name": "changed.txt", "Path": "changed.txt", "IsDir": False, "Size": 6, "ModTime": "2024-01-01T12:00:00Z"},
                {"Name": "remote.txt", "Path": "remote.txt", "IsDir": False, "Size": 6, "ModTime": "2024-01-01T12:00:00Z"},
                remote_file_item("synced.txt", local_root / "synced.txt"),
            ])],
        }, cat_data={
            "dropbox:remote.txt": b"remote",
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            payload = server.post_json("/sync-batch", {
                "action": "dropbox_only_to_local_all",
                "recursive": "0",
                "enable_to_local": "1",
            })
            result = wait_until(
                lambda: server.get_json("/sync-status?id=" + payload["id"])
                if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
                else None,
                description="batch copy to local completion",
            )

        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["message"], "Batch sync complete")
        self.assertEqual((local_root / "remote.txt").read_bytes(), b"remote")
        self.assertEqual((local_root / "changed.txt").read_bytes(), b"local")
        self.assertTrue(any(call["args"][0] == "copyto" and call["target"] == str(local_root / "remote.txt") for call in rclone.calls))
        self.assertFalse(any(call["args"][0] == "copyto" and call["target"] == str(local_root / "changed.txt") for call in rclone.calls))

    def test_recursive_batch_copy_dropbox_only_to_local_creates_empty_folders(self) -> None:
        local_root = self.create_local_root({})
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[
                remote_dir_item("empty-remote"),
            ])],
            "dropbox:empty-remote": [SimulatedLsjsonResponse(items=[])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            plan = server.post_json("/sync-batch-plan", {
                "action": "dropbox_only_to_local_all",
                "recursive": "1",
                "enable_to_local": "1",
            })
            payload = server.post_json("/sync-batch", {
                "action": "dropbox_only_to_local_all",
                "recursive": "1",
                "enable_to_local": "1",
            })
            result = wait_until(
                lambda: server.get_json("/sync-status?id=" + payload["id"])
                if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
                else None,
                description="empty remote folder copy completion",
            )

        self.assertEqual([item["path"] for item in plan["groups"]["dropbox_dir_to_local"]], ["empty-remote"])
        self.assertEqual(result["status"], "complete")
        self.assertTrue((local_root / "empty-remote").is_dir())

    def test_recursive_batch_copy_local_to_dropbox_creates_empty_folders(self) -> None:
        local_root = self.create_local_root({
            "empty-local": None,
        })
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[])],
            "dropbox:empty-local": [SimulatedLsjsonResponse(items=[])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            plan = server.post_json("/sync-batch-plan", {
                "action": "local_to_dropbox_all",
                "recursive": "1",
                "enable_write_dropbox": "1",
            })
            payload = server.post_json("/sync-batch", {
                "action": "local_to_dropbox_all",
                "recursive": "1",
                "enable_write_dropbox": "1",
            })
            result = wait_until(
                lambda: server.get_json("/sync-status?id=" + payload["id"])
                if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
                else None,
                description="empty local folder copy completion",
            )

        self.assertEqual([item["path"] for item in plan["groups"]["local_dir_to_dropbox"]], ["empty-local"])
        self.assertEqual(result["status"], "complete")
        self.assertTrue(any(call["args"][0] == "mkdir" and call["target"] == "dropbox:empty-local" for call in rclone.calls))

    def test_recursive_local_to_dropbox_sync_invalidates_parent_listing_cache_for_new_folders(self) -> None:
        local_root = self.create_local_root({
            "local-folder/file.txt": b"local",
        })
        rclone = SimulatedRclone({
            "dropbox:": [
                SimulatedLsjsonResponse(items=[]),
                SimulatedLsjsonResponse(items=[]),
                SimulatedLsjsonResponse(items=[remote_dir_item("local-folder")]),
            ],
            "dropbox:local-folder": [
                SimulatedLsjsonResponse(items=[]),
                SimulatedLsjsonResponse(items=[]),
            ],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)
        assert app.listing_cache is not None
        app.listing_cache.set("dropbox:", [])

        with TestServer(app) as server:
            payload = server.post_json("/sync-batch", {
                "action": "local_to_dropbox_all",
                "recursive": "1",
                "enable_write_dropbox": "1",
            })
            result = wait_until(
                lambda: server.get_json("/sync-status?id=" + payload["id"])
                if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
                else None,
                description="recursive local-to-dropbox sync completion",
            )
            html = server.get_text("/")

        self.assertEqual(result["status"], "complete")
        folder_row = html.split('<span class="entry-name">local-folder</span></a></td>', 1)[1].split("</tr>", 1)[0]
        self.assertNotIn("Local Only", folder_row)
        self.assertGreaterEqual(sum(1 for call in rclone.calls if call["target"] == "dropbox:"), 3)

    def test_recursive_batch_delete_removes_nested_local_only_folders_after_children(self) -> None:
        local_root = self.create_local_root({
            "keep-remote/remote.txt": b"same",
            "local-folder/nested/file.txt": b"delete",
        })
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[
                remote_dir_item("keep-remote"),
            ])],
            "dropbox:keep-remote": [SimulatedLsjsonResponse(items=[
                remote_file_item("remote.txt", local_root / "keep-remote" / "remote.txt"),
            ])],
            "dropbox:local-folder": [SimulatedLsjsonResponse(items=[])],
            "dropbox:local-folder/nested": [SimulatedLsjsonResponse(items=[])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            plan = server.post_json("/sync-batch-plan", {
                "action": "delete_local_only_all",
                "recursive": "1",
                "enable_to_local": "1",
            })
            payload = server.post_json("/sync-batch", {
                "action": "delete_local_only_all",
                "recursive": "1",
                "enable_to_local": "1",
            })
            result = wait_until(
                lambda: server.get_json("/sync-status?id=" + payload["id"])
                if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
                else None,
                description="recursive folder delete completion",
            )

        self.assertEqual(
            [item["path"] for item in plan["groups"]["delete_local"]],
            ["local-folder/nested/file.txt", "local-folder/nested", "local-folder"],
        )
        self.assertEqual(result["status"], "complete")
        self.assertFalse((local_root / "local-folder").exists())
        self.assertTrue((local_root / "keep-remote").exists())

    def test_batch_sync_continues_after_file_error_and_reports_it(self) -> None:
        local_root = self.create_local_root({
            "bad.txt": b"bad",
            "good.txt": b"good",
        })
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[])],
        })
        original_copy = rclone.copy_file_overwrite

        def flaky_copy(source: str | Path, destination: str | Path) -> None:
            if str(destination) == "dropbox:bad.txt":
                raise BrowserError(HTTPStatus.BAD_GATEWAY, "planned failure")
            original_copy(source, destination)

        rclone.copy_file_overwrite = flaky_copy  # type: ignore[method-assign]
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            payload = server.post_json("/sync-batch", {
                "action": "local_to_dropbox_all",
                "recursive": "0",
                "enable_write_dropbox": "1",
            })
            result = wait_until(
                lambda: server.get_json("/sync-status?id=" + payload["id"])
                if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
                else None,
                description="batch failure completion",
            )

        self.assertEqual(result["status"], "complete")
        self.assertIn("1 error", result["message"])
        self.assertEqual(rclone.cat_data["dropbox:good.txt"], b"good")
        self.assertTrue(any("bad.txt" in error for error in result["errors"]))
