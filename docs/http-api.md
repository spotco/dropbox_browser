# HTTP API

The server is intended for a local browser UI, but its route contracts are also
used by the unit and Playwright tests. JSON responses use `Content-Type:
application/json` and no-store headers unless noted otherwise. Invalid routes,
paths, and parameters are returned as an HTML error page for normal browser
requests or a JSON error from the JSON endpoint handlers.

## Access and path rules

`LocalhostOnlyAccess` defaults to `true`. The server rejects non-loopback peers
even if it is bound with `--host 0.0.0.0`; set the setting to `false` only when
the surrounding environment supplies its own access control. The application
does not provide user authentication or TLS.

Remote-relative paths pass through `clean_rel_path`: backslashes are treated as
slashes, `.` segments are removed, and `..` segments are rejected. Local paths
are resolved with `safe_join_local` and Windows name matching where needed.

## Page and file routes

| Method | Path | Purpose |
| --- | --- | --- |
| `GET`/`HEAD` | `/` | Render the page shell for the requested `path`; client-render mode fills the browse rows from the listing endpoint. |
| `GET`/`HEAD` | `/preview?path=&source=remote` | Durable media preview page for a supported remote image or video. The URL contains no HLS session id. |
| `GET`/`HEAD` | `/file?path=&source=` | Inline stream. `source=remote` uses rclone; `source=local` uses the safe local root. Supports ranges and `HEAD`. |
| `GET`/`HEAD` | `/download?path=&source=` | Same stream behavior with attachment disposition. |
| `GET`/`HEAD` | `/thumbnail?path=&source=` | Image PNG poster, generated/cached by ImageMagick. |
| `GET`/`HEAD` | `/video/endpoints/thumbnail?path=&source=` | Video JPEG poster, generated/cached by FFmpeg. |
| `GET` | `/logs?since=&since_upd=` | Incremental in-memory server log entries and in-place updates. |
| `GET` | `/sync-status?id=` | Current in-memory sync or batch-plan operation state. |

For full streams, `/file` and `/download` return `200` with
`Content-Length` and `Accept-Ranges: bytes`. Valid ranges return `206` with
`Content-Range`; invalid ranges return `416` with `Content-Range: bytes */size`.
Remote ranges use `rclone cat --offset N --count M -- remote:path`.

## Browse listing

`GET /browse/endpoints/listing` accepts:

| Parameter | Values | Meaning |
| --- | --- | --- |
| `path` | remote-relative path | Folder to list. |
| `sort` | `name`, `type`, `status`, `size`, `date` | Sort key for the snapshot. |
| `dir` | `asc`, `desc` | Sort direction. |
| `refresh` | `1` | Bypass direct listing caches and start fresh metadata work. |

The response contains `page`, `breadcrumbs`, `rows`, `pending_metadata_paths`,
`current_folder_info`, `sort`, `listing`, and `timings_ms`. Row objects include
remote/local presence, type, display values, status, copy-path information,
preview/download links, and permitted sync directions. The endpoint returns the
direct children only; recursive folder totals and statuses arrive through
`/folder-info`.

`GET /browse/endpoints/search` is the recursive cached search endpoint. It
requires recursive mode (`recursive=1`) and accepts `path` and `query`. The UI
uses session mode for incremental results:

- Start: `?path=&query=&recursive=1&session=1&limit=100`.
- Poll: add `session_id=`.
- Cancel: add `session_id=&cancel=1`.
- `limit` is bounded to 1–5000.

Search results are cache-backed and can be partial while folder metadata is
missing. See [Browse UI](browse-ui.md) for client filtering and search behavior.

## Background polling

`GET /folder-info` accepts repeated `paths=` values and an optional `current=`
path. It returns a `results` map. A result may be `calculating`, `partial`, or
`complete`, with display/sort values for size, count, date, diff status, and
direct file statuses. The handler queues missing work without blocking for the
recursive computation.

`GET /music/endpoints/library?path=` and `GET /video/endpoints/library?path=`
return recursive media-library payloads built from folder-cache records. Both
can be partial and are intended to be polled by their clients. Music also has
`GET /music/endpoints/status`, which reports its supported extensions and
endpoint root.

## Sync and cache-control routes

| Method | Path | Body/parameters | Result |
| --- | --- | --- | --- |
| `POST` | `/sync` | `path`, `kind=file`, `direction=local_to_dropbox` or `dropbox_to_local`, plus the matching explicit enable flag | `202` with an operation `id`. |
| `POST` | `/sync-batch-plan` | `path`, `action`, `recursive=1`, and the matching enable flag | `202` with a plan-operation `id`; poll `/sync-status`. |
| `POST` | `/sync-batch` | Same selection, plus a confirmed `plan_token` | `202` with operation `id` and total count. |
| `POST` | `/local-only-delete-bat` | `path`, optional `recursive=1`, and `enable_to_local=1` | Downloads a UTF-8-BOM `.bat`; the server does not execute it. |
| `POST` | `/refresh-cache` | `path`, optional `recursive=1` | `202` with invalidated paths; the client reloads the listing. |
| `POST` | `/client-log` | Form fields including `subsystem`, `level`, `message`, and JSON `details` | `200` with whether the event was accepted. |

Sync writes are gated in both the UI and handler. `local_to_dropbox` requires
`enable_write_dropbox=1`; `dropbox_to_local` requires `enable_to_local=1`.
Batch planning is a confirmation step and execution recomputes/validates the
plan before enqueueing operations.

## Photo Map cache

| Method | Path | Body/parameters |
| --- | --- | --- |
| `GET` | `/photo-map/endpoints/cache?path=` | Reads validated records for one relative folder. |
| `POST` | `/photo-map/endpoints/cache` | JSON `{ "path": "...", "entries": [...] }`; batches are bounded and entries must be direct children of the folder. |

This cache is browser-owned metadata persistence, not a Dropbox upload. See
[Photo Map](photo-map.md).

## Video endpoints

Video routes are documented in [Video Player Architecture](video-player.md),
including probe, subtitle, session, progress, stop, HLS file, and cache-clear
contracts. The durable `/preview` page uses the same preview surface as Photo
Map and starts a video HLS session only when playback is requested.

## Static assets

`GET`/`HEAD /assets/...` serves only files under the constrained asset tree. The
Material Icon Theme and Leaflet/marker-cluster assets are vendored. Static
assets use one-hour public cache headers by default or no-store headers when
`CacheStaticAssets` is false.
