# ASS To WebVTT Subtitle Conversion Plan

## Goal

Fix ASS subtitle tracks that currently leak raw ASS drawing, positioning, and
override markup into the browser subtitle overlay after ffmpeg converts them to
WebVTT.

The implementation should keep simple dialogue subtitles on the existing
sidecar WebVTT path, while routing advanced ASS tracks through burned-in libass
rendering when WebVTT cannot faithfully represent the source.

Primary repro:

- `anime/[Trix] Fruits Basket (2019-2022) S01-03+Movie (BD 1080p AV1)/Season 2/[Trix] Fruits Basket (2019) S02E10 (BD 1080p AV1) [12F3163B].mkv`
- Track `4`, `English (Full) [LostYears]`
- Verified by `/video/endpoints/probe`: track `4` is `codec_name: ass`; track
  `5`, `English (Signs) [LostYears]`, is also ASS.
- Bad WebVTT output near `00:01:34` shows literal logo letters and vector
  drawing commands.
- The source ASS near `00:01:34` contains `Logo` events with positioning,
  rotation, fades, transforms, clips, and vector drawing mode (`\p1`).
- Bad WebVTT output near `00:23:47` shows literal ASS sign markup around the
  ending title.
- The source ASS near `00:23:47` contains overlapping dialogue and styled sign
  events, including the ending title text `{*}Mine and Mine Alone{*All Mine}`.

Secondary repro:

- `anime/[Trix] Fruits Basket (2019-2022) S01-03+Movie (BD 1080p AV1)/Season 2/[Trix] Fruits Basket (2019) S02E04 (BD 1080p AV1) [A0E53492].mkv`
- Track `4`, `English (Full) [LostYears]`
- Verified by `/video/endpoints/probe`: track `4` is `codec_name: ass`; track
  `5`, `English (Signs) [LostYears]`, is also ASS.
- The source ASS near `00:00:49` contains `Logo` events with positioning,
  rotation, clips, fades, transforms, custom styling, and vector drawing mode
  (`\p1`).

## Current Failure

The server treats ASS as WebVTT-compatible because ffmpeg can output WebVTT for
ASS streams. That is only safe for simple dialogue. Advanced ASS events use
features WebVTT cannot represent:

- positioned signs and logos;
- vector drawing mode (`\p1`, `\pN`);
- clips, moves, transforms, fades, blur, borders, and custom fonts;
- overlapping layered events;
- inline ASS override blocks and author notes that can survive conversion as
  literal text.

VLC renders the ASS track directly through libass, so these events appear as
styled signs. The browser path asks ffmpeg for WebVTT text, so unsupported ASS
features are flattened into raw cue text.

## Design Direction

Use a two-path model for text subtitles:

- **Simple text path**: convert to WebVTT, sanitize obvious ASS leftovers, and
  render in the existing browser overlay.
- **Advanced ASS path**: mark the track as burn-in-required and restart/create
  the compatibility HLS session with `subtitle_stream_index`, so ffmpeg/libass
  renders the ASS into the video.

Do not attempt to implement a full ASS renderer or full ASS-to-WebVTT layout
engine in JavaScript or Python. The app should classify and route tracks based
on what WebVTT can safely preserve.

## Step 1 - Confirm Existing Subtitle Contracts

- [x] Read `docs/video-player.md` before changing video or subtitle behavior.
- [x] Inspect `dropbox_browser/video.py` subtitle probing, extraction, and HLS
  session command construction.
- [x] Inspect `dropbox_browser/assets/js/video/subtitles.js`,
  `tracks.js`, `compatibility.js`, and `playback.js` for current selected-track
  and restart behavior.
- [x] Confirm how bitmap subtitle tracks currently become burn-in-required.
- [x] Confirm whether the probe payload can add fields without breaking current
  tests or client code.

## Step 2 - Add ASS Capability Classification

- [x] Add a small server-side classifier for subtitle tracks in
  `dropbox_browser/video.py`.
- [x] Classify non-ASS text tracks as existing WebVTT-compatible behavior.
- [x] Classify ASS/SSA tracks as `simple_webvtt`, `advanced_ass`, or
  `unknown_ass` based on extracted ASS event/style features.
- [x] Treat drawing mode (`\p1`, `\p2`, etc.) as advanced ASS.
- [x] Treat explicit positioning, movement, clipping, transforms, fades, blur,
  borders, scaling, rotation, custom fonts, and non-default styles as advanced
  ASS unless proven safe.
- [x] Treat overlapping signs/layered events as advanced ASS when they are not
  plain dialogue.
- [x] Keep the classifier conservative: false positives should burn in
  subtitles, while false negatives can leak bad text.
- [x] Add unit tests for simple dialogue ASS, vector drawing ASS, positioned
  signs, transform/fade markup, and the Fruits Basket logo/title patterns.

## Step 3 - Extend Probe Payload And UI Track Metadata

- [ ] Add subtitle capability fields to probe subtitle rows, for example:
  `subtitle_render_mode`, `webvtt_compatible`, `webvtt_conversion_safe`,
  `burn_in_required`, and `subtitle_render_reason`.
- [ ] Keep existing `webvtt_compatible` semantics stable enough for current
  callers, or update all callers in the same change.
- [ ] Expose advanced ASS tracks in the subtitle selector rather than hiding
  them.
- [ ] Label advanced ASS tracks clearly enough for debugging, without adding
  noisy user-facing explanation text.
- [ ] Preserve default subtitle selection for default ASS tracks; the selected
  default should use the correct rendering path.
- [ ] Add server tests for probe payload fields on ASS, SRT, WebVTT, and bitmap
  subtitle stream fixtures.

## Step 4 - Route Advanced ASS To Burn-In

- [ ] Update client subtitle selection logic so advanced ASS tracks request a
  compatibility session restart with `subtitle_stream_index`.
- [ ] Prevent sidecar WebVTT preload/mount for tracks marked burn-in-required.
- [ ] Ensure selecting `Subtitles Off` stops burned-in subtitles by restarting
  the HLS session without `subtitle_stream_index`.
- [ ] Preserve current playback position when switching between sidecar,
  burn-in, and off.
- [ ] Keep audio-track switching compatible with the currently selected burn-in
  subtitle track.
- [ ] Keep bitmap subtitle behavior on the same burn-in path.
- [ ] Add focused JS tests for track selection decisions and restart payloads.

## Step 5 - Harden Simple ASS WebVTT Conversion

- [ ] Keep the current ffmpeg WebVTT extraction path for simple ASS tracks.
- [ ] Add a post-conversion sanitizer that removes or rejects cue text still
  containing unsupported ASS leftovers.
- [ ] Drop pure drawing cues that contain path commands from ASS vector mode.
- [ ] Strip safe ASS override remnants only when they are clearly formatting
  noise, not dialogue text.
- [ ] Detect conversion output that still contains high-risk ASS syntax and
  return a structured failure or fallback signal instead of mounting garbage.
- [ ] Ensure subtitle window extraction and full-track extraction use the same
  sanitizer and fallback decision.
- [ ] Add tests for sanitized simple dialogue, dropped drawing cues, and
  fallback when unsupported ASS text survives conversion.

## Step 6 - Add Fallback Behavior For Conversion Failures

- [ ] When a selected simple ASS track fails safe WebVTT conversion, mark the
  track/session as needing burn-in for that playback item.
- [ ] Restart compatibility playback with `subtitle_stream_index` after a
  conversion failure if the user still has that subtitle track selected.
- [ ] Avoid retry loops by recording the fallback decision per
  path/subtitle-stream/playback item.
- [ ] Surface a compact debug/status reason when sidecar conversion falls back
  to burn-in.
- [ ] Add tests for one-shot fallback and no-loop behavior.

## Step 7 - Update Caching And Invalidation

- [ ] Include the subtitle classification/sanitizer version in cache keys or
  cached metadata where stale WebVTT could otherwise survive.
- [ ] Ensure old bad subtitle cache entries do not remain authoritative after
  this change.
- [ ] Keep existing subtitle cache TTL and max-byte behavior intact.
- [ ] Verify windowed subtitle cache manifests remain valid for sidecar tracks.
- [ ] Add tests for cache-key/version changes and stale-cache avoidance.

## Step 8 - Diagnostics

- [ ] Add server debug events for ASS classification:
  track index, codec, decision, reason, and sampled feature flags.
- [ ] Add server debug events when WebVTT sanitization drops cues or rejects
  converted output.
- [ ] Add client diagnostics when a track uses sidecar WebVTT versus burn-in.
- [ ] Keep diagnostics behind existing video/client log controls.
- [ ] Avoid logging full subtitle text; log counts, reasons, and timestamps.

## Step 9 - Regression Tests

- [ ] Add Python tests for subtitle classifier decisions.
- [ ] Add Python tests for probe payload render-mode fields.
- [ ] Add Python tests for ffmpeg command construction with burned-in ASS.
- [ ] Add Python tests for subtitle extraction sanitization.
- [ ] Add JS tests for subtitle selector/render-mode decisions.
- [ ] Add JS tests for switching sidecar to burn-in and burn-in to off.
- [ ] Add or update E2E coverage for compatibility playback with an
  advanced-ASS fixture.
- [ ] Add a regression fixture or synthetic ASS sample that reproduces the
  Fruits Basket S02E10 logo/title and S02E04 logo failures without depending on
  private media.

## Step 10 - Verification

- [ ] Run compile checks:
  `python -m py_compile dropbox_browser.py`
- [ ] Run package compile checks:
  `python -m compileall -q dropbox_browser.py dropbox_browser`
- [ ] Run video tests:
  `python -m tests.run video -v`
- [ ] Run web tests if client UI or assets changed:
  `python -m tests.run web -v`
- [ ] Run JS tests if video JS modules changed:
  `npm run test:js`
- [ ] Run focused browser or Playwright video tests if subtitle switching or
  HLS session restart behavior changed.

## Step 11 - Manual Validation

- [ ] Clear video subtitle caches before validating the Fruits Basket repro.
- [ ] Confirm probe metadata identifies the selected/default S02E10 and S02E04
  track `4`, `English (Full) [LostYears]`, as ASS.
- [ ] Open the S02E10 repro file and select track `4`,
  `English (Full) [LostYears]`.
- [ ] Verify `00:01:34` no longer shows raw `F`, `r`, `u`, or vector path text.
- [ ] Verify `00:23:47` no longer shows raw `{*}Mine and Mine Alone{*All Mine}`
  markup in the subtitle overlay.
- [ ] Open the S02E04 repro file and select track `4`,
  `English (Full) [LostYears]`.
- [ ] Verify `00:00:49` no longer shows raw logo letters or vector path text.
- [ ] Verify normal dialogue subtitles still appear with the selected track.
- [ ] Verify subtitle off removes the burned-in track after a restart.
- [ ] Verify switching audio tracks preserves the selected subtitle behavior.
- [ ] Compare the three repro timestamps against VLC for visual parity.
