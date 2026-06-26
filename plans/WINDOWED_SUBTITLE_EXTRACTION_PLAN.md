# Windowed Subtitle Extraction Plan

## Goal

Reduce subtitle startup overhead for large remote video files by replacing the
current **full-track-before-mount** behavior with **windowed subtitle
extraction**, while keeping the video player remote-only and behaviorally
correct during normal playback, seeks, and track changes.

Primary target:

- Large remote MKV files like:
  `anime/conan_24/[Ah-le-le] Detective Conan Movie 24v0 - The Scarlet Bullet (BDRip 1080p HEVC FLAC TrueHD) [12A80FEC].mkv`

Success criteria:

- First subtitle availability should no longer wait for full-track extraction.
- Subtitle extraction should add little or no extra startup overhead beyond the
  existing remote video extraction path.
- Selected subtitle tracks must remain correct during normal playback, seeks,
  subtitle changes, and audio-track restarts.

## Non-Negotiable Principles

- The video player remains **remote-only**. Subtitle extraction must not switch
  to a local file path.
- If a subtitle track is selected, subtitles must continue to display as the
  video plays.
- If more subtitle extraction work is still pending, that must be reflected in
  the currently loaded section of the scrubber / processed range UI.
- It is acceptable to show a loading overlay if playback reaches subtitle time
  that has not been extracted yet.
- Subtitle extraction must use the **same remote input result/path strategy**
  as video extraction. Do not introduce a separate subtitle-only rclone listing
  or metadata lookup flow.
- Audio-track and subtitle-track switching must keep current expected behavior.

## Current State

Today, compatibility playback startup waits on a full selected subtitle track:

1. `compatibility.js` calls `waitForCompatibilityStartupSubtitles()`.
2. That calls `applySubtitlesForSeek(...)`.
3. `applySubtitlesForSeek(...)` calls `preloadAllSubtitleVttsForItem(...)`.
4. `preloadAllSubtitleVttsForItem(...)` fetches `/video/endpoints/subtitles/all`
   and stores complete VTT text per track.
5. `mountSubtitleTrackForItem(...)` only mounts if full VTT text is already
   cached in browser memory.

This means the first play of a large file still waits on:

- remote MKV traversal;
- subtitle demux/copy;
- complete track materialization;
- full VTT text availability.

That is correct but too expensive for long remote files.

## Design Direction

Replace the full-track model with a **windowed subtitle model**:

- Extract only the initial subtitle window needed for startup.
- Mount that window immediately.
- Continue extracting later windows in the background.
- When playback or seek reaches an uncovered subtitle range, fetch or wait for
  the needed window and reflect that in the scrubber loaded range / loading UI.

Important constraint:

- This should not rely on a separate subtitle-only Dropbox listing or path
  discovery flow. It should reuse the same remote path and input strategy as
  the existing video pipeline.

## Decisions

- Keep the existing WebVTT sidecar rendering path for text subtitle formats.
- Keep bitmap subtitle behavior unchanged; this plan targets text subtitle
  tracks only.
- Prefer **selected/default-track-first** extraction instead of all-track
  preload on startup.
- Treat subtitle extraction as a time-range cache problem, not a single full
  text blob problem.
- Use the existing scrubber processed range UI as the basis for subtitle-loaded
  range visualization rather than introducing a separate new control.
- Do not require subtitle completeness before starting playback if the startup
  window is ready.

## Phase 1 - Define The Windowed Subtitle Contract

- [x] Define a server-side subtitle window contract:
      request payload includes `path`, `track`, `window_start_seconds`,
      `window_duration_seconds`, `window_end_seconds`, `file_size`,
      `window_status`; response payload includes `track`,
      `window_start_seconds`, `window_end_seconds`, `coverage_complete`,
      `loaded_ranges`, `gap_action`, `window_status`, and `vtt`.
- [x] Define client-side subtitle window state:
      `subtitleWindowCacheByPath`, `subtitleWindowInFlightByPath`,
      `subtitleCoverageByPath`, `subtitleBackgroundCoverageByPath`, and
      `subtitleMountedWindowByPath`, alongside the existing full-VTT cache.
- [x] Define exact startup window policy:
      initial play requests `0-300s`; seek requests use a 300-second window with
      a 15-second lead and 285-second forward span from the seek target.
- [x] Decide whether windows should overlap slightly to avoid cue-edge gaps
      across window boundaries.
      Use a 1-second overlap when adjacent windows are expanded or merged.
- [x] Decide how subtitle-loaded scrubber state maps onto the existing
      compatibility processed-range UI.
      Keep subtitle coverage as a separate tracked range and later render the
      scrubber's "fully ready" state as the intersection of HLS processed media
      and selected-track subtitle coverage.
- [x] Document fallback behavior when playback reaches a subtitle gap:
      pause-until-ready, using the existing compatibility loading overlay so
      selected subtitles stay correct instead of silently disappearing.
- [x] Keep the invariant explicit: selected subtitles must remain correct, even
      if that means showing a load state while the next window is extracted.

## Phase 2 - Add Server Window Extraction Endpoints

- [x] Add a text-subtitle window endpoint, for example:
      `/video/endpoints/subtitles/window?path=...&track=...&start=...&duration=...`.
- [x] Validate window parameters and clamp them against media duration.
- [x] Reuse probe metadata already used by video/subtitle extraction to resolve
      subtitle track codec, compatibility, and duration.
- [x] Reuse the same remote input strategy as current video/subtitle extraction;
      do not add a separate subtitle-only Dropbox listing path.
- [x] Add a response payload that includes:
      `status`, `track`, `window_start_seconds`, `window_end_seconds`,
      `coverage_complete`, `vtt`, and optional loaded-range metadata.
- [ ] Make the endpoint return partial success cleanly when the requested window
      is valid but full-track extraction is not yet complete.
- [x] Add tests for path validation, window clamping, and response structure.

## Phase 3 - Add Window-Aware Server Cache

- [x] Replace the implicit full-track-only subtitle cache assumption with a
      window-aware cache design.
- [x] Define subtitle cache keys that include:
      `rel_path`, `subtitle_stream_index`, `file_size`, `window_start_seconds`,
      `window_duration_seconds`, and cache version.
- [x] Add a small manifest/index per subtitle track that records which time
      windows are already cached.
- [x] Add helpers to query whether a requested subtitle window is fully covered.
- [x] Add helpers to merge adjacent cached coverage ranges for scrubber display.
- [x] Preserve the existing disk-cache TTL / max-bytes behavior for subtitle
      windows.
- [x] Add tests for cache-key stability, coverage-range merging, and manifest
      persistence.

## Phase 4 - Add Windowed Extraction Implementation

- [x] Add ffmpeg command builders for subtitle window extraction using the same
      remote input path as current extraction.
- [x] Pass `start_time_seconds` through the actual subtitle extraction path
      instead of only supporting it in helper signatures.
- [x] Add an end/window bound strategy so extraction does not materialize the
      full subtitle track for startup windows.
- [x] Keep copy-demux-first behavior for ASS / SRT / WebVTT-compatible text
      subtitle codecs where possible.
- [x] Ensure the extracted WebVTT timestamps remain valid for mounting at the
      requested playback window.
- [x] Verify that requested windows include the first needed visible cues at
      startup and around seeks.
- [x] Add tests that confirm a startup request extracts only the first window
      and that later windows can be requested independently.

## Phase 5 - Add Server In-Flight Dedupe And Background Backfill

- [x] Add in-flight dedupe keyed by subtitle track + window so duplicate
      requests do not trigger duplicate remote scans.
- [x] Add a background backfill mechanism to continue extracting future windows
      after startup window extraction succeeds.
- [x] Ensure background work can be canceled or ignored safely when the active
      item, subtitle track, or playback sync token changes.
- [x] Ensure audio-track restarts and subtitle-track changes do not reuse stale
      subtitle-window jobs from a different track selection.
- [x] Add tests covering duplicate requests, cancellation/staleness, and
      background backfill sequencing.

## Phase 6 - Change Client Startup From Full-Track Warmup To Windowed Warmup

- [x] Replace `preloadAllSubtitleVttsForItem()` startup dependence with a
      selected/default-track window preload path.
- [x] Keep all-track warmup off the critical startup path.
- [x] Add client state for subtitle windows in flight, cached subtitle coverage,
      and mounted coverage for the active track.
- [x] Request only the initial subtitle window before first mount.
- [x] Keep `waitForCompatibilityStartupSubtitles()` blocking only on the first
      required startup window, not the entire track or all compatible tracks.
- [x] Keep the current subtitle loading overlay/status behavior, but scope it to
      “startup window not ready yet” instead of “full subtitle track missing.”
- [x] Add focused JS tests for startup window fetch and reduced preload scope.

## Phase 7 - Teach Mounting And Debug Logic To Work With Partial Tracks

- [x] Update `mountSubtitleTrackForItem()` so it can mount a partial/windowed
      VTT, not only a full-track blob.
- [x] Update browser subtitle cache helpers so they store windowed VTT text and
      coverage metadata instead of only one full VTT string per track.
- [x] Update `updateSubtitleDebugForStream()` and related debug helpers so they
      tolerate partial subtitle coverage.
- [x] Preserve correct subtitle cue timing after rebasing windowed VTT text for
      the current seek start.
- [x] Add tests covering mount success from a partial window and cue/debug
      behavior inside and outside the covered range.

## Phase 8 - Add Seek-Time Window Fetch And Coverage Expansion

- [x] When playback seeks, detect whether subtitle coverage already exists for
      the target time.
- [x] If covered, remount immediately from cached subtitle windows.
- [x] If not covered, request the needed subtitle window for the seek target.
- [x] Reflect missing subtitle coverage in the scrubber loaded-range UI before
      the new window is ready.
- [x] Show a subtitle loading state when the user scrubs into an uncovered range
      and the selected subtitle track must still be honored.
- [x] Resume normal subtitle display automatically once the new window arrives.
- [x] Add tests covering in-range seek, out-of-range seek, and repeated seeks
      into already-cached windows.

## Phase 9 - Wire Subtitle Coverage Into The Scrubber / Loaded Range UI

- [ ] Extend the current processed-range display so subtitle coverage can be
      shown distinctly from HLS media seekability if needed.
- [ ] Decide whether to show:
      video processed range only, subtitle range only, or a combined “fully
      ready” range for the selected subtitle track.
- [ ] Ensure the user can tell when playback video is ready but subtitle
      coverage is still catching up.
- [ ] Keep the UI quiet and utilitarian; avoid adding new decorative controls.
- [ ] Add browser tests for subtitle-loaded-range updates during startup,
      backfill, and seek-triggered extraction.

## Phase 10 - Keep Track Switching Behavior Correct

- [ ] Subtitle track switch:
      request the startup/seek window for the newly selected track immediately.
- [ ] Audio track switch:
      keep existing HLS restart behavior and ensure subtitle window state is
      preserved or re-requested correctly for the active subtitle track.
- [ ] Subtitle Off:
      clear mounted subtitle state without destroying cached subtitle windows.
- [ ] Bitmap subtitle selection:
      leave current burn-in compatibility restart behavior unchanged.
- [ ] Add E2E coverage for subtitle-track switch and audio-track restart while
      selected subtitles continue to behave correctly.

## Phase 11 - Observability And Failure Handling

- [ ] Add server diagnostics for subtitle window requests:
      path, track, window start/end, cache hit/miss, extraction duration,
      background-backfill scheduling.
- [ ] Add client diagnostics for subtitle coverage state:
      startup window requested, seek window requested, mount from cache,
      waiting on missing coverage.
- [ ] Make partial extraction failures visible without silently falling back to
      “no subtitles.”
- [ ] Ensure the UI makes it clear whether playback is waiting on subtitle
      extraction versus general video buffering.

## Phase 12 - Test Matrix

- [ ] Python tests:
      window endpoint validation, cache keys, coverage manifests, in-flight
      dedupe, and background backfill behavior.
- [ ] JS tests:
      window cache state, selected-track-first preload, partial mount, seek
      remount, scrubber loaded-range updates.
- [ ] Video endpoint tests:
      startup window extraction for large text subtitles and seek-window
      extraction at non-zero start times.
- [ ] E2E tests:
      large-file startup with selected subtitles,
      seek into uncovered subtitle range,
      subtitle-track switch,
      audio-track switch with subtitles preserved,
      bitmap-subtitle behavior unchanged.
- [ ] Regression check:
      current small test fixtures should still behave like “instant startup”
      while large-file fixtures prove that full-track blocking is gone.

## Phase 13 - Manual Validation

- [ ] Clear video subtitle cache for the Conan movie and measure time to first
      visible subtitle on startup.
- [ ] Confirm startup no longer waits for full-track subtitle extraction.
- [ ] Confirm scrubber loaded-range UI reflects subtitle coverage progress.
- [ ] Seek to a far-ahead timestamp and confirm subtitle coverage expands
      correctly for the selected track.
- [ ] Switch audio tracks and verify subtitle behavior remains correct.
- [ ] Switch subtitle tracks and verify the new selected track loads the needed
      window and displays correctly.
- [ ] Re-run playback on a cached movie and confirm repeat subtitle startup is
      near-instant.

## Expected Outcome

After this plan:

- First subtitle display should depend on a small startup window, not a full
  track extraction.
- Large remote files should no longer pay full-track subtitle cost on startup.
- Subtitle extraction work should align more closely with what the viewer is
  actually watching.
- The scrubber / loaded-range UI should accurately reflect when subtitle
  coverage is still catching up.
- Selected subtitles should continue to behave correctly during playback, seeks,
  subtitle changes, and audio-track restarts.
