# Video `/file` HTTP Input Optimization Plan

## Goal

Reduce HLS compatibility-session startup and seek latency for ffmpeg input that
must keep using the seekable local `/file` route. Preserve the current reliable
Matroska/PGS stream discovery behavior; direct `rclone cat | ffmpeg -i pipe:0`
is not a fallback for this work because it is non-seekable and fails on the
target Fairy Tail-style media.

## Existing Evidence And Expected Impact

The July direct-input experiment is the performance ceiling for removing the
HTTP path entirely, not the expected result of retaining it:

| Sample | HTTP session create | Direct pipe session create | Difference |
|---|---:|---:|---:|
| HEVC Eureka Seven ep. 01 | ~4.9 s | ~1.7 s | ~3.2 s / 66% |
| AV1 Fruits Basket S02E10 | ~6.1 s | ~1.9 s | ~4.2 s / 69% |

The checked-in CPU-control benchmarks also show full startup is materially
larger and machine-dependent: the Fairy Tail full-transcode case was ~7.6 s on
the ASUS machine and ~8.7 s on the Surface Book 3; the broader paced scenarios
were ~15.8-18.7 s. Therefore the absolute 3.2-4.2 s pipe saving would represent
roughly 15-55% of end-to-end startup depending on workload, but it is not
available while seekable HTTP behavior is required.

Expected results for this HTTP-focused plan:

| Work | Expected session-create gain | Confidence / condition |
|---|---:|---|
| Reuse tagged-session path and size; narrow tagged handler | ~0.2-0.8 s, typically ~3-16% of the 4.9-6.1 s HTTP session-create reference | Medium; notes identify metadata lookup as hundreds of ms, but no per-request trace exists yet. |
| Remove temp `--files-from` setup after Unicode/Windows proof | ~0.05-0.3 s per tagged range request | Low-medium; useful only when request count is more than one. |
| Increase tagged copy buffer from 1 MiB | Usually <0.1 s | Low; localhost/rclone latency should dominate. |
| Combined low-risk path/command/buffer work | ~0.3-1.0 s on a single startup read, about 5-20% of the 4.9-6.1 s HTTP reference | Conditional on baseline traces confirming stat and process setup are material. |
| Session prefix cache | ~1-3+ s only when ffmpeg repeats early ranges | Uncertain; do not implement without trace evidence of repeated early reads. |
| Fully seekable temp file | Potentially approaches the 3.2-4.2 s direct-input ceiling for warm/repeated playback, but may be slower on cold playback because it must download to disk first | High complexity and not a default startup optimization. |

The plan treats the latter two as gated options. A successful first pass may be
the modest, reliable low-risk result; it should not claim the direct-pipe
ceiling without evidence.

## Invariants

- Untagged `/file` and `/download` behavior, including `HEAD` and byte ranges,
  remains unchanged.
- Tagged input stays associated only with a live matching `VideoHlsSession`;
  session id and normalized requested remote path must agree.
- Remote paths continue through `clean_rel_path`; local paths are not involved.
- `rclone` path handling remains Windows- and Unicode-safe. Do not replace
  `--files-from` until focused tests prove the direct form is equivalent.
- Do not add delete, upload, or general overwrite behavior.

## Step 1 - Capture Baseline Measurements

- [x] Enable `LogVideoDebug` for a controlled baseline run and preserve any
      existing unrelated debug log.
- [x] Start the normal production configuration and record the branch, commit,
      machine, remote, pacing settings, and probe-cache state.
- [x] Run `misc/benchmark_video_startup.py` with at least three iterations and
      `--sample-seconds 0` for the existing HEVC Eureka and AV1 Fruits Basket
      samples. Include a H.264/AAC copy sample when available.
- [x] Save each raw run under
      `Temp/video_benchmarks/file-http-baseline-2026-07-10-<sample>.jsonl`.
- [x] Record median `session_create_ms`, `server_session_create_ms`,
      `asset_fetch_ms`, and `total_startup_ms` in a machine-local companion
      note; retain individual samples to expose variance.
- [x] Capture the matching `Temp/video_debug.jsonl` interval so every tagged
      `/file` request, Range value, and ffmpeg command can later be compared.
- [x] Confirm the baseline still uses
      `/file?...&video_session_id=<id>` and that the known Matroska/PGS sample
      starts successfully.

Example baseline command:

```powershell
python misc/benchmark_video_startup.py `
  --base-url http://127.0.0.1:8000 `
  --path "<existing HEVC or AV1 sample path>" `
  --iterations 3 `
  --sample-seconds 0 `
  --output Temp/video_benchmarks/file-http-baseline-2026-07-10-<sample>.jsonl
```

## Step 2 - Add Tagged `/file` Range Instrumentation

- [x] In `handlers.py`, identify tagged ffmpeg input before generic remote-file
      resolution and start a monotonic request timer.
- [x] Emit structured video-debug events for: request path/session id, Range
      header, session/path validation result, remote-resolution duration,
      selected start/count, `open_cat()` duration to first byte, rclone command
      form, bytes copied, stream duration, and terminal outcome.
- [x] Keep diagnostics behind `LogVideoDebug`; avoid logging data payloads or
      unbounded high-frequency events.
- [x] Add focused tests for tagged event fields, invalid/mismatched sessions,
      ordinary ranges, and absent Range headers.
- [x] Run `python -m tests.run video -v` and `python -m tests.run streaming -v`.

## Step 3 - Diagnose And Set Gates

- [x] Repeat one short benchmark pass with instrumentation enabled and group
      tagged requests by session id.
- [x] Measure request count, duplicate ranges, total resolution time, median
      `open_cat()` to first byte, bytes per request, and relay time.
- [x] Select only evidence-backed work:
      - session metadata reuse when resolution is at least ~100 ms or causes
        `stat`/listing activity;
      - direct rclone target experiment when process/setup time is material;
      - buffer trial only when transfer/relay time is material;
      - prefix cache only for repeated overlapping early ranges.
- [x] Write the chosen gates and observed values beside the baseline artifacts;
      do not begin a disk-cache or temp-file branch on speculation.

## Step 4 - Reuse Session Metadata And Narrow Tagged Requests

- [x] Extend `VideoHlsSession` creation/probe state with the canonical remote
      relative path and resolved size needed by its ffmpeg input, without
      weakening session lifecycle cleanup.
- [x] Add a small tagged-input helper in the module that owns session lookup to
      validate `video_session_id`, compare the normalized requested path with
      the session path, and return metadata only for a live matching session.
- [x] Route valid tagged `/file` requests through a narrow handler that uses
      that metadata, parses Range, calls `open_cat(offset, count)`, and streams
      with the existing session-aware backpressure semantics.
- [x] Keep the generic `_resolve_remote_file()` path for untagged `/file`,
      failed session lookup, and explicitly supported fallback cases.
- [x] Add tests proving tagged requests skip redundant resolution, reject a
      mismatched path/session pair, preserve 206/416 behavior, and stop cleanly
      on session expiry/eviction.
- [x] Run `python -m tests.run video -v`, `python -m tests.run streaming -v`,
      and `python -m tests.run rclone -v`.

## Step 5 - Evaluate And Apply Per-Request Setup Improvements

- [x] Add a focused `RcloneClient.open_cat()` test matrix for spaces, Unicode,
      brackets, apostrophes, and Windows-renamed names using both the current
      `--files-from` form and a candidate direct target form.
- [x] Change tagged input to direct `rclone cat -- remote:path` only if the
      matrix and a real Dropbox smoke test prove exact behavior; otherwise
      retain `--files-from` and document the measured setup cost.
- [x] Make tagged copy-buffer size an internal, bounded constant and benchmark
      1, 2, 4, and 8 MiB using identical request ranges. Keep 1 MiB when the
      result is within measurement noise; do not broaden the change to untagged
      downloads.
- [x] Add tests for the selected rclone command form, cleanup of any temporary
      files-from artifact, exact range arguments, and the chosen tagged buffer
      path.
- [x] Run `python -m tests.run rclone -v`, `python -m tests.run streaming -v`,
      and `python -m tests.run video -v`.

## Step 6 - Implement A Prefix Cache Only When Range Traces Justify It

- [x] Proceed only if Step 3 demonstrates repeated overlapping reads within a
      defined early prefix and estimates enough saved remote requests to exceed
      the added complexity.
      **Decision (2026-07-11): do not implement.** Step 3 gate remains unmet
      after re-evaluation of Eureka, Fruits Basket, Conan, and Fairy Tail tagged
      range traces. Pattern is one Matroska open/seek/restart with partial
      early overlap, not repeated prefix churn; partial hits would not eliminate
      the restart remote read. Written decision:
      `Temp/video_benchmarks/file-http-step6-2026-07-11-prefix-cache-decision.md`.
- [x] Define explicit per-session cache limits: prefix byte cap, total disk
      budget, concurrency behavior, fill timeout, and cleanup on stop, expiry,
      eviction, create failure, and shutdown.
      **Skipped — gate not met.**
- [x] Populate a partial prefix file under the existing session Temp directory
      with atomic visibility rules; never expose bytes beyond the verified
      cached length.
      **Skipped — gate not met.**
- [x] Serve fully cached tagged ranges locally and fall back to
      `rclone cat --offset/--count` for uncached or partially cached ranges.
      **Skipped — gate not met.**
- [x] Add tests for cache hit/miss, partial reads, concurrent readers, failed
      fill, session cleanup, and range headers spanning cached and remote data.
      **Skipped — gate not met; no prefix-cache code landed.**
- [x] Run `python -m tests.run video -v`, `python -m tests.run streaming -v`,
      and a manual Fairy Tail startup/seek smoke test.
      Regression groups run after the skip decision; Fairy Tail manual smoke is
      deferred with Step 9 measurement (no cache behavior to smoke-test).

## Step 7 - Consider A Seekable Temp File Only As A Separate Experiment

- [ ] Do not enable this by default. First measure cold full-download time,
      free disk use, warm reuse, startup time, and seek behavior on a
      representative HEVC/PGS file.
- [ ] Define an opt-in session strategy, maximum file size, disk quota,
      cancellation behavior, and cache lifecycle before implementation.
- [ ] Compare cold and warm results against Step 1 and the direct-pipe ceiling;
      reject the strategy when cold startup or disk cost outweighs the gain.
- [ ] If retained, add tests for quota refusal, cancellation, cleanup, partial
      file isolation, and no fallback that changes ordinary `/file` behavior.

## Step 8 - Documentation And Regression Coverage

- [ ] Document tagged `/file` diagnostics, selected command form, cache limits
      (when applicable), and known performance boundaries in
      `docs/video-player.md`.
- [ ] Keep benchmark tooling able to correlate session-create output with tagged
      range diagnostics; add only small parsing support needed for this.
- [ ] Add or update focused regression tests for session/path validation,
      range semantics, Windows/Unicode rclone handling, and cleanup.
- [ ] Run `python -m py_compile dropbox_browser.py`,
      `python -m compileall -q dropbox_browser.py dropbox_browser`, and
      `python -m tests.run video -v`.

## Step 9 - Capture Updated Measurements

- [ ] Use the exact Step 1 machine, remote paths, server settings, probe-cache
      treatment, iteration count, and benchmark command.
- [ ] Save raw runs under
      `Temp/video_benchmarks/file-http-after-2026-07-10-<sample>.jsonl` without
      overwriting the baseline artifacts.
- [ ] Compute medians and per-sample deltas for `session_create_ms`,
      `server_session_create_ms`, `asset_fetch_ms`, and `total_startup_ms`.
- [ ] Compare tagged range traces before and after: resolution time, rclone
      process count, time to first byte, duplicate early ranges, total bytes,
      and stream duration.
- [ ] Verify the Matroska/PGS sample, a nonzero seek/restart, and a copy-mode
      session still succeed with no HLS stalls or regression in untagged
      `/file`/`/download` behavior.
- [ ] Record the measured result, variance, enabled gates, and any remaining
      bottleneck next to the machine-local benchmark artifacts. Report the
      direct-pipe 3.2-4.2 s result only as the retained-HTTP upper bound, not as
      an achieved gain.

## Ownership Map

| Concern | Module |
|---|---|
| Tagged request routing and diagnostics | `dropbox_browser/handlers.py` |
| Session metadata, validation, lifecycle | `dropbox_browser/video.py` |
| Range parsing and copy helpers | `dropbox_browser/streaming.py` |
| `rclone cat` command form and temp files | `dropbox_browser/rclone.py` |
| Video benchmark tooling | `misc/benchmark_video_startup.py` |
| Video regression coverage | `tests/test_video_endpoints.py`, `tests/test_rclone.py` |
