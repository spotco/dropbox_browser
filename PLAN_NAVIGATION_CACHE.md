# Navigation Cache And Priority Plan

This plan tracks two related improvements:

1. Make normal folder navigation render from cached direct listings when the
   folder cache already has them.
2. Improve navigation priority only after the cached path is implemented and
   measured.

The implementation should happen in that order. The cached navigation path is
well-scoped and low risk. Priority/foreground coordination is more invasive and
should be added only where tests or trace logs show remaining latency.

## Goal

Make `GET /?path=...` faster without changing sync safety, upload behavior,
delete behavior, streaming behavior, or Windows-safe local name matching.

Expected listing order for normal navigation:

1. `ListingCacheManager`
2. `FolderCacheManager.get_direct_listing()`
3. `rclone.lsjson`

Explicit refreshes (`?refresh=1`) must bypass cached navigation data and force a
fresh listing.

## Progress

- [x] Implement cached navigation.
- [x] Add focused tests.
- [x] Update docs.
- [x] Validate with targeted and full checks.
- [ ] Measure navigation traces.
- [ ] Implement priority improvements only if still needed.

## Phase 1 - Cached Navigation

- [x] Extend `DirectListingMetadata` with `direct_items`, a filtered list of the
      original direct child `rclone lsjson` item dicts.
- [x] Populate `direct_items` in `parse_direct_listing()` from the same valid
      direct children used for `remote_children`.
- [x] Store `direct_items` in `FolderCacheManager._compute()` accumulator state.
- [x] Persist `direct_items` in `foldercache_records.build_cache_record()`.
- [x] Bump `DIFF_CACHE_SCHEMA_VERSION`.
- [x] Reject complete records missing `direct_items` in
      `validate_cache_record()`.
- [x] Keep existing `direct_files` and `direct_folders`; they are still used by
      folder metadata, tests, and music endpoints.
- [x] Add `FolderCacheManager.get_direct_listing(remote_path)`.
- [x] Implement `get_direct_listing()` as read-only:
      - call `self.get(remote_path)` so schema, TTL, and local-root validation
        are reused;
      - return a shallow copy of `direct_items` on hit;
      - return `None` on miss, stale/invalid record, or missing `direct_items`.
- [x] Wire `DropboxBrowser.list_entries()` to check folder-cache direct listings
      after `ListingCacheManager` and before `rclone.lsjson`.
- [x] Bypass folder-cache direct listings when `force_refresh=True`.
- [x] Keep `_entries_from_remote_items()` as the only row-building path so
      ignored names and Windows-safe local matching remain centralized.
- [x] Keep `render_index()` focused on page flow, cache requests, status maps,
      sorting, and rendering. Do not duplicate listing source logic there.
- [x] Preserve current fallback behavior when remote listing fails and a local
      folder exists.

## Phase 2 - Tests

- [x] Add `foldercache_compute` tests for `direct_items` preservation and
      filtering.
- [x] Add `foldercache_records` tests for `direct_items` persistence and schema
      rejection of old complete records.
- [x] Add folder-cache worker coverage that normal `_compute()` writes usable
      `direct_items`.
- [x] Add service tests proving `list_entries()` uses folder-cache direct data
      without calling rclone when the listing cache misses.
- [x] Add service tests proving `force_refresh=True` bypasses folder-cache
      direct data and calls rclone.
- [x] Add web tests proving rendered navigation can show rows from folder-cache
      direct data without a new rclone listing call.
- [x] Include a Windows-name matching case for cached navigation if practical.

## Phase 3 - Docs

- [x] Update `docs/architecture.md` to describe navigation listing order:
      listing cache, folder-cache direct listing, then rclone.
- [x] Update `docs/background-workers.md` to note that folder-cache records
      persist direct child listing items for navigation reuse.
- [x] Update `docs/testing.md` only if a new test group is added.

## Phase 4 - Validation

- [x] Run compile checks:
      `python -m py_compile dropbox_browser.py`
- [x] Run compileall:
      `python -m compileall -q dropbox_browser.py dropbox_browser`
- [x] Run focused tests:
      `python -m tests.run cache background-file-info web names -v`
- [x] Run any specific new tests directly while iterating.
- [x] Run the full suite before handoff:
      `python -m unittest discover -s tests -v`
- [ ] Manually verify:
      - previously populated folders navigate without a new visible-row
        `rclone lsjson`;
      - `?refresh=1` forces a fresh listing;
      - status labels, child folder size/date columns, sorting, and local-only
        rows still behave correctly;
      - `/file` and `/download` byte-range streaming are unaffected.

## Phase 5 - Priority Improvements If Needed

Do this only after Phase 1 is working and traces show remaining navigation
latency from background contention.

- [x] Add lightweight trace events around navigation listing source:
      cache hit, folder-cache direct hit, rclone fallback.
- [ ] Measure whether background workers still block common navigation misses.
- [ ] If needed, add a short wait for an already-active exact folder job before
      issuing a foreground `lsjson`.
- [ ] If needed, design foreground coordination using the existing
      `notify_page_load`, generation, cancellation, `_active_jobs`, and
      `_in_progress` mechanics.
- [ ] Avoid adding a separate foreground executor or second priority queue unless
      measurement proves the existing system cannot support the needed behavior.
- [ ] Do not lower `FolderCacheWorkers` by default unless measurements show that
      configuration is still necessary after cached navigation lands.
