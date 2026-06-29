#!/usr/bin/env python3
"""Benchmark compatibility video startup against a running dropbox_browser server."""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Callable

DEFAULT_BASE_URL = "http://127.0.0.1:8000"
DEFAULT_VIDEO_PATH = (
    "anime/[bonkai77] Eureka Seven [BD-1080p] [DUAL-AUDIO] [x265] [HEVC] [AAC] [10bit] {FILTERED}/"
    "[bonkai77] Eureka Seven - Episode 01 [BD 1080p Dual Audio x265 10bit].mkv"
)
TEMP_DIR = Path(__file__).resolve().parent.parent / "Temp"
PROBE_CACHE_DIR = TEMP_DIR / "probe_cache"
HEADER_CACHE_DIR = TEMP_DIR / "video_header_cache"
CLIENT_LOG_PATH = TEMP_DIR / "client_logs.jsonl"
BENCHMARK_DIR = TEMP_DIR / "video_benchmarks"


@dataclass
class IterationResult:
    iteration: int
    probe_cold_ms: float
    probe_warm_ms: float
    session_create_ms: float
    server_session_create_ms: float | None
    asset_fetch_ms: float
    total_startup_ms: float
    session_id: str | None = None
    ffmpeg_pid: int | None = None
    video_mode: str | None = None
    audio_mode: str | None = None
    sample_duration_ms: float = 0.0
    status_sample_count: int = 0
    playlist_sample_count: int = 0
    encoded_media_end_start_seconds: float | None = None
    encoded_media_end_end_seconds: float | None = None
    encoded_media_end_max_seconds: float | None = None
    playlist_segment_start_count: int | None = None
    playlist_segment_end_count: int | None = None
    playlist_segment_max_count: int | None = None
    playlist_edge_start_seconds: float | None = None
    playlist_edge_end_seconds: float | None = None
    playlist_edge_max_seconds: float | None = None
    playlist_endlist_seen: bool = False
    segment_production_rate_per_second: float | None = None
    media_encode_rate: float | None = None
    ffmpeg_cpu_percent_mean: float | None = None
    ffmpeg_cpu_percent_max: float | None = None
    ffmpeg_cpu_sample_count: int = 0
    client_hls_loading_events: int = 0
    client_hls_stall_events: int = 0
    client_video_waiting_events: int = 0
    client_video_stalled_events: int = 0
    error: str | None = None


@dataclass
class CpuSample:
    timestamp: float
    process_cpu_seconds: float


@dataclass
class SessionSample:
    timestamp: float
    encoded_media_end_seconds: float | None
    playlist_segment_count: int | None
    playlist_edge_seconds: float | None
    playlist_has_endlist: bool
    ffmpeg_cpu_percent: float | None


def _request(
    url: str,
    *,
    method: str = "GET",
    data: dict[str, str] | None = None,
    timeout: float = 120.0,
) -> tuple[int, bytes, float]:
    body = None
    headers: dict[str, str] = {}
    if data is not None:
        body = urllib.parse.urlencode(data).encode("utf-8")
        headers["Content-Type"] = "application/x-www-form-urlencoded; charset=utf-8"
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = response.read()
    except urllib.error.HTTPError as exc:
        payload = exc.read()
        elapsed_ms = (time.perf_counter() - started) * 1000
        raise RuntimeError(f"HTTP {exc.code} for {url}: {payload[:400]!r}") from exc
    elapsed_ms = (time.perf_counter() - started) * 1000
    return response.status, payload, elapsed_ms


def _json_request(
    url: str,
    *,
    method: str = "GET",
    data: dict[str, str] | None = None,
    timeout: float = 30.0,
) -> tuple[dict[str, Any], float]:
    status, payload, elapsed_ms = _request(url, method=method, data=data, timeout=timeout)
    if status != 200:
        raise RuntimeError(f"request failed with status {status}: {url}")
    decoded = json.loads(payload.decode("utf-8"))
    if not isinstance(decoded, dict):
        raise RuntimeError(f"request did not return a JSON object: {url}")
    return decoded, elapsed_ms


def _clear_video_disk_caches() -> int:
    removed = 0
    for cache_dir in (PROBE_CACHE_DIR, HEADER_CACHE_DIR):
        if not cache_dir.exists():
            continue
        for path in cache_dir.rglob("*"):
            if path.is_file():
                path.unlink(missing_ok=True)
                removed += 1
    return removed


def _stop_active_session(base_url: str) -> None:
    try:
        _request(f"{base_url}/video/endpoints/session/stop", method="POST", data={"id": ""}, timeout=10.0)
    except RuntimeError:
        return


def _probe(base_url: str, video_path: str) -> tuple[dict, float]:
    query = urllib.parse.urlencode({"path": video_path, "source": "remote"})
    return _json_request(f"{base_url}/video/endpoints/probe?{query}", timeout=60.0)


def _create_session(
    base_url: str,
    video_path: str,
    audio_stream_index: int | None,
    *,
    force_video_transcode: bool = False,
    force_audio_transcode: bool = False,
) -> tuple[dict, float]:
    body = {
        "path": video_path,
        "source": "remote",
        "start_time_seconds": "0",
    }
    if audio_stream_index is not None:
        body["audio_stream_index"] = str(audio_stream_index)
    if force_video_transcode:
        body["force_video_transcode"] = "1"
    if force_audio_transcode:
        body["force_audio_transcode"] = "1"
    return _json_request(
        f"{base_url}/video/endpoints/session",
        method="POST",
        data=body,
        timeout=120.0,
    )


def _playlist_asset_urls(playlist_text: str) -> list[str]:
    urls: list[str] = []
    for raw_line in playlist_text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("#EXT-X-MAP:"):
            uri_key = 'URI="'
            start = line.find(uri_key)
            if start >= 0:
                start += len(uri_key)
                end = line.find('"', start)
                if end > start:
                    urls.append(line[start:end])
            continue
        if line.startswith("#"):
            continue
        urls.append(line)
    return urls


def _fetch_startup_assets(base_url: str, session_payload: dict) -> float:
    playlist_url = str(session_payload.get("playlist_url") or "")
    if not playlist_url:
        raise RuntimeError("session payload missing playlist URL")

    started = time.perf_counter()
    _, playlist_body, _ = _request(f"{base_url}{playlist_url}", timeout=30.0)
    playlist_text = playlist_body.decode("utf-8", errors="replace")
    asset_urls = _playlist_asset_urls(playlist_text)
    if not asset_urls:
        raise RuntimeError("playlist did not list startup assets")
    for asset_url in asset_urls[:2]:
        if asset_url.startswith("/"):
            _request(f"{base_url}{asset_url}", timeout=60.0)
        else:
            asset_root = str(session_payload.get("asset_root") or "")
            _request(f"{base_url}{asset_root}{asset_url}", timeout=60.0)
    return (time.perf_counter() - started) * 1000


def _playlist_metrics(playlist_text: str) -> dict[str, object]:
    segment_count = 0
    edge_seconds = 0.0
    pending_duration: float | None = None
    for raw_line in playlist_text.splitlines():
        line = raw_line.strip()
        if line.startswith("#EXTINF:"):
            duration_text = line.removeprefix("#EXTINF:").split(",", 1)[0]
            try:
                pending_duration = float(duration_text)
            except ValueError:
                pending_duration = None
            continue
        if not line or line.startswith("#"):
            continue
        segment_count += 1
        if pending_duration is not None:
            edge_seconds += pending_duration
        pending_duration = None
    return {
        "playlist_segment_count": segment_count,
        "playlist_edge_seconds": round(edge_seconds, 3),
        "playlist_has_endlist": "#EXT-X-ENDLIST" in playlist_text,
    }


def _session_status(base_url: str) -> dict[str, object] | None:
    payload, _ = _json_request(f"{base_url}/video/endpoints/status", timeout=10.0)
    active = payload.get("active_session")
    return active if isinstance(active, dict) else None


def _fetch_playlist_metrics(base_url: str, session_payload: dict[str, object]) -> dict[str, object]:
    playlist_url = str(session_payload.get("playlist_url") or "")
    if not playlist_url:
        return {}
    _, playlist_body, _ = _request(f"{base_url}{playlist_url}", timeout=10.0)
    return _playlist_metrics(playlist_body.decode("utf-8", errors="replace"))


def _process_cpu_seconds_windows(pid: int) -> float | None:
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    process_query_limited_information = 0x1000
    handle = kernel32.OpenProcess(process_query_limited_information, False, int(pid))
    if not handle:
        return None
    try:
        creation = ctypes.c_ulonglong()
        exit_time = ctypes.c_ulonglong()
        kernel = ctypes.c_ulonglong()
        user = ctypes.c_ulonglong()
        ok = kernel32.GetProcessTimes(
            handle,
            ctypes.byref(creation),
            ctypes.byref(exit_time),
            ctypes.byref(kernel),
            ctypes.byref(user),
        )
        if not ok:
            return None
        return (kernel.value + user.value) / 10_000_000.0
    finally:
        kernel32.CloseHandle(handle)


def _process_cpu_seconds_procfs(pid: int) -> float | None:
    stat_path = Path("/proc") / str(pid) / "stat"
    try:
        text = stat_path.read_text(encoding="utf-8")
    except OSError:
        return None
    end = text.rfind(")")
    if end < 0:
        return None
    fields = text[end + 2 :].split()
    try:
        user_ticks = int(fields[11])
        system_ticks = int(fields[12])
    except (IndexError, ValueError):
        return None
    ticks_per_second = os.sysconf(os.sysconf_names.get("SC_CLK_TCK", "SC_CLK_TCK"))
    return (user_ticks + system_ticks) / float(ticks_per_second)


def _process_cpu_seconds(pid: int | None) -> float | None:
    if pid is None:
        return None
    if os.name == "nt":
        return _process_cpu_seconds_windows(pid)
    return _process_cpu_seconds_procfs(pid)


def _cpu_percent(previous: CpuSample | None, current: CpuSample, cpu_count: int) -> float | None:
    if previous is None:
        return None
    elapsed = current.timestamp - previous.timestamp
    cpu_elapsed = current.process_cpu_seconds - previous.process_cpu_seconds
    if elapsed <= 0 or cpu_elapsed < 0:
        return None
    return max(0.0, min(100.0 * cpu_count, (cpu_elapsed / elapsed) * 100.0))


def _client_log_offset(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def _read_client_video_events(path: Path, offset: int) -> dict[str, int]:
    counts = {
        "client_hls_loading_events": 0,
        "client_hls_stall_events": 0,
        "client_video_waiting_events": 0,
        "client_video_stalled_events": 0,
    }
    try:
        with path.open("rb") as handle:
            handle.seek(offset)
            lines = handle.read().decode("utf-8", "replace").splitlines()
    except OSError:
        return counts
    for line in lines:
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(row, dict):
            continue
        text = " ".join(
            str(part)
            for part in (
                row.get("subsystem"),
                row.get("message"),
                (row.get("details") or {}).get("milestone") if isinstance(row.get("details"), dict) else "",
            )
        ).casefold()
        if "hls_" in text and "loading" in text:
            counts["client_hls_loading_events"] += 1
        if "hls_" in text and "stall" in text:
            counts["client_hls_stall_events"] += 1
        if "video element waiting" in text:
            counts["client_video_waiting_events"] += 1
        if "video element stalled" in text:
            counts["client_video_stalled_events"] += 1
    return counts


def _sample_session(
    base_url: str,
    session_payload: dict[str, object],
    *,
    sample_seconds: float,
    sample_interval_seconds: float,
    progress_callback: Callable[[dict[str, object]], None] | None = None,
) -> list[SessionSample]:
    if sample_seconds <= 0:
        return []
    deadline = time.perf_counter() + sample_seconds
    samples: list[SessionSample] = []
    previous_cpu: CpuSample | None = None
    cpu_count = max(1, os.cpu_count() or 1)
    pid = _coerce_optional_int(session_payload.get("ffmpeg_pid"))
    while time.perf_counter() < deadline:
        timestamp = time.perf_counter()
        if progress_callback is not None:
            elapsed_seconds = max(0.0, timestamp - (deadline - sample_seconds))
            progress_callback(
                {
                    "stage": "sample",
                    "elapsed_seconds": round(elapsed_seconds, 3),
                    "total_seconds": round(sample_seconds, 3),
                    "remaining_seconds": round(max(0.0, deadline - timestamp), 3),
                    "sample_index": len(samples) + 1,
                }
            )
        active = _session_status(base_url)
        status_encoded_end = None
        if active is not None:
            try:
                status_encoded_end = float(active.get("encoded_media_end_seconds"))
            except (TypeError, ValueError):
                status_encoded_end = None
            pid = _coerce_optional_int(active.get("ffmpeg_pid")) or pid
        playlist = _fetch_playlist_metrics(base_url, session_payload)
        cpu_seconds = _process_cpu_seconds(pid)
        current_cpu = CpuSample(timestamp=timestamp, process_cpu_seconds=cpu_seconds) if cpu_seconds is not None else None
        cpu_percent = _cpu_percent(previous_cpu, current_cpu, cpu_count) if current_cpu is not None else None
        if current_cpu is not None:
            previous_cpu = current_cpu
        samples.append(
            SessionSample(
                timestamp=timestamp,
                encoded_media_end_seconds=status_encoded_end,
                playlist_segment_count=_coerce_optional_int(playlist.get("playlist_segment_count")),
                playlist_edge_seconds=_coerce_optional_float(playlist.get("playlist_edge_seconds")),
                playlist_has_endlist=bool(playlist.get("playlist_has_endlist", False)),
                ffmpeg_cpu_percent=round(cpu_percent, 3) if cpu_percent is not None else None,
            )
        )
        time.sleep(max(0.05, sample_interval_seconds))
    return samples


def _coerce_optional_float(value: object) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _coerce_optional_int(value: object) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _first(values: list[float | int | None]) -> float | int | None:
    for value in values:
        if value is not None:
            return value
    return None


def _last(values: list[float | int | None]) -> float | int | None:
    for value in reversed(values):
        if value is not None:
            return value
    return None


def _max_or_none(values: list[float | int | None]) -> float | int | None:
    present = [value for value in values if value is not None]
    return max(present) if present else None


def _sample_rate(start_value: float | int | None, end_value: float | int | None, elapsed_seconds: float) -> float | None:
    if start_value is None or end_value is None or elapsed_seconds <= 0:
        return None
    return round((float(end_value) - float(start_value)) / elapsed_seconds, 6)


def run_iteration(
    base_url: str,
    video_path: str,
    iteration: int,
    *,
    clear_probe_cache: bool,
    sample_seconds: float,
    sample_interval_seconds: float,
    client_log_path: Path,
    force_video_transcode: bool = False,
    force_audio_transcode: bool = False,
    progress_callback: Callable[[dict[str, object]], None] | None = None,
) -> IterationResult:
    if clear_probe_cache:
        _clear_video_disk_caches()
    _stop_active_session(base_url)
    client_log_offset = _client_log_offset(client_log_path)
    try:
        if progress_callback is not None:
            progress_callback({"stage": "probe_cold_start"})
        probe_payload, probe_cold_ms = _probe(base_url, video_path)
        if progress_callback is not None:
            progress_callback({"stage": "probe_cold_done", "elapsed_ms": round(probe_cold_ms, 3)})
            progress_callback({"stage": "probe_warm_start"})
        _, probe_warm_ms = _probe(base_url, video_path)
        if progress_callback is not None:
            progress_callback({"stage": "probe_warm_done", "elapsed_ms": round(probe_warm_ms, 3)})
        audio_index = probe_payload.get("default_audio_stream_index")
        if not isinstance(audio_index, int):
            audio_index = None
        if progress_callback is not None:
            progress_callback({"stage": "session_create_start"})
        session_payload, session_create_ms = _create_session(
            base_url,
            video_path,
            audio_index,
            force_video_transcode=force_video_transcode,
            force_audio_transcode=force_audio_transcode,
        )
        if progress_callback is not None:
            progress_callback(
                {
                    "stage": "session_create_done",
                    "elapsed_ms": round(session_create_ms, 3),
                    "session_id": str(session_payload.get("session_id") or "") or None,
                    "ffmpeg_pid": _coerce_optional_int(session_payload.get("ffmpeg_pid")),
                }
            )
        server_session_create_ms = session_payload.get("session_create_elapsed_ms")
        if server_session_create_ms is not None:
            server_session_create_ms = float(server_session_create_ms)
        if progress_callback is not None:
            progress_callback({"stage": "asset_fetch_start"})
        asset_fetch_ms = _fetch_startup_assets(base_url, session_payload)
        if progress_callback is not None:
            progress_callback({"stage": "asset_fetch_done", "elapsed_ms": round(asset_fetch_ms, 3)})
        sample_started = time.perf_counter()
        samples = _sample_session(
            base_url,
            session_payload,
            sample_seconds=sample_seconds,
            sample_interval_seconds=sample_interval_seconds,
            progress_callback=progress_callback,
        )
        sample_duration_ms = (time.perf_counter() - sample_started) * 1000 if samples else 0.0
        total_startup_ms = probe_cold_ms + session_create_ms + asset_fetch_ms
        encoded_values = [sample.encoded_media_end_seconds for sample in samples]
        segment_values = [sample.playlist_segment_count for sample in samples]
        edge_values = [sample.playlist_edge_seconds for sample in samples]
        cpu_values = [sample.ffmpeg_cpu_percent for sample in samples if sample.ffmpeg_cpu_percent is not None]
        client_counts = _read_client_video_events(client_log_path, client_log_offset)
        first_edge = _first(edge_values)
        last_edge = _last(edge_values)
        elapsed_seconds = sample_duration_ms / 1000.0
        return IterationResult(
            iteration=iteration,
            probe_cold_ms=round(probe_cold_ms, 3),
            probe_warm_ms=round(probe_warm_ms, 3),
            session_create_ms=round(session_create_ms, 3),
            server_session_create_ms=server_session_create_ms,
            asset_fetch_ms=round(asset_fetch_ms, 3),
            total_startup_ms=round(total_startup_ms, 3),
            session_id=str(session_payload.get("session_id") or "") or None,
            ffmpeg_pid=_coerce_optional_int(session_payload.get("ffmpeg_pid")),
            video_mode=str(session_payload.get("video_mode") or "") or None,
            audio_mode=str(session_payload.get("audio_mode") or "") or None,
            sample_duration_ms=round(sample_duration_ms, 3),
            status_sample_count=len(samples),
            playlist_sample_count=len(samples),
            encoded_media_end_start_seconds=_coerce_optional_float(_first(encoded_values)),
            encoded_media_end_end_seconds=_coerce_optional_float(_last(encoded_values)),
            encoded_media_end_max_seconds=_coerce_optional_float(_max_or_none(encoded_values)),
            playlist_segment_start_count=_coerce_optional_int(_first(segment_values)),
            playlist_segment_end_count=_coerce_optional_int(_last(segment_values)),
            playlist_segment_max_count=_coerce_optional_int(_max_or_none(segment_values)),
            playlist_edge_start_seconds=_coerce_optional_float(first_edge),
            playlist_edge_end_seconds=_coerce_optional_float(last_edge),
            playlist_edge_max_seconds=_coerce_optional_float(_max_or_none(edge_values)),
            playlist_endlist_seen=any(sample.playlist_has_endlist for sample in samples),
            segment_production_rate_per_second=_sample_rate(_first(segment_values), _last(segment_values), elapsed_seconds),
            media_encode_rate=_sample_rate(first_edge, last_edge, elapsed_seconds),
            ffmpeg_cpu_percent_mean=round(statistics.mean(cpu_values), 3) if cpu_values else None,
            ffmpeg_cpu_percent_max=round(max(cpu_values), 3) if cpu_values else None,
            ffmpeg_cpu_sample_count=len(cpu_values),
            **client_counts,
        )
    except Exception as exc:
        return IterationResult(
            iteration=iteration,
            probe_cold_ms=0.0,
            probe_warm_ms=0.0,
            session_create_ms=0.0,
            server_session_create_ms=None,
            asset_fetch_ms=0.0,
            total_startup_ms=0.0,
            error=str(exc),
        )
    finally:
        _stop_active_session(base_url)


def summarize(results: list[IterationResult]) -> dict[str, object]:
    ok = [row for row in results if not row.error]
    if not ok:
        return {"iterations": len(results), "successful": 0}

    def stats(values: list[float]) -> dict[str, float]:
        return {
            "min": round(min(values), 3),
            "median": round(statistics.median(values), 3),
            "max": round(max(values), 3),
            "mean": round(statistics.mean(values), 3),
        }

    return {
        "iterations": len(results),
        "successful": len(ok),
        "probe_cold_ms": stats([row.probe_cold_ms for row in ok]),
        "probe_warm_ms": stats([row.probe_warm_ms for row in ok]),
        "session_create_ms": stats([row.session_create_ms for row in ok]),
        "server_session_create_ms": stats(server_values)
        if (server_values := [
            float(row.server_session_create_ms)
            for row in ok
            if row.server_session_create_ms is not None
        ])
        else None,
        "asset_fetch_ms": stats([row.asset_fetch_ms for row in ok]),
        "total_startup_ms": stats([row.total_startup_ms for row in ok]),
        "encoded_media_end_max_seconds": stats([
            row.encoded_media_end_max_seconds
            for row in ok
            if row.encoded_media_end_max_seconds is not None
        ])
        if any(row.encoded_media_end_max_seconds is not None for row in ok)
        else None,
        "playlist_segment_max_count": stats([
            float(row.playlist_segment_max_count)
            for row in ok
            if row.playlist_segment_max_count is not None
        ])
        if any(row.playlist_segment_max_count is not None for row in ok)
        else None,
        "media_encode_rate": stats([
            row.media_encode_rate
            for row in ok
            if row.media_encode_rate is not None
        ])
        if any(row.media_encode_rate is not None for row in ok)
        else None,
        "ffmpeg_cpu_percent_mean": stats([
            row.ffmpeg_cpu_percent_mean
            for row in ok
            if row.ffmpeg_cpu_percent_mean is not None
        ])
        if any(row.ffmpeg_cpu_percent_mean is not None for row in ok)
        else None,
        "client_hls_loading_events": sum(row.client_hls_loading_events for row in ok),
        "client_hls_stall_events": sum(row.client_hls_stall_events for row in ok),
        "client_video_waiting_events": sum(row.client_video_waiting_events for row in ok),
        "client_video_stalled_events": sum(row.client_video_stalled_events for row in ok),
    }


def print_report(label: str, results: list[IterationResult], summary: dict[str, object]) -> None:
    print(f"\n=== {label} ===")
    for row in results:
        if row.error:
            print(f"iteration {row.iteration}: ERROR {row.error}")
            continue
        print(
            f"iteration {row.iteration}: "
            f"probe_cold={row.probe_cold_ms:.1f}ms "
            f"probe_warm={row.probe_warm_ms:.1f}ms "
            f"session={row.session_create_ms:.1f}ms "
            f"(server={row.server_session_create_ms}) "
            f"assets={row.asset_fetch_ms:.1f}ms "
            f"total={row.total_startup_ms:.1f}ms "
            f"encoded_end_max={row.encoded_media_end_max_seconds} "
            f"segments_max={row.playlist_segment_max_count} "
            f"encode_rate={row.media_encode_rate}x "
            f"ffmpeg_cpu_mean={row.ffmpeg_cpu_percent_mean}"
        )
    print("summary:", json.dumps(summary, indent=2, sort_keys=True))


def _default_output_path(label: str) -> Path:
    safe_label = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "-" for ch in label).strip("-")
    if not safe_label:
        safe_label = "video-benchmark"
    stamp = time.strftime("%Y%m%d-%H%M%S")
    return BENCHMARK_DIR / f"{stamp}-{safe_label}.jsonl"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--path", default=DEFAULT_VIDEO_PATH)
    parser.add_argument("--iterations", type=int, default=3)
    parser.add_argument("--label", default="video-startup-benchmark")
    parser.add_argument("--output", type=Path, default=None)
    parser.add_argument("--no-output", action="store_true", help="Do not write the default Temp/video_benchmarks JSONL file.")
    parser.add_argument("--sample-seconds", type=float, default=30.0)
    parser.add_argument("--sample-interval-seconds", type=float, default=1.0)
    parser.add_argument("--client-log-path", type=Path, default=CLIENT_LOG_PATH)
    parser.add_argument(
        "--ffmpeg-read-rate",
        type=float,
        default=None,
        help="Record the VideoFFmpegReadRate value used by the running server for this scenario.",
    )
    parser.add_argument(
        "--ffmpeg-initial-burst-seconds",
        type=float,
        default=None,
        help="Record the VideoFFmpegInitialBurstSeconds value used by the running server for this scenario.",
    )
    parser.add_argument(
        "--ffmpeg-catchup-read-rate",
        type=float,
        default=None,
        help="Record the VideoFFmpegCatchupReadRate value used by the running server for this scenario.",
    )
    parser.add_argument(
        "--ffmpeg-threads",
        type=int,
        default=None,
        help="Record the VideoFFmpegThreads value used by the running server for this scenario.",
    )
    parser.add_argument(
        "--ffmpeg-filter-threads",
        type=int,
        default=None,
        help="Record the VideoFFmpegFilterThreads value used by the running server for this scenario.",
    )
    parser.add_argument(
        "--ffmpeg-process-priority",
        default=None,
        help="Record the VideoFFmpegProcessPriority value used by the running server for this scenario.",
    )
    parser.add_argument(
        "--force-video-transcode",
        action="store_true",
        help="Request server-side force_video_transcode=1 for this scenario.",
    )
    parser.add_argument(
        "--force-audio-transcode",
        action="store_true",
        help="Request server-side force_audio_transcode=1 for this scenario.",
    )
    parser.add_argument(
        "--no-clear-probe-cache",
        action="store_true",
        help="Keep probe cache between iterations (only the first probe in each iteration is still cold if cache was cleared once).",
    )
    args = parser.parse_args()

    results = [
        run_iteration(
            args.base_url,
            args.path,
            index + 1,
            clear_probe_cache=not args.no_clear_probe_cache,
            sample_seconds=max(0.0, args.sample_seconds),
            sample_interval_seconds=max(0.05, args.sample_interval_seconds),
            client_log_path=args.client_log_path,
            force_video_transcode=bool(args.force_video_transcode),
            force_audio_transcode=bool(args.force_audio_transcode),
        )
        for index in range(max(1, args.iterations))
    ]
    summary = summarize(results)
    print_report(args.label, results, summary)

    output_path = None if args.no_output else (args.output or _default_output_path(args.label))
    if output_path is not None:
        payload = {
            "label": args.label,
            "base_url": args.base_url,
            "path": args.path,
            "sample_seconds": max(0.0, args.sample_seconds),
            "sample_interval_seconds": max(0.05, args.sample_interval_seconds),
            "client_log_path": str(args.client_log_path),
            "scenario_config": {
                "VideoFFmpegReadRate": args.ffmpeg_read_rate,
                "VideoFFmpegInitialBurstSeconds": args.ffmpeg_initial_burst_seconds,
                "VideoFFmpegCatchupReadRate": args.ffmpeg_catchup_read_rate,
                "VideoFFmpegThreads": args.ffmpeg_threads,
                "VideoFFmpegFilterThreads": args.ffmpeg_filter_threads,
                "VideoFFmpegProcessPriority": args.ffmpeg_process_priority,
                "force_video_transcode": bool(args.force_video_transcode),
                "force_audio_transcode": bool(args.force_audio_transcode),
            },
            "iterations": [asdict(row) for row in results],
            "summary": summary,
        }
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with output_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, sort_keys=True) + "\n")
        print(f"Wrote {output_path}")

    return 0 if summary.get("successful") else 1


if __name__ == "__main__":
    sys.exit(main())
