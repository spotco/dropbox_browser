from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlparse

from dropbox_browser.handlers import RequestHandler


class InternalHttpLoopbackUrlTests(unittest.TestCase):
    def _handler(self, listen_port: int, *, internal_http_port: int | None = None) -> RequestHandler:
        handler = RequestHandler.__new__(RequestHandler)
        server = SimpleNamespace(
            server_address=("127.0.0.1", listen_port),
            localhost_only_access=True,
        )
        if internal_http_port is not None:
            server.internal_http_port = internal_http_port
        handler.server = server
        return handler

    def test_http_listener_uses_bound_port(self) -> None:
        self.assertEqual(
            self._handler(8000)._internal_http_base_url(),
            "http://127.0.0.1:8000",
        )

    def test_https_listener_uses_internal_http_port(self) -> None:
        self.assertEqual(
            self._handler(8001, internal_http_port=8000)._internal_http_base_url(),
            "http://127.0.0.1:8000",
        )


class VideoEndpointLoopbackTests(unittest.TestCase):
    def _https_handler(self) -> RequestHandler:
        handler = RequestHandler.__new__(RequestHandler)
        handler.server = SimpleNamespace(
            server_address=("127.0.0.1", 8001),
            internal_http_port=8000,
            localhost_only_access=True,
            app=Mock(),
        )
        handler.wfile = Mock()
        handler.send_response = Mock()
        handler.send_header = Mock()
        handler.end_headers = Mock()
        return handler

    @patch("dropbox_browser.handlers.probe_remote_media", return_value={"status": "ok"})
    @patch.object(RequestHandler, "_resolve_remote_file", return_value=("movie.mp4", 1234))
    def test_probe_on_http_listener_uses_bound_port(self, _resolve_mock: Mock, probe_mock: Mock) -> None:
        handler = InternalHttpLoopbackUrlTests()._handler(8000)
        handler.server.app = Mock()
        handler.wfile = Mock()
        handler.send_response = Mock()
        handler.send_header = Mock()
        handler.end_headers = Mock()
        handler.serve_video_endpoint("/video/endpoints/probe", "path=movie.mp4&source=remote")
        self.assertEqual(probe_mock.call_args.kwargs["base_url"], "http://127.0.0.1:8000")

    @patch("dropbox_browser.handlers.probe_remote_media", return_value={"status": "ok"})
    @patch.object(RequestHandler, "_resolve_remote_file", return_value=("movie.mp4", 1234))
    def test_probe_on_https_listener_uses_http_port(self, _resolve_mock: Mock, probe_mock: Mock) -> None:
        handler = self._https_handler()
        handler.serve_video_endpoint("/video/endpoints/probe", "path=movie.mp4&source=remote")
        probe_mock.assert_called_once()
        self.assertEqual(probe_mock.call_args.kwargs["base_url"], "http://127.0.0.1:8000")

    @patch("dropbox_browser.handlers.extract_all_remote_subtitles_to_webvtt", return_value={"tracks": []})
    @patch.object(RequestHandler, "_resolve_remote_file", return_value=("movie.mp4", 1234))
    def test_subtitles_all_on_https_listener_uses_http_port(self, _resolve_mock: Mock, extract_mock: Mock) -> None:
        handler = self._https_handler()
        handler.serve_video_endpoint("/video/endpoints/subtitles/all", "path=movie.mp4&source=remote")
        extract_mock.assert_called_once()
        self.assertEqual(extract_mock.call_args.kwargs["base_url"], "http://127.0.0.1:8000")

    @patch("dropbox_browser.handlers.extract_remote_subtitles_to_webvtt", return_value=(b"WEBVTT\n", "en"))
    @patch.object(RequestHandler, "_resolve_remote_file", return_value=("movie.mp4", 1234))
    def test_subtitles_track_on_https_listener_uses_http_port(self, _resolve_mock: Mock, extract_mock: Mock) -> None:
        handler = self._https_handler()
        handler.serve_video_endpoint("/video/endpoints/subtitles", "path=movie.mp4&source=remote&track=2")
        extract_mock.assert_called_once()
        self.assertEqual(extract_mock.call_args.kwargs["base_url"], "http://127.0.0.1:8000")

    @patch("dropbox_browser.handlers.extract_remote_subtitle_window_to_webvtt", return_value={"status": "ok"})
    @patch.object(RequestHandler, "_resolve_remote_file", return_value=("movie.mp4", 1234))
    def test_subtitle_window_on_https_listener_uses_http_port(self, _resolve_mock: Mock, extract_mock: Mock) -> None:
        handler = self._https_handler()
        handler.serve_video_endpoint(
            "/video/endpoints/subtitles/window",
            "path=movie.mp4&source=remote&track=2&start=0&duration=30",
        )
        extract_mock.assert_called_once()
        self.assertEqual(extract_mock.call_args.kwargs["base_url"], "http://127.0.0.1:8000")

    @patch("dropbox_browser.handlers.video_session_manager")
    @patch.object(RequestHandler, "_resolve_remote_file", return_value=("movie.mp4", 1234))
    def test_session_create_on_https_listener_uses_http_port(self, _resolve_mock: Mock, manager_mock: Mock) -> None:
        handler = self._https_handler()
        handler._read_form = Mock(return_value={
            "source": ["remote"],
            "path": ["movie.mp4"],
            "client_id": [""],
            "subtitle_stroke_enabled": ["1"],
            "subtitle_shadow_enabled": ["1"],
            "force_subtitle_burn_in": [""],
            "subtitle_background_enabled": [""],
            "force_video_transcode": [""],
            "force_audio_transcode": [""],
        })
        manager_mock.return_value.create_session.return_value = {"session_id": "abc"}
        handler.serve_video_endpoint_post("/video/endpoints/session")
        create_session = manager_mock.return_value.create_session
        create_session.assert_called_once()
        self.assertEqual(create_session.call_args.kwargs["base_url"], "http://127.0.0.1:8000")

    @patch.object(RequestHandler, "_send_video_thumbnail_result")
    def test_video_thumbnail_on_https_listener_uses_http_port(self, send_mock: Mock) -> None:
        handler = self._https_handler()
        service = Mock()
        service.descriptor_for_path.return_value = Mock()
        service.ensure_thumbnail.return_value = Mock(ok=False, error_message="skip")
        handler.server.app.video_thumbnail_service = service
        handler.serve_video_thumbnail("path=clip.mov&source=remote")
        service.ensure_thumbnail.assert_called_once()
        remote_input_url = service.ensure_thumbnail.call_args.kwargs["remote_input_url"]
        parsed = urlparse(remote_input_url)
        self.assertEqual(parsed.scheme, "http")
        self.assertEqual(parsed.hostname, "127.0.0.1")
        self.assertEqual(parsed.port, 8000)
        query = parse_qs(parsed.query)
        self.assertEqual(query["path"], ["clip.mov"])
        self.assertEqual(query["source"], ["remote"])


if __name__ == "__main__":
    unittest.main()
