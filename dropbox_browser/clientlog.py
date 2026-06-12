from __future__ import annotations

import json
import threading
import time
from typing import Any

from .config import TEMP_DIR


CLIENT_LOG_PATH = TEMP_DIR / "client_logs.jsonl"
_CLIENT_LOG_LOCK = threading.Lock()
_MAX_FIELD_LENGTH = 4000
_MAX_FIELDS = 80


def client_log_config(app_config: dict | None = None) -> tuple[bool, dict[str, bool]]:
    config = app_config or {}
    enabled = bool(config.get("ClientLogEnabled", True))
    raw_subsystems = config.get("ClientLogSubsystems", {})
    subsystems: dict[str, bool] = {}
    if isinstance(raw_subsystems, dict):
        for key, value in raw_subsystems.items():
            if isinstance(key, str) and key:
                subsystems[key] = bool(value)
    return enabled, subsystems


def is_client_log_enabled(app: Any, subsystem: str) -> bool:
    if not bool(getattr(app, "client_log_enabled", True)):
        return False
    subsystems = getattr(app, "client_log_subsystems", None)
    if not isinstance(subsystems, dict):
        return False
    return bool(subsystems.get(subsystem, False))


def append_client_log(app: Any, fields: dict[str, object]) -> bool:
    subsystem = _clean_field(fields.get("subsystem") or "")
    if not subsystem or not is_client_log_enabled(app, subsystem):
        return False
    row: dict[str, object] = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "subsystem": subsystem,
        "level": _clean_field(fields.get("level") or "info"),
        "message": _clean_field(fields.get("message") or ""),
    }
    details = fields.get("details")
    if isinstance(details, dict):
        row["details"] = _clean_details(details)
    for key in ("path", "url", "session_id", "playback_mode", "current_time"):
        value = fields.get(key)
        if value not in (None, ""):
            row[key] = _clean_field(value)
    try:
        CLIENT_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(row, ensure_ascii=False, sort_keys=True)
        with _CLIENT_LOG_LOCK:
            with CLIENT_LOG_PATH.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")
    except OSError:
        return False
    return True


def _clean_details(details: dict[object, object]) -> dict[str, object]:
    cleaned: dict[str, object] = {}
    for index, (key, value) in enumerate(details.items()):
        if index >= _MAX_FIELDS:
            cleaned["_truncated"] = True
            break
        cleaned[_clean_field(key)] = _clean_value(value)
    return cleaned


def _clean_value(value: object) -> object:
    if isinstance(value, dict):
        return _clean_details(value)
    if isinstance(value, list):
        return [_clean_value(item) for item in value[:_MAX_FIELDS]]
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return _clean_field(value)


def _clean_field(value: object) -> str:
    text = str(value)
    if len(text) > _MAX_FIELD_LENGTH:
        return text[:_MAX_FIELD_LENGTH] + "...[truncated]"
    return text
