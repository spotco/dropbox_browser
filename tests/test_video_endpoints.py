from __future__ import annotations

import json
import io
import threading
import time
import unittest
from pathlib import Path
from subprocess import CompletedProcess
from urllib.error import HTTPError
from urllib.request import urlopen
from unittest.mock import patch

from dropbox_browser.config import VideoToolsConfig
from dropbox_browser.video import (
    HLS_MIN_READY_SEGMENTS,
    SUBTITLE_WINDOW_DURATION_SECONDS,
    SUBTITLE_WINDOW_GAP_ACTION,
    SUBTITLE_WINDOW_OVERLAP_SECONDS,
    SUBTITLE_WINDOW_SEEK_LAG_SECONDS,
    SUBTITLE_WINDOW_SEEK_LEAD_SECONDS,
    VideoHlsSession,
    build_ffmpeg_batch_subtitle_copy_command,
    build_ffmpeg_batch_webvtt_command,
    build_ffmpeg_hls_command,
    build_ffmpeg_subtitle_copy_command,
    build_ffmpeg_webvtt_command,
    build_ffprobe_command,
    compatibility_audio_mode_for_probe,
    compatibility_video_mode_for_probe,
    ffmpeg_popen_kwargs_for_priority,
    build_probe_cache_key,
    build_seek_subtitle_window_request,
    build_startup_subtitle_window_request,
    DEFAULT_PROBE_ANALYZE_DURATION_US,
    DEFAULT_PROBE_PROBE_SIZE_BYTES,
    build_subtitle_window_request,
    build_subtitle_window_response,
    build_subtitle_cache_key,
    build_subtitle_window_manifest_key,
    clamp_subtitle_window,
    expand_subtitle_window_for_extraction,
    extracted_webvtt_needs_absolute_offset,
    extract_remote_subtitle_window_to_webvtt,
    merge_subtitle_coverage_ranges,
    offset_webvtt_text,
    _playlist_ready_for_playback,
    _playlist_segment_names,
    parse_subtitle_window_duration_seconds,
    probe_cache_path,
    probe_payload_is_incomplete,
    rebase_webvtt_text,
    slice_webvtt_text_to_window,
    store_subtitle_window_cache_entry,
    _probe_cache_store,
    _write_probe_cache,
    subtitle_window_is_covered,
    subtitle_cache_path,
    subtitle_codec_supports_webvtt,
    subtitle_window_end_seconds,
    audio_stream_supports_aac_copy,
    video_stream_supports_h264_copy,
    read_subtitle_window_manifest,
)

try:
    from tests.app_test_support import AppTestCase
    from tests.support import SimulatedLsjsonResponse, SimulatedRclone, TestServer
except ImportError:
    from app_test_support import AppTestCase
    from support import SimulatedLsjsonResponse, SimulatedRclone, TestServer


def write_hls_session_fixture(
    playlist_path: Path,
    *,
    segment_base_url: str = "",
    segment_count: int = HLS_MIN_READY_SEGMENTS,
    include_segments: bool = True,
) -> None:
    playlist_path.parent.mkdir(parents=True, exist_ok=True)
    lines = ["#EXTM3U", '#EXT-X-MAP:URI="init.mp4"']
    for index in range(segment_count):
        segment_name = f"segment_{index:05d}.m4s"
        lines.append("#EXTINF:6,")
        lines.append(f"{segment_base_url}{segment_name}" if segment_base_url else segment_name)
    playlist_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    (playlist_path.parent / "init.mp4").write_bytes(b"init")
    if include_segments:
        for index in range(segment_count):
            (playlist_path.parent / f"segment_{index:05d}.m4s").write_bytes(f"segment{index}".encode())


def is_ffmpeg_hls_spawn(command: list[str]) -> bool:
    if not command:
        return False
    return str(command[0]).casefold().endswith("ffmpeg.exe") and str(command[-1]).casefold().endswith(".m3u8")


class FakeFfmpegProcess:
    def __init__(self, command: list[str]) -> None:
        self.command = command
        self.stdout = None
        self.stderr = io.BytesIO()
        self.returncode = None
        self.killed = False
        self.pid = 12345

    def poll(self):
        return self.returncode

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def communicate(self, input=None, timeout=None):
        if self.returncode is None:
            self.returncode = 0
        stderr_bytes = self.stderr.getvalue() if hasattr(self.stderr, "getvalue") else b""
        return b"", stderr_bytes

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9

    def wait(self, timeout: float | None = None) -> int:
        if self.returncode is None:
            self.returncode = 0
        return self.returncode


class VideoEndpointTests(AppTestCase):
    def test_library_endpoint_returns_child_folders_and_supported_video_files(self) -> None:
        rclone = self._build_video_library_rclone()
        app = self._build_app(rclone, local_root=None)

        with TestServer(app) as server:
            payload = server.get_json("/video/endpoints/library?path=Videos")

        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["root"], {
            "display_name": "Videos",
            "path": "Videos",
            "stream_path": "Videos",
            "remote_path": "dropbox:Videos",
        })
        self.assertEqual(payload["supported_extensions"], [".mkv", ".mp4", ".m4v", ".webm", ".mov", ".avi", ".ts", ".m2ts", ".wmv"])
        self.assertEqual(
            [(item["display_name"], item["type"]) for item in payload["items"]],
            [
                ("Anime", "folder"),
                ("Movies", "folder"),
                ("a.avi", "file"),
                ("B.mkv", "file"),
                ("clip.mp4", "file"),
                ("episode.WEBM", "file"),
            ],
        )
        mkv_row = next(item for item in payload["items"] if item["display_name"] == "B.mkv")
        mp4_row = next(item for item in payload["items"] if item["display_name"] == "clip.mp4")
        self.assertEqual(mkv_row["preview_url"], "/file?path=Videos%2FB.mkv&source=remote")
        self.assertTrue(mkv_row["compatibility_expected"])
        self.assertFalse(mp4_row["compatibility_expected"])
        self.assertEqual(len(rclone.calls), 1)
        self.assertEqual(rclone.calls[0]["target"], "dropbox:Videos")

    def test_status_endpoint_reports_missing_ffmpeg_support_without_crashing(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(ffmpeg_exe=None, ffprobe_exe=None),
        )

        with TestServer(app) as server:
            payload = server.get_json("/video/endpoints/status")

        self.assertEqual(payload["status"], "ok")
        self.assertFalse(payload["ffmpeg_available"])
        self.assertFalse(payload["ffprobe_available"])
        self.assertFalse(payload["compatibility_available"])
        self.assertTrue(payload["native_only"])
        self.assertEqual(payload["endpoint_root"], "/video/endpoints")

    def test_status_endpoint_reports_available_ffmpeg_support(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            ),
        )

        with TestServer(app) as server:
            payload = server.get_json("/video/endpoints/status?check=1")

        self.assertTrue(payload["ffmpeg_available"])
        self.assertTrue(payload["ffprobe_available"])
        self.assertTrue(payload["compatibility_available"])
        self.assertFalse(payload["native_only"])
        self.assertEqual(payload["ffmpeg_path"], "C:\\tools\\ffmpeg\\bin\\ffmpeg.exe")
        self.assertEqual(payload["ffprobe_path"], "C:\\tools\\ffmpeg\\bin\\ffprobe.exe")
        self.assertEqual(payload["query_keys"], ["check"])

    def test_unknown_video_endpoint_returns_not_found(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(rclone, local_root=None)

        with TestServer(app) as server:
            with self.assertRaises(HTTPError) as ctx:
                urlopen(server.base_url + "/video/endpoints/missing", timeout=5)

        self.assertEqual(ctx.exception.code, 404)
        ctx.exception.close()

    def test_library_endpoint_rejects_parent_segments(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(rclone, local_root=None)

        with TestServer(app) as server:
            with self.assertRaises(HTTPError) as ctx:
                urlopen(server.base_url + "/video/endpoints/library?path=..", timeout=5)

        self.assertEqual(ctx.exception.code, 400)
        ctx.exception.close()

    def test_library_endpoint_excludes_local_only_entries(self) -> None:
        local_root = self.create_local_root({
            "Videos/local-only.mp4": b"local",
            "Videos/LocalFolder/note.txt": b"x",
        })
        rclone = self._build_video_library_rclone()
        app = self._build_app(rclone, local_root=local_root)

        with TestServer(app) as server:
            payload = server.get_json("/video/endpoints/library?path=Videos")

        names = [item["display_name"] for item in payload["items"]]
        self.assertNotIn("local-only.mp4", names)
        self.assertNotIn("LocalFolder", names)

    def test_library_endpoint_marks_native_compatible_extensions(self) -> None:
        local_root = self.create_local_root({})
        rclone = SimulatedRclone({
            "dropbox:Videos": [SimulatedLsjsonResponse(items=[
                {
                    "Name": "movie.mov",
                    "Path": "movie.mov",
                    "IsDir": False,
                    "Size": 11,
                    "ModTime": "2024-01-01T12:00:00Z",
                },
                {
                    "Name": "broadcast.ts",
                    "Path": "broadcast.ts",
                    "IsDir": False,
                    "Size": 12,
                    "ModTime": "2024-01-01T12:00:01Z",
                },
            ])],
        })
        app = self._build_app(rclone, local_root=local_root)

        with TestServer(app) as server:
            payload = server.get_json("/video/endpoints/library?path=Videos")

        rows = {item["display_name"]: item for item in payload["items"]}
        self.assertFalse(rows["movie.mov"]["compatibility_expected"])
        self.assertTrue(rows["broadcast.ts"]["compatibility_expected"])

    def test_probe_endpoint_returns_structured_dual_audio_and_subtitle_metadata(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            ),
        )
        ffprobe_payload = {
            "streams": [
                {
                    "index": 0,
                    "codec_type": "video",
                    "codec_name": "hevc",
                    "codec_long_name": "H.265 / HEVC",
                    "width": 1920,
                    "height": 1080,
                    "pix_fmt": "yuv420p10le",
                },
                {
                    "index": 1,
                    "codec_type": "audio",
                    "codec_name": "aac",
                    "codec_long_name": "AAC",
                    "channels": 2,
                    "channel_layout": "stereo",
                    "sample_rate": "48000",
                    "tags": {"language": "jpn", "title": "Japanese"},
                    "disposition": {"default": 1, "forced": 0},
                },
                {
                    "index": 2,
                    "codec_type": "audio",
                    "codec_name": "aac",
                    "codec_long_name": "AAC",
                    "channels": 2,
                    "channel_layout": "stereo",
                    "sample_rate": "48000",
                    "tags": {"language": "eng", "title": "English"},
                    "disposition": {"default": 0, "forced": 0},
                },
                {
                    "index": 3,
                    "codec_type": "subtitle",
                    "codec_name": "ass",
                    "codec_long_name": "ASS",
                    "tags": {"language": "eng", "title": "Signs & Songs"},
                    "disposition": {"default": 0, "forced": 1},
                },
            ],
            "format": {
                "duration": "1501.250000",
            },
        }

        with (
            TestServer(app) as server,
            patch(
                "dropbox_browser.video.subprocess.run",
                return_value=CompletedProcess(
                    ["ffprobe"],
                    0,
                    json.dumps(ffprobe_payload).encode("utf-8"),
                    b"",
                ),
            ) as run_mock,
        ):
            payload = server.get_json("/video/endpoints/probe?path=movie.mp4&source=remote")

        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["path"], "movie.mp4")
        self.assertEqual(payload["source"], "remote")
        self.assertEqual(payload["duration_seconds"], 1501.25)
        self.assertEqual(payload["default_audio_stream_index"], 1)
        self.assertIsNone(payload["default_subtitle_stream_index"])
        self.assertTrue(payload["subtitle_off_default"])
        self.assertEqual(len(payload["video_streams"]), 1)
        self.assertEqual(len(payload["audio_streams"]), 2)
        self.assertEqual(len(payload["subtitle_streams"]), 1)
        self.assertEqual(payload["audio_streams"][0]["language"], "jpn")
        self.assertEqual(payload["audio_streams"][0]["title"], "Japanese")
        self.assertTrue(payload["audio_streams"][0]["default"])
        self.assertTrue(payload["audio_streams"][0]["hls_audio_copy_compatible"])
        self.assertEqual(payload["audio_streams"][0]["hls_audio_copy_reason"], "selected_aac_stream_copy_safe")
        self.assertEqual(payload["subtitle_streams"][0]["codec_name"], "ass")
        self.assertTrue(payload["subtitle_streams"][0]["webvtt_compatible"])
        self.assertTrue(payload["subtitle_streams"][0]["forced"])
        self.assertFalse(payload["video_streams"][0]["hls_video_copy_compatible"])
        self.assertEqual(payload["video_streams"][0]["hls_video_copy_reason"], "video_codec_not_h264")
        ffprobe_cmd = run_mock.call_args.args[0]
        self.assertEqual(ffprobe_cmd[0], "C:\\tools\\ffmpeg\\bin\\ffprobe.exe")
        self.assertIn("-probesize", ffprobe_cmd)
        self.assertIn(str(DEFAULT_PROBE_PROBE_SIZE_BYTES), ffprobe_cmd)
        self.assertIn("-analyzeduration", ffprobe_cmd)
        self.assertIn(str(DEFAULT_PROBE_ANALYZE_DURATION_US), ffprobe_cmd)
        input_url = ffprobe_cmd[-1]
        if input_url.startswith("http://"):
            self.assertIn("/file?path=movie.mp4&source=remote", input_url)
        else:
            self.assertTrue(input_url.endswith(".bin"), input_url)

    def test_build_ffprobe_command_caps_probe_and_analyze_duration(self) -> None:
        command = build_ffprobe_command(
            Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            "http://127.0.0.1:8000/file?path=movie.mkv&source=remote",
            probe_size_bytes=DEFAULT_PROBE_PROBE_SIZE_BYTES,
            analyze_duration_us=DEFAULT_PROBE_ANALYZE_DURATION_US,
        )
        self.assertEqual(
            command,
            [
                "C:\\tools\\ffmpeg\\bin\\ffprobe.exe",
                "-v",
                "error",
                "-probesize",
                str(DEFAULT_PROBE_PROBE_SIZE_BYTES),
                "-analyzeduration",
                str(DEFAULT_PROBE_ANALYZE_DURATION_US),
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
                "http://127.0.0.1:8000/file?path=movie.mkv&source=remote",
            ],
        )

    def test_probe_endpoint_rejects_local_source(self) -> None:
        rclone = self._remote_media_rclone()
        local_root = self.create_local_root({"movie.mp4": b"0123456789"})
        app = self._build_app(rclone, local_root=local_root)

        with TestServer(app) as server:
            with self.assertRaises(HTTPError) as ctx:
                urlopen(server.base_url + "/video/endpoints/probe?path=movie.mp4&source=local", timeout=5)

        self.assertEqual(ctx.exception.code, 400)
        ctx.exception.close()

    def test_probe_endpoint_requires_ffprobe(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"), ffprobe_exe=None),
        )

        with TestServer(app) as server:
            with self.assertRaises(HTTPError) as ctx:
                urlopen(server.base_url + "/video/endpoints/probe?path=movie.mp4&source=remote", timeout=5)

        self.assertEqual(ctx.exception.code, 503)
        ctx.exception.close()

    def test_probe_endpoint_rejects_parent_segments(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(rclone, local_root=None)

        with TestServer(app) as server:
            with self.assertRaises(HTTPError) as ctx:
                urlopen(server.base_url + "/video/endpoints/probe?path=../movie.mp4&source=remote", timeout=5)

        self.assertEqual(ctx.exception.code, 400)
        ctx.exception.close()

    def test_probe_endpoint_returns_canonical_remote_path_after_name_matching(self) -> None:
        local_root = self.create_local_root({"Movie.mkv": b"video"})
        rclone = self._build_case_variant_probe_rclone(local_root)
        app = self._build_app(
            rclone,
            local_root=local_root,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            ),
        )
        ffprobe_payload = {"streams": [], "format": {"duration": "10.0"}}

        with (
            TestServer(app) as server,
            patch(
                "dropbox_browser.video.subprocess.run",
                return_value=CompletedProcess(["ffprobe"], 0, json.dumps(ffprobe_payload).encode("utf-8"), b""),
            ),
        ):
            payload = server.get_json("/video/endpoints/probe?path=movie.mkv&source=remote")

        self.assertEqual(payload["path"], "Movie.mkv")
        self.assertEqual(payload["stream_path"], "Movie.mkv")

    def test_probe_endpoint_uses_disk_cache_on_repeat_request(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            ),
        )
        app.video_probe_cache_ttl_seconds = 3600
        ffprobe_payload = {
            "streams": [
                {
                    "index": 0,
                    "codec_type": "video",
                    "codec_name": "h264",
                    "pix_fmt": "yuv420p",
                }
            ],
            "format": {"duration": "120.0"},
        }
        run_calls: list[list[str]] = []

        def fake_run(cmd, stdout=None, stderr=None, check=False, timeout=None):
            run_calls.append(list(cmd))
            return CompletedProcess(cmd, 0, json.dumps(ffprobe_payload).encode("utf-8"), b"")

        with (
            TestServer(app) as server,
            patch("dropbox_browser.video.subprocess.run", side_effect=fake_run),
        ):
            first = server.get_json("/video/endpoints/probe?path=movie.mp4&source=remote")
            second = server.get_json("/video/endpoints/probe?path=movie.mp4&source=remote")

        self.assertEqual(first["path"], "movie.mp4")
        self.assertEqual(second["path"], "movie.mp4")
        self.assertTrue(first["video_streams"][0]["hls_video_copy_compatible"])
        self.assertEqual(first["video_streams"][0]["hls_video_copy_reason"], "selected_h264_stream_copy_safe")
        self.assertEqual(len(run_calls), 1)
        cache_path = probe_cache_path(build_probe_cache_key("movie.mp4", file_size=10))
        self.assertTrue(cache_path.is_file())

    def test_video_stream_supports_h264_copy_requires_safe_pixel_format(self) -> None:
        self.assertEqual(
            video_stream_supports_h264_copy({"codec_name": "h264", "pix_fmt": "yuv420p"}),
            (True, "selected_h264_stream_copy_safe"),
        )
        self.assertEqual(
            video_stream_supports_h264_copy({"codec_name": "h264", "pix_fmt": "yuv420p10le"}),
            (False, "video_pix_fmt_not_copy_safe"),
        )
        self.assertEqual(
            video_stream_supports_h264_copy({"codec_name": "hevc", "pix_fmt": "yuv420p"}),
            (False, "video_codec_not_h264"),
        )

    def test_audio_stream_supports_aac_copy_prefers_broad_aac_compatibility(self) -> None:
        self.assertEqual(
            audio_stream_supports_aac_copy({"codec_name": "aac", "channels": 6, "channel_layout": "5.1"}),
            (True, "selected_aac_stream_copy_safe"),
        )
        self.assertEqual(
            audio_stream_supports_aac_copy({"codec_name": "ac3", "channels": 6}),
            (False, "audio_codec_not_aac"),
        )

    def test_compatibility_video_mode_for_probe_prefers_copy_only_without_burn_in(self) -> None:
        probe_payload = {
            "video_streams": [
                {
                    "index": 0,
                    "codec_name": "h264",
                    "pix_fmt": "yuv420p",
                    "hls_video_copy_compatible": True,
                    "hls_video_copy_reason": "selected_h264_stream_copy_safe",
                }
            ]
        }

        self.assertEqual(
            compatibility_video_mode_for_probe(probe_payload, subtitle_stream_index=None),
            ("video_copy", "selected_h264_stream_copy_safe"),
        )
        self.assertEqual(
            compatibility_video_mode_for_probe(probe_payload, subtitle_stream_index=4),
            ("video_transcode", "subtitle_burn_in_requires_filter"),
        )
        self.assertEqual(
            compatibility_video_mode_for_probe(
                probe_payload,
                subtitle_stream_index=None,
                force_video_transcode=True,
            ),
            ("video_transcode", "forced_video_transcode"),
        )

    def test_compatibility_audio_mode_for_probe_prefers_selected_aac_stream_copy(self) -> None:
        probe_payload = {
            "audio_streams": [
                {
                    "index": 1,
                    "codec_name": "aac",
                    "hls_audio_copy_compatible": True,
                    "hls_audio_copy_reason": "selected_aac_stream_copy_safe",
                },
                {
                    "index": 2,
                    "codec_name": "ac3",
                    "hls_audio_copy_compatible": False,
                    "hls_audio_copy_reason": "audio_codec_not_aac",
                },
            ],
            "default_audio_stream_index": 1,
        }

        self.assertEqual(
            compatibility_audio_mode_for_probe(probe_payload, rel_path="movie.mp4", audio_stream_index=None),
            ("audio_copy", "selected_aac_stream_copy_safe"),
        )
        self.assertEqual(
            compatibility_audio_mode_for_probe(probe_payload, rel_path="movie.mp4", audio_stream_index=2),
            ("audio_transcode", "audio_codec_not_aac"),
        )
        self.assertEqual(
            compatibility_audio_mode_for_probe(
                probe_payload,
                rel_path="movie.mp4",
                audio_stream_index=1,
                force_audio_transcode=True,
            ),
            ("audio_transcode", "forced_audio_transcode"),
        )
        self.assertEqual(
            compatibility_audio_mode_for_probe(
                probe_payload,
                rel_path="movie.mkv",
                audio_stream_index=1,
            ),
            ("audio_transcode", "audio_container_not_copy_safe"),
        )

    def test_probe_cache_key_changes_when_file_size_changes(self) -> None:
        self.assertNotEqual(
            build_probe_cache_key("movie.mp4", file_size=10),
            build_probe_cache_key("movie.mp4", file_size=11),
        )

    def test_probe_payload_is_incomplete_detects_duration_without_streams(self) -> None:
        self.assertTrue(
            probe_payload_is_incomplete({
                "duration_seconds": 120.0,
                "video_streams": [],
                "audio_streams": [],
                "subtitle_streams": [],
            })
        )
        self.assertFalse(
            probe_payload_is_incomplete({
                "duration_seconds": 120.0,
                "video_streams": [{"index": 0}],
                "audio_streams": [],
                "subtitle_streams": [],
            })
        )

    def test_probe_endpoint_skips_incomplete_disk_cache(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            ),
        )
        app.video_probe_cache_ttl_seconds = 3600
        cache_key = build_probe_cache_key("movie.mp4", file_size=10)
        _probe_cache_store(app).write_json(
            cache_key,
            {
                "status": "ok",
                "source": "remote",
                "path": "movie.mp4",
                "stream_path": "movie.mp4",
                "probe_url": "cache://incomplete",
                "duration_seconds": 120.0,
                "video_streams": [],
                "audio_streams": [],
                "subtitle_streams": [],
                "default_audio_stream_index": None,
                "default_subtitle_stream_index": None,
                "subtitle_off_default": True,
            },
        )
        ffprobe_payload = {
            "streams": [
                {"index": 0, "codec_type": "video", "codec_name": "h264"},
                {"index": 1, "codec_type": "audio", "codec_name": "aac", "tags": {"language": "eng"}},
            ],
            "format": {"duration": "120.0"},
        }
        run_calls: list[list[str]] = []

        def fake_run(cmd, stdout=None, stderr=None, check=False, timeout=None):
            run_calls.append(list(cmd))
            return CompletedProcess(cmd, 0, json.dumps(ffprobe_payload).encode("utf-8"), b"")

        with (
            TestServer(app) as server,
            patch("dropbox_browser.video.subprocess.run", side_effect=fake_run),
        ):
            payload = server.get_json("/video/endpoints/probe?path=movie.mp4&source=remote")

        self.assertEqual(len(run_calls), 1)
        self.assertEqual(len(payload["audio_streams"]), 1)
        cached_payload = json.loads(probe_cache_path(cache_key).read_text(encoding="utf-8"))
        self.assertEqual(len(cached_payload["audio_streams"]), 1)
        self.assertFalse(probe_payload_is_incomplete(cached_payload))

    def test_probe_endpoint_does_not_cache_incomplete_probe(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            ),
        )
        app.video_probe_cache_ttl_seconds = 3600
        ffprobe_payload = {
            "streams": [],
            "format": {"duration": "120.0"},
        }

        def fake_run(cmd, stdout=None, stderr=None, check=False, timeout=None):
            return CompletedProcess(cmd, 0, json.dumps(ffprobe_payload).encode("utf-8"), b"")

        with (
            TestServer(app) as server,
            patch("dropbox_browser.video.subprocess.run", side_effect=fake_run),
        ):
            payload = server.get_json("/video/endpoints/probe?path=movie.mp4&source=remote")

        cache_path = probe_cache_path(build_probe_cache_key("movie.mp4", file_size=10))
        self.assertFalse(cache_path.is_file())
        self.assertEqual(payload["audio_streams"], [])

    def test_cache_clear_endpoint_clears_video_disk_caches(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            ),
        )
        cache_key = build_probe_cache_key("movie.mp4", file_size=10)
        _write_probe_cache(
            app,
            cache_key,
            {
                "status": "ok",
                "source": "remote",
                "path": "movie.mp4",
                "stream_path": "movie.mp4",
                "probe_url": "cache://complete",
                "duration_seconds": 120.0,
                "video_streams": [{"index": 0}],
                "audio_streams": [],
                "subtitle_streams": [],
                "default_audio_stream_index": None,
                "default_subtitle_stream_index": None,
                "subtitle_off_default": True,
            },
        )
        self.assertTrue(probe_cache_path(cache_key).is_file())

        with TestServer(app) as server:
            payload = server.post_json("/video/endpoints/cache/clear", {})

        self.assertEqual(payload["status"], "ok")
        self.assertTrue(payload["cleared"]["probe_cache"])
        self.assertFalse(probe_cache_path(cache_key).is_file())

    def test_probe_endpoint_falls_back_to_remote_file_when_header_probe_is_incomplete(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            ),
        )
        app.video_probe_cache_ttl_seconds = 3600
        app.video_header_cache_bytes = 8
        incomplete_payload = {
            "streams": [],
            "format": {"duration": "120.0"},
        }
        complete_payload = {
            "streams": [
                {"index": 0, "codec_type": "video", "codec_name": "h264"},
                {"index": 1, "codec_type": "audio", "codec_name": "aac", "tags": {"language": "eng"}},
            ],
            "format": {"duration": "120.0"},
        }
        run_calls: list[list[str]] = []

        def fake_run(cmd, stdout=None, stderr=None, check=False, timeout=None):
            run_calls.append(list(cmd))
            input_url = cmd[-1]
            payload = incomplete_payload if input_url.endswith(".bin") else complete_payload
            return CompletedProcess(cmd, 0, json.dumps(payload).encode("utf-8"), b"")

        with (
            TestServer(app) as server,
            patch("dropbox_browser.video.subprocess.run", side_effect=fake_run),
        ):
            payload = server.get_json("/video/endpoints/probe?path=movie.mp4&source=remote")

        self.assertEqual(len(run_calls), 2)
        self.assertTrue(run_calls[0][-1].endswith(".bin"), run_calls[0][-1])
        self.assertIn("path=movie.mp4", run_calls[1][-1])
        self.assertEqual(len(payload["audio_streams"]), 1)

    def test_probe_endpoint_uses_header_cache_for_ffprobe_input(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            ),
        )
        app.video_header_cache_bytes = 8
        ffprobe_payload = {
            "streams": [{"index": 0, "codec_type": "video", "codec_name": "h264"}],
            "format": {"duration": "120.0"},
        }
        run_calls: list[list[str]] = []

        def fake_run(cmd, stdout=None, stderr=None, check=False, timeout=None):
            run_calls.append(list(cmd))
            return CompletedProcess(cmd, 0, json.dumps(ffprobe_payload).encode("utf-8"), b"")

        with (
            TestServer(app) as server,
            patch("dropbox_browser.video.subprocess.run", side_effect=fake_run),
        ):
            server.get_json("/video/endpoints/probe?path=movie.mp4&source=remote")

        self.assertEqual(len(run_calls), 1)
        input_url = run_calls[0][-1]
        self.assertFalse(input_url.startswith("http://"))
        self.assertTrue(input_url.endswith(".bin"), input_url)

    def test_subtitles_endpoint_expires_disk_cache_after_ttl(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            ),
        )
        app.video_subtitle_cache_ttl_seconds = 0.01
        ffprobe_payload = {
            "streams": [
                {"index": 0, "codec_type": "video", "codec_name": "h264"},
                {
                    "index": 3,
                    "codec_type": "subtitle",
                    "codec_name": "ass",
                    "tags": {"language": "eng"},
                    "disposition": {"default": 1, "forced": 0},
                },
            ],
            "format": {"duration": "15.0"},
        }
        vtt_body = b"WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n"

        with (
            TestServer(app) as server,
            patch(
                "dropbox_browser.video.subprocess.run",
                side_effect=lambda cmd, stdout=None, stderr=None, check=False, timeout=None: CompletedProcess(
                    cmd,
                    0,
                    json.dumps(ffprobe_payload).encode("utf-8")
                    if "ffprobe" in Path(cmd[0]).name.lower()
                    else (vtt_body if cmd and cmd[-1] == "-" else b""),
                    b"",
                ),
            ) as mock_run,
            patch("dropbox_browser.video.SUBTITLE_CACHE_DIR", self.temp_dir / "subtitle_cache"),
        ):
            url = server.base_url + "/video/endpoints/subtitles?path=movie.mp4&source=remote&track=3"
            with urlopen(url, timeout=5) as response:
                self.assertEqual(response.read(), vtt_body)
            time.sleep(0.02)
            with urlopen(url, timeout=5) as response:
                self.assertEqual(response.read(), vtt_body)
            self.assertEqual(mock_run.call_count, 5)

    def test_session_endpoint_creates_hls_session_and_returns_playlist_url(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            ),
        )
        spawned: list[FakeFfmpegProcess] = []

        def fake_popen(command, stdout=None, stderr=None, cwd=None, **kwargs):
            if not is_ffmpeg_hls_spawn(command):
                return FakeFfmpegProcess(command)
            playlist_path = Path(command[-1])
            segment_base_url = command[command.index("-hls_base_url") + 1]
            write_hls_session_fixture(playlist_path, segment_base_url=segment_base_url)
            process = FakeFfmpegProcess(command)
            spawned.append(process)
            return process

        with TestServer(app) as server, patch("dropbox_browser.video.subprocess.Popen", side_effect=fake_popen):
            payload = server.post_json("/video/endpoints/session", {
                "path": "movie.mp4",
                "source": "remote",
                "start_time_seconds": "120.5",
            })

        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["path"], "movie.mp4")
        self.assertEqual(payload["start_time_seconds"], 120.5)
        self.assertEqual(payload["encoded_media_end_seconds"], HLS_MIN_READY_SEGMENTS * 6.0)
        self.assertEqual(payload["ffmpeg_pid"], 12345)
        self.assertTrue(payload["session_id"])
        self.assertEqual(
            payload["playlist_url"],
            "/video/endpoints/session/file?id=" + payload["session_id"] + "&name=stream.m3u8",
        )
        self.assertIsNone(payload["audio_stream_index"])
        self.assertIsNone(payload["subtitle_stream_index"])
        self.assertEqual(len(spawned), 1)
        self.assertEqual(spawned[0].command[0], "C:\\tools\\ffmpeg\\bin\\ffmpeg.exe")
        self.assertTrue(any("/file?path=movie.mp4&source=remote" in part for part in spawned[0].command))
        self.assertIn("-ss", spawned[0].command)
        self.assertEqual(spawned[0].command[spawned[0].command.index("-ss") + 1], "120.5")
        self.assertTrue(any(("/video/endpoints/session/file?id=" + payload["session_id"] + "&name=") in part for part in spawned[0].command))

    def test_session_asset_endpoint_serves_playlist_and_segment_files(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            ),
        )

        def fake_popen(command, stdout=None, stderr=None, cwd=None, **kwargs):
            if not is_ffmpeg_hls_spawn(command):
                return FakeFfmpegProcess(command)
            playlist_path = Path(command[-1])
            segment_base_url = command[command.index("-hls_base_url") + 1]
            write_hls_session_fixture(playlist_path, segment_base_url=segment_base_url)
            return FakeFfmpegProcess(command)

        with TestServer(app) as server, patch("dropbox_browser.video.subprocess.Popen", side_effect=fake_popen):
            payload = server.post_json("/video/endpoints/session", {
                "path": "movie.mp4",
                "source": "remote",
            })
            playlist_text = server.get_text(payload["playlist_url"])
            with urlopen(server.base_url + payload["asset_root"] + "segment_00000.m4s", timeout=5) as response:
                segment_bytes = response.read()
                segment_type = response.headers["Content-Type"]
            with urlopen(server.base_url + payload["asset_root"] + "init.mp4", timeout=5) as response:
                init_bytes = response.read()
                init_type = response.headers["Content-Type"]
            with self.assertRaises(HTTPError) as ctx:
                urlopen(server.base_url + "/video/endpoints/session/file?id=" + payload["session_id"] + "&name=..%2Fbad.ts", timeout=5)

        self.assertIn("#EXTM3U", playlist_text)
        self.assertIn("#EXT-X-START:TIME-OFFSET=0,PRECISE=YES", playlist_text)
        self.assertIn("name=init.mp4", playlist_text)
        self.assertEqual(segment_bytes, b"segment0")
        self.assertEqual(segment_type, "video/mp4")
        self.assertEqual(init_bytes, b"init")
        self.assertEqual(init_type, "video/mp4")
        self.assertEqual(ctx.exception.code, 404)
        ctx.exception.close()

    def test_session_endpoint_waits_for_minimum_ready_segments(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            ),
        )

        def fake_popen(command, stdout=None, stderr=None, cwd=None, **kwargs):
            if not is_ffmpeg_hls_spawn(command):
                return FakeFfmpegProcess(command)
            playlist_path = Path(command[-1])
            write_hls_session_fixture(playlist_path, include_segments=False)

            def write_segments() -> None:
                time.sleep(0.1)
                (playlist_path.parent / "segment_00000.m4s").write_bytes(b"segment0")

            threading.Thread(target=write_segments, daemon=True).start()
            return FakeFfmpegProcess(command)

        with TestServer(app) as server, patch("dropbox_browser.video.subprocess.Popen", side_effect=fake_popen):
            started = time.monotonic()
            payload = server.post_json("/video/endpoints/session", {
                "path": "movie.mp4",
                "source": "remote",
            })
            elapsed = time.monotonic() - started
            with urlopen(server.base_url + payload["asset_root"] + "segment_00000.m4s", timeout=5) as response:
                body = response.read()

        self.assertGreaterEqual(elapsed, 0.08)
        self.assertEqual(body, b"segment0")

    def test_session_asset_endpoint_waits_for_delayed_segment_while_process_runs(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            ),
        )
        requested_segment = threading.Event()

        def fake_popen(command, stdout=None, stderr=None, cwd=None, **kwargs):
            if not is_ffmpeg_hls_spawn(command):
                return FakeFfmpegProcess(command)
            playlist_path = Path(command[-1])
            write_hls_session_fixture(playlist_path, segment_count=3)
            (playlist_path.parent / "segment_00002.m4s").unlink(missing_ok=True)
            playlist_path.write_text(
                playlist_path.read_text(encoding="utf-8")
                + "#EXTINF:6,\nsegment_00002.m4s\n",
                encoding="utf-8",
            )

            def write_delayed_segment() -> None:
                requested_segment.wait(timeout=2)
                time.sleep(0.2)
                (playlist_path.parent / "segment_00002.m4s").write_bytes(b"third")

            threading.Thread(target=write_delayed_segment, daemon=True).start()
            return FakeFfmpegProcess(command)

        with TestServer(app) as server, patch("dropbox_browser.video.subprocess.Popen", side_effect=fake_popen):
            payload = server.post_json("/video/endpoints/session", {
                "path": "movie.mp4",
                "source": "remote",
            })
            started = time.monotonic()
            requested_segment.set()
            with urlopen(server.base_url + payload["asset_root"] + "segment_00002.m4s", timeout=5) as response:
                body = response.read()
                elapsed = time.monotonic() - started

        self.assertGreaterEqual(elapsed, 0.15)
        self.assertEqual(body, b"third")

    def test_new_session_replaces_previous_session_and_cleans_up_old_assets(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            ),
        )
        spawned: list[FakeFfmpegProcess] = []

        def fake_popen(command, stdout=None, stderr=None, cwd=None, **kwargs):
            if not is_ffmpeg_hls_spawn(command):
                return FakeFfmpegProcess(command)
            playlist_path = Path(command[-1])
            write_hls_session_fixture(playlist_path)
            process = FakeFfmpegProcess(command)
            spawned.append(process)
            return process

        with TestServer(app) as server, patch("dropbox_browser.video.subprocess.Popen", side_effect=fake_popen):
            first = server.post_json("/video/endpoints/session", {
                "path": "movie.mp4",
                "source": "remote",
            })
            second = server.post_json("/video/endpoints/session", {
                "path": "movie.mp4",
                "source": "remote",
            })
            with self.assertRaises(HTTPError) as ctx:
                urlopen(server.base_url + first["playlist_url"], timeout=5)
            second_playlist = server.get_text(second["playlist_url"])

        self.assertEqual(len(spawned), 2)
        self.assertTrue(spawned[0].killed)
        self.assertIn("#EXTM3U", second_playlist)
        self.assertEqual(ctx.exception.code, 404)
        ctx.exception.close()

    def test_session_stop_endpoint_cleans_up_active_session(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            ),
        )

        def fake_popen(command, stdout=None, stderr=None, cwd=None, **kwargs):
            if not is_ffmpeg_hls_spawn(command):
                return FakeFfmpegProcess(command)
            playlist_path = Path(command[-1])
            write_hls_session_fixture(playlist_path)
            return FakeFfmpegProcess(command)

        with TestServer(app) as server, patch("dropbox_browser.video.subprocess.Popen", side_effect=fake_popen):
            payload = server.post_json("/video/endpoints/session", {
                "path": "movie.mp4",
                "source": "remote",
            })
            stop_payload = server.post_json("/video/endpoints/session/stop", {
                "id": payload["session_id"],
            })
            with self.assertRaises(HTTPError) as ctx:
                urlopen(server.base_url + payload["playlist_url"], timeout=5)

        self.assertEqual(stop_payload, {"status": "ok", "stopped": True})
        self.assertEqual(ctx.exception.code, 404)
        ctx.exception.close()

    def test_session_endpoint_passes_selected_audio_stream_index_to_ffmpeg(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            ),
        )
        spawned: list[FakeFfmpegProcess] = []

        def fake_popen(command, stdout=None, stderr=None, cwd=None, **kwargs):
            if not is_ffmpeg_hls_spawn(command):
                return FakeFfmpegProcess(command)
            playlist_path = Path(command[-1])
            write_hls_session_fixture(playlist_path)
            process = FakeFfmpegProcess(command)
            spawned.append(process)
            return process

        with TestServer(app) as server, patch("dropbox_browser.video.subprocess.Popen", side_effect=fake_popen):
            payload = server.post_json("/video/endpoints/session", {
                "path": "movie.mp4",
                "source": "remote",
                "audio_stream_index": "2",
            })

        self.assertEqual(payload["audio_stream_index"], 2)
        self.assertIsNone(payload["subtitle_stream_index"])
        self.assertIn("0:2?", spawned[0].command)

    def test_session_endpoint_passes_configured_thread_flags_to_ffmpeg(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
                ffmpeg_threads=3,
                ffmpeg_filter_threads=2,
            ),
        )
        spawned: list[FakeFfmpegProcess] = []

        def fake_popen(command, stdout=None, stderr=None, cwd=None, **kwargs):
            if not is_ffmpeg_hls_spawn(command):
                return FakeFfmpegProcess(command)
            playlist_path = Path(command[-1])
            write_hls_session_fixture(playlist_path)
            process = FakeFfmpegProcess(command)
            spawned.append(process)
            return process

        with TestServer(app) as server, patch("dropbox_browser.video.subprocess.Popen", side_effect=fake_popen):
            server.post_json("/video/endpoints/session", {
                "path": "movie.mp4",
                "source": "remote",
                "subtitle_stream_index": "4",
            })

        self.assertEqual(spawned[0].command[spawned[0].command.index("-threads") + 1], "3")
        self.assertEqual(spawned[0].command[spawned[0].command.index("-filter_threads") + 1], "2")
        self.assertEqual(spawned[0].command[spawned[0].command.index("-filter_complex_threads") + 1], "2")

    def test_session_endpoint_uses_video_copy_for_copy_safe_h264_without_burn_in(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            ),
        )
        spawned: list[FakeFfmpegProcess] = []

        def fake_popen(command, stdout=None, stderr=None, cwd=None, **kwargs):
            if not is_ffmpeg_hls_spawn(command):
                return FakeFfmpegProcess(command)
            playlist_path = Path(command[-1])
            write_hls_session_fixture(playlist_path)
            process = FakeFfmpegProcess(command)
            spawned.append(process)
            return process

        with (
            TestServer(app) as server,
            patch(
                "dropbox_browser.video.probe_remote_media",
                return_value={
                    "video_streams": [
                        {
                            "index": 0,
                            "codec_name": "h264",
                            "pix_fmt": "yuv420p",
                            "hls_video_copy_compatible": True,
                            "hls_video_copy_reason": "selected_h264_stream_copy_safe",
                        }
                    ]
                },
            ),
            patch("dropbox_browser.video.subprocess.Popen", side_effect=fake_popen),
        ):
            payload = server.post_json("/video/endpoints/session", {
                "path": "movie.mp4",
                "source": "remote",
            })

        self.assertEqual(payload["video_mode"], "video_copy")
        self.assertEqual(payload["video_mode_reason"], "selected_h264_stream_copy_safe")
        self.assertEqual(spawned[0].command[spawned[0].command.index("-c:v") + 1], "copy")
        self.assertNotIn("-force_key_frames", spawned[0].command)
        self.assertNotIn("-pix_fmt", spawned[0].command)

    def test_session_endpoint_uses_audio_copy_for_copy_safe_aac_selection(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            ),
        )
        spawned: list[FakeFfmpegProcess] = []

        def fake_popen(command, stdout=None, stderr=None, cwd=None, **kwargs):
            if not is_ffmpeg_hls_spawn(command):
                return FakeFfmpegProcess(command)
            playlist_path = Path(command[-1])
            write_hls_session_fixture(playlist_path)
            process = FakeFfmpegProcess(command)
            spawned.append(process)
            return process

        with (
            TestServer(app) as server,
            patch(
                "dropbox_browser.video.probe_remote_media",
                return_value={
                    "video_streams": [
                        {
                            "index": 0,
                            "codec_name": "h264",
                            "pix_fmt": "yuv420p",
                            "hls_video_copy_compatible": True,
                            "hls_video_copy_reason": "selected_h264_stream_copy_safe",
                        }
                    ],
                    "audio_streams": [
                        {
                            "index": 2,
                            "codec_name": "aac",
                            "hls_audio_copy_compatible": True,
                            "hls_audio_copy_reason": "selected_aac_stream_copy_safe",
                        }
                    ],
                    "default_audio_stream_index": 2,
                },
            ),
            patch("dropbox_browser.video.subprocess.Popen", side_effect=fake_popen),
        ):
            payload = server.post_json("/video/endpoints/session", {
                "path": "movie.mp4",
                "source": "remote",
                "audio_stream_index": "2",
            })

        self.assertEqual(payload["audio_mode"], "audio_copy")
        self.assertEqual(payload["audio_mode_reason"], "selected_aac_stream_copy_safe")
        self.assertEqual(spawned[0].command[spawned[0].command.index("-c:a") + 1], "copy")
        self.assertNotIn("-ac", spawned[0].command)
        self.assertNotIn("-ar", spawned[0].command)

    def test_session_endpoint_force_video_transcode_overrides_copy_safe_probe(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            ),
        )
        spawned: list[FakeFfmpegProcess] = []

        def fake_popen(command, stdout=None, stderr=None, cwd=None, **kwargs):
            if not is_ffmpeg_hls_spawn(command):
                return FakeFfmpegProcess(command)
            playlist_path = Path(command[-1])
            write_hls_session_fixture(playlist_path)
            process = FakeFfmpegProcess(command)
            spawned.append(process)
            return process

        with (
            TestServer(app) as server,
            patch(
                "dropbox_browser.video.probe_remote_media",
                return_value={
                    "video_streams": [
                        {
                            "index": 0,
                            "codec_name": "h264",
                            "pix_fmt": "yuv420p",
                            "hls_video_copy_compatible": True,
                            "hls_video_copy_reason": "selected_h264_stream_copy_safe",
                        }
                    ]
                },
            ),
            patch("dropbox_browser.video.subprocess.Popen", side_effect=fake_popen),
        ):
            payload = server.post_json("/video/endpoints/session", {
                "path": "movie.mp4",
                "source": "remote",
                "force_video_transcode": "1",
            })

        self.assertEqual(payload["video_mode"], "video_transcode")
        self.assertEqual(payload["video_mode_reason"], "forced_video_transcode")
        self.assertEqual(spawned[0].command[spawned[0].command.index("-c:v") + 1], "libx264")

    def test_session_endpoint_force_audio_transcode_overrides_copy_safe_probe(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            ),
        )
        spawned: list[FakeFfmpegProcess] = []

        def fake_popen(command, stdout=None, stderr=None, cwd=None, **kwargs):
            if not is_ffmpeg_hls_spawn(command):
                return FakeFfmpegProcess(command)
            playlist_path = Path(command[-1])
            write_hls_session_fixture(playlist_path)
            process = FakeFfmpegProcess(command)
            spawned.append(process)
            return process

        with (
            TestServer(app) as server,
            patch(
                "dropbox_browser.video.probe_remote_media",
                return_value={
                    "video_streams": [],
                    "audio_streams": [
                        {
                            "index": 2,
                            "codec_name": "aac",
                            "hls_audio_copy_compatible": True,
                            "hls_audio_copy_reason": "selected_aac_stream_copy_safe",
                        }
                    ],
                    "default_audio_stream_index": 2,
                },
            ),
            patch("dropbox_browser.video.subprocess.Popen", side_effect=fake_popen),
        ):
            payload = server.post_json("/video/endpoints/session", {
                "path": "movie.mp4",
                "source": "remote",
                "audio_stream_index": "2",
                "force_audio_transcode": "1",
            })

        self.assertEqual(payload["audio_mode"], "audio_transcode")
        self.assertEqual(payload["audio_mode_reason"], "forced_audio_transcode")
        self.assertEqual(spawned[0].command[spawned[0].command.index("-c:a") + 1], "aac")
        self.assertIn("-ac", spawned[0].command)
        self.assertIn("-ar", spawned[0].command)

    def test_session_endpoint_passes_configured_windows_priority_to_ffmpeg_popen(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
                ffmpeg_process_priority="idle",
            ),
        )
        popen_kwargs: list[dict[str, object]] = []

        def fake_popen(command, stdout=None, stderr=None, cwd=None, **kwargs):
            if not is_ffmpeg_hls_spawn(command):
                return FakeFfmpegProcess(command)
            playlist_path = Path(command[-1])
            write_hls_session_fixture(playlist_path)
            popen_kwargs.append(dict(kwargs))
            return FakeFfmpegProcess(command)

        with (
            TestServer(app) as server,
            patch("dropbox_browser.video.os.name", "nt"),
            patch("dropbox_browser.video.subprocess.IDLE_PRIORITY_CLASS", 64, create=True),
            patch("dropbox_browser.video.subprocess.Popen", side_effect=fake_popen),
        ):
            server.post_json("/video/endpoints/session", {
                "path": "movie.mp4",
                "source": "remote",
            })

        self.assertEqual(popen_kwargs, [{"creationflags": 64}])

    def test_ffmpeg_popen_kwargs_for_priority_keeps_non_windows_and_normal_unchanged(self) -> None:
        with patch("dropbox_browser.video.os.name", "posix"):
            self.assertEqual(ffmpeg_popen_kwargs_for_priority("below_normal"), {})

        with patch("dropbox_browser.video.os.name", "nt"):
            self.assertEqual(ffmpeg_popen_kwargs_for_priority("normal"), {})

    def test_ffmpeg_popen_kwargs_for_priority_maps_windows_priority_flags(self) -> None:
        with (
            patch("dropbox_browser.video.os.name", "nt"),
            patch("dropbox_browser.video.subprocess.BELOW_NORMAL_PRIORITY_CLASS", 16384, create=True),
            patch("dropbox_browser.video.subprocess.IDLE_PRIORITY_CLASS", 64, create=True),
        ):
            self.assertEqual(ffmpeg_popen_kwargs_for_priority("below-normal"), {"creationflags": 16384})
            self.assertEqual(ffmpeg_popen_kwargs_for_priority("idle"), {"creationflags": 64})
            self.assertEqual(ffmpeg_popen_kwargs_for_priority("bad"), {})

    def test_session_endpoint_passes_selected_bitmap_subtitle_stream_index_to_ffmpeg(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            ),
        )
        spawned: list[FakeFfmpegProcess] = []

        def fake_popen(command, stdout=None, stderr=None, cwd=None, **kwargs):
            if not is_ffmpeg_hls_spawn(command):
                return FakeFfmpegProcess(command)
            playlist_path = Path(command[-1])
            write_hls_session_fixture(playlist_path)
            process = FakeFfmpegProcess(command)
            spawned.append(process)
            return process

        with TestServer(app) as server, patch("dropbox_browser.video.subprocess.Popen", side_effect=fake_popen):
            payload = server.post_json("/video/endpoints/session", {
                "path": "movie.mp4",
                "source": "remote",
                "subtitle_stream_index": "4",
            })

        self.assertIsNone(payload["audio_stream_index"])
        self.assertEqual(payload["subtitle_stream_index"], 4)
        self.assertIn("-filter_complex", spawned[0].command)
        self.assertIn("[0:v:0][0:4]overlay[vout]", spawned[0].command)
        self.assertIn("[vout]", spawned[0].command)

    def test_session_endpoint_rejects_negative_start_time(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            ),
        )

        with TestServer(app) as server:
            with self.assertRaises(HTTPError) as ctx:
                server.post_json("/video/endpoints/session", {
                    "path": "movie.mp4",
                    "source": "remote",
                    "start_time_seconds": "-1",
                })

        self.assertEqual(ctx.exception.code, 400)
        ctx.exception.close()

    def test_playlist_ready_for_playback_requires_minimum_segment_count(self) -> None:
        session_dir = self.temp_dir / "playlist_ready"
        session_dir.mkdir(parents=True, exist_ok=True)
        playlist_path = session_dir / "stream.m3u8"
        write_hls_session_fixture(playlist_path, include_segments=False)
        session = VideoHlsSession(
            session_id="test",
            rel_path="movie.mp4",
            session_dir=session_dir,
            playlist_path=playlist_path,
            process=FakeFfmpegProcess([]),
            command=[],
            created_at=time.time(),
            create_started_at=time.monotonic(),
            last_accessed_at=time.time(),
            audio_stream_index=None,
            subtitle_stream_index=None,
            start_time_seconds=0.0,
            video_mode="video_transcode",
            video_mode_reason="test_fixture",
            audio_mode="audio_transcode",
            audio_mode_reason="test_fixture",
        )

        self.assertFalse(_playlist_ready_for_playback(session))
        (session_dir / "segment_00000.m4s").write_bytes(b"segment0")
        self.assertTrue(_playlist_ready_for_playback(session))
        write_hls_session_fixture(playlist_path, segment_count=2)
        self.assertEqual(
            _playlist_segment_names(playlist_path),
            ["segment_00000.m4s", "segment_00001.m4s"],
        )

    def test_build_ffmpeg_hls_command_maps_selected_audio_stream_by_absolute_index(self) -> None:
        command = build_ffmpeg_hls_command(
            Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
            "http://127.0.0.1:8000/file?path=movie.mkv&source=remote",
            Path("E:/dev/dropbox_browser/Temp/video_sessions/test/stream.m3u8"),
            segment_base_url="/video/endpoints/session/file?id=test&name=",
            audio_stream_index=5,
            start_time_seconds=366.25,
        )

        self.assertLess(command.index("-ss"), command.index("-i"))
        self.assertEqual(command[command.index("-ss") + 1], "366.25")
        self.assertIn("0:v:0", command)
        self.assertIn("0:5?", command)
        self.assertNotIn("0:a:5?", command)
        self.assertIn("/video/endpoints/session/file?id=test&name=", command)
        self.assertIn("expr:gte(t,n_forced*6)", command)
        self.assertIn("independent_segments+temp_file", command)
        self.assertIn("-hls_segment_type", command)
        self.assertIn("fmp4", command)
        self.assertIn("-hls_fmp4_init_filename", command)
        self.assertIn("init.mp4", command)
        self.assertIn("segment_%05d.m4s", command)

    def test_build_ffmpeg_hls_command_adds_input_pacing_flags_before_input(self) -> None:
        command = build_ffmpeg_hls_command(
            Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
            "http://127.0.0.1:8000/file?path=movie.mkv&source=remote",
            Path("E:/dev/dropbox_browser/Temp/video_sessions/test/stream.m3u8"),
            segment_base_url="/video/endpoints/session/file?id=test&name=",
            read_rate=1.2,
            read_rate_initial_burst_seconds=15.0,
            read_rate_catchup=2.5,
        )

        self.assertLess(command.index("-readrate"), command.index("-i"))
        self.assertLess(command.index("-readrate_initial_burst"), command.index("-i"))
        self.assertLess(command.index("-readrate_catchup"), command.index("-i"))
        self.assertEqual(command[command.index("-readrate") + 1], "1.2")
        self.assertEqual(command[command.index("-readrate_initial_burst") + 1], "15")
        self.assertEqual(command[command.index("-readrate_catchup") + 1], "2.5")

    def test_build_ffmpeg_hls_command_omits_input_pacing_flags_when_disabled(self) -> None:
        command = build_ffmpeg_hls_command(
            Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
            "http://127.0.0.1:8000/file?path=movie.mkv&source=remote",
            Path("E:/dev/dropbox_browser/Temp/video_sessions/test/stream.m3u8"),
            segment_base_url="/video/endpoints/session/file?id=test&name=",
            read_rate=0.0,
            read_rate_initial_burst_seconds=10.0,
            read_rate_catchup=3.0,
        )

        self.assertNotIn("-readrate", command)
        self.assertNotIn("-readrate_initial_burst", command)
        self.assertNotIn("-readrate_catchup", command)

    def test_build_ffmpeg_hls_command_adds_thread_flags_when_configured(self) -> None:
        command = build_ffmpeg_hls_command(
            Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
            "http://127.0.0.1:8000/file?path=movie.mkv&source=remote",
            Path("E:/dev/dropbox_browser/Temp/video_sessions/test/stream.m3u8"),
            segment_base_url="/video/endpoints/session/file?id=test&name=",
            subtitle_stream_index=4,
            threads=3,
            filter_threads=2,
        )

        self.assertIn("-threads", command)
        self.assertEqual(command[command.index("-threads") + 1], "3")
        self.assertLess(command.index("-threads"), command.index("-c:v"))
        self.assertIn("-filter_threads", command)
        self.assertEqual(command[command.index("-filter_threads") + 1], "2")
        self.assertIn("-filter_complex_threads", command)
        self.assertEqual(command[command.index("-filter_complex_threads") + 1], "2")
        self.assertLess(command.index("-filter_threads"), command.index("-filter_complex"))
        self.assertLess(command.index("-filter_complex_threads"), command.index("-filter_complex"))

    def test_build_ffmpeg_hls_command_omits_thread_flags_when_disabled(self) -> None:
        command = build_ffmpeg_hls_command(
            Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
            "http://127.0.0.1:8000/file?path=movie.mkv&source=remote",
            Path("E:/dev/dropbox_browser/Temp/video_sessions/test/stream.m3u8"),
            segment_base_url="/video/endpoints/session/file?id=test&name=",
            threads=0,
            filter_threads=0,
        )

        self.assertNotIn("-threads", command)
        self.assertNotIn("-filter_threads", command)
        self.assertNotIn("-filter_complex_threads", command)

    def test_build_ffmpeg_hls_command_uses_video_copy_when_requested(self) -> None:
        command = build_ffmpeg_hls_command(
            Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
            "http://127.0.0.1:8000/file?path=movie.mkv&source=remote",
            Path("E:/dev/dropbox_browser/Temp/video_sessions/test/stream.m3u8"),
            segment_base_url="/video/endpoints/session/file?id=test&name=",
            copy_video=True,
        )

        self.assertEqual(command[command.index("-c:v") + 1], "copy")
        self.assertNotIn("-force_key_frames", command)
        self.assertNotIn("-pix_fmt", command)
        self.assertNotIn("libx264", command)

    def test_build_ffmpeg_hls_command_uses_audio_copy_when_requested(self) -> None:
        command = build_ffmpeg_hls_command(
            Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
            "http://127.0.0.1:8000/file?path=movie.mkv&source=remote",
            Path("E:/dev/dropbox_browser/Temp/video_sessions/test/stream.m3u8"),
            segment_base_url="/video/endpoints/session/file?id=test&name=",
            copy_audio=True,
        )

        self.assertEqual(command[command.index("-c:a") + 1], "copy")
        self.assertNotIn("-ac", command)
        self.assertNotIn("-ar", command)
        self.assertNotIn("aac", [value for value in command if value == "aac"])

    def test_build_ffmpeg_hls_command_burns_in_selected_bitmap_subtitle_stream(self) -> None:
        command = build_ffmpeg_hls_command(
            Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
            "http://127.0.0.1:8000/file?path=movie.mkv&source=remote",
            Path("E:/dev/dropbox_browser/Temp/video_sessions/test/stream.m3u8"),
            segment_base_url="/video/endpoints/session/file?id=test&name=",
            audio_stream_index=5,
            subtitle_stream_index=4,
            start_time_seconds=12.5,
            copy_video=True,
        )

        self.assertLess(command.index("-ss"), command.index("-i"))
        self.assertIn("-filter_complex", command)
        self.assertIn("[0:v:0][0:4]overlay[vout]", command)
        self.assertIn("[vout]", command)
        self.assertNotIn("0:v:0", [item for item in command if item == "0:v:0"])
        self.assertIn("0:5?", command)
        self.assertIn("-sn", command)
        self.assertEqual(command[command.index("-c:v") + 1], "libx264")

    def test_subtitle_window_end_seconds_adds_start_and_duration(self) -> None:
        self.assertEqual(subtitle_window_end_seconds(12.5, 30.0), 42.5)

    def test_clamp_subtitle_window_limits_end_to_media_duration(self) -> None:
        self.assertEqual(
            clamp_subtitle_window(290.0, 30.0, media_duration_seconds=300.0),
            {
                "window_start_seconds": 290.0,
                "window_duration_seconds": 10.0,
                "window_end_seconds": 300.0,
            },
        )

    def test_build_subtitle_window_request_normalizes_path_and_shape(self) -> None:
        payload = build_subtitle_window_request(
            rel_path="Videos//movie.mkv",
            subtitle_stream_index=4,
            file_size=123,
            window_start_seconds=25.0,
            window_duration_seconds=SUBTITLE_WINDOW_DURATION_SECONDS,
            window_status="startup",
            media_duration_seconds=250.0,
        )

        self.assertEqual(payload, {
            "path": "Videos/movie.mkv",
            "track": 4,
            "file_size": 123,
            "window_start_seconds": 25.0,
            "window_duration_seconds": 225.0,
            "window_end_seconds": 250.0,
            "window_status": "startup",
        })

    def test_build_startup_subtitle_window_request_uses_initial_policy(self) -> None:
        payload = build_startup_subtitle_window_request(
            rel_path="movie.mkv",
            subtitle_stream_index=3,
            file_size=999,
            media_duration_seconds=120.0,
        )

        self.assertEqual(payload, {
            "path": "movie.mkv",
            "track": 3,
            "file_size": 999,
            "window_start_seconds": 0.0,
            "window_duration_seconds": 120.0,
            "window_end_seconds": 120.0,
            "window_status": "startup",
        })

    def test_build_seek_subtitle_window_request_uses_lead_lag_policy(self) -> None:
        payload = build_seek_subtitle_window_request(
            rel_path="movie.mkv",
            subtitle_stream_index=7,
            file_size=500,
            seek_target_seconds=200.0,
            media_duration_seconds=1000.0,
        )

        self.assertEqual(payload["window_start_seconds"], 200.0 - SUBTITLE_WINDOW_SEEK_LEAD_SECONDS)
        self.assertEqual(payload["window_duration_seconds"], SUBTITLE_WINDOW_DURATION_SECONDS)
        self.assertEqual(payload["window_end_seconds"], 200.0 + SUBTITLE_WINDOW_SEEK_LAG_SECONDS)
        self.assertEqual(payload["window_status"], "seek")

    def test_build_seek_subtitle_window_request_clamps_near_media_end(self) -> None:
        payload = build_seek_subtitle_window_request(
            rel_path="movie.mkv",
            subtitle_stream_index=7,
            file_size=500,
            seek_target_seconds=995.0,
            media_duration_seconds=1000.0,
        )

        self.assertEqual(payload["window_start_seconds"], 995.0 - SUBTITLE_WINDOW_SEEK_LEAD_SECONDS)
        self.assertEqual(payload["window_end_seconds"], 1000.0)
        self.assertEqual(payload["window_duration_seconds"], 20.0)

    def test_build_subtitle_window_response_includes_loaded_ranges_and_gap_action(self) -> None:
        payload = build_subtitle_window_response(
            track=4,
            window_start_seconds=15.0,
            window_duration_seconds=SUBTITLE_WINDOW_DURATION_SECONDS,
            coverage_complete=False,
            loaded_ranges=[
                {"start_seconds": 15.0, "end_seconds": 315.0},
                {"start_seconds": 314.0, "end_seconds": 400.0},
            ],
            vtt="WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n",
            window_status="ready",
            media_duration_seconds=350.0,
        )

        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["track"], 4)
        self.assertEqual(payload["window_status"], "ready")
        self.assertEqual(payload["window_start_seconds"], 15.0)
        self.assertEqual(payload["window_end_seconds"], 315.0)
        self.assertFalse(payload["coverage_complete"])
        self.assertEqual(payload["loaded_ranges"], [
            {"start_seconds": 15.0, "end_seconds": 315.0},
            {"start_seconds": 314.0, "end_seconds": 350.0},
        ])
        self.assertEqual(payload["gap_action"], SUBTITLE_WINDOW_GAP_ACTION)
        self.assertIn("WEBVTT", payload["vtt"])
        self.assertEqual(SUBTITLE_WINDOW_OVERLAP_SECONDS, 1.0)

    def test_expand_subtitle_window_for_extraction_adds_overlap_and_clamps_to_media(self) -> None:
        self.assertEqual(
            expand_subtitle_window_for_extraction(4.0, 4.0, media_duration_seconds=15.0),
            {
                "window_start_seconds": 3.0,
                "window_duration_seconds": 6.0,
                "window_end_seconds": 9.0,
            },
        )
        self.assertEqual(
            expand_subtitle_window_for_extraction(0.0, 4.0, media_duration_seconds=4.5),
            {
                "window_start_seconds": 0.0,
                "window_duration_seconds": 4.5,
                "window_end_seconds": 4.5,
            },
        )

    def test_parse_subtitle_window_duration_seconds_defaults_and_rejects_non_positive_values(self) -> None:
        self.assertEqual(parse_subtitle_window_duration_seconds(""), SUBTITLE_WINDOW_DURATION_SECONDS)
        self.assertEqual(parse_subtitle_window_duration_seconds("12.5"), 12.5)
        with self.assertRaisesRegex(Exception, "greater than zero"):
            parse_subtitle_window_duration_seconds("0")

    def test_slice_webvtt_text_to_window_keeps_only_overlapping_cues(self) -> None:
        body = (
            "WEBVTT\n\n"
            "00:00.000 --> 00:02.000\n"
            "Before\n\n"
            "1\n"
            "00:09.500 --> 00:11.000\n"
            "Overlap start\n\n"
            "00:12.000 --> 00:13.000\n"
            "Inside\n\n"
            "00:20.000 --> 00:21.000\n"
            "After\n"
        )

        sliced = slice_webvtt_text_to_window(
            body,
            window_start_seconds=10.0,
            window_end_seconds=15.0,
        )

        self.assertIn("WEBVTT", sliced)
        self.assertIn("Overlap start", sliced)
        self.assertIn("Inside", sliced)
        self.assertNotIn("Before", sliced)
        self.assertNotIn("After", sliced)

    def test_offset_webvtt_text_shifts_relative_window_forward(self) -> None:
        body = (
            "WEBVTT\n\n"
            "00:00.500 --> 00:02.000\n"
            "Hello\n"
        )

        shifted = offset_webvtt_text(body, 120.0)

        self.assertIn("02:00.500 --> 02:02.000", shifted)

    def test_extracted_webvtt_needs_absolute_offset_detects_relative_window_output(self) -> None:
        self.assertTrue(
            extracted_webvtt_needs_absolute_offset(
                "WEBVTT\n\n00:00.500 --> 00:02.000\nHello\n",
                start_time_seconds=120.0,
                window_duration_seconds=10.0,
            )
        )
        self.assertFalse(
            extracted_webvtt_needs_absolute_offset(
                "WEBVTT\n\n02:00.500 --> 02:02.000\nHello\n",
                start_time_seconds=120.0,
                window_duration_seconds=10.0,
            )
        )

    def test_build_subtitle_cache_key_changes_for_window_requests(self) -> None:
        full_key = build_subtitle_cache_key(
            rel_path="movie.mp4",
            subtitle_stream_index=3,
            file_size=10,
        )
        window_key = build_subtitle_cache_key(
            rel_path="movie.mp4",
            subtitle_stream_index=3,
            file_size=10,
            window_start_seconds=0.0,
            window_duration_seconds=300.0,
        )
        other_window_key = build_subtitle_cache_key(
            rel_path="movie.mp4",
            subtitle_stream_index=3,
            file_size=10,
            window_start_seconds=300.0,
            window_duration_seconds=300.0,
        )

        self.assertNotEqual(full_key, window_key)
        self.assertNotEqual(window_key, other_window_key)

    def test_merge_subtitle_coverage_ranges_combines_adjacent_windows(self) -> None:
        merged = merge_subtitle_coverage_ranges([
            {"start_seconds": 0.0, "end_seconds": 300.0},
            {"start_seconds": 300.5, "end_seconds": 600.0},
            {"start_seconds": 700.0, "end_seconds": 750.0},
        ])

        self.assertEqual(merged, [
            {"start_seconds": 0.0, "end_seconds": 600.0},
            {"start_seconds": 700.0, "end_seconds": 750.0},
        ])

    def test_subtitle_window_is_covered_uses_merged_ranges(self) -> None:
        coverage_ranges = [
            {"start_seconds": 0.0, "end_seconds": 300.0},
            {"start_seconds": 300.5, "end_seconds": 600.0},
        ]

        self.assertTrue(
            subtitle_window_is_covered(
                coverage_ranges,
                window_start_seconds=10.0,
                window_end_seconds=590.0,
            )
        )
        self.assertFalse(
            subtitle_window_is_covered(
                coverage_ranges,
                window_start_seconds=10.0,
                window_end_seconds=650.0,
            )
        )

    def test_store_subtitle_window_cache_entry_persists_manifest(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(rclone, local_root=None)
        cache_dir = self.temp_dir / "subtitle_cache"

        cache_key, manifest = store_subtitle_window_cache_entry(
            app,
            rel_path="movie.mp4",
            subtitle_stream_index=3,
            file_size=10,
            window_start_seconds=0.0,
            window_duration_seconds=300.0,
            body=b"WEBVTT\n\n",
            cache_dir=cache_dir,
        )

        manifest_key = build_subtitle_window_manifest_key(
            rel_path="movie.mp4",
            subtitle_stream_index=3,
            file_size=10,
        )
        cache_path = subtitle_cache_path(cache_key, cache_dir=cache_dir)
        manifest_path = subtitle_cache_path(manifest_key, cache_dir=cache_dir).with_suffix(".json")
        loaded_manifest = read_subtitle_window_manifest(
            app,
            rel_path="movie.mp4",
            subtitle_stream_index=3,
            file_size=10,
            cache_dir=cache_dir,
        )

        self.assertTrue(cache_path.exists())
        self.assertTrue(manifest_path.exists())
        self.assertEqual(manifest["coverage_ranges"], [{"start_seconds": 0.0, "end_seconds": 300.0}])
        self.assertEqual(loaded_manifest["coverage_ranges"], [{"start_seconds": 0.0, "end_seconds": 300.0}])
        self.assertEqual(len(loaded_manifest["windows"]), 1)

    def test_subtitles_window_endpoint_rejects_invalid_duration(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(rclone, local_root=None)

        with TestServer(app) as server:
            with self.assertRaises(HTTPError) as ctx:
                urlopen(
                    server.base_url
                    + "/video/endpoints/subtitles/window?path=movie.mp4&source=remote&track=3&start=0&duration=0",
                    timeout=5,
                )

        self.assertEqual(ctx.exception.code, 400)
        ctx.exception.close()

    def test_extract_remote_subtitle_window_to_webvtt_slices_full_track_to_requested_window(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            ),
        )
        ffprobe_payload = {
            "streams": [
                {"index": 0, "codec_type": "video", "codec_name": "h264"},
                {
                    "index": 3,
                    "codec_type": "subtitle",
                    "codec_name": "ass",
                    "tags": {"language": "eng", "title": "English"},
                    "disposition": {"default": 1, "forced": 0},
                },
            ],
            "format": {"duration": "15.0"},
        }
        ffmpeg_copy_commands: list[list[str]] = []

        def fake_subprocess(command, stdout=None, stderr=None, check=False, timeout=None):
            if "ffprobe" in command[0]:
                return CompletedProcess(command, 0, json.dumps(ffprobe_payload).encode("utf-8"), b"")
            if "-c:s" in command and "copy" in command:
                ffmpeg_copy_commands.append(list(command))
                output_path = Path(command[-1])
                output_path.write_text(
                    "WEBVTT\n\n"
                    "00:00.500 --> 00:01.500\nEdge overlap\n\n"
                    "00:01.500 --> 00:03.000\nInside one\n\n"
                    "00:03.000 --> 00:04.000\nInside two\n",
                    encoding="utf-8",
                )
                return CompletedProcess(command, 0, b"", b"")
            if command and command[-1] == "-":
                input_path = Path(command[command.index("-i") + 1])
                return CompletedProcess(command, 0, input_path.read_bytes(), b"")
            return CompletedProcess(command, 0, b"", b"")

        with patch("dropbox_browser.video.subprocess.run", side_effect=fake_subprocess):
            payload = extract_remote_subtitle_window_to_webvtt(
                app,
                rel_path="movie.mp4",
                subtitle_stream_index=3,
                base_url="http://127.0.0.1:8000",
                file_size=10,
                window_start_seconds=4.0,
                window_duration_seconds=4.0,
            )

        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["track"], 3)
        self.assertEqual(payload["window_start_seconds"], 4.0)
        self.assertEqual(payload["window_end_seconds"], 8.0)
        self.assertTrue(payload["coverage_complete"])
        self.assertEqual(payload["loaded_ranges"], [{"start_seconds": 4.0, "end_seconds": 8.0}])
        self.assertEqual(payload["language"], "eng")
        self.assertFalse(payload["cache_hit"])
        self.assertEqual(len(ffmpeg_copy_commands), 1)
        self.assertIn("-ss", ffmpeg_copy_commands[0])
        self.assertEqual(ffmpeg_copy_commands[0][ffmpeg_copy_commands[0].index("-ss") + 1], "3")
        self.assertIn("-t", ffmpeg_copy_commands[0])
        self.assertEqual(ffmpeg_copy_commands[0][ffmpeg_copy_commands[0].index("-t") + 1], "6")
        self.assertIn("Edge overlap", payload["vtt"])
        self.assertIn("Inside one", payload["vtt"])
        self.assertIn("Inside two", payload["vtt"])
        self.assertIn("00:03.500 --> 00:04.500", payload["vtt"])
        self.assertIn("00:04.500 --> 00:06.000", payload["vtt"])
        self.assertIn("00:06.000 --> 00:07.000", payload["vtt"])

    def test_subtitles_window_endpoint_returns_clamped_json_window_payload(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            ),
        )
        ffprobe_payload = {
            "streams": [
                {"index": 0, "codec_type": "video", "codec_name": "h264"},
                {
                    "index": 3,
                    "codec_type": "subtitle",
                    "codec_name": "ass",
                    "tags": {"language": "eng", "title": "English"},
                    "disposition": {"default": 1, "forced": 0},
                },
            ],
            "format": {"duration": "15.0"},
        }

        def fake_subprocess(command, stdout=None, stderr=None, check=False, timeout=None):
            if "ffprobe" in command[0]:
                return CompletedProcess(command, 0, json.dumps(ffprobe_payload).encode("utf-8"), b"")
            if "-c:s" in command and "copy" in command:
                output_path = Path(command[-1])
                output_path.write_text(
                    "WEBVTT\n\n"
                    "00:01.000 --> 00:02.000\nBefore\n\n"
                    "00:13.000 --> 00:14.500\nNear end\n\n"
                    "00:14.800 --> 00:15.000\nLast cue\n",
                    encoding="utf-8",
                )
                return CompletedProcess(command, 0, b"", b"")
            if command and command[-1] == "-":
                input_path = Path(command[command.index("-i") + 1])
                return CompletedProcess(command, 0, input_path.read_bytes(), b"")
            return CompletedProcess(command, 0, b"", b"")

        with (
            TestServer(app) as server,
            patch("dropbox_browser.video.subprocess.run", side_effect=fake_subprocess),
        ):
            with urlopen(
                server.base_url
                + "/video/endpoints/subtitles/window?path=movie.mp4&source=remote&track=3&start=13&duration=10",
                timeout=5,
            ) as response:
                payload = json.loads(response.read().decode("utf-8"))
                content_type = response.headers["Content-Type"]

        self.assertEqual(content_type, "application/json; charset=utf-8")
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["track"], 3)
        self.assertEqual(payload["window_start_seconds"], 13.0)
        self.assertEqual(payload["window_end_seconds"], 15.0)
        self.assertEqual(payload["loaded_ranges"], [{"start_seconds": 13.0, "end_seconds": 15.0}])
        self.assertTrue(payload["coverage_complete"])
        self.assertEqual(payload["gap_action"], SUBTITLE_WINDOW_GAP_ACTION)
        self.assertFalse(payload["cache_hit"])
        self.assertIn("Near end", payload["vtt"])
        self.assertIn("Last cue", payload["vtt"])
        self.assertNotIn("Before", payload["vtt"])

    def test_subtitles_window_endpoint_uses_window_cache_on_repeat_request(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            ),
        )
        ffprobe_payload = {
            "streams": [
                {"index": 0, "codec_type": "video", "codec_name": "h264"},
                {
                    "index": 3,
                    "codec_type": "subtitle",
                    "codec_name": "ass",
                    "tags": {"language": "eng", "title": "English"},
                    "disposition": {"default": 1, "forced": 0},
                },
            ],
            "format": {"duration": "15.0"},
        }

        def fake_subprocess(command, stdout=None, stderr=None, check=False, timeout=None):
            if "ffprobe" in command[0]:
                return CompletedProcess(command, 0, json.dumps(ffprobe_payload).encode("utf-8"), b"")
            if "-c:s" in command and "copy" in command:
                output_path = Path(command[-1])
                output_path.write_text(
                    "WEBVTT\n\n"
                    "00:04.500 --> 00:06.000\nInside one\n\n"
                    "00:07.000 --> 00:08.000\nInside two\n",
                    encoding="utf-8",
                )
                return CompletedProcess(command, 0, b"", b"")
            if command and command[-1] == "-":
                input_path = Path(command[command.index("-i") + 1])
                return CompletedProcess(command, 0, input_path.read_bytes(), b"")
            return CompletedProcess(command, 0, b"", b"")

        with (
            TestServer(app) as server,
            patch("dropbox_browser.video.subprocess.run", side_effect=fake_subprocess) as run_mock,
            patch("dropbox_browser.video.SUBTITLE_CACHE_DIR", self.temp_dir / "subtitle_cache"),
        ):
            url = server.base_url + "/video/endpoints/subtitles/window?path=movie.mp4&source=remote&track=3&start=4&duration=4"
            with urlopen(url, timeout=5) as response:
                first_payload = json.loads(response.read().decode("utf-8"))
            with urlopen(url, timeout=5) as response:
                second_payload = json.loads(response.read().decode("utf-8"))

        self.assertFalse(first_payload["cache_hit"])
        self.assertTrue(second_payload["cache_hit"])
        self.assertEqual(first_payload["loaded_ranges"], [{"start_seconds": 4.0, "end_seconds": 8.0}])
        self.assertEqual(second_payload["loaded_ranges"], [{"start_seconds": 4.0, "end_seconds": 8.0}])
        self.assertEqual(run_mock.call_count, 3)

    def test_subtitle_window_extraction_keeps_startup_to_first_window_and_requests_later_window_independently(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            ),
        )
        ffprobe_payload = {
            "streams": [
                {"index": 0, "codec_type": "video", "codec_name": "h264"},
                {
                    "index": 3,
                    "codec_type": "subtitle",
                    "codec_name": "ass",
                    "tags": {"language": "eng", "title": "English"},
                    "disposition": {"default": 1, "forced": 0},
                },
            ],
            "format": {"duration": "900.0"},
        }
        ffmpeg_copy_commands: list[list[str]] = []

        def fake_subprocess(command, stdout=None, stderr=None, check=False, timeout=None):
            if "ffprobe" in command[0]:
                return CompletedProcess(command, 0, json.dumps(ffprobe_payload).encode("utf-8"), b"")
            if "-c:s" in command and "copy" in command:
                ffmpeg_copy_commands.append(list(command))
                start_seconds = float(command[command.index("-ss") + 1]) if "-ss" in command else 0.0
                output_path = Path(command[-1])
                if start_seconds < 1.0:
                    output_path.write_text(
                        "WEBVTT\n\n"
                        "00:00.500 --> 00:01.500\nStartup overlap\n\n"
                        "04:59.000 --> 05:00.000\nStartup tail\n\n"
                        "05:01.000 --> 05:02.000\nShould be trimmed\n",
                        encoding="utf-8",
                    )
                else:
                    output_path.write_text(
                        "WEBVTT\n\n"
                        "00:00.500 --> 00:01.500\nLater overlap\n\n"
                        "00:02.000 --> 00:03.000\nLater inside\n\n",
                        encoding="utf-8",
                    )
                return CompletedProcess(command, 0, b"", b"")
            if command and command[-1] == "-":
                input_path = Path(command[command.index("-i") + 1])
                return CompletedProcess(command, 0, input_path.read_bytes(), b"")
            return CompletedProcess(command, 0, b"", b"")

        with (
            patch("dropbox_browser.video.subprocess.run", side_effect=fake_subprocess),
            patch("dropbox_browser.video.SUBTITLE_CACHE_DIR", self.temp_dir / "subtitle_cache"),
        ):
            startup_request = build_startup_subtitle_window_request(
                rel_path="movie.mp4",
                subtitle_stream_index=3,
                file_size=10,
                media_duration_seconds=900.0,
            )
            startup_payload = extract_remote_subtitle_window_to_webvtt(
                app,
                rel_path="movie.mp4",
                subtitle_stream_index=3,
                base_url="http://127.0.0.1:8000",
                file_size=10,
                window_start_seconds=float(startup_request["window_start_seconds"]),
                window_duration_seconds=float(startup_request["window_duration_seconds"]),
            )
            later_payload = extract_remote_subtitle_window_to_webvtt(
                app,
                rel_path="movie.mp4",
                subtitle_stream_index=3,
                base_url="http://127.0.0.1:8000",
                file_size=10,
                window_start_seconds=300.0,
                window_duration_seconds=300.0,
            )

        self.assertEqual(len(ffmpeg_copy_commands), 2)
        self.assertNotIn("-ss", ffmpeg_copy_commands[0])
        self.assertEqual(ffmpeg_copy_commands[0][ffmpeg_copy_commands[0].index("-t") + 1], "301")
        self.assertEqual(ffmpeg_copy_commands[1][ffmpeg_copy_commands[1].index("-ss") + 1], "299")
        self.assertEqual(ffmpeg_copy_commands[1][ffmpeg_copy_commands[1].index("-t") + 1], "302")

        self.assertEqual(startup_payload["window_start_seconds"], 0.0)
        self.assertEqual(startup_payload["window_end_seconds"], 300.0)
        self.assertEqual(startup_payload["loaded_ranges"], [{"start_seconds": 0.0, "end_seconds": 300.0}])
        self.assertIn("Startup overlap", startup_payload["vtt"])
        self.assertIn("Startup tail", startup_payload["vtt"])
        self.assertNotIn("Should be trimmed", startup_payload["vtt"])

        self.assertEqual(later_payload["window_start_seconds"], 300.0)
        self.assertEqual(later_payload["window_end_seconds"], 600.0)
        self.assertEqual(later_payload["loaded_ranges"], [{"start_seconds": 0.0, "end_seconds": 600.0}])
        self.assertIn("Later overlap", later_payload["vtt"])
        self.assertIn("Later inside", later_payload["vtt"])

    def test_subtitle_window_extraction_dedupes_duplicate_inflight_requests(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            ),
        )
        ffprobe_payload = {
            "streams": [
                {"index": 0, "codec_type": "video", "codec_name": "h264"},
                {
                    "index": 3,
                    "codec_type": "subtitle",
                    "codec_name": "ass",
                    "tags": {"language": "eng", "title": "English"},
                    "disposition": {"default": 1, "forced": 0},
                },
            ],
            "format": {"duration": "900.0"},
        }
        started = threading.Event()
        release = threading.Event()
        ffmpeg_copy_call_count = 0
        ffmpeg_copy_call_guard = threading.Lock()
        results: list[object] = [None, None]

        def fake_subprocess(command, stdout=None, stderr=None, check=False, timeout=None):
            nonlocal ffmpeg_copy_call_count
            if "ffprobe" in command[0]:
                return CompletedProcess(command, 0, json.dumps(ffprobe_payload).encode("utf-8"), b"")
            if "-c:s" in command and "copy" in command:
                with ffmpeg_copy_call_guard:
                    ffmpeg_copy_call_count += 1
                started.set()
                release.wait(5)
                output_path = Path(command[-1])
                output_path.write_text(
                    "WEBVTT\n\n"
                    "00:00.500 --> 00:01.500\nOverlap\n\n"
                    "00:02.000 --> 00:03.000\nInside\n",
                    encoding="utf-8",
                )
                return CompletedProcess(command, 0, b"", b"")
            if command and command[-1] == "-":
                input_path = Path(command[command.index("-i") + 1])
                return CompletedProcess(command, 0, input_path.read_bytes(), b"")
            return CompletedProcess(command, 0, b"", b"")

        def run_request(index: int) -> None:
            results[index] = extract_remote_subtitle_window_to_webvtt(
                app,
                rel_path="movie.mp4",
                subtitle_stream_index=3,
                base_url="http://127.0.0.1:8000",
                file_size=10,
                window_start_seconds=4.0,
                window_duration_seconds=4.0,
            )

        with (
            patch("dropbox_browser.video.subprocess.run", side_effect=fake_subprocess),
            patch("dropbox_browser.video.SUBTITLE_CACHE_DIR", self.temp_dir / "subtitle_cache"),
        ):
            first = threading.Thread(target=run_request, args=(0,))
            second = threading.Thread(target=run_request, args=(1,))
            first.start()
            self.assertTrue(started.wait(1))
            second.start()
            release.set()
            first.join(timeout=5)
            second.join(timeout=5)

        self.assertEqual(ffmpeg_copy_call_count, 1)
        self.assertIsInstance(results[0], dict)
        self.assertIsInstance(results[1], dict)
        self.assertFalse(results[0]["cache_hit"])
        self.assertTrue(results[1]["cache_hit"])
        self.assertEqual(results[0]["vtt"], results[1]["vtt"])
        self.assertEqual(results[0]["loaded_ranges"], [{"start_seconds": 4.0, "end_seconds": 8.0}])
        self.assertEqual(results[1]["loaded_ranges"], [{"start_seconds": 4.0, "end_seconds": 8.0}])

    def test_startup_subtitle_window_request_triggers_background_backfill_for_future_windows(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            ),
        )
        ffprobe_payload = {
            "streams": [
                {"index": 0, "codec_type": "video", "codec_name": "h264"},
                {
                    "index": 3,
                    "codec_type": "subtitle",
                    "codec_name": "ass",
                    "tags": {"language": "eng", "title": "English"},
                    "disposition": {"default": 1, "forced": 0},
                },
            ],
            "format": {"duration": "600.0"},
        }
        ffmpeg_copy_commands: list[list[str]] = []

        def fake_subprocess(command, stdout=None, stderr=None, check=False, timeout=None):
            if "ffprobe" in command[0]:
                return CompletedProcess(command, 0, json.dumps(ffprobe_payload).encode("utf-8"), b"")
            if "-c:s" in command and "copy" in command:
                ffmpeg_copy_commands.append(list(command))
                output_path = Path(command[-1])
                start_seconds = float(command[command.index("-ss") + 1]) if "-ss" in command else 0.0
                if start_seconds < 1.0:
                    output_path.write_text(
                        "WEBVTT\n\n"
                        "00:00.500 --> 00:01.500\nStartup overlap\n\n"
                        "04:59.000 --> 05:00.000\nStartup tail\n",
                        encoding="utf-8",
                    )
                else:
                    output_path.write_text(
                        "WEBVTT\n\n"
                        "00:00.500 --> 00:01.500\nBackfill overlap\n\n"
                        "00:02.000 --> 00:03.000\nBackfill inside\n",
                        encoding="utf-8",
                    )
                return CompletedProcess(command, 0, b"", b"")
            if command and command[-1] == "-":
                input_path = Path(command[command.index("-i") + 1])
                return CompletedProcess(command, 0, input_path.read_bytes(), b"")
            return CompletedProcess(command, 0, b"", b"")

        with patch("dropbox_browser.video.subprocess.run", side_effect=fake_subprocess):
            startup_payload = extract_remote_subtitle_window_to_webvtt(
                app,
                rel_path="movie.mp4",
                subtitle_stream_index=3,
                base_url="http://127.0.0.1:8000",
                file_size=10,
                window_start_seconds=0.0,
                window_duration_seconds=300.0,
                window_status="startup",
            )
            deadline = time.time() + 2.0
            while time.time() < deadline:
                jobs = list(getattr(app, "_subtitle_backfill_jobs", {}).values())
                if jobs:
                    for job in jobs:
                        job.join(timeout=0.1)
                if len(ffmpeg_copy_commands) >= 2 and not getattr(app, "_subtitle_backfill_jobs", {}):
                    break
                time.sleep(0.01)
            later_payload = extract_remote_subtitle_window_to_webvtt(
                app,
                rel_path="movie.mp4",
                subtitle_stream_index=3,
                base_url="http://127.0.0.1:8000",
                file_size=10,
                window_start_seconds=300.0,
                window_duration_seconds=300.0,
            )

        self.assertEqual(startup_payload["window_start_seconds"], 0.0)
        self.assertEqual(startup_payload["window_end_seconds"], 300.0)
        self.assertEqual(startup_payload["loaded_ranges"], [{"start_seconds": 0.0, "end_seconds": 300.0}])
        self.assertEqual(len(ffmpeg_copy_commands), 2)
        self.assertNotIn("-ss", ffmpeg_copy_commands[0])
        self.assertEqual(ffmpeg_copy_commands[0][ffmpeg_copy_commands[0].index("-t") + 1], "301")
        self.assertEqual(ffmpeg_copy_commands[1][ffmpeg_copy_commands[1].index("-ss") + 1], "299")
        self.assertEqual(ffmpeg_copy_commands[1][ffmpeg_copy_commands[1].index("-t") + 1], "301")
        self.assertTrue(later_payload["cache_hit"])

    def test_subtitle_window_request_logs_cache_and_backfill_diagnostics(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            ),
        )
        app.video_debug_logs = True
        ffprobe_payload = {
            "streams": [
                {"index": 0, "codec_type": "video", "codec_name": "h264"},
                {
                    "index": 3,
                    "codec_type": "subtitle",
                    "codec_name": "ass",
                    "tags": {"language": "eng", "title": "English"},
                    "disposition": {"default": 1, "forced": 0},
                },
            ],
            "format": {"duration": "600.0"},
        }

        def fake_subprocess(command, stdout=None, stderr=None, check=False, timeout=None):
            if "ffprobe" in command[0]:
                return CompletedProcess(command, 0, json.dumps(ffprobe_payload).encode("utf-8"), b"")
            if "-c:s" in command and "copy" in command:
                output_path = Path(command[-1])
                start_seconds = float(command[command.index("-ss") + 1]) if "-ss" in command else 0.0
                if start_seconds < 1.0:
                    output_path.write_text(
                        "WEBVTT\n\n"
                        "00:00.500 --> 00:01.500\nStartup overlap\n\n"
                        "04:59.000 --> 05:00.000\nStartup tail\n",
                        encoding="utf-8",
                    )
                else:
                    output_path.write_text(
                        "WEBVTT\n\n"
                        "00:00.500 --> 00:01.500\nBackfill overlap\n\n"
                        "00:02.000 --> 00:03.000\nBackfill inside\n",
                        encoding="utf-8",
                    )
                return CompletedProcess(command, 0, b"", b"")
            if command and command[-1] == "-":
                input_path = Path(command[command.index("-i") + 1])
                return CompletedProcess(command, 0, input_path.read_bytes(), b"")
            return CompletedProcess(command, 0, b"", b"")

        debug_path = self.temp_dir / "video_debug.jsonl"
        with (
            patch("dropbox_browser.video.subprocess.run", side_effect=fake_subprocess),
            patch("dropbox_browser.video.VIDEO_DEBUG_LOG_PATH", debug_path),
        ):
            extract_remote_subtitle_window_to_webvtt(
                app,
                rel_path="movie.mp4",
                subtitle_stream_index=3,
                base_url="http://127.0.0.1:8000",
                file_size=10,
                window_start_seconds=0.0,
                window_duration_seconds=300.0,
                window_status="startup",
                playback_sync_token=7,
            )
            deadline = time.time() + 2.0
            while time.time() < deadline and getattr(app, "_subtitle_backfill_jobs", {}):
                for job in list(getattr(app, "_subtitle_backfill_jobs", {}).values()):
                    job.join(timeout=0.1)
                time.sleep(0.01)
            extract_remote_subtitle_window_to_webvtt(
                app,
                rel_path="movie.mp4",
                subtitle_stream_index=3,
                base_url="http://127.0.0.1:8000",
                file_size=10,
                window_start_seconds=300.0,
                window_duration_seconds=300.0,
                window_status="requested",
                playback_sync_token=7,
            )

        records = [
            json.loads(line)
            for line in debug_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        request_events = [row for row in records if row.get("event") == "subtitle_window_request"]
        self.assertGreaterEqual(len(request_events), 2)
        startup_event = next(row for row in request_events if row.get("window_status") == "startup")
        self.assertFalse(startup_event["cache_hit"])
        self.assertFalse(startup_event["inflight_waited"])
        self.assertTrue(startup_event["background_backfill_scheduled"])
        self.assertEqual(startup_event["request_window_start_seconds"], 0.0)
        self.assertEqual(startup_event["request_window_end_seconds"], 300.0)
        self.assertGreaterEqual(startup_event["loaded_range_count"], 1)
        self.assertIn("extraction_duration_ms", startup_event)
        cached_event = next(row for row in request_events if row.get("window_status") == "requested")
        self.assertTrue(cached_event["cache_hit"])
        self.assertEqual(cached_event["request_window_start_seconds"], 300.0)
        self.assertEqual(cached_event["request_window_end_seconds"], 600.0)
        backfill_events = [row for row in records if row.get("event") == "subtitle_window_backfill_scheduled"]
        self.assertEqual(len(backfill_events), 1)
        self.assertEqual(backfill_events[0]["subtitle_stream_index"], 3)
        self.assertEqual(backfill_events[0]["playback_sync_token"], 7)

    def test_startup_backfill_stops_when_playback_sync_token_changes(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            ),
        )
        ffprobe_payload = {
            "streams": [
                {"index": 0, "codec_type": "video", "codec_name": "h264"},
                {
                    "index": 3,
                    "codec_type": "subtitle",
                    "codec_name": "ass",
                    "tags": {"language": "eng", "title": "English"},
                    "disposition": {"default": 1, "forced": 0},
                },
            ],
            "format": {"duration": "900.0"},
        }
        ffmpeg_copy_commands: list[list[str]] = []
        backfill_started = threading.Event()
        release_backfill = threading.Event()

        def fake_subprocess(command, stdout=None, stderr=None, check=False, timeout=None):
            if "ffprobe" in command[0]:
                return CompletedProcess(command, 0, json.dumps(ffprobe_payload).encode("utf-8"), b"")
            if "-c:s" in command and "copy" in command:
                ffmpeg_copy_commands.append(list(command))
                output_path = Path(command[-1])
                start_seconds = float(command[command.index("-ss") + 1]) if "-ss" in command else 0.0
                if abs(start_seconds - 299.0) < 0.001:
                    backfill_started.set()
                    release_backfill.wait(5)
                output_path.write_text(
                    "WEBVTT\n\n"
                    "00:00.500 --> 00:01.500\nCue\n\n"
                    "00:02.000 --> 00:03.000\nInside\n",
                    encoding="utf-8",
                )
                return CompletedProcess(command, 0, b"", b"")
            if command and command[-1] == "-":
                input_path = Path(command[command.index("-i") + 1])
                return CompletedProcess(command, 0, input_path.read_bytes(), b"")
            return CompletedProcess(command, 0, b"", b"")

        with patch("dropbox_browser.video.subprocess.run", side_effect=fake_subprocess):
            extract_remote_subtitle_window_to_webvtt(
                app,
                rel_path="movie.mp4",
                subtitle_stream_index=3,
                base_url="http://127.0.0.1:8000",
                file_size=10,
                window_start_seconds=0.0,
                window_duration_seconds=300.0,
                window_status="startup",
                playback_sync_token=1,
            )
            self.assertTrue(backfill_started.wait(1))
            extract_remote_subtitle_window_to_webvtt(
                app,
                rel_path="movie.mp4",
                subtitle_stream_index=3,
                base_url="http://127.0.0.1:8000",
                file_size=10,
                window_start_seconds=4.0,
                window_duration_seconds=4.0,
                window_status="requested",
                playback_sync_token=2,
            )
            release_backfill.set()
            deadline = time.time() + 2.0
            while time.time() < deadline and getattr(app, "_subtitle_backfill_jobs", {}):
                for job in list(getattr(app, "_subtitle_backfill_jobs", {}).values()):
                    job.join(timeout=0.1)
                time.sleep(0.01)

        self.assertEqual(len(ffmpeg_copy_commands), 3)
        self.assertEqual(ffmpeg_copy_commands[1][ffmpeg_copy_commands[1].index("-ss") + 1], "299")
        self.assertEqual(ffmpeg_copy_commands[2][ffmpeg_copy_commands[2].index("-ss") + 1], "3")
        self.assertFalse(any("-ss" in command and command[command.index("-ss") + 1] == "599" for command in ffmpeg_copy_commands))

    def test_startup_backfill_stops_when_subtitle_track_changes(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            ),
        )
        ffprobe_payload = {
            "streams": [
                {"index": 0, "codec_type": "video", "codec_name": "h264"},
                {
                    "index": 3,
                    "codec_type": "subtitle",
                    "codec_name": "ass",
                    "tags": {"language": "eng", "title": "English"},
                    "disposition": {"default": 1, "forced": 0},
                },
                {
                    "index": 4,
                    "codec_type": "subtitle",
                    "codec_name": "ass",
                    "tags": {"language": "spa", "title": "Spanish"},
                    "disposition": {"default": 0, "forced": 0},
                },
            ],
            "format": {"duration": "900.0"},
        }
        ffmpeg_copy_commands: list[list[str]] = []
        backfill_started = threading.Event()
        release_backfill = threading.Event()

        def fake_subprocess(command, stdout=None, stderr=None, check=False, timeout=None):
            if "ffprobe" in command[0]:
                return CompletedProcess(command, 0, json.dumps(ffprobe_payload).encode("utf-8"), b"")
            if "-c:s" in command and "copy" in command:
                ffmpeg_copy_commands.append(list(command))
                output_path = Path(command[-1])
                start_seconds = float(command[command.index("-ss") + 1]) if "-ss" in command else 0.0
                mapped_track = command[command.index("-map") + 1]
                if mapped_track == "0:3" and abs(start_seconds - 299.0) < 0.001:
                    backfill_started.set()
                    release_backfill.wait(5)
                output_path.write_text(
                    "WEBVTT\n\n"
                    "00:00.500 --> 00:01.500\nCue\n\n"
                    "00:02.000 --> 00:03.000\nInside\n",
                    encoding="utf-8",
                )
                return CompletedProcess(command, 0, b"", b"")
            if command and command[-1] == "-":
                input_path = Path(command[command.index("-i") + 1])
                return CompletedProcess(command, 0, input_path.read_bytes(), b"")
            return CompletedProcess(command, 0, b"", b"")

        with patch("dropbox_browser.video.subprocess.run", side_effect=fake_subprocess):
            extract_remote_subtitle_window_to_webvtt(
                app,
                rel_path="movie.mp4",
                subtitle_stream_index=3,
                base_url="http://127.0.0.1:8000",
                file_size=10,
                window_start_seconds=0.0,
                window_duration_seconds=300.0,
                window_status="startup",
                playback_sync_token=1,
            )
            self.assertTrue(backfill_started.wait(1))
            extract_remote_subtitle_window_to_webvtt(
                app,
                rel_path="movie.mp4",
                subtitle_stream_index=4,
                base_url="http://127.0.0.1:8000",
                file_size=10,
                window_start_seconds=4.0,
                window_duration_seconds=4.0,
                window_status="requested",
                playback_sync_token=1,
            )
            release_backfill.set()
            deadline = time.time() + 2.0
            while time.time() < deadline and getattr(app, "_subtitle_backfill_jobs", {}):
                for job in list(getattr(app, "_subtitle_backfill_jobs", {}).values()):
                    job.join(timeout=0.1)
                time.sleep(0.01)

        self.assertEqual(len(ffmpeg_copy_commands), 3)
        self.assertEqual(ffmpeg_copy_commands[1][ffmpeg_copy_commands[1].index("-map") + 1], "0:3")
        self.assertEqual(ffmpeg_copy_commands[1][ffmpeg_copy_commands[1].index("-ss") + 1], "299")
        self.assertEqual(ffmpeg_copy_commands[2][ffmpeg_copy_commands[2].index("-map") + 1], "0:4")
        self.assertEqual(ffmpeg_copy_commands[2][ffmpeg_copy_commands[2].index("-ss") + 1], "3")
        self.assertFalse(any(
            command[command.index("-map") + 1] == "0:3"
            and "-ss" in command
            and command[command.index("-ss") + 1] == "599"
            for command in ffmpeg_copy_commands
        ))

    def test_subtitles_endpoint_returns_webvtt_with_content_type(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            ),
        )
        ffprobe_payload = {
            "streams": [
                {"index": 0, "codec_type": "video", "codec_name": "h264"},
                {
                    "index": 3,
                    "codec_type": "subtitle",
                    "codec_name": "ass",
                    "tags": {"language": "eng", "title": "English"},
                    "disposition": {"default": 1, "forced": 0},
                },
            ],
            "format": {"duration": "15.0"},
        }

        with (
            TestServer(app) as server,
            patch(
                "dropbox_browser.video.subprocess.run",
                side_effect=[
                    CompletedProcess(["ffprobe"], 0, json.dumps(ffprobe_payload).encode("utf-8"), b""),
                    CompletedProcess(["ffmpeg"], 0, b"", b""),
                    CompletedProcess(["ffmpeg"], 0, b"WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n", b""),
                ],
            ),
        ):
            with urlopen(server.base_url + "/video/endpoints/subtitles?path=movie.mp4&source=remote&track=3", timeout=5) as response:
                body = response.read().decode("utf-8")
                content_type = response.headers["Content-Type"]
                content_language = response.headers["Content-Language"]

        self.assertIn("WEBVTT", body)
        self.assertEqual(content_type, "text/vtt; charset=utf-8")
        self.assertEqual(content_language, "eng")

    def test_subtitles_endpoint_uses_disk_cache_on_repeat_request(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            ),
        )
        ffprobe_payload = {
            "streams": [
                {"index": 0, "codec_type": "video", "codec_name": "h264"},
                {
                    "index": 3,
                    "codec_type": "subtitle",
                    "codec_name": "ass",
                    "tags": {"language": "eng", "title": "English"},
                    "disposition": {"default": 1, "forced": 0},
                },
            ],
            "format": {"duration": "15.0"},
        }
        vtt_body = b"WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n"
        cache_key = build_subtitle_cache_key(rel_path="movie.mp4", subtitle_stream_index=3, file_size=10)
        cache_path = subtitle_cache_path(cache_key, cache_dir=self.temp_dir / "subtitle_cache")

        with (
            TestServer(app) as server,
            patch(
                "dropbox_browser.video.subprocess.run",
                side_effect=[
                    CompletedProcess(["ffprobe"], 0, json.dumps(ffprobe_payload).encode("utf-8"), b""),
                    CompletedProcess(["ffmpeg"], 0, b"", b""),
                    CompletedProcess(["ffmpeg"], 0, vtt_body, b""),
                ],
            ) as mock_run,
            patch("dropbox_browser.video.SUBTITLE_CACHE_DIR", self.temp_dir / "subtitle_cache"),
        ):
            url = server.base_url + "/video/endpoints/subtitles?path=movie.mp4&source=remote&track=3"
            with urlopen(url, timeout=5) as response:
                first_body = response.read()
            self.assertEqual(first_body, vtt_body)
            self.assertTrue(cache_path.exists())
            with urlopen(url, timeout=5) as response:
                second_body = response.read()
            self.assertEqual(second_body, vtt_body)
            self.assertEqual(mock_run.call_count, 3)

    def test_subtitles_all_endpoint_returns_all_tracks_in_one_ffmpeg_pass(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            ),
        )
        ffprobe_payload = {
            "streams": [
                {"index": 0, "codec_type": "video", "codec_name": "h264"},
                {
                    "index": 3,
                    "codec_type": "subtitle",
                    "codec_name": "ass",
                    "tags": {"language": "eng", "title": "English"},
                    "disposition": {"default": 1, "forced": 0},
                },
                {
                    "index": 4,
                    "codec_type": "subtitle",
                    "codec_name": "ass",
                    "tags": {"language": "jpn", "title": "Japanese"},
                    "disposition": {"default": 0, "forced": 0},
                },
            ],
            "format": {"duration": "15.0"},
        }

        def fake_subprocess(command, stdout=None, stderr=None, check=False, timeout=None):
            if "ffprobe" in command[0]:
                return CompletedProcess(command, 0, json.dumps(ffprobe_payload).encode("utf-8"), b"")
            if "-c:s" in command and "copy" in command:
                for index, arg in enumerate(command):
                    if arg == "copy" and index + 1 < len(command):
                        Path(command[index + 1]).write_text(
                            f"WEBVTT\n\n00:00.000 --> 00:01.000\nTrack {index}\n",
                            encoding="utf-8",
                        )
                return CompletedProcess(command, 0, b"", b"")
            if command and command[-1] == "-":
                input_path = Path(command[command.index("-i") + 1])
                return CompletedProcess(command, 0, input_path.read_bytes(), b"")
            return CompletedProcess(command, 0, b"", b"")

        with (
            TestServer(app) as server,
            patch(
                "dropbox_browser.video.subprocess.run",
                side_effect=fake_subprocess,
            ) as mock_run,
            patch("dropbox_browser.video.SUBTITLE_CACHE_DIR", self.temp_dir / "subtitle_cache"),
        ):
            with urlopen(server.base_url + "/video/endpoints/subtitles/all?path=movie.mp4&source=remote", timeout=5) as response:
                payload = json.loads(response.read().decode("utf-8"))
                content_type = response.headers["Content-Type"]

        self.assertEqual(content_type, "application/json; charset=utf-8")
        self.assertEqual(payload["status"], "ok")
        self.assertIn("3", payload["tracks"])
        self.assertIn("4", payload["tracks"])
        self.assertIn("WEBVTT", payload["tracks"]["3"]["vtt"])
        self.assertEqual(payload["tracks"]["3"]["language"], "eng")
        self.assertEqual(payload["tracks"]["4"]["language"], "jpn")
        self.assertEqual(mock_run.call_count, 4)
        ffmpeg_calls = [
            call.args[0]
            for call in mock_run.call_args_list
            if Path(call.args[0][0]).name.lower().startswith("ffmpeg")
        ]
        self.assertEqual(len(ffmpeg_calls), 3)
        self.assertIn("0:3", ffmpeg_calls[0])
        self.assertIn("0:4", ffmpeg_calls[0])
        self.assertIn("-c:s", ffmpeg_calls[0])
        self.assertIn("copy", ffmpeg_calls[0])
        self.assertEqual(ffmpeg_calls[1][-3:], ["-f", "webvtt", "-"])
        self.assertEqual(ffmpeg_calls[2][-3:], ["-f", "webvtt", "-"])

    def test_subtitle_codec_supports_webvtt_rejects_bitmap_codecs(self) -> None:
        self.assertTrue(subtitle_codec_supports_webvtt("ass"))
        self.assertFalse(subtitle_codec_supports_webvtt("hdmv_pgs_subtitle"))

    def test_subtitles_all_endpoint_skips_bitmap_tracks(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            ),
        )
        ffprobe_payload = {
            "streams": [
                {"index": 0, "codec_type": "video", "codec_name": "h264"},
                {
                    "index": 4,
                    "codec_type": "subtitle",
                    "codec_name": "ass",
                    "tags": {"language": "eng", "title": "English"},
                    "disposition": {"default": 1, "forced": 0},
                },
                {
                    "index": 5,
                    "codec_type": "subtitle",
                    "codec_name": "ass",
                    "tags": {"language": "jpn", "title": "Japanese"},
                    "disposition": {"default": 0, "forced": 0},
                },
                {
                    "index": 6,
                    "codec_type": "subtitle",
                    "codec_name": "hdmv_pgs_subtitle",
                    "tags": {"language": "eng", "title": "PGS"},
                    "disposition": {"default": 0, "forced": 0},
                },
            ],
            "format": {"duration": "15.0"},
        }

        def fake_subprocess(command, stdout=None, stderr=None, check=False, timeout=None):
            if "ffprobe" in command[0]:
                return CompletedProcess(command, 0, json.dumps(ffprobe_payload).encode("utf-8"), b"")
            if "-c:s" in command and "copy" in command:
                for index, arg in enumerate(command):
                    if arg == "copy" and index + 1 < len(command):
                        Path(command[index + 1]).write_text(
                            "WEBVTT\n\n00:00.000 --> 00:01.000\nTrack\n",
                            encoding="utf-8",
                        )
                return CompletedProcess(command, 0, b"", b"")
            if command[-1] == "-":
                input_path = Path(command[command.index("-i") + 1])
                return CompletedProcess(command, 0, input_path.read_bytes(), b"")
            return CompletedProcess(command, 0, b"", b"")

        with (
            TestServer(app) as server,
            patch(
                "dropbox_browser.video.subprocess.run",
                side_effect=fake_subprocess,
            ) as mock_run,
            patch("dropbox_browser.video.SUBTITLE_CACHE_DIR", self.temp_dir / "subtitle_cache"),
        ):
            with urlopen(server.base_url + "/video/endpoints/subtitles/all?path=movie.mp4&source=remote", timeout=5) as response:
                payload = json.loads(response.read().decode("utf-8"))

        self.assertEqual(payload["status"], "ok")
        self.assertIn("4", payload["tracks"])
        self.assertIn("5", payload["tracks"])
        self.assertNotIn("6", payload["tracks"])
        ffmpeg_calls = [
            call.args[0]
            for call in mock_run.call_args_list
            if Path(call.args[0][0]).name.lower().startswith("ffmpeg")
        ]
        self.assertTrue(ffmpeg_calls)
        self.assertNotIn("0:6", ffmpeg_calls[0])

    def test_build_ffmpeg_batch_webvtt_command_maps_each_stream(self) -> None:
        command = build_ffmpeg_batch_webvtt_command(
            Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
            "http://127.0.0.1:8000/file?path=movie.mkv&source=remote",
            [3, 4],
            [Path("C:/temp/track3.vtt"), Path("C:/temp/track4.vtt")],
        )
        self.assertIn("-map", command)
        self.assertIn("0:3", command)
        self.assertIn("0:4", command)
        self.assertIn(str(Path("C:/temp/track3.vtt")), command)
        self.assertIn(str(Path("C:/temp/track4.vtt")), command)

    def test_build_ffmpeg_subtitle_copy_command_maps_selected_stream(self) -> None:
        command = build_ffmpeg_subtitle_copy_command(
            Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
            "http://127.0.0.1:8000/file?path=movie.mkv&source=remote",
            7,
            Path("C:/temp/track7.ass"),
            start_time_seconds=42,
            duration_seconds=12.5,
        )

        self.assertLess(command.index("-ss"), command.index("-i"))
        self.assertEqual(command[command.index("-ss") + 1], "42")
        self.assertLess(command.index("-t"), command.index("-i"))
        self.assertEqual(command[command.index("-t") + 1], "12.5")
        self.assertIn("0:7", command)
        self.assertIn("-c:s", command)
        self.assertIn("copy", command)
        self.assertEqual(command[-1], str(Path("C:/temp/track7.ass")))

    def test_build_ffmpeg_batch_subtitle_copy_command_maps_each_stream(self) -> None:
        command = build_ffmpeg_batch_subtitle_copy_command(
            Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
            "http://127.0.0.1:8000/file?path=movie.mkv&source=remote",
            [3, 4],
            [Path("C:/temp/track3.ass"), Path("C:/temp/track4.srt")],
        )

        self.assertIn("-map", command)
        self.assertIn("0:3", command)
        self.assertIn("0:4", command)
        self.assertIn("-c:s", command)
        self.assertIn("copy", command)
        self.assertIn(str(Path("C:/temp/track3.ass")), command)
        self.assertIn(str(Path("C:/temp/track4.srt")), command)

    def test_subtitles_endpoint_rejects_invalid_track(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            ),
        )
        ffprobe_payload = {
            "streams": [
                {"index": 0, "codec_type": "video", "codec_name": "h264"},
            ],
            "format": {"duration": "15.0"},
        }

        with (
            TestServer(app) as server,
            patch(
                "dropbox_browser.video.subprocess.run",
                return_value=CompletedProcess(["ffprobe"], 0, json.dumps(ffprobe_payload).encode("utf-8"), b""),
            ),
        ):
            with self.assertRaises(HTTPError) as ctx:
                urlopen(server.base_url + "/video/endpoints/subtitles?path=movie.mp4&source=remote&track=3", timeout=5)

        self.assertEqual(ctx.exception.code, 400)
        ctx.exception.close()

    def test_rebase_webvtt_text_shifts_absolute_timestamps(self) -> None:
        body = (
            "WEBVTT\n\n"
            "00:20:49.130 --> 00:20:52.640\n"
            "Hello\n\n"
            "00:21:10.000 --> 00:21:12.000\n"
            "World\n"
        )

        rebased = rebase_webvtt_text(body, 1200.0)

        self.assertIn("00:49.130 --> 00:52.640", rebased)
        self.assertIn("01:10.000 --> 01:12.000", rebased)
        self.assertNotIn("00:20:49.130", rebased)

    def test_rebase_webvtt_text_leaves_already_relative_timestamps(self) -> None:
        body = (
            "WEBVTT\n\n"
            "00:49.130 --> 00:52.640\n"
            "Hello\n"
        )

        rebased = rebase_webvtt_text(body, 1200.0)

        self.assertEqual(rebased, body)

    def test_rebase_webvtt_text_drops_cues_ending_before_media_start(self) -> None:
        body = (
            "WEBVTT\n\n"
            "00:19:58.000 --> 00:19:59.500\n"
            "Before\n\n"
            "00:20:01.000 --> 00:20:03.000\n"
            "After\n"
        )

        rebased = rebase_webvtt_text(body, 1200.0)

        self.assertNotIn("Before", rebased)
        self.assertIn("00:01.000 --> 00:03.000", rebased)

    def test_build_ffmpeg_webvtt_command_maps_selected_subtitle_stream(self) -> None:
        command = build_ffmpeg_webvtt_command(
            Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
            "http://127.0.0.1:8000/file?path=movie.mkv&source=remote",
            7,
            start_time_seconds=42,
            duration_seconds=12.5,
        )

        self.assertLess(command.index("-ss"), command.index("-i"))
        self.assertEqual(command[command.index("-ss") + 1], "42")
        self.assertLess(command.index("-t"), command.index("-i"))
        self.assertEqual(command[command.index("-t") + 1], "12.5")
        self.assertEqual(command[-3:], ["-f", "webvtt", "-"])
        self.assertIn("0:7", command)

    def _build_case_variant_probe_rclone(self, local_root: Path):
        from tests.support import remote_file_item

        return SimulatedRclone({
            "dropbox:movie.mkv": [SimulatedLsjsonResponse(items=[], returncode=1, stderr=b"not found")],
            "dropbox:": [SimulatedLsjsonResponse(items=[remote_file_item("Movie.mkv", local_root / "Movie.mkv")])],
        }, cat_data={"dropbox:Movie.mkv": b"video"})

    def _build_video_library_rclone(self):
        return SimulatedRclone({
            "dropbox:Videos": [SimulatedLsjsonResponse(items=[
                {
                    "Name": "Movies",
                    "Path": "Movies",
                    "IsDir": True,
                    "Size": 0,
                    "ModTime": "2024-01-01T12:00:00Z",
                },
                {
                    "Name": "clip.mp4",
                    "Path": "clip.mp4",
                    "IsDir": False,
                    "Size": 10,
                    "ModTime": "2024-01-01T12:00:01Z",
                },
                {
                    "Name": "B.mkv",
                    "Path": "B.mkv",
                    "IsDir": False,
                    "Size": 12,
                    "ModTime": "2024-01-01T12:00:02Z",
                },
                {
                    "Name": "notes.txt",
                    "Path": "notes.txt",
                    "IsDir": False,
                    "Size": 8,
                    "ModTime": "2024-01-01T12:00:03Z",
                },
                {
                    "Name": "Anime",
                    "Path": "Anime",
                    "IsDir": True,
                    "Size": 0,
                    "ModTime": "2024-01-01T12:00:04Z",
                },
                {
                    "Name": "episode.WEBM",
                    "Path": "episode.WEBM",
                    "IsDir": False,
                    "Size": 15,
                    "ModTime": "2024-01-01T12:00:05Z",
                },
                {
                    "Name": "a.avi",
                    "Path": "a.avi",
                    "IsDir": False,
                    "Size": 18,
                    "ModTime": "2024-01-01T12:00:06Z",
                },
            ])],
        })


if __name__ == "__main__":
    unittest.main()
