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
from dropbox_browser.video import build_ffmpeg_hls_command, build_ffmpeg_webvtt_command

try:
    from tests.app_test_support import AppTestCase
    from tests.support import SimulatedLsjsonResponse, SimulatedRclone, TestServer
except ImportError:
    from app_test_support import AppTestCase
    from support import SimulatedLsjsonResponse, SimulatedRclone, TestServer


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
        self.assertTrue(payload["subtitle_streams"][0]["forced"])
        ffprobe_cmd = run_mock.call_args.args[0]
        self.assertEqual(ffprobe_cmd[0], "C:\\tools\\ffmpeg\\bin\\ffprobe.exe")
        self.assertIn("/file?path=movie.mp4&source=remote", ffprobe_cmd[-1])

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
            playlist_path.parent.mkdir(parents=True, exist_ok=True)
            playlist_path.write_text(
                "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:6,\n"
                + segment_base_url
                + "segment_00000.m4s\n",
                encoding="utf-8",
            )
            (playlist_path.parent / "init.mp4").write_bytes(b"init")
            (playlist_path.parent / "segment_00000.m4s").write_bytes(b"segment")
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
            playlist_path.parent.mkdir(parents=True, exist_ok=True)
            playlist_path.write_text(
                "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:6,\n"
                + segment_base_url
                + "segment_00000.m4s\n",
                encoding="utf-8",
            )
            (playlist_path.parent / "init.mp4").write_bytes(b"init")
            (playlist_path.parent / "segment_00000.m4s").write_bytes(b"segment")
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
        self.assertEqual(segment_bytes, b"segment")
        self.assertEqual(segment_type, "video/mp4")
        self.assertEqual(init_bytes, b"init")
        self.assertEqual(init_type, "video/mp4")
        self.assertEqual(ctx.exception.code, 404)
        ctx.exception.close()

    def test_session_endpoint_waits_for_first_referenced_segment(self) -> None:
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
            playlist_path.parent.mkdir(parents=True, exist_ok=True)
            playlist_path.write_text("#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:6,\nsegment_00000.m4s\n", encoding="utf-8")
            (playlist_path.parent / "init.mp4").write_bytes(b"init")

            def write_segment() -> None:
                time.sleep(0.2)
                (playlist_path.parent / "segment_00000.m4s").write_bytes(b"segment")

            threading.Thread(target=write_segment, daemon=True).start()
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

        self.assertGreaterEqual(elapsed, 0.15)
        self.assertEqual(body, b"segment")

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
            playlist_path.parent.mkdir(parents=True, exist_ok=True)
            playlist_path.write_text(
                "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:6,\nsegment_00000.m4s\n#EXTINF:6,\nsegment_00001.m4s\n",
                encoding="utf-8",
            )
            (playlist_path.parent / "init.mp4").write_bytes(b"init")
            (playlist_path.parent / "segment_00000.m4s").write_bytes(b"first")

            def write_delayed_segment() -> None:
                requested_segment.wait(timeout=2)
                time.sleep(0.2)
                (playlist_path.parent / "segment_00001.m4s").write_bytes(b"second")

            threading.Thread(target=write_delayed_segment, daemon=True).start()
            return FakeFfmpegProcess(command)

        with TestServer(app) as server, patch("dropbox_browser.video.subprocess.Popen", side_effect=fake_popen):
            payload = server.post_json("/video/endpoints/session", {
                "path": "movie.mp4",
                "source": "remote",
            })
            started = time.monotonic()
            requested_segment.set()
            with urlopen(server.base_url + payload["asset_root"] + "segment_00001.m4s", timeout=5) as response:
                body = response.read()
                elapsed = time.monotonic() - started

        self.assertGreaterEqual(elapsed, 0.15)
        self.assertEqual(body, b"second")

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
            playlist_path.parent.mkdir(parents=True, exist_ok=True)
            playlist_path.write_text("#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:6,\nsegment_00000.m4s\n", encoding="utf-8")
            (playlist_path.parent / "init.mp4").write_bytes(b"init")
            (playlist_path.parent / "segment_00000.m4s").write_bytes(b"segment")
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
            playlist_path.parent.mkdir(parents=True, exist_ok=True)
            playlist_path.write_text("#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:6,\nsegment_00000.m4s\n", encoding="utf-8")
            (playlist_path.parent / "init.mp4").write_bytes(b"init")
            (playlist_path.parent / "segment_00000.m4s").write_bytes(b"segment")
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
            playlist_path.parent.mkdir(parents=True, exist_ok=True)
            playlist_path.write_text("#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:6,\nsegment_00000.m4s\n", encoding="utf-8")
            (playlist_path.parent / "init.mp4").write_bytes(b"init")
            (playlist_path.parent / "segment_00000.m4s").write_bytes(b"segment")
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
        self.assertIn("0:2?", spawned[0].command)

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
