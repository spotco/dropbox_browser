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

    def test_waveform_cache_entry_limit_defaults_are_bounded(self) -> None:
        config = dict(config_module._APP_CONFIG_DEFAULTS)

        self.assertEqual(config["MusicWaveformCacheEntryLimit"], 20)
        self.assertEqual(config_module.normalize_music_waveform_cache_entry_limit(-1), 0)
        self.assertEqual(config_module.normalize_music_waveform_cache_entry_limit(999), 100)
        self.assertEqual(config_module.normalize_music_waveform_cache_entry_limit("oops"), 20)
        self.assertEqual(config_module.normalize_music_waveform_cache_entry_limit(True), 20)

    def test_waveform_max_resolution_defaults_are_bounded(self) -> None:
        config = dict(config_module._APP_CONFIG_DEFAULTS)

        self.assertEqual(config["MusicWaveformMaxResolution"], 256)
        self.assertEqual(config_module.normalize_music_waveform_max_resolution(64), 64)
        self.assertEqual(config_module.normalize_music_waveform_max_resolution(256), 256)
        self.assertEqual(config_module.normalize_music_waveform_max_resolution(-1), 64)
        self.assertEqual(config_module.normalize_music_waveform_max_resolution(999), 512)
        self.assertEqual(config_module.normalize_music_waveform_max_resolution("oops"), 256)
        self.assertEqual(config_module.normalize_music_waveform_max_resolution(True), 256)

    def test_packaged_config_waveform_cache_entry_limit_defaults_to_20(self) -> None:
        config = config_module._read_config_file(config_module.PROJECT_ROOT / "config.json")

        self.assertEqual(config["MusicWaveformCacheEntryLimit"], 20)

    def test_packaged_config_waveform_max_resolution_is_locally_256(self) -> None:
        config = config_module._read_config_file(config_module.PROJECT_ROOT / "config.json")

        self.assertEqual(config["MusicWaveformMaxResolution"], 256)

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
        self.assertEqual(config["VideoFFmpegReadRate"], 1.1)
        self.assertEqual(config["VideoFFmpegInitialBurstSeconds"], 18.0)
        self.assertEqual(config["VideoFFmpegCatchupReadRate"], 1.3)
        self.assertEqual(config["VideoFFmpegThreads"], 0)
        self.assertEqual(config["VideoFFmpegFilterThreads"], 0)
        self.assertEqual(config["VideoFFmpegProcessPriority"], "below_normal")
        self.assertEqual(config["VideoSessionIdleTTLSeconds"], 15 * 60)
        self.assertEqual(config["VideoBackpressureLowWaterSeconds"], 45.0)
        self.assertEqual(config["VideoBackpressureMediumWaterSeconds"], 120.0)
        self.assertEqual(config["VideoBackpressureHighWaterSeconds"], 300.0)
        self.assertEqual(config["VideoBackpressureMaxWaterSeconds"], 600.0)
        self.assertEqual(config["VideoSubtitleFontFamily"], "Arial, Helvetica, sans-serif")
        self.assertEqual(config["VideoSubtitleFontSizePx"], 28)
        self.assertTrue(config["VideoSubtitleBold"])
        self.assertEqual(config["VideoProbeCacheTTLSeconds"], 7 * 24 * 60 * 60)
        self.assertEqual(config["VideoSubtitleCacheTTLSeconds"], 7 * 24 * 60 * 60)
        self.assertEqual(config["VideoHeaderCacheTTLSeconds"], 24 * 60 * 60)
        self.assertEqual(config["VideoHeaderCacheBytes"], 8 * 1024 * 1024)

    def test_packaged_config_video_subtitle_defaults_are_present(self) -> None:
        config = config_module._read_config_file(config_module.PROJECT_ROOT / "config.json")

        self.assertEqual(config["VideoFFmpegReadRate"], 1.1)
        self.assertEqual(config["VideoFFmpegInitialBurstSeconds"], 18.0)
        self.assertEqual(config["VideoFFmpegCatchupReadRate"], 1.3)
        self.assertEqual(config["VideoFFmpegThreads"], 0)
        self.assertEqual(config["VideoFFmpegFilterThreads"], 0)
        self.assertEqual(config["VideoFFmpegProcessPriority"], "below_normal")
        self.assertEqual(config["VideoSessionIdleTTLSeconds"], 15 * 60)
        self.assertEqual(config["VideoBackpressureLowWaterSeconds"], 45.0)
        self.assertEqual(config["VideoBackpressureMediumWaterSeconds"], 120.0)
        self.assertEqual(config["VideoBackpressureHighWaterSeconds"], 300.0)
        self.assertEqual(config["VideoBackpressureMaxWaterSeconds"], 600.0)
        self.assertEqual(config["VideoSubtitleFontFamily"], "Arial, Helvetica, sans-serif")
        self.assertEqual(config["VideoSubtitleFontSizePx"], 28)
        self.assertTrue(config["VideoSubtitleBold"])

    def test_client_log_defaults_are_present(self) -> None:
        config = dict(config_module._APP_CONFIG_DEFAULTS)

        self.assertTrue(config["ClientLogEnabled"])
        self.assertFalse(config["LogVideoDebug"])
        self.assertTrue(config["ClientLogSubsystems"]["video"])
        self.assertTrue(config["ClientLogSubsystems"]["video-timing"])
        self.assertFalse(config["ClientLogSubsystems"]["video-subtitles"])
        self.assertFalse(config["ClientLogSubsystems"]["browse-reveal"])
        self.assertFalse(config["ClientLogSubsystems"]["file-search"])
        self.assertFalse(config["ClientLogSubsystems"]["music-metadata"])
        self.assertFalse(config["ClientLogSubsystems"]["music-waveform"])
        self.assertFalse(config["ClientLogSubsystems"]["photo-map"])

    def test_rclone_write_retry_defaults_match_policy_defaults(self) -> None:
        config = dict(config_module._APP_CONFIG_DEFAULTS)

        self.assertEqual(config["RcloneWriteMaxAttempts"], 25)
        self.assertEqual(config["RcloneWriteMinTimeoutSeconds"], 10.0)
        self.assertEqual(config["RcloneWriteTimeoutPerGibSeconds"], 20.0)
        self.assertEqual(config["RcloneWriteMaxInitialTimeoutSeconds"], 300.0)
        self.assertEqual(config["RcloneWriteTimeoutMultiplier"], 2.0)
        self.assertEqual(config["RcloneWriteMaxTimeoutSeconds"], 600.0)


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
            patch.object(
                config_module.shutil,
                "which",
                side_effect=[
                    "C:/bin/ffmpeg.exe",
                    "C:/bin/ffprobe.exe",
                    "C:/bin/ffmpeg.exe",
                    "C:/bin/ffprobe.exe",
                ],
            ),
        ):
            video_config = config_module.load_video_tools_config({})

        self.assertEqual(video_config.ffmpeg_exe, Path("C:/bin/ffmpeg.exe").resolve())
        self.assertEqual(video_config.ffprobe_exe, Path("C:/bin/ffprobe.exe").resolve())

    def test_load_video_tools_config_reads_ffmpeg_input_pacing_settings(self) -> None:
        with (
            patch.object(config_module, "find_vendored_ffmpeg", return_value=None),
            patch.object(config_module, "find_vendored_ffprobe", return_value=None),
            patch.object(
                config_module.shutil,
                "which",
                side_effect=[
                    "C:/bin/ffmpeg.exe",
                    "C:/bin/ffprobe.exe",
                    "C:/bin/ffmpeg.exe",
                    "C:/bin/ffprobe.exe",
                ],
            ),
        ):
            video_config = config_module.load_video_tools_config({
                "VideoFFmpegReadRate": "1.25",
                "VideoFFmpegInitialBurstSeconds": "18.5",
                "VideoFFmpegCatchupReadRate": 2,
            })

        self.assertEqual(video_config.ffmpeg_read_rate, 1.25)
        self.assertEqual(video_config.ffmpeg_initial_burst_seconds, 18.5)
        self.assertEqual(video_config.ffmpeg_catchup_read_rate, 2.0)

    def test_load_video_tools_config_clamps_invalid_ffmpeg_input_pacing_settings(self) -> None:
        with (
            patch.object(config_module, "find_vendored_ffmpeg", return_value=None),
            patch.object(config_module, "find_vendored_ffprobe", return_value=None),
            patch.object(config_module.shutil, "which", side_effect=["C:/bin/ffmpeg.exe", "C:/bin/ffprobe.exe"]),
        ):
            video_config = config_module.load_video_tools_config({
                "VideoFFmpegReadRate": "-2",
                "VideoFFmpegInitialBurstSeconds": "oops",
                "VideoFFmpegCatchupReadRate": 99,
            })

        self.assertEqual(video_config.ffmpeg_read_rate, 0.0)
        self.assertEqual(video_config.ffmpeg_initial_burst_seconds, 18.0)
        self.assertEqual(video_config.ffmpeg_catchup_read_rate, 16.0)

    def test_load_video_tools_config_reads_ffmpeg_thread_settings(self) -> None:
        with (
            patch.object(config_module, "find_vendored_ffmpeg", return_value=None),
            patch.object(config_module, "find_vendored_ffprobe", return_value=None),
            patch.object(config_module.shutil, "which", side_effect=["C:/bin/ffmpeg.exe", "C:/bin/ffprobe.exe"]),
        ):
            video_config = config_module.load_video_tools_config({
                "VideoFFmpegThreads": "4",
                "VideoFFmpegFilterThreads": 2,
            })

        self.assertEqual(video_config.ffmpeg_threads, 4)
        self.assertEqual(video_config.ffmpeg_filter_threads, 2)

    def test_load_video_tools_config_clamps_invalid_ffmpeg_thread_settings(self) -> None:
        with (
            patch.object(config_module, "find_vendored_ffmpeg", return_value=None),
            patch.object(config_module, "find_vendored_ffprobe", return_value=None),
            patch.object(config_module.shutil, "which", side_effect=["C:/bin/ffmpeg.exe", "C:/bin/ffprobe.exe"]),
        ):
            video_config = config_module.load_video_tools_config({
                "VideoFFmpegThreads": "-1",
                "VideoFFmpegFilterThreads": 999,
            })

        self.assertEqual(video_config.ffmpeg_threads, 0)
        self.assertEqual(video_config.ffmpeg_filter_threads, 64)

    def test_load_video_tools_config_reads_ffmpeg_process_priority(self) -> None:
        with (
            patch.object(config_module, "find_vendored_ffmpeg", return_value=None),
            patch.object(config_module, "find_vendored_ffprobe", return_value=None),
            patch.object(config_module.shutil, "which", side_effect=["C:/bin/ffmpeg.exe", "C:/bin/ffprobe.exe"]),
        ):
            video_config = config_module.load_video_tools_config({
                "VideoFFmpegProcessPriority": "idle",
            })

        self.assertEqual(video_config.ffmpeg_process_priority, "idle")

    def test_load_video_tools_config_reads_max_concurrent_sessions(self) -> None:
        with (
            patch.object(config_module, "find_vendored_ffmpeg", return_value=None),
            patch.object(config_module, "find_vendored_ffprobe", return_value=None),
            patch.object(config_module.shutil, "which", side_effect=["C:/bin/ffmpeg.exe", "C:/bin/ffprobe.exe"]),
        ):
            video_config = config_module.load_video_tools_config({
                "VideoMaxConcurrentSessions": "4",
            })

        self.assertEqual(video_config.max_concurrent_sessions, 4)

    def test_load_video_tools_config_reads_session_idle_ttl_seconds(self) -> None:
        with (
            patch.object(config_module, "find_vendored_ffmpeg", return_value=None),
            patch.object(config_module, "find_vendored_ffprobe", return_value=None),
            patch.object(config_module.shutil, "which", side_effect=["C:/bin/ffmpeg.exe", "C:/bin/ffprobe.exe"]),
        ):
            video_config = config_module.load_video_tools_config({
                "VideoSessionIdleTTLSeconds": "120",
            })

        self.assertEqual(video_config.session_idle_ttl_seconds, 120.0)

    def test_load_video_tools_config_normalizes_invalid_max_concurrent_sessions(self) -> None:
        with (
            patch.object(config_module, "find_vendored_ffmpeg", return_value=None),
            patch.object(config_module, "find_vendored_ffprobe", return_value=None),
            patch.object(
                config_module.shutil,
                "which",
                side_effect=[
                    "C:/bin/ffmpeg.exe",
                    "C:/bin/ffprobe.exe",
                    "C:/bin/ffmpeg.exe",
                    "C:/bin/ffprobe.exe",
                ],
            ),
        ):
            low_config = config_module.load_video_tools_config({
                "VideoMaxConcurrentSessions": "0",
            })
            invalid_config = config_module.load_video_tools_config({
                "VideoMaxConcurrentSessions": "oops",
            })

        self.assertEqual(low_config.max_concurrent_sessions, 1)
        self.assertEqual(invalid_config.max_concurrent_sessions, 8)

    def test_load_video_tools_config_normalizes_invalid_session_idle_ttl_seconds(self) -> None:
        with (
            patch.object(config_module, "find_vendored_ffmpeg", return_value=None),
            patch.object(config_module, "find_vendored_ffprobe", return_value=None),
            patch.object(
                config_module.shutil,
                "which",
                side_effect=[
                    "C:/bin/ffmpeg.exe",
                    "C:/bin/ffprobe.exe",
                    "C:/bin/ffmpeg.exe",
                    "C:/bin/ffprobe.exe",
                ],
            ),
        ):
            low_config = config_module.load_video_tools_config({
                "VideoSessionIdleTTLSeconds": "0",
            })
            invalid_config = config_module.load_video_tools_config({
                "VideoSessionIdleTTLSeconds": "oops",
            })

        self.assertEqual(low_config.session_idle_ttl_seconds, 1.0)
        self.assertEqual(invalid_config.session_idle_ttl_seconds, 15 * 60.0)

    def test_load_video_tools_config_reads_backpressure_thresholds(self) -> None:
        with (
            patch.object(config_module, "find_vendored_ffmpeg", return_value=None),
            patch.object(config_module, "find_vendored_ffprobe", return_value=None),
            patch.object(config_module.shutil, "which", side_effect=["C:/bin/ffmpeg.exe", "C:/bin/ffprobe.exe"]),
        ):
            video_config = config_module.load_video_tools_config({
                "VideoBackpressureLowWaterSeconds": "30",
                "VideoBackpressureMediumWaterSeconds": "90",
                "VideoBackpressureHighWaterSeconds": 240,
                "VideoBackpressureMaxWaterSeconds": 480,
            })

        self.assertEqual(video_config.backpressure_low_water_seconds, 30.0)
        self.assertEqual(video_config.backpressure_medium_water_seconds, 90.0)
        self.assertEqual(video_config.backpressure_high_water_seconds, 240.0)
        self.assertEqual(video_config.backpressure_max_water_seconds, 480.0)

    def test_load_video_tools_config_normalizes_backpressure_thresholds(self) -> None:
        with (
            patch.object(config_module, "find_vendored_ffmpeg", return_value=None),
            patch.object(config_module, "find_vendored_ffprobe", return_value=None),
            patch.object(config_module.shutil, "which", side_effect=["C:/bin/ffmpeg.exe", "C:/bin/ffprobe.exe"]),
        ):
            video_config = config_module.load_video_tools_config({
                "VideoBackpressureLowWaterSeconds": "-1",
                "VideoBackpressureMediumWaterSeconds": "20",
                "VideoBackpressureHighWaterSeconds": "10",
                "VideoBackpressureMaxWaterSeconds": "5",
            })

        self.assertEqual(video_config.backpressure_low_water_seconds, 0.0)
        self.assertEqual(video_config.backpressure_medium_water_seconds, 20.0)
        self.assertEqual(video_config.backpressure_high_water_seconds, 20.0)
        self.assertEqual(video_config.backpressure_max_water_seconds, 20.0)

    def test_load_video_tools_config_normalizes_invalid_ffmpeg_process_priority(self) -> None:
        with (
            patch.object(config_module, "find_vendored_ffmpeg", return_value=None),
            patch.object(config_module, "find_vendored_ffprobe", return_value=None),
            patch.object(
                config_module.shutil,
                "which",
                side_effect=[
                    "C:/bin/ffmpeg.exe",
                    "C:/bin/ffprobe.exe",
                    "C:/bin/ffmpeg.exe",
                    "C:/bin/ffprobe.exe",
                ],
            ),
        ):
            hyphenated_config = config_module.load_video_tools_config({
                "VideoFFmpegProcessPriority": "below-normal",
            })
            invalid_config = config_module.load_video_tools_config({
                "VideoFFmpegProcessPriority": "realtime",
            })

        self.assertEqual(hyphenated_config.ffmpeg_process_priority, "below_normal")
        self.assertEqual(invalid_config.ffmpeg_process_priority, "below_normal")


if __name__ == "__main__":
    unittest.main()
