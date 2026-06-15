from __future__ import annotations

import json
import os
import signal
import sys
import threading
import time
from http import HTTPStatus
from http.server import ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse


REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT))

import dropbox_browser.config as config_module
import dropbox_browser.foldercache as foldercache_module
import dropbox_browser.listingcache as listingcache_module
import dropbox_browser.workertrace as workertrace_module
from dropbox_browser import logoutput
from dropbox_browser.config import VideoToolsConfig
from dropbox_browser.foldercache import FolderCacheManager
from dropbox_browser.handlers import RequestHandler
from dropbox_browser.listingcache import ListingCacheManager
from dropbox_browser.services import DropboxBrowser
from dropbox_browser.syncjobs import SyncJobManager
from tests.e2e.support.video_mocks import build_video_mock_patches
from tests.support import SimulatedLsjsonResponse, SimulatedRclone


DEFAULT_MOD_TIME = "2024-01-01T12:00:00Z"
DEFAULT_FIXTURE_PATH = REPO_ROOT / "tests" / "e2e" / "fixtures" / "basic-library.json"
DEFAULT_MUSIC_LIBRARY_POLL_DELAY_MS = 150
E2E_TEMP_ROOT = REPO_ROOT / ".dropbox-browser-temp" / "e2e-integration"


def _decode_content(entry: dict[str, Any]) -> bytes:
    if "base64" in entry:
        import base64

        return base64.b64decode(entry["base64"])
    return str(entry.get("content", "")).encode("utf-8")


class FixtureRemoteTree:
    def __init__(self, fixture: dict[str, Any]) -> None:
        self.entries: dict[str, dict[str, Any]] = {}
        for raw_entry in fixture.get("entries", []):
            entry = dict(raw_entry)
            rel_path = self.clean_rel_path(entry["path"])
            kind = str(entry["type"])
            if kind == "dir":
                self.entries[rel_path] = {
                    "type": "dir",
                    "mod_time": str(entry.get("mod_time", DEFAULT_MOD_TIME)),
                }
            elif kind == "file":
                self.entries[rel_path] = {
                    "type": "file",
                    "mod_time": str(entry.get("mod_time", DEFAULT_MOD_TIME)),
                    "content": _decode_content(entry),
                }
                self._ensure_parent_dirs(rel_path)
            else:
                raise SystemExit(f"Unsupported integration fixture entry type: {kind!r}")

    @staticmethod
    def clean_rel_path(value: str) -> str:
        return "/".join(part for part in str(value).replace("\\", "/").split("/") if part)

    def _ensure_parent_dirs(self, rel_path: str) -> None:
        parts = self.clean_rel_path(rel_path).split("/")
        for count in range(1, len(parts)):
            parent = "/".join(parts[:count])
            self.entries.setdefault(parent, {"type": "dir", "mod_time": DEFAULT_MOD_TIME})

    def _rel_path(self, remote_path: str) -> str:
        return self.clean_rel_path(remote_path.split(":", 1)[1] if ":" in remote_path else remote_path)

    def list_dir(self, remote_path: str) -> list[dict[str, Any]]:
        rel_dir = self._rel_path(remote_path)
        prefix = rel_dir + "/" if rel_dir else ""
        children: dict[str, dict[str, Any]] = {}
        for rel_path, entry in self.entries.items():
            if rel_dir:
                if rel_path == rel_dir or not rel_path.startswith(prefix):
                    continue
                remainder = rel_path[len(prefix):]
            else:
                remainder = rel_path
            if not remainder:
                continue
            child_name = remainder.split("/", 1)[0]
            child_rel = child_name if not rel_dir else prefix + child_name
            child_entry = self.entries.get(child_rel) or {"type": "dir", "mod_time": DEFAULT_MOD_TIME}
            children[child_name] = {
                "Name": child_name,
                "Path": child_name,
                "IsDir": child_entry["type"] == "dir",
                "Size": 0 if child_entry["type"] == "dir" else len(child_entry["content"]),
                "ModTime": child_entry.get("mod_time", DEFAULT_MOD_TIME),
            }
        return sorted(children.values(), key=lambda item: str(item["Name"]).casefold())

    def cat_data(self, remote_name: str) -> dict[str, bytes]:
        result: dict[str, bytes] = {}
        for rel_path, entry in self.entries.items():
            if entry["type"] != "file":
                continue
            remote_path = remote_name + rel_path if remote_name.endswith(":") else remote_name.rstrip("/") + "/" + rel_path
            result[remote_path] = entry["content"]
        return result

    def directory_targets(self, remote_name: str) -> list[str]:
        targets = {remote_name}
        for rel_path, entry in self.entries.items():
            if entry["type"] == "dir":
                if rel_path:
                    targets.add(remote_name + rel_path if remote_name.endswith(":") else remote_name.rstrip("/") + "/" + rel_path)
            else:
                parent = "/".join(rel_path.split("/")[:-1])
                target = remote_name if not parent else (
                    remote_name + parent if remote_name.endswith(":") else remote_name.rstrip("/") + "/" + parent
                )
                targets.add(target)
        return sorted(targets)


class IntegrationState:
    def __init__(
        self,
        *,
        fixture: dict[str, Any],
        fixture_path: Path,
        temp_root: Path,
        local_root: Path,
        run_dir: Path,
        gate_events: dict[str, threading.Event],
        rclone: SimulatedRclone,
    ) -> None:
        self.fixture = fixture
        self.fixture_path = fixture_path
        self.temp_root = temp_root
        self.local_root = local_root
        self.run_dir = run_dir
        self.trace_log_path = run_dir / "foldercache_threads.jsonl"
        self.gate_events = gate_events
        self.rclone = rclone

    def trace_events(self) -> list[dict[str, Any]]:
        if not self.trace_log_path.exists():
            return []
        return [
            json.loads(line)
            for line in self.trace_log_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def call_records(self) -> list[dict[str, Any]]:
        return list(self.rclone.calls)

    def status_payload(self) -> dict[str, Any]:
        return {
            "status": "ok",
            "scenario": self.fixture.get("scenario"),
            "fixture_path": str(self.fixture_path),
            "temp_root": str(self.temp_root),
            "local_root": str(self.local_root),
            "run_dir": str(self.run_dir),
            "trace_log_path": str(self.trace_log_path),
            "rclone_adapter": "in-process-simulated",
            "using_fake_rclone": True,
            "music_library_poll_delay_ms": getattr(self.rclone, "music_library_poll_delay_ms", None),
            "call_count": len(self.rclone.calls),
            "trace_event_count": len(self.trace_events()),
            "music_library_checkpoints": self.fixture.get("music_library_checkpoints", {}),
            "gates": [
                {"name": name, "released": event.is_set()}
                for name, event in sorted(self.gate_events.items())
            ],
        }


class IntegrationRequestHandler(RequestHandler):
    @property
    def integration_state(self) -> IntegrationState:
        return self.server.integration_state  # type: ignore[attr-defined]

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/__integration/status":
            self._send_json(HTTPStatus.OK, self.integration_state.status_payload())
            return
        if parsed.path == "/__integration/trace":
            self._send_json(HTTPStatus.OK, {"events": self.integration_state.trace_events()})
            return
        if parsed.path == "/__integration/calls":
            self._send_json(HTTPStatus.OK, {"calls": self.integration_state.call_records()})
            return
        if parsed.path == "/__integration/checkpoints":
            self._send_json(
                HTTPStatus.OK,
                {
                    "scenario": self.integration_state.fixture.get("scenario"),
                    "music_library_checkpoints": self.integration_state.fixture.get("music_library_checkpoints", {}),
                    "integration_gates": self.integration_state.fixture.get("integration_gates", []),
                },
            )
            return
        super().do_GET()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/__integration/release-gate":
            self._handle_release_gate()
            return
        super().do_POST()

    def _handle_release_gate(self) -> None:
        length = int(self.headers.get("Content-Length") or "0")
        params = parse_qs(self.rfile.read(length).decode("utf-8") if length > 0 else "", keep_blank_values=True)
        gate_name = params.get("name", [""])[0]
        if gate_name not in self.integration_state.gate_events:
            self._send_json(
                HTTPStatus.NOT_FOUND,
                {"status": "error", "message": f"Unknown integration gate: {gate_name}"},
            )
            return
        self.integration_state.gate_events[gate_name].set()
        self._send_json(HTTPStatus.OK, {"status": "released", "name": gate_name})

    def _send_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def _fixture_path() -> Path:
    raw = os.environ.get("DROPBOX_BROWSER_E2E_FIXTURE")
    return Path(raw) if raw else DEFAULT_FIXTURE_PATH


def _load_fixture(fixture_path: Path) -> dict[str, Any]:
    return json.loads(fixture_path.read_text(encoding="utf-8"))


def _create_repo_temp_root(prefix: str) -> Path:
    E2E_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
    run_id = f"{prefix}-{int(time.time() * 1000)}-{os.getpid()}"
    temp_root = E2E_TEMP_ROOT / run_id
    temp_root.mkdir(parents=True, exist_ok=False)
    return temp_root


def _write_local_files(local_root: Path, fixture: dict[str, Any]) -> None:
    local_root.mkdir(parents=True, exist_ok=True)
    for file_entry in fixture.get("local_files", []):
        target = local_root.joinpath(*str(file_entry["path"]).split("/"))
        target.parent.mkdir(parents=True, exist_ok=True)
        if "base64" in file_entry:
            import base64

            target.write_bytes(base64.b64decode(file_entry["base64"]))
        else:
            target.write_text(str(file_entry.get("content", "")), encoding="utf-8")


def _file_stat_responses(tree: FixtureRemoteTree) -> dict[str, list[SimulatedLsjsonResponse]]:
    responses: dict[str, list[SimulatedLsjsonResponse]] = {}
    for rel_path, entry in tree.entries.items():
        if entry.get("type") != "file":
            continue
        name = rel_path.rsplit("/", 1)[-1]
        remote_path = "dropbox:" + rel_path
        responses[remote_path] = [
            SimulatedLsjsonResponse(items=[{
                "Name": name,
                "Path": name,
                "IsDir": False,
                "Size": len(entry.get("content") or b""),
                "ModTime": entry.get("mod_time", DEFAULT_MOD_TIME),
            }])
        ]
    return responses


def _parse_fixture_responses(
    fixture: dict[str, Any],
    tree: FixtureRemoteTree,
    gate_events: dict[str, threading.Event],
) -> dict[str, list[SimulatedLsjsonResponse]]:
    lsjson_responses: dict[str, list[SimulatedLsjsonResponse]] = {}
    for remote_path in tree.directory_targets("dropbox:"):
        lsjson_responses[remote_path] = [SimulatedLsjsonResponse(items=tree.list_dir(remote_path))]
    for remote_path, responses in _file_stat_responses(tree).items():
        lsjson_responses.setdefault(remote_path, responses)

    raw_overrides = fixture.get("lsjson_responses", {})
    if not isinstance(raw_overrides, dict):
        return lsjson_responses

    for remote_path, raw_responses in raw_overrides.items():
        if not isinstance(remote_path, str) or not isinstance(raw_responses, list):
            continue
        parsed: list[SimulatedLsjsonResponse] = []
        for raw_response in raw_responses:
            if not isinstance(raw_response, dict):
                continue
            gate_name = raw_response.get("gate")
            gate_event = None
            if isinstance(gate_name, str) and gate_name:
                gate_event = gate_events.setdefault(gate_name, threading.Event())
            delay_ms = raw_response.get("delay_ms", 0)
            delay_seconds = raw_response.get("delay_seconds")
            if delay_seconds is None:
                delay = float(delay_ms) / 1000.0
            else:
                delay = float(delay_seconds)
            items = raw_response.get("items")
            if items is None:
                items = tree.list_dir(remote_path)
            parsed.append(
                SimulatedLsjsonResponse(
                    items=items if isinstance(items, list) else [],
                    delay=delay,
                    wait_event=gate_event,
                    invalid_json=bool(raw_response.get("invalid_json", False)),
                    returncode=int(raw_response.get("returncode", 0)),
                    stderr=str(raw_response.get("stderr", "")).encode("utf-8"),
                )
            )
        if parsed:
            lsjson_responses[remote_path] = parsed
    return lsjson_responses


def _patch_isolated_paths(temp_root: Path) -> None:
    folder_cache_dir = temp_root / "Cache" / "FolderInfo"
    listing_cache_dir = temp_root / "Cache" / "ListingCache"
    temp_dir = temp_root / "Temp"
    config_module.TEMP_DIR = temp_dir
    foldercache_module.CACHE_DIR = folder_cache_dir
    listingcache_module.CACHE_DIR = listing_cache_dir
    workertrace_module.TEMP_DIR = temp_dir
    workertrace_module.TRACE_LOG_PATH = temp_dir / "foldercache_threads.jsonl"


def _build_app(fixture_path: Path, port: int) -> tuple[DropboxBrowser, IntegrationState]:
    fixture = _load_fixture(fixture_path)
    temp_root = _create_repo_temp_root("run")
    local_root = temp_root / "local"
    _write_local_files(local_root, fixture)
    _patch_isolated_paths(temp_root)

    tree = FixtureRemoteTree(fixture)
    gate_events: dict[str, threading.Event] = {}
    rclone = SimulatedRclone(
        _parse_fixture_responses(fixture, tree, gate_events),
        cat_data=tree.cat_data("dropbox:"),
    )
    run_dir = workertrace_module.configure_server_run(
        started_at=time.time(),
        metadata={
            "host": "127.0.0.1",
            "port": port,
            "remote": "dropbox:",
            "local_root": str(local_root),
            "fixture_path": str(fixture_path),
            "test_harness": "music_integration",
            "rclone_adapter": "in-process-simulated",
        },
    )
    listing_cache = ListingCacheManager(ttl_seconds=1800)
    folder_cache = FolderCacheManager(
        rclone,
        workers=2,
        ttl_seconds=86400,
        listing_cache=listing_cache,
        local_root=local_root,
        remote="dropbox:",
    )
    rclone.progress_fn = folder_cache.current_progress
    video_tools_config = None
    if isinstance(fixture.get("video"), dict):
        video_tools_config = VideoToolsConfig(
            ffmpeg_exe=Path("C:/tools/ffmpeg/bin/ffmpeg.exe"),
            ffprobe_exe=Path("C:/tools/ffmpeg/bin/ffprobe.exe"),
        )
    app = DropboxBrowser(
        rclone,
        "dropbox:",
        local_root,
        folder_cache=folder_cache,
        listing_cache=listing_cache,
        video_tools_config=video_tools_config,
    )
    app.sync_jobs = SyncJobManager(app, workers=1)
    app.music_library_poll_delay_ms = int(
        os.environ.get("DROPBOX_BROWSER_E2E_MUSIC_LIBRARY_POLL_DELAY_MS", str(DEFAULT_MUSIC_LIBRARY_POLL_DELAY_MS))
    )
    rclone.music_library_poll_delay_ms = app.music_library_poll_delay_ms
    integration_state = IntegrationState(
        fixture=fixture,
        fixture_path=fixture_path,
        temp_root=temp_root,
        local_root=local_root,
        run_dir=run_dir,
        gate_events=gate_events,
        rclone=rclone,
    )
    return app, integration_state


def main() -> int:
    fixture_path = _fixture_path()
    fixture = _load_fixture(fixture_path)
    port = int(os.environ.get("PLAYWRIGHT_PORT", "8011"))
    app, integration_state = _build_app(fixture_path, port)
    video_mock_patches = build_video_mock_patches(fixture, integration_state.temp_root)
    server = ThreadingHTTPServer(("127.0.0.1", port), IntegrationRequestHandler)
    server.app = app  # type: ignore[attr-defined]
    server.integration_state = integration_state  # type: ignore[attr-defined]
    server.log_requests = False  # type: ignore[attr-defined]
    stop_signal: int | None = None

    def request_shutdown(signum: int, _frame: object) -> None:
        nonlocal stop_signal
        stop_signal = signum
        threading.Thread(target=server.shutdown, daemon=True, name="integration-http-shutdown").start()

    print(f"Serving integration test server at http://127.0.0.1:{port}/")
    print(f"Fixture: {fixture_path}")
    print(f"Local root: {integration_state.local_root}")
    print(f"Trace log: {integration_state.trace_log_path}")
    logoutput.start()
    for mock_patch in video_mock_patches:
        mock_patch.start()
    previous_sigint = signal.getsignal(signal.SIGINT)
    signal.signal(signal.SIGINT, request_shutdown)
    previous_sigterm = None
    if hasattr(signal, "SIGTERM"):
        previous_sigterm = signal.getsignal(signal.SIGTERM)
        signal.signal(signal.SIGTERM, request_shutdown)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        signal.signal(signal.SIGINT, previous_sigint)
        if previous_sigterm is not None and hasattr(signal, "SIGTERM"):
            signal.signal(signal.SIGTERM, previous_sigterm)
        if stop_signal is not None:
            print(f"\nStopped by signal {stop_signal}.")
        server.server_close()
        app.shutdown()
        for mock_patch in reversed(video_mock_patches):
            mock_patch.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
