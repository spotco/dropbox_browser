"""Persistent Temp-folder trace logs for folder-cache background work."""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any

from .config import TEMP_DIR

TRACE_LOG_PATH = TEMP_DIR / "foldercache_threads.jsonl"
_lock = threading.Lock()


def trace_path() -> Path:
    TEMP_DIR.mkdir(exist_ok=True)
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
