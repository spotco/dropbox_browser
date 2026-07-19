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
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .rclone import RcloneClient

from .cacheio import write_json_atomic
from .config import PROJECT_ROOT
from .foldercache_records import DIFF_CACHE_SCHEMA_VERSION, build_cache_record, validate_cache_record
from .foldercache_state import FolderAccumulationState
from .folderdiff import (
    DIFF_DROPBOX_ONLY,
    DIFF_HAS_DIFFS,
    DIFF_LOADING,
    DIFF_SYNCED,
    DIFF_UNAVAILABLE,
    compare_direct_children,
    enumerate_local_children,
)
from .foldercache_compute import parse_direct_listing
from .listingcache import ListingCacheManager
from .priorityqueue import PriorityQueue
from .rclone import RcloneCancelled, RcloneCancelToken
from .windows_names import resolve_matching_local_path
from . import workertrace

CACHE_DIR = PROJECT_ROOT / "Cache" / "FolderInfo"

# Folders are intentionally processed breadth-first within each page load.
# That discovers more direct child folders early, making the dispatched queue
# total settle faster in the UI.  Depth is capped so very deep paths share the
# same effective priority after this point.  Do not change this to DFS unless
# the progress strategy changes too.
BREADTH_FIRST_DEPTH_CAP = 3


def _same_or_child_path(path: str, root: str) -> bool:
    root = root.rstrip("/")
    if path == root:
        return True
    if root.endswith(":"):
        return path.startswith(root)
    return path.startswith(root + "/")


@dataclass(order=True, frozen=True)
class FolderJob:
    """Queued folder-cache job.

    Keep the ordered priority fields generic. If other background job types are
    added later, they should use the same leading priority shape or a shared
    queue wrapper so mixed job types remain heap-comparable.
    """
    priority_page: float
    breadth_depth: int
    job_priority: int
    sort_path: str
    page_epoch: float = field(compare=False)
    remote_path: str = field(compare=False)
    job_type: str = field(default="folder", compare=False)

    @classmethod
    def create(cls, remote_path: str, page_epoch: float, breadth_depth: int) -> "FolderJob":
        return cls(-page_epoch, breadth_depth, 0, remote_path, page_epoch, remote_path)


@dataclass(order=True, frozen=True)
class FolderShutdownJob:
    priority_page: float = 0.0
    breadth_depth: int = 0
    job_priority: int = 1
    sort_path: str = ""


@dataclass
class ActiveFolderJob:
    remote_path: str
    page_epoch: float
    generation: int
    cancel_token: RcloneCancelToken


class FolderCacheManager:
    supports_record_lookup = True

    def __init__(
        self,
        rclone: "RcloneClient",
        workers: int,
        ttl_seconds: float,
        listing_cache: ListingCacheManager | None = None,
        local_root: Path | None = None,
        remote: str | None = None,
    ):
        self.rclone = rclone
        self.ttl_seconds = ttl_seconds
        self.listing_cache = listing_cache
        self.local_root = local_root.resolve() if local_root else None
        self.remote = (remote or "").rstrip("/")
        # FolderJob priority: (-page_time, breadth_depth, path)
        # Newer page_time → more-negative first element → dequeued first.
        # Within the same page_time, lower breadth_depth dequeues first on
        # purpose: this is breadth-first so the total queued work is discovered
        # quickly and progress counts become more accurate sooner.
        self._queue: PriorityQueue = PriorityQueue()
        self._lock = threading.RLock()

        # Maps path → best (most-recent) page_time we have queued for it.
        self._in_progress: dict[str, float] = {}
        # Paths whose direct lsjson call is currently running.  This is a
        # process-wide single-flight guard: only one worker may query a folder.
        self._active_jobs: dict[str, ActiveFolderJob] = {}
        # Tracks the newest page_time seen. New page loads advance this cheaply;
        # stale queued jobs are skipped lazily by workers instead of being
        # removed on the HTTP request path.
        self._min_page_time: float = 0.0
        self._current_page_key: str | None = None
        # Progress counters for the current page (reset when _min_page_time advances).
        self._page_dispatched: int = 0
        self._page_completed: int = 0
        # Maps path → page_time at which _compute last ran for it.
        # Used to avoid re-fetching a folder while its subtree is still being
        # accumulated in memory.
        self._direct_done: dict[str, float] = {}
        self._generation: dict[str, int] = {}
        self._abandoned: set[str] = set()
        self._progress_by_epoch: dict[float, dict[str, int]] = {}
        # path → (write_as_complete, write_epoch). Epoch advances on every dirty
        # mark so a deferred flush can detect that a newer in-memory state exists
        # and must not clobber disk with a stale partial snapshot.
        self._dirty_cache_writes: dict[str, tuple[bool, int]] = {}
        self._cache_write_epoch: dict[str, int] = {}
        # In-process signal for recursive media snapshots. It is deliberately
        # not persisted because a restart can safely rebuild snapshots.
        self._revision = 0
        self._state = FolderAccumulationState(
            direct_done=self._direct_done,
            abandoned=self._abandoned,
            write_cache=self._mark_cache_dirty_locked,
            note_diff=self._note_diff,
            maybe_complete=self._maybe_complete,
        )
        self._acc = self._state.acc
        self._pending_children = self._state.pending_children
        self._parent = self._state.parent
        self._child_contrib = self._state.child_contrib
        self._reschedule_after_cancel: dict[str, float] = {}
        self._tree_invalidations: dict[str, float] = {}
        self._shutdown = False
        self._workers: list[threading.Thread] = []

        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        worker_count = max(1, workers)
        workertrace.append(
            "manager_started",
            workers=worker_count,
            local_root=str(self.local_root) if self.local_root is not None else None,
            remote=self.remote,
        )
        for index in range(worker_count):
            t = threading.Thread(target=self._worker, daemon=True, name=f"folder-cache-worker-{index + 1}")
            t.start()
            self._workers.append(t)
            workertrace.append("worker_started", worker=t.name)

    def shutdown(self, timeout: float = 5.0) -> None:
        with self._lock:
            if self._shutdown:
                return
            self._shutdown = True
            for active in list(self._active_jobs.values()):
                active.cancel_token.cancel()
        for _ in self._workers:
            self._queue.put(FolderShutdownJob())
        per_thread_timeout = timeout / max(1, len(self._workers))
        for worker in self._workers:
            worker.join(timeout=per_thread_timeout)

    # ------------------------------------------------------------------
    # Cache file helpers
    # ------------------------------------------------------------------

    def _cache_path(self, remote_path: str) -> Path:
        key = hashlib.sha256(remote_path.encode()).hexdigest()
        return CACHE_DIR / f"{key}.json"

    def _remote_rel_path(self, remote_path: str) -> str | None:
        if not self.remote:
            return None
        if remote_path == self.remote:
            return ""
        if self.remote.endswith(":"):
            if remote_path.startswith(self.remote):
                return remote_path[len(self.remote):].lstrip("/")
            return None
        prefix = self.remote.rstrip("/") + "/"
        if remote_path.startswith(prefix):
            return remote_path[len(prefix):]
        return None

    def _local_folder_for_remote(self, remote_path: str) -> Path | None:
        if self.local_root is None:
            return None
        rel_path = self._remote_rel_path(remote_path)
        if rel_path is None:
            return None
        return resolve_matching_local_path(self.local_root, rel_path)


    def get(self, remote_path: str) -> dict | None:
        """Return cached data (partial or complete), or None if unavailable.

        TTL is only enforced for *complete* entries; partial results from a
        prior run are returned as-is so the UI can show them while re-computing.
        """
        started = time.perf_counter()
        p = self._cache_path(remote_path)
        if not p.exists():
            return None
        result: dict | None = None
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            invalidated_at = self._tree_invalidated_at(remote_path)
            if invalidated_at is not None and data.get("cached_at", 0) <= invalidated_at:
                return None
            expected_local_root = str(self.local_root) if self.local_root is not None else None
            result = validate_cache_record(
                data,
                expected_local_root=expected_local_root,
                ttl_seconds=self.ttl_seconds,
                now=time.time(),
            )
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
                    "slow_folder_cache_read",
                    remote_path=remote_path,
                    cache_path=str(p),
                    elapsed_ms=elapsed_ms,
                    hit=result is not None,
                    complete=bool(result and result.get("complete")),
                    file_size=file_size,
                )

    def get_direct_listing(self, remote_path: str) -> list[dict] | None:
        """Return cached direct lsjson items for one folder, or None on miss."""
        data = self.get(remote_path)
        if data is None:
            return None
        direct_items = data.get("direct_items")
        if not isinstance(direct_items, list) or not all(isinstance(item, dict) for item in direct_items):
            return None
        return [dict(item) for item in direct_items]

    @property
    def revision(self) -> int:
        """Return the current in-process cache revision."""
        with self._lock:
            return self._revision

    def _advance_revision_locked(self) -> None:
        self._revision += 1

    def invalidate(self, remote_path: str) -> None:
        """Forget cached and in-memory metadata for one remote folder."""
        with self._lock:
            self._advance_revision_locked()
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

    def invalidate_tree(self, remote_path: str) -> list[str]:
        """Forget cached and in-memory metadata for a folder and known descendants."""
        invalidated_at = time.time()
        paths = {remote_path}
        with self._lock:
            self._tree_invalidations[remote_path.rstrip("/")] = invalidated_at
            known_paths: set[str] = set(self._acc)
            known_paths.update(self._direct_done)
            known_paths.update(self._pending_children)
            known_paths.update(self._parent)
            known_paths.update(self._in_progress)
            known_paths.update(self._active_jobs)
            for child_paths in self._pending_children.values():
                known_paths.update(child_paths)
            for path in known_paths:
                if _same_or_child_path(path, remote_path):
                    paths.add(path)
        for path in sorted(paths, key=lambda value: value.count("/"), reverse=True):
            self.invalidate(path)
        self._start_tree_cleanup(remote_path, invalidated_at)
        return sorted(paths, key=str.casefold)

    def _tree_invalidated_at(self, remote_path: str) -> float | None:
        with self._lock:
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
            name="folder-cache-cleanup",
        )
        thread.start()

    def _cleanup_tree(self, remote_path: str, invalidated_at: float) -> None:
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

    def _cache_record_data_locked(self, remote_path: str, complete: bool) -> dict:
        """Build one cache record snapshot from the current in-memory state."""
        acc = self._acc.get(remote_path, {})
        return build_cache_record(
            remote_path,
            acc,
            complete=complete,
            local_root=str(self.local_root) if self.local_root is not None else None,
            now=time.time(),
        )

    def _write_cache_record(self, remote_path: str, data: dict) -> None:
        write_json_atomic(self._cache_path(remote_path), data)

    def _write_cache(self, remote_path: str, complete: bool) -> None:
        """Flush one cache record to disk immediately."""
        with self._lock:
            self._advance_revision_locked()
            data = self._cache_record_data_locked(remote_path, complete)
        self._write_cache_record(remote_path, data)

    def _mark_cache_dirty_locked(self, remote_path: str, complete: bool) -> None:
        """Mark one cache record for disk flush after the lock is released."""
        self._advance_revision_locked()
        previous = self._dirty_cache_writes.get(remote_path)
        previous_complete = bool(previous[0]) if previous is not None else False
        epoch = self._cache_write_epoch.get(remote_path, 0) + 1
        self._cache_write_epoch[remote_path] = epoch
        self._dirty_cache_writes[remote_path] = (bool(complete or previous_complete), epoch)

    def _is_disk_complete_locked(self, remote_path: str) -> bool:
        """Whether the current in-memory state should be written as complete."""
        if remote_path not in self._acc or remote_path in self._abandoned:
            return False
        if remote_path not in self._direct_done or self._pending_children.get(remote_path):
            return False
        acc = self._acc[remote_path]
        if self.local_root is None:
            return True
        if acc.get("diff_status") in {DIFF_HAS_DIFFS, DIFF_DROPBOX_ONLY}:
            return True
        return bool(acc.get("diff_complete"))

    def _flush_dirty_cache_writes(self) -> None:
        """Write pending cache snapshots without holding the manager lock.

        Snapshots are taken under the lock, then written outside it so HTTP and
        worker threads are not blocked on disk I/O. Because another worker may
        finalize the same path between snapshot and write (classic parent
        partial flush vs child completion race), each write carries an epoch.
        Stale epochs are skipped or repaired so a late partial cannot clobber a
        newer complete record on disk.
        """
        while True:
            with self._lock:
                if not self._dirty_cache_writes:
                    return
                pending = self._dirty_cache_writes
                self._dirty_cache_writes = {}
                snapshots = [
                    (remote_path, self._cache_record_data_locked(remote_path, complete), epoch)
                    for remote_path, (complete, epoch) in pending.items()
                ]
            for remote_path, data, epoch in snapshots:
                with self._lock:
                    if self._cache_write_epoch.get(remote_path, 0) != epoch:
                        self._trace_locked(
                            "cache_write_skipped_stale",
                            remote_path,
                            write_epoch=epoch,
                            current_epoch=self._cache_write_epoch.get(remote_path, 0),
                        )
                        continue
                self._write_cache_record(remote_path, data)
                with self._lock:
                    if self._cache_write_epoch.get(remote_path, 0) != epoch:
                        # Lost the race between the pre-write check and the
                        # disk write. Force a fresh snapshot of current state.
                        self._mark_cache_dirty_locked(
                            remote_path,
                            self._is_disk_complete_locked(remote_path),
                        )
                        self._trace_locked(
                            "cache_write_repaired_stale",
                            remote_path,
                            write_epoch=epoch,
                            current_epoch=self._cache_write_epoch.get(remote_path, 0),
                        )

    def prime_direct_listing(self, remote_path: str, items: list[dict], page_time: float | None = None) -> None:
        """Seed direct child metadata from a foreground listing.

        This keeps cache-only consumers, such as the music library endpoint, in
        sync with the current page after a forced refresh without doing
        recursive metadata work on the request thread.
        """
        direct_listing = parse_direct_listing(items, remote_path)
        if page_time is None:
            page_time = time.time()
        current = self.get(remote_path)
        if current is not None and current.get("complete"):
            return
        with self._lock:
            if self._shutdown:
                return
            self._acc[remote_path] = {
                "size": direct_listing.direct_size,
                "count": direct_listing.direct_count,
                "mtime": direct_listing.direct_mtime,
                "diff_status": DIFF_UNAVAILABLE if self.local_root is None else DIFF_LOADING,
                "diff_complete": self.local_root is None,
                "first_diff_path": None,
                "file_statuses": {},
                "direct_items": direct_listing.direct_items,
                "direct_files": direct_listing.direct_files,
                "direct_folders": direct_listing.direct_folders,
            }
            self._advance_revision_locked()
            self._mark_cache_dirty_locked(remote_path, complete=False)
            self._trace_locked(
                "direct_listing_primed",
                remote_path,
                page_epoch=page_time,
                direct_files=direct_listing.direct_count,
                subfolders=len(direct_listing.subfolders),
            )
        self._flush_dirty_cache_writes()

    def _trace(self, event: str, remote_path: str | None = None, **details: object) -> None:
        payload: dict[str, object] = {
            "queue_size": self._queue.qsize(),
            "active_jobs": len(self._active_jobs),
            "in_progress": len(self._in_progress),
            "page_completed": self._page_completed,
            "page_dispatched": self._page_dispatched,
        }
        if remote_path is not None:
            payload["remote_path"] = remote_path
        payload.update(details)
        workertrace.append(event, **payload)

    def _trace_locked(self, event: str, remote_path: str | None = None, **details: object) -> None:
        payload: dict[str, object] = {
            "queue_size": self._queue.qsize(),
            "active_jobs": len(self._active_jobs),
            "in_progress": len(self._in_progress),
            "page_completed": self._page_completed,
            "page_dispatched": self._page_dispatched,
        }
        if remote_path is not None:
            payload["remote_path"] = remote_path
        payload.update(details)
        workertrace.append(event, **payload)

    def _queue_job(self, job: FolderJob, reason: str) -> None:
        self._queue.put(job)
        self._trace(
            "job_queued",
            job.remote_path,
            reason=reason,
            job_type=job.job_type,
            page_epoch=job.page_epoch,
            breadth_depth=job.breadth_depth,
        )

    def _finalize_loading_file_statuses(self, acc: dict, diff_status: str, reason: str) -> None:
        for status in acc.get("file_statuses", {}).values():
            if status.get("diff_status") == DIFF_LOADING:
                status["diff_status"] = diff_status
                status.setdefault("reason", reason)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def status(self, remote_path: str) -> str:
        """Return 'complete', 'partial', 'calculating', or 'pending'."""
        data = self.get(remote_path)
        with self._lock:
            if data is not None and not (remote_path in self._abandoned and not data.get("complete")):
                return "complete" if data.get("complete") else "partial"
            if remote_path in self._in_progress:
                return "calculating"
        return "pending"

    def notify_page_load(self, page_time: float, *, page_key: str | None = None, force: bool = False) -> None:
        """Start a new page epoch without doing heavy queue cleanup."""
        started = time.perf_counter()
        lock_wait_started = time.perf_counter()
        with self._lock:
            lock_wait_ms = round((time.perf_counter() - lock_wait_started) * 1000, 3)
            if not force and page_key is not None and page_key == self._current_page_key:
                self._trace_locked(
                    "page_load_reused",
                    page_epoch=page_time,
                    page_key=page_key,
                    lock_wait_ms=lock_wait_ms,
                    elapsed_ms=round((time.perf_counter() - started) * 1000, 3),
                )
                return
            self._advance_page_time(page_time)
            self._current_page_key = page_key
            self._trace_locked(
                "page_load",
                page_epoch=page_time,
                removed_jobs=0,
                page_key=page_key,
                force=force,
                lock_wait_ms=lock_wait_ms,
                elapsed_ms=round((time.perf_counter() - started) * 1000, 3),
            )

    def page_epoch_for(self, page_key: str) -> float:
        """Return the active page epoch for the current page key when available.

        Fallback requests intentionally become the newest epoch because the user
        explicitly asked to load music for a non-current or stale page context.
        """
        with self._lock:
            if (
                self._min_page_time
                and self._current_page_key is not None
                and page_key == self._current_page_key
            ):
                return self._min_page_time
        return time.time()

    def _advance_page_time(self, page_time: float) -> None:
        """Update _min_page_time and reset progress counters.  Lock must be held."""
        if page_time > self._min_page_time:
            self._min_page_time = page_time
            self._page_dispatched = 0
            self._page_completed = 0
        self._progress_by_epoch.setdefault(page_time, {"completed": 0, "dispatched": 0})

    def _cancel_queued_job(self, job: FolderJob) -> None:
        """Cancel a queued old-page job.  Lock must be held."""
        if job.remote_path not in self._active_jobs and self._in_progress.get(job.remote_path) == job.page_epoch:
            self._in_progress.pop(job.remote_path, None)
        self._mark_abandoned(job.remote_path)
        self._trace_locked("job_canceled", job.remote_path, page_epoch=job.page_epoch, job_type=job.job_type)

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
            self._mark_cache_dirty_locked(parent, complete=False)
        self._mark_abandoned(parent)

    def current_progress(self) -> tuple[int, int]:
        """Return (completed, dispatched) counts for the current page."""
        with self._lock:
            return (self._page_completed, self._page_dispatched)

    def _progress_text_for_epoch(self, page_epoch: float) -> str:
        with self._lock:
            progress = self._progress_by_epoch.get(page_epoch)
            if progress is None:
                return f"{self._page_completed}/{self._page_dispatched}]"
            return f"{progress.get('completed', 0)}/{progress.get('dispatched', 0)}]"

    def _record_dispatched(self, page_epoch: float) -> None:
        """Count dispatched work only for the active page epoch.  Lock must be held."""
        progress = self._progress_by_epoch.setdefault(page_epoch, {"completed": 0, "dispatched": 0})
        progress["dispatched"] += 1
        if page_epoch >= self._min_page_time:
            self._page_dispatched += 1

    def _record_completed(self, page_epoch: float) -> None:
        """Count completed work only for the active page epoch.  Lock must be held."""
        progress = self._progress_by_epoch.setdefault(page_epoch, {"completed": 0, "dispatched": 0})
        progress["completed"] += 1
        if page_epoch >= self._min_page_time:
            self._page_completed += 1

    def _request_with_depth(
        self,
        remote_path: str,
        page_time: float,
        breadth_depth: int,
        *,
        cached_data: dict | None = None,
        cached_data_provided: bool = False,
        trace_dedup: bool = True,
    ) -> bool:
        """Ensure one folder is queued, preserving the requested breadth depth."""
        data = cached_data if cached_data_provided else self.get(remote_path)
        if data is not None and data.get("complete"):
            self._trace("request_skipped_cached", remote_path, page_epoch=page_time)
            return False
        enqueue_refresh = False
        flush_complete = False
        with self._lock:
            if self._shutdown:
                return False
            if remote_path in self._direct_done:
                # Its direct listing has already been fetched in this process.
                # If child work is still finishing, try to attach already-complete
                # children before giving up. Abandoned folders were canceled on
                # an older page and must be allowed to restart cleanly.
                if self._pending_children.get(remote_path) and remote_path not in self._abandoned:
                    self._repair_complete_children_locked(remote_path)
                    if self._pending_children.get(remote_path) and remote_path not in self._abandoned:
                        if trace_dedup:
                            self._trace_locked("request_deduplicated", remote_path, page_epoch=page_time)
                        return False
                if remote_path not in self._abandoned and self._is_disk_complete_locked(remote_path):
                    # In-memory subtree is already complete (possibly after
                    # repair) but disk still shows partial — common after a
                    # stale deferred flush. Rewrite complete without recompute.
                    self._mark_cache_dirty_locked(remote_path, True)
                    self._trace_locked("request_flushed_complete", remote_path, page_epoch=page_time)
                    flush_complete = True
                else:
                    self._abandoned.discard(remote_path)
                    self._direct_done.pop(remote_path, None)
                    self._pending_children.pop(remote_path, None)
                    self._child_contrib.pop(remote_path, None)
            if not flush_complete:
                current_page_time = self._in_progress.get(remote_path)
                if current_page_time is not None:
                    active = self._active_jobs.get(remote_path)
                    if active is not None and active.cancel_token.cancelled:
                        previous = self._reschedule_after_cancel.get(remote_path, 0.0)
                        self._reschedule_after_cancel[remote_path] = max(previous, page_time)
                        self._trace_locked("request_rescheduled", remote_path, page_epoch=page_time)
                    elif page_time > current_page_time:
                        self._in_progress[remote_path] = page_time
                        if active is None:
                            removed = self._queue.remove_matching(
                                lambda item: isinstance(item, FolderJob) and item.remote_path == remote_path
                            )
                            self._advance_page_time(page_time)
                            self._record_dispatched(page_time)
                            self._trace_locked(
                                "request_reenqueued",
                                remote_path,
                                page_epoch=page_time,
                                removed_jobs=len(removed),
                            )
                            enqueue_refresh = True
                        else:
                            self._trace_locked("request_refreshed", remote_path, page_epoch=page_time)
                    else:
                        if trace_dedup:
                            self._trace_locked(
                                "request_deduplicated",
                                remote_path,
                                page_epoch=page_time,
                                owner_page_epoch=current_page_time,
                                active=active is not None,
                            )
                    if not enqueue_refresh:
                        return False
                else:
                    self._in_progress[remote_path] = page_time
                    self._advance_page_time(page_time)
                    self._record_dispatched(page_time)
                    self._trace_locked("request_enqueued", remote_path, page_epoch=page_time)
        if flush_complete:
            self._flush_dirty_cache_writes()
            return False
        self._queue_job(
            FolderJob.create(remote_path, page_time, breadth_depth),
            "request_reenqueue" if enqueue_refresh else "request",
        )
        return True

    def request(self, remote_path: str, page_time: float | None = None) -> None:
        """Enqueue a folder at depth 0 (page-level) for background computation."""
        if page_time is None:
            page_time = time.time()
        self._request_with_depth(remote_path, page_time, 0)

    def ensure_known_subtree(
        self,
        remote_path: str,
        page_epoch: float,
        *,
        record_lookup=None,
        trace_dedup: bool = True,
    ) -> dict[str, int | float]:
        """Queue known missing or incomplete subtree records without blocking.

        Traversal uses cached ``direct_folders`` only, so this never runs
        rclone work on the request thread and only queues folders the cache can
        already identify.
        """
        result: dict[str, int | float] = {
            "page_epoch": page_epoch,
            "queued_folder_count": 0,
            "pending_folder_count": 0,
            "missing_folder_count": 0,
        }
        seen: set[str] = set()
        queue: list[tuple[str, int]] = [(remote_path, 0)]
        index = 0

        while index < len(queue):
            current_path, breadth_depth = queue[index]
            index += 1
            if current_path in seen:
                continue
            seen.add(current_path)

            current_data = record_lookup(current_path) if record_lookup is not None else self.get(current_path)
            if current_data is not None:
                current_status = "complete" if current_data.get("complete") else "partial"
            else:
                current_status = self.status(current_path)
            if current_status != "complete":
                result["pending_folder_count"] += 1
                if current_data is None:
                    result["missing_folder_count"] += 1
                if self._request_with_depth(
                    current_path,
                    page_epoch,
                    breadth_depth,
                    cached_data=current_data,
                    cached_data_provided=record_lookup is not None,
                    trace_dedup=trace_dedup,
                ):
                    result["queued_folder_count"] += 1

            if current_data is None:
                continue

            direct_folders = current_data.get("direct_folders", [])
            if not isinstance(direct_folders, list):
                continue
            child_depth = min(breadth_depth + 1, BREADTH_FIRST_DEPTH_CAP)
            for child in direct_folders:
                if not isinstance(child, dict):
                    continue
                child_remote_path = child.get("remote_path")
                if isinstance(child_remote_path, str) and child_remote_path:
                    queue.append((child_remote_path, child_depth))

        return result

    # ------------------------------------------------------------------
    # Worker
    # ------------------------------------------------------------------

    def _worker(self) -> None:
        while True:
            job = self._queue.get()
            if isinstance(job, FolderShutdownJob):
                self._queue.task_done()
                return
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
                    self._trace_locked(
                        "job_dequeued",
                        remote_path,
                        page_epoch=page_epoch,
                        job_type=job.job_type,
                        breadth_depth=job.breadth_depth,
                    )
                    owner_page_time = self._in_progress.get(remote_path)
                    if owner_page_time is None:
                        self._trace_locked("job_skipped_unowned", remote_path, page_epoch=page_epoch)
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
                        self._trace_locked("job_skipped_stale", remote_path, page_epoch=effective_page_time)
                    continue
                if already_done:
                    clear_in_progress = True
                    with self._lock:
                        # Direct listing is done, but a concurrent child may
                        # have finished without the parent attach path running.
                        # Repair pending children before skipping the job.
                        self._repair_complete_children_locked(remote_path)
                        self._record_completed(effective_page_time)
                        self._trace_locked("job_skipped_complete", remote_path, page_epoch=effective_page_time)
                    continue
                assert cancel_token is not None
                self._trace("job_started", remote_path, page_epoch=effective_page_time, breadth_depth=job.breadth_depth)
                if self._compute(remote_path, effective_page_time, job.breadth_depth, generation, cancel_token):
                    clear_in_progress = True
                    with self._lock:
                        self._record_completed(effective_page_time)
                        self._trace_locked("job_finished", remote_path, page_epoch=effective_page_time)
                else:
                    force_clear_in_progress = True
                    with self._lock:
                        self._record_completed(effective_page_time)
                        self._trace_locked("job_aborted", remote_path, page_epoch=effective_page_time)
                clear_in_progress = True
            except RcloneCancelled:
                clear_in_progress = True
                force_clear_in_progress = True
                with self._lock:
                    self._mark_abandoned(remote_path)
                    self._record_completed(page_epoch)
                    self._trace_locked("job_canceled_running", remote_path, page_epoch=page_epoch)
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
                        self._acc[remote_path] = {
                            "size": 0,
                            "count": 0,
                            "mtime": None,
                            "diff_status": DIFF_UNAVAILABLE if self.local_root is None else DIFF_HAS_DIFFS,
                            "diff_complete": True,
                            "first_diff_path": "Background folder job failed",
                            "file_statuses": {},
                        }
                    self._finalize_loading_file_statuses(
                        self._acc[remote_path],
                        DIFF_UNAVAILABLE if self.local_root is None else DIFF_HAS_DIFFS,
                        "Background folder job failed",
                    )
                    self._direct_done[remote_path] = latest_page_time
                    self._pending_children.setdefault(remote_path, set())
                    self._mark_cache_dirty_locked(remote_path, complete=True)
                    self._state.propagate(remote_path)
                    self._state.on_subtree_complete(remote_path)
                    self._record_completed(latest_page_time)
                    self._trace_locked("job_failed", remote_path, page_epoch=latest_page_time)
                self._trace(
                    "job_error",
                    remote_path,
                    page_epoch=page_epoch,
                    traceback=traceback.format_exc(),
                )
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
                        self._trace_locked("job_rescheduled", remote_path, page_epoch=reschedule_epoch)
                self._flush_dirty_cache_writes()
                self._queue.task_done()
                if reschedule_epoch is not None:
                    self._queue_job(FolderJob.create(remote_path, reschedule_epoch, job.breadth_depth), "reschedule_after_cancel")

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
        listing_source = "cache"
        if self.listing_cache:
            items = self.listing_cache.get(remote_path)
        if items is None:
            listing_source = "rclone"
            context_factory = getattr(self.rclone, "progress_context", None)
            if context_factory is None:
                proc = self.rclone.run("lsjson", "--", remote_path, cancel_token=cancel_token)
            else:
                with context_factory(lambda: self._progress_text_for_epoch(page_time)):
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
        self._trace("folder_listing_loaded", remote_path, page_epoch=page_time, source=listing_source, item_count=len(items))

        direct_listing = parse_direct_listing(items, remote_path)
        direct_size = direct_listing.direct_size
        direct_count = direct_listing.direct_count
        direct_mtime = direct_listing.direct_mtime
        subfolders = direct_listing.subfolders
        remote_children = direct_listing.remote_children
        direct_items = direct_listing.direct_items
        direct_files = direct_listing.direct_files
        direct_folders = direct_listing.direct_folders

        local_folder = self._local_folder_for_remote(remote_path)
        direct_diff_reason: str | None = None
        direct_diff_status = DIFF_HAS_DIFFS
        file_statuses: dict[str, dict] = {}
        if self.local_root is not None:
            local_snapshot = enumerate_local_children(local_folder)
            direct_diff = compare_direct_children(
                remote_children,
                local_snapshot.children,
                local_folder_exists=local_snapshot.folder_exists,
            )
            direct_diff_reason = direct_diff.diff_reason
            direct_diff_status = direct_diff.diff_status
            file_statuses = direct_diff.file_statuses

        # Read cached data for subfolders *before* acquiring the lock.
        sf_cached: dict[str, dict | None] = {sf: self.get(sf) for sf in subfolders}

        with self._lock:
            if self._generation.get(remote_path, 0) != generation:
                return False
            page_time = max(page_time, self._in_progress.get(remote_path, page_time))
            self._abandoned.discard(remote_path)
            # Initialise (or reset) accumulated state from direct-file stats.
            self._acc[remote_path] = {
                "size": direct_size,
                "count": direct_count,
                "mtime": direct_mtime,
                "diff_status": DIFF_UNAVAILABLE if self.local_root is None else DIFF_LOADING,
                "diff_complete": self.local_root is None,
                "first_diff_path": None,
                "file_statuses": file_statuses,
                "direct_items": direct_items,
                "direct_files": direct_files,
                "direct_folders": direct_folders,
            }
            self._direct_done[remote_path] = page_time
            self._pending_children[remote_path] = set()

            if direct_diff_reason is not None:
                self._trace_locked("direct_diff_found", remote_path, reason=direct_diff_reason, diff_status=direct_diff_status)
                self._note_diff(remote_path, direct_diff_reason, direct_diff_status)

            complete = len(subfolders) == 0
            self._mark_cache_dirty_locked(remote_path, complete=complete)
            self._state.propagate(remote_path)

            # Register and (if needed) queue each subfolder.
            for sf in subfolders:
                self._parent[sf] = remote_path
                # Clear stale contribution so re-compute deltas start from zero.
                self._child_contrib.pop(sf, None)
                # Prefer a live under-lock completeness check over the pre-lock
                # disk snapshot: a child can finish (memory and/or disk) between
                # the snapshot and this critical section.
                cached = sf_cached[sf]
                memory_complete = (
                    sf in self._acc
                    and sf in self._direct_done
                    and not self._pending_children.get(sf)
                    and sf not in self._abandoned
                    and (
                        self.local_root is None
                        or self._acc[sf].get("diff_complete")
                        or self._acc[sf].get("diff_status") in {DIFF_HAS_DIFFS, DIFF_DROPBOX_ONLY}
                    )
                )
                disk_complete = (
                    sf not in self._in_progress
                    and cached is not None
                    and cached.get("complete")
                )
                if disk_complete and not memory_complete:
                    # Reuse existing complete cache — incorporate immediately.
                    self._acc[sf] = {
                        "size": cached.get("size") or 0,
                        "count": cached.get("file_count") or 0,
                        "mtime": cached.get("newest_mtime"),
                        "diff_status": cached.get("diff_status", DIFF_LOADING),
                        "diff_complete": cached.get("diff_complete", False),
                        "first_diff_path": cached.get("first_diff_path"),
                        "file_statuses": cached.get("file_statuses", {}),
                        "direct_items": cached.get("direct_items", []),
                        "direct_files": cached.get("direct_files", []),
                        "direct_folders": cached.get("direct_folders", []),
                    }
                    self._direct_done[sf] = page_time
                    self._pending_children.setdefault(sf, set())
                    self._state.propagate(sf)
                    if cached.get("diff_status") in {DIFF_HAS_DIFFS, DIFF_DROPBOX_ONLY}:
                        self._note_diff(remote_path, cached.get("first_diff_path") or sf)
                    # sf is already fully done — do not add to pending_children.
                    self._state.on_subtree_complete(sf)
                elif memory_complete:
                    # Child finished as an independent request (or under the
                    # lock race with the pre-lock snapshot) before this parent
                    # registered pending state. Attach now.
                    self._state.propagate(sf)
                    if self._acc.get(sf, {}).get("diff_status") in {DIFF_HAS_DIFFS, DIFF_DROPBOX_ONLY}:
                        self._note_diff(remote_path, self._acc[sf].get("first_diff_path") or sf)
                    self._state.on_subtree_complete(sf)
                else:
                    self._pending_children[remote_path].add(sf)
                    if sf in self._direct_done and not self._pending_children.get(sf):
                        # A previously canceled child can be left with direct
                        # metadata but no pending descendants. Clear that
                        # stale marker and let the current page enqueue a clean
                        # recompute below.
                        self._direct_done.pop(sf, None)
                    if page_time < self._min_page_time:
                        self._mark_abandoned(sf)
                    elif sf not in self._direct_done and sf not in self._in_progress:
                        child_depth = min(breadth_depth + 1, BREADTH_FIRST_DEPTH_CAP)
                        self._in_progress[sf] = page_time
                        self._record_dispatched(page_time)
                        self._trace_locked("child_enqueued", sf, parent=remote_path, page_epoch=page_time, breadth_depth=child_depth)
                        self._queue_job(FolderJob.create(sf, page_time, child_depth), "child_folder")

            self._trace_locked(
                "folder_state_updated",
                remote_path,
                page_epoch=page_time,
                subfolders=len(subfolders),
                direct_files=direct_count,
            )
            self._maybe_complete(remote_path)
        return True

    def _repair_complete_children_locked(self, remote_path: str) -> None:
        """Attach already-complete pending children and finalize when possible.

        Used when a job is skipped as already-done for its direct listing so a
        stuck ``pending_children`` set cannot leave the parent partial forever.
        Lock must be held.
        """
        pending = self._pending_children.get(remote_path)
        if pending:
            for sf in list(pending):
                if (
                    sf in self._acc
                    and sf in self._direct_done
                    and not self._pending_children.get(sf)
                    and sf not in self._abandoned
                    and (
                        self.local_root is None
                        or self._acc[sf].get("diff_complete")
                        or self._acc[sf].get("diff_status") in {DIFF_HAS_DIFFS, DIFF_DROPBOX_ONLY}
                    )
                ):
                    self._state.propagate(sf)
                    if self._acc.get(sf, {}).get("diff_status") in {DIFF_HAS_DIFFS, DIFF_DROPBOX_ONLY}:
                        self._note_diff(remote_path, self._acc[sf].get("first_diff_path") or sf)
                    self._state.on_subtree_complete(sf)
        if remote_path in self._direct_done and not self._pending_children.get(remote_path):
            self._maybe_complete(remote_path)

    # ------------------------------------------------------------------
    # Propagation helpers  (all require lock to be held)
    # ------------------------------------------------------------------

    def _note_diff(self, path: str, reason: str, diff_status: str = DIFF_HAS_DIFFS) -> None:
        """Record completed diff status without forcing metadata completion."""
        acc = self._acc.setdefault(path, {
            "size": 0,
            "count": 0,
            "mtime": None,
            "file_statuses": {},
        })
        for status in acc.get("file_statuses", {}).values():
            if status.get("diff_status") == DIFF_LOADING:
                status["diff_status"] = diff_status
                status.setdefault("reason", "Skipped after first diff")
        if acc.get("diff_status") not in {DIFF_HAS_DIFFS, DIFF_DROPBOX_ONLY}:
            acc["diff_status"] = diff_status
        acc["diff_complete"] = True
        if not acc.get("first_diff_path"):
            acc["first_diff_path"] = reason
        self._trace_locked("subtree_diff_marked", path, reason=reason, diff_status=diff_status)

    def _mark_diff(self, path: str, reason: str, diff_status: str = DIFF_HAS_DIFFS) -> None:
        """Mark this subtree and ancestors as different. Lock must be held."""
        self._note_diff(path, reason, diff_status)
        self._pending_children[path] = set()
        self._abandoned.add(path)
        self._mark_cache_dirty_locked(path, complete=True)

        parent = self._parent.get(path)
        if parent is not None:
            pending = self._pending_children.get(parent)
            if pending is not None:
                pending.clear()
            self._mark_diff(parent, reason, DIFF_HAS_DIFFS)

    def _maybe_complete(self, path: str) -> None:
        """Finish a synced subtree when direct and child folder work is done."""
        acc = self._acc.get(path)
        if acc is None:
            return
        if path in self._abandoned:
            self._mark_cache_dirty_locked(path, complete=False)
            return
        if acc.get("diff_status") in {DIFF_HAS_DIFFS, DIFF_DROPBOX_ONLY}:
            if path in self._direct_done and not self._pending_children.get(path):
                self._mark_cache_dirty_locked(path, complete=True)
                self._trace_locked("subtree_complete", path, diff_status=acc.get("diff_status"))
                self._state.on_subtree_complete(path)
            else:
                self._mark_cache_dirty_locked(path, complete=False)
            return
        if self.local_root is None:
            acc["diff_status"] = DIFF_UNAVAILABLE
            acc["diff_complete"] = True
        elif path in self._direct_done and not self._pending_children.get(path):
            acc["diff_status"] = DIFF_SYNCED
            acc["diff_complete"] = True
        else:
            self._mark_cache_dirty_locked(path, complete=False)
            return
        self._mark_cache_dirty_locked(path, complete=True)
        self._trace_locked("subtree_complete", path, diff_status=acc.get("diff_status"))
        self._state.on_subtree_complete(path)
