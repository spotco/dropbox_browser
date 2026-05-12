"""Thread-safe in-memory log buffer shared across the server."""
from __future__ import annotations

import threading
import time
from collections import deque

_MAX_ENTRIES = 500
_lock = threading.Lock()
_entries: deque[dict] = deque(maxlen=_MAX_ENTRIES)
_next_index: int = 0
_update_seq: int = 0  # bumped on every in-place update


def append(kind: str, message: str, elapsed: float | None = None) -> int:
    """Append a log entry. Returns the entry id."""
    global _next_index
    ts = time.strftime("%H:%M:%S")
    entry: dict = {
        "index": _next_index,
        "ts": ts,
        "kind": kind,
        "message": message,
        "update_seq": 0,
    }
    if elapsed is not None:
        entry["elapsed"] = round(elapsed, 2)
    with _lock:
        _entries.append(entry)
        entry_id = _next_index
        _next_index += 1
    return entry_id


def update(entry_id: int, message: str, elapsed: float | None = None) -> None:
    """Update an existing entry in place (e.g. when a command completes)."""
    global _update_seq
    ts = time.strftime("%H:%M:%S")
    with _lock:
        _update_seq += 1
        seq = _update_seq
        for entry in _entries:
            if entry["index"] == entry_id:
                entry["ts"] = ts
                entry["message"] = message
                entry["update_seq"] = seq
                if elapsed is not None:
                    entry["elapsed"] = round(elapsed, 2)
                elif "elapsed" in entry:
                    del entry["elapsed"]
                break


def entries_since(since: int, since_upd: int = 0) -> dict:
    """Return new entries and any in-place updates since last poll.

    Returns a dict with:
      "entries"    — entries with index >= since (new to client)
      "updates"    — entries with update_seq > since_upd and index < since
                     (entries client already has that were updated)
      "update_seq" — current global update_seq for the client to echo back
    """
    with _lock:
        current_seq = _update_seq
        entries  = [{**e} for e in _entries if e["index"] >= since]
        updates  = [{**e} for e in _entries
                    if e.get("update_seq", 0) > since_upd and e["index"] < since]
    return {"entries": entries, "updates": updates, "update_seq": current_seq}

