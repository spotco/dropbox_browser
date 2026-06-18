#!/usr/bin/env python3
"""Benchmark compatibility video startup against a running dropbox_browser server."""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass
from pathlib import Path

DEFAULT_BASE_URL = "http://127.0.0.1:8000"
DEFAULT_VIDEO_PATH = (
    "anime/[bonkai77] Eureka Seven [BD-1080p] [DUAL-AUDIO] [x265] [HEVC] [AAC] [10bit] {FILTERED}/"
    "[bonkai77] Eureka Seven - Episode 01 [BD 1080p Dual Audio x265 10bit].mkv"
)
TEMP_DIR = Path(__file__).resolve().parent.parent / "Temp"
PROBE_CACHE_DIR = TEMP_DIR / "probe_cache"
HEADER_CACHE_DIR = TEMP_DIR / "video_header_cache"


@dataclass
class IterationResult:
    iteration: int
    probe_cold_ms: float
    probe_warm_ms: float
    session_create_ms: float
    server_session_create_ms: float | None
    asset_fetch_ms: float
    total_startup_ms: float
    error: str | None = None


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
    status, payload, elapsed_ms = _request(f"{base_url}/video/endpoints/probe?{query}", timeout=60.0)
    if status != 200:
        raise RuntimeError(f"probe failed with status {status}")
    return json.loads(payload.decode("utf-8")), elapsed_ms


def _create_session(base_url: str, video_path: str, audio_stream_index: int | None) -> tuple[dict, float]:
    body = {
        "path": video_path,
        "source": "remote",
        "start_time_seconds": "0",
    }
    if audio_stream_index is not None:
        body["audio_stream_index"] = str(audio_stream_index)
    status, payload, elapsed_ms = _request(
        f"{base_url}/video/endpoints/session",
        method="POST",
        data=body,
        timeout=120.0,
    )
    if status != 200:
        raise RuntimeError(f"session create failed with status {status}")
    return json.loads(payload.decode("utf-8")), elapsed_ms


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


def run_iteration(base_url: str, video_path: str, iteration: int, *, clear_probe_cache: bool) -> IterationResult:
    if clear_probe_cache:
        _clear_video_disk_caches()
    _stop_active_session(base_url)
    try:
        probe_payload, probe_cold_ms = _probe(base_url, video_path)
        _, probe_warm_ms = _probe(base_url, video_path)
        audio_index = probe_payload.get("default_audio_stream_index")
        if not isinstance(audio_index, int):
            audio_index = None
        session_payload, session_create_ms = _create_session(base_url, video_path, audio_index)
        server_session_create_ms = session_payload.get("session_create_elapsed_ms")
        if server_session_create_ms is not None:
            server_session_create_ms = float(server_session_create_ms)
        asset_fetch_ms = _fetch_startup_assets(base_url, session_payload)
        total_startup_ms = probe_cold_ms + session_create_ms + asset_fetch_ms
        return IterationResult(
            iteration=iteration,
            probe_cold_ms=round(probe_cold_ms, 3),
            probe_warm_ms=round(probe_warm_ms, 3),
            session_create_ms=round(session_create_ms, 3),
            server_session_create_ms=server_session_create_ms,
            asset_fetch_ms=round(asset_fetch_ms, 3),
            total_startup_ms=round(total_startup_ms, 3),
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
            f"total={row.total_startup_ms:.1f}ms"
        )
    print("summary:", json.dumps(summary, indent=2, sort_keys=True))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--path", default=DEFAULT_VIDEO_PATH)
    parser.add_argument("--iterations", type=int, default=3)
    parser.add_argument("--label", default="video-startup-benchmark")
    parser.add_argument("--output", type=Path, default=None)
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
        )
        for index in range(max(1, args.iterations))
    ]
    summary = summarize(results)
    print_report(args.label, results, summary)

    if args.output is not None:
        payload = {
            "label": args.label,
            "base_url": args.base_url,
            "path": args.path,
            "iterations": [asdict(row) for row in results],
            "summary": summary,
        }
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(f"Wrote {args.output}")

    return 0 if summary.get("successful") else 1


if __name__ == "__main__":
    sys.exit(main())