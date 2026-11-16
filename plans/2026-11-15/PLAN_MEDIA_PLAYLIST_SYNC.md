# Plan: Media playlist Dropbox sync

Date: 2026-11-15
Branch: create `dev-playlist-sync` from `master` at the start of implementation

## Scope

On the music and video active-playlist rows, shorten the load and rename
buttons and add Sync Pull and Sync Push. Pull replaces this browser's saved
playlists with a Dropbox JSON file. Push exports this browser's saved
playlists and copies that JSON to Dropbox. Both actions show one confirmation
popup before anything is imported or uploaded.

Music and video stay independent. The shared playlist code does the work.
Each media-library user opts in by passing a Dropbox-relative path.

## Confirmed behavior

- Rename the load button to **Playlists** and the rename button to **Rename**.
  Dialog titles stay "Load Playlist: Songs", "Load Playlist: Videos", and
  "Rename Playlist". Save, Import, and Export stay where they are.
- Put **Sync Pull** and **Sync Push** in that same row, after Rename.
- Sync Pull replaces the saved-playlist set. It calls the existing
  `importPersistedPlaylists` replace path. It does not call
  `mergePersistedPlaylists`. Local-only saved playlists are removed on OK.
- Sync Push builds the file with the existing `exportPersistedPlaylists`.
  After OK it writes that JSON onto the matching file in the server's local
  Dropbox folder, then calls the existing `POST /sync` `local_to_dropbox`
  upload and polls `GET /sync-status`.
- The browser store is the local playlist set. The file in the local Dropbox
  folder is only the copy the existing sync upload sends. Push overwrites
  that file from the export. It does not merge with whatever was already on
  disk.
- Read the Dropbox file with the existing `GET /file?source=remote` before
  the popup. OK applies the payload that was summarized. It does not read
  the file again. Cancel imports nothing and uploads nothing.
- A missing Dropbox file on Pull is an error in the status line. Nothing is
  imported. A missing Dropbox file on Push is an empty remote set: every
  local playlist is listed as added, and OK creates the file.
- Invalid JSON is an error in the status line. No popup and no changes.
- The popup has OK and Cancel at the top, then a scrolling text box. The
  text names playlists added and removed, with their item counts. For a
  playlist that stays, it gives how many items were added and removed. If
  the same items are in a different order, it says that playlist was
  reordered. A membership change can include both the counts and reordered
  when the shared items also moved. Item identity uses the playlist store's
  existing normalized path. `last_modified` and `exported_at` alone are not
  changes.
- When the summary has no playlist changes, the text says so and OK is
  disabled. Nothing is imported or uploaded.
- An empty local set may be pushed. The summary lists every remote playlist
  as removed. The Export button's empty-export guard stays on Export only.
- The visible active playlist's items stay as they are, the same way Import
  leaves them. If Pull removes the saved name that active list was linked
  to, clear that link and refresh the dirty flag. Do not reload or empty
  the visible list.
- Do not change the browse page's current folder. Existing sync listing
  invalidation for the playlist file's parent is acceptable.
- This must work when the browser is on another machine from the server.
  Every read, local write, and upload goes through the server's existing
  HTTP routes. The browser does not read the server disk itself.
- No new JSON parser and no new Dropbox transfer protocol. The one new
  server route writes bytes into the local Dropbox folder. rclone still
  runs only through the existing sync upload.

## Path parameter

`mediaLibraryConfig.playlistSyncPath` is the opt-in. A missing or blank path
disables both sync buttons. They stay visible.

- The music user sets `dropbox_browser_music_playlists.json`.
- The video user sets `dropbox_browser_videos_playlists.json`.
- A page query parameter, `playlist_sync_path`, is the test injection. When
  it is present, that user copies it over the configured member before init.
  Tests and the live-server check use it so they never touch the two root
  files above.

## Sync Pull

1. Require a non-blank sync path. Otherwise the buttons are disabled.
2. `GET /file?path=<sync path>&source=remote`.
3. Parse the body with the existing playlist import on a temporary store.
4. Compare that set with the live saved playlists and open the popup.
5. On OK, call `importPersistedPlaylists` on the live store with that same
   parsed payload, then `persist()`. Refresh the saved-playlist list and the
   saved-name link described above.

Pull does not write the local Dropbox file and does not call `/sync`.

## Sync Push

1. Read and compare the same way as Pull. A missing remote file compares
   against no playlists.
2. On OK, `exportPersistedPlaylists()` and stringify it the same way the
   existing JSON download does.
3. `POST` those bytes to the new local-file route with
   `enable_write_dropbox=1`.
4. `POST /sync` with `path=<sync path>`, `kind=file`,
   `direction=local_to_dropbox`, and `enable_write_dropbox=1`.
5. Poll `/sync-status` until it completes or fails, and report that on the
   existing status line.

If the local write succeeds and the sync upload fails, leave the local file
in place and report the failure. The next confirmed push can retry. Do not
invent a rollback write.

## Local write route

Add one route, `POST /local-file`:

- `path` is a Dropbox-relative path. Run it through `clean_rel_path` and
  `safe_join_local`. Reject parent segments and paths outside the configured
  local folder.
- Require `enable_write_dropbox=1`, the same gate `/sync` already requires
  for a Dropbox write.
- The body is the raw file bytes. Overwrite or create that local file.
  Create missing parent directories only under the local folder.
- Do not call rclone. Do not add a browse upload control.
- Reject the request when no local folder is configured.

## Summary text

Plain text, one playlist per line:

- `Added "<name>" (N items)` for a playlist that will appear.
- `Removed "<name>" (N items)` for a playlist that will disappear.
- `Changed "<name>": added N, removed M` when the item set differs.
- Append `, reordered` when the order of the shared items changed, or use
  `Changed "<name>": reordered` when the set is the same and only the order
  differs.
- `No playlist changes.` when nothing above applies.

Pull's "after" set is the Dropbox file. Push's "after" set is the local
export.

## Implementation checklist

### Branch and tests first

- [ ] Create `dev-playlist-sync` from `master`.
- [ ] Add Node tests for the summary: playlist added, playlist removed,
  item counts, reorder-only, membership change plus reorder, timestamp-only
  ignored, empty-versus-empty, and name matching that follows the store.
- [ ] Add Node tests that a temporary store parses fixture JSON through the
  existing import, and that the live store's replace import is what Pull
  applies. Assert the visible active playlist items are not replaced.
- [ ] Add a Python test that `POST /local-file` rejects a missing write
  gate, a parent segment, and a path outside the local folder, and that an
  allowed write creates the local JSON. Then `POST /sync` that file through
  the fake rclone and assert the remote bytes match the export.

### Shared client behavior

- [ ] Add the summary helper under `dropbox_browser/assets/js/media-library/`.
  It compares two sets already parsed by the playlist store.
- [ ] Add the Pull and Push sequence in the shared playlist controller.
  Pull ends in `importPersistedPlaylists` plus `persist()`. Push ends in
  `exportPersistedPlaylists`, `POST /local-file`, then the existing
  `/sync` and `/sync-status` calls.
- [ ] Read remote JSON only with `GET /file?source=remote`.
- [ ] Add the shared popup to the music and video shells: OK and Cancel
  first, then a scrolling text box. Escape and Cancel leave both sides
  unchanged. Disable OK when there are no changes.
- [ ] Disable both sync buttons when `playlistSyncPath` is blank.
- [ ] Pass the live root filenames from the music and video users. Copy
  `playlist_sync_path` over that member when the query parameter is present.

### Buttons

- [ ] Set the load and rename button labels to **Playlists** and **Rename**
  for both shells. Leave the dialog titles unchanged.
- [ ] Add **Sync Pull** and **Sync Push** after Rename in both shells.

### Server

- [ ] Add `POST /local-file` as specified above. Keep rclone writes inside
  the existing sync operation.

### Docs

- [ ] Document the button labels, the path member, Pull replace, Push's
  local-write-then-sync chain, and the confirmation summary in
  `docs/music-player.md` and `docs/video-player.md`.
- [ ] Document `POST /local-file` in `docs/http-api.md`.
- [ ] Document the simulated Playwright case and the live-server test path
  in `docs/testing.md`.

### Simulated end-to-end

Run this before any request to the real Dropbox playlist files.

- [ ] Add a Playwright case on the existing fake-rclone server. Open the
  music pane with `playlist_sync_path` pointed at a fixture file, not at
  `dropbox_browser_music_playlists.json`.
- [ ] Cover Pull replacing the saved set, including a removed local
  playlist and a changed item count in the popup.
- [ ] Cover Cancel after the summary: the saved set and the remote file
  stay as they were.
- [ ] Cover Push: the popup matches the local-versus-remote diff, OK writes
  the local file, and the fake remote file equals `exportPersistedPlaylists`.
- [ ] Cover a missing remote file: Pull reports an error and does not open
  a mutating popup; Push lists the local playlists as added.
- [ ] Cover a reorder-only summary line.
- [ ] Cover disabled sync buttons when no path is configured.
- [ ] Repeat the Pull and Push success path once on the video pane with its
  own `playlist_sync_path`, and assert the music store is unchanged.
- [ ] Run the new Node tests, the new Python test, the relevant playlist
  and sync groups, and the new Playwright spec. All of these must pass
  before the live-server check.

### Live-server check

Only after the simulated tests pass. Use the server already running at
`http://localhost:8000/`. Do not read or write
`dropbox_browser_music_playlists.json` or
`dropbox_browser_videos_playlists.json`.

- [ ] Open `http://localhost:8000/?path=dropbox_browser&playlist_sync_path=dropbox_browser/dev_test_music_playlists.json`.
- [ ] As a test music user, create a small saved-playlist set and Sync Push.
  Confirm the popup, then confirm the test file's contents through
  `GET /file?path=dropbox_browser/dev_test_music_playlists.json&source=remote`.
- [ ] Change the saved set, Sync Pull from a known remote edit of that same
  test file, and confirm the browser's saved set was replaced and the
  summary matched the edit.
- [ ] Repeat Pull and Push once with
  `playlist_sync_path=dropbox_browser/dev_test_video_playlists.json` on the
  video user. Confirm the music browser store and the music test file did
  not change.
- [ ] Leave the two `dev_test_*` files in place and report their paths.
  Do not delete Dropbox files.

## Hand-off

Tell the user the live root files are ready to try only after every
simulated test and the live-server check above have passed. The user
verifies Sync Pull and Sync Push on the real music and video JSON files.
