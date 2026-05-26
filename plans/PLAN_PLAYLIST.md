# Music Player Playlist Persistence Plan

This file tracks the requested playlist-management work for the Music Player.

## Progress

- [x] Read the relevant music-player templates, browser assets, and test docs.
- [x] Confirm the current playlist is browser-only state in
  `dropbox_browser/assets/js/music.js` and `music-playlist.js`.
- [x] Confirm browser persistence already uses the global `Settings` helper
  backed by `localStorage`.
- [x] Confirm the remaining open behavior question before implementation.
- [x] Replace the placeholder playlist controls with the Step 2 UI scaffold.
- [x] Add the Step 3 playlist save/load wiring around the browser-local store.
- [x] Implement the Step 4 playlist import/export flows and helper coverage.
- [x] Tighten the Step 5 rename/save/load edge-case behavior and confirmations.
- [ ] Implement the playlist model, UI, persistence, import/export, and tests.

## Current State Summary

- The playlist pane markup exists in
  `dropbox_browser/assets/templates/music_player.html`, but the current header
  controls are only disabled placeholders.
- Playlist rows, selection, and reordering currently operate on
  `ctx.state.playlist` plus a remote-path lookup map in
  `dropbox_browser/assets/js/music-playlist.js`.
- The music player already persists some browser-only state through
  `Settings.get()` / `Settings.set()`, so persisted playlists can follow the same
  browser-local storage pattern.
- Existing focused JS tests already cover playlist reordering, and web UI tests
  already assert music-player markup contracts.
- Duplicate songs are already disallowed by current playlist behavior through the
  `state.playlistRemotePaths` membership guard in
  `dropbox_browser/assets/js/music-playlist.js`; preserve that behavior.

## Step 1 - Finalize Playlist Data Model

- Add a dedicated browser-side playlist class for:
  - playlist `name`;
  - `last_modified` timestamp;
  - ordered song references by Dropbox absolute path;
  - JSON serialization/deserialization for browser persistence and export.
- Add a small manager/store class around that model for:
  - active in-memory playlist;
  - persisted playlist collection;
  - overwrite-by-name behavior;
  - import/export helpers;
  - sorting helpers for the load modal.
- Keep the implementation browser-only unless a server endpoint becomes
  necessary; persistence should use `Settings` / `localStorage`.
- Preserve compatibility with the existing playback and playlist-row code by
  making the active playlist expose the ordered songs needed by
  `music-playlist.js` and `music-playback.js`.

## Step 2 - Replace Placeholder Playlist Controls

- Update `dropbox_browser/assets/templates/music_player.html` so the playlist
  pane has:
  - top bar left: `Active Playlist: <playlist name>`;
  - top bar right: `Import`, then `Export`;
  - second bar left: `Rename`, then `Load`;
  - second bar right: `Save`.
- Default the active playlist name to `New Playlist`.
- Add any required hidden file input and modal/dialog markup for:
  - import file picking;
  - rename prompt;
  - overwrite confirmation;
  - load-playlist picker with sortable columns and OK/Cancel actions.
- Update `dropbox_browser/assets/css/music.css` so the new bars and modal UI fit
  the current music-player styling and responsive layout.

## Step 3 - Add Playlist Persistence And UI Wiring

- Extend `dropbox_browser/assets/js/music.js` context state so the active
  playlist and persisted playlists are owned by the new playlist class/store
  instead of ad hoc raw arrays alone.
- Update `dropbox_browser/assets/js/music-playlist.js` so row rendering,
  selection, reorder behavior, and current-track bookkeeping stay in sync with
  the new active playlist object.
- Persist all playlists in browser storage after:
  - import;
  - save;
  - confirmed overwrite actions that write persisted state.
- Keep rename as in-memory only until `Save`.
- If the active playlist is still named `New Playlist`, `Save` should require a
  user-supplied name instead of persisting immediately.

## Step 4 - Implement Import And Export

- `Import` should open a file picker and accept:
  - one or many `.m3u8` files;
  - exported playlist JSON files in the app's own format.
- For `.m3u8` import:
  - read client-side through `FileReader`;
  - ignore blank lines and `#` comment lines;
  - treat each remaining line as a Dropbox absolute path;
  - set the imported playlist name from the selected file name;
  - overwrite any existing persisted playlist with the same name;
  - persist all playlists after the import finishes.
- For JSON import:
  - validate the exported shape before replacing/merging data;
  - persist the imported result immediately after success.
- `Export` should save one JSON file containing every persisted playlist plus
  the metadata needed to restore them on import.

## Step 5 - Implement Rename, Save, And Load

- `Rename` should update only the active in-memory playlist name.
- If renaming the active playlist to a name already present in persisted
  playlists, require explicit overwrite confirmation before later save/load
  flows replace the persisted version.
- `Save` should:
  - validate the active playlist name;
  - prompt for a required name when it is still `New Playlist`;
  - persist the active playlist under its current name;
  - update `last_modified`.
- `Load` should open a modal listing persisted playlists with:
  - `Name` column;
  - `Last Modified` column;
  - sorting by either column;
  - ascending/descending toggle behavior;
  - single selection;
  - `OK` to load and `Cancel` to close without changes.
- Loading a playlist should replace the active in-memory playlist and refresh
  the existing playlist pane and playback selection state safely.

## Step 6 - Test Coverage

- Add focused JS tests under `tests/js/` for:
  - playlist model/store serialization;
  - overwrite-by-name behavior;
  - import parsing for `.m3u8`;
  - export/import JSON round-tripping;
  - load-modal sorting helpers.
- Update `tests/test_web_ui.py` for the new music-player markup contract.
- Run targeted checks:
  - `npm run test:js`
  - `python -m tests.run web -v`
  - `python -m compileall -q dropbox_browser.py dropbox_browser`

## Likely Files To Change

- `dropbox_browser/assets/templates/music_player.html`
- `dropbox_browser/assets/css/music.css`
- `dropbox_browser/assets/js/music.js`
- `dropbox_browser/assets/js/music-playlist.js`
- `dropbox_browser/assets/js/music-shared.js` or a new dedicated playlist module
- `tests/js/music-playlist.test.js` and/or a new playlist-store JS test file
- `tests/test_web_ui.py`

## Resolved Questions

- A single playlist should continue to disallow duplicate Dropbox absolute
  paths, matching the current browser behavior and selection/reordering logic.
