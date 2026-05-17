"""Parallel sync/delete job queue for browser-triggered file operations.

Design decisions:

- Keep sync/delete work separate from folder metadata workers. Metadata jobs are
  page-driven, cancelable, and read-only; sync/delete jobs are side-effecting
  and should keep running once accepted.
- Use one fixed-size worker pool with one queued job per file/path operation so
  batch sync is no longer single-threaded.
- Preserve one browser-visible operation id per user action. A batch request is
  shown as one operation in ``syncstate`` while many child jobs run underneath.
- Give single-file sync requests higher priority than batch jobs. Recursive
  delete jobs still run safely by deleting files before directories and deeper
  directories before their parents.
- Keep logging/error handling uniform across all sync/delete work by driving
  browser progress and completion from this manager rather than raw threads in
  request handlers.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any
import threading

from .priorityqueue import PriorityQueue
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


@dataclass
class SyncGroup:
    total: int
    batch: bool
    success_message: str
    completed: int = 0
    running: int = 0
    errors: list[str] = field(default_factory=list)
    touched_parents: set[str] = field(default_factory=set)


def _job_message(kind: str, item: dict[str, str]) -> tuple[str, str]:
    rel_path = item["path"]
    local_path = item["local_path"]
    remote_path = item["remote_path"]
    if kind == "local_to_dropbox":
        return (
            f"Copying local to Dropbox: {rel_path}",
            f"rclone copyto -- {local_path} {remote_path}",
        )
    if kind == "dropbox_to_local":
        return (
            f"Copying Dropbox to local: {rel_path}",
            f"rclone copyto -- {remote_path} {local_path}",
        )
    return (
        f"Deleting local-only item: {rel_path}",
        f"delete local -- {local_path}",
    )


class SyncJobManager:
    def __init__(self, app: "DropboxBrowser", workers: int):
        self.app = app
        self._queue: PriorityQueue = PriorityQueue()
        self._lock = threading.Lock()
        self._submit_order = 0
        self._groups: dict[str, SyncGroup] = {}
        worker_count = max(1, workers)
        for index in range(worker_count):
            threading.Thread(
                target=self._worker,
                daemon=True,
                name=f"sync-job-worker-{index + 1}",
            ).start()

    def submit(self, label: str, operations: list[tuple[str, dict[str, str]]], *, batch: bool, success_message: str) -> str:
        op_id = syncstate.start(label)
        total = len(operations)
        syncstate.update(op_id, percent=0, total=total, errors=[])
        if total == 0:
            syncstate.complete(op_id, success_message)
            return op_id
        jobs: list[SyncJob] = []
        with self._lock:
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
        local_path = Path(item["local_path"])
        if kind == "delete_local" and local_path.is_dir():
            phase_rank = 1
            depth_rank = -len(Path(item["path"]).parts)
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
                self._run_job(job)
            finally:
                self._queue.task_done()

    def _run_job(self, job: SyncJob) -> None:
        with self._lock:
            group = self._groups.get(job.op_id)
            if group is None:
                return
            group.running += 1
            current = min(group.completed + group.running, group.total)
            syncstate.update(
                job.op_id,
                message=job.message,
                command=job.command,
                percent=int(group.completed / group.total * 100) if group.total else 100,
                current=current,
                total=group.total,
                errors=list(group.errors),
            )
        error_message: str | None = None
        try:
            self.app.execute_sync_operation(job.kind, job.item)
        except Exception as exc:
            if group.batch:
                error_message = f"{job.item['path']}: {exc}"
            else:
                error_message = str(exc)
        finalize: tuple[SyncGroup, list[str]] | None = None
        with self._lock:
            group = self._groups.get(job.op_id)
            if group is None:
                return
            group.running = max(0, group.running - 1)
            group.completed += 1
            group.touched_parents.add(job.parent_rel)
            if error_message is not None:
                group.errors.append(error_message)
            if group.completed >= group.total:
                finalize = (group, sorted(group.touched_parents, key=str.casefold))
                self._groups.pop(job.op_id, None)
            else:
                syncstate.update(
                    job.op_id,
                    percent=int(group.completed / group.total * 100),
                    current=min(group.completed + group.running, group.total),
                    total=group.total,
                    errors=list(group.errors),
                )
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
