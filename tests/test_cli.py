from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
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
                patch.object(cli, "parse_args", return_value=Mock(host="127.0.0.1", port=8000, remote="dropbox:", rclone="rclone.exe", rclone_config=None)),
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
