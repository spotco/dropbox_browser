from __future__ import annotations

import json
import threading
import time
import unicodedata
from http import HTTPStatus
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen
from unittest.mock import patch

from dropbox_browser import handlers as handlers_module
from dropbox_browser.config import VideoToolsConfig
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


class _StreamingFakeFfmpegProcess:
    def __init__(self, command: list[str]) -> None:
        self.command = command
        self.stdout = None
        self.stderr = None
        self.returncode = None
        self.killed = False

    def poll(self):
        return self.returncode

    def wait(self, timeout: float | None = None) -> int:
        if self.returncode is None:
            self.returncode = 0
        return self.returncode

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9


def _write_streaming_hls_session_fixture(playlist_path: Path) -> None:
    playlist_path.parent.mkdir(parents=True, exist_ok=True)
    playlist_path.write_text(
        "#EXTM3U\n"
        '#EXT-X-MAP:URI="init.mp4"\n'
        "#EXTINF:6,\n"
        "segment_00000.m4s\n"
        "#EXTINF:6,\n"
        "segment_00001.m4s\n",
        encoding="utf-8",
    )
    (playlist_path.parent / "init.mp4").write_bytes(b"init")
    (playlist_path.parent / "segment_00000.m4s").write_bytes(b"segment0")
    (playlist_path.parent / "segment_00001.m4s").write_bytes(b"segment1")



class StreamingHttpTests(AppTestCase):
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
            "dropbox:Albums/Live Set/clip.mp4": [SimulatedLsjsonResponse(items=[{
                "Name": "clip.mp4",
                "Path": "clip.mp4",
                "IsDir": False,
                "Size": 10,
            }])],
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
            call["args"] == ("lsjson", "--stat", "--no-modtime", "--no-mimetype", "--", "dropbox:Albums/Live Set/clip.mp4")
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

    def test_remote_file_uses_canonical_remote_name_for_unicode_equivalent_request_path(self) -> None:
        remote_name = "Shikura Chiyomaru - Find the blue セルフカヴァーバージョン.mp3"
        requested_name = unicodedata.normalize("NFD", remote_name)
        rclone = SimulatedRclone({
            "dropbox:music/2025_5_15_loose/" + requested_name: [SimulatedLsjsonResponse(
                items=[],
                returncode=1,
                stderr=b"object not found",
            )],
            "dropbox:music/2025_5_15_loose": [SimulatedLsjsonResponse(items=[{
                "Name": remote_name,
                "Path": remote_name,
                "IsDir": False,
                "Size": 10,
                "ModTime": "2024-01-01T12:00:00Z",
            }])],
        }, cat_data={
            "dropbox:music/2025_5_15_loose/" + remote_name: b"0123456789",
        })
        app = self._build_app(rclone, local_root=None, workers=1)

        with TestServer(app) as server:
            request_path = quote("music/2025_5_15_loose/" + requested_name, safe="")
            with urlopen(server.base_url + "/file?path=" + request_path, timeout=5) as response:
                body = response.read()
                status = response.status
                headers = response.headers

        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(body, b"0123456789")
        self.assertEqual(headers["Content-Length"], "10")
        self.assertTrue(any(
            call["args"] == ("cat", "--", "dropbox:music/2025_5_15_loose/" + remote_name)
            for call in rclone.calls
        ))
        self.assertTrue(any(
            call["args"] == ("lsjson", "--", "dropbox:music/2025_5_15_loose")
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
            call["args"] == ("lsjson", "--stat", "--no-modtime", "--no-mimetype", "--", "dropbox:movie.mp4")
            for call in rclone.calls
        ))
        self.assertTrue(any(
            call["args"] == ("cat", "--", "dropbox:movie.mp4")
            for call in rclone.calls
        ))
        self.assertFalse(any(
            call["args"] == ("lsjson", "--", "dropbox:")
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
        self.assertTrue(any(
            call["args"] == ("lsjson", "--stat", "--no-modtime", "--no-mimetype", "--", "dropbox:movie.mp4")
            for call in rclone.calls
        ))

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
        self.assertTrue(any(
            call["args"] == ("lsjson", "--stat", "--no-modtime", "--no-mimetype", "--", "dropbox:movie.mp4")
            for call in rclone.calls
        ))

    def test_tagged_remote_file_range_uses_session_metadata_without_restat(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            workers=1,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            ),
        )

        def fake_popen(command, stdout=None, stderr=None, cwd=None, **kwargs):
            playlist_path = Path(command[-1])
            _write_streaming_hls_session_fixture(playlist_path)
            return _StreamingFakeFfmpegProcess(command)

        with TestServer(app) as server, patch("dropbox_browser.video.subprocess.Popen", side_effect=fake_popen):
            payload = server.post_json("/video/endpoints/session", {
                "path": "movie.mp4",
                "source": "remote",
            })
            rclone.calls.clear()
            request = Request(
                server.base_url + "/file?path=movie.mp4&source=remote&video_session_id=" + payload["session_id"],
                headers={"Range": "bytes=3-6"},
            )
            with urlopen(request, timeout=5) as response:
                body = response.read()
                status = response.status
                headers = response.headers

        self.assertEqual(status, HTTPStatus.PARTIAL_CONTENT)
        self.assertEqual(body, b"3456")
        self.assertEqual(headers["Content-Range"], "bytes 3-6/10")
        self.assertTrue(any(
            call["args"] == ("cat", "--offset", "3", "--count", "4", "--", "dropbox:movie.mp4")
            for call in rclone.calls
        ))
        self.assertFalse(any(call["args"][0] == "lsjson" for call in rclone.calls))

    def test_tagged_remote_file_invalid_range_uses_session_metadata_without_restat(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            workers=1,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            ),
        )

        def fake_popen(command, stdout=None, stderr=None, cwd=None, **kwargs):
            playlist_path = Path(command[-1])
            _write_streaming_hls_session_fixture(playlist_path)
            return _StreamingFakeFfmpegProcess(command)

        with TestServer(app) as server, patch("dropbox_browser.video.subprocess.Popen", side_effect=fake_popen):
            payload = server.post_json("/video/endpoints/session", {
                "path": "movie.mp4",
                "source": "remote",
            })
            rclone.calls.clear()
            request = Request(
                server.base_url + "/file?path=movie.mp4&source=remote&video_session_id=" + payload["session_id"],
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
        self.assertFalse(any(call["args"][0] == "lsjson" for call in rclone.calls))

    def test_tagged_remote_file_uses_tagged_copy_buffer_constant(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            workers=1,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            ),
        )

        def fake_popen(command, stdout=None, stderr=None, cwd=None, **kwargs):
            playlist_path = Path(command[-1])
            _write_streaming_hls_session_fixture(playlist_path)
            return _StreamingFakeFfmpegProcess(command)

        with TestServer(app) as server, patch("dropbox_browser.video.subprocess.Popen", side_effect=fake_popen):
            payload = server.post_json("/video/endpoints/session", {
                "path": "movie.mp4",
                "source": "remote",
            })
            rclone.calls.clear()
            buffer_sizes: list[int] = []

            def fake_copy_exact_with_throttle(src, dst, count, *, decision_fn, sleep_fn=time.sleep, buffer_size=1024 * 1024):
                buffer_sizes.append(buffer_size)
                chunk = src.read(count)
                if chunk:
                    dst.write(chunk)
                return handlers_module.StreamCopyStats(
                    bytes_copied=(0 if chunk is None else len(chunk)),
                    sleep_seconds_total=0.0,
                    decision_samples=1,
                    last_throttle_mode="unthrottled",
                    last_ahead_seconds=None,
                )

            with patch.object(handlers_module, "copy_exact_with_throttle", side_effect=fake_copy_exact_with_throttle):
                request = Request(
                    server.base_url + "/file?path=movie.mp4&source=remote&video_session_id=" + payload["session_id"],
                    headers={"Range": "bytes=0-3"},
                )
                with urlopen(request, timeout=5) as response:
                    body = response.read()

        self.assertEqual(body, b"0123")
        self.assertEqual(buffer_sizes, [handlers_module.TAGGED_INPUT_COPY_BUFFER_SIZE])
        self.assertEqual(handlers_module.TAGGED_INPUT_COPY_BUFFER_SIZE, 2 * 1024 * 1024)

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
            "dropbox:café mix.mp3": [SimulatedLsjsonResponse(items=[{
                "Name": "café mix.mp3",
                "Path": "café mix.mp3",
                "IsDir": False,
                "Size": 5,
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
