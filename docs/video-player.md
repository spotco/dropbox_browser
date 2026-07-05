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

Video-related config in `config.json` / `config_local.json`:

- `VideoFFmpegReadRate` — optional ffmpeg `-readrate` multiplier for HLS input pacing.
- `VideoFFmpegInitialBurstSeconds` — optional `-readrate_initial_burst` startup burst.
- `VideoFFmpegCatchupReadRate` — optional `-readrate_catchup` recovery rate after stalls/seeks.
- `VideoFFmpegThreads` — optional ffmpeg encoder/output `-threads` value.
- `VideoFFmpegFilterThreads` — optional `-filter_threads` and
  `-filter_complex_threads` value, mainly useful for burned-in subtitle sessions.
- `VideoFFmpegProcessPriority` — Windows-only ffmpeg process priority:
  `below_normal` by default, with `idle` and `normal` also accepted.
- `VideoMaxConcurrentSessions` — maximum number of concurrent HLS sessions the
  server will keep alive before it must evict an idle session or reject a new
  session request.
- `VideoSessionIdleTtlSeconds` — idle lifetime used for session expiry and for
  deciding whether an older session is still active enough to protect from cap
  eviction.
- `VideoBackpressureLowWaterSeconds` — ahead-buffer point below which future
  server-side throttling should stay unthrottled.
- `VideoBackpressureMediumWaterSeconds` — middle watermark for mild throttling.
- `VideoBackpressureHighWaterSeconds` — high watermark for heavy throttling.
- `VideoBackpressureMaxWaterSeconds` — max watermark where future server-side
  input pausing can stop background encode-ahead work.

Current shipped defaults are tuned from the checked-in CPU benchmark matrix:
`readrate=1.1`, `initial_burst=18`, `catchup=1.3`, `threads=2`,
`filter_threads=1`, Windows priority `below_normal`, and backpressure
thresholds `45 / 120 / 300 / 600` seconds.

Pacing values are clamped conservatively in config loading. A read rate of `0`
or blank disables ffmpeg input pacing entirely and omits the related flags.
Thread values of `0` or blank keep ffmpeg's automatic thread behavior. Lower
fixed thread counts can reduce peak CPU use, but may make realtime encoding
impossible on slower machines or more complex files. The shipped `2 / 1`
thread defaults were chosen because they kept the Surface Book 3 HEVC transcode
case above realtime while reducing CPU compared with auto-thread pacing.
On Windows, process priority can make the desktop more responsive while ffmpeg
runs. It does not reduce total encode work; it only changes scheduling priority.
Concurrent compatibility sessions are not a shared encoder pool. Two HEVC
transcodes mean two separate ffmpeg processes doing separate decode/encode work,
and a burned-in subtitle transcode adds filter work on top of that. Session caps
therefore control real additive CPU, memory, and remote-read pressure rather
than virtual bookkeeping.
The backpressure thresholds are config-driven now even though throttle
enforcement lands in later phases. They are normalized into a nondecreasing
`low <= medium <= high <= max` sequence so weak-machine tuning does not require
code changes.

For CPU/pacing validation, `misc/benchmark_video_startup.py` can be run against a
running local server. It creates JSONL results under `Temp/video_benchmarks/` by
default and records probe/session startup timing, playlist segment growth,
encoded media edge, best-effort ffmpeg CPU samples, and video-related client log
events observed during the run.

### HTTP Endpoints

All routes are under `/video/endpoints/`.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `library?path=` | List video files in a remote folder |
| GET | `status` | Report ffmpeg/ffprobe availability plus session summaries and aggregate limits |
| GET | `probe?path=` | Return ffprobe metadata (streams, duration, codecs) |
| GET | `subtitles?path=&track=` | Extract one subtitle stream to WebVTT |
| GET | `subtitles/all?path=` | Batch-extract all WebVTT-compatible subtitle tracks |
| GET | `session/file?id=&name=` | Serve HLS playlist, init segment, or media segment |
| POST | `session` | Create a new HLS compatibility session |
| POST | `session/progress` | Update one session's playback position and paused/playing state |
| POST | `session/stop` | Stop one session and clean up its ffmpeg process |

Session creation (`POST /video/endpoints/session`) accepts form fields:

- `path` — remote video path (required)
- `source` — must be `remote`
- `audio_stream_index` — optional ffmpeg audio stream index
- `subtitle_stream_index` — optional burned-in subtitle stream index
- `start_time_seconds` — seek target for the new session
- `force_video_transcode` — optional retry knob (`1`) that disables H.264
  stream copy for that session request
- `force_audio_transcode` — optional retry knob (`1`) that disables AAC
  stream copy for that session request

Playback progress updates (`POST /video/endpoints/session/progress`) accept:

- `id` — session id
- `playback_seconds` — current global playback time in seconds
- `playback_media_seconds` — current `<video>` media time relative to that HLS session start
- `playback_state` — `playing`, `paused`, or `unknown`
- `playback_sync_token` — optional client sync token for stale-update suppression

The server builds an ffmpeg command that reads from the local `/file` URL for the
remote path, writes fMP4 HLS into `Temp/video_sessions/<uuid>/`, and returns a
playlist URL under `/video/endpoints/session/file`. Sessions are tracked by
session id, not by one global active owner, so multiple browsers or tabs can
keep separate HLS sessions alive at the same time.

When probe metadata says the selected video stream is browser/HLS-safe H.264 and
no burned-in subtitle stream is selected, the server uses `-c:v copy` and omits
transcode-only flags such as `-pix_fmt yuv420p` and `-force_key_frames`.
Otherwise it stays on the existing x264 transcode path. Session payloads and
diagnostics include `video_mode` (`video_copy` or `video_transcode`) plus
`video_mode_reason`.

When probe metadata says the selected audio stream is AAC, the server uses
`-c:a copy` and omits audio normalization flags such as `-ac 2` and
`-ar 48000`. Otherwise it stays on the existing AAC transcode path. Session
payloads and diagnostics include `audio_mode` (`audio_copy` or
`audio_transcode`) plus `audio_mode_reason`.

`GET /video/endpoints/status` is polled by the client during playback to learn
`encoded_media_end_seconds` for the relevant session (how far ffmpeg has encoded
ahead of that session start). The payload returns `active_sessions` with one
summary per live session, aggregate fields such as `session_count`,
`max_session_count`, and configured `backpressure_thresholds`, plus a temporary
`active_session` compatibility alias for the most recently active session. Each
session summary includes `client_playback` with the last reported global
playback seconds, media playback seconds, paused/playing state, report
timestamp, and optional client sync token. Stale progress POSTs stay harmless:
the endpoint returns `updated: false` plus a session lifecycle state such as
`missing`, `stopped`, `expired`, or `evicted` instead of mutating another
session.

### HLS Session Lifecycle

`VideoSessionManager` in `video.py`:

1. Resolves the remote file path and builds an input URL (`/file?path=...&source=remote`).
   ffmpeg-tagged input requests also include `video_session_id=<session_id>` so
   the `/file` route can associate remote reads with only the matching
   HLS session.
   Tagged requests now run through a session-aware copy loop that preserves
   ordinary `/file` behavior for untagged callers, computes encode-ahead from
   the owning session state, and aborts promptly if that tagged session is
   stopped, expired, evicted, or otherwise removed.
2. Spawns ffmpeg with `build_ffmpeg_hls_command(...)`, optionally adding
   ffmpeg input pacing flags before `-i` when `VideoFFmpegReadRate` is enabled.
   On Windows, ffmpeg is started with the configured process priority.
3. Waits for `stream.m3u8` to become ready (longer timeout when burned-in subtitles are requested).
4. Serves playlist and segment files through `session/file`.
5. Rewrites the playlist's `#EXT-X-MAP` URI and injects `#EXT-X-START` when serving `.m3u8`.
6. Stops ffmpeg and deletes session directories on `session/stop`, idle expiry,
   cap eviction, create failure, or shutdown.

Session limit policy is deliberate:

- If the configured session cap has free capacity, the new session is registered.
- If the cap is full but the oldest session is idle, that idle session is
  evicted and the new session is allowed to start.
- If the cap is full and every slot is still recently active, the server rejects
  the new request with `429 Too Many Requests` and
  `session_error_reason=all_sessions_active`.
- "Idle" is based on a combination of `last_accessed_at`, recent progress
  reports, and playback state. A session with recent `playing` or `paused`
  progress is protected from cap eviction even if another browser starts
  playback.

Segment duration is 6 seconds (`HLS_SEGMENT_DURATION_SECONDS`), shared with the
client pure module `video/compatibility-core.js`.

### Probe and Subtitles

`probe_remote_media()` uses ffprobe (with disk cache) to return audio/subtitle
stream layout, duration, and compatibility hints. Video stream rows include
`hls_video_copy_compatible` and `hls_video_copy_reason` so compatibility
session creation can decide whether `-c:v copy` is safe. Audio stream rows
include `hls_audio_copy_compatible` and `hls_audio_copy_reason` so session
creation can decide whether `-c:a copy` is safe.

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
If a `video_copy` session hits a fatal media/codec playback failure, the client
restarts session creation with `force_video_transcode=1` so the retry falls back
to the normal x264 path. That fallback is one-shot per playback item and resume
timestamp to avoid copy/transcode retry loops.
If an `audio_copy` session hits a fatal media/codec playback failure, the client
restarts session creation with `force_audio_transcode=1` so the retry falls back
to the normal AAC transcode/downmix path. That fallback is also one-shot per
playback item and resume timestamp.
While compatibility playback is active, the client also posts
`/video/endpoints/session/progress` updates on playback events and a timer:
roughly every second during startup or after seek/play transitions, then every
five seconds during steady playback. Timers are cleared when the pane deactivates,
the active item changes, or the session stops so stale sessions do not keep
reporting progress.

The server uses those progress reports to pace tagged ffmpeg input reads through
the `/file` route. The default policy is:

- below `low_water_seconds`: no extra throttling so startup, restart, and near-edge seeks can catch up quickly
- between `low` and `medium`: light background pacing
- between `medium` and `high`: slower background pacing
- between `high` and `max`: heavy pacing
- at or above `max`: pause tagged input reads until playback catches up or the session changes

Paused playback is promoted one tier more aggressively than playing playback, so
the browser can sit paused without letting ffmpeg encode indefinitely farther ahead.

### Subtitles

Two subtitle paths:

- **Sidecar WebVTT** — fetched from `/video/endpoints/subtitles` or `/subtitles/all`,
  parsed by `vtt-parse-core.js`, rendered in the custom overlay via `webvtt-core.js`.
- **Burned-in** — selected bitmap or burn-in-required tracks set
  `subtitle_stream_index` on session create; ffmpeg embeds subtitles in the HLS output.

Subtitle styling is intentionally only approximate across those two paths. The
WebVTT overlay uses browser CSS text rendering, while burned-in subtitle tracks
are ffmpeg-composited subtitle bitmaps. The current burned-in styling path
duplicates the subtitle raster into blackened copies for a 1 px outline plus a
2 px drop shadow, then overlays the original subtitle image on top. That keeps
the apparent stroke/shadow direction and weight close to the WebVTT overlay,
but it cannot exactly match browser text antialiasing, outline joins, or blur
behavior.

The client may wait for subtitle preload before revealing playback when a sidecar
track is selected at startup.

Applied subtitle styling is shared across videos and pane modes, but the burned-in
ffmpeg path currently only consumes the shadow and stroke toggles. Subtitle size
and vertical offset remain WebVTT overlay controls for now.

`subtitles.js` owns the subtitle mount contract. The active mounted state now
lives in one explicit client object:

```javascript
subtitleMountState: {
  mode: 'none' | 'window' | 'full',
  path: '',
  streamIndex: null,
  seekSeconds: 0,
  coverageStartSeconds: null,
  coverageEndSeconds: null,
  playbackSyncToken: null,
  generation: 0
}
```

The important rules are:

- `mode: 'full'` means the mounted sidecar subtitle is valid for any later
  playback time for the same item/stream/seek context.
- `mode: 'window'` means the mounted sidecar subtitle is valid only for the
  recorded mounted coverage range.
- `storeFullSubtitleVtt(...)` clears obsolete mounted-window metadata for the
  same path/stream as soon as full-cache data arrives.
- DOM `<track>` state and subtitle debug output are effects of the mount state,
  not independent authorities for deciding mounted coverage.

The client still keeps `subtitleMountedWindowByPath` as derived compatibility
state because other UI surfaces consume mounted coverage summaries. It is
recomputed from the explicit `subtitleMountState` window coverage and never
written directly by subtitle window cache updates:

- scrubber subtitle-ready coverage display
- subtitle debug/range reporting
- tests that assert precise mounted-window replacement behavior

The old `subtitleMountedSeekSeconds` and `subtitleMountedStreamIndex` runtime
fields have been removed; callers should use `subtitleMountState`.

Playback-time subtitle refresh is edge-triggered. During compatibility
`timeupdate`, `subtitles.js` compares the current playback time against the
active mount state:

- if the active mount still covers the target time, no subtitle work runs
- if a full-cache mount is active, steady playback is a no-op
- if a windowed mount no longer covers the target time, the client requests one
  refresh for that uncovered boundary crossing and records that it has already
  reacted for the current mount generation
- seek, subtitle-track changes, audio-track restarts, and HLS-recovery restarts
  still use their existing explicit refresh paths instead of relying on the
  `timeupdate` loop

That structure is what prevents the original regressions:

- Bug A: uncovered window-boundary playback now triggers one intentional window
  refresh without restarting the HLS session
- Bug B: once full-cache data is mounted or cached, stale mounted-window
  metadata no longer makes the active subtitle appear unmounted

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
| Browser integration | `npx playwright test --grep video` |

When changing playback, subtitle, or HLS behavior, run the video e2e suite before
checkin. When changing pure seek/queue/WebVTT math, run the JS unit tests first.

## Related Docs

- Regression groups: `docs/testing.md` (`video`, `web` groups)
- General request/asset routing: `docs/architecture.md`
- Refactor plan (completed): `plans/PLAN_VIDEO_JS_REFACTOR.md`
