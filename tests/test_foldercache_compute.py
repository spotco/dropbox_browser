from __future__ import annotations

import unittest
from datetime import datetime, timezone

from dropbox_browser.foldercache_compute import parse_direct_listing


class FolderCacheComputeTests(unittest.TestCase):
    def test_parse_direct_listing_returns_direct_file_totals_and_newest_mtime(self) -> None:
        result = parse_direct_listing(
            [
                {
                    "Name": "small.txt",
                    "Path": "small.txt",
                    "IsDir": False,
                    "Size": 5,
                    "ModTime": "2024-01-01T00:00:00Z",
                },
                {
                    "Name": "empty.txt",
                    "Path": "empty.txt",
                    "IsDir": False,
                    "Size": 0,
                    "ModTime": "2024-01-03T00:00:00Z",
                },
                {
                    "Name": "negative.txt",
                    "Path": "negative.txt",
                    "IsDir": False,
                    "Size": -7,
                    "ModTime": "2024-01-02T00:00:00Z",
                },
            ],
            "dropbox:",
        )

        self.assertEqual(result.direct_size, 5)
        self.assertEqual(result.direct_count, 3)
        self.assertEqual(
            result.direct_mtime,
            datetime(2024, 1, 3, tzinfo=timezone.utc).timestamp(),
        )
        self.assertEqual(list(result.remote_children), ["small.txt", "empty.txt", "negative.txt"])
        self.assertEqual(
            result.direct_files,
            [
                {
                    "name": "small.txt",
                    "path": "small.txt",
                    "remote_path": "dropbox:small.txt",
                    "extension": ".txt",
                    "size": 5,
                    "mtime": datetime(2024, 1, 1, tzinfo=timezone.utc).timestamp(),
                },
                {
                    "name": "empty.txt",
                    "path": "empty.txt",
                    "remote_path": "dropbox:empty.txt",
                    "extension": ".txt",
                    "size": 0,
                    "mtime": datetime(2024, 1, 3, tzinfo=timezone.utc).timestamp(),
                },
                {
                    "name": "negative.txt",
                    "path": "negative.txt",
                    "remote_path": "dropbox:negative.txt",
                    "extension": ".txt",
                    "size": -7,
                    "mtime": datetime(2024, 1, 2, tzinfo=timezone.utc).timestamp(),
                },
            ],
        )
        self.assertEqual(result.direct_folders, [])

    def test_parse_direct_listing_builds_root_and_nested_subfolder_paths(self) -> None:
        root_result = parse_direct_listing(
            [
                {"Name": "Music", "Path": "Music", "IsDir": True, "Size": 0},
                {"Name": "Photos", "Path": "Photos", "IsDir": True, "Size": 0},
            ],
            "dropbox:",
        )
        nested_result = parse_direct_listing(
            [
                {"Name": "Disc 1", "Path": "Disc 1", "IsDir": True, "Size": 0},
            ],
            "dropbox:Music",
        )

        self.assertEqual(root_result.subfolders, ["dropbox:Music", "dropbox:Photos"])
        self.assertEqual(
            root_result.direct_folders,
            [
                {"name": "Music", "path": "Music", "remote_path": "dropbox:Music", "mtime": None},
                {"name": "Photos", "path": "Photos", "remote_path": "dropbox:Photos", "mtime": None},
            ],
        )
        self.assertEqual(nested_result.subfolders, ["dropbox:Music/Disc 1"])
        self.assertEqual(nested_result.direct_folders[0]["remote_path"], "dropbox:Music/Disc 1")
        self.assertEqual(root_result.direct_size, 0)
        self.assertEqual(root_result.direct_count, 0)

    def test_parse_direct_listing_filters_ignored_empty_and_non_direct_names(self) -> None:
        result = parse_direct_listing(
            [
                {"Name": "", "Path": "", "IsDir": False, "Size": 10},
                {"Name": ".DS_Store", "Path": ".DS_Store", "IsDir": False, "Size": 10},
                {"Name": "nested/file.txt", "Path": "nested/file.txt", "IsDir": False, "Size": 10},
                {"Name": "song.mp3", "Path": "song.mp3", "IsDir": False, "Size": 11},
            ],
            "dropbox:music",
        )

        self.assertEqual(result.direct_size, 11)
        self.assertEqual(result.direct_count, 1)
        self.assertEqual(result.subfolders, [])
        self.assertEqual(list(result.remote_children), ["song.mp3"])
        self.assertEqual(result.direct_files[0]["remote_path"], "dropbox:music/song.mp3")
        self.assertEqual(result.direct_folders, [])

    def test_parse_direct_listing_uses_path_as_name_fallback_for_remote_children(self) -> None:
        result = parse_direct_listing(
            [
                {"Path": "fallback.txt", "IsDir": False, "Size": 12},
                {"Path": "folder", "IsDir": True, "Size": 0},
            ],
            "dropbox:",
        )

        self.assertEqual(result.direct_size, 12)
        self.assertEqual(result.direct_count, 1)
        self.assertEqual(result.subfolders, ["dropbox:folder"])
        self.assertEqual(list(result.remote_children), ["fallback.txt", "folder"])
        self.assertEqual(result.direct_files[0]["name"], "fallback.txt")
        self.assertEqual(result.direct_folders[0]["name"], "folder")


if __name__ == "__main__":
    unittest.main()
