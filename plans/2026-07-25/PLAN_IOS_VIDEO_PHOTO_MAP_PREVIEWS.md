# iOS video parity in Photo Map

## Goal

Make an iPhone-uploaded video (`.mov`, and the already-recognized `.mp4`) interchangeable with a photo in **Photo Map** from the user's perspective. Videos and photos must use the same pin, card, group-cell, selection, popup, preview-entry, and return-state interactions; the format-specific poster/HLS work is an implementation detail. A video may expose only the controls necessary to play it (play affordance and mute state), but it must not create a separate video-only workflow, placeholder, layout, or navigation model. It must also have a stable, user-addressable preview URL even when raw `/file` makes the MOV download.

The implementation must work reliably in Brave and Chrome for iOS containers and codecs. Native MOV playback alone is not a compatibility guarantee.

## Confirmed product decisions

- Preview playback is **HLS-first**. Native Brave/Chrome playback may be used
  later for formats proved to work, but it is not part of the initial critical
  path because the user's iOS MOV examples currently do not play reliably.
- The durable alternate-preview route is
  `/preview?path=...&source=remote`. Photo Map opens it in an in-app overlay
  while updating browser history; direct navigation renders the standalone
  viewer.
- Preview begins only after an explicit click and is muted by default. The
  visible player has a corner mute/unmute control; no autoplay-on-selection.
- V1 uses a generated static poster frame. Animated hover/loop previews are
  deferred.

## Confirmed live evidence

Brave DevTools inspected the running `Camera Uploads` page on 2026-07-25.

- `Camera Uploads/2015-05-16 14.33.52.mov` is a 71.3 MB, 1920x1080 H.264/AAC MOV. `/file` sends `Content-Type: video/quicktime` and supports byte ranges.
- A smaller iOS MOV loaded metadata directly in Brave. This is a useful fast path, but it cannot cover all iPhone codec/HDR/HEVC variants.
- The existing compatibility endpoint produced fMP4 HLS for the larger MOV: H.264 video was stream-copied and audio safely transcoded. Startup was about 6.6 seconds. The test session was stopped and no active session remained.

Today, Photo Map parses QuickTime location metadata for `.mov`/`.mp4`, but it deliberately renders video-thumbnail placeholders. Browse marks MOVs as not thumbnailable. The image thumbnail service cannot merely add `.mov`: it uses ImageMagick, materializes remote input, and applies a 64 MB input guard.

## Product contract

### User-visible parity contract

- Treat photos and videos as one `media` type throughout Photo Map. The same
  dimensions, grouping rules, demand queue, popup/card structure, click target,
  and selection state apply to both.
- A successful video poster is displayed in the same places and with the same
  loading/error behavior as a photo poster. “Video thumbnail unavailable” is
  not an alternate user workflow; it is only a transient failure state with the
  same fallback affordance used for other media.
- Opening a video uses the same Photo Map preview surface and history/return
  behavior as opening a photo. HLS creation, codec conversion, and the raw
  `/file` versus `/preview` distinction stay hidden from the user.
- Do not expose separate “video mode” navigation, a video-player pane, or
  format-specific group behavior. Play/mute affordances remain inside the
  common media surface because they are required for video interaction.

### Canonical alternate-preview URL

Use a durable application route rather than exposing an expiring HLS playlist:

```text
/preview?path=Camera%20Uploads%2F2015-05-16%2014.33.52.mov&source=remote
```

`/preview` resolves the original source and uses the common media surface: an
image displays directly, while a video creates a fresh HLS playback session as
required. It is safe to bookmark/open in a tab. `/file` remains the
original-file stream/download route with its present range and HEAD contract.

In Photo Map, selecting a video opens an overlay first. Its history state uses the canonical preview query so it is linkable; closing restores the pre-preview Photo Map URL, selection, popup DOM, and group-grid scroll position. Direct navigation to `/preview` renders a focused standalone viewer.

### Playback policy

1. Start every V1 Photo Map preview through a compatibility HLS session.
2. The session emits H.264/yuv420p/AAC fMP4 HLS so Brave and Chrome get one
   reliable playback contract independent of the original iOS container/codec.
3. Keep a future native-direct optimization behind probe and browser
   verification; it must fall back immediately to HLS and must never block the
   initial feature delivery.

The transient playlist URL is never the durable alternate URL.

## Implementation checklist

### 1. Shared contracts and lifecycle

- [x] Add `media_kind`/`preview_kind` to Browse and Photo Map payloads; retain the original-file URL separately from the application preview URL.
- [x] Build and parse the canonical preview route in one shared helper. Validate paths with `clean_rel_path` and constrain supported sources.
- [x] Track item path/source, invoking mode, fallback state, session id, and Photo Map return context. Stale async session-create responses must be stopped. The controller snapshots/restores map viewport, popup, selected member, and group scroll, and retries one failed session with forced video/audio transcode.
- [x] Make teardown idempotent on overlay close, navigation, errors, and `beforeunload`.

### 2. FFmpeg video-thumbnail service

- [x] Add a focused `video_thumbnails.py` service using the existing ffmpeg discovery and a separate video poster cache.
- [ ] Use ffprobe duration/stream metadata to select a representative frame: initially 10% of duration, clamped to 1–5 seconds. Honor iOS rotation and generate a bounded square JPEG or PNG.
- [x] Feed ffmpeg from the localhost range-enabled `/file` route; do not first materialize the whole remote movie. Clean temporary files on every outcome.
- [x] Cache by source, normalized path, size, modified time, frame policy, output format, and thumbnailer version. Keep video cache keys distinct from image keys. (Duration/stream dimensions remain a follow-up refinement.)
- [ ] Add dedicated limits for video thumbnail timeout, concurrency, cache location, and remote-read budget. The current slice has timeout, input-size, and cache-location controls; independent concurrency/remote-read budgeting remains.
- [x] Coalesce equivalent in-flight requests and return ordinary image responses with the current no-store behavior. On failure, retain a play-icon placeholder without aggressive retries.

### 3. Thumbnails in Browse and Photo Map

- [x] Mark supported video rows thumbnailable, emitting a video thumbnail URL from the listing response. Browser queue/IntersectionObserver consumption remains next.
- [x] Replace the image-only hover-preview classification so video rows participate in poster loading but never `<img>` preload of the original MOV. Video rows use the same preview-entry behavior as other media, with `/preview` hidden behind the common media link.
- [x] Replace Photo Map video placeholders with thumbnail-backed cards/pins and a clear accessible play affordance.
- [x] Keep failed/loading video poster cells directly actionable: the cell itself
  can open the common preview surface even when poster generation returns an
  error.
- [x] Let all-video groups display their newest video's thumbnail. Mixed groups schedule video and photo thumbnails through the existing demand-driven queue.
- [x] Preserve Photo Map priority, cancellation, visible-only work, and generation checks. Never pre-generate every Camera Uploads video.

### 4. Seamless Photo Map preview overlay

- [x] Build a Photo Map media overlay with poster/loading/error states, native controls, close button, Escape, focus restoration, focus containment, and accessible labels.
- [x] Extract a lean HLS preview controller from the Video Player client: create/stop session, attach vendored `hls.js`, report progress needed for server backpressure, and retry one failed session with forced transcode. It does not import playlist, subtitle, or bottom-pane state.
- [x] Create HLS playback after the user explicitly clicks Play. Start muted and provide a visible corner mute/unmute control; do not autoplay on map/card selection. Retain the poster while showing “Preparing compatible video,” and do not force the user into the Video Player pane.
- [x] Return to the exact selected map item, map center, popup, and group-grid scroll position after close. Use the common media viewer for thumbnail clicks and existing preview actions, alongside Download Original.

### 5. Standalone `/preview` route

- [x] Add a constrained media route/template that shares the overlay controller and does not duplicate session/codec logic.
- [x] Accept `path` and `source`; reject traversal/unsupported sources. Include filename and Download Original. (Safe map-return context is deferred.)
- [x] Recreate HLS state after refresh. Never expose or require a prior temporary session id in the URL.

### 6. Reuse existing video backend

- [x] Reuse `probe_remote_media`, codec decisions, `VideoHlsSessionManager`, range-fed `/file` input, HLS command creation, session caps/eviction, process priority, and backpressure through the existing session endpoint.
- [x] Keep current Video Player behavior unchanged; the Photo Map controller does not import playlist, subtitle, or bottom-pane state.
- [ ] Keep safe H.264 stream copy; use AAC transcode where MOV audio is not safe for HLS; use x264/AAC fallback otherwise.
- [ ] Add configured diagnostics for source mode, thumbnail cache/generation, startup timing, fallback, and cleanup.

### 7. Tests and validation

- [ ] Unit-test video thumbnail keys, rotation, frame choice, budget/timeout cleanup, request coalescing, and image HTTP response headers.
- [ ] Test listing and Photo Map MOV/MP4 thumbnail fields, all-video/mixed groups, placeholder fallback, queue priority, and cancellation.
- [ ] Add browser tests for HLS playback across source codecs, explicit click-to-play, muted default/corner mute control, close/session cleanup, Escape/focus, history return, and `/preview` reload.
- [ ] Use H.264/AAC, HEVC when suitable, short, rotated portrait, alternate-audio, and tail-`moov` fixtures.
- [ ] Manually verify live Camera Uploads in Brave and Chrome: seeking, sound, no orphaned sessions, map return state, and all-video-group thumbnails.
- [ ] After restarting the Python server, reload Photo Map and confirm the stale `-5,-5`, `0,-9`, and `0,0` video records are replaced by corrected coordinates or `no-location` without clearing `Cache/PhotoMap`.

### Current implementation slice (2026-07-25)

The server-side poster path is now available at
`GET/HEAD /video/endpoints/thumbnail?path=...&source=...`. It uses ffmpeg,
range-fed remote input, a dedicated `ThumbnailCache/video/` namespace, bounded
configuration, request coalescing, and Browse listing metadata
(`video_thumbnail_href`, `video_thumbnailable`, and `media_kind`). It does not
touch `Cache/PhotoMap` or any existing Photo Map cache files.

Focused validation passes with `python -m tests.run video-thumbnails -v`,
`python -m tests.run thumbnails -v`, `python -m tests.run cache -v`,
`python -m tests.run video-endpoints -v`, and `python -m unittest
tests.test_config -v`.

The Browse and Photo Map poster integration is now wired to the existing
visible-only queues. Video posters use `/video/endpoints/thumbnail`, grouped
pins choose the newest media member (photo or video), and video cells/pins have
the same media-card structure as photos, and the only format-specific UI is the
necessary play/mute affordance inside the common preview surface. A durable
`/preview` route and standalone page now share a common media controller with
the Photo Map overlay: photos display their image poster directly, while videos
start HLS only after Play. Remote Browse video rows use that route while
preserving `original_file_href` for the raw MOV stream. The controller now
captures/restores map center, popup/member selection, and grouped-grid scroll.
The overlay now contains focus while open and performs one bounded HLS retry
with forced video/audio transcode before showing a terminal playback error.
The poster encoder now explicitly emits full-range `yuvj420p` JPEG pixels; this
avoids an FFmpeg MJPEG failure seen with `2021-06-21 21.10.19.mov` in Brave.
QuickTime metadata cache records now carry a parser version, so cached video
coordinates from the prior false-match parser are re-read and replaced without
clearing the Photo Map cache.
The parser now requires the complete QuickTime ISO-6709 degree shape and treats
`+00.0000+000.0000/` as a no-location placeholder; this prevents compressed
binary coincidences and downloader sentinel coordinates from creating map pins.
The cache endpoint now preserves the video parser-version marker, so the
one-time migration remains durable after the corrected records are written.

## Required live acceptance fixture: Piccard Drive grouped pins

Use the live `Camera Uploads` Photo Map around 1350/1370 Piccard Drive,
Rockville, Maryland as the final manual acceptance fixture. This is required
in addition to deterministic unit and Playwright fixtures: it exercises the
real Dropbox MOVs, current thumbnail cache behavior, dense grouping, and the
browser/ffmpeg integration together.

### Repeatable route to the fixture

1. Open `Camera Uploads` in the browser and select **Photo Map** in the bottom
   pane.
2. Set **Date range** to **All time** and **Grouping distance** to **100 m**.
   Wait until the existing located media are shown; do not wait for unrelated
   background metadata work for the whole folder to finish.
3. The Photo Map currently has no address/coordinate search control. For a
   deterministic manual visit, open Brave DevTools for the page and run:

   ```javascript
   window.DropboxBrowserPhotoMap.getMap().setView([39.1052, -77.1800], 18, {animate: false});
   ```

   This centers the shared 1350/1370 Piccard Drive area. The verification may
   add a test-only helper or a product map-search control later, but it must not
   depend on fragile manual panning for repeatability.

### Expected current evidence

At the time this plan was recorded, the live map showed:

- a **90-media grouped pin** near 1350 Piccard Drive (approximately
  `39.1043, -77.1793`); and
- a **19-media mixed grouped pin** near 1370 Piccard Drive (approximately
  `39.1052, -77.1807`) containing
  `Camera Uploads/2025-06-18 12.57.55.mov` alongside photos.

Counts can naturally change as Camera Uploads grows. The stable acceptance
identity is the Piccard coordinate area and the named MOV; test reporting
should record observed counts rather than failing solely because a group count
changed.

### Required end-to-end checks at Piccard Drive

- [ ] The 1350 group displays a normal grouped poster/card rather than a
  degraded or broken pin; opening and scrolling it preserves grouped-grid
  behavior.
- [ ] The 1370 mixed group displays generated photo and video poster cells,
  including `2025-06-18 12.57.55.mov`, with a clear video play affordance and
  the same card dimensions and interaction as photo cells after successful
  generation.
- [ ] Selecting that MOV opens the Photo Map overlay without dropping the
  selected group/grid context. The initial poster is visible while the HLS
  session prepares.
- [ ] Playback starts only after Play is clicked, begins muted, and the corner
  mute/unmute control changes audible state correctly.
- [ ] Seeking and normal controls work in Brave and Chrome; a codec/container
  failure shows a useful error and does not leave an orphan ffmpeg session.
- [ ] Closing the preview (button and Escape) returns to the same 1370 group,
  selected MOV, map center/zoom, and grid scroll position. Browser Back/Forward
  has the same restoration behavior.
- [ ] Opening the canonical `/preview` URL for the named MOV in a fresh tab
  plays the browser-compatible alternate stream and exposes Download Original;
  refreshing it creates a new valid session rather than referring to an expired
  playlist URL.

## Out of scope for first delivery

- Background pre-generation for every Dropbox video.
- Persistent full-video transcodes; HLS remains temporary.
- Uploading, overwriting, or altering original Dropbox MOVs.
- Live Photo pairing, editing, trimming, or sharing.

## Deferred follow-up

- Use ffprobe stream/duration metadata for a 10%-duration (clamped 1–5 second)
  frame, rotation-aware filtering, and a fallback to the first decodable frame.
- Add independent thumbnail concurrency and remote-read budgets, plus handler/
  listing integration tests and browser coverage for the new poster path.
- Verify the parity contract in Brave and Chrome. Keep any codec/source
  differences inside the controller rather than exposing a separate video
  workflow.
- Add browser-level controller tests (click-to-play, mute, Escape, stale-session
  cleanup, forced-transcode retry, focus containment, history restoration, and
  `/preview` reload) plus live Brave/Chrome acceptance at the Piccard Drive
  fixture.
- Consider a native-direct fast path only after the HLS-first Photo Map preview is proven stable. It must be capability-tested and fall back transparently.
- Consider muted animated hover/loop previews only after static poster-frame generation has proven to be performant for live Camera Uploads use.
