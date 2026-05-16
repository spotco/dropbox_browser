"""Thread-safe progress state for browser-triggered sync operations."""
from __future__ import annotations

import threading
import time
import uuid
from typing import Any


_lock = threading.Lock()
_ops: dict[str, dict[str, Any]] = {}


def start(label: str) -> str:
    op_id = uuid.uuid4().hex
    with _lock:
        _ops[op_id] = {
            "id": op_id,
            "label": label,
            "status": "running",
            "started_at": time.time(),
            "updated_at": time.time(),
            "message": "Starting",
            "command": "",
        }
    return op_id


def update(op_id: str, **fields: Any) -> None:
    with _lock:
        op = _ops.get(op_id)
        if op is None:
            return
        op.update(fields)
        op["updated_at"] = time.time()


def complete(op_id: str, message: str = "Complete") -> None:
    update(op_id, status="complete", message=message, percent=100)


def fail(op_id: str, message: str) -> None:
    update(op_id, status="error", message=message, percent=100)


def get(op_id: str) -> dict[str, Any] | None:
    with _lock:
        op = _ops.get(op_id)
        return dict(op) if op is not None else None
