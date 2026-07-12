from __future__ import annotations

import json
import shlex
import threading
import tempfile
import time
from contextlib import contextmanager
from dataclasses import dataclass
from http import HTTPStatus
from pathlib import Path
import subprocess
from typing import Any, Callable, Iterator, Literal

from . import logoutput, logstore
from .config import TEMP_DIR
from .errors import BrowserError


class RcloneCancelled(Exception):
    """Raised when a cancelable background rclone command is terminated."""


class RcloneTimeoutError(BrowserError):
    def __init__(self, message: str, attempts: int):
        super().__init__(HTTPStatus.GATEWAY_TIMEOUT, message)
        self.attempts = attempts


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


@dataclass(frozen=True)
class RcloneRetryPolicy:
    max_attempts: int = 25
    min_timeout: float = 10.0
    timeout_per_gib: float = 20.0
    max_initial_timeout: float = 300.0
    timeout_multiplier: float = 2.0
    max_timeout: float = 600.0
    retry_sleep: tuple[float, ...] = (1.0, 2.0, 5.0)

    def timeout_for_attempt(self, attempt: int, size_bytes: int | None = None) -> float:
        size_gib = max(0, size_bytes or 0) / float(1024 ** 3)
        initial = min(self.max_initial_timeout, self.min_timeout + self.timeout_per_gib * size_gib)
        return min(self.max_timeout, initial * (self.timeout_multiplier ** max(0, attempt - 1)))

    def sleep_before_attempt(self, attempt: int) -> float:
        if attempt <= 1 or not self.retry_sleep:
            return 0.0
        index = min(attempt - 2, len(self.retry_sleep) - 1)
        return self.retry_sleep[index]


DEFAULT_WRITE_RETRY_POLICY = RcloneRetryPolicy()


def write_retry_policy_from_config(config: dict[str, Any] | None = None) -> RcloneRetryPolicy:
    """Build a write retry policy from app config keys, falling back to defaults.

    Config keys (all optional):
    - RcloneWriteMaxAttempts
    - RcloneWriteMinTimeoutSeconds
    - RcloneWriteTimeoutPerGibSeconds
    - RcloneWriteMaxInitialTimeoutSeconds
    - RcloneWriteTimeoutMultiplier
    - RcloneWriteMaxTimeoutSeconds
    """
    defaults = DEFAULT_WRITE_RETRY_POLICY
    cfg = config or {}

    def _positive_int(key: str, default: int, *, minimum: int = 1, maximum: int = 100) -> int:
        raw = cfg.get(key, default)
        try:
            value = int(raw)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            value = default
        if value < minimum:
            return minimum
        if value > maximum:
            return maximum
        return value

    def _non_negative_float(key: str, default: float, *, maximum: float = 24 * 60 * 60.0) -> float:
        raw = cfg.get(key, default)
        try:
            value = float(raw)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            value = default
        if value < 0:
            return 0.0
        if value > maximum:
            return maximum
        return value

    max_attempts = _positive_int("RcloneWriteMaxAttempts", defaults.max_attempts)
    min_timeout = _non_negative_float("RcloneWriteMinTimeoutSeconds", defaults.min_timeout)
    timeout_per_gib = _non_negative_float("RcloneWriteTimeoutPerGibSeconds", defaults.timeout_per_gib)
    max_initial_timeout = _non_negative_float(
        "RcloneWriteMaxInitialTimeoutSeconds",
        defaults.max_initial_timeout,
    )
    timeout_multiplier = _non_negative_float(
        "RcloneWriteTimeoutMultiplier",
        defaults.timeout_multiplier,
        maximum=16.0,
    )
    if timeout_multiplier < 1.0:
        timeout_multiplier = 1.0
    max_timeout = _non_negative_float("RcloneWriteMaxTimeoutSeconds", defaults.max_timeout)
    # Keep caps ordered so later attempts are never shorter than the initial budget.
    max_initial_timeout = max(min_timeout, max_initial_timeout)
    max_timeout = max(max_initial_timeout, max_timeout)
    return RcloneRetryPolicy(
        max_attempts=max_attempts,
        min_timeout=min_timeout,
        timeout_per_gib=timeout_per_gib,
        max_initial_timeout=max_initial_timeout,
        timeout_multiplier=timeout_multiplier,
        max_timeout=max_timeout,
        retry_sleep=defaults.retry_sleep,
    )


_RETRYABLE_DROPBOX_THROTTLE_MARKERS = (
    "too_many_write_operations",
    "too many write operations",
    "too_many_requests",
    "rate limit",
    "too many requests",
    "please retry",
)


def _looks_like_rclone_remote(value: str) -> bool:
    colon_index = value.find(":")
    if colon_index <= 0:
        return False
    prefix = value[:colon_index]
    if len(prefix) == 1 and prefix.isalpha():
        return False
    return "\\" not in prefix and "/" not in prefix


def _is_remote_target(value: str | Path) -> bool:
    return _looks_like_rclone_remote(str(value))


def _is_local_upload(source: str | Path, destination: str | Path) -> bool:
    return not _is_remote_target(source) and _is_remote_target(destination)


def is_retryable_dropbox_throttle_message(message: str) -> bool:
    normalized = (message or "").strip().casefold()
    if not normalized:
        return False
    return any(marker in normalized for marker in _RETRYABLE_DROPBOX_THROTTLE_MARKERS)


def is_retryable_dropbox_throttle_error(exc: BaseException) -> bool:
    return is_retryable_dropbox_throttle_message(str(exc))


class RcloneClient:
    def __init__(self, executable: str, config: str | None, log_commands: bool = True):
        self.executable = executable
        self.config = config
        self.log_commands = log_commands
        self.write_retry_policy = DEFAULT_WRITE_RETRY_POLICY
        # Optional callback returning (completed, dispatched) for the current page.
        # Set externally after construction.
        self.progress_fn: Callable[[], tuple[int, int]] | None = None
        self._progress_context = threading.local()
        self._lsjson_inflight_guard = threading.Lock()
        self._lsjson_inflight: dict[str, dict[str, Any]] = {}
        self._stream_log_guard = threading.Lock()
        self._stream_logs: dict[int, tuple[list[str], int, int, float, Path | None]] = {}
        self._shutdown_guard = threading.Lock()
        self._shutdown_event = threading.Event()
        self._active_process_guard = threading.Lock()
        self._active_processes: set[subprocess.Popen[bytes]] = set()

    def shutdown(self) -> None:
        with self._shutdown_guard:
            if self._shutdown_event.is_set():
                return
            self._shutdown_event.set()
        with self._active_process_guard:
            active_processes = list(self._active_processes)
        for process in active_processes:
            poll = getattr(process, "poll", None)
            if callable(poll):
                try:
                    if poll() is not None:
                        continue
                except Exception:
                    pass
            try:
                process.kill()
            except OSError:
                pass

    def command(self, *args: str) -> list[str]:
        cmd = [self.executable]
        if self.config:
            cmd += ["--config", self.config]
        cmd += list(args)
        return cmd

    def _track_process(self, process: subprocess.Popen[bytes]) -> None:
        with self._active_process_guard:
            self._active_processes.add(process)
            shutting_down = self._shutdown_event.is_set()
        if shutting_down:
            try:
                process.kill()
            except OSError:
                pass
            raise RcloneCancelled()

    def _untrack_process(self, process: subprocess.Popen[bytes]) -> None:
        with self._active_process_guard:
            self._active_processes.discard(process)

    def _log_start(self, cmd: list[str]) -> tuple[int, int]:
        """Log command start to logstore and terminal. Returns (logstore_id, logoutput_id)."""
        msg = shlex.join(cmd)
        logstore_id = logstore.append("rclone", "[...] " + msg)
        logoutput_id = logoutput.log_start("[...] " + msg) if self.log_commands else 0
        return (logstore_id, logoutput_id)

    def _log_complete(
        self, cmd: list[str], prefix: str, elapsed: float,
        logstore_id: int, logoutput_id: int,
    ) -> None:
        """Update the start log entry with timing and progress."""
        msg = prefix + " " + shlex.join(cmd)
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

    def _log_retry_event(self, message: str) -> None:
        logstore.append("rclone", message)
        if self.log_commands:
            logoutput.log_plain(time.strftime("%H:%M:%S"), message)

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
        if cancel_token.cancelled or self._shutdown_event.is_set():
            raise RcloneCancelled()
        process = subprocess.Popen(
            cmd,
            stdin=input_file,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self._track_process(process)
        if not cancel_token.attach(process):
            try:
                process.kill()
            except OSError:
                pass
        try:
            stdout, stderr = process.communicate()
            if cancel_token.cancelled or self._shutdown_event.is_set():
                raise RcloneCancelled()
            return subprocess.CompletedProcess(cmd, process.returncode, stdout, stderr)
        finally:
            cancel_token.detach(process)
            self._untrack_process(process)
            if (cancel_token.cancelled or self._shutdown_event.is_set()) and process.poll() is None:
                try:
                    process.kill()
                except OSError:
                    pass

    def _run_with_retry(
        self,
        cmd: list[str],
        input_file: Any | None,
        policy: RcloneRetryPolicy,
        size_bytes: int | None,
        started_at: float,
    ) -> tuple[subprocess.CompletedProcess[bytes], int]:
        attempts = max(1, policy.max_attempts)
        command_text = shlex.join(cmd)
        last_timeout = 0.0
        last_stderr = b""
        for attempt in range(1, attempts + 1):
            if self._shutdown_event.is_set():
                raise RcloneCancelled()
            sleep_seconds = policy.sleep_before_attempt(attempt)
            if sleep_seconds > 0 and self._shutdown_event.wait(sleep_seconds):
                raise RcloneCancelled()
            timeout = policy.timeout_for_attempt(attempt, size_bytes)
            if attempt > 1:
                self._log_retry_event(
                    f"[retry attempt={attempt}/{attempts} timeout={timeout:.2f}s size={size_bytes or 0}B] {command_text}"
                )
            if input_file is not None:
                seek = getattr(input_file, "seek", None)
                if callable(seek):
                    seek(0)
            process = subprocess.Popen(
                cmd,
                stdin=input_file,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            self._track_process(process)
            try:
                stdout, stderr = process.communicate(timeout=timeout)
                if self._shutdown_event.is_set():
                    raise RcloneCancelled()
            except subprocess.TimeoutExpired:
                last_timeout = timeout
                try:
                    process.kill()
                except OSError:
                    pass
                try:
                    stdout, stderr = process.communicate()
                except Exception:
                    stderr = b""
                last_stderr = stderr or b""
                next_timeout = policy.timeout_for_attempt(attempt + 1, size_bytes) if attempt < attempts else 0.0
                if attempt < attempts:
                    self._log_retry_event(
                        f"[{timeout:.2f}s timeout attempt={attempt}/{attempts} next={next_timeout:.2f}s "
                        f"size={size_bytes or 0}B killed] {command_text}"
                    )
                    continue
                stderr_text = last_stderr.decode("utf-8", "replace").strip()
                detail = f": {stderr_text}" if stderr_text else ""
                total_elapsed = time.monotonic() - started_at
                raise RcloneTimeoutError(
                    f"rclone timed out after {attempts} attempt(s), last timeout {last_timeout:.2f}s, "
                    f"elapsed {total_elapsed:.2f}s{detail}",
                    attempts,
                )
            finally:
                self._untrack_process(process)
            return subprocess.CompletedProcess(cmd, process.returncode, stdout, stderr), attempt
        raise BrowserError(HTTPStatus.GATEWAY_TIMEOUT, "rclone timed out before starting.")

    def run(
        self,
        *args: str,
        input_file: Any | None = None,
        cancel_token: RcloneCancelToken | None = None,
        retry_policy: RcloneRetryPolicy | None = None,
        size_bytes: int | None = None,
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
        attempt_count = 1
        try:
            if cancel_token is not None:
                result = self._run_cancelable(cmd, input_file, cancel_token)
            elif retry_policy is not None:
                result, attempt_count = self._run_with_retry(cmd, input_file, retry_policy, size_bytes, t0)
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
            prefix = f"[{elapsed:.2f}s canceled]"
            self._log_complete(cmd, prefix, elapsed, logstore_id, logoutput_id)
            raise
        except RcloneTimeoutError as exc:
            if inflight is not None:
                inflight["error"] = exc
            elapsed = time.monotonic() - t0
            prefix = f"[{elapsed:.2f}s timeout exhausted attempts={exc.attempts}]"
            self._log_complete(cmd, prefix, elapsed, logstore_id, logoutput_id)
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
            prefix = f"[{elapsed:.2f}s {progress_str}"
        elif self.progress_fn:
            done, total = self.progress_fn()
            progress_str = f"{done}/{total}"
            prefix = f"[{elapsed:.2f}s {progress_str}]"
        else:
            progress_str = ""
            prefix = f"[{elapsed:.2f}s]"
        if attempt_count > 1:
            prefix = prefix[:-1] + f" attempt={attempt_count}/{max(1, (retry_policy or self.write_retry_policy).max_attempts)}]"
        self._log_complete(cmd, prefix, elapsed, logstore_id, logoutput_id)
        return result

    def lsjson(self, target: str) -> list[dict[str, Any]]:
        proc = self.run("lsjson", "--", target)
        if proc.returncode != 0:
            message = proc.stderr.decode("utf-8", "replace").strip() or "Could not list Dropbox folder."
            raise BrowserError(HTTPStatus.BAD_GATEWAY, message)
        if not proc.stdout.strip():
            return []
        return json.loads(proc.stdout.decode("utf-8"))

    def stat(self, target: str) -> dict[str, Any]:
        proc = self.run("lsjson", "--stat", "--no-modtime", "--no-mimetype", "--", target)
        if proc.returncode != 0:
            message = proc.stderr.decode("utf-8", "replace").strip() or "Could not stat Dropbox path."
            raise BrowserError(HTTPStatus.BAD_GATEWAY, message)
        if not proc.stdout.strip():
            raise BrowserError(HTTPStatus.NOT_FOUND, "Remote file not found.")
        data = json.loads(proc.stdout.decode("utf-8"))
        if not isinstance(data, dict):
            raise BrowserError(HTTPStatus.BAD_GATEWAY, "Could not stat Dropbox path.")
        return data

    def exists(self, target: str) -> bool:
        proc = self.run("lsjson", "--", target)
        return proc.returncode == 0

    def copy_file_overwrite(self, source: str | Path, destination: str | Path, size_bytes: int | None = None) -> None:
        if _is_local_upload(source, destination):
            source_path = Path(str(source))
            upload_size = size_bytes if size_bytes is not None else source_path.stat().st_size
            with source_path.open("rb") as input_file:
                proc = self.run(
                    "rcat",
                    "--size",
                    str(upload_size),
                    "--",
                    str(destination),
                    input_file=input_file,
                    retry_policy=self.write_retry_policy,
                    size_bytes=upload_size,
                )
            if proc.returncode != 0:
                message = proc.stderr.decode("utf-8", "replace").strip() or "File sync failed."
                raise BrowserError(HTTPStatus.BAD_GATEWAY, message)
            return
        args = ["copyto", "--", str(source), str(destination)]
        proc = self.run(*args, retry_policy=self.write_retry_policy, size_bytes=size_bytes)
        if proc.returncode != 0:
            message = proc.stderr.decode("utf-8", "replace").strip() or "File sync failed."
            raise BrowserError(HTTPStatus.BAD_GATEWAY, message)

    def mkdir(self, target: str) -> None:
        proc = self.run("mkdir", "--", target, retry_policy=self.write_retry_policy, size_bytes=0)
        if proc.returncode != 0:
            message = proc.stderr.decode("utf-8", "replace").strip() or "Folder sync failed."
            raise BrowserError(HTTPStatus.BAD_GATEWAY, message)

    def _cat_command_for_target(
        self,
        target: str,
        *,
        offset: int | None = None,
        count: int | None = None,
        remote_form: Literal["files-from", "direct"] = "files-from",
    ) -> tuple[list[str], Path | None]:
        args = ["cat"]
        temp_list_path: Path | None = None
        if _is_remote_target(target):
            if remote_form == "direct":
                if offset is not None:
                    args += ["--offset", str(offset)]
                if count is not None:
                    args += ["--count", str(count)]
                args += ["--", target]
                return self.command(*args), None
            if remote_form != "files-from":
                raise ValueError(f"Unsupported remote_form: {remote_form}")
            remote_name, rel_path = target.split(":", 1)
            root_target = remote_name + ":"
            TEMP_DIR.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(
                "w",
                encoding="utf-8",
                dir=TEMP_DIR,
                prefix="rclone-cat-files-",
                suffix=".txt",
                delete=False,
                newline="\n",
            ) as handle:
                handle.write(rel_path)
                temp_list_path = Path(handle.name)
            args += ["--files-from", str(temp_list_path), "--no-traverse"]
            if offset is not None:
                args += ["--offset", str(offset)]
            if count is not None:
                args += ["--count", str(count)]
            args += ["--", root_target]
            return self.command(*args), temp_list_path
        if offset is not None:
            args += ["--offset", str(offset)]
        if count is not None:
            args += ["--count", str(count)]
        args += ["--", target]
        return self.command(*args), None

    def open_cat(
        self,
        target: str,
        offset: int | None = None,
        count: int | None = None,
        *,
        remote_form: Literal["files-from", "direct"] = "files-from",
    ) -> subprocess.Popen[bytes]:
        cmd, temp_list_path = self._cat_command_for_target(
            target,
            offset=offset,
            count=count,
            remote_form=remote_form,
        )
        logstore_id, logoutput_id = self._log_start(cmd)
        started_at = time.monotonic()
        try:
            process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            self._track_process(process)
            with self._stream_log_guard:
                self._stream_logs[id(process)] = (cmd, logstore_id, logoutput_id, started_at, temp_list_path)
            return process
        except FileNotFoundError as exc:
            if temp_list_path is not None:
                try:
                    temp_list_path.unlink(missing_ok=True)
                except OSError:
                    pass
            elapsed = time.monotonic() - started_at
            self._log_complete(cmd, f"[{elapsed:.2f}s error]", elapsed, logstore_id, logoutput_id)
            raise BrowserError(HTTPStatus.INTERNAL_SERVER_ERROR, f"rclone was not found: {exc}") from exc

    def finish_cat(self, process: subprocess.Popen[bytes], stream_error: Exception | None = None) -> None:
        with self._stream_log_guard:
            state = self._stream_logs.pop(id(process), None)
        self._untrack_process(process)
        if state is None:
            return
        cmd, logstore_id, logoutput_id, started_at, temp_list_path = state
        elapsed = time.monotonic() - started_at
        stderr_text = ""
        if process.stderr is not None:
            try:
                stderr_text = process.stderr.read().decode("utf-8", "replace").strip()
            except Exception:
                stderr_text = ""
        if temp_list_path is not None:
            try:
                temp_list_path.unlink(missing_ok=True)
            except OSError:
                pass
        if stream_error is not None:
            if isinstance(stream_error, (BrokenPipeError, ConnectionAbortedError)):
                prefix = f"[{elapsed:.2f}s client disconnected]"
            else:
                prefix = f"[{elapsed:.2f}s error]"
        elif process.returncode and process.returncode != 0:
            detail = f": {stderr_text}" if stderr_text else ""
            prefix = f"[{elapsed:.2f}s error rc={process.returncode}{detail}]"
        else:
            prefix = f"[{elapsed:.2f}s streamed]"
        self._log_complete(cmd, prefix, elapsed, logstore_id, logoutput_id)
