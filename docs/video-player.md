# Video Player Architecture

The video player is a bottom-pane feature for browsing remote videos in the
current folder, queueing selections, and playing them through a local HLS
compatibility session. Playback always uses ffmpeg-generated HLS; the browser
does not stream remote files directly with native `<video src>`.

Server logic lives in `dropbox_browser/video.py` and `dropbox_browser/handlers.py`.
Client logic is split across ES modules under `dropbox_browser/assets/js/video/`,
loaded from a thin entry at `dropbox_browser/assets/js/video.js`.

## Request Flow

```text
Browser bottom pane (video.js entry)
  -> initX(ctx) modules in dropbox_browser/assets/js/video/
  -> fetch /video/endpoints/*
  -> handlers.serve_video_endpoint() / serve_video_endpoint_post()
  -> video.py helpers and VideoSessionManager
  -> ffmpeg HLS output under Temp/video_sessions/
  -> browser plays session playlist via hls.js
```

The page shell is rendered in `views.py` from `assets/templates/video_player.html`.
Only one script tag is included:

```html
<script type="module" src="/assets/js/video.js"></script>
```

Nested client modules import each other as `/assets/js/video/*.js`. The asset
handler already serves recursive paths under `/assets/js/` with JavaScript content
type.

## Server Architecture

### Ownership

| Concern | Module |
|---------|--------|
| Endpoint routing, JSON/VTT/HLS asset responses | `handlers.py` (`serve_video_endpoint`, `serve_video_endpoint_post`) |
| Probe, subtitle extraction, library listing, HLS session lifecycle | `video.py` |
| Disk caches for probe, subtitles, header bytes | `videocache.py` (`DiskCacheStore`) |
| Remote file byte streaming used as ffmpeg input | `/file` route + `streaming.py` |
| ffmpeg/ffprobe discovery | `config.py` (`video_tools_config`) |
| HTML shell and asset delivery | `views.py` |

Generated state under `Temp/` (not source artifacts):

- `Temp/video_sessions/<session_id>/` — active HLS playlist, init segment, media segments
- `Temp/subtitle_cache/` — extracted WebVTT on disk
- `Temp/probe_cache/` — ffprobe JSON cache
- `Temp/video_header_cache/` — header byte cache for probe acceleration
- `Temp/video_debug.jsonl` — server diagnostics when `LogVideoDebug` is enabled

### HTTP Endpoints

All routes are under `/video/endpoints/`.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `library?path=` | List video files in a remote folder |
| GET | `status` | Report ffmpeg/ffprobe availability and active session summary |
| GET | `probe?path=` | Return ffprobe metadata (streams, duration, codecs) |
| GET | `subtitles?path=&track=` | Extract one subtitle stream to WebVTT |
| GET | `subtitles/all?path=` | Batch-extract all WebVTT-compatible subtitle tracks |
| GET | `session/file?id=&name=` | Serve HLS playlist, init segment, or media segment |
| POST | `session` | Create a new HLS compatibility session |
| POST | `session/stop` | Stop the active session and clean up ffmpeg |

Session creation (`POST /video/endpoints/session`) accepts form fields:

- `path` — remote video path (required)
- `source` — must be `remote`
- `audio_stream_index` — optional ffmpeg audio stream index
- `subtitle_stream_index` — optional burned-in subtitle stream index
- `start_time_seconds` — seek target for the new session

The server builds an ffmpeg command that reads from the local `/file` URL for the
remote path, writes fMP4 HLS into `Temp/video_sessions/<uuid>/`, and returns a
playlist URL under `/video/endpoints/session/file`. Only one active session is
kept at a time; creating a new session stops the previous one.

`GET /video/endpoints/status` is polled by the client during playback to learn
`encoded_media_end_seconds` for the active session (how far ffmpeg has encoded
ahead of the session start).

### HLS Session Lifecycle

`VideoSessionManager` in `video.py`:

1. Resolves the remote file path and builds an input URL (`/file?path=...&source=remote`).
2. Spawns ffmpeg with `build_ffmpeg_hls_command(...)`.
3. Waits for `stream.m3u8` to become ready (longer timeout when burned-in subtitles are requested).
4. Serves playlist and segment files through `session/file`.
5. Rewrites the playlist's `#EXT-X-MAP` URI and injects `#EXT-X-START` when serving `.m3u8`.
6. Stops ffmpeg and deletes session directories on `session/stop`, session replace, expiry, or shutdown.

Segment duration is 6 seconds (`HLS_SEGMENT_DURATION_SECONDS`), shared with the
client pure module `video/compatibility-core.js`.

### Probe and Subtitles

`probe_remote_media()` uses ffprobe (with disk cache) to return audio/subtitle
stream layout, duration, and compatibility hints.

Subtitle extraction uses ffmpeg to produce WebVTT:

- Single-track: `GET /video/endpoints/subtitles`
- All compatible tracks in one pass: `GET /video/endpoints/subtitles/all`

Bitmap subtitle codecs are not mounted as sidecar WebVTT; those tracks require a
compatibility session restart with burned-in subtitles instead.

## Client Architecture

### Entry and Context

`video.js` builds a shared `ctx` object:

- `ctx.els` — DOM references for library, queue, playback surface, controls, debug panel
- `ctx.state` — mutable playback/library/queue/subtitle/session state
- `ctx.setStatus(text)` — updates the status bar

It calls `initX(ctx)` modules in dependency order, then wires only **global**
cross-app events:

- `bottom-pane-mode-changed` — activate or deactivate the video pane
- `browse-folder-changed` — reload library when the browse folder changes
- `beforeunload` — stop active session and clear recovery timers
- `video-playback-ended` (on the pane) — advance queue after natural playback end

Per-control DOM listeners live inside the modules that own the behavior, not in
the entry file.

### Module Layout

```text
dropbox_browser/assets/js/
  video.js                 # entry (~190 lines)
  video-core.js            # barrel re-export of pure *-core modules
  video/
    constants.js           # icons, timing, recovery, probe storage constants
    shared.js              # formatting, paths, loading overlay, queue helpers
    diagnostics.js         # client-log timing and diagnostic reporters
    library.js             # folder library fetch/render, playback status
    queue.js               # queue render/mutations, library/queue button listeners
    probe.js               # probe sessionStorage cache, metadata fetch
    tracks.js              # audio/subtitle selectors, preferences, change handlers
    compatibility.js       # Hls import, session create/stop, seek/restart, recovery
    subtitles.js           # VTT mount/cache/overlay/debug
    controls.js            # transport UI, progress scrubber, overlay listeners
    playback.js            # syncPlaybackForActiveItem orchestration
    pane.js                # syncPaneMode, pane lifecycle
    queue-core.js          # pure queue math
    compatibility-core.js  # seek decisions, duration, processed/seekable ranges
    webvtt-core.js         # WebVTT HTML rendering helpers
    vtt-parse-core.js      # WebVTT cue parsing and timing rebase
```

`video-core.js` re-exports the four `*-core.js` modules so unit tests and browser
code can import pure helpers from one path.

### Init Order

```text
initShared
  -> initDiagnostics
  -> initLibrary
  -> initQueue
  -> initProbe
  -> initTracks
  -> initCompatibility   # registers ctx.compatibilityApi
  -> initSubtitles        # uses compatibilityApi
  -> initControls
  -> initPlayback         # registers ctx.playbackApi
  -> initPane             # registers ctx.paneApi
```

### Cross-Module APIs

Modules expose a small `ctx.*Api` surface only where cross-module calls are
required:

| API | Owner | Used for |
|-----|-------|----------|
| `ctx.compatibilityApi.restartAt(seconds, reason)` | `compatibility.js` | Scrub, audio/subtitle track changes, recovery |
| `ctx.compatibilityApi.stopSession()` | `compatibility.js` | Pane deactivate, beforeunload, item changes |
| `ctx.playbackApi.syncForActiveItem()` | `playback.js` | Queue changes, pane activation |
| `ctx.subtitlesApi.applyForSeek(...)` | `subtitles.js` | Post-seek subtitle remount |
| `ctx.paneApi.syncPaneMode(mode)` | `pane.js` | Bottom pane mode changes |

### Playback Modes

The client supports compatibility playback only (no native remote streaming path).

Typical startup for the active queue item:

1. `playback.js` loads `/video/endpoints/status` and probe metadata.
2. `tracks.js` renders audio/subtitle selectors from probe payload.
3. `compatibility.js` posts `/video/endpoints/session` with selected tracks and start time.
4. hls.js attaches to the returned playlist URL on the `<video>` element.
5. `subtitles.js` preloads and mounts sidecar WebVTT when a WebVTT-compatible subtitle is selected.
6. `controls.js` syncs transport UI, progress bar, and overlay visibility.

Seeking uses `compatibility-core.js` to decide between in-session `video.currentTime`
adjustment and a full session restart. Restarts preserve transport intent and may
defer a follow-up seek when the user scrubs during an in-flight restart.

HLS errors and missing segments schedule recovery through `compatibility.js`, which
may restart the session when `compatibilityRecoveryRequiresSessionRestart()` says
a new ffmpeg session is required.

### Subtitles

Two subtitle paths:

- **Sidecar WebVTT** — fetched from `/video/endpoints/subtitles` or `/subtitles/all`,
  parsed by `vtt-parse-core.js`, rendered in the custom overlay via `webvtt-core.js`.
- **Burned-in** — selected bitmap or burn-in-required tracks set
  `subtitle_stream_index` on session create; ffmpeg embeds subtitles in the HLS output.

The client may wait for subtitle preload before revealing playback when a sidecar
track is selected at startup.

### Diagnostics

Client diagnostics post to `POST /client-log` with subsystem `video` or
`video-timing` (controlled by `ClientLogEnabled` / `ClientLogSubsystems` in config).
Server HLS/session events go to `Temp/video_debug.jsonl` when enabled.

## Testing

| Layer | Command |
|-------|---------|
| Pure JS helpers | `npm run test:js` — `video-core.test.js`, `video-vtt-parse.test.js` |
| Module import graph | `npm run test:js` — `video-modules.test.js` smoke imports |
| Server endpoints | `python -m tests.run video -v` |
| UI asset contracts | `python -m tests.run web -v` |
| Browser integration | `npx playwright test --grep video` (4 specs, 18 tests) |

When changing playback, subtitle, or HLS behavior, run the video e2e suite before
checkin. When changing pure seek/queue/WebVTT math, run the JS unit tests first.

## Related Docs

- Regression groups: `docs/testing.md` (`video`, `web` groups)
- General request/asset routing: `docs/architecture.md`
- Refactor plan (completed): `plans/PLAN_VIDEO_JS_REFACTOR.md`