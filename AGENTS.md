# AGENTS.md instructions for `F:\dev\dropbox_browser`

## Overview

Dropbox Browser is a dependency-free Python application. It runs a local
stdlib HTTP server, obtains Dropbox listings and file bytes through `rclone`,
and renders a client-rendered browse shell with optional media panes.

Start locally:

```powershell
python dropbox_browser.py --remote dropbox:
```

Default URL: `http://127.0.0.1:8000/`.

## Read before editing

Use the document that matches the subsystem being changed:

- [Architecture](docs/architecture.md) — request flow and ownership map.
- [Configuration](docs/configuration.md) — config layers, tool discovery, and
  generated state.
- [HTTP API](docs/http-api.md) — route methods, parameters, and payloads.
- [Browse UI](docs/browse-ui.md) — client-rendered listing, filters, search,
  navigation, and thumbnails.
- [Background workers](docs/background-workers.md) — folder metadata, diff
  cache, worker traces, and `/folder-info`.
- [Sync and rclone](docs/sync-and-rclone.md) — copy directions, confirmation
  plans, retry behavior, and delete-command downloads.
- [Media caches](docs/media-caches.md) — image/video posters and video disk
  caches.
- [Music player](docs/music-player.md) — recursive library, playlists,
  metadata, playback, and waveform processing.
- [Photo Map](docs/photo-map.md) — GPS parsing, map lifecycle, grouping,
  thumbnails, preview, and browser-owned cache.
- [Video player](docs/video-player.md) — HLS sessions, tracks, subtitles, and
  video client modules.
- [Windows name matching](docs/windows-name-matching.md) — normalized matching
  and safe local path resolution.
- [Testing](docs/testing.md) — Python groups, JavaScript tests, and Playwright.

Do not read or edit `plans/TODO_NOTES` unless the human explicitly requests it.
The other files under `plans/` are historical design notes, not runtime
contracts.

## Repository map

- `dropbox_browser.py` — compatibility entry point.
- `dropbox_browser/cli.py` — CLI parsing, config loading, tool discovery, and
  server startup/shutdown.
- `dropbox_browser/config.py` — defaults, config layering, paths, and tool
  discovery.
- `dropbox_browser/handlers.py` — HTTP routing, path validation, response
  streaming, JSON endpoints, and asset delivery.
- `dropbox_browser/services.py` — browse snapshots, listing merge, cached
  recursive search, status decisions, sync planning, and sync operations.
- `dropbox_browser/foldercache.py` plus `foldercache_compute.py`,
  `foldercache_records.py`, `foldercache_state.py`, and `folderdiff.py` —
  background recursive metadata, diff propagation, and cache records.
- `dropbox_browser/listingcache.py` — TTL-based direct `rclone lsjson` cache.
- `dropbox_browser/rclone.py` — subprocess adapter, streaming, cancellation,
  and write retry policy.
- `dropbox_browser/streaming.py` — byte-range parsing and exact-byte copy.
- `dropbox_browser/paths.py`, `windows_names.py`, `namekeys.py`, and
  `ignored.py` — path safety, Windows-compatible matching, and ignored names.
- `dropbox_browser/syncjobs.py` and `syncstate.py` — browser-triggered copy
  queue, throttling retries, and in-memory operation status.
- `dropbox_browser/thumbnails.py` and `video_thumbnails.py` — image and video
  poster generation and cache keys.
- `dropbox_browser/media_library.py`, `music.py`, and `video.py` — recursive
  media-library payloads, music endpoints, and video/HLS endpoints.
- `dropbox_browser/videocache.py` — TTL/LRU-byte-cap disk cache used by video
  probe, subtitle, and header data.
- `dropbox_browser/photo_map_cache.py` — validated browser-owned Photo Map
  metadata cache.
- `dropbox_browser/clientlog.py`, `logoutput.py`, `logstore.py`, and
  `workertrace.py` — client diagnostics, server logs, in-memory log polling,
  and JSONL worker traces.
- `dropbox_browser/views.py` and `assets/templates/` — page shells, HTML, and
  server-side asset metadata.
- `dropbox_browser/assets/js/browse/` — browse navigation, rendering, sorting,
  filtering, virtual rows, folder-info polling, and thumbnails.
- `dropbox_browser/assets/js/media-library/` — shared music/video library tree,
  playlist store/UI, layout, and Recent history.
- `dropbox_browser/assets/js/music/` — audio playback, metadata, embedded art,
  shuffle helpers, and waveform worker/controller.
- `dropbox_browser/assets/js/photo-map/` plus `photo-map.js` — map lifecycle,
  parsers, grouping, cache, thumbnail scheduling, and diagnostics.
- `dropbox_browser/assets/js/video/` plus `video.js` — video playback, HLS,
  tracks, subtitles, controls, and diagnostics.
- `tests/` — stdlib unit tests, Node tests, Playwright specs, fake rclone, and
  isolated integration harnesses.

## Hard safety rules

- Do not add delete behavior unless explicitly requested. The existing
  `/local-only-delete-bat` behavior only downloads a reviewable batch file; the
  server does not execute it.
- Do not add overwrite behavior unless explicitly requested. Sync is the
  explicit exception: the chosen source direction may overwrite the selected
  destination, but sync must never delete destination-only files.
- Browser uploads are not supported. Do not reintroduce upload UI or an
  `/upload` backend route unless explicitly requested.
- Local paths must stay under `--local-root`/`DropboxFolder` and use
  `safe_join_local` or Windows name-resolution helpers.
- Remote paths must pass through `clean_rel_path`; parent segments are rejected.
- Do not hotlink icon or Leaflet asset URLs. Serve the constrained vendored
  assets through the existing asset handlers.
- Do not `git add`, `git commit`, or `git push` without an explicit human
  request.

## Runtime invariants

- Dropbox folder listings use `rclone lsjson`; direct listings may come from
  `ListingCacheManager` or completed folder-cache records.
- `/file` and `/download` stream from `rclone cat` or a safe local file. They
  support `HEAD`, byte ranges, `Accept-Ranges`, and `206`/`416` semantics.
- Remote ranged reads use `rclone cat --offset N --count M -- remote:path`.
- Video HLS sessions read remote bytes through a tagged `/file` request and
  write temporary HLS output under the active `Temp` run directory.
- Image and video thumbnails are explicit generated cache artifacts; ordinary
  preview/download requests are not materialized as downloads.
- Dropbox folder `ModTime` values can be placeholders such as
  `2000-01-01T00:00:00Z`; folder date sorting remains based on direct listing
  data unless an indexed design changes that contract.
- Local/Dropbox name matching uses Unicode NFKC normalization followed by
  `casefold()` via `filename_compare_key`.
- If a remote row matches a Windows-renamed local path, use the actual local
  path captured from the filesystem or resolve segments through the matcher.
  Never reconstruct an impossible Windows path from a Dropbox display name.
- Client-rendered browse is the supported UI mode and is the CLI default.
  Server-rendered rows are a compatibility path, not a maintained regression
  surface.
- Background folder metadata and recursive media-library listing must not turn
  normal page loads into synchronous Dropbox recursion.

## Development workflow

Run the smallest relevant check first, then the broader group for shared code:

```powershell
python -m tests.run --list
python -m tests.run <relevant-group> -v
npm run test:js
python -m unittest discover -s tests -v
```

Useful smoke checks:

```powershell
python -m py_compile dropbox_browser.py
python -m compileall -q dropbox_browser.py dropbox_browser
python dropbox_browser.py --help
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8000/ -TimeoutSec 30
```

Focused groups include `web`, `streaming`, `file-sync`, `background-file-info`,
`diff`, `cache`, `names`, `rclone`, `thumbnails`, `photo-map`, `music`,
`video`, and `client-log`. See [Testing](docs/testing.md) for aliases and
Playwright projects.

When fixing a regression, add a focused failing test when practical, make the
smallest fix, rerun it, run the relevant group, and run the full suite before a
handoff for broad/shared changes. Documentation-only changes must not modify
Python, JavaScript, CSS, templates, fixtures, or generated runtime state.

## Debugging

- Use the repository's configured Brave DevTools integration for interactive
  local UI inspection when available; select the existing app tab instead of
  starting a second browser session.
- Client logs are posted to `POST /client-log` and written to
  `Temp/client_logs.jsonl` only when `ClientLogEnabled` and the named subsystem
  are enabled.
- Server request/command logs are visible in the in-memory `/logs` stream and
  normal output. Worker timing and cache events are written to the current run
  under `Temp/runs/<run-id>/`.
- Video session diagnostics are written to `Temp/video_debug.jsonl` when
  `LogVideoDebug` is enabled.
- Generated state under `Cache/`, `Temp/`, and `ThumbnailCache/` is disposable
  runtime data. Inspect it when useful, but do not add it to source or tests.

## Git notes

- Remote: `https://github.com/spotco/dropbox_browser`.
- “Dev branch” means the repository's currently used development branch; do
  not create or push a branch literally named `dev` unless requested.
- For an explicit commit/push request, inspect the current branch and status,
  stage only intended files, use a focused commit, and push the current branch
  to `origin`. Do not use GitHub CLI or create a PR unless explicitly asked.
- `rclone.exe` is tracked and large. Do not rewrite history or remove it unless
  asked.
- Do not probe or remove `.git/index.lock` unless a Git command actually fails
  with that exact error; if so, verify no Git process is live and remove only
  the repository's lock before retrying.
