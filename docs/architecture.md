# Architecture

This project intentionally stays small and dependency-free for runtime web
serving. It uses stdlib HTTP handling and `rclone` instead of a web framework or
Dropbox SDK.

## Request Flow

- `dropbox_browser.py` calls `dropbox_browser.cli.main`.
- `cli.py` parses args, loads config, discovers rclone, builds the app, and
  starts the HTTP server.
- `handlers.py` routes requests and translates application errors into HTTP
  responses.
- `services.py` owns listing merge, status comparison, sorting, direct file sync,
  and batch sync planning decisions.
- `views.py` renders HTML and serves browser assets.

## Dropbox and Local Data

- Dropbox folder listings use `rclone lsjson`.
- Normal page navigation checks cached listing data first: `ListingCacheManager`,
  then `FolderCacheManager.get_direct_listing()`, then `rclone lsjson`.
  Explicit refreshes bypass these cached listing paths.
- File previews/downloads stream through `rclone cat`.
- Local comparison is optional and configured with `--local-root` or
  `DropboxFolder` in config.
- Local paths must stay under the selected local root.
- Remote paths are normalized and reject parent traversal.

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

Abandoned remote streams from browser seek behavior should terminate the active
rclone process promptly.

## Icons

File and folder row icons are vendored from Material Icon Theme for VS Code
under `dropbox_browser/assets/icons/material-icon-theme/`.

Rules:

- Keep upstream `LICENSE` and local asset `README.md`.
- Do not hotlink GitHub or CDN icon URLs.
- Serve icons through `/assets/icons/material-icon-theme/<name>.svg`.
- Unknown folders use `folder-base.svg`; unknown files use `document.svg`.

## Feature Ownership

- Listing, status comparison, direct file sync, caching decisions:
  `dropbox_browser/services.py`.
- Background folder metadata and folder diff cache:
  `dropbox_browser/foldercache.py`.
- Browser-triggered sync workers:
  `dropbox_browser/syncjobs.py`.
- Rclone command execution and logging:
  `dropbox_browser/rclone.py`.
- Byte-range parsing and copy helpers:
  `dropbox_browser/streaming.py`.
- Request routing and response status:
  `dropbox_browser/handlers.py`.
- HTML, icons, browser assets:
  `dropbox_browser/views.py`.
- Config evolution and path locations:
  `dropbox_browser/config.py`.
- Shared recursive media library listing (music + video endpoints):
  `dropbox_browser/media_library.py`.
- Music player endpoints and audio filter wrappers:
  `dropbox_browser/music.py`.
- Shared library/playlist client (tree, playlist store, layout, media-kind
  labels): `dropbox_browser/assets/js/media-library/` +
  `assets/css/media-library.css`.
- Generic bottom-panel shell state, drag resizing, full-page/minimize controls:
  `dropbox_browser/assets/js/log.js`, `assets/app.css`, and the shared page
  template in `dropbox_browser/assets/templates/page.html`.
- Music-only playback client:
  `dropbox_browser/assets/js/music/` (entry: `assets/js/music.js`).
- Video player endpoints, HLS sessions, and browser modules:
  `docs/video-player.md` (`dropbox_browser/video.py`, `assets/js/video/`).

## Current Known Issues

- Empty local-only folders do not sync to Dropbox unless recursive sync creates
  remote folders as a side effect of copying contained files.
- Folder rows do not expose single-item sync forms. Sync controls apply to file
  rows and batch actions.
- Batch execution recomputes a confirmed recursive plan, which can be slow before
  copy jobs visibly start.
