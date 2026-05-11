"""Thread-safe in-memory log buffer shared across the server."""
from __future__ import annotations

import threading
import time
from collections import deque

_MAX_ENTRIES = 500
_lock = threading.Lock()
_entries: deque[dict] = deque(maxlen=_MAX_ENTRIES)
_next_index: int = 0


def append(kind: str, message: str) -> None:
    """Append a log entry. kind is 'rclone' or 'request'."""
    global _next_index
    ts = time.strftime("%H:%M:%S")
    with _lock:
        _entries.append({"index": _next_index, "ts": ts, "kind": kind, "message": message})
        _next_index += 1


def entries_since(since: int) -> list[dict]:
    """Return all entries whose index >= since."""
    with _lock:
        return [e for e in _entries if e["index"] >= since]
