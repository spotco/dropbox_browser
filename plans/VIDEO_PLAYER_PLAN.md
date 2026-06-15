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
- Always use ffmpeg compatibility playback in the Video Player so audio track
  switching, subtitle switching, scrubber behavior, and logging stay consistent.
  If `ffmpeg`/`ffprobe` are unavailable, the Video Player shows no-playback
  messaging instead of falling back to native browser playback.
- Do not require a separate "Transcode" click for the first MKV workflow.
- Use HLS for ffmpeg compatibility playback, with vendored `hls.js` for
  Chrome/Edge support.
- Compatibility HLS sessions are seek-started. Initial playback starts ffmpeg at
  source time `0`; scrubbing starts a new ffmpeg/HLS session at the clicked
  source timestamp instead of waiting for a linear transcode from the beginning
  to catch up. The browser media element uses session-relative time while the
  custom scrubber displays original-video time as
  `session_start_seconds + media.currentTime`.
- Use WebVTT subtitle extraction/conversion first because it is lighter than
  subtitle burn-in and allows subtitle switching without full video restart.
- Accept that ASS/SSA styling may be lost in the first WebVTT implementation.
  Burn-in can be added later only for files that need subtitle styling fidelity.
- Changing the selected audio track restarts the compatibility playback session
  with a new ffmpeg stream mapping at the current original-video timestamp.
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
- Client-side video diagnostics should go through the shared client log system
  using the `video` subsystem. Use `Temp/client_logs.jsonl` for browser/HLS
  events and `Temp/video_debug.jsonl` for server-side ffmpeg/session events.

## Debugging Notes

Video playback has two separate diagnostic streams:

- Browser/client diagnostics: `Temp/client_logs.jsonl`, controlled by
  `ClientLogEnabled` and `ClientLogSubsystems.video`.
- Server HLS/session diagnostics: `Temp/video_debug.jsonl`, controlled by
  `LogVideoDebug`.

For playback failures:

1. Restart the server after code/config changes so the page receives the latest
   client logging config.
2. Reproduce the playback failure once.
3. Inspect `Temp/client_logs.jsonl` for `video` entries around the failure time.
   Useful fields include HLS `type`, `details`, `reason`, fragment URL/SN,
   media `readyState`, media `networkState`, and current playback time.
4. Inspect `Temp/video_debug.jsonl` for session creation, playlist readiness,
   asset serving/missing events, ffmpeg early exits, and session replacement.
5. Inspect `Temp/video_sessions/<session-id>/stream.m3u8` and nearby
   `segment_*.ts` files when a fragment-specific error appears. `ffprobe` and
   `ffmpeg -f null -` against the segment or a short concat of segments are
   useful to distinguish corrupt output from browser/MSE rejection.

The Eureka Seven test file used during validation:

```text
anime/[bonkai77] Eureka Seven [BD-1080p] [DUAL-AUDIO] [x265] [HEVC] [AAC] [10bit] {FILTERED}/[bonkai77] Eureka Seven - Episode 01 [BD 1080p Dual Audio x265 10bit].mkv
```

Observed while debugging this file: ffmpeg can successfully produce a complete
HLS event playlist and all segments, while the browser still reports
compatibility playback failure. In that case, prioritize HLS.js fatal/recoverable
client log fields over assuming ffmpeg stopped. If a segment URL is named in the
client log, verify that segment exists, has nonzero size, and decodes with
ffmpeg before changing the HLS/session architecture.

Current HLS-session safeguards:

- Session creation waits for a playlist that references a segment and for that
  referenced segment file to exist.
- Segment asset requests wait briefly while the ffmpeg process is still alive.
- ffmpeg uses HLS `temp_file` output so the server does not expose partial
  segment files.
- The current architecture transcodes linearly only within the active session.
  Scrubbing no longer waits for earlier segments in that session; it replaces
  the active session with a new ffmpeg process started at the requested source
  timestamp via `-ss`.
- Client diagnostics log scrub requests and seek-started session readiness with
  requested source time, session start time, media current time, and
  buffered/seekable ranges. Server diagnostics log session start time, playlist
  segment count, playlist edge seconds, ENDLIST status, and segment/playlist
  asset wait timing.

## Remaining Work

### Phase 1 - ffmpeg Discovery And Configuration

- [x] Add config support for optional `ffmpeg` and `ffprobe` paths.
- [x] Bundle ffmpeg like the existing bundled ImageMagick tooling.
- [x] Discover bundled `ffmpeg` and `ffprobe` first, then configured paths,
      adjacent binaries, and `PATH`.
- [x] Add a small adapter module, probably `dropbox_browser/video.py` or
      `dropbox_browser/ffmpeg.py`, for probe and compatibility playback command
      construction.
- [x] Expose a `/video/endpoints/status` endpoint reporting whether `ffmpeg`
      and `ffprobe` are available.
- [x] Keep app startup working when ffmpeg is missing; the Video Player should
      show native/limited support instead of crashing.
- [x] Add tests for ffmpeg discovery, missing-binary status, and explicit config
      paths.

### Phase 2 - Video Metadata Probe Endpoint

- [x] Add `/video/endpoints/probe?path=...&source=remote`.
- [x] Validate paths with `clean_rel_path`; reject parent segments.
- [x] Resolve remote paths using existing remote path normalization and
      Windows-safe matching behavior where applicable.
- [x] Run `ffprobe` against the remote `/file` URL or an rclone-backed ffmpeg
      input strategy.
- [x] Return structured stream metadata:
      video streams, audio streams, subtitle streams, language, title, codec,
      default flags, forced flags, and duration when available.
- [x] Mark a recommended default audio track and subtitle-off default.
- [x] Add tests with fake ffprobe JSON for dual-audio MKV metadata and subtitle
      metadata.

### Phase 3 - Current Folder Video List

- [x] Add `/video/endpoints/library?path=...` for video files and child folders
      under the current folder.
- [x] Support child-folder navigation inside the left video panel, similar to
      the music player library.
- [x] Avoid expensive Dropbox recursion during normal video-player load; fetch
      direct folder listings as the user navigates the left panel.
- [x] Include common video extensions:
      `.mkv`, `.mp4`, `.m4v`, `.webm`, `.mov`, `.avi`, `.ts`, `.m2ts`, `.wmv`.
- [x] Return file name, remote stream path, size, modified time, extension,
      preview URL, and whether compatibility playback is expected.
- [x] Keep listing behavior cache-friendly and avoid expensive Dropbox recursion.
- [x] Add tests for current-folder video filtering and stable filename sorting.

### Phase 4 - Bottom Pane Shell

- [x] Add `Video Player` to `#bottom-pane-mode`.
- [x] Add `video_player.html` template with three panels:
      current-folder videos, queue, playback.
- [x] Add `video.css` and `video.js` assets.
- [x] Register the new CSS and JS in `views.py`.
- [x] Keep the existing server log, file search, and music player modes
      unchanged.
- [x] Ensure pane mode persistence through existing `Settings` behavior.
- [x] Add web tests for the new pane option, template shell, and asset serving.

### Phase 5 - In-Memory Queue

- [x] Render current-folder videos in the left panel.
- [x] Support adding one or more selected videos to the middle queue.
- [x] Support queue play, remove, clear, and reorder enough for testing.
- [x] Support double-clicking a current-folder video to enqueue and play.
- [x] Track the active queue item and advance to the next item on playback end.
- [x] Keep queue state in browser memory only.
- [x] Add focused JavaScript tests for queue add/remove/reorder/play-next
      behavior.

### Phase 6 - Native Playback Path

- [x] Remove the native browser playback path from the Video Player.
- [x] Keep a `<video>` element for rendering, fullscreen, volume, and
      picture-in-picture APIs, but hide the browser-native control bar.
- [x] Route all Video Player playback through compatibility HLS.
- [x] Add a clear UI state when ffmpeg/ffprobe are unavailable.

### Phase 7 - HLS Compatibility Playback

- [x] Vendor `hls.js` locally under assets; do not hotlink a CDN.
- [x] Add a compatibility playback session endpoint, for example
      `/video/endpoints/session`.
- [x] Start an ffmpeg process that maps the selected video and audio stream to
      HLS output.
- [x] Write HLS playlists and segments under a constrained temp/session
      directory.
- [x] Cache HLS output only for the current playback session.
- [x] Serve HLS playlists and segments through constrained local endpoints.
- [x] Clean up compatibility session files and processes when playback stops,
      changes item, or expires.
- [x] Limit initial implementation to one active compatibility session per
      browser player if that keeps cleanup and resource use simpler.
- [x] Add tests for session creation, path confinement, HLS asset serving, and
      cleanup behavior.
- [x] Wait for the first referenced segment before returning a session payload.
- [x] Wait briefly for delayed segment asset requests while ffmpeg is alive.
- [x] Use ffmpeg HLS temp-file output to avoid serving partially written
      segments.
- [x] Add delayed-segment regression tests.
- [x] Accept `start_time_seconds` on compatibility session creation and pass it
      to ffmpeg as an input seek.
- [x] Return `start_time_seconds` in the session payload so the browser can map
      session-relative media time to original-video time.
- [x] Log playlist edge and asset wait timing for HLS debugging.

### Phase 8 - Audio Track Selection

- [x] Populate the audio-track selector from probe metadata.
- [x] Select the default audio stream from ffprobe default flags when present.
- [x] Restart the HLS compatibility session when the selected audio track
      changes.
- [x] Preserve the current original-video playback position when restarting for
      audio track changes.
- [x] Show track labels using language, title, codec, and stream index.
- [x] Add tests for ffmpeg stream mapping command construction.

### Phase 9 - Subtitle Track Selection

- [x] Populate the subtitle selector from probe metadata.
- [x] Include a `Subtitles Off` option.
- [x] Add a WebVTT extraction endpoint, for example
      `/video/endpoints/subtitles?path=...&source=remote&track=...`.
- [x] Run ffmpeg to extract/convert the selected subtitle stream to WebVTT.
- [x] Attach the generated WebVTT URL as a `<track kind="subtitles">` on the
      video element.
- [x] Switch subtitle tracks without restarting the video when possible.
- [x] Show a video-player error when subtitle extraction or WebVTT conversion
      fails.
- [x] Add tests for subtitle command construction, WebVTT content type, and
      path/track validation.

### Phase 10 - Fullscreen And Playback Ergonomics

- [x] Add a playback scrubber backed by native duration when available and
      ffprobe duration for compatibility HLS when native duration is unavailable.
- [x] Add custom play/pause, volume, fullscreen, and picture-in-picture controls
      so the native browser scrubber is not shown.
- [x] Back the scrubber with ffprobe duration for compatibility HLS, avoiding
      temporary 0:06 live/event playlist durations.
- [x] Restart compatibility playback from the clicked scrubber position instead
      of assigning `video.currentTime` beyond the generated playlist edge.
- [x] Add seek diagnostics to client logs.
- [x] Add a fullscreen button for the playback panel.
- [x] Use the browser Fullscreen API on the video element, not the whole page.
- [ ] Ensure bottom-pane resizing still works when leaving fullscreen.
- [ ] Keep video aspect ratio stable inside the playback panel.
- [ ] Add keyboard-safe focus behavior for queue rows and playback controls.
- [ ] Add a browser smoke test for opening Video Player, loading current-folder
      videos, and entering/exiting fullscreen where Playwright supports it.
- [x] Add a seek-aware compatibility playback design for arbitrary far-ahead HLS
      seeking.

### Phase 11 - First MKV Validation

- [x] Configure ffmpeg/ffprobe on the development machine.
- [x] Open the first example Eureka Seven folder and load the Video Player.
- [x] Confirm the target MKV appears in the current-folder video list.
- [x] Probe the target MKV and confirm video/audio/subtitle streams appear.
- [ ] Play the MKV through HLS compatibility mode through the full episode.
- [ ] Switch audio tracks and confirm playback restarts with the selected audio.
- [ ] Select a subtitle track and confirm WebVTT subtitles display.
- [ ] Open the Detective Conan Season 1 folder and repeat the same validation.
- [ ] Capture any unsupported codec/subtitle failures as follow-up items rather
      than expanding scope before first playback works.
- [ ] Use `Temp/client_logs.jsonl` and `Temp/video_debug.jsonl` to diagnose the
      observed compatibility failure around early playback.

### Phase 12 - Follow-Up Playlist Features

- [ ] Add better multi-select behavior in the current-folder video list.
- [ ] Add richer queue sorting and bulk actions.
- [ ] Add optional persisted video playlists after the in-memory queue is stable.
- [ ] Consider recursive folder loading after direct-folder playback is stable.
- [ ] Consider burn-in subtitle fallback for ASS/SSA tracks that lose important
      styling when converted to WebVTT.
- [ ] Consider local-source video playback after remote-source playback is
      stable.
