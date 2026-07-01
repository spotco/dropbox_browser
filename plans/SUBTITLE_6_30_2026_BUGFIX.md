# Subtitle 2026-06-30 Bugfix Plan

## Goal

Fix the two subtitle playback bugs investigated on `bugfix-dev` while reducing
the chance of future subtitle regressions. The implementation should leave
subtitle behavior easier to reason about by replacing implicit, overlapping
mounted-state checks with an explicit subtitle mount state.

## Resolved Implementation Decisions

- Implement the fixes on a new branch. Current working branch:
  `subtitle-6-30-2026-bugfix`.
- This plan is the implementation source of truth. It must include the repro
  and debugging context needed to understand the bugs without requiring a
  separate read of `plans/bugs/bug_subtitle_flickering_6_30_2026.md`.
- Clear stale subtitle state as soon as it becomes stale. Do not wait for a
  later remount if full-cache preload, item change, track change, session
  replacement, or subtitle-off selection already proves old mounted-window
  metadata is obsolete.

## Bugs To Cover

### Bug A - Windowed Subtitle Playback Crosses Mounted Coverage

Observed fix commit: `f71f644` (`subtitle unmounted fix + e2e test`)

Problem:

- A WebVTT subtitle window can be mounted for an initial range.
- Playback can later move outside that mounted window.
- The old code does not reliably fetch/remount the next subtitle window at the
  current playback time, so subtitles/debug output can disappear or stay stale.

Expected behavior:

- When playback crosses a mounted window boundary and no full subtitle cache is
  available, the client fetches the needed window and remounts the selected
  subtitle track without restarting the HLS session.
- The refresh must be tied to actual coverage-boundary crossing, not repeated
  blind remount attempts on every `timeupdate`.

### Bug B - Full-Cache Upgrade Leaves Stale Mounted-Window Metadata

Observed fix commit: `5df1c1a` (`subtitle flicker follow-up fixes and e2e coverage`)

Problem:

- Startup can mount a windowed subtitle payload and record finite mounted
  coverage.
- Background preload can later cache the full subtitle track.
- The source chosen for mounting becomes full-cache, but stale mounted-window
  metadata can still make `subtitlesAreMounted(...)` report false after playback
  moves outside the old window.
- `timeupdate` then repeatedly clears and remounts the `<track>`, producing
  visible/debug flicker.

Expected behavior:

- Once full subtitle VTT is mounted, obsolete window-bound metadata no longer
  makes the track appear unmounted.
- Once full subtitle VTT is cached for the active path/stream, stale mounted
  window metadata for that path/stream is cleared immediately if it can no
  longer be authoritative.
- Repeated `timeupdate` events during steady playback do not remove/recreate the
  mounted subtitle track.

### Bug B Detailed Repro And Failure Signature

Symptoms observed during compatibility playback:

- Debug `Track:` line flickers between the selected subtitle label and `none`.
- On-screen subtitles blink or briefly disappear.
- Debug cue text alternates between an active cue and empty/no active cue.
- Playback continues; the instability is isolated to subtitle mounting/display.

Repro conditions:

- Compatibility playback is active with a WebVTT-compatible subtitle selected.
- Startup mounted a windowed subtitle payload and recorded finite mounted
  coverage, commonly an initial `0-300s` window.
- Background preload later cached the full subtitle VTT through
  `/video/endpoints/subtitles/all`.
- Playback moved past the stale mounted window, for example from `300s` to
  `301s`.
- `timeupdate` kept firing during playback.

State-model inconsistency:

- `cachedSubtitleSourceForSeek(...)` prefers full subtitle cache when available.
- `subtitlesAreMounted(...)` still enforced `subtitleMountedWindowByPath` if a
  stale per-track mounted range remained.
- `mountSubtitleTrackForItem(...)` clears/removes the old `<track>` before
  inserting a new one, so any false negative from `subtitlesAreMounted(...)`
  becomes visible flicker.

Representative diagnostic signature:

```text
Subtitle mount started
reload_reason: timeupdate
subtitle_cache_source: full
global_current_time: just past stale mounted window end
Track: none flashes between real track labels
```

For the e2e fixture, the same signature appears on `Videos/seek-window.mkv`
when playback is moved to `17s` after a startup window ending at `12s`.

Healthy behavior after the fix:

- Full-cache steady playback should not repeatedly log `Subtitle mount started`
  with `reload_reason: timeupdate`.
- Window-only playback should still issue one intentional seek-window refresh
  when playback crosses uncovered mounted coverage.

## Non-Negotiable Principles

- Keep compatibility playback remote-only.
- Do not change burned-in subtitle behavior except where tests prove the shared
  state model requires a no-op preservation change.
- Do not add browser upload behavior.
- Do not make normal page load do extra Dropbox recursion.
- Keep the video player client-rendered path as the tested path.
- Run e2e verification at every phase boundary before continuing.
- Keep test fixtures deterministic; do not depend on real Dropbox files.
- Do not edit `plans/TODO_NOTES`.

## Target Structure

Replace the current implicit subtitle mount contract:

```text
subtitleMountedSeekSeconds
subtitleMountedStreamIndex
subtitleMountedWindowByPath
subtitleFullVttCacheByPath
subtitleWindowCacheByPath
subtitleDebug.trackLabel
DOM <track> state
```

with one explicit client-side mount-state object owned by
`dropbox_browser/assets/js/video/subtitles.js`:

```javascript
subtitleMountState: {
  mode: 'none' | 'window' | 'full',
  path: '',
  streamIndex: null,
  seekSeconds: 0,
  coverageStartSeconds: null,
  coverageEndSeconds: null,
  playbackSyncToken: null,
  generation: 0
}
```

The exact field names can change during implementation, but the structure must
make these rules explicit:

- Full-cache mounts are not bounded by stale window ranges.
- Full-cache preload invalidates stale mounted-window metadata for the same
  path/stream as soon as the full VTT is stored.
- Window mounts are bounded by the mounted window coverage.
- DOM track state and debug state are outputs of the mount state, not separate
  authorities.
- High-frequency `timeupdate` handling only requests work when the desired
  subtitle coverage differs from the current mount state.
- State transitions are centralized:
  `mountFromWindow(...)`, `cacheFullTrack(...)`, `mountFromFull(...)`,
  `clearForItemChange(...)`, `clearForTrackOff(...)`, and
  `clearForSessionReplacement(...)` should be the only places that can make
  mounted subtitle state stale or fresh.

## Phase 0 - Baseline And Branch Hygiene

- [x] Create and switch to new implementation branch:
      `subtitle-6-30-2026-bugfix`.
- [x] Confirm the active branch with `git branch --show-current` before code
      implementation continues.
- [x] Confirm the worktree is clean or identify unrelated local changes with
      `git status --short`.
- [x] Read `docs/video-player.md` and `docs/testing.md`.
- [x] Inspect current subtitle functions:
      `subtitlesAreMounted`, `mountSubtitleTrackForItem`,
      `applySubtitlesForSeek`, `preloadSubtitleWindowForStream`,
      `preloadAllSubtitleVttsForItem`, and the `timeupdate` listener.
- [x] Run the current relevant baseline:
      `node --test tests/js/video-subtitles-startup.test.js`.
- [x] Run the current relevant e2e baseline:
      `npx playwright test tests/e2e/video-subtitle-switch.integration.spec.js`.
- [x] Record any pre-existing failures in this plan before changing behavior.
      Current baseline on `subtitle-6-30-2026-bugfix`:
      `tests/js/video-subtitles-startup.test.js` passed 18/18 and
      `tests/e2e/video-subtitle-switch.integration.spec.js` passed 28/28 in one
      full run. No failing test is presently blocking implementation.
      One Python integration-server `ConnectionResetError [WinError 10054]`
      appeared in server logs during the passing Playwright run, so E2E
      hardening in Phase 6 remains justified even though the baseline passed.

## Phase 1 - Add Repro Coverage For Bug A

- [x] Add or modify an e2e test that fails without the Bug A behavior.
- [x] Use the generated video fixture and route interception to force
      `/video/endpoints/subtitles/all` and per-track full extraction to fail for
      `Videos/seek-window.mkv`, so only windowed subtitle extraction is active.
- [x] Mount an initial subtitle window that covers only the startup range.
- [x] Advance playback across the mounted-window boundary using the same helper
      style as existing subtitle e2e tests.
- [x] Assert that a `/video/endpoints/subtitles/window` request is made with
      `window_status=seek` for the crossed boundary.
- [x] Assert that the subtitle debug/current cue switches to the later-window
      text.
- [x] Assert no `/video/endpoints/session` restart is made for the subtitle
      window refresh.
- [x] Verify the new test fails on the pre-fix code path.
      Verified against a disposable snapshot exported from commit
      `f562edcb05f74ab76b4b4acae54517db9b5cdbc8` using the in-project
      `tests/e2e/fixtures/video_player_generated_fixture.py` generator and the
      current Bug A test overlaid onto that snapshot. Failure was the expected
      product behavior: after moving playback to `17s`, the debug subtitle text
      stayed at `No active subtitle cue.` instead of reaching
      `SEEK-WINDOW-ENG AGAIN`.
- [x] Implement the smallest Bug A fix if it is not already present:
      Already present on `subtitle-6-30-2026-bugfix` via
      `syncSubtitlesForCurrentPlaybackTime(...)` plus the `timeupdate` hookup
      that routes playback-boundary subtitle refresh through
      `applySubtitlesForSeek(...)` without forcing a new HLS session.
      `timeupdate` or equivalent edge-triggered playback sync must call
      `applySubtitlesForSeek(...)` for the current global playback time when the
      mounted window does not cover it.
- [x] Run the new Bug A e2e test until it passes.
- [x] Run the full subtitle-switch e2e file:
      `npx playwright test tests/e2e/video-subtitle-switch.integration.spec.js`.

## Phase 2 - Add Repro Coverage For Bug B

- [x] Add or modify an e2e test that fails without the Bug B behavior.
- [x] Start with a mounted windowed subtitle payload for `Videos/seek-window.mkv`.
- [x] Allow `/video/endpoints/subtitles/all` to populate the full subtitle cache
      after startup.
- [x] Move playback beyond the originally mounted window.
- [x] Instrument subtitle `<track>` removal in the page.
- [x] Dispatch repeated `timeupdate` events after the full-cache cue is visible.
- [x] Assert no subtitle track teardown/remount events occur during those
      repeated steady-state `timeupdate` events.
- [x] Assert the debug panel does not regress to `Track: none`.
- [x] Add or extend a JS unit test proving full-cache mounts clear or supersede
      stale mounted-window metadata.
- [x] Assert no non-startup subtitle-window fetch is attempted after full-cache
      takeover during repeated steady-state `timeupdate` events.
- [x] Verify the new Bug B e2e/unit tests fail on the pre-fix code path.
      Verified against a disposable snapshot at `f71f644` with the current Bug B
      e2e and JS test files overlaid onto that snapshot and exercised through the
      in-project `tests/e2e/fixtures/video_player_generated_fixture.py`
      generator.
      E2E failure matched the original bug: repeated steady-state `timeupdate`
      events produced a recorded subtitle `<track>` teardown instead of zero
      teardown events.
      JS failure matched the stale-state diagnosis: the mounted window entry
      remained `{ start_seconds: 0, end_seconds: 12 }` instead of becoming
      `undefined` after mounting from full cache.
- [x] Implement the smallest Bug B fix if it is not already present:
      Already present on `subtitle-6-30-2026-bugfix`. The current code does not
      proactively clear stale mounted-window state inside
      `storeFullSubtitleVtt(...)`, but Bug B does not persist because:
      `cachedSubtitleSourceForSeek(...)` prefers full cache, and the first
      full-cache `mountSubtitleTrackForItem(...)` clears the stale mounted
      window entry before subsequent steady-state `timeupdate` events can loop.
      full-cache storage and full-cache mounts must make stale mounted-window
      coverage irrelevant as early as possible.
- [x] Confirm whether storing full VTT for a path/stream proactively clears
      obsolete mounted-window metadata for that path/stream when the
      active/mounted source can no longer be window-bounded.
      It does not today; current code still clears on full-cache mount, not on
      cache store. Current regression coverage shows that mount-time clearing is
      sufficient to prevent Bug B as currently observed, so no extra Bug B-only
      fix is required before the later structural refactor phases.
- [x] Run the new Bug B unit and e2e tests until they pass.
- [x] Run the full subtitle-switch e2e file:
      `npx playwright test tests/e2e/video-subtitle-switch.integration.spec.js`.
      Current status after later refactor verification: the strengthened Bug B
      test passes, the JS subtitle tests pass, and the full file passed
      `28/28`. The unrelated intermittent failure in
      `missing HLS segment recovery restarts session instead of looping
      in-session seek` remains Phase 6 flake-hardening scope because it is not
      specific to the subtitle behavior under test.

## Phase 3 - Introduce Explicit Subtitle Mount State

- [x] Add a mount-state initializer to `video.js` state or to an init helper in
      `subtitles.js`.
- [x] Add helper functions in `subtitles.js`:
      `resetSubtitleMountState`, `recordWindowSubtitleMount`,
      `recordFullSubtitleCached`, `recordFullSubtitleMount`,
      `clearObsoleteMountedWindowState`, and `subtitleMountCoversTarget`.
- [x] Keep old fields temporarily populated where existing tests or functions
      still need them.
- [x] Make `mountSubtitleTrackForItem(...)` update mount state through the new
      helpers instead of writing scattered mounted fields directly.
- [x] Make full-cache storage update mount/cache state immediately so stale
      window metadata is removed before the next playback-time sync tick.
- [x] Make `clearSubtitleTrack()` clear the mount state and DOM/debug state in
      one ordered transition.
- [x] Add focused JS tests for:
      full mount covers any target for the same path/stream/seek;
      window mount covers only its recorded range;
      full-cache storage clears obsolete mounted-window metadata;
      clear resets to `mode: none`.
- [x] Run:
      `node --test tests/js/video-subtitles-startup.test.js`.
- [x] Run focused e2e for Bug A and Bug B.
- [x] Run the full subtitle-switch e2e file before continuing.
      Current verification after the explicit mount-state slice:
      `tests/js/video-subtitles-startup.test.js` passed 20/20 and
      `tests/e2e/video-subtitle-switch.integration.spec.js` passed 28/28.

## Phase 4 - Route Mounted Checks Through The New State

- [x] Rewrite `subtitlesAreMounted(...)` to ask the explicit mount state whether
      the current path/stream/seek/coverage target is satisfied.
- [x] Preserve compatibility with existing callers during the transition.
- [x] Remove duplicated mounted-window inference from `subtitlesAreMounted`.
- [x] Ensure full-cache presence and window-cache presence cannot disagree about
      whether the active track is mounted.
- [x] Confirm debug state is not used as an authority for mounted state.
- [x] Confirm stale mounted-window state is absent immediately after full-cache
      preload, not merely after a later full-cache remount.
- [x] Run:
      `node --test tests/js/video-subtitles-startup.test.js`.
- [x] Run focused e2e for Bug A and Bug B.
- [x] Run the full subtitle-switch e2e file before continuing.
      Current verification after routing mounted checks through explicit mount
      state: `tests/js/video-subtitles-startup.test.js` passed `23/23` and
      `tests/e2e/video-subtitle-switch.integration.spec.js` passed `28/28`.

## Phase 5 - Make Playback-Time Subtitle Sync Edge-Triggered

- [x] Replace unconditional high-frequency refresh attempts with an
      edge-triggered check.
- [x] Track the last subtitle coverage target or mount generation considered by
      playback-time sync.
- [x] Only call `applySubtitlesForSeek(...)` from playback-time sync when the
      current global playback time crosses outside the mounted window coverage.
- [x] Keep full-cache steady-state playback a no-op.
- [x] Keep genuine window-boundary crossing behavior from Bug A.
- [x] Ensure clearing stale state early does not suppress needed window-only
      boundary refreshes.
- [x] Keep seek, subtitle-track change, audio-track restart, and HLS recovery
      behavior routed through their existing explicit refresh paths.
- [x] Add JS coverage for the decision helper if a pure helper is introduced.
- [x] Run:
      `node --test tests/js/video-subtitles-startup.test.js`.
- [x] Run focused e2e for Bug A and Bug B.
- [ ] Run the full subtitle-switch e2e file before continuing.
      Current verification after the edge-triggered playback-sync slice:
      `tests/js/video-subtitles-startup.test.js` passed `25/25`.
      Focused Bug A and Bug B Playwright coverage passed:
      `windowed subtitles remount when playback crosses mounted coverage` and
      `full cached subtitles stay mounted across timeupdate without remount
      flicker`.
      The full file still intermittently fails in the unrelated Phase 6 test
      `missing HLS segment recovery restarts session instead of looping
      in-session seek`, so do not treat that flake as a subtitle-regression
      failure for this phase.

## Phase 6 - Harden E2E Against Late Subtitle Requests

- [x] Audit route handlers in
      `tests/e2e/video-subtitle-switch.integration.spec.js` that call
      `route.fetch()`.
- [x] Treat teardown-time `ECONNREFUSED 127.0.0.1:<port>` similarly to closed
      page/context errors when the page is already closing.
- [x] Prefer deterministic route fulfillment over proxying with `route.fetch()`
      where a test only needs a synthetic subtitle payload.
- [x] Ensure each test waits for the subtitle request or mounted state it caused
      before moving to teardown.
- [x] Re-run the two tests that previously failed only in full-file order:
      `subtitle track switch and audio restart keep windowed subtitles correct
      at non-zero playback` and `subtitle-ready scrubber debug info reflects
      full cached subtitle coverage after reload`.
- [x] Run the full subtitle-switch e2e file twice in a row.
- [x] If flake remains, collect Playwright error contexts and client logs before
      making further changes.
      Phase 6 changes:
      added shared JSON route helpers for `route.fetch()` interception,
      treated closed-page and connection-refused fetch failures as ignorable
      during teardown-sensitive interception, and reset active video session
      plus cache before the missing-HLS-segment recovery test so full-file order
      does not inherit stale server state.
      Verification:
      `missing HLS segment recovery restarts session instead of looping
      in-session seek` passed in isolation, and
      `npx playwright test tests/e2e/video-subtitle-switch.integration.spec.js`
      passed `28/28` twice in a row.

## Phase 7 - Remove Transitional State And Update Docs

- [x] Remove obsolete writes to `subtitleMountedSeekSeconds`,
      `subtitleMountedStreamIndex`, or `subtitleMountedWindowByPath` if the new
      mount state fully replaces them.
- [x] If those fields remain for compatibility or debug output, document why and
      ensure they are derived from the explicit mount state.
- [x] Update `docs/video-player.md` subtitle architecture notes to describe the
      explicit mount state and playback-boundary refresh behavior.
- [x] Keep the bug-plan notes focused; do not add local log dumps or generated
      state.
- [x] Run:
      `node --test tests/js/video-subtitles-startup.test.js`.
- [x] Run:
      `npm run test:js`.
- [x] Run:
      `npx playwright test tests/e2e/video-subtitle-switch.integration.spec.js`.
- [ ] Run `python -m tests.run video -v` if server endpoint behavior changed.
- [ ] Run `python -m tests.run web -v` if asset loading, page shell, or script
      contracts changed.
      Phase 7 result:
      removed the transitional runtime fields
      `subtitleMountedSeekSeconds` and `subtitleMountedStreamIndex`, moved
      diagnostics onto `subtitleMountState`, and documented why
      `subtitleMountedWindowByPath` still exists as derived mounted-coverage
      state for scrubber/debug consumers.
      Verification:
      `tests/js/video-subtitles-startup.test.js` passed `25/25`,
      `npm run test:js` passed `174/174`, and
      `tests/e2e/video-subtitle-switch.integration.spec.js` passed `28/28`.

## Final Acceptance Checklist

- [x] Bug A has an e2e test that fails before the fix and passes after it.
- [x] Bug B has an e2e test that fails before the fix and passes after it.
- [x] Bug B has focused JS coverage for stale mounted-window metadata/full-cache
      precedence.
- [x] Full subtitle-switch e2e passes repeatedly.
- [x] JS subtitle tests pass.
- [x] No subtitle remount storm occurs during full-cache steady playback.
- [x] Full-cache preload clears obsolete mounted-window state before the next
      `timeupdate` can classify the active full-cache subtitle as unmounted.
- [x] Window-only playback still refreshes when playback crosses uncovered
      mounted coverage.
- [x] Subtitle track changes and audio restarts preserve the selected subtitle at
      non-zero playback.
- [x] Reloaded video playback still mounts selected subtitles and reports full
      cached subtitle coverage.
- [x] Documentation describes the new mount-state contract.

## Questions Status

- [x] Branching question answered: implement on a new branch. Current branch is
      `subtitle-6-30-2026-bugfix`.
- [x] Bug-note question answered: incorporate the needed repro/debug context
      into this plan.
- [x] Stale-state question answered: clear stale subtitle state as soon as
      reasonably possible, especially when full-cache preload makes
      mounted-window metadata obsolete.
