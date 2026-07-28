# Music Waveform Scrubber Plan

## Purpose

Add a default-closed Audio Visualization section below the Music Player
playback controls.  When open, it will build and display a combined full-track
amplitude waveform, progressively refine its resolution, show the current
playhead, and act as a pointer scrubber.

This plan deliberately protects normal playback: no visualization request,
decoder, worker, canvas drawing, or cache access begins while the section is
closed.  When it is open, work starts only after the selected song has emitted
the normal `<audio>` element's `playing` event.

## Locked Decisions

- [x] Render the waveform in the client, not through a new server waveform
  endpoint.
- [x] Fetch the complete remote file only after normal playback successfully
  starts and the visualization section is open.
- [x] Use one combined waveform.  Each time bucket records the greatest
  absolute sample amplitude across every channel, rather than rendering
  separate stereo rows.
- [x] Keep only compact peak summaries, never source audio, in browser local
  storage.
- [x] Keep the most recent cached summaries with a configurable app setting;
  use `MusicWaveformCacheEntryLimit` with default `20` and a bounded valid
  range.  `0` disables persistent waveform caching.
- [x] Key cache records by remote path, remote size, and remote modification
  time so a changed file rebuilds automatically.
- [x] Produce a low-resolution view first, then refine with independent,
  mathematically spaced sample rounds: 64, 256, and final 1024.
- [x] Run peak reduction and progressive refinement in a dedicated Worker,
  with a small per-turn processing-time budget and deliberate yields between
  turns.

## Architecture and Constraints

The existing player streams `<audio id="music-audio">` from `/file`, and
`/file` resolves a remote file then starts an `rclone cat` stream.  Its opaque
media fetch cannot be reused by page JavaScript as the complete decoded audio
buffer.  A real complete Audacity-style overview therefore requires one
additional, deferred `/file` fetch for a previously uncached song.  Existing
metadata reads remain independent small range requests.

The added fetch must never be on the normal song-start path.  It begins only
after `playing`, with a current-song/generation check, and is aborted on panel
close, song replacement, bottom-pane deactivation, or document hiding where
appropriate.

Browser `decodeAudioData()` is asynchronous and normally implemented by the
browser's media decoder outside page JavaScript, but it does not expose a
portable CPU-slice control.  The implementation must document that limitation.
All page-controlled sample scanning, peak calculation, cache encoding, and
refinement must be worker-based and throttled.  The UI thread only starts the
decode, sends/cancels jobs, applies compact progress messages, and paints the
canvas.

## Implementation Checklist

### 1. Add configuration and markup

- [x] Add `MusicWaveformCacheEntryLimit` to `dropbox_browser/config.py` with a
  conservative default of `20`, numeric normalization, and a maximum that
  keeps browser storage bounded.
- [x] Expose the normalized value to the page as a music-player data attribute
  through the existing template/view configuration path; do not create a
  runtime endpoint solely for this setting.
- [x] Add a closed native `<details>` element directly below the playback
  surface in `assets/templates/music_player.html`, styled after the Video
  Player's collapsible panels.
- [x] Give the summary a clear label such as `Audio Visualization`; the closed
  state must not allocate a canvas drawing loop or start any feature request.
- [x] Add an accessible canvas/container, loading/status text, and an
  off-screen/live status region.  Preserve the existing range input as the
  keyboard-accessible primary scrubber.
- [x] Add focused music CSS for the collapsible panel, canvas sizing, combined
  waveform fill, completed/unprocessed regions, focus state, drag cursor, and
  current-time playhead.  Keep it responsive within the playback subpane.

### 2. Isolate waveform feature code

- [x] Create `dropbox_browser/assets/js/music/waveform/` for all new feature
  code.  Keep the host entry and existing playback code limited to lifecycle
  calls and seek integration.
- [x] Add a waveform controller module that owns details-panel lifecycle,
  active song identity, abort controller, worker generation/token, cache
  lookup, canvas rendering, pointer scrub state, and cleanup.
- [x] Add a worker module that accepts decoded channel sample data and emits
  compact progressive peak summaries.  It must not access player DOM, Settings,
  or playback state directly.
- [x] Add pure helper modules for cache record validation/LRU eviction, cache
  keys, peak packing/unpacking, resolution selection, and pointer-position to
  playback-time conversion so they can receive narrow Node tests.
- [x] Wire the controller into `assets/js/music.js` through new element
  references and initial state only.  Do not spread waveform state through
  media-library modules.

### 3. Implement lazy lifecycle and deferred fetch

- [x] On `details.toggle`, do nothing when closed except cancel/tear down the
  active visualization job and stop repaint scheduling.
- [x] When opened, require both a current song and a confirmed `audio.playing`
  state.  Otherwise show a waiting message and register no fetch until the
  current song actually starts.
- [x] On `playing`, ask the controller to start only if the panel is still
  open, the audio source/song generation still matches, and no valid cache
  record is present.
- [x] Fetch the normal `playbackApi.streamUrl(song)` with an AbortSignal.  Do
  not change `/file`, rclone invocation behavior, media preloading, or normal
  playback request priority.
- [x] Verify the song/generation after every asynchronous stage.  Late fetch,
  decode, worker, or cache messages must be ignored rather than changing a
  newer song's UI.
- [x] Cancel on song clear/replacement, section close, music-pane deactivation,
  `beforeunload`, and document-hidden lifecycle transitions.  Release large
  ArrayBuffers and worker references after cancellation/completion.

### 4. Decode and progressively reduce safely

- [x] Decode the fetched bytes with `AudioContext.decodeAudioData()` only after
  the deferred fetch completes.  Report unsupported/failed decode without
  affecting audio playback.
- [x] Send the decoded channel sample data to the worker using the least-copying
  safe transfer approach supported by the target browser.  Keep only data
  necessary for the job; never persist PCM or encoded source audio.
- [x] Have the worker emit independent combined sample envelopes in ordered
  rounds of 64, 256, and final 1024 samples. Each round samples
  the centers of distinct equal-width source intervals so no round reuses a
  source position from an earlier round.
- [x] Define a worker slice budget (for example 2–4 ms measured with
  `performance.now()`), followed by a short `setTimeout` yield before the next
  slice.  Make budget and yield values named constants with comments describing
  the CPU-responsiveness tradeoff.
- [x] Compute each bucket as the largest absolute amplitude across all samples
  and channels in that time range.  Retain enough compact peak data to redraw
  at resize without decoding again.
- [x] Make progress messages compact and rate-limited.  The controller should
  repaint at animation-frame cadence at most, never once per worker inner loop.
- [x] Emit the 64-sample round immediately after decode, then report each
  completed sample round in the visualization status text. These are
  intentionally approximate envelopes optimized for responsiveness rather
  than exact full-track reductions.
- [ ] Replace the sparse one-sample-per-bucket reduction with an Audacity-style
  range summary containing signed minimum, signed maximum, and RMS for each
  bucket. Keep the first 64-point preview fast with a small stratified sample
  set, then perform one exact worker scan at 1024 points and derive the 256
  and 64 summaries by merging min/max/sum-of-squares/count values. Render RMS
  as the primary body and retain min/max for the outer transient envelope;
  update the compact cache payload and add synthetic tests for silence, steady
  signals, ramps, tones, and isolated impulses.
- [x] Clearly document the unavoidable browser-native decode limitation: peak
  processing is budgeted in the worker, while decode is asynchronous but not
  individually CPU-sliceable through portable web APIs.

### 5. Canvas rendering and scrub interaction

- [x] Draw the centered combined waveform with a dark panel background and
  visible amplitude silhouette inspired by the Audacity reference, plus
  processed/unprocessed and current-position affordances appropriate to the
  existing application theme.
- [x] Use CSS-pixel layout plus device-pixel-ratio-aware canvas backing size;
  redraw on panel opening, waveform refinement, player-time updates, and
  ResizeObserver changes without creating an always-running loop.
- [x] Keep the constrained playback surface scrollable so an expanded
  visualization panel cannot intercept transport controls when the pane is
  shorter than the combined controls and waveform content.
- [x] Draw a precise current-time playhead from the same `<audio>` state used by
  the existing range slider.  Throttle it to animation frames while the panel
  is open and playing; stop it while closed or inactive.
- [x] On pointer click or drag, map horizontal position to a clamped fraction
  of finite audio duration, assign `audio.currentTime`, and call the existing
  progress-display synchronization path.
- [x] Use pointer capture for drag, ignore invalid/unknown duration, expose an
  accessible label/instructions, and avoid interfering with native summary
  toggle behavior.
- [x] Show explicit visualization state text for playback waiting, audio
  retrieval, progressive sampling, and final resolution; add a bottom-right
  control to clear the current summary cache and reload the visualization.

### 6. Cache compact visual summaries

- [x] Store a versioned waveform cache envelope through the existing browser
  Settings/local-storage conventions.  Include cache key, LRU/last-used time,
  duration, resolution, and packed combined peaks only.
- [x] Validate types, version, resolution bounds, duration, key identity, and
  decoded peak payload before accepting a record.  Treat malformed or quota
  failures as cache misses; playback must continue normally.
- [x] On a cache hit, render immediately when the panel opens after playback is
  confirmed, update recency, and skip the extra full-file fetch/decode.
- [x] Evict least-recently-used entries until the configured limit is met.
  Never scan or rewrite unrelated Settings keys.
- [x] Keep cache entries intentionally small enough that twenty typical
  waveforms fit comfortably under common localStorage quotas.
- [x] Preserve the source file's size and modification identity when library
  songs enter an active playlist, so live waveform cache keys are not reduced
  to path-only identities.
- [x] Bump the waveform cache schema when the sampling algorithm or final
  resolution changes, so older lower-resolution summaries cannot skip the new
  progressive rounds.

### 7. Test and verify behavior

- [x] Add Node tests for cache key/invalidation, cache validation/LRU eviction,
  peak aggregation across multiple channels, progressive stage ordering,
  worker time-slice/yield scheduling, cancellation/generation rejection, and
  pointer-to-time clamping.
- [x] Extend `tests/js/music-playback.test.js` or add a focused music waveform
  controller test with fake audio/details/fetch/worker objects.  Assert no
  waveform fetch occurs while closed or before `playing`; assert one starts
  after both conditions are true.
- [ ] Assert close, song change, inactive-pane switch, and hidden document abort
  active requests/jobs and suppress late results.
- [x] Assert cached results display without issuing a second waveform fetch,
  and changed path/size/modification identity invalidates the cache.
- [x] Keep visualization state and integration assertions focused on lifecycle
  completion and valid progress messages rather than fixed sample counts.
- [x] Add disabled-by-default `music-waveform` client diagnostics covering
  fetch/decode timing, sample rounds, canvas renders, song
  changes, and cancellation/worker cleanup; enable it only in the local
  `config.json` during investigation.
- [x] Optimize long-track refinement with independent sparse sample rounds
  instead of repeated full-track scans; the first 64 samples can render
  immediately and the final visualization is capped at 1024 samples.
- [x] Extend the music Playwright integration fixture/spec with generated WAV
  tracks: the panel starts closed, normal playback starts before visualization
  work, each song renders a distinct waveform, and next/previous navigation
  continues to render correctly with cache reuse.
- [x] Add an E2E network assertion scoped to waveform work: there is no added
  `/file` request before panel open plus `playing`; the first uncached opened
  track and the next uncached track each have one deferred full-file request;
  a valid previous-song cache hit has none.
- [x] Run `npm run test:js`, `npm run test:e2e:music`, the relevant Python
  web/config tests, `python -m compileall -q dropbox_browser.py
  dropbox_browser`, and the full Python suite before handoff.  All passed.

## Acceptance Criteria

- [x] With the visualization closed, normal Music Player playback behavior,
  time-to-start, rclone traffic, CPU use, and UI painting are unchanged.
- [x] Opening the visualization before playback waits without requesting or
  decoding data; opening it after confirmed playback begins the deferred job.
- [x] The first uncached completed view resembles a full-track combined
  amplitude waveform, starts visibly low-resolution, and refines without UI
  stalls.
- [x] The canvas accurately follows current playback time and supports click
  and drag seeking across the entire finite duration.
- [x] Page-controlled peak processing stays off the main thread and obeys its
  configured per-turn budget/yield schedule; the native decode caveat is
  explicit and does not delay normal playback startup.
- [x] A cached waveform avoids a repeat full-file fetch for the same remote
  file identity, while cache size is bounded by configuration.
- [x] The generated music E2E verifies distinct waveform rendering across
  playlist next/previous navigation and confirms the previous song reuses its
  cached waveform without another full-file fetch.
- [ ] Failures, cancellation, unsupported decode, storage quota issues, and
  rapid song changes leave normal audio playback usable and show a concise
  visualization-only status.
