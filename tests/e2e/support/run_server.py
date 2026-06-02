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
    if os.environ.get("PLAYWRIGHT_CLIENT_RENDER") == "1":
        sys.argv.append("--client-render")
    return cli.main()


if __name__ == "__main__":
    raise SystemExit(main())
