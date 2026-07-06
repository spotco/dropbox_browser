# Video Subtitle Styling Plan — Burn-In Parity, Font, and Weight

## Goal

Close the gap between WebVTT overlay styling and burned-in (ffmpeg HLS) subtitle
styling, then extend the player subtitle-style UI with font family and font
weight controls.

Today the player exposes shadow, stroke, text size, and height offset in the
track panel, but burned-in sessions only honor shadow and stroke. Font family
and weight exist only as server config defaults on initial page load, not as
per-user player controls.

Target outcomes:

1. **Burn-in parity for existing UI controls** — text size and height offset
   affect burned-in output when technically possible.
2. **Font selector** — user-chosen font family for WebVTT overlay, with the
   best achievable burned-in equivalent per subtitle codec class.
3. **Font weight selector** — user-chosen weight for WebVTT overlay, with
   burned-in support only where parity is realistic.

Success criteria:

- One shared `video-subtitle-style` settings object drives WebVTT CSS variables
  and burned-in session parameters.
- Apply semantics stay predictable: size/offset/font changes update WebVTT
  immediately on Apply; burned-in changes restart the compatibility session when
  a burned-in track is active (same pattern as shadow/stroke today).
- UI clearly labels controls that are WebVTT-only or approximate for bitmap
  burned-in tracks.
- Unit tests cover command construction and client apply/restart decisions;
  e2e covers at least one burned-in size/offset case and one WebVTT font case.

## Current State

### Client subtitle style (`tracks.js`)

Persisted setting key: `video-subtitle-style`.

| Control | WebVTT overlay | Burned-in HLS | Apply / restart |
| --- | --- | --- | --- |
| Drop shadow | CSS `--video-subtitle-shadow` | `subtitle_shadow_enabled` on session create | Checkbox live-preview; burn-in restart on Apply when burned-in active |
| Text stroke | CSS text-shadow outline | `subtitle_stroke_enabled` on session create | Same as shadow |
| Text size | CSS `--video-subtitle-font-size` | **Not implemented** | Apply only; no burn-in restart today |
| Height offset | CSS `bottom: calc(8% + offset)` | **Not implemented** | Apply only; positive = up, negative = down |

Code notes already mark the burn-in gap in:

- `dropbox_browser/assets/js/video/tracks.js`
- `dropbox_browser/assets/js/video/compatibility.js`
- `dropbox_browser/video.py` (`build_ffmpeg_hls_command`)

### Server defaults (not in player UI)

Config keys in `dropbox_browser/config.py`:

- `VideoSubtitleFontFamily` → `--video-subtitle-font-family` on `<body>` via
  `views._subtitle_style_attr()`
- `VideoSubtitleBold` → `--video-subtitle-font-weight` (`700` or `400`)
- `VideoSubtitleFontSizePx` → initial `--video-subtitle-font-size` before client
  settings load

These defaults are overwritten once `tracks.js` restores persisted player
settings.

### Subtitle delivery paths

- **Sidecar WebVTT** — text rendered in `.video-subtitle-overlay` (and `::cue`
  for native track fallback). Full CSS styling.
- **Burned-in** — ffmpeg `filter_complex` composites decoded subtitle bitmaps
  onto video. Current graph duplicates the rgba subtitle plane for stroke/shadow,
  then `[tmpN][sub_main]overlay[vout]` with no size, offset, font, or weight
  parameters.

### Burn-in codec classes

From `subtitle_codec_supports_webvtt()` / `_WEBVTT_INCOMPATIBLE_SUBTITLE_CODECS`:

| Class | Codecs | Font family / weight | Size / offset |
| --- | --- | --- | --- |
| **Bitmap** | `hdmv_pgs_subtitle`, `pgssub`, `dvd_subtitle`, `dvb_subtitle`, `vobsub`, `xsub` | Pre-rendered glyphs; true font/weight change is **not possible** | Global **scale** and **vertical shift** of the composited subtitle layer are feasible |
| **Text (non-WebVTT path)** | Rare burn-in cases where extraction fails but decode-to-rgba still works | Limited; changing typeface requires a different ffmpeg render path (`subtitles` + `force_style`), not the current rgba-overlay graph | Same scale/shift as bitmap unless/until render path changes |

Most real burn-in traffic in this app is **bitmap** (see `tests/e2e/video-subtitle-bitmap.integration.spec.js`).

## Parity Principles

- Do not pretend bitmap burned-in subtitles support font family or weight.
- Prefer **honest UI**: disable or annotate controls when the active track cannot
  use them; still allow size/offset where scale/shift helps.
- Keep one settings schema; each delivery path consumes the fields it supports.
- Avoid breaking the existing stroke/shadow overlay graph for bitmap codecs.
- Size/offset parity for burn-in should target **visual similarity**, not pixel
  identity with WebVTT CSS text.

## Shared Settings Model (prerequisite)

Extend `SUBTITLE_STYLE_DEFAULTS` / persisted `video-subtitle-style`:

```javascript
{
  shadowEnabled: true,
  strokeEnabled: true,
  fontSizePx: 28,
  offsetPx: 0,
  fontFamily: "Arial, Helvetica, sans-serif",  // new
  fontWeight: 700,                              // new; 400 | 700 | 900
}
```

Migration: missing keys fall back to current server defaults from config.

Shared helpers:

- `subtitleStyleOptionsEqual()` — compare full object.
- `burnedInSubtitleStyleOptionsEqual()` — expand beyond shadow/stroke once
  burn-in consumes size/offset (and later font fields where supported).
- `burnedInRestartRequired(previous, next, stream)` — centralize which fields
  force a session restart for the active burned-in codec class.

## Phase 1 — Burn-In Size and Offset

### 1A. Server session parameters

Add optional session-create fields:

- `subtitle_font_size_px` — integer, omitted = default `28`
- `subtitle_offset_px` — signed integer, omitted = `0`; **same semantics as
  WebVTT**: positive moves subtitles up

Wire through:

- `handlers.serve_video_endpoint_post()` (`/video/endpoints/session`)
- `VideoSessionManager.create_session()`
- `build_ffmpeg_hls_command()` new kwargs

### 1B. ffmpeg filter graph

Apply styling on the **final** `[sub_main]` branch before compositing onto
`[0:v:0]`, after stroke/shadow processing so outline/shadow scale with the
subtitle plane.

Proposed helpers in `video.py`:

- `_subtitle_burn_in_scale_factor(font_size_px: int, reference_px: int = 28) -> float`
- `_subtitle_burn_in_overlay_y(offset_px: int) -> int` → return `-offset_px`
  (ffmpeg `overlay` positive `y` moves down; user positive offset moves up)

Filter insertion sketch (stroke+shadow path):

```text
[sub_main]scale=iw*S:ih*S[sub_sized];
...
[tmp5][sub_sized]overlay=0:Y[vout]
```

Where `S = font_size_px / 28` and `Y = -offset_px`.

Validation:

- Reject non-finite or empty values; no arbitrary client-side caps unless ffmpeg
  rejects them.
- Log chosen `S` and `Y` in `video_debug.jsonl` when `LogVideoDebug` is enabled.

### 1C. Client forwarding

In `compatibility.js` `createCompatibilitySession()`:

- Forward `subtitle_font_size_px` and `subtitle_offset_px` from
  `appliedSubtitleStyleOptions()` when `subtitle_stream_index` is set.

In `tracks.js` `handleSubtitleStyleApply()`:

- Include `fontSizePx` and `offsetPx` in `burnedInSubtitleStyleOptionsEqual()`
  **or** replace with codec-aware `burnedInRestartRequired()`.
- Update status text: burned-in restarts when size/offset/shadow/stroke change.

### 1D. Tests

- `tests/test_video_endpoints.py` — assert `scale=` and `overlay=0:<y>` appear
  in `-filter_complex` for non-default size/offset.
- `tests/js/video-tracks.test.js` — burned-in restart fires on size/offset apply.
- `tests/e2e/video-subtitle-bitmap.integration.spec.js` — optional visual or
  session-post assertion that size/offset params are sent on apply.

### 1E. Documentation

- Update `docs/video-player.md` burned-in styling section.
- Replace “not yet implemented” comments in code once shipped.

### Phase 1 risks

- Full-frame subtitle rgba planes may clip when shifted/up-scaled; verify with
  PGS and DVD subs in e2e.
- Stroke/shadow offsets are fixed pixels today; scaling `[sub_main]` may change
  apparent outline thickness relative to text. Accept for v1 or scale stroke
  offsets proportionally in a follow-up.

---

## Phase 2 — Font Selector

### 2A. UI

Add a **Font** control to the subtitle style section (same Apply semantics as
size/offset):

- `<select id="video-subtitle-font-family">` with a **curated** list, not free
  text.
- Keep the checkbox row and number row layout; font + weight can share a new
  third row or sit beside weight in a compact two-column row.

Recommended initial options (CSS + libass-friendly):

| Label | Value |
| --- | --- |
| Arial | `Arial, Helvetica, sans-serif` |
| Helvetica | `Helvetica, Arial, sans-serif` |
| Segoe UI | `"Segoe UI", Arial, sans-serif` |
| Times New Roman | `"Times New Roman", Times, serif` |
| Courier New | `"Courier New", Courier, monospace` |
| Verdana | `Verdana, Arial, sans-serif` |

Do not add web font downloads in v1; rely on OS-installed faces.

### 2B. WebVTT implementation

- Persist `fontFamily` in `video-subtitle-style`.
- On Apply, set `--video-subtitle-font-family` on `document.body` (same as size).
- Checkbox live-preview does **not** need to preview font (match size/offset
  behavior).

### 2C. Burned-in implementation (codec-aware)

| Codec class | v1 behavior |
| --- | --- |
| **Bitmap** | **No font change.** UI shows helper text: “Font applies to WebVTT subtitles only. Bitmap burned-in subtitles keep their source typeface; use Text Size to scale.” Do not send `subtitle_font_family` for bitmap streams. |
| **Future text render path** | Defer: switching bitmap overlay graph to `subtitles=...:force_style='FontName=Arial'` is a separate project and may break PGS. |

Optional v1.1 for bitmap: none (font selector disabled when burned-in bitmap
track selected).

### 2D. Server / session (when supported)

Reserved parameter for a future text-render path:

- `subtitle_font_family` — sanitized string from allowlist only.

Handler must reject unknown families.

### 2E. Tests

- `tests/js/video-tracks.test.js` — font persisted and applied to CSS variable.
- `tests/test_web_ui.py` — template contains font `<select>`.
- Burned-in bitmap e2e — assert session POST does **not** include font param.

### 2F. Config relationship

- Player setting wins over `VideoSubtitleFontFamily` after first Apply.
- Initial page load can still seed from config until client restores local
  storage.

---

## Phase 3 — Font Weight Selector

### 3A. UI

Add **Weight** control:

- `<select id="video-subtitle-font-weight">` with `400` (Normal), `700` (Bold),
  `900` (Heavy) — mirror CSS weights already used in overlay CSS.

### 3B. WebVTT implementation

- Persist `fontWeight` (integer).
- Apply `--video-subtitle-font-weight` on Apply.
- Confirm `.video-subtitle-overlay b` and `::cue` bold tags still render; weight
  selector sets base weight only.

### 3C. Burned-in parity assessment

| Codec class | Achievable? | v1 proposal |
| --- | --- | --- |
| **WebVTT** | Yes | Full support |
| **Bitmap (PGS, DVD, …)** | **No** true weight | Disable weight selector when burned-in bitmap track is active; helper text explains limitation |
| **ASS via `subtitles` filter** | Partial (`Bold=0/1`) | Defer until text render path exists; do not claim 900/heavy parity |

Do **not** simulate bold on bitmap burn-in by stretching pixels unless a later
experiment shows acceptable quality.

### 3D. Server / session (deferred)

- `subtitle_font_weight` — only if a text `force_style` path is added later.

### 3E. Tests

- WebVTT unit test: weight `400` vs `700` sets CSS variable.
- UI contract test for weight `<select>`.
- When burned-in bitmap selected, weight control disabled (JS unit test on
  `renderSubtitleStyleControls` or equivalent helper).

---

## Phase 4 — Polish and UX

- [ ] Subtitle style help text summarizes per-path behavior in one line.
- [ ] Status messages distinguish “applied to WebVTT only” vs “restarting
      burned-in playback”.
- [ ] When user switches from WebVTT track to burned-in bitmap, refresh control
      disabled states without losing draft values.
- [ ] Remove duplicate server-only defaults from `_subtitle_style_attr()` once
      client always owns font/size/weight after `initTracks()` (or keep as
      first-paint fallback only).

---

## Suggested Implementation Order

```text
Phase 0  Tests green before changes
Phase 1  Burn-in size + offset (highest user-visible gap for existing controls)
Phase 2  Font selector (WebVTT full + bitmap burn-in honest disable)
Phase 3  Font weight selector (WebVTT full + bitmap burn-in honest disable)
Phase 4  UX polish and docs
```

Phase 1 is independent. Phases 2–3 should share the extended settings schema
and Apply plumbing from Phase 1.

---

## Testing Matrix

| Case | Group |
| --- | --- |
| `build_ffmpeg_hls_command` scale/overlay args | `python -m tests.run video -v` |
| Client restart on burn-in style apply | `node --test tests/js/video-tracks.test.js` |
| Template/CSS contracts | `python -m tests.run web -v` |
| Bitmap burn-in style apply | `tests/e2e/video-subtitle-bitmap.integration.spec.js` |
| WebVTT font/weight overlay | new focused e2e or JS unit tests |

Run full video e2e before checkin when `video.py`, `tracks.js`, or
`compatibility.js` change together.

---

## Out of Scope (this plan)

- Free-text font input or Google Fonts loading.
- Per-track style overrides (global setting only).
- ASS `force_style` rewrite of the burn-in graph for text codecs.
- Stroke/shadow pixel-perfect parity between CSS and ffmpeg.
- Changing source ASS/PGS subtitle positioning metadata inside the media.

---

## Open Questions

1. **Scale anchor** — scale subtitle plane from center vs top-left affects
   perceived vertical position when combined with offset. Prototype with PGS
   content before locking math.
2. **Reference font size** — use `28` as fixed reference for burn-in scale, or
   read from config `VideoSubtitleFontSizePx`?
3. **Weight 900** — keep in UI for WebVTT only, or limit selector to 400/700
   until burn-in text path exists?
4. **Native `::cue` track** — today secondary to custom overlay; confirm font
   controls also update `::cue` via shared CSS variables (they should).

---

## File Touch Map (expected)

| Area | Files |
| --- | --- |
| UI template | `dropbox_browser/assets/templates/video_player.html` |
| UI styles | `dropbox_browser/assets/css/video.css` |
| Client style state | `dropbox_browser/assets/js/video/tracks.js` |
| Session create body | `dropbox_browser/assets/js/video/compatibility.js` |
| HTTP handler | `dropbox_browser/handlers.py` |
| ffmpeg command | `dropbox_browser/video.py` |
| Docs | `docs/video-player.md` |
| Tests | `tests/test_video_endpoints.py`, `tests/js/video-tracks.test.js`, `tests/test_web_ui.py`, e2e bitmap spec |