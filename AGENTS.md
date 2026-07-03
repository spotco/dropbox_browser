## Overview

This is a dependency-free Python Dropbox browser/downloader. It runs a local
stdlib HTTP server and shells out to `rclone` for Dropbox access.

Start locally:

```powershell
python dropbox_browser.py --remote dropbox:
```

Default URL:

```text
http://127.0.0.1:8000/
```

## Read Before Editing

Load only the doc that matches the work:

- Background folder metadata, diff status, worker traces, sync queues:
  `docs/background-workers.md`.
- Windows-safe Dropbox/local name matching:
  `docs/windows-name-matching.md`.
- Regression workflow and test groups: `docs/testing.md`.
- High-level behavior and ownership map: `docs/architecture.md`.
- Video player server endpoints, HLS sessions, and client modules:
  `docs/video-player.md`.

## Repository Map

- `dropbox_browser.py` - compatibility entry point.
- `dropbox_browser/cli.py` - args and HTTP server startup.
- `dropbox_browser/config.py` - config paths, rclone discovery, temp/cache paths.
- `dropbox_browser/handlers.py` - HTTP routes and response streaming.
- `dropbox_browser/services.py` - listing merge, sorting, sync planning, status decisions.
- `dropbox_browser/foldercache.py` - background recursive folder metadata and diff cache.
- `dropbox_browser/syncjobs.py` - browser-triggered sync/delete worker queue.
- `dropbox_browser/rclone.py` - rclone subprocess adapter.
- `dropbox_browser/streaming.py` - byte-range parsing and stream response helpers.
- `dropbox_browser/windows_names.py` - Windows-safe filename matching and path resolution.
- `dropbox_browser/namekeys.py` - filename comparison compatibility wrapper.
- `dropbox_browser/ignored.py` - ignored metadata/system names.
- `dropbox_browser/clientlog.py` - client-side browser log ingestion and filtering.
- `dropbox_browser/views.py` - server-rendered HTML/CSS/JS asset responses.
- `tests/` - stdlib `unittest` tests with fake rclone and isolated temp/cache paths.
- `Cache/`, `Temp/`, `.dropbox-browser-temp/` - generated local state, ignored by git.
- `plans/TODO_NOTES` - human-owned active plan list and scratch notes; do not
  read or edit unless explicitly requested.

## Hard Safety Rules

- Do not add delete behavior unless explicitly requested.
- Do not add overwrite behavior unless explicitly requested.
- Sync is the explicit overwrite exception: when the user chooses a sync
  direction in the browser, overwrite the selected destination from the selected
  source direction. Sync must still never delete destination-only files.
- Browser uploads are not supported. Do not reintroduce upload UI or `/upload`
  backend behavior unless explicitly requested.
- Local paths must stay under `--local-root`; use `safe_join_local`.
- Remote paths must be normalized through `clean_rel_path`; parent segments are
  rejected.
- Do not hotlink icon URLs. Serve vendored icon files only through the
  constrained `/assets/icons/material-icon-theme/<name>.svg` handler.
- Do not `git add`, `git commit`, or `git push` without an explicit human
  request.

## Runtime Invariants

- Dropbox folder listings use `rclone lsjson`.
- File preview and download stream directly from `rclone cat`; the app does not
  save previews/downloads to disk.
- `/file` and `/download` support byte ranges and `HEAD`; keep seekable
  audio/video behavior intact.
- Remote range streaming uses `rclone cat --offset N --count M -- remote:path`.
- Dropbox folder `ModTime` values may be placeholders such as
  `2000-01-01T00:00:00Z`; folder date sorting stays based on direct listings
  unless a faster indexed design is added.
- Local/Dropbox filename matching must follow `filename_compare_key`
  semantics: Unicode NFKC normalization followed by `casefold()`.
- When a remote row matches a Windows-renamed local path, use the actual local
  path captured from the filesystem or resolve path segments through the
  matcher. Do not reconstruct impossible Windows paths from Dropbox display
  names.

## Browse UI Mode

Client-rendered browse is the supported and tested UI mode. `--client-render`
is the CLI default.

- Do not maintain or add regression coverage for `--no-client-render` /
  server-rendered browse rows.
- Tests that need row fields, sort order, status labels, or copy-path data
  should use `GET /browse/endpoints/listing` (see `browse_listing()` in
  `tests/app_test_support.py`), not `GET /` HTML row markup.
- Server-rendered page HTML is still tested only for shell contracts such as
  scripts, placeholders, and topbar chrome.

## Development Workflow

Useful checks:

```powershell
python -m py_compile dropbox_browser.py
python -m compileall -q dropbox_browser.py dropbox_browser
python dropbox_browser.py --help
python -m tests.run --list
python -m tests.run <relevant-group> -v
python -m unittest discover -s tests -v
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8000/ -TimeoutSec 30
```

During feature work, run the smallest relevant test group or specific test case.
Run the full suite before checkin/commit, before handing off broad cross-module
changes, or when shared helpers used by multiple groups changed.

Common groups:

- `client-log` - browser-to-server client log endpoint and filtering.
- `web` - rendered pages, assets, UI contracts.
- `streaming` - pure streaming helpers plus `/file` and `/download` HTTP behavior.
- `video` - video player endpoints, ffmpeg command construction, HLS sessions.
- `file-sync` - sync routes and sync job queue.
- `background-file-info` - folder-cache workers and `/folder-info` polling.
- `diff` - Dropbox/local status semantics.
- `cache` - listing/folder cache invalidation.
- `names` - Windows-safe name matching and listing merge.
- `rclone` - rclone adapter behavior.

When fixing a regression, add a focused failing test first when practical, make
the smallest fix, rerun that test, then run the relevant group. See
`docs/testing.md` for details.

## Debugging

- Client-side browser logs can be reported to `POST /client-log` and written to
  `Temp/client_logs.jsonl`.
- Client logging is controlled by `ClientLogEnabled` and
  `ClientLogSubsystems` in config. Keep noisy subsystems disabled by default
  unless they are actively being debugged.
- Current client log subsystem names include `video`, `browse-reveal`,
  `file-search`, and `music-metadata`.
- Server-side video HLS/session diagnostics are written to
  `Temp/video_debug.jsonl` when `LogVideoDebug` is enabled.
- Generated run state, logs, caches, and local reproductions under `Temp/`,
  `Cache/`, and `.dropbox-browser-temp/` are not source artifacts. Inspect them
  when useful, but do not commit or depend on their contents in tests.

## Implementation Preferences

- Keep Python web serving dependency-free and stdlib-based.
- Prefer direct, conservative code that matches existing module ownership.
- Keep UI interactions server-rendered unless a feature needs client-side state.
- Avoid expensive Dropbox recursion during normal page loads.
- Treat `.gitignore`, local config, generated caches, and untracked tooling as
  user-owned unless asked to modify them.
- Place new behavior where it belongs:
  - listing, status comparison, direct file sync, caching decisions:
    `dropbox_browser/services.py`;
  - background folder metadata and folder diff cache:
    `dropbox_browser/foldercache.py`;
  - browser-triggered sync/delete workers: `dropbox_browser/syncjobs.py`;
  - rclone command execution and logging: `dropbox_browser/rclone.py`;
  - byte-range parsing and copy helpers: `dropbox_browser/streaming.py`;
  - browser-originated client logs: `dropbox_browser/clientlog.py`;
  - request routing and response status: `dropbox_browser/handlers.py`;
  - HTML, icons, and browser assets: `dropbox_browser/views.py`;
  - config evolution and path locations: `dropbox_browser/config.py`.

## Git Notes

- Remote: `https://github.com/spotco/dropbox_browser`
- For an explicit request to commit and push:
  1. Check the current branch with `git branch --show-current`.
  2. Inspect `git status --short`.
  3. Stage only the files that belong to the requested work.
  4. Include `plans/TODO_NOTES` in the commit when it has local changes and
     the human is checking work into GitHub. Agents must still never read, edit,
     or rewrite `plans/TODO_NOTES` unless the human explicitly asks.
  5. Leave unrelated local edits uncommitted unless the human explicitly asks
     to include them.
  6. Commit with a focused message.
  7. Push the current branch to `origin` unless the human explicitly asks for a
     different branch or flow.
- Do not waste time probing `.git/index.lock` unless a git command actually
  fails with an index-lock error. If that specific error happens, confirm there
  is no live git process and then clear the stale lock before retrying.
- Use the approval-gated push tool call for network pushes.
- `rclone.exe` is tracked and large. Do not rewrite history or remove it unless
  asked.
- Git may warn about `C:\Users\mooto/.config/git/ignore`; this has not blocked
  normal status, commit, or push operations.
- `plans/TODO_NOTES` is human-edited. Do not read or edit it unless explicitly
  requested. When checking work into GitHub, stage and commit it if it changed.
