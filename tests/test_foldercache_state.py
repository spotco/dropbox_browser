from __future__ import annotations

import unittest

from dropbox_browser.foldercache_state import FolderAccumulationState


class FolderAccumulationStateTests(unittest.TestCase):
    def _build_state(self) -> tuple[FolderAccumulationState, dict, set, list, list, list]:
        direct_done: dict[str, float] = {}
        abandoned: set[str] = set()
        writes: list[tuple[str, bool]] = []
        noted: list[tuple[str, str, str]] = []
        completed: list[str] = []
        state = FolderAccumulationState(
            direct_done=direct_done,
            abandoned=abandoned,
            write_cache=lambda path, complete: writes.append((path, complete)),
            note_diff=lambda path, reason, status: noted.append((path, reason, status)),
            maybe_complete=lambda path: completed.append(path),
        )
        return state, direct_done, abandoned, writes, noted, completed

    def test_propagate_adds_child_delta_to_parent_and_updates_child_contribution(self) -> None:
        state, direct_done, _abandoned, writes, _noted, _completed = self._build_state()
        direct_done["root"] = 1.0
        state.acc["root"] = {"size": 10, "count": 1, "mtime": 5.0}
        state.acc["root/child"] = {"size": 7, "count": 2, "mtime": 9.0}
        state.parent["root/child"] = "root"
        state.pending_children["root"] = set()

        state.propagate("root/child")

        self.assertEqual(state.acc["root"]["size"], 17)
        self.assertEqual(state.acc["root"]["count"], 3)
        self.assertEqual(state.acc["root"]["mtime"], 9.0)
        self.assertEqual(state.child_contrib["root/child"], {"size": 7, "count": 2, "mtime": 9.0})
        self.assertEqual(writes, [("root", True)])

    def test_propagate_uses_deltas_on_repeated_child_updates(self) -> None:
        state, direct_done, _abandoned, writes, _noted, _completed = self._build_state()
        direct_done["root"] = 1.0
        state.acc["root"] = {"size": 10, "count": 1, "mtime": 5.0}
        state.acc["root/child"] = {"size": 7, "count": 2, "mtime": 9.0}
        state.parent["root/child"] = "root"
        state.pending_children["root"] = set()

        state.propagate("root/child")
        state.acc["root/child"] = {"size": 9, "count": 3, "mtime": 9.0}
        state.propagate("root/child")

        self.assertEqual(state.acc["root"]["size"], 19)
        self.assertEqual(state.acc["root"]["count"], 4)
        self.assertEqual(writes, [("root", True), ("root", True)])

    def test_on_subtree_complete_discards_pending_child_and_completes_parent(self) -> None:
        state, direct_done, _abandoned, writes, noted, completed = self._build_state()
        direct_done["root"] = 1.0
        state.acc["root"] = {"size": 0, "count": 0, "mtime": None}
        state.acc["root/child"] = {"size": 0, "count": 0, "mtime": None, "diff_status": "synced"}
        state.parent["root/child"] = "root"
        state.pending_children["root"] = {"root/child"}

        state.on_subtree_complete("root/child")

        self.assertEqual(state.pending_children["root"], set())
        self.assertEqual(writes, [])
        self.assertEqual(noted, [])
        self.assertEqual(completed, ["root"])

    def test_on_subtree_complete_marks_parent_diff_before_completion(self) -> None:
        state, direct_done, _abandoned, _writes, noted, completed = self._build_state()
        direct_done["root"] = 1.0
        state.acc["root"] = {"size": 0, "count": 0, "mtime": None}
        state.acc["root/child"] = {
            "size": 0,
            "count": 0,
            "mtime": None,
            "diff_status": "has_diffs",
            "first_diff_path": "root/child/file.txt",
        }
        state.parent["root/child"] = "root"
        state.pending_children["root"] = {"root/child"}

        state.on_subtree_complete("root/child")

        self.assertEqual(noted, [("root", "root/child/file.txt", "has_diffs")])
        self.assertEqual(completed, ["root"])

    def test_on_subtree_complete_writes_partial_parent_when_parent_is_abandoned(self) -> None:
        state, direct_done, abandoned, writes, _noted, completed = self._build_state()
        direct_done["root"] = 1.0
        abandoned.add("root")
        state.parent["root/child"] = "root"
        state.pending_children["root"] = {"root/child"}

        state.on_subtree_complete("root/child")

        self.assertEqual(writes, [("root", False)])
        self.assertEqual(completed, [])


if __name__ == "__main__":
    unittest.main()
