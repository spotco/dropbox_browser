# Plan: Shared Music and Video Playback Recents

Date: 2026-07-18
Branch: `dev-ui-fixes`

## Scope

Add a shared, browser-persisted **Recent** menu to the active-playlist top bar
for both music and video. It records the latest 100 playback starts separately
per media kind, presents them in a large selectable modal, and restores the
corresponding saved playlist or a one-item fallback playlist.

## Confirmed behavior decisions

- Music and video have independent recent-history stores and UI state.
- A history record captures a cloned playlist item (including its display name
  and file paths), the source active-playlist name, and the time playback was
  started.
- Retain at most 100 records. Collapse only an immediately preceding record
  with the same normalized file path **and** source playlist name; update that
  record's played timestamp. Repeated `A, B, A` plays remain three records.
- The same file played consecutively from different playlists remains separate
  entries, because each entry must retain its actual playlist source.
- The Recent modal opens with date/time sorted newest first. Its Date/Time,
  File Name, and Playlist Name column controls toggle sort direction using the
  existing saved-playlist dialog conventions.
- Every row shows the file name, source playlist name, full file path as a
  subordinate smaller line, and played time in a non-overlapping responsive
  layout.
- Selecting a row and choosing **OK** restores the currently persisted playlist
  with the recorded playlist name, then selects and plays the recorded file
  when it exists in that playlist.
- If no persisted playlist has that name, replace the active playlist with a
  new one-item playlist containing the recorded item and play it.
- If the named persisted playlist exists but no longer contains the recorded
  item, load that playlist, leave playback stopped, and report the outcome in
  the existing status surface. Do not silently add the item or overwrite the
  saved playlist.

## Implementation checklist

### Phase 0 — Lock the shared behavior with focused tests

- [ ] Add pure JavaScript coverage for a shared recent-history model: record
  serialization/deserialization, path-and-playlist-aware consecutive collapse,
  alternating replay retention, 100-item eviction, invalid-storage recovery,
  and separate music/video storage keys.
- [ ] Add pure tests for the recent sort helpers: default played-time descending,
  deterministic file/playlist sorting, direction toggles, and stable tie
  behavior.
- [ ] Add shared-playlist controller tests for restoration decisions: saved
  playlist plus present item plays that item; missing saved playlist creates and
  plays a one-item playlist; saved playlist with a missing item loads without
  starting playback.
- [ ] Extend the music Playwright coverage to record plays, reopen the modal
  after reload, check row content/default order/sorting, and exercise all three
  restoration outcomes.
- [ ] Add the equivalent shallow video browser coverage, including history
  separation from music and the video bridge's playback transition.

### Phase 1 — Create the shared persisted recent-history contract

- [ ] Add a focused module under `dropbox_browser/assets/js/media-library/`
  (for example, `recent-store.js`) that owns normalization, clone-safe recent
  records, bounded insertion, consecutive duplicate handling, sorting, and
  Settings/local-storage persistence.
- [ ] Derive namespaced persistence keys from the host media kind so music and
  video never read or mutate each other's recent records. Keep the record
  schema versioned or safely normalizable so malformed/older browser state is
  ignored without breaking player startup.
- [ ] Normalize comparison paths using the playlist's existing absolute-path
  semantics rather than raw display text. Preserve the original item fields for
  display and fallback-playlist reconstruction.
- [ ] Record the current active playlist name at the instant playback is
  selected, including an unsaved name. Later restoration still looks only for a
  persisted playlist with that name, as confirmed above.
- [ ] Expose a narrow `ctx.recentApi` contract for recording, listing/sorting,
  modal selection, and restoration; avoid embedding music- or video-only
  playback details in the shared storage module.

### Phase 2 — Capture real playback starts from both player paths

- [ ] Wire the music playback controller to record an entry exactly when a
  playlist item becomes the chosen playback target, covering row/context play,
  transport next/previous, queue end advance, loop, and shuffle without
  recording passive selection or failed index lookups.
- [ ] Wire the video media-library bridge to the same shared recording point
  before it requests the active item's HLS playback, covering playlist rows,
  controls, shuffle, loop, and automatic advance.
- [ ] Ensure re-rendering, pane activation, retries, buffering callbacks, and
  HLS session restarts do not create artificial extra recent entries for the
  same user/queue playback choice.
- [ ] Keep persistence entirely client-side and dependency-free; this feature
  needs no Dropbox calls, server route, or background-worker state.

### Phase 3 — Add the shared Recent modal and controls

- [ ] Add a **Recent** button before Import and Export in the active-playlist
  top bar of `music_player.html` and `video_player.html`, with stable,
  host-prefixed IDs, accessible labels, and matching controls grouping.
- [ ] Add a larger shared modal structure modelled on the saved-playlist Load
  dialog: heading, sortable Date/Time, File Name, and Playlist Name headers, a
  scrollable single-select rowgroup, and bottom-right Cancel/OK actions.
- [ ] Give each row a clean primary/secondary layout: file name and playlist
  name in the main grid, file path on a smaller line beneath the file name, and
  a right-aligned played time. Selectable rows must expose correct role and
  `aria-selected` state.
- [ ] Extend `media-library.css` with modal/table grid rules sized for recents:
  useful desktop width/height, viewport-safe maximums, scroll containment,
  minmax columns, long-path wrapping or truncation that never overlaps adjacent
  data, and a compact small-window layout that preserves all fields.
- [ ] Reuse the existing modal visibility, focus, Escape, Enter, click, and
  selected-row patterns from `playlist.js`; the new modal's Cancel/OK behavior
  must not interfere with the Load, Rename, or overwrite dialogs.
- [ ] Render an explicit empty state and disable OK when no recent record is
  selectable. On opening, select the first visible (newest) record by default.
- [ ] Persist recent-modal sort choice separately for music and video if the
  existing playlist-load UI convention persists sort state; otherwise keep it
  session-local deliberately and document that choice in the implementation.

### Phase 4 — Restore playlists through the shared playlist controller

- [ ] Add a shared `playlist.js` action that accepts a recent record, closes
  the modal, looks up the recorded playlist name in `PlaylistStore`, and uses
  the existing playlist replacement/render/dirty-state paths.
- [ ] When the saved playlist exists and contains the item's normalized path,
  load it and invoke the host playback API for that path so the selected item
  becomes current and starts playback.
- [ ] When no saved playlist exists, create a fresh `PlaylistModel` using the
  normal default new-playlist name and the cloned recorded item, synchronize it
  through the normal active-playlist state path, then play that item. Do not
  persist this fallback automatically.
- [ ] When the saved playlist exists but lacks the recorded path, load it,
  clear or retain no active playback according to the existing safe load
  behavior, and do not call a play API. Provide a concise status explaining
  that the playlist was loaded but the historical file is no longer in it.
- [ ] Ensure the host-neutral controller relies only on the existing shared
  `ctx.playbackApi` methods, so music's native audio and video's HLS bridge
  receive equivalent restore requests.

### Phase 5 — Templates, contracts, and documentation

- [ ] Update `music.js` and `video.js` context construction with the new
  host-prefixed Recent elements and media-kind persistence configuration.
- [ ] Update media-library initialization order/imports so the recent store is
  available before playback callbacks can record an item, while retaining the
  documented music/video module boundaries.
- [ ] Extend `tests/test_web_ui.py` shell and asset contracts for both Recent
  buttons, modal IDs, sort headers, and the shared JavaScript/CSS references.
- [ ] Update `docs/architecture.md` to identify shared recent persistence and
  modal/restoration ownership under `assets/js/media-library/`.
- [ ] Update `docs/video-player.md` with the video bridge's role in emitting
  shared recent-history playback events and the independent video history key.
- [ ] Update `docs/testing.md` only if a new focused command/test group is
  introduced; otherwise preserve the present JS/music/video test guidance.

### Phase 6 — Complete unit and browser coverage

#### Shared recent-history unit coverage

- [ ] Cover record normalization and round-trip persistence for all playlist
  item fields required for display and one-item fallback reconstruction.
- [ ] Cover music/video namespace separation, empty/malformed/stale persisted
  values, and schema normalization without player-startup failures.
- [ ] Cover chronological insertion, newest-first default display order, exact
  100-record retention, and oldest-record eviction at the limit.
- [ ] Cover consecutive-play collapse only for matching normalized path and
  playlist name, including timestamp replacement; cover that different
  playlists, alternating paths, and non-consecutive repeats stay distinct.
- [ ] Cover Date/Time, File Name, and Playlist Name comparators in both
  directions, including deterministic ties and sort-toggle state.

#### Shared playlist-controller unit coverage

- [ ] Cover recent selection state, first-row default selection, empty-state
  behavior, disabled OK state, Cancel, Enter-to-confirm, and Escape-to-close
  behavior through testable shared controller helpers where practical.
- [ ] Cover restoration when the named saved playlist contains the historical
  item: active playlist replacement, correct selected/current index, and one
  host playback request for that item.
- [ ] Cover restoration when no saved playlist matches the recorded name:
  one-item active playlist construction from the cloned history record, no
  automatic persistence, and playback of that item.
- [ ] Cover restoration when a saved playlist exists but no longer contains the
  file: load the saved playlist, make no playback request, do not add or save
  the historical file, and issue the expected status message.

#### Music and video browser E2E coverage

- [ ] In music E2E, exercise recording through direct row/context playback,
  transport next/previous, automatic advance, loop, and shuffle; verify retry,
  pause/resume, and UI repaint paths do not add false records.
- [ ] In video E2E, exercise direct playlist playback plus next/previous and
  automatic queue advance through the HLS bridge; verify HLS buffering/session
  restart paths do not create false records.
- [ ] In each player, verify that the Recent button is positioned before Import
  and Export, opens the modal, restores persisted history after reload, renders
  every required field, supports all sort controls, and keeps the selected row
  and buttons keyboard-accessible.
- [ ] In each player, verify all three OK restoration paths end to end: saved
  playlist with item starts that item; missing playlist becomes/plays a new
  one-item playlist; existing playlist without the item loads without playing.
- [ ] In cross-player coverage, seed both stores and prove music recents never
  appear in video (and vice versa), including after page reload.
- [ ] Add viewport coverage for the large modal at desktop and narrow widths to
  assert long file names/paths, playlist names, and timestamps remain visible
  or intentionally truncated/wrapped without overlapping controls or rows.

### Phase 7 — Verification and handoff

- [ ] Run the new focused Node tests first, then `npm run test:js`.
- [ ] Run `python -m tests.run web -v` after template, CSS, and asset-contract
  changes.
- [ ] Run `npm run test:e2e:music` for the primary shared UI and restoration
  coverage, then `npm run test:e2e:video` for the HLS bridge integration.
- [ ] Manually verify both players at narrow and wide widths: path/time/name
  columns remain legible without overlap, keyboard selection works, and
  Cancel/OK return focus appropriately.
- [ ] Before handoff, run `python -m unittest discover -s tests -v` and
  `npm run test:e2e`, because the change is shared across both player UIs and
  persisted client state.

## File map

| Area | Primary files |
| --- | --- |
| Shared history model and sort helpers | New `assets/js/media-library/recent-store.js` (or similarly focused module) |
| Shared recent modal and playlist restoration | `assets/js/media-library/playlist.js` |
| Shared playlist state/path semantics | `assets/js/media-library/playlist-store.js` |
| Music playback capture | `assets/js/music/playback.js`, `assets/js/music.js` |
| Video playback capture | `assets/js/video/media-library-bridge.js`, `assets/js/video.js` |
| Music/video markup | `assets/templates/music_player.html`, `assets/templates/video_player.html` |
| Shared responsive styling | `assets/css/media-library.css` |
| Tests | `tests/js/`, `tests/e2e/music-player.integration.spec.js`, video playlist/player specs, `tests/test_web_ui.py` |
| Documentation | `docs/architecture.md`, `docs/video-player.md`, optionally `docs/testing.md` |

## Progress

- [ ] Phase 0 — Focused regression coverage
- [ ] Phase 1 — Shared persisted recent-history contract
- [ ] Phase 2 — Playback-start capture
- [ ] Phase 3 — Recent modal and responsive layout
- [ ] Phase 4 — Playlist restoration
- [ ] Phase 5 — Contracts and documentation
- [ ] Phase 6 — Complete unit and browser coverage
- [ ] Phase 7 — Verification and handoff
