# Photo Map grouped pins and grouped previews

## Confirmed product decisions

- Replace unusable 50+ item spiderfied clusters with one emphasized grouped
  photo pin.  The pin has a count badge and grows through a small number of
  count tiers so larger groups are visibly more important without becoming
  enormous.
- Grouping is based on geographic distance in meters, controlled by a Photo
  Map toolbar control immediately next to Date range.  The initial default is
  **20 m**; this is an intentionally conservative value derived from the live
  data below.  Include an explicit Off/0 m option for users who want individual
  photo pins.
- Grouped pins contain photos only for now.  Video pins retain their current
  neutral GPS-only marker and popup because video thumbnail extraction remains
  deferred.
- A grouped-pin click opens a scrollable thumbnail grid.  The existing shared
  thumbnail URL and rate-controlled browser queue are reused; the grid loads
  visible/near-visible members first rather than issuing hundreds of requests
  at once.
- Clicking a thumbnail selects that member in the same popup and shows its
  existing filename, coordinates, capture/listing dates, and full-preview link
  while keeping the grouped grid available for navigation.
- Disable Leaflet spiderfying for the Photo Map layer.  Ordinary Leaflet
  clusters may still zoom into a region, but a max-zoom click must not fan out
  dozens of individual markers over one another.
- Grouping is browser-only.  The server continues to receive and cache
  ordinary per-photo metadata and does not persist grouped-pin state.

## Live data used to choose the default

Brave DevTools inspection of the running `Camera Uploads` Photo Map found a
repeatable dense location near `39.04317, -77.11745`:

- **Last 90 days:** 252 located photos; the dense group contained 25 photos
  with an observed maximum pairwise spread of about 10 m.
- **Last year:** 815 located photos; the dense group contained 93 photos with
  an observed maximum pairwise spread of about 18 m.
- **All time:** 12,000+ located photos; the dense group contained 313 photos
  (an earlier view showed 328) with an observed maximum pairwise spread of
  about 21 m.

The 20 m default groups the recent burst and the one-year group while avoiding
an unnecessarily broad neighborhood radius.  The implementation should show
the current value in meters so the choice remains understandable and
adjustable.

## Implementation checklist

### 1. Add the grouping-distance control

- [x] Add a `Grouping distance` control beside Date range in the existing
  toolbar-controls region.  Offer Off/0 m, 5 m, 10 m, 20 m, 50 m, and 100 m;
  select 20 m by default.
- [x] Keep future controls in the existing extensible controls region and keep
  reload/actions in the separate trailing-actions region.  Preserve the
  responsive wrapping behavior established for Date range.
- [x] Recompute map marker data when the control changes, without rereading
  the remote listing or metadata ranges.  Reuse the current generation's
  metadata and thumbnail result cache.
- [x] Add focused host/config tests for the default, Off option, numeric values,
  and re-grouping without a new metadata request.

### 2. Build deterministic browser-side photo groups

- [x] Add a pure grouping helper that accepts located photo items and a meter
  radius, returning stable singleton/group records.  Use a geographic distance
  calculation and a spatial index/grid so large folders do not become an
  O(n²) scan.
- [x] Ensure grouping does not create transitive chains that extend far beyond
  the selected radius.  Use deterministic input ordering and keep every
  member within the selected radius of the group's first-item anchor; the
  centroid is display-only.  Document the representative rule in the helper.
- [x] Preserve each member's source path, metadata, and existing thumbnail
  cache identity.  Group records should expose a stable group id, center,
  member list, member count, and a grouped/photo kind marker.
- [x] Leave videos out of groups and keep them as their current individual
  marker records.
- [x] Add tests for singleton behavior, radius boundaries, stable ordering,
  multiple separated groups, large-group counts, and photo/video separation.

### 3. Render emphasized grouped pins without spiderfy

- [x] Extend map marker reconciliation to accept grouped records without
  replacing stable individual markers unnecessarily.  Render grouped records
  with a distinct larger `DivIcon`, a count badge, and count tiers (for
  example 2–9, 10–49, and 50+).
- [x] Keep the group center visibly connected to the geographic location and
  preserve keyboard focus, title/accessible label, click behavior, and normal
  singleton photo/video visuals.
- [x] Configure the MarkerClusterGroup so max-zoom clicks never spiderfy.
  Keep broad-area clustering/zooming for separate groups, and ensure grouped
  pins themselves are not treated as a request to fan out their members.
- [x] Keep grouped pins directly clickable at the map's maximum zoom by
  disabling broad Leaflet clustering there; a count bubble at max zoom cannot
  zoom farther and would otherwise appear to ignore clicks when spiderfy is
  disabled.
- [x] Add map tests for grouped icon markup, badge counts, size tiers,
  accessibility labels, stable marker reuse, and disabled spiderfy behavior.

### 4. Implement the grouped-pin popup grid

- [x] Add a safe interim grouped-pin popup shell that reports the group count
  and center without offering a synthetic full-preview URL; replace it with
  the scrollable member grid in the remaining popup work below.
- [x] Extend popup rendering with a grouped preview widget containing the
  member count, scrollable grid container, loading placeholders, loaded
  thumbnails, and an explicit empty/error state.
- [x] Reuse `buildPhotoMapThumbnailUrl` and the persistent Photo Map thumbnail
  scheduler.  The group popup must not create an independent uncontrolled
  image queue or a second thumbnail URL path.
- [x] Prioritize the selected group's first visible grid rows, then lazy-load
  additional rows using viewport/scroll observation.  Keep the existing
  concurrency limit and abort queued/offscreen member work when the popup
  closes, the group is no longer visible, or the map generation changes.
- [x] Clicking a grid thumbnail selects that member's details in the popup:
  filename, coordinates, capture/listing dates, and the existing full-preview
  link.  Keep a clear way to return to the grid/member overview.
- [x] Add tests for grouped popup HTML, count/grid ordering, loading/error
  states, member selection, safe preview links, deduplication, and late-result
  suppression.

### 5. Reconcile visibility, cache, and lifecycle behavior

- [x] Keep grouped members out of the individual-photo thumbnail scheduler;
  grouped-member demand will be handled by the grouped popup queue so a
  visible aggregate pin does not eagerly request every hidden member.
- [x] Make visible grouped pins request member thumbnails only while the group
  marker is individually visible.  A clustered/hidden grouped pin must not
  schedule all of its members.
- [x] On distance changes, map moves, date changes, pane switches, and folder
  changes, abort stale grouped-member requests without deleting successful
  in-memory thumbnail results within the active generation or allowing late
  results to mutate a newer generation.  Existing generation resets still
  clear path-keyed thumbnail state to avoid carrying stale files across a
  date/folder identity change.
- [x] Preserve the grouped popup grid's scroll position while progressive
  marker updates refresh member content; keep the outer Leaflet popup alive
  and restore the saved offset after any necessary content update.
- [x] Keep individual-photo thumbnail behavior unchanged when grouping is Off
  or no nearby partner exists.
- [x] Extend diagnostics with group count, grouped-member count, grouping
  distance, and grouped-thumbnail queue/cancellation counters.

### 6. Browser-level validation

- [ ] Add a Playwright fixture with a dense burst containing at least 25
  photos, a 90+ photo group, separated nearby photos, and videos.  Verify the
  map shows emphasized grouped pins rather than spiderwebs, with correct
  count badges and singleton video fallbacks.
- [ ] Verify 20 m, Off, and another distance setting regroup without metadata
  rereads; open a large group and scroll its grid while observing bounded
  thumbnail requests and correct member details.
- [ ] Manually validate the live `Camera Uploads` dense location at 90 days,
  one year, and All time, including popup usability and map movement away from
  the group.

## Deferred deliberately

- Video thumbnail extraction and grouped video previews.
- Server-side grouping, persisted group records, reverse geocoding, and
  clustering across descendant folders.
- Full thumbnail prefetching for every member of a very large group; loading
  remains demand-driven through the browser queue.
