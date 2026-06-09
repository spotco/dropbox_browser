#!/usr/bin/env python3
"""Report and optionally rewrite playlist entries against a local Dropbox root."""

from __future__ import annotations

import argparse
from collections import defaultdict
from pathlib import Path
import sys


WORKSPACE_ROOT = Path(__file__).resolve().parent.parent
if str(WORKSPACE_ROOT) not in sys.path:
    sys.path.insert(0, str(WORKSPACE_ROOT))

from dropbox_browser.windows_names import filename_compare_key, resolve_matching_local_path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Scan .m3u8 playlists and report songs whose Dropbox-relative paths "
            "do not resolve beneath a local Dropbox root."
        )
    )
    parser.add_argument(
        "playlist_path",
        help="Playlist file or directory to scan.",
    )
    parser.add_argument(
        "--local-root",
        required=True,
        help="Local Dropbox root directory used to resolve playlist entries.",
    )
    parser.add_argument(
        "--match-filename",
        action="store_true",
        help=(
            "When the original relative path is missing, try to find an existing file "
            "anywhere under the local root with the same filename."
        ),
    )
    parser.add_argument(
        "--rewrite-found",
        action="store_true",
        help=(
            "Rewrite playlist entries in place to the actual Dropbox-relative path "
            "resolved under the local root."
        ),
    )
    return parser.parse_args()


def iter_playlist_files(raw_path: str) -> list[Path]:
    path = Path(raw_path)
    if path.is_dir():
        return sorted(child for child in path.rglob("*.m3u8") if child.is_file())
    if path.is_file() and path.suffix.casefold() == ".m3u8":
        return [path]
    return []


def playlist_entry_to_rel_path(entry: str) -> str:
    return entry.replace("\\", "/").lstrip("/")


def local_path_to_playlist_entry(local_root: Path, local_path: Path) -> str:
    return "/" + local_path.relative_to(local_root).as_posix()


def build_filename_index(local_root: Path) -> dict[str, list[Path]]:
    index: dict[str, list[Path]] = defaultdict(list)
    for path in local_root.rglob("*"):
        if not path.is_file():
            continue
        index[filename_compare_key(path.name)].append(path)
    for matches in index.values():
        matches.sort(
            key=lambda path: (
                len(path.relative_to(local_root).parts),
                path.relative_to(local_root).as_posix().casefold(),
            )
        )
    return dict(index)


def find_filename_match(
    local_root: Path,
    rel_path: str,
    filename_index: dict[str, list[Path]] | None,
) -> Path | None:
    if filename_index is None:
        return None
    filename = Path(rel_path).name
    if not filename:
        return None
    matches = filename_index.get(filename_compare_key(filename)) or []
    for match in matches:
        try:
            match.relative_to(local_root)
        except ValueError:
            continue
        if match.exists():
            return match
    return None


def resolve_entry_path(
    local_root: Path,
    entry: str,
    filename_index: dict[str, list[Path]] | None,
) -> tuple[Path | None, bool]:
    rel_path = playlist_entry_to_rel_path(entry)
    local_path = resolve_matching_local_path(local_root, rel_path)
    if local_path.exists():
        return local_path, False
    filename_match = find_filename_match(local_root, rel_path, filename_index)
    if filename_match is not None:
        return filename_match, True
    return None, False


def scan_playlist_lines(text: str) -> list[tuple[str, str, str]]:
    scanned: list[tuple[str, str, str]] = []
    for line in text.splitlines(keepends=True):
        content = line.rstrip("\r\n")
        newline = line[len(content):]
        scanned.append((line, content, newline))
    return scanned


def rewrite_playlist_file(
    playlist_path: Path,
    local_root: Path,
    filename_index: dict[str, list[Path]] | None,
) -> tuple[int, int]:
    original = playlist_path.read_text(encoding="utf-8")
    rewritten_lines: list[str] = []
    rewritten_entries = 0
    rewritten_by_filename = 0
    for line, content, newline in scan_playlist_lines(original):
        stripped = content.strip()
        if not stripped or stripped.startswith("#"):
            rewritten_lines.append(line)
            continue
        resolved_path, matched_by_filename = resolve_entry_path(local_root, stripped, filename_index)
        if resolved_path is None:
            rewritten_lines.append(line)
            continue
        rewritten_entry = local_path_to_playlist_entry(local_root, resolved_path)
        if rewritten_entry != content:
            rewritten_entries += 1
            if matched_by_filename:
                rewritten_by_filename += 1
        rewritten_lines.append(rewritten_entry + newline)
    rewritten = "".join(rewritten_lines)
    if rewritten != original:
        playlist_path.write_text(rewritten, encoding="utf-8")
    return rewritten_entries, rewritten_by_filename


def rewrite_playlist_files(
    playlist_files: list[Path],
    local_root: Path,
    match_filename: bool,
) -> tuple[int, int, int]:
    updated_files = 0
    rewritten_entries = 0
    rewritten_by_filename = 0
    filename_index = build_filename_index(local_root) if match_filename else None
    for playlist_path in playlist_files:
        file_rewrites, file_rewrites_by_filename = rewrite_playlist_file(
            playlist_path,
            local_root,
            filename_index,
        )
        if file_rewrites == 0:
            continue
        updated_files += 1
        rewritten_entries += file_rewrites
        rewritten_by_filename += file_rewrites_by_filename
    return updated_files, rewritten_entries, rewritten_by_filename


def find_missing_entries(
    playlist_files: list[Path],
    local_root: Path,
    match_filename: bool,
) -> tuple[dict[str, list[str]], int, int]:
    missing_by_song: dict[str, list[str]] = defaultdict(list)
    checked_entries = 0
    recovered_by_filename = 0
    filename_index = build_filename_index(local_root) if match_filename else None
    for playlist_path in playlist_files:
        text = playlist_path.read_text(encoding="utf-8")
        for line, content, _newline in scan_playlist_lines(text):
            _ = line
            stripped = content.strip()
            if not stripped or stripped.startswith("#"):
                continue
            checked_entries += 1
            resolved_path, matched_by_filename = resolve_entry_path(local_root, stripped, filename_index)
            if resolved_path is not None:
                if matched_by_filename:
                    recovered_by_filename += 1
                continue
            missing_by_song[stripped].append(str(playlist_path))
    return dict(sorted(missing_by_song.items())), checked_entries, recovered_by_filename


def main() -> int:
    args = parse_args()
    playlist_files = iter_playlist_files(args.playlist_path)
    if not playlist_files:
        print("No .m3u8 files found.")
        return 1
    local_root = Path(args.local_root)
    if args.rewrite_found:
        updated_files, rewritten_entries, rewritten_by_filename = rewrite_playlist_files(
            playlist_files,
            local_root,
            args.match_filename,
        )
        print(f"Updated playlist files: {updated_files}")
        print(f"Rewritten playlist entries: {rewritten_entries}")
        if args.match_filename:
            print(f"Rewritten by filename fallback: {rewritten_by_filename}")
    missing_by_song, checked_entries, recovered_by_filename = find_missing_entries(
        playlist_files,
        local_root,
        args.match_filename,
    )
    missing_references = sum(len(playlist_paths) for playlist_paths in missing_by_song.values())
    print(f"Scanned {len(playlist_files)} playlist file(s) and {checked_entries} song entries.")
    if args.match_filename:
        print(f"Recovered by filename fallback: {recovered_by_filename}")
    print(f"Missing unique songs: {len(missing_by_song)}")
    print(f"Missing playlist references: {missing_references}")
    if not missing_by_song:
        return 0
    for entry, playlist_paths in missing_by_song.items():
        print(entry)
        for playlist_path in sorted(set(playlist_paths)):
            print(f"  referenced by: {playlist_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
