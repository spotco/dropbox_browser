# Music library cache performance plan

Date: 2026-07-18

## Problem observed

`Load Current Folder` in the music player took an estimated 1-2 minutes at
the Dropbox root, despite the folder cache containing roughly 8,000 records.
The active run showed that the cache was mostly, but not fully, complete:

- 7,878 folders and 32,886 songs were returned by a library poll.
- 211 folder records were missing and 218 folders were pending.
- A single `/music/endpoints/library` poll took about 8.4 seconds.
- The client waits 4 seconds after a response before issuing the next poll, so
  repeated expensive polls extend the apparent completion time.

This is not a normal foreground `rclone lsjson` listing miss. The library
does use `FolderCacheManager`, but its persisted cache is currently a set of
per-folder JSON files rather than a ready-to-serve recursive music-library
snapshot.

## Current implementation cost

`build_recursive_library_payload()` in `dropbox_browser/media_library.py` is
called for every music-library poll (and is shared by video). It currently:

1. Calls `ensure_known_subtree()` for the requested root. That walks every
   known descendant via `direct_folders`, reads cache records, checks status,
   and requests missing/incomplete work.
2. Walks the same subtree again to reconstruct all folder and media rows.
3. Repeatedly calls `FolderCacheManager.get()` / `status()`; `status()` itself
   calls `get()`. Each `get()` reads and JSON-decodes a per-folder cache file.
4. Serializes the complete folders/songs payload again and the browser rebuilds
   its library tree from it.
5. Produces a very high number of per-folder deduplication trace events during
   broad incomplete-tree polling.

With thousands of folders this means tens of thousands of file reads and JSON
decodes per poll. A complete cache avoids foreground Dropbox access, but does
not currently avoid that repeated recursive disk traversal and payload build.

## Goal

For an unchanged, complete subtree, a second `Load Current Folder` response
should reuse an in-memory recursive media snapshot and avoid descendant cache
file reads, recursive payload rebuilding, and per-descendant trace noise.

For a partial subtree, polling must continue to show incremental additions and
accurate pending/missing counts without restarting work or blocking the page.
Music and video must retain the same endpoint contract because both use the
shared media-library implementation.

## Proposed implementation

### Phase 1: establish measurements and boundaries

1. Reproduce with a synthetic preloaded cache large enough to model the
   observed shape (thousands of folders and tens of thousands of media files).
   Do not use live Dropbox or time-sensitive network behavior in tests.
2. Add request/payload diagnostics to measure:
   - recursive record reads,
   - recursive snapshot cache hit/miss,
   - payload build elapsed time,
   - folders and media rows returned,
   - aggregate queued/pending/missing counts.
3. Keep diagnostics aggregated per library request. Do not emit one trace event
   per already-deduplicated descendant during a full subtree pass.

### Phase 2: add a safe cache-change signal

1. Give `FolderCacheManager` a monotonic in-process revision/generation that
   changes whenever a record becomes available, changes completeness, is
   invalidated, or is removed.
2. Expose a narrow read-only way for the media-library service to obtain the
   current revision. A conservative global revision is acceptable initially;
   it may rebuild unrelated library roots after any cache change, but avoids
   stale results and keeps the first implementation simple.
3. Ensure all relevant existing mutation paths advance it: worker completion,
   deferred cache flush/repair, direct-listing priming, single-path invalidation,
   tree invalidation, and sync-triggered invalidation.
4. Keep this revision in memory only. No cache schema migration or persisted
   revision is required because a server restart can safely rebuild snapshots.

### Phase 3: cache recursive media snapshots

1. Add an app-owned or media-library-owned in-memory snapshot cache keyed by:
   - root remote path,
   - media kind / supported-extension set,
   - item ID prefix and any enrichment mode,
   - folder-cache revision.
2. On a cache hit, return the existing immutable folder/media rows and status
   data (or cheap copied containers when response isolation is necessary).
3. On a miss, perform one recursive traversal, build the snapshot, and store
   it against the revision observed for that traversal.
4. Prevent races with worker updates: if the revision changes while building,
   either retry once or store the result only under the revision captured at
   the start and let the next poll rebuild. Never label stale data complete.
5. Bound the snapshot cache by root/key count or use small LRU eviction so
   large libraries from many navigated folders cannot accumulate indefinitely.

### Phase 4: make partial polling cheap enough

1. Retain the current non-blocking worker queue behavior and partial endpoint
   contract.
2. Avoid rereading the same folder record several times within a single
   request. Use a request-scoped lookup map while calculating queue/status and
   constructing rows.
3. Rebuild a partial snapshot only when the folder-cache revision changes;
   otherwise return the previous partial snapshot and its previously measured
   counts immediately.
4. Evaluate whether `ensure_known_subtree()` itself needs an indexed in-memory
   view of cached `direct_folders`. If the revision snapshot alone does not
   materially reduce initial partial-poll time, add that as a separate focused
   optimization rather than mixing it into the first change.

### Phase 5: client behavior and compatibility review

1. Keep the current 4-second poll contract initially; measure after the server
   change before altering cadence.
2. Preserve endpoint fields and semantics: `complete`, `pending`,
   `pending_folder_count`, `queued_folder_count`, `missing_folder_count`,
   folders, songs/items, paths, sort fields, and status messages.
3. Verify the shared video library endpoint receives the same performance
   benefit and continues to expose video-specific enrichment fields.
4. Review memory use with the observed-scale fixture before deciding final LRU
   limits.

## Test plan

### New Python coverage

1. Add a focused recursive-media snapshot-cache test module or extend
   `tests/test_music_endpoints.py` with an instrumented fake folder cache.
   Assert that two unchanged complete requests:
   - return equivalent payloads,
   - make no `rclone` calls,
   - perform no second recursive record-read/build pass,
   - produce a snapshot-cache hit diagnostic.
2. Test a partial snapshot returned twice without a cache revision change:
   the second poll must reuse the partial result, preserve pending/missing
   counts, and not enqueue duplicate work.
3. Test worker-style revision advancement: add a cached child or mark a child
   complete, advance the revision, and assert the next poll rebuilds once and
   exposes the new folder/media rows and final status.
4. Test all invalidation paths relevant to this feature (direct, tree, sync
   invalidation) cause a later request to miss the snapshot cache.
5. Add a deterministic large synthetic cache test. Do not assert a wall-clock
   threshold; assert operation counts remain bounded (for example, unchanged
   second load has O(1) snapshot lookup rather than O(number of descendants)).
6. Add equivalent shared-helper/video assertions for video item enrichment and
   cache-key separation from music.
7. Add trace assertions that a large cached subtree produces an aggregate
   request diagnostic rather than thousands of deduplication records.

### Existing tests to retain or extend

1. Keep all current music endpoint tests in `tests/test_music_endpoints.py`:
   cached listing without rclone, direct-files/folders traversal, empty
   complete folder, partial/missing descendants, unavailable root, sorting
   fields, and trace metadata.
2. Extend the existing library-poll trace test with snapshot hit/miss and
   build/read-count fields if those diagnostics become part of the contract.
3. Extend relevant `background-file-info` / cache tests for the new revision
   increments and invalidation behavior.
4. Keep video endpoint tests because the shared helper is changed; add only
   focused snapshot regression cases rather than duplicating all music cases.

### Existing E2E coverage and additions

1. Retain `tests/e2e/music-library.integration.spec.js`. It already verifies:
   initial non-blocking `Load Current Folder`, partial-to-complete growth,
   polling fields, final completion, and no external rclone executable.
2. Extend that E2E with a second click/load after completion. Assert it returns
   quickly, produces no new fake-rclone listing calls, and uses a server-side
   snapshot cache hit.
3. Keep its small staged fixture for functional reliability. Add any
   observed-scale test as a Python operation-count test, not a browser timing
   test, so CI remains stable.
4. Run the existing music and video E2E suites after implementation because
   shared media-library payload construction changes both clients.

## Validation sequence for the later implementation run

1. Add failing focused unit tests for unchanged complete reload and revision
   invalidation.
2. Implement the revision signal and bounded snapshot cache.
3. Run the focused music endpoint and cache/background-worker tests.
4. Add and run the synthetic large-tree operation-count regression.
5. Run the music-library E2E, then relevant video E2E/tests.
6. Reproduce manually with the real cached Dropbox root and inspect only
   aggregate `music_library_poll` diagnostics. Confirm no foreground `rclone`
   listing starts for an unchanged completed reload.
7. Run the full test suite before any later check-in because this changes a
   shared cache and shared media-library helper.

## Expected outcome

After the cache has completed, repeat `Load Current Folder` requests should be
effectively immediate relative to the current 8+ second poll. While a subtree
is still filling, updates should remain incremental, but unchanged poll cycles
should no longer repeatedly scan and decode the entire persisted cache tree.
