# Architecture

This project is a dependency-free Python Dropbox browser/downloader. Runtime
web serving uses the Python standard library; Dropbox access is delegated to
the local `rclone` executable rather than a Dropbox SDK.

See [Configuration](configuration.md) for startup/config precedence,
[HTTP/API contracts](http-api.md) for routes, and [Testing](testing.md) for
the supported regression workflow.

## Request and data flow

- `dropbox_browser.py` calls `dropbox_browser.cli.main`.
- `cli.py` parses command-line options, loads layered JSON config, discovers
  rclone and optional media tools, constructs the application, and starts the
  HTTP server.
- `handlers.py` owns HTTP routing, path validation, request-size/range
  handling, and translation of application errors into responses.
- `services.py` merges Dropbox and local listings, computes row status, sorts
  and filters browse data, manages cached recursive search sessions, and
  performs direct/batch sync decisions.
- `views.py` renders the page shell and serves constrained static assets. In
  the supported browse mode, the shell then loads rows from
  `/browse/endpoints/listing` in the browser; see [Browse UI](browse-ui.md).
- `foldercache.py` runs recursive folder metadata/diff work in the background.
  The browse, search, music, and video features consume its snapshots rather
  than recursively walking Dropbox during a normal page request.

The main data path is:

```text
HTTP page or API request
        |
        +--> ListingCache / FolderCache --> rclone lsjson when needed
        |
        +--> services.py --> merged browse/search/sync payload
        |
        +--> media_library.py --> music/video library snapshots
        |
        +--> rclone cat --> streamed preview/download or media input
```

The [Background Workers](background-workers.md), [Media Caches](media-caches.md),
and [Sync and rclone](sync-and-rclone.md) pages describe the asynchronous and
cache-backed parts of this flow in more detail.

## Dropbox and local data

- Dropbox folder listings use `rclone lsjson`.
- Normal navigation uses the listing cache first, then persisted direct
  listings from `FolderCacheManager`, then a fresh `lsjson` call. Explicit
  refreshes bypass reusable listing data and invalidate affected cache state.
- Recursive folder metadata, counts, dates, and diff status are computed by
  background workers and returned through `/folder-info` polling.
- Recursive search is a bounded, short-lived, cache-backed session. It starts
  with `/browse/endpoints/search?session=1` and is polled by session id; it is
  not an unbounded synchronous Dropbox walk.
- File previews and downloads stream through `rclone cat`; the app does not
  save ordinary preview/download bodies to disk.
- Local comparison is optional and configured with `--local-root` or
  `DropboxFolder` in config. Local paths are kept under that root, and remote
  paths reject parent traversal after normalization.
- Local/Dropbox name matching uses Unicode NFKC normalization followed by
  `casefold()`, including Windows-safe resolution of renamed path segments.
  See [Windows name matching](windows-name-matching.md).

## Streaming

`/file` and `/download` both use `RequestHandler.serve_file()`.
`dropbox_browser/streaming.py` owns byte-range parsing, response planning, and
exact-byte copy helpers.

Expected response behavior:

- Full response: `200 OK`, `Content-Length`, `Accept-Ranges: bytes`.
- Partial response: `206 Partial Content`, `Content-Range`, `Content-Length`,
  `Accept-Ranges: bytes`.
- Invalid range: `416 Range Not Satisfiable`, `Content-Range: bytes */size`.

Dropbox range requests translate to:

```text
rclone cat --offset <start> --count <length> -- remote:path
```

Abandoned remote streams from browser seek behavior terminate the active
rclone process promptly. See [HTTP/API contracts](http-api.md) and
[Sync and rclone](sync-and-rclone.md) for the surrounding route and subprocess
contracts.

## Cache and worker boundaries

- `listingcache.py` stores short-lived direct listing responses under
  `Cache/ListingCache`.
- `cacheio.py` is the shared atomic JSON writer for disposable cache records;
  it writes a sibling temporary file and retries the final replacement on
  Windows file-sharing races.
- `foldercache.py`, `foldercache_compute.py`, `foldercache_records.py`, and
  `foldercache_state.py` own recursive metadata/diff snapshots under
  `Cache/FolderInfo`.
- `photo_map_cache.py` stores bounded Photo Map metadata under
  `Cache/PhotoMap`; it is independent of the folder cache.
- `videocache.py` stores probe, subtitle, and header bytes under the configured
  video cache root; `thumbnails.py` and `video_thumbnails.py` store image and
  video posters under `ThumbnailCache`.
- `syncstate.py` and `syncjobs.py` own sync progress/state; sync workers never
  delete destination-only files.
- `priorityqueue.py` provides the inspectable thread-safe priority queue used
  by background workers, including queued-item counting/removal without
  draining the queue.
- `workertrace.py`, `clientlog.py`, `logstore.py`, and `logoutput.py` support
  diagnostics and server/client log persistence under `Temp`.

The cache boundaries, invalidation behavior, and generated paths are listed in
[Media Caches](media-caches.md) and [Background Workers](background-workers.md).

## Icons and static assets

File and folder row icons are vendored from Material Icon Theme for VS Code
under `dropbox_browser/assets/icons/material-icon-theme/`.

Rules:

- Keep the upstream `LICENSE` and local asset `README.md`.
- Do not hotlink GitHub or CDN icon URLs.
- Serve icons only through the constrained
  `/assets/icons/material-icon-theme/<name>.svg` handler.
- Unknown folders use `folder-base.svg`; unknown files use `document.svg`.
- Leaflet, markercluster, hls.js, and other browser assets are vendored or
  served from repository assets; runtime pages do not fetch arbitrary remote
  scripts.

## Feature ownership

- Browse listing/search, status comparison, sort/filter, and sync planning:
  `services.py`.
- Direct listing cache: `listingcache.py`.
- Recursive folder metadata and folder diff cache: `foldercache.py`,
  `foldercache_compute.py`, `foldercache_records.py`, `foldercache_state.py`.
- Browser-triggered sync workers and progress: `syncjobs.py`, `syncstate.py`.
- Rclone command execution, cancellation, retry, and logging: `rclone.py`.
- Byte-range parsing and stream response helpers: `streaming.py`.
- Windows-safe filename/path matching: `windows_names.py`, `namekeys.py`.
- Ignored metadata/system names: `ignored.py`.
- Image/video poster generation: `thumbnails.py`, `video_thumbnails.py`.
- Video probe/cache/session/HLS helpers: `video.py`, `videocache.py` and
  `assets/js/video/`; see [Video Player](video-player.md).
- Shared recursive media-library payloads: `media_library.py`.
- Music library endpoint and audio filter: `music.py` and `assets/js/music/`;
  see [Music Player](music-player.md).
- Photo Map metadata cache and client lifecycle: `photo_map_cache.py` and
  `assets/js/photo-map/`; see [Photo Map](photo-map.md).
- Browser-originated client logs: `clientlog.py`, `logstore.py`, and the
  `assets/js/log.js` client panel.
- HTTP routing and response status: `handlers.py`.
- HTML shell, templates, icons, and browser assets: `views.py` and
  `assets/templates/`.
- Configuration and filesystem/tool discovery: `config.py`, `paths.py`, and
  `cli.py`.

## Photo Map lifecycle contract

Photo Map client code is loaded with the page, but its map, cache reads,
remote byte-range metadata requests, and thumbnail requests start only when
the Photo Map bottom-pane mode is selected (or when a persisted Photo Map mode
is restored as the initial pane). Switching to another pane destroys the
Leaflet map, aborts active metadata and thumbnail work, and suppresses late
results from the closed generation. Metadata already accepted by the cache
writer may finish a local cache POST after deactivation; this is persistence
of completed work, not continued Dropbox scanning or Photo Map UI activity.

## Current known issues and intentional limits

- Empty local-only folders do not sync to Dropbox unless recursive sync creates
  remote folders as a side effect of copying contained files.
- Folder rows do not expose single-item sync forms. Sync controls apply to
  file rows and batch actions.
- Batch execution recomputes a confirmed recursive plan, which can be slow
  before copy jobs visibly start.
- Folder-cache and media-library responses can be partial while background
  work is running; clients must poll until `complete`.
- Photo Map currently recognizes JPEG photos and MOV/MP4 videos with embedded
  location metadata; it is not a general image catalog.
- Video playback requires discoverable FFmpeg and FFprobe, and unsupported
  inputs may require a compatibility transcode or remain unplayable.
