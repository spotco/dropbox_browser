# Completed Music Player Work

Completed items moved from `plans/PLAN_MUSICPLAYER.md` so the active plan can
stay focused on upcoming work.

## Progress

- [x] Read `docs/architecture.md`, `docs/background-workers.md`, and
  `docs/testing.md`.
- [x] Inspect current bottom-pane, asset, streaming, and cache integration
  points.
- [x] Write `plans/DESIGN_MUSICPLAYER.md`.
- [x] Write this implementation plan.
- [x] Implement server endpoint module.
- [x] Implement client UI and playback behavior.
- [x] Add focused tests.
- [x] Run targeted checks.

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

## Step 11 - Folder Cache Direct File Metadata

Add direct child file metadata to folder-cache records so the music library can
use background worker results without depending only on `ListingCacheManager`
TTL. This is a cross-app cache schema change, but the first consumer will be the
music library endpoint.

- [x] Read `docs/background-workers.md` before editing folder-cache code.
- [x] Decide and document the record shape for a new direct-file metadata field,
  tentatively `direct_files`.
- [x] Store only direct child remote files for each folder-cache record, not a
  recursive flattened list in this first change.
- [x] Include enough metadata for music-player use:
  - display filename;
  - direct child name;
  - folder-relative path segment;
  - remote absolute path or app-relative stream path;
  - extension;
  - size;
  - parsed mtime.
- [x] Keep all file extensions in `direct_files`, not only supported audio,
  because this field is intended for future non-music uses.
- [x] Exclude ignored/system names using the same `is_ignored_name` path already
  used by direct listing parsing.
- [x] Add the field in `dropbox_browser/foldercache_compute.py` while parsing
  direct `lsjson` results, so no extra `rclone` calls are needed.
- [x] Store the parsed direct file list in the folder-cache accumulation state
  for the current folder only.
- [x] Include `direct_files` in `build_cache_record()` output.
- [x] Include `direct_files` when reusing a complete child folder-cache record,
  while making sure parent aggregation still does not treat direct child file
  lists as recursive parent file lists.
- [x] Bump `DIFF_CACHE_SCHEMA_VERSION` because old cache records do not contain
  the new field.
- [x] Update validation expectations so old complete records are rejected after
  the schema bump where needed.
- [x] Update folder-cache record/unit tests for serialization and validation.
- [x] Update folder-cache worker tests to prove direct files are cached after a
  worker processes a folder.
- [x] Update `/music/endpoints/library` to prefer `folder_cache.get(remote_path)`
  `direct_files` for child file/song data when direct listing cache is missing
  or expired.
- [x] Keep `/music/endpoints/library` non-blocking:
  - do not call `app.list_entries()`;
  - do not call `rclone`;
  - do not call `folder_cache.request()`;
  - do not wait for pending workers.
- [x] Preserve existing `ListingCacheManager` traversal as a fallback or folder
  discovery source until folder-cache direct metadata fully covers the library
  tree.
- [x] Update music endpoint status wording so folders with folder metadata but
  no direct listing cache are not labeled misleadingly as fully unavailable.
- [x] Add music endpoint tests proving songs can be returned from folder-cache
  `direct_files` even when listing-cache entries are absent.
- [x] Add tests proving no new `rclone` calls are made by the music endpoint
  when using folder-cache direct file metadata.
- [x] Run targeted tests:
  `python -m tests.run music foldercache-records background-file-info -v`
- [x] Run compile checks:
  `python -m compileall -q dropbox_browser.py dropbox_browser`

## Step 12 - Test Pass

- [x] Run server endpoint tests:
  `python -m unittest tests.test_music_endpoints -v`
- [x] Run web UI tests:
  `python -m tests.run web -v`
- [x] Run streaming tests if playback URL behavior changed:
  `python -m tests.run streaming -v`
- [x] Run cache/background tests if cache traversal helpers changed:
  `python -m tests.run cache background-file-info -v`
- [x] Run compile checks:
  `python -m compileall -q dropbox_browser.py dropbox_browser`
- [x] Run full suite before checkin or after broad shared changes:
  `python -m unittest discover -s tests -v`

## Step 13 - Manual Browser Verification

- [x] Start locally with:
  `python dropbox_browser.py --remote dropbox:`
- [x] Open `http://127.0.0.1:8000/`.
- [x] Switch bottom pane to Music Player.
- [x] Confirm the pane resizes to the minimum usable music height when needed.
- [x] Load the current folder song library manually.
- [x] Confirm partial/complete cache status is clear.
- [x] Confirm polling updates the library without losing expanded folders,
  selection, or scroll position.
- [x] Add songs from individual song selections.
- [x] Add cached songs recursively from folder selections.
- [x] Confirm playlist dedupe by remote path.
- [x] Play audio and confirm it streams through `/file`.
- [x] Confirm play, pause, next, previous, shuffle, and playlist loop.
- [x] Confirm removing the current song skips to the next song.

## Moved From PLAN_MUSICPLAYER.md

These items were moved out of the active plan when a new deferred-render
implementation plan replaced them.

### Progress

- [x] Analyze playback-controls redesign request and current music player code.
- [x] Confirm open behavior questions:
  - long filename/title/artist text should scroll/marquee;
  - metadata should be acquired asynchronously in the browser when possible;
  - embedded cover art should be shown when available, otherwise use a
    placeholder;
  - time display should use hours/minutes/seconds;
  - keep shuffle and loop controls;
  - use local static icon assets through the existing icon-serving pattern;
  - persist volume for this Dropbox browser app.
- [x] Implement iPhone-style playback controls markup.
- [ ] Implement browser-side playback progress, seeking, metadata, art, and
  persisted volume behavior.
- [ ] Add focused tests.
- [ ] Run targeted checks.

### Step 1 - Playback Controls Markup

- [x] Read `docs/architecture.md` and `docs/testing.md` before editing the
  playback template and UI contract tests.
- [x] Update `dropbox_browser/assets/templates/music_player.html` inside
  `#music-playback-pane` only.
- [x] Replace the current simple controls layout with an iPhone-style stacked
  control surface:
  - top now-playing row with cover-art placeholder on the left;
  - filename, title, and artist text block on the right;
  - scrubber/progress slider row;
  - elapsed and total time labels below the scrubber;
  - previous, play/pause, and next transport buttons;
  - shuffle and loop toggle buttons;
  - horizontal volume slider.
- [x] Keep the hidden `<audio id="music-audio">` element as the playback engine.
- [x] Keep existing element IDs where practical for compatibility, especially:
  `music-current-filename`, `music-prev`, `music-play`, `music-pause`,
  `music-next`, `music-shuffle-toggle`, `music-loop-toggle`, and `music-audio`.
- [x] Add new stable IDs for:
  - song title;
  - song artist;
  - cover-art image/placeholder state;
  - progress slider;
  - elapsed time label;
  - total time label;
  - volume slider.
- [x] Use accessible labels or titles for icon-only controls.
- [x] Preserve the existing library and playlist panes unchanged.

### Step 2 - Local Playback Icon Assets

- [x] Identify reasonable SVG icons for previous, play, pause, next, shuffle,
  loop, and volume.
- [x] Vendor the icon files locally under
  `dropbox_browser/assets/icons/material-icon-theme/` so they can be served by
  the existing constrained icon handler.
- [x] Do not hotlink external icons.
- [x] Preserve or update local icon attribution files if the chosen icon source
  requires it.
- [x] Render icon controls through local `/assets/icons/material-icon-theme/*.svg`
  URLs.
- [x] Add or update web UI tests proving the expected local icon URLs are present
  and served.

### Step 3 - Playback Controls Styling

- [x] Update `dropbox_browser/assets/css/music.css` for the redesigned
  `music-playback-pane`.
- [x] Match the attached iPhone playback-control structure while preserving the
  existing app visual language.
- [x] Keep the control panel compact enough for the bottom pane.
- [x] Use a square cover-art area with a clear placeholder state.
- [x] Style filename, title, and artist text distinctly:
  - filename as the primary current file identifier;
  - title as metadata when available or a loading/unknown placeholder;
  - artist as metadata when available or a loading/unknown placeholder.
- [x] Implement marquee/scroll behavior for overlong filename, title, and artist
  text.
- [x] Make the progress slider visibly show current progress and allow dragging.
- [x] Make enabled shuffle and loop states visually obvious through button
  state, `aria-pressed`, and CSS.
- [x] Make disabled/inactive shuffle and loop states visually distinct.
- [x] Ensure icon buttons have stable dimensions and do not resize the layout.
- [x] Ensure text and controls do not overlap at desktop widths or the existing
  responsive breakpoint.

### Step 4 - Play/Pause Single Control

- [x] Replace the current separate play and pause visible-button behavior with a
  single effective play/pause control.
- [x] Keep compatibility with existing IDs where practical, or update tests if
  markup changes require a new canonical ID.
- [x] When audio is paused or no song is loaded, show the play icon.
- [x] When audio is playing, show the pause icon.
- [x] Update icon state on:
  - starting playback;
  - pausing playback;
  - audio `play`;
  - audio `pause`;
  - audio `ended`;
  - clearing the current song;
  - playback errors.
- [x] Preserve existing previous, next, shuffle, loop, and playlist behavior.

### Step 5 - Progress, Seeking, And Time Display

- [x] Add audio event listeners for `loadedmetadata`, `durationchange`,
  `timeupdate`, `seeking`, `seeked`, `play`, `pause`, and `ended` as needed.
- [x] Format elapsed and total duration as `HH:MM:SS`.
- [x] Show `00:00:00` while duration or current time is unavailable.
- [x] Keep the progress slider minimum at `0`.
- [x] Set the progress slider maximum from `audio.duration` when finite.
- [x] Update progress slider value as playback advances.
- [x] Pause automatic slider updates while the user is dragging the scrubber.
- [x] On scrubber input/change, seek the audio element to the selected time.
- [x] Handle unknown or streaming durations without throwing or displaying `NaN`.
- [x] Reset progress and time display when the current song is cleared.

### Step 6 - Persisted Volume

- [x] Initialize audio volume from `Settings.get('music-volume', defaultVolume)`.
- [x] Clamp restored volume to the valid browser range `0.0` through `1.0`.
- [x] Bind the horizontal volume slider to `audio.volume`.
- [x] Persist changes with `Settings.set('music-volume', volume)`.
- [x] Apply the persisted volume before starting playback.
- [x] Keep volume persistence local to this Dropbox browser app through the
  existing `Settings` prefix.
- [x] Add UI contract tests for `Settings.get('music-volume'` and
  `Settings.set('music-volume'`.

### Step 7 - Browser-Side Metadata Loading

- [x] Add client-side metadata state to `dropbox_browser/assets/js/music.js`.
- [x] When a song becomes current, immediately show loading placeholders for
  title, artist, and cover art.
- [x] Fetch metadata asynchronously in the browser using the existing `/file`
  stream URL for the selected remote song.
- [x] Prefer range requests where practical so metadata parsing does not require
  downloading entire large audio files.
- [x] Keep all metadata work non-blocking relative to playback start.
- [x] Cancel or ignore stale metadata results when the user switches songs before
  parsing completes.
- [x] Start with common browser-side parsing paths for supported formats:
  - MP3 ID3v2 title, artist, and embedded APIC cover art;
  - M4A/MP4 title, artist, and embedded cover art atoms where practical;
  - WAV INFO title/artist where practical.
- [x] If metadata cannot be read, keep filename as the reliable identifier and
  show unknown/placeholder title, artist, and cover art.
- [x] Do not add server-side preview/download caching for metadata.
- [x] Do not add Python package or runtime dependencies for metadata extraction.

### Step 8 - Embedded Cover Art

- [x] Display embedded cover art when browser-side metadata parsing finds it.
- [x] Convert embedded image bytes to a browser object URL or data URL.
- [x] Revoke old object URLs when switching songs to avoid leaking memory.
- [x] Keep the placeholder visible while metadata is loading.
- [x] Keep the placeholder visible when no embedded art exists or parsing fails.
- [x] Avoid layout shifts between placeholder and loaded cover art.
- [x] Add error handling for unsupported embedded image MIME types.

### Step 9 - Playlist And Current Song Integration

- [x] Update `playPlaylistIndex()` so it resets and repopulates the new now-playing
  metadata fields.
- [x] Keep filename display based on the selected playlist row immediately, even
  before metadata loads.
- [x] Keep current playlist row highlighting unchanged.
- [x] Keep double-click library song behavior:
  - add to playlist if missing;
  - select and scroll to the playlist row;
  - play immediately.
- [x] Ensure removing the current song resets progress, metadata, art, and
  play/pause state before advancing or clearing playback.
- [x] Ensure playback errors update the status without breaking the control UI.

### Step 10 - Tests

- [x] Update `tests/test_web_ui.py` for the redesigned playback markup.
- [x] Add tests for the new playback control IDs.
- [x] Add tests for local icon URLs and removal of text-only transport controls.
- [x] Add tests for the progress slider, elapsed/total time labels, and volume
  slider markup.
- [x] Add tests for persisted volume JavaScript contracts.
- [x] Add tests for play/pause icon state JavaScript contracts.
- [x] Add tests for metadata loading placeholders and stale-result protection
  contracts where practical.
- [x] Keep tests dependency-free and stdlib-based.

### Step 11 - Verification

- [ ] Run web UI tests:
  `python -m tests.run web -v`
- [ ] Run streaming tests if `/file` range or playback URL behavior changes:
  `python -m tests.run streaming -v`
- [ ] Run compile checks:
  `python -m compileall -q dropbox_browser.py dropbox_browser`
- [ ] Manually verify in the browser:
  - playback controls visually match the requested iPhone-style structure;
  - play/pause icon switches correctly;
  - previous and next still work;
  - shuffle and loop toggles are visually clear;
  - progress updates during playback;
  - scrubber seeking works;
  - elapsed and total time use `HH:MM:SS`;
  - volume persists after reload;
  - metadata placeholders appear before metadata loads;
  - embedded title/artist/art display when available;
  - placeholder art remains when no embedded art exists.

### Open Questions

- None
