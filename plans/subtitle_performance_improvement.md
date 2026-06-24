# Subtitle Performance Improvements

Companion to `plans/subtitle_timeout_analysis.md`.

Subtitle extraction is slow because the server runs **full-file ffmpeg demux + ASS→WebVTT conversion over a remote HTTP stream**. On slower machines that hurts twice: less CPU for ffmpeg, and the same remote I/O bottleneck.

Current extraction command shape (`dropbox_browser/video.py`):

```python
ffmpeg -v error -i <http://localhost:8000/file?...> -map 0:<track> -f webvtt -
```

That forces ffmpeg to walk the **entire** MKV and convert every cue in one pass. For Detective Conan Movie 24 (~110 min, remote), measured uncached time is **~78 seconds**.

Improvements below are ordered by likely payoff.

---

## Biggest Wins (Architecture)

### 1. Extract text subtitles without full ffmpeg transcode

Today the server muxes demux and conversion in one ffmpeg pass to WebVTT.

**Better two-step path for ASS / SRT / subrip:**

1. **Demux only the subtitle track** — `ffmpeg -map 0:N -c:s copy out.ass` or `mkvextract`
2. **Convert the small `.ass` file to WebVTT locally** — Python parser or ffmpeg on a KB-sized file

Step 1 still reads the remote file, but skips video/audio decode and WebVTT formatting during the long remote read. Step 2 is milliseconds on any CPU.

### 2. Pipe rclone directly into ffmpeg (skip HTTP)

**Current path:**

```text
ffmpeg → http://localhost:8000/file → Python handler → rclone → Dropbox
```

**Lighter path:**

```text
rclone cat --remote:path  |  ffmpeg -i pipe:0 ...
```

Removes the HTTP server middleman, buffering layers, and extra copies. Same bits, less overhead — noticeable on slow machines.

### 3. Use local file when it exists

If the video is synced under `--local-root`, subtitle extraction should read the **local path** first via `safe_join_local`. Local disk random access is dramatically faster than streaming 110 minutes from Dropbox, especially when ffmpeg revisits earlier clusters.

Probably the single largest real-world win for users who sync anime folders.

---

## Medium Wins (Behavior + Caching)

### 4. Extract only the selected track, not all tracks

`preloadAllSubtitleVttsForItem()` in `dropbox_browser/assets/js/video/subtitles.js` calls `/video/endpoints/subtitles/all` and may pull every WebVTT-compatible track before play.

**Prefer:**

- Preload **default/selected track only** on play
- Warm other tracks in background after mount, or on track-change

### 5. Start extraction before the user presses Play

Trigger subtitle warm-up when:

- User double-clicks a library row (before HLS session starts)
- User adds to queue
- Probe returns for items in the active folder listing

Playback and subtitle extraction overlap instead of competing for CPU and bandwidth.

### 6. Background job + poll instead of blocking HTTP

The indefinite-timeout fix restores correctness but still holds an HTTP request open for ~80+ seconds on first play.

**Better model:**

- `POST /subtitles/jobs` → returns job id immediately
- Worker runs ffmpeg, writes partial/full VTT to `Temp/subtitle_cache/`
- Client polls `GET /subtitles/jobs/{id}` or watches cache readiness

Video starts immediately; subtitles mount when ready. Slow CPUs stay responsive.

### 7. Cache raw ASS, not just WebVTT

Disk cache today stores final `.vtt` only. Also cache the extracted `.ass` / `.srt` blob keyed by path + track + file size.

If WebVTT conversion logic changes, reconvert locally in seconds without another remote full read.

### 8. Progressive mount (good-enough subtitles)

For long movies, mount as soon as the **first N cues** are available — pipe ffmpeg stdout into cache incrementally. A user at 00:00 does not need cues at 01:45:00 yet.

Combine with `-ss` for scrub/restart: extract a window around the seek target first, then backfill the full file in background.

`build_ffmpeg_webvtt_command()` already accepts `start_time_seconds`; the main extraction path does not use it yet.

---

## Smaller ffmpeg / Input Tweaks

### 9. Tell ffmpeg to ignore heavy streams explicitly

Add demuxer hints on subtitle-only passes:

```text
-vn -an -sn -dn -map 0:N ...
```

Will not fix MKV cluster traversal, but reduces decoder overhead if ffmpeg touches video/audio paths.

### 10. Cap probesize / analyzeduration on subtitle passes

Probe uses capped analyze settings; subtitle ffmpeg does not. For HTTP inputs, bounded analyze can reduce startup stall (too low breaks some files).

### 11. Batch pass only when multiple tracks matter

`_run_ffmpeg_batch_webvtt()` is worthwhile when extracting 2+ text tracks in one remote read. For a single track, a simpler single-output command with a direct pipe may be less overhead than temp files + batch orchestration.

---

## Format-Specific Paths

### 12. ASS: client-side or lightweight server conversion

The player already ships `webvtt-core.js`; ASS often comes from fansub pipelines. A dedicated ASS→VTT converter (even dialogue-only, skipping karaoke) avoids ffmpeg's general subtitle encoder for the expensive remote phase.

### 13. PGS: do not try sidecar extraction

Bitmap codecs (`hdmv_pgs_subtitle`, etc.) cannot be WebVTT sidecars. Offer burn-in only. Do not spend extraction budget on PGS tracks — saves wasted work when users pick the wrong track (e.g. Conan stream 3 vs stream 4).

---

## Operational / UX Improvements

| Improvement | Effect |
|-------------|--------|
| Show "Extracting subtitles… ~1–2 min first time" | Sets expectations on slow hardware |
| Persist disk cache across server restarts | Second play is instant (`Temp/subtitle_cache/`) |
| Lower priority for subtitle ffmpeg vs HLS ffmpeg | Prevents subtitle work from starving playback encoding on weak CPUs |
| Dedupe probe inside extraction | `extract_remote_subtitles_to_webvtt()` re-probes; cache hit helps but is still work |

---

## Recommended Roadmap

| Priority | Item | Who benefits |
|----------|------|--------------|
| 1 | Local-file-first input | Synced content users |
| 2 | rclone pipe → ffmpeg | Everyone (remote) |
| 3 | Demux copy + local ASS→VTT | ASS/SRT-heavy anime |
| 4 | Async job + preload on queue/library select | Perceived latency |
| 5 | Selected-track-only + progressive cues | Long movies, weak CPUs |

---

## Expected Impact (Conan Movie 24 benchmark)

| Approach | Rough uncached time |
|----------|---------------------|
| Current: full remote ffmpeg → WebVTT | ~78 s |
| Remote + pipe + copy demux + local convert | ~30–40 s (I/O bound) |
| Local file + copy demux + local convert | **< 10 s** |

Gap vs current full transcode is **larger on slow PCs** because ffmpeg WebVTT conversion is CPU-heavy; copy demux is mostly I/O-bound.

After first successful extraction, `Temp/subtitle_cache/` makes repeat plays instant regardless of approach.

---

## Related Code

| Area | Location |
|------|----------|
| WebVTT ffmpeg command | `dropbox_browser/video.py` — `build_ffmpeg_webvtt_command()` |
| Batch extraction | `dropbox_browser/video.py` — `_run_ffmpeg_batch_webvtt()`, `extract_all_remote_subtitles_to_webvtt()` |
| Client preload | `dropbox_browser/assets/js/video/subtitles.js` — `preloadAllSubtitleVttsForItem()` |
| Subtitle disk cache | `Temp/subtitle_cache/` via `DiskCacheStore` |
| Header cache (probe only) | `ensure_remote_header_cache()` — 8 MB header; not usable for full subtitle streams |
| Remote file streaming | `/file` route + `rclone.open_cat()` |

---

## Follow-Ups Not Covered Here

- Return an error from `/subtitles/all` when batch extraction fails instead of `{"tracks":{}}`
- Treat empty batch `tracks` as failure in `preloadAllSubtitleVttsForItem()`
- Reintroduce a **scaled** timeout (duration/file-size based) if indefinite waits need an upper bound for hung jobs