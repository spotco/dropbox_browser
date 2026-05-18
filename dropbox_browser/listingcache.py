"""Disk-backed cache for Dropbox folder listings (rclone lsjson output).

Cache files live in Cache/ListingCache/<sha256(remote_path)>.json.
TTL is enforced strictly — an expired entry is treated as a miss.
The cache is invalidated immediately after operations that can change a folder.
"""
from __future__ import annotations

import hashlib
import json
import threading
import time
from pathlib import Path

from .cacheio import write_json_atomic
from .config import PROJECT_ROOT

CACHE_DIR = PROJECT_ROOT / "Cache" / "ListingCache"


class ListingCacheManager:
    def __init__(self, ttl_seconds: float = 1800):
        self.ttl_seconds = ttl_seconds
        self._lock = threading.Lock()
        CACHE_DIR.mkdir(parents=True, exist_ok=True)

    def _cache_path(self, remote_path: str) -> Path:
        key = hashlib.sha256(remote_path.encode()).hexdigest()
        return CACHE_DIR / f"{key}.json"

    def get(self, remote_path: str) -> list[dict] | None:
        """Return cached lsjson items, or None if missing or expired."""
        p = self._cache_path(remote_path)
        if not p.exists():
            return None
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            if time.time() - data.get("cached_at", 0) > self.ttl_seconds:
                return None
            return data["items"]
        except Exception:
            return None

    def set(self, remote_path: str, items: list[dict]) -> None:
        """Write items to cache."""
        data = {"remote_path": remote_path, "items": items, "cached_at": time.time()}
        with self._lock:
            write_json_atomic(self._cache_path(remote_path), data)

    def invalidate(self, remote_path: str) -> None:
        """Delete the cached listing after an operation changes a folder."""
        with self._lock:
            try:
                self._cache_path(remote_path).unlink(missing_ok=True)
            except Exception:
                pass

    def invalidate_tree(self, remote_path: str) -> list[str]:
        """Delete cached listings for a folder and known descendants."""
        prefix = remote_path.rstrip("/") + "/"
        paths = {remote_path}
        with self._lock:
            for cache_file in list(CACHE_DIR.glob("*.json")):
                try:
                    data = json.loads(cache_file.read_text(encoding="utf-8"))
                except Exception:
                    continue
                cached_path = data.get("remote_path")
                if isinstance(cached_path, str) and (cached_path == remote_path or cached_path.startswith(prefix)):
                    paths.add(cached_path)
            for path in paths:
                try:
                    self._cache_path(path).unlink(missing_ok=True)
                except Exception:
                    pass
        return sorted(paths, key=str.casefold)
