from __future__ import annotations

import io
import json
import re
import subprocess
import time
from pathlib import Path
from subprocess import CompletedProcess
from typing import Any
from unittest.mock import patch
from urllib.parse import parse_qs, unquote, urlparse


class FakeFfmpegProcess:
    def __init__(self, command: list[str]) -> None:
        self.command = command
        self.stdout = None
        self.stderr = io.BytesIO()
        self.returncode: int | None = None
        self.killed = False

    def poll(self) -> int | None:
        return self.returncode

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9

    def wait(self, timeout: float | None = None) -> int:
        if self.returncode is None:
            self.returncode = 0
        return self.returncode


def _extract_rel_path_from_command(command: list[Any]) -> str | None:
    for part in command:
        if not isinstance(part, str) or "path=" not in part:
            continue
        query = urlparse(part).query if "://" in part else part.split("?", 1)[-1]
        values = parse_qs(query).get("path")
        if values and values[0]:
            return unquote(values[0])
    return None


def _vtt_text_for_stream(
    rel_path: str | None,
    stream_index: str,
    vtt_by_path: dict[str, dict[str, str]],
) -> str:
    if not rel_path:
        return "WEBVTT\n\n"
    track_map = vtt_by_path.get(rel_path) or {}
    return track_map.get(stream_index) or track_map.get(str(stream_index)) or "WEBVTT\n\n"


def _write_batch_webvtt_outputs(
    command: list[Any],
    rel_path: str | None,
    vtt_by_path: dict[str, dict[str, str]],
) -> bool:
    wrote = False
    index = 0
    while index < len(command):
        if command[index] == "-map" and index + 4 < len(command):
            map_arg = command[index + 1]
            if command[index + 2] == "-f" and command[index + 3] == "webvtt":
                match = re.search(r"0:(\d+)", str(map_arg))
                output_path = command[index + 4]
                if match and isinstance(output_path, str) and not output_path.startswith("-"):
                    stream_index = match.group(1)
                    vtt_text = _vtt_text_for_stream(rel_path, stream_index, vtt_by_path)
                    Path(output_path).write_text(vtt_text, encoding="utf-8")
                    wrote = True
                index += 5
                continue
        index += 1
    return wrote


def _extract_stream_index_from_command(command: list[Any]) -> str | None:
    for part in command:
        if not isinstance(part, str):
            continue
        match = re.search(r"0:(\d+)", part)
        if match:
            return match.group(1)
        match = re.search(r"[?&]track=(\d+)", part)
        if match:
            return match.group(1)
    return None


def _subtitle_delay_seconds_for_path(
    rel_path: str | None,
    subtitle_delay_seconds_by_path: dict[str, float],
) -> float:
    if not rel_path:
        return 0.0
    delay = subtitle_delay_seconds_by_path.get(rel_path)
    if delay is None:
        delay = subtitle_delay_seconds_by_path.get(str(rel_path))
    try:
        return max(0.0, float(delay or 0.0))
    except (TypeError, ValueError):
        return 0.0


def _resolve_known_rel_path(rel_path: str | None, path_map: dict[str, Any]) -> str | None:
    if rel_path:
        return rel_path
    if len(path_map) == 1:
        return next(iter(path_map.keys()))
    return rel_path


def build_video_mock_patches(fixture: dict[str, Any], temp_dir: Path) -> list[Any]:
    video_section = fixture.get("video")
    if not isinstance(video_section, dict):
        return []

    probe_by_path: dict[str, Any] = dict(video_section.get("probe_by_path") or {})
    vtt_by_path: dict[str, dict[str, str]] = {
        path: dict(tracks)
        for path, tracks in (video_section.get("vtt_by_path") or {}).items()
        if isinstance(tracks, dict)
    }
    subtitle_delay_seconds_by_path: dict[str, float] = {
        str(path): float(seconds)
        for path, seconds in (video_section.get("subtitle_delay_seconds_by_path") or {}).items()
    }
    if bool(video_section.get("use_real_media")):
        if not subtitle_delay_seconds_by_path:
            return []
        real_subprocess_run = subprocess.run

        def delayed_real_run(command, stdout=None, stderr=None, check=False, timeout=None):
            executable = Path(str(command[0])).name.lower() if command else ""
            rel_path = _extract_rel_path_from_command(command)
            is_webvtt_extract = any(str(part).casefold() == "webvtt" for part in command)
            if "ffmpeg" in executable and is_webvtt_extract:
                delay_seconds = _subtitle_delay_seconds_for_path(rel_path, subtitle_delay_seconds_by_path)
                if delay_seconds > 0:
                    time.sleep(delay_seconds)
            return real_subprocess_run(command, stdout=stdout, stderr=stderr, check=check, timeout=timeout)

        return [
            patch("dropbox_browser.video.subprocess.run", side_effect=delayed_real_run),
        ]

    subtitle_cache_dir = temp_dir / "subtitle_cache"
    subtitle_cache_dir.mkdir(parents=True, exist_ok=True)

    def fake_run(command, stdout=None, stderr=None, check=False, timeout=None):
        executable = Path(str(command[0])).name.lower() if command else ""
        rel_path = _extract_rel_path_from_command(command)
        if "ffprobe" in executable:
            resolved_path = _resolve_known_rel_path(rel_path, probe_by_path)
            payload = probe_by_path.get(resolved_path or "", {"streams": [], "format": {"duration": "10.0"}})
            return CompletedProcess(command, 0, json.dumps(payload).encode("utf-8"), b"")
        if "ffmpeg" in executable:
            resolved_path = _resolve_known_rel_path(rel_path, vtt_by_path)
            delay_seconds = _subtitle_delay_seconds_for_path(resolved_path, subtitle_delay_seconds_by_path)
            if delay_seconds > 0:
                time.sleep(delay_seconds)
            if _write_batch_webvtt_outputs(command, resolved_path, vtt_by_path):
                return CompletedProcess(command, 0, b"", b"")
            stream_index = _extract_stream_index_from_command(command)
            vtt_text = ""
            if resolved_path and stream_index:
                vtt_text = _vtt_text_for_stream(resolved_path, stream_index, vtt_by_path)
            if not vtt_text and resolved_path:
                track_map = vtt_by_path.get(resolved_path) or {}
                if len(track_map) == 1:
                    vtt_text = next(iter(track_map.values()))
            for index, arg in enumerate(command):
                if arg == "webvtt" and index + 1 < len(command) and command[index + 1] != "-":
                    Path(command[index + 1]).write_text(vtt_text or "WEBVTT\n\n", encoding="utf-8")
                    return CompletedProcess(command, 0, b"", b"")
            if command and command[-1] == "-":
                body = (vtt_text or "WEBVTT\n\n").encode("utf-8")
                return CompletedProcess(command, 0, body, b"")
            return CompletedProcess(command, 0, b"", b"")
        return CompletedProcess(command, 0, b"", b"")

    def fake_popen(command, stdout=None, stderr=None, cwd=None):
        playlist_path = Path(command[-1])
        segment_base_url = command[command.index("-hls_base_url") + 1]
        playlist_path.parent.mkdir(parents=True, exist_ok=True)
        lines = ["#EXTM3U", '#EXT-X-VERSION:7', '#EXT-X-MAP:URI="init.mp4"']
        for index in range(2):
            segment_name = f"segment_{index:05d}.m4s"
            lines.append("#EXTINF:6,")
            lines.append(segment_base_url + segment_name)
        playlist_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        (playlist_path.parent / "init.mp4").write_bytes(b"init")
        for index in range(2):
            (playlist_path.parent / f"segment_{index:05d}.m4s").write_bytes(f"segment{index}".encode())
        return FakeFfmpegProcess(command)

    return [
        patch("dropbox_browser.video.SUBTITLE_CACHE_DIR", subtitle_cache_dir),
        patch("dropbox_browser.video.subprocess.run", side_effect=fake_run),
        patch("dropbox_browser.video.subprocess.Popen", side_effect=fake_popen),
    ]
