# Subtitle Timeout Analysis — Detective Conan Movie 24

Analysis date: 2026-06-24  
File: `anime/conan_24/[Ah-le-le] Detective Conan Movie 24v0 - The Scarlet Bullet (BDRip 1080p HEVC FLAC TrueHD) [12A80FEC].mkv`

## Symptom

Subtitles appeared to load in the video player (track selector populated, preload/wait stage shown) but **no subtitle text displayed** during playback.

## Video Track Layout (from probe)

| Stream | Codec | Language | Title | WebVTT sidecar? |
|--------|-------|----------|-------|-----------------|
| 0 | hevc | jpn | — | — |
| 1 | truehd | jpn | TrueHD 5.1 | — |
| 2 | flac | jpn | FLAC 2.0 | — |
| 3 | hdmv_pgs_subtitle | jpn | PGS | **No** (bitmap) |
| 4 | ass | eng | [SPP] | **Yes** (default subtitle) |

- Duration: **6618.6 s** (~110 minutes)
- Default subtitle stream: **4** (English ASS)
- Japanese PGS (stream 3) cannot be mounted as a WebVTT sidecar; it requires HLS burn-in restart.

## What the Logs Showed

Client logs in `Temp/client_logs.jsonl` for the 2026-06-24 session:

1. **01:29:57** — `Subtitle mount started` (preload begins after HLS ready)
2. **~61 seconds later** — `Subtitle extraction failed` with `error_message: "Subtitle mount failed."`
3. `subtitle_mounted_stream_index` remained **`null`** for the entire session
4. **No** `Subtitle track mounted` or `Subtitle textTrack activated` entries for this file
5. Same failure pattern on scrub (e.g. **01:33:54** at ~14:37)

Video playback itself worked (HLS session encoding and playing). Only subtitle conversion failed.

Historical sessions (2026-06-17, 2026-06-23) show the same `Subtitle mount failed` / stream 4 pattern.

## Root Cause: ffmpeg 30-Second Timeout on Long Remote File

Subtitle extraction uses ffmpeg reading the remote file via the local HTTP proxy:

```
http://localhost:8000/file?path=...&source=remote
```

For ASS → WebVTT conversion, ffmpeg must scan through the **entire** input to emit all cues. For a 110-minute file streamed from Dropbox through rclone, this takes far longer than 30 seconds.

### Server timeout (before fix)

In `dropbox_browser/video.py`, subtitle ffmpeg calls used a **30-second** `subprocess.run` timeout:

- `extract_remote_subtitles_to_webvtt()` — `timeout=30` → 502 `ffmpeg timed out while converting subtitles.`
- `_run_ffmpeg_single_webvtt()` — default `timeout_seconds=30`
- `_run_ffmpeg_batch_webvtt()` — `timeout_seconds = max(30, 15 * track_count)`
- `extract_all_remote_subtitles_to_webvtt()` — batch timeout of 30 s for a single compatible track

### Reproduction Results

| Test | Result |
|------|--------|
| `GET /video/endpoints/subtitles?...&track=4` | **502** after ~32 s — `ffmpeg timed out while converting subtitles.` |
| `GET /video/endpoints/subtitles/all?...` | **200** `{"status":"ok","tracks":{}}` after ~62 s — silent empty failure |
| Full ffmpeg extraction (no timeout, stream 4) | **Success in ~78 s** — valid WebVTT with thousands of cues (first cue at 00:48) |
| `Temp/subtitle_cache/manifest.json` | **Empty** — no cached VTT for this file |

The ASS track is valid. Extraction simply needs **~80+ seconds** for this remote movie, not 30.

## Why It Looked Like Subtitles "Loaded"

1. **Probe succeeded** — ffprobe returns track metadata; the subtitle dropdown shows `ENG • [SPP] • ASS • Stream 4` before any VTT exists.
2. **Preload ran** — client calls `/video/endpoints/subtitles/all` in background and may show a subtitle-wait loading stage.
3. **Video plays normally** — HLS encoding is independent of subtitle extraction.
4. **Silent batch failure** — `/subtitles/all` returns HTTP 200 with `"tracks": {}` on timeout instead of an error, so the client does not log `Subtitle batch preload failed` for Conan. Failure surfaces only at mount time as generic `Subtitle mount failed.`

Nothing was ever mounted: `getCachedFullSubtitleVtt()` stayed empty → `mountSubtitleTrackForItem()` returned false.

## Client Flow (relevant paths)

1. `scheduleSubtitlesAfterPlaybackReady()` → `preloadAllSubtitleVttsForItem()`
2. Batch fetch `/video/endpoints/subtitles/all` — on empty `tracks`, no cache write, no `batchFailed` flag
3. `applySubtitlesForSeek()` → `mountSubtitleTrackForItem()`
4. Mount requires cached full VTT in `subtitleFullVttCacheByPath`; without it, throws `Subtitle mount failed.`

## Fix Applied

Changed subtitle ffmpeg extraction timeout from **30 seconds** to **indefinite** (no `timeout` on `subprocess.run` for subtitle conversion in `extract_remote_subtitles_to_webvtt`, `_run_ffmpeg_single_webvtt`, and `_run_ffmpeg_batch_webvtt`). Once cached, repeat plays are instant from `Temp/subtitle_cache/`.

## Follow-Up Improvements (not yet implemented)

- Return an error from `/subtitles/all` when batch extraction fails instead of `{"tracks":{}}`
- Treat empty batch `tracks` as failure in `preloadAllSubtitleVttsForItem()` so the UI shows a clear error sooner
- Consider background async extraction with client polling so the HTTP request does not block for minutes on first play
- PGS (stream 3) still requires burn-in path, not sidecar WebVTT

## Why Subtitle Extraction Takes So Long

Subtitle conversion is not a small header read like probe. ffmpeg must **demux and decode the full subtitle stream** from start to finish to produce a complete WebVTT file with every cue and timestamp.

For this Conan movie, several factors stack:

1. **Full-file scan** — ASS subtitles are muxed inside a ~110-minute MKV. ffmpeg walks the container sequentially to read all subtitle packets. It cannot emit the final WebVTT until it has seen the whole stream.

2. **Remote HTTP input** — ffmpeg reads via `http://localhost:8000/file?...&source=remote`, which streams bytes from Dropbox through rclone. That path is seek-limited and bandwidth-bound compared to a local file; ffmpeg may re-read or wait on slow ranges.

3. **Large source file** — BDRip 1080p HEVC + TrueHD + FLAC is a heavy mux. Even when ffmpeg only maps the subtitle stream (`-map 0:4`), the demuxer still advances through the file structure to find subtitle packets.

4. **ASS → WebVTT conversion** — Advanced SubStation Alpha must be parsed and rewritten into WebVTT cue syntax. For a feature-length release with thousands of dialogue lines, output generation adds work on top of demux time.

5. **No partial cache on first request** — Until the first successful extraction finishes and writes to `Temp/subtitle_cache/`, every play triggers a full remote conversion. Measured wall time for this file: **~78 seconds** uncached vs the old **30-second** server cutoff.

Shorter TV episodes extract in a few seconds because the demuxer finishes quickly. Long remote movies cross the old timeout threshold even though the operation is healthy — just slow.