# Music Player Design

This document summarizes the initial browser-based music player design. The
implementation plan is tracked in `plans/PLAN_MUSICPLAYER.md`.

## Goals

- Add a browser-based music player in the existing bottom pane when the Music
  Player pane mode is selected.
- Keep server-side runtime dependency-free and stdlib-based.
- Keep music player endpoints and client code isolated in new music-related
  files where possible.
- Reuse the existing `/file` streaming API for audio playback.
- Keep all music player state in browser memory for the initial version.

## Non-Goals

- No playlist persistence yet.
- No uploads.
- No deletes.
- No overwrite behavior.
- No new streaming or download path unless the existing `/file` route proves
  insufficient.
- No expensive Dropbox recursion during normal page loads or music library
  requests.
- No support yet for less consistently browser-playable formats such as
  `.flac`, `.ogg`, `.oga`, or `.opus`.

## Existing Integration Points

- Bottom pane mode wiring already lives in:
  - `dropbox_browser/assets/templates/page.html`
  - `dropbox_browser/assets/templates/music_player.html`
  - `dropbox_browser/assets/js/bottom-pane.js`
  - `dropbox_browser/assets/js/music.js`
  - `dropbox_browser/assets/css/music.css`
- Request routing lives in `dropbox_browser/handlers.py`.
- Browser assets are served by the existing constrained `/assets/...` handler.
- Streaming is already implemented by `/file` and `/download` through
  `RequestHandler.serve_file()` and `dropbox_browser/streaming.py`.
- Recursive folder metadata and cached child listings are owned by
  `dropbox_browser/foldercache.py` and `dropbox_browser/listingcache.py`.

## Proposed File Layout

- `dropbox_browser/music.py`
  - New music endpoint helpers and request handlers.
  - Owns supported audio extension filtering.
  - Owns cached-library JSON shape.
  - Must not call `rclone`.
  - Must not call `folder_cache.request()`.
- `dropbox_browser/assets/js/music.js`
  - Replace the current stub with the music player client controller.
  - Owns in-memory playlist, selection, context menus, audio element, shuffle
    bag, loop behavior, and polling lifecycle.
- `dropbox_browser/assets/css/music.css`
  - Replace stub styling with the three-pane responsive player layout.
- `dropbox_browser/assets/templates/music_player.html`
  - Replace stub markup with semantic containers for library, playlist, and
    playback controls.
- `tests/test_music_endpoints.py`
  - Focused server endpoint tests using fake rclone and isolated caches.
- Existing files should only receive minimal changes for:
  - registering `/music/endpoints/*`;
  - loading or serving new JS/CSS/template/assets;
  - adding or selecting the bottom-pane mode;
  - enforcing the music pane minimum height behavior if the shared bottom-pane
    code is the right owner.

## Endpoint Design

Initial endpoint:

```text
GET /music/endpoints/library?path=<current-folder-relative-path>
```

The endpoint returns a JSON snapshot of all currently cached supported song
files under the requested Dropbox folder. It uses only current cache state:

- `clean_rel_path()` validates the requested root path.
- `remote_target(app.remote, rel_path)` builds absolute Dropbox remote paths.
- `app.listing_cache.get(remote_path)` provides direct child listings when
  available.
- `app.folder_cache.get(remote_path)` and `app.folder_cache.status(remote_path)`
  provide completeness/status hints.
- Missing listing-cache entries stop traversal for that subtree.
- The endpoint must not wait for pending workers.
- The endpoint must not enqueue new folder-cache work.
- The endpoint must not run `rclone`.

Suggested response shape:

```json
{
  "root": {
    "id": "folder:dropbox:Music",
    "remote_path": "dropbox:Music",
    "rel_path": "",
    "display_name": "Music"
  },
  "status": {
    "cache_status": "partial",
    "complete": false,
    "message": "Library may update as cached metadata arrives.",
    "generated_at": 1779210000.0
  },
  "folders": [
    {
      "id": "folder:dropbox:Music/Album",
      "parent_id": "folder:dropbox:Music",
      "remote_path": "dropbox:Music/Album",
      "rel_path": "Album",
      "display_name": "Album",
      "listing_cached": true,
      "complete": false
    }
  ],
  "songs": [
    {
      "id": "song:dropbox:Music/Album/song.mp3",
      "parent_id": "folder:dropbox:Music/Album",
      "remote_path": "dropbox:Music/Album/song.mp3",
      "stream_path": "Music/Album/song.mp3",
      "rel_path": "Album/song.mp3",
      "display_name": "song.mp3",
      "extension": ".mp3",
      "size": 1234,
      "mtime": 1779210000.0
    }
  ]
}
```

`stream_path` is the relative path passed to `/file?path=...&source=remote`.
`rel_path` is relative to the requested music-library root and is used for
display. `remote_path` is stable for dedupe, selection, and playlist playback.

## Library Semantics

- The folder song library starts empty.
- The user must explicitly request the full song library for the currently
  viewed Dropbox folder.
- Supported extensions for the first version are:
  - `.mp3`
  - `.m4a`
  - `.aac`
  - `.wav`
- Extension matching is case-insensitive.
- The library is rooted at the currently viewed Dropbox folder.
- Displayed folder and song paths are relative to the requested root.
- Playback URLs are built from the absolute song location through the existing
  relative stream path needed by `/file`.
- When the current Dropbox folder changes, the playlist remains in memory.
  Playlist rows keep the root context used when the song was added so display
  paths remain meaningful.

## Cache Completeness

The library can be partial because it only uses cached metadata. The UI should
show this directly in the library pane.

Recommended status language:

- Complete: all known recursive metadata for this root is complete.
- Partial/updating: cached library may update as background metadata arrives.
- Unavailable: no cached listing exists for this root yet.

While music player mode is visible after a library request, the client should
poll the library endpoint every 3-5 seconds. Polling stops when the music player
is hidden or until the user requests the library again. Updates must preserve:

- library scroll position;
- expanded/collapsed folder IDs;
- selected folder/song IDs where still present.

## Bottom Pane Layout

The music player bottom pane has three sub-panes:

1. Folder song library
2. Active playlist
3. Playback controls

The layout should remain usable when the bottom pane is small:

- Use a fixed-height pane with internal scrolling regions.
- Let the library and playlist scroll independently.
- Keep playback controls compact and always reachable.
- Add a music-player minimum bottom-pane height if needed.
- When switching into music-player mode, resize the bottom pane to at least the
  music minimum height without exceeding the viewport.

## Folder Song Library UI

- Tree view grouped by folder hierarchy.
- Empty by default.
- Manual button to request the full cached song library for the current folder.
- Folders and songs are selectable.
- Multi-select supports:
  - single click to select one item;
  - Ctrl-click or Cmd-click to toggle;
  - Shift-click range selection where practical;
  - right-click preserving existing selection when the clicked row is already
    selected.
- Right-click context menu supports:
  - Add to playlist for selected folders/songs.
  - Add cached songs in folder for a folder row.
- Adding selected mixed folders/songs means:
  - include selected songs;
  - include all currently cached recursive songs under selected folders;
  - dedupe by absolute remote path;
  - do not trigger new cache or rclone work.

## Active Playlist UI

- Empty by default.
- Straight scrolling list.
- Columns:
  - filename;
  - path relative to the folder/root context where the song was added.
- Structure rows so more columns can be added later.
- No duplicate remote paths.
- Double-click plays the row immediately.
- Right-click context menu supports:
  - Play;
  - Remove.
- Removing the currently playing song skips to the next playlist item.
- Include a placeholder area for future playlist naming, saving, and loading.
- Do not implement persistence yet.

## Playback Controls

Controls include:

- placeholder song art area;
- current song filename display;
- Play;
- Pause;
- Next;
- Previous;
- Shuffle/order toggle;
- Loop playlist toggle.

Playback uses a browser `Audio` object or `<audio>` element with source URLs
pointing to:

```text
/file?path=<stream_path>&source=remote
```

Shuffle behavior uses a shuffle bag:

- when shuffle is enabled, play each playlist item once in random order before
  repeating;
- reset or reconcile the bag when the playlist changes;
- avoid repeating the current item immediately when there are alternatives.

Loop means playlist loop only. Single-song repeat is out of scope.

## Test Strategy

Server tests:

- `/music/endpoints/library` validates path traversal rejection.
- Endpoint returns only cached data and does not call fake rclone.
- Endpoint includes `.mp3`, `.m4a`, `.aac`, `.wav` case-insensitively.
- Endpoint excludes `.flac`, `.ogg`, `.oga`, `.opus`.
- Endpoint returns stable folder/song IDs and relative display paths.
- Endpoint reports complete/partial/unavailable cache status.
- Endpoint dedupes or deterministically handles duplicate cache traversal paths
  if encountered.

Web/UI contract tests:

- Page loads music template, CSS, and JS.
- Music pane markup contains the three required sub-panes.
- Music mode option remains available in the bottom pane selector.
- Existing asset handler still constrains served asset paths.

Manual/browser verification:

- Request library from a folder with cached metadata.
- Confirm partial status appears while cache is incomplete.
- Confirm polling updates without collapsing folders or losing scroll.
- Confirm add-to-playlist from song and folder context menus.
- Confirm playlist dedupe by remote path.
- Confirm play, pause, next, previous, shuffle bag, and playlist loop.
- Confirm audio seeks/plays through `/file` and byte-range behavior remains
  intact.

## Safety Notes

- Keep local paths under `--local-root`; the music endpoint should not need
  local path access.
- Normalize remote-relative request paths with `clean_rel_path()`.
- Build absolute remote paths with `remote_target()`.
- Never reconstruct Windows local paths from Dropbox display names.
- Do not add upload, delete, overwrite, or persistence behavior.
- Do not hotlink icons or external assets.
