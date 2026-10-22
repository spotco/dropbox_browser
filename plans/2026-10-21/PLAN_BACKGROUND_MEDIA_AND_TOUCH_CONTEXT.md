# Plan: background cover art, waveform, and touch context menus

Date: 2026-10-21

## Scope

Three client-only changes. No server routes, uploads, or deletes.

1. Music cover art loads with the song metadata even when the window is blurred or the tab is hidden.
2. Audio visualization keeps loading while its section is expanded, including when the window is blurred or the tab is hidden.
3. On a touch screen, a long press opens the media-library context menu in the song/video library and the active playlist. The same menu stays a right-click menu on desktop. Music and video share this UI.

## Cover art

`artworkFetchAllowed()` in `assets/js/music/metadata.js` currently defers embedded art unless `document.hidden` is false and `state.windowFocused` is true. Metadata text already loads without that gate. The cover request is part of the same metadata read, and the media-session card uses the object URL it produces.

Remove the focus and visibility gate. Always resolve embedded art for the active song. Drop `windowFocused`, `pendingArtworkRemotePath`, and `resumeDeferredArtworkLoad`. Playback-UI paint throttling in `layout.js` stays as it is: an unfocused window may still paint the time display less often. That path is not the thumbnail.

## Audio visualization

The waveform controller starts work only when the Audio Visualization section is open and audio is playing. `music.js` additionally calls `waveformApi.deactivate()` on `visibilitychange` when the document is hidden, which cancels an expanded panel.

Stop tying waveform start/stop to tab visibility or window focus. Collapsing the section, changing songs, and leaving the music pane still cancel the in-flight request. Returning to the music pane still resumes an expanded panel.

## Touch context menu

Desktop keeps `contextmenu` (right-click) on library rows and active-playlist rows. A primary touch pointer held about 500ms, without moving more than a short slop, opens that same menu. Movement, a short tap, folder-expand buttons, and playlist drag handles do not.

The release that follows a long press must not activate a menu item and must not hit the document click handler that closes the menu. Submenus today open on hover. On a touch open, tapping a parent row toggles its submenu inside the menu, with at least a 44px row height, and the menu scrolls if it is taller than the screen. Hover flyouts stay on mouse opens.

Both players use `media-library/library.js` and `media-library/playlist.js`, so one implementation covers music and video.

## Landed

Cover art no longer waits on focus or tab visibility. An expanded waveform is
no longer cancelled by either. Touch long-press opens the shared library and
active-playlist menus for music and video; mouse right-click is unchanged, and
a touch open toggles submenus in the menu instead of using hover.

## File browser columns and the bottom pane at load

Verified in the current Brave tab, mobile viewport 360×800, on
`http://localhost:8000/`. Saved browse preferences were all seven columns at
16px. That 16px floor is the existing handle minimum and stays.

Loading with the music pane already minimized (`log-panel-minimized: true`,
not full window) measures the browse shell at 328px. Those saved 16px
preferences are scaled across that width (about 47px each). Dragging the Name
divider 80px to the right moves Name from 47px to 127px. Columns are resizable.

Loading with the bottom pane full screen (`bottom-panel-full-window: true`,
`body.bottom-panel-full-window-mode`, `main` is `display: none`) measures the
shell at 0. Column setup runs once at that moment and fits every column to
16px. Minimizing then shows the shell at 328px and the table stretches
visually, but the column model stays at 16px. The same 80px drag leaves every
column at 16px, because each neighbor is already on the minimum and has
nothing to give. Leaving full window does not fire `window` `resize`, which is
the only refit today.

On a phone this shows up easily: a non-minimized pane taller than the viewport
also enters full window on load (`restore-overflow`), so the launch state of
the bottom pane decides whether file-browser dividers work. It must not.
Whatever the pane is doing at load, once the shell has a width the columns fit
that width and stay draggable down to the same 16px minimum.

Landed: the browse shell is observed directly. A hidden shell (width 0) does
not become the fitted layout, and gaining a width refits from the saved
preferences. A minimized load is unchanged. The 16px minimum is unchanged.

## Active playlist double-tap on touch

On a touch screen, double-tapping a song in the active playlist no longer
plays it. Playlist rows (and library rows) use `touch-action: manipulation`
so a finger can scroll and a long-press is not treated as a double-tap zoom.
With that declaration the browser does not emit `dblclick` for touch, and
play is only wired to `dblclick` (`handlePlaylistListDoubleClick` →
`playPlaylistRemotePath`). A mouse double-click still plays. A long-press
still opens the context menu. A single tap still only selects the row.

The second short tap on the same playlist row, within about 500ms, plays
that row. A hold of about 500ms still opens the menu and does not play. The
drag handle is not a play target. If a browser also emits `dblclick` for that
touch, it does not start the song a second time.

Landed: playlist touch handling counts that second tap as play. A held touch
still opens the menu. Mouse double-click still plays.

The library tree has the same gap. Desktop double-click on a song calls
`addSongToPlaylistAndPlay`. A touch double-tap did not, because the tree row
also uses `touch-action: manipulation` and never receives `dblclick`. A second
short tap on a library song must add that song and start it, the same as the
desktop double-click. A folder row and the expand button do not. A long-press
on a library row still opens the context menu. A mouse double-click still
adds and plays, and a touch that already did so does not add the song twice.

Landed: library touch handling uses that same second tap for add-and-play.
Long-press on the library is unchanged.

## Checks

- Node test for the long-press gesture: touch only, move cancels, short release does not fire, a held touch fires on release.
- Update the page-source assertions that require the old artwork focus gate.
- `npm run test:js`, then the web UI test that locks these strings.
