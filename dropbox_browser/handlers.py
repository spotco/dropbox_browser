from __future__ import annotations

import json as _json
import mimetypes
from pathlib import Path
import posixpath
import shutil
import sys
import tempfile
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, quote, urlencode, urlparse

from . import MAX_UPLOAD_BYTES
from . import logstore
from .config import upload_temp_dir
from .errors import BrowserError
from .formatting import display_date, human_size
from .paths import clean_rel_path, remote_target, safe_join_local
from .services import DropboxBrowser
from .uploads import parse_multipart_file
from .views import error_html, page_html


class RequestHandler(BaseHTTPRequestHandler):
    server_version = "DropboxBrowser/0.1"

    @property
    def app(self) -> DropboxBrowser:
        return self.server.app  # type: ignore[attr-defined]

    def do_GET(self) -> None:
        try:
            parsed = urlparse(self.path)
            if parsed.path == "/":
                self.render_index(parsed.query)
            elif parsed.path == "/file":
                self.serve_file(parsed.query, inline=True)
            elif parsed.path == "/download":
                self.serve_file(parsed.query, inline=False)
            elif parsed.path == "/logs":
                self.serve_logs(parsed.query)
            elif parsed.path == "/folder-info":
                self.serve_folder_info(parsed.query)
            else:
                raise BrowserError(HTTPStatus.NOT_FOUND, "Not found.")
        except BrowserError as exc:
            self.render_error(exc.status, exc.message)
        except Exception as exc:
            self.render_error(HTTPStatus.INTERNAL_SERVER_ERROR, str(exc))

    def do_POST(self) -> None:
        try:
            parsed = urlparse(self.path)
            if parsed.path != "/upload":
                raise BrowserError(HTTPStatus.NOT_FOUND, "Not found.")
            self.handle_upload(parsed.query)
        except BrowserError as exc:
            self.render_error(exc.status, exc.message)
        except Exception as exc:
            self.render_error(HTTPStatus.INTERNAL_SERVER_ERROR, str(exc))

    def render_index(self, query: str) -> None:
        params = parse_qs(query)
        rel_path = clean_rel_path(params.get("path", [""])[0])
        sort_key = params.get("sort", ["name"])[0]
        direction = params.get("dir", ["asc"])[0]
        if sort_key not in {"name", "type", "date", "size"}:
            sort_key = "name"
        if direction not in {"asc", "desc"}:
            direction = "asc"

        entries = self.app.list_entries(rel_path)

        # Build folder cache map; stamp cached_size onto folder entries so
        # sort_entries can sort by size.  Trigger background fetch as needed.
        folder_cache_map: dict = {}
        cache = self.app.folder_cache
        if cache:
            page_time = time.time()
            cache.notify_page_load(page_time)
            for entry in entries:
                if entry["is_dir"]:
                    child = posixpath.join(rel_path, entry["name"]) if rel_path else entry["name"]
                    full_remote = remote_target(self.app.remote, child)
                    cached_data = cache.get(full_remote)
                    folder_cache_map[entry["name"]] = cached_data
                    entry["cached_size"] = cached_data.get("size") if cached_data else None
                    if cached_data is None or not cached_data.get("complete"):
                        cache.request(full_remote, page_time)

        entries = self.app.sort_entries(entries, sort_key, direction)

        self.send_html(
            HTTPStatus.OK,
            page_html(self.app, rel_path, entries, sort_key, direction,
                      params.get("msg", [""])[0], folder_cache_map or None),
        )

    def serve_file(self, query: str, inline: bool) -> None:
        params = parse_qs(query)
        rel_path = clean_rel_path(params.get("path", [""])[0])
        source = params.get("source", ["remote"])[0]
        name = Path(rel_path).name
        content_type = mimetypes.guess_type(name)[0] or "application/octet-stream"
        disposition = "inline" if inline else "attachment"

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Disposition", f'{disposition}; filename="{quote(name)}"')
        self.end_headers()

        if source == "local" and self.app.local_root:
            local_file = safe_join_local(self.app.local_root, rel_path)
            if not local_file.is_file():
                raise BrowserError(HTTPStatus.NOT_FOUND, "Local file not found.")
            with local_file.open("rb") as handle:
                shutil.copyfileobj(handle, self.wfile)
            return

        proc = self.app.rclone.open_cat(remote_target(self.app.remote, rel_path))
        assert proc.stdout is not None
        try:
            shutil.copyfileobj(proc.stdout, self.wfile)
        finally:
            proc.stdout.close()
            proc.wait(timeout=30)

    def serve_logs(self, query: str) -> None:
        params = parse_qs(query)
        since = int(params.get("since", ["0"])[0])
        entries = logstore.entries_since(since)
        body = _json.dumps({"entries": entries}).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def serve_folder_info(self, query: str) -> None:
        params = parse_qs(query)
        paths_str = params.get("paths", [""])[0]
        rel_paths = [p for p in paths_str.split(",") if p]
        cache = self.app.folder_cache
        results: dict = {}
        for rel_path in rel_paths:
            if not cache:
                results[rel_path] = {"status": "unavailable"}
                continue
            full_remote = remote_target(self.app.remote, rel_path)
            st = cache.status(full_remote)
            if st in ("complete", "partial"):
                data = cache.get(full_remote) or {}
                sz = data.get("size")
                fc = data.get("file_count")
                results[rel_path] = {
                    "status": st,
                    "complete": data.get("complete", st == "complete"),
                    "size_display": human_size(sz) if sz is not None else "—",
                    "count_display": f"{fc:,} files" if fc is not None else "",
                    "date_display": display_date(data.get("newest_mtime")),
                }
            else:
                # calculating or pending — ensure it's queued
                cache.request(full_remote)
                results[rel_path] = {"status": "calculating", "complete": False}
        body = _json.dumps({"results": results}).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_upload(self, query: str) -> None:
        params = parse_qs(query)
        rel_path = clean_rel_path(params.get("path", [""])[0])
        length = int(self.headers.get("Content-Length") or "0")
        if length <= 0:
            raise BrowserError(HTTPStatus.BAD_REQUEST, "No upload body was received.")
        if length > MAX_UPLOAD_BYTES:
            raise BrowserError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Upload is too large.")

        content_type = self.headers.get("Content-Type", "")
        boundary_key = "boundary="
        if "multipart/form-data" not in content_type or boundary_key not in content_type:
            raise BrowserError(HTTPStatus.BAD_REQUEST, "Expected multipart form upload.")
        boundary = content_type.split(boundary_key, 1)[1].strip().strip('"')
        body = self.rfile.read(length)
        filename, data = parse_multipart_file(body, boundary, "file")

        with tempfile.NamedTemporaryFile(delete=False, dir=upload_temp_dir()) as tmp:
            tmp.write(data)
            tmp_path = Path(tmp.name)
        try:
            self.app.upload_new_file(rel_path, filename, tmp_path)
        finally:
            try:
                tmp_path.unlink()
            except OSError:
                pass

        location = "/?" + urlencode({"path": rel_path, "msg": f"Uploaded {filename}"})
        self.send_response(HTTPStatus.SEE_OTHER)
        self.send_header("Location", location)
        self.end_headers()

    def send_html(self, status: HTTPStatus, body: str) -> None:
        encoded = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def render_error(self, status: HTTPStatus, message: str) -> None:
        self.send_html(status, error_html(status, message))

    def log_request(self, code: int | str = "-", size: int | str = "-") -> None:
        # Don't log polling endpoints to avoid noise.
        if self.path.startswith("/logs") or self.path.startswith("/folder-info"):
            return
        super().log_request(code, size)

    def log_message(self, fmt: str, *args: object) -> None:
        msg = fmt % args
        ts = time.strftime("%H:%M:%S")
        logstore.append("request", msg)
        if getattr(self.server, "log_requests", True):
            sys.stderr.write("[%s] %s\n" % (ts, msg))
