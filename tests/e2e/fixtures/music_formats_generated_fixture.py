"""Generate native Chromium audio formats for Music Player integration tests."""
from __future__ import annotations

import argparse
import base64
import json
import struct
import subprocess
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT))
from tests.e2e.support.media_tools import resolve_ffmpeg  # noqa: E402

try:
    FFMPEG_EXE = resolve_ffmpeg(REPO_ROOT)
except FileNotFoundError:
    FFMPEG_EXE = REPO_ROOT / "FFmpeg" / "bin" / "ffmpeg.exe"
DURATION_SECONDS = "2"

TRACK_SPECS: list[dict[str, Any]] = [
    {
        "path": "music/Ogg Track.ogg",
        "codec": "libvorbis",
        "title": "Ogg Fixture Title",
        "artist": "Ogg Fixture Artist",
    },
    {
        "path": "music/Lossless.flac",
        "codec": "flac",
        "title": "FLAC Fixture Title",
        "artist": "FLAC Fixture Artist",
        # Embedded front cover (FLAC PICTURE block) for media-session artwork.
        "cover": True,
    },
    {
        "path": "music/Oga Track.oga",
        "codec": "libvorbis",
        "title": "Oga Fixture Title",
        "artist": "Oga Fixture Artist",
    },
    {
        "path": "music/Opus Track.opus",
        "codec": "libopus",
        "title": "Opus Fixture Title",
        "artist": "Opus Fixture Artist",
    },
    {
        "path": "music/Audiobook.m4b",
        "codec": "aac",
        "title": "M4B Fixture Title",
        "artist": "M4B Fixture Artist",
    },
]


def cover_picture_block_base64(output_path: Path) -> str:
    """Return a base64 FLAC PICTURE block holding a 64x64 red PNG front cover."""
    png_path = output_path.with_suffix(".cover.png")
    proc = subprocess.run(
        [
            str(FFMPEG_EXE),
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=red:s=64x64:d=1",
            "-frames:v",
            "1",
            str(png_path),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=60,
        cwd=str(REPO_ROOT),
    )
    if proc.returncode != 0 or not png_path.is_file():
        raise SystemExit(proc.stderr.decode("utf-8", "replace").strip() or "ffmpeg cover failed")
    data = png_path.read_bytes()
    png_path.unlink()
    mime = b"image/png"
    block = b"".join([
        struct.pack(">I", 3),  # front cover
        struct.pack(">I", len(mime)),
        mime,
        struct.pack(">I", 0),  # empty description
        struct.pack(">IIII", 64, 64, 24, 0),
        struct.pack(">I", len(data)),
        data,
    ])
    return base64.b64encode(block).decode("ascii")


def generate_track(
    output_path: Path,
    *,
    frequency: str,
    codec: str,
    title: str,
    artist: str,
    cover: bool = False,
) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    cover_args: list[str] = []
    if cover:
        # Front cover as a METADATA_BLOCK_PICTURE comment (pure metadata). An
        # attached-picture stream would make Chromium refuse the file.
        cover_args = ["-metadata", f"METADATA_BLOCK_PICTURE={cover_picture_block_base64(output_path)}"]
    proc = subprocess.run(
        [
            str(FFMPEG_EXE),
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency={frequency}:duration={DURATION_SECONDS}",
            *cover_args,
            "-c:a",
            codec,
            "-metadata",
            f"title={title}",
            "-metadata",
            f"artist={artist}",
            "-t",
            DURATION_SECONDS,
            str(output_path),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=60,
        cwd=str(REPO_ROOT),
    )
    if proc.returncode != 0:
        raise SystemExit(proc.stderr.decode("utf-8", "replace").strip() or "ffmpeg failed")
    if not output_path.is_file() or output_path.stat().st_size < 100:
        raise SystemExit(f"Generated audio missing or too small: {output_path}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    if not FFMPEG_EXE.is_file():
        raise SystemExit(f"ffmpeg not found: {FFMPEG_EXE}")

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    entries: list[dict[str, Any]] = [
        {"path": "music", "type": "dir", "mod_time": "2024-01-01T12:00:00Z"},
    ]
    for index, spec in enumerate(TRACK_SPECS):
        rel_path = str(spec["path"])
        output_path = output_dir.joinpath(*rel_path.split("/"))
        generate_track(
            output_path,
            frequency=str(440 + index * 110),
            codec=str(spec["codec"]),
            title=str(spec["title"]),
            artist=str(spec["artist"]),
            cover=bool(spec.get("cover", False)),
        )
        entries.append({
            "path": rel_path,
            "type": "file",
            "mod_time": f"2024-0{index + 1}-01T10:00:00Z",
            "file_path": str(output_path),
        })

    fixture = {
        "scenario": "music-native-formats-integration",
        "notes": "Short native Chromium audio fixtures for Ogg, Oga, Opus, FLAC, and M4B coverage.",
        "music_player_expected": {
            "root_path": "music",
            "folder_count": 0,
            "song_count": len(TRACK_SPECS),
            "stream_paths": [spec["path"] for spec in TRACK_SPECS],
        },
        "entries": entries,
        "local_files": [],
    }
    sys.stdout.write(json.dumps(fixture, indent=2))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
