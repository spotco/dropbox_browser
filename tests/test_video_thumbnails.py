from __future__ import annotations

from pathlib import Path
import subprocess
from http import HTTPStatus
from urllib.error import HTTPError
from urllib.request import urlopen
from unittest.mock import patch

from dropbox_browser.config import VideoToolsConfig
from dropbox_browser.config import ThumbnailConfig
from dropbox_browser import video_thumbnails as video_thumbnails_module
from dropbox_browser.video_thumbnails import (
    VideoThumbnailService,
    build_video_thumbnail_cache_key,
    is_video_thumbnailable,
)

try:
    from tests.app_test_support import AppTestCase
    from tests.support import IsolatedPathsTestCase, SimulatedLsjsonResponse, SimulatedRclone
    from tests.support import TestServer
except ImportError:
    from app_test_support import AppTestCase
    from support import IsolatedPathsTestCase, SimulatedLsjsonResponse, SimulatedRclone
    from support import TestServer


class VideoThumbnailServiceTests(IsolatedPathsTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.temp_patcher = patch.object(video_thumbnails_module, "TEMP_DIR", self.temp_dir)
        self.temp_patcher.start()
        self.addCleanup(self.temp_patcher.stop)

    def _config(self, *, max_input: int = 2 * 1024 * 1024 * 1024) -> VideoToolsConfig:
        return VideoToolsConfig(
            ffmpeg_exe=Path("ffmpeg.exe"),
            ffprobe_exe=Path("ffprobe.exe"),
            video_thumbnail_max_input_bytes=max_input,
            video_thumbnail_timeout_seconds=2,
        )

    def test_supported_extensions_are_video_only(self) -> None:
        self.assertTrue(is_video_thumbnailable("Camera Uploads/clip.MOV"))
        self.assertTrue(is_video_thumbnailable("clip.m4v"))
        self.assertFalse(is_video_thumbnailable("cover.jpg"))
        self.assertFalse(is_video_thumbnailable("folder.mov", is_dir=True))

    def test_cache_key_includes_frame_policy_and_size(self) -> None:
        first = build_video_thumbnail_cache_key(
            source="remote",
            rel_path="clip.mov",
            size_bytes=100,
            modified_time=10,
            thumbnail_size=128,
        )
        second = build_video_thumbnail_cache_key(
            source="remote",
            rel_path="clip.mov",
            size_bytes=100,
            modified_time=10,
            thumbnail_size=256,
        )
        self.assertNotEqual(first, second)

    def test_local_thumbnail_generation_uses_ffmpeg_and_preserves_cache(self) -> None:
        local_root = self.create_local_root({"Camera Uploads/clip.mov": b"movie"})
        service = VideoThumbnailService(
            SimulatedRclone(),
            "dropbox:",
            local_root,
            self._config(),
            cache_dir=self.root / "ThumbnailCache",
        )
        descriptor = service.descriptor_for_path("Camera Uploads/clip.mov", "local")
        self.assertIsNotNone(descriptor)
        calls = []

        def fake_run(command, stdout=None, stderr=None, check=None, timeout=None):
            calls.append(command)
            Path(command[-1]).write_bytes(b"jpeg-thumb")
            return subprocess.CompletedProcess(command, 0, b"", b"")

        with patch("dropbox_browser.video_thumbnails.subprocess.run", side_effect=fake_run):
            result = service.ensure_thumbnail(descriptor)
            cached = service.ensure_thumbnail(descriptor)

        self.assertEqual(result.status, "generated")
        self.assertEqual(cached.status, "ready")
        self.assertEqual(cached.path, result.path)
        self.assertEqual(len(calls), 1)
        self.assertIn("-ss", calls[0])
        self.assertIn("-pix_fmt", calls[0])
        self.assertIn("yuvj420p", calls[0])
        self.assertIn(str(local_root / "Camera Uploads" / "clip.mov"), calls[0])
        self.assertEqual(result.path.read_bytes(), b"jpeg-thumb")

    def test_short_video_retries_near_end_when_one_second_seek_has_no_frame(self) -> None:
        local_root = self.create_local_root({"Camera Uploads/short.mov": b"movie"})
        service = VideoThumbnailService(
            SimulatedRclone(),
            "dropbox:",
            local_root,
            self._config(),
            cache_dir=self.root / "ThumbnailCache",
        )
        descriptor = service.descriptor_for_path("Camera Uploads/short.mov", "local")
        self.assertIsNotNone(descriptor)
        calls = []

        def fake_run(command, **_kwargs):
            calls.append(command)
            if "-sseof" in command:
                Path(command[-1]).write_bytes(b"jpeg-thumb")
            return subprocess.CompletedProcess(command, 0, b"", b"")

        with patch("dropbox_browser.video_thumbnails.subprocess.run", side_effect=fake_run):
            result = service.ensure_thumbnail(descriptor)

        self.assertEqual(result.status, "generated")
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0][calls[0].index("-ss") + 1], "1.0")
        self.assertEqual(calls[1][calls[1].index("-sseof") + 1], "-0.05")
        self.assertEqual(result.path.read_bytes(), b"jpeg-thumb")

    def test_remote_thumbnail_uses_range_stream_input_url(self) -> None:
        remote = SimulatedRclone({
            "dropbox:Camera Uploads/clip.mov": [SimulatedLsjsonResponse(items=[{
                "Name": "clip.mov",
                "Path": "Camera Uploads/clip.mov",
                "IsDir": False,
                "Size": 71 * 1024 * 1024,
                "ModTime": "2025-01-01T00:00:00Z",
            }])],
        })
        service = VideoThumbnailService(
            remote,
            "dropbox:",
            None,
            self._config(),
            cache_dir=self.root / "ThumbnailCache",
        )
        descriptor = service.descriptor_for_path("Camera Uploads/clip.mov", "remote")
        self.assertIsNotNone(descriptor)
        with patch("dropbox_browser.video_thumbnails.subprocess.run") as run:
            run.return_value = subprocess.CompletedProcess([], 0, b"", b"")
            output = Path(self.root / "fake.jpg")
            output.write_bytes(b"jpeg-thumb")
            def fake_run(command, **_kwargs):
                Path(command[-1]).write_bytes(b"jpeg-thumb")
                return subprocess.CompletedProcess(command, 0, b"", b"")
            run.side_effect = fake_run
            result = service.ensure_thumbnail(
                descriptor,
                remote_input_url="http://127.0.0.1:8000/file?path=Camera%20Uploads%2Fclip.mov&source=remote",
            )

        self.assertEqual(result.status, "generated")
        self.assertEqual(run.call_args.args[0][8], "http://127.0.0.1:8000/file?path=Camera%20Uploads%2Fclip.mov&source=remote")
        self.assertFalse(any(call["args"][0] == "copyto" for call in remote.calls))

    def test_oversized_input_is_rejected_without_ffmpeg(self) -> None:
        local_root = self.create_local_root({"clip.mov": b"movie"})
        service = VideoThumbnailService(
            SimulatedRclone(),
            "dropbox:",
            local_root,
            self._config(max_input=1),
            cache_dir=self.root / "ThumbnailCache",
        )
        descriptor = service.descriptor_for_path("clip.mov", "local")
        with patch("dropbox_browser.video_thumbnails.subprocess.run", side_effect=AssertionError("ffmpeg should not run")):
            result = service.ensure_thumbnail(descriptor)
        self.assertEqual(result.status, "oversized")


class VideoThumbnailHttpTests(AppTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.temp_patcher = patch.object(video_thumbnails_module, "TEMP_DIR", self.temp_dir)
        self.temp_patcher.start()
        self.addCleanup(self.temp_patcher.stop)

    def _video_config(self) -> VideoToolsConfig:
        return VideoToolsConfig(
            ffmpeg_exe=Path("ffmpeg.exe"),
            ffprobe_exe=Path("ffprobe.exe"),
            video_thumbnail_timeout_seconds=2,
        )

    def _thumbnail_config(self) -> ThumbnailConfig:
        return ThumbnailConfig(
            enabled=False,
            configured_enabled=False,
            cache_dir=self.root / "ThumbnailCache",
            magick_exe=None,
            size=64,
            max_input_bytes=1024 * 1024,
            timeout_seconds=1,
        )

    def test_video_thumbnail_route_serves_generated_jpeg_and_head(self) -> None:
        local_root = self.create_local_root({"Camera Uploads/clip.mov": b"movie"})
        app = self._build_app(
            SimulatedRclone(),
            local_root=local_root,
            workers=1,
            thumbnail_config=self._thumbnail_config(),
            video_tools_config=self._video_config(),
        )

        def fake_run(command, **_kwargs):
            Path(command[-1]).write_bytes(b"jpeg-thumb")
            return subprocess.CompletedProcess(command, 0, b"", b"")

        with patch.object(video_thumbnails_module.subprocess, "run", side_effect=fake_run):
            with TestServer(app) as server:
                with urlopen(
                    server.base_url + "/video/endpoints/thumbnail?path=Camera%20Uploads%2Fclip.mov&source=local",
                    timeout=5,
                ) as response:
                    self.assertEqual(response.status, HTTPStatus.OK)
                    self.assertEqual(response.headers["Content-Type"], "image/jpeg")
                    self.assertEqual(response.read(), b"jpeg-thumb")
                status, headers, body = server.head(
                    "/video/endpoints/thumbnail?path=Camera%20Uploads%2Fclip.mov&source=local",
                    timeout=5,
                )

        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(body, b"")
        self.assertEqual(headers["content-type"], "image/jpeg")
        self.assertEqual(headers["cache-control"], "no-store, no-cache, must-revalidate")

    def test_video_thumbnail_route_rejects_unsupported_extension(self) -> None:
        app = self._build_app(
            SimulatedRclone(),
            local_root=self.create_local_root({"cover.jpg": b"image"}),
            workers=1,
            thumbnail_config=self._thumbnail_config(),
            video_tools_config=self._video_config(),
        )
        with TestServer(app) as server:
            with self.assertRaises(HTTPError) as raised:
                urlopen(server.base_url + "/video/endpoints/thumbnail?path=cover.jpg&source=local", timeout=5)
        self.assertEqual(raised.exception.code, HTTPStatus.NOT_FOUND)
        raised.exception.close()
