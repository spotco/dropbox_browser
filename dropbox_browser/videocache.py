"""Disk-backed cache stores with TTL and LRU byte-cap eviction."""
from __future__ import annotations

import heapq
import json
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .cacheio import write_json_atomic


@dataclass
class _CacheEntry:
    key: str
    rel_path: str
    size_bytes: int
    cached_at: float
    accessed_at: float


class DiskCacheStore:
    """Filesystem cache with per-entry TTL and oldest-accessed eviction."""

    def __init__(self, root_dir: Path, *, ttl_seconds: float, max_bytes: int) -> None:
        self.root_dir = root_dir
        self.ttl_seconds = max(0.0, float(ttl_seconds))
        self.max_bytes = max(0, int(max_bytes))
        self._lock = threading.Lock()
        self._manifest_path = root_dir / "manifest.json"
        self._files_dir = root_dir / "files"
        self._entries: dict[str, _CacheEntry] = {}
        self.root_dir.mkdir(parents=True, exist_ok=True)
        self._files_dir.mkdir(parents=True, exist_ok=True)
        self._load_manifest()

    @property
    def total_bytes(self) -> int:
        with self._lock:
            return sum(entry.size_bytes for entry in self._entries.values())

    def entry_path(self, cache_key: str, *, suffix: str = "") -> Path:
        filename = cache_key + suffix
        return self._files_dir / filename

    def get_path(self, cache_key: str, *, suffix: str = "") -> Path | None:
        with self._lock:
            entry = self._entries.get(cache_key)
            if entry is None:
                return None
            if self._is_expired(entry):
                self._remove_entry_locked(cache_key)
                return None
            path = self.root_dir / entry.rel_path
            if not path.is_file():
                self._remove_entry_locked(cache_key)
                return None
            entry.accessed_at = time.time()
            self._save_manifest_locked()
            return path

    def read_bytes(self, cache_key: str, *, suffix: str = "") -> bytes | None:
        path = self.get_path(cache_key, suffix=suffix)
        if path is None:
            return None
        try:
            return path.read_bytes()
        except OSError:
            with self._lock:
                self._remove_entry_locked(cache_key)
            return None

    def read_json(self, cache_key: str, *, suffix: str = ".json") -> Any | None:
        path = self.get_path(cache_key, suffix=suffix)
        if path is None:
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            with self._lock:
                self._remove_entry_locked(cache_key)
            return None

    def write_bytes(self, cache_key: str, body: bytes, *, suffix: str = "") -> Path:
        rel_path = f"files/{cache_key}{suffix}"
        path = self.root_dir / rel_path
        path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = path.with_suffix(path.suffix + ".tmp")
        temp_path.write_bytes(body)
        temp_path.replace(path)
        now = time.time()
        with self._lock:
            self._remove_entry_locked(cache_key)
            self._evict_for_size_locked(len(body))
            self._entries[cache_key] = _CacheEntry(
                key=cache_key,
                rel_path=rel_path,
                size_bytes=len(body),
                cached_at=now,
                accessed_at=now,
            )
            self._save_manifest_locked()
        return path

    def write_json(self, cache_key: str, payload: Any, *, suffix: str = ".json") -> Path:
        encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
        return self.write_bytes(cache_key, encoded, suffix=suffix)

    def remove(self, cache_key: str) -> None:
        with self._lock:
            self._remove_entry_locked(cache_key)
            self._save_manifest_locked()

    def clear(self) -> None:
        with self._lock:
            keys = list(self._entries)
            for cache_key in keys:
                self._remove_entry_locked(cache_key)
            self._save_manifest_locked()

    def _is_expired(self, entry: _CacheEntry) -> bool:
        if self.ttl_seconds <= 0:
            return False
        return time.time() - entry.cached_at > self.ttl_seconds

    def _load_manifest(self) -> None:
        if not self._manifest_path.is_file():
            return
        try:
            data = json.loads(self._manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        entries = data.get("entries")
        if not isinstance(entries, dict):
            return
        loaded: dict[str, _CacheEntry] = {}
        for key, row in entries.items():
            if not isinstance(key, str) or not isinstance(row, dict):
                continue
            rel_path = row.get("rel_path")
            if not isinstance(rel_path, str):
                continue
            try:
                loaded[key] = _CacheEntry(
                    key=key,
                    rel_path=rel_path,
                    size_bytes=int(row.get("size_bytes") or 0),
                    cached_at=float(row.get("cached_at") or 0),
                    accessed_at=float(row.get("accessed_at") or 0),
                )
            except (TypeError, ValueError):
                continue
        with self._lock:
            self._entries = loaded
            self._prune_invalid_locked()

    def _save_manifest_locked(self) -> None:
        payload = {
            "entries": {
                key: {
                    "rel_path": entry.rel_path,
                    "size_bytes": entry.size_bytes,
                    "cached_at": entry.cached_at,
                    "accessed_at": entry.accessed_at,
                }
                for key, entry in self._entries.items()
            }
        }
        write_json_atomic(self._manifest_path, payload)

    def _prune_invalid_locked(self) -> None:
        for cache_key in list(self._entries):
            entry = self._entries[cache_key]
            path = self.root_dir / entry.rel_path
            if self._is_expired(entry) or not path.is_file():
                self._remove_entry_locked(cache_key)

    def _remove_entry_locked(self, cache_key: str) -> None:
        entry = self._entries.pop(cache_key, None)
        if entry is None:
            return
        try:
            (self.root_dir / entry.rel_path).unlink(missing_ok=True)
        except OSError:
            pass

    def _evict_for_size_locked(self, incoming_bytes: int) -> None:
        if self.max_bytes <= 0:
            return
        self._prune_invalid_locked()
        total = sum(entry.size_bytes for entry in self._entries.values())
        if total + incoming_bytes <= self.max_bytes:
            return
        heap: list[tuple[float, float, str]] = []
        for cache_key, entry in self._entries.items():
            heapq.heappush(heap, (entry.accessed_at, entry.cached_at, cache_key))
        while heap and total + incoming_bytes > self.max_bytes:
            _, _, cache_key = heapq.heappop(heap)
            if cache_key not in self._entries:
                continue
            removed = self._entries[cache_key]
            total -= removed.size_bytes
            self._remove_entry_locked(cache_key)