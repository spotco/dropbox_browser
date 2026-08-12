# Shared Active Playlist Virtualization and Memory Plan

Date: 2026-08-12  
Status: Shared virtualization and row recycling implemented; validation complete
Scope: one implementation day

## Implemented next step

Implemented a shared, adapter-driven row recycler on top of the existing
virtual-window math. The generic core owns bounded row pools, source-index
assignment, scroll scheduling, measurement, and lifecycle cleanup. Music/video
playlists and the file-browser table supply separate row adapters, preserving
their existing DOM contracts. The non-virtualized small-list paths and E2E
selectors remain unchanged.

The file-browser recycler also refreshes the scrollbar preview when the scroll
position changes without changing the mounted window, which matters for short
filtered virtual lists.

## Objective

Reduce the browser memory and DOM cost of large active playlists while
preserving the existing shared playlist behavior for both the music and video
players. The active playlist is currently rendered as one DOM row per song and
each row receives its own event listeners. The recent measurement exposed this
as the main player-side memory hotspot at roughly 1,230 active rows.

Virtualization will remain a DOM/rendering concern only. The complete playlist
array, selection map, saved-playlist format, playback queue, shuffle state, and
video bridge will remain unchanged.

## Decisions already resolved

No product decision is blocking implementation. Use these defaults and tune
only if the acceptance measurements show a problem:

1. Virtualize only the active playlist (`#music-playlist-list` and
   `#video-playlist-list`). Do not virtualize the library tree or the load/recent
   modal lists in this pass. The active list is the measured hotspot; the modal
   lists are bounded and have separate selectors and behavior.
2. Keep the existing full-render path for fewer than 100 songs. At 100 or more,
   render only the visible rows plus 12 rows of overscan on each side. This
   keeps all current integration fixtures and their exact row-count/name
   assertions on the existing path.
3. Reuse the existing generic range calculations in
   `assets/js/browse/virtual-list.js`; do not create a second virtual-list math
   implementation. Playlist-specific index, focus, and drag calculations stay
   in the shared media-library playlist module.
4. Use a measured fixed row height. Current playlist rows are single-line,
   ellipsized rows, so variable-height virtualization is unnecessary. Start
   with a 30px fallback, measure the first mounted row, and recompute the
   window if the measured height differs.
5. Preserve the current DOM contract: the list IDs, `.music-playlist-entry`,
   `.music-playlist-filename-cell`, `.music-playlist-drag-handle`,
   `data-remote-path`, current/selected classes, row roles, and list tabindex
   remain available. Existing small-playlist E2Es should not need selector or
   fixture changes.
6. Use one delegated event set on the active list instead of closures on every
   row. This is both a memory reduction and a safer requirement for a bounded
   virtual DOM. The existing row actions and drag suppression behavior must be
   retained.

## Implementation sequence

### 1. Add shared virtualization state and rendering

Modify `dropbox_browser/assets/js/media-library/playlist.js`:

- Add a private `playlistVirtual` state object containing `enabled`, threshold,
  overscan, row height, measurement state, current window key, and a pending
  animation-frame handle.
- In `paintPlaylist()`, keep the existing empty and small-list branches. For a
  large playlist, calculate the visible range from the list's `scrollTop`,
  `clientHeight`, measured row height, and `computeVirtualWindow()`.
- Render only that range. Use a bounded inner content element/spacer with the
  full playlist height and position the mounted rows at their source indexes.
  The scrollable element must remain the existing playlist list element so
  column sizing, keyboard focus, scrollbar behavior, and drag auto-scroll are
  unchanged.
- Keep the existing row construction function, but pass the source index into
  it so each mounted row has a stable `data-playlist-index` in addition to its
  existing remote/stream path data. Keep the row's 1-based display index.
- On list scroll, schedule at most one `requestAnimationFrame` render and
  replace only the bounded mounted window. Add a guarded `ResizeObserver` or
  equivalent refresh hook so the first render after opening/restoring a pane
  gets a real viewport height rather than a zero-height measurement.
- Set diagnostic datasets on the list, such as total playlist count,
  virtualization enabled, and visible start/end indexes. These make the E2E
  and memory checks verifiable without exposing private application state.

The implementation must not copy the full song objects into a second rendered
array. The full `state.playlist` remains the source of truth and only the
currently mounted DOM rows are materialized.

### 2. Delegate active-playlist events

Still in `playlist.js`, attach the active-list handlers once during
`initPlaylist()` and route events through the nearest mounted row:

- `click`: preserve selection, drag-handle click suppression, and list focus.
- `dblclick`: preserve play-by-row behavior.
- `contextmenu`: preserve the existing selected-row/context-menu behavior.
- `pointerdown` on `.music-playlist-drag-handle`: preserve multi-row drag
  initiation, pointer identity, and window-level move/up listeners.

Remove per-row listener creation from the large-list row path. It is acceptable
to use the same delegated handlers for the small-list path if that makes the
code simpler, but the existing small-list behavior and tests must remain
unchanged.

Update helpers that currently assume every playlist row is mounted:

- `paintPlaylistSelection()` should paint only mounted rows while retaining the
  complete selection map and selection count dataset.
- `playlistRows()` should mean mounted rows; callers must not use its length as
  the playlist length.
- Current/selected/drag-source classes must be applied whenever a row enters
  the mounted window.

### 3. Make focus and drag virtualization-aware

Keep the existing public playlist API names so music and video adapters need no
new host-specific code.

- `focusPlaylistRemotePath()` should find the source index from the full
  playlist, scroll the target index into view when virtualized, render the
  target window synchronously or on the next animation frame, then apply the
  existing focus/scroll behavior to the mounted row.
- Selection range calculations must continue to use full playlist order, not
  only mounted rows. Ctrl/Cmd+A must still select every song.
- For virtualized drag/drop, calculate the target index from list bounds,
  `scrollTop`, and row height rather than searching all DOM rows. Use the
  pointer's position within the target row to retain before/after semantics.
- Keep the existing DOM-rect calculation for the small-list path to minimize
  regression risk.
- The drag indicator must be positioned against the virtual content coordinate
  and remain visible while auto-scroll causes the window to rerender. Hidden
  dragged rows do not need a DOM class; the full selected-path map remains the
  source of truth for the reorder operation.
- After reorder, add, remove, sort, or load, invalidate the virtual window key,
  render the new range, preserve the existing anchor/current index adjustment,
  and restore focus through `focusPlaylistRemotePath()`.

### 4. Add shared CSS without changing the external layout

Modify `dropbox_browser/assets/css/media-library.css`:

- Keep `.music-playlist-list` as the flexing, scrolling, focusable viewport.
- Add styles for the virtual content/spacer and absolutely positioned mounted
  rows, with the existing grid columns and ellipsis rules unchanged.
- Set the measured row height through a CSS custom property or inline height
  only for the virtual path. The full-render path keeps its current natural
  sizing.
- Keep the header outside the virtual content and preserve the current drag
  indicator, selected, current, hover, scrollbar, and responsive rules.
- Confirm both the music and video panes inherit the same shared styles; no
  player-specific CSS fork should be introduced.

No template changes should be required. If an inner mount element is useful,
create it lazily from the shared playlist renderer so the existing template
IDs and role structure remain stable.

### 5. Test the shared behavior and protect existing E2Es

Add focused JavaScript coverage:

- Extend the existing virtual-list tests for the playlist configuration:
  threshold behavior, range/spacer math, empty and exact-boundary cases, and
  index-to-scroll/focus mapping.
- Extend `tests/js/music-playlist.test.js` with a large fake playlist that
  verifies only a bounded mounted slice exists, source indexes/data paths are
  correct after scrolling, selection/current state is painted for mounted rows,
  and reorder/remove invalidates and refreshes the window.
- Exercise the same shared initializer with `mediaKind: "video"` in one
  shared-module test so the video host is covered without starting HLS.
- Add or update layout assertions only where needed to ensure the virtual
  viewport remains compatible with persisted column widths.

Run the existing suites without rewriting their selectors:

```text
npm run test:js
npm run test:e2e:music
npm run test:e2e:video
```

Existing small-list assertions such as exact `.music-playlist-entry` counts,
filename queries, drag-handle counts, context-menu dispatch, current-row
queries, and Ctrl/Cmd+A should remain unchanged. The current video helpers that
look for `.music-playlist-entry.current` should likewise continue to work.

Add one large-list browser smoke only if the fixture can seed a deterministic
100+ entry playlist without changing the existing fixture expectations. It
should assert that the list reports the full count while the DOM row count is
bounded, scrolls to a late entry, plays/focuses it, and preserves selection.
If fixture seeding would make the existing serial E2Es materially slower, keep
this as the focused JS DOM test and use the memory harness for browser-level
validation instead.

### 6. Measure the result against the existing baseline

Reuse `tools/measure_browser_memory.js` and keep all generated output under
`Temp/` (already disposable/ignored). Capture the same normal-browser and
music-player scenarios before and after the change, then add the video-player
scenario if the existing harness can open its pane.

Record for each scenario:

- total browser and renderer process memory;
- JS heap used/total where available;
- active playlist total count versus mounted row count;
- number of drag handles/listeners if observable through the diagnostic hook;
- memory after initial load, after scrolling near the end, and after returning
  to the top;
- whether memory returns or stabilizes after the playlist is cleared and the
  pane is closed.

Acceptance targets:

- A 1,230-entry playlist mounts only the viewport plus overscan, not 1,230
  `.music-playlist-entry` nodes.
- Music and video use identical virtualization thresholds and bounded row
  behavior through shared code.
- Existing small-playlist E2Es pass without selector/fixture rewrites.
- Scrolling, selection, context actions, reorder, playback/current-row state,
  saved playlists, import/export, and video queue bridging retain behavior.
- No sustained per-scroll growth is visible in the browser snapshot; the
  mounted-row count stays bounded as the window moves.

## Expected implementation files

- `dropbox_browser/assets/js/browse/virtual-list.js`
- `dropbox_browser/assets/js/browse/main.js`
- `dropbox_browser/assets/js/browse/render.js`
- `dropbox_browser/assets/js/media-library/playlist.js`
- `dropbox_browser/assets/css/media-library.css`
- `tests/js/music-playlist.test.js`
- `tests/js/browse-virtual-list.test.js` or a focused shared playlist virtual
  test file
- Optionally one focused music/video E2E or a test-fixture helper, only if it
  does not disturb the current small-playlist contract
- `tools/measure_browser_memory.js` only if a video scenario or new diagnostic
  field is needed; measurement output stays under `Temp/`

## Definition of done for today

The shared renderer has a small-list compatibility path, the virtual path is
bounded and virtualization-aware for selection/focus/drag, JS tests cover the
recycler, and the existing client-render, music, and video E2E suites pass.
The implementation retains the existing 100-row threshold and 12-row overscan
defaults from the prior virtualization step.

## Validation completed

- `npm run test:js`: 342 passing tests.
- Client-render E2E suite: 35 passing tests, run serially after isolating the
  local rclone test configuration.
- Music E2E suite: 10 passing tests in the distributed run.
- Video E2E suite: 47 passing tests in the distributed run.
