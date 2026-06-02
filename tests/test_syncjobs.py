from __future__ import annotations

import threading
import unittest
from http import HTTPStatus
from pathlib import Path

from dropbox_browser.foldercache import FolderCacheManager
from dropbox_browser.listingcache import ListingCacheManager
from dropbox_browser.services import DropboxBrowser
from dropbox_browser.syncjobs import SyncJobManager
from dropbox_browser.errors import BrowserError
from dropbox_browser import syncstate

try:
    from tests.support import IsolatedPathsTestCase, SimulatedLsjsonResponse, SimulatedRclone, TestServer, wait_until
except ImportError:
    from support import IsolatedPathsTestCase, SimulatedLsjsonResponse, SimulatedRclone, TestServer, wait_until


class _FakeApp:
    def __init__(self, first_path: str):
        self.first_path = first_path
        self.started = threading.Event()
        self.release = threading.Event()
        self.executed: list[str] = []
        self.invalidated: list[list[str]] = []

    def execute_sync_operation(self, kind: str, item: dict[str, str]) -> None:
        path = item["path"]
        if path == self.first_path:
            self.started.set()
            if not self.release.wait(5):
                raise AssertionError("Timed out waiting to release first sync job")
        self.executed.append(path)

    def invalidate_sync_parents(self, parents: list[str] | set[str]) -> None:
        self.invalidated.append(list(parents))


class SyncJobManagerTests(unittest.TestCase):
    def test_single_file_job_runs_before_queued_batch_job(self) -> None:
        app = _FakeApp("batch-one.txt")
        manager = SyncJobManager(app, workers=1)
        self.addCleanup(manager.shutdown)
        batch_id = manager.submit(
            "batch",
            [
                ("local_to_dropbox", {"path": "batch-one.txt", "local_path": r"C:\tmp\batch-one.txt", "remote_path": "dropbox:batch-one.txt"}),
                ("local_to_dropbox", {"path": "batch-two.txt", "local_path": r"C:\tmp\batch-two.txt", "remote_path": "dropbox:batch-two.txt"}),
            ],
            batch=True,
            success_message="Batch sync complete",
        )
        wait_until(app.started.is_set, description="first batch job start")
        single_id = manager.submit(
            "single",
            [("local_to_dropbox", {"path": "priority.txt", "local_path": r"C:\tmp\priority.txt", "remote_path": "dropbox:priority.txt"})],
            batch=False,
            success_message="Sync complete",
        )
        app.release.set()

        def _done() -> bool:
            batch = syncstate.get(batch_id) or {}
            single = syncstate.get(single_id) or {}
            return batch.get("status") == "complete" and single.get("status") == "complete"

        wait_until(_done, description="sync job manager completion")

        self.assertEqual(app.executed, ["batch-one.txt", "priority.txt", "batch-two.txt"])

    def test_directory_jobs_invalidate_directory_and_parent(self) -> None:
        app = _FakeApp("never-block")
        manager = SyncJobManager(app, workers=1)
        self.addCleanup(manager.shutdown)
        op_id = manager.submit(
            "empty folder",
            [("dropbox_dir_to_local", {"path": "parent/empty", "local_path": r"C:\tmp\parent\empty", "remote_path": "dropbox:parent/empty"})],
            batch=True,
            success_message="Batch sync complete",
        )

        wait_until(lambda: syncstate.get(op_id) if (syncstate.get(op_id) or {}).get("status") == "complete" else None)

        self.assertEqual(app.executed, ["parent/empty"])
        self.assertEqual(len(app.invalidated), 1)
        self.assertEqual(set(app.invalidated[0]), {"parent", "parent/empty"})


class SyncJobIntegrationTests(IsolatedPathsTestCase):
    def _build_app(self, rclone: SimulatedRclone, local_root: Path | None = None, workers: int = 1, sync_workers: int = 2) -> DropboxBrowser:
        listing_cache = ListingCacheManager(ttl_seconds=1800)
        folder_cache = FolderCacheManager(
            rclone,
            workers=workers,
            ttl_seconds=86400,
            listing_cache=listing_cache,
            local_root=local_root,
            remote="dropbox:",
        )
        app = DropboxBrowser(rclone, "dropbox:", local_root, folder_cache=folder_cache, listing_cache=listing_cache)
        app.sync_jobs = SyncJobManager(app, workers=sync_workers)
        self.addCleanup(app.shutdown)
        return app

    def test_batch_sync_runs_multiple_copy_jobs_in_parallel(self) -> None:
        local_root = self.create_local_root({
            "batch-one.txt": b"one",
            "batch-two.txt": b"two",
        })
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1, sync_workers=2)

        original_copy = rclone.copy_file_overwrite
        started: list[str] = []
        active = 0
        max_active = 0
        started_two = threading.Event()
        release = threading.Event()
        lock = threading.Lock()

        def blocking_copy(source: str | Path, destination: str | Path, size_bytes: int | None = None) -> None:
            nonlocal active, max_active
            with lock:
                active += 1
                max_active = max(max_active, active)
                started.append(Path(str(source)).name)
                if len(started) >= 2:
                    started_two.set()
            if not release.wait(5):
                raise AssertionError("Timed out waiting to release copy jobs")
            original_copy(source, destination, size_bytes=size_bytes)
            with lock:
                active -= 1

        rclone.copy_file_overwrite = blocking_copy  # type: ignore[method-assign]

        with TestServer(app) as server:
            plan_payload = server.post_json("/sync-batch-plan", {
                "action": "local_to_dropbox_all",
                "recursive": "0",
                "enable_write_dropbox": "1",
            })
            plan_status = wait_until(
                lambda: server.get_json("/sync-status?id=" + plan_payload["id"])
                if server.get_json("/sync-status?id=" + plan_payload["id"]).get("status") != "running"
                else None,
                description="parallel batch plan completion",
            )
            payload = server.post_json("/sync-batch", {
                "action": "local_to_dropbox_all",
                "recursive": "0",
                "enable_write_dropbox": "1",
                "plan_token": plan_status["plan_token"],
            })
            wait_until(started_two.is_set, description="two copy jobs to start")
            release.set()

            def _done():
                result = server.get_json("/sync-status?id=" + payload["id"])
                return result if result.get("status") != "running" else None

            result = wait_until(_done, description="parallel batch sync completion")

        self.assertEqual(result["status"], "complete")
        self.assertGreaterEqual(max_active, 2)
        self.assertEqual((local_root / "batch-one.txt").read_bytes(), b"one")
        self.assertEqual((local_root / "batch-two.txt").read_bytes(), b"two")

    def test_sync_rclone_progress_uses_sync_group_not_folder_cache_progress(self) -> None:
        local_root = self.create_local_root({
            "one.txt": b"one",
            "two.txt": b"two",
        })
        rclone = SimulatedRclone()
        rclone.progress_fn = lambda: (194, 194)
        app = self._build_app(rclone, local_root=local_root, workers=1, sync_workers=1)

        op_id = app.sync_jobs.submit(
            "batch",
            [
                (
                    "local_to_dropbox",
                    {
                        "path": "one.txt",
                        "local_path": str(local_root / "one.txt"),
                        "remote_path": "dropbox:one.txt",
                    },
                ),
                (
                    "local_to_dropbox",
                    {
                        "path": "two.txt",
                        "local_path": str(local_root / "two.txt"),
                        "remote_path": "dropbox:two.txt",
                    },
                ),
            ],
            batch=True,
            success_message="Batch sync complete",
        )

        wait_until(lambda: syncstate.get(op_id) if (syncstate.get(op_id) or {}).get("status") == "complete" else None)

        self.assertEqual(rclone.progress_snapshots, ["1/2]", "2/2]"])
        self.assertNotIn("194/194]", rclone.progress_snapshots)

    def test_sync_all_local_to_dropbox_retries_throttled_writes_until_all_synced(self) -> None:
        local_root = self.create_local_root({
            "first.mp3": b"first-audio",
            "second.mp3": b"second-audio",
        })
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1, sync_workers=2)
        app.sync_jobs.throttle_retry_delays = (0.2,)

        original_copy = rclone.copy_file_overwrite
        attempts: dict[str, int] = {}
        failed_once: set[str] = set()
        saw_throttle = threading.Event()
        lock = threading.Lock()

        def throttled_copy(source: str | Path, destination: str | Path, size_bytes: int | None = None) -> None:
            destination_text = str(destination)
            with lock:
                attempt = attempts.get(destination_text, 0) + 1
                attempts[destination_text] = attempt
                if attempt == 1:
                    failed_once.add(destination_text)
                    if len(failed_once) == 2:
                        saw_throttle.set()
                    raise BrowserError(
                        HTTPStatus.BAD_GATEWAY,
                        "dropbox upload failed: too_many_write_operations, please retry",
                    )
            original_copy(source, destination, size_bytes=size_bytes)

        rclone.copy_file_overwrite = throttled_copy  # type: ignore[method-assign]

        with TestServer(app) as server:
            plan_payload = server.post_json("/sync-batch-plan", {
                "action": "local_to_dropbox_all",
                "recursive": "0",
                "enable_write_dropbox": "1",
            })
            plan_status = wait_until(
                lambda: server.get_json("/sync-status?id=" + plan_payload["id"])
                if server.get_json("/sync-status?id=" + plan_payload["id"]).get("status") != "running"
                else None,
                description="sync-all plan completion",
            )
            payload = server.post_json("/sync-batch", {
                "action": "local_to_dropbox_all",
                "recursive": "0",
                "enable_write_dropbox": "1",
                "plan_token": plan_status["plan_token"],
            })

            wait_until(saw_throttle.is_set, description="first throttled batch write failure")

            def _retrying() -> dict[str, object] | None:
                status = server.get_json("/sync-status?id=" + payload["id"])
                if status.get("status") != "running":
                    return None
                if "Retrying throttled Dropbox writes" not in str(status.get("message") or ""):
                    return None
                return status

            running = wait_until(_retrying, description="batch retry status")

            def _done():
                status = server.get_json("/sync-status?id=" + payload["id"])
                return status if status.get("status") != "running" else None

            result = wait_until(_done, description="sync-all completion after throttle retries")

        self.assertEqual(running["status"], "running")
        self.assertIn("rclone rcat --size", str(running["command"]))
        self.assertEqual(result["status"], "complete")
        self.assertEqual(result.get("errors"), [])
        self.assertEqual(attempts, {
            "dropbox:first.mp3": 2,
            "dropbox:second.mp3": 2,
        })
        self.assertEqual(rclone.cat_data["dropbox:first.mp3"], b"first-audio")
        self.assertEqual(rclone.cat_data["dropbox:second.mp3"], b"second-audio")
