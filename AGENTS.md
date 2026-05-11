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
- `dropbox_browser/views.py` - server-rendered HTML/CSS.
- `README.md` - user-facing setup and usage notes.
- `config_location.txt` - points to the rclone config path. This may contain
  Windows environment variables such as `%APPDATA%\rclone\rclone.conf`; the app
  expands them.
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
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8000/ -TimeoutSec 30
```

Run with local comparison:

```powershell
python dropbox_browser.py --remote dropbox: --local-root "C:\path\to\folder"
```

If starting the server from an agent shell, use a hidden background process and
then verify the root URL returns HTTP 200. The current environment has required
approval for persistent background server starts.

## Git/GitHub Notes

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
