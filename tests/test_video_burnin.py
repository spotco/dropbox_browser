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
        style = build_force_style_arg()
        self.assertIn("BorderStyle=3", style)
        self.assertIn("Outline=1", style)
        self.assertIn("Shadow=2", style)

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
    def test_command_shape_without_start_time(self) -> None:
        command = build_srt_extraction_command(
            Path("ffmpeg.exe"),
            "http://127.0.0.1:8000/file?path=a.mkv",
            Path("session/burnin.srt"),
            subtitle_stream_index=3,
        )
        self.assertEqual(command[0], str(Path("ffmpeg.exe")))
        self.assertEqual(command[-1], str(Path("session/burnin.srt")))
        self.assertNotIn("-ss", command)
        map_index = command.index("-map")
        self.assertEqual(command[map_index + 1], "0:3")
        self.assertEqual(["-f", "srt"], command[command.index("-f"):command.index("-f") + 2])

    def test_command_shape_with_start_time(self) -> None:
        command = build_srt_extraction_command(
            "ffmpeg",
            "http://x/file",
            "out.srt",
            subtitle_stream_index=2,
            start_time_seconds=7.5,
        )
        ss_index = command.index("-ss")
        self.assertEqual(command[ss_index + 1], "7.500")


class ExtractSubtitleStreamToSrtTests(unittest.TestCase):
    def run_extract(self, returncode: int, stderr: bytes, write_file: bool):
        completed = subprocess.CompletedProcess([], returncode, b"", stderr)
        with (
            patch("dropbox_browser.video_burnin.subprocess.run", return_value=completed) as mock_run,
            patch("pathlib.Path.exists", return_value=write_file),
            patch("pathlib.Path.stat") as mock_stat,
        ):
            mock_stat.return_value.st_size = 10 if write_file else 0
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


if __name__ == "__main__":
    unittest.main()


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
