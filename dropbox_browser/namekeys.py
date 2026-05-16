from __future__ import annotations

import unicodedata


def filename_compare_key(name: str) -> str:
    """Return the key used when comparing Dropbox and local filenames.

    Windows cannot store characters such as ``*`` in local filenames. Tools
    commonly replace them with fullwidth Unicode characters, so normalize with
    NFKC before case folding to compare those round-tripped names consistently.
    """
    return unicodedata.normalize("NFKC", name).casefold()
