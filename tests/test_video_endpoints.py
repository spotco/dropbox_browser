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
    VideoHlsSession,
    build_ffmpeg_batch_webvtt_command,
    build_ffmpeg_hls_command,
    build_ffmpeg_webvtt_command,
    build_ffprobe_command,
    build_probe_cache_key,
    DEFAULT_PROBE_ANALYZE_DURATION_US,
    DEFAULT_PROBE_PROBE_SIZE_BYTES,
    build_subtitle_cache_key,
    _playlist_ready_for_playback,
    _playlist_segment_names,
    probe_cache_path,
    rebase_webvtt_text,
    subtitle_cache_path,
    subtitle_codec_supports_webvtt,
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


class FakeFfmpegProcess:
    def __init__(self, command: list[str]) -> None:
        self.command = command
        self.stdout = None
        self.stderr = io.BytesIO()
        self.returncode = None
        self.killed = False

    def poll(self):
        return self.returncode

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
        self.assertEqual(payload["subtitle_streams"][0]["codec_name"], "ass")
        self.assertTrue(payload["subtitle_streams"][0]["webvtt_compatible"])
        self.assertTrue(payload["subtitle_streams"][0]["forced"])
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
        self.assertEqual(len(run_calls), 1)
        cache_path = probe_cache_path(build_probe_cache_key("movie.mp4", file_size=10))
        self.assertTrue(cache_path.is_file())

    def test_probe_cache_key_changes_when_file_size_changes(self) -> None:
        self.assertNotEqual(
            build_probe_cache_key("movie.mp4", file_size=10),
            build_probe_cache_key("movie.mp4", file_size=11),
        )

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
                    json.dumps(ffprobe_payload).encode("utf-8") if "ffprobe" in Path(cmd[0]).name.lower() else vtt_body,
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

        def fake_popen(command, stdout=None, stderr=None, cwd=None):
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

        def fake_popen(command, stdout=None, stderr=None, cwd=None):
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

        def fake_popen(command, stdout=None, stderr=None, cwd=None):
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

        def fake_popen(command, stdout=None, stderr=None, cwd=None):
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

        def fake_popen(command, stdout=None, stderr=None, cwd=None):
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

        def fake_popen(command, stdout=None, stderr=None, cwd=None):
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

        def fake_popen(command, stdout=None, stderr=None, cwd=None):
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

        def fake_popen(command, stdout=None, stderr=None, cwd=None):
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

    def test_build_ffmpeg_hls_command_burns_in_selected_bitmap_subtitle_stream(self) -> None:
        command = build_ffmpeg_hls_command(
            Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
            "http://127.0.0.1:8000/file?path=movie.mkv&source=remote",
            Path("E:/dev/dropbox_browser/Temp/video_sessions/test/stream.m3u8"),
            segment_base_url="/video/endpoints/session/file?id=test&name=",
            audio_stream_index=5,
            subtitle_stream_index=4,
            start_time_seconds=12.5,
        )

        self.assertLess(command.index("-ss"), command.index("-i"))
        self.assertIn("-filter_complex", command)
        self.assertIn("[0:v:0][0:4]overlay[vout]", command)
        self.assertIn("[vout]", command)
        self.assertNotIn("0:v:0", [item for item in command if item == "0:v:0"])
        self.assertIn("0:5?", command)
        self.assertIn("-sn", command)

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
            self.assertEqual(mock_run.call_count, 2)

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
            for index, arg in enumerate(command):
                if arg == "webvtt" and index + 1 < len(command) and command[index + 1] != "-":
                    Path(command[index + 1]).write_text(
                        f"WEBVTT\n\n00:00.000 --> 00:01.000\nTrack {index}\n",
                        encoding="utf-8",
                    )
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
            for index, arg in enumerate(command):
                if arg == "webvtt" and index + 1 < len(command) and command[index + 1] != "-":
                    Path(command[index + 1]).write_text(
                        "WEBVTT\n\n00:00.000 --> 00:01.000\nTrack\n",
                        encoding="utf-8",
                    )
            if "-map" in command and "0:6" in command:
                return CompletedProcess(command, 1, b"", b"bitmap to bitmap only")
            if command[-1] == "-":
                return CompletedProcess(command, 0, b"WEBVTT\n\n00:00.000 --> 00:01.000\nTrack\n", b"")
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
        )

        self.assertLess(command.index("-ss"), command.index("-i"))
        self.assertEqual(command[command.index("-ss") + 1], "42")
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
