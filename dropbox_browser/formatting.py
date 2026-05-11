from __future__ import annotations

import datetime as dt
from pathlib import Path


def display_date(value: float | None) -> str:
    if not value:
        return ""
    return dt.datetime.fromtimestamp(value).strftime("%Y-%m-%d %H:%M")


def parse_rclone_time(value: str | None) -> float | None:
    if not value:
        return None
    normalized = value.replace("Z", "+00:00")
    try:
        return dt.datetime.fromisoformat(normalized).timestamp()
    except ValueError:
        return None


def file_type(name: str, is_dir: bool) -> str:
    if is_dir:
        return "folder"
    suffix = Path(name).suffix.lower().lstrip(".")
    return suffix or "file"


def human_size(size: int) -> str:
    value = float(size)
    for unit in ["B", "KB", "MB", "GB"]:
        if value < 1024 or unit == "GB":
            return f"{value:.1f} {unit}" if unit != "B" else f"{int(value)} B"
        value /= 1024
    return f"{size} B"


def status_class(status: str) -> str:
    return {
        "Both": "both",
        "Dropbox only": "remote",
        "Local only": "local",
    }.get(status, "")
