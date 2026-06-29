# Video Playback CPU Control Plan

## Goal

Reduce CPU usage during remote video compatibility playback while preserving the
current remote-only design. Playback should still recover quickly when the user
is near the end of loaded media, but ffmpeg should stop racing far ahead when a
large loaded section is already available.

Primary target:

- Remote MKV/MP4 playback through the existing ffmpeg-generated HLS session.
- Weaker computers where current ffmpeg sessions can consume 100% CPU.

Success criteria:

- Startup and seek recovery can briefly use higher CPU to build a useful buffer.
- Long background encode-ahead work is bounded or paced.
- Compatible media avoids unnecessary video/audio transcoding where possible.
- Burned-in subtitles keep the current compatibility behavior, even when that
  requires video transcoding.

## Current State

`build_ffmpeg_hls_command()` always transcodes video to x264 and audio to AAC:

- `-c:v libx264`
- `-preset ultrafast`
- `-crf 23`
- `-c:a aac`
- unbounded HLS event playlist with `-hls_list_size 0`

Recent `Temp/video_debug.jsonl` sessions show ffmpeg encoding far faster than
realtime. One full episode reached `#EXT-X-ENDLIST` about a minute after
playback started, so high CPU is expected from the current command shape.

The client already polls `/video/endpoints/status` and tracks
`encoded_media_end_seconds`. The missing pieces are CPU/pacing controls and
server-side backpressure.

## Non-Negotiable Principles

- The video player remains remote-only. Do not stream from a local media file.
- Keep `/file` and `/download` byte-range behavior intact.
- Do not break HLS seeking, restart, or recovery behavior.
- Do not use local uploads or introduce browser upload behavior.
- Burned-in subtitles require video filtering and therefore cannot use video
  stream copy.

## Phase 1 - Add Static ffmpeg Input Pacing

- [x] Add video CPU/pacing defaults to app config:
      `VideoFFmpegReadRate`, `VideoFFmpegInitialBurstSeconds`, and
      `VideoFFmpegCatchupReadRate`.
- [x] Load and validate those values in config code using conservative clamps.
- [x] Add measurement tooling before choosing defaults:
      a script or developer command that runs representative remote playback
      sessions and records startup time, segment production rate, encoded-ahead
      seconds, HLS stalls/loading events, ffmpeg process CPU, and wall-clock
      encode speed.
- [x] Add measurement output under generated state such as `Temp/` so benchmark
      results are inspectable but not committed.
- [x] Measure at least these scenarios before picking defaults:
      current unpaced behavior, conservative pacing, moderate pacing, weak-CPU
      thread limits, H.264 video-copy candidates, and full transcode sessions.
- [x] Choose default pacing values from measurement results, optimizing for no
      playback stutter/loading while keeping CPU reasonable after the initial
      buffer is loaded.
- [x] Add optional ffmpeg input pacing flags before `-i` in
      `build_ffmpeg_hls_command()`:
      `-readrate`, `-readrate_initial_burst`, and `-readrate_catchup`.
- [x] Keep pacing disabled or minimal when configured read rate is `0` or
      blank, so troubleshooting can temporarily restore current behavior.
- [x] Document the measured default values and the test data that justified
      them.
- [x] Add command-construction tests proving pacing flags appear before `-i`.
- [x] Add tests proving disabled pacing omits all pacing flags.
- [x] Update `docs/video-player.md` with the new config keys and behavior.

## Phase 2 - Add ffmpeg CPU / Thread Bounds

- [x] Add config values for CPU bounds:
      `VideoFFmpegThreads` and `VideoFFmpegFilterThreads`.
- [x] Pick reasonable initial thread defaults before measurement:
      start with ffmpeg automatic thread behavior unless measurements show it
      is too aggressive, and make explicit low thread counts configurable for
      weaker machines. Final default after the ASUS and Surface Book 3 matrix:
      `VideoFFmpegThreads = 2`, `VideoFFmpegFilterThreads = 1`.
- [x] Include thread-count variants in the measurement tooling so defaults can
      be adjusted from real playback data rather than guesswork.
- [x] Apply `-threads <N>` to the ffmpeg output/encoder command when configured.
- [x] Apply `-filter_threads <N>` and `-filter_complex_threads <N>` when
      configured, especially for burned-in subtitle filter graphs.
- [x] Clamp thread values to safe integers and treat `0` or blank as ffmpeg
      default behavior.
- [x] Add command-construction tests for thread flags.
- [x] Add tests proving invalid or disabled thread config does not emit broken
      ffmpeg arguments.
- [x] Document the tradeoff: lower thread counts reduce peak CPU but may make
      realtime encode impossible on slow hardware.

## Phase 3 - Start ffmpeg At Lower OS Priority

- [x] Add Windows process-priority support in `VideoSessionManager.create_session`
      when spawning ffmpeg.
- [x] Pick a reasonable initial Windows priority default before measurement:
      below-normal by default, with idle and normal available through config.
- [x] Include priority variants in the measurement/manual validation pass so the
      default can be adjusted based on playback smoothness and system
      responsiveness.
- [x] Use `subprocess.BELOW_NORMAL_PRIORITY_CLASS` or
      `subprocess.IDLE_PRIORITY_CLASS` according to config.
- [x] Keep non-Windows behavior unchanged unless a portable low-priority option
      is added later.
- [x] Add tests around the computed `subprocess.Popen` kwargs without requiring
      a real ffmpeg process.
- [x] Include the selected priority in `session_create_start` diagnostics when
      video debug logging is enabled.
- [x] Document that process priority improves system responsiveness but does not
      itself reduce total ffmpeg work.

## Phase 4 - Copy Compatible Video Streams

- [x] Extend probe compatibility helpers to identify browser/HLS-safe H.264
      video streams.
- [x] Make the H.264 copy decision opportunistic and compatibility-first:
      use video copy for as many H.264 variants as are expected to work, because
      avoiding video transcode is a major CPU win.
- [x] Treat video stream copy as allowed only when no burned-in subtitle stream
      is selected.
- [x] Keep video transcode for:
      non-H.264 video, unknown compatibility, required pixel-format conversion,
      burned-in bitmap subtitles, or any active video filter.
- [x] Add a session mode marker to distinguish video-copy sessions from normal
      video-transcode sessions in server payloads and diagnostics.
- [x] Add client recovery behavior for copy-mode playback failures:
      if hls.js or the browser reports fatal media/codec playback failure for a
      video-copy session, restart the same session request with video transcode
      forced.
- [x] Add server request support for forcing video transcode on retry, without
      changing the selected audio/subtitle streams or playback position.
- [x] Add safeguards to avoid infinite copy/transcode retry loops for the same
      playback item and timestamp.
- [x] Change HLS command construction to choose `-c:v copy` when probe metadata
      says the selected video stream is safe.
- [x] Preserve keyframe/segment behavior for copy mode; verify whether
      `-force_key_frames` must be omitted when `-c:v copy` is used.
- [x] Add session creation plumbing so `build_ffmpeg_hls_command()` receives the
      selected media compatibility decision, not just path and stream indices.
- [x] Add tests for H.264/no-burn-in sessions using `-c:v copy`.
- [x] Add tests proving burned-in subtitle sessions still use video transcode.
- [x] Add diagnostics indicating whether a session uses video copy or video
      transcode and why.

## Phase 5 - Copy Compatible Audio Streams

- [x] Extend probe compatibility helpers to identify AAC audio streams that are
      browser/HLS-safe for the selected audio track.
- [x] Make the AAC copy decision opportunistic and compatibility-first:
      use audio copy for as many AAC variants and channel layouts as are
      expected to work, because avoiding audio transcode also reduces CPU.
- [x] Change HLS command construction to choose `-c:a copy` when the selected
      audio stream is AAC/stereo-compatible.
- [x] Keep audio transcode for non-AAC codecs, unknown compatibility, or
      selected retry paths where the browser/player rejects copied audio.
- [x] Add a session mode marker to distinguish audio-copy sessions from normal
      audio-transcode sessions in server payloads and diagnostics.
- [x] Add client recovery behavior for copy-mode audio playback failures:
      if hls.js or the browser reports fatal media/codec playback failure for an
      audio-copy session, restart the same session request with audio transcode
      and downmix forced.
- [x] Add server request support for forcing audio transcode/downmix on retry,
      without changing the selected video/subtitle streams or playback position.
- [x] Add safeguards to avoid infinite audio copy/transcode retry loops for the
      same playback item and timestamp.
- [x] Omit audio normalization flags such as `-ac 2` and `-ar 48000` when
      `-c:a copy` is selected.
- [x] Add tests for AAC-compatible sessions using `-c:a copy`.
- [x] Add tests for non-AAC or incompatible audio still using AAC transcode.
- [x] Add diagnostics indicating whether a session uses audio copy or audio
      transcode and why.

## Phase 6 - Define Sliding-Scale Backpressure Contract

- [x] Define server-side session state for client playback position:
      current global playback seconds, update timestamp, paused/playing state,
      and last client sync token if useful.
- [x] Define a lightweight client-to-server update path, either by extending
      `/video/endpoints/status` or adding a small POST endpoint such as
      `/video/endpoints/session/progress`.
- [x] Define the initial backpressure thresholds:
      no throttle below the low watermark, mild throttle in the middle range,
      heavy throttle above the high watermark, and pause input beyond the max
      watermark.
- [x] Use reasonable initial sliding-scale thresholds:
      low `45s`, medium `120s`, high `300s`, and max `600s`.
- [ ] Include sliding-scale threshold variants in the measurement tooling and
      adjust defaults only if real playback validation shows stutter/loading or
      excessive post-buffer CPU.
- [x] Make thresholds config-driven from the start so weak-machine tuning does
      not require code changes.
- [x] Document the expected behavior around pause, seek, session replacement,
      and browser disconnect.

## Phase 7 - Tag ffmpeg Input Requests With Session Identity

- [x] Add `video_session_id=<session_id>` to the ffmpeg input URL generated in
      `VideoSessionManager.create_session()`.
- [x] Ensure `/file` still behaves normally when `video_session_id` is absent.
- [x] Validate that `video_session_id` only affects the active matching HLS
      session and cannot access arbitrary paths.
- [x] Add tests proving ordinary `/file` streaming is unchanged.
- [x] Add tests proving a tagged ffmpeg input request can be associated with the
      active video session.

## Phase 8 - Add Throttled Remote Copy For ffmpeg Input

- [x] Add a streaming copy helper for remote `/file` responses that can sleep or
      pause between chunks according to an active session throttle decision.
- [x] Keep the existing `copy_exact()` behavior for non-video-session requests.
- [x] Calculate encode-ahead from:
      `session.start_time_seconds + encoded_media_end_seconds -
      reported_playback_seconds`.
- [x] Use the existing playlist parsing path to update encoded media edge while
      streaming.
- [x] Kill or unblock the underlying rclone process promptly if the client
      disconnects or the HLS session is replaced.
- [x] Add diagnostics for throttle mode, ahead seconds, sleep duration, and
      stream cancellation.
- [x] Add unit tests for throttle decisions and copy-loop cancellation.

## Phase 9 - Report Playback Position From The Client

- [x] Add client polling or event-driven progress reports while compatibility
      playback is active.
- [x] Report global playback time, media current time, paused/playing state, and
      active session id.
- [x] Send updates more frequently near playback start and after seeks, then
      settle to a modest interval during steady playback.
- [x] Stop progress reports when the pane deactivates, the session stops, or the
      active item changes.
- [x] Add JS tests for progress-report scheduling and stale-session suppression.

## Phase 10 - Apply Sliding-Scale Policy

- [x] Implement the default sliding-scale policy:
      low watermark means no throttle, middle range means slow background load,
      high range means heavy throttle, max range means pause input.
- [x] Allow brief high CPU after startup, seek restart, or recovery until the
      low watermark is reached.
- [x] Resume faster input automatically when playback catches up or the user
      seeks near the encoded edge.
- [x] Ensure paused playback does not allow ffmpeg to continue encoding far
      ahead indefinitely.
- [x] Add tests for policy transitions:
      catch-up, steady playback, far-ahead pause, paused playback, and seek
      near edge.
- [x] Add a manual validation checklist using `Temp/video_debug.jsonl`, Task
      Manager CPU usage, and weak-machine playback.

Manual validation checklist:

- Start compatibility playback for a remote MKV/MP4 and confirm startup still reaches visible playback without prolonged loading.
- Let playback run past the initial startup burst, then inspect `Temp/video_debug.jsonl` for tagged input stream completion/cancellation rows with non-`unthrottled` throttle modes once encode-ahead grows.
- While playback is running, watch Task Manager and verify ffmpeg CPU drops after a useful ahead buffer is built instead of racing to the end immediately.
- Pause playback for at least 30-60 seconds and confirm ffmpeg does not continue expanding the encoded-ahead window indefinitely.
- Resume playback and confirm encode-ahead shrinks and then re-enters lighter throttle bands automatically.
- Scrub near the current encoded edge and confirm playback recovers promptly without remaining stuck in a heavy-throttle or pause-input state.
- Replace the session by switching items or subtitle burn-in mode and confirm the prior tagged input stream is cancelled promptly.

## Phase 11 - Test Matrix

- [x] Run compile checks:
      `python -m compileall -q dropbox_browser.py dropbox_browser`.
- [x] Run video endpoint tests:
      `python -m tests.run video -v`.
- [x] Run streaming tests if `/file` copy behavior changed:
      `python -m tests.run streaming -v`.
- [x] Run web UI tests if config/status payloads or player assets changed:
      `python -m tests.run web -v`.
- [x] Run JS tests if client progress reporting changed:
      `npm run test:js`.
- [x] Run video E2E checks before checkin when playback behavior changes:
      `npx playwright test --grep video`.
- [ ] Run full unittest discovery before broad handoff:
      `python -m unittest discover -s tests -v`.

## Open Decisions / Questions

- [x] Decide default pacing values:
      measure based on data instead of choosing constants upfront. Add
      measurement tooling and benchmark representative playback sessions, then
      choose defaults that avoid playback stutter/loading while keeping CPU
      reasonable after the initial load.
- [x] Decide default thread count:
      use a reasonable initial default, then measure. Start with ffmpeg
      automatic threads as the default, expose low fixed thread counts through
      config for weaker machines, and adjust the default only if measurement
      shows automatic threads are too aggressive. Final decision: ship
      `threads=2` and `filter_threads=1` with the conservative pacing profile
      because the Surface Book 3 HEVC case dropped from `~154.9%` to `~127.2%`
      mean ffmpeg CPU without stalls or a startup regression.
- [x] Decide default Windows process priority:
      use a reasonable initial default, then measure. Start ffmpeg below-normal
      by default on Windows, expose idle and normal through config, and adjust
      based on playback smoothness and system responsiveness measurements.
- [x] Decide H.264 compatibility strictness:
      prefer broad compatibility and use video stream copy as much as practical
      when it is expected to work, because it can save significant CPU. If a
      copy-mode session starts but the browser or hls.js reports that playback
      is not usable, automatically fall back to the normal video conversion path
      for that item/session.
- [x] Decide AAC compatibility strictness:
      use the same policy as video stream copy. Prefer broad AAC stream copy
      when it is expected to work, including multichannel AAC where practical,
      because it can save CPU. If a copy-mode session starts but the browser or
      hls.js reports playback is not usable, automatically fall back to normal
      AAC conversion/downmix for that item/session.
- [x] Decide sliding-scale thresholds:
      use reasonable initial defaults of low `45s`, medium `120s`, high `300s`,
      and max `600s`. Add these thresholds to the measurement plan and adjust
      them only if playback validation shows stutter/loading or excessive CPU
      after the initial load.
