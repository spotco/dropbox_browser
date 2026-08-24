"""Disk-backed cache for Dropbox folder listings (rclone lsjson output).

Cache files live in Cache/ListingCache/<sha256(remote_path)>.json.
TTL is enforced strictly — an expired entry is treated as a miss.
The cache is invalidated immediately after operations that can change a folder.
"""
from __future__ import annotations

import hashlib
import json
import math
import threading
import time
from pathlib import Path

from .cacheio import write_json_atomic
from .config import PROJECT_ROOT
from . import workertrace

CACHE_DIR = PROJECT_ROOT / "Cache" / "ListingCache"


def _same_or_child_path(path: str, root: str) -> bool:
    root = root.rstrip("/")
    if path == root:
        return True
    if root.endswith(":"):
        return path.startswith(root)
    return path.startswith(root + "/")


class ListingCacheManager:
    def __init__(self, ttl_seconds: float = 1800):
        self.ttl_seconds = ttl_seconds
        self._lock = threading.Lock()
        self._tree_invalidations: dict[str, float] = {}
        CACHE_DIR.mkdir(parents=True, exist_ok=True)

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

    def invalidate(self, remote_path: str) -> None:
        """Delete the cached listing after an operation changes a folder."""
        with self._lock:
            try:
                self._cache_path(remote_path).unlink(missing_ok=True)
            except Exception:
                pass

    def invalidate_tree(self, remote_path: str) -> list[str]:
        """Invalidate cached listings for a folder and known descendants."""
        invalidated_at = time.time()
        with self._lock:
            self._tree_invalidations[remote_path.rstrip("/")] = invalidated_at
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
