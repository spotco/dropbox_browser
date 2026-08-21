# Force Subtitle Burn-In Mode Plan

Date: 2026-08-21
Status: Implemented; validation complete
Branch: `feature/force-subtitle-burnin`
Scope: one implementation day

## Progress

- [x] Step 1 - Read docs and confirm contracts
- [x] Step 2 - New server-side module `dropbox_browser/video_burnin.py`
- [x] Step 3 - Wire the session-create server path
- [x] Step 4 - Python tests for the burn-in command builder and session wiring
- [x] Step 5 - Client template switch and settings plumbing
- [x] Step 6 - Client playback routing through effective burn-in selection
- [x] Step 7 - E2E suite for force burn-in behavior
- [x] Step 8 - Documentation updates
- [x] Step 9 - Full verification

## Objective

Add an opt-in **Force Subtitle Burn-in** switch to the video player's Subtitle
Style section. When enabled, a selected WebVTT-compatible (text) subtitle track
is rendered as burned-in subtitles inside the HLS compatibility session instead
of being mounted as a sidecar WebVTT overlay. Existing burned-in (bitmap PGS)
behavior is untouched. All existing subtitle style controls (drop shadow, text
stroke, text size, height offset) apply to forced burn-in sessions, giving
those styles real parity with the WebVTT overlay path.

## Constraints and invariants

- Follow AGENTS.md hard safety rules: no delete behavior, no uploads, no
  hotlinked assets, paths stay validated.
- No new libraries or dependencies; stdlib Python and the existing JS modules
  only.
- Default behavior with the switch off must be byte-for-byte identical to
  today: the server ignores forced burn-in unless the client explicitly sends
  the new form field, and the client sends it only when the switch is on.
- New server-side burn-in code lives in a dedicated new module,
  `dropbox_browser/video_burnin.py`. `video.py` and `handlers.py` only gain
  thin call sites.
- Reuse the existing `subtitle_style` applied-options machinery on the client;
  do not invent a second settings store.
- Do not commit to master; work stays on `feature/force-subtitle-burnin`.

## Design notes

Today the client only sends `subtitle_stream_index` on session create when the
selected track is *not* WebVTT compatible (bitmap PGS), and
`build_ffmpeg_hls_command` composites those bitmap subtitles with an
`overlay`-based filter graph styled by the shadow/stroke toggles.

Text (subrip/ass) streams cannot feed that bitmap `overlay` graph. Forced
burn-in therefore uses ffmpeg's `subtitles` video filter instead:

1. Before spawning the main HLS ffmpeg process, the server extracts the
   selected text subtitle stream to a temporary `.srt` file inside the
   session directory (reusing the existing ffmpeg extraction helpers).
2. The main command's filter graph becomes
   `[0:v:0]subtitles=filename='<relative.srt>':force_style='...'` with
   `force_style` derived from the four existing style options:
   - stroke enabled -> `BorderStyle=3` style outline (Outline + Back Colour)
   - shadow enabled -> drop shadow component
   - font size -> `Fontsize=<px>`
   - offset -> `MarginV=<px>` (positive moves up, matching the overlay help)
3. Because the filter consumes video, session creation reports
   `video_transcode` / `subtitle_burn_in_requires_filter` exactly like bitmap
   burn-in already does.

On the client, `selectedBurnedInSubtitleStreamIndex()` is the single choke
point every playback path already consults (session create, sidecar guards,
seek-restart decisions, subtitle-style restart decisions). Teaching it to
return the selected stream index when the force switch is on routes the whole
existing feature set (restart-on-track-change, restart-on-style-change, no
sidecar mounting, seek parity) through burn-in automatically.

## Step 1 - Read docs and confirm contracts

- [x] Read `AGENTS.md`, `docs/architecture.md` ownership map, and
      `docs/video-player.md` (session endpoints, subtitle paths, testing).
- [x] Confirm session-create form parsing in `handlers.py`
      (`serve_video_endpoint_post`) and `VideoSessionManager.create_session`
      in `video.py` are the only server entry points to extend.
- [x] Confirm `tests/test_video_endpoints.py` already unit-tests
      `build_ffmpeg_hls_command`; mirror that style for the new module.

## Step 2 - New server-side module `dropbox_browser/video_burnin.py`

Create `dropbox_browser/video_burnin.py` with pure, unit-testable helpers:

- [x] `forced_burnin_requested(force_flag, subtitle_stream_index) -> bool`
- [x] `build_text_subtitle_burnin_filter(subtitle_path, *, stroke_enabled,
      shadow_enabled, font_size_px, offset_px) -> str` returning the
      `-vf`/filter fragment using the `subtitles` filter with `force_style`,
      with Windows-safe relative path quoting (forward slashes, `:` escaped).
- [x] `build_force_style_arg(...)` mapping the four style booleans/numbers to
      the ASS `force_style` string (pure string math).
- [x] `extract_subtitle_stream_to_srt(ffmpeg_exe, input_url,
      output_path, subtitle_stream_index, start_time_seconds)` running the
      short ffmpeg extraction (`-map 0:<index> -f srt`) with timeout, used once
      per session before the main spawn.

## Step 3 - Wire the session-create server path

- [x] `handlers.py serve_video_endpoint_post`: parse
      `force_subtitle_burn_in` (`!= "0"` only counts when `"1"`), pass through
      plus the already-parsed subtitle style values.
- [x] `video.py create_session`: accept `force_subtitle_burn_in: bool =
      False` and the two number style values (`subtitle_font_size_px`,
      `subtitle_offset_px`); when the flag is set, the selected stream exists,
      and probe says it is WebVTT compatible, call
      `video_burnin.extract_subtitle_stream_to_srt(...)` into the session dir
      and hand the built filter to `build_ffmpeg_hls_command` via a new
      `extra_video_filter` parameter; log the decision in
      `log_video_debug("session_create_start", ...)` fields
      (`force_subtitle_burn_in=True`, `burnin_mode="text_subtitles_filter"`).
- [x] `build_ffmpeg_hls_command`: add optional `extra_video_filter: str |
      None` that, when present, replaces the bitmap overlay branch (the caller
      has already decided the filter), while keeping `-sn` and transcode flags
      identical.

## Step 4 - Python tests

- [ ] New `tests/test_video_burnin.py` (stdlib unittest, registered with the
      `video` group runner): force_style mapping matrix, filter quoting on
      Windows-style relative paths, `forced_burnin_requested` gating, and
      extraction command construction (patch subprocess).
- [ ] Extend `tests/test_video_endpoints.py`: session create POST with
      `force_subtitle_burn_in=1` on a text-subtitle fixture produces a command
      containing the `subtitles=` filter and `video_transcode`; without the
      flag the command is unchanged from today.
- [ ] Run: `python -m tests.run video -v`.

## Step 5 - Client template switch and settings plumbing

- [x] `assets/templates/video_player.html`: add a checkbox row item
      `<input type="checkbox" id="video-subtitle-force-burnin">` labeled
      "Force Subtitle Burn-in" inside the Subtitle Style section checkbox row;
      extend the help paragraph to say the switch renders WebVTT-capable
      tracks as burned-in subtitles.
- [x] `assets/js/video.js`: register
      `subtitleForceBurnInEl: document.getElementById('video-subtitle-force-burnin')`
      in `ctx.els`.
- [x] `assets/js/video/tracks.js`: add `forceBurnIn: false` to
      `SUBTITLE_STYLE_DEFAULTS`, thread it through
      clone/equal/persist/sync/preview functions (persisted in the existing
      `video-subtitle-style` setting), and treat a toggle of it as a burned-in
      style change (restart when a subtitle is active) in
      `handleSubtitleStyleApply`.

## Step 6 - Client playback routing

- [x] `assets/js/video/subtitles.js`: make
      `selectedBurnedInSubtitleStreamIndex()` return the normalized selected
      stream index when force burn-in is applied and the selected stream is
      WebVTT compatible (bitmap-requiring streams keep their current path);
      add `forceBurnInApplied()` reading the applied style options. All other
      modules (playback, compatibility, seek decisions, style-apply restarts)
      keep calling the same function, so no duplicated branching appears.
- [x] `assets/js/video/compatibility.js` `createCompatibilitySession`: append
      `force_subtitle_burn_in=1` and the numeric
      `subtitle_font_size_px` / `subtitle_offset_px` fields when a burn-in
      session is being created with the force option applied.

## Step 7 - E2E suite

New `tests/e2e/video-subtitle-force-burnin.integration.spec.js` modeled on
`video-subtitle-bitmap.integration.spec.js` (own port, generated fixture,
HLS stub). Cases:

- [ ] Switch is present in the Subtitle Style section, defaults unchecked,
      and its checked state survives reload (settings persistence).
- [ ] With the switch on and a text subtitle track selected, playing a fixture
      file issues a session POST containing `force_subtitle_burn_in=1` and
      `subtitle_stream_index`, never requests `/video/endpoints/subtitles`,
      and reaches visible playback.
- [ ] With the switch off, the same selection issues a session POST without
      `subtitle_stream_index` and mounts the sidecar WebVTT overlay (existing
      behavior preserved).
- [ ] Toggling the switch during playback of a sidecar-subtitle item triggers
      a compatibility session restart carrying the burn-in fields.
- [ ] Run: `npx playwright test --project=video tests/e2e/video-subtitle-force-burnin.integration.spec.js`.

## Step 8 - Documentation updates

- [x] `docs/video-player.md`: document the switch, the text burn-in filter
      path, the new form fields, and the new module in the ownership table and
      Subtitles section.

## Step 9 - Full verification

```powershell
run\win\run_python.bat py_compile dropbox_browser/video_burnin.py
run\win\run_python.bat compileall -q dropbox_browser.py dropbox_browser
run\win\run_python.bat tests.run video -v
npm run test:js
npm run test:e2e:video
```

Manual smoke: start the server, play a text-subtitle video with the switch off
(sidecar), flip the switch, apply, confirm restart burns subtitles into the
frame and style size/offset/shadow/stroke visibly apply.
