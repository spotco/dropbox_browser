from __future__ import annotations

import io
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from dropbox_browser.errors import BrowserError
from dropbox_browser import rclone as rclone_module
from dropbox_browser.rclone import (
    RcloneClient,
    RcloneCancelled,
    RcloneRetryPolicy,
    is_retryable_dropbox_throttle_message,
    write_retry_policy_from_config,
)


class FakeCatProcess:
    def __init__(self, returncode: int = 0, stderr: bytes = b"") -> None:
        self.stdout = io.BytesIO(b"hello")
        self.stderr = io.BytesIO(stderr)
        self.returncode = returncode

    def wait(self, timeout: float | None = None) -> int:
        return self.returncode


class KillableCatProcess(FakeCatProcess):
    def __init__(self, returncode: int | None = None, stderr: bytes = b"") -> None:
        super().__init__(returncode=0 if returncode is None else returncode, stderr=stderr)
        self.returncode = returncode
        self.killed = False

    def poll(self) -> int | None:
        return self.returncode

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9

    def wait(self, timeout: float | None = None) -> int:
        return -9 if self.returncode is None else self.returncode


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


class TimeoutAndSignalKillProcess:
    instances: list["TimeoutAndSignalKillProcess"] = []
    first_kill_event = threading.Event()

    def __init__(self, cmd: list[str], stdin: object | None = None, stdout: object | None = None, stderr: object | None = None) -> None:
        self.cmd = cmd
        self.returncode = 0
        self.killed = False
        TimeoutAndSignalKillProcess.instances.append(self)

    def communicate(self, timeout: float | None = None) -> tuple[bytes, bytes]:
        raise subprocess.TimeoutExpired(self.cmd, timeout)

    def poll(self) -> int | None:
        return None if not self.killed else self.returncode

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9
        TimeoutAndSignalKillProcess.first_kill_event.set()


class RcloneLoggingTests(unittest.TestCase):
    def test_cat_command_matrix_files_from_mode_preserves_exact_relative_path(self) -> None:
        path_cases = [
            "Camera Uploads/2020-08-07 13.34.35.png",
            "music/宇多田ヒカル/Automatic.mp3",
            "anime/[Group] Show [1080p]/ep[01].mkv",
            "anime/JoJo's Bizarre Adventure/episode 01's cut.mkv",
            "music/＊NSYNC／Greatest Hits／01 - It's Gonna Be Me.mp3",
        ]
        with tempfile.TemporaryDirectory() as tmpdir:
            patcher = patch.object(rclone_module, "TEMP_DIR", Path(tmpdir))
            with patcher:
                client = RcloneClient("rclone.exe", None)
                for rel_path in path_cases:
                    cmd, temp_list_path = client._cat_command_for_target(
                        f"dropbox:{rel_path}",
                        remote_form="files-from",
                    )
                    self.assertIsNotNone(temp_list_path)
                    assert temp_list_path is not None
                    self.assertEqual(
                        cmd,
                        [
                            "rclone.exe",
                            "cat",
                            "--files-from",
                            str(temp_list_path),
                            "--no-traverse",
                            "--",
                            "dropbox:",
                        ],
                    )
                    self.assertEqual(temp_list_path.read_text(encoding="utf-8"), rel_path)
                    temp_list_path.unlink()

    def test_cat_command_matrix_direct_mode_preserves_exact_remote_target(self) -> None:
        path_cases = [
            "Camera Uploads/2020-08-07 13.34.35.png",
            "music/宇多田ヒカル/Automatic.mp3",
            "anime/[Group] Show [1080p]/ep[01].mkv",
            "anime/JoJo's Bizarre Adventure/episode 01's cut.mkv",
            "music/＊NSYNC／Greatest Hits／01 - It's Gonna Be Me.mp3",
        ]
        client = RcloneClient("rclone.exe", None)
        for rel_path in path_cases:
            cmd, temp_list_path = client._cat_command_for_target(
                f"dropbox:{rel_path}",
                remote_form="direct",
            )
            self.assertIsNone(temp_list_path)
            self.assertEqual(
                cmd,
                [
                    "rclone.exe",
                    "cat",
                    "--",
                    f"dropbox:{rel_path}",
                ],
            )

    def test_dropbox_throttle_classifier_matches_write_limit_error(self) -> None:
        self.assertTrue(
            is_retryable_dropbox_throttle_message(
                "NOTICE: Failed to rcat: too_many_write_operations/..../please retry later"
            )
        )
        self.assertFalse(is_retryable_dropbox_throttle_message("directory not found"))

    def test_write_retry_policy_from_config_defaults_match_builtin(self) -> None:
        policy = write_retry_policy_from_config({})
        defaults = RcloneRetryPolicy()
        self.assertEqual(policy.max_attempts, defaults.max_attempts)
        self.assertEqual(policy.min_timeout, defaults.min_timeout)
        self.assertEqual(policy.timeout_per_gib, defaults.timeout_per_gib)
        self.assertEqual(policy.max_initial_timeout, defaults.max_initial_timeout)
        self.assertEqual(policy.timeout_multiplier, defaults.timeout_multiplier)
        self.assertEqual(policy.max_timeout, defaults.max_timeout)

    def test_write_retry_policy_from_config_applies_overrides(self) -> None:
        policy = write_retry_policy_from_config(
            {
                "RcloneWriteMaxAttempts": 10,
                "RcloneWriteMinTimeoutSeconds": 60,
                "RcloneWriteTimeoutPerGibSeconds": 900,
                "RcloneWriteMaxInitialTimeoutSeconds": 3600,
                "RcloneWriteTimeoutMultiplier": 2.0,
                "RcloneWriteMaxTimeoutSeconds": 7200,
            }
        )
        self.assertEqual(policy.max_attempts, 10)
        self.assertEqual(policy.min_timeout, 60.0)
        self.assertEqual(policy.timeout_per_gib, 900.0)
        self.assertEqual(policy.max_initial_timeout, 3600.0)
        self.assertEqual(policy.timeout_multiplier, 2.0)
        self.assertEqual(policy.max_timeout, 7200.0)
        # ~400 MiB anime episode should get a multi-minute first attempt.
        four_hundred_mib = 400 * 1024 * 1024
        self.assertGreaterEqual(policy.timeout_for_attempt(1, four_hundred_mib), 300.0)
        # ~2 GiB should stay under the initial cap and far above old 37s budget.
        two_gib = 2 * 1024 * 1024 * 1024
        self.assertGreaterEqual(policy.timeout_for_attempt(1, two_gib), 1800.0)
        self.assertLessEqual(policy.timeout_for_attempt(1, two_gib), 3600.0)

    def test_write_retry_policy_from_config_orders_timeout_caps(self) -> None:
        policy = write_retry_policy_from_config(
            {
                "RcloneWriteMinTimeoutSeconds": 100,
                "RcloneWriteMaxInitialTimeoutSeconds": 50,
                "RcloneWriteMaxTimeoutSeconds": 25,
            }
        )
        self.assertEqual(policy.min_timeout, 100.0)
        self.assertEqual(policy.max_initial_timeout, 100.0)
        self.assertEqual(policy.max_timeout, 100.0)

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
            tempfile.TemporaryDirectory() as tmpdir,
            patch.object(rclone_module, "TEMP_DIR", Path(tmpdir)),
            patch("dropbox_browser.rclone.subprocess.Popen", return_value=process),
            patch("dropbox_browser.rclone.logstore.append", return_value=11) as append_mock,
            patch("dropbox_browser.rclone.logstore.update") as update_mock,
            patch("dropbox_browser.rclone.logoutput.log_start", return_value=22) as start_mock,
            patch("dropbox_browser.rclone.logoutput.log_complete") as complete_mock,
        ):
            client = RcloneClient("E:\\dev\\dropbox_browser\\rclone.exe", None)
            proc = client.open_cat("dropbox:test/file.txt")
            cmd = start_mock.call_args[0][0]
            files_from = cmd.split("--files-from ", 1)[1].split(" --no-traverse", 1)[0].strip("'")
            self.assertTrue(Path(files_from).exists())
            proc.wait(timeout=5)
            client.finish_cat(proc)
            self.assertFalse(Path(files_from).exists())

        self.assertIs(proc, process)
        self.assertTrue(append_mock.called)
        self.assertTrue(append_mock.call_args[0][1].startswith("[...] "))
        self.assertTrue(start_mock.called)
        start_text = start_mock.call_args[0][0]
        self.assertTrue(start_text.startswith("[...] "))
        self.assertIn("cat --files-from", start_text)
        self.assertIn("--no-traverse -- dropbox:", start_text)
        update_text = update_mock.call_args[0][1]
        self.assertTrue(update_text.startswith("["))
        self.assertIn("cat --files-from", update_text)
        self.assertIn("--no-traverse -- dropbox:", update_text)
        self.assertIn("streamed", update_text)
        self.assertTrue(complete_mock.called)

    def test_cat_stream_logs_errors(self) -> None:
        process = FakeCatProcess(returncode=1, stderr=b"remote error")
        with (
            tempfile.TemporaryDirectory() as tmpdir,
            patch.object(rclone_module, "TEMP_DIR", Path(tmpdir)),
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

    def test_shutdown_kills_active_cat_process(self) -> None:
        process = KillableCatProcess(returncode=None)
        with (
            tempfile.TemporaryDirectory() as tmpdir,
            patch.object(rclone_module, "TEMP_DIR", Path(tmpdir)),
            patch("dropbox_browser.rclone.subprocess.Popen", return_value=process),
            patch("dropbox_browser.rclone.logstore.append", return_value=11),
            patch("dropbox_browser.rclone.logstore.update"),
            patch("dropbox_browser.rclone.logoutput.log_start", return_value=22),
            patch("dropbox_browser.rclone.logoutput.log_complete"),
        ):
            client = RcloneClient("rclone.exe", None)
            proc = client.open_cat("dropbox:test/file.txt")
            client.shutdown()
            client.finish_cat(proc)

        self.assertTrue(process.killed)

    def test_shutdown_interrupts_retry_waits(self) -> None:
        TimeoutAndSignalKillProcess.instances = []
        TimeoutAndSignalKillProcess.first_kill_event = threading.Event()
        policy = RcloneRetryPolicy(
            max_attempts=3,
            min_timeout=0.01,
            timeout_per_gib=0.0,
            max_initial_timeout=1.0,
            retry_sleep=(60.0,),
        )
        client = RcloneClient("rclone.exe", None)
        client.write_retry_policy = policy
        result: dict[str, BaseException] = {}

        def run_mkdir() -> None:
            try:
                client.mkdir("dropbox:folder")
            except BaseException as exc:
                result["error"] = exc

        with (
            patch("dropbox_browser.rclone.subprocess.Popen", side_effect=TimeoutAndSignalKillProcess),
            patch("dropbox_browser.rclone.logstore.append", return_value=11),
            patch("dropbox_browser.rclone.logstore.update"),
            patch("dropbox_browser.rclone.logoutput.log_start", return_value=22),
            patch("dropbox_browser.rclone.logoutput.log_complete"),
            patch("dropbox_browser.rclone.logoutput.log_plain"),
        ):
            thread = threading.Thread(target=run_mkdir, daemon=True)
            thread.start()
            self.assertTrue(TimeoutAndSignalKillProcess.first_kill_event.wait(timeout=1))
            client.shutdown()
            thread.join(timeout=1)

        self.assertFalse(thread.is_alive())
        self.assertIsInstance(result.get("error"), RcloneCancelled)

    def test_cat_stream_can_open_byte_range(self) -> None:
        process = FakeCatProcess()
        with (
            tempfile.TemporaryDirectory() as tmpdir,
            patch.object(rclone_module, "TEMP_DIR", Path(tmpdir)),
            patch("dropbox_browser.rclone.subprocess.Popen", return_value=process) as popen_mock,
            patch("dropbox_browser.rclone.logstore.append", return_value=11),
            patch("dropbox_browser.rclone.logstore.update"),
            patch("dropbox_browser.rclone.logoutput.log_start", return_value=22),
            patch("dropbox_browser.rclone.logoutput.log_complete"),
        ):
            client = RcloneClient("E:\\dev\\dropbox_browser\\rclone.exe", None)
            proc = client.open_cat("dropbox:test/video.mp4", offset=10, count=5)
            self.assertIs(proc, process)
            cmd = popen_mock.call_args[0][0]
            self.assertEqual(cmd[0], "E:\\dev\\dropbox_browser\\rclone.exe")
            self.assertEqual(cmd[1:7], ["cat", "--files-from", cmd[3], "--no-traverse", "--offset", "10"])
            self.assertEqual(cmd[7:11], ["--count", "5", "--", "dropbox:"])
            self.assertEqual(Path(cmd[3]).read_text(encoding="utf-8"), "test/video.mp4")

    def test_cat_command_direct_mode_can_open_byte_range(self) -> None:
        client = RcloneClient("rclone.exe", None)
        cmd, temp_list_path = client._cat_command_for_target(
            "dropbox:test/video.mp4",
            offset=10,
            count=5,
            remote_form="direct",
        )
        self.assertIsNone(temp_list_path)
        self.assertEqual(
            cmd,
            [
                "rclone.exe",
                "cat",
                "--offset",
                "10",
                "--count",
                "5",
                "--",
                "dropbox:test/video.mp4",
            ],
        )

    def test_cat_stream_uses_files_from_and_no_traverse_for_single_remote_file(self) -> None:
        process = FakeCatProcess()
        with (
            tempfile.TemporaryDirectory() as tmpdir,
            patch.object(rclone_module, "TEMP_DIR", Path(tmpdir)),
            patch("dropbox_browser.rclone.subprocess.Popen", return_value=process) as popen_mock,
            patch("dropbox_browser.rclone.logstore.append", return_value=11),
            patch("dropbox_browser.rclone.logstore.update"),
            patch("dropbox_browser.rclone.logoutput.log_start", return_value=22),
            patch("dropbox_browser.rclone.logoutput.log_complete"),
        ):
            client = RcloneClient("rclone.exe", None)
            proc = client.open_cat("dropbox:Camera Uploads/2020-08-07 13.34.35.png")
            cmd = popen_mock.call_args[0][0]
            files_from_path = Path(cmd[3])
            self.assertTrue(files_from_path.exists())
            self.assertEqual(
                cmd,
                [
                    "rclone.exe",
                    "cat",
                    "--files-from",
                    str(files_from_path),
                    "--no-traverse",
                    "--",
                    "dropbox:",
                ],
            )
            self.assertEqual(files_from_path.read_text(encoding="utf-8"), "Camera Uploads/2020-08-07 13.34.35.png")
            client.finish_cat(proc)
            self.assertFalse(files_from_path.exists())

    def test_stat_uses_lsjson_stat_flags(self) -> None:
        completed = subprocess.CompletedProcess(
            ["rclone"],
            0,
            b'{"Name":"file.txt","Path":"dir/file.txt","IsDir":false,"Size":5}',
            b"",
        )
        with (
            patch("dropbox_browser.rclone.subprocess.run", return_value=completed) as run_mock,
            patch("dropbox_browser.rclone.logstore.append", return_value=11),
            patch("dropbox_browser.rclone.logstore.update"),
            patch("dropbox_browser.rclone.logoutput.log_start", return_value=22),
            patch("dropbox_browser.rclone.logoutput.log_complete"),
        ):
            client = RcloneClient("rclone.exe", None)
            item = client.stat("dropbox:dir/file.txt")

        self.assertEqual(
            run_mock.call_args[0][0],
            [
                "rclone.exe",
                "lsjson",
                "--stat",
                "--no-modtime",
                "--no-mimetype",
                "--",
                "dropbox:dir/file.txt",
            ],
        )
        self.assertEqual(item["Path"], "dir/file.txt")
        self.assertEqual(item["Size"], 5)
