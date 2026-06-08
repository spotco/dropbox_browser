#!/usr/bin/env python3
"""Rewrite Android music playlist prefixes into music-player import paths."""

from __future__ import annotations

import argparse
from pathlib import Path


DEFAULT_SOURCE_PREFIXES = (
    "/storage/3935-3838/Music",
    "/storage/3935-3838/music",
)
DEFAULT_TARGET_PREFIX = "/music"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Rewrite .m3u8 playlist entry prefixes from Android storage paths "
            "to importable music-player paths."
        )
    )
    parser.add_argument(
        "paths",
        nargs="+",
        help="Playlist files or directories to process.",
    )
    parser.add_argument(
        "--from-prefix",
        dest="from_prefixes",
        action="append",
        default=[],
        help=(
            "Source prefix to rewrite. Repeat to allow multiple prefixes. "
            f"Defaults to: {', '.join(DEFAULT_SOURCE_PREFIXES)}"
        ),
    )
    parser.add_argument(
        "--to-prefix",
        default=DEFAULT_TARGET_PREFIX,
        help=f"Target prefix to write. Default: {DEFAULT_TARGET_PREFIX}",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report pending changes without writing files.",
    )
    return parser.parse_args()


def iter_playlist_files(raw_paths: list[str]) -> list[Path]:
    files: list[Path] = []
    for raw_path in raw_paths:
        path = Path(raw_path)
        if path.is_dir():
            files.extend(sorted(child for child in path.rglob("*.m3u8") if child.is_file()))
        elif path.is_file() and path.suffix.casefold() == ".m3u8":
            files.append(path)
    seen: set[Path] = set()
    unique_files: list[Path] = []
    for path in files:
        resolved = path.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        unique_files.append(path)
    return unique_files


def rewrite_entry(entry: str, from_prefixes: tuple[str, ...], to_prefix: str) -> tuple[str, bool]:
    for prefix in from_prefixes:
        if entry.startswith(prefix + "/"):
            return to_prefix.rstrip("/") + entry[len(prefix):], True
        if entry == prefix:
            return to_prefix, True
    return entry, False


def rewrite_playlist_text(text: str, from_prefixes: tuple[str, ...], to_prefix: str) -> tuple[str, int]:
    changed_lines = 0
    rewritten_lines: list[str] = []
    for line in text.splitlines(keepends=True):
        content = line.rstrip("\r\n")
        newline = line[len(content):]
        stripped = content.strip()
        if not stripped or stripped.startswith("#"):
            rewritten_lines.append(line)
            continue
        rewritten, changed = rewrite_entry(content, from_prefixes, to_prefix)
        if changed:
            changed_lines += 1
        rewritten_lines.append(rewritten + newline)
    return "".join(rewritten_lines), changed_lines


def process_file(path: Path, from_prefixes: tuple[str, ...], to_prefix: str, dry_run: bool) -> tuple[int, bool]:
    original = path.read_text(encoding="utf-8")
    rewritten, changed_lines = rewrite_playlist_text(original, from_prefixes, to_prefix)
    changed = rewritten != original
    if changed and not dry_run:
        path.write_text(rewritten, encoding="utf-8")
    return changed_lines, changed


def main() -> int:
    args = parse_args()
    from_prefixes = tuple(args.from_prefixes or DEFAULT_SOURCE_PREFIXES)
    files = iter_playlist_files(args.paths)
    if not files:
        print("No .m3u8 files found.")
        return 1

    touched_files = 0
    touched_lines = 0
    for path in files:
        changed_lines, changed = process_file(path, from_prefixes, args.to_prefix, args.dry_run)
        if changed:
            touched_files += 1
            touched_lines += changed_lines
            status = "would update" if args.dry_run else "updated"
            print(f"{status}: {path} ({changed_lines} line{'s' if changed_lines != 1 else ''})")
        else:
            print(f"unchanged: {path}")

    summary_status = "Would update" if args.dry_run else "Updated"
    print(f"{summary_status} {touched_files} file(s); rewrote {touched_lines} playlist line(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
