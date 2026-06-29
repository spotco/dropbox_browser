# Video CPU Control Benchmark Report

- Machine label: `asus-rog-strix-g614jv-2026-06-29`
- CPU: `13th Gen Intel(R) Core(TM) i7-13650HX`
- Cores / logical processors: `14 / 20`
- RAM: `63.63 GiB`
- System: `ASUSTeK COMPUTER INC. ROG Strix G614JV_G614JV`
- Copy candidate: `anime/[PsyPlex] Detective Conan 1-1006 + Movies 1-23 Batch/Season 10/Detective Conan - S10E07 - The Fearful Legend of the Snowy Night (1) SDTV-Kienai-AZFS.mp4`
- Full-transcode candidate: `anime/[Judas] Fairy Tail (2009-2014) (Seasons 1-8 + OVAs) [BD 1080p][HEVC x265 10bit][Dual-Audio][Eng-Subs]/[Judas] Fairy Tail (2009)/[Judas] Fairy Tail (2009) - 001.mkv`

## Scenario Results

| Scenario | Video/Audio mode | Startup ms | Encode rate | ffmpeg CPU | HLS stalls |
|---|---|---:|---:|---:|---:|
| Current unpaced behavior | video_transcode/audio_transcode | mean=15126.055, median=15126.055 | mean=19.284, median=19.284 | mean=1342.993, median=1342.993 | 0 |
| Conservative pacing | video_transcode/audio_transcode | mean=15794.329, median=15794.329 | mean=2.215, median=2.215 | mean=119.94, median=119.94 | 0 |
| Moderate pacing | video_transcode/audio_transcode | mean=18052.1, median=18052.1 | mean=2.92, median=2.92 | mean=201.152, median=201.152 | 0 |
| Weak-CPU thread limits | video_transcode/audio_transcode | mean=18224.17, median=18224.17 | mean=1.391, median=1.391 | mean=81.739, median=81.739 | 0 |
| H.264 copy candidate | video_copy/audio_copy | mean=8147.512, median=8147.512 | mean=1.793, median=1.793 | mean=0.0, median=0.0 | 0 |
| Full transcode session | video_transcode/audio_transcode | mean=7593.328, median=7593.328 | mean=1.459, median=1.459 | mean=21.303, median=21.303 | 0 |

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
