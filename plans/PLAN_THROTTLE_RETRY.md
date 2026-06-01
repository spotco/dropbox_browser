# Plan: throttle-aware retry for Dropbox write limits

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
