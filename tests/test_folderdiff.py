from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from dropbox_browser.folderdiff import (
    DIFF_DROPBOX_ONLY,
    DIFF_HAS_DIFFS,
    DIFF_SYNCED,
    LocalChild,
    compare_direct_children,
    enumerate_local_children,
)


def remote_file(name: str, size: int) -> dict:
    return {"Name": name, "Path": name, "IsDir": False, "Size": size}


def remote_dir(name: str) -> dict:
    return {"Name": name, "Path": name, "IsDir": True, "Size": 0}


class FolderDiffTests(unittest.TestCase):
    def test_enumerate_local_children_filters_ignored_names_and_captures_file_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "song.mp3").write_bytes(b"audio")
            (root / ".DS_Store").write_bytes(b"ignored")
            (root / "nested").mkdir()

            snapshot = enumerate_local_children(root)

        self.assertTrue(snapshot.folder_exists)
        self.assertEqual(sorted(snapshot.children), ["nested", "song.mp3"])
        self.assertEqual(snapshot.children["nested"].path, root / "nested")
        self.assertEqual(snapshot.children["song.mp3"].path, root / "song.mp3")
        self.assertIsNone(snapshot.children["song.mp3"].size)
        self.assertTrue(snapshot.children["song.mp3"].readable)

    def test_enumerate_local_children_reports_missing_folder_without_children(self) -> None:
        snapshot = enumerate_local_children(None)

        self.assertFalse(snapshot.folder_exists)
        self.assertEqual(snapshot.children, {})

    def test_compare_direct_children_marks_synced_files_and_ignores_matching_folders(self) -> None:
        result = compare_direct_children(
            {
                "song.mp3": remote_file("song.mp3", 5),
                "album": remote_dir("album"),
            },
            {
                "song.mp3": LocalChild("song.mp3", is_dir=False, size=5),
                "album": LocalChild("album", is_dir=True),
            },
            local_folder_exists=True,
        )

        self.assertIsNone(result.diff_reason)
        self.assertEqual(result.diff_status, DIFF_SYNCED)
        self.assertEqual(result.file_statuses, {"song.mp3": {"diff_status": DIFF_SYNCED}})

    def test_compare_direct_children_reports_extra_local_file_after_matched_file_syncs(self) -> None:
        result = compare_direct_children(
            {"af_audio_download.py": remote_file("af_audio_download.py", 12)},
            {
                "af_audio_download.py": LocalChild("af_audio_download.py", is_dir=False, size=12),
                "af_audio_download (1).py": LocalChild("af_audio_download (1).py", is_dir=False, size=14),
            },
            local_folder_exists=True,
        )

        self.assertEqual(result.diff_reason, "Local only: af_audio_download (1).py")
        self.assertEqual(result.diff_status, DIFF_HAS_DIFFS)
        self.assertEqual(result.file_statuses["af_audio_download.py"]["diff_status"], DIFF_SYNCED)

    def test_compare_direct_children_reports_local_only_child_when_no_remote_match_exists(self) -> None:
        result = compare_direct_children(
            {},
            {"local-only.txt": LocalChild("local-only.txt", is_dir=False, size=9)},
            local_folder_exists=True,
        )

        self.assertEqual(result.diff_reason, "Local only: local-only.txt")
        self.assertEqual(result.diff_status, DIFF_HAS_DIFFS)
        self.assertEqual(result.file_statuses, {})

    def test_compare_direct_children_reports_dropbox_only_folder_when_local_folder_missing(self) -> None:
        result = compare_direct_children(
            {"only.txt": remote_file("only.txt", 4)},
            {},
            local_folder_exists=False,
        )

        self.assertEqual(result.diff_reason, "Dropbox only")
        self.assertEqual(result.diff_status, DIFF_DROPBOX_ONLY)
        self.assertEqual(result.file_statuses, {})

    def test_compare_direct_children_reports_size_mismatch(self) -> None:
        size_result = compare_direct_children(
            {"changed.txt": remote_file("changed.txt", 99)},
            {"changed.txt": LocalChild("changed.txt", is_dir=False, size=5)},
            local_folder_exists=True,
        )

        self.assertEqual(size_result.diff_reason, "Size differs: changed.txt")
        self.assertEqual(size_result.diff_status, DIFF_HAS_DIFFS)
        self.assertEqual(size_result.file_statuses["changed.txt"]["diff_status"], DIFF_HAS_DIFFS)

    def test_compare_direct_children_reports_same_name_remote_file_local_folder_conflict(self) -> None:
        type_result = compare_direct_children(
            {"conflict.txt": remote_file("conflict.txt", 10)},
            {"conflict.txt": LocalChild("conflict.txt", is_dir=True)},
            local_folder_exists=True,
        )

        self.assertEqual(type_result.diff_reason, "Type differs: conflict.txt")
        self.assertEqual(type_result.diff_status, DIFF_HAS_DIFFS)
        self.assertEqual(type_result.file_statuses["conflict.txt"]["diff_status"], DIFF_HAS_DIFFS)

    def test_compare_direct_children_reports_same_name_remote_folder_local_file_conflict(self) -> None:
        result = compare_direct_children(
            {"conflict": remote_dir("conflict")},
            {"conflict": LocalChild("conflict", is_dir=False, size=10)},
            local_folder_exists=True,
        )

        self.assertEqual(result.diff_reason, "Type differs: conflict")
        self.assertEqual(result.diff_status, DIFF_HAS_DIFFS)
        self.assertEqual(result.file_statuses, {})

    def test_compare_direct_children_reports_unreadable_file_diff(self) -> None:
        unreadable_result = compare_direct_children(
            {"locked.txt": remote_file("locked.txt", 10)},
            {"locked.txt": LocalChild("locked.txt", is_dir=False, readable=False)},
            local_folder_exists=True,
        )

        self.assertEqual(unreadable_result.diff_reason, "Local unreadable: locked.txt")
        self.assertEqual(unreadable_result.file_statuses["locked.txt"]["diff_status"], DIFF_HAS_DIFFS)

    def test_compare_direct_children_uses_windows_safe_name_matching(self) -> None:
        result = compare_direct_children(
            {"Sword of Convallaria: OST.txt": remote_file("Sword of Convallaria: OST.txt", 5)},
            {"Sword of Convallaria_ OST.txt": LocalChild("Sword of Convallaria_ OST.txt", is_dir=False, size=5)},
            local_folder_exists=True,
        )

        self.assertIsNone(result.diff_reason)
        self.assertEqual(result.file_statuses["Sword of Convallaria: OST.txt"]["diff_status"], DIFF_SYNCED)


if __name__ == "__main__":
    unittest.main()
