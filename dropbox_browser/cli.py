from __future__ import annotations

import argparse
import os
import signal
import ssl
import sys
import threading
import time
from http.server import ThreadingHTTPServer
from pathlib import Path
from socket import gethostname

from .config import (
    find_default_config,
    find_default_rclone,
    find_dropbox_folder,
    load_app_config,
    load_thumbnail_config,
    load_video_tools_config,
    normalize_music_waveform_cache_entry_limit,
    normalize_music_waveform_max_resolution,
    python_version_warning,
)
from .clientlog import client_log_config
from .dev_tls import DevTlsUnavailable, default_dev_tls_directory, ensure_dev_tls_material
from .foldercache import FolderCacheManager
from .handlers import RequestHandler
from . import logoutput, workertrace
from .listingcache import ListingCacheManager
from .rclone import RcloneClient, write_retry_policy_from_config
from .services import DropboxBrowser
from .syncjobs import SyncJobManager

MIN_PORT = 1
MAX_PORT = 65535


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
    parser.add_argument(
        "--https",
        action="store_true",
        help="Also serve HTTPS on --https-port (default: --port + 1) using generated dev TLS material.",
    )
    parser.add_argument(
        "--https-port",
        type=int,
        default=None,
        help="HTTPS listen port (default: --port + 1, or DROPBOX_BROWSER_HTTPS_PORT).",
    )
    parser.add_argument(
        "--https-optional",
        action="store_true",
        help="Keep HTTP available if HTTPS cannot be prepared or started.",
    )
    parser.add_argument(
        "--https-required",
        action="store_true",
        help="Exit if HTTPS cannot be prepared or started.",
    )
    parser.add_argument(
        "--tls-dir",
        type=Path,
        default=None,
        help="Directory for auto-generated dev TLS material (default: Temp/dev-https).",
    )
    parser.add_argument(
        "--tls-cert",
        type=Path,
        default=None,
        help="Optional PEM server certificate (default: generate under --tls-dir).",
    )
    parser.add_argument(
        "--tls-key",
        type=Path,
        default=None,
        help="Optional PEM server private key (default: generate under --tls-dir).",
    )
    return parser.parse_args()


def warn_if_python_too_old() -> None:
    warning = python_version_warning()
    if warning:
        print(f"Warning: {warning}", file=sys.stderr)


def binds_all_interfaces(host: str) -> bool:
    return host in ("", "0.0.0.0", "::")


def resolve_listen_ports(
    http_port: int,
    https_port: int | None,
    *,
    enable_https: bool,
) -> tuple[int, int | None]:
    if not (MIN_PORT <= http_port <= MAX_PORT):
        raise ValueError(f"HTTP port must be between {MIN_PORT} and {MAX_PORT}, not {http_port}")
    if not enable_https:
        return http_port, None
    resolved_https = https_port
    if resolved_https is None:
        env_port = os.environ.get("DROPBOX_BROWSER_HTTPS_PORT", "").strip()
        if env_port:
            try:
                resolved_https = int(env_port)
            except ValueError as exc:
                raise ValueError(f"DROPBOX_BROWSER_HTTPS_PORT must be an integer, not {env_port!r}") from exc
        else:
            resolved_https = http_port + 1
    if not (MIN_PORT <= resolved_https <= MAX_PORT):
        raise ValueError(
            f"HTTPS port must be between {MIN_PORT} and {MAX_PORT}, not {resolved_https} "
            f"(HTTP port is {http_port})"
        )
    if resolved_https == http_port:
        raise ValueError("HTTP and HTTPS ports must be different")
    return http_port, resolved_https


def dev_tls_directory(args: argparse.Namespace) -> Path:
    if args.tls_dir is not None:
        return args.tls_dir
    env_dir = os.environ.get("DROPBOX_BROWSER_TLS_DIR", "").strip()
    if env_dir:
        return Path(env_dir)
    return default_dev_tls_directory()


def resolve_tls_material(
    args: argparse.Namespace,
    *,
    https_required: bool,
) -> tuple[Path, Path] | None:
    if (args.tls_cert is None) != (args.tls_key is None):
        raise ValueError("--tls-cert and --tls-key must be supplied together")
    if args.tls_cert is not None and args.tls_key is not None:
        cert_path = args.tls_cert.resolve()
        key_path = args.tls_key.resolve()
        if not cert_path.is_file():
            raise FileNotFoundError(f"--tls-cert is not a file: {cert_path}")
        if not key_path.is_file():
            raise FileNotFoundError(f"--tls-key is not a file: {key_path}")
        return cert_path, key_path

    tls_dir = dev_tls_directory(args).resolve()
    try:
        return ensure_dev_tls_material(tls_dir)
    except DevTlsUnavailable as error:
        if https_required:
            raise
        print(f"WARNING: {error}", file=sys.stderr)
        print("WARNING: HTTPS is unavailable; continuing with HTTP only.", file=sys.stderr)
        return None


def _configure_server(
    server: ThreadingHTTPServer,
    app: DropboxBrowser,
    app_config: dict[str, object],
    *,
    internal_http_port: int,
) -> None:
    server.app = app  # type: ignore[attr-defined]
    server.log_requests = bool(app_config["LogHttpRequests"])  # type: ignore[attr-defined]
    server.cache_static_assets = bool(app_config.get("CacheStaticAssets", True))  # type: ignore[attr-defined]
    server.localhost_only_access = bool(app_config.get("LocalhostOnlyAccess", True))  # type: ignore[attr-defined]
    server.internal_http_port = int(internal_http_port)  # type: ignore[attr-defined]
    server.daemon_threads = True  # type: ignore[attr-defined]
    if hasattr(server, "block_on_close"):
        server.block_on_close = False  # type: ignore[attr-defined]


def create_https_server(
    address: tuple[str, int],
    app: DropboxBrowser,
    app_config: dict[str, object],
    cert_path: Path,
    key_path: Path,
    *,
    internal_http_port: int,
) -> ThreadingHTTPServer:
    https_server = ThreadingHTTPServer(address, RequestHandler)
    _configure_server(https_server, app, app_config, internal_http_port=internal_http_port)
    try:
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(certfile=str(cert_path), keyfile=str(key_path))
        https_server.socket = tls.wrap_socket(https_server.socket, server_side=True)
    except (OSError, ssl.SSLError, ValueError, OverflowError):
        https_server.server_close()
        raise
    return https_server


def print_listen_urls(
    *,
    host: str,
    http_port: int,
    https_port: int | None,
    remote: str,
    self_signed_https: bool,
) -> None:
    print(f"Listening for {remote} on http://127.0.0.1:{http_port}/ (localhost HTTP)")
    if binds_all_interfaces(host):
        hostname = gethostname()
        if hostname and hostname.lower() != "localhost":
            print(
                f"  LAN HTTP when LocalhostOnlyAccess is false: "
                f"http://{hostname}:{http_port}/"
            )
    elif host not in ("127.0.0.1", "localhost", "::1"):
        print(f"  HTTP bind address: http://{host}:{http_port}/")

    if https_port is None:
        return

    print(f"Listening for {remote} on https://127.0.0.1:{https_port}/ (localhost HTTPS)")
    if binds_all_interfaces(host):
        hostname = gethostname()
        if hostname and hostname.lower() != "localhost":
            print(
                f"  LAN HTTPS when LocalhostOnlyAccess is false: "
                f"https://{hostname}:{https_port}/"
            )
    elif host not in ("127.0.0.1", "localhost", "::1"):
        print(f"  HTTPS bind address: https://{host}:{https_port}/")
    if self_signed_https:
        print(
            "  Browsers will warn: local self-signed development certificate "
            "(not automatically trusted)."
        )


def _abort_startup(
    *,
    app: DropboxBrowser,
    http_server: ThreadingHTTPServer | None,
    https_server: ThreadingHTTPServer | None,
    message: str,
    code: int = 1,
) -> int:
    if https_server is not None:
        https_server.server_close()
    if http_server is not None:
        http_server.server_close()
    app.shutdown()
    print(message, file=sys.stderr)
    return code


def _https_required(args: argparse.Namespace) -> bool:
    return bool(args.https_required) or os.environ.get("DROPBOX_BROWSER_REQUIRE_HTTPS") == "1"


def main() -> int:
    warn_if_python_too_old()
    args = parse_args()
    serve_https = bool(args.https)
    https_required = _https_required(args)
    https_optional = bool(args.https_optional) or (serve_https and not https_required)

    try:
        http_port, https_port = resolve_listen_ports(args.port, args.https_port, enable_https=serve_https)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 2

    tls_material: tuple[Path, Path] | None = None
    self_signed_https = False
    if serve_https:
        try:
            tls_material = resolve_tls_material(args, https_required=https_required)
        except (ValueError, FileNotFoundError, DevTlsUnavailable) as error:
            print(str(error), file=sys.stderr)
            return 2 if isinstance(error, ValueError) else 1
        if tls_material is None:
            serve_https = False
            https_port = None
        elif args.tls_cert is None and args.tls_key is None:
            self_signed_https = True

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
            "port": http_port,
            "https_port": https_port,
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
    rclone.write_retry_policy = write_retry_policy_from_config(app_config)
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
    app.video_debug_logs = bool(app_config.get("LogVideoDebug", False))
    app.client_log_enabled, app.client_log_subsystems = client_log_config(app_config)
    app.music_waveform_cache_entry_limit = normalize_music_waveform_cache_entry_limit(
        app_config.get("MusicWaveformCacheEntryLimit")
    )
    app.music_waveform_max_resolution = normalize_music_waveform_max_resolution(
        app_config.get("MusicWaveformMaxResolution")
    )
    app.video_subtitle_font_family = str(
        app_config.get("VideoSubtitleFontFamily", "Arial, Helvetica, sans-serif")
    ).strip() or "Arial, Helvetica, sans-serif"
    app.video_subtitle_font_size_px = max(10, int(app_config.get("VideoSubtitleFontSizePx", 28) or 28))
    app.video_subtitle_bold = bool(app_config.get("VideoSubtitleBold", True))
    app.video_probe_cache_ttl_seconds = max(
        0,
        int(app_config.get("VideoProbeCacheTTLSeconds", 7 * 24 * 60 * 60) or (7 * 24 * 60 * 60)),
    )
    app.video_probe_cache_max_bytes = max(
        0,
        int(app_config.get("VideoProbeCacheMaxBytes", 50 * 1024 * 1024) or (50 * 1024 * 1024)),
    )
    app.video_subtitle_cache_ttl_seconds = max(
        0,
        int(app_config.get("VideoSubtitleCacheTTLSeconds", 7 * 24 * 60 * 60) or (7 * 24 * 60 * 60)),
    )
    app.video_subtitle_cache_max_bytes = max(
        0,
        int(app_config.get("VideoSubtitleCacheMaxBytes", 200 * 1024 * 1024) or (200 * 1024 * 1024)),
    )
    app.video_header_cache_ttl_seconds = max(
        0,
        int(app_config.get("VideoHeaderCacheTTLSeconds", 24 * 60 * 60) or (24 * 60 * 60)),
    )
    app.video_header_cache_max_bytes = max(
        0,
        int(app_config.get("VideoHeaderCacheMaxBytes", 500 * 1024 * 1024) or (500 * 1024 * 1024)),
    )
    app.video_header_cache_bytes = max(
        0,
        int(app_config.get("VideoHeaderCacheBytes", 8 * 1024 * 1024) or (8 * 1024 * 1024)),
    )
    app.video_probe_probe_size_bytes = max(
        32,
        int(app_config.get("VideoProbeProbeSizeBytes", 2 * 1024 * 1024) or (2 * 1024 * 1024)),
    )
    app.video_probe_analyze_duration_us = max(
        0,
        int(app_config.get("VideoProbeAnalyzeDurationUs", 3_000_000) or 3_000_000),
    )
    app.sync_jobs = SyncJobManager(app, workers=int(app_config["SyncJobWorkers"]))
    server = ThreadingHTTPServer((args.host, http_port), RequestHandler)
    _configure_server(server, app, app_config, internal_http_port=http_port)

    https_server: ThreadingHTTPServer | None = None
    https_thread: threading.Thread | None = None
    if serve_https and tls_material is not None:
        cert_path, key_path = tls_material
        try:
            https_server = create_https_server(
                (args.host, https_port),
                app,
                app_config,
                cert_path,
                key_path,
                internal_http_port=http_port,
            )
        except (OSError, ssl.SSLError, ValueError, OverflowError, FileNotFoundError) as error:
            if https_server is not None:
                https_server.server_close()
                https_server = None
            if https_required or not https_optional:
                return _abort_startup(
                    app=app,
                    http_server=server,
                    https_server=None,
                    message=f"could not start HTTPS listener: {error}",
                )
            print(
                f"WARNING: HTTPS listener unavailable; continuing with HTTP only: {error}",
                file=sys.stderr,
            )
            https_port = None

    stop_signal: int | None = None
    shutdown_started = threading.Event()
    app_shutdown_lock = threading.Lock()
    app_shutdown_done = False

    def shutdown_app_once() -> None:
        nonlocal app_shutdown_done
        with app_shutdown_lock:
            if app_shutdown_done:
                return
            app_shutdown_done = True
            app.shutdown()

    def request_shutdown(signum: int, _frame: object) -> None:
        nonlocal stop_signal
        stop_signal = signum
        if shutdown_started.is_set():
            return
        shutdown_started.set()

        def begin_shutdown() -> None:
            server.shutdown()
            if https_server is not None:
                https_server.shutdown()

        threading.Thread(target=begin_shutdown, daemon=True, name="http-server-shutdown").start()

    print_listen_urls(
        host=args.host,
        http_port=http_port,
        https_port=https_port if https_server is not None else None,
        remote=args.remote,
        self_signed_https=self_signed_https and https_server is not None,
    )
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
    if https_server is not None:
        https_thread = threading.Thread(
            target=https_server.serve_forever,
            name="dropbox-browser-https",
            daemon=True,
        )
        https_thread.start()
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
        if https_server is not None:
            https_server.shutdown()
        server.shutdown()
        shutdown_app_once()
        if https_server is not None:
            https_server.server_close()
        if https_thread is not None:
            https_thread.join(timeout=5)
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
