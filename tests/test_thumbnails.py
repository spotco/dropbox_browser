from __future__ import annotations

from pathlib import Path
import re
import subprocess
import threading
import unittest
from http import HTTPStatus
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import urlopen
from unittest.mock import patch

import dropbox_browser.config as config_module
import dropbox_browser.thumbnails as thumbnails_module
from dropbox_browser.config import PROJECT_ROOT, ThumbnailConfig
from dropbox_browser.thumbnails import (
    THUMBNAILABLE_IMAGE_EXTENSIONS,
    ThumbnailService,
    build_thumbnail_cache_key,
    is_thumbnailable_image,
    thumbnail_cache_path,
    thumbnail_descriptor_for_row,
    thumbnail_source_for_row,
    thumbnailable_image_extension,
)

try:
    from tests.app_test_support import AppTestCase
    from tests.support import IsolatedPathsTestCase, SimulatedLsjsonResponse, SimulatedRclone
    from tests.support import TestServer
except ImportError:
    from app_test_support import AppTestCase
    from support import IsolatedPathsTestCase, SimulatedLsjsonResponse, SimulatedRclone
    from support import TestServer


def _js_previewable_extensions() -> set[str]:
    js_path = PROJECT_ROOT / "dropbox_browser" / "assets" / "js" / "browse" / "image-hover-preview.js"
    text = js_path.read_text(encoding="utf-8")
    return {
        match.group(1)
        for match in re.finditer(r'^\s*"(\.[^"]+)"\s*,?\s*$', text, flags=re.MULTILINE)
    }


class ThumbnailRulesTests(unittest.TestCase):
    def test_thumbnailable_extension_is_casefolded(self) -> None:
        self.assertEqual(thumbnailable_image_extension("Photos/Cover.JPG"), ".jpg")

    def test_is_thumbnailable_image_accepts_supported_extensions(self) -> None:
        self.assertTrue(is_thumbnailable_image("Camera Uploads/shot.png", is_dir=False))
        self.assertTrue(is_thumbnailable_image("illustration.SVG", is_dir=False))
        self.assertTrue(is_thumbnailable_image("album art.WEBP", is_dir=False))

    def test_is_thumbnailable_image_rejects_folders(self) -> None:
        self.assertFalse(is_thumbnailable_image("folder.png", is_dir=True))
        self.assertFalse(is_thumbnailable_image("gallery.svg", is_dir=True))

    def test_is_thumbnailable_image_rejects_unsupported_extensions(self) -> None:
        self.assertFalse(is_thumbnailable_image("song.mp3", is_dir=False))
        self.assertFalse(is_thumbnailable_image("README", is_dir=False))
        self.assertFalse(is_thumbnailable_image("archive.tar.gz", is_dir=False))

    def test_python_thumbnail_extensions_match_hover_preview_js(self) -> None:
        self.assertEqual(set(THUMBNAILABLE_IMAGE_EXTENSIONS), _js_previewable_extensions())


class ThumbnailCacheKeyTests(unittest.TestCase):
    def test_changed_size_produces_new_cache_key(self) -> None:
        key_one = build_thumbnail_cache_key(
            source="remote",
            rel_path="Photos/cover.jpg",
            size_bytes=100,
            modified_time=1710000000.0,
            thumbnail_size=64,
        )
        key_two = build_thumbnail_cache_key(
            source="remote",
            rel_path="Photos/cover.jpg",
            size_bytes=101,
            modified_time=1710000000.0,
            thumbnail_size=64,
        )

        self.assertNotEqual(key_one, key_two)

    def test_changed_modified_time_produces_new_cache_key(self) -> None:
        key_one = build_thumbnail_cache_key(
            source="remote",
            rel_path="Photos/cover.jpg",
            size_bytes=100,
            modified_time=1710000000.0,
            thumbnail_size=64,
        )
        key_two = build_thumbnail_cache_key(
            source="remote",
            rel_path="Photos/cover.jpg",
            size_bytes=100,
            modified_time=1710000001.0,
            thumbnail_size=64,
        )

        self.assertNotEqual(key_one, key_two)

    def test_source_changes_cache_key(self) -> None:
        remote_key = build_thumbnail_cache_key(
            source="remote",
            rel_path="Photos/cover.jpg",
            size_bytes=100,
            modified_time=1710000000.0,
            thumbnail_size=64,
        )
        local_key = build_thumbnail_cache_key(
            source="local",
            rel_path="Photos/cover.jpg",
            size_bytes=100,
            modified_time=1710000000.0,
            thumbnail_size=64,
        )

        self.assertNotEqual(remote_key, local_key)

    def test_thumbnail_cache_path_uses_sharded_hash_layout(self) -> None:
        cache_root = Path("X:/ThumbnailCache")
        cache_key = "abcdef0123456789" * 4

        path = thumbnail_cache_path(cache_key, cache_dir=cache_root)

        self.assertEqual(path, cache_root / "ab" / "cd" / f"{cache_key}.png")


class ThumbnailDescriptorTests(unittest.TestCase):
    def test_thumbnail_source_prefers_local_for_has_diffs(self) -> None:
        source = thumbnail_source_for_row({
            "is_dir": False,
            "remote": True,
            "local": True,
            "status_label": "Has Diffs",
        })

        self.assertEqual(source, "local")

    def test_thumbnail_source_defaults_to_remote_when_both_exist_without_diffs(self) -> None:
        source = thumbnail_source_for_row({
            "is_dir": False,
            "remote": True,
            "local": True,
            "status_label": "Synced",
        })

        self.assertEqual(source, "remote")

    def test_thumbnail_descriptor_uses_actual_windows_resolved_local_path(self) -> None:
        cache_root = Path("X:/ThumbnailCache")
        actual_local_path = Path(r"E:\music\＊NSYNC - Bye Bye Bye.jpg")
        descriptor = thumbnail_descriptor_for_row(
            "music",
            {
                "name": "*NSYNC - Bye Bye Bye.jpg",
                "is_dir": False,
                "remote": True,
                "local": True,
                "status_label": "Has Diffs",
                "local_path": str(actual_local_path),
                "local_size": 222,
                "remote_size": 111,
                "local_mtime": 1710000002.0,
                "remote_mtime": 1710000001.0,
            },
            thumbnail_size=64,
            cache_dir=cache_root,
        )

        self.assertIsNotNone(descriptor)
        assert descriptor is not None
        self.assertEqual(descriptor.source, "local")
        self.assertEqual(descriptor.local_path, actual_local_path)
        self.assertEqual(descriptor.rel_path, "music/*NSYNC - Bye Bye Bye.jpg")
        self.assertEqual(descriptor.size_bytes, 222)
        self.assertEqual(descriptor.modified_time, 1710000002.0)
        self.assertEqual(
            descriptor.cache_path,
            cache_root / descriptor.cache_key[:2] / descriptor.cache_key[2:4] / f"{descriptor.cache_key}.png",
        )

    def test_thumbnail_descriptor_ignores_non_image_rows(self) -> None:
        descriptor = thumbnail_descriptor_for_row(
            "",
            {
                "name": "track.mp3",
                "is_dir": False,
                "remote": True,
                "local": False,
                "remote_size": 10,
                "remote_mtime": 1710000000.0,
            },
            thumbnail_size=64,
        )

        self.assertIsNone(descriptor)

    def test_thumbnail_cache_dir_defaults_to_configured_root(self) -> None:
        cache_root = Path("X:/ThumbnailCache")
        with patch.object(thumbnails_module, "THUMBNAIL_CACHE_DIR", cache_root):
            descriptor = thumbnails_module.thumbnail_descriptor_for_row(
                "",
                {
                    "name": "cover.png",
                    "is_dir": False,
                    "remote": True,
                    "local": False,
                    "remote_size": 10,
                    "remote_mtime": 1710000000.0,
                },
                thumbnail_size=64,
            )

        self.assertIsNotNone(descriptor)
        assert descriptor is not None
        self.assertEqual(descriptor.cache_path.parent.parent.parent, cache_root)


class ThumbnailServiceTests(IsolatedPathsTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.thumbnail_cache_dir = self.root / "ThumbnailCache"
        self.magick_exe = self.root / "ImageMagick" / "magick.exe"
        self.magick_exe.parent.mkdir(parents=True, exist_ok=True)
        self.magick_exe.write_bytes(b"")
        self.config_patcher = patch.object(thumbnails_module, "THUMBNAIL_CACHE_DIR", self.thumbnail_cache_dir)
        self.config_patcher.start()
        self.addCleanup(self.config_patcher.stop)
        self.temp_patcher = patch.object(thumbnails_module, "TEMP_DIR", self.temp_dir)
        self.temp_patcher.start()
        self.addCleanup(self.temp_patcher.stop)

    def _thumbnail_config(self, *, enabled: bool = True, max_input_bytes: int = 1024 * 1024) -> ThumbnailConfig:
        return ThumbnailConfig(
            enabled=enabled,
            configured_enabled=enabled,
            cache_dir=self.thumbnail_cache_dir,
            magick_exe=self.magick_exe if enabled else None,
            size=64,
            max_input_bytes=max_input_bytes,
            timeout_seconds=1.5,
        )

    def test_descriptor_for_local_path_uses_windows_resolved_local_name(self) -> None:
        local_root = self.create_local_root({"music/＊NSYNC - Bye Bye Bye.jpg": b"jpg"})
        service = ThumbnailService(SimulatedRclone(), "dropbox:", local_root, self._thumbnail_config())

        descriptor = service.descriptor_for_path("music/*NSYNC - Bye Bye Bye.jpg", "local")

        self.assertIsNotNone(descriptor)
        assert descriptor is not None
        self.assertEqual(descriptor.local_path, local_root / "music" / "＊NSYNC - Bye Bye Bye.jpg")
        self.assertEqual(descriptor.source, "local")

    def test_descriptor_for_remote_path_uses_rclone_stat_and_remote_source(self) -> None:
        local_file = self.root / "cover.jpg"
        local_file.write_bytes(b"abcdef")
        rclone = SimulatedRclone({
            "dropbox:photos/cover.jpg": [SimulatedLsjsonResponse(items=[{
                "Name": "cover.jpg",
                "Path": "photos/cover.jpg",
                "IsDir": False,
                "Size": 6,
                "ModTime": "2024-01-01T12:00:00Z",
            }])],
        })
        service = ThumbnailService(rclone, "dropbox:", None, self._thumbnail_config())

        descriptor = service.descriptor_for_path("photos/cover.jpg", "remote")

        self.assertIsNotNone(descriptor)
        assert descriptor is not None
        self.assertEqual(descriptor.source, "remote")
        self.assertEqual(descriptor.size_bytes, 6)
        self.assertIsNone(descriptor.local_path)

    def test_descriptor_for_remote_path_treats_empty_modtime_as_missing(self) -> None:
        rclone = SimulatedRclone({
            "dropbox:photos/cover.jpg": [SimulatedLsjsonResponse(items=[{
                "Name": "cover.jpg",
                "Path": "photos/cover.jpg",
                "IsDir": False,
                "Size": 6,
                "ModTime": "",
            }])],
        })
        service = ThumbnailService(rclone, "dropbox:", None, self._thumbnail_config())

        descriptor = service.descriptor_for_path("photos/cover.jpg", "remote")

        self.assertIsNotNone(descriptor)
        assert descriptor is not None
        self.assertIsNone(descriptor.modified_time)

    def test_ensure_thumbnail_generates_from_local_file_and_writes_cache_atomically(self) -> None:
        local_root = self.create_local_root({"photos/cover.png": b"image-bytes"})
        service = ThumbnailService(SimulatedRclone(), "dropbox:", local_root, self._thumbnail_config())
        descriptor = service.descriptor_for_path("photos/cover.png", "local")
        generated_bytes = b"png-thumb"

        def fake_run(cmd, stdout=None, stderr=None, check=None, timeout=None):
            output_path = Path(str(cmd[-1]).split("png:", 1)[1])
            output_path.write_bytes(generated_bytes)
            return subprocess.CompletedProcess(cmd, 0, b"", b"")

        with patch("dropbox_browser.thumbnails.subprocess.run", side_effect=fake_run) as run_mock:
            result = service.ensure_thumbnail(descriptor)

        self.assertTrue(result.ok)
        assert result.path is not None
        self.assertEqual(result.status, "generated")
        self.assertEqual(result.path.read_bytes(), generated_bytes)
        self.assertTrue(result.path.is_file())
        self.assertEqual(run_mock.call_count, 1)
        self.assertFalse(any(self.temp_dir.glob("thumbnail-out-*")))
        events = self.read_trace_events()
        self.assertEqual([event["event"] for event in events], [
            "thumbnail_cache_miss",
            "thumbnail_generation_success",
        ])
        self.assertEqual(events[0]["rel_path"], "photos/cover.png")
        self.assertEqual(events[0]["source"], "local")
        self.assertEqual(events[1]["output_size_bytes"], len(generated_bytes))
        self.assertIn("elapsed_ms", events[1])
        self.assertNotIn("local_path", events[0])
        self.assertNotIn("local_path", events[1])

    def test_ensure_thumbnail_downloads_remote_source_to_temp_before_thumbnailing(self) -> None:
        remote_bytes = b"remote-image"
        rclone = SimulatedRclone(
            {
                "dropbox:photos/cover.jpg": [SimulatedLsjsonResponse(items=[{
                    "Name": "cover.jpg",
                    "Path": "photos/cover.jpg",
                    "IsDir": False,
                    "Size": len(remote_bytes),
                    "ModTime": "2024-01-01T12:00:00Z",
                }])],
            },
            cat_data={"dropbox:photos/cover.jpg": remote_bytes},
        )
        service = ThumbnailService(rclone, "dropbox:", None, self._thumbnail_config())
        descriptor = service.descriptor_for_path("photos/cover.jpg", "remote")

        def fake_run(cmd, stdout=None, stderr=None, check=None, timeout=None):
            input_path = Path(str(cmd[1]).rsplit("[0]", 1)[0])
            output_path = Path(str(cmd[-1]).split("png:", 1)[1])
            self.assertEqual(input_path.read_bytes(), remote_bytes)
            output_path.write_bytes(b"png-thumb")
            return subprocess.CompletedProcess(cmd, 0, b"", b"")

        with patch("dropbox_browser.thumbnails.subprocess.run", side_effect=fake_run):
            result = service.ensure_thumbnail(descriptor)

        self.assertTrue(result.ok)
        self.assertEqual(
            [call for call in rclone.calls if call["args"][0] == "copyto"],
            [call for call in rclone.calls if call["args"][0] == "copyto"],
        )
        self.assertEqual(len([call for call in rclone.calls if call["args"][0] == "copyto"]), 1)
        self.assertFalse(any(self.temp_dir.glob("thumbnail-src-*")))

    def test_ensure_thumbnail_rejects_oversized_input_before_subprocess(self) -> None:
        local_root = self.create_local_root({"photos/cover.png": b"x" * 11})
        service = ThumbnailService(
            SimulatedRclone(),
            "dropbox:",
            local_root,
            self._thumbnail_config(max_input_bytes=10),
        )
        descriptor = service.descriptor_for_path("photos/cover.png", "local")

        with patch("dropbox_browser.thumbnails.subprocess.run", side_effect=AssertionError("should not run")):
            result = service.ensure_thumbnail(descriptor)

        self.assertEqual(result.status, "oversized")
        self.assertIsNone(result.path)
        events = self.read_trace_events()
        self.assertEqual([event["event"] for event in events], ["thumbnail_oversized_input"])
        self.assertEqual(events[0]["input_size_bytes"], 11)

    def test_ensure_thumbnail_returns_timeout_and_cleans_temp_files(self) -> None:
        local_root = self.create_local_root({"photos/cover.png": b"image-bytes"})
        service = ThumbnailService(SimulatedRclone(), "dropbox:", local_root, self._thumbnail_config())
        descriptor = service.descriptor_for_path("photos/cover.png", "local")

        def fake_run(cmd, stdout=None, stderr=None, check=None, timeout=None):
            raise subprocess.TimeoutExpired(cmd, timeout)

        with patch("dropbox_browser.thumbnails.subprocess.run", side_effect=fake_run):
            result = service.ensure_thumbnail(descriptor)

        self.assertEqual(result.status, "timeout")
        self.assertFalse(any(self.temp_dir.glob("thumbnail-out-*")))
        self.assertFalse(any(self.thumbnail_cache_dir.rglob("*.png")))
        events = self.read_trace_events()
        self.assertEqual([event["event"] for event in events], [
            "thumbnail_cache_miss",
            "thumbnail_generation_timeout",
        ])
        self.assertIn("elapsed_ms", events[1])

    def test_ensure_thumbnail_coalesces_same_cache_key_requests(self) -> None:
        local_root = self.create_local_root({"photos/cover.png": b"image-bytes"})
        service = ThumbnailService(SimulatedRclone(), "dropbox:", local_root, self._thumbnail_config())
        descriptor = service.descriptor_for_path("photos/cover.png", "local")
        started = threading.Event()
        release = threading.Event()
        call_count = 0
        call_guard = threading.Lock()

        def fake_generate(inner_descriptor):
            nonlocal call_count
            with call_guard:
                call_count += 1
            started.set()
            release.wait(5)
            assert inner_descriptor is not None
            inner_descriptor.cache_path.parent.mkdir(parents=True, exist_ok=True)
            inner_descriptor.cache_path.write_bytes(b"png-thumb")
            return thumbnails_module.ThumbnailResult(
                status="generated",
                descriptor=inner_descriptor,
                path=inner_descriptor.cache_path,
                cache_hit=False,
            )

        results: list[object] = [None, None]

        def run_request(index: int) -> None:
            results[index] = service.ensure_thumbnail(descriptor)

        with patch.object(service, "_generate_thumbnail", side_effect=fake_generate):
            first = threading.Thread(target=run_request, args=(0,))
            second = threading.Thread(target=run_request, args=(1,))
            first.start()
            self.assertTrue(started.wait(1))
            second.start()
            release.set()
            first.join(timeout=5)
            second.join(timeout=5)

        self.assertEqual(call_count, 1)
        self.assertEqual(results[0].status, "generated")
        self.assertIn(results[1].status, {"generated", "ready"})
        self.assertEqual(results[0].path, results[1].path)

    def test_ensure_thumbnail_logs_cache_hit_without_generation(self) -> None:
        local_root = self.create_local_root({"photos/cover.png": b"image-bytes"})
        service = ThumbnailService(SimulatedRclone(), "dropbox:", local_root, self._thumbnail_config())
        descriptor = service.descriptor_for_path("photos/cover.png", "local")
        assert descriptor is not None
        descriptor.cache_path.parent.mkdir(parents=True, exist_ok=True)
        descriptor.cache_path.write_bytes(b"cached-thumb")

        with patch("dropbox_browser.thumbnails.subprocess.run", side_effect=AssertionError("should not run")):
            result = service.ensure_thumbnail(descriptor)

        self.assertEqual(result.status, "ready")
        self.assertTrue(result.cache_hit)
        events = self.read_trace_events()
        self.assertEqual([event["event"] for event in events], ["thumbnail_cache_hit"])
        self.assertEqual(events[0]["cache_key"], descriptor.cache_key)

    def test_ensure_thumbnail_logs_magick_missing_when_disabled(self) -> None:
        local_root = self.create_local_root({"photos/cover.png": b"image-bytes"})
        service = ThumbnailService(SimulatedRclone(), "dropbox:", local_root, self._thumbnail_config(enabled=False))
        descriptor = service.descriptor_for_path("photos/cover.png", "local")

        result = service.ensure_thumbnail(descriptor)

        self.assertEqual(result.status, "disabled")
        events = self.read_trace_events()
        self.assertEqual([event["event"] for event in events], ["thumbnail_magick_missing"])

    def test_ensure_thumbnail_logs_generation_failure(self) -> None:
        local_root = self.create_local_root({"photos/cover.png": b"image-bytes"})
        service = ThumbnailService(SimulatedRclone(), "dropbox:", local_root, self._thumbnail_config())
        descriptor = service.descriptor_for_path("photos/cover.png", "local")

        def fake_run(cmd, stdout=None, stderr=None, check=None, timeout=None):
            return subprocess.CompletedProcess(cmd, 1, b"", b"magick failed")

        with patch("dropbox_browser.thumbnails.subprocess.run", side_effect=fake_run):
            result = service.ensure_thumbnail(descriptor)

        self.assertEqual(result.status, "failed")
        events = self.read_trace_events()
        self.assertEqual([event["event"] for event in events], [
            "thumbnail_cache_miss",
            "thumbnail_generation_failure",
        ])
        self.assertEqual(events[1]["error_message"], "magick failed")

    def test_descriptor_for_path_logs_unsupported_format(self) -> None:
        local_root = self.create_local_root({"photos/track.mp3": b"audio"})
        service = ThumbnailService(SimulatedRclone(), "dropbox:", local_root, self._thumbnail_config())

        descriptor = service.descriptor_for_path("photos/track.mp3", "local")

        self.assertIsNone(descriptor)
        events = self.read_trace_events()
        self.assertEqual([event["event"] for event in events], ["thumbnail_unsupported_format"])
        self.assertEqual(events[0]["rel_path"], "photos/track.mp3")


class ThumbnailHttpTests(AppTestCase):
    def _thumbnail_config(self, magick_exe: Path | None) -> ThumbnailConfig:
        return ThumbnailConfig(
            enabled=magick_exe is not None,
            configured_enabled=True,
            cache_dir=self.root / "ThumbnailCache",
            magick_exe=magick_exe,
            size=64,
            max_input_bytes=1024 * 1024,
            timeout_seconds=1.5,
        )

    def test_thumbnail_route_serves_generated_local_png(self) -> None:
        local_root = self.create_local_root({"photos/cover.png": b"local-image"})
        magick_exe = self.root / "ImageMagick" / "magick.exe"
        magick_exe.parent.mkdir(parents=True, exist_ok=True)
        magick_exe.write_bytes(b"")
        app = self._build_app(
            SimulatedRclone({}),
            local_root=local_root,
            workers=1,
            thumbnail_config=self._thumbnail_config(magick_exe),
        )

        def fake_run(cmd, stdout=None, stderr=None, check=None, timeout=None):
            output_path = Path(str(cmd[-1]).split("png:", 1)[1])
            output_path.write_bytes(b"png-thumb")
            return subprocess.CompletedProcess(cmd, 0, b"", b"")

        with patch("dropbox_browser.thumbnails.subprocess.run", side_effect=fake_run):
            with TestServer(app) as server:
                with urlopen(server.base_url + "/thumbnail?path=photos%2Fcover.png&source=local", timeout=5) as response:
                    body = response.read()
                    headers = response.headers
                    status = response.status

        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(body, b"png-thumb")
        self.assertEqual(headers["Content-Type"], "image/png")
        self.assertEqual(headers["Cache-Control"], "private, max-age=60")
        self.assertTrue(headers["ETag"])

    def test_thumbnail_route_serves_generated_remote_png(self) -> None:
        remote_bytes = b"remote-image"
        magick_exe = self.root / "ImageMagick" / "magick.exe"
        magick_exe.parent.mkdir(parents=True, exist_ok=True)
        magick_exe.write_bytes(b"")
        rclone = SimulatedRclone(
            {
                "dropbox:photos/cover.jpg": [SimulatedLsjsonResponse(items=[{
                    "Name": "cover.jpg",
                    "Path": "photos/cover.jpg",
                    "IsDir": False,
                    "Size": len(remote_bytes),
                    "ModTime": "2024-01-01T12:00:00Z",
                }])],
            },
            cat_data={"dropbox:photos/cover.jpg": remote_bytes},
        )
        app = self._build_app(
            rclone,
            local_root=None,
            workers=1,
            thumbnail_config=self._thumbnail_config(magick_exe),
        )

        def fake_run(cmd, stdout=None, stderr=None, check=None, timeout=None):
            input_path = Path(str(cmd[1]).rsplit("[0]", 1)[0])
            output_path = Path(str(cmd[-1]).split("png:", 1)[1])
            self.assertEqual(input_path.read_bytes(), remote_bytes)
            output_path.write_bytes(b"png-thumb")
            return subprocess.CompletedProcess(cmd, 0, b"", b"")

        with patch("dropbox_browser.thumbnails.subprocess.run", side_effect=fake_run):
            with TestServer(app) as server:
                with urlopen(server.base_url + "/thumbnail?path=photos%2Fcover.jpg&source=remote", timeout=5) as response:
                    body = response.read()
                    headers = response.headers
                    status = response.status

        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(body, b"png-thumb")
        self.assertEqual(headers["Content-Type"], "image/png")
        self.assertTrue(any(call["args"][0] == "lsjson" for call in rclone.calls))

    def test_thumbnail_head_returns_headers_without_body(self) -> None:
        local_root = self.create_local_root({"photos/cover.png": b"local-image"})
        magick_exe = self.root / "ImageMagick" / "magick.exe"
        magick_exe.parent.mkdir(parents=True, exist_ok=True)
        magick_exe.write_bytes(b"")
        app = self._build_app(
            SimulatedRclone({}),
            local_root=local_root,
            workers=1,
            thumbnail_config=self._thumbnail_config(magick_exe),
        )

        def fake_run(cmd, stdout=None, stderr=None, check=None, timeout=None):
            output_path = Path(str(cmd[-1]).split("png:", 1)[1])
            output_path.write_bytes(b"png-thumb")
            return subprocess.CompletedProcess(cmd, 0, b"", b"")

        with patch("dropbox_browser.thumbnails.subprocess.run", side_effect=fake_run):
            with TestServer(app) as server:
                status, headers, body = server.head(
                    "/thumbnail?path=photos%2Fcover.png&source=local",
                    timeout=30,
                )

        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(body, b"")
        self.assertEqual(headers["content-type"], "image/png")
        self.assertGreater(int(headers["content-length"]), 0)

    def test_thumbnail_route_rejects_unsupported_extension(self) -> None:
        local_root = self.create_local_root({"photos/track.mp3": b"audio"})
        app = self._build_app(
            SimulatedRclone({}),
            local_root=local_root,
            workers=1,
            thumbnail_config=self._thumbnail_config(None),
        )

        with TestServer(app) as server:
            with self.assertRaises(HTTPError) as raised:
                urlopen(server.base_url + "/thumbnail?path=photos%2Ftrack.mp3&source=local", timeout=5)

        self.assertEqual(raised.exception.code, HTTPStatus.NOT_FOUND)
        raised.exception.close()

    def test_thumbnail_route_rejects_path_traversal(self) -> None:
        app = self._build_app(
            SimulatedRclone({}),
            local_root=self.create_local_root({}),
            workers=1,
            thumbnail_config=self._thumbnail_config(None),
        )

        with TestServer(app) as server:
            with self.assertRaises(HTTPError) as raised:
                urlopen(server.base_url + "/thumbnail?path=..%2Fsecret.png&source=local", timeout=5)

        self.assertEqual(raised.exception.code, HTTPStatus.BAD_REQUEST)
        raised.exception.close()

    def test_thumbnail_route_serves_cached_hit_without_regeneration(self) -> None:
        local_root = self.create_local_root({"photos/cover.png": b"local-image"})
        magick_exe = self.root / "ImageMagick" / "magick.exe"
        magick_exe.parent.mkdir(parents=True, exist_ok=True)
        magick_exe.write_bytes(b"")
        app = self._build_app(
            SimulatedRclone({}),
            local_root=local_root,
            workers=1,
            thumbnail_config=self._thumbnail_config(magick_exe),
        )
        descriptor = app.thumbnail_service.descriptor_for_path("photos/cover.png", "local")
        assert descriptor is not None
        descriptor.cache_path.parent.mkdir(parents=True, exist_ok=True)
        descriptor.cache_path.write_bytes(b"cached-thumb")

        with patch("dropbox_browser.thumbnails.subprocess.run", side_effect=AssertionError("should not run")):
            with TestServer(app) as server:
                with urlopen(server.base_url + "/thumbnail?path=" + quote("photos/cover.png") + "&source=local", timeout=5) as response:
                    body = response.read()
                    headers = response.headers

        self.assertEqual(body, b"cached-thumb")
        self.assertEqual(headers["Content-Type"], "image/png")

    def test_thumbnail_route_returns_not_found_when_generation_fails(self) -> None:
        local_root = self.create_local_root({"photos/cover.png": b"local-image"})
        magick_exe = self.root / "ImageMagick" / "magick.exe"
        magick_exe.parent.mkdir(parents=True, exist_ok=True)
        magick_exe.write_bytes(b"")
        app = self._build_app(
            SimulatedRclone({}),
            local_root=local_root,
            workers=1,
            thumbnail_config=self._thumbnail_config(magick_exe),
        )

        def fake_run(cmd, stdout=None, stderr=None, check=None, timeout=None):
            return subprocess.CompletedProcess(cmd, 1, b"", b"magick failed")

        with patch("dropbox_browser.thumbnails.subprocess.run", side_effect=fake_run):
            with TestServer(app) as server:
                with self.assertRaises(HTTPError) as raised:
                    urlopen(server.base_url + "/thumbnail?path=photos%2Fcover.png&source=local", timeout=5)

        self.assertEqual(raised.exception.code, HTTPStatus.NOT_FOUND)
        raised.exception.close()


if __name__ == "__main__":
    unittest.main()
