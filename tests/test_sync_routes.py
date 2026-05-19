from __future__ import annotations

import json
import threading
import time
from http import HTTPStatus
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

from dropbox_browser.errors import BrowserError
from dropbox_browser.foldercache import DIFF_CACHE_SCHEMA_VERSION
from dropbox_browser.listingcache import ListingCacheManager
from dropbox_browser.services import DropboxBrowser

try:
    from tests.app_test_support import AppTestCase, PreloadedFolderCache, RecordingFolderCache
    from tests.support import SimulatedLsjsonResponse, SimulatedRclone, TestServer, remote_dir_item, remote_file_item, wait_until
except ImportError:
    from app_test_support import AppTestCase, PreloadedFolderCache, RecordingFolderCache
    from support import SimulatedLsjsonResponse, SimulatedRclone, TestServer, remote_dir_item, remote_file_item, wait_until



class SyncRouteTests(AppTestCase):
    def test_sync_post_requires_enabled_guard(self) -> None:
        local_root = self.create_local_root({
            "local.txt": b"local",
        })
        rclone = SimulatedRclone({})
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            body = b"path=local.txt&kind=file&direction=local_to_dropbox&enable_write_dropbox=0"
            request = Request(
                server.base_url + "/sync",
                data=body,
                method="POST",
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            with self.assertRaises(HTTPError) as ctx:
                urlopen(request, timeout=5)

        self.assertEqual(ctx.exception.code, 403)
        ctx.exception.close()

    def test_sync_post_requires_direction_specific_enabled_guard(self) -> None:
        local_root = self.create_local_root({})
        rclone = SimulatedRclone(cat_data={
            "dropbox:remote.txt": b"remote",
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            body = b"path=remote.txt&kind=file&direction=dropbox_to_local&enable_to_local=0&enable_write_dropbox=1"
            request = Request(
                server.base_url + "/sync",
                data=body,
                method="POST",
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            with self.assertRaises(HTTPError) as ctx:
                urlopen(request, timeout=5)

        self.assertEqual(ctx.exception.code, 403)
        ctx.exception.close()

    def test_sync_post_rejects_folder_kind(self) -> None:
        local_root = self.create_local_root({
            "folder/inside.txt": b"inside",
        })
        rclone = SimulatedRclone({})
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            body = b"path=folder&kind=folder&direction=local_to_dropbox&enable_write_dropbox=1"
            request = Request(
                server.base_url + "/sync",
                data=body,
                method="POST",
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            with self.assertRaises(HTTPError) as ctx:
                urlopen(request, timeout=5)

        self.assertEqual(ctx.exception.code, 400)
        ctx.exception.close()

    def test_sync_local_only_file_copies_local_to_dropbox(self) -> None:
        local_root = self.create_local_root({
            "local.txt": b"local",
        })
        rclone = SimulatedRclone({})
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            payload = server.post_json("/sync", {
                "path": "local.txt",
                "kind": "file",
                "direction": "local_to_dropbox",
                "enable_write_dropbox": "1",
            })
            result = wait_until(
                lambda: server.get_json("/sync-status?id=" + payload["id"])
                if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
                else None,
                description="local-to-dropbox sync completion",
            )

        self.assertEqual(result["status"], "complete")
        self.assertEqual(rclone.cat_data["dropbox:local.txt"], b"local")
        self.assertTrue(any(call["args"][0] == "copyto" and call["target"] == "dropbox:local.txt" for call in rclone.calls))

    def test_sync_dropbox_only_file_copies_dropbox_to_local(self) -> None:
        local_root = self.create_local_root({})
        rclone = SimulatedRclone(cat_data={
            "dropbox:remote.txt": b"remote",
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            payload = server.post_json("/sync", {
                "path": "remote.txt",
                "kind": "file",
                "direction": "dropbox_to_local",
                "enable_to_local": "1",
            })
            result = wait_until(
                lambda: server.get_json("/sync-status?id=" + payload["id"])
                if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
                else None,
                description="dropbox-to-local sync completion",
            )

        self.assertEqual(result["status"], "complete")
        self.assertEqual((local_root / "remote.txt").read_bytes(), b"remote")
        self.assertTrue(any(call["args"][0] == "copyto" and call["target"] == str(local_root / "remote.txt") for call in rclone.calls))

    def test_sync_dropbox_only_nested_file_does_not_copy_to_partial_ancestor_path(self) -> None:
        local_root = self.create_local_root({
            "conan/Season Pack": b"misplaced episode bytes",
        })
        rclone = SimulatedRclone(cat_data={
            "dropbox:conan/Season Pack/Episodes/episode 001.mkv": b"episode",
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            payload = server.post_json("/sync", {
                "path": "conan/Season Pack/Episodes/episode 001.mkv",
                "kind": "file",
                "direction": "dropbox_to_local",
                "enable_to_local": "1",
            })
            result = wait_until(
                lambda: server.get_json("/sync-status?id=" + payload["id"])
                if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
                else None,
                description="nested dropbox-to-local sync completion",
            )

        expected = local_root / "conan" / "Season Pack" / "Episodes" / "episode 001.mkv"
        bad_partial = local_root / "conan" / "Season Pack"
        self.assertEqual(result["status"], "error")
        self.assertEqual(bad_partial.read_bytes(), b"misplaced episode bytes")
        self.assertFalse(expected.exists())
        self.assertFalse(any(
            call["args"][0] == "copyto" and call["target"] == str(bad_partial)
            for call in rclone.calls
        ))

    def test_sync_dropbox_only_nested_file_uses_full_safe_destination_path(self) -> None:
        local_root = self.create_local_root({})
        rclone = SimulatedRclone(cat_data={
            "dropbox:conan/Season Pack/Episodes/episode 001.mkv": b"episode",
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            payload = server.post_json("/sync", {
                "path": "conan/Season Pack/Episodes/episode 001.mkv",
                "kind": "file",
                "direction": "dropbox_to_local",
                "enable_to_local": "1",
            })
            result = wait_until(
                lambda: server.get_json("/sync-status?id=" + payload["id"])
                if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
                else None,
                description="nested dropbox-to-local sync completion",
            )

        expected = local_root / "conan" / "Season Pack" / "Episodes" / "episode 001.mkv"
        self.assertEqual(result["status"], "complete")
        self.assertEqual(expected.read_bytes(), b"episode")
        self.assertTrue(any(
            call["args"][0] == "copyto" and call["target"] == str(expected)
            for call in rclone.calls
        ))

    def test_batch_plan_lists_current_folder_files_by_action(self) -> None:
        local_root = self.create_local_root({
            "local.txt": b"local",
            "changed.txt": b"local",
            "synced.txt": b"synced",
            "child/local-child.txt": b"child",
            ".DS_Store": b"ignored",
        })
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[
                {"Name": "changed.txt", "Path": "changed.txt", "IsDir": False, "Size": 99, "ModTime": "2024-01-01T12:00:00Z"},
                {"Name": "remote.txt", "Path": "remote.txt", "IsDir": False, "Size": 6, "ModTime": "2024-01-01T12:00:00Z"},
                remote_file_item("synced.txt", local_root / "synced.txt"),
                remote_dir_item("child"),
            ])],
            "dropbox:child": [SimulatedLsjsonResponse(items=[
                {"Name": "remote-child.txt", "Path": "child/remote-child.txt", "IsDir": False, "Size": 7, "ModTime": "2024-01-01T12:00:00Z"},
            ])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            nonrecursive = server.post_json("/sync-batch-plan", {
                "action": "local_to_dropbox_all",
                "recursive": "0",
                "enable_write_dropbox": "1",
            })
            recursive = server.post_json("/sync-batch-plan", {
                "action": "local_to_dropbox_all",
                "recursive": "1",
                "enable_write_dropbox": "1",
            })
            delete_local = server.post_json("/sync-batch-plan", {
                "action": "delete_local_only_all",
                "recursive": "0",
                "enable_to_local": "1",
            })
            copy_to_local = server.post_json("/sync-batch-plan", {
                "action": "dropbox_only_to_local_all",
                "recursive": "0",
                "enable_to_local": "1",
            })
            copy_to_local_recursive = server.post_json("/sync-batch-plan", {
                "action": "dropbox_only_to_local_all",
                "recursive": "1",
                "enable_to_local": "1",
            })

        self.assertEqual([item["path"] for item in nonrecursive["groups"]["local_to_dropbox"]], ["changed.txt", "local.txt"])
        self.assertEqual([item["path"] for item in recursive["groups"]["local_to_dropbox"]], ["child/local-child.txt", "changed.txt", "local.txt"])
        self.assertEqual([item["path"] for item in delete_local["groups"]["delete_local"]], ["local.txt"])
        self.assertEqual([item["path"] for item in copy_to_local["groups"]["dropbox_to_local"]], ["remote.txt"])
        self.assertEqual([item["path"] for item in copy_to_local_recursive["groups"]["dropbox_to_local"]], ["child/remote-child.txt", "remote.txt"])
        self.assertNotIn(".DS_Store", str(nonrecursive))

    def test_recursive_batch_plan_uses_sync_worker_concurrency(self) -> None:
        local_root = self.create_local_root({})
        release = threading.Event()
        started_a = threading.Event()
        started_b = threading.Event()
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[
                remote_dir_item("a"),
                remote_dir_item("b"),
            ]), SimulatedLsjsonResponse(items=[
                remote_dir_item("a"),
                remote_dir_item("b"),
            ])],
            "dropbox:a": [
                SimulatedLsjsonResponse(items=[], wait_event=release, started_event=started_a),
                SimulatedLsjsonResponse(items=[]),
            ],
            "dropbox:b": [
                SimulatedLsjsonResponse(items=[], wait_event=release, started_event=started_b),
                SimulatedLsjsonResponse(items=[]),
            ],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1, sync_workers=2)
        plan_holder: dict[str, Any] = {}

        def run_plan() -> None:
            plan_holder["plan"] = app.plan_batch_sync("", "dropbox_only_to_local_all", recursive=True)

        thread = threading.Thread(target=run_plan)
        thread.start()
        try:
            wait_until(started_a.is_set, description="first child planning listing")
            wait_until(started_b.is_set, description="second child planning listing")
        finally:
            release.set()
            thread.join(timeout=5)

        self.assertFalse(thread.is_alive())
        self.assertEqual(
            [item["path"] for item in plan_holder["plan"]["groups"]["dropbox_dir_to_local"]],
            ["a", "b"],
        )

    def test_recursive_batch_plans_skip_confirmed_synced_subtrees(self) -> None:
        local_root = self.create_local_root({
            "synced/track.txt": b"same",
            "local-root.txt": b"local",
        })

        class SyncedFolderCache:
            def get(self, remote_path: str) -> dict[str, Any] | None:
                if remote_path == "dropbox:synced":
                    return {
                        "complete": True,
                        "diff_complete": True,
                        "diff_status": "synced",
                    }
                return None

        root_items = [
            remote_dir_item("synced"),
            remote_dir_item("remote-only"),
            {"Name": "remote-root.txt", "Path": "remote-root.txt", "IsDir": False, "Size": 6, "ModTime": "2024-01-01T12:00:00Z"},
        ]
        rclone = SimulatedRclone({
            "dropbox:": [
                SimulatedLsjsonResponse(items=root_items),
                SimulatedLsjsonResponse(items=root_items),
            ],
            "dropbox:remote-only": [
                SimulatedLsjsonResponse(items=[
                    {"Name": "remote-child.txt", "Path": "remote-only/remote-child.txt", "IsDir": False, "Size": 6, "ModTime": "2024-01-01T12:00:00Z"},
                ]),
                SimulatedLsjsonResponse(items=[
                    {"Name": "remote-child.txt", "Path": "remote-only/remote-child.txt", "IsDir": False, "Size": 6, "ModTime": "2024-01-01T12:00:00Z"},
                ]),
            ],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1, sync_workers=2)
        app.folder_cache = SyncedFolderCache()

        copy_to_local = app.plan_batch_sync("", "dropbox_only_to_local_all", recursive=True)
        sync_to_dropbox = app.plan_batch_sync("", "local_to_dropbox_all", recursive=True)

        self.assertEqual(
            [item["path"] for item in copy_to_local["groups"]["dropbox_dir_to_local"]],
            ["remote-only"],
        )
        self.assertEqual(
            [item["path"] for item in copy_to_local["groups"]["dropbox_to_local"]],
            ["remote-only/remote-child.txt", "remote-root.txt"],
        )
        self.assertEqual(
            [item["path"] for item in sync_to_dropbox["groups"]["local_to_dropbox"]],
            ["local-root.txt"],
        )
        self.assertFalse(any(call["target"] == "dropbox:synced" for call in rclone.calls))

    def test_batch_delete_local_only_runs_per_file(self) -> None:
        local_root = self.create_local_root({
            "local.txt": b"local",
            "local-folder/inside.txt": b"inside",
            "changed.txt": b"local",
            "synced.txt": b"synced",
        })
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[
                {"Name": "changed.txt", "Path": "changed.txt", "IsDir": False, "Size": 6, "ModTime": "2024-01-01T12:00:00Z"},
                remote_file_item("synced.txt", local_root / "synced.txt"),
            ])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            payload = server.post_json("/sync-batch", {
                "action": "delete_local_only_all",
                "recursive": "0",
                "enable_to_local": "1",
            })
            result = wait_until(
                lambda: server.get_json("/sync-status?id=" + payload["id"])
                if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
                else None,
                description="batch delete completion",
            )

        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["message"], "Batch sync complete")
        self.assertFalse((local_root / "local.txt").exists())
        self.assertFalse((local_root / "local-folder").exists())
        self.assertEqual((local_root / "changed.txt").read_bytes(), b"local")
        self.assertFalse(any(call["args"][0] == "copyto" and call["target"] == str(local_root / "changed.txt") for call in rclone.calls))

    def test_batch_copy_dropbox_only_to_local_runs_per_file(self) -> None:
        local_root = self.create_local_root({
            "changed.txt": b"local",
            "synced.txt": b"synced",
        })
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[
                {"Name": "changed.txt", "Path": "changed.txt", "IsDir": False, "Size": 6, "ModTime": "2024-01-01T12:00:00Z"},
                {"Name": "remote.txt", "Path": "remote.txt", "IsDir": False, "Size": 6, "ModTime": "2024-01-01T12:00:00Z"},
                remote_file_item("synced.txt", local_root / "synced.txt"),
            ])],
        }, cat_data={
            "dropbox:remote.txt": b"remote",
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            payload = server.post_json("/sync-batch", {
                "action": "dropbox_only_to_local_all",
                "recursive": "0",
                "enable_to_local": "1",
            })
            result = wait_until(
                lambda: server.get_json("/sync-status?id=" + payload["id"])
                if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
                else None,
                description="batch copy to local completion",
            )

        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["message"], "Batch sync complete")
        self.assertEqual((local_root / "remote.txt").read_bytes(), b"remote")
        self.assertEqual((local_root / "changed.txt").read_bytes(), b"local")
        self.assertTrue(any(call["args"][0] == "copyto" and call["target"] == str(local_root / "remote.txt") for call in rclone.calls))
        self.assertFalse(any(call["args"][0] == "copyto" and call["target"] == str(local_root / "changed.txt") for call in rclone.calls))

    def test_recursive_batch_copy_dropbox_only_to_local_creates_empty_folders(self) -> None:
        local_root = self.create_local_root({})
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[
                remote_dir_item("empty-remote"),
            ])],
            "dropbox:empty-remote": [SimulatedLsjsonResponse(items=[])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            plan = server.post_json("/sync-batch-plan", {
                "action": "dropbox_only_to_local_all",
                "recursive": "1",
                "enable_to_local": "1",
            })
            payload = server.post_json("/sync-batch", {
                "action": "dropbox_only_to_local_all",
                "recursive": "1",
                "enable_to_local": "1",
            })
            result = wait_until(
                lambda: server.get_json("/sync-status?id=" + payload["id"])
                if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
                else None,
                description="empty remote folder copy completion",
            )

        self.assertEqual([item["path"] for item in plan["groups"]["dropbox_dir_to_local"]], ["empty-remote"])
        self.assertEqual(result["status"], "complete")
        self.assertTrue((local_root / "empty-remote").is_dir())

    def test_recursive_batch_copy_local_to_dropbox_creates_empty_folders(self) -> None:
        local_root = self.create_local_root({
            "empty-local": None,
        })
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[])],
            "dropbox:empty-local": [SimulatedLsjsonResponse(items=[])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            plan = server.post_json("/sync-batch-plan", {
                "action": "local_to_dropbox_all",
                "recursive": "1",
                "enable_write_dropbox": "1",
            })
            payload = server.post_json("/sync-batch", {
                "action": "local_to_dropbox_all",
                "recursive": "1",
                "enable_write_dropbox": "1",
            })
            result = wait_until(
                lambda: server.get_json("/sync-status?id=" + payload["id"])
                if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
                else None,
                description="empty local folder copy completion",
            )

        self.assertEqual([item["path"] for item in plan["groups"]["local_dir_to_dropbox"]], ["empty-local"])
        self.assertEqual(result["status"], "complete")
        self.assertTrue(any(call["args"][0] == "mkdir" and call["target"] == "dropbox:empty-local" for call in rclone.calls))

    def test_recursive_batch_copy_local_to_dropbox_deduplicates_mkdir_ancestors(self) -> None:
        local_root = self.create_local_root({
            "a/b/c": None,
            "a/b/d": None,
            "a/e": None,
        })
        rclone = SimulatedRclone({
            "dropbox:": [
                SimulatedLsjsonResponse(items=[]),
                SimulatedLsjsonResponse(items=[]),
            ],
            "dropbox:a": [
                SimulatedLsjsonResponse(items=[]),
                SimulatedLsjsonResponse(items=[]),
            ],
            "dropbox:a/b": [
                SimulatedLsjsonResponse(items=[]),
                SimulatedLsjsonResponse(items=[]),
            ],
            "dropbox:a/b/c": [
                SimulatedLsjsonResponse(items=[]),
                SimulatedLsjsonResponse(items=[]),
            ],
            "dropbox:a/b/d": [
                SimulatedLsjsonResponse(items=[]),
                SimulatedLsjsonResponse(items=[]),
            ],
            "dropbox:a/e": [
                SimulatedLsjsonResponse(items=[]),
                SimulatedLsjsonResponse(items=[]),
            ],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1, sync_workers=4)

        with TestServer(app) as server:
            plan = server.post_json("/sync-batch-plan", {
                "action": "local_to_dropbox_all",
                "recursive": "1",
                "enable_write_dropbox": "1",
            })
            payload = server.post_json("/sync-batch", {
                "action": "local_to_dropbox_all",
                "recursive": "1",
                "enable_write_dropbox": "1",
            })
            result = wait_until(
                lambda: server.get_json("/sync-status?id=" + payload["id"])
                if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
                else None,
                description="deduplicated mkdir batch completion",
            )

        mkdir_targets = [
            call["target"]
            for call in rclone.calls
            if call["args"][0] == "mkdir"
        ]
        self.assertEqual(result["status"], "complete")
        self.assertEqual(
            [item["path"] for item in plan["groups"]["local_dir_to_dropbox"]],
            ["a/b/c", "a/b/d", "a/b", "a/e", "a"],
        )
        self.assertEqual(
            sorted(mkdir_targets, key=str.casefold),
            sorted({
                "dropbox:a",
                "dropbox:a/b",
                "dropbox:a/b/c",
                "dropbox:a/b/d",
                "dropbox:a/e",
            }, key=str.casefold),
        )

    def test_recursive_local_to_dropbox_sync_invalidates_parent_listing_cache_for_new_folders(self) -> None:
        local_root = self.create_local_root({
            "local-folder/file.txt": b"local",
        })
        rclone = SimulatedRclone({
            "dropbox:": [
                SimulatedLsjsonResponse(items=[]),
                SimulatedLsjsonResponse(items=[remote_dir_item("local-folder")]),
            ],
            "dropbox:local-folder": [
                SimulatedLsjsonResponse(items=[]),
            ],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)
        assert app.listing_cache is not None
        app.listing_cache.set("dropbox:", [])

        with TestServer(app) as server:
            payload = server.post_json("/sync-batch", {
                "action": "local_to_dropbox_all",
                "recursive": "1",
                "enable_write_dropbox": "1",
            })
            result = wait_until(
                lambda: server.get_json("/sync-status?id=" + payload["id"])
                if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
                else None,
                description="recursive local-to-dropbox sync completion",
            )
            html = server.get_text("/")

        self.assertEqual(result["status"], "complete")
        folder_row = html.split('<span class="entry-name">local-folder</span></a></td>', 1)[1].split("</tr>", 1)[0]
        self.assertNotIn("Local Only", folder_row)
        self.assertGreaterEqual(sum(1 for call in rclone.calls if call["target"] == "dropbox:"), 2)

    def test_recursive_batch_delete_removes_nested_local_only_folders_after_children(self) -> None:
        local_root = self.create_local_root({
            "keep-remote/remote.txt": b"same",
            "local-folder/nested/file.txt": b"delete",
        })
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[
                remote_dir_item("keep-remote"),
            ])],
            "dropbox:keep-remote": [SimulatedLsjsonResponse(items=[
                remote_file_item("remote.txt", local_root / "keep-remote" / "remote.txt"),
            ])],
            "dropbox:local-folder": [SimulatedLsjsonResponse(items=[])],
            "dropbox:local-folder/nested": [SimulatedLsjsonResponse(items=[])],
        })
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            plan = server.post_json("/sync-batch-plan", {
                "action": "delete_local_only_all",
                "recursive": "1",
                "enable_to_local": "1",
            })
            payload = server.post_json("/sync-batch", {
                "action": "delete_local_only_all",
                "recursive": "1",
                "enable_to_local": "1",
            })
            result = wait_until(
                lambda: server.get_json("/sync-status?id=" + payload["id"])
                if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
                else None,
                description="recursive folder delete completion",
            )

        self.assertEqual(
            [item["path"] for item in plan["groups"]["delete_local"]],
            ["local-folder/nested/file.txt", "local-folder/nested", "local-folder"],
        )
        self.assertEqual(result["status"], "complete")
        self.assertFalse((local_root / "local-folder").exists())
        self.assertTrue((local_root / "keep-remote").exists())

    def test_batch_sync_continues_after_file_error_and_reports_it(self) -> None:
        local_root = self.create_local_root({
            "bad.txt": b"bad",
            "good.txt": b"good",
        })
        rclone = SimulatedRclone({
            "dropbox:": [SimulatedLsjsonResponse(items=[])],
        })
        original_copy = rclone.copy_file_overwrite

        def flaky_copy(source: str | Path, destination: str | Path) -> None:
            if str(destination) == "dropbox:bad.txt":
                raise BrowserError(HTTPStatus.BAD_GATEWAY, "planned failure")
            original_copy(source, destination)

        rclone.copy_file_overwrite = flaky_copy  # type: ignore[method-assign]
        app = self._build_app(rclone, local_root=local_root, workers=1)

        with TestServer(app) as server:
            payload = server.post_json("/sync-batch", {
                "action": "local_to_dropbox_all",
                "recursive": "0",
                "enable_write_dropbox": "1",
            })
            result = wait_until(
                lambda: server.get_json("/sync-status?id=" + payload["id"])
                if server.get_json("/sync-status?id=" + payload["id"]).get("status") != "running"
                else None,
                description="batch failure completion",
            )

        self.assertEqual(result["status"], "complete")
        self.assertIn("1 error", result["message"])
        self.assertEqual(rclone.cat_data["dropbox:good.txt"], b"good")
        self.assertTrue(any("bad.txt" in error for error in result["errors"]))
