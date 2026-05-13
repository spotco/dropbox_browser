"""Inspectable priority queue backed by heapq.

Matches the subset of queue.PriorityQueue used in this project and adds
count_matching() so callers can query how many items satisfy a predicate
without draining the queue.
"""
from __future__ import annotations

import heapq
import threading
from typing import Any, Callable


class PriorityQueue:
    """Thread-safe priority queue.  Items must be comparable (e.g. tuples)."""

    def __init__(self) -> None:
        self._heap: list[Any] = []
        self._lock = threading.Lock()
        self._not_empty = threading.Condition(self._lock)
        self._unfinished = 0

    # ------------------------------------------------------------------
    # Core queue.PriorityQueue-compatible interface
    # ------------------------------------------------------------------

    def put(self, item: Any) -> None:
        """Add an item (non-blocking; this queue is unbounded)."""
        with self._not_empty:
            heapq.heappush(self._heap, item)
            self._unfinished += 1
            self._not_empty.notify()

    def get(self) -> Any:
        """Remove and return the lowest-priority item, blocking until available."""
        with self._not_empty:
            while not self._heap:
                self._not_empty.wait()
            return heapq.heappop(self._heap)

    def task_done(self) -> None:
        """Signal that a previously get()ted item has been processed."""
        with self._lock:
            self._unfinished = max(0, self._unfinished - 1)

    def empty(self) -> bool:
        with self._lock:
            return len(self._heap) == 0

    def qsize(self) -> int:
        with self._lock:
            return len(self._heap)

    # ------------------------------------------------------------------
    # Extension: inspect without draining
    # ------------------------------------------------------------------

    def count_matching(self, predicate: Callable[[Any], bool]) -> int:
        """Return the number of queued items for which predicate returns True."""
        with self._lock:
            return sum(1 for item in self._heap if predicate(item))

    def remove_matching(self, predicate: Callable[[Any], bool]) -> list[Any]:
        """Remove and return queued items for which predicate returns True."""
        with self._not_empty:
            removed = [item for item in self._heap if predicate(item)]
            if not removed:
                return []
            self._heap = [item for item in self._heap if not predicate(item)]
            heapq.heapify(self._heap)
            self._unfinished = max(0, self._unfinished - len(removed))
            return removed
