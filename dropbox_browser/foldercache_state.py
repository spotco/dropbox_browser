"""In-memory aggregation state for recursive folder-cache metadata."""
from __future__ import annotations

from collections.abc import Callable

from .folderdiff import DIFF_DROPBOX_ONLY, DIFF_HAS_DIFFS


class FolderAccumulationState:
    """Track subtree totals and propagate child updates to parents.

    The manager still owns locking, worker scheduling, cancellation, cache file
    paths, and completion policy. This object owns the aggregation dictionaries
    and the mechanics of pushing child state upward.
    """

    def __init__(
        self,
        *,
        direct_done: dict[str, float],
        abandoned: set[str],
        write_cache: Callable[[str, bool], None],
        note_diff: Callable[[str, str, str], None],
        maybe_complete: Callable[[str], None],
    ) -> None:
        self.direct_done = direct_done
        self.abandoned = abandoned
        self.write_cache = write_cache
        self.note_diff = note_diff
        self.maybe_complete = maybe_complete
        self.acc: dict[str, dict] = {}
        self.pending_children: dict[str, set[str]] = {}
        self.parent: dict[str, str] = {}
        self.child_contrib: dict[str, dict] = {}

    def has_diff_ancestor(self, path: str) -> bool:
        current: str | None = path
        while current:
            if self.acc.get(current, {}).get("diff_status") in {DIFF_HAS_DIFFS, DIFF_DROPBOX_ONLY}:
                return True
            current = self.parent.get(current)
        return False

    def propagate(self, path: str) -> None:
        """Push this path's accumulated delta to its parent and recurse up."""
        parent = self.parent.get(path)
        if parent is None or parent not in self.acc:
            return

        old = self.child_contrib.get(path, {"size": 0, "count": 0, "mtime": None})
        new = self.acc[path]

        delta_size = new["size"] - old["size"]
        delta_count = new["count"] - old["count"]

        if delta_size == 0 and delta_count == 0 and new["mtime"] == old["mtime"]:
            return

        self.child_contrib[path] = {"size": new["size"], "count": new["count"], "mtime": new["mtime"]}

        parent_acc = self.acc[parent]
        parent_acc["size"] += delta_size
        parent_acc["count"] += delta_count
        if new["mtime"] is not None and (parent_acc["mtime"] is None or new["mtime"] > parent_acc["mtime"]):
            parent_acc["mtime"] = new["mtime"]

        parent_complete = (
            parent in self.direct_done
            and not self.pending_children.get(parent)
            and parent not in self.abandoned
        )
        self.write_cache(parent, parent_complete)
        self.propagate(parent)

    def on_subtree_complete(self, path: str) -> None:
        """Mark this path's subtree done; propagate completeness upward."""
        parent = self.parent.get(path)
        if parent is None:
            return
        pending = self.pending_children.get(parent)
        if pending is None:
            return
        pending.discard(path)
        if self.acc.get(path, {}).get("diff_status") in {DIFF_HAS_DIFFS, DIFF_DROPBOX_ONLY}:
            self.note_diff(parent, self.acc[path].get("first_diff_path") or path, DIFF_HAS_DIFFS)
        if parent in self.direct_done and not pending:
            if parent in self.abandoned:
                self.write_cache(parent, False)
                return
            self.maybe_complete(parent)
