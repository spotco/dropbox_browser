from __future__ import annotations

import io
import unittest
from http import HTTPStatus

from dropbox_browser.streaming import (
    ByteRange,
    RangeNotSatisfiable,
    StreamPlan,
    content_disposition,
    copy_file_range,
    is_client_disconnect,
    parse_byte_range,
    plan_stream,
    stream_headers,
    unsatisfiable_range_headers,
)


class ByteRangeParsingTests(unittest.TestCase):
    def test_missing_or_unsupported_header_returns_none(self) -> None:
        self.assertIsNone(parse_byte_range(None, 10))
        self.assertIsNone(parse_byte_range("items=0-3", 10))
        self.assertIsNone(parse_byte_range("bytes=0-1,4-5", 10))
        self.assertIsNone(parse_byte_range("bytes=abc-def", 10))

    def test_parses_closed_range(self) -> None:
        self.assertEqual(parse_byte_range("bytes=2-5", 10), ByteRange(2, 5))

    def test_parses_case_insensitive_range_unit(self) -> None:
        self.assertEqual(parse_byte_range("Bytes = 2-5", 10), ByteRange(2, 5))

    def test_parses_open_ended_range(self) -> None:
        self.assertEqual(parse_byte_range("bytes=7-", 10), ByteRange(7, 9))

    def test_parses_suffix_range(self) -> None:
        self.assertEqual(parse_byte_range("bytes=-4", 10), ByteRange(6, 9))

    def test_clamps_end_to_file_size(self) -> None:
        self.assertEqual(parse_byte_range("bytes=7-99", 10), ByteRange(7, 9))

    def test_rejects_unsatisfiable_ranges(self) -> None:
        with self.assertRaises(RangeNotSatisfiable):
            parse_byte_range("bytes=10-", 10)
        with self.assertRaises(RangeNotSatisfiable):
            parse_byte_range("bytes=5-2", 10)
        with self.assertRaises(RangeNotSatisfiable):
            parse_byte_range("bytes=-0", 10)
        with self.assertRaises(RangeNotSatisfiable):
            parse_byte_range("bytes=0-0", 0)


class StreamPlanningTests(unittest.TestCase):
    def test_full_response_plan(self) -> None:
        plan = plan_stream(None, 10)

        self.assertEqual(plan.status, HTTPStatus.OK)
        self.assertEqual(plan.start, 0)
        self.assertEqual(plan.end, 9)
        self.assertEqual(plan.length, 10)
        self.assertFalse(plan.is_partial)

    def test_partial_response_plan(self) -> None:
        plan = plan_stream("bytes=2-5", 10)

        self.assertEqual(plan.status, HTTPStatus.PARTIAL_CONTENT)
        self.assertEqual(plan.start, 2)
        self.assertEqual(plan.end, 5)
        self.assertEqual(plan.length, 4)
        self.assertTrue(plan.is_partial)

    def test_stream_headers_include_content_range_for_partial_response(self) -> None:
        plan = StreamPlan(
            status=HTTPStatus.PARTIAL_CONTENT,
            start=2,
            end=5,
            length=4,
            file_size=10,
            is_partial=True,
        )

        headers = dict(stream_headers(
            plan,
            content_type="video/mp4",
            disposition="inline",
            filename="my video.mp4",
        ))

        self.assertEqual(headers["Content-Type"], "video/mp4")
        self.assertEqual(
            headers["Content-Disposition"],
            'inline; filename="my video.mp4"; filename*=UTF-8\'\'my%20video.mp4',
        )
        self.assertEqual(headers["Accept-Ranges"], "bytes")
        self.assertEqual(headers["Content-Length"], "4")
        self.assertEqual(headers["Content-Range"], "bytes 2-5/10")

    def test_content_disposition_includes_ascii_fallback_and_utf8_filename(self) -> None:
        self.assertEqual(
            content_disposition("attachment", 'café "mix".mp3'),
            'attachment; filename="caf? _mix_.mp3"; filename*=UTF-8\'\'caf%C3%A9%20%22mix%22.mp3',
        )

    def test_unsatisfiable_headers(self) -> None:
        self.assertEqual(
            dict(unsatisfiable_range_headers(10)),
            {
                "Content-Range": "bytes */10",
                "Content-Length": "0",
                "Accept-Ranges": "bytes",
            },
        )

    def test_copy_file_range_seeks_and_copies_only_planned_bytes(self) -> None:
        src = io.BytesIO(b"0123456789")
        dst = io.BytesIO()
        plan = plan_stream("bytes=3-6", 10)

        copy_file_range(src, dst, plan)

        self.assertEqual(dst.getvalue(), b"3456")

    def test_client_disconnect_classification(self) -> None:
        self.assertTrue(is_client_disconnect(BrokenPipeError()))
        self.assertTrue(is_client_disconnect(ConnectionAbortedError()))
        self.assertTrue(is_client_disconnect(ConnectionResetError()))
        self.assertFalse(is_client_disconnect(RuntimeError()))


if __name__ == "__main__":
    unittest.main()
