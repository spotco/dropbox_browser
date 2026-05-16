from __future__ import annotations

import io
import subprocess
import unittest
from unittest.mock import patch

from dropbox_browser.rclone import RcloneClient


class FakeCatProcess:
    def __init__(self, returncode: int = 0, stderr: bytes = b"") -> None:
        self.stdout = io.BytesIO(b"hello")
        self.stderr = io.BytesIO(stderr)
        self.returncode = returncode

    def wait(self, timeout: float | None = None) -> int:
        return self.returncode


class RcloneLoggingTests(unittest.TestCase):
    def test_cat_stream_logs_start_and_completion(self) -> None:
        process = FakeCatProcess()
        with (
            patch("dropbox_browser.rclone.subprocess.Popen", return_value=process),
            patch("dropbox_browser.rclone.logstore.append", return_value=11) as append_mock,
            patch("dropbox_browser.rclone.logstore.update") as update_mock,
            patch("dropbox_browser.rclone.logoutput.log_start", return_value=22) as start_mock,
            patch("dropbox_browser.rclone.logoutput.log_complete") as complete_mock,
        ):
            client = RcloneClient("E:\\dev\\dropbox_browser\\rclone.exe", None)
            proc = client.open_cat("dropbox:test/file.txt")
            proc.wait(timeout=5)
            client.finish_cat(proc)

        self.assertIs(proc, process)
        self.assertTrue(append_mock.called)
        self.assertTrue(start_mock.called)
        start_text = start_mock.call_args[0][0]
        self.assertIn("cat -- dropbox:test/file.txt", start_text)
        update_text = update_mock.call_args[0][1]
        self.assertIn("cat -- dropbox:test/file.txt", update_text)
        self.assertIn("streamed", update_text)
        self.assertTrue(complete_mock.called)

    def test_cat_stream_logs_errors(self) -> None:
        process = FakeCatProcess(returncode=1, stderr=b"remote error")
        with (
            patch("dropbox_browser.rclone.subprocess.Popen", return_value=process),
            patch("dropbox_browser.rclone.logstore.append", return_value=11),
            patch("dropbox_browser.rclone.logstore.update") as update_mock,
            patch("dropbox_browser.rclone.logoutput.log_start", return_value=22),
            patch("dropbox_browser.rclone.logoutput.log_complete"),
        ):
            client = RcloneClient("E:\\dev\\dropbox_browser\\rclone.exe", None)
            proc = client.open_cat("dropbox:test/file.txt")
            proc.wait(timeout=5)
            client.finish_cat(proc)

        update_text = update_mock.call_args[0][1]
        self.assertIn("error rc=1", update_text)
        self.assertIn("remote error", update_text)
