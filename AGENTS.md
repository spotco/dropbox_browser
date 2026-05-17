# Agent Notes

## Project Overview

This is a Python standard-library Dropbox file browser/downloader. It runs as a
local web server and uses `rclone` for Dropbox access instead of a Python web
framework or Dropbox SDK.

Primary entry point:

```powershell
python dropbox_browser.py --remote dropbox:
```

Default local URL:

```text
http://127.0.0.1:8000/
```

## Repository Layout

- `dropbox_browser.py` - compatibility entry point that calls
  `dropbox_browser.cli.main`.
- `dropbox_browser/cli.py` - argument parsing and HTTP server startup.
- `dropbox_browser/config.py` - project paths, default rclone discovery, config
  path expansion, and scratch/temp directory selection.
- `dropbox_browser/errors.py` - HTTP-aware application exception.
- `dropbox_browser/formatting.py` - display formatting for dates, sizes, file
  types, and status CSS classes.
- `dropbox_browser/handlers.py` - stdlib HTTP request routing and response
  streaming.
- `dropbox_browser/ignored.py` - hardcoded metadata/system file names that are
  hidden from Dropbox and local listings.
- `dropbox_browser/paths.py` - local and remote path normalization/safety
  helpers.
- `dropbox_browser/rclone.py` - rclone subprocess adapter.
- `dropbox_browser/services.py` - Dropbox/local listing merge, sorting, direct
  file sync, and caching decisions.
- `dropbox_browser/foldercache.py` - background thread pool for recursive folder
  size/date/count caching; writes JSON files to `Cache/`.
- `dropbox_browser/logstore.py` - thread-safe in-memory log ring buffer for
  the browser log panel.
- `dropbox_browser/syncjobs.py` - background worker pool for browser-triggered
  sync/delete jobs, with queue priorities and grouped progress reporting.
- `dropbox_browser/windows_names.py` - Windows-safe Dropbox/local name matching,
  fallback comparison, and local path resolution helpers for Windows-safe local
  rename variants.
- `dropbox_browser/namekeys.py` - compatibility wrapper for the exact normalized
  filename comparison key used by the broader Windows-safe matcher.
- `dropbox_browser/views.py` - server-rendered HTML/CSS.
- `dropbox_browser/assets/icons/material-icon-theme/` - vendored SVG icons from
  Material Icon Theme for VS Code, including local license/README notes.
- `tests/` - stdlib `unittest` coverage for app behavior and folder-cache
  workers, using simulated rclone responses and isolated temp/cache paths.
- `README.md` - user-facing setup and usage notes.
- `config.json` - rclone config path and logging/cache options (`RCloneConfig`,
  `LogRcloneCommands`, `LogHttpRequests`, `FolderCacheWorkers`,
  `SyncJobWorkers`, `FolderCacheTTLSeconds`, `ListingCacheTTLSeconds`). May
  contain Windows environment variables such as `%APPDATA%\rclone\rclone.conf`;
  the app expands them.
- `Cache/` - folder metadata cache (JSON files keyed by SHA-256 of remote
  path). Ignored by git.
- `rclone.exe` - bundled Windows rclone binary, currently tracked.
- `rclone.1` - bundled rclone manpage, currently tracked.
- `Temp/` - local process/log scratch directory. It is ignored by git.
- `.dropbox-browser-temp/` - local process/log scratch directory. It is ignored
  by git.
- `TODO_NOTES` - human-owned future feature notes. Do not edit it unless the
  user explicitly asks.

## Runtime Behavior

- Dropbox folder listings use `rclone lsjson`.
- File preview and download stream directly from `rclone cat` to the HTTP
  response. Downloads/previews are not saved to disk by this app.
- Browser sync actions run through `/sync` and are guarded by an explicit
  direction-specific POST field. File sync may overwrite destination files in
  the selected direction, but it is copy-only and must never delete
  destination-only files.
- Browser uploads are not supported. Do not reintroduce upload UI or `/upload`
  backend behavior unless the user explicitly asks.

## Icon Asset Notes

- File and folder row icons are local SVG assets vendored from Material Icon
  Theme for VS Code under `dropbox_browser/assets/icons/material-icon-theme/`.
  Keep the upstream `LICENSE` and update the local asset `README.md` when adding
  more icons.
- Do not hotlink GitHub or CDN icon URLs from the app. Serve icon files through
  the constrained `/assets/icons/material-icon-theme/<name>.svg` handler.
- To add an icon, download the needed upstream `icons/<name>.svg` file into the
  vendored icon directory, then add or adjust extension mappings in
  `dropbox_browser/views.py` (`FILE_ICON_BY_EXTENSION`). Use one icon for related
  extensions where practical, such as mapping `.zip`, `.rar`, `.7z`, `.tar`, and
  `.gz` to `zip.svg`.
- Keep a reasonable default icon for unknown file types. Folder rows should use
  `folder-base.svg`; unknown files should fall back to `document.svg`.

## Safety Rules

- Do not add delete behavior unless explicitly requested.
- Do not add overwrite behavior unless explicitly requested.
- The sync feature is the explicit exception to the overwrite rule: when the
  user chooses a sync direction in the browser, overwrite the destination from
  the selected source direction. Sync must still never delete extra files.
- Local paths must stay under `--local-root`; use `safe_join_local`.
- Remote paths are normalized through `clean_rel_path`; parent segments are
  rejected.

## Known Dropbox/rclone Behavior

- Dropbox folder `ModTime` values returned by `rclone lsjson` may be placeholders
  such as `2000-01-01T00:00:00Z`.
- Dropbox names may contain characters that Windows cannot store in local file
  names, especially `*`. Local Windows copies may use visually similar
  fullwidth Unicode replacements such as `＊` (`U+FF0A FULLWIDTH ASTERISK`) for
  Dropbox `*` (`U+002A ASTERISK`), as seen with names like `*NSYNC` or
  `f*ck`.
- Local/Dropbox filename comparisons must use
  `dropbox_browser.namekeys.filename_compare_key`, which applies Unicode NFKC
  normalization before `casefold()`. This makes Dropbox `*` compare equal to
  local `＊`, and similarly handles other fullwidth compatibility characters.
- Planned robust matcher work: move Windows-safe Dropbox/local name matching
  into a dedicated helper module so all call sites share the same behavior.
  Keep the existing exact NFKC/casefold match first, then add a constrained
  fallback for Windows-safe local substitutions that are not recovered by NFKC
  alone, including private-use replacement characters and the observed
  `:` -> `_` local rename form. Integrate the same matcher into page listing
  merge, local path resolution, folder-cache direct child comparison, and child
  folder enumeration so a Dropbox folder/file keeps the same local link across
  the whole app.
- Add regression coverage for combined Windows-prohibited character cases in
  both file and folder names, including repeated/combined invalid characters
  and surrounding Unicode text. Verify the page row merge, `local_display_path`
  resolution, and folder-cache diff status stay aligned.
- Do not reconstruct an existing local path from the Dropbox display name when a
  row matched by `filename_compare_key`. Use the actual local path captured from
  the filesystem (`row["local_path"]`) or resolve each path segment through the
  local filesystem with the same comparison key. Otherwise copy/open actions can
  produce impossible Windows paths like `F:\...\*NSYNC - Bye Bye Bye.mp3`.
- A recursive "newest child inside folder" date mode was tested and removed
  because it made browsing too slow to be usable on large Dropbox folders.
- Keep folder date sorting based on the direct listing only unless a faster
  cached/indexed design is added.

## Local Development

Useful checks:

```powershell
python -m py_compile dropbox_browser.py
python -m compileall -q dropbox_browser.py dropbox_browser
python dropbox_browser.py --help
python -m unittest discover -s tests -v
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8000/ -TimeoutSec 30
```

The background-worker regression suite lives under `tests/` and uses a fake
`rclone` implementation rather than the real binary. The main coverage file is
`tests/test_app_behavior.py`; it exercises normal page loads, `/folder-info`
polling, slow background listings, page changes during in-flight work,
background worker failures, common diff cases, and regressions where diff
status completes before recursive folder metadata is actually complete.

When a new regression is found, add a focused unit test for it before applying
the fix:

1. Create a regression unit test that reproduces the bad behavior with the fake
   `rclone` and isolated temp/cache paths.
2. Run that specific test and verify it fails for the expected reason.
3. Apply the smallest fix that addresses the regression.
4. Run the specific regression test again and verify it passes.
5. Run the full suite with `python -m unittest discover -s tests -v`.

Do not rely only on browser/manual verification for regressions that can be
represented in the stdlib test harness.

Run with local comparison:

```powershell
python dropbox_browser.py --remote dropbox: --local-root "C:\path\to\folder"
```

If starting the server from an agent shell, use a hidden background process and
then verify the root URL returns HTTP 200. The current environment has required
approval for persistent background server starts.

## Background Job Debugging

Folder-cache workers write persistent JSONL trace events to:

```text
Temp/foldercache_threads.jsonl
```

Each line is one JSON object with fields such as `ts`, `thread`, `event`,
`remote_path`, `queue_size`, `active_jobs`, `in_progress`, `page_completed`,
and `page_dispatched`. Use this file to trace background folder progress across
threads without depending on browser timing.

Useful event names include:

- `manager_started` and `worker_started` - worker pool startup.
- `page_load` and `page_load_reused` - page epoch changes.
- `request_enqueued`, `request_reenqueued`, and `request_skipped_cached` -
  public folder-cache requests.
- `job_queued`, `job_started`, `job_finished`, `job_aborted`,
  `job_canceled_running`, and `job_failed` - worker job lifecycle.
- `folder_listing_loaded` - a direct `lsjson` result was loaded from rclone or
  listing cache.
- `direct_diff_found` and `subtree_diff_marked` - diff status was determined.
- `subtree_complete` - recursive folder metadata for that path is complete.

For live debugging, inspect the tail of the file while loading pages or polling
`/folder-info`. In tests, `IsolatedPathsTestCase.read_trace_events()` reads the
same JSONL format from the isolated temp directory.

## Git/GitHub Notes

- Do not `git add`, `git commit`, or `git push` without an explicit human request.
- The repository remote is:

```text
https://github.com/spotco/dropbox_browser
```

- The main branch is `main`.
- `rclone.exe` is tracked and GitHub warned that it is larger than the
  recommended 50 MB file size. Do not rewrite history or remove it unless the
  user asks for that cleanup.
- Git may warn about being unable to access
  `C:\Users\mooto/.config/git/ignore`; this has not blocked normal status,
  commit, or push operations.

## Current Implementation Preferences

- Keep the app dependency-free for Python web serving.
- Prefer conservative, direct stdlib code over introducing a framework.
- Keep UI interactions server-rendered unless a feature needs client-side state.
- Avoid expensive Dropbox recursion during normal page loads.
- Treat `.gitignore`, `run_local.bat`, and any untracked local tooling as
  user-owned unless the user asks to modify them.
- Place new features in the module that owns the behavior:
  - listing, status comparison, direct file sync, caching decisions:
    `dropbox_browser/services.py`;
  - browser-triggered sync/delete queueing, worker concurrency, and grouped
    sync progress: `dropbox_browser/syncjobs.py`;
  - rclone command execution and future progress/log capture:
    `dropbox_browser/rclone.py`;
  - request routes, streaming behavior, and response status:
    `dropbox_browser/handlers.py`;
  - generated HTML, icons, search controls, preview controls, and map links:
    `dropbox_browser/views.py`;
  - config-file evolution and path locations: `dropbox_browser/config.py`.

## Planned: Recursive Diff Status Cache

Goal: the table Status column should show Dropbox/local diff status for both
folders and files when `--local-root` is configured. Folder status should be
computed by the existing background folder-cache jobs, not by synchronous page
loads.

Planned status labels:

- `Loading` - a remote folder is still being computed by background jobs.
- `Synced` - local and Dropbox item names, item types, and file sizes match for
  that item/subtree.
- `Has Diffs` - the local subtree and Dropbox subtree differ by item presence,
  item type, or file size.
- `Local Only` - an item exists locally but not on Dropbox.
- `Dropbox Only` - an item exists on Dropbox but not locally.

Resolved design decisions:

- `Synced` means the visible item/subtree matches by names, item types, and
  file sizes. Modification time differences do not make an item unsynced for
  this feature.
- Compare files by size only once names and item types match; do not perform
  local Dropbox content hashing for this feature.
- Store folder/subtree diff status in the existing folder cache JSON.
- Treat old folder cache files that do not include the current diff fields as
  stale and recompute them.
- Diff status may be determined before recursive metadata is complete, but the
  folder cache must not mark `complete: true` until size/count/date metadata has
  finished for all required Dropbox subfolders. A folder can show `Has Diffs`
  while size/date cells continue loading.
- Local-only folders should show `Local Only` immediately. Do not create
  recursive cache jobs for local-only folder contents.
- Dropbox-only folders should show `Dropbox Only`, not `Has Diffs`, when the
  matching local folder is absent or the folder contents are entirely
  Dropbox-side-only.
- Same-name file-vs-folder conflicts should display `Has Diffs`; store the
  specific reason internally if useful for debugging.

Implementation plan:

1. Reuse `FolderCacheManager` as the background worker for folder diff status.
   This is the simplest fit because it already performs the recursive Dropbox
   traversal, writes partial/complete JSON cache files, supports cancellation,
   and is already polled by `/folder-info`.
2. Pass local comparison context into `FolderCacheManager` from `cli.py`
   (`local_root` and base `remote`) so a remote cache path can be mapped back to
   the matching local folder with `safe_join_local`.
3. Extend each folder cache accumulator and cache JSON file with diff fields,
   for example:
   - `diff_status`: one of `loading`, `synced`, `has_diffs`,
     `local_only`, `dropbox_only`;
   - optional debug/count fields such as `local_only_count`,
     `dropbox_only_count`, and `first_diff_path`.
4. In `_compute`, fetch direct Dropbox children with:
   `rclone lsjson -- remote:path`. Compare direct Dropbox child names/types/sizes
   against the direct local folder listing:
   - case-insensitive name matching should follow the current listing merge
     behavior (`filename_compare_key`) unless a future decision changes it;
   - direct name/type/size differences immediately mark that folder and its
     ancestors as `has_diffs`;
   - if no direct differences exist, recursively queued child folders continue
     determining whether the whole subtree is still size-synced.
5. Record and surface diff status as soon as the first difference is found, but
   keep recursive folder metadata work running until size/date/count values are
   complete. Do not write `complete: true` for a folder whose subfolder metadata
   is still pending.
6. Keep file-row status synchronous for existence/type/size where available:
   - both sides present: `Synced`;
   - only local present: `Local Only`;
   - only Dropbox present: `Dropbox Only`.
7. For folder rows, `views.py` should render status from the folder cache map:
   - missing or incomplete diff data: `Loading`;
   - complete diff data: `Synced` or `Has Diffs`;
   - local-only folder rows can show `Local Only` immediately because no Dropbox
     background job exists for them.
8. Extend `/folder-info` and `FOLDER_JS` so polling updates the Status cell at
   the same time it updates size/date cells.
9. Invalidate diff cache data anywhere existing folder metadata is invalidated.
10. Add focused tests for direct name/type/size comparison, early exit, recursive propagation,
    local-only/dropbox-only rows, and cache serialization. If no test harness
    exists yet, add small stdlib `unittest` coverage around the pure comparison
    helpers first.

Remaining design questions before implementation:

- None currently known.
