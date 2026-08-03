# Photo Map

Photo Map is a client-side bottom pane for plotting geotagged remote media from
the current browse folder. Its host is `assets/js/photo-map.js`; focused modules
under `assets/js/photo-map/` own listing selection, bounded metadata parsing,
cache, grouping, Leaflet integration, thumbnails, and diagnostics.

## Scope and supported media

Photo Map requests the current folder's direct browse listing. It does not
recursively scan the Dropbox tree. It recognizes:

- `.jpg` and `.jpeg` as photos parsed from JPEG EXIF GPS metadata;
- `.mov` and `.mp4` as videos parsed from QuickTime/ISO-6709 location atoms.

PNG and HEIC are intentionally unsupported by this feature, even though other
parts of the browse UI may display them. Files with no usable location remain
known to the parser/cache as `no-location` instead of silently becoming a map
pin.

The date selector supports All time, Last 90 days, Last year, and a custom
range. Date filtering uses the browse listing date before metadata fetches are
queued. Results are ordered newest first.

## Metadata reads

Photo Map never downloads a complete remote photo or video merely to locate it.
It uses ranged `/file` requests with bounded budgets:

- JPEG: the first 256 KiB;
- QuickTime: a 1 MiB head range and, when necessary, a 1 MiB tail range.

The parsers validate coordinate ranges, capture dates, TIFF byte order, JPEG
segments, and QuickTime atom boundaries. A located record contains latitude,
longitude, optional capture date, and listing identity. Parse states are
`located`, `no-location`, `unsupported`, and `error`.

Metadata work has a concurrency of three. Results are written to the browser-
owned cache in batches of at most 200 records. The cache writer may finish
persisting a completed batch after the user switches panes, but it must not
continue remote scanning or update the closed map.

## Map lifecycle and grouping

Photo Map code is loaded with the page, but map creation, cache reads, range
requests, and thumbnail scheduling begin only when the Photo Map mode is active
or is restored as the selected initial mode. Switching to Server Log, File
Search, Music, or Video:

- destroys the Leaflet map;
- aborts active metadata and thumbnail requests;
- increments the lifecycle generation so late promises are ignored;
- retains only cache writes that already accepted a batch.

The map uses vendored Leaflet and marker-cluster assets served through the
constrained asset handler. Pins can be grouped by distance. The choices are Off,
50 m, 100 m, 500 m, 1000 m, and 10 km; the default is 100 m. Group markers use
the newest/most useful member thumbnail and open a popup grid for members.
Thumbnails for visible markers and visible members of an open group are
demand-driven, with a concurrency of two. Hidden group members are not eagerly
downloaded.

The map fits to the initial located results once. Later progressive results do
not repeatedly override a user's pan/zoom. Resizing the pane or entering the
shared full-page mode calls Leaflet's size invalidation.

## Preview behavior

Selecting a pin or group member opens the shared Photo Map preview surface. The
preview route is `/preview?path=&source=remote` and has no session id in its
URL. Images show their cached poster directly. Videos start a fresh HLS
compatibility session only after Play is pressed, report progress while active,
and stop the session when closed or unloaded. The first fatal HLS failure gets a
single forced-transcode retry; persistent failure leaves a Download Original
link.

Preview context records the selected group/member and scroll position so
closing the full-screen/standalone preview returns to the same popup state.
The shared implementation is `assets/js/photo-map-preview.js`, also used by
the durable `/preview` page.

## Cache contract

The browser reads and writes:

- `GET /photo-map/endpoints/cache?path=`;
- `POST /photo-map/endpoints/cache` with `{path, entries}` JSON.

The server stores hashed folder files under `Cache/PhotoMap/`. It validates
relative paths, direct-child membership, size/modification identity, statuses,
coordinates, capture dates, and parser versions. A cache identity includes
path, size, and modified time; changing the listing identity causes a metadata
re-read. Each folder is capped at 50,000 records, and each request batch at 200.

Photo Map cache state is separate from `Cache/FolderInfo`, `Cache/ListingCache`,
and video/image thumbnail caches. It is local metadata persistence, not a
remote write.

## Diagnostics and tests

Photo Map diagnostics are controlled by the `photo-map` client-log subsystem.
The browser exposes `window.DropboxBrowserPhotoMap` for focused inspection,
including map/debug state, cache summaries, and lifecycle counters. Server
accepted logs are written to `Temp/client_logs.jsonl`.

Run:

```powershell
python -m tests.run photo-map -v
npm run test:js:photo-map
npx playwright test tests/e2e/client-render.photo-map.spec.js --project=client-render
npx playwright test tests/e2e/client-render.photo-map-preview.spec.js --project=client-render
```

The preview e2e suite uses local fixtures and fake rclone; it does not require
live Dropbox media.
