# Video Subtitle Parallel Prefetch Plan

## Goal

Start sidecar subtitle extraction earlier during compatibility startup so it
overlaps with ffmpeg session create instead of beginning only after session create
returns.

Today:

```text
probe -> session create (~6s) -> subtitle preload + HLS attach (parallel)
      -> HLS buffer ready -> wait for subtitle window -> buffer_ready / overlay hides
```

Target:

```text
probe -> session create (~6s)  } parallel when sidecar subtitles are selected
      -> subtitle window prefetch }
      -> HLS attach after session create
      -> overlay hides when both HLS buffer and startup subtitle window are ready
```

Expected win:

- **No meaningful change** when subtitles are off or burned-in (most Eureka starts).
- **Moderate win** when sidecar subtitles are enabled: roughly up to one session-create
  duration (~6s median) removed from post-HLS subtitle wait, based on July 2026 log
  analysis of subtitle-gated initial-playback sessions.

Success criteria:

- Sidecar subtitle startup still waits for the selected track's startup window before
  revealing playback.
- Burned-in subtitle sessions do not start sidecar extraction.
- Stale `playbackSyncToken`, failed session create, and item changes do not mount or
  wait on old prefetch work.
- Existing subtitle startup unit and integration tests pass before and after the change.
- New tests lock in earlier prefetch scheduling and the skip conditions above.

## Current Diagnosis

Client startup in `dropbox_browser/assets/js/video/playback.js` and
`compatibility.js`:

1. Awaits probe.
2. Awaits `createCompatibilitySession(...)`.
3. Calls `scheduleSubtitlesAfterPlaybackReady(...)`, which starts
   `preloadAllSubtitleVttsForItem()` and then `applySubtitlesForSeek()`.
4. When HLS has startup buffer, `revealCompatibilityPlaybackWhenReady()` awaits
   `waitForCompatibilityStartupSubtitles()`, which blocks on
   `ensureStartupSubtitleWindowForPlayback()` if the track is not already mounted.

Relevant existing helpers in `dropbox_browser/assets/js/video/subtitles.js`:

- `preloadSubtitleWindowForStream()` — windowed `/video/endpoints/subtitles/window`
  fetch with in-flight dedup.
- `ensureStartupSubtitleWindowForPlayback()` — startup gate used by compatibility reveal.
- `scheduleSubtitlesAfterPlaybackReady()` — post-session-create preload/mount path.

Log evidence (`Temp/client_logs.jsonl`, non-test content):

- Median `buffer_ready - hls_first_fragment_loaded` across initial playback: **~64 ms**.
- **49** sessions had >=1s extra wait after HLS, with subtitle-wait overlay active.
- On those subtitle-gated sessions, median post-HLS wait **~7.2s** and median session
  create **~6.6s** — roughly one session-create window that could overlap with extraction.

## Non-Negotiable Principles

- Keep sidecar and burned-in subtitle paths separate.
- Do not change server subtitle endpoints or extraction behavior in this plan.
- Do not block session create on subtitle prefetch failure.
- Reuse existing in-flight dedup; do not add duplicate concurrent window fetches for the
  same path/track/window.
- Keep `buffer_ready` semantics: overlay still hides only when video buffer and required
  startup subtitles are ready (for sidecar tracks).
- Do not regress subtitle-off startup or seek/restart flows.

## Phase 0 - Verify Tests Pass Before Changes

Run and record results **before any implementation**. All listed commands must pass.

### Python sanity (unchanged server surface)

```powershell
python -m py_compile dropbox_browser.py
python -m compileall -q dropbox_browser.py dropbox_browser
```

### Focused subtitle/client tests

```powershell
node --test tests/js/video-subtitles-startup.test.js
node --test tests/js/video-subtitle-mount-core.test.js
node --test tests/js/video-compatibility-copy-fallback.test.js
```

### Subtitle startup integration coverage

```powershell
npx playwright test tests/e2e/video-subtitle-startup-wait.integration.spec.js
```

### Broader JS regression pass

```powershell
npm run test:js
```

### Optional timing baseline (generated state only)

Capture a few subtitle-on startup timings from `Temp/client_logs.jsonl` after playing
one slow sidecar case and one subtitles-off case. Suggested samples:

- Sidecar, slow extraction: Conan Movie 24 or Fruits Basket S01 with subtitles enabled.
- Subtitles off: Eureka Seven episode with subtitles disabled.

Record per session:

- `session_create_complete - session_create_requested`
- `buffer_ready - hls_first_fragment_loaded`
- `buffer_ready` total elapsed

Save notes under `Temp/video_benchmarks/subtitle-prefetch-baseline-2026-07-05.txt`.
Do not commit media or generated logs.

### Baseline gate

Do not start Phase 1 until every command in this phase passes and baseline notes are
recorded for at least one subtitle-on and one subtitle-off sample.

## Phase 1 - Add A Shared Prefetch Entry Point

- [ ] Add a small helper in `subtitles.js`, e.g.
      `startStartupSubtitlePrefetch(item, probePayload, seekSeconds, syncToken, reason)`.
- [ ] Helper behavior:
      - return immediately when subtitles are disabled for the item;
      - return immediately for burned-in subtitle selection;
      - return immediately when startup window coverage is already cached/mounted;
      - otherwise call `preloadSubtitleWindowForStream(...)` with
        `windowStatus: 'startup'` (or `'seek'` when `seekSeconds > 0`) without awaiting
        from the caller;
      - pass `playbackSyncToken` through for stale-request protection.
- [ ] Export the helper on `ctx` alongside existing subtitle APIs.
- [ ] Add a focused unit test proving the helper:
      - starts window prefetch for sidecar selection;
      - does not fetch when subtitles are off;
      - does not fetch for burned-in selection.

## Phase 2 - Wire Prefetch Before Session Create

- [ ] In `playback.js` `syncPlaybackForActiveItem()`:
      after probe completes and before `createCompatibilitySession(...)`, call
      `startStartupSubtitlePrefetch(...)` for initial playback at `t=0`.
- [ ] In `compatibility.js` `restartCompatibilityAt()`:
      after probe completes and before `createCompatibilitySession(...)`, call the same
      helper with the restart target seconds and current `playbackSyncToken`.
- [ ] Keep `scheduleSubtitlesAfterPlaybackReady(...)` after session create for mount/batch
      warm behavior; rely on in-flight dedup so the early prefetch is reused rather than
      duplicated.
- [ ] Keep `waitForCompatibilityStartupSubtitles()` as the reveal gate; it should become
      faster when prefetch finished during session create.
- [ ] Ensure failed session create or sync-token change does not leave the subtitle-wait
      overlay stuck:
      - stale prefetch promises must not satisfy the wait;
      - existing stale checks in `subtitlePlaybackRequestIsStale()` remain authoritative.

## Phase 3 - Test Updates For New Scheduling

- [ ] Extend `tests/js/video-subtitles-startup.test.js`:
      - prefetch helper invoked before session create in the initial-playback path;
      - restart path also prefetches with non-zero `seekSeconds` when sidecar subtitles
        are enabled;
      - reveal still awaits startup window when prefetch has not completed.
- [ ] If needed, add a small mock-context test file rather than over-expanding an
      already large startup test module.
- [ ] Re-run the Phase 0 focused JS tests while developing; fix regressions before moving on.
- [ ] Review `tests/e2e/video-subtitle-startup-wait.integration.spec.js`:
      - expected to keep passing unchanged overlay contract (`subtitle-wait` still shown
        when extraction is slow and not cached);
      - optional enhancement: assert `buffer_ready` happens sooner when the delayed
        fixture is used, if the harness can observe timing reliably.

## Phase 4 - Verify Tests Pass After Changes

Run the same verification set as Phase 0. All commands must pass again.

```powershell
python -m py_compile dropbox_browser.py
python -m compileall -q dropbox_browser.py dropbox_browser

node --test tests/js/video-subtitles-startup.test.js
node --test tests/js/video-subtitle-mount-core.test.js
node --test tests/js/video-compatibility-copy-fallback.test.js

npx playwright test tests/e2e/video-subtitle-startup-wait.integration.spec.js

npm run test:js
```

### Optional timing verification (generated state only)

Repeat the Phase 0 manual plays for the same subtitle-on and subtitle-off samples.
Save results to `Temp/video_benchmarks/subtitle-prefetch-after-2026-07-05.txt`.

Target on subtitle-on samples:

- `buffer_ready - hls_first_fragment_loaded` drops materially when extraction is not
  already cached;
- `session_create` timing unchanged;
- subtitles-off samples unchanged.

If subtitle-on improvement is under ~2s on a slow sidecar sample, inspect whether early
prefetch is being skipped, stale-token cancellation is firing, or cache already hid the
win.

## Phase 5 - Documentation Touch-Up

- [ ] Update `docs/video-player.md` startup flow to note that sidecar subtitle window
      prefetch begins at session-create request time and continues in parallel with ffmpeg
      session create.
- [ ] Mention that reveal still gates on startup subtitle window readiness for sidecar
      tracks.

## Ownership Map

| Concern | Module |
|---------|--------|
| Prefetch helper and window/cache dedup | `dropbox_browser/assets/js/video/subtitles.js` |
| Initial playback wiring | `dropbox_browser/assets/js/video/playback.js` |
| Seek/restart wiring | `dropbox_browser/assets/js/video/compatibility.js` |
| Overlay reveal gate | `dropbox_browser/assets/js/video/compatibility.js` |
| Unit tests | `tests/js/video-subtitles-startup.test.js` |
| Integration test | `tests/e2e/video-subtitle-startup-wait.integration.spec.js` |
| Docs | `docs/video-player.md` |

## Out Of Scope

- Server-side subtitle extraction performance changes.
- Parallelizing subtitle fetch with probe.
- Changing burned-in subtitle behavior.
- Replacing the startup subtitle window gate with "play without subtitles first".