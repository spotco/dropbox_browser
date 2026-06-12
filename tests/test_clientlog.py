from __future__ import annotations

import json
import unittest
from pathlib import Path
from unittest.mock import patch

from dropbox_browser import clientlog as clientlog_module

try:
    from tests.app_test_support import AppTestCase
    from tests.support import SimulatedRclone, TestServer
except ImportError:
    from app_test_support import AppTestCase
    from support import SimulatedRclone, TestServer


class ClientLogTests(AppTestCase):
    def test_client_log_endpoint_writes_enabled_subsystem(self) -> None:
        log_path = self.temp_dir / "client_logs.jsonl"
        app = self._build_app(SimulatedRclone({}), local_root=None)
        app.client_log_enabled = True
        app.client_log_subsystems = {"video": True, "file-search": False}

        with patch.object(clientlog_module, "CLIENT_LOG_PATH", log_path), TestServer(app) as server:
            payload = server.post_json("/client-log", {
                "subsystem": "video",
                "level": "error",
                "message": "Fatal HLS error",
                "url": "http://127.0.0.1:8000/",
                "details": json.dumps({"hls_details": "bufferAppendError", "frag_sn": 4}),
            })

        self.assertEqual(payload, {"status": "ok", "logged": True})
        rows = [json.loads(line) for line in log_path.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["subsystem"], "video")
        self.assertEqual(rows[0]["level"], "error")
        self.assertEqual(rows[0]["message"], "Fatal HLS error")
        self.assertEqual(rows[0]["details"]["hls_details"], "bufferAppendError")
        self.assertEqual(rows[0]["details"]["frag_sn"], 4)

    def test_client_log_endpoint_ignores_disabled_subsystem(self) -> None:
        log_path = self.temp_dir / "client_logs.jsonl"
        app = self._build_app(SimulatedRclone({}), local_root=None)
        app.client_log_enabled = True
        app.client_log_subsystems = {"video": False}

        with patch.object(clientlog_module, "CLIENT_LOG_PATH", log_path), TestServer(app) as server:
            payload = server.post_json("/client-log", {
                "subsystem": "video",
                "level": "debug",
                "message": "ignored",
                "details": "{}",
            })

        self.assertEqual(payload, {"status": "ok", "logged": False})
        self.assertFalse(log_path.exists())

    def test_client_log_endpoint_ignores_when_global_disabled(self) -> None:
        log_path = self.temp_dir / "client_logs.jsonl"
        app = self._build_app(SimulatedRclone({}), local_root=None)
        app.client_log_enabled = False
        app.client_log_subsystems = {"video": True}

        with patch.object(clientlog_module, "CLIENT_LOG_PATH", log_path), TestServer(app) as server:
            payload = server.post_json("/client-log", {
                "subsystem": "video",
                "level": "debug",
                "message": "ignored",
                "details": "{}",
            })

        self.assertEqual(payload, {"status": "ok", "logged": False})
        self.assertFalse(log_path.exists())


if __name__ == "__main__":
    unittest.main()
