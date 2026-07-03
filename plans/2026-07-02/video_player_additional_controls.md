# Video Player Additional Controls Plan

## Goal

Add five controls to the video player overlay, aligned immediately to the right
of the picture-in-picture button in both embedded and fullscreen playback:

- Loop queue toggle
- Previous video
- Next video
- Back 15 seconds
- Forward 15 seconds

The controls should use unique icons, preserve the current compatibility/HLS
playback behavior, and be covered by e2e tests in embedded and fullscreen mode.

## Current State

- The video overlay buttons live in `dropbox_browser/assets/templates/video_player.html`.
- DOM references and shared state are initialized in `dropbox_browser/assets/js/video.js`.
- Transport controls and overlay listeners live in `dropbox_browser/assets/js/video/controls.js`.
- Queue mutations live in `dropbox_browser/assets/js/video/queue.js`, with pure queue helpers in
  `dropbox_browser/assets/js/video/queue-core.js`.
- Existing player icons are declared in `dropbox_browser/assets/js/video/constants.js`.
- The music player already has persisted loop behavior using
  `Settings.get('music-loop-playlist', ...)`, `Settings.set(...)`, and
  `music-loop.svg`.
- Existing reusable music icons include `music-loop.svg`, `music-prev.svg`, and
  `music-next.svg`; previous/next should be renamed to shared icon names and
  the music player updated to use the renamed files.
- No video-specific 15-second seek icons exist yet.

## Non-Negotiable Principles

- Keep the video player dependency-free and continue using the existing
  stdlib-served assets.
- Do not change `/file`, `/download`, HLS session creation, or byte-range
  behavior except through the existing seek/restart APIs.
- Keep controls module-owned; do not add per-control listeners to the entry
  file.
- Do not hotlink icons. New icons must be vendored under
  `dropbox_browser/assets/icons/material-icon-theme/` and served by the existing
  constrained icon asset handler.
- Preserve keyboard/accessibility contracts: buttons need clear `aria-label`,
  `title`, disabled state, and `aria-pressed` where applicable.

## Phase 1 - Define Queue Navigation Semantics

- [x] Extend `advanceQueueAfterPlaybackEnd(queueLength, activeIndex, loopEnabled)`
      in `video/queue-core.js` so the final item returns `0` only when loop is
      enabled; otherwise it continues to return `-1`.
- [x] Add pure helpers for manual navigation:
      `previousQueueIndex(queueLength, activeIndex, loopEnabled)` and
      `nextQueueIndex(queueLength, activeIndex, loopEnabled)`.
- [x] Make manual previous/next wrap when loop is enabled.
- [x] Keep manual previous disabled on the first item when loop is off.
- [x] Keep manual next disabled on the last item when loop is off.
- [x] Add JS unit tests in `tests/js/video-core.test.js` covering looped and
      non-looped automatic end behavior, previous navigation, and next
      navigation.

## Phase 2 - Add Icons And Template Controls

- [x] Reuse `music-loop.svg` for the video loop toggle icon.
- [x] Rename `music-prev.svg` and `music-next.svg` to shared icon names, reuse
      those renamed icons for video previous/next, and update
      `music_player.html` so the music player still references the same icons.
- [x] Add new vendored icons:
      `video-back-15.svg` and `video-forward-15.svg`.
- [x] Register the new icon paths in `VIDEO_ICONS` in `video/constants.js`.
- [x] Add buttons to `video_player.html` immediately after
      `#video-pip-toggle` and before `#video-fullscreen-toggle`, in this order:
      loop, previous, next, back 15 seconds, forward 15 seconds.
- [x] Give each button a stable id:
      `video-loop-toggle`, `video-previous`, `video-next`,
      `video-back-15`, and `video-forward-15`.
- [x] Use unique labels/titles:
      `Loop queue`, `Previous video`, `Next video`, `Back 15 seconds`, and
      `Forward 15 seconds`.
- [x] Keep initial buttons disabled where playback/queue state is not ready;
      the loop button is the exception and should always be enabled so the user
      can toggle the persisted preference at any time.
- [x] Add DOM references for the new buttons in `video.js`.
- [x] Update web/UI asset contract tests if they assert the video template
      button set or icon references.

## Phase 3 - Persist Loop State

- [x] Add `state.loopQueue` and a setting key such as
      `video-loop-queue`.
- [x] Load initial loop state from `Settings.get('video-loop-queue', false)`
      during video player initialization, guarded for test contexts where
      `Settings` may be unavailable.
- [x] Persist loop changes with `Settings.set('video-loop-queue', value)`,
      guarded the same way.
- [x] Sync loop button state with `aria-pressed`, label/title text, and a visual
      active class consistent with existing control styling.
- [x] Keep loop state independent from the music player's loop setting.
- [x] Add JS or web tests proving the code uses the video-specific setting key
      and initializes safely when `Settings` is unavailable.

## Phase 4 - Wire Control Behavior

- [x] In `controls.js`, add click handlers for the five new buttons.
- [x] Keep queue-control behavior in `controls.js` without adding new
      cross-module helpers from `queue.js`.
- [x] Implement previous video by selecting the computed previous queue index,
      setting `selectedQueueIndex`, setting autoplay/transport intent, and
      rendering/syncing playback through the existing queue path.
- [x] Implement next video with the same path as previous video, using loop
      state where applicable.
- [x] Update the existing `video-playback-ended` handler in `video.js` to pass
      loop state into `advanceQueueAfterPlaybackEnd`.
- [x] When automatic end reaches no next item and loop is off, leave playback
      ended instead of restarting or selecting a different item.
- [x] Implement back 15 seconds through the existing compatibility seek path:
      target is `max(0, currentGlobalPlaybackSeconds() - 15)`.
- [x] Implement forward 15 seconds through the existing compatibility seek path:
      target is clamped near EOF with the same safety used by scrub/restart
      logic, and it should keep playback intent rather than triggering natural
      ended behavior.
- [x] Preserve current play intent on 15-second seeks; if playback was running,
      it should keep running after any needed session restart.
- [x] Add Space key play/pause toggling when the browser window is focused, and
      ensure Space also toggles play/pause while `#video-playback-stage` is
      fullscreen.
- [x] Disable previous/next based on queue state and loop state, not just video
      element availability: previous is disabled at the first item when loop is
      off, next is disabled at the last item when loop is off, and both can wrap
      when loop is on.
- [x] Disable 15-second seek buttons when normal transport controls are
      unavailable or duration is unknown.
- [x] Keep controls visible/revealed after each click and stop click propagation
      so overlay button clicks do not toggle play/pause through the stage.

## Phase 5 - Styling And Layout

- [x] Confirm the added buttons fit in the existing `.video-controls-bar` at
      desktop embedded widths without overlapping time, volume, PiP, or
      fullscreen controls.
- [x] Confirm the same controls appear and remain usable when
      `#video-playback-stage` is fullscreen.
- [x] Add responsive CSS only if the existing control bar overflows at common
      narrow widths; prefer stable button dimensions and wrapping/compaction
      over text labels inside controls.
- [x] Ensure active loop state is visually distinguishable without relying only
      on color, or at least has correct `aria-pressed` for assistive tech.
- [x] Avoid changing unrelated video pane layout.

## Phase 6 - E2E Coverage

- [x] Add a focused e2e spec, for example
      `tests/e2e/video-controls.integration.spec.js`, or extend the existing
      video e2e suite if sharing setup is materially simpler.
- [x] Use the existing HLS stub and video fixture setup so tests do not require
      real ffmpeg playback.
- [x] Embedded mode: queue at least two videos and verify previous/next buttons
      switch the active queue item.
- [x] Embedded mode: set media time above 15 seconds, click back 15 seconds,
      and assert playback seeks near the expected earlier time.
- [x] Embedded mode: click forward 15 seconds and assert playback seeks near
      the expected later time, using the existing compatibility/session restart
      test helpers where needed.
- [x] Embedded mode: verify loop toggles `aria-pressed`, persists through a
      page reload, and makes natural playback end on the last queued item
      advance to the first item.
- [x] Embedded mode: verify loop can be toggled before a video is loaded and
      that the persisted state affects later playback.
- [x] Embedded mode: verify loop off leaves playback ended after the last item
      instead of wrapping.
- [x] Fullscreen mode: enter fullscreen on `#video-playback-stage`, then repeat
      representative button checks for loop visibility/state, previous/next,
      and 15-second seeks.
- [x] Fullscreen mode: assert the new buttons are visible, enabled/disabled
      correctly, and positioned in the control bar after PiP and before
      fullscreen.
- [x] Add selectors/assertions that check each new control has a unique icon
      source.
- [x] Run the focused e2e spec locally after implementation.

## Phase 7 - Subtitle Styling Controls

- [x] Add black subtitle drop shadows, enabled by default, for both WebVTT
      overlay subtitles and burned-in subtitles.
- [x] Make WebVTT and burned-in subtitle shadows look as similar as practical,
      documenting any ffmpeg/subtitle-format limitation that prevents an exact
      match; pixel-identical rendering is not required.
- [x] Add subtitle styling controls in the tracks area below the subtitle track
      section:
      drop shadow enable/disable checkbox, subtitle text size number input, and
      subtitle height-from-default number input that accepts negative values.
- [x] Use current shipped subtitle presentation as the default values, except
      drop shadow should default to enabled.
- [x] Choose reasonable units/ranges for the number inputs that map cleanly to
      both CSS WebVTT rendering and ffmpeg burn-in rendering.
- [x] Apply changes immediately to WebVTT overlay subtitles as controls change,
      without requiring playback/session restart.
- [x] Add an Apply button for subtitle styling changes.
- [x] Apply burned-in subtitle styling only when the Apply button is pressed,
      using the existing compatibility restart path when a burned-in subtitle
      session needs regeneration.
- [x] Persist subtitle styling settings only when the Apply button is pressed,
      not on each live WebVTT preview change.
- [x] Persisted drop shadow, text size, and height offset settings apply to all
      videos and subtitle modes, including future playback sessions.
- [x] Keep the settings shared across embedded and fullscreen playback, with
      matching visual behavior in both modes.
- [x] Keep the settings independent from subtitle track selection and audio
      stream preferences.
- [x] Add JS, web, or e2e coverage for defaults, WebVTT live preview,
      Apply-triggered persistence, and burned-in restart/apply behavior.

## Phase 8 - Regression Checks

- [x] Run JS unit tests:
      `npm run test:js`.
- [x] Run web UI tests if template, CSS, or asset contracts changed:
      `python -m tests.run web -v`.
- [x] Run video endpoint tests if playback/session code changed:
      `python -m tests.run video -v`.
- [x] Run the focused video controls e2e:
      `npx playwright test --grep "video controls"`.
- [x] Run the broader video e2e suite before checkin:
      `npx playwright test --grep video`.

## Open Decisions / Questions

- [ ] None currently.
