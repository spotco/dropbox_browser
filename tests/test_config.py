from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from dropbox_browser import config as config_module


class ConfigDefaultsTests(unittest.TestCase):
    def test_default_localhost_only_access_is_enabled(self) -> None:
        config = dict(config_module._APP_CONFIG_DEFAULTS)

        self.assertEqual(config["LocalhostOnlyAccess"], True)

    def test_default_folder_cache_ttl_is_two_weeks(self) -> None:
        config = dict(config_module._APP_CONFIG_DEFAULTS)

        self.assertEqual(config["FolderCacheTTLSeconds"], 14 * 24 * 60 * 60)

    def test_packaged_config_folder_cache_ttl_is_two_weeks(self) -> None:
        config = config_module._read_config_file(config_module.PROJECT_ROOT / "config.json")

        self.assertEqual(config["FolderCacheTTLSeconds"], 14 * 24 * 60 * 60)

    def test_thumbnail_defaults_are_present(self) -> None:
        config = dict(config_module._APP_CONFIG_DEFAULTS)

        self.assertTrue(config["ThumbnailEnabled"])
        self.assertEqual(config["ThumbnailSize"], 64)
        self.assertEqual(config["ThumbnailMaxInputBytes"], 64 * 1024 * 1024)
        self.assertEqual(config["ThumbnailTimeoutSeconds"], 15)

    def test_packaged_config_thumbnail_size_defaults_to_64(self) -> None:
        config = config_module._read_config_file(config_module.PROJECT_ROOT / "config.json")

        self.assertEqual(config["ThumbnailSize"], 64)

    def test_video_tool_defaults_are_present(self) -> None:
        config = dict(config_module._APP_CONFIG_DEFAULTS)

        self.assertEqual(config["FFMpegPath"], "")
        self.assertEqual(config["FFProbePath"], "")

    def test_client_log_defaults_are_present(self) -> None:
        config = dict(config_module._APP_CONFIG_DEFAULTS)

        self.assertTrue(config["ClientLogEnabled"])
        self.assertTrue(config["ClientLogSubsystems"]["video"])
        self.assertFalse(config["ClientLogSubsystems"]["video-subtitles"])
        self.assertFalse(config["ClientLogSubsystems"]["browse-reveal"])
        self.assertFalse(config["ClientLogSubsystems"]["file-search"])
        self.assertFalse(config["ClientLogSubsystems"]["music-metadata"])


class ThumbnailConfigTests(unittest.TestCase):
    def test_find_vendored_magick_returns_none_when_missing(self) -> None:
        with patch.object(config_module, "VENDORED_MAGICK_EXE", Path("Z:/missing/ImageMagick/magick.exe")):
            self.assertIsNone(config_module.find_vendored_magick())

    def test_find_vendored_magick_returns_path_when_present(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            magick_exe = Path(temp_dir) / "ImageMagick" / "magick.exe"
            magick_exe.parent.mkdir(parents=True, exist_ok=True)
            magick_exe.write_bytes(b"")
            with patch.object(config_module, "VENDORED_MAGICK_EXE", magick_exe):
                self.assertEqual(config_module.find_vendored_magick(), magick_exe)

    def test_load_thumbnail_config_disables_when_magick_missing(self) -> None:
        app_config = {
            "ThumbnailEnabled": True,
            "ThumbnailSize": 80,
            "ThumbnailMaxInputBytes": 1234,
            "ThumbnailTimeoutSeconds": 9,
        }
        with patch.object(config_module, "find_vendored_magick", return_value=None):
            thumbnail_config = config_module.load_thumbnail_config(app_config)

        self.assertFalse(thumbnail_config.enabled)
        self.assertTrue(thumbnail_config.configured_enabled)
        self.assertEqual(thumbnail_config.size, 80)
        self.assertEqual(thumbnail_config.max_input_bytes, 1234)
        self.assertEqual(thumbnail_config.timeout_seconds, 9)

    def test_load_thumbnail_config_respects_explicit_disable(self) -> None:
        app_config = {"ThumbnailEnabled": False}
        fake_magick = config_module.PROJECT_ROOT / "ImageMagick" / "magick.exe"
        with patch.object(config_module, "find_vendored_magick", return_value=fake_magick):
            thumbnail_config = config_module.load_thumbnail_config(app_config)

        self.assertFalse(thumbnail_config.enabled)
        self.assertFalse(thumbnail_config.configured_enabled)
        self.assertEqual(thumbnail_config.magick_exe, fake_magick)


class VideoToolsConfigTests(unittest.TestCase):
    def test_find_vendored_ffmpeg_returns_none_when_missing(self) -> None:
        with patch.object(config_module, "VENDORED_FFMPEG_EXE", Path("Z:/missing/FFmpeg/bin/ffmpeg.exe")):
            self.assertIsNone(config_module.find_vendored_ffmpeg())

    def test_find_vendored_ffprobe_returns_none_when_missing(self) -> None:
        with patch.object(config_module, "VENDORED_FFPROBE_EXE", Path("Z:/missing/FFmpeg/bin/ffprobe.exe")):
            self.assertIsNone(config_module.find_vendored_ffprobe())

    def test_load_video_tools_config_prefers_vendored_binaries(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            ffmpeg_exe = Path(temp_dir) / "FFmpeg" / "bin" / "ffmpeg.exe"
            ffprobe_exe = Path(temp_dir) / "FFmpeg" / "bin" / "ffprobe.exe"
            ffmpeg_exe.parent.mkdir(parents=True, exist_ok=True)
            ffmpeg_exe.write_bytes(b"")
            ffprobe_exe.write_bytes(b"")
            with (
                patch.object(config_module, "VENDORED_FFMPEG_EXE", ffmpeg_exe),
                patch.object(config_module, "VENDORED_FFPROBE_EXE", ffprobe_exe),
                patch.object(config_module.shutil, "which", return_value=None),
            ):
                video_config = config_module.load_video_tools_config({})

        self.assertEqual(video_config.ffmpeg_exe, ffmpeg_exe)
        self.assertEqual(video_config.ffprobe_exe, ffprobe_exe)
        self.assertTrue(video_config.compatibility_available)

    def test_load_video_tools_config_uses_explicit_configured_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            ffmpeg_exe = Path(temp_dir) / "tools" / "ffmpeg.exe"
            ffprobe_exe = Path(temp_dir) / "tools" / "ffprobe.exe"
            ffmpeg_exe.parent.mkdir(parents=True, exist_ok=True)
            ffmpeg_exe.write_bytes(b"")
            ffprobe_exe.write_bytes(b"")
            with (
                patch.object(config_module, "find_vendored_ffmpeg", return_value=None),
                patch.object(config_module, "find_vendored_ffprobe", return_value=None),
                patch.object(config_module.shutil, "which", return_value=None),
            ):
                video_config = config_module.load_video_tools_config({
                    "FFMpegPath": str(ffmpeg_exe),
                    "FFProbePath": str(ffprobe_exe),
                })

        self.assertEqual(video_config.ffmpeg_exe, ffmpeg_exe.resolve())
        self.assertEqual(video_config.ffprobe_exe, ffprobe_exe.resolve())

    def test_load_video_tools_config_discovers_adjacent_ffprobe_from_ffmpeg_path(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            ffmpeg_exe = Path(temp_dir) / "tools" / "ffmpeg.exe"
            ffprobe_exe = Path(temp_dir) / "tools" / "ffprobe.exe"
            ffmpeg_exe.parent.mkdir(parents=True, exist_ok=True)
            ffprobe_exe.write_bytes(b"")
            with (
                patch.object(config_module, "find_vendored_ffmpeg", return_value=None),
                patch.object(config_module, "find_vendored_ffprobe", return_value=None),
                patch.object(config_module.shutil, "which", return_value=None),
            ):
                video_config = config_module.load_video_tools_config({
                    "FFMpegPath": str(ffmpeg_exe),
                })

        self.assertIsNone(video_config.ffmpeg_exe)
        self.assertEqual(video_config.ffprobe_exe, ffprobe_exe.resolve())

    def test_load_video_tools_config_falls_back_to_path(self) -> None:
        with (
            patch.object(config_module, "find_vendored_ffmpeg", return_value=None),
            patch.object(config_module, "find_vendored_ffprobe", return_value=None),
            patch.object(config_module.shutil, "which", side_effect=["C:/bin/ffmpeg.exe", "C:/bin/ffprobe.exe"]),
        ):
            video_config = config_module.load_video_tools_config({})

        self.assertEqual(video_config.ffmpeg_exe, Path("C:/bin/ffmpeg.exe").resolve())
        self.assertEqual(video_config.ffprobe_exe, Path("C:/bin/ffprobe.exe").resolve())


if __name__ == "__main__":
    unittest.main()
