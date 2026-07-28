from __future__ import annotations

from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from collections import OrderedDict
from dataclasses import dataclass, field, replace
from datetime import datetime
from http import HTTPStatus
import inspect
import posixpath
import re
import time
import uuid
from pathlib import Path
import threading
from typing import Any
from contextlib import nullcontext

from . import syncstate, workertrace
from .config import (
    MUSIC_WAVEFORM_CACHE_ENTRY_LIMIT_DEFAULT,
    MUSIC_WAVEFORM_MAX_RESOLUTION_DEFAULT,
    THUMBNAIL_CACHE_DIR,
    ThumbnailConfig,
    VideoToolsConfig,
)
from .errors import BrowserError
from .formatting import file_type, parse_rclone_time
from .foldercache_compute import parse_direct_listing
from .ignored import is_ignored_name
from .listingcache import ListingCacheManager
from .namekeys import filename_compare_key
from .photo_map_cache import PhotoMapCache
from .paths import remote_target, safe_join_local
from .rclone import RcloneClient
from .thumbnails import ThumbnailService
from .video_thumbnails import VideoThumbnailService
from .windows_names import (
    decode_rclone_literal_escapes,
    decode_rclone_literal_escapes_path,
    match_dropbox_names_to_local_names,
    resolve_matching_local_path,
)


def diff_label(status: str | None) -> str:
    return {
        "synced": "Synced",
        "has_diffs": "Has Diffs",
        "dropbox_only": "Dropbox Only",
        "local_only": "Local Only",
        "loading": "Loading",
    }.get(status or "", "Loading")


_SEARCH_SEPARATOR_RE = re.compile(r"[_./\\\-\s]+")


def normalize_search_text(value: str) -> str:
    return " ".join(
        part for part in _SEARCH_SEPARATOR_RE.split(filename_compare_key(value or "")) if part
    )


def tokenize_search_text(value: str) -> list[str]:
    normalized = normalize_search_text(value)
    return normalized.split(" ") if normalized else []


@dataclass
class BatchPlanProgress:
    started_label: str = field(default_factory=lambda: datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    completed: int = 0
    dispatched: int = 0
    running: int = 0
    lock: threading.Lock = field(default_factory=threading.Lock)

    def dispatch(self, count: int = 1) -> None:
        with self.lock:
            self.dispatched += count

    def start(self) -> None:
        with self.lock:
            self.running += 1

    def finish(self) -> None:
        with self.lock:
            self.running = max(0, self.running - 1)
            self.completed += 1

    def text(self) -> str:
        with self.lock:
            current = min(self.dispatched, self.completed + self.running)
            remaining = max(0, self.dispatched - current)
            return f"{current}/{self.dispatched} planned, {remaining} remaining] (Plan: {self.started_label})"

    def snapshot(self) -> dict[str, int | str]:
        with self.lock:
            current = min(self.dispatched, self.completed + self.running)
            remaining = max(0, self.dispatched - current)
            return {
                "current": current,
                "total": self.dispatched,
                "remaining": remaining,
                "text": f"{current}/{self.dispatched} planned, {remaining} remaining] (Plan: {self.started_label})",
            }


@dataclass
class StoredBatchPlan:
    token: str
    created_at: float
    rel_path: str
    action: str
    recursive: bool
    plan: dict[str, Any]


@dataclass
class BrowseSnapshot:
    rel_path: str
    sort_key: str
    direction: str
    force_refresh: bool
    page_time: float
    remote_path: str
    entries: list[dict[str, Any]]
    folder_cache_map: dict[str, Any]
    current_folder_cache: dict[str, Any] | None
    listing_source: str
    remote_folder_count: int
    folder_cache_hits: int
    folder_cache_missing: int
    folder_cache_requests: int
    timings_ms: dict[str, float]


@dataclass
class CachedRecursiveSearchSnapshot:
    rel_path: str
    remote_path: str
    query: str
    entries: list[dict[str, Any]]
    cache_status: str
    complete: bool
    pending: bool
    pending_folder_count: int
    queued_folder_count: int
    missing_folder_count: int
    missing_listing_count: int
    scanned_folder_count: int
    generated_at: float
    scanned_direct_item_count: int = 0
    hydrated_row_count: int = 0
    folder_cache_record_read_count: int = 0
    planning_elapsed_ms: float = 0.0
    candidate_scan_elapsed_ms: float = 0.0
    row_hydration_elapsed_ms: float = 0.0
    snapshot_cache_hit: bool = False


class CachedSearchSession:
    """One cancellable background search scan with consumable result batches."""

    IDLE_TTL_SECONDS = 15 * 60

    def __init__(
        self,
        manager: "CachedSearchSessionManager",
        session_id: str,
        rel_path: str,
        query: str,
        recursive: bool,
        limit: int,
    ) -> None:
        self.manager = manager
        self.session_id = session_id
        self.rel_path = rel_path
        self.query = query
        self.recursive = recursive
        self.limit = max(1, min(int(limit), 5000))
        self.created_at = time.time()
        self.last_access = self.created_at
        self._condition = threading.Condition()
        self._pending_results: list[dict[str, Any]] = []
        self._total_result_count = 0
        self._first_batch_result_count = 0
        self._snapshot: CachedRecursiveSearchSnapshot | None = None
        self._progress: dict[str, Any] = {
            "scanned_folder_count": 0,
            "scanned_direct_item_count": 0,
            "hydrated_row_count": 0,
            "folder_cache_record_read_count": 0,
            "planning_elapsed_ms": 0.0,
            "candidate_scan_elapsed_ms": 0.0,
            "row_hydration_elapsed_ms": 0.0,
        }
        self._started = False
        self._complete = False
        self._cancelled = False
        self._error: str | None = None

    def start(self) -> None:
        with self._condition:
            if self._started:
                return
            self._started = True
        thread = threading.Thread(
            target=self._run,
            name=f"cached-search-{self.session_id[:8]}",
            daemon=True,
        )
        thread.start()

    def _run(self) -> None:
        try:
            snapshot = self.manager.app.build_cached_recursive_search(
                self.rel_path,
                self.query,
                recursive=self.recursive,
                on_result=self._publish_result,
                on_progress=self._publish_progress,
                cancel_check=self.is_cancelled,
            )
            with self._condition:
                self._snapshot = snapshot
                self._complete = not self._cancelled
                self._condition.notify_all()
        except Exception as exc:
            with self._condition:
                self._error = str(exc)
                self._complete = True
                self._condition.notify_all()

    def is_cancelled(self) -> bool:
        with self._condition:
            return self._cancelled

    def cancel(self) -> None:
        with self._condition:
            self._cancelled = True
            self._condition.notify_all()

    def _publish_result(self, row: dict[str, Any]) -> None:
        with self._condition:
            if self._cancelled:
                return
            self._pending_results.append(dict(row))
            self._total_result_count += 1
            self._condition.notify_all()

    def _publish_progress(self, progress: dict[str, Any]) -> None:
        with self._condition:
            self._progress.update(progress)
            self._condition.notify_all()

    def payload(self, limit: int | None = None) -> dict[str, Any]:
        batch_limit = self.limit if limit is None else max(1, min(int(limit), 5000))
        with self._condition:
            self.last_access = time.time()
            if self._error is not None:
                raise BrowserError(HTTPStatus.INTERNAL_SERVER_ERROR, self._error)
            rows = self._pending_results[:batch_limit]
            del self._pending_results[:len(rows)]
            if self._first_batch_result_count == 0 and rows:
                self._first_batch_result_count = len(rows)
            snapshot = self._snapshot
            progress = dict(self._progress)
            search_complete = bool(self._complete and snapshot is not None and not self._pending_results)
            cache_status = snapshot.cache_status if snapshot is not None else "partial"
            pending = snapshot.pending if snapshot is not None else True
            complete = bool(search_complete and snapshot is not None and snapshot.complete)
            if self._cancelled:
                search_complete = True
                complete = False
                pending = False
            status = {
                "cache_status": cache_status,
                "complete": complete,
                "pending": pending,
                "search_scan_complete": search_complete,
                "search_pending": not search_complete,
                "has_more_results": bool(self._pending_results) or not search_complete,
                "pending_folder_count": snapshot.pending_folder_count if snapshot is not None else 0,
                "queued_folder_count": snapshot.queued_folder_count if snapshot is not None else 0,
                "missing_folder_count": snapshot.missing_folder_count if snapshot is not None else 0,
                "missing_listing_count": snapshot.missing_listing_count if snapshot is not None else 0,
                "message": (
                    "Cached recursive search is complete."
                    if complete
                    else "Recursive search was cancelled."
                    if self._cancelled
                    else "Recursive search is scanning cached metadata."
                ),
                "generated_at": snapshot.generated_at if snapshot is not None else time.time(),
                **progress,
                "first_batch_result_count": self._first_batch_result_count,
            }
            return {
                "session_id": self.session_id,
                "root": {
                    "remote_path": snapshot.remote_path if snapshot is not None else remote_target(self.manager.app.remote, self.rel_path),
                    "path": self.rel_path,
                    "display_name": posixpath.basename(self.rel_path) if self.rel_path else "Dropbox",
                },
                "search": {
                    "query": self.query,
                    "recursive": self.recursive,
                    "result_count": self._total_result_count,
                    "scanned_folder_count": progress.get("scanned_folder_count", 0),
                    "first_batch_result_count": self._first_batch_result_count,
                },
                "status": status,
                "results": rows,
            }


class CachedSearchSessionManager:
    """Bounded app-local manager for incremental cache-only search scans."""

    MAX_SESSIONS = 8

    def __init__(self, app: "DropboxBrowser") -> None:
        self.app = app
        self._lock = threading.Lock()
        self._sessions: dict[str, CachedSearchSession] = {}

    def _prune_locked(self) -> None:
        now = time.time()
        expired = [
            session_id
            for session_id, session in self._sessions.items()
            if now - session.last_access > CachedSearchSession.IDLE_TTL_SECONDS
        ]
        for session_id in expired:
            session = self._sessions.pop(session_id)
            session.cancel()
        while len(self._sessions) >= self.MAX_SESSIONS:
            session_id, session = min(self._sessions.items(), key=lambda item: item[1].last_access)
            self._sessions.pop(session_id, None)
            session.cancel()

    def start(self, rel_path: str, query: str, *, recursive: bool, limit: int) -> dict[str, Any]:
        with self._lock:
            self._prune_locked()
            session_id = uuid.uuid4().hex
            session = CachedSearchSession(self, session_id, rel_path, query, recursive, limit)
            self._sessions[session_id] = session
        session.start()
        return session.payload(limit)

    def poll(self, session_id: str, *, limit: int) -> dict[str, Any]:
        with self._lock:
            self._prune_locked()
            session = self._sessions.get(session_id)
        if session is None:
            raise BrowserError(HTTPStatus.NOT_FOUND, "Search session was not found or has expired.")
        return session.payload(limit)

    def cancel(self, session_id: str) -> dict[str, Any]:
        with self._lock:
            session = self._sessions.get(session_id)
        if session is None:
            raise BrowserError(HTTPStatus.NOT_FOUND, "Search session was not found or has expired.")
        session.cancel()
        return session.payload(limit=session.limit)

    def shutdown(self) -> None:
        with self._lock:
            sessions = list(self._sessions.values())
            self._sessions.clear()
        for session in sessions:
            session.cancel()


class SearchSnapshotCache:
    """Small revision-keyed LRU for complete remote-only search snapshots."""

    def __init__(self, max_entries: int = 8) -> None:
        self.max_entries = max(1, int(max_entries))
        self._entries: OrderedDict[tuple[Any, ...], CachedRecursiveSearchSnapshot] = OrderedDict()

    def get(self, key: tuple[Any, ...]) -> CachedRecursiveSearchSnapshot | None:
        snapshot = self._entries.get(key)
        if snapshot is None:
            return None
        self._entries.move_to_end(key)
        return replace(snapshot, entries=[dict(row) for row in snapshot.entries], snapshot_cache_hit=True)

    def put(self, key: tuple[Any, ...], snapshot: CachedRecursiveSearchSnapshot) -> None:
        self._entries[key] = replace(snapshot, entries=[dict(row) for row in snapshot.entries])
        self._entries.move_to_end(key)
        while len(self._entries) > self.max_entries:
            self._entries.popitem(last=False)

    def __len__(self) -> int:
        return len(self._entries)


class DropboxBrowser:
    BATCH_PLAN_TTL_SECONDS = 15 * 60

    def __init__(
        self,
        rclone: RcloneClient,
        remote: str,
        local_root: Path | None,
        folder_cache: Any = None,
        listing_cache: ListingCacheManager | None = None,
        *,
        client_render: bool = True,
        thumbnail_config: ThumbnailConfig | None = None,
        video_tools_config: VideoToolsConfig | None = None,
        photo_map_cache: PhotoMapCache | None = None,
    ):
        self.rclone = rclone
        self.remote = remote
        self.local_root = local_root.resolve() if local_root else None
        self.folder_cache = folder_cache
        self.listing_cache = listing_cache
        self.client_render = bool(client_render)
        self.thumbnail_config = thumbnail_config
        self.video_tools_config = video_tools_config
        self.photo_map_cache = photo_map_cache or PhotoMapCache()
        self.video_debug_logs = False
        self.music_waveform_cache_entry_limit = MUSIC_WAVEFORM_CACHE_ENTRY_LIMIT_DEFAULT
        self.music_waveform_max_resolution = MUSIC_WAVEFORM_MAX_RESOLUTION_DEFAULT
        self.client_log_enabled = True
        self.client_log_subsystems = {
            "video": True,
            "video-timing": True,
            "video-subtitles": False,
            "browse-reveal": False,
            "file-search": False,
            "music-metadata": False,
            "music-waveform": False,
            "photo-map": False,
        }
        self._thumbnail_service: ThumbnailService | None = None
        self._video_thumbnail_service: VideoThumbnailService | None = None
        self._video_session_manager: Any | None = None
        self.sync_jobs: Any | None = None
        self._search_session_manager = CachedSearchSessionManager(self)
        self._search_snapshot_cache = SearchSnapshotCache()
        self._batch_plan_lock = threading.Lock()
        self._batch_plans: dict[str, StoredBatchPlan] = {}

    @property
    def thumbnail_service(self) -> ThumbnailService | None:
        if self.thumbnail_config is None:
            return None
        if self._thumbnail_service is None:
            self._thumbnail_service = ThumbnailService(
                self.rclone,
                self.remote,
                self.local_root,
                self.thumbnail_config,
            )
        return self._thumbnail_service

    @property
    def video_thumbnail_service(self) -> VideoThumbnailService | None:
        if self.video_tools_config is None:
            return None
        if self._video_thumbnail_service is None:
            self._video_thumbnail_service = VideoThumbnailService(
                self.rclone,
                self.remote,
                self.local_root,
                self.video_tools_config,
                cache_dir=self.thumbnail_config.cache_dir if self.thumbnail_config is not None else THUMBNAIL_CACHE_DIR,
            )
        return self._video_thumbnail_service

    def shutdown(self) -> None:
        for manager in (
            self.rclone,
            self.folder_cache,
            self.sync_jobs,
            self._video_session_manager,
            self._search_session_manager,
        ):
            shutdown = getattr(manager, "shutdown", None)
            if shutdown is not None:
                shutdown()

    def start_cached_search_session(
        self,
        rel_path: str,
        query: str,
        *,
        recursive: bool = True,
        limit: int = 100,
    ) -> dict[str, Any]:
        return self._search_session_manager.start(
            rel_path,
            query,
            recursive=recursive,
            limit=limit,
        )

    def poll_cached_search_session(self, session_id: str, *, limit: int = 100) -> dict[str, Any]:
        return self._search_session_manager.poll(session_id, limit=limit)

    def cancel_cached_search_session(self, session_id: str) -> dict[str, Any]:
        return self._search_session_manager.cancel(session_id)

    def _entries_from_remote_items(
        self,
        rel_path: str,
        remote_items: list[dict[str, Any]],
        *,
        candidate_remote_names: set[str] | None = None,
        candidate_local_names: set[str] | None = None,
    ) -> list[dict[str, Any]]:
        local_folder = resolve_matching_local_path(self.local_root, rel_path) if self.local_root else None

        remote_entries: dict[str, dict[str, Any]] = {}
        for item in remote_items:
            name = item.get("Name") or item.get("Path") or ""
            if not name or "/" in name or is_ignored_name(name):
                continue
            remote_entries[name] = item

        local_entries: dict[str, Path] = {}
        if local_folder and local_folder.exists() and local_folder.is_dir():
            for child in local_folder.iterdir():
                if not is_ignored_name(child.name):
                    local_entries[child.name] = child

        matches = match_dropbox_names_to_local_names(remote_entries, local_entries)
        matched_local_names = set(matches.values())
        rows: list[dict[str, Any]] = []

        for remote_name, item in remote_entries.items():
            if candidate_remote_names is not None and remote_name not in candidate_remote_names:
                continue
            local_name = matches.get(remote_name)
            child = local_entries.get(local_name) if local_name is not None else None
            stat = child.stat() if child is not None else None
            is_dir = bool(item.get("IsDir"))
            rows.append({
                "name": remote_name,
                "remote_name": remote_name,
                "local_name": child.name if child is not None else None,
                "local_path": str(child) if child is not None else None,
                "is_dir": bool(is_dir or (child.is_dir() if child is not None else False)),
                "remote": True,
                "local": child is not None,
                "remote_size": None if is_dir else item.get("Size"),
                "local_size": None if child is None or child.is_dir() else stat.st_size,
                "remote_mtime": parse_rclone_time(item.get("ModTime")),
                "local_mtime": None if child is None else stat.st_mtime,
            })

        for local_name, child in local_entries.items():
            if candidate_local_names is not None and local_name not in candidate_local_names:
                continue
            if local_name in matched_local_names:
                continue
            display_name = decode_rclone_literal_escapes(local_name)
            stat = child.stat()
            rows.append({
                "name": display_name,
                "remote_name": None,
                "local_name": local_name,
                "local_path": str(child),
                "is_dir": child.is_dir(),
                "remote": False,
                "local": True,
                "remote_size": None,
                "local_size": None if child.is_dir() else stat.st_size,
                "remote_mtime": None,
                "local_mtime": stat.st_mtime,
            })

        return rows

    def _search_candidate_names(
        self,
        rel_path: str,
        remote_items: list[dict[str, Any]],
        query_tokens: list[str],
        search_root_path: str | None = None,
    ) -> tuple[set[str], set[str]]:
        """Return remote/local names that can produce search rows.

        This deliberately does not stat local children or build browse rows.
        Local directory enumeration is still required when local comparison is
        enabled so local-only search results retain the existing semantics.
        """
        remote_entries: dict[str, dict[str, Any]] = {}
        for item in remote_items:
            name = item.get("Name") or item.get("Path") or ""
            if not name or "/" in name or is_ignored_name(name):
                continue
            remote_entries[name] = item

        local_entries: dict[str, Path] = {}
        local_folder = resolve_matching_local_path(self.local_root, rel_path) if self.local_root else None
        if local_folder and local_folder.exists() and local_folder.is_dir():
            try:
                for child in local_folder.iterdir():
                    if not is_ignored_name(child.name):
                        local_entries[child.name] = child
            except OSError:
                local_entries = {}

        matches = match_dropbox_names_to_local_names(remote_entries, local_entries)
        matched_local_names = set(matches.values())

        def matches_query(name: str) -> bool:
            if not query_tokens:
                return True
            child_rel_path = posixpath.join(rel_path, name) if rel_path else name
            child_relative_path = child_rel_path
            root_path = search_root_path if search_root_path is not None else rel_path
            if root_path:
                prefix = root_path.rstrip("/") + "/"
                if child_rel_path == root_path:
                    child_relative_path = ""
                elif child_rel_path.startswith(prefix):
                    child_relative_path = child_rel_path[len(prefix):]
            name_key = normalize_search_text(name)
            path_key = normalize_search_text(child_relative_path)
            return all(token in name_key or token in path_key for token in query_tokens)

        candidate_remote_names = {
            name for name in remote_entries if matches_query(name)
        }
        candidate_local_names = {
            name
            for name in local_entries
            if name not in matched_local_names
            and matches_query(decode_rclone_literal_escapes(name))
        }
        return candidate_remote_names, candidate_local_names

    def _list_entries_with_metadata(
        self,
        rel_path: str,
        *,
        force_refresh: bool = False,
        page_time: float | None = None,
    ) -> tuple[list[dict[str, Any]], str]:
        started = time.perf_counter()
        remote = remote_target(self.remote, rel_path)
        local_folder = resolve_matching_local_path(self.local_root, rel_path) if self.local_root else None

        remote_items = None
        source = "rclone"
        if self.listing_cache and not force_refresh:
            remote_items = self.listing_cache.get(remote)
            if remote_items is not None:
                source = "listing_cache"
        if remote_items is None and self.folder_cache and not force_refresh:
            get_direct_listing = getattr(self.folder_cache, "get_direct_listing", None)
            if get_direct_listing is not None:
                remote_items = get_direct_listing(remote)
                if remote_items is not None:
                    source = "folder_cache_direct"
        if remote_items is None:
            try:
                remote_items = self.rclone.lsjson(remote)
            except BrowserError:
                if not (local_folder and local_folder.exists() and local_folder.is_dir()):
                    raise
                remote_items = []
                source = "local_only_after_remote_error"
            else:
                if self.listing_cache:
                    self.listing_cache.set(remote, remote_items)
                prime_direct_listing = getattr(self.folder_cache, "prime_direct_listing", None)
                if prime_direct_listing is not None:
                    prime_direct_listing(remote, remote_items, page_time)

        entries = self._entries_from_remote_items(rel_path, remote_items)
        workertrace.append(
            "navigation_listing_source",
            rel_path=rel_path,
            remote_path=remote,
            source=source,
            force_refresh=force_refresh,
            item_count=len(remote_items),
            row_count=len(entries),
            elapsed_ms=round((time.perf_counter() - started) * 1000, 3),
        )
        return entries, source

    def list_entries(self, rel_path: str, force_refresh: bool = False, page_time: float | None = None) -> list[dict[str, Any]]:
        entries, _source = self._list_entries_with_metadata(
            rel_path,
            force_refresh=force_refresh,
            page_time=page_time,
        )
        return entries

    def build_browse_snapshot(
        self,
        rel_path: str,
        sort_key: str,
        direction: str,
        *,
        force_refresh: bool = False,
        page_time: float | None = None,
        queue_current_folder_metadata: bool = True,
        load_child_folder_metadata: bool = True,
    ) -> BrowseSnapshot:
        canonical_sort_key = sort_key if sort_key in {"name", "type", "date", "size", "status"} else "name"
        canonical_direction = direction if direction in {"asc", "desc"} else "asc"
        page_time_value = time.time() if page_time is None else page_time
        current_remote = remote_target(self.remote, rel_path)
        cache = self.folder_cache

        notify_started = time.perf_counter()
        if cache:
            cache.notify_page_load(page_time_value, page_key=rel_path, force=force_refresh)
            if force_refresh:
                cache.invalidate(current_remote)
        notify_elapsed_ms = round((time.perf_counter() - notify_started) * 1000, 3)

        list_started = time.perf_counter()
        entries, listing_source = self._list_entries_with_metadata(
            rel_path,
            force_refresh=force_refresh,
            page_time=page_time_value,
        )
        list_elapsed_ms = round((time.perf_counter() - list_started) * 1000, 3)

        current_cache_started = time.perf_counter()
        current_folder_cache: dict[str, Any] | None = None
        if cache and self.local_root:
            current_folder_cache = cache.get(current_remote)
            live_file_statuses = self.file_statuses_for_entries(entries)
            if current_folder_cache is None:
                current_folder_cache = {"file_statuses": live_file_statuses}
            else:
                current_folder_cache = dict(current_folder_cache)
                current_folder_cache["file_statuses"] = live_file_statuses
            if queue_current_folder_metadata and (
                current_folder_cache is None or not current_folder_cache.get("complete")
            ):
                cache.request(current_remote, page_time_value)
        current_cache_elapsed_ms = round((time.perf_counter() - current_cache_started) * 1000, 3)

        folder_map_started = time.perf_counter()
        folder_cache_map: dict[str, Any] = {}
        remote_folder_count = 0
        folder_cache_hits = 0
        folder_cache_missing = 0
        folder_cache_requests = 0
        if cache and load_child_folder_metadata:
            for entry in entries:
                if entry["is_dir"] and entry["remote"]:
                    remote_folder_count += 1
                    child = posixpath.join(rel_path, entry["name"]) if rel_path else entry["name"]
                    full_remote = remote_target(self.remote, child)
                    if force_refresh:
                        cache.invalidate(full_remote)
                    cached_data = cache.get(full_remote)
                    if cached_data is not None:
                        folder_cache_hits += 1
                    else:
                        folder_cache_missing += 1
                    folder_cache_map[entry["name"]] = cached_data
                    entry["cached_size"] = cached_data.get("size") if cached_data else None
                    entry["cached_mtime"] = cached_data.get("newest_mtime") if cached_data else None
        folder_map_elapsed_ms = round((time.perf_counter() - folder_map_started) * 1000, 3)

        status_started = time.perf_counter()
        for entry in entries:
            entry["status_label"] = self.status_label_for_entry(entry, folder_cache_map, current_folder_cache)
        status_elapsed_ms = round((time.perf_counter() - status_started) * 1000, 3)

        sort_started = time.perf_counter()
        sorted_entries = self.sort_entries(entries, canonical_sort_key, canonical_direction)
        sort_elapsed_ms = round((time.perf_counter() - sort_started) * 1000, 3)

        return BrowseSnapshot(
            rel_path=rel_path,
            sort_key=canonical_sort_key,
            direction=canonical_direction,
            force_refresh=force_refresh,
            page_time=page_time_value,
            remote_path=current_remote,
            entries=sorted_entries,
            folder_cache_map=folder_cache_map,
            current_folder_cache=current_folder_cache,
            listing_source=listing_source,
            remote_folder_count=remote_folder_count,
            folder_cache_hits=folder_cache_hits,
            folder_cache_missing=folder_cache_missing,
            folder_cache_requests=folder_cache_requests,
            timings_ms={
                "notify": notify_elapsed_ms,
                "list": list_elapsed_ms,
                "current_cache": current_cache_elapsed_ms,
                "folder_map": folder_map_elapsed_ms,
                "status": status_elapsed_ms,
                "sort": sort_elapsed_ms,
            },
        )

    def _cached_direct_items_for_search(
        self,
        remote_path: str,
        record_lookup=None,
    ) -> tuple[dict[str, Any] | None, list[dict[str, Any]] | None]:
        folder_data: dict[str, Any] | None = None
        if self.folder_cache is not None:
            cached = record_lookup(remote_path) if record_lookup is not None else self.folder_cache.get(remote_path)
            if isinstance(cached, dict):
                folder_data = cached
                direct_items = cached.get("direct_items")
                if isinstance(direct_items, list) and all(isinstance(item, dict) for item in direct_items):
                    return folder_data, [dict(item) for item in direct_items]
        if self.listing_cache is not None:
            direct_items = self.listing_cache.get(remote_path)
            if direct_items is not None:
                return folder_data, [dict(item) for item in direct_items]
        return folder_data, None

    def build_cached_recursive_search(
        self,
        rel_path: str,
        query: str,
        *,
        recursive: bool = True,
        on_result=None,
        on_progress=None,
        cancel_check=None,
    ) -> CachedRecursiveSearchSnapshot:
        root_remote_path = remote_target(self.remote, rel_path)
        normalized_query = (query or "").strip()
        query_tokens = tokenize_search_text(normalized_query)
        snapshot_cache_key: tuple[Any, ...] | None = None
        if self.local_root is None and self.folder_cache is not None:
            revision_value = getattr(self.folder_cache, "revision", None)
            if callable(revision_value):
                revision_value = revision_value()
            if isinstance(revision_value, int) and not isinstance(revision_value, bool):
                snapshot_cache_key = (root_remote_path, normalized_query, bool(recursive), revision_value)
                cached_snapshot = self._search_snapshot_cache.get(snapshot_cache_key)
                if cached_snapshot is not None:
                    if on_result is not None:
                        for cached_row in cached_snapshot.entries:
                            on_result(dict(cached_row))
                    if on_progress is not None:
                        on_progress({
                            "scanned_folder_count": cached_snapshot.scanned_folder_count,
                            "scanned_direct_item_count": cached_snapshot.scanned_direct_item_count,
                            "hydrated_row_count": cached_snapshot.hydrated_row_count,
                            "folder_cache_record_read_count": 0,
                            "planning_elapsed_ms": 0.0,
                            "candidate_scan_elapsed_ms": 0.0,
                            "row_hydration_elapsed_ms": 0.0,
                        })
                    return cached_snapshot
        record_cache: dict[str, dict[str, Any] | None] = {}
        folder_cache_record_read_count = 0

        def record_lookup(remote_path: str) -> dict[str, Any] | None:
            nonlocal folder_cache_record_read_count
            if remote_path not in record_cache:
                if self.folder_cache is None:
                    record_cache[remote_path] = None
                else:
                    folder_cache_record_read_count += 1
                    cached = self.folder_cache.get(remote_path)
                    record_cache[remote_path] = cached if isinstance(cached, dict) else None
            return record_cache[remote_path]

        def accepts_keyword(function: Any, name: str) -> bool:
            try:
                parameters = inspect.signature(function).parameters.values()
            except (TypeError, ValueError):
                return False
            return any(
                parameter.name == name or parameter.kind == inspect.Parameter.VAR_KEYWORD
                for parameter in parameters
            )

        ensure_result: dict[str, int | float] = {
            "queued_folder_count": 0,
            "pending_folder_count": 0,
            "missing_folder_count": 0,
        }
        incremental_session = on_result is not None
        search_page_epoch = time.time()
        if (
            incremental_session
            and self.folder_cache is not None
            and hasattr(self.folder_cache, "page_epoch_for")
        ):
            try:
                search_page_epoch = self.folder_cache.page_epoch_for(rel_path)
            except Exception:
                search_page_epoch = time.time()
        if (
            not incremental_session
            and recursive
            and self.folder_cache is not None
            and hasattr(self.folder_cache, "page_epoch_for")
            and hasattr(self.folder_cache, "ensure_known_subtree")
        ):
            planning_started = time.perf_counter()
            page_epoch = self.folder_cache.page_epoch_for(rel_path)
            ensure_method = self.folder_cache.ensure_known_subtree
            if (
                getattr(self.folder_cache, "supports_record_lookup", False)
                and accepts_keyword(ensure_method, "record_lookup")
            ):
                ensure_result = ensure_method(
                    root_remote_path,
                    page_epoch,
                    record_lookup=record_lookup,
                    trace_dedup=False,
                )
            else:
                ensure_result = ensure_method(root_remote_path, page_epoch)
            planning_elapsed_ms = (time.perf_counter() - planning_started) * 1000
        else:
            planning_elapsed_ms = 0.0

        results: list[dict[str, Any]] = []
        scanned_folder_count = 0
        scanned_direct_item_count = 0
        hydrated_row_count = 0
        missing_listing_count = 0
        scanned_pending_folder_count = 0
        candidate_scan_elapsed = 0.0
        row_hydration_elapsed = 0.0
        seen_remote_paths: set[str] = set()
        queue: list[tuple[str, str]] = [(rel_path, root_remote_path)]
        index = 0

        def root_relative_path(full_path: str) -> str:
            if not rel_path:
                return full_path
            prefix = rel_path.rstrip("/") + "/"
            if full_path == rel_path:
                return ""
            if full_path.startswith(prefix):
                return full_path[len(prefix):]
            return full_path

        scan_cancelled = False
        while index < len(queue):
            if cancel_check is not None and cancel_check():
                scan_cancelled = True
                break
            current_rel_path, current_remote_path = queue[index]
            index += 1
            if current_remote_path in seen_remote_paths:
                continue
            seen_remote_paths.add(current_remote_path)

            folder_data, direct_items = self._cached_direct_items_for_search(
                current_remote_path,
                record_lookup,
            )
            if direct_items is None:
                missing_listing_count += 1
                if incremental_session and self.folder_cache is not None and hasattr(self.folder_cache, "request"):
                    try:
                        self.folder_cache.request(current_remote_path, search_page_epoch)
                    except Exception:
                        pass
                continue

            if incremental_session and isinstance(folder_data, dict) and not folder_data.get("complete"):
                scanned_pending_folder_count += 1

            scanned_folder_count += 1
            scanned_direct_item_count += len(direct_items)
            candidate_started = time.perf_counter()
            candidate_remote_names, candidate_local_names = self._search_candidate_names(
                current_rel_path,
                direct_items,
                query_tokens,
                rel_path,
            )
            listing_metadata = parse_direct_listing(direct_items, current_remote_path)
            candidate_scan_elapsed += (time.perf_counter() - candidate_started) * 1000

            hydration_started = time.perf_counter()
            entries = self._entries_from_remote_items(
                current_rel_path,
                direct_items,
                candidate_remote_names=candidate_remote_names,
                candidate_local_names=candidate_local_names,
            )
            entries = self.sort_entries(entries, "name", "asc")
            current_folder_cache = dict(folder_data) if folder_data is not None else {}
            if self.local_root:
                current_folder_cache["file_statuses"] = self.file_statuses_for_entries(entries)

            folder_cache_map: dict[str, Any] = {}
            for entry in entries:
                if entry["is_dir"] and entry["remote"]:
                    child_rel_path = posixpath.join(current_rel_path, entry["name"]) if current_rel_path else entry["name"]
                    child_remote_path = remote_target(self.remote, child_rel_path)
                    child_folder_data = record_lookup(child_remote_path)
                    folder_cache_map[entry["name"]] = child_folder_data
                    entry["cached_size"] = child_folder_data.get("size") if isinstance(child_folder_data, dict) else None
                    entry["cached_mtime"] = child_folder_data.get("newest_mtime") if isinstance(child_folder_data, dict) else None
                entry["status_label"] = self.status_label_for_entry(
                    entry,
                    folder_cache_map,
                    current_folder_cache,
                )
            hydrated_row_count += len(entries)
            row_hydration_elapsed += (time.perf_counter() - hydration_started) * 1000

            remote_child_paths = {
                str(folder.get("name")): str(folder.get("remote_path"))
                for folder in listing_metadata.direct_folders
                if folder.get("name") and folder.get("remote_path")
            }
            for entry in entries:
                child_rel_path = posixpath.join(current_rel_path, entry["name"]) if current_rel_path else entry["name"]
                result_row = dict(entry)
                result_row["path"] = child_rel_path
                result_row["relative_path"] = root_relative_path(child_rel_path)
                if entry["is_dir"]:
                    result_row["search_child_folder_cache"] = folder_cache_map.get(entry["name"])
                results.append(result_row)
                if on_result is not None:
                    on_result(dict(result_row))

                if recursive and entry["is_dir"] and entry["remote"]:
                    child_remote_path = remote_child_paths.get(entry["name"], remote_target(self.remote, child_rel_path))
                    queue.append((child_rel_path, child_remote_path))

            # A folder can be a candidate only because a descendant path
            # matches. Continue discovering every remote child even when the
            # folder itself was not hydrated into a result row.
            if recursive:
                hydrated_remote_names = {
                    str(entry["name"])
                    for entry in entries
                    if entry["is_dir"] and entry["remote"]
                }
                for child_name, child_remote_path in remote_child_paths.items():
                    if child_name not in hydrated_remote_names:
                        child_rel_path = posixpath.join(current_rel_path, child_name) if current_rel_path else child_name
                        queue.append((child_rel_path, child_remote_path))

            if on_progress is not None:
                on_progress({
                    "scanned_folder_count": scanned_folder_count,
                    "scanned_direct_item_count": scanned_direct_item_count,
                    "hydrated_row_count": hydrated_row_count,
                    "folder_cache_record_read_count": folder_cache_record_read_count,
                    "planning_elapsed_ms": round(planning_elapsed_ms, 3),
                    "candidate_scan_elapsed_ms": round(candidate_scan_elapsed, 3),
                    "row_hydration_elapsed_ms": round(row_hydration_elapsed, 3),
                })

        pending_folder_count = max(
            int(ensure_result.get("pending_folder_count", 0) or 0),
            scanned_pending_folder_count,
        )
        queued_folder_count = int(ensure_result.get("queued_folder_count", 0) or 0)
        missing_folder_count = int(ensure_result.get("missing_folder_count", 0) or 0)
        pending = pending_folder_count > 0 or missing_listing_count > 0
        complete = (
            not scan_cancelled
            and pending_folder_count == 0
            and missing_folder_count == 0
            and missing_listing_count == 0
        )
        if complete:
            cache_status = "complete"
        elif scanned_folder_count > 0 or pending or missing_listing_count > 0:
            cache_status = "partial"
        else:
            cache_status = "unavailable"

        snapshot = CachedRecursiveSearchSnapshot(
            rel_path=rel_path,
            remote_path=root_remote_path,
            query=normalized_query,
            entries=results,
            cache_status=cache_status,
            complete=complete,
            pending=pending,
            pending_folder_count=pending_folder_count,
            queued_folder_count=queued_folder_count,
            missing_folder_count=missing_folder_count,
            missing_listing_count=missing_listing_count,
            scanned_folder_count=scanned_folder_count,
            generated_at=time.time(),
            scanned_direct_item_count=scanned_direct_item_count,
            hydrated_row_count=hydrated_row_count,
            folder_cache_record_read_count=folder_cache_record_read_count,
            planning_elapsed_ms=round(planning_elapsed_ms, 3),
            candidate_scan_elapsed_ms=round(candidate_scan_elapsed, 3),
            row_hydration_elapsed_ms=round(row_hydration_elapsed, 3),
        )
        if snapshot_cache_key is not None and snapshot.complete:
            self._search_snapshot_cache.put(snapshot_cache_key, snapshot)
        return snapshot

    def local_display_path(self, rel_path: str) -> Path | None:
        """Return the actual local path for a displayed Dropbox-relative path.

        Names shown in the browser may come from Dropbox, while Windows local
        files can use compatibility replacements for characters such as ``*``.
        Walk each segment with the same comparison key used by listings so copy
        actions use the path that actually exists on disk when possible.
        """
        if self.local_root is None:
            return None
        return resolve_matching_local_path(self.local_root, rel_path)

    def invalidate_folder_metadata(self, rel_path: str) -> None:
        """Invalidate cached folder totals for this folder and its ancestors."""
        if not self.folder_cache:
            return
        parts = [part for part in rel_path.split("/") if part]
        rel_paths = ["/".join(parts[:i]) for i in range(len(parts), -1, -1)]
        for path in rel_paths:
            self.folder_cache.invalidate(remote_target(self.remote, path))

    def sort_entries(self, entries: list[dict[str, Any]], sort_key: str, direction: str) -> list[dict[str, Any]]:
        reverse = direction == "desc"

        def key(row: dict[str, Any]) -> tuple[Any, str]:
            name = row["name"].lower()
            if sort_key == "type":
                primary = file_type(row["name"], row["is_dir"])
            elif sort_key == "date":
                if row["is_dir"] and row.get("cached_mtime") is not None:
                    primary = row.get("cached_mtime") or 0
                else:
                    primary = max(row.get("remote_mtime") or 0, row.get("local_mtime") or 0)
            elif sort_key == "size":
                if row["is_dir"]:
                    primary = row.get("cached_size") or 0
                else:
                    primary = row.get("remote_size") or row.get("local_size") or 0
            elif sort_key == "status":
                primary = row.get("status_label") or ""
            else:
                primary = name
            return (primary, name)

        folders = sorted((row for row in entries if row["is_dir"]), key=key, reverse=reverse)
        files = sorted((row for row in entries if not row["is_dir"]), key=key, reverse=reverse)
        return folders + files

    def status_label_for_entry(
        self,
        row: dict[str, Any],
        folder_cache_map: dict | None = None,
        current_folder_cache: dict | None = None,
    ) -> str:
        status = "Both" if row["remote"] and row["local"] else "Dropbox Only" if row["remote"] else "Local Only"
        if self.local_root is None:
            return status

        name = row["name"]
        if row["is_dir"]:
            if not row["remote"]:
                return "Local Only"
            if not row["local"]:
                return "Dropbox Only"
            cached = (folder_cache_map or {}).get(name)
            if cached is not None and cached.get("diff_complete"):
                return diff_label(cached.get("diff_status"))
            return "Loading"

        if not row["remote"]:
            return "Local Only"
        if not row["local"]:
            return "Dropbox Only"
        file_status = ((current_folder_cache or {}).get("file_statuses") or {}).get(name, {})
        return diff_label(file_status.get("diff_status"))

    def file_statuses_for_entries(self, entries: list[dict[str, Any]]) -> dict[str, dict[str, str]]:
        """Compute direct file diff status from the live merged listing.

        Folder subtree status is cached, but file rows can be compared cheaply
        from the current direct Dropbox listing and local stat data. This keeps
        local edits made outside the browser from being hidden by stale folder
        cache entries.
        """
        if self.local_root is None:
            return {}
        statuses: dict[str, dict[str, str]] = {}
        for row in entries:
            if row["is_dir"]:
                continue
            name = row["name"]
            if not row["remote"]:
                statuses[name] = {"diff_status": "local_only", "reason": f"Local only: {name}"}
            elif not row["local"]:
                statuses[name] = {"diff_status": "dropbox_only", "reason": f"Dropbox only: {name}"}
            elif (row.get("remote_size") or 0) != (row.get("local_size") or 0):
                statuses[name] = {"diff_status": "has_diffs", "reason": f"Size differs: {name}"}
            else:
                statuses[name] = {"diff_status": "synced"}
        return statuses

    def _direct_batch_rows_from_entries(self, rel_path: str, entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for row in entries:
            name = row["name"]
            child_path = f"{rel_path}/{name}" if rel_path else name
            if row["is_dir"]:
                if not row["remote"]:
                    rows.append({
                        "status": "local_only_dir",
                        "path": child_path,
                        "local_path": row.get("local_path") or str(safe_join_local(self.local_root, child_path)),
                        "remote_path": remote_target(self.remote, child_path),
                    })
                elif not row["local"]:
                    rows.append({
                        "status": "dropbox_only_dir",
                        "path": child_path,
                        "local_path": str(safe_join_local(self.local_root, child_path)),
                        "remote_path": remote_target(self.remote, child_path),
                    })
                continue
            if not row["remote"]:
                rows.append({
                    "status": "local_only",
                    "path": child_path,
                    "local_path": row.get("local_path") or str(safe_join_local(self.local_root, child_path)),
                    "remote_path": remote_target(self.remote, child_path),
                    "size": row.get("local_size") or 0,
                })
            elif not row["local"]:
                rows.append({
                    "status": "dropbox_only",
                    "path": child_path,
                    "local_path": str(safe_join_local(self.local_root, child_path)),
                    "remote_path": remote_target(self.remote, child_path),
                    "size": row.get("remote_size") or 0,
                })
            elif (row.get("remote_size") or 0) != (row.get("local_size") or 0):
                rows.append({
                    "status": "has_diffs",
                    "path": child_path,
                    "local_path": row.get("local_path") or str(safe_join_local(self.local_root, child_path)),
                    "remote_path": remote_target(self.remote, child_path),
                    "local_size": row.get("local_size") or 0,
                    "remote_size": row.get("remote_size") or 0,
                })
        return rows

    def _direct_batch_rows(self, rel_path: str) -> list[dict[str, Any]]:
        entries = self.list_entries(rel_path, force_refresh=True)
        return self._direct_batch_rows_from_entries(rel_path, entries)

    def _is_confirmed_synced_subtree(self, rel_path: str) -> bool:
        if not self.folder_cache:
            return False
        cached = self.folder_cache.get(remote_target(self.remote, rel_path))
        return bool(
            cached
            and cached.get("complete")
            and cached.get("diff_complete")
            and cached.get("diff_status") == "synced"
        )

    def _planning_lsjson(self, remote: str, progress: BatchPlanProgress | None, status_id: str | None = None) -> list[dict[str, Any]]:
        if progress is None:
            return self.rclone.lsjson(remote)
        progress.start()
        if status_id is not None:
            snapshot = progress.snapshot()
            syncstate.update(
                status_id,
                message="Batch planning",
                command=f"rclone lsjson -- {remote}",
                current=snapshot["current"],
                total=snapshot["total"],
            )
        context_factory = getattr(self.rclone, "progress_context", None)
        context = context_factory(progress.text) if context_factory is not None else nullcontext()
        try:
            with context:
                return self.rclone.lsjson(remote)
        finally:
            progress.finish()
            if status_id is not None:
                snapshot = progress.snapshot()
                syncstate.update(
                    status_id,
                    message="Batch planning",
                    command=str(snapshot["text"]),
                    current=snapshot["current"],
                    total=snapshot["total"],
                )

    def _batch_scan(self, rel_path: str, progress: BatchPlanProgress | None = None, status_id: str | None = None) -> tuple[list[str], list[dict[str, Any]]]:
        if self._is_confirmed_synced_subtree(rel_path):
            return [], []
        remote = remote_target(self.remote, rel_path)
        local_folder = resolve_matching_local_path(self.local_root, rel_path) if self.local_root else None
        try:
            remote_items = self._planning_lsjson(remote, progress, status_id=status_id)
        except BrowserError:
            if not (local_folder and local_folder.exists() and local_folder.is_dir()):
                raise
            remote_items = []
        entries = self._entries_from_remote_items(rel_path, remote_items)
        children = [
            f"{rel_path}/{row['name']}" if rel_path else row["name"]
            for row in entries
            if row["is_dir"] and not self._is_confirmed_synced_subtree(f"{rel_path}/{row['name']}" if rel_path else row["name"])
        ]
        return sorted(dict.fromkeys(children), key=str.casefold), self._direct_batch_rows_from_entries(rel_path, entries)

    def _child_folder_paths(self, rel_path: str) -> list[str]:
        remote_children: dict[str, str] = {}
        remote = remote_target(self.remote, rel_path)
        try:
            for item in self.rclone.lsjson(remote):
                name = item.get("Name") or item.get("Path") or ""
                if name and "/" not in name and not is_ignored_name(name) and item.get("IsDir"):
                    remote_children[name] = f"{rel_path}/{name}" if rel_path else name
        except BrowserError:
            pass
        local_children: dict[str, str] = {}
        local_folder = resolve_matching_local_path(self.local_root, rel_path) if self.local_root else None
        if local_folder is not None and local_folder.exists() and local_folder.is_dir():
            for child in local_folder.iterdir():
                if child.is_dir() and not is_ignored_name(child.name):
                    local_children[child.name] = f"{rel_path}/{child.name}" if rel_path else child.name
        matches = match_dropbox_names_to_local_names(remote_children, local_children)
        paths = [remote_children[name] for name in remote_children]
        paths.extend(local_children[name] for name in local_children if name not in set(matches.values()))
        return sorted(dict.fromkeys(paths), key=str.casefold)

    def _batch_rows(self, rel_path: str, recursive: bool, workers: int = 1, status_id: str | None = None) -> list[dict[str, Any]]:
        if recursive:
            return self._batch_rows_parallel(rel_path, workers, status_id=status_id)
        return self._direct_batch_rows(rel_path)

    def _batch_rows_parallel(self, rel_path: str, workers: int, status_id: str | None = None) -> list[dict[str, Any]]:
        progress = BatchPlanProgress()

        def scan(path: str) -> tuple[str, list[str], list[dict[str, Any]]]:
            children, rows = self._batch_scan(path, progress, status_id=status_id)
            return path, children, rows

        results: dict[str, tuple[list[str], list[dict[str, Any]]]] = {}
        scheduled = {rel_path}
        progress.dispatch()
        with ThreadPoolExecutor(max_workers=max(1, workers), thread_name_prefix="sync-plan") as executor:
            pending = {executor.submit(scan, rel_path)}
            while pending:
                done, pending = wait(pending, return_when=FIRST_COMPLETED)
                for future in done:
                    path, children, rows = future.result()
                    results[path] = (children, rows)
                    for child in children:
                        if child in scheduled:
                            continue
                        scheduled.add(child)
                        progress.dispatch()
                        pending.add(executor.submit(scan, child))

        rows: list[dict[str, Any]] = []

        def append_postorder(path: str) -> None:
            children, direct_rows = results[path]
            for child in children:
                append_postorder(child)
            rows.extend(direct_rows)

        append_postorder(rel_path)
        return rows

    def _sync_plan_workers(self) -> int:
        return max(1, int(getattr(self.sync_jobs, "worker_count", 1) or 1))

    def plan_batch_sync(self, rel_path: str, action: str, recursive: bool, status_id: str | None = None) -> dict[str, Any]:
        if self.local_root is None:
            raise BrowserError(HTTPStatus.BAD_REQUEST, "Local comparison is not configured.")
        if action not in {"local_to_dropbox_all", "dropbox_only_to_local_all"}:
            raise BrowserError(HTTPStatus.BAD_REQUEST, "Unsupported batch sync action.")

        if status_id is not None:
            syncstate.update(status_id, message="Batch planning", command=f"Planning {rel_path or '/'}")
        rows = self._batch_rows(rel_path, recursive, workers=self._sync_plan_workers(), status_id=status_id)
        groups: dict[str, list[dict[str, str]]] = {
            "local_dir_to_dropbox": [],
            "local_to_dropbox": [],
            "dropbox_dir_to_local": [],
            "dropbox_to_local": [],
        }
        for row in rows:
            item = {
                "path": row["path"],
                "local_path": row["local_path"],
                "remote_path": row["remote_path"],
            }
            if action == "local_to_dropbox_all":
                if row["status"] == "local_only_dir":
                    groups["local_dir_to_dropbox"].append(item)
                elif row["status"] in {"local_only", "has_diffs"}:
                    item["size"] = row.get("local_size", row.get("size", 0))
                    groups["local_to_dropbox"].append(item)
            elif action == "dropbox_only_to_local_all":
                if row["status"] == "dropbox_only_dir":
                    groups["dropbox_dir_to_local"].append(item)
                elif row["status"] == "dropbox_only":
                    item["size"] = row.get("remote_size", row.get("size", 0))
                    groups["dropbox_to_local"].append(item)
        return {
            "action": action,
            "recursive": recursive,
            "groups": groups,
            "total": sum(len(items) for items in groups.values()),
        }

    @staticmethod
    def _batch_literal(path: Path) -> str:
        text = str(path.resolve())
        if text.startswith("\\\\?\\"):
            extended = text
        elif text.startswith("\\\\"):
            extended = "\\\\?\\UNC\\" + text.lstrip("\\")
        else:
            extended = "\\\\?\\" + text
        return '"' + extended.replace("%", "%%") + '"'

    def local_only_delete_batch(self, rel_path: str, recursive: bool) -> tuple[str, int]:
        if self.local_root is None:
            raise BrowserError(HTTPStatus.BAD_REQUEST, "Local comparison is not configured.")
        rows = self._batch_rows(rel_path, recursive, workers=self._sync_plan_workers())
        local_only_files = [
            row
            for row in rows
            if row.get("status") == "local_only" and row.get("local_path") and Path(row["local_path"]).is_file()
        ]
        local_only_files.sort(key=lambda row: str(row["local_path"]).casefold())
        lines = [
            "@echo off",
            "chcp 65001 >nul",
            "setlocal DisableDelayedExpansion",
            "rem Generated by dropbox_browser. Review before running.",
            "rem Deletes local-only files only; Dropbox files are not touched.",
            f"set /p CONFIRM=Are you sure you want to delete {len(local_only_files)} file(s)? Enter y to continue: ",
            'if /i not "%CONFIRM%"=="y" exit /b 0',
            "",
        ]
        lines.extend(f"del /f /q {self._batch_literal(Path(row['local_path']))}" for row in local_only_files)
        lines.extend(["", "endlocal", ""])
        return "\r\n".join(lines), len(local_only_files)

    def _cleanup_batch_plans_locked(self, now: float | None = None) -> None:
        cutoff = (now if now is not None else time.time()) - self.BATCH_PLAN_TTL_SECONDS
        for token, record in list(self._batch_plans.items()):
            if record.created_at < cutoff:
                self._batch_plans.pop(token, None)

    def store_batch_plan(self, rel_path: str, action: str, recursive: bool, plan: dict[str, Any]) -> str:
        token = uuid.uuid4().hex
        with self._batch_plan_lock:
            self._cleanup_batch_plans_locked()
            self._batch_plans[token] = StoredBatchPlan(
                token=token,
                created_at=time.time(),
                rel_path=rel_path,
                action=action,
                recursive=recursive,
                plan=plan,
            )
        return token

    def consume_batch_plan(self, token: str, rel_path: str, action: str, recursive: bool) -> dict[str, Any]:
        with self._batch_plan_lock:
            self._cleanup_batch_plans_locked()
            record = self._batch_plans.pop(token, None)
        if record is None:
            raise BrowserError(HTTPStatus.BAD_REQUEST, "Batch plan is missing, expired, or already used.")
        if record.rel_path != rel_path or record.action != action or record.recursive != recursive:
            raise BrowserError(HTTPStatus.BAD_REQUEST, "Batch plan does not match the confirmed request.")
        return record.plan

    def start_batch_plan(self, rel_path: str, action: str, recursive: bool) -> str:
        label = f"batch plan {action.replace('_', ' ')}: {rel_path or '/'}"
        op_id = syncstate.start(label)
        syncstate.update(
            op_id,
            percent=0,
            current=0,
            total=0,
            message="Batch planning",
            command=f"Preparing recursive scan for {rel_path or '/'}",
        )

        def run_plan() -> None:
            try:
                plan = self.plan_batch_sync(rel_path, action, recursive, status_id=op_id)
                token = self.store_batch_plan(rel_path, action, recursive, plan)
                syncstate.update(op_id, plan=plan, plan_token=token, total=plan["total"], command="")
                syncstate.complete(op_id, "Batch plan complete")
            except Exception as exc:
                syncstate.fail(op_id, str(exc))

        thread = threading.Thread(target=run_plan, daemon=True, name="sync-batch-plan")
        thread.start()
        return op_id

    def batch_sync_operations(self, plan: dict[str, Any]) -> list[tuple[str, dict[str, str]]]:
        operations: list[tuple[str, dict[str, str]]] = []
        for kind in ("local_dir_to_dropbox", "dropbox_dir_to_local", "local_to_dropbox", "dropbox_to_local"):
            operations.extend((kind, item) for item in plan.get("groups", {}).get(kind, []))
        return operations

    def single_sync_operation(self, rel_path: str, direction: str) -> tuple[str, dict[str, str]]:
        if self.local_root is None:
            raise BrowserError(HTTPStatus.BAD_REQUEST, "Local comparison is not configured.")
        if direction not in {"local_to_dropbox", "dropbox_to_local"}:
            raise BrowserError(HTTPStatus.BAD_REQUEST, "Unsupported sync direction.")
        if direction == "dropbox_to_local":
            local_path = safe_join_local(self.local_root, rel_path)
            remote_rel_path = rel_path
        else:
            local_path = self.local_display_path(rel_path) or safe_join_local(self.local_root, rel_path)
            remote_rel_path = decode_rclone_literal_escapes_path(rel_path)
        return (
            direction,
            {
                "path": rel_path,
                "local_path": str(local_path),
                "remote_path": remote_target(self.remote, remote_rel_path),
            },
        )

    def execute_sync_operation(self, kind: str, item: dict[str, str]) -> None:
        local_path = Path(item["local_path"])
        remote_path = item["remote_path"]
        if kind == "local_to_dropbox":
            if not local_path.is_file():
                raise BrowserError(HTTPStatus.NOT_FOUND, "Local file not found.")
            size_bytes = int(item.get("size") or local_path.stat().st_size)
            self.rclone.copy_file_overwrite(local_path, remote_path, size_bytes=size_bytes)
        elif kind == "local_dir_to_dropbox":
            if not local_path.is_dir():
                raise BrowserError(HTTPStatus.NOT_FOUND, "Local folder not found.")
            parts = [part for part in item["path"].split("/") if part]
            for index in range(1, len(parts) + 1):
                self.rclone.mkdir(remote_target(self.remote, "/".join(parts[:index])))
        elif kind == "dropbox_to_local":
            local_path.parent.mkdir(parents=True, exist_ok=True)
            size_bytes = int(item["size"]) if item.get("size") is not None else None
            self.rclone.copy_file_overwrite(remote_path, local_path, size_bytes=size_bytes)
        elif kind == "dropbox_dir_to_local":
            local_path.mkdir(parents=True, exist_ok=True)
        else:
            raise BrowserError(HTTPStatus.BAD_REQUEST, "Unsupported sync direction.")

    def invalidate_sync_parents(self, parents: list[str] | set[str]) -> None:
        for parent in parents:
            normalized = parent or ""
            if self.listing_cache:
                parts = [part for part in normalized.split("/") if part]
                for index in range(len(parts), -1, -1):
                    ancestor = "/".join(parts[:index])
                    self.listing_cache.invalidate(remote_target(self.remote, ancestor))
            self.invalidate_folder_metadata(normalized)

    def sync_item(self, rel_path: str, direction: str) -> None:
        kind, item = self.single_sync_operation(rel_path, direction)
        self.execute_sync_operation(kind, item)
        self.invalidate_sync_parents({str(Path(rel_path).parent).replace("\\", "/") if str(Path(rel_path).parent) != "." else ""})
