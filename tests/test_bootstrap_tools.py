from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
BOOTSTRAP_SCRIPT = REPO_ROOT / "tools" / "bootstrap_tools.py"


class BootstrapToolsStandaloneTests(unittest.TestCase):
    def test_fresh_checkout_bootstraps_an_offline_pack_without_project_modules(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            tools_dir = root / "tools"
            packs_dir = root / "tools-packs"
            tools_dir.mkdir()
            packs_dir.mkdir()
            shutil.copy2(BOOTSTRAP_SCRIPT, tools_dir / "bootstrap_tools.py")
            pack = packs_dir / "fixture.zip"
            with zipfile.ZipFile(pack, "w") as archive:
                archive.writestr("windows-x64/bin/tool.exe", b"fixture")
            checksum = hashlib.sha256(pack.read_bytes()).hexdigest()
            (tools_dir / "runtime_manifest.json").write_text(
                json.dumps(
                    {
                        "format": "dropbox-browser-tool-packs-v1",
                        "platforms": {"windows-x64": {"asset": pack.name, "sha256": checksum}},
                    }
                ),
                encoding="utf-8",
            )

            result = subprocess.run(
                [sys.executable, str(tools_dir / "bootstrap_tools.py"), "--platform", "windows-x64", "--offline"],
                cwd=root,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((root / ".tools" / "windows-x64" / "bin" / "tool.exe").read_bytes(), b"fixture")
            self.assertEqual((root / ".tools" / "windows-x64" / ".pack-sha256").read_text(encoding="utf-8").strip(), checksum)
