from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES_DIR = Path(__file__).resolve().parent
FFMPEG_EXE = REPO_ROOT / "FFmpeg" / "bin" / "ffmpeg.exe"
FFPROBE_EXE = REPO_ROOT / "FFmpeg" / "bin" / "ffprobe.exe"
BUNDLED_BITMAP_SAMPLE = FIXTURES_DIR / "fairy-tail-sample.sup"
DEFAULT_BITMAP_SOURCE_URL = (
    "http://127.0.0.1:8000/file?"
    "path=anime%2F%5BJudas%5D+Fairy+Tail+%282009-2014%29+%28Seasons+1-8+%2B+OVAs%29+"
    "%5BBD+1080p%5D%5BHEVC+x265+10bit%5D%5BDual-Audio%5D%5BEng-Subs%5D%2F"
    "%5BJudas%5D+Fairy+Tail+%282009%29%2F%5BJudas%5D+Fairy+Tail+%282009%29+-+001.mkv"
    "&source=remote"
)


def run_checked(command: list[str], *, timeout: int = 180) -> subprocess.CompletedProcess[bytes]:
    proc = subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=timeout,
        cwd=str(REPO_ROOT),
        env=dict(os.environ),
    )
    if proc.returncode != 0:
        stderr = proc.stderr.decode("utf-8", "replace").strip()
        raise SystemExit(stderr or f"Command failed: {' '.join(command)}")
    return proc


def write_srt(path: Path, cues: list[tuple[str, str]]) -> None:
    blocks: list[str] = []
    for index, (timing, text) in enumerate(cues, start=1):
        blocks.append(f"{index}\n{timing}\n{text}\n")
    path.write_text("\n".join(blocks), encoding="utf-8")


def write_ass(path: Path, cues: list[tuple[str, str, str]]) -> None:
    lines = [
        "[Script Info]",
        "ScriptType: v4.00+",
        "PlayResX: 1920",
        "PlayResY: 1080",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
        "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, "
        "MarginR, MarginV, Encoding",
        "Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,40,40,40,1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    for start, end, text in cues:
        lines.append(f"Dialogue: 0,{start},{end},Default,,0,0,0,,{text}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def resolve_bitmap_sample_path(output_path: Path) -> Path:
    override_source = os.environ.get("DROPBOX_BROWSER_E2E_BITMAP_SOURCE_URL", "").strip()
    if override_source:
        extract_bitmap_sample(output_path, override_source)
        return output_path
    if BUNDLED_BITMAP_SAMPLE.is_file():
        return BUNDLED_BITMAP_SAMPLE
    extract_bitmap_sample(output_path, DEFAULT_BITMAP_SOURCE_URL)
    return output_path


def extract_bitmap_sample(output_path: Path, source_url: str) -> None:
    run_checked(
        [
            str(FFMPEG_EXE),
            "-y",
            "-ss",
            "3",
            "-to",
            "8",
            "-i",
            source_url,
            "-map",
            "0:4",
            "-c",
            "copy",
            str(output_path),
        ],
        timeout=240,
    )


def generate_video_file(
    output_path: Path,
    *,
    english_audio_title: str,
    japanese_audio_title: str,
    english_subtitle_title: str,
    french_subtitle_title: str,
    bitmap_subtitle_title: str,
    english_cue_text: str,
    french_cue_text: str,
    english_frequency: str,
    japanese_frequency: str,
    bitmap_sample_path: Path,
    duration_seconds: str = "8",
    english_cues: list[tuple[str, str]] | None = None,
    french_cues: list[tuple[str, str]] | None = None,
) -> None:
    work_dir = output_path.parent
    english_srt = work_dir / f"{output_path.stem}.eng.srt"
    french_srt = work_dir / f"{output_path.stem}.fra.srt"
    write_srt(
        english_srt,
        english_cues or [
            ("00:00:00,400 --> 00:00:02,000", english_cue_text),
            ("00:00:02,200 --> 00:00:04,500", english_cue_text + " AGAIN"),
        ],
    )
    write_srt(
        french_srt,
        french_cues or [
            ("00:00:00,500 --> 00:00:02,100", french_cue_text),
            ("00:00:02,300 --> 00:00:04,600", french_cue_text + " ENCORE"),
        ],
    )
    run_checked(
        [
            str(FFMPEG_EXE),
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"color=c=black:s=640x360:d={duration_seconds}",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency={english_frequency}:duration={duration_seconds}",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency={japanese_frequency}:duration={duration_seconds}",
            "-i",
            str(english_srt),
            "-i",
            str(french_srt),
            "-i",
            str(bitmap_sample_path),
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-map",
            "2:a:0",
            "-map",
            "3:0",
            "-map",
            "4:0",
            "-map",
            "5:0",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-c:s:0",
            "srt",
            "-c:s:1",
            "srt",
            "-c:s:2",
            "copy",
            "-t",
            str(duration_seconds),
            "-metadata:s:a:0",
            "language=eng",
            "-metadata:s:a:0",
            f"title={english_audio_title}",
            "-metadata:s:a:1",
            "language=jpn",
            "-metadata:s:a:1",
            f"title={japanese_audio_title}",
            "-metadata:s:s:0",
            "language=eng",
            "-metadata:s:s:0",
            f"title={english_subtitle_title}",
            "-metadata:s:s:1",
            "language=fra",
            "-metadata:s:s:1",
            f"title={french_subtitle_title}",
            "-metadata:s:s:2",
            "language=eng",
            "-metadata:s:s:2",
            f"title={bitmap_subtitle_title}",
            "-disposition:a:0",
            "default",
            "-disposition:a:1",
            "0",
            "-disposition:s:0",
            "default",
            "-disposition:s:1",
            "0",
            "-disposition:s:2",
            "0",
            str(output_path),
        ]
    )


def generate_ass_video_file(
    output_path: Path,
    *,
    english_audio_title: str,
    japanese_audio_title: str,
    ass_subtitle_title: str,
    english_frequency: str,
    japanese_frequency: str,
    ass_cues: list[tuple[str, str, str]],
    duration_seconds: str = "10",
) -> None:
    work_dir = output_path.parent
    ass_path = work_dir / f"{output_path.stem}.eng.ass"
    write_ass(ass_path, ass_cues)
    run_checked(
        [
            str(FFMPEG_EXE),
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"color=c=black:s=640x360:d={duration_seconds}",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency={english_frequency}:duration={duration_seconds}",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency={japanese_frequency}:duration={duration_seconds}",
            "-i",
            str(ass_path),
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-map",
            "2:a:0",
            "-map",
            "3:0",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-c:s",
            "ass",
            "-t",
            str(duration_seconds),
            "-metadata:s:a:0",
            "language=eng",
            "-metadata:s:a:0",
            f"title={english_audio_title}",
            "-metadata:s:a:1",
            "language=jpn",
            "-metadata:s:a:1",
            f"title={japanese_audio_title}",
            "-metadata:s:s:0",
            "language=eng",
            "-metadata:s:s:0",
            f"title={ass_subtitle_title}",
            "-disposition:a:0",
            "default",
            "-disposition:a:1",
            "0",
            "-disposition:s:0",
            "default",
            str(output_path),
        ]
    )


def probe_output(path: Path) -> dict[str, Any]:
    proc = run_checked(
        [
            str(FFPROBE_EXE),
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_streams",
            "-show_format",
            str(path),
        ]
    )
    return json.loads(proc.stdout.decode("utf-8"))


def validate_generated_file(path: Path, expected_codecs: list[str]) -> None:
    payload = probe_output(path)
    streams = payload.get("streams")
    if not isinstance(streams, list):
        raise SystemExit(f"Generated fixture missing streams: {path}")
    codec_names = [str(stream.get("codec_name") or "") for stream in streams if isinstance(stream, dict)]
    if codec_names[: len(expected_codecs)] != expected_codecs:
        raise SystemExit(f"Unexpected generated stream layout for {path}: {codec_names}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()

    if not FFMPEG_EXE.is_file():
        raise SystemExit(f"ffmpeg not found: {FFMPEG_EXE}")
    if not FFPROBE_EXE.is_file():
        raise SystemExit(f"ffprobe not found: {FFPROBE_EXE}")

    output_dir = Path(args.output_dir).resolve()
    videos_dir = output_dir / "Videos"
    videos_dir.mkdir(parents=True, exist_ok=True)

    bitmap_sample_path = resolve_bitmap_sample_path(output_dir / "fairy-tail-sample.sup")

    video_specs = [
        {
            "filename": "alpha.mkv",
            "english_audio_title": "Alpha English Audio",
            "japanese_audio_title": "Alpha Japanese Audio",
            "english_subtitle_title": "Alpha English Text",
            "french_subtitle_title": "Alpha French Text",
            "bitmap_subtitle_title": "Alpha English PGS",
            "english_cue_text": "<i>ALPHA-SUBTITLE-ENG</i>",
            "french_cue_text": "<b>ALPHA-SUBTITLE-FRA</b>",
            "english_frequency": "440",
            "japanese_frequency": "660",
        },
        {
            "filename": "bravo.mkv",
            "english_audio_title": "Bravo English Audio",
            "japanese_audio_title": "Bravo Japanese Audio",
            "english_subtitle_title": "Bravo English Text",
            "french_subtitle_title": "Bravo French Text",
            "bitmap_subtitle_title": "Bravo English PGS",
            "english_cue_text": "BRAVO-SUBTITLE-ENG",
            "french_cue_text": "BRAVO-SUBTITLE-FRA",
            "english_frequency": "550",
            "japanese_frequency": "770",
        },
        {
            "filename": "bitmap.mkv",
            "english_audio_title": "Bitmap English Audio",
            "japanese_audio_title": "Bitmap Japanese Audio",
            "english_subtitle_title": "Bitmap English Text",
            "french_subtitle_title": "Bitmap French Text",
            "bitmap_subtitle_title": "Bitmap English PGS",
            "english_cue_text": "BITMAP-TEXT-SUBTITLE",
            "french_cue_text": "BITMAP-FRENCH-SUBTITLE",
            "english_frequency": "480",
            "japanese_frequency": "720",
        },
        {
            "filename": "multiline.mkv",
            "english_audio_title": "Multiline English Audio",
            "japanese_audio_title": "Multiline Japanese Audio",
            "english_subtitle_title": "Multiline English Text",
            "french_subtitle_title": "Multiline French Text",
            "bitmap_subtitle_title": "Multiline English PGS",
            "english_cue_text": "MULTI-LINE-ONE\nMULTI-LINE-TWO\nMULTI-LINE-THREE",
            "french_cue_text": "MULTI-LIGNE-UN\nMULTI-LIGNE-DEUX",
            "english_frequency": "500",
            "japanese_frequency": "700",
        },
        {
            "filename": "offset.mkv",
            "english_audio_title": "Offset English Audio",
            "japanese_audio_title": "Offset Japanese Audio",
            "english_subtitle_title": "Offset English Text",
            "french_subtitle_title": "Offset French Text",
            "bitmap_subtitle_title": "Offset English PGS",
            "english_cue_text": "OFFSET-SUBTITLE-ENG",
            "french_cue_text": "OFFSET-SUBTITLE-FRA",
            "english_frequency": "520",
            "japanese_frequency": "740",
            "duration_seconds": "12",
            "english_cues": [
                ("00:00:04,400 --> 00:00:06,200", "OFFSET-SUBTITLE-ENG"),
                ("00:00:06,600 --> 00:00:08,800", "OFFSET-SUBTITLE-ENG AGAIN"),
            ],
            "french_cues": [
                ("00:00:04,500 --> 00:00:06,300", "OFFSET-SUBTITLE-FRA"),
                ("00:00:06,700 --> 00:00:08,900", "OFFSET-SUBTITLE-FRA ENCORE"),
            ],
        },
        {
            "filename": "seek-window.mkv",
            "english_audio_title": "Seek Window English Audio",
            "japanese_audio_title": "Seek Window Japanese Audio",
            "english_subtitle_title": "Seek Window English Text",
            "french_subtitle_title": "Seek Window French Text",
            "bitmap_subtitle_title": "Seek Window English PGS",
            "english_cue_text": "SEEK-WINDOW-ENG",
            "french_cue_text": "SEEK-WINDOW-FRA",
            "english_frequency": "530",
            "japanese_frequency": "750",
            "duration_seconds": "24",
            "english_cues": [
                ("00:00:10,000 --> 00:00:12,000", "SEEK-WINDOW-ENG"),
                ("00:00:16,000 --> 00:00:18,000", "SEEK-WINDOW-ENG AGAIN"),
            ],
            "french_cues": [
                ("00:00:10,100 --> 00:00:12,100", "SEEK-WINDOW-FRA"),
                ("00:00:16,100 --> 00:00:18,100", "SEEK-WINDOW-FRA ENCORE"),
            ],
        },
    ]

    for spec in video_specs:
        output_path = videos_dir / str(spec["filename"])
        generate_video_file(
            output_path,
            english_audio_title=str(spec["english_audio_title"]),
            japanese_audio_title=str(spec["japanese_audio_title"]),
            english_subtitle_title=str(spec["english_subtitle_title"]),
            french_subtitle_title=str(spec["french_subtitle_title"]),
            bitmap_subtitle_title=str(spec["bitmap_subtitle_title"]),
            english_cue_text=str(spec["english_cue_text"]),
            french_cue_text=str(spec["french_cue_text"]),
            english_frequency=str(spec["english_frequency"]),
            japanese_frequency=str(spec["japanese_frequency"]),
            bitmap_sample_path=bitmap_sample_path,
            duration_seconds=str(spec.get("duration_seconds", "8")),
            english_cues=spec.get("english_cues"),
            french_cues=spec.get("french_cues"),
        )
        validate_generated_file(output_path, ["h264", "aac", "aac", "subrip", "subrip", "hdmv_pgs_subtitle"])

    ass_output_path = videos_dir / "ass-fruits.mkv"
    generate_ass_video_file(
        ass_output_path,
        english_audio_title="ASS Fruits English Audio",
        japanese_audio_title="ASS Fruits Japanese Audio",
        ass_subtitle_title="ASS Fruits Basket Text",
        english_frequency="610",
        japanese_frequency="830",
        duration_seconds="10",
        ass_cues=[
            ("0:00:00.40", "0:00:01.80", "{\\pos(1210,94)\\frz3.2}Logo"),
            ("0:00:02.00", "0:00:02.80", "{\\p1}m 0 0 l 50 0 50 20 0 20{\\p0}"),
            ("0:00:03.00", "0:00:04.60", "{\\fad(100,250)\\t(0,500,\\frz-4)}Mine and Mine Alone{*All Mine}"),
            ("0:00:04.80", "0:00:06.20", "First line\\NSecond line"),
            ("0:00:06.40", "0:00:07.80", "{\\i1}Italic{\\i0} {\\b1}Bold{\\b0} {\\u1}Underline{\\u0}"),
        ],
    )
    validate_generated_file(ass_output_path, ["h264", "aac", "aac", "ass"])

    fixture = {
        "scenario": "video-player-generated-media",
        "entries": [
            {
                "path": "Videos",
                "type": "dir",
                "mod_time": "2024-01-01T12:00:00Z",
            },
            *[
                {
                    "path": "Videos/" + str(spec["filename"]),
                    "type": "file",
                    "file_path": str((videos_dir / str(spec["filename"])).resolve()),
                    "mod_time": "2024-01-01T12:00:01Z",
                }
                for spec in video_specs
            ],
            {
                "path": "Videos/ass-fruits.mkv",
                "type": "file",
                "file_path": str(ass_output_path.resolve()),
                "mod_time": "2024-01-01T12:00:01Z",
            },
        ],
        "video": {
            "use_real_media": True,
        },
    }
    sys.stdout.write(json.dumps(fixture))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
