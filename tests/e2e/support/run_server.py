from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def _create_repo_temp_root(repo_root: Path, prefix: str) -> Path:
    base = repo_root / ".dropbox-browser-temp" / "e2e"
    base.mkdir(parents=True, exist_ok=True)
    run_id = f"{prefix}-{__import__('time').time_ns()}-{os.getpid()}"
    temp_root = base / run_id
    temp_root.mkdir(parents=True, exist_ok=False)
    return temp_root


def _patch_isolated_paths(temp_root: Path) -> None:
    from dropbox_browser import config as config_module
    from dropbox_browser import foldercache as foldercache_module
    from dropbox_browser import listingcache as listingcache_module
    from dropbox_browser import workertrace as workertrace_module

    folder_cache_dir = temp_root / "Cache" / "FolderInfo"
    listing_cache_dir = temp_root / "Cache" / "ListingCache"
    temp_dir = temp_root / "Temp"
    config_module.TEMP_DIR = temp_dir
    foldercache_module.CACHE_DIR = folder_cache_dir
    listingcache_module.CACHE_DIR = listing_cache_dir
    workertrace_module.TEMP_DIR = temp_dir
    workertrace_module.TRACE_LOG_PATH = temp_dir / "foldercache_threads.jsonl"

def main() -> int:
    repo_root = Path(__file__).resolve().parents[3]
    sys.path.insert(0, str(repo_root))
    from dropbox_browser import cli

    fixture_path = Path(
        os.environ.get(
            "DROPBOX_BROWSER_E2E_FIXTURE",
            repo_root / "tests" / "e2e" / "fixtures" / "basic-library.json",
        )
    )
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    temp_root = _create_repo_temp_root(repo_root, "run")
    _patch_isolated_paths(temp_root)

    local_root = temp_root / "local"
    local_root.mkdir(parents=True, exist_ok=True)
    for file_entry in fixture.get("local_files", []):
        target = local_root.joinpath(*str(file_entry["path"]).split("/"))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(str(file_entry.get("content", "")), encoding="utf-8")

    os.environ["DROPBOX_BROWSER_FAKE_RCLONE_FIXTURE"] = str(fixture_path)
    os.environ["DROPBOX_BROWSER_FAKE_RCLONE_CALL_LOG"] = str(temp_root / "fake-rclone-calls.jsonl")
    os.environ["DROPBOX_BROWSER_FAKE_RCLONE_STATE"] = str(temp_root / "fake-rclone-state.json")

    sys.argv = [
        str(Path(__file__).resolve()),
        "--host",
        "127.0.0.1",
        "--port",
        os.environ.get("PLAYWRIGHT_PORT", "8010"),
        "--remote",
        "dropbox:",
        "--rclone",
        str(repo_root / "tests" / "fake_rclone.cmd"),
        "--local-root",
        str(local_root),
    ]
    if os.environ.get("PLAYWRIGHT_CLIENT_RENDER") == "0":
        sys.argv.append("--no-client-render")
    return cli.main()


if __name__ == "__main__":
    raise SystemExit(main())
