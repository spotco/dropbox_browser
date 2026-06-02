from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
import sys
from unittest.mock import Mock, patch

from dropbox_browser import cli


class FakeServer:
    def __init__(self, address: tuple[str, int], handler: object) -> None:
        self.address = address
        self.handler = handler
        self.app = None
        self.log_requests = None
        self.server_close = Mock()

    def serve_forever(self) -> None:
        raise KeyboardInterrupt


class CliArgumentTests(unittest.TestCase):
    def test_parse_args_client_render_defaults_to_false(self) -> None:
        with patch.object(sys, "argv", ["dropbox_browser.py"]):
            args = cli.parse_args()

        self.assertFalse(args.client_render)

    def test_parse_args_client_render_flag_sets_true(self) -> None:
        with patch.object(sys, "argv", ["dropbox_browser.py", "--client-render"]):
            args = cli.parse_args()

        self.assertTrue(args.client_render)


class CliShutdownTests(unittest.TestCase):
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
                patch.object(cli, "parse_args", return_value=Mock(host="127.0.0.1", port=8000, remote="dropbox:", rclone="rclone.exe", rclone_config=None, local_root=None, client_render=False)),
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
        server.server_close.assert_called_once_with()
        app.shutdown.assert_called_once_with()
        configure_run.assert_called_once()
        self.assertEqual(configure_run.call_args.kwargs["metadata"]["remote"], "dropbox:")
        self.assertEqual(configure_run.call_args.kwargs["metadata"]["local_root"], str(local_root))
        self.assertFalse(configure_run.call_args.kwargs["metadata"]["client_render"])

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
                patch.object(cli, "parse_args", return_value=Mock(host="127.0.0.1", port=8000, remote="dropbox:", rclone="rclone.exe", rclone_config=None, local_root=str(local_root), client_render=True)),
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
        self.assertEqual(configure_run.call_args.kwargs["metadata"]["local_root"], str(local_root.resolve()))
        self.assertTrue(configure_run.call_args.kwargs["metadata"]["client_render"])
