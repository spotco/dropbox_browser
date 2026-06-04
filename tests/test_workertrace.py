from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from dropbox_browser import workertrace


class WorkerTraceRunTests(unittest.TestCase):
    def test_configure_server_run_writes_current_run_metadata_and_routes_trace(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            fallback = root / "foldercache_threads.jsonl"
            with (
                patch.object(workertrace, "TEMP_DIR", root),
                patch.object(workertrace, "TRACE_LOG_PATH", fallback),
                patch.object(workertrace, "_configured_trace_path", None),
                patch.object(workertrace, "_run_dir", None),
                patch.object(workertrace, "_run_id", None),
            ):
                run_dir = workertrace.configure_server_run(
                    started_at=1779341234.9,
                    metadata={"remote": "dropbox:", "local_root": "C:\\Sync"},
                )
                workertrace.append("sample_event", value=42)

            self.assertEqual(run_dir, root / "runs" / "1779341234")
            self.assertEqual((root / "current-run.txt").read_text(encoding="utf-8"), "1779341234\n")
            metadata = json.loads((run_dir / "server.json").read_text(encoding="utf-8"))
            self.assertEqual(metadata["started_at"], 1779341234)
            self.assertEqual(metadata["remote"], "dropbox:")
            self.assertEqual(metadata["local_root"], "C:\\Sync")
            trace_lines = (run_dir / "foldercache_threads.jsonl").read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(trace_lines), 1)
            self.assertEqual(json.loads(trace_lines[0])["event"], "sample_event")
            self.assertFalse(fallback.exists())

    def test_record_diagnostic_writes_to_run_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            fallback = root / "foldercache_threads.jsonl"
            with (
                patch.object(workertrace, "TEMP_DIR", root),
                patch.object(workertrace, "TRACE_LOG_PATH", fallback),
                patch.object(workertrace, "_configured_trace_path", None),
                patch.object(workertrace, "_run_dir", None),
                patch.object(workertrace, "_run_id", None),
            ):
                run_dir = workertrace.configure_server_run(started_at=1779341234.9)
                workertrace.record_diagnostic("slow_cache_read", elapsed_ms=512.5)

            diagnostic_lines = (run_dir / "slow_operations.jsonl").read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(diagnostic_lines), 1)
            record = json.loads(diagnostic_lines[0])
            self.assertEqual(record["kind"], "slow_cache_read")
            self.assertEqual(record["elapsed_ms"], 512.5)

    def test_append_records_slow_trace_write_diagnostic_when_threshold_is_crossed(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            fallback = root / "foldercache_threads.jsonl"
            with (
                patch.object(workertrace, "TEMP_DIR", root),
                patch.object(workertrace, "TRACE_LOG_PATH", fallback),
                patch.object(workertrace, "_configured_trace_path", None),
                patch.object(workertrace, "_run_dir", None),
                patch.object(workertrace, "_run_id", None),
                patch.object(workertrace, "SLOW_OPERATION_THRESHOLD_MS", 0.0),
            ):
                run_dir = workertrace.configure_server_run(started_at=1779341234.9)
                workertrace.append("sample_event", value=42)

            diagnostic_lines = (run_dir / "slow_operations.jsonl").read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(diagnostic_lines), 1)
            record = json.loads(diagnostic_lines[0])
            self.assertEqual(record["kind"], "slow_trace_write")
            self.assertEqual(record["event"], "sample_event")


if __name__ == "__main__":
    unittest.main()
