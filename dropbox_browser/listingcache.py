"""Disk-backed cache for Dropbox folder listings (rclone lsjson output).

Cache files live in Cache/ListingCache/<sha256(remote_path)>.json.
TTL is enforced strictly — an expired entry is treated as a miss.
The cache is invalidated immediately after a successful upload to a folder.
"""
from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

from .config import PROJECT_ROOT

CACHE_DIR = PROJECT_ROOT / "Cache" / "ListingCache"


class ListingCacheManager:
    def __init__(self, ttl_minutes: float = 30):
        self.ttl_seconds = ttl_minutes * 60
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
        self._cache_path(remote_path).write_text(json.dumps(data), encoding="utf-8")

    def invalidate(self, remote_path: str) -> None:
        """Delete the cached listing (e.g. after a successful upload)."""
        try:
            self._cache_path(remote_path).unlink(missing_ok=True)
        except Exception:
            pass
