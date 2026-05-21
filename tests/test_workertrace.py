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


if __name__ == "__main__":
    unittest.main()
