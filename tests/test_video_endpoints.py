from __future__ import annotations

import json
import io
import threading
import time
import unittest
from http.client import IncompleteRead
from http import HTTPStatus
from pathlib import Path
from subprocess import CompletedProcess
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from unittest.mock import patch

from dropbox_browser.config import VideoToolsConfig
from dropbox_browser.errors import BrowserError
from dropbox_browser.video import (
    HLS_MIN_READY_SEGMENTS,
    SUBTITLE_CACHE_VERSION,
    SUBTITLE_WINDOW_CACHE_VERSION,
    SUBTITLE_WINDOW_MANIFEST_VERSION,
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
    convert_ass_text_to_webvtt,
    expand_subtitle_window_for_extraction,
    extracted_webvtt_needs_absolute_offset,
    extract_all_remote_subtitles_to_webvtt,
    extract_remote_subtitles_to_webvtt,
    extract_remote_subtitle_window_to_webvtt,
    merge_subtitle_coverage_ranges,
    offset_webvtt_text,
    _playlist_ready_for_playback,
    _playlist_segment_names,
    _convert_subtitle_file_to_webvtt,
    parse_subtitle_window_duration_seconds,
    probe_cache_path,
    probe_payload_is_incomplete,
    header_probe_duration_unreliable,
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
    video_session_manager,
    video_stream_supports_h264_copy,
    read_subtitle_window_manifest,
)

try:
    from tests.app_test_support import AppTestCase
    from tests.support import SimulatedLsjsonResponse, SimulatedRclone, TestServer, wait_until
except ImportError:
    from app_test_support import AppTestCase
    from support import SimulatedLsjsonResponse, SimulatedRclone, TestServer, wait_until


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


class BlockingWaitFakeFfmpegProcess(FakeFfmpegProcess):
    def __init__(self, command: list[str], *, release_wait: threading.Event, wait_started: threading.Event) -> None:
        super().__init__(command)
        self._release_wait = release_wait
        self._wait_started = wait_started

    def wait(self, timeout: float | None = None) -> int:
        self._wait_started.set()
        self._release_wait.wait(timeout)
        return super().wait(timeout)


class VideoEndpointTests(AppTestCase):
    def _read_video_debug_records(self, debug_path: Path) -> list[dict[str, object]]:
        if not debug_path.exists():
            return []
        return [
            json.loads(line)
            for line in debug_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def test_library_endpoint_returns_child_folders_and_supported_video_files(self) -> None:
        from tests.test_music_endpoints import DirectFilesFolderCache

        rclone = self._build_video_library_rclone()
        app = self._build_app(rclone, local_root=None)
        # Recursive library reads folder-cache direct_* rows (Phase 5 shared UI).
        app.folder_cache = DirectFilesFolderCache({
            "dropbox:Videos": {
                "complete": True,
                "newest_mtime": 1704067200.0,
                "direct_files": [
                    {"name": "a.avi", "path": "a.avi", "remote_path": "dropbox:Videos/a.avi", "size": 10, "mtime": 1.0},
                    {"name": "B.mkv", "path": "B.mkv", "remote_path": "dropbox:Videos/B.mkv", "size": 10, "mtime": 2.0},
                    {"name": "clip.mp4", "path": "clip.mp4", "remote_path": "dropbox:Videos/clip.mp4", "size": 10, "mtime": 3.0},
                    {"name": "episode.WEBM", "path": "episode.WEBM", "remote_path": "dropbox:Videos/episode.WEBM", "size": 10, "mtime": 4.0},
                    {"name": "notes.txt", "path": "notes.txt", "remote_path": "dropbox:Videos/notes.txt", "size": 2, "mtime": 5.0},
                ],
                "direct_folders": [
                    {"name": "Anime", "path": "Anime", "remote_path": "dropbox:Videos/Anime", "mtime": 6.0},
                    {"name": "Movies", "path": "Movies", "remote_path": "dropbox:Videos/Movies", "mtime": 7.0},
                ],
            },
            "dropbox:Videos/Anime": {"complete": True, "direct_files": [], "direct_folders": []},
            "dropbox:Videos/Movies": {"complete": True, "direct_files": [], "direct_folders": []},
        })

        with TestServer(app) as server:
            payload = server.get_json("/video/endpoints/library?path=Videos")

        self.assertTrue(payload["status"]["complete"])
        self.assertEqual(payload["root"]["stream_path"], "Videos")
        self.assertEqual(payload["root"]["remote_path"], "dropbox:Videos")
        self.assertEqual(payload["supported_extensions"], [".mkv", ".mp4", ".m4v", ".webm", ".mov", ".avi", ".ts", ".m2ts", ".wmv"])
        self.assertEqual(
            sorted(folder["display_name"] for folder in payload["folders"]),
            ["Anime", "Movies"],
        )
        self.assertEqual(
            sorted(item["display_name"] for item in payload["items"]),
            ["B.mkv", "a.avi", "clip.mp4", "episode.WEBM"],
        )
        self.assertEqual(payload["items"], payload["songs"])
        mkv_row = next(item for item in payload["items"] if item["display_name"] == "B.mkv")
        mp4_row = next(item for item in payload["items"] if item["display_name"] == "clip.mp4")
        self.assertEqual(mkv_row["preview_url"], "/file?path=Videos%2FB.mkv&source=remote")
        self.assertTrue(mkv_row["compatibility_expected"])
        self.assertFalse(mp4_row["compatibility_expected"])

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
        self.assertIsNone(payload["active_session"])
        self.assertEqual(payload["active_sessions"], [])
        self.assertEqual(payload["session_count"], 0)
        self.assertEqual(payload["max_session_count"], 8)
        self.assertEqual(payload["backpressure_thresholds"], {
            "low_water_seconds": 45.0,
            "medium_water_seconds": 120.0,
            "high_water_seconds": 300.0,
            "max_water_seconds": 600.0,
        })

    def test_status_endpoint_reports_available_ffmpeg_support(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
                max_concurrent_sessions=4,
            ),
        )

        with TestServer(app) as server:
            payload = server.get_json("/video/endpoints/status?check=1")

        self.assertTrue(payload["ffmpeg_available"])
        self.assertTrue(payload["ffprobe_available"])
        self.assertTrue(payload["compatibility_available"])
        self.assertFalse(payload["native_only"])
        # Path str() uses OS separators; accept either form for cross-platform runs.
        self.assertEqual(str(payload["ffmpeg_path"]).replace("\\", "/"), "C:/tools/ffmpeg/bin/ffmpeg.exe")
        self.assertEqual(str(payload["ffprobe_path"]).replace("\\", "/"), "C:/tools/ffmpeg/bin/ffprobe.exe")
        self.assertEqual(payload["query_keys"], ["check"])
        self.assertEqual(payload["active_sessions"], [])
        self.assertEqual(payload["session_count"], 0)
        self.assertEqual(payload["max_session_count"], 4)
        self.assertEqual(payload["backpressure_thresholds"], {
            "low_water_seconds": 45.0,
            "medium_water_seconds": 120.0,
            "high_water_seconds": 300.0,
            "max_water_seconds": 600.0,
        })

    def test_status_endpoint_returns_one_session_summary_and_compatibility_alias(self) -> None:
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
            session_payload = server.post_json("/video/endpoints/session", {
                "path": "movie.mp4",
                "source": "remote",
            })
            payload = server.get_json("/video/endpoints/status")

        self.assertEqual(payload["session_count"], 1)
        self.assertEqual(len(payload["active_sessions"]), 1)
        active_session = payload["active_session"]
        assert active_session is not None
        self.assertEqual(active_session["session_id"], session_payload["session_id"])
        self.assertEqual(active_session["path"], "movie.mp4")
        self.assertEqual(active_session["state"], "active")
        self.assertIsNotNone(active_session["created_at"])
        self.assertIsNotNone(active_session["last_accessed_at"])
        self.assertIsInstance(active_session["created_at_unix_ms"], int)
        self.assertIsInstance(active_session["last_accessed_at_unix_ms"], int)
        self.assertEqual(payload["active_sessions"][0]["session_id"], session_payload["session_id"])

    def test_status_endpoint_returns_multiple_sessions_sorted_by_recent_access(self) -> None:
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[
                {
                    "Name": "movie.mp4",
                    "Path": "movie.mp4",
                    "IsDir": False,
                    "Size": 10,
                    "ModTime": "2024-01-01T12:00:00Z",
                },
                {
                    "Name": "other.mp4",
                    "Path": "other.mp4",
                    "IsDir": False,
                    "Size": 12,
                    "ModTime": "2024-01-01T12:00:01Z",
                },
            ])],
            "dropbox:movie.mp4": [SimulatedLsjsonResponse(items=[{
                "Name": "movie.mp4",
                "Path": "movie.mp4",
                "IsDir": False,
                "Size": 10,
            }])],
            "dropbox:other.mp4": [SimulatedLsjsonResponse(items=[{
                "Name": "other.mp4",
                "Path": "other.mp4",
                "IsDir": False,
                "Size": 12,
            }])],
        }, cat_data={
            "dropbox:movie.mp4": b"0123456789",
            "dropbox:other.mp4": b"abcdefghijkl",
        })
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
            first = server.post_json("/video/endpoints/session", {
                "path": "movie.mp4",
                "source": "remote",
            })
            second = server.post_json("/video/endpoints/session", {
                "path": "other.mp4",
                "source": "remote",
            })
            server.post_json("/video/endpoints/session/progress", {
                "id": first["session_id"],
                "playback_seconds": "5",
                "playback_state": "playing",
            })
            manager = video_session_manager(app)
            now = time.time()
            with manager._lock:
                first_session = manager._get_session_locked(first["session_id"])
                second_session = manager._get_session_locked(second["session_id"])
                assert first_session is not None
                assert second_session is not None
                first_session.last_accessed_at = now - 120.0
                first_session.reported_playback_state = "playing"
                first_session.reported_playback_updated_at = now - 1.0
                second_session.last_accessed_at = now - 5.0
                second_session.reported_playback_state = "unknown"
                second_session.reported_playback_updated_at = None
            payload = server.get_json("/video/endpoints/status")
            filtered_payload = server.get_json("/video/endpoints/status?id=" + first["session_id"])
            missing_payload = server.get_json("/video/endpoints/status?id=missing")

        self.assertEqual(payload["session_count"], 2)
        self.assertEqual(
            [item["session_id"] for item in payload["active_sessions"]],
            [first["session_id"], second["session_id"]],
        )
        active_session = payload["active_session"]
        assert active_session is not None
        self.assertEqual(active_session["session_id"], first["session_id"])

        self.assertEqual(filtered_payload["query_keys"], ["id"])
        self.assertEqual(filtered_payload["session_count"], 1)
        self.assertEqual(len(filtered_payload["active_sessions"]), 1)
        self.assertEqual(filtered_payload["active_sessions"][0]["session_id"], first["session_id"])
        self.assertEqual(filtered_payload["active_session"]["session_id"], first["session_id"])
        self.assertEqual(missing_payload["session_count"], 0)
        self.assertEqual(missing_payload["active_sessions"], [])
        self.assertIsNone(missing_payload["active_session"])

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
        from tests.test_music_endpoints import DirectFilesFolderCache

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
        app.folder_cache = DirectFilesFolderCache({
            "dropbox:Videos": {
                "complete": True,
                "direct_files": [
                    {"name": "movie.mov", "path": "movie.mov", "remote_path": "dropbox:Videos/movie.mov", "size": 11, "mtime": 1.0},
                    {"name": "broadcast.ts", "path": "broadcast.ts", "remote_path": "dropbox:Videos/broadcast.ts", "size": 12, "mtime": 2.0},
                ],
                "direct_folders": [],
            },
        })

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
        self.assertEqual(str(ffprobe_cmd[0]).replace("\\", "/"), "C:/tools/ffmpeg/bin/ffprobe.exe")
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
            [str(part).replace("\\", "/") for part in command],
            [
                "C:/tools/ffmpeg/bin/ffprobe.exe",
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

    def test_header_probe_duration_unreliable_detects_stub_sized_duration(self) -> None:
        # Synthetic AVI-style header probe: streams + duration present, but format
        # size/bit_rate only explain the header stub, not the real file size.
        header_bytes = 8 * 1024 * 1024
        file_size = 181_809_152
        stub_duration = 68.401667
        stub_bit_rate = int(round(header_bytes * 8 / stub_duration))
        raw_payload = {
            "streams": [
                {"index": 0, "codec_type": "video", "codec_name": "mpeg4"},
                {"index": 1, "codec_type": "audio", "codec_name": "mp3"},
            ],
            "format": {
                "duration": str(stub_duration),
                "size": str(header_bytes),
                "bit_rate": str(stub_bit_rate),
                "format_name": "avi",
            },
        }
        self.assertTrue(
            header_probe_duration_unreliable(
                raw_payload,
                file_size=file_size,
                header_bytes=header_bytes,
            )
        )
        # Full-file-sized format metadata should be trusted.
        full_duration = 1501.25
        full_payload = {
            "streams": raw_payload["streams"],
            "format": {
                "duration": str(full_duration),
                "size": str(file_size),
                "bit_rate": str(int(round(file_size * 8 / full_duration))),
                "format_name": "avi",
            },
        }
        self.assertFalse(
            header_probe_duration_unreliable(
                full_payload,
                file_size=file_size,
                header_bytes=header_bytes,
            )
        )

    def test_probe_endpoint_falls_back_when_header_duration_matches_stub_not_file_size(self) -> None:
        """AVI-style prefix probe can return a plausible but wrong duration.

        Reproduces header-cache probing where ffprobe sees only the stub size
        (~8 MiB) and reports ~68s, while the real remote file is much larger.
        """
        header_bytes = 8 * 1024
        full_size = 1_000_000
        avi_bytes = b"A" * full_size
        rclone = SimulatedRclone(
            {
                "dropbox:": [SimulatedLsjsonResponse(items=[{
                    "Name": "episode.avi",
                    "Path": "episode.avi",
                    "IsDir": False,
                    "Size": full_size,
                    "ModTime": "2024-01-01T12:00:00Z",
                }])],
                "dropbox:episode.avi": [SimulatedLsjsonResponse(items=[{
                    "Name": "episode.avi",
                    "Path": "episode.avi",
                    "IsDir": False,
                    "Size": full_size,
                }])],
            },
            cat_data={"dropbox:episode.avi": avi_bytes},
        )
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            ),
        )
        app.video_probe_cache_ttl_seconds = 3600
        app.video_header_cache_bytes = header_bytes
        stub_duration = 68.401667
        full_duration = 1501.25
        stub_bit_rate = int(round(header_bytes * 8 / stub_duration))
        full_bit_rate = int(round(full_size * 8 / full_duration))
        streams = [
            {
                "index": 0,
                "codec_type": "video",
                "codec_name": "mpeg4",
                "width": 640,
                "height": 480,
                "pix_fmt": "yuv420p",
            },
            {
                "index": 1,
                "codec_type": "audio",
                "codec_name": "mp3",
                "channels": 2,
                "sample_rate": "48000",
            },
        ]
        header_ffprobe = {
            "streams": streams,
            "format": {
                "duration": str(stub_duration),
                "size": str(header_bytes),
                "bit_rate": str(stub_bit_rate),
                "format_name": "avi",
            },
        }
        full_ffprobe = {
            "streams": streams,
            "format": {
                "duration": str(full_duration),
                "size": str(full_size),
                "bit_rate": str(full_bit_rate),
                "format_name": "avi",
            },
        }
        run_calls: list[list[str]] = []

        def fake_run(cmd, stdout=None, stderr=None, check=False, timeout=None):
            run_calls.append(list(cmd))
            input_url = cmd[-1]
            payload = header_ffprobe if str(input_url).endswith(".bin") else full_ffprobe
            return CompletedProcess(cmd, 0, json.dumps(payload).encode("utf-8"), b"")

        with (
            TestServer(app) as server,
            patch("dropbox_browser.video.subprocess.run", side_effect=fake_run),
        ):
            payload = server.get_json("/video/endpoints/probe?path=episode.avi&source=remote")

        self.assertEqual(len(run_calls), 2, run_calls)
        self.assertTrue(str(run_calls[0][-1]).endswith(".bin"), run_calls[0][-1])
        self.assertIn("path=episode.avi", str(run_calls[1][-1]))
        self.assertAlmostEqual(float(payload["duration_seconds"]), full_duration, places=3)
        self.assertNotAlmostEqual(float(payload["duration_seconds"]), stub_duration, places=1)
        self.assertTrue(str(payload["probe_url"]).startswith("http://"))
        self.assertIn("path=episode.avi", str(payload["probe_url"]))

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

        def fake_subprocess(command, stdout=None, stderr=None, check=False, timeout=None):
            if "ffprobe" in Path(command[0]).name.lower():
                return CompletedProcess(command, 0, json.dumps(ffprobe_payload).encode("utf-8"), b"")
            if "-c:s" in command and "copy" in command:
                Path(command[-1]).write_text(
                    "[Events]\n"
                    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
                    "Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Hello\n",
                    encoding="utf-8",
                )
                return CompletedProcess(command, 0, b"", b"")
            if command and command[-1] == "-":
                return CompletedProcess(command, 0, vtt_body, b"")
            return CompletedProcess(command, 0, b"", b"")

        with (
            TestServer(app) as server,
            patch(
                "dropbox_browser.video.subprocess.run",
                side_effect=fake_subprocess,
            ) as mock_run,
            patch("dropbox_browser.video.SUBTITLE_CACHE_DIR", self.temp_dir / "subtitle_cache"),
        ):
            url = server.base_url + "/video/endpoints/subtitles?path=movie.mp4&source=remote&track=3"
            with urlopen(url, timeout=5) as response:
                self.assertEqual(response.read(), vtt_body)
            time.sleep(0.02)
            with urlopen(url, timeout=5) as response:
                self.assertEqual(response.read(), vtt_body)
            self.assertEqual(mock_run.call_count, 3)

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
                "client_id": "client-a",
                "source": "remote",
                "start_time_seconds": "120.5",
            })

        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["path"], "movie.mp4")
        self.assertEqual(payload["client_id"], "client-a")
        self.assertEqual(payload["start_time_seconds"], 120.5)
        self.assertEqual(payload["encoded_media_end_seconds"], HLS_MIN_READY_SEGMENTS * 6.0)
        self.assertEqual(payload["hls_segment_duration_seconds"], 6.0)
        self.assertEqual(payload["ffmpeg_pid"], 12345)
        self.assertTrue(payload["session_id"])
        self.assertEqual(
            payload["playlist_url"],
            "/video/endpoints/session/file?id=" + payload["session_id"] + "&name=stream.m3u8",
        )
        self.assertIsNone(payload["audio_stream_index"])
        self.assertIsNone(payload["subtitle_stream_index"])
        self.assertEqual(len(spawned), 1)
        self.assertEqual(str(spawned[0].command[0]).replace("\\", "/"), "C:/tools/ffmpeg/bin/ffmpeg.exe")
        self.assertTrue(any(
            ("/file?path=movie.mp4&source=remote&video_session_id=" + payload["session_id"]) in part
            for part in spawned[0].command
        ))
        self.assertIn("-ss", spawned[0].command)
        self.assertEqual(spawned[0].command[spawned[0].command.index("-ss") + 1], "120.5")
        self.assertTrue(any(("/video/endpoints/session/file?id=" + payload["session_id"] + "&name=") in part for part in spawned[0].command))

    def test_session_status_preserves_client_id_from_session_create_and_progress(self) -> None:
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
            session_payload = server.post_json("/video/endpoints/session", {
                "path": "movie.mp4",
                "client_id": "client-a",
                "source": "remote",
            })
            progress_payload = server.post_json("/video/endpoints/session/progress", {
                "id": session_payload["session_id"],
                "client_id": "client-a",
                "playback_seconds": "123.5",
                "playback_media_seconds": "3.5",
                "playback_state": "paused",
                "playback_sync_token": "9",
            })
            status_payload = server.get_json("/video/endpoints/status?id=" + session_payload["session_id"])

        self.assertEqual(session_payload["client_id"], "client-a")
        self.assertEqual(progress_payload["client_playback"]["client_id"], "client-a")
        self.assertEqual(status_payload["active_session"]["client_id"], "client-a")
        self.assertEqual(status_payload["active_session"]["client_playback"]["client_id"], "client-a")

    def test_session_endpoint_rejects_when_max_concurrent_sessions_reached(self) -> None:
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[
                {
                    "Name": "movie.mp4",
                    "Path": "movie.mp4",
                    "IsDir": False,
                    "Size": 10,
                    "ModTime": "2024-01-01T12:00:00Z",
                },
                {
                    "Name": "other.mp4",
                    "Path": "other.mp4",
                    "IsDir": False,
                    "Size": 12,
                    "ModTime": "2024-01-01T12:00:01Z",
                },
                {
                    "Name": "third.mp4",
                    "Path": "third.mp4",
                    "IsDir": False,
                    "Size": 14,
                    "ModTime": "2024-01-01T12:00:02Z",
                },
            ])],
            "dropbox:movie.mp4": [SimulatedLsjsonResponse(items=[{
                "Name": "movie.mp4",
                "Path": "movie.mp4",
                "IsDir": False,
                "Size": 10,
            }])],
            "dropbox:other.mp4": [SimulatedLsjsonResponse(items=[{
                "Name": "other.mp4",
                "Path": "other.mp4",
                "IsDir": False,
                "Size": 12,
            }])],
            "dropbox:third.mp4": [SimulatedLsjsonResponse(items=[{
                "Name": "third.mp4",
                "Path": "third.mp4",
                "IsDir": False,
                "Size": 14,
            }])],
        }, cat_data={
            "dropbox:movie.mp4": b"0123456789",
            "dropbox:other.mp4": b"abcdefghijkl",
            "dropbox:third.mp4": b"third-third!!",
        })
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffprobe/bin/ffprobe.exe"),
                max_concurrent_sessions=2,
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
                "path": "other.mp4",
                "source": "remote",
            })
            server.post_json("/video/endpoints/session/progress", {
                "id": first["session_id"],
                "playback_seconds": "12",
                "playback_state": "playing",
            })
            server.post_json("/video/endpoints/session/progress", {
                "id": second["session_id"],
                "playback_seconds": "6",
                "playback_state": "paused",
            })
            with self.assertRaises(HTTPError) as ctx:
                server.post_json("/video/endpoints/session", {
                    "path": "third.mp4",
                    "source": "remote",
                })
            first_playlist = server.get_text(first["playlist_url"])
            with urlopen(server.base_url + first["asset_root"] + "segment_00000.m4s", timeout=5) as response:
                first_segment = response.read()
            second_playlist = server.get_text(second["playlist_url"])
            with urlopen(server.base_url + second["asset_root"] + "segment_00000.m4s", timeout=5) as response:
                second_segment = response.read()
            status_payload = server.get_json("/video/endpoints/status")

        self.assertEqual(ctx.exception.code, 429)
        error_payload = json.loads(ctx.exception.read().decode("utf-8"))
        self.assertEqual(error_payload["status"], "error")
        self.assertEqual(error_payload["error_code"], "session_cap_reached")
        self.assertEqual(error_payload["session_error_reason"], "all_sessions_active")
        self.assertEqual(error_payload["max_session_count"], 2)
        self.assertIn("max concurrent sessions", error_payload["message"])
        self.assertEqual(len(spawned), 2)
        self.assertEqual(status_payload["session_count"], 2)
        self.assertEqual(status_payload["max_session_count"], 2)
        self.assertIn("#EXTM3U", first_playlist)
        self.assertEqual(first_segment, b"segment0")
        self.assertIn("#EXTM3U", second_playlist)
        self.assertEqual(second_segment, b"segment0")
        ctx.exception.close()

    def test_session_endpoint_evicts_oldest_idle_session_when_capacity_is_full(self) -> None:
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[
                {
                    "Name": "movie.mp4",
                    "Path": "movie.mp4",
                    "IsDir": False,
                    "Size": 10,
                    "ModTime": "2024-01-01T12:00:00Z",
                },
                {
                    "Name": "other.mp4",
                    "Path": "other.mp4",
                    "IsDir": False,
                    "Size": 12,
                    "ModTime": "2024-01-01T12:00:01Z",
                },
                {
                    "Name": "third.mp4",
                    "Path": "third.mp4",
                    "IsDir": False,
                    "Size": 14,
                    "ModTime": "2024-01-01T12:00:02Z",
                },
            ])],
            "dropbox:movie.mp4": [SimulatedLsjsonResponse(items=[{
                "Name": "movie.mp4",
                "Path": "movie.mp4",
                "IsDir": False,
                "Size": 10,
            }])],
            "dropbox:other.mp4": [SimulatedLsjsonResponse(items=[{
                "Name": "other.mp4",
                "Path": "other.mp4",
                "IsDir": False,
                "Size": 12,
            }])],
            "dropbox:third.mp4": [SimulatedLsjsonResponse(items=[{
                "Name": "third.mp4",
                "Path": "third.mp4",
                "IsDir": False,
                "Size": 14,
            }])],
        }, cat_data={
            "dropbox:movie.mp4": b"0123456789",
            "dropbox:other.mp4": b"abcdefghijkl",
            "dropbox:third.mp4": b"third-third!!",
        })
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffprobe/bin/ffprobe.exe"),
                max_concurrent_sessions=2,
            ),
        )

        def fake_popen(command, stdout=None, stderr=None, cwd=None, **kwargs):
            if not is_ffmpeg_hls_spawn(command):
                return FakeFfmpegProcess(command)
            playlist_path = Path(command[-1])
            write_hls_session_fixture(playlist_path)
            return FakeFfmpegProcess(command)

        with TestServer(app) as server, patch("dropbox_browser.video.subprocess.Popen", side_effect=fake_popen):
            first = server.post_json("/video/endpoints/session", {
                "path": "movie.mp4",
                "source": "remote",
            })
            second = server.post_json("/video/endpoints/session", {
                "path": "other.mp4",
                "source": "remote",
            })
            server.post_json("/video/endpoints/session/progress", {
                "id": first["session_id"],
                "playback_seconds": "4",
                "playback_state": "paused",
            })
            server.post_json("/video/endpoints/session/progress", {
                "id": second["session_id"],
                "playback_seconds": "4",
                "playback_state": "playing",
            })
            video_session_manager(app)._sessions[first["session_id"]].process.returncode = 0
            third = server.post_json("/video/endpoints/session", {
                "path": "third.mp4",
                "source": "remote",
            })
            with self.assertRaises(HTTPError) as evicted_ctx:
                urlopen(server.base_url + first["asset_root"] + "segment_00000.m4s", timeout=5)
            second_playlist = server.get_text(second["playlist_url"])
            third_playlist = server.get_text(third["playlist_url"])
            stale_payload = server.post_json("/video/endpoints/session/progress", {
                "id": first["session_id"],
                "playback_seconds": "5",
                "playback_state": "playing",
            })
            status_payload = server.get_json("/video/endpoints/status")

        self.assertEqual(evicted_ctx.exception.code, 404)
        self.assertIn("Video session was evicted to free server capacity.", evicted_ctx.exception.read().decode("utf-8"))
        self.assertIn("#EXTM3U", second_playlist)
        self.assertIn("#EXTM3U", third_playlist)
        self.assertFalse(stale_payload["updated"])
        self.assertEqual(stale_payload["session_state"], "evicted")
        self.assertEqual(stale_payload["stale_reason"], "evicted")
        self.assertEqual(status_payload["session_count"], 2)
        self.assertEqual(
            {item["session_id"] for item in status_payload["active_sessions"]},
            {second["session_id"], third["session_id"]},
        )
        evicted_ctx.exception.close()

    def test_session_activity_ignores_exited_session_with_recent_playback(self) -> None:
        app = self._build_app(
            self._remote_media_rclone(),
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffprobe/bin/ffprobe.exe"),
            ),
        )
        manager = video_session_manager(app)
        session_dir = self.temp_dir / "exited_video_session"
        session_dir.mkdir(parents=True, exist_ok=True)
        process = FakeFfmpegProcess([])
        process.returncode = 0
        session = VideoHlsSession(
            session_id="exited",
            rel_path="movie.mp4",
            file_size=10,
            session_dir=session_dir,
            playlist_path=session_dir / "stream.m3u8",
            process=process,
            command=[],
            created_at=time.time(),
            create_started_at=time.monotonic(),
            last_accessed_at=time.time(),
            client_id="client-exited",
            audio_stream_index=1,
            subtitle_stream_index=None,
            start_time_seconds=0.0,
            video_mode="video_copy",
            video_mode_reason="test_fixture",
            audio_mode="audio_copy",
            audio_mode_reason="test_fixture",
            reported_playback_seconds=4.0,
            reported_playback_state="paused",
            reported_playback_updated_at=time.time(),
        )
        with manager._lock:
            self.assertFalse(manager._session_is_recently_active_locked(session))

    def test_tagged_input_session_matches_exact_session_id_and_path_after_second_session_exists(self) -> None:
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[
                {
                    "Name": "movie.mp4",
                    "Path": "movie.mp4",
                    "IsDir": False,
                    "Size": 10,
                    "ModTime": "2024-01-01T12:00:00Z",
                },
                {
                    "Name": "other.mp4",
                    "Path": "other.mp4",
                    "IsDir": False,
                    "Size": 12,
                    "ModTime": "2024-01-01T12:00:01Z",
                },
            ])],
            "dropbox:movie.mp4": [SimulatedLsjsonResponse(items=[{
                "Name": "movie.mp4",
                "Path": "movie.mp4",
                "IsDir": False,
                "Size": 10,
            }])],
            "dropbox:other.mp4": [SimulatedLsjsonResponse(items=[{
                "Name": "other.mp4",
                "Path": "other.mp4",
                "IsDir": False,
                "Size": 12,
            }])],
        }, cat_data={
            "dropbox:movie.mp4": b"0123456789",
            "dropbox:other.mp4": b"abcdefghijkl",
        })
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
            first = server.post_json("/video/endpoints/session", {
                "path": "movie.mp4",
                "source": "remote",
            })
            second = server.post_json("/video/endpoints/session", {
                "path": "other.mp4",
                "source": "remote",
            })
            manager = video_session_manager(app)
            matched = manager.tagged_input_session(first["session_id"], "movie.mp4")
            second_matched = manager.tagged_input_session(second["session_id"], "other.mp4")
            mismatched_path = manager.tagged_input_session(first["session_id"], "other.mp4")
            missing_session = manager.tagged_input_session("missing", "movie.mp4")

        self.assertIsNotNone(matched)
        assert matched is not None
        self.assertEqual(matched.session_id, first["session_id"])
        self.assertIsNotNone(second_matched)
        assert second_matched is not None
        self.assertEqual(second_matched.session_id, second["session_id"])
        self.assertIsNone(mismatched_path)
        self.assertIsNone(missing_session)

    def test_tagged_input_throttle_decision_reports_ahead_seconds_and_cancels_stale_sessions(self) -> None:
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
            write_hls_session_fixture(playlist_path, segment_count=2)
            return FakeFfmpegProcess(command)

        with TestServer(app) as server, patch("dropbox_browser.video.subprocess.Popen", side_effect=fake_popen):
            payload = server.post_json("/video/endpoints/session", {
                "path": "movie.mp4",
                "source": "remote",
                "start_time_seconds": "120",
            })
            server.post_json("/video/endpoints/session/progress", {
                "id": payload["session_id"],
                "playback_seconds": "129",
                "playback_state": "playing",
            })
            manager = video_session_manager(app)
            active = manager.tagged_input_throttle_decision(payload["session_id"], "movie.mp4")
            stale = manager.tagged_input_throttle_decision("missing", "movie.mp4")
            wrong_path = manager.tagged_input_throttle_decision(payload["session_id"], "other.mp4")

        self.assertFalse(active.cancel)
        self.assertEqual(active.throttle_mode, "unthrottled")
        self.assertEqual(active.ahead_seconds, 3.0)
        self.assertTrue(stale.cancel)
        self.assertEqual(stale.throttle_mode, "session_missing")
        self.assertTrue(wrong_path.cancel)
        self.assertEqual(wrong_path.throttle_mode, "path_mismatch")

    def test_tagged_input_throttle_decision_uses_sliding_scale_bands_for_playing_session(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
                backpressure_low_water_seconds=10.0,
                backpressure_medium_water_seconds=20.0,
                backpressure_high_water_seconds=30.0,
                backpressure_max_water_seconds=40.0,
            ),
        )

        def fake_popen(command, stdout=None, stderr=None, cwd=None, **kwargs):
            if not is_ffmpeg_hls_spawn(command):
                return FakeFfmpegProcess(command)
            playlist_path = Path(command[-1])
            write_hls_session_fixture(playlist_path, segment_count=10)
            return FakeFfmpegProcess(command)

        with TestServer(app) as server, patch("dropbox_browser.video.subprocess.Popen", side_effect=fake_popen):
            payload = server.post_json("/video/endpoints/session", {
                "path": "movie.mp4",
                "source": "remote",
            })
            manager = video_session_manager(app)

            server.post_json("/video/endpoints/session/progress", {
                "id": payload["session_id"],
                "playback_seconds": "55",
                "playback_state": "playing",
            })
            catch_up = manager.tagged_input_throttle_decision(payload["session_id"], "movie.mp4")

            server.post_json("/video/endpoints/session/progress", {
                "id": payload["session_id"],
                "playback_seconds": "48",
                "playback_state": "playing",
            })
            steady = manager.tagged_input_throttle_decision(payload["session_id"], "movie.mp4")

            server.post_json("/video/endpoints/session/progress", {
                "id": payload["session_id"],
                "playback_seconds": "36",
                "playback_state": "playing",
            })
            slow = manager.tagged_input_throttle_decision(payload["session_id"], "movie.mp4")

            server.post_json("/video/endpoints/session/progress", {
                "id": payload["session_id"],
                "playback_seconds": "24",
                "playback_state": "playing",
            })
            heavy = manager.tagged_input_throttle_decision(payload["session_id"], "movie.mp4")

            server.post_json("/video/endpoints/session/progress", {
                "id": payload["session_id"],
                "playback_seconds": "20",
                "playback_state": "playing",
            })
            paused = manager.tagged_input_throttle_decision(payload["session_id"], "movie.mp4")

        self.assertEqual(catch_up.throttle_mode, "unthrottled")
        self.assertEqual(catch_up.sleep_seconds, 0.0)
        self.assertEqual(catch_up.ahead_seconds, 5.0)

        self.assertEqual(steady.throttle_mode, "steady_background")
        self.assertEqual(steady.sleep_seconds, 0.05)
        self.assertEqual(steady.ahead_seconds, 12.0)

        self.assertEqual(slow.throttle_mode, "slow_background")
        self.assertEqual(slow.sleep_seconds, 0.15)
        self.assertEqual(slow.ahead_seconds, 24.0)

        self.assertEqual(heavy.throttle_mode, "heavy_throttle")
        self.assertEqual(heavy.sleep_seconds, 0.75)
        self.assertEqual(heavy.ahead_seconds, 36.0)

        self.assertEqual(paused.throttle_mode, "pause_input")
        self.assertEqual(paused.sleep_seconds, 2.0)
        self.assertEqual(paused.ahead_seconds, 40.0)

    def test_tagged_input_throttle_decision_promotes_paused_playback_and_seek_near_edge_resumes_catch_up(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
                backpressure_low_water_seconds=10.0,
                backpressure_medium_water_seconds=20.0,
                backpressure_high_water_seconds=30.0,
                backpressure_max_water_seconds=40.0,
            ),
        )

        def fake_popen(command, stdout=None, stderr=None, cwd=None, **kwargs):
            if not is_ffmpeg_hls_spawn(command):
                return FakeFfmpegProcess(command)
            playlist_path = Path(command[-1])
            write_hls_session_fixture(playlist_path, segment_count=10)
            return FakeFfmpegProcess(command)

        with TestServer(app) as server, patch("dropbox_browser.video.subprocess.Popen", side_effect=fake_popen):
            payload = server.post_json("/video/endpoints/session", {
                "path": "movie.mp4",
                "source": "remote",
            })
            manager = video_session_manager(app)

            server.post_json("/video/endpoints/session/progress", {
                "id": payload["session_id"],
                "playback_seconds": "48",
                "playback_state": "paused",
            })
            paused_near_low = manager.tagged_input_throttle_decision(payload["session_id"], "movie.mp4")

            server.post_json("/video/endpoints/session/progress", {
                "id": payload["session_id"],
                "playback_seconds": "36",
                "playback_state": "paused",
            })
            paused_mid = manager.tagged_input_throttle_decision(payload["session_id"], "movie.mp4")

            server.post_json("/video/endpoints/session/progress", {
                "id": payload["session_id"],
                "playback_seconds": "57",
                "playback_state": "playing",
            })
            near_edge_seek = manager.tagged_input_throttle_decision(payload["session_id"], "movie.mp4")

        self.assertEqual(paused_near_low.throttle_mode, "slow_background")
        self.assertEqual(paused_near_low.sleep_seconds, 0.15)
        self.assertEqual(paused_near_low.ahead_seconds, 12.0)

        self.assertEqual(paused_mid.throttle_mode, "heavy_throttle")
        self.assertEqual(paused_mid.sleep_seconds, 0.75)
        self.assertEqual(paused_mid.ahead_seconds, 24.0)

        self.assertEqual(near_edge_seek.throttle_mode, "unthrottled")
        self.assertEqual(near_edge_seek.sleep_seconds, 0.0)
        self.assertEqual(near_edge_seek.ahead_seconds, 3.0)

    def test_tagged_file_range_request_logs_request_and_completion_diagnostics(self) -> None:
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
        events: list[dict[str, object]] = []

        def fake_popen(command, stdout=None, stderr=None, cwd=None, **kwargs):
            if not is_ffmpeg_hls_spawn(command):
                return FakeFfmpegProcess(command)
            playlist_path = Path(command[-1])
            write_hls_session_fixture(playlist_path, segment_count=2)
            return FakeFfmpegProcess(command)

        def capture_debug(_app, event, **fields):
            events.append({"event": event, **fields})

        with (
            TestServer(app) as server,
            patch("dropbox_browser.video.subprocess.Popen", side_effect=fake_popen),
            patch("dropbox_browser.handlers.log_video_debug", side_effect=capture_debug),
            patch("dropbox_browser.video.log_video_debug", side_effect=capture_debug),
        ):
            payload = server.post_json("/video/endpoints/session", {
                "path": "movie.mp4",
                "source": "remote",
            })
            request = Request(
                server.base_url + "/file?path=movie.mp4&source=remote&video_session_id=" + payload["session_id"],
                headers={"Range": "bytes=3-6"},
            )
            with urlopen(request, timeout=5) as response:
                body = response.read()
                status = response.status
            # Completion is logged in the handler finally after the body is sent.
            # Wait while patches are still active so the event lands in `events`.
            wait_until(
                lambda: any(row.get("event") == "tagged_input_http_complete" for row in events),
                description="tagged range request completion event",
            )
            request_event = next(row for row in events if row.get("event") == "tagged_input_http_request")
            complete_event = next(row for row in events if row.get("event") == "tagged_input_http_complete")

        self.assertEqual(status, HTTPStatus.PARTIAL_CONTENT)
        self.assertEqual(body, b"3456")
        self.assertEqual(request_event["session_id"], payload["session_id"])
        self.assertEqual(request_event["requested_rel_path"], "movie.mp4")
        self.assertEqual(request_event["range_header"], "bytes=3-6")
        self.assertFalse(request_event["head_only"])
        self.assertEqual(complete_event["session_id"], payload["session_id"])
        self.assertEqual(complete_event["requested_rel_path"], "movie.mp4")
        self.assertEqual(complete_event["rel_path"], "movie.mp4")
        self.assertEqual(complete_event["validation_result"], "matched")
        self.assertEqual(complete_event["selected_start"], 3)
        self.assertEqual(complete_event["selected_count"], 4)
        self.assertEqual(complete_event["file_size"], 10)
        self.assertEqual(complete_event["range_header"], "bytes=3-6")
        self.assertEqual(complete_event["rclone_command_form"], "cat_offset_count")
        self.assertEqual(complete_event["bytes_copied"], 4)
        self.assertEqual(complete_event["outcome"], "completed")
        self.assertIsInstance(complete_event["remote_resolution_ms"], float)
        self.assertIsInstance(complete_event["open_cat_duration_ms"], float)
        self.assertIsInstance(complete_event["open_cat_to_first_byte_ms"], float)
        self.assertIsInstance(complete_event["stream_duration_ms"], float)

    def test_tagged_file_request_without_range_logs_full_request_shape(self) -> None:
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
        events: list[dict[str, object]] = []

        def fake_popen(command, stdout=None, stderr=None, cwd=None, **kwargs):
            if not is_ffmpeg_hls_spawn(command):
                return FakeFfmpegProcess(command)
            playlist_path = Path(command[-1])
            write_hls_session_fixture(playlist_path, segment_count=2)
            return FakeFfmpegProcess(command)

        def capture_debug(_app, event, **fields):
            events.append({"event": event, **fields})

        with (
            TestServer(app) as server,
            patch("dropbox_browser.video.subprocess.Popen", side_effect=fake_popen),
            patch("dropbox_browser.handlers.log_video_debug", side_effect=capture_debug),
            patch("dropbox_browser.video.log_video_debug", side_effect=capture_debug),
        ):
            payload = server.post_json("/video/endpoints/session", {
                "path": "movie.mp4",
                "source": "remote",
            })
            with urlopen(
                server.base_url + "/file?path=movie.mp4&source=remote&video_session_id=" + payload["session_id"],
                timeout=5,
            ) as response:
                body = response.read()
                status = response.status
            wait_until(
                lambda: any(row.get("event") == "tagged_input_http_complete" for row in events),
                description="tagged full request completion event",
            )
            complete_event = next(row for row in events if row.get("event") == "tagged_input_http_complete")

        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(body, b"0123456789")
        self.assertEqual(complete_event["range_header"], "")
        self.assertEqual(complete_event["selected_start"], 0)
        self.assertEqual(complete_event["selected_count"], 10)
        self.assertEqual(complete_event["rclone_command_form"], "cat_full")
        self.assertEqual(complete_event["bytes_copied"], 10)
        self.assertEqual(complete_event["outcome"], "completed")

    def test_tagged_file_request_logs_missing_session_validation_result(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(rclone, local_root=None)
        app.video_debug_logs = True
        events: list[dict[str, object]] = []

        def capture_debug(_app, event, **fields):
            events.append({"event": event, **fields})

        with (
            TestServer(app) as server,
            patch("dropbox_browser.handlers.log_video_debug", side_effect=capture_debug),
            patch("dropbox_browser.video.log_video_debug", side_effect=capture_debug),
        ):
            with urlopen(server.base_url + "/file?path=movie.mp4&source=remote&video_session_id=missing", timeout=5) as response:
                status = response.status
                try:
                    body = response.read()
                except IncompleteRead as exc:
                    body = exc.partial
            wait_until(
                lambda: any(row.get("event") == "tagged_input_http_complete" for row in events),
                description="missing tagged session completion event",
            )
            complete_event = next(row for row in events if row.get("event") == "tagged_input_http_complete")

        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(body, b"")
        self.assertEqual(complete_event["validation_result"], "session_missing")
        self.assertEqual(complete_event["selected_start"], 0)
        self.assertEqual(complete_event["selected_count"], 10)
        self.assertEqual(complete_event["bytes_copied"], 0)
        self.assertEqual(complete_event["outcome"], "stream_cancelled")

    def test_tagged_file_request_logs_path_mismatch_validation_result(self) -> None:
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[
                {
                    "Name": "movie.mp4",
                    "Path": "movie.mp4",
                    "IsDir": False,
                    "Size": 10,
                    "ModTime": "2024-01-01T12:00:00Z",
                },
                {
                    "Name": "other.mp4",
                    "Path": "other.mp4",
                    "IsDir": False,
                    "Size": 12,
                    "ModTime": "2024-01-01T12:00:01Z",
                },
            ])],
            "dropbox:movie.mp4": [SimulatedLsjsonResponse(items=[{
                "Name": "movie.mp4",
                "Path": "movie.mp4",
                "IsDir": False,
                "Size": 10,
            }])],
            "dropbox:other.mp4": [SimulatedLsjsonResponse(items=[{
                "Name": "other.mp4",
                "Path": "other.mp4",
                "IsDir": False,
                "Size": 12,
            }])],
        }, cat_data={
            "dropbox:movie.mp4": b"0123456789",
            "dropbox:other.mp4": b"abcdefghijkl",
        })
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
            ),
        )
        app.video_debug_logs = True
        events: list[dict[str, object]] = []

        def fake_popen(command, stdout=None, stderr=None, cwd=None, **kwargs):
            if not is_ffmpeg_hls_spawn(command):
                return FakeFfmpegProcess(command)
            playlist_path = Path(command[-1])
            write_hls_session_fixture(playlist_path, segment_count=2)
            return FakeFfmpegProcess(command)

        def capture_debug(_app, event, **fields):
            events.append({"event": event, **fields})

        with (
            TestServer(app) as server,
            patch("dropbox_browser.video.subprocess.Popen", side_effect=fake_popen),
            patch("dropbox_browser.handlers.log_video_debug", side_effect=capture_debug),
            patch("dropbox_browser.video.log_video_debug", side_effect=capture_debug),
        ):
            payload = server.post_json("/video/endpoints/session", {
                "path": "movie.mp4",
                "source": "remote",
            })
            with urlopen(
                server.base_url + "/file?path=other.mp4&source=remote&video_session_id=" + payload["session_id"],
                timeout=5,
            ) as response:
                status = response.status
                try:
                    body = response.read()
                except IncompleteRead as exc:
                    body = exc.partial
            wait_until(
                lambda: any(row.get("event") == "tagged_input_http_complete" for row in events),
                description="path mismatch tagged completion event",
            )
            complete_event = next(row for row in events if row.get("event") == "tagged_input_http_complete")

        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(body, b"")
        self.assertEqual(complete_event["requested_rel_path"], "other.mp4")
        self.assertEqual(complete_event["rel_path"], "other.mp4")
        self.assertEqual(complete_event["validation_result"], "path_mismatch")
        self.assertEqual(complete_event["selected_count"], 12)
        self.assertEqual(complete_event["bytes_copied"], 0)
        self.assertEqual(complete_event["outcome"], "stream_cancelled")

    def test_plain_file_streaming_stays_unchanged_when_active_video_session_exists(self) -> None:
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
            server.post_json("/video/endpoints/session", {
                "path": "movie.mp4",
                "source": "remote",
            })
            with urlopen(server.base_url + "/file?path=movie.mp4", timeout=5) as response:
                body = response.read()
                status = response.status
                headers = response.headers

        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(body, b"0123456789")
        self.assertEqual(headers["Content-Length"], "10")
        self.assertTrue(any(
            call["args"] == ("cat", "--", "dropbox:movie.mp4")
            for call in rclone.calls
        ))

    def test_tagged_file_streaming_returns_full_body_for_active_session(self) -> None:
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
            rclone.calls.clear()
            with urlopen(
                server.base_url
                + "/file?path=movie.mp4&source=remote&video_session_id="
                + payload["session_id"],
                timeout=5,
            ) as response:
                body = response.read()
                status = response.status
                headers = response.headers

        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(body, b"0123456789")
        self.assertEqual(headers["Content-Length"], "10")
        self.assertTrue(any(
            call["args"] == ("cat", "--", "dropbox:movie.mp4")
            for call in rclone.calls
        ))
        self.assertFalse(any(call["args"][0] == "lsjson" for call in rclone.calls))

    def test_tagged_file_streaming_stops_cleanly_after_session_stop(self) -> None:
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
            server.post_json("/video/endpoints/session/stop", {
                "id": payload["session_id"],
            })
            with urlopen(
                server.base_url
                + "/file?path=movie.mp4&source=remote&video_session_id="
                + payload["session_id"],
                timeout=5,
            ) as response:
                status = response.status
                try:
                    body = response.read()
                except IncompleteRead as exc:
                    body = exc.partial

        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(body, b"")

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

    def test_new_session_for_same_path_keeps_previous_session_assets_available(self) -> None:
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
            first_playlist = server.get_text(first["playlist_url"])
            second_playlist = server.get_text(second["playlist_url"])

        self.assertEqual(len(spawned), 2)
        self.assertNotEqual(first["session_id"], second["session_id"])
        self.assertIn("#EXTM3U", first_playlist)
        self.assertIn("#EXTM3U", second_playlist)

    def test_new_session_for_different_path_keeps_the_first_session_available(self) -> None:
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[
                {
                    "Name": "movie.mp4",
                    "Path": "movie.mp4",
                    "IsDir": False,
                    "Size": 10,
                    "ModTime": "2024-01-01T12:00:00Z",
                },
                {
                    "Name": "other.mp4",
                    "Path": "other.mp4",
                    "IsDir": False,
                    "Size": 12,
                    "ModTime": "2024-01-01T12:00:01Z",
                },
            ])],
            "dropbox:movie.mp4": [SimulatedLsjsonResponse(items=[{
                "Name": "movie.mp4",
                "Path": "movie.mp4",
                "IsDir": False,
                "Size": 10,
            }])],
            "dropbox:other.mp4": [SimulatedLsjsonResponse(items=[{
                "Name": "other.mp4",
                "Path": "other.mp4",
                "IsDir": False,
                "Size": 12,
            }])],
        }, cat_data={
            "dropbox:movie.mp4": b"0123456789",
            "dropbox:other.mp4": b"abcdefghijkl",
        })
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
            first = server.post_json("/video/endpoints/session", {
                "path": "movie.mp4",
                "source": "remote",
            })
            second = server.post_json("/video/endpoints/session", {
                "path": "other.mp4",
                "source": "remote",
            })
            first_playlist = server.get_text(first["playlist_url"])
            with urlopen(server.base_url + first["asset_root"] + "segment_00000.m4s", timeout=5) as response:
                first_segment = response.read()
            second_playlist = server.get_text(second["playlist_url"])
            with urlopen(server.base_url + second["asset_root"] + "segment_00000.m4s", timeout=5) as response:
                second_segment = response.read()

        self.assertIn("#EXTM3U", first_playlist)
        self.assertEqual(first_segment, b"segment0")
        self.assertIn("#EXTM3U", second_playlist)
        self.assertEqual(second_segment, b"segment0")

    def test_session_stop_endpoint_cleans_up_requested_and_client_owned_sessions(self) -> None:
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[
                {
                    "Name": "movie.mp4",
                    "Path": "movie.mp4",
                    "IsDir": False,
                    "Size": 10,
                    "ModTime": "2024-01-01T12:00:00Z",
                },
                {
                    "Name": "other.mp4",
                    "Path": "other.mp4",
                    "IsDir": False,
                    "Size": 12,
                    "ModTime": "2024-01-01T12:00:01Z",
                },
            ])],
            "dropbox:movie.mp4": [SimulatedLsjsonResponse(items=[{
                "Name": "movie.mp4",
                "Path": "movie.mp4",
                "IsDir": False,
                "Size": 10,
            }])],
            "dropbox:other.mp4": [SimulatedLsjsonResponse(items=[{
                "Name": "other.mp4",
                "Path": "other.mp4",
                "IsDir": False,
                "Size": 12,
            }])],
        }, cat_data={
            "dropbox:movie.mp4": b"0123456789",
            "dropbox:other.mp4": b"abcdefghijkl",
        })
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
            first = server.post_json("/video/endpoints/session", {
                "path": "movie.mp4",
                "client_id": "client-old-page",
                "source": "remote",
            })
            second = server.post_json("/video/endpoints/session", {
                "path": "other.mp4",
                "client_id": "client-new-browser",
                "source": "remote",
            })
            stop_payload = server.post_json("/video/endpoints/session/stop", {
                "id": first["session_id"],
                "client_id": "client-old-page",
            })
            with self.assertRaises(HTTPError) as first_ctx:
                urlopen(server.base_url + first["asset_root"] + "segment_00000.m4s", timeout=5)
            second_playlist = server.get_text(second["playlist_url"])
            with urlopen(server.base_url + second["asset_root"] + "segment_00000.m4s", timeout=5) as response:
                second_segment = response.read()
            status_payload = server.get_json("/video/endpoints/status")
            client_stop_payload = server.post_json("/video/endpoints/session/stop", {
                "client_id": "client-new-browser",
            })
            status_after_client_stop = server.get_json("/video/endpoints/status")
            with self.assertRaises(HTTPError) as second_ctx:
                urlopen(server.base_url + second["asset_root"] + "segment_00000.m4s", timeout=5)
        self.assertEqual(stop_payload, {"status": "ok", "stopped": True})
        self.assertEqual(client_stop_payload, {"status": "ok", "stopped": True})
        self.assertEqual(first_ctx.exception.code, 404)
        self.assertEqual(second_ctx.exception.code, 404)
        self.assertIn("#EXTM3U", second_playlist)
        self.assertEqual(second_segment, b"segment0")
        self.assertEqual(len(status_payload["active_sessions"]), 1)
        self.assertEqual(status_payload["active_sessions"][0]["session_id"], second["session_id"])
        self.assertEqual(status_payload["active_sessions"][0]["client_id"], "client-new-browser")
        self.assertEqual(status_after_client_stop["active_sessions"], [])
        first_ctx.exception.close()
        second_ctx.exception.close()

    def test_client_stop_cancels_create_before_session_registration(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffprobe/bin/ffprobe.exe"),
            ),
        )
        probe_started = threading.Event()
        release_probe = threading.Event()
        create_result: dict[str, object] = {}

        def delayed_probe(*args, **kwargs):
            probe_started.set()
            release_probe.wait(2.0)
            return None

        def fake_popen(command, stdout=None, stderr=None, cwd=None, **kwargs):
            playlist_path = Path(command[-1])
            write_hls_session_fixture(playlist_path)
            return FakeFfmpegProcess(command)

        manager = video_session_manager(app)

        def run_create() -> None:
            try:
                create_result["payload"] = manager.create_session(
                    rel_path="movie.mp4",
                    base_url="http://127.0.0.1:8000",
                    file_size=10,
                    client_id="client-pending",
                    transition_token=4,
                )
            except BrowserError as exc:
                create_result["error"] = exc

        with patch("dropbox_browser.video.probe_remote_media", side_effect=delayed_probe), \
                patch("dropbox_browser.video.subprocess.Popen", side_effect=fake_popen):
            create_thread = threading.Thread(target=run_create)
            create_thread.start()
            self.assertTrue(probe_started.wait(1.0))
            stop_result = manager.stop_session(client_id="client-pending", transition_token=4)
            release_probe.set()
            create_thread.join(timeout=3.0)

        self.assertFalse(create_thread.is_alive())
        self.assertEqual(stop_result, {"status": "ok", "stopped": False})
        self.assertIsInstance(create_result.get("error"), BrowserError)
        error = create_result["error"]
        assert isinstance(error, BrowserError)
        self.assertEqual(error.status, HTTPStatus.CONFLICT)
        self.assertEqual(manager.session_status_payload()["active_sessions"], [])

    def test_stale_exact_stop_does_not_cancel_newer_pending_create(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffprobe/bin/ffprobe.exe"),
            ),
        )
        first_response_started = threading.Event()
        release_first_response = threading.Event()
        second_probe_started = threading.Event()
        release_second_probe = threading.Event()
        create_results: dict[str, object] = {}
        probe_call_count = 0
        probe_call_lock = threading.Lock()
        first_payload = True

        def delayed_probe(*args, **kwargs):
            nonlocal probe_call_count
            with probe_call_lock:
                probe_call_count += 1
                call_number = probe_call_count
            if call_number == 2:
                second_probe_started.set()
                release_second_probe.wait(2.0)
            return None

        def fake_popen(command, stdout=None, stderr=None, cwd=None, **kwargs):
            playlist_path = Path(command[-1])
            write_hls_session_fixture(playlist_path)
            return FakeFfmpegProcess(command)

        manager = video_session_manager(app)
        original_session_payload = manager._session_payload

        def delayed_first_response(session, **kwargs):
            nonlocal first_payload
            if first_payload:
                first_payload = False
                first_response_started.set()
                release_first_response.wait(2.0)
            return original_session_payload(session, **kwargs)

        def run_create(label: str, transition_token: int) -> None:
            try:
                create_results[label] = manager.create_session(
                    rel_path=f"{label}.mp4",
                    base_url="http://127.0.0.1:8000",
                    file_size=10,
                    client_id="client-stale-response",
                    transition_token=transition_token,
                )
            except BrowserError as exc:
                create_results[f"{label}_error"] = exc

        with patch("dropbox_browser.video.probe_remote_media", side_effect=delayed_probe), \
                patch("dropbox_browser.video.subprocess.Popen", side_effect=fake_popen), \
                patch.object(manager, "_session_payload", side_effect=delayed_first_response):
            first_thread = threading.Thread(target=run_create, args=("old", 1))
            second_thread = threading.Thread(target=run_create, args=("new", 2))
            first_thread.start()
            try:
                self.assertTrue(first_response_started.wait(1.0))
                active_sessions = manager.session_status_payload()["active_sessions"]
                self.assertEqual(len(active_sessions), 1)
                old_session_id = active_sessions[0]["session_id"]

                second_thread.start()
                self.assertTrue(second_probe_started.wait(1.0))
                release_first_response.set()
                first_thread.join(timeout=3.0)
                stop_result = manager.stop_session(
                    old_session_id,
                    client_id="client-stale-response",
                )
                release_second_probe.set()
                second_thread.join(timeout=3.0)
            finally:
                release_first_response.set()
                release_second_probe.set()
                first_thread.join(timeout=3.0)
                second_thread.join(timeout=3.0)

        self.assertFalse(first_thread.is_alive())
        self.assertFalse(second_thread.is_alive())
        self.assertEqual(stop_result, {"status": "ok", "stopped": True})
        self.assertIn("old", create_results)
        self.assertIn("new", create_results)
        self.assertNotIn("new_error", create_results)
        self.assertEqual(
            manager.session_status_payload()["active_sessions"][0]["path"],
            "new.mp4",
        )

    def test_stop_session_releases_registry_lock_before_waiting_for_ffmpeg_exit(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffprobe/bin/ffprobe.exe"),
            ),
        )
        release_wait = threading.Event()
        wait_started = threading.Event()

        def fake_popen(command, stdout=None, stderr=None, cwd=None, **kwargs):
            if not is_ffmpeg_hls_spawn(command):
                return FakeFfmpegProcess(command)
            playlist_path = Path(command[-1])
            write_hls_session_fixture(playlist_path)
            return BlockingWaitFakeFfmpegProcess(
                command,
                release_wait=release_wait,
                wait_started=wait_started,
            )

        with TestServer(app) as server, patch("dropbox_browser.video.subprocess.Popen", side_effect=fake_popen):
            payload = server.post_json("/video/endpoints/session", {
                "path": "movie.mp4",
                "source": "remote",
            })
            manager = video_session_manager(app)
            stop_result: dict[str, object] = {}
            status_result: dict[str, object] = {}

            def run_stop() -> None:
                stop_result.update(manager.stop_session(payload["session_id"]))

            def read_status() -> None:
                status_result.update(manager.session_status_payload())

            stop_thread = threading.Thread(target=run_stop)
            status_thread = threading.Thread(target=read_status)
            stop_thread.start()
            self.assertTrue(wait_started.wait(1.0))
            status_thread.start()
            status_thread.join(timeout=0.5)
            self.assertFalse(status_thread.is_alive())
            release_wait.set()
            stop_thread.join(timeout=1.0)
            self.assertFalse(stop_thread.is_alive())

        self.assertEqual(stop_result, {"status": "ok", "stopped": True})
        self.assertEqual(status_result["active_sessions"], [])
        self.assertEqual(status_result["session_count"], 0)

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

    def test_session_progress_endpoint_updates_active_session_playback_state(self) -> None:
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
            session_payload = server.post_json("/video/endpoints/session", {
                "path": "movie.mp4",
                "source": "remote",
            })
            progress_payload = server.post_json("/video/endpoints/session/progress", {
                "id": session_payload["session_id"],
                "playback_seconds": "123.5",
                "playback_media_seconds": "3.5",
                "playback_state": "paused",
                "playback_sync_token": "9",
            })
            status_payload = server.get_json("/video/endpoints/status")

        self.assertTrue(progress_payload["updated"])
        self.assertFalse(progress_payload["stale"])
        self.assertEqual(progress_payload["client_playback"]["reported_seconds"], 123.5)
        self.assertEqual(progress_payload["client_playback"]["media_seconds"], 3.5)
        self.assertEqual(progress_payload["client_playback"]["state"], "paused")
        self.assertEqual(progress_payload["client_playback"]["playback_sync_token"], 9)
        self.assertIsNotNone(progress_payload["client_playback"]["reported_at"])
        self.assertIsInstance(progress_payload["client_playback"]["reported_at_unix_ms"], int)
        active_session = status_payload["active_session"]
        assert active_session is not None
        self.assertEqual(active_session["client_playback"]["reported_seconds"], 123.5)
        self.assertEqual(active_session["client_playback"]["media_seconds"], 3.5)
        self.assertEqual(active_session["client_playback"]["state"], "paused")
        self.assertEqual(active_session["client_playback"]["playback_sync_token"], 9)

    def test_session_progress_endpoint_updates_the_named_session_after_another_session_exists(self) -> None:
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
            first = server.post_json("/video/endpoints/session", {
                "path": "movie.mp4",
                "source": "remote",
            })
            second = server.post_json("/video/endpoints/session", {
                "path": "movie.mp4",
                "source": "remote",
                "start_time_seconds": "12",
            })
            progress_payload = server.post_json("/video/endpoints/session/progress", {
                "id": first["session_id"],
                "playback_seconds": "13",
                "playback_state": "playing",
            })
            status_payload = server.get_json("/video/endpoints/status")

        self.assertTrue(progress_payload["updated"])
        self.assertFalse(progress_payload["stale"])
        self.assertEqual(progress_payload["session_id"], first["session_id"])
        self.assertEqual(progress_payload["client_playback"]["reported_seconds"], 13.0)
        self.assertEqual(progress_payload["client_playback"]["state"], "playing")
        active_session = status_payload["active_session"]
        assert active_session is not None
        self.assertEqual(active_session["session_id"], first["session_id"])
        self.assertEqual(active_session["client_playback"]["state"], "playing")
        self.assertEqual(active_session["client_playback"]["reported_seconds"], 13.0)

    def test_session_progress_endpoint_reports_stopped_state_for_stale_session(self) -> None:
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
            session_payload = server.post_json("/video/endpoints/session", {
                "path": "movie.mp4",
                "source": "remote",
            })
            server.post_json("/video/endpoints/session/stop", {
                "id": session_payload["session_id"],
            })
            progress_payload = server.post_json("/video/endpoints/session/progress", {
                "id": session_payload["session_id"],
                "playback_seconds": "13",
                "playback_state": "playing",
            })

        self.assertFalse(progress_payload["updated"])
        self.assertTrue(progress_payload["stale"])
        self.assertEqual(progress_payload["session_id"], session_payload["session_id"])
        self.assertEqual(progress_payload["session_state"], "stopped")
        self.assertEqual(progress_payload["session_state_message"], "Video session was stopped.")
        self.assertEqual(progress_payload["stale_reason"], "stopped")
        self.assertIsNone(progress_payload["active_session_id"])

    def test_session_progress_endpoint_reports_expired_state_for_stale_session(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffprobe/bin/ffprobe.exe"),
                session_idle_ttl_seconds=2.0,
            ),
        )

        def fake_popen(command, stdout=None, stderr=None, cwd=None, **kwargs):
            if not is_ffmpeg_hls_spawn(command):
                return FakeFfmpegProcess(command)
            playlist_path = Path(command[-1])
            write_hls_session_fixture(playlist_path)
            return FakeFfmpegProcess(command)

        with TestServer(app) as server, patch("dropbox_browser.video.subprocess.Popen", side_effect=fake_popen):
            session_payload = server.post_json("/video/endpoints/session", {
                "path": "movie.mp4",
                "source": "remote",
            })
            manager = video_session_manager(app)
            with manager._lock:
                session = manager._get_session_locked(session_payload["session_id"])
                assert session is not None
                session.last_accessed_at = time.time() - 3.0
            progress_payload = server.post_json("/video/endpoints/session/progress", {
                "id": session_payload["session_id"],
                "playback_seconds": "13",
                "playback_state": "playing",
            })

        self.assertFalse(progress_payload["updated"])
        self.assertTrue(progress_payload["stale"])
        self.assertEqual(progress_payload["session_id"], session_payload["session_id"])
        self.assertEqual(progress_payload["session_state"], "expired")
        self.assertEqual(progress_payload["session_state_message"], "Video session expired after being idle.")
        self.assertEqual(progress_payload["stale_reason"], "expired")
        self.assertIsNone(progress_payload["active_session_id"])

    def test_recently_playing_session_does_not_expire_when_last_access_is_stale(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffprobe/bin/ffprobe.exe"),
                session_idle_ttl_seconds=2.0,
            ),
        )

        def fake_popen(command, stdout=None, stderr=None, cwd=None, **kwargs):
            if not is_ffmpeg_hls_spawn(command):
                return FakeFfmpegProcess(command)
            playlist_path = Path(command[-1])
            write_hls_session_fixture(playlist_path)
            return FakeFfmpegProcess(command)

        with TestServer(app) as server, patch("dropbox_browser.video.subprocess.Popen", side_effect=fake_popen):
            session_payload = server.post_json("/video/endpoints/session", {
                "path": "movie.mp4",
                "source": "remote",
            })
            manager = video_session_manager(app)
            now = time.time()
            with manager._lock:
                session = manager._get_session_locked(session_payload["session_id"])
                assert session is not None
                session.last_accessed_at = now - 3.0
                session.reported_playback_state = "playing"
                session.reported_playback_updated_at = now - 1.0
            progress_payload = server.post_json("/video/endpoints/session/progress", {
                "id": session_payload["session_id"],
                "playback_seconds": "13",
                "playback_state": "playing",
            })

        self.assertTrue(progress_payload["updated"])
        self.assertFalse(progress_payload["stale"])
        self.assertEqual(progress_payload["session_id"], session_payload["session_id"])
        self.assertEqual(progress_payload["client_playback"]["state"], "playing")

    def test_session_progress_endpoint_reports_missing_state_for_unknown_session(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffprobe/bin/ffprobe.exe"),
            ),
        )

        with TestServer(app) as server:
            progress_payload = server.post_json("/video/endpoints/session/progress", {
                "id": "missing",
                "playback_seconds": "13",
                "playback_state": "playing",
            })

        self.assertFalse(progress_payload["updated"])
        self.assertTrue(progress_payload["stale"])
        self.assertEqual(progress_payload["session_id"], "missing")
        self.assertEqual(progress_payload["session_state"], "missing")
        self.assertEqual(progress_payload["session_state_message"], "Video session was not found.")
        self.assertEqual(progress_payload["stale_reason"], "missing")
        self.assertIsNone(progress_payload["active_session_id"])

    def test_session_asset_endpoint_reports_specific_removed_session_reason(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffprobe/bin/ffprobe.exe"),
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
            server.post_json("/video/endpoints/session/stop", {
                "id": payload["session_id"],
            })
            with self.assertRaises(HTTPError) as ctx:
                urlopen(server.base_url + payload["asset_root"] + "segment_00000.m4s", timeout=5)

        self.assertEqual(ctx.exception.code, 404)
        self.assertIn("Video session was stopped.", ctx.exception.read().decode("utf-8"))
        ctx.exception.close()

    def test_session_progress_endpoint_rejects_invalid_playback_state(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(rclone, local_root=None)

        with TestServer(app) as server:
            with self.assertRaises(HTTPError) as ctx:
                server.post_json("/video/endpoints/session/progress", {
                    "id": "missing",
                    "playback_seconds": "1",
                    "playback_state": "buffering",
                })

        self.assertEqual(ctx.exception.code, 400)
        ctx.exception.close()

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

    def test_session_endpoint_force_subtitle_burn_in_uses_subtitles_filter(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffprobe/bin/ffprobe.exe"),
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

        def fake_extract(ffmpeg_exe, input_url, output_path, *, subtitle_stream_index, start_time_seconds=0.0, timeout_seconds=60.0):
            Path(output_path).write_text("WEBVTT-LIKE-SRT\n", encoding="utf-8")
            return True

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
            patch(
                "dropbox_browser.video_burnin.extract_subtitle_stream_to_srt",
                side_effect=fake_extract,
            ),
        ):
            payload = server.post_json("/video/endpoints/session", {
                "path": "movie.mp4",
                "source": "remote",
                "subtitle_stream_index": "3",
                "force_subtitle_burn_in": "1",
                "subtitle_stroke_enabled": "1",
                "subtitle_shadow_enabled": "1",
                "subtitle_font_size_px": "32",
                "subtitle_offset_px": "6",
            })

            command = spawned[0].command
            filter_value = command[command.index("-filter_complex") + 1]
            self.assertIn("[0:v:0]subtitles=filename='burnin.srt'", filter_value)
            self.assertIn("Fontsize=32", filter_value)
            self.assertIn("MarginV=6", filter_value)
            self.assertIn("Shadow=2", filter_value)
            self.assertEqual(command[command.index("-map") + 1], "[vout]")
            self.assertEqual(payload["video_mode"], "video_transcode")

            # Without the flag, the same request keeps the legacy bitmap-overlay
            # burn-in path (still a transcode, but not the subtitles filter).
            payload_off = server.post_json("/video/endpoints/session", {
                "path": "movie.mp4",
                "source": "remote",
                "subtitle_stream_index": "3",
            })
            legacy_command = spawned[1].command
            self.assertNotIn("subtitles=", " ".join(legacy_command))
            self.assertIn("colorchannelmixer", " ".join(legacy_command))
            self.assertEqual(payload_off["video_mode"], "video_transcode")
            self.assertEqual(payload_off["video_mode_reason"], "subtitle_burn_in_requires_filter")

    def test_session_endpoint_force_subtitle_burn_in_extraction_failure_returns_service_unavailable(self) -> None:
        rclone = self._remote_media_rclone()
        app = self._build_app(
            rclone,
            local_root=None,
            video_tools_config=VideoToolsConfig(
                ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
                ffprobe_exe=Path("C:/tools/ffprobe/bin/ffprobe.exe"),
            ),
        )

        def fake_popen(command, stdout=None, stderr=None, cwd=None, **kwargs):
            return FakeFfmpegProcess(command)

        with (
            TestServer(app) as server,
            patch("dropbox_browser.video.probe_remote_media", return_value=None),
            patch("dropbox_browser.video.subprocess.Popen", side_effect=fake_popen),
            patch(
                "dropbox_browser.video_burnin.extract_subtitle_stream_to_srt",
                side_effect=RuntimeError("Subtitle burn-in extraction failed: boom"),
            ),
        ):
            with self.assertRaises(HTTPError) as error_ctx:
                server.post_json("/video/endpoints/session", {
                    "path": "movie.mp4",
                    "source": "remote",
                    "subtitle_stream_index": "3",
                    "force_subtitle_burn_in": "1",
                })

        self.assertEqual(error_ctx.exception.code, HTTPStatus.SERVICE_UNAVAILABLE)

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

        # Patch the priority helper instead of os.name: swapping os.name to "nt" on
        # POSIX makes pathlib.Path try to construct WindowsPath and breaks the suite.
        with (
            TestServer(app) as server,
            patch(
                "dropbox_browser.video.ffmpeg_popen_kwargs_for_priority",
                return_value={"creationflags": 64},
            ),
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
        filter_graph = spawned[0].command[spawned[0].command.index("-filter_complex") + 1]
        self.assertIn("[0:4]format=rgba,split=6[sub_main][sub_shadow_src][sub_stroke_left_src][sub_stroke_right_src][sub_stroke_up_src][sub_stroke_down_src]", filter_graph)
        self.assertIn("colorchannelmixer=rr=0:gg=0:bb=0:aa=0.85[sub_shadow]", filter_graph)
        self.assertIn("[sub_stroke_left_src]colorchannelmixer=rr=0:gg=0:bb=0:aa=0.9[sub_stroke_left]", filter_graph)
        self.assertIn("[0:v:0][sub_stroke_left]overlay=-1:0[tmp1]", filter_graph)
        self.assertIn("[tmp4][sub_shadow]overlay=2:2[tmp5]", filter_graph)
        self.assertIn("[tmp5][sub_main]overlay[vout]", filter_graph)
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
            file_size=10,
            session_dir=session_dir,
            playlist_path=playlist_path,
            process=FakeFfmpegProcess([]),
            command=[],
            created_at=time.time(),
            create_started_at=time.monotonic(),
            last_accessed_at=time.time(),
            client_id="",
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

    def test_build_ffmpeg_hls_command_uses_extra_video_filter_when_forced_burnin(self) -> None:
        command = build_ffmpeg_hls_command(
            Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
            "http://127.0.0.1:8000/file?path=movie.mkv&source=remote",
            Path("E:/dev/dropbox_browser/Temp/video_sessions/test/stream.m3u8"),
            segment_base_url="/video/endpoints/session/file?id=test&name=",
            subtitle_stream_index=3,
            extra_video_filter="subtitles=filename='burnin.srt'",
        )

        filter_index = command.index("-filter_complex")
        filter_value = command[filter_index + 1]
        self.assertIn("[0:v:0]subtitles=filename='burnin.srt'[vout]", filter_value)
        self.assertEqual(command[command.index("-map") + 1], "[vout]")
        # Forced burn-in always stays on the transcode path.
        self.assertIn("libx264", command)

    def test_build_ffmpeg_hls_command_without_extra_filter_unchanged(self) -> None:
        command = build_ffmpeg_hls_command(
            Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
            "http://127.0.0.1:8000/file?path=movie.mkv&source=remote",
            Path("E:/dev/dropbox_browser/Temp/video_sessions/test/stream.m3u8"),
            segment_base_url="/video/endpoints/session/file?id=test&name=",
        )
        self.assertIn("0:v:0", command)
        self.assertNotIn("subtitles=", " ".join(command))

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
        filter_graph = command[command.index("-filter_complex") + 1]
        self.assertIn("[0:4]format=rgba,split=6[sub_main][sub_shadow_src][sub_stroke_left_src][sub_stroke_right_src][sub_stroke_up_src][sub_stroke_down_src]", filter_graph)
        self.assertIn("colorchannelmixer=rr=0:gg=0:bb=0:aa=0.85[sub_shadow]", filter_graph)
        self.assertIn("[sub_stroke_left_src]colorchannelmixer=rr=0:gg=0:bb=0:aa=0.9[sub_stroke_left]", filter_graph)
        self.assertIn("[0:v:0][sub_stroke_left]overlay=-1:0[tmp1]", filter_graph)
        self.assertIn("[tmp4][sub_shadow]overlay=2:2[tmp5]", filter_graph)
        self.assertIn("[tmp5][sub_main]overlay[vout]", filter_graph)
        self.assertIn("[vout]", command)
        self.assertNotIn("0:v:0", [item for item in command if item == "0:v:0"])
        self.assertIn("0:5?", command)
        self.assertIn("-sn", command)
        self.assertEqual(command[command.index("-c:v") + 1], "libx264")

    def test_build_ffmpeg_hls_command_can_disable_burned_in_subtitle_stroke(self) -> None:
        command = build_ffmpeg_hls_command(
            Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
            "http://127.0.0.1:8000/file?path=movie.mkv&source=remote",
            Path("E:/dev/dropbox_browser/Temp/video_sessions/test/stream.m3u8"),
            segment_base_url="/video/endpoints/session/file?id=test&name=",
            subtitle_stream_index=4,
            subtitle_stroke_enabled=False,
        )

        filter_graph = command[command.index("-filter_complex") + 1]
        self.assertIn("[0:4]format=rgba,split=2[sub_main][sub_shadow_src]", filter_graph)
        self.assertNotIn("sub_stroke_left", filter_graph)
        self.assertIn("[0:v:0][sub_shadow]overlay=2:2[tmp]", filter_graph)
        self.assertIn("[tmp][sub_main]overlay[vout]", filter_graph)

    def test_build_ffmpeg_hls_command_can_disable_burned_in_subtitle_shadow(self) -> None:
        command = build_ffmpeg_hls_command(
            Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
            "http://127.0.0.1:8000/file?path=movie.mkv&source=remote",
            Path("E:/dev/dropbox_browser/Temp/video_sessions/test/stream.m3u8"),
            segment_base_url="/video/endpoints/session/file?id=test&name=",
            subtitle_stream_index=4,
            subtitle_shadow_enabled=False,
        )

        filter_graph = command[command.index("-filter_complex") + 1]
        self.assertIn(
            "[0:4]format=rgba,split=5[sub_main][sub_stroke_left_src][sub_stroke_right_src][sub_stroke_up_src][sub_stroke_down_src]",
            filter_graph,
        )
        self.assertNotIn("sub_shadow", filter_graph)
        self.assertIn("[tmp4][sub_main]overlay[vout]", filter_graph)

    def test_build_ffmpeg_hls_command_can_disable_burned_in_subtitle_shadow_and_stroke(self) -> None:
        command = build_ffmpeg_hls_command(
            Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
            "http://127.0.0.1:8000/file?path=movie.mkv&source=remote",
            Path("E:/dev/dropbox_browser/Temp/video_sessions/test/stream.m3u8"),
            segment_base_url="/video/endpoints/session/file?id=test&name=",
            subtitle_stream_index=4,
            subtitle_stroke_enabled=False,
            subtitle_shadow_enabled=False,
        )

        filter_graph = command[command.index("-filter_complex") + 1]
        self.assertEqual(filter_graph, "[0:4]format=rgba[sub_main];[0:v:0][sub_main]overlay[vout]")

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

    def test_build_subtitle_cache_key_changes_for_cache_versions(self) -> None:
        full_key = build_subtitle_cache_key(
            rel_path="movie.mp4",
            subtitle_stream_index=3,
            file_size=10,
            cache_version=SUBTITLE_CACHE_VERSION,
        )
        previous_full_key = build_subtitle_cache_key(
            rel_path="movie.mp4",
            subtitle_stream_index=3,
            file_size=10,
            cache_version="webvtt-v1",
        )
        window_key = build_subtitle_cache_key(
            rel_path="movie.mp4",
            subtitle_stream_index=3,
            file_size=10,
            window_start_seconds=0.0,
            window_duration_seconds=300.0,
            cache_version=SUBTITLE_WINDOW_CACHE_VERSION,
        )
        previous_window_key = build_subtitle_cache_key(
            rel_path="movie.mp4",
            subtitle_stream_index=3,
            file_size=10,
            window_start_seconds=0.0,
            window_duration_seconds=300.0,
            cache_version="webvtt-window-v1",
        )
        manifest_key = build_subtitle_window_manifest_key(
            rel_path="movie.mp4",
            subtitle_stream_index=3,
            file_size=10,
            cache_version=SUBTITLE_WINDOW_MANIFEST_VERSION,
        )
        previous_manifest_key = build_subtitle_window_manifest_key(
            rel_path="movie.mp4",
            subtitle_stream_index=3,
            file_size=10,
            cache_version="webvtt-window-manifest-v1",
        )

        self.assertNotEqual(full_key, previous_full_key)
        self.assertNotEqual(window_key, previous_window_key)
        self.assertNotEqual(manifest_key, previous_manifest_key)

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

    def test_extract_remote_subtitles_to_webvtt_accepts_subtitle_stream_index_zero(self) -> None:
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
                output_path.write_text("WEBVTT\n\n00:00.000 --> 00:01.000\nTrack zero\n", encoding="utf-8")
                return CompletedProcess(command, 0, b"", b"")
            if command and command[-1] == "-":
                input_path = Path(command[command.index("-i") + 1])
                return CompletedProcess(command, 0, input_path.read_bytes(), b"")
            return CompletedProcess(command, 0, b"", b"")

        with patch("dropbox_browser.video.subprocess.run", side_effect=fake_subprocess):
            body, language = extract_remote_subtitles_to_webvtt(
                app,
                rel_path="movie.mp4",
                subtitle_stream_index=0,
                base_url="http://127.0.0.1:8000",
                file_size=10,
            )

        self.assertIn(b"WEBVTT", body)
        self.assertIn(b"Track zero", body)
        self.assertEqual(language, "eng")

    def test_extract_remote_subtitle_window_to_webvtt_accepts_subtitle_stream_index_zero(self) -> None:
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
                    "codec_type": "subtitle",
                    "codec_name": "ass",
                    "tags": {"language": "eng", "title": "English"},
                    "disposition": {"default": 1, "forced": 0},
                },
            ],
            "format": {"duration": "12.0"},
        }

        def fake_subprocess(command, stdout=None, stderr=None, check=False, timeout=None):
            if "ffprobe" in command[0]:
                return CompletedProcess(command, 0, json.dumps(ffprobe_payload).encode("utf-8"), b"")
            if "-c:s" in command and "copy" in command:
                output_path = Path(command[-1])
                output_path.write_text(
                    "WEBVTT\n\n"
                    "00:00.500 --> 00:01.500\nZero overlap\n\n"
                    "00:01.500 --> 00:03.000\nZero inside\n",
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
                subtitle_stream_index=0,
                base_url="http://127.0.0.1:8000",
                file_size=10,
                window_start_seconds=1.0,
                window_duration_seconds=4.0,
            )

        self.assertEqual(payload["track"], 0)
        self.assertEqual(payload["language"], "eng")
        self.assertIn("Zero overlap", payload["vtt"])
        self.assertIn("Zero inside", payload["vtt"])

    def test_extract_remote_subtitles_to_webvtt_cleans_ass_content(self) -> None:
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
                    "[Events]\n"
                    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
                    "Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\pos(1210,94)\\frz3.2}Logo\n"
                    "Dialogue: 0,0:00:03.00,0:00:04.50,Default,,0,0,0,,{\\p1}m 0 0 l 50 0 50 20 0 20{\\p0}\n"
                    "Dialogue: 0,0:00:05.00,0:00:07.00,Default,,0,0,0,,First line\\NSecond line\n",
                    encoding="utf-8",
                )
                return CompletedProcess(command, 0, b"", b"")
            if command and command[-1] == "-":
                input_path = Path(command[command.index("-i") + 1])
                return CompletedProcess(command, 0, input_path.read_bytes(), b"")
            return CompletedProcess(command, 0, b"", b"")

        with patch("dropbox_browser.video.subprocess.run", side_effect=fake_subprocess):
            body, language = extract_remote_subtitles_to_webvtt(
                app,
                rel_path="movie.mp4",
                subtitle_stream_index=3,
                base_url="http://127.0.0.1:8000",
                file_size=10,
            )

        text = body.decode("utf-8")
        self.assertEqual(language, "eng")
        self.assertIn("Logo", text)
        self.assertIn("First line\nSecond line", text)
        self.assertNotIn("pos(", text)
        self.assertNotIn("frz", text)
        self.assertNotIn("m 0 0 l 50 0 50 20 0 20", text)

    def test_extract_remote_subtitle_window_to_webvtt_uses_same_ass_cleanup(self) -> None:
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
                    "[Events]\n"
                    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
                    "Dialogue: 0,0:00:00.50,0:00:01.50,Default,,0,0,0,,{\\pos(1210,94)}Logo\n"
                    "Dialogue: 0,0:00:01.50,0:00:02.50,Default,,0,0,0,,{\\p1}m 0 0 l 50 0 50 20 0 20{\\p0}\n"
                    "Dialogue: 0,0:00:02.50,0:00:04.00,Default,,0,0,0,,{*}Mine and Mine Alone{*All Mine}\n",
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
                window_start_seconds=0.0,
                window_duration_seconds=4.0,
            )

        self.assertEqual(payload["language"], "eng")
        self.assertIn("Logo", payload["vtt"])
        self.assertIn("Mine and Mine Alone", payload["vtt"])
        self.assertNotIn("pos(", payload["vtt"])
        self.assertNotIn("{*", payload["vtt"])
        self.assertNotIn("m 0 0 l 50 0 50 20 0 20", payload["vtt"])

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
        self.assertEqual(first_payload["status"], second_payload["status"])
        self.assertEqual(first_payload["track"], second_payload["track"])
        self.assertEqual(first_payload["window_status"], second_payload["window_status"])
        self.assertEqual(first_payload["window_start_seconds"], second_payload["window_start_seconds"])
        self.assertEqual(first_payload["window_end_seconds"], second_payload["window_end_seconds"])
        self.assertEqual(first_payload["coverage_complete"], second_payload["coverage_complete"])
        self.assertEqual(first_payload["loaded_ranges"], [{"start_seconds": 4.0, "end_seconds": 8.0}])
        self.assertEqual(second_payload["loaded_ranges"], [{"start_seconds": 4.0, "end_seconds": 8.0}])
        self.assertEqual(first_payload["gap_action"], second_payload["gap_action"])
        self.assertEqual(first_payload["language"], second_payload["language"])
        self.assertEqual(first_payload["path"], second_payload["path"])
        self.assertEqual(first_payload["file_size"], second_payload["file_size"])
        self.assertEqual(run_mock.call_count, 2)

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
        self.assertEqual(results[0]["status"], results[1]["status"])
        self.assertEqual(results[0]["track"], results[1]["track"])
        self.assertEqual(results[0]["window_status"], results[1]["window_status"])
        self.assertEqual(results[0]["window_start_seconds"], results[1]["window_start_seconds"])
        self.assertEqual(results[0]["window_end_seconds"], results[1]["window_end_seconds"])
        self.assertEqual(results[0]["loaded_ranges"], [{"start_seconds": 4.0, "end_seconds": 8.0}])
        self.assertEqual(results[0]["gap_action"], results[1]["gap_action"])
        self.assertEqual(results[0]["language"], results[1]["language"])
        self.assertEqual(results[0]["path"], results[1]["path"])
        self.assertEqual(results[0]["file_size"], results[1]["file_size"])

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

        def fake_subprocess(command, stdout=None, stderr=None, check=False, timeout=None):
            if "ffprobe" in command[0]:
                return CompletedProcess(command, 0, json.dumps(ffprobe_payload).encode("utf-8"), b"")
            if "-c:s" in command and "copy" in command:
                Path(command[-1]).write_text(
                    "[Events]\n"
                    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
                    "Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Hello\n",
                    encoding="utf-8",
                )
                return CompletedProcess(command, 0, b"", b"")
            if command and command[-1] == "-":
                return CompletedProcess(command, 0, b"WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n", b"")
            return CompletedProcess(command, 0, b"", b"")

        with (
            TestServer(app) as server,
            patch(
                "dropbox_browser.video.subprocess.run",
                side_effect=fake_subprocess,
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

        def fake_subprocess(command, stdout=None, stderr=None, check=False, timeout=None):
            if "ffprobe" in command[0]:
                return CompletedProcess(command, 0, json.dumps(ffprobe_payload).encode("utf-8"), b"")
            if "-c:s" in command and "copy" in command:
                Path(command[-1]).write_text(
                    "[Events]\n"
                    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
                    "Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Hello\n",
                    encoding="utf-8",
                )
                return CompletedProcess(command, 0, b"", b"")
            if command and command[-1] == "-":
                return CompletedProcess(command, 0, vtt_body, b"")
            return CompletedProcess(command, 0, b"", b"")

        with (
            TestServer(app) as server,
            patch(
                "dropbox_browser.video.subprocess.run",
                side_effect=fake_subprocess,
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
            self.assertEqual(mock_run.call_count, 2)

    def test_subtitles_endpoint_ignores_stale_cache_from_previous_version(self) -> None:
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
        cache_dir = self.temp_dir / "subtitle_cache"
        old_cache_key = build_subtitle_cache_key(
            rel_path="movie.mp4",
            subtitle_stream_index=3,
            file_size=10,
            cache_version="webvtt-v1",
        )
        old_cache_path = subtitle_cache_path(old_cache_key, cache_dir=cache_dir)
        old_cache_path.parent.mkdir(parents=True, exist_ok=True)
        old_cache_path.write_bytes(
            b"WEBVTT\n\n00:00.000 --> 00:01.000\nSTALE RAW {\\pos(10,10)}TEXT\n"
        )
        new_cache_key = build_subtitle_cache_key(
            rel_path="movie.mp4",
            subtitle_stream_index=3,
            file_size=10,
            cache_version=SUBTITLE_CACHE_VERSION,
        )
        new_cache_path = subtitle_cache_path(new_cache_key, cache_dir=cache_dir)

        def fake_subprocess(command, stdout=None, stderr=None, check=False, timeout=None):
            if "ffprobe" in Path(command[0]).name.lower():
                return CompletedProcess(command, 0, json.dumps(ffprobe_payload).encode("utf-8"), b"")
            if "-c:s" in command and "copy" in command:
                Path(command[-1]).write_text(
                    "[Events]\n"
                    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
                    "Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,{\\pos(1210,94)}Fresh text\n",
                    encoding="utf-8",
                )
                return CompletedProcess(command, 0, b"", b"")
            if command and command[-1] == "-":
                input_path = Path(command[command.index("-i") + 1])
                return CompletedProcess(command, 0, input_path.read_bytes(), b"")
            return CompletedProcess(command, 0, b"", b"")

        with (
            TestServer(app) as server,
            patch("dropbox_browser.video.subprocess.run", side_effect=fake_subprocess) as mock_run,
            patch("dropbox_browser.video.SUBTITLE_CACHE_DIR", cache_dir),
        ):
            url = server.base_url + "/video/endpoints/subtitles?path=movie.mp4&source=remote&track=3"
            with urlopen(url, timeout=5) as response:
                body = response.read()

        self.assertEqual(mock_run.call_count, 2)
        self.assertTrue(old_cache_path.exists())
        self.assertTrue(new_cache_path.exists())
        self.assertIn(b"Fresh text", body)
        self.assertNotIn(b"STALE RAW", body)
        self.assertNotIn(b"pos(", body)

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
                            "[Events]\n"
                            "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
                            f"Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Track {index}\n",
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
        self.assertEqual(mock_run.call_count, 2)
        ffmpeg_calls = [
            call.args[0]
            for call in mock_run.call_args_list
            if Path(call.args[0][0]).name.lower().startswith("ffmpeg")
        ]
        self.assertEqual(len(ffmpeg_calls), 1)
        self.assertIn("0:3", ffmpeg_calls[0])
        self.assertIn("0:4", ffmpeg_calls[0])
        self.assertIn("-c:s", ffmpeg_calls[0])
        self.assertIn("copy", ffmpeg_calls[0])

    def test_extract_all_remote_subtitles_to_webvtt_keeps_subtitle_stream_index_zero_in_batch_mode(self) -> None:
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
                for index, arg in enumerate(command):
                    if arg == "copy" and index + 1 < len(command):
                        Path(command[index + 1]).write_text(
                            "WEBVTT\n\n00:00.000 --> 00:01.000\nTrack zero batch\n",
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
            payload = extract_all_remote_subtitles_to_webvtt(
                app,
                rel_path="movie.mp4",
                base_url="http://127.0.0.1:8000",
                file_size=10,
            )

        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["tracks"]["0"]["language"], "eng")
        self.assertIn("Track zero batch", payload["tracks"]["0"]["vtt"])

    def test_extract_all_remote_subtitles_to_webvtt_keeps_subtitle_stream_index_zero_in_fallback_mode(self) -> None:
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
                map_count = sum(1 for value in command if value == "-map")
                if map_count > 1:
                    return CompletedProcess(command, 1, b"", b"batch failed")
                output_path = Path(command[-1])
                output_path.write_text(
                    "WEBVTT\n\n00:00.000 --> 00:01.000\nTrack zero fallback\n",
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
            payload = extract_all_remote_subtitles_to_webvtt(
                app,
                rel_path="movie.mp4",
                base_url="http://127.0.0.1:8000",
                file_size=10,
            )

        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["tracks"]["0"]["language"], "eng")
        self.assertIn("Track zero fallback", payload["tracks"]["0"]["vtt"])

    def test_subtitle_codec_supports_webvtt_rejects_bitmap_codecs(self) -> None:
        self.assertTrue(subtitle_codec_supports_webvtt("ass"))
        self.assertFalse(subtitle_codec_supports_webvtt("hdmv_pgs_subtitle"))

    def test_convert_ass_text_to_webvtt_preserves_plain_dialogue(self) -> None:
        body = convert_ass_text_to_webvtt(
            """[Script Info]
Title: Simple

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,40,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,0,2,20,20,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hello there
Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,How are you?
"""
        )
        self.assertIn(b"WEBVTT", body)
        self.assertIn(b"00:01.000 --> 00:03.000", body)
        self.assertIn(b"Hello there", body)
        self.assertIn(b"How are you?", body)

    def test_convert_ass_text_to_webvtt_drops_pure_drawing_cues(self) -> None:
        body = convert_ass_text_to_webvtt(
            """[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\p1}m 0 0 l 50 0 50 20 0 20{\\p0}
"""
        )
        self.assertEqual(body, b"WEBVTT\n\n")

    def test_convert_ass_text_to_webvtt_keeps_readable_text_from_complex_cues(self) -> None:
        body = convert_ass_text_to_webvtt(
            """[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:49.00,0:00:51.00,Default,,0,0,0,,{\\pos(1210,94)\\frz3.2}Logo
"""
        )
        self.assertIn(b"Logo", body)
        self.assertNotIn(b"pos(", body)
        self.assertNotIn(b"frz", body)

    def test_convert_ass_text_to_webvtt_strips_tags_and_literal_brace_markup(self) -> None:
        body = convert_ass_text_to_webvtt(
            """[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:23:47.00,0:23:49.00,Default,,0,0,0,,{\\fad(100,250)\\t(0,500,\\frz-4)}Mine and Mine Alone{*All Mine}
"""
        )
        self.assertIn(b"Mine and Mine Alone", body)
        self.assertNotIn(b"fad(", body)
        self.assertNotIn(b"frz", body)
        self.assertNotIn(b"{*", body)

    def test_convert_ass_text_to_webvtt_preserves_ass_line_breaks(self) -> None:
        body = convert_ass_text_to_webvtt(
            """[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:12.00,0:00:14.00,Default,,0,0,0,,First line\\NSecond line
"""
        )
        self.assertIn(b"First line\nSecond line", body)

    def test_convert_ass_text_to_webvtt_preserves_basic_style_tags(self) -> None:
        body = convert_ass_text_to_webvtt(
            """[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:12.00,0:00:14.00,Default,,0,0,0,,{\\i1}Italic{\\i0} {\\b1}Bold{\\b0} {\\u1}Underline{\\u0}
"""
        )
        self.assertIn(b"<i>Italic</i>", body)
        self.assertIn(b"<b>Bold</b>", body)
        self.assertIn(b"<u>Underline</u>", body)

    def test_convert_ass_text_to_webvtt_resets_simple_styles(self) -> None:
        body = convert_ass_text_to_webvtt(
            """[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:12.00,0:00:14.00,Default,,0,0,0,,{\\i1\\b1}Styled{\\r} Plain
"""
        )
        text = body.decode("utf-8")
        self.assertIn("<b><i>Styled</i></b>", text)
        self.assertIn("Plain", text)
        self.assertNotIn("<i>Plain</i>", text)

    def test_convert_subtitle_file_to_webvtt_converts_subrip_fixture(self) -> None:
        subtitle_path = self.temp_dir / "fixture.srt"
        subtitle_path.parent.mkdir(parents=True, exist_ok=True)
        subtitle_path.write_text(
            "1\n00:00:01,000 --> 00:00:03,000\nHello from SRT\n",
            encoding="utf-8",
        )

        def fake_subprocess(command, stdout=None, stderr=None, check=False, timeout=None):
            self.assertEqual(Path(command[command.index("-i") + 1]), subtitle_path)
            return CompletedProcess(command, 0, b"WEBVTT\n\n00:01.000 --> 00:03.000\nHello from SRT\n", b"")

        with patch("dropbox_browser.video.subprocess.run", side_effect=fake_subprocess) as run_mock:
            body = _convert_subtitle_file_to_webvtt(Path("C:/tools/ffmpeg/bin/ffmpeg.exe"), subtitle_path)

        self.assertEqual(run_mock.call_count, 1)
        self.assertIn(b"WEBVTT", body)
        self.assertIn(b"Hello from SRT", body)

    def test_convert_subtitle_file_to_webvtt_passthrough_webvtt_fixture(self) -> None:
        subtitle_path = self.temp_dir / "fixture.vtt"
        subtitle_path.parent.mkdir(parents=True, exist_ok=True)
        subtitle_path.write_text(
            "WEBVTT\n\n00:01.000 --> 00:03.000\nHello from VTT\n",
            encoding="utf-8",
        )

        with patch("dropbox_browser.video.subprocess.run") as run_mock:
            body = _convert_subtitle_file_to_webvtt(Path("C:/tools/ffmpeg/bin/ffmpeg.exe"), subtitle_path)

        self.assertEqual(run_mock.call_count, 0)
        self.assertEqual(body, subtitle_path.read_bytes())

    def test_convert_subtitle_file_to_webvtt_converts_ass_fixture(self) -> None:
        subtitle_path = self.temp_dir / "fixture.ass"
        subtitle_path.parent.mkdir(parents=True, exist_ok=True)
        subtitle_path.write_text(
            "[Events]\n"
            "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
            "Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\i1}Hello{\\i0} {\\p1}m 0 0 l 1 1{\\p0}\n",
            encoding="utf-8",
        )

        with patch("dropbox_browser.video.subprocess.run") as run_mock:
            body = _convert_subtitle_file_to_webvtt(Path("C:/tools/ffmpeg/bin/ffmpeg.exe"), subtitle_path)

        self.assertEqual(run_mock.call_count, 0)
        self.assertIn(b"WEBVTT", body)
        self.assertIn(b"<i>Hello</i>", body)
        self.assertNotIn(b"m 0 0 l 1 1", body)

    def test_extract_remote_subtitles_to_webvtt_rejects_bitmap_fixture(self) -> None:
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
                    "index": 6,
                    "codec_type": "subtitle",
                    "codec_name": "hdmv_pgs_subtitle",
                    "tags": {"language": "eng", "title": "PGS"},
                    "disposition": {"default": 0, "forced": 0},
                },
            ],
            "format": {"duration": "15.0"},
        }

        with patch(
            "dropbox_browser.video.subprocess.run",
            return_value=CompletedProcess(["ffprobe"], 0, json.dumps(ffprobe_payload).encode("utf-8"), b""),
        ):
            with self.assertRaises(BrowserError) as ctx:
                extract_remote_subtitles_to_webvtt(
                    app,
                    rel_path="movie.mp4",
                    subtitle_stream_index=6,
                    base_url="http://127.0.0.1:8000",
                    file_size=10,
                )

        self.assertEqual(ctx.exception.status, HTTPStatus.BAD_REQUEST)
        self.assertIn("cannot be converted to WebVTT", str(ctx.exception))

    def test_extract_remote_subtitles_to_webvtt_logs_ass_conversion_debug_when_enabled(self) -> None:
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
                Path(command[-1]).write_text(
                    "[Events]\n"
                    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
                    "Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,{\\pos(12,18)}{\\i1}Debug text{\\i0}{\\p1}m 0 0 l 1 1{\\p0}\n",
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
            body, language = extract_remote_subtitles_to_webvtt(
                app,
                rel_path="movie.mp4",
                subtitle_stream_index=3,
                base_url="http://127.0.0.1:8000",
                file_size=10,
            )

        self.assertEqual(language, "eng")
        self.assertIn(b"Debug text", body)
        records = [
            json.loads(line)
            for line in debug_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        event = next(row for row in records if row.get("event") == "subtitle_conversion_debug")
        self.assertEqual(event["rel_path"], "movie.mp4")
        self.assertEqual(event["subtitle_stream_index"], 3)
        self.assertEqual(event["codec_name"], "ass")
        self.assertEqual(event["conversion_mode"], "ass_parser")
        self.assertIn("{\\pos(12,18)}", event["raw_subtitle_text"])
        self.assertIn("\\p1", event["raw_subtitle_text"])
        self.assertIn("<i>Debug text</i>", event["converted_webvtt_text"])
        self.assertNotIn("m 0 0 l 1 1", event["converted_webvtt_text"])

    def test_extract_remote_subtitles_to_webvtt_logs_bitmap_rejection_when_enabled(self) -> None:
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

        debug_path = self.temp_dir / "video_debug.jsonl"
        with (
            patch(
                "dropbox_browser.video.subprocess.run",
                return_value=CompletedProcess(["ffprobe"], 0, json.dumps(ffprobe_payload).encode("utf-8"), b""),
            ),
            patch("dropbox_browser.video.VIDEO_DEBUG_LOG_PATH", debug_path),
        ):
            with self.assertRaises(BrowserError):
                extract_remote_subtitles_to_webvtt(
                    app,
                    rel_path="movie.mp4",
                    subtitle_stream_index=6,
                    base_url="http://127.0.0.1:8000",
                    file_size=10,
                )

        records = [
            json.loads(line)
            for line in debug_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        event = next(row for row in records if row.get("event") == "subtitle_track_rejected_for_webvtt")
        self.assertEqual(event["rel_path"], "movie.mp4")
        self.assertEqual(event["subtitle_stream_index"], 6)
        self.assertEqual(event["codec_name"], "hdmv_pgs_subtitle")
        self.assertEqual(event["reason"], "subtitle_track_cannot_be_converted_to_webvtt")

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
