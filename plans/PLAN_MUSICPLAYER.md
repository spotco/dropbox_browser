# Music Player Implementation Plan

This file tracks upcoming music-player work only. Completed implementation and
test items have been moved to `plans/COMPLETED_MUSICPLAYER.md`.

## Progress

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
- [ ] Implement iPhone-style playback controls markup.
- [ ] Implement browser-side playback progress, seeking, metadata, art, and
  persisted volume behavior.
- [ ] Add focused tests.
- [ ] Run targeted checks.

## Step 1 - Playback Controls Markup

- [ ] Read `docs/architecture.md` and `docs/testing.md` before editing the
  playback template and UI contract tests.
- [ ] Update `dropbox_browser/assets/templates/music_player.html` inside
  `#music-playback-pane` only.
- [ ] Replace the current simple controls layout with an iPhone-style stacked
  control surface:
  - top now-playing row with cover-art placeholder on the left;
  - filename, title, and artist text block on the right;
  - scrubber/progress slider row;
  - elapsed and total time labels below the scrubber;
  - previous, play/pause, and next transport buttons;
  - shuffle and loop toggle buttons;
  - horizontal volume slider.
- [ ] Keep the hidden `<audio id="music-audio">` element as the playback engine.
- [ ] Keep existing element IDs where practical for compatibility, especially:
  `music-current-filename`, `music-prev`, `music-play`, `music-pause`,
  `music-next`, `music-shuffle-toggle`, `music-loop-toggle`, and `music-audio`.
- [ ] Add new stable IDs for:
  - song title;
  - song artist;
  - cover-art image/placeholder state;
  - progress slider;
  - elapsed time label;
  - total time label;
  - volume slider.
- [ ] Use accessible labels or titles for icon-only controls.
- [ ] Preserve the existing library and playlist panes unchanged.

## Step 2 - Local Playback Icon Assets

- [ ] Identify reasonable SVG icons for previous, play, pause, next, shuffle,
  loop, and volume.
- [ ] Vendor the icon files locally under
  `dropbox_browser/assets/icons/material-icon-theme/` so they can be served by
  the existing constrained icon handler.
- [ ] Do not hotlink external icons.
- [ ] Preserve or update local icon attribution files if the chosen icon source
  requires it.
- [ ] Render icon controls through local `/assets/icons/material-icon-theme/*.svg`
  URLs.
- [ ] Add or update web UI tests proving the expected local icon URLs are present
  and served.

## Step 3 - Playback Controls Styling

- [ ] Update `dropbox_browser/assets/css/music.css` for the redesigned
  `music-playback-pane`.
- [ ] Match the attached iPhone playback-control structure while preserving the
  existing app visual language.
- [ ] Keep the control panel compact enough for the bottom pane.
- [ ] Use a square cover-art area with a clear placeholder state.
- [ ] Style filename, title, and artist text distinctly:
  - filename as the primary current file identifier;
  - title as metadata when available or a loading/unknown placeholder;
  - artist as metadata when available or a loading/unknown placeholder.
- [ ] Implement marquee/scroll behavior for overlong filename, title, and artist
  text.
- [ ] Make the progress slider visibly show current progress and allow dragging.
- [ ] Make enabled shuffle and loop states visually obvious through button
  state, `aria-pressed`, and CSS.
- [ ] Make disabled/inactive shuffle and loop states visually distinct.
- [ ] Ensure icon buttons have stable dimensions and do not resize the layout.
- [ ] Ensure text and controls do not overlap at desktop widths or the existing
  responsive breakpoint.

## Step 4 - Play/Pause Single Control

- [ ] Replace the current separate play and pause visible-button behavior with a
  single effective play/pause control.
- [ ] Keep compatibility with existing IDs where practical, or update tests if
  markup changes require a new canonical ID.
- [ ] When audio is paused or no song is loaded, show the play icon.
- [ ] When audio is playing, show the pause icon.
- [ ] Update icon state on:
  - starting playback;
  - pausing playback;
  - audio `play`;
  - audio `pause`;
  - audio `ended`;
  - clearing the current song;
  - playback errors.
- [ ] Preserve existing previous, next, shuffle, loop, and playlist behavior.

## Step 5 - Progress, Seeking, And Time Display

- [ ] Add audio event listeners for `loadedmetadata`, `durationchange`,
  `timeupdate`, `seeking`, `seeked`, `play`, `pause`, and `ended` as needed.
- [ ] Format elapsed and total duration as `HH:MM:SS`.
- [ ] Show `00:00:00` while duration or current time is unavailable.
- [ ] Keep the progress slider minimum at `0`.
- [ ] Set the progress slider maximum from `audio.duration` when finite.
- [ ] Update progress slider value as playback advances.
- [ ] Pause automatic slider updates while the user is dragging the scrubber.
- [ ] On scrubber input/change, seek the audio element to the selected time.
- [ ] Handle unknown or streaming durations without throwing or displaying `NaN`.
- [ ] Reset progress and time display when the current song is cleared.

## Step 6 - Persisted Volume

- [ ] Initialize audio volume from `Settings.get('music-volume', defaultVolume)`.
- [ ] Clamp restored volume to the valid browser range `0.0` through `1.0`.
- [ ] Bind the horizontal volume slider to `audio.volume`.
- [ ] Persist changes with `Settings.set('music-volume', volume)`.
- [ ] Apply the persisted volume before starting playback.
- [ ] Keep volume persistence local to this Dropbox browser app through the
  existing `Settings` prefix.
- [ ] Add UI contract tests for `Settings.get('music-volume'` and
  `Settings.set('music-volume'`.

## Step 7 - Browser-Side Metadata Loading

- [ ] Add client-side metadata state to `dropbox_browser/assets/js/music.js`.
- [ ] When a song becomes current, immediately show loading placeholders for
  title, artist, and cover art.
- [ ] Fetch metadata asynchronously in the browser using the existing `/file`
  stream URL for the selected remote song.
- [ ] Prefer range requests where practical so metadata parsing does not require
  downloading entire large audio files.
- [ ] Keep all metadata work non-blocking relative to playback start.
- [ ] Cancel or ignore stale metadata results when the user switches songs before
  parsing completes.
- [ ] Start with common browser-side parsing paths for supported formats:
  - MP3 ID3v2 title, artist, and embedded APIC cover art;
  - M4A/MP4 title, artist, and embedded cover art atoms where practical;
  - WAV INFO title/artist where practical.
- [ ] If metadata cannot be read, keep filename as the reliable identifier and
  show unknown/placeholder title, artist, and cover art.
- [ ] Do not add server-side preview/download caching for metadata.
- [ ] Do not add Python package or runtime dependencies for metadata extraction.

## Step 8 - Embedded Cover Art

- [ ] Display embedded cover art when browser-side metadata parsing finds it.
- [ ] Convert embedded image bytes to a browser object URL or data URL.
- [ ] Revoke old object URLs when switching songs to avoid leaking memory.
- [ ] Keep the placeholder visible while metadata is loading.
- [ ] Keep the placeholder visible when no embedded art exists or parsing fails.
- [ ] Avoid layout shifts between placeholder and loaded cover art.
- [ ] Add error handling for unsupported embedded image MIME types.

## Step 9 - Playlist And Current Song Integration

- [ ] Update `playPlaylistIndex()` so it resets and repopulates the new now-playing
  metadata fields.
- [ ] Keep filename display based on the selected playlist row immediately, even
  before metadata loads.
- [ ] Keep current playlist row highlighting unchanged.
- [ ] Keep double-click library song behavior:
  - add to playlist if missing;
  - select and scroll to the playlist row;
  - play immediately.
- [ ] Ensure removing the current song resets progress, metadata, art, and
  play/pause state before advancing or clearing playback.
- [ ] Ensure playback errors update the status without breaking the control UI.

## Step 10 - Tests

- [ ] Update `tests/test_web_ui.py` for the redesigned playback markup.
- [ ] Add tests for the new playback control IDs.
- [ ] Add tests for local icon URLs and removal of text-only transport controls.
- [ ] Add tests for the progress slider, elapsed/total time labels, and volume
  slider markup.
- [ ] Add tests for persisted volume JavaScript contracts.
- [ ] Add tests for play/pause icon state JavaScript contracts.
- [ ] Add tests for metadata loading placeholders and stale-result protection
  contracts where practical.
- [ ] Keep tests dependency-free and stdlib-based.

## Step 11 - Verification

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

## Open Questions

- None
