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

- [ ] Extend `advanceQueueAfterPlaybackEnd(queueLength, activeIndex, loopEnabled)`
      in `video/queue-core.js` so the final item returns `0` only when loop is
      enabled; otherwise it continues to return `-1`.
- [ ] Add pure helpers for manual navigation:
      `previousQueueIndex(queueLength, activeIndex, loopEnabled)` and
      `nextQueueIndex(queueLength, activeIndex, loopEnabled)`.
- [ ] Make manual previous/next wrap when loop is enabled.
- [ ] Keep manual previous disabled on the first item when loop is off.
- [ ] Keep manual next disabled on the last item when loop is off.
- [ ] Add JS unit tests in `tests/js/video-core.test.js` covering looped and
      non-looped automatic end behavior, previous navigation, and next
      navigation.

## Phase 2 - Add Icons And Template Controls

- [ ] Reuse `music-loop.svg` for the video loop toggle icon.
- [ ] Rename `music-prev.svg` and `music-next.svg` to shared icon names, reuse
      those renamed icons for video previous/next, and update
      `music_player.html` so the music player still references the same icons.
- [ ] Add new vendored icons:
      `video-back-15.svg` and `video-forward-15.svg`.
- [ ] Register the new icon paths in `VIDEO_ICONS` in `video/constants.js`.
- [ ] Add buttons to `video_player.html` immediately after
      `#video-pip-toggle` and before `#video-fullscreen-toggle`, in this order:
      loop, previous, next, back 15 seconds, forward 15 seconds.
- [ ] Give each button a stable id:
      `video-loop-toggle`, `video-previous`, `video-next`,
      `video-back-15`, and `video-forward-15`.
- [ ] Use unique labels/titles:
      `Loop queue`, `Previous video`, `Next video`, `Back 15 seconds`, and
      `Forward 15 seconds`.
- [ ] Keep initial buttons disabled where playback/queue state is not ready;
      the loop button is the exception and should always be enabled so the user
      can toggle the persisted preference at any time.
- [ ] Add DOM references for the new buttons in `video.js`.
- [ ] Update web/UI asset contract tests if they assert the video template
      button set or icon references.

## Phase 3 - Persist Loop State

- [ ] Add `state.loopQueue` and a setting key such as
      `video-loop-queue`.
- [ ] Load initial loop state from `Settings.get('video-loop-queue', false)`
      during video player initialization, guarded for test contexts where
      `Settings` may be unavailable.
- [ ] Persist loop changes with `Settings.set('video-loop-queue', value)`,
      guarded the same way.
- [ ] Sync loop button state with `aria-pressed`, label/title text, and a visual
      active class consistent with existing control styling.
- [ ] Keep loop state independent from the music player's loop setting.
- [ ] Add JS or web tests proving the code uses the video-specific setting key
      and initializes safely when `Settings` is unavailable.

## Phase 4 - Wire Control Behavior

- [ ] In `controls.js`, add click handlers for the five new buttons.
- [ ] Expose minimal queue-control helpers from `queue.js` only if
      `controls.js` cannot own the behavior directly without crossing module
      boundaries.
- [ ] Implement previous video by selecting the computed previous queue index,
      setting `selectedQueueIndex`, setting autoplay/transport intent, and
      rendering/syncing playback through the existing queue path.
- [ ] Implement next video with the same path as previous video, using loop
      state where applicable.
- [ ] Update the existing `video-playback-ended` handler in `video.js` to pass
      loop state into `advanceQueueAfterPlaybackEnd`.
- [ ] When automatic end reaches no next item and loop is off, leave playback
      ended instead of restarting or selecting a different item.
- [ ] Implement back 15 seconds through the existing compatibility seek path:
      target is `max(0, currentGlobalPlaybackSeconds() - 15)`.
- [ ] Implement forward 15 seconds through the existing compatibility seek path:
      target is clamped near EOF with the same safety used by scrub/restart
      logic, and it should keep playback intent rather than triggering natural
      ended behavior.
- [ ] Preserve current play intent on 15-second seeks; if playback was running,
      it should keep running after any needed session restart.
- [ ] Disable previous/next based on queue state and loop state, not just video
      element availability: previous is disabled at the first item when loop is
      off, next is disabled at the last item when loop is off, and both can wrap
      when loop is on.
- [ ] Disable 15-second seek buttons when normal transport controls are
      unavailable or duration is unknown.
- [ ] Keep controls visible/revealed after each click and stop click propagation
      so overlay button clicks do not toggle play/pause through the stage.

## Phase 5 - Styling And Layout

- [ ] Confirm the added buttons fit in the existing `.video-controls-bar` at
      desktop embedded widths without overlapping time, volume, PiP, or
      fullscreen controls.
- [ ] Confirm the same controls appear and remain usable when
      `#video-playback-stage` is fullscreen.
- [ ] Add responsive CSS only if the existing control bar overflows at common
      narrow widths; prefer stable button dimensions and wrapping/compaction
      over text labels inside controls.
- [ ] Ensure active loop state is visually distinguishable without relying only
      on color, or at least has correct `aria-pressed` for assistive tech.
- [ ] Avoid changing unrelated video pane layout.

## Phase 6 - E2E Coverage

- [ ] Add a focused e2e spec, for example
      `tests/e2e/video-controls.integration.spec.js`, or extend the existing
      video e2e suite if sharing setup is materially simpler.
- [ ] Use the existing HLS stub and video fixture setup so tests do not require
      real ffmpeg playback.
- [ ] Embedded mode: queue at least two videos and verify previous/next buttons
      switch the active queue item.
- [ ] Embedded mode: set media time above 15 seconds, click back 15 seconds,
      and assert playback seeks near the expected earlier time.
- [ ] Embedded mode: click forward 15 seconds and assert playback seeks near
      the expected later time, using the existing compatibility/session restart
      test helpers where needed.
- [ ] Embedded mode: verify loop toggles `aria-pressed`, persists through a
      page reload, and makes natural playback end on the last queued item
      advance to the first item.
- [ ] Embedded mode: verify loop can be toggled before a video is loaded and
      that the persisted state affects later playback.
- [ ] Embedded mode: verify loop off leaves playback ended after the last item
      instead of wrapping.
- [ ] Fullscreen mode: enter fullscreen on `#video-playback-stage`, then repeat
      representative button checks for loop visibility/state, previous/next,
      and 15-second seeks.
- [ ] Fullscreen mode: assert the new buttons are visible, enabled/disabled
      correctly, and positioned in the control bar after PiP and before
      fullscreen.
- [ ] Add selectors/assertions that check each new control has a unique icon
      source.
- [ ] Run the focused e2e spec locally after implementation.

## Phase 7 - Regression Checks

- [ ] Run JS unit tests:
      `npm run test:js`.
- [ ] Run web UI tests if template, CSS, or asset contracts changed:
      `python -m tests.run web -v`.
- [ ] Run video endpoint tests if playback/session code changed:
      `python -m tests.run video -v`.
- [ ] Run the focused video controls e2e:
      `npx playwright test --grep "video controls"`.
- [ ] Run the broader video e2e suite before checkin:
      `npx playwright test --grep video`.

## Open Decisions / Questions

- [ ] None currently.
