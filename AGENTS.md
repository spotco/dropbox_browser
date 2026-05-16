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
  path expansion, and upload temp directory selection.
- `dropbox_browser/errors.py` - HTTP-aware application exception.
- `dropbox_browser/formatting.py` - display formatting for dates, sizes, file
  types, and status CSS classes.
- `dropbox_browser/handlers.py` - stdlib HTTP request routing and response
  streaming.
- `dropbox_browser/paths.py` - local and remote path normalization/safety
  helpers.
- `dropbox_browser/rclone.py` - rclone subprocess adapter.
- `dropbox_browser/services.py` - Dropbox/local listing merge, sorting, and
  create-only upload rules.
- `dropbox_browser/uploads.py` - multipart upload parsing.
- `dropbox_browser/foldercache.py` - background thread pool for recursive folder
  size/date/count caching; writes JSON files to `Cache/`.
- `dropbox_browser/logstore.py` - thread-safe in-memory log ring buffer for
  the browser log panel.
- `dropbox_browser/views.py` - server-rendered HTML/CSS.
- `tests/` - stdlib `unittest` coverage for app behavior and folder-cache
  workers, using simulated rclone responses and isolated temp/cache paths.
- `README.md` - user-facing setup and usage notes.
- `config.json` - rclone config path and logging/cache options (`RCloneConfig`,
  `LogRcloneCommands`, `LogHttpRequests`, `FolderCacheWorkers`,
  `FolderCacheTTLHours`). May contain Windows environment variables such as
  `%APPDATA%\rclone\rclone.conf`; the app expands them.
- `Cache/` - folder metadata cache (JSON files keyed by SHA-256 of remote
  path). Ignored by git.
- `rclone.exe` - bundled Windows rclone binary, currently tracked.
- `rclone.1` - bundled rclone manpage, currently tracked.
- `Temp/` - local upload staging directory. It is ignored by git.
- `.dropbox-browser-temp/` - local process/log scratch directory. It is ignored
  by git.
- `TODO_NOTES` - human-owned future feature notes. Do not edit it unless the
  user explicitly asks.

## Runtime Behavior

- Dropbox folder listings use `rclone lsjson`.
- File preview and download stream directly from `rclone cat` to the HTTP
  response. Downloads/previews are not saved to disk by this app.
- Browser uploads are staged in `./Temp` using `tempfile.NamedTemporaryFile`
  with `dir=upload_temp_dir()`.
- Upload staging files are deleted in a `finally` block after the Dropbox copy
  attempt.
- Uploads are sent to Dropbox with `rclone copyto --ignore-existing`.

## Safety Rules

- Do not add delete behavior unless explicitly requested.
- Do not add overwrite behavior unless explicitly requested.
- Uploads must remain create-only:
  - check whether the target name exists in the current Dropbox folder;
  - when `--local-root` is configured, also check whether that name exists in the
    matching local folder;
  - reject conflicts before copying.
- Local paths must stay under `--local-root`; use `safe_join_local`.
- Remote paths are normalized through `clean_rel_path`; parent segments are
  rejected.

## Known Dropbox/rclone Behavior

- Dropbox folder `ModTime` values returned by `rclone lsjson` may be placeholders
  such as `2000-01-01T00:00:00Z`.
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
background worker failures, and common diff cases.

Run with local comparison:

```powershell
python dropbox_browser.py --remote dropbox: --local-root "C:\path\to\folder"
```

If starting the server from an agent shell, use a hidden background process and
then verify the root URL returns HTTP 200. The current environment has required
approval for persistent background server starts.

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
  - listing, status comparison, upload rules, caching decisions:
    `dropbox_browser/services.py`;
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
- Exit as soon as any diff is found. Once a folder is known to have diffs, write
  that state, report it through the UI, and stop any further recursive
  traversals for that subtree.
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
     behavior (`casefold`) unless a future decision changes it;
   - direct name/type/size differences immediately mark that folder and its
     ancestors as `has_diffs`;
   - if no direct differences exist, recursively queued child folders continue
     determining whether the whole subtree is still size-synced.
5. Stop traversal early for a subtree after the first difference
   is found. Once a folder is known to have diffs, write that status to cache and
   propagate it upward. Size/date/count cache values may remain partial in this
   case; fast diff status is more important for this feature than completing
   metadata totals after a diff has already been proven.
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
9. Invalidate diff cache data anywhere existing folder metadata is invalidated,
   especially after successful uploads.
10. Add focused tests for direct name/type/size comparison, early exit, recursive propagation,
    local-only/dropbox-only rows, and cache serialization. If no test harness
    exists yet, add small stdlib `unittest` coverage around the pure comparison
    helpers first.

Remaining design questions before implementation:

- None currently known.
