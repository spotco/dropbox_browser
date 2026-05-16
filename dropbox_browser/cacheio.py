from __future__ import annotations

import json
import time
import tempfile
from pathlib import Path
from typing import Any

_REPLACE_RETRIES = 8
_REPLACE_RETRY_DELAY_SECONDS = 0.02


def write_json_atomic(path: Path, data: Any) -> None:
    """Write JSON by replacing the cache file only after a full temp write."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            dir=path.parent,
            delete=False,
        ) as tmp:
            json.dump(data, tmp)
            tmp_path = Path(tmp.name)
        delay = _REPLACE_RETRY_DELAY_SECONDS
        for attempt in range(_REPLACE_RETRIES):
            try:
                tmp_path.replace(path)
                break
            except PermissionError:
                if attempt == _REPLACE_RETRIES - 1:
                    raise
                time.sleep(delay)
                delay *= 2
    finally:
        if tmp_path is not None:
            try:
                tmp_path.unlink(missing_ok=True)
            except OSError:
                pass
