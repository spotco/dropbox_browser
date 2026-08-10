# Configuration and generated state

The server loads configuration in this order:

1. Built-in defaults in `dropbox_browser/config.py`.
2. `config.json` in the repository root.
3. `config_local.json`, when present.

Later layers replace earlier scalar values. `ClientLogSubsystems` is merged by
key, so a local file can enable one subsystem without copying the complete
default map. `config_local.json` is machine-local and ignored by Git. Values
may use environment variables; relative `DropboxFolder` paths are resolved from
the repository root.

## Command-line settings

`python dropbox_browser.py --help` is authoritative for the CLI. The options
are:

| Option | Default | Meaning |
| --- | --- | --- |
| `--host` | `127.0.0.1` | Bind address. The separate `LocalhostOnlyAccess` check still rejects non-loopback clients by default. |
| `--port` | `8000` | HTTP port. |
| `--remote` | `dropbox:` | rclone remote root. |
| `--rclone` | `.tools/` pack, then repository `rclone.exe`, then `PATH` | rclone executable. |
| `--rclone-config` | configured `RCloneConfig`, otherwise rclone's own default | rclone config path. |
| `--local-root` | configured `DropboxFolder` | Local comparison root; the CLI option takes precedence. |
| `--client-render` | enabled | Use the maintained client-rendered browse shell. `--no-client-render` is a legacy compatibility mode. |

The server creates the local root if it does not exist. It refuses to start if
the configured path exists as a file.

## Core application settings

| Key | Default | Notes |
| --- | --- | --- |
| `DropboxFolder` | `./DropboxLocal` | Local tree compared with Dropbox. Empty or missing values fall back to `./DropboxLocal`; use `--local-root` to select another root for one run. |
| `RCloneConfig` | empty | Environment-expanded path. A path equal to rclone's native default is omitted from the command. |
| `LocalhostOnlyAccess` | `true` | Rejects requests whose peer is not a loopback address. This is an access boundary, not authentication or TLS. |
| `CacheStaticAssets` | `true` | Sends one-hour public cache headers for HTML, CSS, JavaScript, icons, and other static assets. `false` restores no-store headers for development. |
| `LogRcloneCommands` | `true` | Logs rclone command starts/completions. |
| `LogHttpRequests` | `true` | Logs HTTP requests to normal server output. Polling endpoints are suppressed from that output. |
| `FolderCacheWorkers` | `4` | Background recursive metadata worker count. |
| `SyncJobWorkers` | `4` | Browser-triggered copy worker count. |
| `FolderCacheTTLSeconds` | `1209600` (14 days) | Folder metadata/diff cache freshness. |
| `ListingCacheTTLSeconds` | `1800` (30 minutes) | Direct `rclone lsjson` listing cache freshness. |

## Tool discovery

Native tools (rclone, FFmpeg/FFprobe, ImageMagick) can come from a
**platform tool pack** under `.tools/<platform-id>/`. Install the pack for this
machine only with:

```text
python tools/bootstrap_tools.py
```

That downloads one zip from the project's GitHub `tools-v1` release (see
[`tools/README.md`](../tools/README.md) and
[`tools/runtime_manifest.json`](../tools/runtime_manifest.json)). Linux packs
are not published yet.

Discovery order:

1. Bootstrapped pack under `.tools/<platform-id>/` when present.
2. Legacy in-repo Windows paths (`rclone.exe`, `FFmpeg/bin/`,
   `ImageMagick/magick.exe`) and the older `tools/osx-intel/bin/` layout.
3. Configured `FFMpegPath` / `FFProbePath` (and siblings), then `PATH`.

`rclone` ultimately falls back to the command name `rclone` / `rclone.exe`.
Image thumbnails require a discoverable `magick` executable. The
`ThumbnailEnabled` setting controls whether the feature is requested, but the
service is considered enabled only when that executable is present.

## Image thumbnails

| Key | Default | Notes |
| --- | --- | --- |
| `ThumbnailEnabled` | `true` | Enables image poster generation when ImageMagick is available. |
| `ThumbnailSize` | `64` | Square output edge in pixels. |
| `ThumbnailMaxInputBytes` | `67108864` | Maximum image input size (64 MiB). |
| `ThumbnailTimeoutSeconds` | `15` | ImageMagick generation timeout. |

Supported image extensions are listed in [Media caches](media-caches.md).

## Video tools, sessions, and caches

The video settings are intentionally split between playback tuning, session
limits, poster generation, and disk caches.

| Key | Default | Notes |
| --- | --- | --- |
| `FFMpegPath` / `FFProbePath` | empty | Optional explicit tool paths. |
| `VideoFFmpegReadRate` | `1.1` | Input `-readrate`; `0` disables pacing. |
| `VideoFFmpegInitialBurstSeconds` | `18` | Optional startup burst for paced reads. |
| `VideoFFmpegCatchupReadRate` | `1.3` | Catch-up rate after stalls/seeks. |
| `VideoFFmpegThreads` | `0` | Fixed encoder thread count; `0` keeps FFmpeg automatic selection. |
| `VideoFFmpegFilterThreads` | `0` | Fixed filter thread count; `0` keeps FFmpeg automatic selection. |
| `VideoFFmpegProcessPriority` | `below_normal` | Windows priority: `idle`, `below_normal`, or `normal`. |
| `VideoMaxConcurrentSessions` | `8` | HLS compatibility session cap. |
| `VideoSessionIdleTTLSeconds` | `900` | Idle expiry and cap-eviction threshold. |
| `VideoBackpressureLowWaterSeconds` | `45` | Start of the light pacing tier. |
| `VideoBackpressureMediumWaterSeconds` | `120` | Start of the slower background tier. |
| `VideoBackpressureHighWaterSeconds` | `300` | Start of heavy throttling. |
| `VideoBackpressureMaxWaterSeconds` | `600` | Pause tagged input when encode-ahead reaches this watermark. |
| `VideoSubtitleFontFamily` | `Arial, Helvetica, sans-serif` | WebVTT overlay font family. |
| `VideoSubtitleFontSizePx` | `28` | WebVTT overlay size; the server clamps it to at least 10 px. |
| `VideoSubtitleBold` | `true` | WebVTT overlay weight. |
| `VideoThumbnailEnabled` | `true` | Enables FFmpeg-generated video posters. |
| `VideoThumbnailSize` | `256` | Square poster edge, bounded to 16–1024 px. |
| `VideoThumbnailMaxInputBytes` | `2147483648` | Independent video-poster input limit (2 GiB). |
| `VideoThumbnailTimeoutSeconds` | `30` | Per-poster FFmpeg timeout. |
| `VideoProbeCacheTTLSeconds` | `604800` | Probe JSON cache TTL (7 days). `0` disables retention. |
| `VideoProbeCacheMaxBytes` | `52428800` | Probe cache byte cap (50 MiB). |
| `VideoSubtitleCacheTTLSeconds` | `604800` | Extracted subtitle cache TTL (7 days). |
| `VideoSubtitleCacheMaxBytes` | `209715200` | Subtitle cache byte cap (200 MiB). |
| `VideoHeaderCacheTTLSeconds` | `86400` | Remote header cache TTL (1 day). |
| `VideoHeaderCacheMaxBytes` | `524288000` | Header cache byte cap (500 MiB). |
| `VideoHeaderCacheBytes` | `8388608` | Bytes fetched for a remote probe header (8 MiB). |
| `VideoProbeProbeSizeBytes` | `2097152` | FFprobe `-probesize` input budget (2 MiB). |
| `VideoProbeAnalyzeDurationUs` | `3000000` | FFprobe `-analyzeduration` budget (3 seconds). |
| `LogVideoDebug` | `false` | Enables server HLS/session JSONL diagnostics. |

The four backpressure watermarks are normalized into nondecreasing order. The
session cap controls actual FFmpeg processes, so each concurrent transcode adds
real CPU, memory, and remote-read work.

## Music visualization

| Key | Default | Notes |
| --- | --- | --- |
| `MusicWaveformCacheEntryLimit` | `20` | Browser-local completed waveform records, bounded to 0–100. `0` disables persistence. |
| `MusicWaveformMaxResolution` | `256` | Maximum summary buckets, bounded to 64–512. |

Waveform details are fetched and decoded in the browser only when the panel is
open and audio is playing. See [Music player](music-player.md).

## Client diagnostics

| Key | Default | Notes |
| --- | --- | --- |
| `ClientLogEnabled` | `true` | Master switch for browser-originated logs. |
| `ClientLogSubsystems` | see below | Per-subsystem switches. |

Built-in subsystem defaults are `video: true`, `video-timing: true`,
`video-subtitles: false`, `browse-reveal: false`, `file-search: false`,
`music-metadata: false`, `music-waveform: false`, and `photo-map: false`.
Diagnostics are bounded before being written to `Temp/client_logs.jsonl`.

## rclone write retry settings

Sync writes (`rcat`, `copyto`, and `mkdir`) use a bounded retry policy. Defaults
are 25 attempts, a 10-second minimum timeout, 20 seconds per GiB, a 300-second
initial cap, a 2x timeout multiplier, a 600-second maximum timeout, and retry
sleeps of 1, 2, then 5 seconds. These settings are optional:

`RcloneWriteMaxAttempts`, `RcloneWriteMinTimeoutSeconds`,
`RcloneWriteTimeoutPerGibSeconds`, `RcloneWriteMaxInitialTimeoutSeconds`,
`RcloneWriteTimeoutMultiplier`, and `RcloneWriteMaxTimeoutSeconds`.

Dropbox throttle errors are also retried by sync workers with their own bounded
backoff. See [Sync and rclone](sync-and-rclone.md).

## Generated directories

| Directory | Owner | Contents |
| --- | --- | --- |
| `Cache/FolderInfo/` | `foldercache.py` | Recursive folder metadata and diff records. |
| `Cache/ListingCache/` | `listingcache.py` | Hashed direct `lsjson` responses. |
| `Cache/PhotoMap/` | `photo_map_cache.py` | Validated browser-written location metadata. |
| `ThumbnailCache/` | `thumbnails.py`, `video_thumbnails.py` | Image PNG and video JPEG posters. |
| `Temp/runs/<run-id>/` | `workertrace.py` | Per-run metadata and worker JSONL traces. |
| `Temp/video_sessions/` | `video.py` | Active HLS playlists and segments. |
| `Temp/probe_cache/`, `Temp/subtitle_cache/`, `Temp/video_header_cache/` | `video.py` | Video disk caches with TTL and byte-cap eviction. |
| `Temp/client_logs.jsonl` | `clientlog.py` | Enabled client diagnostic events. |

All of these are disposable runtime state. The video endpoint
`POST /video/endpoints/cache/clear` clears the probe, header, and subtitle disk
caches; it does not replace the normal cache invalidation flow for listings or
folder metadata.
