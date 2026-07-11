# Video Player Full Window Mode Plan

## Goal

Replace picture-in-picture with a **full window** playback mode that fills the
browser viewport (not the monitor). Full window is a CSS layout takeover: hide
the page header and browse area, expand the bottom pane and video playback stage
to use the full browser window, and let normal layout reflow handle window
resize.

Keep native **fullscreen** as a separate monitor-level mode. Add smart
double-click behavior that toggles between embedded playback and the user's last
chosen expanded mode.

Success criteria:

- The PiP button becomes a full-window toggle; PiP API usage is removed.
- Full window hides `header` and `main`, expands `#log-panel` to `100vh`, and
  shows only the playback column (library/queue/track/debug are not reachable
  until the user exits).
- Window resize while in full window keeps the stage filling the viewport
  without manual JS resize logic beyond existing log-height clamping.
- Subtitle overlay sizing in full window matches native fullscreen (full configured
  size, not the embedded 65% scale).
- Double-click contracts:
  - double-click while **embedded** enters the last selected expanded mode
  - double-click while **full window** or **native fullscreen** returns to
    embedded
  - last selected expanded mode defaults to **native fullscreen**
- Expanded-mode preference is **session only** (in-memory); no Settings/localStorage
  persistence across reload.
- Playback/HLS/session behavior is unchanged.

## Current State

- Page layout (`page.html` + `app.css`):
  - `body.has-log-panel` is a `100vh` flex column: `header`, scrollable `main`
    (browse), then resizable `#log-panel` (`--log-panel-height`, default 240px).
- Video player lives inside `#log-panel` as a 3-column grid in
  `video_player.html`: library | queue | playback.
- Embedded stage sizing is controlled in `video.css` via
  `--video-playback-stage-min-height` (180px) and `aspect-ratio: 16 / 9`.
- Native fullscreen uses `requestFullscreen()` on `#video-playback-stage`
  (`controls.js` + `shared.js#fullscreenHostElement`).
- PiP uses `requestPictureInPicture()` on `#video-player-media` (`controls.js`).
- Subtitle scale uses `:fullscreen` vs `:not(:fullscreen)` rules in `video.css`.
- Double-click on `#video-playback-surface` currently always toggles native
  fullscreen (`controls.js`).
- PiP is referenced in transport control ordering tests and web UI contract tests.

## Behavior Contracts

### Full window mode

When active:

- Add a document/body class such as `video-full-window-mode`.
- Hide `header` and `main`.
- Set `--log-panel-height` to `100vh` (or equivalent layout that fills the
  viewport with no header).
- Restructure the video shell to a single playback column:
  - hide library pane, queue pane, playback subpane header, track panel, and
    debug panel
  - playback surface/stage flex-grow to fill available height
  - relax embedded `aspect-ratio` / min-height constraints so the stage uses
    all available space
- Disable bottom-pane manual resize while full window is active.
- Save the pre-entry `--log-panel-height` in memory and restore it on exit.
- Exit full window when:
  - user clicks the full-window toggle again
  - user double-clicks the playback surface
  - bottom pane mode changes away from `video-player`
  - video pane deactivates (`pane.js`)
  - user enters native fullscreen (mutual exclusion)

### Native fullscreen mode

Unchanged in purpose: monitor-level viewing via Fullscreen API on
`#video-playback-stage`.

When user enters native fullscreen manually or via double-click from embedded:

- Exit full window first if it was active.
- Update session expanded-mode preference to `fullscreen`.

When user enters full window manually or via double-click from embedded:

- Exit native fullscreen first if it was active.
- Update session expanded-mode preference to `full-window`.

### Session expanded-mode preference

In-memory only (`ctx.state.preferredExpandedMode` or similar):

- allowed values: `fullscreen` | `full-window`
- default: `fullscreen`
- updated when the user explicitly activates either mode via its toolbar button or
  via double-click from embedded
- not written to `Settings` or `localStorage`

### Double-click behavior

On `#video-playback-surface` double-click (when controls are available and click
is not on the controls overlay):

| Current mode | Action |
|--------------|--------|
| embedded | enter `ctx.state.preferredExpandedMode` (`fullscreen` by default) |
| full window | exit to embedded |
| native fullscreen | exit to embedded |

Entering an expanded mode via double-click must update
`preferredExpandedMode` the same as using the corresponding toolbar button.

### Library / queue access

No in-mode access. User must exit full window (toggle, double-click, or pane
change) to reach library, queue, track panel, or debug panel.

## Non-Negotiable Principles

- Keep playback/HLS/session behavior unchanged; this is layout and transport UI
  work only.
- Do not change `/file`, `/download`, subtitle extraction, or session endpoints.
- Keep controls module-owned in `video/controls.js`; do not add per-control
  listeners to `video.js`.
- Do not hotlink icons. New full-window icons must be vendored under
  `dropbox_browser/assets/icons/material-icon-theme/`.
- Preserve keyboard/accessibility contracts for the new toggle:
  `aria-label`, `title`, disabled state, and icon swap on active/inactive.
- Full window and native fullscreen must remain mutually exclusive.
- Do not persist full-window or expanded-mode preference across page reload.

## Phase 1 - Define Layout And State Contracts

- [x] Add session state fields in `video.js` init state:
      `fullWindowActive` (boolean) and `preferredExpandedMode`
      (`'fullscreen'` default).
- [x] Add `savedLogPanelHeight` (number|null) for restore on full-window exit.
- [x] Document the body class name and which DOM regions are hidden in each mode.
- [x] Decide the exact full-window CSS selector strategy:
      - body class for page-level hiding (`header`, `main`)
      - pane/shell classes for video-internal column hiding
      - stage class or ancestor selector for subtitle full-size parity with
        `:fullscreen`
- [x] Confirm mutual exclusion rules between full window and native fullscreen.

Decisions locked in `docs/video-player.md` ("Playback Layout Modes"):

- Body class: `video-full-window-mode`
- Pane/shell marker: `#video-player-pane.video-full-window` (or shell ancestor)
- Stage/subtitle parity: `.video-playback-stage.video-full-window` (or ancestor)
  matching existing `:fullscreen` subtitle scale rules
- Mutual exclusion: exit the other expanded mode before entering either;
  double-click from expanded always returns to embedded only

## Phase 2 - Replace PiP With Full Window Toggle

- [x] Repurpose `#video-pip-toggle` in `video_player.html`:
      renamed to `#video-full-window-toggle`; labels `Full window` /
      `Exit full window`.
- [x] Add vendored icons:
      `video-full-window-enter.svg`, `video-full-window-exit.svg`.
- [x] Register icon paths in `VIDEO_ICONS` (`constants.js`); removed PiP
      icon constants and unused PiP SVG assets.
- [x] Replace `togglePictureInPicture` with `toggleFullWindowMode` in
      `controls.js` (plus `applyFullWindowLayoutClasses` for body/pane/stage
      class toggles; layout CSS still Phase 3).
- [x] Update `syncTransportControls` to drive the new button from
      `ctx.state.fullWindowActive` instead of `document.pictureInPictureElement`.
- [x] Remove PiP event listeners (`enterpictureinpicture`,
      `leavepictureinpicture`) and PiP availability checks.
- [x] Rename `pipButton` DOM ref to `fullWindowButton` in `video.js`.

## Phase 3 - Full Window Layout CSS

- [x] Add `app.css` rules for `body.video-full-window-mode`:
      hide `header` and `main`; prevent browse scrollbars from affecting layout.
- [x] Add `video.css` rules for full-window shell/stage layout:
      single-column playback-only shell
      hide library/queue/header/track/debug surfaces
      playback pane and surface stretch to available height
      stage drops embedded `aspect-ratio` constraint and grows via flex
- [x] Add subtitle overlay / `::cue` full-size rules for full-window stage,
      matching existing `:fullscreen` typography scale.
- [x] Ensure embedded-mode subtitle 65% scaling does not apply in full window.
- [x] Keep existing `.video-playback-stage:fullscreen` rules unchanged.

## Phase 4 - Height Save/Restore And Resize Integration

- [x] On full-window enter:
      save current computed `--log-panel-height` (`ctx.state.savedLogPanelHeight`)
      force panel height to viewport fill via `DropboxBrowserLogPanel.applyFullWindowHeight`
      disable `#log-resizer` / grip interaction while active
- [x] On full-window exit:
      restore saved height through `DropboxBrowserLogPanel.setVideoFullWindowActive(false)`
      / `applyHeight` in `log.js`
      re-enable pane resizing
- [x] On `window.resize` while full window is active, keep height at viewport
      fill (override normal clamp/restore behavior until exit).
- [x] Ensure `log.js` resize handler does not fight full-window forced height.

## Phase 5 - Lifecycle, Fullscreen Coordination, And Double-Click

- [x] Export small helpers from `controls.js`:
      `enterFullWindow`, `exitFullWindow`, `isFullWindowActive`,
      `enterPreferredExpandedMode`, `exitToEmbeddedPlaybackLayout`
      (plus `enterNativeFullscreen`, `handlePlaybackSurfaceDoubleClick`).
- [x] Update `toggleVideoFullscreen` to exit full window before requesting native
      fullscreen; set `preferredExpandedMode = 'fullscreen'`.
- [x] Update `toggleFullWindowMode` to exit native fullscreen before entering
      full window; set `preferredExpandedMode = 'full-window'`.
- [x] Replace dblclick handler on `#video-playback-surface`:
      embedded -> preferred expanded mode
      full window or native fullscreen -> embedded only
- [x] Extend `videoKeyboardShortcutAllowed` so shortcuts work in full window
      (native fullscreen, full window, or `paneActive`).
- [x] Exit full window from `pane.js` `syncPaneMode` when video pane deactivates.
- [x] Exit full window on `bottom-pane-mode-changed` away from `video-player`
      (via existing `syncPaneMode` path).
- [x] Listen for `fullscreenchange` and treat native fullscreen exit via browser
      UI as return to embedded unless full window was explicitly entered.

## Phase 6 - Tests And Contracts

- [ ] Update `tests/test_web_ui.py`:
      remove PiP icon/function contracts
      add full-window toggle, icons, and `toggleFullWindowMode` expectations
- [ ] Update `tests/js/video-modules.test.js` mock element refs if renamed.
- [ ] Update e2e control-order assertions in:
      `video-subtitle-switch.integration.spec.js`
      `video-playback-small-layout.integration.spec.js`
      replace `video-pip-toggle` with full-window toggle id/label checks
- [ ] Add focused e2e coverage, new file or extend existing video e2e:
      enter full window -> `header`/`main` hidden, stage height ~ viewport
      resize browser window -> stage still fills viewport
      full-window subtitles use full configured size (reuse subtitle layout
      helpers where practical)
      controls remain visible and non-overlapping
      exit via toggle and via double-click restores prior log height and layout
      double-click embedded defaults to native fullscreen
      after using full-window button once, double-click embedded enters full window
      native fullscreen button still works and exits full window first
- [ ] Run targeted groups before checkin:
      `python -m tests.run web -v`
      `npx playwright test --grep video`

## Phase 7 - Docs Touch-Up (Optional)

- [ ] Update `docs/video-player.md` playback-modes section to document full window
      vs native fullscreen and double-click behavior if the doc is being maintained
      for this feature area.

## File Ownership Map

| Concern | Module |
|---------|--------|
| Toggle logic, dblclick, transport button state | `dropbox_browser/assets/js/video/controls.js` |
| Pane deactivate cleanup | `dropbox_browser/assets/js/video/pane.js` |
| DOM refs and session state defaults | `dropbox_browser/assets/js/video.js` |
| Icons | `dropbox_browser/assets/js/video/constants.js` |
| Page-level hide/show | `dropbox_browser/assets/app.css` |
| Video shell/stage/subtitle layout | `dropbox_browser/assets/css/video.css` |
| Log panel height save/restore hooks | `dropbox_browser/assets/js/log.js` (minimal) |
| Button markup | `dropbox_browser/assets/templates/video_player.html` |
| UI contract tests | `tests/test_web_ui.py` |
| Browser layout e2e | `tests/e2e/video-*.integration.spec.js` |

## Risks And Edge Cases

- **Log height restore**: if the user never resized the pane, restore the height
  that was active at entry, not a hardcoded default.
- **Pane mode switch while expanded**: must always land in a sane embedded layout
  for the newly selected pane; do not leave `body.video-full-window-mode` applied.
- **Native fullscreen + full window**: never allow both; always exit one before
  entering the other.
- **Double-click during loading/restart**: preserve existing guard that ignores
  clicks on `#video-controls-overlay`; respect `videoControlsAvailable()`.
- **Small viewport controls**: existing `@media (max-width: 520px)` control wrapping
  should continue to work in full window; verify in e2e rather than adding new
  layout systems.

## Estimated Effort

Moderate: roughly half a day to one day including e2e updates. No server changes.