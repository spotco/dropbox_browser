from __future__ import annotations

import unittest

from dropbox_browser.foldercache_records import (
    DIFF_CACHE_SCHEMA_VERSION,
    build_cache_record,
    validate_cache_record,
)


class FolderCacheRecordTests(unittest.TestCase):
    def test_build_cache_record_serializes_accumulated_state(self) -> None:
        record = build_cache_record(
            "dropbox:music",
            {
                "size": 42,
                "count": 3,
                "mtime": 123.5,
                "diff_status": "synced",
                "diff_complete": True,
                "first_diff_path": None,
                "file_statuses": {"song.mp3": {"diff_status": "synced"}},
            },
            complete=True,
            local_root="C:\\Music",
            now=1000.0,
        )

        self.assertEqual(record["remote_path"], "dropbox:music")
        self.assertEqual(record["schema_version"], DIFF_CACHE_SCHEMA_VERSION)
        self.assertEqual(record["local_root"], "C:\\Music")
        self.assertEqual(record["size"], 42)
        self.assertEqual(record["file_count"], 3)
        self.assertEqual(record["newest_mtime"], 123.5)
        self.assertEqual(record["diff_status"], "synced")
        self.assertTrue(record["diff_complete"])
        self.assertEqual(record["file_statuses"], {"song.mp3": {"diff_status": "synced"}})
        self.assertTrue(record["complete"])
        self.assertEqual(record["cached_at"], 1000.0)

    def test_build_cache_record_defaults_diff_state_for_remote_only_mode(self) -> None:
        record = build_cache_record("dropbox:", {}, complete=False, local_root=None, now=1000.0)

        self.assertEqual(record["diff_status"], "unavailable")
        self.assertTrue(record["diff_complete"])
        self.assertEqual(record["file_statuses"], {})

    def test_build_cache_record_defaults_diff_state_when_local_root_is_enabled(self) -> None:
        record = build_cache_record("dropbox:", {}, complete=False, local_root="C:\\Sync", now=1000.0)

        self.assertEqual(record["diff_status"], "loading")
        self.assertFalse(record["diff_complete"])

    def test_validate_cache_record_accepts_partial_records_past_ttl(self) -> None:
        record = {
            "local_root": "C:\\Sync",
            "schema_version": DIFF_CACHE_SCHEMA_VERSION,
            "complete": False,
            "cached_at": 1.0,
        }

        self.assertIs(
            validate_cache_record(record, expected_local_root="C:\\Sync", ttl_seconds=10, now=1000.0),
            record,
        )

    def test_validate_cache_record_rejects_mismatched_local_root(self) -> None:
        record = {
            "local_root": "C:\\Old",
            "schema_version": DIFF_CACHE_SCHEMA_VERSION,
            "complete": False,
            "cached_at": 1000.0,
        }

        self.assertIsNone(validate_cache_record(record, expected_local_root="C:\\New", ttl_seconds=10, now=1000.0))

    def test_validate_cache_record_rejects_old_schema_only_when_local_root_is_enabled(self) -> None:
        local_record = {
            "local_root": "C:\\Sync",
            "schema_version": DIFF_CACHE_SCHEMA_VERSION - 1,
            "complete": False,
            "cached_at": 1000.0,
        }
        remote_only_record = {
            "local_root": None,
            "schema_version": DIFF_CACHE_SCHEMA_VERSION - 1,
            "complete": False,
            "cached_at": 1000.0,
        }

        self.assertIsNone(
            validate_cache_record(local_record, expected_local_root="C:\\Sync", ttl_seconds=10, now=1000.0)
        )
        self.assertIs(
            validate_cache_record(remote_only_record, expected_local_root=None, ttl_seconds=10, now=1000.0),
            remote_only_record,
        )

    def test_validate_cache_record_rejects_stale_local_schema_record(self) -> None:
        record = {
            "local_root": "C:\\Sync",
            "schema_version": DIFF_CACHE_SCHEMA_VERSION - 1,
            "complete": True,
            "diff_complete": True,
            "cached_at": 1000.0,
        }

        self.assertIsNone(validate_cache_record(record, expected_local_root="C:\\Sync", ttl_seconds=10, now=1000.0))

    def test_validate_cache_record_rejects_complete_diff_with_loading_file_status(self) -> None:
        record = {
            "local_root": "C:\\Sync",
            "schema_version": DIFF_CACHE_SCHEMA_VERSION,
            "complete": True,
            "diff_complete": True,
            "file_statuses": {"song.mp3": {"diff_status": "loading"}},
            "cached_at": 1000.0,
        }

        self.assertIsNone(validate_cache_record(record, expected_local_root="C:\\Sync", ttl_seconds=10, now=1000.0))

    def test_validate_cache_record_rejects_complete_records_past_ttl(self) -> None:
        record = {
            "local_root": None,
            "schema_version": DIFF_CACHE_SCHEMA_VERSION,
            "complete": True,
            "cached_at": 1.0,
        }

        self.assertIsNone(validate_cache_record(record, expected_local_root=None, ttl_seconds=10, now=1000.0))


if __name__ == "__main__":
    unittest.main()
