from __future__ import annotations

import os
import shutil
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
TEMP_DIR = PROJECT_ROOT / "Temp"


def find_default_rclone() -> str:
    local = PROJECT_ROOT / "rclone.exe"
    if local.exists():
        return str(local)
    found = shutil.which("rclone")
    return found or "rclone"


def find_default_config() -> str | None:
    import json
    pointer = PROJECT_ROOT / "config.json"
    if pointer.exists():
        data = json.loads(pointer.read_text(encoding="utf-8"))
        value = data.get("RCloneConfig", "").strip()
        return os.path.expandvars(value) if value else None
    return None


def upload_temp_dir() -> Path:
    TEMP_DIR.mkdir(exist_ok=True)
    return TEMP_DIR
