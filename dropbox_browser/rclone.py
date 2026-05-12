from __future__ import annotations

import json
import shlex
import time
from http import HTTPStatus
from pathlib import Path
import subprocess
from typing import Any, Callable

from . import logoutput, logstore
from .errors import BrowserError


class RcloneClient:
    def __init__(self, executable: str, config: str | None, log_commands: bool = True):
        self.executable = executable
        self.config = config
        self.log_commands = log_commands
        # Optional callback returning (completed, dispatched) for the current page.
        # Set externally after construction.
        self.progress_fn: Callable[[], tuple[int, int]] | None = None

    def command(self, *args: str) -> list[str]:
        cmd = [self.executable]
        if self.config:
            cmd += ["--config", self.config]
        cmd += list(args)
        return cmd

    def _log_start(self, cmd: list[str]) -> tuple[int, int]:
        """Log command start to logstore and terminal. Returns (logstore_id, logoutput_id)."""
        msg = shlex.join(cmd)
        logstore_id = logstore.append("rclone", msg + "  [...]")
        logoutput_id = logoutput.log_start(msg) if self.log_commands else 0
        return (logstore_id, logoutput_id)

    def _log_complete(
        self, cmd: list[str], suffix: str, elapsed: float,
        logstore_id: int, logoutput_id: int,
    ) -> None:
        """Update the start log entry with timing and progress."""
        msg = shlex.join(cmd) + suffix
        logstore.update(logstore_id, msg, elapsed=elapsed)
        if self.log_commands:
            logoutput.log_complete(logoutput_id, msg, elapsed)

    def _log_plain_cmd(self, cmd: list[str]) -> None:
        """Log a command without timing markers (used for streaming calls)."""
        msg = shlex.join(cmd)
        logstore.append("rclone", msg)
        if self.log_commands:
            ts = time.strftime("%H:%M:%S")
            logoutput.log_plain(ts, msg)

    def run(self, *args: str, input_file: Any | None = None) -> subprocess.CompletedProcess[bytes]:
        cmd = self.command(*args)
        logstore_id, logoutput_id = self._log_start(cmd)
        t0 = time.monotonic()
        try:
            result = subprocess.run(
                cmd,
                stdin=input_file,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )
        except FileNotFoundError as exc:
            raise BrowserError(HTTPStatus.INTERNAL_SERVER_ERROR, f"rclone was not found: {exc}") from exc
        elapsed = time.monotonic() - t0
        if self.progress_fn:
            done, total = self.progress_fn()
            progress_str = f"{done}/{total}"
        else:
            progress_str = ""
        suffix = f"  [{elapsed:.2f}s" + (f", {progress_str}]" if progress_str else "]")
        self._log_complete(cmd, suffix, elapsed, logstore_id, logoutput_id)
        return result

    def lsjson(self, target: str) -> list[dict[str, Any]]:
        proc = self.run("lsjson", "--", target)
        if proc.returncode != 0:
            message = proc.stderr.decode("utf-8", "replace").strip() or "Could not list Dropbox folder."
            raise BrowserError(HTTPStatus.BAD_GATEWAY, message)
        if not proc.stdout.strip():
            return []
        return json.loads(proc.stdout.decode("utf-8"))

    def exists(self, target: str) -> bool:
        proc = self.run("lsjson", "--", target)
        return proc.returncode == 0

    def copy_file_to_remote(self, source: Path, destination: str) -> None:
        proc = self.run("copyto", "--ignore-existing", "--", str(source), destination)
        if proc.returncode != 0:
            message = proc.stderr.decode("utf-8", "replace").strip() or "Upload failed."
            raise BrowserError(HTTPStatus.BAD_GATEWAY, message)

    def open_cat(self, target: str) -> subprocess.Popen[bytes]:
        cmd = self.command("cat", "--", target)
        self._log_plain_cmd(cmd)
        try:
            return subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
        except FileNotFoundError as exc:
            raise BrowserError(HTTPStatus.INTERNAL_SERVER_ERROR, f"rclone was not found: {exc}") from exc

