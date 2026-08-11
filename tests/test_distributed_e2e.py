from __future__ import annotations

import json
import tempfile
import unittest
from types import SimpleNamespace
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

    def test_project_map_supplies_worker_runtime_settings(self) -> None:
        host = SimpleNamespace(
            nickname="surfacebook3",
            host="DESKTOP-0DGGB1K",
            user="spotco",
            label="surfacebook3",
            never_remote=False,
            hardware=SimpleNamespace(
                os="Windows",
                model="Microsoft Surface Book 3",
                cpu="Intel Core i7",
                notes="",
            ),
            defaults=SimpleNamespace(schedule_weight=1.0),
        )
        project_worker = SimpleNamespace(
            repo="E:/dev/dropbox_browser",
            git="git",
            path_prefix="C:/Program Files/nodejs",
            extra={
                "platform": "windows",
                "branch": "master",
                "schedule_weight": 2.4,
            },
        )
        project = SimpleNamespace(
            workers={"surfacebook3": project_worker},
            get=lambda nickname: project_worker,
        )
        package = SimpleNamespace(
            load_project=lambda name, root: project,
            load_hosts=lambda root: SimpleNamespace(get=lambda nickname: host),
        )
        shared = SimpleNamespace(root=Path("."), package=package)

        workers, skipped = runner.load_workers(shared, {"project": "dropbox_browser"})

        self.assertEqual(skipped, [])
        self.assertEqual(len(workers), 1)
        self.assertEqual(workers[0].repo, "E:/dev/dropbox_browser")
        self.assertEqual(workers[0].path_prefix, "C:/Program Files/nodejs")
        self.assertEqual(workers[0].branch, "master")
        self.assertEqual(workers[0].schedule_weight, 2.4)

    def test_coordination_claim_and_release_use_bounded_owner_lease(self) -> None:
        worker = runner.RemoteWorker(
            id="surfacebook3",
            nickname="surfacebook3",
            label="surfacebook3",
            host="surface.example",
            user="user",
            repo="E:/dev/dropbox_browser",
            git="git",
            path_prefix="",
            platform="windows",
            remote_os="Windows",
            branch="master",
            schedule_weight=2.4,
        )

        class Store:
            def __init__(self) -> None:
                self.claims: list[dict[str, object]] = []
                self.releases: list[dict[str, object]] = []

            def claim(self, resources, **kwargs):  # noqa: ANN001
                self.claims.append({"resources": resources, **kwargs})
                return {"lease_id": "lease-test"}

            def release(self, lease_id, **kwargs):  # noqa: ANN001
                self.releases.append({"lease_id": lease_id, **kwargs})
                return {"status": "released"}

        store = Store()
        shared = SimpleNamespace(
            root=Path("."),
            coordination=SimpleNamespace(coordination_store=lambda root: store),
        )

        claimed, leases = runner.claim_coordination_workers(
            shared,
            [worker],
            owner="dropbox_browser",
            duration_seconds=1800,
            grace_seconds=30,
        )
        runner.release_coordination_leases(
            shared,
            leases,
            owner="dropbox_browser",
            reason="test finished",
        )

        self.assertEqual(claimed, [worker])
        self.assertEqual(store.claims[0]["resources"], ["surfacebook3"])
        self.assertEqual(store.claims[0]["owner"], "dropbox_browser")
        self.assertEqual(store.claims[0]["duration_seconds"], 1800)
        self.assertEqual(store.releases[0]["lease_id"], "lease-test")

    def test_local_job_result_is_normalized_for_distributed_result_loop(self) -> None:
        self.assertEqual(
            runner.normalize_job_result("local", (True, 12.5)),
            (True, 12.5, "local run"),
        )
        self.assertEqual(
            runner.normalize_job_result("remote", (False, 8.25, "exit 1")),
            (False, 8.25, "exit 1"),
        )

    def test_worker_needs_publish_for_dirty_or_stale_checkout(self) -> None:
        expected = "a" * 40
        self.assertFalse(runner.worker_needs_publish(SimpleNamespace(head=expected, clean=True), expected))
        self.assertTrue(runner.worker_needs_publish(SimpleNamespace(head="b" * 40, clean=True), expected))
        self.assertTrue(runner.worker_needs_publish(SimpleNamespace(head=expected, clean=False), expected))

    def test_publish_arguments_default_to_auto(self) -> None:
        args = runner.parse_args([])
        self.assertEqual(args.publish_workers, "auto")
        self.assertFalse(args.sync_clean)

    def test_remote_script_exports_worker_browser(self) -> None:
        worker = runner.RemoteWorker(
            id="spmba2014",
            nickname="spmba2014",
            label="spmba2014",
            host="spmba.example",
            user="spotco",
            repo="/Users/spotco/dev/dropbox_browser",
            git="git",
            path_prefix="/opt/local/bin",
            platform="macos-intel",
            remote_os="macOS",
            branch="master",
            schedule_weight=1.0,
            browser="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        )
        shared = SimpleNamespace(ssh=SimpleNamespace(shell_quote=lambda value: f"'{value}'"))
        script = runner._remote_script(
            shared,
            worker,
            (runner.E2E_DIR / "client-render.smoke.spec.js",),
            "/tmp/run",
            "job-test",
        )
        self.assertIn("DROPBOX_BROWSER_BROWSER_EXECUTABLE", script)
        self.assertIn("Brave Browser.app", script)


if __name__ == "__main__":
    unittest.main()
