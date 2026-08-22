"""Forced subtitle burn-in support for HLS compatibility sessions.

When the video player's "Force Subtitle Burn-in" switch is enabled, a selected
WebVTT-compatible (text) subtitle stream is rendered into the HLS output by
ffmpeg's ``subtitles`` video filter instead of being mounted as a sidecar
WebVTT overlay. Bitmap (PGS) burn-in keeps using the existing overlay filter
graph in :mod:`dropbox_browser.video`.

This module owns the text-subtitle burn-in pieces so ``video.py`` and
``handlers.py`` only carry thin call sites. All helpers are pure or run one
short ffmpeg extraction; no session state lives here.
"""

from __future__ import annotations

import subprocess
import re
from pathlib import Path, PurePosixPath
from typing import Any


def forced_burnin_requested(force_flag: object, subtitle_stream_index: object) -> bool:
    """Return True only when the client explicitly asked for forced burn-in
    and a subtitle stream index was actually provided."""
    if force_flag is None or force_flag is False:
        return False
    if isinstance(force_flag, str):
        if force_flag.strip() != "1":
            return False
    elif not force_flag:
        return False
    return subtitle_stream_index is not None


def _escape_subtitles_filter_path(path_text: str) -> str:
    """Escape a path for use inside ffmpeg's ``subtitles`` filter argument.

    The path is expected to be relative with forward slashes (the caller passes
    a name inside the ffmpeg working directory). Filter option parsing treats
    ``:`` and ``'`` specially, and the value is wrapped in single quotes by the
    caller, so escape those characters.
    """
    escaped = str(path_text).replace("\\", "/")
    escaped = escaped.replace("'", r"\'")
    escaped = escaped.replace(":", r"\:")
    return escaped


# Headerless SRT files get an implicit libass script with PlayResY=288, so a
# Fontsize value is expressed in 288ths of the video frame height. The WebVTT
# overlay's CSS font size is expressed in CSS pixels of the displayed video
# box. Converting between the two:
#   Fontsize = css_font_size_px * SUBTITLE_BURNIN_PLAYRES_Y / display_height_px
SUBTITLE_BURNIN_PLAYRES_Y = 288


def scale_burnin_font_size(
    font_size_px: int | None,
    display_height_px: int | None,
    video_height_px: int | None,
) -> int | None:
    """Convert the overlay CSS font size into libass Fontsize units.

    ``display_height_px`` is the client's rendered video box height in CSS
    pixels. When it is unknown, fall back to the video's own pixel height so
    the burned-in text occupies the same fraction of the frame as
    ``font_size_px`` pixels would of a video shown at native resolution.
    """
    if font_size_px is None or int(font_size_px) <= 0:
        return None
    reference_height = display_height_px or video_height_px
    if not reference_height or int(reference_height) <= 0:
        return int(font_size_px)
    scaled = (
        float(font_size_px)
        * SUBTITLE_BURNIN_PLAYRES_Y
        / float(reference_height)
    )
    return max(1, int(round(scaled)))


def scale_burnin_offset_px(
    offset_px: int | None,
    display_height_px: int | None,
    video_height_px: int | None,
) -> int | None:
    """Scale an overlay CSS pixel offset into burned-in frame pixels.

    MarginV is expressed in PlayResY (288) units like Fontsize, so the same
    conversion applies. Returns the offset clamped to >= 0; None passes
    through so no MarginV is emitted.
    """
    if offset_px is None:
        return None
    scaled = float(offset_px) * SUBTITLE_BURNIN_PLAYRES_Y / float(
        display_height_px or video_height_px or SUBTITLE_BURNIN_PLAYRES_Y
    )
    return max(0, int(round(scaled)))


def build_force_style_arg(
    *,
    stroke_enabled: bool = True,
    shadow_enabled: bool = True,
    font_size_px: int | None = None,
    offset_px: int | None = None,
) -> str:
    """Map the shared subtitle style options onto an ASS ``force_style`` string.

    Mirrors the WebVTT overlay semantics:
    - stroke enabled adds an opaque outline (libass ``BorderStyle=3`` box used
      only for its outline rendering here) via ``Outline`` weight,
    - shadow enabled adds the drop shadow component,
    - positive ``offset_px`` moves subtitles up like the overlay does.
    """
    parts: list[str] = []
    if stroke_enabled:
        # BorderStyle=3 renders an opaque background box; combined with a
        # matching BackColour alpha of 0 the box disappears and only the
        # heavier Outline remains visible, approximating the overlay stroke.
        parts.extend([
            "BorderStyle=3",
            # Thin outline approximating the overlay's ~1.25px text-shadow
            # stroke without visibly fattening the glyphs.
            "Outline=1",
            "BackColour=&H00000000",
        ])
    else:
        parts.append("BorderStyle=1")
        parts.append("Outline=0")
    if shadow_enabled:
        parts.append("Shadow=2")
    else:
        parts.append("Shadow=0")
    if font_size_px is not None and int(font_size_px) > 0:
        parts.append(f"Fontsize={int(font_size_px)}")
    if offset_px is not None and int(offset_px) != 0:
        # ASS MarginV grows upward from the bottom, matching the overlay help
        # text ("Positive values move subtitles up").
        parts.append(f"MarginV={max(0, int(offset_px))}")
    return ",".join(parts)


def build_text_subtitle_burnin_filter(
    subtitle_path: Path | str,
    *,
    stroke_enabled: bool = True,
    shadow_enabled: bool = True,
    font_size_px: int | None = None,
    offset_px: int | None = None,
) -> str:
    """Build the ``subtitles`` filter fragment for burned-in text subtitles."""
    if isinstance(subtitle_path, Path):
        # Prefer a forward-slash relative form; ffmpeg runs with the session
        # directory as cwd so callers pass names relative to it.
        path_text = PurePosixPath(subtitle_path.as_posix()).as_posix()
    else:
        path_text = str(subtitle_path)
    force_style = build_force_style_arg(
        stroke_enabled=stroke_enabled,
        shadow_enabled=shadow_enabled,
        font_size_px=font_size_px,
        offset_px=offset_px,
    )
    escaped = _escape_subtitles_filter_path(path_text)
    return f"subtitles=filename='{escaped}':force_style='{force_style}'"


def build_srt_extraction_command(
    ffmpeg_exe: Path | str,
    input_url: str,
    output_path: Path | str,
    *,
    subtitle_stream_index: int,
    start_time_seconds: float = 0.0,
) -> list[str]:
    """Build the short ffmpeg command that extracts one text subtitle stream
    to an SRT file."""
    command = [
        str(ffmpeg_exe),
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
    ]
    if start_time_seconds > 0:
        command.extend(["-ss", f"{float(start_time_seconds):.3f}"])
    command.extend([
        "-i",
        str(input_url),
        "-map",
        f"0:{int(subtitle_stream_index)}",
        "-f",
        "srt",
        str(output_path),
    ])
    return command


def extract_subtitle_stream_to_srt(
    ffmpeg_exe: Path | str,
    input_url: str,
    output_path: Path,
    *,
    subtitle_stream_index: int,
    start_time_seconds: float = 0.0,
    timeout_seconds: float = 60.0,
) -> bool:
    """Extract one text subtitle stream to ``output_path``.

    Returns True when the SRT file exists afterwards and is non-empty.
    Raises :class:`RuntimeError` when ffmpeg fails outright so the caller can
    surface a session-create error instead of silently dropping subtitles.
    """
    command = build_srt_extraction_command(
        ffmpeg_exe,
        input_url,
        output_path,
        subtitle_stream_index=subtitle_stream_index,
        start_time_seconds=start_time_seconds,
    )
    try:
        completed = subprocess.run(  # noqa: S603 - fixed argv list
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=timeout_seconds,
            check=False,
        )
    except FileNotFoundError as exc:
        raise RuntimeError(f"ffmpeg was not found: {exc}") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("Subtitle burn-in extraction timed out.") from exc
    if completed.returncode != 0:
        detail = ""
        if completed.stderr:
            detail = completed.stderr.decode("utf-8", "replace").strip()[:400]
        raise RuntimeError(f"Subtitle burn-in extraction failed: {detail}")
    return output_path.exists() and output_path.stat().st_size > 0


def log_fields_for_session(
    *,
    force_subtitle_burn_in: bool,
    burnin_mode: str | None,
    srt_name: str | None,
) -> dict[str, Any]:
    """Structured debug fields for ``session_create_start`` logging."""
    fields: dict[str, Any] = {
        "force_subtitle_burn_in": bool(force_subtitle_burn_in),
    }
    if burnin_mode is not None:
        fields["burnin_mode"] = str(burnin_mode)
    if srt_name is not None:
        fields["burnin_subtitle_file"] = str(srt_name)
    return fields

_FONT_TAG_PATTERN = re.compile(r"</?font\b[^>]*>", re.IGNORECASE)
_OTHER_TAG_PATTERN = re.compile(r"</?(?![biu]>)[a-zA-Z][a-zA-Z0-9]*\b[^>]*>", re.IGNORECASE)


def sanitize_srt_text(text: str) -> str:
    """Strip ASS-to-SRT markup tags that override burn-in styling.

    ffmpeg's ASS/SRT conversion emits tags like
    ``<font face="Cabin" size="75">``; libass honors them and they would
    override the ``force_style`` sizing this feature depends on. Inner text
    is kept; italic/bold/underline markers are preserved.
    """
    cleaned = _FONT_TAG_PATTERN.sub("", text)
    cleaned = _OTHER_TAG_PATTERN.sub("", cleaned)
    return cleaned


def sanitize_srt_file(path):
    """Rewrite an extracted SRT in place without font/size markup.

    Returns True when any line changed.
    """
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False
    out = []
    changed = False
    for line in raw.splitlines(keepends=True):
        cleaned = sanitize_srt_text(line)
        if cleaned != line:
            changed = True
        out.append(cleaned)
    if changed:
        path.write_text("".join(out), encoding="utf-8", newline="")
    return changed
