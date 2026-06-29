# Video CPU Control Benchmark Report

- Machine label: `surfacebook3`
- CPU: `Intel(R) Core(TM) i7-1065G7 CPU @ 1.30GHz`
- Cores / logical processors: `4 / 8`
- RAM: `31.6 GiB`
- System: `Microsoft Corporation Surface Book 3`
- Copy candidate: `anime/[PsyPlex] Detective Conan 1-1006 + Movies 1-23 Batch/Season 10/Detective Conan - S10E07 - The Fearful Legend of the Snowy Night (1) SDTV-Kienai-AZFS.mp4`
- Full-transcode candidate: `anime/[Judas] Fairy Tail (2009-2014) (Seasons 1-8 + OVAs) [BD 1080p][HEVC x265 10bit][Dual-Audio][Eng-Subs]/[Judas] Fairy Tail (2009)/[Judas] Fairy Tail (2009) - 001.mkv`

## Scenario Results

| Scenario | Video/Audio mode | Startup ms | Encode rate | ffmpeg CPU | HLS stalls |
|---|---|---:|---:|---:|---:|
| Current unpaced behavior | video_transcode/audio_transcode | mean=20919.611, median=20919.611 | mean=6.695, median=6.695 | mean=741.166, median=741.166 | 0 |
| Conservative pacing | video_transcode/audio_transcode | mean=18650.921, median=18650.921 | mean=2.206, median=2.206 | mean=154.92, median=154.92 | 0 |
| Moderate pacing | video_transcode/audio_transcode | mean=19216.904, median=19216.904 | mean=2.95, median=2.95 | mean=235.362, median=235.362 | 0 |
| Weak-CPU thread limits | video_transcode/audio_transcode | mean=19031.32, median=19031.32 | mean=2.205, median=2.205 | mean=127.233, median=127.233 | 0 |
| H.264 copy candidate | video_copy/audio_copy | mean=9456.538, median=9456.538 | mean=1.786, median=1.786 | mean=0.0, median=0.0 | 0 |
| Full transcode session | video_transcode/audio_transcode | mean=8737.869, median=8737.869 | mean=2.198, median=2.198 | mean=15.718, median=15.718 | 0 |

## Recommended Defaults

```json
{
  "VideoFFmpegCatchupReadRate": 1.3,
  "VideoFFmpegFilterThreads": 0,
  "VideoFFmpegInitialBurstSeconds": 18.0,
  "VideoFFmpegProcessPriority": "below_normal",
  "VideoFFmpegReadRate": 1.1,
  "VideoFFmpegThreads": 0,
  "basis": "conservative-pacing"
}
```

## Next Measurement Gate

Run the same matrix on a weaker computer before finalizing the defaults globally. The strong-machine numbers here establish an upper-bound baseline, not the last word on safe defaults.
