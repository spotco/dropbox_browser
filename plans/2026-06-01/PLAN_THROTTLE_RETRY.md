# Plan: throttle-aware retry for Dropbox write limits

Status: completed on 2026-06-01.

## Goal

Make browser-driven `sync all local to dropbox` converge even when Dropbox
temporarily rejects concurrent writes with API throttle errors such as:

```text
too_many_write_operations
```

After this plan is implemented, a batch local-to-Dropbox sync should not finish
in a permanently unsynced state just because Dropbox asked the client to slow
down. The batch may take longer, but it should keep retrying delayed writes
until the batch either succeeds or reaches a clear retry limit with actionable
errors.

## Current diagnosis

Single-file uploads now succeed because local-to-Dropbox writes use
`rclone rcat`, which avoids the Windows Unicode local-path parsing regressions.

The remaining failure mode is batch concurrency:

1. The app is configured with `SyncJobWorkers = 8`.
2. `sync all local to dropbox` submits many `local_to_dropbox` jobs in
   parallel through `SyncJobManager`.
3. Dropbox sometimes rejects some of those concurrent writes with
   `too_many_write_operations`.
4. The current batch runner records those failures, marks the batch complete
   with errors, invalidates caches, and stops. The files remain unsynced until a
   human retries them manually.

This is now a write-throttling problem, not a filename-encoding problem.

### Observed evidence from recent runs (post-80b8eca, June 2026)

Full raw rclone stderr for the actual `too_many_write_operations` (and related Dropbox
write throttle) cases has **not** been persisted in any run artifacts. Searches of
`Temp/runs/*/`, `.dropbox-browser-temp/e2e-integration/...`, debug .err.txt files,
and all other logs turned up zero instances of the throttle wording or accompanying
Dropbox API response bodies.

- Contrast: the older unicode local-source regressions *do* have complete
  multi-attempt stderr captures in `Temp/rclone-real-repro/*-failure.stderr.log`
  (the classic "Local file system at //?/... : error reading source root directory:
  directory not found" + rclone retry spam).
- Throttle errors only ever appeared live in the terminal (via `logoutput` + rclone's
  own `ERROR :` / `Attempt N failed` / `NOTICE: Failed` lines) and transiently in
  the per-batch `syncstate` error list.

**Command that now produces the errors:**
- After the unicode fix, local-to-Dropbox file uploads use
  `rclone rcat --size <N> -- dropbox:full/rel/path` (stdin pipe) rather than
  `copyto`. The throttle classifier and any new persistent logging should look for
  failures on `rcat` invocations. See `RcloneClient.copy_file_overwrite` +
  `_is_local_upload` in `dropbox_browser/rclone.py`.

**Reliable indirect signals in persisted traces (use these for timing correlation
and repro setup):**
- Recent run directories (e.g. `1780292116` started 2026-06-01T01:35:16 and nearby
  `17802920xx` siblings) contain `foldercache_threads.jsonl` with heavy activity of:
  - `"event": "direct_diff_found"`
  - `"event": "subtree_diff_marked"`
  - `"reason": "Local only: <Artist> - <Title>.mp3"` (or similar track names)
  - `"remote_path": "dropbox:dropbox_browser/betty_youtube_5_26_2026"`
  - Overall folder status `"diff_status": "has_diffs"`
- Corresponding `Cache/FolderInfo/<hash>.json` entries for the same remote path
  record the "Local only" `first_diff_path` plus per-track statuses.
- These come from the background folder-cache workers right before a user would
  trigger the bulk "sync all local to dropbox" that then hits the throttle.
  See `workertrace.py`, `foldercache*.py`, and `docs/background-workers.md`.
- `server.json` in each run dir gives exact start timestamp, pid, `local_root`
  (`F:\\Dropbox`), and remote for correlation.

The `betty_youtube_5_26_2026` folder (and similar large artist/track drops under
music/ or dropbox_browser/) is the canonical hot-path repro for these batch
throttle failures in practice.

**Recommendation for the implementation:**
When adding the central throttle classifier (item 1) and the delayed-retry logic
(items 3-4), also ensure that any classified throttle failure (and ideally all
batch `local_to_dropbox` failures) records the *full raw rclone stderr*, the exact
command argv, size, timestamp, and op_id. A good home is a new `sync_jobs.jsonl`
(or `batch_errors.jsonl`) inside the per-run directory (parallel to the existing
`foldercache_threads.jsonl`). This will give future debuggers the precise Dropbox
wording on the next occurrence without needing a live high-concurrency repro.

## Planned implementation

1. Classify Dropbox throttle errors centrally in `dropbox_browser/rclone.py`.
   Add a helper that detects retryable Dropbox write-throttle failures from
   stderr text, starting with:
   - `too_many_write_operations`
   - closely related Dropbox batch-write throttle wording if present in real
     logs.

2. Expose a retryable-throttle signal to the sync job layer.
   Keep `RcloneClient.copy_file_overwrite()` raising `BrowserError` for failed
   writes, but preserve enough message detail for `SyncJobManager` to recognize
   throttle failures without fragile string handling scattered across the app.

3. Add delayed retry scheduling in `dropbox_browser/syncjobs.py` for
   `local_to_dropbox` jobs that fail due to Dropbox throttling.
   The retry behavior should be owned by the sync job manager rather than the
   HTTP handler so a batch operation can remain active while retries are still
   pending.

4. Keep the batch operation open until all retryable throttle failures are
   resolved or exhausted.
   Do not mark the batch complete while delayed retry jobs are still pending.
   Progress accounting must include:
   - original jobs already completed successfully;
   - retry-delayed jobs still outstanding;
   - exhausted retry failures that will remain as real errors.

5. Use bounded backoff for throttle retries.
   Start conservatively with a small escalating delay per file, for example:
   - retry 1: `2s`
   - retry 2: `5s`
   - retry 3: `10s`
   - retry 4+: clamp at a reasonable ceiling

   Keep the retry count bounded so a truly stuck batch still terminates with a
   useful error instead of running forever.

6. Scope the retry behavior narrowly to Dropbox-bound batch writes.
   Apply delayed retry only when all of the following are true:
   - job kind is `local_to_dropbox`;
   - the operation is part of a batch;
   - the failure matches the retryable Dropbox throttle classifier.

   Do not change:
   - single-file sync semantics;
   - Dropbox-to-local behavior;
   - delete behavior;
   - listing/streaming behavior.

7. Consider a complementary concurrency cap for Dropbox writes.
   Delayed retry is the required behavior change, but the implementation should
   leave room for reducing effective concurrent `local_to_dropbox` writes later,
   either globally or only after throttles are observed. The retry design should
   not assume the worker count stays at `8`.

8. Improve batch status messaging.
   When the app is retrying throttled files, surface that explicitly in
   `syncstate`, for example:
   - `Retrying throttled Dropbox writes`
   - include pending retry count
   - include the next delayed retry command/path when useful

   This avoids the current ambiguity where a batch appears to be “done” even
   though some files still need another attempt.

9. Fix command/status text to reflect actual upload transport.
   Batch local uploads now use `rcat`, not `copyto`. Status and debug strings in
   `syncjobs.py` should reflect the real command path so future investigations
   are not misled by stale labels.

## Regression coverage

Add focused tests in `tests/test_syncjobs.py` and related helpers.

Cover at least:

- a batch `local_to_dropbox` job that fails once with a simulated throttle
  error, is retried after delay, and eventually completes successfully;
- a batch with multiple throttled files where the operation remains `running`
  while retries are pending and only becomes `complete` after the retries
  finish;
- a throttled file that exceeds the retry limit and leaves the batch complete
  with errors;
- a non-throttle write failure that is not retried;
- status/command text for local batch uploads uses `rcat`;
- existing parallel sync-job tests still pass.

If practical, add a narrow `rclone`-layer unit test for the throttle classifier
so new Dropbox wording can be covered without driving the full batch queue.

## Validation

Run focused tests first:

- `python -m unittest tests.test_syncjobs -v`
- `python -m tests.run file-sync rclone -v`

Then run the full suite:

- `python -m unittest discover -s tests -v`

Finally, re-run a real `sync all local to dropbox` against
`dropbox_browser/betty_youtube_5_26_2026` and confirm:

- transient throttles no longer leave the batch permanently unsynced;
- the operation remains active while retries are pending;
- the batch either fully converges or ends with only exhausted, explicit
  failures.
