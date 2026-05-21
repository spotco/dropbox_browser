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



class FolderInfoWorkerTests(AppTestCase):
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
        assert app.folder_cache is not None
        root_cache = app.folder_cache.get("dropbox:") or {}
        sub_cache = app.folder_cache.get("dropbox:sub") or {}
        self.assertEqual([item["Name"] for item in root_cache["direct_items"]], ["shared.txt", "sub"])
        self.assertEqual(root_cache["direct_items"][0]["ModTime"], "2024-01-01T12:00:00Z")
        self.assertEqual(sub_cache["direct_items"][0]["Name"], "child.txt")
        root_direct_listing = app.folder_cache.get_direct_listing("dropbox:")
        self.assertIsNotNone(root_direct_listing)
        assert root_direct_listing is not None
        self.assertEqual([item["Name"] for item in root_direct_listing], ["shared.txt", "sub"])
        root_direct_listing.append({"Name": "mutated.txt", "Path": "mutated.txt", "IsDir": False})
        self.assertEqual(
            [item["Name"] for item in app.folder_cache.get_direct_listing("dropbox:") or []],
            ["shared.txt", "sub"],
        )
        self.assertIsNone(app.folder_cache.get_direct_listing("dropbox:missing"))
        self.assertEqual(root_cache["direct_files"][0]["name"], "shared.txt")
        self.assertEqual(root_cache["direct_files"][0]["remote_path"], "dropbox:shared.txt")
        self.assertEqual(root_cache["direct_folders"][0]["name"], "sub")
        self.assertEqual(root_cache["direct_folders"][0]["remote_path"], "dropbox:sub")
        self.assertEqual(sub_cache["direct_files"][0]["name"], "child.txt")
        self.assertEqual(sub_cache["direct_files"][0]["remote_path"], "dropbox:sub/child.txt")
        events = self.read_trace_events()
        self.assertTrue(any(event["event"] == "job_queued" for event in events))
        self.assertTrue(any(event["event"] == "subtree_complete" and event.get("remote_path") == "dropbox:sub" for event in events))

    def test_server_cleanup_stops_app_background_workers(self) -> None:
        before_folder_workers = {
            thread.ident for thread in threading.enumerate()
            if thread.name.startswith("folder-cache-worker")
        }
        before_sync_workers = {
            thread.ident for thread in threading.enumerate()
            if thread.name.startswith("sync-job-worker")
        }
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[])],
        })
        app = self._build_app(rclone, local_root=None, workers=2, sync_workers=2)

        with TestServer(app) as server:
            server.get_text("/")

        after_folder_workers = {
            thread.ident for thread in threading.enumerate()
            if thread.name.startswith("folder-cache-worker")
        }
        after_sync_workers = {
            thread.ident for thread in threading.enumerate()
            if thread.name.startswith("sync-job-worker")
        }
        self.assertEqual(after_folder_workers, before_folder_workers)
        self.assertEqual(after_sync_workers, before_sync_workers)

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
        app = self._build_app(rclone, manager_cls=PreloadedFolderCache)

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

    def test_folder_cache_progress_text_uses_job_epoch_after_page_reset(self) -> None:
        rclone = SimulatedRclone({})
        app = self._build_app(rclone, workers=1)
        cache = app.folder_cache

        with cache._lock:
            cache._advance_page_time(100.0)
            for _ in range(10):
                cache._record_dispatched(100.0)
            for _ in range(3):
                cache._record_completed(100.0)
            cache._advance_page_time(200.0)
            cache._record_dispatched(200.0)

        self.assertEqual(cache.current_progress(), (0, 1))
        self.assertEqual(cache._progress_text_for_epoch(100.0), "3/10]")
