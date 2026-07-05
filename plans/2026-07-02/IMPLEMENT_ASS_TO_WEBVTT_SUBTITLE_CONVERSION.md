# ASS To WebVTT Subtitle Conversion Plan

## Goal

Fix ASS subtitle tracks that currently leak raw ASS drawing, positioning, and
override markup into the browser subtitle overlay after ffmpeg converts them to
WebVTT.

The implementation should keep subtitle rendering on the existing sidecar
WebVTT/browser-overlay path and improve ASS handling there. The primary fix is
to parse ASS into cleaner WebVTT-compatible subtitle output, strip unsupported
ASS metadata/tags, and add selective parity for obvious high-value ASS features
when they can be represented reasonably in the current browser subtitle path.

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
features are flattened into raw cue text or noisy cue metadata.

## Design Direction

Use a WebVTT-first model for ASS subtitle handling:

- Parse ASS subtitle content directly instead of relying only on ffmpeg's
  WebVTT conversion output.
- Strip unsupported ASS override blocks, drawing commands, comments, and other
  metadata that should never leak into cue text.
- Preserve plain dialogue faithfully.
- When complex ASS sign/layout content cannot be represented well, keep
  readable plain text by default rather than leaking raw ASS syntax or dropping
  potentially useful text outright.
- Implement a small, explicit subset of ASS parity features where they are both
  obvious and useful in the browser subtitle overlay.
- Avoid scanning the entire subtitle track just to decide whether playback
  should switch to burned-in rendering. Burn-in is not the primary path in this
  plan.

Do not attempt to implement a full libass-equivalent renderer or a complete ASS
layout engine in JavaScript or Python. Prefer conservative cleanup and small
feature translations over broad rendering ambition.

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

## Step 2 - Parse And Sanitize ASS Tracks

- [x] Inspect current ASS-specific failure patterns and add focused parsing
  helpers in `dropbox_browser/video.py`.
- [x] Keep non-ASS text tracks on the existing WebVTT-compatible behavior.
- [x] Parse ASS/SSA event text conservatively enough to identify dialogue,
  drawing-mode cues, obvious sign/layout markup, and high-risk metadata.
- [x] Treat drawing mode (`\p1`, `\p2`, etc.) as content that should not leak
  into cue text.
- [x] Detect explicit positioning, movement, clipping, transforms, fades, blur,
  borders, scaling, rotation, custom fonts, and non-default styles so the
  conversion path can either strip them or map small safe subsets later.
- [x] Detect overlapping signs/layered events because they affect parity and
  cleanup expectations even when they are not rendered fully.
- [x] Keep the parser conservative: dialogue should survive cleanly, while
  unsupported ASS syntax should be stripped rather than exposed to users.
- [x] Add unit tests for simple dialogue ASS, vector drawing ASS, positioned
  signs, transform/fade markup, overlapping layers, and the Fruits Basket
  logo/title patterns.

## Step 3 - Define ASS-To-WebVTT Conversion Output

- [x] Decide whether ASS parsing/conversion should live fully server-side,
  partially client-side, or use a shared intermediate format.
- [x] Prefer client-side parsing only if it does not require loading full raw
  subtitle blobs in ways that hurt startup or seek-window behavior.
- [x] If server-side parsing remains the main path, keep probe payload changes
  minimal and avoid routing metadata that exists only to drive burn-in.
- [x] Define the conversion contract for full-track extraction and windowed
  extraction so both produce the same cleaned cue output.
- [x] Add tests for the chosen conversion contract on ASS, SRT, WebVTT, and
  bitmap subtitle stream fixtures.

## Step 4 - Implement Basic ASS Cleanup

- [x] Strip ASS override tags from cue text by default.
- [x] Strip author notes, drawing commands, and other non-dialogue metadata
  that currently leak into converted WebVTT.
- [x] Preserve readable plain text from complex ASS cues by default, even when
  positioning or styling cannot be represented faithfully.
- [x] Drop pure drawing/logo cues only when no meaningful readable text remains
  after cleanup.
- [x] Preserve line breaks and plain dialogue text while removing formatting
  noise.
- [x] Make sure cleanup applies consistently to both full-track and subtitle
  window extraction.
- [x] Add focused tests for stripped tags, dropped drawing cues, and preserved
  plain dialogue.

## Step 5 - Add Targeted ASS Feature Parity

- [x] Identify the small subset of ASS features worth approximating in WebVTT
  or overlay HTML/CSS, such as basic italics, bold, underline, and simple line
  breaks/alignment if already supportable.
- [x] Implement only features that are obvious, stable, and low-risk in the
  current subtitle overlay.
- [x] Do not attempt full fidelity for animated transforms, vector graphics,
  precise positioning, or complex karaoke effects in this phase.
- [x] Leave cue-by-cue handling for ambiguous complex signs as a future
  follow-up rather than part of the default cleanup path.
- [x] Add tests showing which ASS formatting survives intentionally and which
  formatting is stripped.

## Step 6 - Harden Windowed And Full-Track Extraction

- [x] Ensure subtitle window extraction and full-track extraction share the same
  ASS parsing and cleanup behavior.
- [x] If ffmpeg still participates in extraction, make ASS cleanup happen after
  extraction in one shared path rather than as separate heuristics.
- [x] Avoid inconsistent results where startup subtitles are cleaned one way and
  later seek-window subtitles are cleaned another way.
- [x] Add tests for parity between startup/full-track and seek-window output.

## Step 7 - Update Caching And Invalidation

- [x] Include the ASS parsing/sanitizer version in cache keys or cached
  metadata where stale WebVTT could otherwise survive.
- [x] Ensure old bad ffmpeg-generated subtitle cache entries do not remain
  authoritative after this change.
- [x] Keep existing subtitle cache TTL and max-byte behavior intact.
- [x] Verify windowed subtitle cache manifests remain valid for cleaned sidecar
  subtitle tracks.
- [x] Add tests for cache-key/version changes and stale-cache avoidance.

## Step 8 - Diagnostics

- [x] Add server debug events for ASS parsing/cleanup decisions:
  track index, codec, stripped feature flags, dropped-cue counts, and reasons.
- [x] Add server debug events when WebVTT sanitization drops cues or strips
  unsupported ASS syntax.
- [ ] Add client diagnostics only where they help debug subtitle cleanup or
  missing cues.
- [x] Keep diagnostics behind existing video/client log controls.
- [ ] Avoid logging full subtitle text; log counts, reasons, and timestamps.

## Step 9 - Regression Tests

- [x] Add Python tests for ASS parse/cleanup decisions.
- [x] Add Python tests for subtitle extraction sanitization.
- [ ] Add JS tests if any client-side parsing or overlay formatting logic
  changes.
- [ ] Add or update E2E coverage for compatibility playback with cleaned ASS
  subtitle output.
- [ ] Add a regression fixture or synthetic ASS sample that reproduces the
  Fruits Basket S02E10 logo/title and S02E04 logo failures without depending on
  private media.

## Step 10 - Verification

- [x] Run compile checks:
  `python -m py_compile dropbox_browser.py`
- [x] Run package compile checks:
  `python -m compileall -q dropbox_browser.py dropbox_browser`
- [x] Run video tests:
  `python -m tests.run video -v`
- [ ] Run web tests if client UI or assets changed:
  `python -m tests.run web -v`
- [ ] Run JS tests if video JS modules changed:
  `npm run test:js`
- [ ] Run focused browser or Playwright video tests if ASS parsing, subtitle
  overlay formatting, or seek-window subtitle behavior changed.

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
- [ ] Verify subtitle off still removes the subtitle overlay cleanly.
- [ ] Verify switching audio tracks preserves the selected subtitle behavior.
- [ ] Compare the three repro timestamps against VLC for reasonable text/output
  parity, with known exceptions for unsupported complex ASS effects.

## Optional Step 12 - Burn-In Everything Later

- [ ] Evaluate an optional mode where all selected subtitle tracks render as
  burned-in compatibility subtitles instead of sidecar WebVTT.
- [ ] Keep this as a separate follow-up decision, not part of the default ASS
  cleanup implementation.
- [ ] If pursued later, define the UX and playback tradeoffs explicitly:
  session restarts, styling differences, CPU cost, and loss of browser-side
  subtitle controls.
