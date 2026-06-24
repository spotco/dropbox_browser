from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
BASE_FIXTURE = REPO_ROOT / "tests" / "e2e" / "fixtures" / "video_player_generated_fixture.py"


def main() -> int:
    proc = subprocess.run(
        [sys.executable, str(BASE_FIXTURE), *sys.argv[1:]],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr.decode("utf-8", "replace"))
        return proc.returncode
    payload = json.loads(proc.stdout.decode("utf-8"))
    video = payload.get("video")
    if not isinstance(video, dict):
        raise SystemExit("Generated video fixture did not include a video section.")
    video["subtitle_delay_seconds_by_path"] = {
        "Videos/alpha.mkv": 2.5,
    }
    sys.stdout.write(json.dumps(payload))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
