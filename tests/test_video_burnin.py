"""Tests for forced subtitle burn-in helpers (dropbox_browser/video_burnin.py)."""

from __future__ import annotations

import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

from dropbox_browser.video_burnin import (
    SUBTITLE_BURNIN_PLAYRES_Y,
    build_force_style_arg,
    build_srt_extraction_command,
    build_text_subtitle_burnin_filter,
    extract_subtitle_stream_to_srt,
    forced_burnin_requested,
    rebase_srt_file,
    rebase_srt_text,
    sanitize_srt_file,
    sanitize_srt_text,
    scale_burnin_font_size,
    scale_burnin_offset_px,
)


class ForcedBurninRequestedTests(unittest.TestCase):
    def test_flag_on_with_stream_index(self) -> None:
        self.assertTrue(forced_burnin_requested("1", 3))

    def test_flag_off_without_stream_index_is_false(self) -> None:
        self.assertFalse(forced_burnin_requested("1", None))
        self.assertFalse(forced_burnin_requested("", 3))
        self.assertFalse(forced_burnin_requested("0", 3))
        self.assertFalse(forced_burnin_requested(None, 3))

    def test_boolean_flag_accepted(self) -> None:
        self.assertTrue(forced_burnin_requested(True, 2))
        self.assertFalse(forced_burnin_requested(False, 2))


class BuildForceStyleArgTests(unittest.TestCase):
    def test_defaults_enable_stroke_and_shadow(self) -> None:
        # Background box defaults off; stroke renders as a plain outline.
        style = build_force_style_arg()
        self.assertIn("BorderStyle=1", style)
        self.assertIn("Outline=2", style)
        self.assertNotIn("BorderStyle=3", style)
        self.assertIn("Shadow=2", style)

    def test_background_enabled_uses_opaque_box(self) -> None:
        style = build_force_style_arg(background_enabled=True)
        self.assertIn("BorderStyle=3", style)
        self.assertIn("BackColour=&H00000000", style)
        self.assertIn("Outline=1", style)

    def test_background_overrides_stroke_borderstyle(self) -> None:
        style = build_force_style_arg(background_enabled=True, stroke_enabled=False)
        self.assertIn("BorderStyle=3", style)
        self.assertIn("BackColour=&H00000000", style)

    def test_stroke_disabled_removes_outline(self) -> None:
        style = build_force_style_arg(stroke_enabled=False)
        self.assertIn("BorderStyle=1", style)
        self.assertIn("Outline=0", style)
        self.assertIn("Shadow=2", style)

    def test_shadow_disabled(self) -> None:
        style = build_force_style_arg(shadow_enabled=False)
        self.assertIn("Shadow=0", style)
        self.assertNotIn("Shadow=2", style)

    def test_both_disabled(self) -> None:
        style = build_force_style_arg(stroke_enabled=False, shadow_enabled=False)
        self.assertIn("Outline=0", style)
        self.assertIn("Shadow=0", style)

    def test_font_size_included_when_positive(self) -> None:
        style = build_force_style_arg(font_size_px=34)
        self.assertIn("Fontsize=34", style)

    def test_font_size_zero_or_missing_omitted(self) -> None:
        self.assertNotIn("Fontsize", build_force_style_arg(font_size_px=0))
        self.assertNotIn("Fontsize", build_force_style_arg())

    def test_offset_maps_to_margin_v_upward(self) -> None:
        self.assertIn("MarginV=12", build_force_style_arg(offset_px=12))
        # Negative offset clamps to the bottom margin instead of going off-screen.
        self.assertIn("MarginV=0", build_force_style_arg(offset_px=-5))
        self.assertNotIn("MarginV", build_force_style_arg(offset_px=0))


class BuildTextSubtitleBurninFilterTests(unittest.TestCase):
    def test_basic_filter_shape(self) -> None:
        fragment = build_text_subtitle_burnin_filter(
            "burnin.srt",
            stroke_enabled=True,
            shadow_enabled=True,
            font_size_px=28,
            offset_px=4,
        )
        self.assertTrue(fragment.startswith("subtitles=filename='"))
        self.assertIn("burnin.srt", fragment)
        self.assertIn("force_style='", fragment)
        self.assertIn("Fontsize=28", fragment)
        self.assertIn("MarginV=4", fragment)

    def test_windows_relative_path_uses_forward_slashes_and_escapes_colons(self) -> None:
        fragment = build_text_subtitle_burnin_filter(
            Path("sub") / "dir:like.srt",
            stroke_enabled=False,
            shadow_enabled=False,
        )
        self.assertIn("sub/dir\\:like.srt", fragment)

    def test_path_object_normalized_to_posix(self) -> None:
        fragment = build_text_subtitle_burnin_filter(
            Path("nested/burnin.srt"),
            stroke_enabled=True,
            shadow_enabled=False,
        )
        self.assertIn("filename='nested/burnin.srt'", fragment)


class ExtractionCommandTests(unittest.TestCase):
    def test_command_shape_extracts_full_stream(self) -> None:
        command = build_srt_extraction_command(
            Path("ffmpeg.exe"),
            "http://127.0.0.1:8000/file?path=a.mkv",
            Path("session/burnin.srt"),
            subtitle_stream_index=3,
        )
        self.assertEqual(command[0], str(Path("ffmpeg.exe")))
        self.assertEqual(command[-1], str(Path("session/burnin.srt")))
        # No -ss: the full stream is extracted; rebase_srt_file handles seeks.
        self.assertNotIn("-ss", command)
        map_index = command.index("-map")
        self.assertEqual(command[map_index + 1], "0:3")
        self.assertEqual(["-f", "srt"], command[command.index("-f"):command.index("-f") + 2])


class ExtractSubtitleStreamToSrtTests(unittest.TestCase):
    def run_extract(self, returncode: int, stderr: bytes, write_file: bool, file_size: int = 10):
        completed = subprocess.CompletedProcess([], returncode, b"", stderr)
        with (
            patch("dropbox_browser.video_burnin.subprocess.run", return_value=completed) as mock_run,
            patch("pathlib.Path.exists", return_value=write_file),
            patch("pathlib.Path.stat") as mock_stat,
        ):
            mock_stat.return_value.st_size = file_size
            result = None
            error = None
            try:
                result = extract_subtitle_stream_to_srt(
                    "ffmpeg",
                    "http://x/file",
                    Path("out.srt"),
                    subtitle_stream_index=1,
                )
            except RuntimeError as exc:
                error = exc
        return result, error, mock_run

    def test_success_returns_true(self) -> None:
        result, error, mock_run = self.run_extract(0, b"", True)
        self.assertIsNone(error)
        self.assertTrue(result)
        self.assertEqual(mock_run.call_count, 1)

    def test_ffmpeg_failure_raises_runtime_error(self) -> None:
        _result, error, _mock_run = self.run_extract(1, b"bad stream", False)
        self.assertIsNotNone(error)
        self.assertIn("Subtitle burn-in extraction failed", str(error))
        self.assertIn("bad stream", str(error))

    def test_empty_output_returns_false(self) -> None:
        # Exit code 0 but no usable SRT file must be a False, not a silent pass.
        result, error, _mock_run = self.run_extract(0, b"", True, file_size=0)
        self.assertIsNone(error)
        self.assertFalse(result)

    def test_missing_output_returns_false(self) -> None:
        result, error, _mock_run = self.run_extract(0, b"", False)
        self.assertIsNone(error)
        self.assertFalse(result)


class RebaseSrtTextTests(unittest.TestCase):
    def test_nonpositive_start_is_identity(self) -> None:
        body = "1\n00:00:05,000 --> 00:00:06,000\nHi\n"
        self.assertEqual(rebase_srt_text(body, 0), body.replace("\n", "\n"))

    def test_cues_shift_back_by_start_time(self) -> None:
        rebased = rebase_srt_text(
            "1\n00:01:05,000 --> 00:01:06,500\nHello\n\n"
            "2\n00:02:10,000 --> 00:02:12,000\nWorld\n",
            60.0,
        )
        self.assertIn("00:00:05,000 --> 00:00:06,500", rebased)
        self.assertIn("Hello", rebased)
        self.assertIn("00:01:10,000 --> 00:01:12,000", rebased)
        self.assertIn("World", rebased)

    def test_cues_ending_before_seek_are_dropped(self) -> None:
        rebased = rebase_srt_text(
            "1\n00:00:10,000 --> 00:00:20,000\nGone\n\n"
            "2\n00:00:30,000 --> 00:01:00,000\nKept\n",
            25.0,
        )
        self.assertNotIn("Gone", rebased)
        self.assertIn("00:00:05,000 --> 00:00:35,000", rebased)
        self.assertIn("Kept", rebased)

    def test_all_dropped_yields_empty_body(self) -> None:
        rebased = rebase_srt_text(
            "1\n00:00:01,000 --> 00:00:02,000\nEarly\n",
            60.0,
        )
        self.assertEqual(rebased.strip(), "")


class RebaseSrtFileTests(unittest.TestCase):
    def test_rewrites_file_in_place(self) -> None:
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            srt = Path(tmp) / "burnin.srt"
            srt.write_text(
                "1\n00:01:05,000 --> 00:01:06,000\nShifted\n",
                encoding="utf-8",
            )
            changed = rebase_srt_file(srt, 60.0)
            text = srt.read_text(encoding="utf-8")
        self.assertTrue(changed)
        self.assertIn("00:00:05,000 --> 00:00:06,000", text)
        self.assertIn("Shifted", text)

    def test_zero_start_makes_no_changes(self) -> None:
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            srt = Path(tmp) / "burnin.srt"
            original = "1\n00:00:05,000 --> 00:00:06,000\nSame\n"
            srt.write_text(original, encoding="utf-8")
            changed = rebase_srt_file(srt, 0.0)
            text = srt.read_text(encoding="utf-8")
        self.assertFalse(changed)
        self.assertEqual(text, original)

    def test_missing_file_returns_false(self) -> None:
        self.assertFalse(rebase_srt_file(Path("Z:/nope/missing.srt"), 5.0))


class ScaleBurninFontSizeTests(unittest.TestCase):
    def test_scales_by_playres_y_over_display_height(self) -> None:
        # 28 CSS px on a 720px-tall displayed video -> 28*288/720 = 11.2 -> 11
        self.assertEqual(
            scale_burnin_font_size(28, 720, 1080),
            round(28 * SUBTITLE_BURNIN_PLAYRES_Y / 720),
        )

    def test_falls_back_to_video_height_without_display_height(self) -> None:
        # Native-resolution playback: 28 px of a 360p video -> 28*288/360 = 22.4
        self.assertEqual(scale_burnin_font_size(28, None, 360), 22)

    def test_falls_back_to_identity_when_no_heights(self) -> None:
        self.assertEqual(scale_burnin_font_size(28, None, None), 28)

    def test_zero_or_negative_size_returns_none(self) -> None:
        self.assertIsNone(scale_burnin_font_size(0, 720, 1080))
        self.assertIsNone(scale_burnin_font_size(None, 720, 1080))

    def test_result_clamped_to_one(self) -> None:
        # Tiny font on a huge display still yields >= 1
        self.assertEqual(scale_burnin_font_size(1, 5000, 1080), 1)

    def test_same_display_and_video_fraction_matches_overlay_fraction(self) -> None:
        # Fraction-of-height parity: burned-in fraction (Fontsize/288) must
        # equal overlay fraction (css_px/display_height).
        css_px = 42.0
        display_h = 481.0
        fontsize = scale_burnin_font_size(int(css_px), int(display_h), 1080)
        burnin_fraction = fontsize / SUBTITLE_BURNIN_PLAYRES_Y
        overlay_fraction = css_px / display_h
        self.assertLess(abs(burnin_fraction - overlay_fraction), 0.005)


class ScaleBurninOffsetPxTests(unittest.TestCase):
    def test_scales_like_font_size(self) -> None:
        self.assertEqual(
            scale_burnin_offset_px(12, 480, 1080),
            round(12 * SUBTITLE_BURNIN_PLAYRES_Y / 480),
        )

    def test_negative_clamps_to_zero(self) -> None:
        self.assertEqual(scale_burnin_offset_px(-5, 480, 1080), 0)

    def test_none_passthrough(self) -> None:
        self.assertIsNone(scale_burnin_offset_px(None, 480, 1080))


class SanitizeSrtTextTests(unittest.TestCase):
    def test_strips_font_size_tags(self) -> None:
        self.assertEqual(
            sanitize_srt_text('<font face="Cabin" size="75"><b>Hi</b></font>'),
            "<b>Hi</b>",
        )

    def test_plain_text_untouched(self) -> None:
        self.assertEqual(sanitize_srt_text("Hello, world."), "Hello, world.")

    def test_preserves_bold_italic_underline(self) -> None:
        self.assertEqual(
            sanitize_srt_text("<i>a</i><b>b</b><u>c</u>"),
            "<i>a</i><b>b</b><u>c</u>",
        )


class SanitizeSrtFileTests(unittest.TestCase):
    def test_rewrites_font_tags_in_place(self) -> None:
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as tmp:
            srt = Path(tmp) / "burnin.srt"
            srt.write_text(
                "1\n00:00:00,000 --> 00:00:01,000\n"
                '<font face="Cabin" size="75"><b>Then, the culprit.</b></font>\n',
                encoding="utf-8",
            )
            changed = sanitize_srt_file(srt)
            text = srt.read_text(encoding="utf-8")
        self.assertTrue(changed)
        self.assertNotIn("<font", text)
        self.assertIn("<b>Then, the culprit.</b>", text)

    def test_missing_file_returns_false(self) -> None:
        from pathlib import Path
        self.assertFalse(sanitize_srt_file(Path("Z:/nope/missing.srt")))


if __name__ == "__main__":
    unittest.main()
