from __future__ import annotations

from http import HTTPStatus
from pathlib import Path

from .errors import BrowserError


def parse_multipart_file(body: bytes, boundary: str, field_name: str) -> tuple[str, bytes]:
    marker = ("--" + boundary).encode()
    for part in body.split(marker):
        part = part.strip(b"\r\n")
        if not part or part == b"--":
            continue
        headers_blob, _, content = part.partition(b"\r\n\r\n")
        headers = headers_blob.decode("utf-8", "replace")
        disposition = next((line for line in headers.splitlines() if line.lower().startswith("content-disposition:")), "")
        if f'name="{field_name}"' not in disposition:
            continue
        filename = ""
        for segment in disposition.split(";"):
            segment = segment.strip()
            if segment.startswith("filename="):
                filename = segment.split("=", 1)[1].strip().strip('"')
                break
        if content.endswith(b"\r\n"):
            content = content[:-2]
        if not filename:
            raise BrowserError(HTTPStatus.BAD_REQUEST, "No file was selected.")
        return Path(filename).name, content
    raise BrowserError(HTTPStatus.BAD_REQUEST, "Upload file field was not found.")
