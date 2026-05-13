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
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .rclone import RcloneClient

from .cacheio import write_json_atomic
from .config import PROJECT_ROOT
from .formatting import parse_rclone_time
from .listingcache import ListingCacheManager
from .priorityqueue import PriorityQueue
from .rclone import RcloneCancelled, RcloneCancelToken

CACHE_DIR = PROJECT_ROOT / "Cache" / "FolderInfo"

# Folders are intentionally processed breadth-first within each page load.
# That discovers more direct child folders early, making the dispatched queue
# total settle faster in the UI.  Depth is capped so very deep paths share the
# same effective priority after this point.  Do not change this to DFS unless
# the progress strategy changes too.
BREADTH_FIRST_DEPTH_CAP = 3


@dataclass(order=True, frozen=True)
class FolderJob:
    """Queued folder-cache job.

    Keep the ordered priority fields generic. If other background job types are
    added later, they should use the same leading priority shape or a shared
    queue wrapper so mixed job types remain heap-comparable.
    """
    priority_page: float
    breadth_depth: int
    sort_path: str
    page_epoch: float = field(compare=False)
    remote_path: str = field(compare=False)
    job_type: str = field(default="folder", compare=False)

    @classmethod
    def create(cls, remote_path: str, page_epoch: float, breadth_depth: int) -> "FolderJob":
        return cls(-page_epoch, breadth_depth, remote_path, page_epoch, remote_path)


@dataclass
class ActiveFolderJob:
    remote_path: str
    page_epoch: float
    generation: int
    cancel_token: RcloneCancelToken


class FolderCacheManager:
    def __init__(self, rclone: "RcloneClient", workers: int, ttl_hours: float, listing_cache: ListingCacheManager | None = None):
        self.rclone = rclone
        self.ttl_seconds = ttl_hours * 3600
        self.listing_cache = listing_cache
        # FolderJob priority: (-page_time, breadth_depth, path)
        # Newer page_time → more-negative first element → dequeued first.
        # Within the same page_time, lower breadth_depth dequeues first on
        # purpose: this is breadth-first so the total queued work is discovered
        # quickly and progress counts become more accurate sooner.
        self._queue: PriorityQueue = PriorityQueue()
        self._lock = threading.Lock()

        # Maps path → best (most-recent) page_time we have queued for it.
        self._in_progress: dict[str, float] = {}
        # Paths whose direct lsjson call is currently running.  This is a
        # process-wide single-flight guard: only one worker may query a folder.
        self._active_jobs: dict[str, ActiveFolderJob] = {}
        # Tracks the newest page_time seen; workers skip items older than this.
        self._min_page_time: float = 0.0
        # Progress counters for the current page (reset when _min_page_time advances).
        self._page_dispatched: int = 0
        self._page_completed: int = 0
        self._acc: dict[str, dict] = {}
        # Maps path → page_time at which _compute last ran for it.
        # Used to avoid re-fetching a folder while its subtree is still being
        # accumulated in memory.
        self._direct_done: dict[str, float] = {}
        self._pending_children: dict[str, set[str]] = {}
        self._parent: dict[str, str] = {}
        self._child_contrib: dict[str, dict] = {}
        self._generation: dict[str, int] = {}
        self._abandoned: set[str] = set()
        self._reschedule_after_cancel: dict[str, float] = {}

        CACHE_DIR.mkdir(parents=True, exist_ok=True)
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

    def invalidate(self, remote_path: str) -> None:
        """Forget cached and in-memory metadata for one remote folder."""
        with self._lock:
            self._generation[remote_path] = self._generation.get(remote_path, 0) + 1
            self._acc.pop(remote_path, None)
            self._direct_done.pop(remote_path, None)
            self._pending_children.pop(remote_path, None)
            self._child_contrib.pop(remote_path, None)
            self._parent.pop(remote_path, None)
            self._abandoned.discard(remote_path)
            self._reschedule_after_cancel.pop(remote_path, None)
            for pending in self._pending_children.values():
                pending.discard(remote_path)
            stale_children = [child for child, parent in self._parent.items() if parent == remote_path]
            for child in stale_children:
                self._parent.pop(child, None)
        try:
            self._cache_path(remote_path).unlink(missing_ok=True)
        except Exception:
            pass

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
        write_json_atomic(self._cache_path(remote_path), data)

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
        """Start a new page epoch and cancel queued work from older pages."""
        removed = self._queue.remove_matching(
            lambda item: isinstance(item, FolderJob) and item.page_epoch < page_time
        )
        with self._lock:
            self._advance_page_time(page_time)
            for job in removed:
                self._cancel_queued_job(job)
            self._cancel_active_jobs_before(page_time)

    def _advance_page_time(self, page_time: float) -> None:
        """Update _min_page_time and reset progress counters.  Lock must be held."""
        if page_time > self._min_page_time:
            self._min_page_time = page_time
            self._page_dispatched = 0
            self._page_completed = 0

    def _cancel_queued_job(self, job: FolderJob) -> None:
        """Cancel a queued old-page job.  Lock must be held."""
        if job.remote_path not in self._active_jobs and self._in_progress.get(job.remote_path) == job.page_epoch:
            self._in_progress.pop(job.remote_path, None)
        self._mark_abandoned(job.remote_path)

    def _cancel_active_jobs_before(self, page_time: float) -> None:
        """Terminate active old-page background rclone calls.  Lock must be held."""
        for active in list(self._active_jobs.values()):
            if active.page_epoch >= page_time:
                continue
            self._generation[active.remote_path] = self._generation.get(active.remote_path, 0) + 1
            self._mark_abandoned(active.remote_path)
            active.cancel_token.cancel()

    def _mark_abandoned(self, path: str) -> None:
        """Mark this path and incomplete ancestors as partial/abandoned."""
        parent = self._parent.get(path)
        if parent is None:
            return
        pending = self._pending_children.get(parent)
        if pending is not None:
            pending.discard(path)
        self._abandoned.add(parent)
        if parent in self._acc:
            self._write_cache(parent, complete=False)
        self._mark_abandoned(parent)

    def current_progress(self) -> tuple[int, int]:
        """Return (completed, dispatched) counts for the current page."""
        with self._lock:
            return (self._page_completed, self._page_dispatched)

    def _record_dispatched(self, page_epoch: float) -> None:
        """Count dispatched work only for the active page epoch.  Lock must be held."""
        if page_epoch >= self._min_page_time:
            self._page_dispatched += 1

    def _record_completed(self, page_epoch: float) -> None:
        """Count completed work only for the active page epoch.  Lock must be held."""
        if page_epoch >= self._min_page_time:
            self._page_completed += 1

    def request(self, remote_path: str, page_time: float | None = None) -> None:
        """Enqueue a folder at depth 0 (page-level) for background computation."""
        if page_time is None:
            page_time = time.time()
        data = self.get(remote_path)
        if data is not None and data.get("complete"):
            return
        with self._lock:
            if remote_path in self._direct_done:
                # Its direct listing has already been fetched in this process.
                # If child work is still finishing, do not start a second
                # direct lsjson.  Abandoned folders were canceled on an older
                # page and must be allowed to restart cleanly.
                if self._pending_children.get(remote_path) and remote_path not in self._abandoned:
                    return
                self._abandoned.discard(remote_path)
                self._direct_done.pop(remote_path, None)
                self._pending_children.pop(remote_path, None)
                self._child_contrib.pop(remote_path, None)
            current_page_time = self._in_progress.get(remote_path)
            if current_page_time is not None:
                active = self._active_jobs.get(remote_path)
                if active is not None and active.cancel_token.cancelled:
                    previous = self._reschedule_after_cancel.get(remote_path, 0.0)
                    self._reschedule_after_cancel[remote_path] = max(previous, page_time)
                elif page_time > current_page_time:
                    self._in_progress[remote_path] = page_time
                return
            self._in_progress[remote_path] = page_time
            self._advance_page_time(page_time)
            self._record_dispatched(page_time)
        self._queue.put(FolderJob.create(remote_path, page_time, 0))

    # ------------------------------------------------------------------
    # Worker
    # ------------------------------------------------------------------

    def _worker(self) -> None:
        while True:
            job = self._queue.get()
            if not isinstance(job, FolderJob):
                self._queue.task_done()
                continue
            remote_path = job.remote_path
            page_epoch = job.page_epoch
            claimed_active = False
            clear_in_progress = False
            force_clear_in_progress = False
            cancel_token: RcloneCancelToken | None = None
            try:
                with self._lock:
                    owner_page_time = self._in_progress.get(remote_path)
                    if owner_page_time is None:
                        continue
                    effective_page_time = max(page_epoch, owner_page_time)
                    stale = effective_page_time < self._min_page_time
                    already_done = self._direct_done.get(remote_path, 0.0) >= effective_page_time
                    if not stale and not already_done:
                        if remote_path in self._active_jobs:
                            continue
                        generation = self._generation.get(remote_path, 0)
                        cancel_token = RcloneCancelToken()
                        self._active_jobs[remote_path] = ActiveFolderJob(
                            remote_path,
                            effective_page_time,
                            generation,
                            cancel_token,
                        )
                        claimed_active = True
                if stale:
                    clear_in_progress = True
                    force_clear_in_progress = True
                    with self._lock:
                        self._cancel_queued_job(job)
                    continue
                if already_done:
                    clear_in_progress = True
                    with self._lock:
                        self._record_completed(effective_page_time)
                    continue
                assert cancel_token is not None
                if self._compute(remote_path, effective_page_time, job.breadth_depth, generation, cancel_token):
                    clear_in_progress = True
                    with self._lock:
                        self._record_completed(effective_page_time)
                else:
                    force_clear_in_progress = True
                    with self._lock:
                        self._record_completed(effective_page_time)
                clear_in_progress = True
            except RcloneCancelled:
                clear_in_progress = True
                force_clear_in_progress = True
                with self._lock:
                    self._mark_abandoned(remote_path)
                    self._record_completed(page_epoch)
            except Exception:
                clear_in_progress = True
                # On failure treat as empty so the parent tree can still complete.
                with self._lock:
                    if claimed_active and self._generation.get(remote_path, 0) != generation:
                        force_clear_in_progress = True
                        self._record_completed(page_epoch)
                        continue
                    latest_page_time = max(page_epoch, self._in_progress.get(remote_path, page_epoch))
                    if remote_path not in self._acc:
                        self._acc[remote_path] = {"size": 0, "count": 0, "mtime": None}
                    self._direct_done[remote_path] = latest_page_time
                    self._pending_children.setdefault(remote_path, set())
                    self._write_cache(remote_path, complete=True)
                    self._propagate(remote_path)
                    self._on_subtree_complete(remote_path)
                    self._record_completed(latest_page_time)
            finally:
                reschedule_epoch: float | None = None
                with self._lock:
                    if claimed_active:
                        self._active_jobs.pop(remote_path, None)
                    if clear_in_progress and (
                        force_clear_in_progress
                        or self._direct_done.get(remote_path, 0.0) >= self._in_progress.get(remote_path, 0.0)
                    ):
                        self._in_progress.pop(remote_path, None)
                    if remote_path not in self._in_progress and remote_path in self._reschedule_after_cancel:
                        reschedule_epoch = self._reschedule_after_cancel.pop(remote_path)
                        self._abandoned.discard(remote_path)
                        self._direct_done.pop(remote_path, None)
                        self._pending_children.pop(remote_path, None)
                        self._child_contrib.pop(remote_path, None)
                        self._in_progress[remote_path] = reschedule_epoch
                        self._record_dispatched(reschedule_epoch)
                self._queue.task_done()
                if reschedule_epoch is not None:
                    self._queue.put(FolderJob.create(remote_path, reschedule_epoch, job.breadth_depth))

    def _compute(
        self,
        remote_path: str,
        page_time: float,
        breadth_depth: int,
        generation: int,
        cancel_token: RcloneCancelToken,
    ) -> bool:
        """Fetch direct children via lsjson (or listing cache), update state, queue subfolders."""
        items = None
        if self.listing_cache:
            items = self.listing_cache.get(remote_path)
        if items is None:
            proc = self.rclone.run("lsjson", "--", remote_path, cancel_token=cancel_token)
            if proc.returncode == 0 and proc.stdout.strip():
                try:
                    items = json.loads(proc.stdout.decode("utf-8"))
                    if self.listing_cache:
                        self.listing_cache.set(remote_path, items)
                except Exception:
                    items = []
            else:
                items = []

        direct_size = 0
        direct_count = 0
        direct_mtime: float | None = None
        subfolders: list[str] = []

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

        # Read cached data for subfolders *before* acquiring the lock.
        sf_cached: dict[str, dict | None] = {sf: self.get(sf) for sf in subfolders}

        with self._lock:
            if self._generation.get(remote_path, 0) != generation:
                return False
            page_time = max(page_time, self._in_progress.get(remote_path, page_time))
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
                    if sf in self._direct_done and not self._pending_children.get(sf):
                        self._direct_done.pop(sf, None)
                    if page_time < self._min_page_time:
                        self._mark_abandoned(sf)
                    elif sf not in self._direct_done and sf not in self._in_progress:
                        child_depth = min(breadth_depth + 1, BREADTH_FIRST_DEPTH_CAP)
                        self._in_progress[sf] = page_time
                        self._record_dispatched(page_time)
                        self._queue.put(FolderJob.create(sf, page_time, child_depth))

            if complete:
                self._on_subtree_complete(remote_path)
        return True

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
            and parent not in self._abandoned
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
            if parent in self._abandoned:
                self._write_cache(parent, complete=False)
                return
            self._write_cache(parent, complete=True)
            self._on_subtree_complete(parent)
