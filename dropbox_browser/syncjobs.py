"""Parallel sync job queue for browser-triggered file operations.

Design decisions:

- Keep sync work separate from folder metadata workers. Metadata jobs are
  page-driven, cancelable, and read-only; sync jobs are side-effecting
  and should keep running once accepted.
- Use one fixed-size worker pool with one queued job per file/path operation so
  batch sync is no longer single-threaded.
- Preserve one browser-visible operation id per user action. A batch request is
  shown as one operation in ``syncstate`` while many child jobs run underneath.
- Give single-file sync requests higher priority than batch jobs.
- Keep logging/error handling uniform across all sync work by driving
  browser progress and completion from this manager rather than raw threads in
  request handlers.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from http import HTTPStatus
from pathlib import Path
from contextlib import nullcontext
from typing import TYPE_CHECKING, Any
import threading

from .errors import BrowserError
from .paths import remote_target
from .priorityqueue import PriorityQueue
from .rclone import is_retryable_dropbox_throttle_error
from . import syncstate

if TYPE_CHECKING:
    from .services import DropboxBrowser


@dataclass(order=True, frozen=True)
class SyncJob:
    priority_rank: int
    phase_rank: int
    depth_rank: int
    submit_order: int
    op_id: str = field(compare=False)
    kind: str = field(compare=False)
    item: dict[str, str] = field(compare=False)
    message: str = field(compare=False)
    command: str = field(compare=False)
    parent_rel: str = field(compare=False)
    attempt: int = field(default=1, compare=False)


@dataclass(order=True, frozen=True)
class SyncShutdownJob:
    priority_rank: int = 999
    phase_rank: int = 0
    depth_rank: int = 0
    submit_order: int = 0


@dataclass
class RemoteMkdirState:
    event: threading.Event = field(default_factory=threading.Event)
    error: Exception | None = None


@dataclass
class SyncGroup:
    total: int
    batch: bool
    success_message: str
    completed: int = 0
    running: int = 0
    pending_retries: int = 0
    errors: list[str] = field(default_factory=list)
    touched_parents: set[str] = field(default_factory=set)
    remote_mkdirs: dict[str, RemoteMkdirState] = field(default_factory=dict)


def _job_message(kind: str, item: dict[str, str]) -> tuple[str, str]:
    rel_path = item["path"]
    local_path = item["local_path"]
    remote_path = item["remote_path"]
    if kind == "local_dir_to_dropbox":
        return (
            f"Creating Dropbox folder: {rel_path}",
            f"rclone mkdir -- {remote_path}",
        )
    if kind == "local_to_dropbox":
        size_text = str(int(item.get("size") or 0))
        return (
            f"Copying local to Dropbox: {rel_path}",
            f"rclone rcat --size {size_text} -- {remote_path}",
        )
    if kind == "dropbox_dir_to_local":
        return (
            f"Creating local folder: {rel_path}",
            f"mkdir -- {local_path}",
        )
    if kind == "dropbox_to_local":
        return (
            f"Copying Dropbox to local: {rel_path}",
            f"rclone copyto -- {remote_path} {local_path}",
        )
    return (f"Unsupported sync operation: {rel_path}", "")


class SyncJobManager:
    DEFAULT_THROTTLE_RETRY_DELAYS = (2.0, 5.0) + (10.0,) * 18

    def __init__(self, app: "DropboxBrowser", workers: int):
        self.app = app
        self._queue: PriorityQueue = PriorityQueue()
        self._lock = threading.Lock()
        self._submit_order = 0
        self._groups: dict[str, SyncGroup] = {}
        self._shutdown = False
        self._workers: list[threading.Thread] = []
        self._retry_timers: set[threading.Timer] = set()
        self.throttle_retry_delays = self.DEFAULT_THROTTLE_RETRY_DELAYS
        worker_count = max(1, workers)
        self.worker_count = worker_count
        for index in range(worker_count):
            worker = threading.Thread(
                target=self._worker,
                daemon=True,
                name=f"sync-job-worker-{index + 1}",
            )
            worker.start()
            self._workers.append(worker)

    def shutdown(self, timeout: float = 5.0) -> None:
        with self._lock:
            if self._shutdown:
                return
            self._shutdown = True
        for _ in self._workers:
            self._queue.put(SyncShutdownJob())
        with self._lock:
            timers = list(self._retry_timers)
            self._retry_timers.clear()
        for timer in timers:
            timer.cancel()
        per_thread_timeout = timeout / max(1, len(self._workers))
        for worker in self._workers:
            worker.join(timeout=per_thread_timeout)

    def submit(self, label: str, operations: list[tuple[str, dict[str, str]]], *, batch: bool, success_message: str) -> str:
        op_id = syncstate.start(label)
        total = len(operations)
        syncstate.update(op_id, percent=0, total=total, errors=[])
        if total == 0:
            syncstate.complete(op_id, success_message)
            return op_id
        jobs: list[SyncJob] = []
        with self._lock:
            if self._shutdown:
                syncstate.fail(op_id, "Sync job manager is shutting down.")
                return op_id
            self._groups[op_id] = SyncGroup(total=total, batch=batch, success_message=success_message)
            for kind, item in operations:
                self._submit_order += 1
                jobs.append(self._make_job(op_id, kind, item, batch=batch, submit_order=self._submit_order))
        for job in jobs:
            self._queue.put(job)
        return op_id

    def _make_job(self, op_id: str, kind: str, item: dict[str, str], *, batch: bool, submit_order: int) -> SyncJob:
        phase_rank = 0
        depth_rank = 0
        if kind in {"local_dir_to_dropbox", "dropbox_dir_to_local"}:
            phase_rank = -1
            depth_rank = len(Path(item["path"]).parts)
        message, command = _job_message(kind, item)
        parent_rel = str(Path(item["path"]).parent).replace("\\", "/")
        if parent_rel == ".":
            parent_rel = ""
        return SyncJob(
            priority_rank=1 if batch else 0,
            phase_rank=phase_rank,
            depth_rank=depth_rank,
            submit_order=submit_order,
            op_id=op_id,
            kind=kind,
            item=item,
            message=message,
            command=command,
            parent_rel=parent_rel,
        )

    def _worker(self) -> None:
        while True:
            job = self._queue.get()
            try:
                if isinstance(job, SyncShutdownJob):
                    return
                if not isinstance(job, SyncJob):
                    return
                self._run_job(job)
            finally:
                self._queue.task_done()

    def _run_job(self, job: SyncJob) -> None:
        with self._lock:
            group = self._groups.get(job.op_id)
            if group is None:
                return
            group.running += 1
            syncstate.update(
                job.op_id,
                message=job.message,
                command=job.command,
                percent=int(group.completed / group.total * 100) if group.total else 100,
                current=self._current_progress(group),
                total=group.total,
                errors=list(group.errors),
            )
        error_message: str | None = None
        retry_job: SyncJob | None = None
        retry_delay = 0.0
        try:
            rclone = getattr(self.app, "rclone", None)
            context_factory = getattr(rclone, "progress_context", None)
            context = (
                context_factory(lambda: self._progress_text(job.op_id))
                if context_factory is not None
                else nullcontext()
            )
            with context:
                self._execute_job_operation(job)
        except Exception as exc:
            if group.batch and self._should_retry_throttled_job(job, exc):
                retry_delay = self._retry_delay_for_attempt(job.attempt)
                if retry_delay > 0:
                    retry_job = self._clone_job_for_retry(job)
                else:
                    error_message = f"{job.item['path']}: {exc}"
            elif group.batch:
                error_message = f"{job.item['path']}: {exc}"
            else:
                error_message = str(exc)
        finalize: tuple[SyncGroup, list[str]] | None = None
        with self._lock:
            group = self._groups.get(job.op_id)
            if group is None:
                return
            group.running = max(0, group.running - 1)
            if retry_job is not None:
                group.pending_retries += 1
            else:
                group.completed += 1
                group.touched_parents.add(job.parent_rel)
                if job.kind in {"local_dir_to_dropbox", "dropbox_dir_to_local"}:
                    group.touched_parents.add(job.item["path"])
                if error_message is not None:
                    group.errors.append(error_message)
            if self._group_is_complete(group):
                finalize = (group, sorted(group.touched_parents, key=str.casefold))
                self._groups.pop(job.op_id, None)
            elif retry_job is not None:
                syncstate.update(
                    job.op_id,
                    message=f"Retrying throttled Dropbox writes ({group.pending_retries} pending)",
                    command=f"{retry_job.command} (retry {retry_job.attempt}/{self._max_throttle_attempts()} in {retry_delay:.2f}s)",
                    percent=int(group.completed / group.total * 100),
                    current=self._current_progress(group),
                    total=group.total,
                    errors=list(group.errors),
                )
            else:
                syncstate.update(
                    job.op_id,
                    percent=int(group.completed / group.total * 100),
                    current=self._current_progress(group),
                    total=group.total,
                    errors=list(group.errors),
                )
        if retry_job is not None:
            self._schedule_retry(retry_job, retry_delay)
        if finalize is not None:
            group, parents = finalize
            self.app.invalidate_sync_parents(parents)
            if group.errors:
                if group.batch:
                    syncstate.update(job.op_id, errors=list(group.errors))
                    syncstate.complete(job.op_id, f"Batch complete with {len(group.errors)} error(s)")
                else:
                    syncstate.fail(job.op_id, group.errors[0])
            else:
                syncstate.complete(job.op_id, group.success_message)

    def _progress_text(self, op_id: str) -> str:
        with self._lock:
            group = self._groups.get(op_id)
            if group is None:
                op = syncstate.get(op_id) or {}
                return f"{int(op.get('current') or 0)}/{int(op.get('total') or 0)}]"
            current = self._current_progress(group)
            return f"{current}/{group.total}]"

    def _current_progress(self, group: SyncGroup) -> int:
        return min(group.total, group.completed + group.running + group.pending_retries)

    def _group_is_complete(self, group: SyncGroup) -> bool:
        return group.completed >= group.total and group.running == 0 and group.pending_retries == 0

    def _should_retry_throttled_job(self, job: SyncJob, exc: Exception) -> bool:
        return (
            job.kind == "local_to_dropbox"
            and is_retryable_dropbox_throttle_error(exc)
            and job.attempt < self._max_throttle_attempts()
        )

    def _retry_delay_for_attempt(self, attempt: int) -> float:
        delays = self.throttle_retry_delays or ()
        if not delays:
            return 0.0
        index = min(max(0, attempt - 1), len(delays) - 1)
        return float(delays[index])

    def _max_throttle_attempts(self) -> int:
        return max(1, len(self.throttle_retry_delays) + 1)

    def _clone_job_for_retry(self, job: SyncJob) -> SyncJob:
        with self._lock:
            self._submit_order += 1
            submit_order = self._submit_order
        return SyncJob(
            priority_rank=job.priority_rank,
            phase_rank=job.phase_rank,
            depth_rank=job.depth_rank,
            submit_order=submit_order,
            op_id=job.op_id,
            kind=job.kind,
            item=job.item,
            message=job.message,
            command=job.command,
            parent_rel=job.parent_rel,
            attempt=job.attempt + 1,
        )

    def _schedule_retry(self, job: SyncJob, delay: float) -> None:
        timer = threading.Timer(delay, self._enqueue_retry_job, args=(job,))
        timer.daemon = True
        with self._lock:
            if self._shutdown:
                return
            self._retry_timers.add(timer)
        timer.start()

    def _enqueue_retry_job(self, job: SyncJob) -> None:
        with self._lock:
            self._retry_timers = {timer for timer in self._retry_timers if timer.is_alive()}
            group = self._groups.get(job.op_id)
            if group is None or self._shutdown:
                return
            group.pending_retries = max(0, group.pending_retries - 1)
        self._queue.put(job)

    def _execute_job_operation(self, job: SyncJob) -> None:
        if job.kind != "local_dir_to_dropbox":
            self.app.execute_sync_operation(job.kind, job.item)
            return

        local_path = Path(job.item["local_path"])
        if not local_path.is_dir():
            raise BrowserError(HTTPStatus.NOT_FOUND, "Local folder not found.")
        parts = [part for part in job.item["path"].split("/") if part]
        for index in range(1, len(parts) + 1):
            self._ensure_remote_mkdir_once(job.op_id, remote_target(self.app.remote, "/".join(parts[:index])))

    def _ensure_remote_mkdir_once(self, op_id: str, target: str) -> None:
        owner = False
        with self._lock:
            group = self._groups.get(op_id)
            if group is None:
                return
            state = group.remote_mkdirs.get(target)
            if state is None:
                state = RemoteMkdirState()
                group.remote_mkdirs[target] = state
                owner = True

        if owner:
            try:
                self.app.rclone.mkdir(target)
            except Exception as exc:
                state.error = exc
                raise
            finally:
                state.event.set()
            return

        state.event.wait()
        if state.error is not None:
            raise state.error
