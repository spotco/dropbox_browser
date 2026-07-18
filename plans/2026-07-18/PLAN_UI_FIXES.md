# Plan: Miscellaneous UI Fixes — Bottom Panel and Media Library

Date: 2026-07-18  
Branch: `dev-ui-fixes`

## Scope

Implement the requested bottom-panel controls and full-page resizing, make the
shared playlist UI media-aware for music and video hosts, and make `Escape`
leave the video player's CSS full-window mode.

## Confirmed behavior decisions

- “Full screen” in the bottom-panel toolbar means a CSS full-page panel that
  fills the browser viewport; it does not invoke the browser Fullscreen API.
- Dragging the panel up to its viewport limit enters that same shared
  full-page state. Normal intermediate drag heights continue to persist as the
  normal bottom-panel height; the temporary full-page state does not.
- “Minimize” means restore the bottom panel to its existing minimum visible
  height, retaining the panel toolbar and selected mode rather than closing the
  panel.
- The video player keeps its focused playback-only full-window layout (hide
  library, playlist, tracks, and debug). It must use the shared bottom-panel
  full-page controller for shell sizing/chrome, not own a second height lock.
- A generic bottom-panel expansion keeps non-video pane content intact. When
  the active pane is video, the video control path additionally enables its
  established focused playback layout.
- Playlist persistence and import/export JSON keep their existing `songs`
  data field for backward compatibility. “Songs” versus “Videos” is display
  metadata only.
- Use `dropbox_browser_music_playlists.json` and
  `dropbox_browser_videos_playlists.json` as the new download filenames.

## Implementation checklist

### Phase 0 — Add focused regression coverage first

- [x] Record the current baseline with `npm run test:js`,
  `python -m tests.run web -v`, and the affected music/video Playwright suites.
- [ ] Add or extend a Playwright bottom-panel test to cover: drag the panel to
  the viewport limit, verify page chrome is hidden and the panel fills the
  viewport, use the topbar minimize control, and verify the normal page shell
  and minimum-height panel return.
- [ ] Extend the existing video full-window browser coverage to press `Escape`
  in CSS full-window mode and assert the generic shell state and video-specific
  classes both clear, while native fullscreen behavior remains unchanged.
- [ ] Add focused JavaScript tests for a media-kind presentation helper,
  including music/video singular and plural count labels, `Load Playlist:`
  labels, and the two export filenames.
- [ ] Extend music and video playlist browser tests to assert the displayed
  saved-playlist count noun, load labels, and download `suggestedFilename` for
  each host.

### Phase 1 — Centralize bottom-panel full-page state in `log.js`

- [x] Refactor `dropbox_browser/assets/js/log.js` so its full-page state is
  generic bottom-panel state rather than `videoFullWindowActive` state. Keep
  one owner for saved height, resize enablement, viewport-height application,
  restoration, and resize-window handling.
- [x] Replace the video-named public API with explicit generic operations such
  as enter/exit/toggle full-page mode, minimize, current-height access, and
  full-page-state access. Provide an intentional transition/event contract so
  video code can synchronize its playback-only classes when a generic toolbar
  action exits or minimizes the panel.
- [x] Preserve current resize behavior between the minimum and normal maximum.
  When an upward drag reaches the viewport boundary, transition through the
  same generic full-page entry path used by the toolbar; do not persist a
  viewport-height value as the normal `log-height` setting.
- [x] Ensure leaving full-page mode restores the saved pre-expansion height.
  Ensure minimizing explicitly exits full-page mode first, then applies and
  persists the existing minimum panel height.
- [x] Keep resize interactions disabled while full-page mode is active, prevent
  stale pointer listeners from changing state after that transition, and keep
  viewport resizing locked to the current viewport height until exit.
- [x] Update `app.css` from the video-specific shell selector to a generic
  bottom-panel full-page selector: hide `header`, `main`, and the browse
  horizontal scrollbar; make `#log-panel` fill the viewport; and preserve the
  existing flex/overflow constraints. Retain video-only selectors solely for
  the focused playback layout.

### Phase 2 — Add bottom-panel topbar controls and connect video

- [ ] Update `assets/templates/page.html` with right-aligned, accessible icon
  buttons in `#log-toolbar` for expand-to-full-page and minimize. Add stable
  element IDs, titles/ARIA labels, pressed/disabled state where appropriate,
  and a toolbar group that does not disturb the pane selector or status text.
- [ ] Reuse appropriate vendored Material Icon Theme SVGs (or add matching
  vendored assets if required); never reference externally hosted icons.
- [ ] Add toolbar CSS in `app.css` for a compact right-aligned control group,
  visible focus treatment, and reliable small-window layout without clipping
  the pane selector/status area.
- [ ] Wire the buttons in `log.js`: expand immediately enters the generic
  full-page path, and minimize immediately leaves it and sets minimum height.
  Synchronize labels/icons/state after drag, mode changes, toolbar actions,
  and window resize.
- [ ] Refactor `assets/js/video/controls.js` to delegate page chrome and
  bottom-panel height ownership to the generic API. Keep only video-specific
  state/classes there: focused playback shell, playback-stage sizing, native
  fullscreen mutual exclusion, and restoring shared library grid columns.
- [ ] Make the video full-window control enter the generic panel full-page
  state plus the focused video layout. When a generic minimize/exit action
  occurs while video is active, clear the focused video classes and restore its
  grid exactly once, avoiding recursive shell transitions or stale saved
  heights.
- [ ] Preserve existing video cleanup paths in `video/pane.js`: switching away
  from the video pane, deactivating it, and entering native fullscreen must
  reliably leave CSS full-window mode without affecting browser native
  fullscreen semantics.
- [ ] Update `handleVideoKeyboardShortcut()` so `Escape`, when the video pane
  is in CSS full-window mode and focus is not an editable field, prevents the
  shortcut default and calls the existing asynchronous full-window exit path.
  Do not intercept `Escape` for text inputs/dialogs or replace browser-native
  fullscreen exit behavior.

### Phase 3 — Introduce one shared media-kind presentation contract

- [ ] Add a small pure shared module under
  `assets/js/media-library/` that maps a host-supplied media kind (`music` or
  `videos`) to all user-facing playlist presentation details: singular/plural
  item nouns, title-cased `Songs`/`Videos` label, and export filename.
- [ ] Replace duplicated host-specific playlist display values in
  `assets/js/music.js` and `assets/js/video.js` with the one media-kind input
  passed through `ctx.mediaLibraryConfig`. Continue exposing existing library
  wording through that derived presentation so library status strings remain
  correct.
- [ ] Update `assets/js/media-library/playlist.js` to consume that contract for
  the right-side saved-playlist item count, including correct singular/plural
  grammar (`1 song`, `2 songs`, `1 video`, `2 videos`). Do not rename the
  persisted `playlist.songs` field.
- [ ] Drive both the playlist load action and dialog heading from the same
  presentation value: `Load Playlist: Songs` for music and
  `Load Playlist: Videos` for video. Add the necessary title/button element
  references in each host context and update the shared UI at initialization.
- [ ] Replace the hard-coded export name in `playlist.js` with the media-kind
  export filename, resulting in distinct music and video downloads while
  retaining the existing JSON schema and import behavior.

### Phase 4 — Templates, contracts, and documentation

- [ ] Update `assets/templates/music_player.html` and
  `assets/templates/video_player.html` only where needed to supply stable load
  button/dialog-title hooks; leave the shared modal/table structure intact.
- [ ] Update `tests/test_web_ui.py` shell, asset, playlist, and full-window
  string contracts for the generic bottom-panel selector/API, the new topbar
  controls/icons, and media-aware load labels.
- [ ] Update `docs/architecture.md` to document generic bottom-panel ownership
  in `log.js` and the media-library host presentation contract.
- [ ] Update `docs/video-player.md` to distinguish shared full-page panel
  ownership from video’s playback-only full-window styling, and document
  `Escape` as an exit path for CSS full-window mode.
- [ ] Update `docs/testing.md` only if the added bottom-panel/media-kind tests
  introduce a new command or test grouping; otherwise keep the existing suite
  guidance unchanged.

### Phase 5 — Verification and handoff

- [ ] Run the focused new/changed JavaScript tests, then `npm run test:js`.
- [ ] Run `python -m tests.run web -v` and the focused video group after the
  template/asset and full-window changes.
- [ ] Run `npm run test:e2e:music` for shared playlist changes and
  `npm run test:e2e:video` for full-window/`Escape` changes.
- [ ] Run the relevant client-render Playwright spec containing the bottom
  panel toolbar/drag coverage.
- [ ] Before handoff, run `python -m unittest discover -s tests -v` and the
  complete browser suite (`npm run test:e2e`) because these changes cross the
  shared panel shell, music, video, and browse horizontal-scroll behavior.
- [ ] Manually verify that the topbar expand/minimize controls are reachable at
  narrow widths, dragging stops at full-page mode, music remains a complete
  library/playlist/player panel when expanded, and video retains its
  playback-focused full-window behavior.

## File map

| Area | Primary files |
| --- | --- |
| Generic bottom-panel state and drag behavior | `assets/js/log.js`, `assets/app.css` |
| Topbar controls | `assets/templates/page.html`, `assets/js/log.js`, `assets/app.css` |
| Video full-window adapter and Escape | `assets/js/video/controls.js`, `assets/js/video/pane.js`, `assets/css/video.css` |
| Shared media kind and playlist labels/export | `assets/js/media-library/playlist.js`, new `assets/js/media-library/*` helper, `assets/js/music.js`, `assets/js/video.js` |
| Player markup | `assets/templates/music_player.html`, `assets/templates/video_player.html` |
| Regression coverage | `tests/js/`, `tests/e2e/`, `tests/test_web_ui.py` |

## Progress

- [x] Phase 0 — Focused regression coverage (baseline complete; behavior tests
  continue with their implementation phases)
- [x] Phase 1 — Generic bottom-panel full-page controller
- [ ] Phase 2 — Topbar controls and video integration
- [ ] Phase 3 — Shared media-kind playlist presentation
- [ ] Phase 4 — Template contracts and documentation
- [ ] Phase 5 — Full verification and handoff
