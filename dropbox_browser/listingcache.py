"""Disk-backed cache for Dropbox folder listings (rclone lsjson output).

Cache files live in Cache/ListingCache/<sha256(remote_path)>.json.
TTL is enforced strictly — an expired entry is treated as a miss.
The cache is invalidated immediately after operations that can change a folder.

Separately, the manager keeps a small in-memory "last good" copy of each
recently seen listing.  It survives invalidation and TTL expiry so a page load
whose live ``rclone lsjson`` fails (for example Dropbox throttling right after
an upload) can show the previous listing marked as stale instead of nothing.
It is never returned by ``get()`` and never treated as fresh.
"""
from __future__ import annotations

import hashlib
import json
import math
import threading
import time
from collections import OrderedDict
from pathlib import Path

from .cacheio import write_json_atomic
from .config import PROJECT_ROOT
from . import workertrace

CACHE_DIR = PROJECT_ROOT / "Cache" / "ListingCache"
LAST_GOOD_LIMIT = 256


def _same_or_child_path(path: str, root: str) -> bool:
    root = root.rstrip("/")
    if path == root:
        return True
    if root.endswith(":"):
        return path.startswith(root)
    return path.startswith(root + "/")


class ListingCacheManager:
    def __init__(self, ttl_seconds: float = 1800, last_good_limit: int = LAST_GOOD_LIMIT):
        self.ttl_seconds = ttl_seconds
        self._lock = threading.Lock()
        self._tree_invalidations: dict[str, float] = {}
        self._last_good_limit = max(0, int(last_good_limit))
        self._last_good_lock = threading.Lock()
        # remote_path -> (items, cached_at); most recently used last.
        self._last_good: OrderedDict[str, tuple[list[dict], float]] = OrderedDict()
        CACHE_DIR.mkdir(parents=True, exist_ok=True)

    def _remember_last_good(self, remote_path: str, items: object, cached_at: float) -> None:
        if self._last_good_limit <= 0 or not isinstance(items, list):
            return
        with self._last_good_lock:
            previous = self._last_good.get(remote_path)
            if previous is not None and previous[1] > cached_at:
                self._last_good.move_to_end(remote_path)
                return
            self._last_good[remote_path] = (items, cached_at)
            self._last_good.move_to_end(remote_path)
            while len(self._last_good) > self._last_good_limit:
                self._last_good.popitem(last=False)

    def _remember_last_good_from_disk(self, remote_path: str) -> None:
        try:
            data = json.loads(self._cache_path(remote_path).read_text(encoding="utf-8"))
        except Exception:
            return
        if isinstance(data, dict) and data.get("remote_path", remote_path) == remote_path:
            self._remember_last_good(remote_path, data.get("items"), float(data.get("cached_at", 0) or 0))

    def get_last_good(self, remote_path: str) -> tuple[list[dict], float] | None:
        """Return ``(items, cached_at)`` of the last successful listing, if known.

        This ignores TTL and invalidation on purpose: it is only for showing a
        clearly-labelled stale fallback when a live listing fails.
        """
        with self._last_good_lock:
            entry = self._last_good.get(remote_path)
        if entry is None:
            p = self._cache_path(remote_path)
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                return None
            items = data.get("items") if isinstance(data, dict) else None
            if not isinstance(items, list) or data.get("remote_path", remote_path) != remote_path:
                return None
            entry = (items, float(data.get("cached_at", 0) or 0))
        items, cached_at = entry
        return [dict(item) if isinstance(item, dict) else item for item in items], cached_at

    def _cache_path(self, remote_path: str) -> Path:
        key = hashlib.sha256(remote_path.encode()).hexdigest()
        return CACHE_DIR / f"{key}.json"

    def get(self, remote_path: str) -> list[dict] | None:
        """Return cached lsjson items, or None if missing or expired."""
        started = time.perf_counter()
        p = self._cache_path(remote_path)
        if not p.exists():
            return None
        result: list[dict] | None = None
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            invalidated_at = self._tree_invalidated_at(remote_path)
            if invalidated_at is not None and data.get("cached_at", 0) <= invalidated_at:
                return None
            if time.time() - data.get("cached_at", 0) > self.ttl_seconds:
                return None
            result = data["items"]
            self._remember_last_good(remote_path, result, float(data.get("cached_at", 0) or 0))
            return result
        except Exception:
            return None
        finally:
            elapsed_ms = round((time.perf_counter() - started) * 1000, 3)
            if elapsed_ms >= workertrace.SLOW_OPERATION_THRESHOLD_MS:
                file_size = None
                try:
                    file_size = p.stat().st_size
                except OSError:
                    file_size = None
                workertrace.record_diagnostic(
                    "slow_listing_cache_read",
                    remote_path=remote_path,
                    cache_path=str(p),
                    elapsed_ms=elapsed_ms,
                    hit=result is not None,
                    file_size=file_size,
                )

    def set(self, remote_path: str, items: list[dict]) -> None:
        """Write items to cache."""
        with self._lock:
            cached_at = time.time()
            invalidated_at = self._tree_invalidated_at_locked(remote_path)
            if invalidated_at is not None and cached_at <= invalidated_at:
                cached_at = math.nextafter(invalidated_at, math.inf)
            data = {"remote_path": remote_path, "items": items, "cached_at": cached_at}
            write_json_atomic(self._cache_path(remote_path), data)
        self._remember_last_good(remote_path, items, cached_at)

    def invalidate(self, remote_path: str) -> None:
        """Delete the cached listing after an operation changes a folder."""
        with self._lock:
            self._remember_last_good_from_disk(remote_path)
            try:
                self._cache_path(remote_path).unlink(missing_ok=True)
            except Exception:
                pass

    def invalidate_tree(self, remote_path: str) -> list[str]:
        """Invalidate cached listings for a folder and known descendants."""
        invalidated_at = time.time()
        with self._lock:
            self._tree_invalidations[remote_path.rstrip("/")] = invalidated_at
            self._remember_last_good_from_disk(remote_path)
            try:
                self._cache_path(remote_path).unlink(missing_ok=True)
            except Exception:
                pass
        self._start_tree_cleanup(remote_path, invalidated_at)
        return [remote_path]

    def _tree_invalidated_at(self, remote_path: str) -> float | None:
        with self._lock:
            return self._tree_invalidated_at_locked(remote_path)

    def _tree_invalidated_at_locked(self, remote_path: str) -> float | None:
        invalidated_at: float | None = None
        for root, cutoff in self._tree_invalidations.items():
            if _same_or_child_path(remote_path, root):
                invalidated_at = cutoff if invalidated_at is None else max(invalidated_at, cutoff)
        return invalidated_at

    def _start_tree_cleanup(self, remote_path: str, invalidated_at: float) -> None:
        thread = threading.Thread(
            target=self._cleanup_tree,
            args=(remote_path, invalidated_at),
            daemon=True,
            name="listing-cache-cleanup",
        )
        thread.start()

    def _cleanup_tree(self, remote_path: str, invalidated_at: float) -> None:
        # Hold the same lock as set() while inspecting and deleting entries.
        # Otherwise cleanup can read an old record, set() can atomically write a
        # fresh record, and cleanup can then unlink that fresh record by path.
        with self._lock:
            for cache_file in list(CACHE_DIR.glob("*.json")):
                try:
                    data = json.loads(cache_file.read_text(encoding="utf-8"))
                except Exception:
                    continue
                cached_path = data.get("remote_path")
                cached_at = data.get("cached_at", 0)
                if (
                    isinstance(cached_path, str)
                    and _same_or_child_path(cached_path, remote_path)
                    and cached_at <= invalidated_at
                ):
                    try:
                        cache_file.unlink(missing_ok=True)
                    except Exception:
                        pass
