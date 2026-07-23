from __future__ import annotations

import argparse
import sys
import unittest


GROUPS: dict[str, list[str]] = {
    "web": ["tests.test_web_ui"],
    "ui": ["tests.test_web_ui"],
    "javascript": ["tests.test_web_ui"],
    "music": ["tests.test_music_endpoints", "tests.test_media_library"],
    "music-endpoints": ["tests.test_music_endpoints", "tests.test_media_library"],
    "webpage": ["tests.test_web_ui"],
    "streaming": ["tests.test_streaming", "tests.test_streaming_http"],
    "streaming-http": ["tests.test_streaming_http"],
    "file-sync": ["tests.test_sync_routes", "tests.test_syncjobs"],
    "sync": ["tests.test_sync_routes", "tests.test_syncjobs"],
    "sync-routes": ["tests.test_sync_routes"],
    "sync-jobs": ["tests.test_syncjobs"],
    "background": ["tests.test_folder_info_workers"],
    "background-file-info": ["tests.test_folder_info_workers"],
    "folder-info": ["tests.test_folder_info_workers"],
    "foldercache": ["tests.test_folder_info_workers"],
    "foldercache-compute": ["tests.test_foldercache_compute"],
    "foldercache-records": ["tests.test_foldercache_records"],
    "foldercache-state": ["tests.test_foldercache_state"],
    "diff": ["tests.test_folderdiff", "tests.test_diff_status"],
    "folderdiff": ["tests.test_folderdiff"],
    "status": ["tests.test_diff_status"],
    "cache": ["tests.test_cache_invalidation"],
    "photo-map": [
        "tests.test_photo_map_cache",
        "tests.test_photo_map_web",
        "tests.test_config.ConfigDefaultsTests.test_client_log_defaults_are_present",
    ],
    "photo-map-cache": ["tests.test_photo_map_cache"],
    "client-log": ["tests.test_clientlog"],
    "cli": ["tests.test_cli"],
    "names": ["tests.test_listing_merge_names", "tests.test_windows_names"],
    "windows-names": ["tests.test_listing_merge_names", "tests.test_windows_names"],
    "rclone": ["tests.test_rclone"],
    "thumbnails": ["tests.test_thumbnails"],
    "video": ["tests.test_video_endpoints", "tests.test_video_benchmark"],
    "video-endpoints": ["tests.test_video_endpoints"],
}


def _expand_groups(names: list[str]) -> list[str]:
    modules: list[str] = []
    seen: set[str] = set()
    for name in names:
        for part in name.split(","):
            group = part.strip().lower()
            if not group:
                continue
            if group == "all":
                group_modules = sorted({module for values in GROUPS.values() for module in values})
            else:
                try:
                    group_modules = GROUPS[group]
                except KeyError as exc:
                    choices = ", ".join(["all", *sorted(GROUPS)])
                    raise SystemExit(f"Unknown test group {part!r}. Choices: {choices}") from exc
            for module in group_modules:
                if module not in seen:
                    modules.append(module)
                    seen.add(module)
    return modules


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run Dropbox browser unit test groups.")
    parser.add_argument(
        "groups",
        nargs="*",
        help="Test group names. Use commas or pass multiple groups. Defaults to all.",
    )
    parser.add_argument(
        "-g",
        "--group",
        action="append",
        default=[],
        help="Test group name. May be passed more than once.",
    )
    parser.add_argument("--list", action="store_true", help="List available groups and exit.")
    parser.add_argument("-v", "--verbose", action="store_true", help="Use verbose unittest output.")
    args = parser.parse_args(argv)

    if args.list:
        for group in sorted(GROUPS):
            print(f"{group}: {', '.join(GROUPS[group])}")
        return 0

    requested = [*args.group, *args.groups] or ["all"]
    modules = _expand_groups(requested)
    loader = unittest.defaultTestLoader
    suite = unittest.TestSuite(loader.loadTestsFromName(module) for module in modules)
    result = unittest.TextTestRunner(verbosity=2 if args.verbose else 1).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
