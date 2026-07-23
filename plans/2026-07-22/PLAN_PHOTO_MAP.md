# Photo Map bottom-panel prototype

## Confirmed product decisions

- The new `Photo Map` bottom-panel mode maps media in the currently active
  folder only; it does not recurse into descendant folders.
- The browser drives the work: it reads the already-supported client-rendered
  folder listing, filters and orders candidates newest-first, schedules work,
  and cancels all active/queued work when the mode or folder changes.
- The default date range is **All time**, with 90-day, 1-year, and custom date
  range controls.  Results still enter the queue newest-first within the
  chosen range.
- Start with iPhone-originated still photos and videos.  Initial video support
  is GPS-only; a video thumbnail is explicitly a later enhancement.
- Use iOS-style clustered location pins.  Clusters show a count and expand as
  the user zooms.  Clicking an individual pin opens a small preview widget
  with its cached thumbnail, filename, GPS coordinates, capture/listing date,
  and an explicit link to the existing file preview.
- Vendor Leaflet and its license with the application.  Fetch standard
  OpenStreetMap raster tiles directly from the browser, show the required
  attribution, and do not prefetch or proxy map tiles.
- Keep the server passive: it validates and persists browser-discovered media
  metadata and serves existing thumbnail-cache results.  It must not launch a
  folder-wide rclone scan or independently schedule photo-map work.

## Completed foundation

- [x] Vendored Leaflet 1.9.4, Leaflet.markercluster, licenses, exact asset
  serving, the Photo Map pane shell, responsive CSS, accessible controls, and
  Leaflet-safe panel wheel handling.
- [x] Client listing integration: current-folder-only candidate selection,
  date ranges, newest-first ordering, non-recursive loading, and thin host
  modules.
- [x] Supported-format configuration and bounded browser parsers for JPEG EXIF
  GPS and iPhone MOV/MP4 QuickTime location metadata, including validation,
  capture/listing dates, source paths, and per-item failures.
- [x] Disk cache API and validation: normalized remote paths, size/mtime
  identity keys, stale-entry rejection, safe cache files, batch limits, and
  current-folder read/merge behavior.
- [x] Generation cancellation: abortable listing/range/cache requests,
  thumbnail queue cancellation, late-result suppression, map cleanup on pane
  deactivation, and cache-aware reopening.
- [x] Map rendering foundation: clustered markers, direct OSM tiles and
  attribution, configured defaults, diagnostics counters, progressive/cached/
  empty/error states, and one-time fit-to-results behavior.
- [x] Thumbnail foundation: a separate low-concurrency queue that only selects
  located photos marked visible or selected.
- [x] Focused Python and Node coverage for cache validation, parsers, listing
  filtering/order, queue behavior, cancellation, and web asset contracts.

## Remaining implementation checklist

### 1. Persist metadata incrementally — next step

- [ ] Persist each completed Photo Map metadata result (parsed EXIF/QuickTime
  coordinates, capture date, and status) as the metadata queue produces it.
- [ ] Flush in bounded batches without waiting for the entire folder queue to
  finish; completed results must survive a page refresh or server restart.
- [ ] Keep writes generation-safe so results completed before cancellation are
  retained, while late results and aborted writes are ignored.
- [ ] On a fresh load, paint matching cached pins immediately and issue range
  requests only for uncached or changed listing identities.
- [ ] Add regression coverage for partial queue completion, refresh/abort, and
  reuse of already-written per-image records.

### 2. Complete individual-pin previews

- [ ] Connect marker selection/click handling to the thumbnail queue and retain
  the loaded thumbnail for that marker's preview.
- [ ] Replace the current text-only popup with an accessible preview widget
  containing the thumbnail, filename, latitude/longitude, capture date, and
  listing date.
- [ ] Make the thumbnail a deliberate link to the existing `/file` preview,
  opening the full image in a new tab with safe link attributes.
- [ ] Give video pins a neutral media icon and useful GPS-only preview state;
  keep video thumbnail extraction deferred.
- [ ] Add focused tests for popup contents, thumbnail loading on pin selection,
  preview-link target behavior, and the video fallback.

### 3. Report unsupported candidate formats cleanly

- [ ] Carry PNG, HEIC, and other recognized-but-unsupported candidate rows
  through Photo Map result/status accounting instead of filtering them out
  before the map can report their unsupported state.
- [ ] Preserve the no-range-request behavior for unsupported formats and show a
  concise unsupported/no-location distinction in the user-facing state.
- [ ] Add focused coverage for unsupported rows in the normal listing-to-state
  flow.

### 4. Finish Leaflet lifecycle cleanup

- [ ] Register an explicit page-teardown path so the map instance is destroyed
  when the page is torn down, not only when the pane is deactivated.

### 5. Browser-level validation

- [ ] Add one narrow Playwright smoke test with an isolated fixture and mocked
  map tiles: open Photo Map, verify nonzero pane size, observe a cached
  pin/cluster, switch tabs, and assert queued requests are aborted.
- [ ] Manually validate `/?path=Camera+Uploads`: immediate All-time loading,
  newest-first results, usable clustering at wide/close zooms, date-control
  requeueing, responsive loading, and no network/cache activity after leaving
  the pane.

## Deferred deliberately

- Video thumbnail extraction and preview frames.
- HEIC/PNG and other non-JPEG location parsers.
- Reverse geocoding, location-name search, offline maps, tile prefetching, or
  a server-side tile proxy.
- Recursive folder map aggregation.
