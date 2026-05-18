from __future__ import annotations

import argparse
import sys
from http.server import ThreadingHTTPServer

from .config import find_default_config, find_default_rclone, find_dropbox_folder, load_app_config
from .foldercache import FolderCacheManager
from .handlers import RequestHandler
from . import logoutput
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
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    app_config = load_app_config()
    local_root = find_dropbox_folder(app_config)
    if local_root.exists() and not local_root.is_dir():
        print(f"DropboxFolder is not a directory: {local_root}", file=sys.stderr)
        return 2
    local_root.mkdir(parents=True, exist_ok=True)

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
    app = DropboxBrowser(rclone, args.remote, local_root, folder_cache=folder_cache, listing_cache=listing_cache)
    app.sync_jobs = SyncJobManager(app, workers=int(app_config["SyncJobWorkers"]))
    server = ThreadingHTTPServer((args.host, args.port), RequestHandler)
    server.app = app  # type: ignore[attr-defined]
    server.log_requests = bool(app_config["LogHttpRequests"])  # type: ignore[attr-defined]

    print(f"Serving {args.remote} at http://{args.host}:{args.port}/")
    print(f"Comparing with local folder: {local_root}")
    logoutput.start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    return 0
