# Video CPU Control Benchmarks

This folder contains checked-in benchmark metadata for video CPU-control
measurement runs. It does not contain media files. The benchmark inputs are
remote Dropbox-relative paths supplied at runtime.

## How To Run

From the repo root:

```powershell
python misc/benchmark_video_matrix.py `
  --machine-label <machine-label> `
  --port 8016 `
  --copy-path "anime/...copy-candidate.mp4" `
  --transcode-path "anime/...transcode-candidate.mkv"
```

Expected inputs:

- `--copy-path`: a remote H.264/AAC `.mp4` or `.m4v` copy-mode candidate
- `--transcode-path`: a remote HEVC or otherwise incompatible full-transcode candidate

The script:

- starts and stops the local server per scenario
- runs six benchmark scenarios
- prints current scenario progress, overall progress, and ETA
- writes machine-specific output under `docs/benchmarks/video_cpu_control/<machine-label>/`

Default quick-run shape:

- `1` iteration per scenario
- `8` seconds of sampling per iteration
- about `2m 24s` total on the June 29, 2026 ASUS test machine

## Current Machine Notes

Latest checked-in machine report:

- [asus-rog-strix-g614jv-2026-06-29/README.md](asus-rog-strix-g614jv-2026-06-29/README.md)
- [asus-rog-strix-g614jv-2026-06-29/results.json](asus-rog-strix-g614jv-2026-06-29/results.json)

Machine:

- CPU: `13th Gen Intel(R) Core(TM) i7-13650HX`
- Cores / logical processors: `14 / 20`
- RAM: `63.63 GiB`
- System: `ASUSTeK COMPUTER INC. ROG Strix G614JV_G614JV`

Quick-run results used for current provisional defaults:

- Unpaced HEVC transcode: `~1343%` ffmpeg CPU mean, `~19.3x` encode rate
- Conservative pacing: `~120%` ffmpeg CPU mean, `~2.2x` encode rate
- Moderate pacing: `~201%` ffmpeg CPU mean, `~2.9x` encode rate
- Weak-CPU thread limits: `~81.7%` ffmpeg CPU mean, `~1.39x` encode rate
- H.264/AAC copy candidate: `0%` ffmpeg CPU mean
- Forced full transcode of the same MP4: `~21.3%` ffmpeg CPU mean

Current provisional defaults from that run:

- `VideoFFmpegReadRate = 1.1`
- `VideoFFmpegInitialBurstSeconds = 18.0`
- `VideoFFmpegCatchupReadRate = 1.3`
- `VideoFFmpegThreads = 0`
- `VideoFFmpegFilterThreads = 0`
- `VideoFFmpegProcessPriority = "below_normal"`

Reasoning:

- `1.1 / 18 / 1.3` removed the runaway encode-ahead behavior from the unpaced
  HEVC transcode case without introducing stalls in the quick pass.
- The more aggressive `1.35 / 24 / 1.6` pacing increased CPU again on this
  machine without improving the no-stall result.
- Thread caps are still useful as a weaker-machine tuning fallback, but are not
  the current default on this stronger machine.

## Next Required Comparison

This machine is the strong-box baseline. Before locking defaults globally, run
the same matrix on a weaker computer and compare:

- startup time
- HLS stalls/loading events
- ffmpeg CPU mean/max
- encode rate
- encoded-ahead behavior

If the weaker machine stutters or stays too hot at `1.1 / 18 / 1.3`, the next
step is to revise the default pacing and/or thread settings from that side of
the comparison before moving on to server-side backpressure work.
