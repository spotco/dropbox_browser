from __future__ import annotations

import json
import os
import shutil
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
TEMP_DIR = PROJECT_ROOT / "Temp"

_APP_CONFIG_DEFAULTS: dict = {
    "RCloneConfig": "",
    "LogRcloneCommands": True,
    "LogHttpRequests": True,
    "FolderCacheWorkers": 4,
    "FolderCacheTTLHours": 24,
    "ListingCacheTTLMinutes": 30,
}


def load_app_config() -> dict:
    """Load config.json and return a dict merged with defaults."""
    result = dict(_APP_CONFIG_DEFAULTS)
    pointer = PROJECT_ROOT / "config.json"
    if pointer.exists():
        data = json.loads(pointer.read_text(encoding="utf-8"))
        result.update(data)
    return result


def find_default_rclone() -> str:
    local = PROJECT_ROOT / "rclone.exe"
    if local.exists():
        return str(local)
    found = shutil.which("rclone")
    return found or "rclone"


def _rclone_default_config() -> Path | None:
    """Return the path rclone uses by default when --config is not supplied."""
    appdata = os.environ.get("APPDATA")
    if appdata:
        return Path(appdata) / "rclone" / "rclone.conf"
    return None


def find_default_config() -> str | None:
    value = load_app_config().get("RCloneConfig", "").strip()
    if not value:
        return None
    resolved = Path(os.path.expandvars(value)).resolve()
    default = _rclone_default_config()
    if default is not None and resolved == default.resolve():
        return None  # matches rclone's own default; omit --config
    return str(resolved)
