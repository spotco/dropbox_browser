from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from misc import benchmark_video_startup as benchmark
from misc import benchmark_video_matrix as matrix


class VideoBenchmarkTests(unittest.TestCase):
    def test_playlist_metrics_counts_segments_edge_and_endlist(self) -> None:
        metrics = benchmark._playlist_metrics(
            "#EXTM3U\n"
            "#EXTINF:6,\n"
            "segment_00000.m4s\n"
            "#EXTINF:5.5,\n"
            "/video/endpoints/session/file?id=abc&name=segment_00001.m4s\n"
            "#EXT-X-ENDLIST\n"
        )

        self.assertEqual(metrics["playlist_segment_count"], 2)
        self.assertEqual(metrics["playlist_edge_seconds"], 11.5)
        self.assertTrue(metrics["playlist_has_endlist"])

    def test_read_client_video_events_counts_hls_and_media_events_after_offset(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "client_logs.jsonl"
            path.write_text(
                json.dumps({"subsystem": "video-timing", "message": "Playback timing: old"}) + "\n",
                encoding="utf-8",
            )
            offset = path.stat().st_size
            with path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps({
                    "subsystem": "video-timing",
                    "message": "Playback timing: hls_manifest_loading",
                    "details": {"milestone": "hls_manifest_loading"},
                }) + "\n")
                handle.write(json.dumps({
                    "subsystem": "video-timing",
                    "message": "Playback timing: hls_manifest_parse_stall",
                    "details": {"milestone": "hls_manifest_parse_stall"},
                }) + "\n")
                handle.write(json.dumps({
                    "subsystem": "video",
                    "message": "Video element waiting",
                }) + "\n")
                handle.write(json.dumps({
                    "subsystem": "video",
                    "message": "Video element stalled",
                }) + "\n")

            counts = benchmark._read_client_video_events(path, offset)

        self.assertEqual(counts["client_hls_loading_events"], 1)
        self.assertEqual(counts["client_hls_stall_events"], 1)
        self.assertEqual(counts["client_video_waiting_events"], 1)
        self.assertEqual(counts["client_video_stalled_events"], 1)

    def test_default_output_path_writes_under_temp_video_benchmarks(self) -> None:
        output_path = benchmark._default_output_path("moderate pacing")

        self.assertEqual(output_path.parent, benchmark.BENCHMARK_DIR)
        self.assertIn("moderate-pacing", output_path.name)
        self.assertEqual(output_path.suffix, ".jsonl")

    def test_sample_rate_returns_units_per_second(self) -> None:
        self.assertEqual(benchmark._sample_rate(6.0, 18.0, 4.0), 3.0)
        self.assertIsNone(benchmark._sample_rate(None, 18.0, 4.0))
        self.assertIsNone(benchmark._sample_rate(6.0, 18.0, 0.0))

    def test_build_scenarios_covers_required_matrix(self) -> None:
        scenarios = matrix.build_scenarios("copy/video.mp4", "transcode/video.mkv")

        self.assertEqual(
            [scenario.name for scenario in scenarios],
            [
                "current-unpaced",
                "conservative-pacing",
                "moderate-pacing",
                "weak-cpu-threads",
                "h264-video-copy",
                "full-transcode-copy-candidate",
            ],
        )
        self.assertEqual(scenarios[4].path, "copy/video.mp4")
        self.assertTrue(scenarios[5].force_video_transcode)
        self.assertTrue(scenarios[5].force_audio_transcode)

    def test_scenario_config_payload_records_pacing_threads_and_force_flags(self) -> None:
        scenario = matrix.Scenario(
            name="full-transcode-copy-candidate",
            label="Full transcode session",
            path="copy/video.mp4",
            config_overrides={
                "VideoFFmpegReadRate": 1.1,
                "VideoFFmpegInitialBurstSeconds": 18.0,
                "VideoFFmpegCatchupReadRate": 1.3,
                "VideoFFmpegThreads": 2,
                "VideoFFmpegFilterThreads": 1,
                "VideoFFmpegProcessPriority": "below_normal",
            },
            force_video_transcode=True,
            force_audio_transcode=True,
        )

        payload = matrix._scenario_config_payload(scenario.config_overrides, scenario)

        self.assertEqual(payload["VideoFFmpegReadRate"], 1.1)
        self.assertEqual(payload["VideoFFmpegInitialBurstSeconds"], 18.0)
        self.assertEqual(payload["VideoFFmpegCatchupReadRate"], 1.3)
        self.assertEqual(payload["VideoFFmpegThreads"], 2)
        self.assertEqual(payload["VideoFFmpegFilterThreads"], 1)
        self.assertEqual(payload["VideoFFmpegProcessPriority"], "below_normal")
        self.assertTrue(payload["force_video_transcode"])
        self.assertTrue(payload["force_audio_transcode"])


if __name__ == "__main__":
    unittest.main()
