from __future__ import annotations

import threading
import time
from urllib.parse import quote
from urllib.error import HTTPError
from urllib.request import Request, urlopen

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
        })
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            html = server.get_text("/")

        self.assertIn("<th>View</th>", html)
        self.assertIn("<th>Sync</th>", html)
        self.assertIn('id="sync-enabled"', html)
        self.assertIn("Copy Local -&gt; Dropbox", html)
        self.assertIn("body.sync-enabled .sync-form", html)
        self.assertIn("Settings.get('sync-enabled', false)", html)
        self.assertIn("Settings.set('sync-enabled', toggle.checked)", html)
        self.assertIn("setSyncBusy(true)", html)
        self.assertIn("button.disabled = busy", html)

    def test_view_column_can_copy_local_parent_folder_path(self) -> None:
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

        self.assertIn('class="copy-parent"', html)
        self.assertIn(f'data-copy-path="{local_root}"', html)
        self.assertIn("navigator.clipboard.writeText(path)", html)
        self.assertIn("document.execCommand('copy')", html)
        remote_row = html.split('remote.txt</a></td>', 1)[1].split("</tr>", 1)[0]
        self.assertNotIn("copy-parent", remote_row)

    def test_sync_post_requires_enabled_guard(self) -> None:
        local_root = self.create_local_root({
            "local.txt": b"local",
        })
        rclone = SimulatedRclone({})
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            body = b"path=local.txt&kind=file&direction=local_to_dropbox&sync_enabled=0"
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
                "sync_enabled": "1",
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
                "sync_enabled": "1",
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

    def test_sync_local_folder_copies_recursively_to_dropbox(self) -> None:
        local_root = self.create_local_root({
            "folder/a.txt": b"a",
            "folder/nested/b.txt": b"b",
        })
        rclone = SimulatedRclone({})
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            payload = server.post_json("/sync", {
                "path": "folder",
                "kind": "folder",
                "direction": "local_to_dropbox",
                "sync_enabled": "1",
            })
            result = wait_until(
                lambda: server.get_json("/sync-status?id=" + payload["id"])
                if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
                else None,
                description="local-folder sync completion",
            )

        self.assertEqual(result["status"], "complete")
        self.assertEqual(rclone.cat_data["dropbox:folder/a.txt"], b"a")
        self.assertEqual(rclone.cat_data["dropbox:folder/nested/b.txt"], b"b")
        self.assertTrue(any(call["args"][0] == "copy" and call["target"] == "dropbox:folder" for call in rclone.calls))

    def test_sync_dropbox_folder_copies_recursively_to_local_without_delete(self) -> None:
        local_root = self.create_local_root({
            "folder/local-only.txt": b"keep",
        })
        rclone = SimulatedRclone(cat_data={
            "dropbox:folder/a.txt": b"a",
            "dropbox:folder/nested/b.txt": b"b",
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            payload = server.post_json("/sync", {
                "path": "folder",
                "kind": "folder",
                "direction": "dropbox_to_local",
                "sync_enabled": "1",
            })
            result = wait_until(
                lambda: server.get_json("/sync-status?id=" + payload["id"])
                if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
                else None,
                description="dropbox-folder sync completion",
            )

        self.assertEqual(result["status"], "complete")
        self.assertEqual((local_root / "folder" / "a.txt").read_bytes(), b"a")
        self.assertEqual((local_root / "folder" / "nested" / "b.txt").read_bytes(), b"b")
        self.assertEqual((local_root / "folder" / "local-only.txt").read_bytes(), b"keep")
        self.assertTrue(any(call["args"][0] == "copy" and call["target"] == str(local_root / "folder") for call in rclone.calls))
