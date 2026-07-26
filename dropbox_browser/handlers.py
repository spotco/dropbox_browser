from __future__ import annotations

import json as _json
import ipaddress
import mimetypes
from pathlib import Path
import posixpath
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, quote, unquote, urlencode, urlparse

from . import logoutput, logstore, syncstate, workertrace
from .clientlog import append_client_log
from .errors import BrowserError
from .formatting import display_date, file_type, human_size, status_class
from .music import MUSIC_ENDPOINT_PREFIX, handle_music_get
from .namekeys import filename_compare_key
from .photo_map_cache import normalize_cache_path
from .paths import clean_rel_path, remote_target, safe_join_local
from .services import DropboxBrowser, diff_label
from .streaming import (
    RangeNotSatisfiable,
    StreamPlan,
    copy_exact,
    copy_exact_with_throttle,
    copy_file_range,
    is_client_disconnect,
    plan_stream,
    StreamCopyCancelled,
    StreamCopyStats,
    stream_headers,
    unsatisfiable_range_headers,
)
from .syncjobs import SyncJobManager
from .thumbnails import ThumbnailResult, is_thumbnailable_image, thumbnail_source_for_row
from .video_thumbnails import VideoThumbnailResult, is_video_thumbnailable, video_thumbnail_source_for_row
from .video import (
    HLS_INIT_SEGMENT_NAME,
    VIDEO_ENDPOINT_PREFIX,
    clear_video_disk_caches,
    extract_all_remote_subtitles_to_webvtt,
    extract_remote_subtitle_window_to_webvtt,
    extract_remote_subtitles_to_webvtt,
    handle_video_get,
    parse_playback_sync_token,
    parse_optional_video_playback_seconds,
    parse_subtitle_window_duration_seconds,
    parse_video_playback_seconds,
    parse_video_playback_state,
    parse_video_start_seconds,
    parse_video_transition_token,
    probe_remote_media,
    log_video_debug,
    video_session_manager,
)
from .views import (
    PHOTO_MAP_VENDOR_ASSETS,
    dropbox_home_url,
    error_html,
    folder_page_title,
    icon_for_entry,
    page_html,
    preview_html,
)


ASSET_DIR = Path(__file__).resolve().parent / "assets"
ASSET_ROUTE_PREFIX = "/assets/"
PHOTO_MAP_ENDPOINT_PREFIX = "/photo-map/endpoints/"
TAGGED_INPUT_COPY_BUFFER_SIZE = 2 * 1024 * 1024
PHOTO_MAP_MAX_JSON_BODY_BYTES = 2 * 1024 * 1024


class _FirstByteTimingReader:
    def __init__(self, handle, *, started_at: float) -> None:
        self._handle = handle
        self._started_at = float(started_at)
        self.first_byte_elapsed_ms: float | None = None
        self.bytes_read = 0

    def read(self, size: int = -1):
        chunk = self._handle.read(size)
        if chunk:
            self.bytes_read += len(chunk)
            if self.first_byte_elapsed_ms is None:
                self.first_byte_elapsed_ms = round((time.monotonic() - self._started_at) * 1000, 3)
        return chunk

    def close(self) -> None:
        self._handle.close()


class RequestHandler(BaseHTTPRequestHandler):
    server_version = "DropboxBrowser/0.1"

    def _send_no_store_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")

    def _send_json_error(self, status: HTTPStatus, message: str, details: dict[str, object] | None = None) -> None:
        payload: dict[str, object] = {
            "status": "error",
            "message": message,
        }
        if details:
            payload.update(details)
        body = _json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self._send_no_store_headers()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    @property
    def app(self) -> DropboxBrowser:
        return self.server.app  # type: ignore[attr-defined]

    @property
    def sync_jobs(self) -> SyncJobManager:
        if self.app.sync_jobs is None:
            self.app.sync_jobs = SyncJobManager(self.app, workers=1)
        return self.app.sync_jobs

    @property
    def localhost_only_access(self) -> bool:
        return bool(getattr(self.server, "localhost_only_access", True))

    def _client_is_loopback(self) -> bool:
        host = str((self.client_address or ("", 0))[0]).strip()
        if not host:
            return False
        if host == "localhost":
            return True
        normalized = host.split("%", 1)[0]
        try:
            return ipaddress.ip_address(normalized).is_loopback
        except ValueError:
            if normalized.startswith("::ffff:"):
                try:
                    return ipaddress.ip_address(normalized.split(":", 3)[-1]).is_loopback
                except ValueError:
                    return False
            return False

    def _enforce_localhost_only_access(self) -> None:
        if not self.localhost_only_access:
            return
        if self._client_is_loopback():
            return
        raise BrowserError(HTTPStatus.FORBIDDEN, "Only localhost clients may access this server.")

    def do_GET(self) -> None:
        try:
            self._enforce_localhost_only_access()
            parsed = urlparse(self.path)
            if parsed.path == "/":
                self.render_index(parsed.query)
            elif parsed.path == "/preview":
                self.render_preview(parsed.query)
            elif parsed.path == "/browse/endpoints/listing":
                self.serve_browse_listing_endpoint(parsed.query)
            elif parsed.path == "/browse/endpoints/search":
                self.serve_browse_search_endpoint(parsed.query)
            elif parsed.path == "/file":
                self.serve_file(parsed.query, inline=True)
            elif parsed.path == "/download":
                self.serve_file(parsed.query, inline=False)
            elif parsed.path == "/thumbnail":
                self.serve_thumbnail(parsed.query)
            elif parsed.path == "/logs":
                self.serve_logs(parsed.query)
            elif parsed.path == "/sync-status":
                self.serve_sync_status(parsed.query)
            elif parsed.path == "/folder-info":
                self.serve_folder_info(parsed.query)
            elif parsed.path.startswith(PHOTO_MAP_ENDPOINT_PREFIX):
                self.serve_photo_map_endpoint(parsed.path, parsed.query)
            elif parsed.path.startswith(MUSIC_ENDPOINT_PREFIX):
                self.serve_music_endpoint(parsed.path, parsed.query)
            elif parsed.path.startswith(VIDEO_ENDPOINT_PREFIX):
                self.serve_video_endpoint(parsed.path, parsed.query)
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
            self._enforce_localhost_only_access()
            parsed = urlparse(self.path)
            if parsed.path == "/":
                self.render_index(parsed.query, head_only=True)
            elif parsed.path == "/preview":
                self.render_preview(parsed.query, head_only=True)
            elif parsed.path == "/file":
                self.serve_file(parsed.query, inline=True, head_only=True)
            elif parsed.path == "/download":
                self.serve_file(parsed.query, inline=False, head_only=True)
            elif parsed.path == "/thumbnail":
                self.serve_thumbnail(parsed.query, head_only=True)
            elif parsed.path == VIDEO_ENDPOINT_PREFIX + "thumbnail":
                self.serve_video_thumbnail(parsed.query, head_only=True)
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
            self._enforce_localhost_only_access()
            parsed = urlparse(self.path)
            if parsed.path == "/sync":
                self.handle_sync()
            elif parsed.path == "/sync-batch-plan":
                self.handle_sync_batch_plan()
            elif parsed.path == "/sync-batch":
                self.handle_sync_batch()
            elif parsed.path == "/local-only-delete-bat":
                self.handle_local_only_delete_bat()
            elif parsed.path == "/refresh-cache":
                self.handle_refresh_cache()
            elif parsed.path == "/client-log":
                self.handle_client_log()
            elif parsed.path.startswith(PHOTO_MAP_ENDPOINT_PREFIX):
                self.handle_photo_map_endpoint(parsed.path)
            elif parsed.path.startswith(VIDEO_ENDPOINT_PREFIX):
                self.serve_video_endpoint_post(parsed.path)
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
        force_refresh = params.get("refresh", [""])[0] == "1"
        page_time = time.time()
        snapshot = self.app.build_browse_snapshot(
            rel_path,
            sort_key,
            direction,
            force_refresh=force_refresh,
            page_time=page_time,
            queue_current_folder_metadata=True,
            load_child_folder_metadata=True,
        )

        html_started = time.perf_counter()
        body = page_html(
            self.app,
            snapshot.rel_path,
            snapshot.entries,
            snapshot.sort_key,
            snapshot.direction,
            params.get("msg", [""])[0],
            snapshot.folder_cache_map or None,
            snapshot.current_folder_cache,
        )
        html_elapsed_ms = round((time.perf_counter() - html_started) * 1000, 3)
        total_elapsed_ms = round((time.perf_counter() - render_started) * 1000, 3)
        if total_elapsed_ms >= workertrace.SLOW_OPERATION_THRESHOLD_MS:
            workertrace.record_diagnostic(
                "slow_render_index",
                rel_path=snapshot.rel_path,
                remote_path=snapshot.remote_path,
                force_refresh=snapshot.force_refresh,
                head_only=head_only,
                listing_source=snapshot.listing_source,
                row_count=len(snapshot.entries),
                timings_ms=dict(snapshot.timings_ms),
                html_elapsed_ms=html_elapsed_ms,
                total_elapsed_ms=total_elapsed_ms,
            )
        workertrace.append(
            "navigation_render_complete",
            rel_path=snapshot.rel_path,
            remote_path=snapshot.remote_path,
            force_refresh=snapshot.force_refresh,
            head_only=head_only,
            row_count=len(snapshot.entries),
            remote_folder_count=snapshot.remote_folder_count,
            folder_cache_hits=snapshot.folder_cache_hits,
            folder_cache_missing=snapshot.folder_cache_missing,
            folder_cache_requests=snapshot.folder_cache_requests,
            child_metadata_cached_hits=snapshot.folder_cache_hits,
            child_metadata_missing_count=snapshot.folder_cache_missing,
            child_metadata_requests_queued=snapshot.folder_cache_requests,
            child_metadata_requests_deferred=snapshot.folder_cache_missing,
            listing_source=snapshot.listing_source,
            notify_elapsed_ms=snapshot.timings_ms["notify"],
            list_elapsed_ms=snapshot.timings_ms["list"],
            current_cache_elapsed_ms=snapshot.timings_ms["current_cache"],
            folder_map_elapsed_ms=snapshot.timings_ms["folder_map"],
            status_elapsed_ms=snapshot.timings_ms["status"],
            sort_elapsed_ms=snapshot.timings_ms["sort"],
            html_elapsed_ms=html_elapsed_ms,
            total_elapsed_ms=total_elapsed_ms,
        )
        self.send_html(
            HTTPStatus.OK,
            body,
            head_only=head_only,
        )

    def render_preview(self, query: str, head_only: bool = False) -> None:
        params = parse_qs(query, keep_blank_values=True)
        rel_path = clean_rel_path(params.get("path", [""])[0])
        source = params.get("source", ["remote"])[0]
        if source != "remote":
            raise BrowserError(HTTPStatus.BAD_REQUEST, "Only remote video previews are supported.")
        if not rel_path:
            raise BrowserError(HTTPStatus.NOT_FOUND, "Media preview is not available for this file type.")
        media_kind = "video" if is_video_thumbnailable(rel_path, False) else "photo" if is_thumbnailable_image(rel_path, False) else None
        if media_kind is None:
            raise BrowserError(HTTPStatus.NOT_FOUND, "Media preview is not available for this file type.")
        self.send_html(
            HTTPStatus.OK,
            preview_html(rel_path=rel_path, source=source, media_kind=media_kind),
            head_only=head_only,
        )

    def _resolve_remote_file(self, rel_path: str) -> tuple[str, int]:
        remote_path = remote_target(self.app.remote, rel_path)
        try:
            item = self.app.rclone.stat(remote_path)
        except BrowserError as exc:
            if exc.status != HTTPStatus.BAD_GATEWAY:
                raise
        else:
            if not item.get("IsDir"):
                size = item.get("Size")
                if size is not None:
                    return rel_path, int(size)

        parent = posixpath.dirname(rel_path)
        name = posixpath.basename(rel_path)
        normalized_name = filename_compare_key(name)
        normalized_match: dict | None = None
        for entry in self.app.list_entries(parent):
            if not entry.get("remote") or entry.get("is_dir"):
                continue
            entry_name = entry.get("name")
            if entry_name == name:
                size = entry.get("remote_size")
                if size is None:
                    break
                return (posixpath.join(parent, entry_name) if parent else entry_name, int(size))
            if (
                normalized_match is None
                and isinstance(entry_name, str)
                and filename_compare_key(entry_name) == normalized_name
            ):
                normalized_match = entry
        if normalized_match is not None:
            size = normalized_match.get("remote_size")
            entry_name = normalized_match.get("name")
            if isinstance(entry_name, str) and size is not None:
                return (posixpath.join(parent, entry_name) if parent else entry_name, int(size))
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
        self._send_no_store_headers()
        self.end_headers()

    def _send_unsatisfiable_range(self, file_size: int) -> None:
        self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
        for key, value in unsatisfiable_range_headers(file_size):
            self.send_header(key, value)
        self._send_no_store_headers()
        self.end_headers()

    def serve_file(self, query: str, inline: bool, head_only: bool = False) -> None:
        params = parse_qs(query)
        rel_path = clean_rel_path(params.get("path", [""])[0])
        source = params.get("source", ["remote"])[0]
        video_session_id = params.get("video_session_id", [""])[0].strip() or None
        tagged_request = source != "local" and video_session_id is not None
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

        range_header = self.headers.get("Range")
        request_started = time.monotonic()
        remote_resolution_started = request_started
        remote_rel_path = rel_path
        remote_resolution_ms: float | None = None
        validation_result = "untagged"
        tagged_input_metadata = None
        tagged_video_session_manager = video_session_manager(self.app)
        if tagged_request:
            log_video_debug(
                self.app,
                "tagged_input_http_request",
                session_id=video_session_id,
                requested_rel_path=rel_path,
                range_header=("" if range_header is None else range_header),
                head_only=head_only,
            )
            tagged_input_metadata, validation_result = tagged_video_session_manager.tagged_input_file_metadata(
                video_session_id,
                rel_path,
            )
        if tagged_input_metadata is not None:
            remote_rel_path = tagged_input_metadata.rel_path
            file_size = tagged_input_metadata.file_size
            remote_resolution_ms = 0.0
        else:
            remote_rel_path, file_size = self._resolve_remote_file(rel_path)
            if tagged_request:
                remote_resolution_ms = round((time.monotonic() - remote_resolution_started) * 1000, 3)
        try:
            plan = plan_stream(range_header, file_size)
        except RangeNotSatisfiable:
            if tagged_request:
                log_video_debug(
                    self.app,
                    "tagged_input_http_complete",
                    session_id=video_session_id,
                    requested_rel_path=rel_path,
                    rel_path=remote_rel_path,
                    range_header=("" if range_header is None else range_header),
                    validation_result=validation_result,
                    remote_resolution_ms=remote_resolution_ms,
                    selected_start=None,
                    selected_count=None,
                    file_size=file_size,
                    rclone_command_form="not_opened",
                    open_cat_to_first_byte_ms=None,
                    bytes_copied=0,
                    stream_duration_ms=0.0,
                    outcome="range_not_satisfiable",
                )
            self._send_unsatisfiable_range(file_size)
            return
        self._send_file_headers(plan=plan, content_type=content_type, disposition=disposition, name=name)
        if head_only:
            if tagged_request:
                log_video_debug(
                    self.app,
                    "tagged_input_http_complete",
                    session_id=video_session_id,
                    requested_rel_path=rel_path,
                    rel_path=remote_rel_path,
                    range_header=("" if range_header is None else range_header),
                    validation_result=validation_result,
                    remote_resolution_ms=remote_resolution_ms,
                    selected_start=plan.start,
                    selected_count=plan.length,
                    file_size=file_size,
                    rclone_command_form=("cat_offset_count" if plan.is_partial else "cat_full"),
                    open_cat_to_first_byte_ms=None,
                    bytes_copied=0,
                    stream_duration_ms=0.0,
                    outcome="head_only",
                )
            return

        open_cat_started = time.monotonic()
        proc = self.app.rclone.open_cat(
            remote_target(self.app.remote, remote_rel_path),
            offset=plan.start if plan.is_partial else None,
            count=plan.length if plan.is_partial else None,
        )
        open_cat_duration_ms = round((time.monotonic() - open_cat_started) * 1000, 3)
        assert proc.stdout is not None
        timed_stdout = _FirstByteTimingReader(proc.stdout, started_at=open_cat_started)
        stream_error: Exception | None = None
        wait_error: Exception | None = None
        stream_stats: StreamCopyStats | None = None
        outcome = "completed"
        try:
            if video_session_id is None:
                copy_exact(timed_stdout, self.wfile, plan.length)
            else:
                stream_stats = copy_exact_with_throttle(
                    timed_stdout,
                    self.wfile,
                    plan.length,
                    decision_fn=lambda: tagged_video_session_manager.tagged_input_throttle_decision(
                        video_session_id,
                        remote_rel_path,
                    ),
                    buffer_size=TAGGED_INPUT_COPY_BUFFER_SIZE,
                )
        except Exception as exc:
            stream_error = exc
            if isinstance(exc, StreamCopyCancelled):
                outcome = "stream_cancelled"
                log_video_debug(
                    self.app,
                    "tagged_input_stream_cancelled",
                    session_id=video_session_id,
                    rel_path=remote_rel_path,
                    throttle_mode=exc.decision.throttle_mode,
                    ahead_seconds=exc.decision.ahead_seconds,
                    sleep_seconds=float(exc.decision.sleep_seconds or 0.0),
                )
                if getattr(proc, "poll", lambda: None)() is None:
                    try:
                        proc.kill()
                    except OSError:
                        pass
                return
            if is_client_disconnect(exc):
                outcome = "client_disconnect"
                if getattr(proc, "poll", lambda: None)() is None:
                    try:
                        proc.kill()
                    except OSError:
                        pass
                return
            outcome = "stream_error"
            raise
        finally:
            timed_stdout.close()
            try:
                proc.wait(timeout=30)
            except Exception as exc:
                wait_error = exc
                outcome = "wait_error"
            finally:
                self.app.rclone.finish_cat(proc, stream_error or wait_error)
            if tagged_request:
                bytes_copied = (
                    stream_stats.bytes_copied
                    if stream_stats is not None
                    else timed_stdout.bytes_read
                )
                log_video_debug(
                    self.app,
                    "tagged_input_http_complete",
                    session_id=video_session_id,
                    requested_rel_path=rel_path,
                    rel_path=remote_rel_path,
                    range_header=("" if range_header is None else range_header),
                    validation_result=validation_result,
                    remote_resolution_ms=remote_resolution_ms,
                    selected_start=plan.start,
                    selected_count=plan.length,
                    file_size=file_size,
                    rclone_command_form=("cat_offset_count" if plan.is_partial else "cat_full"),
                    open_cat_duration_ms=open_cat_duration_ms,
                    open_cat_to_first_byte_ms=timed_stdout.first_byte_elapsed_ms,
                    bytes_copied=bytes_copied,
                    stream_duration_ms=round((time.monotonic() - request_started) * 1000, 3),
                    outcome=outcome,
                )
            if wait_error is not None:
                raise wait_error
        if video_session_id is not None and stream_stats is not None:
            log_video_debug(
                self.app,
                "tagged_input_stream_complete",
                session_id=video_session_id,
                rel_path=remote_rel_path,
                bytes_copied=stream_stats.bytes_copied,
                sleep_seconds_total=stream_stats.sleep_seconds_total,
                decision_samples=stream_stats.decision_samples,
                throttle_mode=stream_stats.last_throttle_mode,
                ahead_seconds=stream_stats.last_ahead_seconds,
            )

    def serve_thumbnail(self, query: str, head_only: bool = False) -> None:
        params = parse_qs(query, keep_blank_values=True)
        rel_path = clean_rel_path(params.get("path", [""])[0])
        source = params.get("source", ["remote"])[0]
        service = self.app.thumbnail_service
        if service is None:
            raise BrowserError(HTTPStatus.NOT_FOUND, "Thumbnail service is unavailable.")
        descriptor = service.descriptor_for_path(rel_path, source)
        result = service.ensure_thumbnail(descriptor)
        self._send_thumbnail_result(result, head_only=head_only)

    def _send_thumbnail_result(self, result: ThumbnailResult, *, head_only: bool = False) -> None:
        if result.ok:
            assert result.path is not None
            body_size = result.path.stat().st_size
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "image/png")
            self._send_no_store_headers()
            self.send_header("Content-Length", str(body_size))
            self.end_headers()
            if head_only:
                return
            self.wfile.write(result.path.read_bytes())
            return
        if result.status == "unsupported":
            raise BrowserError(HTTPStatus.NOT_FOUND, "Thumbnail is not available for this file type.")
        if result.status in {"disabled", "failed", "timeout", "oversized"}:
            raise BrowserError(HTTPStatus.NOT_FOUND, result.error_message or "Thumbnail is unavailable.")
        raise BrowserError(HTTPStatus.NOT_FOUND, "Thumbnail was not found.")

    def serve_video_thumbnail(self, query: str, head_only: bool = False) -> None:
        params = parse_qs(query, keep_blank_values=True)
        rel_path = clean_rel_path(params.get("path", [""])[0])
        source = params.get("source", ["remote"])[0]
        service = self.app.video_thumbnail_service
        if service is None:
            raise BrowserError(HTTPStatus.NOT_FOUND, "Video thumbnail service is unavailable.")
        descriptor = service.descriptor_for_path(rel_path, source)
        input_url = None
        if source == "remote":
            port = int(self.server.server_address[1])  # type: ignore[attr-defined]
            input_url = f"http://127.0.0.1:{port}/file?" + urlencode({
                "path": rel_path,
                "source": "remote",
            })
        result = service.ensure_thumbnail(descriptor, remote_input_url=input_url)
        self._send_video_thumbnail_result(result, head_only=head_only)

    def _send_video_thumbnail_result(self, result: VideoThumbnailResult, *, head_only: bool = False) -> None:
        if result.ok:
            assert result.path is not None
            body_size = result.path.stat().st_size
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "image/jpeg")
            self._send_no_store_headers()
            self.send_header("Content-Length", str(body_size))
            self.end_headers()
            if not head_only:
                self.wfile.write(result.path.read_bytes())
            return
        if result.status == "unsupported":
            raise BrowserError(HTTPStatus.NOT_FOUND, "Video thumbnail is not available for this file type.")
        raise BrowserError(HTTPStatus.NOT_FOUND, result.error_message or "Video thumbnail is unavailable.")

    def serve_logs(self, query: str) -> None:
        params = parse_qs(query)
        since = int(params.get("since", ["0"])[0])
        since_upd = int(params.get("since_upd", ["0"])[0])
        body = _json.dumps(logstore.entries_since(since, since_upd)).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self._send_no_store_headers()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _browse_breadcrumb_items(self, rel_path: str) -> list[dict[str, str]]:
        items = [{"name": "Dropbox", "path": "", "href": "/"}]
        current = ""
        for part in rel_path.split("/"):
            if not part:
                continue
            current = posixpath.join(current, part) if current else part
            items.append({
                "name": part,
                "path": current,
                "href": "/?" + urlencode({"path": current}),
            })
        return items

    def _serialize_browse_row(
        self,
        rel_path: str,
        row: dict[str, object],
        *,
        current_folder_cache: dict[str, object] | None,
        folder_cache_map: dict[str, object] | None,
    ) -> dict[str, object]:
        name = str(row["name"])
        child_path = posixpath.join(rel_path, name) if rel_path else name
        is_dir = bool(row["is_dir"])
        status = str(row.get("status_label") or ("Both" if row["remote"] and row["local"] else "Dropbox Only" if row["remote"] else "Local Only"))
        type_label = file_type(name, is_dir)
        icon_name = icon_for_entry(name, is_dir)
        current_file_statuses = ((current_folder_cache or {}).get("file_statuses") or {}) if self.app.local_root else {}
        source = "remote" if row["remote"] else "local"
        preview_query = urlencode({"path": child_path, "source": source})
        original_file_href = None if is_dir else "/file?" + preview_query
        download_href = None if is_dir else "/download?" + preview_query
        folder_href = "/?" + urlencode({"path": child_path}) if is_dir else None
        thumbnailable = is_thumbnailable_image(name, is_dir)
        video_thumbnailable = is_video_thumbnailable(name, is_dir)
        preview_href = (
            "/preview?" + preview_query
            if not is_dir and video_thumbnailable and source == "remote"
            else original_file_href
        )
        local_copy_path = None
        if self.app.local_root and row.get("local"):
            local_copy_path = row.get("local_path") or str(self.app.local_display_path(child_path) or safe_join_local(self.app.local_root, child_path))

        if is_dir:
            cached_folder = (folder_cache_map or {}).get(name) if row.get("remote") else None
            count_display = ""
            if row.get("remote"):
                size_value = row.get("cached_size")
                date_value = row.get("cached_mtime")
                size_display = human_size(int(size_value)) if size_value is not None else "—"
                date_display = display_date(date_value if isinstance(date_value, (int, float)) else None)
                metadata_complete = False
                if isinstance(cached_folder, dict):
                    metadata_complete = bool(cached_folder.get("complete", False))
                    file_count = cached_folder.get("file_count")
                    if file_count is not None:
                        count_display = f"{int(file_count):,} files"
            else:
                size_value = None
                date_value = row.get("local_mtime")
                size_display = "—"
                date_display = display_date(date_value if isinstance(date_value, (int, float)) else None)
                metadata_complete = True
            sync_directions: list[str] = []
        else:
            size_value = row.get("remote_size") if row.get("remote_size") is not None else row.get("local_size")
            date_value = max(row.get("remote_mtime") or 0, row.get("local_mtime") or 0) or 0
            size_display = human_size(int(size_value or 0))
            date_display = display_date(float(date_value) if date_value else None)
            if self.app.local_root and row.get("remote") and row.get("local") and name in current_file_statuses:
                file_status = current_file_statuses.get(name, {})
                status = diff_label(file_status.get("diff_status"))
            sync_directions = []
            if self.app.local_root:
                if status == "Local Only":
                    sync_directions = ["local_to_dropbox"]
                elif status == "Dropbox Only":
                    sync_directions = ["dropbox_to_local"]
                elif status == "Has Diffs":
                    sync_directions = ["local_to_dropbox", "dropbox_to_local"]
            count_display = ""
            metadata_complete = True

        thumbnail_source = thumbnail_source_for_row(row, status_label=status) if thumbnailable else None
        thumbnail_href = None
        if thumbnail_source is not None:
            thumbnail_href = "/thumbnail?" + urlencode({"path": child_path, "source": thumbnail_source})
        video_thumbnail_source = video_thumbnail_source_for_row(row, status_label=status) if video_thumbnailable else None
        video_thumbnail_href = None
        if video_thumbnail_source is not None:
            video_thumbnail_href = "/video/endpoints/thumbnail?" + urlencode({
                "path": child_path,
                "source": video_thumbnail_source,
            })

        sort_date_value = (
            row.get("cached_mtime")
            if is_dir and row.get("cached_mtime") is not None
            else max(row.get("remote_mtime") or 0, row.get("local_mtime") or 0)
        ) or 0
        sort_size_value = (
            row.get("cached_size") or 0
            if is_dir
            else row.get("remote_size") or row.get("local_size") or 0
        )

        return {
            "id": f'{"folder" if is_dir else "file"}:{child_path}',
            "display_name": name,
            "path": child_path,
            "kind": "folder" if is_dir else "file",
            "is_dir": is_dir,
            "type_label": type_label,
            "icon_name": icon_name,
            "icon_href": "/assets/icons/material-icon-theme/" + quote(icon_name, safe=""),
            "thumbnailable": thumbnailable,
            "thumbnail_source": thumbnail_source,
            "thumbnail_href": thumbnail_href,
            "video_thumbnailable": video_thumbnailable,
            "video_thumbnail_source": video_thumbnail_source,
            "video_thumbnail_href": video_thumbnail_href,
            "media_kind": "video" if video_thumbnailable else "photo" if thumbnailable else None,
            "status_label": status,
            "status_class": status_class(status),
            "remote": bool(row["remote"]),
            "local": bool(row["local"]),
            "source": None if is_dir else source,
            "size_display": size_display,
            "count_display": count_display,
            "date_display": date_display,
            "metadata_complete": metadata_complete,
            "sort_name": filename_compare_key(name),
            "sort_type": type_label,
            "sort_status": status,
            "sort_size": int(sort_size_value),
            "sort_date": float(sort_date_value),
            "local_copy_path": local_copy_path,
            "preview_href": preview_href,
            "original_file_href": original_file_href,
            "download_href": download_href,
            "folder_href": folder_href,
            "sync": {
                "allowed": bool(self.app.local_root and not is_dir and bool(sync_directions)),
                "directions": sync_directions,
            },
        }

    def serve_browse_listing_endpoint(self, query: str) -> None:
        started = time.perf_counter()
        params = parse_qs(query, keep_blank_values=True)
        rel_path = clean_rel_path(params.get("path", [""])[0])
        sort_key = params.get("sort", ["name"])[0]
        direction = params.get("dir", ["asc"])[0]
        force_refresh = params.get("refresh", [""])[0] == "1"
        snapshot = self.app.build_browse_snapshot(
            rel_path,
            sort_key,
            direction,
            force_refresh=force_refresh,
            page_time=time.time(),
            queue_current_folder_metadata=True,
            load_child_folder_metadata=True,
        )
        current_local_folder = None
        local_note = "Local comparison disabled"
        local_root_prefix = None
        local_root_name = None
        if self.app.local_root:
            current_local_folder = str(self.app.local_display_path(snapshot.rel_path) or self.app.local_root)
            local_note = f"Comparing with {self.app.local_root}"
            parent = str(self.app.local_root.parent)
            local_root_name = self.app.local_root.name or str(self.app.local_root)
            if not parent or parent == ".":
                local_root_prefix = ""
            elif parent.endswith(("\\", "/")):
                local_root_prefix = parent
            else:
                local_root_prefix = parent + "\\"
        refresh_href = "/?" + urlencode({
            "path": snapshot.rel_path,
            "sort": snapshot.sort_key,
            "dir": snapshot.direction,
            "refresh": "1",
        })
        next_sort_direction = {
            key: ("desc" if snapshot.sort_key == key and snapshot.direction == "asc" else "asc")
            for key in ("name", "type", "status", "size", "date")
        }
        pending_metadata_paths = [
            posixpath.join(snapshot.rel_path, entry["name"]) if snapshot.rel_path else str(entry["name"])
            for entry in snapshot.entries
            if (
                bool(entry["is_dir"])
                and bool(entry["remote"])
                and (
                    snapshot.folder_cache_map.get(str(entry["name"])) is None
                    or not bool((snapshot.folder_cache_map.get(str(entry["name"])) or {}).get("complete"))
                )
            )
        ]
        payload = {
            "page": {
                "title": folder_page_title(self.app.remote, snapshot.rel_path),
                "remote": self.app.remote,
                "path": snapshot.rel_path,
                "local_note": local_note,
                "current_local_folder": current_local_folder,
                "local_root_prefix": local_root_prefix,
                "local_root_name": local_root_name,
                "dropbox_home_url": dropbox_home_url(snapshot.rel_path),
                "refresh_href": refresh_href,
            },
            "breadcrumbs": self._browse_breadcrumb_items(snapshot.rel_path),
            "rows": [
                self._serialize_browse_row(
                    snapshot.rel_path,
                    row,
                    current_folder_cache=snapshot.current_folder_cache,
                    folder_cache_map=snapshot.folder_cache_map,
                )
                for row in snapshot.entries
            ],
            "pending_metadata_paths": pending_metadata_paths,
            "current_folder_info": {
                "path": snapshot.rel_path,
                "poll_current_file_statuses": bool(self.app.local_root),
            },
            "sort": {
                "available": ["name", "type", "status", "size", "date"],
                "current_key": snapshot.sort_key,
                "current_direction": snapshot.direction,
                "next_direction": next_sort_direction,
            },
            "listing": {
                "source": snapshot.listing_source,
                "force_refresh": snapshot.force_refresh,
                "row_count": len(snapshot.entries),
                "remote_folder_count": snapshot.remote_folder_count,
            },
            "timings_ms": dict(snapshot.timings_ms),
        }
        json_elapsed_ms = round((time.perf_counter() - started) * 1000, 3)
        if json_elapsed_ms >= workertrace.SLOW_OPERATION_THRESHOLD_MS:
            workertrace.record_diagnostic(
                "slow_browse_listing_endpoint",
                rel_path=snapshot.rel_path,
                remote_path=snapshot.remote_path,
                force_refresh=snapshot.force_refresh,
                listing_source=snapshot.listing_source,
                row_count=len(snapshot.entries),
                remote_folder_count=snapshot.remote_folder_count,
                folder_cache_hits=snapshot.folder_cache_hits,
                folder_cache_missing=snapshot.folder_cache_missing,
                folder_cache_requests=snapshot.folder_cache_requests,
                client_render=bool(getattr(self.app, "client_render", False)),
                timings_ms=dict(snapshot.timings_ms),
                total_elapsed_ms=json_elapsed_ms,
            )
        workertrace.append(
            "browse_listing_endpoint",
            rel_path=snapshot.rel_path,
            remote_path=snapshot.remote_path,
            force_refresh=snapshot.force_refresh,
            listing_source=snapshot.listing_source,
            row_count=len(snapshot.entries),
            remote_folder_count=snapshot.remote_folder_count,
            folder_cache_hits=snapshot.folder_cache_hits,
            folder_cache_missing=snapshot.folder_cache_missing,
            folder_cache_requests=snapshot.folder_cache_requests,
            client_render=bool(getattr(self.app, "client_render", False)),
            notify_elapsed_ms=snapshot.timings_ms["notify"],
            list_elapsed_ms=snapshot.timings_ms["list"],
            current_cache_elapsed_ms=snapshot.timings_ms["current_cache"],
            folder_map_elapsed_ms=snapshot.timings_ms["folder_map"],
            status_elapsed_ms=snapshot.timings_ms["status"],
            sort_elapsed_ms=snapshot.timings_ms["sort"],
            total_elapsed_ms=json_elapsed_ms,
        )
        workertrace.append(
            "browse_listing_endpoint_complete",
            rel_path=snapshot.rel_path,
            remote_path=snapshot.remote_path,
            force_refresh=snapshot.force_refresh,
            listing_source=snapshot.listing_source,
            row_count=len(snapshot.entries),
            remote_folder_count=snapshot.remote_folder_count,
            folder_cache_hits=snapshot.folder_cache_hits,
            folder_cache_missing=snapshot.folder_cache_missing,
            folder_cache_requests=snapshot.folder_cache_requests,
            client_render=bool(getattr(self.app, "client_render", False)),
            notify_elapsed_ms=snapshot.timings_ms["notify"],
            list_elapsed_ms=snapshot.timings_ms["list"],
            current_cache_elapsed_ms=snapshot.timings_ms["current_cache"],
            folder_map_elapsed_ms=snapshot.timings_ms["folder_map"],
            status_elapsed_ms=snapshot.timings_ms["status"],
            sort_elapsed_ms=snapshot.timings_ms["sort"],
            total_elapsed_ms=json_elapsed_ms,
        )
        body = _json.dumps(payload).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self._send_no_store_headers()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_search_session_payload(self, payload: dict, *, started: float) -> None:
        result_serialization_started = time.perf_counter()
        serialized_results = [
            dict(
                self._serialize_browse_row(
                    posixpath.dirname(str(row["path"])),
                    row,
                    current_folder_cache=None,
                    folder_cache_map=(
                        {str(row["name"]): row.get("search_child_folder_cache")}
                        if bool(row.get("is_dir"))
                        else None
                    ),
                ),
                relative_path=str(row.get("relative_path") or ""),
            )
            for row in payload.get("results", [])
        ]
        result_serialization_elapsed_ms = round((time.perf_counter() - result_serialization_started) * 1000, 3)
        payload["results"] = serialized_results
        status = payload.get("status")
        if isinstance(status, dict):
            status["response_serialization_elapsed_ms"] = result_serialization_elapsed_ms
        elapsed_ms = round((time.perf_counter() - started) * 1000, 3)
        search = payload.get("search") if isinstance(payload.get("search"), dict) else {}
        status = payload.get("status") if isinstance(payload.get("status"), dict) else {}
        workertrace.append(
            "browse_search_endpoint",
            rel_path=str((payload.get("root") or {}).get("path") or ""),
            remote_path=str((payload.get("root") or {}).get("remote_path") or ""),
            recursive=bool(search.get("recursive", True)),
            query=str(search.get("query") or ""),
            session_id=payload.get("session_id"),
            cache_status=status.get("cache_status"),
            complete=bool(status.get("complete")),
            pending=bool(status.get("pending")),
            search_scan_complete=bool(status.get("search_scan_complete")),
            result_count=int(search.get("result_count") or 0),
            batch_result_count=len(serialized_results),
            first_batch_result_count=int(search.get("first_batch_result_count") or 0),
            scanned_folder_count=int(search.get("scanned_folder_count") or 0),
            scanned_direct_item_count=int(status.get("scanned_direct_item_count") or 0),
            hydrated_row_count=int(status.get("hydrated_row_count") or 0),
            folder_cache_record_read_count=int(status.get("folder_cache_record_read_count") or 0),
            planning_elapsed_ms=float(status.get("planning_elapsed_ms") or 0.0),
            candidate_scan_elapsed_ms=float(status.get("candidate_scan_elapsed_ms") or 0.0),
            row_hydration_elapsed_ms=float(status.get("row_hydration_elapsed_ms") or 0.0),
            response_serialization_elapsed_ms=result_serialization_elapsed_ms,
            client_render=bool(getattr(self.app, "client_render", False)),
            total_elapsed_ms=elapsed_ms,
        )
        body = _json.dumps(payload).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self._send_no_store_headers()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def serve_browse_search_endpoint(self, query: str) -> None:
        started = time.perf_counter()
        params = parse_qs(query, keep_blank_values=True)
        rel_path = clean_rel_path(params.get("path", [""])[0])
        recursive = params.get("recursive", ["1"])[0]
        if recursive not in {"1", "true", "True"}:
            raise BrowserError(HTTPStatus.BAD_REQUEST, "Recursive cached search requires recursive=1.")
        session_mode = params.get("session", [""])[0]
        session_id = params.get("session_id", [""])[0]
        if session_mode == "1" or session_id:
            try:
                limit = int(params.get("limit", ["100"])[0])
            except (TypeError, ValueError):
                raise BrowserError(HTTPStatus.BAD_REQUEST, "Search limit must be an integer.")
            if limit < 1 or limit > 5000:
                raise BrowserError(HTTPStatus.BAD_REQUEST, "Search limit must be between 1 and 5000.")
            if session_id and params.get("cancel", [""])[0] in {"1", "true", "True"}:
                payload = self.app.cancel_cached_search_session(session_id)
            elif session_id:
                payload = self.app.poll_cached_search_session(session_id, limit=limit)
            else:
                payload = self.app.start_cached_search_session(
                    rel_path,
                    params.get("query", [""])[0],
                    recursive=True,
                    limit=limit,
                )
            self._serve_search_session_payload(payload, started=started)
            return
        snapshot = self.app.build_cached_recursive_search(
            rel_path,
            params.get("query", [""])[0],
            recursive=True,
        )
        root_label = posixpath.basename(snapshot.rel_path) if snapshot.rel_path else "Dropbox"
        result_serialization_started = time.perf_counter()
        serialized_results = [
            dict(
                self._serialize_browse_row(
                    posixpath.dirname(str(row["path"])),
                    row,
                    current_folder_cache=None,
                    folder_cache_map=(
                        {str(row["name"]): row.get("search_child_folder_cache")}
                        if bool(row.get("is_dir"))
                        else None
                    ),
                ),
                relative_path=str(row.get("relative_path") or ""),
            )
            for row in snapshot.entries
        ]
        result_serialization_elapsed_ms = round((time.perf_counter() - result_serialization_started) * 1000, 3)
        payload = {
            "root": {
                "remote_path": snapshot.remote_path,
                "path": snapshot.rel_path,
                "display_name": root_label,
            },
            "search": {
                "query": snapshot.query,
                "recursive": True,
                "result_count": len(snapshot.entries),
                "scanned_folder_count": snapshot.scanned_folder_count,
                "scanned_direct_item_count": snapshot.scanned_direct_item_count,
                "hydrated_row_count": snapshot.hydrated_row_count,
                "first_batch_result_count": len(serialized_results),
            },
            "status": {
                "cache_status": snapshot.cache_status,
                "complete": snapshot.complete,
                "pending": snapshot.pending,
                "pending_folder_count": snapshot.pending_folder_count,
                "queued_folder_count": snapshot.queued_folder_count,
                "missing_folder_count": snapshot.missing_folder_count,
                "missing_listing_count": snapshot.missing_listing_count,
                "message": (
                    "Cached recursive search is complete."
                    if snapshot.complete
                    else "Recursive search is loading cached metadata."
                    if snapshot.pending
                    else "Recursive search results are partial until more cached listings arrive."
                    if snapshot.cache_status == "partial"
                    else "No cached recursive search data is available for this folder yet."
                ),
                "generated_at": snapshot.generated_at,
                "scanned_direct_item_count": snapshot.scanned_direct_item_count,
                "hydrated_row_count": snapshot.hydrated_row_count,
                "folder_cache_record_read_count": snapshot.folder_cache_record_read_count,
                "planning_elapsed_ms": snapshot.planning_elapsed_ms,
                "candidate_scan_elapsed_ms": snapshot.candidate_scan_elapsed_ms,
                "row_hydration_elapsed_ms": snapshot.row_hydration_elapsed_ms,
                "response_serialization_elapsed_ms": result_serialization_elapsed_ms,
                "snapshot_cache_hit": snapshot.snapshot_cache_hit,
                "snapshot_cache_entry_count": len(getattr(self.app, "_search_snapshot_cache", [])),
            },
            "results": serialized_results,
        }
        elapsed_ms = round((time.perf_counter() - started) * 1000, 3)
        if elapsed_ms >= workertrace.SLOW_OPERATION_THRESHOLD_MS:
            workertrace.record_diagnostic(
                "slow_browse_search_endpoint",
                rel_path=snapshot.rel_path,
                remote_path=snapshot.remote_path,
                recursive=True,
                query=snapshot.query,
                cache_status=snapshot.cache_status,
                complete=snapshot.complete,
                pending=snapshot.pending,
                result_count=len(snapshot.entries),
                scanned_folder_count=snapshot.scanned_folder_count,
                queued_folder_count=snapshot.queued_folder_count,
                pending_folder_count=snapshot.pending_folder_count,
                missing_folder_count=snapshot.missing_folder_count,
                missing_listing_count=snapshot.missing_listing_count,
                scanned_direct_item_count=snapshot.scanned_direct_item_count,
                hydrated_row_count=snapshot.hydrated_row_count,
                first_batch_result_count=len(serialized_results),
                folder_cache_record_read_count=snapshot.folder_cache_record_read_count,
                planning_elapsed_ms=snapshot.planning_elapsed_ms,
                candidate_scan_elapsed_ms=snapshot.candidate_scan_elapsed_ms,
                row_hydration_elapsed_ms=snapshot.row_hydration_elapsed_ms,
                response_serialization_elapsed_ms=result_serialization_elapsed_ms,
                snapshot_cache_hit=snapshot.snapshot_cache_hit,
                snapshot_cache_entry_count=len(getattr(self.app, "_search_snapshot_cache", [])),
                client_render=bool(getattr(self.app, "client_render", False)),
                total_elapsed_ms=elapsed_ms,
            )
        workertrace.append(
            "browse_search_endpoint",
            rel_path=snapshot.rel_path,
            remote_path=snapshot.remote_path,
            recursive=True,
            query=snapshot.query,
            cache_status=snapshot.cache_status,
            complete=snapshot.complete,
            pending=snapshot.pending,
            result_count=len(snapshot.entries),
            scanned_folder_count=snapshot.scanned_folder_count,
            queued_folder_count=snapshot.queued_folder_count,
            pending_folder_count=snapshot.pending_folder_count,
            missing_folder_count=snapshot.missing_folder_count,
            missing_listing_count=snapshot.missing_listing_count,
            scanned_direct_item_count=snapshot.scanned_direct_item_count,
            hydrated_row_count=snapshot.hydrated_row_count,
            first_batch_result_count=len(serialized_results),
            folder_cache_record_read_count=snapshot.folder_cache_record_read_count,
            planning_elapsed_ms=snapshot.planning_elapsed_ms,
            candidate_scan_elapsed_ms=snapshot.candidate_scan_elapsed_ms,
            row_hydration_elapsed_ms=snapshot.row_hydration_elapsed_ms,
            response_serialization_elapsed_ms=result_serialization_elapsed_ms,
            snapshot_cache_hit=snapshot.snapshot_cache_hit,
            snapshot_cache_entry_count=len(getattr(self.app, "_search_snapshot_cache", [])),
            client_render=bool(getattr(self.app, "client_render", False)),
            total_elapsed_ms=elapsed_ms,
        )
        body = _json.dumps(payload).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self._send_no_store_headers()
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
        self._send_no_store_headers()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def serve_folder_info(self, query: str) -> None:
        started = time.perf_counter()
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
        request_page_time: float | None = None
        if cache:
            if current_rel is not None and hasattr(cache, "page_epoch_for"):
                request_page_time = cache.page_epoch_for(current_rel)
            else:
                request_page_time = time.time()
        results: dict = {}
        requested_count = 0
        stuck_parent_reenqueued = False
        status_counts: dict[str, int] = {}
        for rel_path in rel_paths:
            if not cache:
                results[rel_path] = {"status": "unavailable"}
                status_counts["unavailable"] = status_counts.get("unavailable", 0) + 1
                continue
            full_remote = remote_target(self.app.remote, rel_path)
            st = cache.status(full_remote)
            status_counts[st] = status_counts.get(st, 0) + 1
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
                    "size_sort_value": sz or 0,
                    "count_display": f"{fc:,} files" if fc is not None else "",
                    "date_display": display_date(data.get("newest_mtime")),
                    "date_sort_value": data.get("newest_mtime") or 0,
                }
            else:
                # calculating or pending — ensure it's queued
                cache.request(full_remote, request_page_time)
                requested_count += 1
                results[rel_path] = {"status": "calculating", "complete": False}
        # Safety net: when polled child folders are already complete but the
        # current folder is still partial, re-request current. Legitimate
        # in-progress parents dedupe; stuck partial parents (stale disk or
        # missed child attach) can repair/flush or recompute.
        if cache and current_rel is not None:
            current_result = results.get(current_rel) or {}
            child_paths = [path for path in rel_paths if path != current_rel]
            if (
                child_paths
                and current_result.get("status") == "partial"
                and not current_result.get("complete")
                and all((results.get(path) or {}).get("complete") for path in child_paths)
            ):
                cache.request(remote_target(self.app.remote, current_rel), request_page_time)
                requested_count += 1
                stuck_parent_reenqueued = True
        workertrace.append(
            "folder_info_poll",
            path_count=len(rel_paths),
            requested_count=requested_count,
            status_counts=status_counts,
            current_rel=current_rel,
            request_page_time=request_page_time,
            stuck_parent_reenqueued=stuck_parent_reenqueued,
            elapsed_ms=round((time.perf_counter() - started) * 1000, 3),
        )
        body = _json.dumps({"results": results}).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self._send_no_store_headers()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def serve_music_endpoint(self, path: str, query: str) -> None:
        started = time.perf_counter()
        status, payload = handle_music_get(self.app, path, query)
        endpoint = path.removeprefix(MUSIC_ENDPOINT_PREFIX)
        if endpoint == "library":
            params = parse_qs(query, keep_blank_values=True)
            payload_status = payload.get("status", {}) if isinstance(payload, dict) else {}
            payload_root = payload.get("root", {}) if isinstance(payload, dict) else {}
            workertrace.append(
                "music_library_poll",
                endpoint=endpoint,
                query_path=params.get("path", [""])[0],
                root_remote_path=payload_root.get("remote_path") if isinstance(payload_root, dict) else None,
                http_status=int(status),
                cache_status=payload_status.get("cache_status") if isinstance(payload_status, dict) else None,
                complete=payload_status.get("complete") if isinstance(payload_status, dict) else None,
                pending=payload_status.get("pending") if isinstance(payload_status, dict) else None,
                pending_folder_count=payload_status.get("pending_folder_count") if isinstance(payload_status, dict) else None,
                queued_folder_count=payload_status.get("queued_folder_count") if isinstance(payload_status, dict) else None,
                missing_folder_count=payload_status.get("missing_folder_count") if isinstance(payload_status, dict) else None,
                folder_count=len(payload.get("folders", [])) if isinstance(payload, dict) else None,
                song_count=len(payload.get("songs", [])) if isinstance(payload, dict) else None,
                snapshot_cache_hit=payload_status.get("snapshot_cache_hit") if isinstance(payload_status, dict) else None,
                snapshot_build_count=payload_status.get("snapshot_build_count") if isinstance(payload_status, dict) else None,
                recursive_record_read_count=payload_status.get("recursive_record_read_count") if isinstance(payload_status, dict) else None,
                recursive_traversal_folder_count=payload_status.get("recursive_traversal_folder_count") if isinstance(payload_status, dict) else None,
                payload_build_elapsed_ms=payload_status.get("payload_build_elapsed_ms") if isinstance(payload_status, dict) else None,
                snapshot_cache_revision=payload_status.get("snapshot_cache_revision") if isinstance(payload_status, dict) else None,
                client_poll_seq=params.get("poll_seq", [""])[0],
                client_poll_delay_ms=params.get("poll_delay_ms", [""])[0],
                client_poll_refresh=params.get("poll_refresh", [""])[0],
                elapsed_ms=round((time.perf_counter() - started) * 1000, 3),
            )
        body = _json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self._send_no_store_headers()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def serve_video_endpoint(self, path: str, query: str) -> None:
        endpoint = path.removeprefix(VIDEO_ENDPOINT_PREFIX)
        if endpoint == "thumbnail":
            self.serve_video_thumbnail(query)
            return
        if endpoint == "probe":
            params = parse_qs(query, keep_blank_values=True)
            source = params.get("source", ["remote"])[0]
            if source != "remote":
                raise BrowserError(HTTPStatus.BAD_REQUEST, "Only remote video probe is supported.")
            rel_path = clean_rel_path(params.get("path", [""])[0])
            resolved_rel_path, file_size = self._resolve_remote_file(rel_path)
            port = int(self.server.server_address[1])  # type: ignore[attr-defined]
            base_url = f"http://127.0.0.1:{port}"
            payload = probe_remote_media(
                self.app,
                rel_path=resolved_rel_path,
                base_url=base_url,
                file_size=file_size,
            )
            status = HTTPStatus.OK
        elif endpoint == "subtitles/all":
            params = parse_qs(query, keep_blank_values=True)
            source = params.get("source", ["remote"])[0]
            if source != "remote":
                raise BrowserError(HTTPStatus.BAD_REQUEST, "Only remote subtitle extraction is supported.")
            rel_path = clean_rel_path(params.get("path", [""])[0])
            resolved_rel_path, file_size = self._resolve_remote_file(rel_path)
            port = int(self.server.server_address[1])  # type: ignore[attr-defined]
            base_url = f"http://127.0.0.1:{port}"
            payload = extract_all_remote_subtitles_to_webvtt(
                self.app,
                rel_path=resolved_rel_path,
                base_url=base_url,
                file_size=file_size,
            )
            body = _json.dumps(payload).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self._send_no_store_headers()
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        elif endpoint == "subtitles":
            params = parse_qs(query, keep_blank_values=True)
            source = params.get("source", ["remote"])[0]
            if source != "remote":
                raise BrowserError(HTTPStatus.BAD_REQUEST, "Only remote subtitle extraction is supported.")
            rel_path = clean_rel_path(params.get("path", [""])[0])
            resolved_rel_path, file_size = self._resolve_remote_file(rel_path)
            track_raw = params.get("track", [""])[0].strip()
            if not track_raw:
                raise BrowserError(HTTPStatus.BAD_REQUEST, "Subtitle track is required.")
            try:
                subtitle_stream_index = int(track_raw)
            except ValueError as exc:
                raise BrowserError(HTTPStatus.BAD_REQUEST, "Subtitle track must be an integer stream index.") from exc
            port = int(self.server.server_address[1])  # type: ignore[attr-defined]
            base_url = f"http://127.0.0.1:{port}"
            body, language = extract_remote_subtitles_to_webvtt(
                self.app,
                rel_path=resolved_rel_path,
                subtitle_stream_index=subtitle_stream_index,
                base_url=base_url,
                file_size=file_size,
            )
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/vtt; charset=utf-8")
            self._send_no_store_headers()
            if language:
                self.send_header("Content-Language", language)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        elif endpoint == "subtitles/window":
            params = parse_qs(query, keep_blank_values=True)
            source = params.get("source", ["remote"])[0]
            if source != "remote":
                raise BrowserError(HTTPStatus.BAD_REQUEST, "Only remote subtitle extraction is supported.")
            rel_path = clean_rel_path(params.get("path", [""])[0])
            resolved_rel_path, file_size = self._resolve_remote_file(rel_path)
            track_raw = params.get("track", [""])[0].strip()
            if not track_raw:
                raise BrowserError(HTTPStatus.BAD_REQUEST, "Subtitle track is required.")
            try:
                subtitle_stream_index = int(track_raw)
            except ValueError as exc:
                raise BrowserError(HTTPStatus.BAD_REQUEST, "Subtitle track must be an integer stream index.") from exc
            window_start_seconds = parse_video_start_seconds(params.get("start", [""])[0])
            window_duration_seconds = parse_subtitle_window_duration_seconds(params.get("duration", [""])[0])
            window_status = params.get("window_status", ["requested"])[0].strip() or "requested"
            playback_sync_token = parse_playback_sync_token(params.get("playback_sync_token", [""])[0])
            port = int(self.server.server_address[1])  # type: ignore[attr-defined]
            base_url = f"http://127.0.0.1:{port}"
            payload = extract_remote_subtitle_window_to_webvtt(
                self.app,
                rel_path=resolved_rel_path,
                subtitle_stream_index=subtitle_stream_index,
                base_url=base_url,
                file_size=file_size,
                window_start_seconds=window_start_seconds,
                window_duration_seconds=window_duration_seconds,
                window_status=window_status,
                playback_sync_token=playback_sync_token,
            )
            body = _json.dumps(payload).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self._send_no_store_headers()
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        elif endpoint == "session/file":
            params = parse_qs(query, keep_blank_values=True)
            session_id = params.get("id", [""])[0]
            name = params.get("name", [""])[0]
            asset_path, content_type = video_session_manager(self.app).session_asset(session_id, name)
            body = asset_path.read_bytes()
            if asset_path.suffix.casefold() == ".m3u8":
                init_url = "/video/endpoints/session/file?" + urlencode({
                    "id": session_id,
                    "name": HLS_INIT_SEGMENT_NAME,
                })
                body = body.replace(
                    f'#EXT-X-MAP:URI="{HLS_INIT_SEGMENT_NAME}"'.encode("utf-8"),
                    f'#EXT-X-MAP:URI="{init_url}"'.encode("utf-8"),
                )
                if b"#EXT-X-START:" not in body:
                    newline = b"\r\n" if b"\r\n" in body else b"\n"
                    start_tag = b"#EXT-X-START:TIME-OFFSET=0,PRECISE=YES" + newline
                    if b"#EXT-X-INDEPENDENT-SEGMENTS" + newline in body:
                        body = body.replace(
                            b"#EXT-X-INDEPENDENT-SEGMENTS" + newline,
                            b"#EXT-X-INDEPENDENT-SEGMENTS" + newline + start_tag,
                        )
                    else:
                        body = body.replace(b"#EXTM3U" + newline, b"#EXTM3U" + newline + start_tag)
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self._send_no_store_headers()
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        else:
            status, payload = handle_video_get(self.app, path, query)
        body = _json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self._send_no_store_headers()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def serve_video_endpoint_post(self, path: str) -> None:
        try:
            endpoint = path.removeprefix(VIDEO_ENDPOINT_PREFIX)
            params = self._read_form()
            if endpoint == "session":
                source = params.get("source", ["remote"])[0]
                if source != "remote":
                    raise BrowserError(HTTPStatus.BAD_REQUEST, "Only remote video compatibility playback is supported.")
                rel_path = clean_rel_path(params.get("path", [""])[0])
                client_id = params.get("client_id", [""])[0].strip()[:128]
                resolved_rel_path, file_size = self._resolve_remote_file(rel_path)
                audio_stream_index_raw = params.get("audio_stream_index", [""])[0].strip()
                audio_stream_index = int(audio_stream_index_raw) if audio_stream_index_raw else None
                subtitle_stream_index_raw = params.get("subtitle_stream_index", [""])[0].strip()
                subtitle_stream_index = int(subtitle_stream_index_raw) if subtitle_stream_index_raw else None
                subtitle_stroke_enabled = params.get("subtitle_stroke_enabled", ["1"])[0].strip() != "0"
                subtitle_shadow_enabled = params.get("subtitle_shadow_enabled", ["1"])[0].strip() != "0"
                start_time_seconds = parse_video_start_seconds(params.get("start_time_seconds", [""])[0])
                force_video_transcode = params.get("force_video_transcode", [""])[0].strip() == "1"
                force_audio_transcode = params.get("force_audio_transcode", [""])[0].strip() == "1"
                transition_token = parse_video_transition_token(params.get("transition_token", [""])[0])
                port = int(self.server.server_address[1])  # type: ignore[attr-defined]
                base_url = f"http://127.0.0.1:{port}"
                payload = video_session_manager(self.app).create_session(
                    rel_path=resolved_rel_path,
                    base_url=base_url,
                    file_size=file_size,
                    client_id=client_id,
                    audio_stream_index=audio_stream_index,
                    subtitle_stream_index=subtitle_stream_index,
                    subtitle_stroke_enabled=subtitle_stroke_enabled,
                    subtitle_shadow_enabled=subtitle_shadow_enabled,
                    start_time_seconds=start_time_seconds,
                    force_video_transcode=force_video_transcode,
                    force_audio_transcode=force_audio_transcode,
                    transition_token=transition_token,
                )
                status = HTTPStatus.OK
            elif endpoint == "session/stop":
                session_id = params.get("id", [""])[0].strip() or None
                client_id = params.get("client_id", [""])[0].strip()[:128]
                transition_token = parse_video_transition_token(params.get("transition_token", [""])[0])
                payload = video_session_manager(self.app).stop_session(
                    session_id,
                    client_id=client_id,
                    transition_token=transition_token,
                )
                status = HTTPStatus.OK
            elif endpoint == "session/progress":
                session_id = params.get("id", [""])[0].strip()
                if not session_id:
                    raise BrowserError(HTTPStatus.BAD_REQUEST, "Video session id is required.")
                client_id = params.get("client_id", [""])[0].strip()[:128]
                playback_seconds = parse_video_playback_seconds(params.get("playback_seconds", [""])[0])
                media_seconds = parse_optional_video_playback_seconds(params.get("playback_media_seconds", [""])[0])
                playback_state = parse_video_playback_state(params.get("playback_state", [""])[0])
                playback_sync_token = parse_playback_sync_token(params.get("playback_sync_token", [""])[0])
                payload = video_session_manager(self.app).update_session_progress(
                    session_id=session_id,
                    playback_seconds=playback_seconds,
                    media_seconds=media_seconds,
                    playback_state=playback_state,
                    playback_sync_token=playback_sync_token,
                    client_id=client_id,
                )
                status = HTTPStatus.OK
            elif endpoint == "cache/clear":
                payload = {
                    "status": "ok",
                    "cleared": clear_video_disk_caches(self.app),
                }
                status = HTTPStatus.OK
            else:
                raise BrowserError(HTTPStatus.NOT_FOUND, "Video endpoint not found.")
        except BrowserError as exc:
            self._send_json_error(exc.status, exc.message, exc.details)
            return
        body = _json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self._send_no_store_headers()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_client_log(self) -> None:
        params = self._read_form()
        details_raw = params.get("details", ["{}"])[0]
        try:
            details = _json.loads(details_raw) if details_raw else {}
        except _json.JSONDecodeError:
            details = {"raw": details_raw}
        if not isinstance(details, dict):
            details = {"value": details}
        logged = append_client_log(self.app, {
            "subsystem": params.get("subsystem", [""])[0],
            "level": params.get("level", ["info"])[0],
            "message": params.get("message", [""])[0],
            "url": params.get("url", [""])[0],
            "details": details,
            "path": params.get("path", [""])[0],
            "session_id": params.get("session_id", [""])[0],
            "playback_mode": params.get("playback_mode", [""])[0],
            "current_time": params.get("current_time", [""])[0],
        })
        body = _json.dumps({"status": "ok", "logged": logged}).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self._send_no_store_headers()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def serve_photo_map_endpoint(self, path: str, query: str) -> None:
        endpoint = path.removeprefix(PHOTO_MAP_ENDPOINT_PREFIX)
        if endpoint != "cache":
            raise BrowserError(HTTPStatus.NOT_FOUND, "Photo Map endpoint not found.")
        params = parse_qs(query, keep_blank_values=True)
        folder_path = normalize_cache_path(params.get("path", [""])[0], allow_empty=True)
        entries = self.app.photo_map_cache.read(folder_path)
        self._send_photo_map_json({"status": "ok", "path": folder_path, "entries": entries})

    def handle_photo_map_endpoint(self, path: str) -> None:
        endpoint = path.removeprefix(PHOTO_MAP_ENDPOINT_PREFIX)
        if endpoint != "cache":
            raise BrowserError(HTTPStatus.NOT_FOUND, "Photo Map endpoint not found.")
        payload = self._read_json_body()
        entries = payload.get("entries") if isinstance(payload, dict) else None
        folder_path = normalize_cache_path(payload.get("path", "") if isinstance(payload, dict) else "", allow_empty=True)
        written = self.app.photo_map_cache.write_batch(folder_path, entries)
        self._send_photo_map_json({"status": "ok", "path": folder_path, "written": written})

    def _send_photo_map_json(self, payload: dict[str, object]) -> None:
        body = _json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._send_no_store_headers()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self) -> object:
        raw_length = self.headers.get("Content-Length") or "0"
        try:
            length = int(raw_length)
        except ValueError as exc:
            raise BrowserError(HTTPStatus.BAD_REQUEST, "Invalid JSON request length.") from exc
        if length < 0 or length > PHOTO_MAP_MAX_JSON_BODY_BYTES:
            raise BrowserError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Photo Map JSON request is too large.")
        raw = self.rfile.read(length)
        try:
            return _json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, _json.JSONDecodeError) as exc:
            raise BrowserError(HTTPStatus.BAD_REQUEST, "Photo Map request body must be valid JSON.") from exc

    def serve_asset(self, request_path: str, head_only: bool = False) -> None:
        rel = unquote(request_path.removeprefix(ASSET_ROUTE_PREFIX))
        if "\\" in rel:
            raise BrowserError(HTTPStatus.NOT_FOUND, "Not found.")
        parts = Path(rel).parts
        if not parts or any(part in {"", ".", ".."} for part in parts):
            raise BrowserError(HTTPStatus.NOT_FOUND, "Not found.")
        vendor_content_type = PHOTO_MAP_VENDOR_ASSETS.get(rel)
        if vendor_content_type is not None:
            content_type = vendor_content_type
        elif parts == ("app.css",) or (len(parts) == 2 and parts[0] == "css" and parts[1].endswith(".css")):
            content_type = "text/css; charset=utf-8"
        elif (
            len(parts) >= 2
            and parts[0] == "js"
            and parts[-1].endswith(".js")
            and all(part not in {"", ".", ".."} for part in parts[1:])
        ):
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
        self._send_no_store_headers()
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
        self._send_no_store_headers()
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
        elif action == "dropbox_only_to_local_all":
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
        self._send_no_store_headers()
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
        self._send_no_store_headers()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_local_only_delete_bat(self) -> None:
        params = self._read_form()
        rel_path = clean_rel_path(params.get("path", [""])[0])
        recursive = params.get("recursive", [""])[0] == "1"
        if params.get("enable_to_local", [""])[0] != "1":
            raise BrowserError(HTTPStatus.FORBIDDEN, "Enable sync to local before downloading delete commands.")
        script, total = self.app.local_only_delete_batch(rel_path, recursive)
        body = script.encode("utf-8-sig")
        safe_name = (Path(rel_path).name if rel_path else "root") or "root"
        safe_name = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "-" for ch in safe_name)
        filename = f"delete-local-only-{safe_name}.bat"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/x-msdos-program")
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("X-Local-Only-File-Count", str(total))
        self._send_no_store_headers()
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
        self._send_no_store_headers()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_html(self, status: HTTPStatus, body: str, head_only: bool = False) -> None:
        encoded = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self._send_no_store_headers()
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
