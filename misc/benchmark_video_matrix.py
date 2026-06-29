#!/usr/bin/env python3
"""Run the checked-in video CPU/control benchmark matrix against a local server.

How to use:

1. Pick one remote Dropbox-relative H.264/AAC `.mp4` or `.m4v` path that should
   exercise the copy-safe path.
2. Pick one remote Dropbox-relative HEVC/other-transcode `.mkv` or similar path
   that should exercise the heavier full-transcode path.
3. Run the command from the repo root, for example:

   python misc/benchmark_video_matrix.py ^
       --machine-label asus-rog-strix-g614jv-2026-06-29 ^
       --port 8016 ^
       --copy-path "anime/...copy-candidate.mp4" ^
       --transcode-path "anime/...transcode-candidate.mkv"

The script starts and stops the local server for each scenario, prints live
overall/scenario/iteration progress plus ETA, and writes checked-in output under
`docs/benchmarks/video_cpu_control/<machine-label>/`.

Do not add actual media files to the repository. Only benchmark metadata,
machine-local measurements, and the remote-relative test paths belong in the
checked-in output.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import subprocess
import sys
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterator

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from misc import benchmark_video_startup as startup

CONFIG_LOCAL_PATH = PROJECT_ROOT / "config_local.json"
DEFAULT_OUTPUT_ROOT = PROJECT_ROOT / "docs" / "benchmarks" / "video_cpu_control"


@dataclass(frozen=True)
class Scenario:
    name: str
    label: str
    path: str
    config_overrides: dict[str, Any]
    force_video_transcode: bool = False
    force_audio_transcode: bool = False
    notes: str = ""


def build_scenarios(copy_path: str, transcode_path: str) -> list[Scenario]:
    return [
        Scenario(
            name="current-unpaced",
            label="Current unpaced behavior",
            path=transcode_path,
            config_overrides={
                "VideoFFmpegReadRate": 0.0,
                "VideoFFmpegInitialBurstSeconds": 0.0,
                "VideoFFmpegCatchupReadRate": 0.0,
                "VideoFFmpegThreads": 0,
                "VideoFFmpegFilterThreads": 0,
                "VideoFFmpegProcessPriority": "below_normal",
            },
            notes="Baseline transcode session with pacing disabled and ffmpeg automatic threading.",
        ),
        Scenario(
            name="conservative-pacing",
            label="Conservative pacing",
            path=transcode_path,
            config_overrides={
                "VideoFFmpegReadRate": 1.1,
                "VideoFFmpegInitialBurstSeconds": 18.0,
                "VideoFFmpegCatchupReadRate": 1.3,
                "VideoFFmpegThreads": 0,
                "VideoFFmpegFilterThreads": 0,
                "VideoFFmpegProcessPriority": "below_normal",
            },
            notes="Gentle pacing intended to reduce background encode-ahead while preserving startup.",
        ),
        Scenario(
            name="moderate-pacing",
            label="Moderate pacing",
            path=transcode_path,
            config_overrides={
                "VideoFFmpegReadRate": 1.35,
                "VideoFFmpegInitialBurstSeconds": 24.0,
                "VideoFFmpegCatchupReadRate": 1.6,
                "VideoFFmpegThreads": 0,
                "VideoFFmpegFilterThreads": 0,
                "VideoFFmpegProcessPriority": "below_normal",
            },
            notes="More aggressive than conservative pacing to test whether a stronger machine still stays responsive.",
        ),
        Scenario(
            name="weak-cpu-threads",
            label="Weak-CPU thread limits",
            path=transcode_path,
            config_overrides={
                "VideoFFmpegReadRate": 1.1,
                "VideoFFmpegInitialBurstSeconds": 18.0,
                "VideoFFmpegCatchupReadRate": 1.3,
                "VideoFFmpegThreads": 2,
                "VideoFFmpegFilterThreads": 1,
                "VideoFFmpegProcessPriority": "below_normal",
            },
            notes="Simulates a weaker box by constraining ffmpeg and filter graph threads.",
        ),
        Scenario(
            name="h264-video-copy",
            label="H.264 copy candidate",
            path=copy_path,
            config_overrides={
                "VideoFFmpegReadRate": 1.1,
                "VideoFFmpegInitialBurstSeconds": 18.0,
                "VideoFFmpegCatchupReadRate": 1.3,
                "VideoFFmpegThreads": 0,
                "VideoFFmpegFilterThreads": 0,
                "VideoFFmpegProcessPriority": "below_normal",
            },
            notes="Expected H.264/AAC copy-safe path to quantify the low-CPU ceiling.",
        ),
        Scenario(
            name="full-transcode-copy-candidate",
            label="Full transcode session",
            path=copy_path,
            config_overrides={
                "VideoFFmpegReadRate": 1.1,
                "VideoFFmpegInitialBurstSeconds": 18.0,
                "VideoFFmpegCatchupReadRate": 1.3,
                "VideoFFmpegThreads": 0,
                "VideoFFmpegFilterThreads": 0,
                "VideoFFmpegProcessPriority": "below_normal",
            },
            force_video_transcode=True,
            force_audio_transcode=True,
            notes="Forces the same copy candidate through full video+audio transcode for an apples-to-apples comparison.",
        ),
    ]


def _read_json_file(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8-sig"))


def _write_json_file(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


@contextmanager
def temporary_config_local(overrides: dict[str, Any]) -> Iterator[None]:
    original_exists = CONFIG_LOCAL_PATH.exists()
    original_text = CONFIG_LOCAL_PATH.read_text(encoding="utf-8-sig") if original_exists else ""
    merged = _read_json_file(CONFIG_LOCAL_PATH)
    merged.update(overrides)
    _write_json_file(CONFIG_LOCAL_PATH, merged)
    try:
        yield
    finally:
        if original_exists:
            CONFIG_LOCAL_PATH.write_text(original_text, encoding="utf-8")
        else:
            CONFIG_LOCAL_PATH.unlink(missing_ok=True)


def _poll_ready(base_url: str, *, timeout_seconds: float = 45.0) -> None:
    deadline = time.perf_counter() + timeout_seconds
    last_error = "server did not become ready"
    while time.perf_counter() < deadline:
        try:
            with urllib.request.urlopen(f"{base_url}/video/endpoints/status", timeout=3.0) as response:
                if response.status == 200:
                    return
                last_error = f"status returned {response.status}"
        except (OSError, urllib.error.URLError) as exc:
            last_error = str(exc)
        time.sleep(0.25)
    raise RuntimeError(last_error)


def _creation_flags() -> int:
    if os.name != "nt":
        return 0
    return getattr(subprocess, "CREATE_NO_WINDOW", 0)


@contextmanager
def running_server(port: int, *, config_overrides: dict[str, Any]) -> Iterator[str]:
    with temporary_config_local(config_overrides):
        command = [sys.executable, "-m", "dropbox_browser.cli", "--port", str(port)]
        process = subprocess.Popen(
            command,
            cwd=str(PROJECT_ROOT),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=_creation_flags(),
        )
        base_url = f"http://127.0.0.1:{port}"
        try:
            _poll_ready(base_url)
            yield base_url
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)


def _safe_machine_slug(machine_label: str) -> str:
    slug = "".join(ch.lower() if ch.isalnum() else "-" for ch in machine_label).strip("-")
    return slug or "machine"


def _gib(bytes_value: int | None) -> float | None:
    if not bytes_value:
        return None
    return round(bytes_value / (1024 ** 3), 2)


def collect_machine_metadata() -> dict[str, Any]:
    result = {
        "hostname": platform.node(),
        "platform": platform.platform(),
        "python_version": platform.python_version(),
        "cpu_count_logical": os.cpu_count(),
    }
    if os.name != "nt":
        return result
    commands = {
        "processor": [
            "powershell",
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed,Manufacturer | ConvertTo-Json -Compress",
        ],
        "system": [
            "powershell",
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_ComputerSystem | Select-Object TotalPhysicalMemory,Manufacturer,Model | ConvertTo-Json -Compress",
        ],
    }
    for key, command in commands.items():
        try:
            completed = subprocess.run(
                command,
                cwd=str(PROJECT_ROOT),
                capture_output=True,
                text=True,
                check=True,
                creationflags=_creation_flags(),
            )
        except (OSError, subprocess.CalledProcessError):
            continue
        text = completed.stdout.strip()
        if not text:
            continue
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            result[key] = payload
    system = result.get("system")
    if isinstance(system, dict):
        total_memory = system.get("TotalPhysicalMemory")
        try:
            result["total_memory_gib"] = _gib(int(total_memory))
        except (TypeError, ValueError):
            pass
    return result


def _scenario_config_payload(overrides: dict[str, Any], scenario: Scenario) -> dict[str, Any]:
    return {
        "VideoFFmpegReadRate": overrides.get("VideoFFmpegReadRate"),
        "VideoFFmpegInitialBurstSeconds": overrides.get("VideoFFmpegInitialBurstSeconds"),
        "VideoFFmpegCatchupReadRate": overrides.get("VideoFFmpegCatchupReadRate"),
        "VideoFFmpegThreads": overrides.get("VideoFFmpegThreads"),
        "VideoFFmpegFilterThreads": overrides.get("VideoFFmpegFilterThreads"),
        "VideoFFmpegProcessPriority": overrides.get("VideoFFmpegProcessPriority"),
        "force_video_transcode": scenario.force_video_transcode,
        "force_audio_transcode": scenario.force_audio_transcode,
    }


def _choose_recommended_defaults(report: dict[str, Any]) -> dict[str, Any]:
    scenarios = report.get("scenarios") or []
    by_name = {str(item.get("name")): item for item in scenarios if isinstance(item, dict)}
    conservative = by_name.get("conservative-pacing")
    moderate = by_name.get("moderate-pacing")
    weak_cpu = by_name.get("weak-cpu-threads")
    recommended = {
        "VideoFFmpegReadRate": 1.1,
        "VideoFFmpegInitialBurstSeconds": 18.0,
        "VideoFFmpegCatchupReadRate": 1.3,
        "VideoFFmpegThreads": 0,
        "VideoFFmpegFilterThreads": 0,
        "VideoFFmpegProcessPriority": "below_normal",
        "basis": "fallback defaults",
    }
    if isinstance(conservative, dict):
        recommended["basis"] = "conservative-pacing"
    if isinstance(weak_cpu, dict):
        weak_summary = weak_cpu.get("summary") or {}
        weak_cpu_mean = ((weak_summary.get("ffmpeg_cpu_percent_mean") or {}).get("mean"))
        try:
            if weak_cpu_mean is not None and float(weak_cpu_mean) < 60.0:
                recommended["VideoFFmpegThreads"] = 2
                recommended["VideoFFmpegFilterThreads"] = 1
                recommended["basis"] += " + weak-cpu thread cap"
        except (TypeError, ValueError):
            pass
    if isinstance(moderate, dict):
        stalls = int((moderate.get("summary") or {}).get("client_hls_stall_events") or 0)
        try:
            cpu_mean = float(((moderate.get("summary") or {}).get("ffmpeg_cpu_percent_mean") or {}).get("mean"))
        except (TypeError, ValueError):
            cpu_mean = None
        if stalls == 0 and cpu_mean is not None and cpu_mean <= 80.0:
            recommended.update(
                {
                    "VideoFFmpegReadRate": 1.35,
                    "VideoFFmpegInitialBurstSeconds": 24.0,
                    "VideoFFmpegCatchupReadRate": 1.6,
                    "basis": "moderate-pacing",
                }
            )
    return recommended


def _format_stat_block(stats: dict[str, Any] | None) -> str:
    if not isinstance(stats, dict):
        return "n/a"
    mean = stats.get("mean")
    median = stats.get("median")
    return f"mean={mean}, median={median}"


def _format_duration(seconds: float) -> str:
    total = max(0, int(round(seconds)))
    minutes, seconds_part = divmod(total, 60)
    return f"{minutes:02d}:{seconds_part:02d}"


def _print_progress(
    *,
    scenario_index: int,
    scenario_total: int,
    iteration_index: int,
    iteration_total: int,
    overall_index: int,
    overall_total: int,
    scenario_label: str,
    stage: str,
    run_started: float,
    sample_elapsed: float | None = None,
    sample_total: float | None = None,
) -> None:
    elapsed = time.perf_counter() - run_started
    completed_fraction = 0.0 if overall_total <= 0 else max(0.0, min(1.0, overall_index / overall_total))
    eta = (elapsed / completed_fraction - elapsed) if completed_fraction > 0 else 0.0
    message = (
        f"[overall {overall_index}/{overall_total} | scenario {scenario_index}/{scenario_total} "
        f"| iteration {iteration_index}/{iteration_total}] {scenario_label}: {stage} "
        f"(elapsed {_format_duration(elapsed)}, eta {_format_duration(eta)})"
    )
    if sample_elapsed is not None and sample_total is not None:
        message += f" [{sample_elapsed:.0f}/{sample_total:.0f}s sample]"
    print(message, flush=True)


def write_markdown_summary(report: dict[str, Any], output_path: Path) -> None:
    machine = report.get("machine") or {}
    processor = machine.get("processor") or {}
    system = machine.get("system") or {}
    lines = [
        "# Video CPU Control Benchmark Report",
        "",
        f"- Machine label: `{report.get('machine_label')}`",
        f"- CPU: `{processor.get('Name', 'unknown')}`",
        f"- Cores / logical processors: `{processor.get('NumberOfCores', 'unknown')} / {processor.get('NumberOfLogicalProcessors', 'unknown')}`",
        f"- RAM: `{machine.get('total_memory_gib', 'unknown')} GiB`",
        f"- System: `{system.get('Manufacturer', 'unknown')} {system.get('Model', 'unknown')}`",
        f"- Copy candidate: `{report.get('copy_candidate_path')}`",
        f"- Full-transcode candidate: `{report.get('transcode_candidate_path')}`",
        "",
        "## Scenario Results",
        "",
        "| Scenario | Video/Audio mode | Startup ms | Encode rate | ffmpeg CPU | HLS stalls |",
        "|---|---|---:|---:|---:|---:|",
    ]
    for scenario in report.get("scenarios") or []:
        summary = scenario.get("summary") or {}
        startup_ms = _format_stat_block(summary.get("total_startup_ms"))
        encode_rate = _format_stat_block(summary.get("media_encode_rate"))
        cpu = _format_stat_block(summary.get("ffmpeg_cpu_percent_mean"))
        lines.append(
            "| "
            + f"{scenario.get('label')} | "
            + f"{scenario.get('observed_video_mode', 'n/a')}/{scenario.get('observed_audio_mode', 'n/a')} | "
            + f"{startup_ms} | {encode_rate} | {cpu} | {summary.get('client_hls_stall_events', 'n/a')} |"
        )
    recommended = report.get("recommended_defaults") or {}
    lines.extend(
        [
            "",
            "## Recommended Defaults",
            "",
            "```json",
            json.dumps(recommended, indent=2, sort_keys=True),
            "```",
            "",
            "## Next Measurement Gate",
            "",
            "Run the same matrix on a weaker computer before finalizing the defaults globally. "
            "The strong-machine numbers here establish an upper-bound baseline, not the last word on safe defaults.",
            "",
        ]
    )
    output_path.write_text("\n".join(lines), encoding="utf-8")


def _write_report_files(report: dict[str, Any], output_dir: Path) -> tuple[Path, Path]:
    report["recommended_defaults"] = _choose_recommended_defaults(report)
    json_path = output_dir / "results.json"
    markdown_path = output_dir / "README.md"
    _write_json_file(json_path, report)
    write_markdown_summary(report, markdown_path)
    return json_path, markdown_path


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run the video CPU/control benchmark matrix and write checked-in machine results.",
        epilog=(
            "Example:\n"
            "  python misc/benchmark_video_matrix.py "
            '--machine-label asus-rog-strix-g614jv-2026-06-29 --port 8016 '
            '--copy-path "anime/...copy-candidate.mp4" '
            '--transcode-path "anime/...transcode-candidate.mkv"\n\n'
            "Use remote Dropbox-relative media paths only. Do not check actual media files into git."
        ),
        formatter_class=argparse.RawTextHelpFormatter,
    )
    parser.add_argument("--copy-path", required=True, help="Remote Dropbox-relative path for the H.264/AAC copy candidate.")
    parser.add_argument("--transcode-path", required=True, help="Remote Dropbox-relative path for the full-transcode candidate.")
    parser.add_argument("--machine-label", required=True)
    parser.add_argument("--port", type=int, default=8016)
    parser.add_argument("--iterations", type=int, default=1)
    parser.add_argument("--sample-seconds", type=float, default=8.0)
    parser.add_argument("--sample-interval-seconds", type=float, default=1.0)
    parser.add_argument("--output-root", type=Path, default=DEFAULT_OUTPUT_ROOT)
    args = parser.parse_args()

    machine_slug = _safe_machine_slug(args.machine_label)
    output_dir = args.output_root / machine_slug
    output_dir.mkdir(parents=True, exist_ok=True)
    run_started = time.perf_counter()
    scenarios = build_scenarios(args.copy_path, args.transcode_path)
    scenario_total = len(scenarios)
    iteration_total = max(1, args.iterations)
    overall_total = scenario_total * iteration_total

    report: dict[str, Any] = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "machine_label": args.machine_label,
        "machine": collect_machine_metadata(),
        "copy_candidate_path": args.copy_path,
        "transcode_candidate_path": args.transcode_path,
        "iterations": args.iterations,
        "sample_seconds": args.sample_seconds,
        "sample_interval_seconds": args.sample_interval_seconds,
        "benchmark_mode": "quick",
        "scenarios": [],
    }

    for scenario_index, scenario in enumerate(scenarios, start=1):
        _print_progress(
            scenario_index=scenario_index,
            scenario_total=scenario_total,
            iteration_index=0,
            iteration_total=iteration_total,
            overall_index=(scenario_index - 1) * iteration_total,
            overall_total=overall_total,
            scenario_label=scenario.label,
            stage="server_start",
            run_started=run_started,
        )
        with running_server(args.port, config_overrides=scenario.config_overrides) as base_url:
            results = []
            for iteration_index in range(1, iteration_total + 1):
                overall_index = (scenario_index - 1) * iteration_total + iteration_index

                def _progress_callback(event: dict[str, object]) -> None:
                    stage = str(event.get("stage") or "work")
                    sample_elapsed = None
                    sample_total = None
                    if stage == "sample":
                        sample_elapsed = float(event.get("elapsed_seconds") or 0.0)
                        sample_total = float(event.get("total_seconds") or 0.0)
                        stage_text = "sampling"
                    else:
                        stage_text = stage.replace("_", " ")
                    _print_progress(
                        scenario_index=scenario_index,
                        scenario_total=scenario_total,
                        iteration_index=iteration_index,
                        iteration_total=iteration_total,
                        overall_index=overall_index,
                        overall_total=overall_total,
                        scenario_label=scenario.label,
                        stage=stage_text,
                        run_started=run_started,
                        sample_elapsed=sample_elapsed,
                        sample_total=sample_total,
                    )

                results.append(
                    startup.run_iteration(
                    base_url,
                    scenario.path,
                    iteration_index,
                    clear_probe_cache=True,
                    sample_seconds=max(0.0, args.sample_seconds),
                    sample_interval_seconds=max(0.05, args.sample_interval_seconds),
                    client_log_path=startup.CLIENT_LOG_PATH,
                    force_video_transcode=scenario.force_video_transcode,
                    force_audio_transcode=scenario.force_audio_transcode,
                    progress_callback=_progress_callback,
                    )
                )
        summary = startup.summarize(results)
        scenario_payload = {
            "name": scenario.name,
            "label": scenario.label,
            "path": scenario.path,
            "notes": scenario.notes,
            "scenario_config": _scenario_config_payload(scenario.config_overrides, scenario),
            "observed_video_mode": next((row.video_mode for row in results if row.video_mode), None),
            "observed_audio_mode": next((row.audio_mode for row in results if row.audio_mode), None),
            "iterations": [asdict(row) for row in results],
            "summary": summary,
        }
        report["scenarios"].append(scenario_payload)
        print(json.dumps({"scenario": scenario.name, "summary": summary}, indent=2, sort_keys=True))
        json_path, markdown_path = _write_report_files(report, output_dir)
        print(f"Updated {json_path}")
        print(f"Updated {markdown_path}")

    json_path, markdown_path = _write_report_files(report, output_dir)
    print(f"Wrote {json_path}")
    print(f"Wrote {markdown_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
