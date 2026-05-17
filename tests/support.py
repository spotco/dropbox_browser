from __future__ import annotations

import copy
import io
import json
import tempfile
import threading
import time
import unittest
from dataclasses import dataclass
from http import HTTPStatus
from http.server import ThreadingHTTPServer
from pathlib import Path
from subprocess import CompletedProcess
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from unittest.mock import patch

from dropbox_browser.errors import BrowserError
from dropbox_browser.handlers import RequestHandler
import dropbox_browser.config as config_module
import dropbox_browser.foldercache as foldercache_module
import dropbox_browser.listingcache as listingcache_module
import dropbox_browser.workertrace as workertrace_module
from dropbox_browser.rclone import RcloneCancelled


@dataclass
class SimulatedLsjsonResponse:
    items: list[dict[str, Any]] | None = None
    delay: float = 0.0
    wait_event: threading.Event | None = None
    started_event: threading.Event | None = None
    exception: Exception | None = None
    invalid_json: bool = False
    returncode: int = 0
    stderr: bytes = b""


class SimulatedCatProcess:
    def __init__(self, data: bytes):
        self.stdout = io.BytesIO(data)
        self.stderr = io.BytesIO()
        self.returncode = 0
        self.killed = False

    def wait(self, timeout: float | None = None) -> int:
        return 0

    def poll(self) -> int | None:
        return self.returncode

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9


class SimulatedRclone:
    """Fake rclone implementation for app and background-worker tests."""

    def __init__(
        self,
        lsjson_responses: dict[str, list[SimulatedLsjsonResponse]] | None = None,
        cat_data: dict[str, bytes] | None = None,
    ) -> None:
        self._responses = {target: list(items) for target, items in (lsjson_responses or {}).items()}
        self._lock = threading.Lock()
        self.calls: list[dict[str, Any]] = []
        self.cat_data = dict(cat_data or {})
        self.progress_fn = None

    def _next_response(self, target: str) -> SimulatedLsjsonResponse:
        with self._lock:
            responses = self._responses.get(target)
            if not responses:
                raise AssertionError(f"No simulated lsjson response configured for {target!r}")
            response = responses[0]
            if len(responses) > 1:
                responses.pop(0)
            return response

    def _record_call(self, target: str, args: tuple[str, ...], cancelable: bool) -> None:
        with self._lock:
            self.calls.append({
                "target": target,
                "args": args,
                "cancelable": cancelable,
                "time": time.monotonic(),
            })

    def _wait(self, response: SimulatedLsjsonResponse, cancel_token: Any | None) -> None:
        if response.started_event is not None:
            response.started_event.set()
        deadline = time.monotonic() + response.delay
        while True:
            if cancel_token is not None and cancel_token.cancelled:
                raise RcloneCancelled()
            delay_done = time.monotonic() >= deadline
            gate_done = response.wait_event is None or response.wait_event.is_set()
            if delay_done and gate_done:
                return
            time.sleep(0.01)

    def _execute_lsjson(self, target: str, args: tuple[str, ...], cancel_token: Any | None) -> SimulatedLsjsonResponse:
        self._record_call(target, args, cancelable=cancel_token is not None)
        response = self._next_response(target)
        self._wait(response, cancel_token)
        if response.exception is not None:
            raise response.exception
        return response

    def run(
        self,
        *args: str,
        input_file: Any | None = None,
        cancel_token: Any | None = None,
    ) -> CompletedProcess[bytes]:
        if input_file is not None:
            raise AssertionError("SimulatedRclone does not support stdin input")
        if not args:
            raise AssertionError(f"Unsupported simulated rclone command: {args!r}")
        if args[0] == "lsjson":
            target = args[-1]
            response = self._execute_lsjson(target, args, cancel_token)
            stdout = b"{invalid json" if response.invalid_json else json.dumps(copy.deepcopy(response.items) or []).encode("utf-8")
            return CompletedProcess(list(args), response.returncode, stdout, response.stderr)
        if args[0] == "copyto":
            source = args[-2]
            destination = args[-1]
            self._record_call(destination, args, cancelable=cancel_token is not None)
            source_path = Path(source)
            destination_path = Path(destination)
            if source_path.exists():
                self.cat_data[destination] = source_path.read_bytes()
            elif source in self.cat_data:
                destination_path.parent.mkdir(parents=True, exist_ok=True)
                destination_path.write_bytes(self.cat_data[source])
            return CompletedProcess(list(args), 0, b"", b"")
        if args[0] == "mkdir":
            target = args[-1]
            self._record_call(target, args, cancelable=cancel_token is not None)
            return CompletedProcess(list(args), 0, b"", b"")
        raise AssertionError(f"Unsupported simulated rclone command: {args!r}")

    def lsjson(self, target: str) -> list[dict[str, Any]]:
        response = self._execute_lsjson(target, ("lsjson", "--", target), cancel_token=None)
        if response.returncode != 0:
            message = response.stderr.decode("utf-8", "replace").strip() or "Could not list Dropbox folder."
            raise BrowserError(HTTPStatus.BAD_GATEWAY, message)
        return copy.deepcopy(response.items) or []

    def exists(self, target: str) -> bool:
        return target in self.cat_data

    def copy_file_overwrite(self, source: str | Path, destination: str | Path) -> None:
        self.run("copyto", "--", str(source), str(destination))

    def mkdir(self, target: str) -> None:
        self.run("mkdir", "--", target)

    def open_cat(self, target: str, offset: int | None = None, count: int | None = None) -> SimulatedCatProcess:
        if target not in self.cat_data:
            raise BrowserError(HTTPStatus.NOT_FOUND, "Remote file not found.")
        args = ["cat"]
        if offset is not None:
            args += ["--offset", str(offset)]
        if count is not None:
            args += ["--count", str(count)]
        args += ["--", target]
        self._record_call(target, tuple(args), cancelable=False)
        data = self.cat_data[target]
        if offset is not None:
            data = data[offset:]
        if count is not None:
            data = data[:count]
        return SimulatedCatProcess(data)

    def finish_cat(self, process: SimulatedCatProcess, stream_error: Exception | None = None) -> None:
        return None


class TestServer:
    def __init__(self, app: Any):
        self.app = app
        self.server: ThreadingHTTPServer | None = None
        self.thread: threading.Thread | None = None

    def __enter__(self) -> "TestServer":
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), RequestHandler)
        self.server.app = self.app  # type: ignore[attr-defined]
        self.server.log_requests = False  # type: ignore[attr-defined]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True, name="test-http-server")
        self.thread.start()
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        assert self.server is not None
        assert self.thread is not None
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    @property
    def base_url(self) -> str:
        assert self.server is not None
        host, port = self.server.server_address
        return f"http://{host}:{port}"

    def get_text(self, path: str) -> str:
        with urlopen(self.base_url + path, timeout=5) as response:
            return response.read().decode("utf-8")

    def get_json(self, path: str) -> dict[str, Any]:
        return json.loads(self.get_text(path))

    def post_json(self, path: str, data: dict[str, str]) -> dict[str, Any]:
        body = urlencode(data).encode("utf-8")
        request = Request(
            self.base_url + path,
            data=body,
            method="POST",
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        with urlopen(request, timeout=5) as response:
            return json.loads(response.read().decode("utf-8"))


class IsolatedPathsTestCase(unittest.TestCase):
    def setUp(self) -> None:
        super().setUp()
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.folder_cache_dir = self.root / "Cache" / "FolderInfo"
        self.listing_cache_dir = self.root / "Cache" / "ListingCache"
        self.temp_dir = self.root / "Temp"
        self.trace_log_path = self.temp_dir / "foldercache_threads.jsonl"
        self._patchers = [
            patch.object(foldercache_module, "CACHE_DIR", self.folder_cache_dir),
            patch.object(listingcache_module, "CACHE_DIR", self.listing_cache_dir),
            patch.object(config_module, "TEMP_DIR", self.temp_dir),
            patch.object(workertrace_module, "TEMP_DIR", self.temp_dir),
            patch.object(workertrace_module, "TRACE_LOG_PATH", self.trace_log_path),
        ]
        for patcher in self._patchers:
            patcher.start()
            self.addCleanup(patcher.stop)

    def create_local_root(self, files: dict[str, bytes | str | None]) -> Path:
        root = self.root / "local"
        root.mkdir(parents=True, exist_ok=True)
        for rel_path, contents in files.items():
            path = root.joinpath(*rel_path.split("/"))
            if contents is None:
                path.mkdir(parents=True, exist_ok=True)
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            if isinstance(contents, bytes):
                path.write_bytes(contents)
            else:
                path.write_text(contents, encoding="utf-8")
        return root

    def read_trace_events(self) -> list[dict[str, Any]]:
        if not self.trace_log_path.exists():
            return []
        return [
            json.loads(line)
            for line in self.trace_log_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]


def wait_until(predicate: Any, timeout: float = 5.0, interval: float = 0.02, description: str = "condition") -> Any:
    deadline = time.monotonic() + timeout
    last_value = None
    while time.monotonic() < deadline:
        last_value = predicate()
        if last_value:
            return last_value
        time.sleep(interval)
    raise AssertionError(f"Timed out waiting for {description}")
def remote_file_item(name: str, local_path: Path, mod_time: str = "2024-01-01T12:00:00Z") -> dict[str, Any]:
    data = local_path.read_bytes()
    return {
        "Name": name,
        "Path": name,
        "IsDir": False,
        "Size": len(data),
        "ModTime": mod_time,
    }


def remote_dir_item(name: str, mod_time: str = "2024-01-01T12:00:00Z") -> dict[str, Any]:
    return {
        "Name": name,
        "Path": name,
        "IsDir": True,
        "Size": 0,
        "ModTime": mod_time,
    }
