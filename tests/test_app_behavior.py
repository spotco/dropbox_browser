from __future__ import annotations

import threading
import time
from urllib.parse import quote

from dropbox_browser.foldercache import FolderCacheManager
from dropbox_browser.listingcache import ListingCacheManager
from dropbox_browser.services import DropboxBrowser

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


class AppBehaviorTests(IsolatedPathsTestCase):
    def _build_app(
        self,
        rclone: SimulatedRclone,
        local_root: Path | None = None,
        workers: int = 2,
        manager_cls=FolderCacheManager,
        **manager_kwargs,
    ) -> DropboxBrowser:
        listing_cache = ListingCacheManager(ttl_minutes=30)
        folder_cache = manager_cls(
            rclone,
            workers=workers,
            ttl_hours=24,
            listing_cache=listing_cache,
            local_root=local_root,
            remote="dropbox:",
            **manager_kwargs,
        )
        return DropboxBrowser(rclone, "dropbox:", local_root, folder_cache=folder_cache, listing_cache=listing_cache)

    def _wait_folder_info(self, server: TestServer, *, paths: list[str] | None = None, current: str | None = None, predicate=None):
        query_parts: list[str] = []
        if paths:
            query_parts.append("paths=" + ",".join(quote(path) for path in paths))
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
            self.assertIn("[dir] sub", html)
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
