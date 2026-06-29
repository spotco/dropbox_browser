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

Cross-machine quick-run results that drive the current defaults:

- Unpaced HEVC transcode: `~1343%` ffmpeg CPU mean, `~19.3x` encode rate
- Conservative pacing: `~120%` ffmpeg CPU mean, `~2.2x` encode rate
- Moderate pacing: `~201%` ffmpeg CPU mean, `~2.9x` encode rate
- Weak-CPU thread limits: `~81.7%` ffmpeg CPU mean, `~1.39x` encode rate
- H.264/AAC copy candidate: `0%` ffmpeg CPU mean
- Forced full transcode of the same MP4: `~21.3%` ffmpeg CPU mean

Surface Book 3 weak-machine comparison:

- Unpaced HEVC transcode: `~741%` ffmpeg CPU mean, `~6.7x` encode rate
- Conservative pacing: `~155%` ffmpeg CPU mean, `~2.2x` encode rate
- Moderate pacing: `~235%` ffmpeg CPU mean, `~3.0x` encode rate
- Weak-CPU thread limits: `~127%` ffmpeg CPU mean, `~2.2x` encode rate
- H.264/AAC copy candidate: `0%` ffmpeg CPU mean
- Forced full transcode of the same MP4: `~15.7%` ffmpeg CPU mean

Final shipped defaults after the strong-machine and Surface Book 3 comparison:

- `VideoFFmpegReadRate = 1.1`
- `VideoFFmpegInitialBurstSeconds = 18.0`
- `VideoFFmpegCatchupReadRate = 1.3`
- `VideoFFmpegThreads = 2`
- `VideoFFmpegFilterThreads = 1`
- `VideoFFmpegProcessPriority = "below_normal"`

Reasoning:

- `1.1 / 18 / 1.3` removed the runaway encode-ahead behavior from the unpaced
  HEVC transcode case on both machines without introducing stalls in the quick
  pass.
- The more aggressive `1.35 / 24 / 1.6` pacing increased CPU again on both
  machines without improving the no-stall result.
- On the Surface Book 3, adding `threads=2` and `filter_threads=1` cut the
  paced HEVC transcode from `~155%` to `~127%` mean ffmpeg CPU with nearly the
  same startup time and still no observed HLS stalls.
- On the ASUS machine, the same thread caps stayed safely above realtime
  (`~1.39x` encode rate) while keeping ffmpeg CPU far below the unpaced
  baseline, so the weaker-machine profile is safe to ship as the default.

## Next Validation Gate

The defaults are now locked from the two-machine comparison. Next validation
work should focus on broader content coverage rather than another baseline box:

- burned-in subtitle sessions
- long seeks and recovery restarts
- very long files where encoded-ahead drift can reappear
- backpressure thresholds before Phase 6 implementation

If real playback on the Surface Book 3 still feels too hot with the shipped
defaults, the next change should be dynamic backpressure, not a return to the
unbounded-thread profile.
