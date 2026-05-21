from __future__ import annotations

import json
import os
import shutil
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
TEMP_DIR = PROJECT_ROOT / "Temp"

_APP_CONFIG_DEFAULTS: dict = {
    "DropboxFolder": "./DropboxLocal",
    "RCloneConfig": "",
    "LogRcloneCommands": True,
    "LogHttpRequests": True,
    "FolderCacheWorkers": 4,
    "SyncJobWorkers": 4,
    "FolderCacheTTLSeconds": 14 * 24 * 60 * 60,
    "ListingCacheTTLSeconds": 1800,
}


def _read_config_file(path: Path) -> dict:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8-sig"))


def load_app_config() -> dict:
    """Load config.json plus local overrides and return a dict merged with defaults."""
    result = dict(_APP_CONFIG_DEFAULTS)
    result.update(_read_config_file(PROJECT_ROOT / "config.json"))
    result.update(_read_config_file(PROJECT_ROOT / "config_local.json"))
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


def find_dropbox_folder(app_config: dict | None = None) -> Path:
    config = app_config if app_config is not None else load_app_config()
    value = str(config.get("DropboxFolder") or _APP_CONFIG_DEFAULTS["DropboxFolder"]).strip()
    if not value:
        value = _APP_CONFIG_DEFAULTS["DropboxFolder"]
    expanded = Path(os.path.expandvars(value)).expanduser()
    if not expanded.is_absolute():
        expanded = PROJECT_ROOT / expanded
    return expanded.resolve()
