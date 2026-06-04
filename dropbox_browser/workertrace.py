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
SLOW_OPERATIONS_PATH = TEMP_DIR / "slow_operations.jsonl"
SLOW_OPERATION_THRESHOLD_MS = 250.0
_lock = threading.Lock()
_diagnostic_lock = threading.Lock()
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


def diagnostic_path() -> Path:
    if _run_dir is not None:
        _run_dir.mkdir(parents=True, exist_ok=True)
        return _run_dir / SLOW_OPERATIONS_PATH.name
    TEMP_DIR.mkdir(parents=True, exist_ok=True)
    return SLOW_OPERATIONS_PATH


def record_diagnostic(kind: str, **fields: Any) -> None:
    record = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "time": round(time.time(), 6),
        "thread": threading.current_thread().name,
        "kind": kind,
    }
    record.update(fields)
    line = json.dumps(record, ensure_ascii=True, sort_keys=True)
    with _diagnostic_lock:
        path = diagnostic_path()
        with path.open("a", encoding="utf-8") as handle:
            handle.write(line)
            handle.write("\n")


def append(event: str, **fields: Any) -> None:
    record = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "time": round(time.time(), 6),
        "thread": threading.current_thread().name,
        "event": event,
    }
    record.update(fields)
    line = json.dumps(record, ensure_ascii=True, sort_keys=True)
    lock_wait_started = time.perf_counter()
    with _lock:
        lock_wait_ms = round((time.perf_counter() - lock_wait_started) * 1000, 3)
        path = trace_path()
        write_started = time.perf_counter()
        with path.open("a", encoding="utf-8") as handle:
            handle.write(line)
            handle.write("\n")
        write_ms = round((time.perf_counter() - write_started) * 1000, 3)
    total_ms = round(lock_wait_ms + write_ms, 3)
    if total_ms >= SLOW_OPERATION_THRESHOLD_MS:
        record_diagnostic(
            "slow_trace_write",
            event=event,
            lock_wait_ms=lock_wait_ms,
            write_ms=write_ms,
            total_ms=total_ms,
            trace_path=str(path),
        )
