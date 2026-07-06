# Video Session Direct Rclone Input Plan

## Goal

Remove the HTTP loopback hop from ffmpeg HLS session input. Today ffmpeg reads
remote media through `http://127.0.0.1:<port>/file?...&video_session_id=...`,
which adds roughly **3–4 seconds** to session create on typical HEVC/AV1
transcode sessions. Feed ffmpeg directly from `rclone cat` via a pipe instead.

Success criteria:

- First HLS playlist ready time (`session_create_ready`) drops materially on
  representative remote transcode files compared with the baseline measurement
  pass in Phase 0.
- Playback behavior stays remote-only; `/file` and `/download` remain unchanged
  for previews, downloads, subtitles, and ffprobe.
- Session lifecycle, cap eviction, idle expiry, and stop semantics still clean
  up both rclone and ffmpeg.
- Encode-ahead backpressure still works during playback, not just at startup.
- Post-implementation metrics in the final phase document the before/after delta
  on the same known sample files.

## Current Diagnosis

Session create in `VideoSessionManager.create_session()` builds an HTTP input URL
and spawns ffmpeg with `-i` pointing at the local server:

```text
ffmpeg -i http://127.0.0.1:8000/file?path=...&source=remote&video_session_id=<id>
  -> handlers.serve_file()
  -> rclone cat --offset/--count
  -> Dropbox
```

Prior ad-hoc benchmarks on this machine (July 2026) showed:

| File | HTTP `/file` input | Direct `rclone cat | ffmpeg pipe:0` | Savings |
|------|-------------------|-------------------------------------|---------|
| AV1 Fruits Basket S02E10 | ~6.1s | ~1.9s | ~69% |
| HEVC Eureka Seven ep 01 | ~4.9s | ~1.7s | ~66% |

The HTTP hop is the dominant startup cost after probe; prefix-to-disk caching is
optional and not required for most of the win.

Tagged `/file` reads also carry session-aware backpressure through
`copy_exact_with_throttle()` and `tagged_input_throttle_decision()` in
`handlers.py` / `video.py`. That logic must move to a pipe writer when the HTTP
input path is bypassed.

## Non-Negotiable Principles

- Video playback remains remote-only through local ffmpeg HLS sessions.
- Do not change `/file` or `/download` behavior for untagged callers.
- Do not add browser upload behavior.
- Do not add delete or overwrite behavior beyond existing sync rules.
- Keep seek, restart, burned-in subtitle, and multi-session behavior intact.
- Generated benchmark output stays under `Temp/` or `docs/benchmarks/`; do not
  commit media files.

## Phase 0 - Baseline Metrics On Known Sample Files

Run **before any implementation**. Capture repeatable numbers on fixed remote
paths so the post-implementation pass can compare apples-to-apples.

### Sample file set

Use at least these two remote Dropbox-relative paths (already exercised in prior
startup analysis on this machine):

1. **HEVC transcode candidate** — Eureka Seven episode 01:
   `anime/[bonkai77] Eureka Seven [BD-1080p] [DUAL-AUDIO] [x265] [HEVC] [AAC] [10bit] {FILTERED}/[bonkai77] Eureka Seven - Episode 01 [BD 1080p Dual Audio x265 10bit].mkv`
2. **AV1 transcode candidate** — Fruits Basket S02E10 (use the exact remote path
   from local browsing history / `Temp/video_debug.jsonl` if the filename
   differs between machines).

Optional third sample for regression coverage:

3. **H.264/AAC copy candidate** — any small remote `.mp4` / `.m4v` that probes
   as `video_copy` + `audio_copy` to confirm the pipe path does not regress
   near-instant copy-mode sessions.

### Measurement procedure

- [ ] Enable `LogVideoDebug` in `config_local.json` for the benchmark runs.
- [ ] Start the server with normal production pacing defaults (current shipped
      `readrate=1.1`, `initial_burst=18`, `threads=2`, etc.).
- [ ] Run `misc/benchmark_video_startup.py` once per sample file with at least
      `3` iterations and `0` post-create sampling (`--sample-seconds 0`) so the
      run focuses on startup timing rather than encode-ahead drift.
- [ ] Record for each file and iteration:
      `probe_cold_ms`, `probe_warm_ms`, `session_create_ms`,
      `server_session_create_ms` (from `session_create_ready` in
      `Temp/video_debug.jsonl` when present), `asset_fetch_ms`,
      `total_startup_ms`, `video_mode`, `audio_mode`, `ffmpeg_pid`.
- [ ] Save output under
      `Temp/video_benchmarks/direct-input-baseline-2026-07-05.jsonl` (or a
      sibling timestamped file). Do not overwrite prior unrelated benchmark
      artifacts.
- [ ] Summarize medians in a short machine-local note (can live beside the
      jsonl output) with hostname, date, branch name, and git commit hash.
- [ ] Confirm ffmpeg commands in `session_create_start` logs still show the
      HTTP `/file?...&video_session_id=` input URL (expected pre-change).

Example commands:

```powershell
python dropbox_browser.py --remote dropbox: --port 8000

python misc/benchmark_video_startup.py `
  --base-url http://127.0.0.1:8000 `
  --path "anime/[bonkai77] Eureka Seven [BD-1080p] [DUAL-AUDIO] [x265] [HEVC] [AAC] [10bit] {FILTERED}/[bonkai77] Eureka Seven - Episode 01 [BD 1080p Dual Audio x265 10bit].mkv" `
  --iterations 3 `
  --sample-seconds 0 `
  --output Temp/video_benchmarks/direct-input-baseline-2026-07-05-eureka.jsonl

python misc/benchmark_video_startup.py `
  --base-url http://127.0.0.1:8000 `
  --path "<fruits-basket-av1-path>" `
  --iterations 3 `
  --sample-seconds 0 `
  --output Temp/video_benchmarks/direct-input-baseline-2026-07-05-fruits.jsonl
```

### Baseline acceptance gate

Do not start Phase 1 until baseline medians are recorded. Target reference from
prior analysis (HTTP input, unpaced startup window):

- HEVC sample: `session_create_ms` median roughly **5–7s**
- AV1 sample: `session_create_ms` median roughly **6–7s**
- Copy sample: `session_create_ms` median roughly **0.2–0.5s**

If baseline numbers diverge wildly, note network/cache state before continuing.

## Phase 1 - Pipe Input For Startup (`t=0`, No Seek)

- [ ] Add config flag `VideoSessionDirectRcloneInput` (default `true` once
      stable; start implementation behind `false` or opt-in during development).
- [ ] Extend `VideoHlsSession` to track:
      `input_mode` (`http` | `pipe`),
      `rclone_process` (optional `subprocess.Popen`),
      `input_feeder_thread` (optional `threading.Thread`),
      `input_feeder_error` (optional stored exception).
- [ ] In `create_session()`, when direct input is enabled:
      1. Spawn `rclone cat` via `app.rclone.open_cat(remote_target(...))` with
         no offset/count (full stream).
      2. Spawn ffmpeg with `-i pipe:0` and `stdin=subprocess.PIPE` instead of
         the HTTP URL.
      3. Start a daemon feeder thread that copies rclone stdout to ffmpeg stdin
         using `copy_exact()` (no throttle yet).
- [ ] Keep the existing HTTP input path as fallback when the config flag is off.
- [ ] Update `build_ffmpeg_hls_command()` to accept a generic input specifier
      (`http://...` or `pipe:0`) without other command changes.
- [ ] Extend `session_create_start` logging with `input_mode` and whether a
      feeder thread was started.
- [ ] Add command-construction tests proving pipe mode emits `-i pipe:0` and
      does not embed `/file?...&video_session_id=`.
- [ ] Run `python -m tests.run video -v`.

## Phase 2 - Two-Process Lifecycle And Cleanup

- [ ] Update `_stop_session_resources()` to:
      stop the feeder thread promptly (set a cancel flag or close rclone stdout),
      kill rclone if still running,
      call `finish_cat()` with any stream error,
      then kill/wait on ffmpeg as today.
- [ ] Handle broken-pipe / `StreamCopyCancelled` cleanly when ffmpeg exits early.
- [ ] Ensure deferred session stops (`_drain_deferred_session_stops`) still work
      when multiple sessions are active.
- [ ] On create failure or playlist timeout, tear down rclone and ffmpeg for
      only the failed session.
- [ ] Add server tests with fake rclone/ffmpeg proving both processes are
      started in pipe mode and both are stopped on `session/stop`.
- [ ] Confirm Windows pipe behavior manually once with a real remote file.

## Phase 3 - Relocate Backpressure To The Pipe Writer

- [ ] Replace startup `copy_exact()` in the feeder with `copy_exact_with_throttle()`
      using `tagged_input_throttle_decision(session_id, rel_path)`.
- [ ] On `StreamCopyCancelled`, stop rclone and close ffmpeg stdin so encode-ahead
      halts when the session is stopped/expired/evicted.
- [ ] Log feeder completion stats mirroring today's `tagged_input_stream_complete`
      fields: `bytes_copied`, `sleep_seconds_total`, `throttle_mode`,
      `ahead_seconds`.
- [ ] Add tests that simulate progress updates and verify the feeder receives
      throttle decisions (can use short fake streams and injected decision_fn in
      a focused unit test).
- [ ] Verify startup remains unthrottled until the client posts progress far
      enough ahead (same semantics as current HTTP path).

## Phase 4 - Seek And Resume Offsets

- [ ] When `start_time_seconds > 0`, align rclone and ffmpeg seek:
      prefer `rclone cat --offset <bytes>` when a reliable byte offset is known,
      otherwise document that ffmpeg `-ss` before `-i` on a pipe reads from
      stream start (acceptable fallback only if byte offset is impractical).
- [ ] Reuse existing `start_time_seconds` POST field from compatibility restart /
      resume flows.
- [ ] Add tests for command construction with non-zero `start_time_seconds` in
      pipe mode (at minimum: offset flag presence or documented `-ss` behavior).
- [ ] Manually verify a mid-file compatibility restart on one HEVC sample.

## Phase 5 - Documentation And Config Polish

- [ ] Document `VideoSessionDirectRcloneInput` in `docs/video-player.md` under
      server architecture / HLS session lifecycle.
- [ ] Note that ffprobe and subtitle extraction continue to use HTTP `/file`;
      only ffmpeg HLS session input moves to the pipe.
- [ ] Remove or gate any temporary HTTP fallback once pipe mode is stable.
- [ ] Update `misc/benchmark_video_startup.py` (or add a thin wrapper) to record
      `input_mode` from `session_create_start` / create payload when present.

## Phase 6 - Post-Implementation Metrics On The Same Sample Files

Run **after Phases 1–5 are complete** on the same machine, same remote paths,
same iteration count, and same server config as Phase 0.

### Measurement procedure

- [ ] Confirm `VideoSessionDirectRcloneInput` is enabled.
- [ ] Re-run the exact Phase 0 `benchmark_video_startup.py` commands against the
      same Eureka, Fruits Basket, and optional copy sample paths.
- [ ] Save output under
      `Temp/video_benchmarks/direct-input-after-2026-07-05-<sample>.jsonl`.
- [ ] Verify `session_create_start` / create payload logs show
      `input_mode=pipe` and ffmpeg commands use `-i pipe:0`.
- [ ] Compute per-file deltas:
      `median(session_create_ms)`, `median(total_startup_ms)`, and
      `median(server_session_create_ms)` before vs after.
- [ ] Check for regressions on the copy-mode sample (should stay sub-second).
- [ ] Optionally run one longer sample (`--sample-seconds 30`) on the HEVC file
      to confirm backpressure still limits encode-ahead and does not introduce
      HLS stalls.
- [ ] Write a checked-in summary under
      `docs/benchmarks/video_direct_input/<machine-label>/results.json` and
      `README.md` with:
      baseline medians, after medians, percent improvement, branch/commit, date,
      and any caveats (network conditions, probe cache warm state).

### Target outcome

Based on prior pipe benchmarks, expect roughly:

| Metric | HTTP baseline | Pipe target |
|--------|---------------|-------------|
| HEVC `session_create_ms` median | ~5–7s | ~1.5–2.5s |
| AV1 `session_create_ms` median | ~6–7s | ~1.5–2.5s |
| Copy `session_create_ms` median | ~0.2–0.5s | unchanged |

If improvement is under ~40% on transcode samples, investigate whether the HTTP
fallback is still active, probe cache coldness skews results, or the feeder is
accidentally throttling during startup.

## Tradeoffs

| Benefit | Cost |
|---------|------|
| ~3–4s faster first segment on transcode content | Two child processes per session (rclone + ffmpeg) |
| Simpler than prefix-to-disk caching | Backpressure must be reimplemented on pipe writer |
| No extra Temp disk for pulled prefixes | Harder to debug than curling `/file` |
| `/file` unchanged for previews/probe/subs | Only session input changes; subtitle extract still HTTP |
| Keeps remote-only semantics | Mid-file seek needs explicit offset plumbing |
| Proven ~65–70% win in prior experiments | rclone broken-pipe noise when ffmpeg stops early |

## Test Checklist Before Checkin

```powershell
python -m py_compile dropbox_browser.py
python -m compileall -q dropbox_browser.py dropbox_browser
python -m tests.run video -v
```

Manual smoke on one HEVC and one AV1 file:

- overlay hides in roughly 2–4s after probe (down from ~8–10s)
- playback continues without HLS stalls through first few minutes
- stop + restart same file cleans up and succeeds
- second browser tab can play a different file (multi-session)

## Ownership Map

| Concern | Module |
|---------|--------|
| Pipe spawn, feeder thread, session lifecycle | `dropbox_browser/video.py` |
| rclone cat subprocess | `dropbox_browser/rclone.py` |
| Throttled copy loop | `dropbox_browser/streaming.py` |
| Untagged `/file` streaming (unchanged) | `dropbox_browser/handlers.py` |
| Startup benchmark tooling | `misc/benchmark_video_startup.py` |
| Benchmark artifacts | `Temp/video_benchmarks/`, `docs/benchmarks/video_direct_input/` |