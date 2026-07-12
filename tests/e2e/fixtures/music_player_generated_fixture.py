"""Generate a small synthetic music-library fixture for Playwright e2e.

Produces short WAV files (browser-playable) under an isolated output dir and
prints a JSON fixture description for the integration server harness.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]
FFMPEG_EXE = REPO_ROOT / "FFmpeg" / "bin" / "ffmpeg.exe"

# Distinct mtimes so date-sort order is deterministic and differs from name order.
TRACK_SPECS: list[dict[str, Any]] = [
    {
        "path": "music/TrackA.wav",
        "frequency": "440",
        "mod_time": "2024-03-01T10:00:00Z",
    },
    {
        "path": "music/TrackB.wav",
        "frequency": "523",
        "mod_time": "2024-01-01T10:00:00Z",
    },
    {
        "path": "music/TrackC.wav",
        "frequency": "659",
        "mod_time": "2024-02-01T10:00:00Z",
    },
    {
        "path": "music/Side/TrackD.wav",
        "frequency": "784",
        "mod_time": "2024-04-01T10:00:00Z",
    },
]

DURATION_SECONDS = "1.5"


def run_ffmpeg(args: list[str]) -> None:
    import subprocess

    proc = subprocess.run(
        args,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=60,
        cwd=str(REPO_ROOT),
    )
    if proc.returncode != 0:
        stderr = proc.stderr.decode("utf-8", "replace").strip()
        raise SystemExit(stderr or f"ffmpeg failed: {' '.join(args)}")


def generate_wav(output_path: Path, *, frequency: str) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    run_ffmpeg(
        [
            str(FFMPEG_EXE),
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency={frequency}:duration={DURATION_SECONDS}",
            "-c:a",
            "pcm_s16le",
            "-t",
            DURATION_SECONDS,
            str(output_path),
        ]
    )
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
        {"path": "music/Side", "type": "dir", "mod_time": "2024-04-01T09:00:00Z"},
    ]

    for spec in TRACK_SPECS:
        rel_path = str(spec["path"])
        out_path = output_dir.joinpath(*rel_path.split("/"))
        generate_wav(out_path, frequency=str(spec["frequency"]))
        entries.append(
            {
                "path": rel_path,
                "type": "file",
                "mod_time": str(spec["mod_time"]),
                "file_path": str(out_path),
            }
        )

    fixture = {
        "scenario": "music-player-integration",
        "notes": (
            "Synthetic short WAV tracks for Music Player library, playlist, "
            "and playback e2e coverage. Complete listing (no integration gates)."
        ),
        "music_player_expected": {
            "root_path": "music",
            "folder_count": 1,
            "song_count": 4,
            "root_song_names_name_asc": ["TrackA.wav", "TrackB.wav", "TrackC.wav"],
            "root_song_names_date_desc": ["TrackA.wav", "TrackC.wav", "TrackB.wav"],
            "nested_song_name": "TrackD.wav",
            "nested_folder_name": "Side",
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
