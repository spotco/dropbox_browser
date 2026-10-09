"""Browse listing state right after a local -> Dropbox sync ("upload").

After a sync job finishes, ``invalidate_sync_parents`` drops the listing cache
and folder-cache record for the touched folder, so the next page load and the
next background folder-cache pass both run a live ``rclone lsjson``. Dropbox
commonly rejects or rate-limits requests right after a burst of writes. These
tests pin what the browse listing must look like when that live listing fails:

* a failed or unparseable lsjson is never recorded as an empty, complete folder
  and never marks parent folders as different;
* only rclone's "directory not found" counts as a real empty Dropbox folder;
* transient failures are retried (with zero delays here to keep tests fast);
* a page load that still fails serves the last good listing marked stale, or
  local rows labelled "Unknown" with an explicit remote_error, never cached.
"""
from __future__ import annotations

import time
import unittest

from dropbox_browser.foldercache import FolderCacheManager
from dropbox_browser.listingcache import ListingCacheManager
from dropbox_browser.services import DropboxBrowser

try:
    from tests.support import IsolatedPathsTestCase, SimulatedLsjsonResponse, SimulatedRclone, TestServer, wait_until
except ImportError:
    from support import IsolatedPathsTestCase, SimulatedLsjsonResponse, SimulatedRclone, TestServer, wait_until


REMOTE_ROOT = "dropbox:"
REMOTE_FOLDER = "dropbox:proj"
THROTTLED = SimulatedLsjsonResponse(
    returncode=1,
    stderr=b"Failed to lsjson: too_many_requests/: Too many requests or write operations.",
)
NOT_FOUND = SimulatedLsjsonResponse(
    returncode=3,
    stderr=b"ERROR : proj: error listing: directory not found",
)
GARBLED = SimulatedLsjsonResponse(invalid_json=True)


def _remote_items() -> list[dict]:
    return [
        {"Name": "dropbox-only.txt", "Path": "dropbox-only.txt", "IsDir": False, "Size": 6, "ModTime": "2024-01-01T12:00:00Z"},
        {"Name": "uploaded.txt", "Path": "uploaded.txt", "IsDir": False, "Size": 8, "ModTime": "2024-01-01T12:00:00Z"},
    ]


def _ok() -> SimulatedLsjsonResponse:
    return SimulatedLsjsonResponse(items=_remote_items())


class PostSyncRemoteListingFailureTests(IsolatedPathsTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.local_root = self.create_local_root({
            "proj/local-only.txt": "local",
            "proj/uploaded.txt": "uploaded",
        })

    def _build_app(
        self,
        rclone: SimulatedRclone,
        *,
        with_folder_cache: bool,
        cooldown_seconds: float = 60.0,
    ) -> DropboxBrowser:
        listing_cache = ListingCacheManager(ttl_seconds=1800)
        folder_cache = None
        if with_folder_cache:
            folder_cache = FolderCacheManager(
                rclone,
                workers=1,
                ttl_seconds=86400,
                listing_cache=listing_cache,
                local_root=self.local_root,
                remote="dropbox:",
                listing_retry_delays=(0.0, 0.0),
                listing_failure_cooldown_seconds=cooldown_seconds,
            )
        app = DropboxBrowser(rclone, "dropbox:", self.local_root, folder_cache=folder_cache, listing_cache=listing_cache)
        app.listing_retry_delay_seconds = 0.0
        self.addCleanup(app.shutdown)
        return app

    @staticmethod
    def _names(snapshot) -> list[str]:
        return sorted(str(entry["name"]) for entry in snapshot.entries)

    @staticmethod
    def _statuses(snapshot) -> dict[str, str]:
        return {str(entry["name"]): str(entry.get("status_label")) for entry in snapshot.entries}

    @staticmethod
    def _calls(rclone: SimulatedRclone, target: str) -> int:
        return sum(1 for call in rclone.calls if call["target"] == target)

    def _wait_for_failed_background_pass(self, app: DropboxBrowser, rclone: SimulatedRclone, target: str) -> None:
        wait_until(
            lambda: self._calls(rclone, target) >= 3 and app.folder_cache.status(target) != "calculating",
            description="background listing attempts to finish",
        )

    # ------------------------------------------------------------------
    # Background folder cache (foldercache.py)
    # ------------------------------------------------------------------

    def test_background_recompute_failure_after_sync_does_not_poison_folder_listing(self) -> None:
        # One throttled lsjson right after the sync, then Dropbox is healthy again.
        rclone = SimulatedRclone({REMOTE_FOLDER: [THROTTLED, _ok()]})
        app = self._build_app(rclone, with_folder_cache=True)

        # Exactly what SyncJobManager does once the upload group completes.
        app.invalidate_sync_parents(["proj"])
        # The folder-info poller / next page load queues the background pass.
        page_time = time.time()
        app.folder_cache.notify_page_load(page_time, page_key="proj")
        app.folder_cache.request(REMOTE_FOLDER, page_time)
        record = wait_until(
            lambda: app.folder_cache.get(REMOTE_FOLDER),
            description="background folder-cache record after the throttled lsjson",
        )
        self.assertEqual(
            sorted(item["Name"] for item in record.get("direct_items", [])),
            ["dropbox-only.txt", "uploaded.txt"],
        )
        self.assertEqual(self._calls(rclone, REMOTE_FOLDER), 2, "the throttled lsjson should be retried once")

        snapshot = app.build_browse_snapshot("proj", "name", "asc")

        self.assertIn(
            "dropbox-only.txt",
            self._names(snapshot),
            "Dropbox-only file vanished after one throttled background lsjson "
            f"(listing_source={snapshot.listing_source!r}, rows={self._names(snapshot)!r}, "
            f"lsjson calls={len(rclone.calls)})",
        )
        self.assertIsNone(snapshot.remote_error)

    def test_background_persistent_failure_records_nothing_and_defers_requests(self) -> None:
        rclone = SimulatedRclone({REMOTE_FOLDER: [THROTTLED]})
        app = self._build_app(rclone, with_folder_cache=True)
        cache = app.folder_cache

        cache.request(REMOTE_FOLDER, time.time())
        self._wait_for_failed_background_pass(app, rclone, REMOTE_FOLDER)

        self.assertEqual(self._calls(rclone, REMOTE_FOLDER), 3, "two retries then give up")
        self.assertIsNone(cache.get(REMOTE_FOLDER), "a failed listing must not be recorded")
        self.assertIsNone(cache.get_direct_listing(REMOTE_FOLDER))
        self.assertIsNone(app.listing_cache.get(REMOTE_FOLDER))

        # Folder-info polling re-requests the folder; within the cooldown that
        # must not start another burst of lsjson calls.
        cache.request(REMOTE_FOLDER, time.time())
        time.sleep(0.2)
        self.assertEqual(self._calls(rclone, REMOTE_FOLDER), 3)
        events = [event["event"] for event in self.read_trace_events() if event.get("remote_path") == REMOTE_FOLDER]
        self.assertIn("folder_listing_failed", events)
        self.assertIn("request_deferred_listing_failure", events)

    def test_background_failure_cooldown_is_cleared_by_invalidation(self) -> None:
        rclone = SimulatedRclone({REMOTE_FOLDER: [THROTTLED, THROTTLED, THROTTLED, _ok()]})
        app = self._build_app(rclone, with_folder_cache=True)
        cache = app.folder_cache

        cache.request(REMOTE_FOLDER, time.time())
        self._wait_for_failed_background_pass(app, rclone, REMOTE_FOLDER)
        self.assertIsNone(cache.get(REMOTE_FOLDER))

        # An explicit refresh / post-sync invalidation retries immediately.
        cache.invalidate(REMOTE_FOLDER)
        cache.request(REMOTE_FOLDER, time.time())
        record = wait_until(lambda: cache.get(REMOTE_FOLDER), description="record after recovery")
        self.assertTrue(record["complete"])
        self.assertEqual(len(record["direct_items"]), 2)

    def test_background_unparseable_listing_is_retried_not_recorded_empty(self) -> None:
        rclone = SimulatedRclone({REMOTE_FOLDER: [GARBLED]})
        app = self._build_app(rclone, with_folder_cache=True)

        app.folder_cache.request(REMOTE_FOLDER, time.time())
        self._wait_for_failed_background_pass(app, rclone, REMOTE_FOLDER)

        self.assertIsNone(app.folder_cache.get(REMOTE_FOLDER))
        self.assertIsNone(app.folder_cache.get_direct_listing(REMOTE_FOLDER))

    def test_background_child_failure_does_not_mark_parent_as_different(self) -> None:
        rclone = SimulatedRclone({
            REMOTE_ROOT: [SimulatedLsjsonResponse(items=[
                {"Name": "proj", "Path": "proj", "IsDir": True, "Size": -1, "ModTime": "2024-01-01T12:00:00Z"},
            ])],
            REMOTE_FOLDER: [THROTTLED],
        })
        app = self._build_app(rclone, with_folder_cache=True)
        cache = app.folder_cache

        cache.request(REMOTE_ROOT, time.time())
        self._wait_for_failed_background_pass(app, rclone, REMOTE_FOLDER)
        time.sleep(0.1)

        self.assertIsNone(cache.get(REMOTE_FOLDER))
        parent = cache.get(REMOTE_ROOT)
        self.assertIsNotNone(parent)
        self.assertFalse(parent["complete"], "a parent with a failed child must stay incomplete")
        self.assertNotEqual(parent.get("diff_status"), "has_diffs")
        self.assertIsNone(parent.get("first_diff_path"))

    def test_background_directory_not_found_is_a_real_empty_folder(self) -> None:
        rclone = SimulatedRclone({REMOTE_FOLDER: [NOT_FOUND]})
        app = self._build_app(rclone, with_folder_cache=True)

        app.folder_cache.request(REMOTE_FOLDER, time.time())
        record = wait_until(
            lambda: app.folder_cache.get(REMOTE_FOLDER),
            description="record for a folder missing on Dropbox",
        )

        self.assertTrue(record["complete"])
        self.assertEqual(record["direct_items"], [])
        self.assertEqual(self._calls(rclone, REMOTE_FOLDER), 1, "not-found must not be retried")

    # ------------------------------------------------------------------
    # Foreground page-load listing (services.py)
    # ------------------------------------------------------------------

    def test_foreground_listing_failure_right_after_sync_does_not_render_local_only_folder(self) -> None:
        # No folder cache so only the foreground listing path is exercised.
        rclone = SimulatedRclone({REMOTE_FOLDER: [THROTTLED, _ok()]})
        app = self._build_app(rclone, with_folder_cache=False)
        app.invalidate_sync_parents(["proj"])

        snapshot = app.build_browse_snapshot("proj", "name", "asc")

        statuses = self._statuses(snapshot)
        self.assertIn(
            "dropbox-only.txt",
            statuses,
            "A single transient lsjson failure produced a local-only listing presented as complete "
            f"(listing_source={snapshot.listing_source!r}, statuses={statuses!r})",
        )
        self.assertEqual(snapshot.listing_source, "rclone")
        self.assertIsNone(snapshot.remote_error)
        self.assertFalse(snapshot.listing_stale)
        self.assertEqual(self._calls(rclone, REMOTE_FOLDER), 2)

    def test_foreground_persistent_failure_serves_last_good_listing_marked_stale(self) -> None:
        rclone = SimulatedRclone({REMOTE_FOLDER: [_ok(), THROTTLED]})
        app = self._build_app(rclone, with_folder_cache=False)
        first = app.build_browse_snapshot("proj", "name", "asc")
        self.assertIsNone(first.remote_error)

        app.invalidate_sync_parents(["proj"])
        snapshot = app.build_browse_snapshot("proj", "name", "asc")

        self.assertEqual(snapshot.listing_source, "stale_after_remote_error")
        self.assertTrue(snapshot.listing_stale)
        self.assertIn("too_many_requests", snapshot.remote_error or "")
        self.assertIsNotNone(snapshot.stale_cached_at)
        self.assertEqual(self._names(snapshot), ["dropbox-only.txt", "local-only.txt", "uploaded.txt"])
        # The stale fallback must not be written back as a fresh listing.
        self.assertIsNone(app.listing_cache.get(REMOTE_FOLDER))
        self.assertEqual(self._calls(rclone, REMOTE_FOLDER), 3)

    def test_foreground_persistent_failure_without_last_good_reports_unknown_and_is_not_cached(self) -> None:
        rclone = SimulatedRclone({REMOTE_FOLDER: [THROTTLED, THROTTLED, _ok()]})
        app = self._build_app(rclone, with_folder_cache=False)

        snapshot = app.build_browse_snapshot("proj", "name", "asc")

        self.assertEqual(snapshot.listing_source, "local_only_after_remote_error")
        self.assertFalse(snapshot.listing_stale)
        self.assertIn("too_many_requests", snapshot.remote_error or "")
        self.assertEqual(self._statuses(snapshot), {"local-only.txt": "Unknown", "uploaded.txt": "Unknown"})
        self.assertIsNone(app.listing_cache.get(REMOTE_FOLDER))

        # Nothing was cached, so the next page load asks Dropbox again and recovers.
        recovered = app.build_browse_snapshot("proj", "name", "asc")
        self.assertIsNone(recovered.remote_error)
        self.assertEqual(recovered.listing_source, "rclone")
        self.assertEqual(self._statuses(recovered)["local-only.txt"], "Local Only")
        self.assertEqual(self._statuses(recovered)["dropbox-only.txt"], "Dropbox Only")

    def test_foreground_directory_not_found_shows_local_only_without_error(self) -> None:
        rclone = SimulatedRclone({REMOTE_FOLDER: [NOT_FOUND]})
        app = self._build_app(rclone, with_folder_cache=False)

        snapshot = app.build_browse_snapshot("proj", "name", "asc")

        self.assertEqual(snapshot.listing_source, "local_only_remote_missing")
        self.assertIsNone(snapshot.remote_error)
        self.assertEqual(self._statuses(snapshot), {"local-only.txt": "Local Only", "uploaded.txt": "Local Only"})
        self.assertEqual(self._calls(rclone, REMOTE_FOLDER), 1, "not-found must not be retried")

    def test_listing_endpoint_reports_remote_error_and_unknown_status(self) -> None:
        rclone = SimulatedRclone({REMOTE_FOLDER: [THROTTLED]})
        app = self._build_app(rclone, with_folder_cache=False)
        app.client_render = True

        with TestServer(app) as server:
            payload = server.get_json("/browse/endpoints/listing?path=proj")

        listing = payload["listing"]
        self.assertEqual(listing["source"], "local_only_after_remote_error")
        self.assertIn("too_many_requests", listing["remote_error"])
        self.assertFalse(listing["stale"])
        rows = {row["path"].rsplit("/", 1)[-1]: row for row in payload["rows"]}
        self.assertEqual(set(rows), {"local-only.txt", "uploaded.txt"})
        for row in rows.values():
            self.assertEqual(row["status_label"], "Unknown")
            self.assertEqual(row["status_class"], "unknown")
            self.assertFalse(row["sync"]["allowed"], "no sync actions while Dropbox state is unknown")

    def test_listing_endpoint_reports_stale_listing(self) -> None:
        rclone = SimulatedRclone({REMOTE_FOLDER: [_ok(), THROTTLED]})
        app = self._build_app(rclone, with_folder_cache=False)
        app.client_render = True

        with TestServer(app) as server:
            server.get_json("/browse/endpoints/listing?path=proj")
            app.invalidate_sync_parents(["proj"])
            payload = server.get_json("/browse/endpoints/listing?path=proj")

        listing = payload["listing"]
        self.assertTrue(listing["stale"])
        self.assertEqual(listing["source"], "stale_after_remote_error")
        self.assertIn("too_many_requests", listing["remote_error"])
        self.assertTrue(listing["stale_cached_display"])
        self.assertIn("proj/dropbox-only.txt", {row["path"] for row in payload["rows"]})


if __name__ == "__main__":
    unittest.main()
