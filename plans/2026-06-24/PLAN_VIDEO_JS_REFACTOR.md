# Video.js / video-core.js Refactor Plan

Plan for splitting `video.js` (~3,930 lines) and `video-core.js` (~380 lines) into focused ES modules. Updated after review feedback (2026-06-24).

---

## Current State

| File | Size | Problem |
|------|------|---------|
| `video.js` | ~3,930 lines, ~200 functions in one IIFE | Any edit risks breaking unrelated playback, subtitles, HLS, queue, or controls |
| `video-core.js` | ~380 lines | Already pure/testable, but mixes queue math, compatibility seek logic, and WebVTT HTML |

The music player already uses the pattern we should mirror: a thin `music.js` entry that builds `ctx` and calls `initX(ctx)` modules — but with **module-owned DOM/event binding**, not a fat entry that wires every listener.

---

## Review Feedback (Point by Point)

### 1. Fix the `video-core.js` barrel / test assumption — **Agree**

`tests/js/video-core.test.js` imports modules via a `data:text/javascript;base64,...` URL (`tests/js/video-core.test.js:6–9`). Relative imports inside a barrel (`export * from './video/queue-core.js'`) will not resolve from that `data:` base.

**Plan change:** Phase 1 updates the test helper to use `pathToFileURL(absolutePath).href` (same pattern as `browse-main.test.js`, `file-search.test.js`, etc.). The barrel re-export in `video-core.js` remains valid for browser/runtime imports; tests just must load from real file URLs.

### 2. Don't keep all event listeners in `video.js` — **Agree**

Current listeners at `video.js:3626+` call deep implementation functions across controls, subtitles, compatibility, queue, and playback. Keeping them all in the entry either balloons `ctx.*Api` or leaves `video.js` too fat.

**Plan change:** Each module binds its own DOM/event listeners inside `initControls(ctx)`, `initQueue(ctx)`, `initTracks(ctx)`, `initCompatibility(ctx)`, etc. The entry keeps only **global cross-app events**: `bottom-pane-mode-changed`, `browse-folder-changed`, `beforeunload`, and `video-playback-ended` on the pane. Modules expose a small `ctx.*Api` only where cross-module calls are genuinely needed (e.g. `restartCompatibilityAt` for track changes), not to proxy every listener callback.

### 3. Reorder subtitles / compatibility extraction — **Agree**

The original plan had init order `compatibility → subtitles` but phases extracted subtitles (Phase 5) before compatibility (Phase 6). Subtitle code calls compatibility paths (`restartCompatibilityAt`, `resyncSubtitleTrackAfterHlsRecovery`, etc.), so extracting subtitles first forces awkward temporary APIs.

**Plan change:** Reordered phases:
1. Extract a small **compatibility API facade** (session create/stop, restart, in-session seek signatures) while HLS body still lives in monolith.
2. Extract full **compatibility.js** (HLS attach, recovery).
3. Extract **subtitles.js** once the compatibility API exists.

### 4. Move Hls ownership fully into `compatibility.js` — **Agree**

`video.js` currently imports Hls at line 1. If compatibility owns attach/recovery, it should `import Hls from '../vendor/hls.js'` directly. The entry must not know about HLS.

**Plan change:** `import Hls` moves to `video/compatibility.js` only. `video.js` entry has no Hls import. `test_web_ui.py` HLS-related string assertions move to the compatibility module checks.

### 5. Update web tests incrementally, not Phase 8 only — **Agree**

`tests/test_web_ui.py` has many direct `video_js` string assertions from ~line 948 onward. Leaving them until the end makes `python -m tests.run web -v` fail for most of the refactor.

**Plan change:** Each phase updates affected `test_web_ui.py` assertions as code moves (fetch the new module file, same pattern as music's `music_playback_js`, etc.). No end-only web-test phase.

### 6. Move `parseWebVttCues` into a pure module in the first pass — **Agree**

High-risk subtitle parsing logic should get direct JS unit tests before the large subtitle extraction.

**Plan change:** Add `video/vtt-parse-core.js` (or extend `webvtt-core.js`) with `parseWebVttCues` and related pure helpers in Phase 1, with new tests in `tests/js/video-vtt-parse.test.js` (or extend `video-core.test.js`). No longer optional follow-up.

### 7. Add an "all video modules import cleanly" JS smoke test — **Agree**

`npm run test:js` currently mainly protects `video-core`; it will not catch browser module graph / relative-import errors across split files.

**Plan change:** Once modules exist (Phase 2+), add `tests/js/video-modules.test.js` that imports each `video/*.js` module via `pathToFileURL` with minimal DOM/globals stubs (pattern from `browse-main.test.js`). Run on every phase.

### 8. Keep the nested asset plan — **Agree**

The handler already serves recursive `/assets/js/...` paths with JavaScript content type at `handlers.py:1133`. No routing or `views.py` script-tag change needed.

---

## Target Layout

```
dropbox_browser/assets/js/
  video.js                      # thin entry (~150 lines): ctx, boot, global events only
  video-core.js                 # barrel re-export (browser + tests via pathToFileURL)
  video/
    constants.js                # VIDEO_ICONS, timing/poll/recovery constants
    shared.js                   # formatting, paths, loading overlay, status helpers
    diagnostics.js              # client-log timing/diagnostic reporters
    library.js                  # folder library fetch/render, playback status
    queue.js                    # queue render + mutations + queue button listeners
    probe.js                    # probe sessionStorage cache + /video/endpoints/probe
    tracks.js                   # audio/subtitle selectors, preferences, change handlers + listeners
    compatibility.js            # HLS import, session, seek/restart, recovery + media listeners
    subtitles.js                # VTT mount/cache/overlay/debug + subtitle sync listeners
    controls.js                 # transport UI, progress scrubber, overlay + control listeners
    playback.js                 # syncPlaybackForActiveItem orchestration, surface reset
    pane.js                     # syncPaneMode, pane lifecycle
    queue-core.js               # pure queue ops (from video-core)
    compatibility-core.js       # seek decisions, ranges, duration (from video-core)
    webvtt-core.js              # WebVTT HTML helpers (from video-core)
    vtt-parse-core.js           # parseWebVttCues + cue timing pure helpers (from video.js)
```

**HTML / routing:** No change. Still load only `/assets/js/video.js`. Nested modules import via ES modules; asset handler serves `assets/js/**` recursively.

**Hls:** Only `video/compatibility.js` imports `../vendor/hls.js`.

---

## Structural Improvements

### 1. `initX(ctx)` modules with module-owned listeners

Each module exports one `initLibrary(ctx)`, `initCompatibility(ctx)`, etc. The module:
- Owns its DOM `addEventListener` wiring inside `init`.
- Exposes a **minimal** `ctx.*Api` only for cross-module calls that cannot stay internal.

Cross-module examples that still need `ctx.*Api`:
- `ctx.compatibilityApi.restartAt(targetSeconds, reason)` — called from tracks (audio/subtitle change) and controls (scrub).
- `ctx.playbackApi.syncForActiveItem()` — called from pane mode changes and queue advance.
- `ctx.subtitlesApi.applyForSeek(...)` — called from compatibility after seek/restart.

Not exposed through `ctx.*Api`: overlay reveal, volume slider, queue up/down, library selection — those stay inside their modules.

### 2. Init order

```
shared → diagnostics → library → queue → probe → tracks
→ compatibility (registers compatibilityApi)
→ subtitles (uses compatibilityApi)
→ controls → playback → pane
```

Compatibility registers `ctx.compatibilityApi` before subtitles init. Playback/pane init last so they can call into registered APIs.

### 3. Split `video-core.js` into focused pure modules

`video-core.js` remains a barrel for browser imports:

```js
export * from './video/queue-core.js';
export * from './video/compatibility-core.js';
export * from './video/webvtt-core.js';
export * from './video/vtt-parse-core.js';
```

**Tests:** `tests/js/video-core.test.js` helper switches to `pathToFileURL` so barrel relative imports resolve. Existing test cases stay; add VTT parse tests for `vtt-parse-core.js`.

### 4. `parseWebVttCues` in first pass

Extract `parseWebVttCues`, `parseVttTimestamp`, `formatVttTimestamp`, `shiftVttTimingLine`, `rebaseWebVttText` into `vtt-parse-core.js` in Phase 1 with unit tests before subtitle module extraction.

### 5. Keep `ctx.state` shape unchanged

No state redesign — only file boundaries, listener ownership, and minimal `ctx.*Api` wiring.

### 6. Entry `video.js` responsibilities only

- Build `ctx` (els, state, `setStatus`).
- Call `initX(ctx)` in order.
- Wire global events: `bottom-pane-mode-changed`, `browse-folder-changed`, `beforeunload`, pane `video-playback-ended`.
- Bootstrap: initial render calls, `syncPaneMode` on load.
- **No** Hls import, **no** per-control listener wiring.

---

## What Moves Where (High Level)

| Concern | New home | Approx. lines |
|---------|----------|---------------|
| Queue/library UI, folder browsing, queue listeners | `library.js`, `queue.js` | ~450 |
| Probe cache + metadata fetch | `probe.js` | ~200 |
| Audio/subtitle track UI, preferences, change listeners | `tracks.js` | ~350 |
| VTT cue parsing (pure) | `vtt-parse-core.js` | ~120 |
| Subtitle mount, overlay, cache, debug, sync listeners | `subtitles.js` | ~600 |
| HLS attach, session, seek/restart, recovery, media listeners | `compatibility.js` | ~900 |
| Play/pause, volume, fullscreen, PiP, progress, overlay listeners | `controls.js` | ~450 |
| `syncPlaybackForActiveItem` orchestration | `playback.js` | ~200 |
| Pure queue/seek/WebVTT math | `*-core.js` modules | ~500 |

### Listener ownership (moved out of entry)

| Listeners (current `video.js` region) | Owner module |
|---------------------------------------|--------------|
| Library up / add-selected | `queue.js` or `library.js` |
| Queue play/remove/up/down/clear | `queue.js` |
| Audio/subtitle track `change` | `tracks.js` |
| Playback surface click/dblclick/mouse | `controls.js` |
| Play/mute/volume/fullscreen/pip/progress | `controls.js` |
| `videoEl` loadedmetadata/timeupdate/play/pause/… | `compatibility.js` + `controls.js` (split: HLS/buffer events → compatibility; transport sync → controls) |
| `bottom-pane-mode-changed`, `browse-folder-changed`, `beforeunload`, `video-playback-ended` | `video.js` entry |

---

## Test Plan (Every Major Step)

| Step | Verification |
|------|----------------|
| Phase 1 | `npm run test:js` — updated `video-core.test.js` helper + new `vtt-parse` tests |
| Each phase after modules exist | `tests/js/video-modules.test.js` smoke imports |
| After probe/tracks/compatibility/subtitles | `python -m tests.run video -v` |
| **Same phase** as each code move | Update `test_web_ui.py` assertions for moved strings |
| After compatibility + subtitles | Full e2e: `npx playwright test tests/e2e/video-subtitle-*.integration.spec.js` |
| Final | `python -m tests.run web -v` (should pass incrementally, not only at end) |

### E2E specs

- `tests/e2e/video-subtitle-switch.integration.spec.js`
- `tests/e2e/video-subtitle-startup-wait.integration.spec.js`
- `tests/e2e/video-subtitle-fullscreen-layout.integration.spec.js`
- `tests/e2e/video-subtitle-bitmap.integration.spec.js`

### Test commands

```powershell
npm run test:js
python -m tests.run video -v
npx playwright test tests/e2e/video-subtitle-*.integration.spec.js
python -m tests.run web -v
```

### New / updated test files

| File | Purpose |
|------|---------|
| `tests/js/video-core.test.js` | Switch import helper to `pathToFileURL` |
| `tests/js/video-vtt-parse.test.js` | Unit tests for `vtt-parse-core.js` |
| `tests/js/video-modules.test.js` | Smoke-import every `video/*.js` module |
| `tests/test_web_ui.py` | Incremental assertion updates per phase |

---

## Implementation Phases (Incremental, Test-Gated)

1. **Phase 1 — Pure core split** — **DONE**
   - Split `video-core.js` into `queue-core`, `compatibility-core`, `webvtt-core`.
   - Extract `vtt-parse-core.js` from monolith `parseWebVttCues` (+ helpers).
   - Barrel `video-core.js`; fix test helper to `pathToFileURL`.
   - Add `video-vtt-parse.test.js`.
   - Run `npm run test:js`.

2. **Phase 2 — `constants`, `shared`, `diagnostics`** — **DONE**
   - Add `video-modules.test.js` smoke test.
   - Update `test_web_ui.py` for any strings moved off `video.js`.
   - Run `npm run test:js`.

3. **Phase 3 — `library`, `queue`** (module-owned queue/library listeners) — **DONE**
   - Update `test_web_ui.py`.
   - Run `npm run test:js`, `python -m tests.run web -v`.

4. **Phase 4 — `probe`, `tracks`** (module-owned track change listeners) — **DONE**
   - Update `test_web_ui.py`.
   - Run `npm run test:js`, `python -m tests.run video -v`, `python -m tests.run web -v`.

5. **Phase 5 — Compatibility API facade + `compatibility.js`** — **DONE**
   - Register `ctx.compatibilityApi` (restart, stop session, in-session seek).
   - Move Hls import here; HLS attach, recovery, session lifecycle.
   - Move `videoEl` HLS/buffer/waiting/error listeners into compatibility (or shared with controls per split above).
   - Update `test_web_ui.py` (HLS strings → `compatibility.js`).
   - Run full e2e video suite + `web` + `video` groups.

6. **Phase 6 — `subtitles.js`** — **DONE**
   - Extract subtitle mount/cache/overlay/debug; uses `ctx.compatibilityApi`.
   - Update `test_web_ui.py`.
   - Run full e2e video suite.

7. **Phase 7 — `controls`, `playback`, `pane`** + slim entry `video.js` — **DONE**
   - Controls owns transport/progress/overlay listeners.
   - Entry sheds all per-control listeners and Hls import.
   - Update `test_web_ui.py`.
   - Run all tests.

Each phase is a mechanical move with no intended logic changes.

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| `data:` URL barrel import failure | Phase 1: `pathToFileURL` in test helper |
| Circular imports subtitles ↔ compatibility | Init order + minimal `ctx.compatibilityApi` before subtitles extraction |
| Fat entry / huge `ctx.*Api` | Module-owned listeners; expose only true cross-module calls |
| `test_web_ui.py` fails mid-refactor | Incremental assertion updates each phase |
| E2E HLS stub routing | Unchanged — still stubs `/assets/js/vendor/hls.js` |
| Module import graph errors | `video-modules.test.js` smoke test every phase |
| Accidental behavior drift | No logic edits during moves; run js unit + e2e after every phase |

---

## Out of Scope (Unless Explicitly Requested)

- Changing playback behavior, subtitle semantics, or HLS recovery logic
- Renaming `ctx.state` fields
- New features or deleting dead code
- Editing `TODO_NOTES`

---

## Approval Status

Direction approved with the corrections above incorporated. Ready for phased implementation.