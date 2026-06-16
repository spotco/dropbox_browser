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
) -> None:
    work_dir = output_path.parent
    english_srt = work_dir / f"{output_path.stem}.eng.srt"
    french_srt = work_dir / f"{output_path.stem}.fra.srt"
    write_srt(
        english_srt,
        [
            ("00:00:00,400 --> 00:00:02,000", english_cue_text),
            ("00:00:02,200 --> 00:00:04,500", english_cue_text + " AGAIN"),
        ],
    )
    write_srt(
        french_srt,
        [
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
            "color=c=black:s=640x360:d=8",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency={english_frequency}:duration=8",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency={japanese_frequency}:duration=8",
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
            "8",
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


def validate_generated_file(path: Path) -> None:
    payload = probe_output(path)
    streams = payload.get("streams")
    if not isinstance(streams, list):
        raise SystemExit(f"Generated fixture missing streams: {path}")
    codec_names = [str(stream.get("codec_name") or "") for stream in streams if isinstance(stream, dict)]
    expected = ["h264", "aac", "aac", "subrip", "subrip", "hdmv_pgs_subtitle"]
    if codec_names[: len(expected)] != expected:
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
            "english_cue_text": "ALPHA-SUBTITLE-ENG",
            "french_cue_text": "ALPHA-SUBTITLE-FRA",
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
        )
        validate_generated_file(output_path)

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
        ],
        "video": {
            "use_real_media": True,
        },
    }
    sys.stdout.write(json.dumps(fixture))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
