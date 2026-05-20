# Music Player Implementation Plan

This plan tracks sequential implementation tasks for the bottom-pane music
player. Design details are summarized in `DESIGN_MUSICPLAYER.md`.

## Progress

- [x] Read `docs/architecture.md`, `docs/background-workers.md`, and
  `docs/testing.md`.
- [x] Inspect current bottom-pane, asset, streaming, and cache integration
  points.
- [x] Write `DESIGN_MUSICPLAYER.md`.
- [x] Write this implementation plan.
- [x] Implement server endpoint module.
- [ ] Implement client UI and playback behavior.
- [ ] Add focused tests.
- [ ] Run targeted checks.

## Step 1 - Server Endpoint Skeleton

- [x] Add `dropbox_browser/music.py`.
- [x] Define supported audio extensions: `.mp3`, `.m4a`, `.aac`, `.wav`.
- [x] Add a small dispatcher for `/music/endpoints/*` paths.
- [x] Register that dispatcher from `dropbox_browser/handlers.py` with a minimal
  route check.
- [x] Return `404` for unknown music endpoint paths.
- [x] Return JSON using the same response conventions as existing JSON routes.
- [x] Add initial tests proving the route is registered and unknown music
  endpoints return `404`.

## Step 2 - Cached Library Builder

- [x] Implement `GET /music/endpoints/library?path=<rel-path>`.
- [x] Validate `path` with `clean_rel_path()`.
- [x] Build absolute root remote path with `remote_target(app.remote, rel_path)`.
- [x] Traverse cached direct listings from `app.listing_cache.get(remote_path)`
  only.
- [x] Do not call `app.list_entries()`.
- [x] Do not call `rclone`.
- [x] Do not call `folder_cache.request()`.
- [x] Stop traversal at folders whose direct listing is not currently cached.
- [x] Include only supported song extensions case-insensitively.
- [x] Return folder nodes with stable IDs, parent IDs, absolute remote paths,
  and root-relative display paths.
- [x] Return song nodes with stable IDs, parent IDs, absolute remote paths,
  `/file` stream paths, root-relative display paths, filename, extension, size,
  and mtime when available.
- [x] Return status metadata that distinguishes complete, partial/updating, and
  unavailable cache state.
- [x] Add endpoint tests for cached-only traversal, extension filtering, stable
  IDs, relative paths, and no fake-rclone calls.

## Step 3 - Music Pane Markup

- [x] Replace `dropbox_browser/assets/templates/music_player.html` stub with
  three semantic sub-panes:
  - folder song library;
  - active playlist;
  - playback controls.
- [x] Add a manual library-load button.
- [x] Add a library status area.
- [x] Add empty states for the library and playlist.
- [x] Add a playlist future-controls placeholder for naming/saving/loading.
- [x] Add playback controls markup:
  - art placeholder;
  - current filename;
  - previous;
  - play;
  - pause;
  - next;
  - shuffle/order toggle;
  - loop playlist toggle;
  - audio element if using markup rather than a constructed `Audio` object.
- [x] Keep existing page-template integration minimal.
- [x] Update web UI tests for the required pane structure.

## Step 4 - Responsive Music Pane Styling

- [x] Replace `dropbox_browser/assets/css/music.css` stub styles with the final
  music layout.
- [x] Use compact, scrollable regions for library and playlist.
- [x] Ensure playback controls remain usable at small pane heights.
- [x] Add a CSS custom property or class for the music-player minimum pane
  height if useful.
- [x] Keep styling scoped under the music pane to avoid affecting the file
  browser and server log.
- [x] Verify the pane has no nested-card layout and text does not overflow
  controls.

## Step 5 - Bottom Pane Minimum Height Behavior

- [x] Decide whether minimum-height enforcement belongs in
  `bottom-pane.js`, `log.js`, or `music.js`.
- [x] When switching to music-player mode, check the current bottom-pane height.
- [x] If the pane is below the music minimum, resize it upward.
- [x] Clamp the resized height so it does not exceed the usable viewport.
- [x] Preserve normal manual resizing behavior.
- [x] Add or update UI contract tests where practical.

## Step 6 - Library Client State and Rendering

- [x] Replace `dropbox_browser/assets/js/music.js` stub with a music player
  controller.
- [x] Keep state in browser memory only.
- [x] Track the current folder root from `document.body.dataset.currentFolderPath`.
- [x] Keep the library empty until the user clicks the load button.
- [x] Fetch `/music/endpoints/library` only after manual request.
- [x] Render the folder tree from returned folder/song nodes.
- [x] Preserve expanded folder IDs across refreshes.
- [x] Preserve selected IDs where those nodes still exist.
- [x] Preserve library scroll position across refreshes.
- [x] Show cache completeness/status in the library pane.
- [x] Poll every 3-5 seconds only while music-player mode is visible and a
  library has been requested.
- [x] Stop polling when another bottom-pane mode is selected.
- [x] On main folder navigation, keep playlist state but reset the library to an
  unloaded state for the new current folder.

## Step 7 - Library Selection and Context Menu

- [x] Implement single selection for folders and songs.
- [x] Implement Ctrl-click/Cmd-click toggle selection.
- [x] Implement Shift-click range selection where practical.
- [x] Preserve selected rows when right-clicking an already selected row.
- [x] Add a library context menu.
- [x] Add `Add to playlist` for current selected folders/songs.
- [x] Add `Add cached songs in folder` for right-clicked folder rows.
- [x] Expand selected folders to all currently cached recursive songs already
  present in the library snapshot.
- [x] Dedupe additions by absolute remote path.
- [x] Do not trigger any server fetch solely for context-menu expansion.

## Step 8 - Playlist State and Rendering

- [x] Implement an in-memory playlist array keyed by remote path.
- [x] Add songs from the library with filename, remote path, stream path, and
  root-context-relative display path.
- [x] Ignore duplicate remote paths while preserving the original row.
- [x] Render playlist columns for filename and relative path.
- [x] Keep row data structured so future columns can be added.
- [x] Implement playlist selection, including multi-select where sensible.
- [x] Add playlist context menu with `Play` and `Remove`.
- [x] Double-clicking a playlist row plays that song immediately.
- [x] Right-click `Play` plays the selected row immediately.
- [x] Removing the currently playing song skips to the next playable item.
- [x] Removing non-playing songs preserves the current song where possible.

## Step 9 - Playback Engine

- [x] Use the existing `/file?path=<stream_path>&source=remote` route for audio
  sources.
- [x] Implement play, pause, next, and previous.
- [x] Display the current song filename.
- [x] Highlight the currently playing playlist row.
- [x] Handle browser playback errors with a compact status message.
- [x] On song ended, advance according to shuffle/order and loop settings.
- [x] Do not create a new streaming, temp-file, or download route.

## Step 10 - Shuffle and Loop

- [x] Implement order mode as straight playlist order by default.
- [x] Implement shuffle-bag mode:
  - every playlist item plays once before repeats;
  - playlist changes reset or reconcile the bag;
  - avoid immediate repeat when possible.
- [x] Implement playlist loop toggle.
- [x] Ensure loop means playlist loop only.
- [x] Do not implement single-song repeat.
- [x] Add focused client-level manual test notes or lightweight JS assertions if
  the test harness supports them later.

## Step 11 - Test Pass

- [ ] Run server endpoint tests:
  `python -m unittest tests.test_music_endpoints -v`
- [ ] Run web UI tests:
  `python -m tests.run web -v`
- [ ] Run streaming tests if playback URL behavior changed:
  `python -m tests.run streaming -v`
- [ ] Run cache/background tests if cache traversal helpers changed:
  `python -m tests.run cache background-file-info -v`
- [ ] Run compile checks:
  `python -m compileall -q dropbox_browser.py dropbox_browser`
- [ ] Run full suite before checkin or after broad shared changes:
  `python -m unittest discover -s tests -v`

## Step 12 - Manual Browser Verification

- [ ] Start locally with:
  `python dropbox_browser.py --remote dropbox:`
- [ ] Open `http://127.0.0.1:8000/`.
- [ ] Switch bottom pane to Music Player.
- [ ] Confirm the pane resizes to the minimum usable music height when needed.
- [ ] Load the current folder song library manually.
- [ ] Confirm partial/complete cache status is clear.
- [ ] Confirm polling updates the library without losing expanded folders,
  selection, or scroll position.
- [ ] Add songs from individual song selections.
- [ ] Add cached songs recursively from folder selections.
- [ ] Confirm playlist dedupe by remote path.
- [ ] Play audio and confirm it streams through `/file`.
- [ ] Confirm play, pause, next, previous, shuffle, and playlist loop.
- [ ] Confirm removing the current song skips to the next song.

## Open Questions

- [ ] Should the first endpoint expose only the tree snapshot, or should it also
  include a flattened `songs_by_folder_id` helper map to simplify client-side
  folder context-menu expansion?
- [ ] Should playlist row relative paths preserve the exact root display context
  where the song was added, or should the UI also show the absolute Dropbox path
  in a tooltip for clarity after folder navigation?
- [ ] Should polling stop automatically once the endpoint reports complete, or
  continue while visible in case cache invalidation occurs from another action?
