from __future__ import annotations

import io
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Callable
from unittest.mock import Mock, patch

from dropbox_browser import cli
from dropbox_browser.config import ThumbnailConfig, VideoToolsConfig


class FakeServer:
    def __init__(self, address: tuple[str, int], handler: object) -> None:
        self.address = address
        self.handler = handler
        self.app = None
        self.log_requests = None
        self.daemon_threads = False
        self.block_on_close = True
        self.shutdown = Mock()
        self.server_close = Mock()

    def serve_forever(self) -> None:
        raise KeyboardInterrupt


class FakeSignalDrivenServer(FakeServer):
    def __init__(self, address: tuple[str, int], handler: object, on_serve_forever: Callable[[], None] | None = None) -> None:
        super().__init__(address, handler)
        self._on_serve_forever = on_serve_forever

    def serve_forever(self) -> None:
        if self._on_serve_forever is not None:
            self._on_serve_forever()


class CliArgumentTests(unittest.TestCase):
    def test_parse_args_client_render_defaults_to_true(self) -> None:
        with patch.object(sys, "argv", ["dropbox_browser.py"]):
            args = cli.parse_args()

        self.assertTrue(args.client_render)

    def test_parse_args_client_render_flag_sets_true(self) -> None:
        with patch.object(sys, "argv", ["dropbox_browser.py", "--client-render"]):
            args = cli.parse_args()

        self.assertTrue(args.client_render)

    def test_parse_args_no_client_render_flag_sets_false(self) -> None:
        with patch.object(sys, "argv", ["dropbox_browser.py", "--no-client-render"]):
            args = cli.parse_args()

        self.assertFalse(args.client_render)


class CliPythonWarningTests(unittest.TestCase):
    def test_old_python_warning_is_written_without_blocking(self) -> None:
        stderr = io.StringIO()
        with (
            patch.object(cli, "python_version_warning", return_value="old runtime"),
            patch.object(sys, "stderr", stderr),
        ):
            cli.warn_if_python_too_old()

        self.assertIn("Warning: old runtime", stderr.getvalue())


class CliShutdownTests(unittest.TestCase):
    def _thumbnail_config(self, *, enabled: bool = False, configured_enabled: bool = True) -> ThumbnailConfig:
        return ThumbnailConfig(
            enabled=enabled,
            configured_enabled=configured_enabled,
            cache_dir=Path("ThumbnailCache"),
            magick_exe=None,
            size=64,
            max_input_bytes=64 * 1024 * 1024,
            timeout_seconds=15,
        )

    def _video_tools_config(self, *, ffmpeg_exe: Path | None = None, ffprobe_exe: Path | None = None) -> VideoToolsConfig:
        return VideoToolsConfig(ffmpeg_exe=ffmpeg_exe, ffprobe_exe=ffprobe_exe)

    def test_keyboard_interrupt_closes_server_and_shuts_down_app(self) -> None:
        created_servers: list[FakeServer] = []

        def create_server(address: tuple[str, int], handler: object) -> FakeServer:
            server = FakeServer(address, handler)
            created_servers.append(server)
            return server

        with tempfile.TemporaryDirectory() as temp_dir:
            local_root = Path(temp_dir)
            app = Mock()

            with (
                patch.object(
                    cli,
                    "parse_args",
                    return_value=Mock(
                        host="127.0.0.1",
                        port=8000,
                        remote="dropbox:",
                        rclone="rclone.exe",
                        rclone_config=None,
                        local_root=None,
                        client_render=True,
                    ),
                ),
                patch.object(
                    cli,
                    "load_app_config",
                    return_value={
                        "LogRcloneCommands": False,
                        "ListingCacheTTLSeconds": 30,
                        "FolderCacheTTLSeconds": 30,
                        "FolderCacheWorkers": 1,
                        "SyncJobWorkers": 1,
                        "LogHttpRequests": False,
                    },
                ),
                patch.object(cli, "load_thumbnail_config", return_value=self._thumbnail_config()),
                patch.object(cli, "load_video_tools_config", return_value=self._video_tools_config()),
                patch.object(cli, "find_dropbox_folder", return_value=local_root),
                patch.object(cli.workertrace, "configure_server_run", return_value=local_root / "runs" / "1779341234") as configure_run,
                patch.object(cli, "RcloneClient", return_value=Mock()),
                patch.object(cli, "ListingCacheManager", return_value=Mock()),
                patch.object(cli, "FolderCacheManager", return_value=Mock(current_progress=Mock())),
                patch.object(cli, "DropboxBrowser", return_value=app),
                patch.object(cli, "SyncJobManager", return_value=Mock()),
                patch.object(cli, "ThreadingHTTPServer", side_effect=create_server),
                patch.object(cli.logoutput, "start"),
            ):
                result = cli.main()

        self.assertEqual(result, 0)
        self.assertEqual(len(created_servers), 1)
        server = created_servers[0]
        self.assertTrue(server.daemon_threads)
        self.assertFalse(server.block_on_close)
        self.assertTrue(server.cache_static_assets)
        self.assertTrue(server.localhost_only_access)
        server.server_close.assert_called_once_with()
        app.shutdown.assert_called_once_with()
        configure_run.assert_called_once()
        self.assertEqual(configure_run.call_args.kwargs["metadata"]["remote"], "dropbox:")
        self.assertEqual(configure_run.call_args.kwargs["metadata"]["local_root"], str(local_root))
        self.assertTrue(configure_run.call_args.kwargs["metadata"]["client_render"])
        self.assertFalse(configure_run.call_args.kwargs["metadata"]["thumbnail_enabled"])
        self.assertEqual(configure_run.call_args.kwargs["metadata"]["thumbnail_size"], 64)
        self.assertIsNone(configure_run.call_args.kwargs["metadata"]["thumbnail_magick_path"])
        self.assertIsNone(configure_run.call_args.kwargs["metadata"]["video_ffmpeg_path"])
        self.assertIsNone(configure_run.call_args.kwargs["metadata"]["video_ffprobe_path"])
        self.assertFalse(configure_run.call_args.kwargs["metadata"]["video_compatibility_available"])

    def test_sigint_starts_app_shutdown_before_server_close(self) -> None:
        created_servers: list[FakeSignalDrivenServer] = []
        installed_handlers: dict[int, callable] = {}
        steps: list[str] = []

        def fake_signal(signum: int, handler: Callable[..., object]) -> object:
            installed_handlers[signum] = handler
            return object()

        class ImmediateThread:
            def __init__(self, target: Callable[[], None], daemon: bool = False, name: str | None = None) -> None:
                self._target = target
                self.daemon = daemon
                self.name = name

            def start(self) -> None:
                self._target()

        def create_server(address: tuple[str, int], handler: object) -> FakeSignalDrivenServer:
            def on_serve_forever() -> None:
                installed_handlers[cli.signal.SIGINT](cli.signal.SIGINT, None)

            server = FakeSignalDrivenServer(address, handler, on_serve_forever=on_serve_forever)
            server.shutdown.side_effect = lambda: steps.append("server.shutdown")
            server.server_close.side_effect = lambda: steps.append("server.server_close")
            created_servers.append(server)
            return server

        with tempfile.TemporaryDirectory() as temp_dir:
            local_root = Path(temp_dir)
            app = Mock()
            app.shutdown.side_effect = lambda: steps.append("app.shutdown")

            with (
                patch.object(
                    cli,
                    "parse_args",
                    return_value=Mock(
                        host="127.0.0.1",
                        port=8000,
                        remote="dropbox:",
                        rclone="rclone.exe",
                        rclone_config=None,
                        local_root=None,
                        client_render=True,
                    ),
                ),
                patch.object(
                    cli,
                    "load_app_config",
                    return_value={
                        "LogRcloneCommands": False,
                        "ListingCacheTTLSeconds": 30,
                        "FolderCacheTTLSeconds": 30,
                        "FolderCacheWorkers": 1,
                        "SyncJobWorkers": 1,
                        "LogHttpRequests": False,
                    },
                ),
                patch.object(cli, "load_thumbnail_config", return_value=self._thumbnail_config()),
                patch.object(cli, "load_video_tools_config", return_value=self._video_tools_config()),
                patch.object(cli, "find_dropbox_folder", return_value=local_root),
                patch.object(cli.workertrace, "configure_server_run", return_value=local_root / "runs" / "1779341234"),
                patch.object(cli, "RcloneClient", return_value=Mock()),
                patch.object(cli, "ListingCacheManager", return_value=Mock()),
                patch.object(cli, "FolderCacheManager", return_value=Mock(current_progress=Mock())),
                patch.object(cli, "DropboxBrowser", return_value=app),
                patch.object(cli, "SyncJobManager", return_value=Mock()),
                patch.object(cli, "ThreadingHTTPServer", side_effect=create_server),
                patch.object(cli.logoutput, "start"),
                patch.object(cli.signal, "getsignal", return_value=object()),
                patch.object(cli.signal, "signal", side_effect=fake_signal),
                patch.object(cli.threading, "Thread", ImmediateThread),
            ):
                result = cli.main()

        self.assertEqual(result, 0)
        self.assertEqual(len(created_servers), 1)
        self.assertIn("app.shutdown", steps)
        self.assertIn("server.shutdown", steps)
        self.assertIn("server.server_close", steps)
        self.assertTrue(created_servers[0].localhost_only_access)
        self.assertLess(steps.index("app.shutdown"), steps.index("server.server_close"))
        self.assertLess(steps.index("server.shutdown"), steps.index("server.server_close"))

    def test_local_root_arg_bypasses_config_lookup(self) -> None:
        created_servers: list[FakeServer] = []

        def create_server(address: tuple[str, int], handler: object) -> FakeServer:
            server = FakeServer(address, handler)
            created_servers.append(server)
            return server

        with tempfile.TemporaryDirectory() as temp_dir:
            local_root = Path(temp_dir) / "isolated-local"
            app = Mock()

            with (
                patch.object(
                    cli,
                    "parse_args",
                    return_value=Mock(
                        host="127.0.0.1",
                        port=8000,
                        remote="dropbox:",
                        rclone="rclone.exe",
                        rclone_config=None,
                        local_root=str(local_root),
                        client_render=True,
                    ),
                ),
                patch.object(
                    cli,
                    "load_app_config",
                    return_value={
                        "LogRcloneCommands": False,
                        "ListingCacheTTLSeconds": 30,
                        "FolderCacheTTLSeconds": 30,
                        "FolderCacheWorkers": 1,
                        "SyncJobWorkers": 1,
                        "LogHttpRequests": False,
                    },
                ),
                patch.object(cli, "load_thumbnail_config", return_value=self._thumbnail_config()),
                patch.object(cli, "load_video_tools_config", return_value=self._video_tools_config()),
                patch.object(cli, "find_dropbox_folder") as find_dropbox_folder,
                patch.object(cli.workertrace, "configure_server_run", return_value=local_root / "runs" / "1779341234") as configure_run,
                patch.object(cli, "RcloneClient", return_value=Mock()),
                patch.object(cli, "ListingCacheManager", return_value=Mock()),
                patch.object(cli, "FolderCacheManager", return_value=Mock(current_progress=Mock())),
                patch.object(cli, "DropboxBrowser", return_value=app),
                patch.object(cli, "SyncJobManager", return_value=Mock()),
                patch.object(cli, "ThreadingHTTPServer", side_effect=create_server),
                patch.object(cli.logoutput, "start"),
            ):
                result = cli.main()

        self.assertEqual(result, 0)
        find_dropbox_folder.assert_not_called()
        self.assertTrue(created_servers[0].localhost_only_access)
        self.assertEqual(configure_run.call_args.kwargs["metadata"]["local_root"], str(local_root.resolve()))
        self.assertTrue(configure_run.call_args.kwargs["metadata"]["client_render"])

    def test_main_prints_visible_thumbnail_disabled_message_when_magick_missing(self) -> None:
        created_servers: list[FakeServer] = []

        def create_server(address: tuple[str, int], handler: object) -> FakeServer:
            server = FakeServer(address, handler)
            created_servers.append(server)
            return server

        with tempfile.TemporaryDirectory() as temp_dir:
            local_root = Path(temp_dir)
            stdout = io.StringIO()

            with (
                patch.object(
                    cli,
                    "parse_args",
                    return_value=Mock(
                        host="127.0.0.1",
                        port=8000,
                        remote="dropbox:",
                        rclone="rclone.exe",
                        rclone_config=None,
                        local_root=None,
                        client_render=True,
                    ),
                ),
                patch.object(
                    cli,
                    "load_app_config",
                    return_value={
                        "LogRcloneCommands": False,
                        "ListingCacheTTLSeconds": 30,
                        "FolderCacheTTLSeconds": 30,
                        "FolderCacheWorkers": 1,
                        "SyncJobWorkers": 1,
                        "LogHttpRequests": False,
                    },
                ),
                patch.object(cli, "load_thumbnail_config", return_value=self._thumbnail_config()),
                patch.object(cli, "load_video_tools_config", return_value=self._video_tools_config()),
                patch.object(cli, "find_dropbox_folder", return_value=local_root),
                patch.object(cli.workertrace, "configure_server_run", return_value=local_root / "runs" / "1779341234"),
                patch.object(cli, "RcloneClient", return_value=Mock()),
                patch.object(cli, "ListingCacheManager", return_value=Mock()),
                patch.object(cli, "FolderCacheManager", return_value=Mock(current_progress=Mock())),
                patch.object(cli, "DropboxBrowser", return_value=Mock()),
                patch.object(cli, "SyncJobManager", return_value=Mock()),
                patch.object(cli, "ThreadingHTTPServer", side_effect=create_server),
                patch.object(cli.logoutput, "start"),
                patch.object(sys, "stdout", stdout),
            ):
                result = cli.main()

        self.assertEqual(result, 0)
        self.assertEqual(len(created_servers), 1)
        self.assertIn("Thumbnails disabled: vendored ImageMagick not found", stdout.getvalue())
        self.assertIn("Video compatibility playback unavailable", stdout.getvalue())


if __name__ == "__main__":
    unittest.main()
