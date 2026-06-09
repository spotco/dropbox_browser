# Video Player Bottom Pane Plan

## Goal

Add a `Video Player` mode to the bottom pane that can play remote Dropbox video
files from the current folder, with first-testable support focused on the two
remote MKV examples discussed in planning:

- `anime/[bonkai77] Eureka Seven [BD-1080p] [DUAL-AUDIO] [x265] [HEVC] [AAC] [10bit] {FILTERED}/[bonkai77] Eureka Seven - Episode 01 [BD 1080p Dual Audio x265 10bit].mkv`
- `anime/[PsyPlex] Detective Conan 1-1006 + Movies 1-23 Batch/Season 1/Detective Conan - S01E01 - Roller Coaster Murder Case SDTV-Judas.mkv`

The first usable milestone must support:

- remote-only playback;
- MKV compatibility playback through server-side ffmpeg;
- audio track detection and selection;
- subtitle track detection and selection;
- WebVTT subtitle extraction/conversion where possible;
- fullscreen playback from the bottom-pane video area;
- a simple in-memory queue.

Playlist persistence and richer queue management can come later after MKV
playback and track control are proven.

## Decisions

- Use a new bottom-pane mode named `video-player`.
- Keep video separate from the existing music player implementation. Reuse ideas
  from the music player, but do not mix music and video state or endpoints.
- Initial support is remote-only. Local video playback can be added later.
- Add a server-side ffmpeg dependency. Discover `ffmpeg` and `ffprobe` together,
  preferably from the same configured directory or from `PATH`.
- Bundle ffmpeg in the repo the same way ImageMagick is bundled, with config and
  discovery falling back to `PATH` when the bundled binaries are unavailable.
- Use `ffprobe` to inspect video, audio, and subtitle streams.
- Use existing `/file` range streaming for browser-native playable files.
- Automatically use ffmpeg compatibility playback for `.mkv` files and any file
  that is likely unsupported natively.
- Do not require a separate "Transcode" click for the first MKV workflow.
- Use HLS for ffmpeg compatibility playback, with vendored `hls.js` for
  Chrome/Edge support.
- Use WebVTT subtitle extraction/conversion first because it is lighter than
  subtitle burn-in and allows subtitle switching without full video restart.
- Accept that ASS/SSA styling may be lost in the first WebVTT implementation.
  Burn-in can be added later only for files that need subtitle styling fidelity.
- Changing the selected audio track restarts the compatibility playback session
  with a new ffmpeg stream mapping.
- Changing the selected subtitle track updates the active WebVTT track where
  possible.
- The first queue is in browser memory only. Persisted video playlists are
  explicitly deferred.
- Queue UI follows the music player structure: current-folder files on the left,
  queue in the middle, playback and track controls on the right.
- Cache HLS compatibility output only for the current playback session. Clean it
  up when playback stops, the queue item changes, or the session expires.
- If subtitle extraction or WebVTT conversion fails, show an error in the video
  player area using a music-player-style status/error display.
- The left panel should include child-folder navigation, similar to the music
  player library, instead of showing only direct files.

## Remaining Work

### Phase 1 - ffmpeg Discovery And Configuration

- [ ] Add config support for optional `ffmpeg` and `ffprobe` paths.
- [ ] Bundle ffmpeg like the existing bundled ImageMagick tooling.
- [ ] Discover bundled `ffmpeg` and `ffprobe` first, then configured paths,
      adjacent binaries, and `PATH`.
- [ ] Add a small adapter module, probably `dropbox_browser/video.py` or
      `dropbox_browser/ffmpeg.py`, for probe and compatibility playback command
      construction.
- [ ] Expose a `/video/endpoints/status` endpoint reporting whether `ffmpeg`
      and `ffprobe` are available.
- [ ] Keep app startup working when ffmpeg is missing; the Video Player should
      show native/limited support instead of crashing.
- [ ] Add tests for ffmpeg discovery, missing-binary status, and explicit config
      paths.

### Phase 2 - Video Metadata Probe Endpoint

- [ ] Add `/video/endpoints/probe?path=...&source=remote`.
- [ ] Validate paths with `clean_rel_path`; reject parent segments.
- [ ] Resolve remote paths using existing remote path normalization and
      Windows-safe matching behavior where applicable.
- [ ] Run `ffprobe` against the remote `/file` URL or an rclone-backed ffmpeg
      input strategy.
- [ ] Return structured stream metadata:
      video streams, audio streams, subtitle streams, language, title, codec,
      default flags, forced flags, and duration when available.
- [ ] Mark a recommended default audio track and subtitle-off default.
- [ ] Add tests with fake ffprobe JSON for dual-audio MKV metadata and subtitle
      metadata.

### Phase 3 - Current Folder Video List

- [ ] Add `/video/endpoints/library?path=...` for video files and child folders
      under the current folder.
- [ ] Support child-folder navigation inside the left video panel, similar to
      the music player library.
- [ ] Avoid expensive Dropbox recursion during normal video-player load; fetch
      direct folder listings as the user navigates the left panel.
- [ ] Include common video extensions:
      `.mkv`, `.mp4`, `.m4v`, `.webm`, `.mov`, `.avi`, `.ts`, `.m2ts`, `.wmv`.
- [ ] Return file name, remote stream path, size, modified time, extension,
      preview URL, and whether compatibility playback is expected.
- [ ] Keep listing behavior cache-friendly and avoid expensive Dropbox recursion.
- [ ] Add tests for current-folder video filtering and stable filename sorting.

### Phase 4 - Bottom Pane Shell

- [ ] Add `Video Player` to `#bottom-pane-mode`.
- [ ] Add `video_player.html` template with three panels:
      current-folder videos, queue, playback.
- [ ] Add `video.css` and `video.js` assets.
- [ ] Register the new CSS and JS in `views.py`.
- [ ] Keep the existing server log, file search, and music player modes
      unchanged.
- [ ] Ensure pane mode persistence through existing `Settings` behavior.
- [ ] Add web tests for the new pane option, template shell, and asset serving.

### Phase 5 - In-Memory Queue

- [ ] Render current-folder videos in the left panel.
- [ ] Support adding one or more selected videos to the middle queue.
- [ ] Support queue play, remove, clear, and reorder enough for testing.
- [ ] Support double-clicking a current-folder video to enqueue and play.
- [ ] Track the active queue item and advance to the next item on playback end.
- [ ] Keep queue state in browser memory only.
- [ ] Add focused JavaScript tests for queue add/remove/reorder/play-next
      behavior.

### Phase 6 - Native Playback Path

- [ ] Add a `<video>` element in the playback panel with normal controls.
- [ ] Use existing `/file?path=...&source=remote` for files that can play
      natively.
- [ ] Use `video.canPlayType()` as a hint, not as the only compatibility
      decision.
- [ ] Treat `.mkv` as compatibility-mode by default even if a browser returns
      ambiguous support.
- [ ] Preserve seekable playback through current `/file` byte-range behavior.
- [ ] Add a clear UI state when a file cannot be played natively and ffmpeg is
      unavailable.

### Phase 7 - HLS Compatibility Playback

- [ ] Vendor `hls.js` locally under assets; do not hotlink a CDN.
- [ ] Add a compatibility playback session endpoint, for example
      `/video/endpoints/session`.
- [ ] Start an ffmpeg process that maps the selected video and audio stream to
      HLS output.
- [ ] Write HLS playlists and segments under a constrained temp/session
      directory.
- [ ] Cache HLS output only for the current playback session.
- [ ] Serve HLS playlists and segments through constrained local endpoints.
- [ ] Clean up compatibility session files and processes when playback stops,
      changes item, or expires.
- [ ] Limit initial implementation to one active compatibility session per
      browser player if that keeps cleanup and resource use simpler.
- [ ] Add tests for session creation, path confinement, HLS asset serving, and
      cleanup behavior.

### Phase 8 - Audio Track Selection

- [ ] Populate the audio-track selector from probe metadata.
- [ ] Select the default audio stream from ffprobe default flags when present.
- [ ] Restart the HLS compatibility session when the selected audio track
      changes.
- [ ] Preserve current queue item and reset playback position on first
      implementation; resume-position support can come later.
- [ ] Show track labels using language, title, codec, and stream index.
- [ ] Add tests for ffmpeg stream mapping command construction.

### Phase 9 - Subtitle Track Selection

- [ ] Populate the subtitle selector from probe metadata.
- [ ] Include a `Subtitles Off` option.
- [ ] Add a WebVTT extraction endpoint, for example
      `/video/endpoints/subtitles?path=...&source=remote&track=...`.
- [ ] Run ffmpeg to extract/convert the selected subtitle stream to WebVTT.
- [ ] Attach the generated WebVTT URL as a `<track kind="subtitles">` on the
      video element.
- [ ] Switch subtitle tracks without restarting the video when possible.
- [ ] Show a video-player error when subtitle extraction or WebVTT conversion
      fails.
- [ ] Add tests for subtitle command construction, WebVTT content type, and
      path/track validation.

### Phase 10 - Fullscreen And Playback Ergonomics

- [ ] Add a fullscreen button for the playback panel.
- [ ] Use the browser Fullscreen API on the video shell, not the whole page.
- [ ] Ensure bottom-pane resizing still works when leaving fullscreen.
- [ ] Keep video aspect ratio stable inside the playback panel.
- [ ] Add keyboard-safe focus behavior for queue rows and playback controls.
- [ ] Add a browser smoke test for opening Video Player, loading current-folder
      videos, and entering/exiting fullscreen where Playwright supports it.

### Phase 11 - First MKV Validation

- [ ] Configure ffmpeg/ffprobe on the development machine.
- [ ] Open the first example Eureka Seven folder and load the Video Player.
- [ ] Confirm the target MKV appears in the current-folder video list.
- [ ] Probe the target MKV and confirm video/audio/subtitle streams appear.
- [ ] Play the MKV through HLS compatibility mode.
- [ ] Switch audio tracks and confirm playback restarts with the selected audio.
- [ ] Select a subtitle track and confirm WebVTT subtitles display.
- [ ] Open the Detective Conan Season 1 folder and repeat the same validation.
- [ ] Capture any unsupported codec/subtitle failures as follow-up items rather
      than expanding scope before first playback works.

### Phase 12 - Follow-Up Playlist Features

- [ ] Add better multi-select behavior in the current-folder video list.
- [ ] Add richer queue sorting and bulk actions.
- [ ] Add optional persisted video playlists after the in-memory queue is stable.
- [ ] Consider recursive folder loading after direct-folder playback is stable.
- [ ] Consider burn-in subtitle fallback for ASS/SSA tracks that lose important
      styling when converted to WebVTT.
- [ ] Consider local-source video playback after remote-source playback is
      stable.
