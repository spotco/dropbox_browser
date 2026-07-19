from __future__ import annotations

import json
import shutil
import threading
import time
from http import HTTPStatus
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen
from unittest.mock import patch

import dropbox_browser.foldercache as foldercache_module
import dropbox_browser.cacheio as cacheio_module
from dropbox_browser.errors import BrowserError
from dropbox_browser.foldercache import DIFF_CACHE_SCHEMA_VERSION, FolderJob, FolderShutdownJob
from dropbox_browser.listingcache import ListingCacheManager
from dropbox_browser.priorityqueue import PriorityQueue
from dropbox_browser.services import DropboxBrowser

try:
    from tests.app_test_support import AppTestCase, PreloadedFolderCache, RecordingFolderCache
    from tests.support import SimulatedLsjsonResponse, SimulatedRclone, TestServer, remote_dir_item, remote_file_item, wait_until
except ImportError:
    from app_test_support import AppTestCase, PreloadedFolderCache, RecordingFolderCache
    from support import SimulatedLsjsonResponse, SimulatedRclone, TestServer, remote_dir_item, remote_file_item, wait_until



class FolderInfoWorkerTests(AppTestCase):
    def test_folder_cache_revision_advances_for_worker_prime_and_invalidation_paths(self) -> None:
        rclone = SimulatedRclone({
            "dropbox:worker": [SimulatedLsjsonResponse(items=[{
                "Name": "track.mp3",
                "Path": "track.mp3",
                "IsDir": False,
                "Size": 1,
                "ModTime": "2024-01-01T12:00:00Z",
            }])],
        })
        app = self._build_app(rclone, local_root=None, workers=1)
        cache = app.folder_cache
        assert cache is not None
        initial_revision = cache.revision

        cache.request("dropbox:worker")
        wait_until(
            lambda: bool((cache.get("dropbox:worker") or {}).get("complete")),
            description="worker folder cache completion",
        )
        worker_revision = cache.revision
        self.assertGreater(worker_revision, initial_revision)

        cache.prime_direct_listing(
            "dropbox:primed",
            [{"Name": "primed.mp3", "Path": "primed.mp3", "IsDir": False, "Size": 1}],
        )
        prime_revision = cache.revision
        self.assertGreater(prime_revision, worker_revision)

        cache.invalidate("dropbox:primed")
        direct_revision = cache.revision
        self.assertGreater(direct_revision, prime_revision)

        cache.invalidate_tree("dropbox:worker")
        self.assertGreater(cache.revision, direct_revision)

    def test_folder_cache_queue_accepts_shutdown_with_queued_folder_job(self) -> None:
        queue = PriorityQueue()

        queue.put(FolderJob.create("dropbox:queued", page_epoch=1.0, breadth_depth=0))
        queue.put(FolderShutdownJob())

        self.assertIsInstance(queue.get(), FolderJob)
        self.assertIsInstance(queue.get(), FolderShutdownJob)

    def test_cache_write_ignores_directory_removed_during_atomic_replace(self) -> None:
        cache_path = self.root / "Cache" / "FolderInfo" / "entry.json"
        original_named_temporary_file = cacheio_module.tempfile.NamedTemporaryFile

        def disappearing_temporary_file(*args, **kwargs):
            temporary_file = original_named_temporary_file(*args, **kwargs)

            class DisappearingTemporaryFile:
                def __enter__(self):
                    return temporary_file.__enter__()

                def __exit__(self, *args):
                    result = temporary_file.__exit__(*args)
                    shutil.rmtree(cache_path.parent, ignore_errors=True)
                    return result

            return DisappearingTemporaryFile()

        with patch.object(
            cacheio_module.tempfile,
            "NamedTemporaryFile",
            side_effect=disappearing_temporary_file,
        ):
            cacheio_module.write_json_atomic(cache_path, {"complete": True})

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
            listing = self._browse_listing(server)
            row_names = {row["display_name"] for row in listing["rows"]}
            self.assertIn("shared.txt", row_names)
            sub_row = next(row for row in listing["rows"] if row["display_name"] == "sub")
            self.assertEqual(sub_row["icon_href"], "/assets/icons/material-icon-theme/folder-base.svg")
            self.assertEqual(sub_row["status_label"], "Loading")

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

    def test_stale_parent_partial_flush_does_not_clobber_completed_root(self) -> None:
        """Parent partial disk flush must not overwrite a newer complete root.

        Reproduces the multi-worker race behind the full-suite flake where
        ``sub`` finishes and finalizes root in memory, then a deferred partial
        root write clobbers disk. ``/folder-info`` reads disk only and does not
        re-queue ``partial`` paths, so the poll would hang forever.
        """
        local_root = self.create_local_root({
            "shared.txt": b"root data",
            "sub/child.txt": b"child data",
        })
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[
                remote_file_item("shared.txt", local_root / "shared.txt"),
                remote_dir_item("sub"),
            ])],
            "dropbox:sub": [SimulatedLsjsonResponse(items=[
                remote_file_item("child.txt", local_root / "sub" / "child.txt"),
            ])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=2)
        cache = app.folder_cache
        assert cache is not None

        incomplete_root_write_started = threading.Event()
        incomplete_root_write_release = threading.Event()
        original_write = foldercache_module.write_json_atomic
        incomplete_root_writes = {"count": 0}

        def gated_write(path: Path, data: dict) -> None:
            if data.get("remote_path") == "dropbox:" and not data.get("complete"):
                incomplete_root_writes["count"] += 1
                # Gate only the first partial root flush so the parent worker
                # blocks in disk I/O while the child worker finalizes root.
                if incomplete_root_writes["count"] == 1:
                    incomplete_root_write_started.set()
                    if not incomplete_root_write_release.wait(timeout=5):
                        raise AssertionError("Timed out waiting to release incomplete root cache write")
            original_write(path, data)

        with patch.object(foldercache_module, "write_json_atomic", side_effect=gated_write):
            cache.request("dropbox:", time.time())
            wait_until(
                incomplete_root_write_started.is_set,
                description="incomplete root cache write to start",
            )
            wait_until(
                lambda: (cache.get("dropbox:sub") or {}).get("complete"),
                description="child folder completion while parent flush is gated",
            )
            # Child completion should have finalized root in memory (and ideally
            # already written a complete root record around the gated partial).
            wait_until(
                lambda: (
                    (cache._acc.get("dropbox:") or {}).get("diff_complete")
                    and not cache._pending_children.get("dropbox:")
                ),
                description="root in-memory completion via child subtree",
            )
            incomplete_root_write_release.set()
            root_data = wait_until(
                lambda: cache.get("dropbox:") if (cache.get("dropbox:") or {}).get("complete") else None,
                description="root remains complete after stale partial flush attempt",
            )

        self.assertTrue(root_data.get("complete"))
        self.assertTrue(root_data.get("diff_complete"))
        self.assertEqual(root_data.get("diff_status"), "synced")
        self.assertEqual(root_data.get("size"), len(b"root data") + len(b"child data"))
        self.assertEqual(root_data.get("file_count"), 2)
        events = self.read_trace_events()
        self.assertTrue(
            any(event["event"] == "subtree_complete" and event.get("remote_path") == "dropbox:sub" for event in events),
        )
        self.assertTrue(
            any(event["event"] == "subtree_complete" and event.get("remote_path") == "dropbox:" for event in events),
        )

    def test_folder_info_rerequests_partial_current_when_children_complete(self) -> None:
        """``/folder-info`` re-requests a stuck partial current when children are done.

        Simulates a coherent in-memory root that lost a disk race (partial on
        disk, complete in memory). Polling with complete children must nudge
        the current folder so subsequent polls observe complete totals.
        """
        local_root = self.create_local_root({
            "shared.txt": b"root data",
            "sub/child.txt": b"child data",
        })
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[
                remote_file_item("shared.txt", local_root / "shared.txt"),
                remote_dir_item("sub"),
            ])],
            "dropbox:sub": [SimulatedLsjsonResponse(items=[
                remote_file_item("child.txt", local_root / "sub" / "child.txt"),
            ])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=2)
        cache = app.folder_cache
        assert cache is not None

        with TestServer(app) as server:
            self._browse_listing(server)
            self._wait_folder_info(
                server,
                paths=["sub"],
                current="",
                predicate=lambda data: (
                    data.get("sub", {}).get("complete")
                    and data.get("", {}).get("complete")
                    and data.get("", {}).get("diff_complete")
                ),
            )

            complete_root = cache.get("dropbox:") or {}
            self.assertTrue(complete_root.get("complete"))
            stuck = dict(complete_root)
            stuck["complete"] = False
            stuck["diff_complete"] = False
            stuck["diff_status"] = "loading"
            stuck["size"] = len(b"root data")
            stuck["file_count"] = 1
            foldercache_module.write_json_atomic(cache._cache_path("dropbox:"), stuck)
            self.assertFalse((cache.get("dropbox:") or {}).get("complete"))
            self.assertEqual((cache.get("dropbox:") or {}).get("size"), len(b"root data"))

            first = server.get_json("/folder-info?paths=sub&current=")["results"]
            self.assertTrue(first["sub"]["complete"])
            # Response body was built before the safety-net re-request.
            self.assertEqual(first[""]["status"], "partial")
            self.assertFalse(first[""]["complete"])

            # Re-request should have repaired disk from complete in-memory state.
            healed_disk = wait_until(
                lambda: cache.get("dropbox:") if (cache.get("dropbox:") or {}).get("complete") else None,
                description="root disk healed after folder-info re-request",
            )
            second = server.get_json("/folder-info?paths=sub&current=")["results"]

        self.assertTrue(healed_disk.get("complete"))
        self.assertEqual(healed_disk.get("size"), len(b"root data") + len(b"child data"))
        self.assertTrue(second[""]["complete"])
        self.assertTrue(second[""]["diff_complete"])
        self.assertEqual(second[""]["size_sort_value"], len(b"root data") + len(b"child data"))
        self.assertEqual(second[""]["count_display"], "2 files")
        events = self.read_trace_events()
        self.assertTrue(
            any(
                event["event"] == "folder_info_poll" and event.get("stuck_parent_reenqueued")
                for event in events
            ),
        )
        self.assertTrue(
            any(
                event["event"] == "request_flushed_complete" and event.get("remote_path") == "dropbox:"
                for event in events
            ),
        )

    def test_folder_info_does_not_rerequest_partial_current_while_children_incomplete(self) -> None:
        """Safety net must not thrash while a polled child is still incomplete."""
        local_root = self.create_local_root({
            "shared.txt": b"root data",
            "slow/child.txt": b"slow child",
        })
        slow_started = threading.Event()
        slow_release = threading.Event()
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[
                remote_file_item("shared.txt", local_root / "shared.txt"),
                remote_dir_item("slow"),
            ])],
            "dropbox:slow": [SimulatedLsjsonResponse(
                items=[remote_file_item("child.txt", local_root / "slow" / "child.txt")],
                wait_event=slow_release,
                started_event=slow_started,
            )],
        })
        app = self._build_app(rclone, local_root=local_root, workers=2)

        with TestServer(app) as server:
            self._browse_listing(server)
            wait_until(slow_started.is_set, description="slow child listing to start")
            # Root may already be partial; child is still calculating.
            mid = server.get_json("/folder-info?paths=slow&current=")["results"]
            self.assertFalse(mid.get("slow", {}).get("complete", False))
            slow_release.set()
            self._wait_folder_info(
                server,
                paths=["slow"],
                current="",
                predicate=lambda data: data.get("slow", {}).get("complete") and data.get("", {}).get("complete"),
            )

        events = self.read_trace_events()
        blocked_polls = [
            event for event in events
            if event["event"] == "folder_info_poll" and not (event.get("status_counts") or {}).get("complete")
        ]
        self.assertTrue(blocked_polls)
        self.assertFalse(
            any(event.get("stuck_parent_reenqueued") for event in blocked_polls),
            "partial current must not re-request while polled children are incomplete",
        )

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
            listing = self._browse_listing(server, sort="date", direction="desc")

        folder_rows = [row for row in listing["rows"] if row["kind"] == "folder"]
        self.assertEqual([row["display_name"] for row in folder_rows], ["newer", "older"])
        self.assertEqual(folder_rows[0]["sort_date"], 1735689600.0)
        self.assertEqual(folder_rows[1]["sort_date"], 1704067200.0)
        self.assertTrue(all(not row["metadata_complete"] for row in folder_rows))

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

    def test_folder_info_returns_partial_folder_growth_and_final_completion(self) -> None:
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

        with TestServer(app) as server:
            listing = self._browse_listing(server, path="music")
            self.assertIn("Album", {row["display_name"] for row in listing["rows"]})

            partial_results = self._wait_folder_info(
                server,
                paths=["music/Album"],
                predicate=lambda data: data.get("music/Album", {}).get("status") == "partial",
            )
            partial = partial_results["music/Album"]
            self.assertFalse(partial["complete"])
            self.assertEqual(partial["size_display"], "5 B")
            self.assertEqual(partial["count_display"], "1 files")
            self.assertEqual(partial["date_display"], "2024-01-02 07:00")

            complete_results = self._wait_folder_info(
                server,
                paths=["music/Album"],
                predicate=lambda data: data.get("music/Album", {}).get("complete"),
            )

        complete = complete_results["music/Album"]
        self.assertTrue(complete["complete"])
        self.assertEqual(complete["diff_status"], "synced")
        self.assertEqual(complete["size_display"], "11 B")
        self.assertEqual(complete["count_display"], "2 files")
        self.assertEqual(complete["date_display"], "2024-01-03 07:00")

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
            listing = self._browse_listing(server, path="music")
            results = self._wait_folder_info(
                server,
                paths=[folder_name, "Other Album"],
                predicate=lambda data: (
                    data.get(folder_name, {}).get("complete")
                    and data.get("Other Album", {}).get("complete")
                ),
            )

        self.assertIn(folder_name, {row["display_name"] for row in listing["rows"]})
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

    def test_newer_page_load_keeps_active_old_job_and_allows_new_page_to_finish(self) -> None:
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
        wait_until(lambda: cache.status("dropbox:a") != "calculating", description="folder a completion")

        self.assertTrue((cache.get("dropbox:b") or {}).get("complete"))
        self.assertTrue((cache.get("dropbox:a") or {}).get("complete"))
        events = self.read_trace_events()
        self.assertFalse(any(event["event"] == "job_canceled_running" and event.get("remote_path") == "dropbox:a" for event in events))

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

    def test_duplicate_queued_folder_requests_coalesce_to_latest_priority(self) -> None:
        block_started = threading.Event()
        block_release = threading.Event()
        rclone = SimulatedRclone({
            "dropbox:block": [SimulatedLsjsonResponse(items=[], wait_event=block_release, started_event=block_started)],
            "dropbox:root": [SimulatedLsjsonResponse(items=[])],
        })
        app = self._build_app(rclone, local_root=None, workers=1)
        cache = app.folder_cache
        assert cache is not None

        page0 = time.time()
        cache.request("dropbox:block", page0)
        wait_until(block_started.is_set, description="block folder to start")

        page1 = page0 + 1
        page2 = page1 + 1
        page3 = page2 + 1
        cache.request("dropbox:root", page1)
        cache.request("dropbox:root", page2)
        cache.request("dropbox:root", page3)
        block_release.set()

        wait_until(lambda: (cache.get("dropbox:root") or {}).get("complete"), description="root completion")

        self.assertEqual(sum(1 for call in rclone.calls if call["target"] == "dropbox:root"), 1)
        events = self.read_trace_events()
        root_requeues = [
            event for event in events
            if event["event"] == "request_reenqueued" and event.get("remote_path") == "dropbox:root"
        ]
        self.assertEqual(len(root_requeues), 2)
        self.assertTrue(all(event.get("removed_jobs") == 1 for event in root_requeues))
        root_starts = [
            event for event in events
            if event["event"] == "job_started" and event.get("remote_path") == "dropbox:root"
        ]
        self.assertEqual(len(root_starts), 1)
        self.assertEqual(root_starts[0].get("page_epoch"), page3)

    def test_duplicate_active_folder_requests_refresh_without_duplicate_work(self) -> None:
        slow_started = threading.Event()
        slow_release = threading.Event()
        rclone = SimulatedRclone({
            "dropbox:slow": [SimulatedLsjsonResponse(items=[], wait_event=slow_release, started_event=slow_started)],
        })
        app = self._build_app(rclone, local_root=None, workers=1)
        cache = app.folder_cache
        assert cache is not None

        page1 = time.time()
        cache.request("dropbox:slow", page1)
        wait_until(slow_started.is_set, description="slow folder to start")

        page2 = page1 + 1
        page3 = page2 + 1
        cache.request("dropbox:slow", page2)
        cache.request("dropbox:slow", page3)
        slow_release.set()

        wait_until(lambda: (cache.get("dropbox:slow") or {}).get("complete"), description="slow folder completion")

        self.assertEqual(sum(1 for call in rclone.calls if call["target"] == "dropbox:slow"), 1)
        events = self.read_trace_events()
        refreshes = [
            event for event in events
            if event["event"] == "request_refreshed" and event.get("remote_path") == "dropbox:slow"
        ]
        self.assertEqual(len(refreshes), 2)
        starts = [
            event for event in events
            if event["event"] == "job_started" and event.get("remote_path") == "dropbox:slow"
        ]
        self.assertEqual(len(starts), 1)

    def test_active_child_can_complete_parent_after_newer_page_load(self) -> None:
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
            description="root completion after active child finishes",
        )
        season_data = cache.get("dropbox:root/season") or {}
        extras_data = cache.get("dropbox:root/season/extras") or {}

        self.assertEqual(root_data["diff_status"], "synced")
        self.assertTrue(root_data["complete"])
        self.assertEqual(season_data.get("diff_status"), "synced")
        self.assertTrue(season_data.get("complete"))
        self.assertEqual(extras_data.get("diff_status"), "synced")
        self.assertTrue(extras_data.get("complete"))
        self.assertEqual(
            sum(1 for call in rclone.calls if call["target"] == "dropbox:root/season/extras"),
            1,
        )

    def test_refreshed_queued_root_is_reenqueued_after_lazy_stale_skip(self) -> None:
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
        wait_until(lambda: cache.status("dropbox:block") != "calculating", description="block folder completion")

        page4 = page3 + 1
        cache.request("dropbox:root", page4)

        data = wait_until(
            lambda: cache.get("dropbox:root") if (cache.get("dropbox:root") or {}).get("complete") else None,
            description="root completion after lazy stale skip",
        )

        self.assertEqual(data["diff_status"], "synced")
        self.assertTrue(data["complete"])
        self.assertGreaterEqual(
            sum(1 for call in rclone.calls if call["target"] == "dropbox:root"),
            1,
        )
        events = self.read_trace_events()
        page_load_events = [event for event in events if event["event"] == "page_load" and event.get("page_epoch") == page3]
        self.assertEqual(page_load_events[-1].get("removed_jobs"), 0)
        self.assertTrue(any(event["event"] == "job_skipped_stale" and event.get("remote_path") == "dropbox:root" for event in events))

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

    def test_page_epoch_for_current_page_reuses_active_navigation_epoch(self) -> None:
        rclone = SimulatedRclone({})
        app = self._build_app(rclone, workers=1)
        cache = app.folder_cache
        assert cache is not None

        cache.notify_page_load(1234.5, page_key="Music")

        self.assertEqual(cache.page_epoch_for("Music"), 1234.5)

    def test_page_epoch_for_other_page_uses_fresh_time(self) -> None:
        rclone = SimulatedRclone({})
        app = self._build_app(rclone, workers=1)
        cache = app.folder_cache
        assert cache is not None

        cache.notify_page_load(1234.5, page_key="Music")
        with patch("dropbox_browser.foldercache.time.time", return_value=4321.25):
            self.assertEqual(cache.page_epoch_for("Other"), 4321.25)
        with patch("dropbox_browser.foldercache.time.time", return_value=6789.0):
            self.assertEqual(cache.page_epoch_for("Music"), 1234.5)

    def test_notify_page_load_does_not_block_on_background_cache_file_write(self) -> None:
        rclone = SimulatedRclone({
            "dropbox:root": [SimulatedLsjsonResponse(items=[])],
        })
        app = self._build_app(rclone, workers=1)
        cache = app.folder_cache
        assert cache is not None

        write_started = threading.Event()
        write_release = threading.Event()
        original_write_json_atomic = foldercache_module.write_json_atomic

        def delayed_write(path: Path, data: dict) -> None:
            write_started.set()
            if not write_release.wait(timeout=5):
                raise AssertionError("Timed out waiting to release delayed cache write")
            original_write_json_atomic(path, data)

        with patch("dropbox_browser.foldercache.write_json_atomic", side_effect=delayed_write):
            cache.request("dropbox:root", 100.0)
            wait_until(write_started.is_set, description="background cache write to start")

            started = time.perf_counter()
            cache.notify_page_load(101.0, page_key="next-page")
            elapsed_ms = (time.perf_counter() - started) * 1000

            write_release.set()
            wait_until(
                lambda: (cache.get("dropbox:root") or {}).get("complete"),
                description="root completion after delayed cache write",
            )

        self.assertLess(elapsed_ms, 100.0)
        events = self.read_trace_events()
        page_load_events = [
            event for event in events
            if event["event"] == "page_load" and event.get("page_key") == "next-page"
        ]
        self.assertTrue(page_load_events)
        self.assertLess(page_load_events[-1].get("lock_wait_ms", 0.0), 100.0)

    def test_ensure_known_subtree_queues_missing_descendant_under_complete_root(self) -> None:
        rclone = SimulatedRclone({
            "dropbox:Music/Album": [SimulatedLsjsonResponse(items=[])],
        })
        app = self._build_app(rclone, workers=1)
        cache = app.folder_cache
        assert cache is not None

        with cache._lock:
            cache._acc["dropbox:Music"] = {
                "size": 0,
                "count": 0,
                "mtime": None,
                "diff_status": "unavailable",
                "diff_complete": True,
                "first_diff_path": None,
                "file_statuses": {},
                "direct_items": [],
                "direct_files": [],
                "direct_folders": [
                    {"name": "Album", "remote_path": "dropbox:Music/Album"},
                ],
            }
            cache._write_cache("dropbox:Music", complete=True)

        result = cache.ensure_known_subtree("dropbox:Music", 100.0)
        child_data = wait_until(
            lambda: cache.get("dropbox:Music/Album") if (cache.get("dropbox:Music/Album") or {}).get("complete") else None,
            description="music album completion from ensure_known_subtree",
        )

        self.assertEqual(result["queued_folder_count"], 1)
        self.assertEqual(result["pending_folder_count"], 1)
        self.assertEqual(result["missing_folder_count"], 1)
        self.assertTrue(child_data["complete"])
        self.assertEqual(sum(1 for call in rclone.calls if call["target"] == "dropbox:Music/Album"), 1)
        events = self.read_trace_events()
        starts = [
            event for event in events
            if event["event"] == "job_started" and event.get("remote_path") == "dropbox:Music/Album"
        ]
        self.assertEqual(starts[0].get("breadth_depth"), 1)

    def test_duplicate_ensure_known_subtree_calls_do_not_start_duplicate_rclone_work(self) -> None:
        child_started = threading.Event()
        child_release = threading.Event()
        rclone = SimulatedRclone({
            "dropbox:Music/Album": [
                SimulatedLsjsonResponse(items=[], wait_event=child_release, started_event=child_started),
            ],
        })
        app = self._build_app(rclone, workers=1)
        cache = app.folder_cache
        assert cache is not None

        with cache._lock:
            cache._acc["dropbox:Music"] = {
                "size": 0,
                "count": 0,
                "mtime": None,
                "diff_status": "unavailable",
                "diff_complete": True,
                "first_diff_path": None,
                "file_statuses": {},
                "direct_items": [],
                "direct_files": [],
                "direct_folders": [
                    {"name": "Album", "remote_path": "dropbox:Music/Album"},
                ],
            }
            cache._write_cache("dropbox:Music", complete=True)

        first = cache.ensure_known_subtree("dropbox:Music", 100.0)
        wait_until(child_started.is_set, description="ensure_known_subtree child to start")
        second = cache.ensure_known_subtree("dropbox:Music", 100.0)
        child_release.set()
        wait_until(lambda: (cache.get("dropbox:Music/Album") or {}).get("complete"), description="ensure_known_subtree child completion")

        self.assertEqual(first["queued_folder_count"], 1)
        self.assertEqual(second["queued_folder_count"], 0)
        self.assertEqual(sum(1 for call in rclone.calls if call["target"] == "dropbox:Music/Album"), 1)

    def test_ensure_known_subtree_preserves_breadth_first_depth(self) -> None:
        block_started = threading.Event()
        block_release = threading.Event()
        rclone = SimulatedRclone({
            "dropbox:block": [SimulatedLsjsonResponse(items=[], wait_event=block_release, started_event=block_started)],
            "dropbox:Root/Other": [SimulatedLsjsonResponse(items=[])],
            "dropbox:Root/Album/Disc 2": [SimulatedLsjsonResponse(items=[])],
        })
        app = self._build_app(rclone, workers=1)
        cache = app.folder_cache
        assert cache is not None

        cache.request("dropbox:block", 10.0)
        wait_until(block_started.is_set, description="block folder start for ensure_known_subtree ordering")

        with cache._lock:
            cache._acc["dropbox:Root"] = {
                "size": 0,
                "count": 0,
                "mtime": None,
                "diff_status": "unavailable",
                "diff_complete": True,
                "first_diff_path": None,
                "file_statuses": {},
                "direct_items": [],
                "direct_files": [],
                "direct_folders": [
                    {"name": "Album", "remote_path": "dropbox:Root/Album"},
                    {"name": "Other", "remote_path": "dropbox:Root/Other"},
                ],
            }
            cache._write_cache("dropbox:Root", complete=True)
            cache._acc["dropbox:Root/Album"] = {
                "size": 0,
                "count": 0,
                "mtime": None,
                "diff_status": "unavailable",
                "diff_complete": True,
                "first_diff_path": None,
                "file_statuses": {},
                "direct_items": [],
                "direct_files": [],
                "direct_folders": [
                    {"name": "Disc 2", "remote_path": "dropbox:Root/Album/Disc 2"},
                ],
            }
            cache._write_cache("dropbox:Root/Album", complete=True)

        first = cache.ensure_known_subtree("dropbox:Root", 100.0)
        block_release.set()
        wait_until(lambda: (cache.get("dropbox:Root/Other") or {}).get("complete"), description="root other completion")
        wait_until(lambda: (cache.get("dropbox:Root/Album/Disc 2") or {}).get("complete"), description="disc 2 completion")

        self.assertEqual(first["queued_folder_count"], 2)
        starts = [
            event for event in self.read_trace_events()
            if event["event"] == "job_started" and event.get("remote_path") in {
                "dropbox:Root/Other",
                "dropbox:Root/Album/Disc 2",
            }
        ]
        self.assertEqual(
            [event.get("remote_path") for event in starts],
            ["dropbox:Root/Other", "dropbox:Root/Album/Disc 2"],
        )
        self.assertEqual(
            [event.get("breadth_depth") for event in starts],
            [1, 2],
        )

    def test_ensure_known_subtree_preserves_newer_page_priority(self) -> None:
        block_started = threading.Event()
        block_release = threading.Event()
        rclone = SimulatedRclone({
            "dropbox:block": [SimulatedLsjsonResponse(items=[], wait_event=block_release, started_event=block_started)],
            "dropbox:Root/Other": [SimulatedLsjsonResponse(items=[])],
            "dropbox:NewRoot/Fresh": [SimulatedLsjsonResponse(items=[])],
        })
        app = self._build_app(rclone, workers=1)
        cache = app.folder_cache
        assert cache is not None

        cache.request("dropbox:block", 10.0)
        wait_until(block_started.is_set, description="block folder start for ensure_known_subtree newer page priority")

        with cache._lock:
            cache._acc["dropbox:Root"] = {
                "size": 0,
                "count": 0,
                "mtime": None,
                "diff_status": "unavailable",
                "diff_complete": True,
                "first_diff_path": None,
                "file_statuses": {},
                "direct_items": [],
                "direct_files": [],
                "direct_folders": [
                    {"name": "Other", "remote_path": "dropbox:Root/Other"},
                ],
            }
            cache._write_cache("dropbox:Root", complete=True)
            cache._acc["dropbox:NewRoot"] = {
                "size": 0,
                "count": 0,
                "mtime": None,
                "diff_status": "unavailable",
                "diff_complete": True,
                "first_diff_path": None,
                "file_statuses": {},
                "direct_items": [],
                "direct_files": [],
                "direct_folders": [
                    {"name": "Fresh", "remote_path": "dropbox:NewRoot/Fresh"},
                ],
            }
            cache._write_cache("dropbox:NewRoot", complete=True)

        first = cache.ensure_known_subtree("dropbox:Root", 100.0)
        second = cache.ensure_known_subtree("dropbox:NewRoot", 200.0)
        block_release.set()
        wait_until(lambda: (cache.get("dropbox:NewRoot/Fresh") or {}).get("complete"), description="new root fresh completion")
        wait_until(lambda: cache.status("dropbox:Root/Other") != "calculating", description="stale older page descendant resolution")

        self.assertEqual(first["queued_folder_count"], 1)
        self.assertEqual(second["queued_folder_count"], 1)
        starts = [
            event for event in self.read_trace_events()
            if event["event"] == "job_started" and event.get("remote_path") in {
                "dropbox:Root/Other",
                "dropbox:NewRoot/Fresh",
            }
        ]
        self.assertEqual([event.get("remote_path") for event in starts], ["dropbox:NewRoot/Fresh"])
        events = self.read_trace_events()
        self.assertTrue(any(
            event["event"] == "job_skipped_stale" and event.get("remote_path") == "dropbox:Root/Other"
            for event in events
        ))

    def test_ensure_known_subtree_pending_counts_only_include_non_complete_observable_folders(self) -> None:
        rclone = SimulatedRclone({
            "dropbox:Root/Partial": [SimulatedLsjsonResponse(items=[])],
            "dropbox:Root/Missing": [SimulatedLsjsonResponse(items=[])],
        })
        app = self._build_app(rclone, workers=1)
        cache = app.folder_cache
        assert cache is not None

        with cache._lock:
            cache._acc["dropbox:Root"] = {
                "size": 0,
                "count": 0,
                "mtime": None,
                "diff_status": "unavailable",
                "diff_complete": True,
                "first_diff_path": None,
                "file_statuses": {},
                "direct_items": [],
                "direct_files": [],
                "direct_folders": [
                    {"name": "Complete", "remote_path": "dropbox:Root/Complete"},
                    {"name": "Partial", "remote_path": "dropbox:Root/Partial"},
                    {"name": "Calculating", "remote_path": "dropbox:Root/Calculating"},
                    {"name": "Missing", "remote_path": "dropbox:Root/Missing"},
                ],
            }
            cache._write_cache("dropbox:Root", complete=True)
            cache._acc["dropbox:Root/Complete"] = {
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
            cache._write_cache("dropbox:Root/Complete", complete=True)
            cache._acc["dropbox:Root/Partial"] = {
                "size": 0,
                "count": 0,
                "mtime": None,
                "diff_status": "unavailable",
                "diff_complete": False,
                "first_diff_path": None,
                "file_statuses": {},
                "direct_items": [],
                "direct_files": [],
                "direct_folders": [],
            }
            cache._write_cache("dropbox:Root/Partial", complete=False)
            cache._in_progress["dropbox:Root/Calculating"] = 100.0

        result = cache.ensure_known_subtree("dropbox:Root", 100.0)
        wait_until(lambda: (cache.get("dropbox:Root/Partial") or {}).get("complete"), description="partial child completion from ensure_known_subtree")
        wait_until(lambda: (cache.get("dropbox:Root/Missing") or {}).get("complete"), description="missing child completion from ensure_known_subtree")

        self.assertEqual(result["pending_folder_count"], 3)
        self.assertEqual(result["missing_folder_count"], 2)
        self.assertEqual(result["queued_folder_count"], 2)
        self.assertEqual(sum(1 for call in rclone.calls if call["target"] == "dropbox:Root/Complete"), 0)
        self.assertEqual(sum(1 for call in rclone.calls if call["target"] == "dropbox:Root/Partial"), 1)
        self.assertEqual(sum(1 for call in rclone.calls if call["target"] == "dropbox:Root/Missing"), 1)
        self.assertEqual(sum(1 for call in rclone.calls if call["target"] == "dropbox:Root/Calculating"), 0)
