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



class DiffStatusTests(AppTestCase):
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
            listing = self._browse_listing(server, path="music")
            results = self._wait_folder_info(
                server,
                current="music",
                predicate=lambda data: data.get("music", {}).get("file_statuses", {}).get("song.mp3"),
            )
            info = results["music"]

        row_names = {row["display_name"] for row in listing["rows"]}
        self.assertIn("song.mp3", row_names)
        self.assertNotIn(".DS_Store", row_names)
        self.assertNotIn("Thumbs.db", row_names)
        self.assertNotIn("desktop.ini", row_names)
        self.assertNotIn("ehthumbs.db", row_names)
        self.assertNotIn("._song.mp3", row_names)
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
            listing = self._browse_listing(server, sort="status", direction="asc")

        self.assertEqual(listing["sort"]["current_key"], "status")
        self.assertEqual(listing["sort"]["current_direction"], "asc")
        self.assertEqual(listing["sort"]["next_direction"]["status"], "desc")
        status_labels = [row["status_label"] for row in listing["rows"]]
        self.assertEqual(status_labels, ["Dropbox Only", "Has Diffs", "Local Only", "Synced"])

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
            self._browse_listing(server, path="dropbox_browser_test")
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
            listing = self._browse_listing(server, path="dropbox_browser_test")
            info = server.get_json("/folder-info?current=dropbox_browser_test")["results"]["dropbox_browser_test"]

        audio_row = next(row for row in listing["rows"] if row["display_name"] == "audio_urls.txt")
        self.assertEqual(audio_row["path"], "dropbox_browser_test/audio_urls.txt")
        self.assertEqual(audio_row["status_label"], "Has Diffs")
        self.assertEqual(info["file_statuses"]["audio_urls.txt"]["diff_status"], "has_diffs")

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
