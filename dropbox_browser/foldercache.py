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
from .formatting import parse_rclone_time
from .ignored import is_ignored_name
from .listingcache import ListingCacheManager
from .priorityqueue import PriorityQueue
from .rclone import RcloneCancelled, RcloneCancelToken
from .windows_names import match_dropbox_names_to_local_names, resolve_matching_local_path
from . import workertrace

CACHE_DIR = PROJECT_ROOT / "Cache" / "FolderInfo"
DIFF_CACHE_SCHEMA_VERSION = 6
DIFF_LOADING = "loading"
DIFF_SYNCED = "synced"
DIFF_HAS_DIFFS = "has_diffs"
DIFF_DROPBOX_ONLY = "dropbox_only"
DIFF_UNAVAILABLE = "unavailable"

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
        self._lock = threading.Lock()

        # Maps path → best (most-recent) page_time we have queued for it.
        self._in_progress: dict[str, float] = {}
        # Paths whose direct lsjson call is currently running.  This is a
        # process-wide single-flight guard: only one worker may query a folder.
        self._active_jobs: dict[str, ActiveFolderJob] = {}
        # Tracks the newest page_time seen; workers skip items older than this.
        self._min_page_time: float = 0.0
        self._current_page_key: str | None = None
        # Progress counters for the current page (reset when _min_page_time advances).
        self._page_dispatched: int = 0
        self._page_completed: int = 0
        self._progress_by_epoch: dict[float, dict[str, int]] = {}
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
        p = self._cache_path(remote_path)
        if not p.exists():
            return None
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            expected_local_root = str(self.local_root) if self.local_root is not None else None
            if data.get("local_root") != expected_local_root:
                return None
            if self.local_root is not None and data.get("schema_version") != DIFF_CACHE_SCHEMA_VERSION:
                return None
            if data.get("complete") and data.get("diff_complete") and any(
                (status or {}).get("diff_status") == DIFF_LOADING
                for status in (data.get("file_statuses") or {}).values()
            ):
                return None
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
            "schema_version": DIFF_CACHE_SCHEMA_VERSION,
            "local_root": str(self.local_root) if self.local_root is not None else None,
            "size": acc.get("size", 0),
            "file_count": acc.get("count", 0),
            "newest_mtime": acc.get("mtime"),
            "diff_status": acc.get("diff_status", DIFF_UNAVAILABLE if self.local_root is None else DIFF_LOADING),
            "diff_complete": acc.get("diff_complete", self.local_root is None),
            "first_diff_path": acc.get("first_diff_path"),
            "file_statuses": acc.get("file_statuses", {}),
            "complete": complete,
            "cached_at": time.time(),
        }
        write_json_atomic(self._cache_path(remote_path), data)

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
        """Start a new page epoch and cancel queued work from older pages."""
        with self._lock:
            if not force and page_key is not None and page_key == self._current_page_key:
                self._trace_locked("page_load_reused", page_epoch=page_time, page_key=page_key)
                return
            removed = self._queue.remove_matching(
                lambda item: isinstance(item, FolderJob) and item.page_epoch < page_time
            )
            self._advance_page_time(page_time)
            self._current_page_key = page_key
            for job in removed:
                self._cancel_queued_job(job)
            self._cancel_active_jobs_before(page_time)
            self._trace_locked(
                "page_load",
                page_epoch=page_time,
                removed_jobs=len(removed),
                page_key=page_key,
                force=force,
            )

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

    def request(self, remote_path: str, page_time: float | None = None) -> None:
        """Enqueue a folder at depth 0 (page-level) for background computation."""
        if page_time is None:
            page_time = time.time()
        data = self.get(remote_path)
        if data is not None and data.get("complete"):
            self._trace("request_skipped_cached", remote_path, page_epoch=page_time)
            return
        enqueue_refresh = False
        with self._lock:
            if self._shutdown:
                return
            if remote_path in self._direct_done:
                # Its direct listing has already been fetched in this process.
                # If child work is still finishing, do not start a second
                # direct lsjson.  Abandoned folders were canceled on an older
                # page and must be allowed to restart cleanly.
                if self._pending_children.get(remote_path) and remote_path not in self._abandoned:
                    self._trace_locked("request_deduplicated", remote_path, page_epoch=page_time)
                    return
                self._abandoned.discard(remote_path)
                self._direct_done.pop(remote_path, None)
                self._pending_children.pop(remote_path, None)
                self._child_contrib.pop(remote_path, None)
            current_page_time = self._in_progress.get(remote_path)
            if current_page_time is not None:
                active = self._active_jobs.get(remote_path)
                queued_jobs = self._queue.count_matching(
                    lambda item: isinstance(item, FolderJob) and item.remote_path == remote_path
                )
                if active is not None and active.cancel_token.cancelled:
                    previous = self._reschedule_after_cancel.get(remote_path, 0.0)
                    self._reschedule_after_cancel[remote_path] = max(previous, page_time)
                    self._trace_locked("request_rescheduled", remote_path, page_epoch=page_time)
                elif page_time > current_page_time:
                    self._in_progress[remote_path] = page_time
                    if active is None and queued_jobs == 0:
                        self._advance_page_time(page_time)
                        self._record_dispatched(page_time)
                        self._trace_locked("request_reenqueued", remote_path, page_epoch=page_time)
                        enqueue_refresh = True
                    else:
                        self._trace_locked("request_refreshed", remote_path, page_epoch=page_time)
                if not enqueue_refresh:
                    return
            else:
                self._in_progress[remote_path] = page_time
                self._advance_page_time(page_time)
                self._record_dispatched(page_time)
                self._trace_locked("request_enqueued", remote_path, page_epoch=page_time)
        self._queue_job(FolderJob.create(remote_path, page_time, 0), "request_reenqueue" if enqueue_refresh else "request")

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
                    self._write_cache(remote_path, complete=True)
                    self._propagate(remote_path)
                    self._on_subtree_complete(remote_path)
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

        direct_size = 0
        direct_count = 0
        direct_mtime: float | None = None
        subfolders: list[str] = []
        remote_children: dict[str, dict] = {}

        for item in items:
            name = item.get("Name") or item.get("Path") or ""
            if not name or "/" in name or is_ignored_name(name):
                continue
            remote_children[name] = item
            t = parse_rclone_time(item.get("ModTime"))
            if t and (direct_mtime is None or t > direct_mtime):
                direct_mtime = t
            if item.get("IsDir"):
                sf_name = item.get("Path") or item.get("Name", "")
                if sf_name:
                    if remote_path.endswith(":"):
                        subfolders.append(remote_path + sf_name)
                    else:
                        subfolders.append(remote_path.rstrip("/") + "/" + sf_name)
            else:
                sz = item.get("Size") or 0
                if sz > 0:
                    direct_size += sz
                direct_count += 1

        local_children: dict[str, Path] = {}
        local_folder = self._local_folder_for_remote(remote_path)
        if local_folder is not None and local_folder.exists() and local_folder.is_dir():
            try:
                local_children = {
                    child.name: child
                    for child in local_folder.iterdir()
                    if not is_ignored_name(child.name)
                }
            except OSError:
                local_children = {}

        direct_diff_reason: str | None = None
        direct_diff_status = DIFF_HAS_DIFFS
        file_statuses: dict[str, dict] = {}
        if self.local_root is not None:
            matches = match_dropbox_names_to_local_names(remote_children, local_children)
            matched_local_names = set(matches.values())
            missing_local = sorted((name for name in remote_children if name not in matches), key=str.casefold)
            missing_remote = sorted((name for name in local_children if name not in matched_local_names), key=str.casefold)

            def set_direct_diff(reason: str, status: str = DIFF_HAS_DIFFS) -> None:
                nonlocal direct_diff_reason, direct_diff_status
                if direct_diff_reason is None:
                    direct_diff_reason = reason
                    direct_diff_status = status

            if local_folder is None or not local_folder.exists() or not local_folder.is_dir():
                set_direct_diff("Dropbox only", DIFF_DROPBOX_ONLY)
            if missing_local or missing_remote:
                if missing_local and not missing_remote and not local_children:
                    set_direct_diff("Dropbox only", DIFF_DROPBOX_ONLY)
                elif missing_local:
                    set_direct_diff(
                        f"Dropbox only: {remote_children[missing_local[0]].get('Name') or remote_children[missing_local[0]].get('Path')}"
                    )
                elif missing_remote:
                    set_direct_diff(f"Local only: {local_children[missing_remote[0]].name}")

            for remote_name in sorted(matches, key=str.casefold):
                item = remote_children[remote_name]
                child = local_children[matches[remote_name]]
                name = item.get("Name") or item.get("Path") or child.name
                remote_is_dir = bool(item.get("IsDir"))
                local_is_dir = child.is_dir()
                if remote_is_dir != local_is_dir:
                    set_direct_diff(f"Type differs: {name}")
                    if not remote_is_dir:
                        file_statuses[name] = {"diff_status": DIFF_HAS_DIFFS, "reason": f"Type differs: {name}"}
                    continue
                if remote_is_dir:
                    continue
                try:
                    local_size = child.stat().st_size
                except OSError:
                    reason = f"Local unreadable: {name}"
                    set_direct_diff(reason)
                    file_statuses[name] = {"diff_status": DIFF_HAS_DIFFS, "reason": reason}
                    continue
                remote_size = item.get("Size") or 0
                if remote_size != local_size:
                    reason = f"Size differs: {name}"
                    set_direct_diff(reason)
                    file_statuses[name] = {"diff_status": DIFF_HAS_DIFFS, "reason": reason}
                    continue
                file_statuses[name] = {"diff_status": DIFF_SYNCED}

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
            }
            self._direct_done[remote_path] = page_time
            self._pending_children[remote_path] = set()

            if direct_diff_reason is not None:
                self._trace_locked("direct_diff_found", remote_path, reason=direct_diff_reason, diff_status=direct_diff_status)
                self._note_diff(remote_path, direct_diff_reason, direct_diff_status)

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
                        "diff_status": cached.get("diff_status", DIFF_LOADING),
                        "diff_complete": cached.get("diff_complete", False),
                        "first_diff_path": cached.get("first_diff_path"),
                        "file_statuses": cached.get("file_statuses", {}),
                    }
                    self._direct_done[sf] = page_time
                    self._pending_children.setdefault(sf, set())
                    self._propagate(sf)
                    if cached.get("diff_status") in {DIFF_HAS_DIFFS, DIFF_DROPBOX_ONLY}:
                        self._note_diff(remote_path, cached.get("first_diff_path") or sf)
                    # sf is already fully done — do not add to pending_children.
                    self._on_subtree_complete(sf)
                else:
                    self._pending_children[remote_path].add(sf)
                    if (
                        sf in self._acc
                        and sf in self._direct_done
                        and not self._pending_children.get(sf)
                        and sf not in self._abandoned
                    ):
                        # The child may have completed as an independent page
                        # request before this parent registered it. Attach its
                        # already-complete contribution now so the parent does
                        # not wait forever for a completion callback that has
                        # already happened.
                        self._propagate(sf)
                        if self._acc.get(sf, {}).get("diff_status") in {DIFF_HAS_DIFFS, DIFF_DROPBOX_ONLY}:
                            self._note_diff(remote_path, self._acc[sf].get("first_diff_path") or sf)
                        self._on_subtree_complete(sf)
                        continue
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

    # ------------------------------------------------------------------
    # Propagation helpers  (all require lock to be held)
    # ------------------------------------------------------------------

    def _has_diff_ancestor(self, path: str) -> bool:
        current: str | None = path
        while current:
            if self._acc.get(current, {}).get("diff_status") in {DIFF_HAS_DIFFS, DIFF_DROPBOX_ONLY}:
                return True
            current = self._parent.get(current)
        return False

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
        self._write_cache(path, complete=True)

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
            self._write_cache(path, complete=False)
            return
        if acc.get("diff_status") in {DIFF_HAS_DIFFS, DIFF_DROPBOX_ONLY}:
            if path in self._direct_done and not self._pending_children.get(path):
                self._write_cache(path, complete=True)
                self._trace_locked("subtree_complete", path, diff_status=acc.get("diff_status"))
                self._on_subtree_complete(path)
            else:
                self._write_cache(path, complete=False)
            return
        if self.local_root is None:
            acc["diff_status"] = DIFF_UNAVAILABLE
            acc["diff_complete"] = True
        elif path in self._direct_done and not self._pending_children.get(path):
            acc["diff_status"] = DIFF_SYNCED
            acc["diff_complete"] = True
        else:
            self._write_cache(path, complete=False)
            return
        self._write_cache(path, complete=True)
        self._trace_locked("subtree_complete", path, diff_status=acc.get("diff_status"))
        self._on_subtree_complete(path)

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
        if self._acc.get(path, {}).get("diff_status") in {DIFF_HAS_DIFFS, DIFF_DROPBOX_ONLY}:
            self._note_diff(parent, self._acc[path].get("first_diff_path") or path)
        if parent in self._direct_done and not pc:
            if parent in self._abandoned:
                self._write_cache(parent, complete=False)
                return
            self._maybe_complete(parent)
