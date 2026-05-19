# Windows Name Matching

Read this when changing listing merge, local path resolution, folder-cache child
comparison, sync destination paths, or tests involving Dropbox names that cannot
be represented directly on Windows.

## Core Rule

Local/Dropbox comparisons must use `dropbox_browser.namekeys.filename_compare_key`.
The key applies Unicode NFKC normalization and then `casefold()`.

This makes Dropbox names using ASCII characters compare equal to local Windows
copies that use compatible fullwidth replacements, such as:

- Dropbox `*NSYNC` and local `＊NSYNC`;
- Dropbox `f*ck` and local `f＊ck`.

## Path Safety Rule

When a row matched by filename comparison has an existing local path, do not
reconstruct the local path from the Dropbox display name. Use the actual local
path captured from the filesystem, usually `row["local_path"]`, or resolve each
path segment through the local filesystem with the same comparison behavior.

Otherwise copy/open actions can produce impossible Windows paths such as:

```text
F:\...\*NSYNC - Bye Bye Bye.mp3
```

## Current Helpers

- `dropbox_browser/windows_names.py` contains Windows-safe Dropbox/local name
  matching, fallback comparison, and local path resolution helpers.
- `dropbox_browser/namekeys.py` is a compatibility wrapper for the normalized
  filename comparison key.
- `dropbox_browser/ignored.py` defines metadata/system names hidden from both
  Dropbox and local listings.

Prefer existing helpers over ad hoc string manipulation.

## Known Name Cases

Dropbox names may contain characters Windows cannot store in file names,
especially `*`. Local copies may use visually similar Unicode replacements,
private-use replacement characters, or rename forms such as `:` to `_`.

Regression coverage should include:

- files and folders;
- repeated invalid characters;
- combined invalid characters;
- names surrounded by non-ASCII text;
- page row merge;
- `local_display_path` resolution;
- folder-cache diff status.

## Relevant Tests

Run:

```powershell
python -m tests.run names -v
python -m tests.run diff -v
```

If the change affects sync destination resolution, also run:

```powershell
python -m tests.run file-sync -v
```
