from __future__ import annotations

import json
import shlex
import sys
import time
from http import HTTPStatus
from pathlib import Path
import subprocess
from typing import Any, Callable

from . import logstore
from .errors import BrowserError


class RcloneClient:
    def __init__(self, executable: str, config: str | None, log_commands: bool = True):
        self.executable = executable
        self.config = config
        self.log_commands = log_commands
        # Optional callback that returns the number of items still queued for
        # the current page.  Set externally after construction.
        self.pending_count_fn: Callable[[], int] | None = None

    def command(self, *args: str) -> list[str]:
        cmd = [self.executable]
        if self.config:
            cmd += ["--config", self.config]
        cmd += list(args)
        return cmd

    def _log_command(self, cmd: list[str], suffix: str = "") -> None:
        msg = shlex.join(cmd) + suffix
        logstore.append("rclone", msg)
        if self.log_commands:
            sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), msg))

    def run(self, *args: str, input_file: Any | None = None) -> subprocess.CompletedProcess[bytes]:
        cmd = self.command(*args)
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
        pending = self.pending_count_fn() if self.pending_count_fn else 0
        pending_str = f"{pending} pending" if pending else "0 pending"
        self._log_command(cmd, suffix=f"  [{elapsed:.2f}s, {pending_str}]")
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
        self._log_command(cmd)
        try:
            return subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
        except FileNotFoundError as exc:
            raise BrowserError(HTTPStatus.INTERNAL_SERVER_ERROR, f"rclone was not found: {exc}") from exc
