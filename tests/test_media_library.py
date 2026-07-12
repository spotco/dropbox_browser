"""Unit tests for shared media_library listing helpers."""
from __future__ import annotations

from http import HTTPStatus

try:
    from tests.app_test_support import AppTestCase
    from tests.support import SimulatedLsjsonResponse, SimulatedRclone, TestServer
    from tests.test_music_endpoints import DirectFilesFolderCache
except ImportError:
    from app_test_support import AppTestCase
    from support import SimulatedLsjsonResponse, SimulatedRclone, TestServer
    from test_music_endpoints import DirectFilesFolderCache

from dropbox_browser.media_library import (
    build_flat_folder_library_payload,
    build_recursive_library_payload,
    is_supported_media,
    video_file_enricher,
)
from dropbox_browser.video import COMPATIBILITY_EXPECTED_EXTENSIONS, SUPPORTED_VIDEO_EXTENSIONS


class MediaLibraryHelperTests(AppTestCase):
    def test_is_supported_media_is_case_insensitive(self) -> None:
        self.assertTrue(is_supported_media("Clip.MKV", SUPPORTED_VIDEO_EXTENSIONS))
        self.assertFalse(is_supported_media("notes.txt", SUPPORTED_VIDEO_EXTENSIONS))

    def test_recursive_builder_filters_by_video_extensions(self) -> None:
        rclone = SimulatedRclone({"dropbox:Videos": [SimulatedLsjsonResponse(items=[])]})
        app = self._build_app(rclone, local_root=None)
        app.folder_cache = DirectFilesFolderCache({
            "dropbox:Videos": {
                "complete": True,
                "newest_mtime": 1704067200.0,
                "direct_files": [
                    {
                        "name": "clip.mkv",
                        "path": "clip.mkv",
                        "remote_path": "dropbox:Videos/clip.mkv",
                        "size": 10,
                        "mtime": 1704067200.0,
                    },
                    {
                        "name": "song.mp3",
                        "path": "song.mp3",
                        "remote_path": "dropbox:Videos/song.mp3",
                        "size": 10,
                        "mtime": 1704067201.0,
                    },
                ],
                "direct_folders": [],
            },
        })

        payload = build_recursive_library_payload(
            app,
            rel_path="Videos",
            supported_extensions=SUPPORTED_VIDEO_EXTENSIONS,
            id_prefix="item",
            include_songs_key=False,
            include_items_key=True,
            enrich_file=video_file_enricher(
                compatibility_expected_extensions=COMPATIBILITY_EXPECTED_EXTENSIONS,
            ),
        )

        self.assertTrue(payload["status"]["complete"])
        self.assertEqual([item["display_name"] for item in payload["items"]], ["clip.mkv"])
        self.assertNotIn("songs", payload)
        self.assertTrue(payload["items"][0]["compatibility_expected"])
        self.assertEqual(
            payload["items"][0]["preview_url"],
            "/file?path=Videos%2Fclip.mkv&source=remote",
        )

    def test_flat_folder_builder_filters_unsupported_files(self) -> None:
        rclone = SimulatedRclone({
            "dropbox:Videos": [SimulatedLsjsonResponse(items=[
                {"Name": "Movies", "Path": "Movies", "IsDir": True, "Size": 0, "ModTime": "2024-01-01T00:00:00Z"},
                {"Name": "clip.mp4", "Path": "clip.mp4", "IsDir": False, "Size": 12, "ModTime": "2024-01-02T00:00:00Z"},
                {"Name": "readme.txt", "Path": "readme.txt", "IsDir": False, "Size": 3, "ModTime": "2024-01-03T00:00:00Z"},
            ])],
        })
        app = self._build_app(rclone, local_root=None)
        payload = build_flat_folder_library_payload(
            app,
            rel_path="Videos",
            supported_extensions=SUPPORTED_VIDEO_EXTENSIONS,
            enrich_file=video_file_enricher(
                compatibility_expected_extensions=COMPATIBILITY_EXPECTED_EXTENSIONS,
            ),
        )
        self.assertEqual(payload["status"], "ok")
        names = [item["display_name"] for item in payload["items"]]
        self.assertEqual(names, ["Movies", "clip.mp4"])
        self.assertNotIn("readme.txt", names)