from __future__ import annotations

import json
import shlex
import threading
import time
from contextlib import contextmanager
from http import HTTPStatus
from pathlib import Path
import subprocess
from typing import Any, Callable, Iterator

from . import logoutput, logstore
from .errors import BrowserError


class RcloneCancelled(Exception):
    """Raised when a cancelable background rclone command is terminated."""


class RcloneCancelToken:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._cancelled = False
        self._process: subprocess.Popen[bytes] | None = None

    @property
    def cancelled(self) -> bool:
        with self._lock:
            return self._cancelled

    def attach(self, process: subprocess.Popen[bytes]) -> bool:
        with self._lock:
            self._process = process
            return not self._cancelled

    def detach(self, process: subprocess.Popen[bytes]) -> None:
        with self._lock:
            if self._process is process:
                self._process = None

    def cancel(self) -> None:
        with self._lock:
            self._cancelled = True
            process = self._process
        if process is not None and process.poll() is None:
            try:
                process.kill()
            except OSError:
                pass


class RcloneClient:
    def __init__(self, executable: str, config: str | None, log_commands: bool = True):
        self.executable = executable
        self.config = config
        self.log_commands = log_commands
        # Optional callback returning (completed, dispatched) for the current page.
        # Set externally after construction.
        self.progress_fn: Callable[[], tuple[int, int]] | None = None
        self._progress_context = threading.local()
        self._lsjson_inflight_guard = threading.Lock()
        self._lsjson_inflight: dict[str, dict[str, Any]] = {}
        self._stream_log_guard = threading.Lock()
        self._stream_logs: dict[int, tuple[list[str], int, int, float]] = {}

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

    def _lsjson_target(self, args: tuple[str, ...]) -> str | None:
        if len(args) >= 3 and args[0] == "lsjson" and args[-2] == "--":
            return args[-1]
        return None

    @contextmanager
    def progress_context(self, progress_fn: Callable[[], str]) -> Iterator[None]:
        previous = getattr(self._progress_context, "fn", None)
        self._progress_context.fn = progress_fn
        try:
            yield
        finally:
            if previous is None:
                try:
                    del self._progress_context.fn
                except AttributeError:
                    pass
            else:
                self._progress_context.fn = previous

    def _run_cancelable(
        self,
        cmd: list[str],
        input_file: Any | None,
        cancel_token: RcloneCancelToken,
    ) -> subprocess.CompletedProcess[bytes]:
        if cancel_token.cancelled:
            raise RcloneCancelled()
        process = subprocess.Popen(
            cmd,
            stdin=input_file,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        if not cancel_token.attach(process):
            try:
                process.kill()
            except OSError:
                pass
        try:
            stdout, stderr = process.communicate()
            if cancel_token.cancelled:
                raise RcloneCancelled()
            return subprocess.CompletedProcess(cmd, process.returncode, stdout, stderr)
        finally:
            cancel_token.detach(process)
            if cancel_token.cancelled and process.poll() is None:
                try:
                    process.kill()
                except OSError:
                    pass

    def run(
        self,
        *args: str,
        input_file: Any | None = None,
        cancel_token: RcloneCancelToken | None = None,
    ) -> subprocess.CompletedProcess[bytes]:
        lsjson_target = self._lsjson_target(args)
        if lsjson_target is not None and input_file is None and cancel_token is None:
            with self._lsjson_inflight_guard:
                inflight = self._lsjson_inflight.get(lsjson_target)
                if inflight is None:
                    inflight = {"event": threading.Event(), "result": None, "error": None}
                    self._lsjson_inflight[lsjson_target] = inflight
                    owner = True
                else:
                    owner = False
            if not owner:
                inflight["event"].wait()
                if inflight["error"] is not None:
                    raise inflight["error"]
                return inflight["result"]
        else:
            inflight = None
            owner = False

        cmd = self.command(*args)
        logstore_id, logoutput_id = self._log_start(cmd)
        t0 = time.monotonic()
        try:
            if cancel_token is not None:
                result = self._run_cancelable(cmd, input_file, cancel_token)
            else:
                result = subprocess.run(
                    cmd,
                    stdin=input_file,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    check=False,
                )
        except FileNotFoundError as exc:
            error = BrowserError(HTTPStatus.INTERNAL_SERVER_ERROR, f"rclone was not found: {exc}")
            if inflight is not None:
                inflight["error"] = error
            raise error from exc
        except RcloneCancelled as exc:
            if inflight is not None:
                inflight["error"] = exc
            elapsed = time.monotonic() - t0
            suffix = f"  [{elapsed:.2f}s, canceled]"
            self._log_complete(cmd, suffix, elapsed, logstore_id, logoutput_id)
            raise
        except Exception as exc:
            if inflight is not None:
                inflight["error"] = exc
            raise
        finally:
            if inflight is not None and owner:
                if "result" in locals():
                    inflight["result"] = result
                inflight["event"].set()
                with self._lsjson_inflight_guard:
                    self._lsjson_inflight.pop(lsjson_target, None)
        elapsed = time.monotonic() - t0
        context_progress_fn = getattr(self._progress_context, "fn", None)
        if context_progress_fn is not None:
            progress_str = context_progress_fn()
            suffix = f"  [{elapsed:.2f}s, {progress_str}"
        elif self.progress_fn:
            done, total = self.progress_fn()
            progress_str = f"{done}/{total}"
            suffix = f"  [{elapsed:.2f}s, {progress_str}]"
        else:
            progress_str = ""
            suffix = f"  [{elapsed:.2f}s]"
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

    def copy_file_overwrite(self, source: str | Path, destination: str | Path) -> None:
        proc = self.run("copyto", "--", str(source), str(destination))
        if proc.returncode != 0:
            message = proc.stderr.decode("utf-8", "replace").strip() or "File sync failed."
            raise BrowserError(HTTPStatus.BAD_GATEWAY, message)

    def mkdir(self, target: str) -> None:
        proc = self.run("mkdir", "--", target)
        if proc.returncode != 0:
            message = proc.stderr.decode("utf-8", "replace").strip() or "Folder sync failed."
            raise BrowserError(HTTPStatus.BAD_GATEWAY, message)

    def open_cat(self, target: str, offset: int | None = None, count: int | None = None) -> subprocess.Popen[bytes]:
        args = ["cat"]
        if offset is not None:
            args += ["--offset", str(offset)]
        if count is not None:
            args += ["--count", str(count)]
        args += ["--", target]
        cmd = self.command(*args)
        logstore_id, logoutput_id = self._log_start(cmd)
        started_at = time.monotonic()
        try:
            process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            with self._stream_log_guard:
                self._stream_logs[id(process)] = (cmd, logstore_id, logoutput_id, started_at)
            return process
        except FileNotFoundError as exc:
            elapsed = time.monotonic() - started_at
            self._log_complete(cmd, f"  [{elapsed:.2f}s, error]", elapsed, logstore_id, logoutput_id)
            raise BrowserError(HTTPStatus.INTERNAL_SERVER_ERROR, f"rclone was not found: {exc}") from exc

    def finish_cat(self, process: subprocess.Popen[bytes], stream_error: Exception | None = None) -> None:
        with self._stream_log_guard:
            state = self._stream_logs.pop(id(process), None)
        if state is None:
            return
        cmd, logstore_id, logoutput_id, started_at = state
        elapsed = time.monotonic() - started_at
        stderr_text = ""
        if process.stderr is not None:
            try:
                stderr_text = process.stderr.read().decode("utf-8", "replace").strip()
            except Exception:
                stderr_text = ""
        if stream_error is not None:
            if isinstance(stream_error, (BrokenPipeError, ConnectionAbortedError)):
                suffix = f"  [{elapsed:.2f}s, client disconnected]"
            else:
                suffix = f"  [{elapsed:.2f}s, error]"
        elif process.returncode and process.returncode != 0:
            detail = f": {stderr_text}" if stderr_text else ""
            suffix = f"  [{elapsed:.2f}s, error rc={process.returncode}{detail}]"
        else:
            suffix = f"  [{elapsed:.2f}s, streamed]"
        self._log_complete(cmd, suffix, elapsed, logstore_id, logoutput_id)
