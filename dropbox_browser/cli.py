from __future__ import annotations

import argparse
from pathlib import Path
import sys
from http.server import ThreadingHTTPServer

from .config import find_default_config, find_default_rclone, load_app_config
from .foldercache import FolderCacheManager
from .handlers import RequestHandler
from . import logoutput
from .listingcache import ListingCacheManager
from .rclone import RcloneClient
from .services import DropboxBrowser


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a stdlib Dropbox browser backed by rclone.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--remote", default="dropbox:")
    parser.add_argument("--local-root", type=Path)
    parser.add_argument("--rclone", default=find_default_rclone())
    parser.add_argument("--rclone-config", default=find_default_config())
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.local_root and not args.local_root.is_dir():
        print(f"Local root is not a directory: {args.local_root}", file=sys.stderr)
        return 2

    app_config = load_app_config()
    rclone = RcloneClient(args.rclone, args.rclone_config, log_commands=bool(app_config["LogRcloneCommands"]))
    listing_cache = ListingCacheManager(ttl_minutes=float(app_config["ListingCacheTTLMinutes"]))
    folder_cache = FolderCacheManager(
        rclone,
        workers=int(app_config["FolderCacheWorkers"]),
        ttl_hours=float(app_config["FolderCacheTTLHours"]),
        listing_cache=listing_cache,
        local_root=args.local_root,
        remote=args.remote,
    )
    rclone.progress_fn = folder_cache.current_progress
    app = DropboxBrowser(rclone, args.remote, args.local_root, folder_cache=folder_cache, listing_cache=listing_cache)
    server = ThreadingHTTPServer((args.host, args.port), RequestHandler)
    server.app = app  # type: ignore[attr-defined]
    server.log_requests = bool(app_config["LogHttpRequests"])  # type: ignore[attr-defined]

    print(f"Serving {args.remote} at http://{args.host}:{args.port}/")
    if args.local_root:
        print(f"Comparing with local folder: {args.local_root.resolve()}")
    logoutput.start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    return 0

