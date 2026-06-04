from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path
import unicodedata

WINDOWS_INVALID_FILENAME_CHARS = frozenset('<>:"\\|?*')
RCLONE_LITERAL_ESCAPE = "\u201b"
PRIVATE_USE_START = 0xE000
PRIVATE_USE_END = 0xF8FF


def filename_compare_key(name: str) -> str:
    """Return the exact Unicode-normalized comparison key for a name."""
    return unicodedata.normalize("NFKC", name).casefold()


def decode_rclone_literal_escapes(name: str) -> str:
    """Decode rclone's Windows literal marker in one filename segment.

    Rclone prefixes a literal fullwidth/compatibility character with ``‛`` when
    that character's normalized form is a Windows-invalid filename character.
    The marker distinguishes a literal Dropbox ``？`` from rclone's encoding of
    Dropbox ASCII ``?`` as local ``？``. Dropbox-facing names should not include
    the marker.
    """
    if RCLONE_LITERAL_ESCAPE not in name:
        return name
    decoded: list[str] = []
    index = 0
    while index < len(name):
        char = name[index]
        if char == RCLONE_LITERAL_ESCAPE and index + 1 < len(name):
            next_char = name[index + 1]
            if filename_compare_key(next_char) in WINDOWS_INVALID_FILENAME_CHARS:
                decoded.append(next_char)
                index += 2
                continue
        decoded.append(char)
        index += 1
    return "".join(decoded)


def decode_rclone_literal_escapes_path(rel_path: str) -> str:
    """Decode rclone literal markers in a Dropbox-relative path."""
    return "/".join(decode_rclone_literal_escapes(part) for part in rel_path.split("/"))


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


def _rclone_literal_escape_match_score(dropbox_name: str, local_name: str) -> tuple[int, int, int] | None:
    """Match rclone's Windows escape marker for literal compatibility chars.

    With rclone's default Windows local encoding, remote ASCII ``?`` becomes
    local fullwidth ``？`` while remote literal fullwidth ``？`` becomes local
    ``‛？``. The marker is only accepted when it prefixes the exact Dropbox
    character, which avoids merging a Dropbox ASCII ``?`` with an escaped
    fullwidth local name.
    """
    remote_index = 0
    local_index = 0
    escaped_literals = 0
    while remote_index < len(dropbox_name) and local_index < len(local_name):
        local_char = local_name[local_index]
        if local_char == RCLONE_LITERAL_ESCAPE and local_index + 1 < len(local_name):
            escaped_char = local_name[local_index + 1]
            remote_char = dropbox_name[remote_index]
            if (
                remote_char == escaped_char
                and filename_compare_key(escaped_char) in WINDOWS_INVALID_FILENAME_CHARS
            ):
                escaped_literals += 1
                remote_index += 1
                local_index += 2
                continue
            return None
        if filename_compare_key(dropbox_name[remote_index]) != filename_compare_key(local_char):
            return None
        remote_index += 1
        local_index += 1
    if remote_index != len(dropbox_name) or local_index != len(local_name) or escaped_literals == 0:
        return None
    return (0, 0, escaped_literals)


def dropbox_local_name_equal(dropbox_name: str, local_name: str) -> bool:
    """Return True when a Dropbox name matches a Windows-safe local variant."""
    if filename_compare_key(dropbox_name) == filename_compare_key(local_name):
        return True
    return (
        _windows_safe_match_score(dropbox_name, local_name) is not None
        or _rclone_literal_escape_match_score(dropbox_name, local_name) is not None
    )


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
            if local_name == remote_name and local_name in unmatched_local:
                matches[remote_name] = local_name
                unmatched_remote.discard(remote_name)
                unmatched_local.discard(local_name)
                break
        if remote_name not in unmatched_remote:
            continue
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
            score = (
                _windows_safe_match_score(remote_name, local_name)
                or _rclone_literal_escape_match_score(remote_name, local_name)
            )
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
        exact_path = current / part
        if exact_path.exists():
            current = exact_path
            continue
        try:
            match_name = find_matching_local_name(part, [child.name for child in current.iterdir()])
        except OSError:
            match_name = None
        current = current / match_name if match_name is not None else current / part
    return current
