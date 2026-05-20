from __future__ import annotations

from http import HTTPStatus
from urllib.parse import quote
from urllib.error import HTTPError

try:
    from tests.app_test_support import AppTestCase
    from tests.support import SimulatedRclone, TestServer
except ImportError:
    from app_test_support import AppTestCase
    from support import SimulatedRclone, TestServer


class MusicEndpointTests(AppTestCase):
    def test_music_status_endpoint_returns_supported_extensions(self) -> None:
        rclone = SimulatedRclone()
        app = self._build_app(rclone, local_root=None, workers=1)

        with TestServer(app) as server:
            payload = server.get_json("/music/endpoints/status")

        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["endpoint_root"], "/music/endpoints")
        self.assertEqual(payload["supported_extensions"], [".mp3", ".m4a", ".aac", ".wav"])
        self.assertEqual(rclone.calls, [])

    def test_unknown_music_endpoint_returns_404(self) -> None:
        rclone = SimulatedRclone()
        app = self._build_app(rclone, local_root=None, workers=1)

        with TestServer(app) as server:
            with self.assertRaises(HTTPError) as ctx:
                server.get_text("/music/endpoints/nope")

        self.assertEqual(ctx.exception.code, HTTPStatus.NOT_FOUND)
        self.assertEqual(rclone.calls, [])

    def test_music_library_uses_cached_listing_without_rclone_calls(self) -> None:
        rclone = SimulatedRclone()
        app = self._build_app(rclone, local_root=None, workers=1)
        assert app.listing_cache is not None
        app.listing_cache.set("dropbox:Music", [
            {"Name": "Album", "Path": "Album", "IsDir": True, "Size": 0, "ModTime": "2024-01-01T00:00:00Z"},
            {"Name": "Loose.MP3", "Path": "Loose.MP3", "IsDir": False, "Size": 10, "ModTime": "2024-01-02T00:00:00Z"},
            {"Name": "notes.txt", "Path": "notes.txt", "IsDir": False, "Size": 11, "ModTime": "2024-01-03T00:00:00Z"},
            {"Name": "raw.flac", "Path": "raw.flac", "IsDir": False, "Size": 12, "ModTime": "2024-01-04T00:00:00Z"},
        ])
        app.listing_cache.set("dropbox:Music/Album", [
            {"Name": "Track.m4a", "Path": "Track.m4a", "IsDir": False, "Size": 13, "ModTime": "2024-01-05T00:00:00Z"},
            {"Name": "Voice.AAC", "Path": "Voice.AAC", "IsDir": False, "Size": 14, "ModTime": "2024-01-06T00:00:00Z"},
            {"Name": "Wave.WAV", "Path": "Wave.WAV", "IsDir": False, "Size": 15, "ModTime": "2024-01-07T00:00:00Z"},
            {"Name": "skip.ogg", "Path": "skip.ogg", "IsDir": False, "Size": 16, "ModTime": "2024-01-08T00:00:00Z"},
        ])

        with TestServer(app) as server:
            payload = server.get_json("/music/endpoints/library?path=" + quote("Music"))

        self.assertEqual(payload["root"]["remote_path"], "dropbox:Music")
        self.assertEqual(payload["root"]["rel_path"], "")
        self.assertEqual(payload["root"]["stream_path"], "Music")
        self.assertEqual(payload["status"]["cache_status"], "partial")
        self.assertEqual(payload["status"]["missing_listing_count"], 0)
        self.assertEqual(payload["folders"], [{
            "id": "folder:dropbox:Music/Album",
            "parent_id": "folder:dropbox:Music",
            "remote_path": "dropbox:Music/Album",
            "rel_path": "Album",
            "stream_path": "Music/Album",
            "display_name": "Album",
            "listing_cached": True,
            "complete": False,
        }])
        self.assertEqual(
            [(song["display_name"], song["rel_path"], song["stream_path"], song["extension"]) for song in payload["songs"]],
            [
                ("Track.m4a", "Album/Track.m4a", "Music/Album/Track.m4a", ".m4a"),
                ("Voice.AAC", "Album/Voice.AAC", "Music/Album/Voice.AAC", ".aac"),
                ("Wave.WAV", "Album/Wave.WAV", "Music/Album/Wave.WAV", ".wav"),
                ("Loose.MP3", "Loose.MP3", "Music/Loose.MP3", ".mp3"),
            ],
        )
        self.assertEqual(rclone.calls, [])

    def test_music_library_stops_at_uncached_child_listing(self) -> None:
        rclone = SimulatedRclone()
        app = self._build_app(rclone, local_root=None, workers=1)
        assert app.listing_cache is not None
        app.listing_cache.set("dropbox:Music", [
            {"Name": "Known", "Path": "Known", "IsDir": True, "Size": 0, "ModTime": "2024-01-01T00:00:00Z"},
            {"Name": "Cached.mp3", "Path": "Cached.mp3", "IsDir": False, "Size": 10, "ModTime": "2024-01-02T00:00:00Z"},
        ])

        with TestServer(app) as server:
            payload = server.get_json("/music/endpoints/library?path=Music")

        self.assertEqual(payload["status"]["cache_status"], "partial")
        self.assertEqual(payload["status"]["missing_listing_count"], 1)
        self.assertEqual(payload["folders"][0]["listing_cached"], False)
        self.assertEqual([song["display_name"] for song in payload["songs"]], ["Cached.mp3"])
        self.assertEqual(rclone.calls, [])

    def test_music_library_reports_unavailable_without_root_listing(self) -> None:
        rclone = SimulatedRclone()
        app = self._build_app(rclone, local_root=None, workers=1)

        with TestServer(app) as server:
            payload = server.get_json("/music/endpoints/library?path=Music")

        self.assertEqual(payload["status"]["cache_status"], "unavailable")
        self.assertEqual(payload["status"]["missing_listing_count"], 1)
        self.assertEqual(payload["folders"], [])
        self.assertEqual(payload["songs"], [])
        self.assertEqual(rclone.calls, [])

    def test_music_library_rejects_parent_segments(self) -> None:
        rclone = SimulatedRclone()
        app = self._build_app(rclone, local_root=None, workers=1)

        with TestServer(app) as server:
            with self.assertRaises(HTTPError) as ctx:
                server.get_text("/music/endpoints/library?path=..")

        self.assertEqual(ctx.exception.code, HTTPStatus.BAD_REQUEST)
        self.assertEqual(rclone.calls, [])
