"""Hardcoded Dropbox/local file names that should never appear in listings."""
from __future__ import annotations


IGNORED_NAMES = frozenset({
    ".ds_store",
    "thumbs.db",
    "desktop.ini",
    "ehthumbs.db",
})


def is_ignored_name(name: str) -> bool:
    normalized = name.casefold()
    return normalized in IGNORED_NAMES or normalized.startswith("._")
