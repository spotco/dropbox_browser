from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path
import unicodedata

WINDOWS_INVALID_FILENAME_CHARS = frozenset('<>:"\\|?*')
PRIVATE_USE_START = 0xE000
PRIVATE_USE_END = 0xF8FF


def filename_compare_key(name: str) -> str:
    """Return the exact Unicode-normalized comparison key for a name."""
    return unicodedata.normalize("NFKC", name).casefold()


def _is_private_use(char: str) -> bool:
    codepoint = ord(char)
    return PRIVATE_USE_START <= codepoint <= PRIVATE_USE_END


def _windows_safe_match_score(dropbox_name: str, local_name: str) -> tuple[int, int, int] | None:
    remote = filename_compare_key(dropbox_name)
    local = filename_compare_key(local_name)
    if len(remote) != len(local):
        return None
    underscore_colon_replacements = 0
    private_use_replacements = 0
    total_replacements = 0
    for remote_char, local_char in zip(remote, local):
        if remote_char == local_char:
            continue
        if remote_char == ":" and local_char == "_":
            underscore_colon_replacements += 1
            total_replacements += 1
            continue
        if remote_char in WINDOWS_INVALID_FILENAME_CHARS and _is_private_use(local_char):
            private_use_replacements += 1
            total_replacements += 1
            continue
        return None
    return (underscore_colon_replacements, private_use_replacements, total_replacements)


def dropbox_local_name_equal(dropbox_name: str, local_name: str) -> bool:
    """Return True when a Dropbox name matches a Windows-safe local variant."""
    if filename_compare_key(dropbox_name) == filename_compare_key(local_name):
        return True
    return _windows_safe_match_score(dropbox_name, local_name) is not None


def match_dropbox_names_to_local_names(dropbox_names: Iterable[str], local_names: Iterable[str]) -> dict[str, str]:
    """Return the best Dropbox->local name matches for one folder.

    Exact Unicode-normalized matches win first. Remaining names are paired with a
    constrained Windows-safe fallback matcher so local substitutions for
    Windows-prohibited characters still resolve to the correct Dropbox name.
    """
    remote_list = list(dropbox_names)
    local_list = list(local_names)
    matches: dict[str, str] = {}

    unmatched_remote = set(remote_list)
    unmatched_local = set(local_list)
    local_by_key: dict[str, list[str]] = {}
    for name in local_list:
        local_by_key.setdefault(filename_compare_key(name), []).append(name)

    for remote_name in remote_list:
        bucket = local_by_key.get(filename_compare_key(remote_name)) or []
        for local_name in list(bucket):
            if local_name in unmatched_local:
                matches[remote_name] = local_name
                unmatched_remote.discard(remote_name)
                unmatched_local.discard(local_name)
                break

    candidates: list[tuple[tuple[int, int, int], str, str]] = []
    for remote_name in remote_list:
        if remote_name not in unmatched_remote:
            continue
        for local_name in local_list:
            if local_name not in unmatched_local:
                continue
            score = _windows_safe_match_score(remote_name, local_name)
            if score is not None:
                candidates.append((score, remote_name, local_name))
    candidates.sort(key=lambda item: (item[0], filename_compare_key(item[1]), filename_compare_key(item[2])))
    for _, remote_name, local_name in candidates:
        if remote_name in unmatched_remote and local_name in unmatched_local:
            matches[remote_name] = local_name
            unmatched_remote.remove(remote_name)
            unmatched_local.remove(local_name)
    return matches


def find_matching_local_name(dropbox_name: str, local_names: Iterable[str]) -> str | None:
    """Return the best matching local name for one Dropbox name, if any."""
    return match_dropbox_names_to_local_names([dropbox_name], local_names).get(dropbox_name)


def resolve_matching_local_path(local_root: Path, rel_path: str) -> Path:
    """Resolve a Dropbox-relative path to the best matching local filesystem path."""
    current = local_root
    for part in [part for part in rel_path.split("/") if part]:
        if not current.exists() or not current.is_dir():
            return current / part
        try:
            match_name = find_matching_local_name(part, [child.name for child in current.iterdir()])
        except OSError:
            match_name = None
        current = current / match_name if match_name is not None else current / part
    return current
