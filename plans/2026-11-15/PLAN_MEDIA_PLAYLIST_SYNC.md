# Plan: Media playlist Dropbox sync

Date: 2026-11-15
Revised: 2026-11-15
Final review: 2026-11-15
Branch: continue on `dev-playlist-sync`

## Scope

On the music and video active-playlist rows, shorten two buttons and add
Sync Pull and Sync Push. Pull replaces this browser's saved playlists with
a Dropbox JSON file, then reloads or resets the active playlist. Push
exports this browser's saved playlists and copies that JSON to Dropbox.
Both actions show one confirmation popup before anything is imported or
uploaded.

Music and video stay independent. Shared playlist code does the work. Each
media-library user opts in by passing its own Dropbox-relative path.

This is not a sync engine. There is no automatic sync, no merge, no
per-path lock, and no conflict resolver. One Pull or one Push runs by
itself. Ordinary request errors are enough.

## Confirmed behavior

- Button labels are **Playlists**, **Rename**, **Sync Pull**, and **Sync Push**.
  Dialog titles stay "Load Playlist: Songs", "Load Playlist: Videos",
  "Rename Playlist", and the existing save-mode title "Save Playlist".
  Save, Import, and Export stay where they are.
- Put Sync Pull and Sync Push in the same row, after Rename.
- Sync Pull replaces the saved-playlist collection. It uses
  `PlaylistStore.importPersistedPlaylists`. It does not use
  `mergePersistedPlaylists`.
- After that replacement, Pull also updates the visible active playlist.
  The Sync Pull confirmation is the only discard prompt. Do not call
  `maybeConfirmDiscardUnsavedPlaylist`.
- Sync Push builds the file with `exportPersistedPlaylists` before the
  popup. OK writes those exact bytes. It does not export again.
- The browser saved collection is the local playlist set. The file in the
  server's local Dropbox folder is only the copy the existing sync upload
  sends. Push overwrites that file from the confirmed export. It does not
  merge with whatever was already on disk, and it does not change the
  active playlist.
- Unsaved edits to the active playlist are not part of the saved
  collection. Push does not include them. Pull discards them only when OK
  applies a real collection change.
- Read the Dropbox file with `GET /file?source=remote` before the popup.
  OK applies the payload that was validated and summarized. It does not
  read the file again. Cancel imports nothing and uploads nothing.
- A remote 404 is a missing file only when absence was established.
  `GET /file` must not turn an rclone `BAD_GATEWAY` into 404 just because
  the parent listing fell back to local-only rows after a remote failure
  (`local_only_after_remote_error`, or a stale listing). Preserve that
  remote error. A genuine 404 on Pull is an error and nothing is imported.
  A genuine 404 on Push means the remote collection is empty: every local
  saved playlist is listed as added, and OK creates the file. Any other
  read, network, or server error stops the action. It must not be treated
  as an empty file or as a 404.
- Importer and validation errors stop the action before the live store is
  modified. No popup is offered for a payload that failed validation.
- The popup has OK and Cancel at the top, then a scrolling text box. OK is
  disabled when the saved collections have no content changes. Nothing is
  imported or uploaded in that case, and the active playlist is left as it
  is, dirty edits included.
- An empty local saved collection may be pushed. The summary lists every
  remote playlist as removed. The Export button's empty-export guard stays
  on Export only.
- Do not change the browse page's current folder. Existing sync listing
  invalidation for the playlist file's parent is acceptable.
- The browser may be on another machine from the server. Reads, the local
  write, and the upload all go through HTTP. The browser does not read the
  server disk itself.
- No new JSON parser and no new Dropbox transfer. `POST /local-file` only
  writes bytes into the local Dropbox folder. rclone still runs only
  through the existing `POST /sync` upload.

## Two different replacements

Saved-collection replacement and active-playlist reload are separate steps.

1. Saved collection. `importPersistedPlaylists` replaces
   `persistedPlaylists` on the live store. `persist()` writes that
   collection to the existing Settings key: `music-playlists` for music,
   `video-playlists` for video.
2. Active playlist. This is session state. The store constructor always
   starts it as "New Playlist", and `loadPersistedPlaylists` restores only
   the saved collection. Pull must not add a new "remember the active
   playlist" setting.

After a successful Pull import, choose the active playlist from the link
already stored in `state.activePlaylistSavedName`:

- Non-blank saved name, and `findPersistedPlaylistByName` finds it in the
  new collection: call `loadPlaylistByName`. That is the Favorites case.
  Browser A had "Favorites" loaded with 20 songs. Browser B pushed 25.
  After Pull, the visible active playlist is the imported "Favorites"
  with those 25 songs.
- Saved name missing, blank, or not in the new collection: call
  `loadNewPlaylist`. That covers an unlinked active playlist, including
  one with unsaved local work, and a linked playlist the Dropbox file
  removed.

Do not pass a blank saved name to `findPersistedPlaylistByName`. That
helper normalizes an empty name to "New Playlist" and could load the wrong
row.

Both loaders already update the pieces Pull needs:

- `loadPlaylistByName` calls `replaceActivePlaylist` with a clone, then
  `ctx.syncPlaylistState`, `markActivePlaylistSaved`,
  `resetPlaylistSelections`, `resetShuffleBag`, and `renderPlaylist`. It
  keeps `currentPlaylistIndex` when `playlistIndexByRemotePath` still
  finds the playing path, and otherwise calls
  `ctx.playbackApi.clearCurrentSong`.
- `loadNewPlaylist` replaces the active playlist with an empty
  "New Playlist", clears the saved-name link, sets the dirty flag false,
  clears the index, resets selections and shuffle, calls
  `clearCurrentSong`, and renders.

Music `syncPlaylistState` copies `activePlaylist`, `persistedPlaylists`,
`playlist`, and `playlistRemotePaths`. Video's copy does the same and
then calls `syncQueueFromPlaylist`. `loadPlaylistByName` calls
`syncPlaylistState` before it restores `currentPlaylistIndex`, so the
video queue can still hold the old index. After either loader returns,
call `ctx.syncPlaylistState()` once more so the video queue sees the
loader's final index. `syncQueueFromPlaylist` must set
`selectedQueueIndex` to that same active index. Leaving the old selected
index in place is wrong once the playing index has moved. Do not call
`playPlaylistIndex` or `playPlaylistRemotePath`. Those start playback and
record Recent history.
The existing loader is the playback policy: keep the current music element
or video session only when the playing path is still in the list; stop
when it is not. Shuffle is cleared because both loaders call
`resetShuffleBag`.

`persistPlaylistStore` already calls `persist`, `syncPlaylistState`, and
`renderPlaylistLoadList`. Use it. Do not add a second persist helper.

## Path parameter

`mediaLibraryConfig.playlistSyncPath` is the opt-in. A missing or blank
path disables both sync buttons. They stay visible.

- Music sets `dropbox_browser_music_playlists.json`.
- Video sets `dropbox_browser_videos_playlists.json`.

Test injection is media-specific. Music reads the query parameter
`music_playlist_sync_path`. Video reads `video_playlist_sync_path`. When
that parameter is present, that user copies it over its own configured
path before init. Neither user reads a shared parameter, and neither
falls back to the other user's path.

Live-server checks use:

- `dropbox_browser/dev_test_music_playlists.json`
- `dropbox_browser/dev_test_video_playlists.json`

They must not read or write the two production root files.

## Validation

Parse on a temporary `PlaylistStore` created with `storage: null` and the
live store's `songFactory`. `importPersistedPlaylists` on that temporary
store is the parser. If it throws, stop. The live store, Settings,
controller refs, active playlist, and playback stay as they were.

The existing importer already rejects a non-object payload, a missing
`playlists` array, a playlist that is not an object, a missing `songs`
array, and a song that is not a non-blank path string. Sync uses those
errors as-is. Before that import, sync rejects a payload whose `version`
is present and is not `PLAYLIST_EXPORT_VERSION`. A missing `version` stays
valid, matching older exports. Manual Import is unchanged.

After the temporary import succeeds, reject the payload when two
playlists have the same `name`. `findPersistedPlaylistByName` and
`loadPlaylistByName` can only see the first. Stop before the live store
is touched.

Only then may Pull call `importPersistedPlaylists` on the live store with
that same payload. `importPersistedPlaylists` assigns `persistedPlaylists`
only after every entry has been built, so a throw inside that call also
leaves the previous array in place. Do not call a loader or `persist`
unless that live import returns.

## Sync Pull

1. Require a non-blank sync path. Otherwise the buttons are disabled.
2. `GET /file?path=<sync path>&source=remote`.
3. On HTTP 404, set the status and stop. Do not open the popup.
4. On any other HTTP, network, or parse failure, set the status and stop.
   Do not describe that failure as a missing file.
5. Validate on the temporary store, including the duplicate-name check.
   On failure, set the status to the error and stop.
6. Compare the temporary collection with the live saved collection and
   open the popup.
7. On OK, import that same payload into the live store, call
   `persistPlaylistStore`, then `loadPlaylistByName` or `loadNewPlaylist`
   as specified above, then `ctx.syncPlaylistState()` once more.

Pull does not write the local Dropbox file and does not call `/sync`.

A confirmed Pull whose summary lists any saved-collection change always
runs the active-playlist step, even when the linked playlist's own items
did not change. Other playlists changing is still a collection
replacement, and unsaved edits to the active list are discarded. No
saved-collection change means OK stays disabled and the active list is
not touched.

## Sync Push

1. Call `exportPersistedPlaylists()` and stringify it the same way
   `downloadJsonFile` does: `JSON.stringify(data, null, 2)`. Keep that
   object and that text as the confirmed payload.
2. Read the remote file the same way Pull does. HTTP 404 compares against
   no playlists. Any other read failure stops before the popup. A body
   that fails validation stops before the popup and is not treated as
   empty.
3. Compare the confirmed export with the remote collection and open the
   popup.
4. On OK, `POST` the confirmed text bytes to `/local-file` with
   `enable_write_dropbox=1`. Do not stringify a new export.
5. If that write fails, do not call `/sync`. Report the failure. The
   browser store and the Dropbox file stay as they were.
6. `POST /sync` with `path=<sync path>`, `kind=file`,
   `direction=local_to_dropbox`, and `enable_write_dropbox=1`.
7. Poll `GET /sync-status` until it completes or fails, and report that
   on the existing status line.

If the local write succeeds and the upload fails, leave the local file in
place. Report the upload failure and say the remote state was not
verified. Do not claim the Dropbox file is unchanged. Do not write a
rollback file. The next confirmed push can retry. Do not add locking
around this.

Push does not call `loadPlaylistByName`, `loadNewPlaylist`, or `persist`.
The saved collection is already what was exported.

## Local write route

Add one general-purpose route, `POST /local-file`. It is not
playlist-specific.

- `path` and `enable_write_dropbox=1` are query parameters. The body is
  the raw file bytes, so the write gate stays out of the body.
- Require `enable_write_dropbox=1`. Missing gate is 403, the same rule
  `POST /sync` uses for a Dropbox write.
- Run `path` through `clean_rel_path` and `safe_join_local`. Reject parent
  segments and any path outside the configured local folder.
- Reject the request when no local folder is configured.
- Require `Content-Length`. Reject a missing or invalid length with 400.
  Reject a length above 8 MiB with 413, using the same early length check
  as `_read_json_body`. Do not parse the body as JSON.
- Write the bytes to a temporary file in the destination directory, then
  `Path.replace` onto the destination. Create missing parents only under
  the local folder. On Windows `PermissionError`, retry the replace a few
  times the way `write_json_atomic` does, but do not call
  `write_json_atomic`: it JSON-encodes and it swallows `FileNotFoundError`
  for disposable caches. A failed write or failed replace returns an HTTP
  error and leaves the previous destination file in place. Delete the temp
  file afterward.
- Do not call rclone. Do not add a browse upload control.

`LocalhostOnlyAccess` stays default true. A non-loopback peer is rejected
until that setting is false. Document that trusted remote access is
`LocalhostOnlyAccess: false` in `config_local.json` plus a non-loopback
bind such as `--host 0.0.0.0`. That is not authentication. The existing
access-control test covers a non-loopback peer when the flag is off.

A caller who can already reach this server and send
`enable_write_dropbox=1` can overwrite any file under the local Dropbox
folder. That is the same trusted-server boundary as sync, extended to
bytes supplied by the browser. It is not a public upload endpoint.

## Confirmation text

Pull heading: `Replace Local Saved Playlists from Dropbox`

The Pull text box starts with this fixed line, then the summary:

`This replaces the saved playlists in this browser. If this active playlist is linked to a saved playlist, it reloads from Dropbox and discards unsaved changes. Otherwise it resets to New Playlist.`

Push heading: `Replace Dropbox Saved Playlists from Local`

The Push text box starts with this fixed line, then the summary:

`This replaces the Dropbox playlist file with this browser's saved playlists. Unsaved edits to the active playlist are not included.`

Summary lines, one playlist per line:

- `Added "<name>" (N items)` for a playlist that will appear.
- `Removed "<name>" (N items)` for a playlist that will disappear.
- `Changed "<name>": added N, removed M` when the item set differs.
- Append `, reordered` when the shared items also changed order, or use
  `Changed "<name>": reordered` when the set is the same and only the
  order differs.
- `No playlist changes.` when nothing above applies. OK is disabled.

Pull's "after" set is the Dropbox file. Push's "after" set is the
confirmed local export. Item identity uses `playlistAbsolutePathKey`.
`last_modified` and `exported_at` alone are not changes. Playlist names
match through the store's normalized name.

## State transitions

Pull, remote 404 or any other read error:

- Saved collection, Settings, active playlist, dirty flag, video queue,
  and playback stay unchanged.
- No popup.

Pull, body fails validation or has duplicate names:

- Same as a read error. The temporary store is discarded. The live store
  is not modified.

Pull, summary has no content changes:

- Popup shows the fixed line and `No playlist changes.`
- OK is disabled. Cancel closes the popup.
- Saved collection and active playlist stay unchanged, including unsaved
  active edits.

Pull, OK with a linked playlist still present:

- `importPersistedPlaylists` replaces the saved collection.
- `persistPlaylistStore` writes `music-playlists` or `video-playlists`.
- `loadPlaylistByName` loads the imported clone, marks it saved, clears
  dirty, resets selections and shuffle, and keeps or clears playback
  through the existing path check.
- The extra `syncPlaylistState` aligns the video queue.
- Reload later restores the saved collection only. The active playlist
  starts as "New Playlist" again, which is existing initialization.

Pull, OK with no link, or with a link the file removed:

- The saved collection is replaced and persisted the same way.
- `loadNewPlaylist` clears the visible list to "New Playlist", clears the
  saved-name link, clears dirty, and calls `clearCurrentSong`.

Push, 404:

- Compare against an empty remote collection.
- OK writes the confirmed export and uploads it with `/sync`.

Push, other read error or invalid remote JSON:

- Stop. Do not write and do not upload. Do not treat the body as empty.

Push, no content changes:

- OK disabled. Do not write the local file. `exported_at` differing is
  not a change.

Push, OK:

- Write the confirmed bytes, then the existing upload.
- The browser saved collection and the active playlist are not modified
  by Push itself.

Push, local write fails:

- Do not upload. Browser store and Dropbox stay unchanged.

Push, upload fails after the local write:

- Browser store stays unchanged. The local file has the confirmed bytes.
  Status says the upload failed and that the remote state was not
  verified. Do not claim the Dropbox file is unchanged.

Cancel on either popup:

- No import, no local write, no upload, no active-playlist change.

## Design risks

- Another browser can Push at the same time. The last upload wins. No
  lock or conflict UI is in this work.
- A failed upload leaves the local Dropbox file newer than Dropbox until
  a later successful Push.
- `POST /local-file` can overwrite any local Dropbox file for a localhost
  caller who sends the write gate. The playlist client only sends its
  own sync path.
- `loadPlaylistByName` also closes the load dialog and sets a load status.
  Set the sync status after the loader returns.
- Playback continues only when the existing loader finds the playing
  path. Shuffle state is cleared either way. Video does not start a new
  HLS session as part of Pull.
- Page reload restores the saved collection, not the session active
  playlist. That is existing `PlaylistStore` construction. This work
  does not change it.
- Edits made while the popup is open are not folded into the confirmed
  Push bytes, and Pull still applies the payload that was summarized.

## Implementation checklist

### Tests first

- [ ] Stay on `dev-playlist-sync`. Do not recreate the branch.
- [ ] Add Node tests for the summary: playlist added, playlist removed,
  item counts, reorder-only, membership change plus reorder,
  timestamp-only ignored, empty-versus-empty, and normalized names.
- [ ] Add Node tests for the Favorites example: a linked 20-song active
  playlist becomes the imported 25-song playlist, dirty is cleared, and
  the saved-name link remains "Favorites".
- [ ] Add Node tests that Pull removes a linked active playlist by ending
  on empty "New Playlist", with the saved-name link cleared, dirty
  false, and playback cleared.
- [ ] Add Node tests that an unlinked dirty active playlist is reset to
  "New Playlist" when OK applies a collection change, and that it is left
  untouched when the summary has no content changes.
- [ ] Add Node tests that a blank `activePlaylistSavedName` does not
  resolve to a saved playlist named "New Playlist".
- [ ] Add Node tests that validation uses a temporary store: malformed
  JSON, a bad playlist entry, duplicate names, and an explicit
  unsupported `version` leave the live store unchanged. A missing
  `version` still imports.
- [ ] Add Node tests that music and video keep separate storage keys and
  separate sync paths.
- [ ] Add a Python test that `POST /local-file` rejects a missing write
  gate, a missing length, an oversized body, a parent segment, a path
  outside the local folder, and a missing local root. An allowed write
  atomically replaces the local file. A failed replace leaves the
  previous bytes. Then `POST /sync` that file through the fake rclone
  and assert the remote bytes match the confirmed export.
- [ ] Add a Python regression test that a remote stat `BAD_GATEWAY`
  followed by a local-only fallback listing stays a remote error on
  `GET /file`, and is not reported as 404. A successful parent listing
  that does not contain the file is still 404.

### Shared client behavior

- [ ] Add the summary helper under
  `dropbox_browser/assets/js/media-library/`. It compares two
  collections already parsed by `PlaylistStore`.
- [ ] Add Pull and Push in the shared playlist controller in
  `playlist.js`. Pull's success path is temporary
  `importPersistedPlaylists`, duplicate-name check, live
  `importPersistedPlaylists`, `persistPlaylistStore`, then
  `loadPlaylistByName` or `loadNewPlaylist`, then one more
  `ctx.syncPlaylistState`. Push's success path is the confirmed
  `exportPersistedPlaylists` text, `POST /local-file`, then `POST /sync`
  and `GET /sync-status`.
- [ ] Read remote JSON only with `GET /file?source=remote`. Treat HTTP
  404 separately from every other failure.
- [ ] Add the shared popup to the music and video shells. Use the Pull
  and Push headings and fixed lines above. OK and Cancel come first.
  Escape and Cancel leave both sides unchanged. Disable OK when the
  summary is `No playlist changes.`
- [ ] Disable both sync buttons when that user's `playlistSyncPath` is
  blank.
- [ ] Pass the production filenames from the music and video users. Honor
  only `music_playlist_sync_path` in `music.js` and only
  `video_playlist_sync_path` in `video.js`.

### Buttons

- [ ] In `media-kind.js`, keep `playlistLoadLabel` as the dialog title and
  add a separate button label, `Playlists`.
- [ ] Change `updatePlaylistMediaLabels` so the load button uses the
  button label and `playlistLoadTitleEl` keeps `playlistLoadLabel`.
- [ ] Set the rename button text to **Rename** in both templates. Leave
  the rename dialog title alone.
- [ ] Set the initial load-button text in both templates to **Playlists**
  so the short label is present before the script runs.
- [ ] Add **Sync Pull** and **Sync Push** after Rename in both templates.

### Server

- [ ] Add general-purpose `POST /local-file` as specified above. Keep
  rclone writes inside the existing sync operation.

### Docs

- [ ] Document the button labels, the separate dialog titles, the
  per-user path, Pull's collection replacement plus active reload, and
  Push's confirmed-export chain in `docs/music-player.md` and
  `docs/video-player.md`.
- [ ] Document `POST /local-file`, including that it can overwrite any
  file under the local Dropbox folder for a localhost caller who sends
  the write gate, in `docs/http-api.md`.
- [ ] Document the simulated Playwright case and the two live-server test
  paths in `docs/testing.md`.

### Simulated end-to-end

Run this before any request to the real Dropbox playlist files.

- [ ] Add a Playwright case on the existing fake-rclone server. Open music
  with `music_playlist_sync_path` pointed at a fixture file, not at
  `dropbox_browser_music_playlists.json`.
- [ ] Cover the 20-song then 25-song Pull: the popup lists the item
  change, OK shows 25 songs in the active "Favorites" playlist, dirty is
  clear, and a reload still has the 25-song saved playlist in the
  Playlists dialog. The active row after reload may be "New Playlist".
- [ ] Cover Pull deleting the linked playlist: the active playlist becomes
  "New Playlist" and playback is cleared.
- [ ] Cover unsaved active edits: a collection change discards them; a
  no-change summary leaves them and disables OK.
- [ ] Cover Cancel: the saved set, the active playlist, and the remote
  file stay as they were.
- [ ] Cover Push: the heading and summary match the confirmed export, OK
  writes that exact text, and the fake remote file equals it. A save made
  after the popup opened is not picked up.
- [ ] Cover remote 404: Pull stops with a missing-file status and does not
  open a mutating popup; Push lists the local playlists as added. A
  non-404 failure does neither and does not say the file is missing.
- [ ] Cover invalid remote JSON and duplicate playlist names: the saved
  collection and active playlist are unchanged.
- [ ] Cover a reorder-only summary line.
- [ ] Cover disabled sync buttons when that user's path is blank.
- [ ] Repeat Pull and Push once on the video pane with only
  `video_playlist_sync_path` set. Assert the music store and the music
  fixture file are unchanged, and that the video queue follows the
  loader: same playing path keeps its index, a removed path clears the
  queue.
- [ ] Run the new Node tests, the new Python test, the relevant playlist
  and sync groups, and the new Playwright spec. All of these must pass
  before the live-server check.

### Live-server check

Only after the simulated tests pass. Use the server already running at
`http://localhost:8000/`. Do not read or write
`dropbox_browser_music_playlists.json` or
`dropbox_browser_videos_playlists.json`.

- [ ] Open music at
  `http://localhost:8000/?path=dropbox_browser&music_playlist_sync_path=dropbox_browser/dev_test_music_playlists.json`.
- [ ] Create a small saved set, Sync Push, and confirm the popup. Read
  back only
  `GET /file?path=dropbox_browser/dev_test_music_playlists.json&source=remote`.
- [ ] Change that same test file remotely, Sync Pull, and confirm the
  saved collection and the linked active playlist match it.
- [ ] Open video with
  `video_playlist_sync_path=dropbox_browser/dev_test_video_playlists.json`
  and no music override. Repeat Pull and Push. Confirm the music browser
  store and the music test file did not change.
- [ ] Leave the two `dev_test_*` files in place and report their paths.
  Do not delete Dropbox files.

## Hand-off

Tell the user the live root files are ready to try only after every
simulated test and the live-server check above have passed. The user
verifies Sync Pull and Sync Push on the real music and video JSON files.
