from __future__ import annotations

import json
from http import HTTPStatus
from pathlib import Path
import subprocess
from typing import Any

from .errors import BrowserError


class RcloneClient:
    def __init__(self, executable: str, config: str | None):
        self.executable = executable
        self.config = config

    def command(self, *args: str) -> list[str]:
        cmd = [self.executable]
        if self.config:
            cmd += ["--config", self.config]
        cmd += list(args)
        return cmd

    def run(self, *args: str, input_file: Any | None = None) -> subprocess.CompletedProcess[bytes]:
        try:
            return subprocess.run(
                self.command(*args),
                stdin=input_file,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )
        except FileNotFoundError as exc:
            raise BrowserError(HTTPStatus.INTERNAL_SERVER_ERROR, f"rclone was not found: {exc}") from exc

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
        try:
            return subprocess.Popen(
                self.command("cat", "--", target),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
        except FileNotFoundError as exc:
            raise BrowserError(HTTPStatus.INTERNAL_SERVER_ERROR, f"rclone was not found: {exc}") from exc
