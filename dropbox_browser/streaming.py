from __future__ import annotations

from dataclasses import dataclass
from http import HTTPStatus
from typing import BinaryIO
from urllib.parse import quote


@dataclass(frozen=True)
class ByteRange:
    start: int
    end: int

    @property
    def length(self) -> int:
        return self.end - self.start + 1


@dataclass(frozen=True)
class StreamPlan:
    status: HTTPStatus
    start: int
    end: int
    length: int
    file_size: int
    is_partial: bool


class RangeNotSatisfiable(ValueError):
    """Raised when a syntactically valid Range header cannot fit the file."""


def stream_headers(
    plan: StreamPlan,
    *,
    content_type: str,
    disposition: str,
    filename: str,
) -> list[tuple[str, str]]:
    headers = [
        ("Content-Type", content_type),
        ("Content-Disposition", content_disposition(disposition, filename)),
        ("Accept-Ranges", "bytes"),
        ("Content-Length", str(plan.length)),
    ]
    if plan.is_partial:
        headers.append(("Content-Range", content_range(plan)))
    return headers


def unsatisfiable_range_headers(file_size: int) -> list[tuple[str, str]]:
    return [
        ("Content-Range", f"bytes */{file_size}"),
        ("Content-Length", "0"),
        ("Accept-Ranges", "bytes"),
    ]


def content_range(plan: StreamPlan) -> str:
    return f"bytes {plan.start}-{plan.end}/{plan.file_size}"


def content_disposition(disposition: str, filename: str) -> str:
    safe_disposition = "attachment" if disposition == "attachment" else "inline"
    fallback = filename.encode("ascii", "replace").decode("ascii")
    fallback = "".join("_" if ord(ch) < 32 or ch in {'"', "\\"} else ch for ch in fallback).strip()
    if not fallback:
        fallback = "download"
    return f'{safe_disposition}; filename="{fallback}"; filename*=UTF-8\'\'{quote(filename)}'


def is_client_disconnect(exc: BaseException) -> bool:
    return isinstance(exc, (BrokenPipeError, ConnectionAbortedError, ConnectionResetError))


def plan_stream(range_header: str | None, file_size: int) -> StreamPlan:
    byte_range = parse_byte_range(range_header, file_size)
    if byte_range is None:
        return StreamPlan(
            status=HTTPStatus.OK,
            start=0,
            end=max(file_size - 1, 0),
            length=file_size,
            file_size=file_size,
            is_partial=False,
        )
    return StreamPlan(
        status=HTTPStatus.PARTIAL_CONTENT,
        start=byte_range.start,
        end=byte_range.end,
        length=byte_range.length,
        file_size=file_size,
        is_partial=True,
    )


def copy_exact(src: BinaryIO, dst: BinaryIO, count: int, buffer_size: int = 1024 * 1024) -> None:
    remaining = count
    while remaining > 0:
        chunk = src.read(min(buffer_size, remaining))
        if not chunk:
            break
        dst.write(chunk)
        remaining -= len(chunk)


def copy_file_range(src: BinaryIO, dst: BinaryIO, plan: StreamPlan) -> None:
    src.seek(plan.start)
    copy_exact(src, dst, plan.length)


def parse_byte_range(range_header: str | None, file_size: int) -> ByteRange | None:
    """Parse a single HTTP bytes range against a known file size.

    Returns None when the header is absent or is not a single bytes range. Raises
    RangeNotSatisfiable for valid bytes ranges that do not overlap the file.
    """
    if range_header is None:
        return None
    value = range_header.strip()
    unit, separator, spec = value.partition("=")
    if separator != "=" or unit.strip().lower() != "bytes":
        return None
    spec = spec.strip()
    if "," in spec or "-" not in spec:
        return None

    first, last = (part.strip() for part in spec.split("-", 1))
    if not first and not last:
        return None
    if file_size < 0:
        raise ValueError("file_size must be non-negative")
    if file_size == 0:
        raise RangeNotSatisfiable("empty file has no satisfiable byte ranges")

    if first:
        if not first.isdecimal() or (last and not last.isdecimal()):
            return None
        start = int(first)
        end = int(last) if last else file_size - 1
        if start >= file_size:
            raise RangeNotSatisfiable("range starts beyond end of file")
        if end < start:
            raise RangeNotSatisfiable("range end precedes start")
        return ByteRange(start, min(end, file_size - 1))

    if not last.isdecimal():
        return None
    suffix_length = int(last)
    if suffix_length <= 0:
        raise RangeNotSatisfiable("suffix range length must be positive")
    if suffix_length >= file_size:
        return ByteRange(0, file_size - 1)
    return ByteRange(file_size - suffix_length, file_size - 1)
