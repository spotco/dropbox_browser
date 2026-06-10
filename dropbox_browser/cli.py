from __future__ import annotations

import argparse
import signal
import sys
import threading
import time
from http.server import ThreadingHTTPServer
from pathlib import Path

from .config import (
    find_default_config,
    find_default_rclone,
    find_dropbox_folder,
    load_app_config,
    load_thumbnail_config,
    load_video_tools_config,
)
from .foldercache import FolderCacheManager
from .handlers import RequestHandler
from . import logoutput, workertrace
from .listingcache import ListingCacheManager
from .rclone import RcloneClient
from .services import DropboxBrowser
from .syncjobs import SyncJobManager


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a stdlib Dropbox browser backed by rclone.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--remote", default="dropbox:")
    parser.add_argument("--rclone", default=find_default_rclone())
    parser.add_argument("--rclone-config", default=find_default_config())
    parser.add_argument("--local-root", default=None)
    parser.add_argument(
        "--client-render",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Enable the client-rendered browse shell.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    started_at = time.time()
    app_config = load_app_config()
    thumbnail_config = load_thumbnail_config(app_config)
    video_tools_config = load_video_tools_config(app_config)
    local_root = Path(args.local_root).resolve() if args.local_root else find_dropbox_folder(app_config)
    if local_root.exists() and not local_root.is_dir():
        print(f"DropboxFolder is not a directory: {local_root}", file=sys.stderr)
        return 2
    local_root.mkdir(parents=True, exist_ok=True)
    trace_run_dir = workertrace.configure_server_run(
        started_at=started_at,
        metadata={
            "host": args.host,
            "port": args.port,
            "remote": args.remote,
            "local_root": str(local_root),
            "client_render": bool(getattr(args, "client_render", False)),
            "thumbnail_enabled": thumbnail_config.enabled,
            "thumbnail_size": thumbnail_config.size,
            "thumbnail_magick_path": str(thumbnail_config.magick_exe) if thumbnail_config.magick_exe else None,
            "video_ffmpeg_path": str(video_tools_config.ffmpeg_exe) if video_tools_config.ffmpeg_exe else None,
            "video_ffprobe_path": str(video_tools_config.ffprobe_exe) if video_tools_config.ffprobe_exe else None,
            "video_compatibility_available": video_tools_config.compatibility_available,
        },
    )

    rclone = RcloneClient(args.rclone, args.rclone_config, log_commands=bool(app_config["LogRcloneCommands"]))
    listing_cache = ListingCacheManager(ttl_seconds=float(app_config["ListingCacheTTLSeconds"]))
    folder_cache = FolderCacheManager(
        rclone,
        workers=int(app_config["FolderCacheWorkers"]),
        ttl_seconds=float(app_config["FolderCacheTTLSeconds"]),
        listing_cache=listing_cache,
        local_root=local_root,
        remote=args.remote,
    )
    rclone.progress_fn = folder_cache.current_progress
    app = DropboxBrowser(
        rclone,
        args.remote,
        local_root,
        folder_cache=folder_cache,
        listing_cache=listing_cache,
        client_render=bool(getattr(args, "client_render", False)),
        thumbnail_config=thumbnail_config,
        video_tools_config=video_tools_config,
    )
    app.sync_jobs = SyncJobManager(app, workers=int(app_config["SyncJobWorkers"]))
    server = ThreadingHTTPServer((args.host, args.port), RequestHandler)
    server.app = app  # type: ignore[attr-defined]
    server.log_requests = bool(app_config["LogHttpRequests"])  # type: ignore[attr-defined]
    server.localhost_only_access = bool(app_config.get("LocalhostOnlyAccess", True))  # type: ignore[attr-defined]
    server.daemon_threads = True  # type: ignore[attr-defined]
    if hasattr(server, "block_on_close"):
        server.block_on_close = False  # type: ignore[attr-defined]
    stop_signal: int | None = None
    shutdown_started = threading.Event()

    def request_shutdown(signum: int, _frame: object) -> None:
        nonlocal stop_signal
        stop_signal = signum
        if shutdown_started.is_set():
            return
        shutdown_started.set()

        def begin_shutdown() -> None:
            try:
                app.shutdown()
            finally:
                server.shutdown()

        threading.Thread(target=begin_shutdown, daemon=True, name="http-server-shutdown").start()

    print(f"Serving {args.remote} at http://{args.host}:{args.port}/")
    print(f"Comparing with local folder: {local_root}")
    if thumbnail_config.enabled:
        print(
            "Thumbnails enabled: "
            f"{thumbnail_config.magick_exe} "
            f"(size={thumbnail_config.size}px timeout={thumbnail_config.timeout_seconds:g}s "
            f"max_input={thumbnail_config.max_input_bytes} bytes)"
        )
    elif thumbnail_config.configured_enabled:
        print("Thumbnails disabled: vendored ImageMagick not found at ImageMagick\\magick.exe")
    else:
        print("Thumbnails disabled by config.")
    if video_tools_config.compatibility_available:
        print(
            "Video compatibility playback enabled: "
            f"ffmpeg={video_tools_config.ffmpeg_exe} ffprobe={video_tools_config.ffprobe_exe}"
        )
    else:
        print("Video compatibility playback unavailable: ffmpeg and/or ffprobe not found; native video only.")
    print(f"Trace log: {trace_run_dir / 'foldercache_threads.jsonl'}")
    logoutput.start()
    previous_sigint = signal.getsignal(signal.SIGINT)
    signal.signal(signal.SIGINT, request_shutdown)
    previous_sigterm = None
    if hasattr(signal, "SIGTERM"):
        previous_sigterm = signal.getsignal(signal.SIGTERM)
        signal.signal(signal.SIGTERM, request_shutdown)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        signal.signal(signal.SIGINT, previous_sigint)
        if previous_sigterm is not None and hasattr(signal, "SIGTERM"):
            signal.signal(signal.SIGTERM, previous_sigterm)
        if stop_signal is not None:
            print(f"\nStopped by signal {stop_signal}.")
        app.shutdown()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
