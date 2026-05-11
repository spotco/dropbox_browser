from __future__ import annotations

import argparse
from pathlib import Path
import sys
from http.server import ThreadingHTTPServer

from .config import find_default_config, find_default_rclone
from .handlers import RequestHandler
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

    app = DropboxBrowser(RcloneClient(args.rclone, args.rclone_config), args.remote, args.local_root)
    server = ThreadingHTTPServer((args.host, args.port), RequestHandler)
    server.app = app  # type: ignore[attr-defined]

    print(f"Serving {args.remote} at http://{args.host}:{args.port}/")
    if args.local_root:
        print(f"Comparing with local folder: {args.local_root.resolve()}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    return 0
