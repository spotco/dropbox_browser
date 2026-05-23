# Navigation Cache And Priority Plan

## Goal

Make `GET /?path=...` fast even while background folder workers are active and
while multiple browser tabs are navigating the app.

The page response should be blocked only by the current folder listing needed to
render visible rows. Child folder metadata is opportunistic:

- use cached child metadata when it already exists;
- render missing child metadata as loading/unknown;
- enqueue background metadata work without waiting for it;
- update existing rows through `/folder-info` polling when work completes.

Keep sync safety, upload behavior, delete behavior, streaming behavior, and
Windows-safe local name matching unchanged.

## Current Diagnosis

The cached listing path is working, but logs show navigation can still be slow
for two different reasons.

Run `1779339545` showed child-folder metadata and eager background cancellation
on the request path:

- `af_vid_dl`: listing cache hit in about 5 ms, but page render took about 12 s.
- root back navigation: listing cache hit in about 2 ms, but
  `notify_page_load()` took about 6.3 s.
- `music`: listing cache hit in about 16 ms, but total render took about 33.7 s;
  child folder cache/status mapping took about 24.1 s for 388 folders.

Phases 1-3 removed child metadata from first paint, stopped bulk cancellation
inside `notify_page_load()`, and coalesced duplicate folder metadata requests.

Run `1779340888` showed the remaining bottlenecks:

- `music/aldnoah_zero_ost`: foreground listing used `rclone` and took about
  8.8 s. The folder had been queued for background metadata, but the queued job
  never completed before navigation and was later skipped as stale. This was a
  real foreground `rclone lsjson` miss, not cache/render overhead.
- `af_vid_dl`: listing was fast, but `notify_page_load()` waited about 7.3 s
  for `FolderCacheManager._lock`.
- `af_vid_dl/downloads`: listing took about 0.67 s, but `notify_page_load()`
  waited about 6.1 s for the manager lock.
- `spotco_game_archive`: listing was fast, but `notify_page_load()` waited
  about 9.6 s for the manager lock.

The manager-lock waits line up with background workers finishing large folder
listings and then holding the lock while updating state, writing cache records,
enqueuing children, and tracing. Example background jobs from run `1779340888`:

- `dropbox:Camera Uploads`: `rclone`, about 23.6 s, 26,124 items.
- `dropbox:spotco_game_archive/.../graphics/jk`: `rclone`, about 14.1 s,
  4,089 items.
- `dropbox:af_vid_dl/audio_downloads`: `rclone`, about 3.1 s, 2,367 items.

The next fixes should make page-load priority not wait behind long worker
critical sections, and should improve foreground behavior when the exact
navigated folder was already queued but not yet cached.

## Completed

- Implemented cached navigation listing order:
  `ListingCacheManager`, then `FolderCacheManager.get_direct_listing()`, then
  `rclone lsjson`.
- Added `direct_items` to folder-cache direct-listing metadata and persisted it
  with a schema bump.
- Added tests for direct-item parsing, persistence, schema validation, service
  listing behavior, web rendering, cache invalidation, and name matching.
- Updated architecture, background-worker, and testing docs for cached
  navigation.
- Added foreground navigation trace events:
  `navigation_listing_source`, `navigation_render_complete`, and page-load lock
  timing.
- Added per-server-run trace directories under
  `Temp/runs/<unix-start-time>/`, with `Temp/current-run.txt` pointing at the
  active run.
- Validated with targeted groups and the full unittest suite.

## Remaining Work

### Phase 1 - Non-Blocking Child Folder Metadata

- [x] Change `render_index()` so no child folder metadata is required before the
      page is returned.
- [x] Keep rendering all current-folder rows immediately.
- [x] Use already-cached child folder metadata when available.
- [x] Show loading/unknown state for child folders whose metadata is missing.
- [x] Ensure `/folder-info` polling updates those rows after background metadata
      completes.
- [x] Add trace fields for child metadata behavior:
      cached child metadata hits, missing child metadata count, deferred
      request count, `/folder-info` queued request count, status counts, and
      elapsed time.

### Phase 2 - Cheap Page-Load Priority

- [x] Make `FolderCacheManager.notify_page_load()` cheap on the request path.
- [x] Stop doing bulk queued-job cancellation/removal while the HTTP request is
      waiting.
- [x] Reprioritize the latest navigated page quickly.
- [x] Let workers skip stale queued jobs lazily when they dequeue work.
- [x] Keep older tab work functional, but lower priority than the latest
      navigated tab.

### Phase 3 - Background Work Deduplication

- [x] Ensure a folder has at most one queued or active metadata job at a time.
- [x] When multiple tabs request the same folder metadata, update priority
      instead of adding duplicate work.
- [x] Preserve current in-progress work where possible rather than canceling and
      restarting it.
- [x] Add tests covering duplicate request coalescing and latest-page priority.

### Phase 4 - Validation

- [x] Run focused tests:
      `python -m tests.run background-file-info cache web -v`
- [x] Run compile checks:
      `python -m py_compile dropbox_browser.py`
- [x] Run compileall:
      `python -m compileall -q dropbox_browser.py dropbox_browser`
- [x] Run the full suite before handoff:
      `python -m unittest discover -s tests -v`
- [ ] Manually verify navigation with active background workers:
      root, `af_vid_dl`, back to root, `music`, and another tab navigating a
      different folder.
- [ ] Confirm wide folders render before child metadata finishes and later
      update through `/folder-info`.

### Phase 5 - Reduce Folder-Cache Lock Contention

Problem: `notify_page_load()` no longer performs expensive cancellation, but it
still needs `FolderCacheManager._lock`. If a background worker holds that lock
for seconds after a large `rclone lsjson`, navigation still blocks before the
page can render.

- [ ] Add trace around long lock-held sections in folder-cache workers:
      `_compute()` state update, cache writes, child enqueue loops,
      propagation/completion, and trace-heavy loops.
- [ ] Measure lock hold time separately from rclone time. Preserve existing
      `page_load lock_wait_ms` tracing so before/after runs are comparable.
- [ ] Move slow work out of the manager lock where safe, especially cache file
      writes and per-child queue/trace work.
- [ ] Batch child enqueue decisions under the lock, then perform queue puts and
      trace appends after releasing it when correctness allows.
- [ ] Keep shared state mutation protected: `_in_progress`, `_active_jobs`,
      `_direct_done`, `_pending_children`, `_parent`, `_child_contrib`, `_acc`,
      progress counters, and abandoned/generation state must remain consistent.
- [ ] Add tests that simulate a worker holding or updating many child folders
      and assert `notify_page_load()` stays fast.

### Phase 6 - Exact Queued Folder Navigation Handoff

Problem: a folder can be queued for background metadata but still not have a
usable cached direct listing when the user navigates to it. In run `1779340888`,
`music/aldnoah_zero_ost` was queued/requeued several times, but navigation still
fell back to foreground `rclone lsjson` for about 8.8 s and the background job
was later skipped as stale.

- [ ] Add an API on `FolderCacheManager` to detect whether the exact current
      folder is queued or active and to refresh its priority for the latest page
      without duplicating work.
- [ ] Consider a short bounded wait for an exact active/queued folder to finish
      direct listing before foreground navigation starts its own `rclone lsjson`.
      The wait must be small and configurable in code, not an unbounded block.
- [ ] If the exact queued job is stale only because a newer page epoch arrived,
      requeue it at the latest page priority instead of allowing it to be
      skipped after the user navigates directly to that folder.
- [ ] Avoid duplicate rclone calls for the same exact folder. If foreground
      navigation must fall back to `rclone`, ensure the background job is
      coalesced, canceled, or marked satisfied so it does not repeat the same
      listing.
- [ ] Add tests for a queued exact folder, an active exact folder, a stale exact
      folder refreshed by navigation, and timeout fallback to foreground
      `rclone`.
