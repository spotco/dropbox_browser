from __future__ import annotations

import io
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from dropbox_browser.errors import BrowserError
from dropbox_browser.rclone import RcloneClient, RcloneRetryPolicy


class FakeCatProcess:
    def __init__(self, returncode: int = 0, stderr: bytes = b"") -> None:
        self.stdout = io.BytesIO(b"hello")
        self.stderr = io.BytesIO(stderr)
        self.returncode = returncode

    def wait(self, timeout: float | None = None) -> int:
        return self.returncode


class TimeoutThenSuccessProcess:
    instances: list["TimeoutThenSuccessProcess"] = []

    def __init__(self, cmd: list[str], stdin: object | None = None, stdout: object | None = None, stderr: object | None = None) -> None:
        self.cmd = cmd
        self.returncode = 0
        self.killed = False
        self.communicate_timeouts: list[float | None] = []
        TimeoutThenSuccessProcess.instances.append(self)

    def communicate(self, timeout: float | None = None) -> tuple[bytes, bytes]:
        self.communicate_timeouts.append(timeout)
        if len(TimeoutThenSuccessProcess.instances) == 1 and not self.killed:
            raise subprocess.TimeoutExpired(self.cmd, timeout)
        return b"", b""

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9


class RecordingSuccessProcess:
    instances: list["RecordingSuccessProcess"] = []

    def __init__(self, cmd: list[str], stdin: object | None = None, stdout: object | None = None, stderr: object | None = None) -> None:
        self.cmd = cmd
        self.stdin = stdin
        self.returncode = 0
        RecordingSuccessProcess.instances.append(self)

    def communicate(self, timeout: float | None = None) -> tuple[bytes, bytes]:
        return b"", b""


class AlwaysTimeoutProcess:
    instances: list["AlwaysTimeoutProcess"] = []

    def __init__(self, cmd: list[str], stdin: object | None = None, stdout: object | None = None, stderr: object | None = None) -> None:
        self.cmd = cmd
        self.returncode = 0
        self.killed = False
        self.communicate_timeouts: list[float | None] = []
        AlwaysTimeoutProcess.instances.append(self)

    def communicate(self, timeout: float | None = None) -> tuple[bytes, bytes]:
        self.communicate_timeouts.append(timeout)
        if not self.killed:
            raise subprocess.TimeoutExpired(self.cmd, timeout)
        return b"", b""

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9


class RcloneLoggingTests(unittest.TestCase):
    def test_copyto_local_upload_uses_rcat_with_stdin(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            source = Path(tmpdir) / "milet「Anytime Anywhere」×「葬送のフリーレン」SPECIAL MUSIC VIDEO／フリーレンEDテーマアニメMV.mp3"
            source.write_bytes(b"audio")
            RecordingSuccessProcess.instances = []
            with (
                patch("dropbox_browser.rclone.subprocess.Popen", side_effect=RecordingSuccessProcess),
                patch("dropbox_browser.rclone.logstore.append", return_value=11),
                patch("dropbox_browser.rclone.logstore.update"),
                patch("dropbox_browser.rclone.logoutput.log_start", return_value=22),
                patch("dropbox_browser.rclone.logoutput.log_complete"),
            ):
                client = RcloneClient("rclone.exe", None)
                client.copy_file_overwrite(source, "dropbox:upload.mp3", size_bytes=5)

        self.assertEqual(
            RecordingSuccessProcess.instances[0].cmd,
            [
                "rclone.exe",
                "rcat",
                "--size",
                "5",
                "--",
                "dropbox:upload.mp3",
            ],
        )
        self.assertIsNotNone(RecordingSuccessProcess.instances[0].stdin)

    def test_copyto_remote_source_on_windows_does_not_use_local_encoding_workaround(self) -> None:
        RecordingSuccessProcess.instances = []
        with (
            patch("dropbox_browser.rclone.subprocess.Popen", side_effect=RecordingSuccessProcess),
            patch("dropbox_browser.rclone.logstore.append", return_value=11),
            patch("dropbox_browser.rclone.logstore.update"),
            patch("dropbox_browser.rclone.logoutput.log_start", return_value=22),
            patch("dropbox_browser.rclone.logoutput.log_complete"),
        ):
            client = RcloneClient("rclone.exe", None)
            client.copy_file_overwrite("dropbox:track?.mp3", "F:\\Dropbox\\music\\track？.mp3")

        self.assertEqual(
            RecordingSuccessProcess.instances[0].cmd,
            [
                "rclone.exe",
                "copyto",
                "--",
                "dropbox:track?.mp3",
                "F:\\Dropbox\\music\\track？.mp3",
            ],
        )

    def test_copyto_escaped_local_source_on_windows_uses_decoded_virtual_source(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            source = Path(tmpdir) / "track‛？.mp3"
            source.write_bytes(b"audio")
            RecordingSuccessProcess.instances = []
            with (
                patch("dropbox_browser.rclone.subprocess.Popen", side_effect=RecordingSuccessProcess),
                patch("dropbox_browser.rclone.logstore.append", return_value=11),
                patch("dropbox_browser.rclone.logstore.update"),
                patch("dropbox_browser.rclone.logoutput.log_start", return_value=22),
                patch("dropbox_browser.rclone.logoutput.log_complete"),
            ):
                client = RcloneClient("rclone.exe", None)
                client.copy_file_overwrite(source, "dropbox:track？.mp3", size_bytes=5)

        self.assertEqual(
            RecordingSuccessProcess.instances[0].cmd,
            [
                "rclone.exe",
                "rcat",
                "--size",
                "5",
                "--",
                "dropbox:track？.mp3",
            ],
        )

    def test_rcat_retry_rewinds_input_between_attempts(self) -> None:
        class ReadThenTimeoutProcess:
            instances: list["ReadThenTimeoutProcess"] = []

            def __init__(self, cmd: list[str], stdin: object | None = None, stdout: object | None = None, stderr: object | None = None) -> None:
                self.cmd = cmd
                self.stdin = stdin
                self.returncode = 0
                self.killed = False
                self.read_data = b""
                ReadThenTimeoutProcess.instances.append(self)

            def communicate(self, timeout: float | None = None) -> tuple[bytes, bytes]:
                if hasattr(self.stdin, "read"):
                    self.read_data = self.stdin.read()
                if len(ReadThenTimeoutProcess.instances) == 1 and not self.killed:
                    raise subprocess.TimeoutExpired(self.cmd, timeout)
                return b"", b""

            def kill(self) -> None:
                self.killed = True
                self.returncode = -9

        policy = RcloneRetryPolicy(
            max_attempts=2,
            min_timeout=0.01,
            timeout_per_gib=0.0,
            max_initial_timeout=1.0,
            retry_sleep=(0.0,),
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            source = Path(tmpdir) / "ヨルシカ「晴る」×「葬送のフリーレン」SPECIAL MUSIC VIDEO／フリーレンOPテーマアニメMV.mp3"
            source.write_bytes(b"abcdef")
            ReadThenTimeoutProcess.instances = []
            with (
                patch("dropbox_browser.rclone.subprocess.Popen", side_effect=ReadThenTimeoutProcess),
                patch("dropbox_browser.rclone.logstore.append", return_value=11),
                patch("dropbox_browser.rclone.logstore.update"),
                patch("dropbox_browser.rclone.logoutput.log_start", return_value=22),
                patch("dropbox_browser.rclone.logoutput.log_complete"),
                patch("dropbox_browser.rclone.logoutput.log_plain"),
            ):
                client = RcloneClient("rclone.exe", None)
                client.write_retry_policy = policy
                client.copy_file_overwrite(source, "dropbox:upload.mp3", size_bytes=6)

        self.assertEqual(len(ReadThenTimeoutProcess.instances), 2)

    def test_copyto_retries_after_timeout_without_waiting_full_timeout(self) -> None:
        TimeoutThenSuccessProcess.instances = []
        policy = RcloneRetryPolicy(
            max_attempts=2,
            min_timeout=0.01,
            timeout_per_gib=0.02,
            max_initial_timeout=1.0,
            retry_sleep=(0.0,),
        )
        with (
            patch("dropbox_browser.rclone.subprocess.Popen", side_effect=TimeoutThenSuccessProcess),
            patch("dropbox_browser.rclone.logstore.append", return_value=11) as append_mock,
            patch("dropbox_browser.rclone.logstore.update") as update_mock,
            patch("dropbox_browser.rclone.logoutput.log_start", return_value=22),
            patch("dropbox_browser.rclone.logoutput.log_complete"),
            patch("dropbox_browser.rclone.logoutput.log_plain"),
        ):
            client = RcloneClient("rclone.exe", None)
            client.write_retry_policy = policy
            client.copy_file_overwrite("dropbox:local.txt", "local.txt", size_bytes=1024 ** 3)

        self.assertEqual(len(TimeoutThenSuccessProcess.instances), 2)
        self.assertTrue(TimeoutThenSuccessProcess.instances[0].killed)
        self.assertAlmostEqual(TimeoutThenSuccessProcess.instances[0].communicate_timeouts[0] or 0, 0.03, places=3)
        self.assertAlmostEqual(TimeoutThenSuccessProcess.instances[1].communicate_timeouts[0] or 0, 0.06, places=3)
        appended_messages = [call.args[1] for call in append_mock.call_args_list]
        self.assertTrue(any("timeout attempt=1/2" in message and "killed" in message for message in appended_messages))
        self.assertTrue(any("retry attempt=2/2" in message and "timeout=0.06s" in message for message in appended_messages))
        self.assertIn("attempt=2/2", update_mock.call_args[0][1])

    def test_mkdir_timeout_exhaustion_raises_and_logs_retry_context(self) -> None:
        AlwaysTimeoutProcess.instances = []
        policy = RcloneRetryPolicy(
            max_attempts=2,
            min_timeout=0.01,
            timeout_per_gib=0.0,
            max_initial_timeout=1.0,
            retry_sleep=(0.0,),
        )
        with (
            patch("dropbox_browser.rclone.subprocess.Popen", side_effect=AlwaysTimeoutProcess),
            patch("dropbox_browser.rclone.logstore.append", return_value=11) as append_mock,
            patch("dropbox_browser.rclone.logstore.update") as update_mock,
            patch("dropbox_browser.rclone.logoutput.log_start", return_value=22),
            patch("dropbox_browser.rclone.logoutput.log_complete"),
            patch("dropbox_browser.rclone.logoutput.log_plain"),
        ):
            client = RcloneClient("rclone.exe", None)
            client.write_retry_policy = policy
            with self.assertRaises(BrowserError) as ctx:
                client.mkdir("dropbox:folder")

        self.assertIn("timed out after 2 attempt", str(ctx.exception))
        self.assertEqual(len(AlwaysTimeoutProcess.instances), 2)
        self.assertTrue(all(process.killed for process in AlwaysTimeoutProcess.instances))
        appended_messages = [call.args[1] for call in append_mock.call_args_list]
        self.assertTrue(any("timeout attempt=1/2" in message for message in appended_messages))
        self.assertTrue(any("retry attempt=2/2" in message for message in appended_messages))
        self.assertIn("timeout exhausted", update_mock.call_args[0][1])

    def test_lsjson_progress_context_adds_plan_progress_to_log(self) -> None:
        completed = subprocess.CompletedProcess(["rclone"], 0, b"[]", b"")
        with (
            patch("dropbox_browser.rclone.subprocess.run", return_value=completed),
            patch("dropbox_browser.rclone.logstore.append", return_value=11),
            patch("dropbox_browser.rclone.logstore.update") as update_mock,
            patch("dropbox_browser.rclone.logoutput.log_start", return_value=22),
            patch("dropbox_browser.rclone.logoutput.log_complete") as complete_mock,
        ):
            client = RcloneClient("rclone.exe", None)
            with client.progress_context(lambda: "123/271 planned, 148 remaining] (Plan: 2026-05-18 15:41:21)"):
                self.assertEqual(client.lsjson("dropbox:music"), [])

        update_text = update_mock.call_args[0][1]
        self.assertTrue(update_text.startswith("["))
        self.assertIn("lsjson -- dropbox:music", update_text)
        self.assertIn("s 123/271 planned, 148 remaining] (Plan: 2026-05-18 15:41:21) rclone.exe lsjson", update_text)
        self.assertTrue(complete_mock.called)

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
        self.assertTrue(append_mock.call_args[0][1].startswith("[...] "))
        self.assertTrue(start_mock.called)
        start_text = start_mock.call_args[0][0]
        self.assertTrue(start_text.startswith("[...] "))
        self.assertIn("cat -- dropbox:test/file.txt", start_text)
        update_text = update_mock.call_args[0][1]
        self.assertTrue(update_text.startswith("["))
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

    def test_cat_stream_can_open_byte_range(self) -> None:
        process = FakeCatProcess()
        with (
            patch("dropbox_browser.rclone.subprocess.Popen", return_value=process) as popen_mock,
            patch("dropbox_browser.rclone.logstore.append", return_value=11),
            patch("dropbox_browser.rclone.logstore.update"),
            patch("dropbox_browser.rclone.logoutput.log_start", return_value=22),
            patch("dropbox_browser.rclone.logoutput.log_complete"),
        ):
            client = RcloneClient("E:\\dev\\dropbox_browser\\rclone.exe", None)
            proc = client.open_cat("dropbox:test/video.mp4", offset=10, count=5)

        self.assertIs(proc, process)
        self.assertEqual(
            popen_mock.call_args[0][0],
            [
                "E:\\dev\\dropbox_browser\\rclone.exe",
                "cat",
                "--offset",
                "10",
                "--count",
                "5",
                "--",
                "dropbox:test/video.mp4",
            ],
        )
