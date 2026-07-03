# Video Player Small Layout And Track Panel Plan

## Goal

Fix the video playback pane so it remains usable at small browser and bottom-pane
sizes:

- The debug info bar must remain reachable instead of disappearing below the
  playback surface.
- The playback section should preserve a practical minimum video area, then
  scroll vertically when the pane cannot fit every control.
- Audio/subtitle track selection should move below the video surface and above
  debug info.
- Track selection should be collapsible, using the same behavior and visual
  language as debug info.
- The selected audio and subtitle tracks should always be visible in the
  collapsed and expanded track-selection summary, truncated cleanly when long.
- Small-window layout needs focused browser coverage that can survive later
  shared music/video layout refactoring.

## Current State

- The video player template lives in
  `dropbox_browser/assets/templates/video_player.html`.
- Video styles live in `dropbox_browser/assets/css/video.css`.
- The playback pane now owns vertical scrolling and keeps the embedded playback
  stage at a `--video-playback-stage-min-height` of `180px`.
- Track selectors now sit below the video surface and above debug info inside a
  collapsed-by-default `<details id="video-track-panel">`.
- Debug info and track selection both use shared local collapsible panel
  classes, with sticky summaries and bounded body scrolling.
- Audio/subtitle summary labels live in the track-panel summary and are updated
  by `dropbox_browser/assets/js/video/tracks.js`.
- DOM references for video player controls and summary fields are initialized in
  `dropbox_browser/assets/js/video.js`.
- Existing small-layout coverage already asserts stage minimum height, playback
  pane vertical scrolling, track-panel/debug-panel reachability, and summary
  truncation behavior through
  `tests/e2e/video-playback-small-layout.integration.spec.js`.

## Non-Negotiable Principles

- Keep playback/HLS/session behavior unchanged; this is layout and track-panel
  presentation work.
- Do not change `/file`, `/download`, subtitle extraction, or session endpoint
  behavior.
- Keep track-selection behavior module-owned in `video/tracks.js`.
- Keep the debug panel visible/reachable at small sizes; vertical scrolling is
  acceptable and expected.
- Do not hard-code assertions that depend on exact pixel-perfect final styling;
  tests should assert usability contracts that can survive shared music/video
  layout work.
- Avoid adding another one-off layout system if a small reusable panel class can
  serve both track selection and debug info.

## Phase 1 - Define Small-Viewport Layout Contracts

- [x] Set the minimum practical embedded video stage height to `180px`, using a
      CSS custom property such as `--video-playback-stage-min-height: 180px`,
      matching the existing e2e expectation that the stage is greater than
      180px when usable.
- [x] Decide the minimum playback-pane scroll contract: the playback pane should
      own vertical scrolling when its content exceeds available height, while
      library and queue panes continue to manage their own list scrolling.
- [x] Keep the video stage from shrinking below the chosen minimum in normal
      embedded mode.
- [x] Let the playback pane scroll to track selection and debug info when the
      available Y size is smaller than header + stage + panels.
- [x] Confirm that fullscreen remains controlled by
      `.video-playback-stage:fullscreen` and is not affected by embedded-pane
      minimum-height rules.
- [x] Treat horizontal overflow as a regression: small windows may scroll
      vertically, but playback controls should not require horizontal scrolling.

## Phase 2 - Move Track Selection Below The Video Surface

- [x] In `video_player.html`, move the audio/subtitle selector block so it sits
      after `#video-playback-surface` and before `#video-debug-panel`.
- [x] Replace the plain `.video-playback-controls` wrapper with a
      `<details>` panel, for example:
      `id="video-track-panel"` and `class="video-track-panel video-collapsible-panel"`.
- [x] Add a `<summary>` that follows the same interaction model as
      `#video-debug-panel`: clickable summary, native details expansion, and no
      custom collapse state unless later needed.
- [x] Keep stable selector ids `#video-audio-track` and
      `#video-subtitle-track` so existing track-selection code and tests keep
      working.
- [x] Add stable summary value elements, for example
      `#video-audio-track-summary` and `#video-subtitle-track-summary`, with
      labels that make both selected tracks visible in collapsed and expanded
      states.
- [x] Preserve keyboard accessibility by using native `<details>/<summary>` and
      ensuring summary text reflects the selected tracks.
- [x] Make the track-selection panel collapsed by default; selected audio and
      subtitle values remain visible through the summary.

## Phase 3 - Share Collapsible Panel Styling Locally

- [x] Extract the common debug-panel shell styles into video-local classes such
      as `.video-collapsible-panel`, `.video-collapsible-summary`, and
      `.video-collapsible-body`.
- [x] Update `#video-debug-panel` to use the shared collapsible classes while
      preserving debug-specific ids and body layout.
- [x] Style the new track panel with the same border, summary background,
      typography, sticky summary behavior, and max-height pattern as debug info.
- [x] Keep panel body scrolling bounded so expanding track selection cannot push
      debug info permanently out of reach.
- [x] Use grid/flex rules for the summary track values so audio and subtitle are
      both visible, each truncating with `overflow: hidden`,
      `text-overflow: ellipsis`, and `white-space: nowrap`.
- [x] Use CSS-only ellipsis for track-summary truncation and keep the full label
      in each summary value's `title`; do not add hard JavaScript clipping.
- [x] Keep the CSS class names generic enough that later music/video shared
      layout work can lift them into a shared stylesheet without changing the
      e2e selectors.

## Phase 4 - Make Playback Pane Vertically Scrollable

- [x] Change `.video-playback-pane` behavior so it can scroll vertically when
      its content exceeds the available pane height.
- [x] Keep `.video-playback-surface` from being the only flexible consumer of
      space: give it a stable `flex` basis or minimum height and avoid
      `min-height: 0` collapsing the video stage at small sizes.
- [x] Ensure the playback header remains in normal document flow and does not
      overlap the video surface or panels.
- [x] Ensure debug and track panel summaries remain reachable with normal wheel,
      touchpad, PageDown, and keyboard scrolling.
- [x] Review `.video-controls-overlay`, `.video-controls-bar`, and
      `.video-progress-group` at narrow widths.
- [x] Add responsive CSS for the video control bar if needed: allow wrapping or
      compact grouping of existing buttons so play, time, mute/volume, PiP, and
      fullscreen remain accessible without horizontal overflow.
- [x] Keep control buttons icon-only and preserve stable button dimensions.
- [x] Verify volume slider hover expansion does not force horizontal overflow in
      the smallest tested viewport; if it does, cap or adapt the slider width
      under a media query.

## Phase 5 - Track Summary State And Updates

- [x] Add DOM references in `video.js` for the new summary value elements:
      audio summary and subtitle summary.
- [x] In `video/tracks.js`, add helper functions that derive the currently
      selected audio and subtitle display labels from the existing `<select>`
      options.
- [x] Update the summary after every placeholder render:
      no video selected, loading, unavailable, no tracks, and enabled states.
- [x] Update the summary after every successful audio track change.
- [x] Update the summary after every subtitle track change, including
      `Subtitles Off`.
- [x] Use the same labels as select options where possible, because
      `audioTrackLabel()` and `subtitleTrackLabel()` already encode language,
      title, codec, burn-in status, and stream index.
- [x] Set `title` attributes on the summary value elements to the full labels
      so truncated text remains inspectable.
- [x] Make the fallback text explicit and short, for example `Audio: none` or
      `Subtitles: off`, without introducing new playback state.

## Phase 6 - Web Contract Tests

- [x] Update `tests/test_web_ui.py` template assertions to expect
      `#video-track-panel`, `#video-audio-track-summary`, and
      `#video-subtitle-track-summary`.
- [x] Update CSS contract assertions to cover the shared collapsible classes and
      the playback-pane vertical overflow rule.
- [x] Keep tests focused on stable ids/classes and accessibility attributes, not
      exact visual copy that may change during later layout refactoring.
- [x] Run:
      `python -m tests.run web -v`.

## Phase 7 - Small-Viewport Browser Coverage

- [x] Add a focused e2e spec, for example
      `tests/e2e/video-playback-small-layout.integration.spec.js`, or extend
      an existing video layout spec if sharing setup is materially simpler.
- [x] Use the existing generated video fixture and HLS stub setup so the test
      does not depend on real remote Dropbox access.
- [x] Use a small viewport, for example `480x360` or `520x380`, and set a small
      bottom-pane height through `--log-panel-height` to reproduce the cramped
      playback pane.
- [x] Open `/?path=Videos`, switch to the video player pane, and wait for the
      player shell to render.
- [x] Queue or play a video with long audio/subtitle labels if the existing
      generated fixture has one; otherwise extend the fixture with long track
      titles so truncation is exercised.
- [x] Assert the playback pane has vertical scroll capacity when content exceeds
      its visible height.
- [x] Assert `#video-playback-stage` has at least the chosen minimum usable
      height and a nonzero width.
- [x] Assert `#video-track-panel` is reachable by scrolling and that its summary
      is visible.
- [x] Assert both `#video-audio-track-summary` and
      `#video-subtitle-track-summary` have non-empty rendered text and their
      bounding boxes stay inside the summary container.
- [x] Assert long summary text is visually truncated instead of overflowing:
      element `scrollWidth > clientWidth` is acceptable only when CSS ellipsis
      is active and the container itself does not overflow horizontally.
- [x] Assert `#video-debug-panel` summary is reachable by scrolling at the same
      small size.
- [x] Reveal the playback overlay and assert all existing playback buttons are
      reachable and have nonzero bounding boxes: play, mute, PiP, fullscreen,
      and any additional video control buttons already present by the time this
      plan is implemented.
- [x] Assert the document or playback pane does not show horizontal overflow at
      the tested viewport.
- [x] Prefer contract assertions such as reachability, non-overlap,
      no-horizontal-overflow, and minimum target size over exact row/column
      placement, so the test remains useful after music/video layout sharing.
- [x] Run the focused spec:
      `npx playwright test tests/e2e/video-playback-small-layout.integration.spec.js`.

## Phase 8 - Manual Verification Pass

- [ ] Start the local server with a normal remote configuration if available:
      `python dropbox_browser.py --remote dropbox:`.
- [ ] Open the video player at a normal desktop size and confirm the track panel
      sits below the video and above debug info.
- [ ] Collapse and expand track selection and debug info; verify both panels
      have matching behavior and appearance.
- [ ] Select audio and subtitle tracks and confirm the summary updates
      immediately.
- [ ] Resize the browser to a short height and confirm the playback pane scrolls
      vertically to track selection and debug info.
- [ ] Confirm the video area remains usable at the agreed minimum height.
- [ ] Confirm the control overlay remains usable with all buttons reachable.
- [ ] Confirm fullscreen playback still uses the full viewport and its controls
      are not affected by embedded-pane scrolling.

## Phase 9 - Regression Checks

- [ ] Run JS tests if `tracks.js` helpers gain pure exportable behavior:
      `npm run test:js`.
- [x] Run web UI tests after template/CSS changes:
      `python -m tests.run web -v`.
- [ ] Run video endpoint tests only if implementation unexpectedly touches
      endpoint/session/subtitle server behavior:
      `python -m tests.run video -v`.
- [x] Run the focused small-layout e2e:
      `npx playwright test tests/e2e/video-playback-small-layout.integration.spec.js`.
- [x] Run the broader video e2e suite before checkin:
      `npx playwright test --grep video`.
