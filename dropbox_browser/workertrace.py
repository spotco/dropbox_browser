"""Persistent Temp-folder trace logs for folder-cache and navigation work."""
from __future__ import annotations

import os
import json
import threading
import time
from pathlib import Path
from typing import Any

from .config import TEMP_DIR

TRACE_LOG_PATH = TEMP_DIR / "foldercache_threads.jsonl"
_lock = threading.Lock()
_run_id: str | None = None
_run_dir: Path | None = None
_configured_trace_path: Path | None = None


def configure_server_run(*, started_at: float | None = None, metadata: dict[str, Any] | None = None) -> Path:
    """Route trace output for this server process to a per-run directory."""
    global _configured_trace_path, _run_dir, _run_id
    if started_at is None:
        started_at = time.time()
    run_id = str(int(started_at))
    run_dir = TEMP_DIR / "runs" / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    trace_log_path = run_dir / "foldercache_threads.jsonl"
    server_metadata = {
        "started_at": int(started_at),
        "started_iso": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(started_at)),
        "pid": os.getpid(),
    }
    if metadata:
        server_metadata.update(metadata)
    (run_dir / "server.json").write_text(
        json.dumps(server_metadata, ensure_ascii=True, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    TEMP_DIR.mkdir(exist_ok=True)
    (TEMP_DIR / "current-run.txt").write_text(run_id + "\n", encoding="utf-8")
    with _lock:
        _run_id = run_id
        _run_dir = run_dir
        _configured_trace_path = trace_log_path
    return run_dir


def trace_path() -> Path:
    if _configured_trace_path is not None:
        _configured_trace_path.parent.mkdir(parents=True, exist_ok=True)
        return _configured_trace_path
    TEMP_DIR.mkdir(parents=True, exist_ok=True)
    return TRACE_LOG_PATH


def append(event: str, **fields: Any) -> None:
    record = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "time": round(time.time(), 6),
        "thread": threading.current_thread().name,
        "event": event,
    }
    record.update(fields)
    line = json.dumps(record, ensure_ascii=True, sort_keys=True)
    with _lock:
        path = trace_path()
        with path.open("a", encoding="utf-8") as handle:
            handle.write(line)
            handle.write("\n")
