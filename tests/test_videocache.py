from __future__ import annotations

import time
import unittest
from pathlib import Path

from dropbox_browser.videocache import DiskCacheStore

try:
    from tests.support import IsolatedPathsTestCase
except ImportError:
    from support import IsolatedPathsTestCase


class DiskCacheStoreTests(IsolatedPathsTestCase):
    def _store(self, *, ttl_seconds: float = 3600.0, max_bytes: int = 0) -> DiskCacheStore:
        return DiskCacheStore(
            self.temp_dir / "cache",
            ttl_seconds=ttl_seconds,
            max_bytes=max_bytes,
        )

    def test_write_and_read_bytes_round_trip(self) -> None:
        store = self._store()
        path = store.write_bytes("alpha", b"hello", suffix=".bin")
        self.assertTrue(path.is_file())
        self.assertEqual(store.read_bytes("alpha", suffix=".bin"), b"hello")

    def test_get_path_updates_access_time_for_lru(self) -> None:
        store = self._store(max_bytes=10)
        store.write_bytes("older", b"12345", suffix=".bin")
        time.sleep(0.02)
        store.write_bytes("newer", b"12345", suffix=".bin")
        time.sleep(0.02)
        self.assertIsNotNone(store.get_path("older", suffix=".bin"))
        time.sleep(0.02)
        store.write_bytes("incoming", b"123", suffix=".bin")
        self.assertIsNotNone(store.get_path("older", suffix=".bin"))
        self.assertIsNone(store.get_path("newer", suffix=".bin"))

    def test_expired_entry_is_removed_on_read(self) -> None:
        store = self._store(ttl_seconds=0.01)
        store.write_bytes("expires", b"x", suffix=".bin")
        time.sleep(0.02)
        self.assertIsNone(store.read_bytes("expires", suffix=".bin"))

    def test_eviction_removes_oldest_accessed_entries_first(self) -> None:
        store = self._store(max_bytes=10)
        store.write_bytes("a", b"1234", suffix=".bin")
        time.sleep(0.01)
        store.write_bytes("b", b"1234", suffix=".bin")
        time.sleep(0.01)
        self.assertIsNotNone(store.get_path("a", suffix=".bin"))
        time.sleep(0.01)
        store.write_bytes("c", b"1234", suffix=".bin")
        self.assertIsNotNone(store.get_path("a", suffix=".bin"))
        self.assertIsNone(store.get_path("b", suffix=".bin"))
        self.assertIsNotNone(store.get_path("c", suffix=".bin"))


if __name__ == "__main__":
    unittest.main()