from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from tools import network_workers_bootstrap as bootstrap
from tools import run_distributed_e2e as runner


class DistributedE2ETests(unittest.TestCase):
    def test_supported_platforms_exclude_linux_and_non_intel_macos(self) -> None:
        self.assertTrue(runner.is_supported_platform("windows"))
        self.assertTrue(runner.is_supported_platform("macos-intel"))
        self.assertFalse(runner.is_supported_platform("linux"))
        self.assertFalse(runner.is_supported_platform("macos-arm"))

    def test_remote_notes_are_optional_and_parse_json_block(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "LOCAL_NOTES.md"
            path.write_text(
                "## Remote E2E\n\n```json\n"
                + json.dumps({"local": {"enabled": True}, "workers": []})
                + "\n```\n",
                encoding="utf-8",
            )
            self.assertEqual(bootstrap.remote_notes(path)["local"]["enabled"], True)

    def test_missing_shared_sdk_is_a_local_fallback_unless_required(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            missing = Path(temp_dir) / "missing"
            self.assertIsNone(bootstrap.load_shared(missing, required=False))
            with self.assertRaises(bootstrap.BootstrapError):
                bootstrap.load_shared(missing, required=True)

    def test_spec_collection_is_deterministic(self) -> None:
        specs = runner.collect_specs([])
        self.assertEqual(specs, sorted(specs))
        self.assertTrue(all(spec.parent == runner.E2E_DIR for spec in specs))

    def test_relative_spec_uses_posix_path(self) -> None:
        spec = runner.E2E_DIR / "music-player.integration.spec.js"
        self.assertEqual(
            runner.relative_spec(spec),
            "tests/e2e/music-player.integration.spec.js",
        )

    def test_windows_remote_paths_use_git_bash_drive_mapping(self) -> None:
        windows = runner.RemoteWorker(
            id="surface",
            nickname="surfacebook3",
            label="Surface",
            host="surface.example",
            user="user",
            repo="E:/dev/dropbox_browser",
            git="git",
            path_prefix="",
            platform="windows",
            remote_os="Windows",
            branch="master",
            schedule_weight=1.0,
        )
        mac = windows.__class__(**{**windows.__dict__, "platform": "macos-intel", "repo": "/Users/spotco/dev/dropbox_browser"})
        self.assertEqual(
            runner.remote_shell_path(windows, windows.repo),
            "/e/dev/dropbox_browser",
        )
        self.assertEqual(
            runner.remote_shell_path(mac, mac.repo),
            "/Users/spotco/dev/dropbox_browser",
        )
        self.assertEqual(
            runner.remote_scp_path(windows, "/e/dev/dropbox_browser/Temp/job"),
            "E:/dev/dropbox_browser/Temp/job",
        )


if __name__ == "__main__":
    unittest.main()
