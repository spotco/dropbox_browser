from __future__ import annotations

import io
import os
import signal
import ssl
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.request import Request, urlopen

from dropbox_browser import cli
from dropbox_browser.config import ThumbnailConfig, VideoToolsConfig
from dropbox_browser.dev_tls import DevTlsUnavailable, ensure_dev_tls_material
from dropbox_browser.handlers import RequestHandler
from http.server import ThreadingHTTPServer


class ResolveListenPortTests(unittest.TestCase):
    def test_default_https_is_http_plus_one(self) -> None:
        http_port, https_port = cli.resolve_listen_ports(8000, None, enable_https=True)
        self.assertEqual(http_port, 8000)
        self.assertEqual(https_port, 8001)

    def test_custom_http_port_keeps_plus_one_default(self) -> None:
        http_port, https_port = cli.resolve_listen_ports(9000, None, enable_https=True)
        self.assertEqual(https_port, 9001)

    def test_port_65535_https_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "65536"):
            cli.resolve_listen_ports(65535, None, enable_https=True)

    def test_equal_ports_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "different"):
            cli.resolve_listen_ports(8000, 8000, enable_https=True)

    def test_https_disabled_returns_none(self) -> None:
        http_port, https_port = cli.resolve_listen_ports(8000, None, enable_https=False)
        self.assertEqual(http_port, 8000)
        self.assertIsNone(https_port)

    def test_env_https_port_override(self) -> None:
        with patch.dict(os.environ, {"DROPBOX_BROWSER_HTTPS_PORT": "9443"}, clear=False):
            _, https_port = cli.resolve_listen_ports(8000, None, enable_https=True)
        self.assertEqual(https_port, 9443)


class PrintListenUrlTests(unittest.TestCase):
    def test_localhost_and_lan_lines(self) -> None:
        output = io.StringIO()
        with patch.object(sys, "stdout", output):
            cli.print_listen_urls(
                host="0.0.0.0",
                http_port=8000,
                https_port=8001,
                remote="dropbox:",
                self_signed_https=True,
            )
        text = output.getvalue()
        self.assertIn("http://127.0.0.1:8000/", text)
        self.assertIn("https://127.0.0.1:8001/", text)
        self.assertIn("self-signed", text)
        self.assertIn("LAN HTTP", text)
        self.assertIn("LAN HTTPS", text)


class HttpsStartupFailureTests(unittest.TestCase):
    def _thumbnail_config(self) -> ThumbnailConfig:
        return ThumbnailConfig(
            enabled=False,
            configured_enabled=False,
            cache_dir=Path("ThumbnailCache"),
            magick_exe=None,
            size=64,
            max_input_bytes=64 * 1024 * 1024,
            timeout_seconds=15,
        )

    def _video_tools_config(self) -> VideoToolsConfig:
        return VideoToolsConfig(ffmpeg_exe=None, ffprobe_exe=None)

    def test_required_https_listener_failure_shuts_down_app(self) -> None:
        created_servers: list[ThreadingHTTPServer] = []

        def create_server(address: tuple[str, int], handler: object) -> ThreadingHTTPServer:
            server = Mock(spec=ThreadingHTTPServer)
            server.server_close = Mock()
            server.shutdown = Mock()
            server.serve_forever = Mock(side_effect=KeyboardInterrupt)
            created_servers.append(server)
            return server

        app = Mock()

        with tempfile.TemporaryDirectory() as temp_dir:
            local_root = Path(temp_dir)
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
                        https=True,
                        https_port=None,
                        https_optional=False,
                        https_required=True,
                        tls_dir=Path(temp_dir) / "tls",
                        tls_cert=None,
                        tls_key=None,
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
                patch.object(cli.workertrace, "configure_server_run", return_value=local_root / "runs" / "1"),
                patch.object(cli, "RcloneClient", return_value=Mock()),
                patch.object(cli, "ListingCacheManager", return_value=Mock()),
                patch.object(cli, "FolderCacheManager", return_value=Mock(current_progress=Mock())),
                patch.object(cli, "DropboxBrowser", return_value=app),
                patch.object(cli, "SyncJobManager", return_value=Mock()),
                patch.object(cli, "resolve_tls_material", return_value=(Path("a.crt"), Path("a.key"))),
                patch.object(cli, "ThreadingHTTPServer", side_effect=create_server),
                patch.object(
                    cli,
                    "create_https_server",
                    side_effect=OSError("bind failed"),
                ),
                patch.object(cli.logoutput, "start"),
            ):
                result = cli.main()

        self.assertEqual(result, 1)
        app.shutdown.assert_called_once()
        self.assertGreaterEqual(len(created_servers), 1)
        created_servers[0].server_close.assert_called_once_with()

    def test_optional_missing_openssl_preserves_http(self) -> None:
        created_servers: list[Mock] = []

        def create_server(address: tuple[str, int], handler: object) -> Mock:
            server = Mock(spec=ThreadingHTTPServer)
            server.server_close = Mock()
            server.shutdown = Mock()
            server.serve_forever = Mock(side_effect=KeyboardInterrupt)
            created_servers.append(server)
            return server

        app = Mock()
        stderr = io.StringIO()

        with tempfile.TemporaryDirectory() as temp_dir:
            local_root = Path(temp_dir)
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
                        https=True,
                        https_port=None,
                        https_optional=True,
                        https_required=False,
                        tls_dir=None,
                        tls_cert=None,
                        tls_key=None,
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
                patch.object(cli.workertrace, "configure_server_run", return_value=local_root / "runs" / "1"),
                patch.object(cli, "RcloneClient", return_value=Mock()),
                patch.object(cli, "ListingCacheManager", return_value=Mock()),
                patch.object(cli, "FolderCacheManager", return_value=Mock(current_progress=Mock())),
                patch.object(cli, "DropboxBrowser", return_value=app),
                patch.object(cli, "SyncJobManager", return_value=Mock()),
                patch.object(
                    cli,
                    "ensure_dev_tls_material",
                    side_effect=DevTlsUnavailable("OpenSSL missing"),
                ),
                patch.object(cli, "ThreadingHTTPServer", side_effect=create_server),
                patch.object(cli.logoutput, "start"),
                patch.object(sys, "stderr", stderr),
            ):
                result = cli.main()

        self.assertEqual(result, 0)
        self.assertEqual(len(created_servers), 1)
        self.assertIn("continuing with HTTP only", stderr.getvalue())
        app.shutdown.assert_called_once()


class DualListenerIntegrationTests(unittest.TestCase):
    asset_path = "/assets/css/file-search.css"

    @classmethod
    def setUpClass(cls) -> None:
        cls._tmp = tempfile.TemporaryDirectory()
        cls.tls_dir = Path(cls._tmp.name) / "tls"
        try:
            cls.cert_path, cls.key_path = ensure_dev_tls_material(cls.tls_dir)
            cls.root_ca = cls.tls_dir / "root-ca.crt"
            cls.have_openssl = True
        except DevTlsUnavailable:
            cls.have_openssl = False

    @classmethod
    def tearDownClass(cls) -> None:
        cls._tmp.cleanup()

    def setUp(self) -> None:
        if not self.have_openssl:
            self.skipTest("OpenSSL unavailable")

        self.app = Mock()
        self.app_config = {
            "LogHttpRequests": False,
            "CacheStaticAssets": True,
            "LocalhostOnlyAccess": True,
        }
        self.http_server = ThreadingHTTPServer(("127.0.0.1", 0), RequestHandler)
        _, http_port = self.http_server.server_address
        cli._configure_server(self.http_server, self.app, self.app_config, internal_http_port=http_port)
        self.https_server = cli.create_https_server(
            ("127.0.0.1", 0),
            self.app,
            self.app_config,
            self.cert_path,
            self.key_path,
            internal_http_port=http_port,
        )
        self.http_thread = threading.Thread(target=self.http_server.serve_forever, daemon=True)
        self.https_thread = threading.Thread(target=self.https_server.serve_forever, daemon=True)
        self.http_thread.start()
        self.https_thread.start()

    def tearDown(self) -> None:
        if not self.have_openssl:
            return
        self.https_server.shutdown()
        self.http_server.shutdown()
        self.https_server.server_close()
        self.http_server.server_close()
        self.https_thread.join(timeout=5)
        self.http_thread.join(timeout=5)

    def test_http_and_https_serve_same_asset(self) -> None:
        _, http_port = self.http_server.server_address
        _, https_port = self.https_server.server_address
        http_url = f"http://127.0.0.1:{http_port}{self.asset_path}"
        https_url = f"https://127.0.0.1:{https_port}{self.asset_path}"

        with urlopen(http_url, timeout=5) as response:
            http_body = response.read()
            self.assertGreater(len(http_body), 0)

        context = ssl.create_default_context(cafile=str(self.root_ca))
        context.check_hostname = False
        request = Request(https_url)
        with urlopen(request, timeout=5, context=context) as response:
            https_body = response.read()
        self.assertEqual(http_body, https_body)


class ShutdownOnceTests(unittest.TestCase):
    def test_sigint_shutdowns_app_once(self) -> None:
        installed_handlers: dict[int, callable] = {}
        shutdown_calls: list[str] = []

        def fake_signal(signum: int, handler: callable) -> object:
            installed_handlers[signum] = handler
            return object()

        class ImmediateThread:
            def __init__(self, target: callable, daemon: bool = False, name: str | None = None) -> None:
                self._target = target

            def start(self) -> None:
                self._target()

        def create_server(address: tuple[str, int], handler: object) -> Mock:
            server = Mock(spec=ThreadingHTTPServer)
            server.server_close = Mock()
            server.shutdown = Mock(side_effect=lambda: shutdown_calls.append("server.shutdown"))
            server.serve_forever = Mock(
                side_effect=lambda: installed_handlers[signal.SIGINT](signal.SIGINT, None)
            )
            return server

        app = Mock()
        app.shutdown.side_effect = lambda: shutdown_calls.append("app.shutdown")

        with tempfile.TemporaryDirectory() as temp_dir:
            local_root = Path(temp_dir)
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
                        https=False,
                        https_port=None,
                        https_optional=False,
                        https_required=False,
                        tls_dir=None,
                        tls_cert=None,
                        tls_key=None,
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
                patch.object(cli, "load_thumbnail_config", return_value=ThumbnailConfig(
                    enabled=False,
                    configured_enabled=False,
                    cache_dir=Path("ThumbnailCache"),
                    magick_exe=None,
                    size=64,
                    max_input_bytes=1,
                    timeout_seconds=1,
                )),
                patch.object(cli, "load_video_tools_config", return_value=VideoToolsConfig(ffmpeg_exe=None, ffprobe_exe=None)),
                patch.object(cli, "find_dropbox_folder", return_value=local_root),
                patch.object(cli.workertrace, "configure_server_run", return_value=local_root / "runs" / "1"),
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
        self.assertEqual(shutdown_calls.count("app.shutdown"), 1)


class CreateHttpsServerTests(unittest.TestCase):
    def test_tls_failure_closes_bound_socket(self) -> None:
        app = Mock()
        app_config = {"LogHttpRequests": False, "CacheStaticAssets": True, "LocalhostOnlyAccess": True}
        with tempfile.TemporaryDirectory() as temp_dir:
            cert_path = Path(temp_dir) / "missing.crt"
            key_path = Path(temp_dir) / "missing.key"
            with self.assertRaises(FileNotFoundError):
                cli.create_https_server(
                    ("127.0.0.1", 0),
                    app,
                    app_config,
                    cert_path,
                    key_path,
                    internal_http_port=8000,
                )


class DevTlsDirectoryTests(unittest.TestCase):
    def test_env_tls_dir_with_spaces(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            tls_dir = Path(temp_dir) / "spaced path" / "dev-https"
            with patch.dict(os.environ, {"DROPBOX_BROWSER_TLS_DIR": str(tls_dir)}, clear=False):
                resolved = cli.dev_tls_directory(
                    Mock(tls_dir=None),
                )
            self.assertEqual(resolved, tls_dir)


class WindowsRunServerArgsTests(unittest.TestCase):
    def test_run_server_compose_https_flags_without_tls_dir_arg(self) -> None:
        if os.name != "nt":
            self.skipTest("Windows-only launcher argument test")
        with tempfile.TemporaryDirectory() as temp_dir:
            bat_path = Path(temp_dir) / "compose.bat"
            bat_path.write_text(
                "\n".join(
                    [
                        "@echo off",
                        "setlocal EnableExtensions",
                        'set "SERVER_ARGS=--remote dropbox: --https"',
                        'if "%DROPBOX_BROWSER_REQUIRE_HTTPS%"=="1" (',
                        '  set "SERVER_ARGS=%SERVER_ARGS% --https-required"',
                        ") else (",
                        '  set "SERVER_ARGS=%SERVER_ARGS% --https-optional"',
                        ")",
                        'if defined DROPBOX_BROWSER_HTTP_PORT set "SERVER_ARGS=%SERVER_ARGS% --port %DROPBOX_BROWSER_HTTP_PORT%"',
                        "echo %SERVER_ARGS%",
                    ]
                ),
                encoding="utf-8",
            )
            completed = subprocess.run(
                ["cmd", "/c", str(bat_path)],
                env={**os.environ, "DROPBOX_BROWSER_HTTP_PORT": "8000"},
                capture_output=True,
                text=True,
                check=False,
            )
        output = completed.stdout.strip()
        self.assertEqual(completed.returncode, 0, msg=completed.stderr)
        self.assertIn("--https", output)
        self.assertIn("--https-optional", output)
        self.assertIn("--port 8000", output)
        self.assertNotIn("--tls-dir", output)


if __name__ == "__main__":
    unittest.main()
