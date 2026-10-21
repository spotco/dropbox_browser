# Plan: Media Session controls for music and video

Date: 2026-10-21
Branch: `media-session-controls`

## Scope

Publish the current music or video item through the browser Media Session API
(`navigator.mediaSession`) so Windows System Media Transport Controls and an
iPhone lock screen can show the item and send play, pause, previous, next,
seek, and scrub commands back to the page.

Music is the player this is for. Video gets the same session only where it can
reuse the existing transport. Video seek, HLS restart, subtitle remount, and
pane teardown stay on their current paths.

No server routes or upload behavior. One playlist-column fix lands first, then
the media-session work. The session controller lives in the shared
media-library client (`assets/js/media-library/`), the same tree as the
playlist, library, and recent-history modules. Music and video only bind to
it. It must not import from `music/` or `video/`.

## What the page publishes

One document has one media session. Music and video are both panes on that
document, so a shared owner decides who is allowed to write it.

| OS surface | Source |
| --- | --- |
| Title | Music: embedded title once metadata arrives, otherwise the playlist display name. Video: `activeItemTitle` (display name, filename, then path). |
| Artist | Music: embedded artist once metadata arrives. Video: omit. |
| Album | Omit. Album tags are not parsed today. |
| Artwork | Music: the cover object URL already stored on `state.currentArtObjectUrl`, when embedded art exists. Video: one frame from the playing element, captured once per item. |
| Playing / paused | The real media element, not the button icon alone. |
| Progress | Music: `audio.currentTime` and `audio.duration`. Video: `currentGlobalPlaybackSeconds()` and the duration already used by the transport slider. |
| Previous / next | The existing playlist actions, including shuffle and loop. |
| Rewind / fast forward | `seekbackward` / `seekforward`. Use `details.seekOffset` when the browser sends one. Otherwise 15 seconds for both players. |
| Scrub | `seekto` at `details.seekTime`. |

`playbackRate` is always `1`. Neither player exposes a rate control.

## Confirmed decisions

1. The player that most recently started or resumed playback owns the session.
   The other player keeps its own playback, but its progress ticks do not
   overwrite the session. It takes the session back only when the user plays,
   pauses, seeks, or skips in that player.
2. Pausing does not release the session. The lock screen stays on the paused
   item. Music already keeps playing when the music pane is hidden, so hiding
   that pane does not clear the session either.
3. Publish every field we can fill without a new server route. Music artwork
   is the embedded cover that metadata parsing already extracted. Video
   artwork is one frame taken from the element that is already playing. Neither
   path calls `/video/endpoints/thumbnail` or starts FFmpeg. A poster miss on
   that endpoint is a remote FFmpeg run with a 30 second timeout, which is not
   the quick one-frame grab this needs. If frame capture fails, publish the
   session with no artwork rather than falling through to that endpoint.
4. When the browser omits `seekOffset`, both players seek by 15 seconds.
5. Leaving the video pane keeps today's behavior: stop the HLS session and
   reset the playback surface. That path releases the session only when video
   still owns it.
6. The browse page title stays unchanged.

## Playlist column minimums

Do this before the media-session work. Active-playlist columns in both the
music and video panes share `initLayout` in
`dropbox_browser/assets/js/media-library/layout.js`. Their drag floor is much
higher than the file browser:

| Column | Playlist floor today | File-browser floor |
| --- | --- | --- |
| index | 48px | 16px |
| filename | 120px | 16px |
| path | 150px | 16px |
| reorder | 56px | 16px |

The file-browser floor is `BROWSE_COLUMN_MIN_WIDTHS` in
`dropbox_browser/assets/js/browse/columns.js`: 16px so a 14px resize handle
stays inside the column and can still be grabbed. Playlist resizers are the
same 14px (`.music-playlist-column-resizer` in `media-library.css`).

Set `PLAYLIST_COLUMN_MIN_WIDTHS` to 16 for `index`, `filename`, `path`, and
`reorder`. Leave the default and saved widths alone, so existing playlists
open at their current sizes and can then be dragged down to that floor.
`resizeColumnPair` and `fitColumnWidthsToTotal` already honor the map passed
in, so no browse-column behavior change is required.

Also drop the stylesheet fallback that re-imposes the old floor before layout
JS runs. In `.music-playlist-table`, change the `minmax(120px, …)` and
`minmax(150px, …)` tracks to `minmax(16px, …)`, and set
`--music-playlist-grid-min-width` from the 16px floors plus the existing 16px
gap and 16px horizontal padding (96px). The inline widths JS writes stay in
pixels, so this fallback is only the pre-init template.

The reorder row grip is 24px. At a 16px column it clips. That grip is not the
resize handle, so it does not raise the column floor.

Update the assertions that lock the old floors:

- `tests/js/media-library-layout.test.js` (`>= 120`, the CSS custom-property
  match)
- `tests/test_web_ui.py` (the `--music-playlist-grid-columns` string)
- the custom-min example in `tests/js/browse-columns.test.js` only if it is
  meant to mirror playlist floors; the generic fitter can keep its own sample
  numbers

Check both panes: drag each playlist divider until the column stops, confirm
the 14px handle is still fully visible and clickable, then reload and confirm
the saved narrow width comes back. Music and video use separate settings keys
(`music-playlist-column-widths`, `video-playlist-column-widths`).

## Shared module

Add `dropbox_browser/assets/js/media-library/media-session.js`. This is shared
media-library code, next to `layout.js`, `playlist.js`, and `recent-store.js`.
Do not put it under `music/` or `video/`, and do not duplicate it per player.

It is the only writer of `navigator.mediaSession`. Music and video each pass a
kind (`"music"` or `"video"`) and action callbacks. ES module identity gives
both hosts the same owner on the page.

Public surface:

- `bindMediaSession(kind, actions)` registers `play`, `pause`, `next`,
  `previous`, `seekBy(deltaSeconds)`, and `seekTo(seconds)`.
- `claimMediaSession(kind)` makes that kind the owner and installs handlers.
- `updateMediaSession(kind, snapshot)` refreshes metadata, playback state, and
  position. A snapshot with `playbackState: "playing"` also claims. A
  `"paused"` or position-only update is ignored unless that kind is already
  the owner.
- `releaseMediaSession(kind)` clears metadata, sets `playbackState` to
  `"none"`, and removes handlers only when that kind is the owner.

Snapshot fields: `title`, `artist`, `album`, `artworkUrl`, `artworkType`,
`playbackState` (`"playing"`, `"paused"`, or `"none"`), `position`,
`duration`, `playbackRate`, `canSeek`, `seekStepSeconds`.

Handler rules:

- Missing `navigator.mediaSession` makes every call a no-op.
- Each `setActionHandler` is in its own try/catch. An unsupported action must
  not block the others.
- Previous and next handlers are always installed for the owner. They call the
  same functions as the on-screen buttons, including "no next item" behavior.
- Seek handlers are installed only when `canSeek` is true. `seekbackward`
  and `seekforward` call `seekBy` with `-(details.seekOffset || seekStepSeconds)`
  or `+(details.seekOffset || seekStepSeconds)`. `seekto` calls `seekTo` only
  when `details.seekTime` is a finite number. Ignore `details.fastSeek`;
  neither player has a fast-seek path that is safe to prefer.
- `setPositionState` runs only when `duration` is finite and `>= 0`, and
  `position` is finite. Clamp `position` into `[0, duration]`. Swallow a throw
  from a stale duration during a track change.
- Position writes are throttled to about once per second, except a claim,
  seek, pause, or track change, which flush immediately.
- Releasing or replacing the owner sets metadata to `null` before the next
  owner publishes. A non-owner release does nothing.

## Music wiring

Owner: `dropbox_browser/assets/js/music/playback.js`, with one metadata hook in
`music/metadata.js`.

Bind once from `initPlayback`. Actions:

- play → `playCurrentOrFirst`
- pause → `pausePlayback`
- next → `playNextSong`
- previous → `playPreviousSong`
- seekBy → add the delta to `audio.currentTime`, clamped to `[0, duration]`,
  then refresh the existing time display
- seekTo → the same assignment the progress slider already uses
  (`els.audio.currentTime = targetTime`)

Publish from the existing audio events, not from a new timer:

- `playPlaylistIndex` and `play` / `playing`: claim, state `"playing"`, title
  from the song display name until metadata replaces it.
- `pause`: owner update, state `"paused"`.
- `timeupdate`, `seeked`, `loadedmetadata`, `durationchange`: position update.
  Skip the position write while `state.scrubberDragging` is true, then flush
  on `seeked`.
- `clearCurrentSong`, a terminal load error that leaves no song, and playback
  that advances onto no next item: `releaseMediaSession("music")`.
- `applyMetadataResult` and a successful `setCoverArtImage`: owner update with
  title, artist, and `state.currentArtObjectUrl`. Clearing the cover removes
  the artwork URL. Do not wait for artwork before the first publish.

`canSeek` is true only when `audio.duration` is finite and positive.
`seekStepSeconds` is `15`. Artwork is `state.currentArtObjectUrl` with the
cover MIME type. Revoking that URL on a song change must publish a new
snapshot without the old artwork.

Hiding the music pane, blurring the window, and stopping library polling do
not release the session. `beforeunload` / `pagehide` does.

## Video wiring

Owner: `dropbox_browser/assets/js/video/controls.js`, which already owns
play/pause, previous/next, and the 15-second steps. Do not point seek at
`videoEl.currentTime`.

Bind once from `initControls`. Actions call the existing functions:

- play / pause → `toggleVideoPlayPause` split into the play and pause branches
  already inside it (`requestVideoPlay` versus `videoEl.pause()` plus
  `transportWantsPlay` / `pendingAutoplay`). A media-session play during the
  loading overlay must set those flags the same way the space bar does, and
  must not start a second HLS session.
- next → `playNextVideo`
- previous → `playPreviousVideo`
- seekBy → `seekBySeconds`
- seekTo → `restartCompatibilityAt(seconds, "media-session-seek")`, using the
  same duration clamp and forward-seek restart clamp as `seekBySeconds`

Publish only as an owner update from the transport that already runs:

- `requestVideoPlay` and the video `play` / `playing` events: claim with the
  active item title and state `"playing"`.
- pause: state `"paused"`.
- `syncPlaybackProgress`: throttled position. While `seekRestartInProgress`
  is set, publish `requestedSeekSeconds` instead of the element time so the
  system bar does not jump backward during an HLS restart.
- `canSeek` follows the back/forward buttons: a finite duration greater than
  0. `seekStepSeconds` is `15`.
- Artwork: after the element presents the first frame of the active item,
  draw that frame once to a small canvas (about 512px on the long edge),
  export a JPEG or PNG blob, and publish its object URL. Capture again only
  when the active item changes. Revoke the previous object URL on that change
  and on release. Skip the capture while the poster is already current for
  the same item. If the canvas is tainted or the frame is not available yet,
  publish without artwork and retry once on the next presented frame. Do not
  request `/video/endpoints/thumbnail`.

Release video only from the paths that already stop playback:

- `clearCurrentSong` in the media-library bridge
- pane deactivation in `video/pane.js` after `stopCompatibilitySession` and
  `resetPlaybackSurface`
- `pagehide` / `beforeunload`

Releasing video must not pause or retarget the music element. If music still
owns the session, video's release is a no-op.

Do not publish during probe, placeholder, or "preparing HLS" states before a
media element is actually playing or paused on a loaded item. A queue change
that has not started playback yet does not claim.

## Behavior that stays put

- Video still stops its compatibility session when the bottom pane leaves
  video. This plan does not keep video alive in the background or on a locked
  phone.
- Music still does not pause when the user switches panes.
- Shuffle, loop, recent history, and failed-song skip keep their current
  results. Previous and next from the OS call those same functions.
- No `document.title` changes, no new settings keys, no new endpoints.
- Photo Map preview playback is out of scope.

## Tests

Node tests in `tests/js/media-session.test.js` against a fake
`navigator.mediaSession`. Cover:

- no API: calls do nothing
- playing snapshot claims, writes `MediaMetadata`, `playbackState`, and a
  clamped `setPositionState`
- paused update from a non-owner is ignored
- a later playing claim replaces the owner and clears the previous metadata
  first
- position updates from the previous owner are ignored after replacement
- missing or non-finite duration skips `setPositionState` and seek handlers
- position above duration is clamped
- a throwing `setPositionState` or `setActionHandler` does not throw outward
- seek backward/forward uses `seekOffset`, then the snapshot step
- `seekto` forwards `seekTime` and ignores a missing time
- release by the owner clears the session; release by the other kind does not
- a second position update inside the throttle window does not call
  `setPositionState` again; a seek flush does

Music and video host tests stay small:

- extend `tests/js/music-playback.test.js` so a fake session module records
  claim, pause, seek, and release from the existing playback events
- extend `tests/js/video-modules.test.js` or the media-library bridge test so
  a video seek action is recorded as `restartCompatibilityAt` / `seekBySeconds`
  rather than a `currentTime` write, and pane deactivation releases only a
  video-owned session

`tests/test_web_ui.py` asserts specific import lines. Add the new import
assertions next to the existing music and video import checks.

Run:

```powershell
npm run test:js
run\win\run_python.bat tests.run web -v
```

Playwright is not required. Headless Chrome will not show the Windows media
card.

## Manual check

After the branch is implemented, play a song in Chrome or Edge:

- Zebar, `Win+A`, and the volume flyout show the display name, then the
  embedded title and artist after metadata loads, plus cover art when the
  song has embedded art. A video replaces that with the video title and a
  frame from the playing picture, with no new FFmpeg poster request in the
  server log.
- Play, pause, previous, and next on that card move the playlist the same way
  the pane buttons do, including shuffle and loop.
- Scrubbing the Chrome media popup or the Windows timeline seeks the audio
  element.
- Switching to the video pane and starting a video replaces the card with the
  video title and a captured frame. Previous, next, and a 15-second skip follow the
  video buttons. Leaving the video pane clears the card only if music is not
  still the owner; if music is still playing, the next music progress tick
  does not steal the card back until music is played, paused, sought, or
  skipped.
- The PowerShell GSMTC dump from the planning notes lists a `Chrome` or
  `MSEdge` session whose title matches the owner.

## Docs

After the behavior lands, add a short "System media controls" section to
`docs/music-player.md` and a shorter one to `docs/video-player.md`. Mention
the shared module, the single-session owner, the 15-second default seek,
where artwork comes from, and that video seek goes through compatibility
restart. Update the video cross-module
API table with the media-session bind.

## Implementation order

1. Playlist column floors in shared `layout.js`, the CSS fallback, and the
   tests that lock the old 48/120/150/56 floors. Confirm music and video.
2. Shared `media-library/media-session.js` and `tests/js/media-session.test.js`.
3. Music bind, metadata refresh, playback-event publish, music test.
4. Video bind through existing transport and compatibility seek, video test,
   and the web UI import assertions.
5. Docs. Then the manual Windows check.
