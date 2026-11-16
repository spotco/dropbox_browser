from __future__ import annotations

import json
import socket
from http import HTTPStatus
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from unittest.mock import patch

from dropbox_browser.handlers import LOCAL_FILE_MAX_BODY_BYTES
from dropbox_browser.services import DropboxBrowser

try:
    from tests.app_test_support import AppTestCase
    from tests.support import SimulatedLsjsonResponse, SimulatedRclone, TestServer, wait_until
except ImportError:
    from app_test_support import AppTestCase
    from support import SimulatedLsjsonResponse, SimulatedRclone, TestServer, wait_until


DEV_MUSIC_PLAYLIST = "dropbox_browser/dev_test_music_playlists.json"


class PlaylistSyncRouteTests(AppTestCase):
    def _post_bytes(self, server: TestServer, path: str, body: bytes, *, content_length: int | None = None):
        headers = {"Content-Type": "application/octet-stream"}
        if content_length is not None:
            headers["Content-Length"] = str(content_length)
        request = Request(server.base_url + path, data=body, method="POST", headers=headers)
        with urlopen(request, timeout=5) as response:
            return response.status, response.read()

    def test_remote_gateway_fallback_is_not_a_missing_file(self) -> None:
        local_root = self.create_local_root({"playlists/.keep": b"local"})
        rclone = SimulatedRclone({
            "dropbox:playlists/dev_test.json": [
                SimulatedLsjsonResponse(returncode=1, stderr=b"connection reset"),
            ],
            "dropbox:playlists": [
                SimulatedLsjsonResponse(returncode=1, stderr=b"connection reset"),
            ],
        })
        app = self._build_app(rclone, local_root)
        app.listing_retry_delay_seconds = 0
        with TestServer(app) as server:
            with self.assertRaises(HTTPError) as caught:
                server.get_text("/file?path=playlists/dev_test.json&source=remote")
        self.assertEqual(caught.exception.code, HTTPStatus.BAD_GATEWAY)
        self.assertNotEqual(caught.exception.code, HTTPStatus.NOT_FOUND)

    def test_successful_parent_listing_can_report_a_missing_file(self) -> None:
        local_root = self.create_local_root({"playlists/.keep": b"local"})
        rclone = SimulatedRclone({
            "dropbox:playlists/missing.json": [
                SimulatedLsjsonResponse(returncode=1, stderr=b"temporary"),
            ],
            "dropbox:playlists": [
                SimulatedLsjsonResponse(items=[{
                    "Name": "other.txt",
                    "Path": "other.txt",
                    "IsDir": False,
                    "Size": 4,
                    "ModTime": "2024-01-01T12:00:00Z",
                }]),
            ],
        })
        app = self._build_app(rclone, local_root)
        app.listing_retry_delay_seconds = 0
        with TestServer(app) as server:
            with self.assertRaises(HTTPError) as caught:
                server.get_text("/file?path=playlists/missing.json&source=remote")
        self.assertEqual(caught.exception.code, HTTPStatus.NOT_FOUND)

    def test_local_file_write_gates_and_sync_upload(self) -> None:
        local_root = self.create_local_root({})
        rclone = SimulatedRclone()
        app = self._build_app(rclone, local_root)
        body = b'{"playlists":[],"version":1}\n'
        with TestServer(app) as server:
            with self.assertRaises(HTTPError) as missing_gate:
                self._post_bytes(server, "/local-file?path=" + DEV_MUSIC_PLAYLIST, body)
            self.assertEqual(missing_gate.exception.code, HTTPStatus.FORBIDDEN)

            with self.assertRaises(HTTPError) as parent:
                self._post_bytes(
                    server,
                    "/local-file?path=../outside.json&enable_write_dropbox=1",
                    body,
                )
            self.assertEqual(parent.exception.code, HTTPStatus.BAD_REQUEST)

            status, _payload = self._post_bytes(
                server,
                "/local-file?path=" + DEV_MUSIC_PLAYLIST + "&enable_write_dropbox=1",
                body,
            )
            self.assertEqual(status, HTTPStatus.OK)
            written = local_root / "dropbox_browser" / "dev_test_music_playlists.json"
            self.assertEqual(written.read_bytes(), body)

            with patch.object(Path, "replace", side_effect=OSError("disk full")):
                with self.assertRaises(HTTPError) as failed:
                    self._post_bytes(
                        server,
                        "/local-file?path=" + DEV_MUSIC_PLAYLIST + "&enable_write_dropbox=1",
                        b"replacement",
                    )
            self.assertEqual(failed.exception.code, HTTPStatus.INTERNAL_SERVER_ERROR)
            self.assertEqual(written.read_bytes(), body)

            sync_payload = server.post_json("/sync", {
                "direction": "local_to_dropbox",
                "enable_write_dropbox": "1",
                "kind": "file",
                "path": DEV_MUSIC_PLAYLIST,
            })
            status_payload = wait_until(
                lambda: server.get_json("/sync-status?id=" + sync_payload["id"])
                if server.get_json("/sync-status?id=" + sync_payload["id"]).get("status") != "running"
                else None,
                description="playlist sync upload",
            )
        self.assertEqual(status_payload["status"], "complete")
        remote_key = "dropbox:" + DEV_MUSIC_PLAYLIST
        self.assertEqual(rclone.cat_data[remote_key], body)

    def test_local_file_rejects_missing_length_oversized_body_and_missing_root(self) -> None:
        local_root = self.create_local_root({})
        app = self._build_app(SimulatedRclone(), local_root)
        with TestServer(app) as server:
            host, port = server.server.server_address
            with socket.create_connection((host, port), timeout=5) as sock:
                sock.sendall(
                    b"POST /local-file?path=dropbox_browser/dev_test_music_playlists.json"
                    b"&enable_write_dropbox=1 HTTP/1.1\r\n"
                    b"Host: 127.0.0.1\r\n"
                    b"Connection: close\r\n\r\n"
                )
                missing_length = sock.recv(256)
            self.assertIn(b"400", missing_length)

            with socket.create_connection((host, port), timeout=5) as sock:
                oversized = (
                    "POST /local-file?path=dropbox_browser/dev_test_music_playlists.json"
                    "&enable_write_dropbox=1 HTTP/1.1\r\n"
                    "Host: 127.0.0.1\r\n"
                    f"Content-Length: {LOCAL_FILE_MAX_BODY_BYTES + 1}\r\n"
                    "Connection: close\r\n\r\n"
                )
                sock.sendall(oversized.encode("ascii"))
                too_large = sock.recv(256)
            self.assertIn(b"413", too_large)

        rootless = DropboxBrowser(SimulatedRclone(), "dropbox:", None)
        self.addCleanup(rootless.shutdown)
        with TestServer(rootless) as server:
            with self.assertRaises(HTTPError) as caught:
                self._post_bytes(
                    server,
                    "/local-file?path=dropbox_browser/dev_test_music_playlists.json&enable_write_dropbox=1",
                    b"{}",
                )
        self.assertEqual(caught.exception.code, HTTPStatus.BAD_REQUEST)

    def test_confirmed_export_bytes_round_trip_without_reencoding(self) -> None:
        local_root = self.create_local_root({})
        app = self._build_app(SimulatedRclone(), local_root)
        body = json.dumps({"exported_at": 5, "playlists": [], "version": 1}, indent=2).encode("utf-8")
        with TestServer(app) as server:
            request = Request(
                server.base_url + "/local-file?path=" + DEV_MUSIC_PLAYLIST + "&enable_write_dropbox=1",
                data=body,
                method="POST",
            )
            with urlopen(request, timeout=5) as response:
                self.assertEqual(response.status, 200)
        written = (local_root / "dropbox_browser" / "dev_test_music_playlists.json").read_bytes()
        self.assertEqual(written, body)
        self.assertNotIn(urlencode({"unused": "1"}), written.decode("utf-8"))
