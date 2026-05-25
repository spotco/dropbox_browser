# Music Player Implementation Plan

This file tracks upcoming music-player work only. Completed implementation and
test items have been moved to `plans/COMPLETED_MUSICPLAYER.md`.

## Progress

- [x] Read `docs/background-workers.md`, `docs/testing.md`, and this plan.
- [x] Make the music library endpoint use `FolderCacheManager` as its source of
  truth.
- [x] Add non-blocking folder-cache queueing for `Load Current Folder`.
- [x] Add explicit pending-work status to the music library response.
- [x] Update client polling backoff to use pending-work status.
- [x] Add concrete folder-cache APIs for current page epoch lookup and known
  descendant queueing.
- [x] Add focused regression tests.
- [x] Run targeted checks.

## Step 1 - Confirm Current Cache Contracts

- [x] Read `docs/background-workers.md` before editing folder-cache or
  `/folder-info`-adjacent behavior.
- [x] Inspect `dropbox_browser/music.py`, `dropbox_browser/foldercache.py`,
  `dropbox_browser/handlers.py`, and `dropbox_browser/assets/js/music.js`.
- [x] Confirm `FolderCacheManager.request(remote_path, page_time)` still:
  - skips complete cache records;
  - coalesces duplicate queued requests;
  - refreshes active requests without starting duplicate rclone calls;
  - prioritizes newer page epochs before older page epochs;
  - queues discovered descendants breadth-first.
- [x] If any of those contracts changed, update this plan before implementing
  the music changes.

## Step 2 - Add A Folder-Cache Library Snapshot API

Create a small server-side helper that builds the music library from
`FolderCacheManager` records, not directly from `ListingCacheManager`.

- [x] Keep response shaping in `dropbox_browser/music.py`.
- [x] Add any cache traversal or queueing primitives to `FolderCacheManager`
  when they need access to private epoch, priority, in-progress, or direct-child
  state.
- [x] Use `clean_rel_path()` for the requested root path.
- [x] Use `remote_target(app.remote, rel_path)` for Dropbox absolute paths.
- [x] Read folder metadata through `app.folder_cache.get(remote_path)` and
  status through `app.folder_cache.status(remote_path)` where needed.
- [x] Treat `direct_files` and `direct_folders` from folder-cache records as the
  source for library traversal.
- [x] Do not call `app.list_entries()`.
- [x] Do not call `rclone`.
- [x] Do not read `app.listing_cache` directly from the music endpoint.
- [x] Let `FolderCacheManager` continue using `ListingCacheManager` internally
  as an implementation optimization.
- [x] Preserve partial snapshots: return whatever cached folder/song data is
  currently available without waiting for incomplete folders.
- [x] Handle empty folders correctly: a cached folder with no `direct_files` and
  no `direct_folders` can still be a valid complete cached folder.
- [x] Treat a complete root aggregate as insufficient by itself for music
  traversal if child folder cache records needed for descendant songs are
  missing or expired.

## Step 3 - Add Page Epoch API

`Load Current Folder` queueing should use the current navigation epoch when the
music root is the current page. This keeps the work prioritized with the page
the user just navigated to.

- [x] Add a public `FolderCacheManager` method for page epoch lookup, e.g.
  `page_epoch_for(page_key: str) -> float`.
- [x] Under the folder-cache lock, return the current `_min_page_time` only when
  `page_key == _current_page_key` and `_min_page_time` is non-zero.
- [x] If the requested music root is not the current page key, return a fresh
  `time.time()` value.
- [x] Document that fallback requests intentionally become the newest epoch
  because the user explicitly requested music loading for a non-current or
  stale page context.
- [x] Do not make the music endpoint call `notify_page_load()` directly.
- [x] Add tests for current-page epoch reuse and fallback fresh-epoch behavior.

## Step 4 - Queue Missing Folder-Cache Work Non-Blocking

`Load Current Folder` should actively ask the background folder-cache system to
fill missing data, while the HTTP response still returns quickly.

- [x] Add a `FolderCacheManager` API for ensuring known music-library subtree
  records, e.g. `ensure_known_subtree(remote_path, page_epoch) -> dict`.
- [x] The API should queue the root when the root record is missing, partial,
  calculating, or pending.
- [x] If the root record is complete, do not stop there. Walk cached
  `direct_folders` and queue missing, expired, partial, calculating, or pending
  child folder records needed for descendant song discovery.
- [x] Preserve breadth-first depth when queueing known descendants from cached
  `direct_folders`; do not make the music endpoint queue every descendant as a
  depth-0 request.
- [x] Reuse existing `request()` dedupe/single-flight behavior internally where
  practical, or share the same guards for complete, queued, in-progress, and
  active folders.
- [x] Return cheap queueing/pending counts from this API so the music response
  can report pending status accurately.
- [x] Do not block waiting for queued work to start or complete.
- [x] Do not trigger any rclone work on the request thread.
- [x] Add worker trace fields or events only if existing traces cannot prove
  queueing and pending status clearly.

## Step 5 - Return Explicit Pending Status

Make the response tell the browser whether polling should stay fast.

- [x] Add response status fields for pending work, such as:
  - `pending`: boolean;
  - `pending_folder_count`: number of known folders not complete;
  - `queued_folder_count`: number of requests submitted by this response, if
    cheap to report;
  - `missing_folder_count`: number of known folders with no usable folder-cache
    record.
- [x] Keep `cache_status` values simple and stable:
  - `complete` when the root subtree is complete and no pending work remains;
  - `partial` when a usable snapshot exists but more work may arrive;
  - `unavailable` when no root folder-cache data is available yet.
- [x] Keep `complete` as a boolean alias for `cache_status == "complete"`.
- [x] Keep status messages user-facing and compact.
- [x] Avoid relying on “same response as last poll” as a server-side status
  signal.
- [x] Compute pending fields from the same folder-cache ensure/traversal result
  that actually queued work, so the endpoint never reports pending work that no
  worker can reach.

## Step 6 - Ensure Future Sorting Data Is Present

Do not implement sorting yet, but make sure the library payload consistently
contains the fields needed later.

- [x] For every song node, include:
  - `filename`;
  - `display_name` for compatibility with existing UI;
  - Dropbox absolute `remote_path`;
  - `/file` relative `stream_path`;
  - root-relative `rel_path`;
  - file date as `mtime`;
  - file type as `extension`;
  - size when available.
- [x] For every folder node, include:
  - `filename`;
  - `display_name` for compatibility with existing UI;
  - Dropbox absolute `remote_path`;
  - `/file` relative `stream_path`;
  - root-relative `rel_path`;
  - folder direct-listing date as `mtime` when available;
  - recursive aggregate date as `recursive_mtime` when available;
  - file type marker such as `type: "folder"`;
  - `complete` and pending/cache flags.
- [x] Use direct-listing folder mtime for future folder-row sorting parity with
  navigation's direct listing behavior.
- [x] Keep recursive aggregate mtime separate so future UI can explicitly sort
  by newest descendant if that behavior is desired.
- [x] Keep stable IDs based on Dropbox absolute paths.
- [x] Keep playlist and library dedupe based on Dropbox absolute
  `remote_path`.

## Step 7 - Update Browser Polling Backoff

The library should poll quickly while the background cache is still working.

- [x] Keep the existing behavior where pressing `Load Current Folder` starts
  polling `/music/endpoints/library`.
- [x] Keep showing incomplete folder-info state initially when that is all the
  cache has.
- [x] Keep updating the song library as future polls return more cached data.
- [x] Change `music.js` so poll delay increases only when the latest response
  says no pending work remains.
- [x] Reset poll delay to the default whenever `status.pending` is true.
- [x] Stop using identical response fingerprints as the sole backoff trigger.
- [x] Preserve existing behavior that polling stops when the music player pane
  is hidden or the library is reset.
- [x] Preserve expanded folders, selected rows, and scroll position across
  polling updates.

## Step 8 - Regression Tests

Music endpoint tests:

- [ ] Prove the endpoint does not call fake rclone.
- [ ] Prove the endpoint uses `FolderCacheManager` data and does not directly
  read `ListingCacheManager`.
- [ ] Prove a complete folder-cache subtree makes descendant songs visible on
  the next poll.
- [ ] Prove empty complete folders are not mistaken for missing metadata.
- [x] Prove pending fields reflect missing descendants under an otherwise
  complete root.
- [x] Prove song and folder nodes expose filename, Dropbox absolute path, date,
  and type fields.

Folder-cache boundary tests:

- [x] Prove `page_epoch_for(current_page_key)` returns the active navigation
  epoch.
- [x] Prove `page_epoch_for(other_page_key)` returns a fresh epoch.
- [x] Prove the known-subtree ensure API queues missing descendants under a
  complete root.
- [x] Prove duplicate ensure calls do not create duplicate rclone calls for the
  same folder.
- [x] Prove known-descendant queueing preserves newer-page priority and
  breadth-first depth.
- [x] Prove pending counts only include folders that are missing, partial,
  calculating, or pending and can actually be queued or observed.

Client/UI tests:

- [x] Add UI contract tests for polling backoff logic where practical.

## Step 9 - Verification

- [x] Run music endpoint tests:
  `python -m tests.run music -v`
- [x] Run background folder-info tests:
  `python -m tests.run background-file-info -v`
- [ ] Run cache tests if folder-cache APIs changed:
  `python -m tests.run cache -v`
- [x] Run web UI tests if `music.js` or templates changed:
  `python -m tests.run web -v`
- [x] Run compile checks:
  `python -m compileall -q dropbox_browser.py dropbox_browser`
- [ ] Manually verify:
  - navigate to a Dropbox folder;
  - open Music Player;
  - press `Load Current Folder`;
  - confirm the library appears quickly without blocking on rclone;
  - confirm partial state updates while background folder-cache work continues;
  - confirm completed folder-info subtrees expose all descendant supported songs
    on the next music poll;
  - confirm polling slows only after no pending work remains.

## Open Questions

- None.
