from __future__ import annotations

import json as _json
import mimetypes
from pathlib import Path
import posixpath
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, unquote, urlparse

from . import logoutput, logstore, syncstate, workertrace
from .errors import BrowserError
from .formatting import display_date, human_size
from .music import MUSIC_ENDPOINT_PREFIX, handle_music_get
from .paths import clean_rel_path, remote_target, safe_join_local
from .services import DropboxBrowser
from .streaming import (
    RangeNotSatisfiable,
    StreamPlan,
    copy_exact,
    copy_file_range,
    is_client_disconnect,
    plan_stream,
    stream_headers,
    unsatisfiable_range_headers,
)
from .syncjobs import SyncJobManager
from .views import error_html, page_html


ASSET_DIR = Path(__file__).resolve().parent / "assets"
ASSET_ROUTE_PREFIX = "/assets/"


class RequestHandler(BaseHTTPRequestHandler):
    server_version = "DropboxBrowser/0.1"

    @property
    def app(self) -> DropboxBrowser:
        return self.server.app  # type: ignore[attr-defined]

    @property
    def sync_jobs(self) -> SyncJobManager:
        if self.app.sync_jobs is None:
            self.app.sync_jobs = SyncJobManager(self.app, workers=1)
        return self.app.sync_jobs

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
            elif parsed.path == "/sync-status":
                self.serve_sync_status(parsed.query)
            elif parsed.path == "/folder-info":
                self.serve_folder_info(parsed.query)
            elif parsed.path.startswith(MUSIC_ENDPOINT_PREFIX):
                self.serve_music_endpoint(parsed.path, parsed.query)
            elif parsed.path.startswith(ASSET_ROUTE_PREFIX):
                self.serve_asset(parsed.path)
            else:
                raise BrowserError(HTTPStatus.NOT_FOUND, "Not found.")
        except BrowserError as exc:
            self.render_error(exc.status, exc.message)
        except Exception as exc:
            self.render_error(HTTPStatus.INTERNAL_SERVER_ERROR, str(exc))

    def do_HEAD(self) -> None:
        try:
            parsed = urlparse(self.path)
            if parsed.path == "/":
                self.render_index(parsed.query, head_only=True)
            elif parsed.path == "/file":
                self.serve_file(parsed.query, inline=True, head_only=True)
            elif parsed.path == "/download":
                self.serve_file(parsed.query, inline=False, head_only=True)
            elif parsed.path.startswith(ASSET_ROUTE_PREFIX):
                self.serve_asset(parsed.path, head_only=True)
            else:
                raise BrowserError(HTTPStatus.NOT_FOUND, "Not found.")
        except BrowserError as exc:
            self.render_error(exc.status, exc.message, head_only=True)
        except Exception as exc:
            self.render_error(HTTPStatus.INTERNAL_SERVER_ERROR, str(exc), head_only=True)

    def do_POST(self) -> None:
        try:
            parsed = urlparse(self.path)
            if parsed.path == "/sync":
                self.handle_sync()
            elif parsed.path == "/sync-batch-plan":
                self.handle_sync_batch_plan()
            elif parsed.path == "/sync-batch":
                self.handle_sync_batch()
            elif parsed.path == "/refresh-cache":
                self.handle_refresh_cache()
            else:
                raise BrowserError(HTTPStatus.NOT_FOUND, "Not found.")
        except BrowserError as exc:
            self.render_error(exc.status, exc.message)
        except Exception as exc:
            self.render_error(HTTPStatus.INTERNAL_SERVER_ERROR, str(exc))

    def render_index(self, query: str, head_only: bool = False) -> None:
        render_started = time.perf_counter()
        params = parse_qs(query, keep_blank_values=True)
        rel_path = clean_rel_path(params.get("path", [""])[0])
        sort_key = params.get("sort", ["name"])[0]
        direction = params.get("dir", ["asc"])[0]
        if sort_key not in {"name", "type", "date", "size", "status"}:
            sort_key = "name"
        if direction not in {"asc", "desc"}:
            direction = "asc"
        force_refresh = params.get("refresh", [""])[0] == "1"

        cache = self.app.folder_cache
        page_time = time.time()
        current_remote = remote_target(self.app.remote, rel_path)
        notify_started = time.perf_counter()
        if cache:
            cache.notify_page_load(page_time, page_key=rel_path, force=force_refresh)
            if force_refresh:
                cache.invalidate(current_remote)
        notify_elapsed_ms = round((time.perf_counter() - notify_started) * 1000, 3)

        list_started = time.perf_counter()
        entries = self.app.list_entries(rel_path, force_refresh=force_refresh)
        list_elapsed_ms = round((time.perf_counter() - list_started) * 1000, 3)

        current_cache_started = time.perf_counter()
        current_folder_cache: dict | None = None
        if cache and self.app.local_root:
            current_folder_cache = cache.get(current_remote)
            live_file_statuses = self.app.file_statuses_for_entries(entries)
            if current_folder_cache is None:
                current_folder_cache = {"file_statuses": live_file_statuses}
            else:
                current_folder_cache = dict(current_folder_cache)
                current_folder_cache["file_statuses"] = live_file_statuses
            if current_folder_cache is None or not current_folder_cache.get("complete"):
                cache.request(current_remote, page_time)
        current_cache_elapsed_ms = round((time.perf_counter() - current_cache_started) * 1000, 3)

        # Build folder cache map; stamp cached_size onto folder entries so
        # sort_entries can sort by size.  Trigger background fetch as needed.
        folder_map_started = time.perf_counter()
        folder_cache_map: dict = {}
        remote_folder_count = 0
        folder_cache_hits = 0
        folder_cache_requests = 0
        if cache:
            for entry in entries:
                if entry["is_dir"] and entry["remote"]:
                    remote_folder_count += 1
                    child = posixpath.join(rel_path, entry["name"]) if rel_path else entry["name"]
                    full_remote = remote_target(self.app.remote, child)
                    if force_refresh:
                        cache.invalidate(full_remote)
                    cached_data = cache.get(full_remote)
                    if cached_data is not None:
                        folder_cache_hits += 1
                    folder_cache_map[entry["name"]] = cached_data
                    entry["cached_size"] = cached_data.get("size") if cached_data else None
                    entry["cached_mtime"] = cached_data.get("newest_mtime") if cached_data else None
                    if cached_data is None or not cached_data.get("complete"):
                        folder_cache_requests += 1
                        cache.request(full_remote, page_time)
        folder_map_elapsed_ms = round((time.perf_counter() - folder_map_started) * 1000, 3)

        status_started = time.perf_counter()
        for entry in entries:
            entry["status_label"] = self.app.status_label_for_entry(entry, folder_cache_map, current_folder_cache)
        status_elapsed_ms = round((time.perf_counter() - status_started) * 1000, 3)

        sort_started = time.perf_counter()
        entries = self.app.sort_entries(entries, sort_key, direction)
        sort_elapsed_ms = round((time.perf_counter() - sort_started) * 1000, 3)

        html_started = time.perf_counter()
        body = page_html(
            self.app,
            rel_path,
            entries,
            sort_key,
            direction,
            params.get("msg", [""])[0],
            folder_cache_map or None,
            current_folder_cache,
        )
        html_elapsed_ms = round((time.perf_counter() - html_started) * 1000, 3)
        workertrace.append(
            "navigation_render_complete",
            rel_path=rel_path,
            remote_path=current_remote,
            force_refresh=force_refresh,
            head_only=head_only,
            row_count=len(entries),
            remote_folder_count=remote_folder_count,
            folder_cache_hits=folder_cache_hits,
            folder_cache_requests=folder_cache_requests,
            notify_elapsed_ms=notify_elapsed_ms,
            list_elapsed_ms=list_elapsed_ms,
            current_cache_elapsed_ms=current_cache_elapsed_ms,
            folder_map_elapsed_ms=folder_map_elapsed_ms,
            status_elapsed_ms=status_elapsed_ms,
            sort_elapsed_ms=sort_elapsed_ms,
            html_elapsed_ms=html_elapsed_ms,
            total_elapsed_ms=round((time.perf_counter() - render_started) * 1000, 3),
        )
        self.send_html(
            HTTPStatus.OK,
            body,
            head_only=head_only,
        )

    def _remote_file_size(self, rel_path: str) -> int:
        parent = posixpath.dirname(rel_path)
        name = posixpath.basename(rel_path)
        for entry in self.app.list_entries(parent):
            if entry.get("name") == name and entry.get("remote") and not entry.get("is_dir"):
                size = entry.get("remote_size")
                if size is None:
                    break
                return int(size)
        raise BrowserError(HTTPStatus.NOT_FOUND, "Remote file not found.")

    def _send_file_headers(
        self,
        *,
        plan: StreamPlan,
        content_type: str,
        disposition: str,
        name: str,
    ) -> None:
        self.send_response(plan.status)
        for key, value in stream_headers(plan, content_type=content_type, disposition=disposition, filename=name):
            self.send_header(key, value)
        self.end_headers()

    def _send_unsatisfiable_range(self, file_size: int) -> None:
        self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
        for key, value in unsatisfiable_range_headers(file_size):
            self.send_header(key, value)
        self.end_headers()

    def serve_file(self, query: str, inline: bool, head_only: bool = False) -> None:
        params = parse_qs(query)
        rel_path = clean_rel_path(params.get("path", [""])[0])
        source = params.get("source", ["remote"])[0]
        name = Path(rel_path).name
        content_type = mimetypes.guess_type(name)[0] or "application/octet-stream"
        disposition = "inline" if inline else "attachment"

        if source == "local" and self.app.local_root:
            local_file = self.app.local_display_path(rel_path) or safe_join_local(self.app.local_root, rel_path)
            if not local_file.is_file():
                raise BrowserError(HTTPStatus.NOT_FOUND, "Local file not found.")
            file_size = local_file.stat().st_size
            try:
                plan = plan_stream(self.headers.get("Range"), file_size)
            except RangeNotSatisfiable:
                self._send_unsatisfiable_range(file_size)
                return
            self._send_file_headers(plan=plan, content_type=content_type, disposition=disposition, name=name)
            if head_only:
                return
            with local_file.open("rb") as handle:
                try:
                    copy_file_range(handle, self.wfile, plan)
                except Exception as exc:
                    if is_client_disconnect(exc):
                        return
                    raise
            return

        file_size = self._remote_file_size(rel_path)
        try:
            plan = plan_stream(self.headers.get("Range"), file_size)
        except RangeNotSatisfiable:
            self._send_unsatisfiable_range(file_size)
            return
        self._send_file_headers(plan=plan, content_type=content_type, disposition=disposition, name=name)
        if head_only:
            return

        proc = self.app.rclone.open_cat(
            remote_target(self.app.remote, rel_path),
            offset=plan.start if plan.is_partial else None,
            count=plan.length if plan.is_partial else None,
        )
        assert proc.stdout is not None
        stream_error: Exception | None = None
        wait_error: Exception | None = None
        try:
            copy_exact(proc.stdout, self.wfile, plan.length)
        except Exception as exc:
            stream_error = exc
            if is_client_disconnect(exc):
                if getattr(proc, "poll", lambda: None)() is None:
                    try:
                        proc.kill()
                    except OSError:
                        pass
                return
            raise
        finally:
            proc.stdout.close()
            try:
                proc.wait(timeout=30)
            except Exception as exc:
                wait_error = exc
            finally:
                self.app.rclone.finish_cat(proc, stream_error or wait_error)
            if wait_error is not None:
                raise wait_error

    def serve_logs(self, query: str) -> None:
        params = parse_qs(query)
        since = int(params.get("since", ["0"])[0])
        since_upd = int(params.get("since_upd", ["0"])[0])
        body = _json.dumps(logstore.entries_since(since, since_upd)).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def serve_sync_status(self, query: str) -> None:
        params = parse_qs(query)
        op_id = params.get("id", [""])[0]
        op = syncstate.get(op_id)
        if op is None:
            raise BrowserError(HTTPStatus.NOT_FOUND, "Sync operation not found.")
        body = _json.dumps(op).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def serve_folder_info(self, query: str) -> None:
        params = parse_qs(query, keep_blank_values=True)

        def _folder_info_rel_path(raw: str) -> str:
            parts: list[str] = []
            for part in raw.split("/"):
                if not part or part == ".":
                    continue
                if part == "..":
                    raise BrowserError(HTTPStatus.BAD_REQUEST, "Parent path segments are not allowed.")
                parts.append(part)
            return "/".join(parts)

        rel_paths: list[str] = []
        seen_paths: set[str] = set()
        for rel_path_raw in params.get("paths", []):
            rel_path = _folder_info_rel_path(rel_path_raw)
            if rel_path not in seen_paths:
                rel_paths.append(rel_path)
                seen_paths.add(rel_path)
        current_rel_raw = params.get("current", [None])[0]
        current_rel = clean_rel_path(current_rel_raw) if current_rel_raw is not None else None
        if current_rel is not None and current_rel not in seen_paths:
            rel_paths.append(current_rel)
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
                file_statuses = data.get("file_statuses", {})
                if rel_path == current_rel and self.app.local_root:
                    file_statuses = self.app.file_statuses_for_entries(self.app.list_entries(rel_path))
                results[rel_path] = {
                    "status": st,
                    "complete": data.get("complete", st == "complete"),
                    "diff_status": data.get("diff_status"),
                    "diff_complete": data.get("diff_complete", False),
                    "first_diff_path": data.get("first_diff_path"),
                    "file_statuses": file_statuses,
                    "size_display": human_size(sz) if sz is not None else "—",
                    "count_display": f"{fc:,} files" if fc is not None else "",
                    "date_display": display_date(data.get("newest_mtime")),
                    "date_sort_value": data.get("newest_mtime") or 0,
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

    def serve_music_endpoint(self, path: str, query: str) -> None:
        status, payload = handle_music_get(self.app, path, query)
        body = _json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def serve_asset(self, request_path: str, head_only: bool = False) -> None:
        rel = unquote(request_path.removeprefix(ASSET_ROUTE_PREFIX))
        if "\\" in rel:
            raise BrowserError(HTTPStatus.NOT_FOUND, "Not found.")
        parts = Path(rel).parts
        if not parts or any(part in {"", ".", ".."} for part in parts):
            raise BrowserError(HTTPStatus.NOT_FOUND, "Not found.")
        if parts == ("app.css",) or (len(parts) == 2 and parts[0] == "css" and parts[1].endswith(".css")):
            content_type = "text/css; charset=utf-8"
        elif len(parts) == 2 and parts[0] == "js" and parts[1].endswith(".js"):
            content_type = "application/javascript; charset=utf-8"
        elif (
            len(parts) == 3
            and parts[0] == "icons"
            and parts[1] == "material-icon-theme"
            and parts[2].endswith(".svg")
        ):
            content_type = "image/svg+xml; charset=utf-8"
        else:
            raise BrowserError(HTTPStatus.NOT_FOUND, "Not found.")

        path = ASSET_DIR.joinpath(*parts)
        try:
            path.resolve().relative_to(ASSET_DIR.resolve())
        except ValueError:
            raise BrowserError(HTTPStatus.NOT_FOUND, "Not found.")
        if not path.is_file():
            raise BrowserError(HTTPStatus.NOT_FOUND, "Not found.")
        body = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "public, max-age=86400")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if head_only:
            return
        self.wfile.write(body)

    def handle_sync(self) -> None:
        length = int(self.headers.get("Content-Length") or "0")
        params = parse_qs(self.rfile.read(length).decode("utf-8") if length > 0 else "", keep_blank_values=True)
        rel_path = clean_rel_path(params.get("path", [""])[0])
        direction = params.get("direction", [""])[0]
        kind = params.get("kind", [""])[0]
        if kind != "file":
            raise BrowserError(HTTPStatus.BAD_REQUEST, "Sync is only supported for files.")
        if direction == "local_to_dropbox":
            if params.get("enable_write_dropbox", [""])[0] != "1":
                raise BrowserError(HTTPStatus.FORBIDDEN, "Enable write to Dropbox before starting a copy.")
        elif direction == "dropbox_to_local":
            if params.get("enable_to_local", [""])[0] != "1":
                raise BrowserError(HTTPStatus.FORBIDDEN, "Enable to local before starting a copy.")
        else:
            raise BrowserError(HTTPStatus.BAD_REQUEST, "Unsupported sync direction.")
        label = f"{direction.replace('_', ' ')}: {rel_path or '/'}"
        op_id = self.sync_jobs.submit(
            label,
            [self.app.single_sync_operation(rel_path, direction)],
            batch=False,
            success_message="Sync complete",
        )
        body = _json.dumps({"id": op_id}).encode("utf-8")
        self.send_response(HTTPStatus.ACCEPTED)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_form(self) -> dict[str, list[str]]:
        length = int(self.headers.get("Content-Length") or "0")
        return parse_qs(self.rfile.read(length).decode("utf-8") if length > 0 else "", keep_blank_values=True)

    def _validate_batch_gate(self, action: str, params: dict[str, list[str]]) -> None:
        if action == "local_to_dropbox_all":
            if params.get("enable_write_dropbox", [""])[0] != "1":
                raise BrowserError(HTTPStatus.FORBIDDEN, "Enable sync to Dropbox before starting a batch copy.")
        elif action in {"delete_local_only_all", "dropbox_only_to_local_all"}:
            if params.get("enable_to_local", [""])[0] != "1":
                raise BrowserError(HTTPStatus.FORBIDDEN, "Enable sync to local before starting a batch copy.")
        else:
            raise BrowserError(HTTPStatus.BAD_REQUEST, "Unsupported batch sync action.")

    def handle_sync_batch_plan(self) -> None:
        params = self._read_form()
        rel_path = clean_rel_path(params.get("path", [""])[0])
        action = params.get("action", [""])[0]
        recursive = params.get("recursive", [""])[0] == "1"
        self._validate_batch_gate(action, params)
        op_id = self.app.start_batch_plan(rel_path, action, recursive)
        body = _json.dumps({"id": op_id}).encode("utf-8")
        self.send_response(HTTPStatus.ACCEPTED)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_sync_batch(self) -> None:
        params = self._read_form()
        rel_path = clean_rel_path(params.get("path", [""])[0])
        action = params.get("action", [""])[0]
        recursive = params.get("recursive", [""])[0] == "1"
        plan_token = params.get("plan_token", [""])[0]
        self._validate_batch_gate(action, params)
        if not plan_token:
            raise BrowserError(HTTPStatus.BAD_REQUEST, "Batch plan token is required.")
        plan = self.app.consume_batch_plan(plan_token, rel_path, action, recursive)
        label = f"{action.replace('_', ' ')}: {rel_path or '/'}"
        op_id = self.sync_jobs.submit(
            label,
            self.app.batch_sync_operations(plan),
            batch=True,
            success_message="Batch sync complete",
        )
        body = _json.dumps({"id": op_id, "total": plan["total"]}).encode("utf-8")
        self.send_response(HTTPStatus.ACCEPTED)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_refresh_cache(self) -> None:
        params = self._read_form()
        rel_path = clean_rel_path(params.get("path", [""])[0])
        recursive = params.get("recursive", [""])[0] == "1"
        full_remote = remote_target(self.app.remote, rel_path)
        invalidated: list[str] = []
        if self.app.listing_cache:
            if recursive and hasattr(self.app.listing_cache, "invalidate_tree"):
                invalidated.extend(self.app.listing_cache.invalidate_tree(full_remote))
            else:
                self.app.listing_cache.invalidate(full_remote)
                invalidated.append(full_remote)
        cache = self.app.folder_cache
        page_time = time.time()
        if cache:
            cache.notify_page_load(page_time, page_key=rel_path, force=True)
            if recursive and hasattr(cache, "invalidate_tree"):
                invalidated.extend(cache.invalidate_tree(full_remote))
            else:
                cache.invalidate(full_remote)
                invalidated.append(full_remote)
            cache.request(full_remote, page_time)
        body = _json.dumps({
            "status": "refreshing",
            "path": rel_path,
            "recursive": recursive,
            "invalidated": sorted(set(invalidated), key=str.casefold),
        }).encode("utf-8")
        self.send_response(HTTPStatus.ACCEPTED)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_html(self, status: HTTPStatus, body: str, head_only: bool = False) -> None:
        encoded = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if head_only:
            return
        try:
            self.wfile.write(encoded)
        except (ConnectionAbortedError, BrokenPipeError):
            pass  # client navigated away; response not needed

    def render_error(self, status: HTTPStatus, message: str, head_only: bool = False) -> None:
        try:
            self.send_html(status, error_html(status, message), head_only=head_only)
        except (ConnectionAbortedError, BrokenPipeError):
            pass

    def log_error(self, fmt: str, *args: object) -> None:  # type: ignore[override]
        """Suppress connection-abort tracebacks; log other errors normally."""
        msg = fmt % args
        if "ConnectionAbortedError" in msg or "BrokenPipeError" in msg or "10053" in msg:
            logoutput.log_plain(time.strftime("%H:%M:%S"), "client disconnected before response sent")
            return
        super().log_error(fmt, *args)  # type: ignore[misc]

    def log_request(self, code: int | str = "-", size: int | str = "-") -> None:
        # Don't log polling endpoints to avoid noise.
        if self.path.startswith("/logs") or self.path.startswith("/folder-info") or self.path.startswith("/sync-status"):
            return
        super().log_request(code, size)

    def log_message(self, fmt: str, *args: object) -> None:
        msg = fmt % args
        ts = time.strftime("%H:%M:%S")
        logstore.append("request", msg)
        if getattr(self.server, "log_requests", True):
            logoutput.log_plain(ts, msg)
