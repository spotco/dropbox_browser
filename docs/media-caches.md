# Image/video thumbnails and media caches

The browse table, hover preview, Photo Map, and durable `/preview` page use
generated media artifacts. These are separate from ordinary file streaming:
`/file` and `/download` still stream source bytes directly.

## Image thumbnails

`dropbox_browser/thumbnails.py` uses ImageMagick to generate square PNG posters
for these image extensions:

`.apng`, `.avif`, `.bmp`, `.gif`, `.ico`, `.jpeg`, `.jpg`, `.png`, `.svg`, and
`.webp`.

`GET /thumbnail?path=&source=remote|local` resolves a source, validates the
configured local root when needed, and returns a cached PNG. A `Has Diffs` row
with both sides uses the local source; remote-only and local-only rows use the
side that exists. Cache identity includes source, normalized path, size,
modification time, output size, output format, and thumbnailer version, so a
changed source produces a new file.

The cache is under `ThumbnailCache/<hash-prefix>/<hash-prefix>/`. Generation
uses a temporary input/output file under `Temp/`, writes atomically, coalesces
concurrent requests for the same key, and rejects unsupported or oversized
inputs. `HEAD` is supported for the generated response.

Image thumbnails require `ThumbnailEnabled: true` and the vendored
`ImageMagick/magick.exe`; the feature is unavailable when that executable is
missing.

## Video thumbnails

`dropbox_browser/video_thumbnails.py` uses FFmpeg to generate square JPEG
posters for `.avi`, `.m2ts`, `.m4v`, `.mkv`, `.mov`, `.mp4`, `.ts`, `.webm`, and
`.wmv`.

`GET /video/endpoints/thumbnail?path=&source=remote|local` returns a cached
poster. It seeks to one second and falls back to a short seek from the end for
very short media. The cache key includes source identity, frame position,
thumbnailer version, and size. Remote generation feeds FFmpeg through the
server's loopback `/file` route; it does not download a permanent source file.

Video poster settings are `VideoThumbnailEnabled`, `VideoThumbnailSize`,
`VideoThumbnailMaxInputBytes`, and `VideoThumbnailTimeoutSeconds`. Posters are
stored under `ThumbnailCache/video/<hash-prefix>/<hash-prefix>/` and are
independent of Photo Map state.

## Video disk caches

`video.py` uses `videocache.DiskCacheStore`, a manifest-backed filesystem cache
with per-entry TTL and oldest-accessed byte-cap eviction, for:

| Cache | Runtime directory | Contents |
| --- | --- | --- |
| Probe | `Temp/probe_cache/` | Complete FFprobe stream/duration/compatibility payloads. |
| Subtitle | `Temp/subtitle_cache/` | Extracted full and windowed WebVTT plus manifests. |
| Header | `Temp/video_header_cache/` | Bounded remote header bytes used to accelerate probing. |

Probe and subtitle cache keys include the remote path and source identity; an
incomplete probe payload is not retained as a successful cache result. Expired
or missing files are pruned on read/startup. The default TTLs and caps are in
[Configuration](configuration.md).

`POST /video/endpoints/cache/clear` clears these three disk caches and returns a
JSON `cleared` map. It does not stop active HLS sessions, clear folder/listing
caches, clear Photo Map records, or remove generated posters.

## Preview route

`GET/HEAD /preview?path=&source=remote` serves a durable HTML page for a
supported remote image or video. It chooses the image or video poster endpoint
from the extension and always retains a Download Original link. Video playback
uses the same compatibility HLS session flow as the Photo Map overlay and
cleans up sessions on close/unload.

## Observability and tests

Thumbnail generation records worker-trace events for cache hits, unsupported
formats, oversized inputs, failures, and timeouts. Video session/cache details
are available in `Temp/video_debug.jsonl` when `LogVideoDebug` is enabled.

Focused checks:

```powershell
python -m tests.run thumbnails -v
python -m tests.run video-thumbnails -v
python -m tests.run video -v
```
