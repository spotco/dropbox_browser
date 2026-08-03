# Background Workers

Read this when changing `dropbox_browser/foldercache.py`,
`dropbox_browser/syncjobs.py`, `/folder-info`, recursive batch planning, or
worker trace/debug behavior. The public route shapes are summarized in
[HTTP/API contracts](http-api.md); this page focuses on ownership, scheduling,
cache records, and observability.

## Folder Cache

`FolderCacheManager` owns recursive folder metadata and folder diff status.
Normal page loads should not synchronously recurse through Dropbox. Page loads
request background work, then `/folder-info` polling returns updated size, date,
count, and status fields.

Initial HTML rendering does not wait for child folder metadata. It uses cached
child metadata when already available, renders missing child metadata as loading,
and relies on `/folder-info` polling to queue and update child folder rows after
the page is visible.

Folder cache jobs:

- use `rclone lsjson` for Dropbox children;
- use the listing cache when available;
- write JSON cache files under `Cache/FolderInfo`;
- keep page-load priority changes cheap by advancing the current epoch without
  bulk-canceling queued or active work on the HTTP request path;
- skip stale queued jobs lazily in workers when a newer page epoch supersedes
  old queued work;
- continue metadata work even after a direct diff is discovered, because size,
  date, and count still need to finish before `complete: true`.

Cache file writes are deferred until after the manager lock is released so
workers and HTTP threads are not blocked on disk I/O. Each dirty mark advances
a per-path write epoch; flush skips or repairs stale snapshots so a late
**partial** parent write cannot clobber a newer **complete** record produced
when a child finishes on another worker.

`/folder-info` returns cached `partial`/`complete` snapshots without re-queueing
in the normal case. As a conservative safety net, when the poll includes a
`current` folder that is still `partial` and every other requested path is
already `complete`, the handler re-requests `current`. Legitimate parents still
waiting on unpolled children dedupe; stuck partial parents can repair pending
children or flush a complete in-memory record back to disk
(`stuck_parent_reenqueued` on `folder_info_poll`, `request_flushed_complete`).

Folder cache data can expose diff status before recursive metadata is complete.
This lets the UI show `Has Diffs` while size/date cells continue loading.
Cache records also persist filtered direct child `lsjson` items. Normal page
navigation can reuse those direct items for visible rows when the listing cache
misses, without waiting for recursive size/date/count work to finish.

## Folder-cache consumers

The folder cache is shared by several features:

- Browse uses direct child records for rows and polls `/folder-info` for
  recursive status, size, date, and count fields.
- Recursive File Search starts a bounded session from `services.py` and uses
  cached or partially computed folder data where possible; it reports progress
  rather than blocking the page request on a whole-tree walk.
- Music and Video libraries use `media_library.py` to turn folder-cache
  snapshots into recursive tree/library payloads. Their clients poll while the
  cache is partial, so a library may grow between responses.

These consumers do not share the Photo Map cache or video probe/subtitle/header
caches. Those are separate feature caches with their own invalidation and
limits; see [Media Caches](media-caches.md) and [Photo Map](photo-map.md).

## Diff Status

Status values:

- `loading` - a remote folder is still being computed.
- `synced` - matching item names, item types, and file sizes.
- `has_diffs` - item presence, item type, or file size differs.
- `local_only` - local item exists without a Dropbox match.
- `dropbox_only` - Dropbox item exists without a local match.

Semantics:

- File comparisons use size once names and item types match.
- Modification time differences do not make an item unsynced.
- Local-only folders show `Local Only` immediately; do not enqueue recursive
  Dropbox jobs for local-only folder contents.
- Dropbox-only folders show `Dropbox Only`, not `Has Diffs`, when the matching
  local folder is absent or the subtree is entirely Dropbox-only.
- Same-name file/folder conflicts display `Has Diffs`.
- Old cache files missing current diff fields must be treated as stale.

## Trace Log

Folder-cache workers and foreground navigation write JSONL trace events under
the current server run directory:

```text
Temp/runs/<unix-start-time>/foldercache_threads.jsonl
```

`Temp/current-run.txt` contains the current run id. Each run directory also
contains `server.json` with startup metadata such as PID, remote, local root,
host, and port.

Other useful generated diagnostics include `Temp/slow_operations.jsonl` for
slow foreground operations, `Temp/client_logs.jsonl` for accepted browser
client logs, and `Temp/video_debug.jsonl` when video debug logging is enabled.

Each line is one JSON object. Common fields include:

- `ts`
- `thread`
- `event`
- `remote_path`
- `queue_size`
- `active_jobs`
- `in_progress`
- `page_completed`
- `page_dispatched`

Useful event names:

- `manager_started`, `worker_started` - worker pool startup.
- `page_load`, `page_load_reused` - page epoch changes.
- `navigation_listing_source` - foreground page listing source and row count.
- `navigation_render_complete` - foreground page render phase timings.
- `folder_info_poll` - `/folder-info` batch size, queued request count,
  status counts, and `stuck_parent_reenqueued` when the partial-current
  safety net fires.
- `request_flushed_complete` - a re-request found complete in-memory state and
  rewrote the on-disk record without a full recompute.
- `music_library_poll` - `/music/endpoints/library` response timing, cache
  status, returned folder/song counts, and client poll scheduling fields.
- `request_enqueued`, `request_reenqueued`, `request_refreshed`,
  `request_deduplicated`, `request_skipped_cached` - public folder-cache
  requests and duplicate coalescing.
- `job_queued`, `job_started`, `job_finished`, `job_aborted`,
  `job_canceled_running`, `job_failed` - worker lifecycle.
- `folder_listing_loaded` - direct `lsjson` result loaded from rclone or cache.
- `direct_diff_found`, `subtree_diff_marked` - diff status determined.
- `subtree_complete` - recursive metadata is complete for that path.

For live debugging, inspect the tail while loading pages or polling
`/folder-info`. In tests, `IsolatedPathsTestCase.read_trace_events()` reads the
same JSONL format from the isolated temp directory.

The music-library Playwright integration test also uses these trace events. The
dedicated `8011` integration harness drives an uncached `/?path=music` page,
opens `Music Player`, clicks `Load Current Folder`, and verifies that:

- the initial request returns without blocking on descendant folder recursion;
- Song Library can start in a partial `not cached` state while folder-cache
  workers are still computing descendants;
- staged subtree completion grows the library incrementally through polling
  without another manual click;
- the final library state becomes complete after the background workers finish.

## Sync Job Workers

`SyncJobManager` owns browser-triggered sync work and grouped progress.
Single-file jobs have priority over queued batch jobs. Batch operations must
continue after per-file failures and report errors in `/sync-status`.

Sync may overwrite the selected destination in the selected direction, but it
must not delete destination-only files.

`rclone.py` applies the configured retry/timeout policy to write operations and
records subprocess output according to the logging settings. Browser sync does
not execute a generated local-only `.bat` command; the batch endpoint queues
the approved copy plan through the sync workers. See [Sync and rclone](sync-and-rclone.md).

Known performance caveat: `/sync-batch-plan` computes a plan for confirmation,
then `/sync-batch` recomputes before queuing jobs. On large recursive folders
this can look like the confirmed batch action is hanging before any `rclone
copyto` work starts.

## Relevant Tests

Run targeted groups while working:

```powershell
python -m tests.run background-file-info -v
python -m tests.run file-sync -v
python -m tests.run diff -v
python -m tests.run cache -v
python -m tests.run music -v
python -m tests.run video -v
```

Run the full suite before checkin/commit or after broad shared changes:

```powershell
python -m unittest discover -s tests -v
```
