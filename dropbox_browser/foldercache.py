"""Background folder metadata cache (recursive size, file count, newest mtime).

Each folder is fetched non-recursively (one rclone lsjson call per folder).
Results are accumulated upward: as each subfolder's direct-children fetch
completes, its totals are propagated to its parent.  The displayed numbers
grow in real time until the full subtree is done.

State machine per folder path
------------------------------
  _acc[path]              running accumulated totals (size, count, mtime)
  _direct_done            set of paths whose own lsjson has been parsed
  _pending_children[path] direct subfolders not yet fully computed
  _parent[path]           the path that triggered this folder's computation
  _child_contrib[path]    last totals sent upward to the parent

Cache files
-----------
  Cache/<sha256>.json  — written after every change; includes ``complete``
  flag.  TTL is only enforced for complete entries so partial results from a
  previous run are shown while re-computation happens.
"""
from __future__ import annotations

import hashlib
import json
import queue
import threading
import time
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .rclone import RcloneClient

from .config import PROJECT_ROOT
from .formatting import parse_rclone_time

CACHE_DIR = PROJECT_ROOT / "Cache"


class FolderCacheManager:
    def __init__(self, rclone: "RcloneClient", workers: int, ttl_hours: float):
        self.rclone = rclone
        self.ttl_seconds = ttl_hours * 3600
        # Priority is -page_time so that a newer page load (larger unix time)
        # produces a more-negative value and is therefore dequeued first.
        # Tuple: (-page_time, remote_path, page_time)
        self._queue: queue.PriorityQueue[tuple[float, str, float]] = queue.PriorityQueue()
        self._lock = threading.Lock()

        # Maps path → best (most-recent) page_time we have queued for it.
        # Used to avoid re-queuing at equal or stale priority.
        self._in_progress: dict[str, float] = {}
        # Tracks the newest page_time seen; workers skip items older than this.
        self._min_page_time: float = 0.0
        self._acc: dict[str, dict] = {}
        # Maps path → page_time at which _compute last ran for it.
        # Used to deduplicate duplicate queue entries for the same page_time
        # while still allowing re-computation when a newer page_time arrives.
        self._direct_done: dict[str, float] = {}
        self._pending_children: dict[str, set[str]] = {}
        self._parent: dict[str, str] = {}
        self._child_contrib: dict[str, dict] = {}

        CACHE_DIR.mkdir(exist_ok=True)
        for _ in range(max(1, workers)):
            t = threading.Thread(target=self._worker, daemon=True)
            t.start()

    # ------------------------------------------------------------------
    # Cache file helpers
    # ------------------------------------------------------------------

    def _cache_path(self, remote_path: str) -> Path:
        key = hashlib.sha256(remote_path.encode()).hexdigest()
        return CACHE_DIR / f"{key}.json"

    def get(self, remote_path: str) -> dict | None:
        """Return cached data (partial or complete), or None if unavailable.

        TTL is only enforced for *complete* entries; partial results from a
        prior run are returned as-is so the UI can show them while re-computing.
        """
        p = self._cache_path(remote_path)
        if not p.exists():
            return None
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            if data.get("complete") and time.time() - data.get("cached_at", 0) > self.ttl_seconds:
                return None
            return data
        except Exception:
            return None

    def _write_cache(self, remote_path: str, complete: bool) -> None:
        """Flush current accumulated state to disk.  Lock must be held."""
        acc = self._acc.get(remote_path, {})
        data = {
            "remote_path": remote_path,
            "size": acc.get("size", 0),
            "file_count": acc.get("count", 0),
            "newest_mtime": acc.get("mtime"),
            "complete": complete,
            "cached_at": time.time(),
        }
        self._cache_path(remote_path).write_text(json.dumps(data), encoding="utf-8")

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def status(self, remote_path: str) -> str:
        """Return 'complete', 'partial', 'calculating', or 'pending'."""
        data = self.get(remote_path)
        if data is not None:
            return "complete" if data.get("complete") else "partial"
        with self._lock:
            if remote_path in self._in_progress:
                return "calculating"
        return "pending"

    def notify_page_load(self, page_time: float) -> None:
        """Advance _min_page_time for pages that have no folder entries.

        request() updates _min_page_time when it is called, but a page
        consisting entirely of files never calls request().  This ensures
        old background work is still cancelled when navigating to such a page.
        """
        with self._lock:
            if page_time > self._min_page_time:
                self._min_page_time = page_time

    def request(self, remote_path: str, page_time: float | None = None) -> None:
        """Enqueue a folder for background computation at the given page timestamp.

        Newer page loads get a more-negative priority value and are therefore
        dequeued before older queued items at the same integer priority.
        Always re-inserts when page_time is newer than whatever is already
        queued, ensuring navigation to a new page immediately outranks stale
        background work from a previous page.
        """
        if page_time is None:
            page_time = time.time()
        data = self.get(remote_path)
        if data is not None and data.get("complete"):
            return
        with self._lock:
            if self._in_progress.get(remote_path, 0.0) >= page_time:
                return  # already queued at equal or better priority
            self._in_progress[remote_path] = page_time
            if page_time > self._min_page_time:
                self._min_page_time = page_time
        self._queue.put((-page_time, remote_path, page_time))

    # ------------------------------------------------------------------
    # Worker
    # ------------------------------------------------------------------

    def _worker(self) -> None:
        while True:
            _priority, remote_path, page_time = self._queue.get()
            try:
                with self._lock:
                    stale = page_time < self._min_page_time
                    already_done = self._direct_done.get(remote_path, 0.0) >= page_time
                if stale or already_done:
                    continue
                self._compute(remote_path, page_time)
            except Exception:
                # On failure treat as empty so the parent tree can still complete.
                with self._lock:
                    if remote_path not in self._acc:
                        self._acc[remote_path] = {"size": 0, "count": 0, "mtime": None}
                    self._direct_done[remote_path] = page_time
                    self._pending_children.setdefault(remote_path, set())
                    self._write_cache(remote_path, complete=True)
                    self._propagate(remote_path)
                    self._on_subtree_complete(remote_path)
            finally:
                with self._lock:
                    self._in_progress.pop(remote_path, None)
                self._queue.task_done()

    def _compute(self, remote_path: str, page_time: float) -> None:
        """Fetch direct children via lsjson, update state, queue subfolders."""
        proc = self.rclone.run("lsjson", "--", remote_path)

        direct_size = 0
        direct_count = 0
        direct_mtime: float | None = None
        subfolders: list[str] = []

        if proc.returncode == 0 and proc.stdout.strip():
            try:
                items = json.loads(proc.stdout.decode("utf-8"))
                for item in items:
                    t = parse_rclone_time(item.get("ModTime"))
                    if t and (direct_mtime is None or t > direct_mtime):
                        direct_mtime = t
                    if item.get("IsDir"):
                        sf_name = item.get("Path") or item.get("Name", "")
                        if sf_name:
                            subfolders.append(remote_path.rstrip("/") + "/" + sf_name)
                    else:
                        sz = item.get("Size") or 0
                        if sz > 0:
                            direct_size += sz
                        direct_count += 1
            except Exception:
                pass

        # Read cached data for subfolders *before* acquiring the lock.
        sf_cached: dict[str, dict | None] = {sf: self.get(sf) for sf in subfolders}

        with self._lock:
            # Initialise (or reset) accumulated state from direct-file stats.
            self._acc[remote_path] = {"size": direct_size, "count": direct_count, "mtime": direct_mtime}
            self._direct_done[remote_path] = page_time
            self._pending_children[remote_path] = set()

            complete = len(subfolders) == 0
            self._write_cache(remote_path, complete=complete)
            self._propagate(remote_path)

            # Register and (if needed) queue each subfolder.
            for sf in subfolders:
                self._parent[sf] = remote_path
                # Clear stale contribution so re-compute deltas start from zero.
                self._child_contrib.pop(sf, None)
                cached = sf_cached[sf]
                if sf not in self._in_progress and cached is not None and cached.get("complete"):
                    # Reuse existing complete cache — incorporate immediately.
                    self._acc[sf] = {
                        "size": cached.get("size") or 0,
                        "count": cached.get("file_count") or 0,
                        "mtime": cached.get("newest_mtime"),
                    }
                    self._direct_done[sf] = page_time
                    self._pending_children.setdefault(sf, set())
                    self._propagate(sf)
                    # sf is already fully done — do not add to pending_children.
                    self._on_subtree_complete(sf)
                else:
                    self._pending_children[remote_path].add(sf)
                    if self._direct_done.get(sf, 0.0) < page_time and self._in_progress.get(sf, 0.0) < page_time:
                        self._in_progress[sf] = page_time
                        self._queue.put((-page_time, sf, page_time))

            if complete:
                self._on_subtree_complete(remote_path)

    # ------------------------------------------------------------------
    # Propagation helpers  (all require lock to be held)
    # ------------------------------------------------------------------

    def _propagate(self, path: str) -> None:
        """Push this path's accumulated delta to its parent and recurse up."""
        parent = self._parent.get(path)
        if parent is None or parent not in self._acc:
            return

        old = self._child_contrib.get(path, {"size": 0, "count": 0, "mtime": None})
        new = self._acc[path]

        delta_size = new["size"] - old["size"]
        delta_count = new["count"] - old["count"]

        # Nothing changed — no need to propagate.
        if delta_size == 0 and delta_count == 0 and new["mtime"] == old["mtime"]:
            return

        self._child_contrib[path] = {"size": new["size"], "count": new["count"], "mtime": new["mtime"]}

        pacc = self._acc[parent]
        pacc["size"] += delta_size
        pacc["count"] += delta_count
        if new["mtime"] is not None and (pacc["mtime"] is None or new["mtime"] > pacc["mtime"]):
            pacc["mtime"] = new["mtime"]

        parent_complete = (
            parent in self._direct_done
            and not self._pending_children.get(parent)
        )
        self._write_cache(parent, complete=parent_complete)
        self._propagate(parent)

    def _on_subtree_complete(self, path: str) -> None:
        """Mark this path's subtree done; propagate completeness upward."""
        parent = self._parent.get(path)
        if parent is None:
            return
        pc = self._pending_children.get(parent)
        if pc is None:
            return
        pc.discard(path)
        if parent in self._direct_done and not pc:
            self._write_cache(parent, complete=True)
            self._on_subtree_complete(parent)
