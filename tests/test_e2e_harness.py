from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


class E2EHarnessTests(unittest.TestCase):
    def test_fake_rclone_accepts_rclone_global_config_option(self) -> None:
        fixture = REPO_ROOT / "tests" / "e2e" / "fixtures" / "camera-uploads-large.json"
        executable = REPO_ROOT / "tests" / "fake_rclone.py"
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_root = Path(temp_dir)
            env = {
                **os.environ,
                "DROPBOX_BROWSER_FAKE_RCLONE_FIXTURE": str(fixture),
                "DROPBOX_BROWSER_FAKE_RCLONE_STATE": str(temp_root / "state.json"),
            }
            result = subprocess.run(
                [
                    sys.executable,
                    str(executable),
                    "--config",
                    str(temp_root / "rclone.conf"),
                    "lsjson",
                    "--",
                    "dropbox:Camera Uploads",
                ],
                cwd=REPO_ROOT,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(json.loads(result.stdout)), 40)


if __name__ == "__main__":
    unittest.main()
