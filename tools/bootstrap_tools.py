#!/usr/bin/env python3
"""Download and extract the runtime tool pack for this platform only."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import ssl
import sys
import tempfile
import urllib.error
import urllib.request
import zipfile
from pathlib import Path


# This script is deliberately standalone: it is used to install the tool pack
# before any installed runtime exists.  Keep its only dependencies in Python's
# standard library so `python tools/bootstrap_tools.py` works from a fresh
# checkout.
PROJECT_ROOT = Path(__file__).resolve().parent.parent
TOOLS_DIR = PROJECT_ROOT / "tools"
PACKS_DIR = PROJECT_ROOT / "tools-packs"
EXTRACT_ROOT = PROJECT_ROOT / ".tools"
MANIFEST_PATH = TOOLS_DIR / "runtime_manifest.json"
STAMP_NAME = ".pack-sha256"
PACK_FORMAT = "dropbox-browser-tool-packs-v1"
DEFAULT_RELEASE_TAG = "tools-v1"
DEFAULT_REPOSITORY = "spotco/dropbox_browser"


def runtime_platform_id() -> str | None:
    """Return the supported pack identifier for this host, if any."""
    machine = platform.machine().lower()
    if sys.platform == "win32":
        return "windows-x64" if machine in {"amd64", "x86_64", "x64", ""} else None
    if sys.platform == "darwin":
        if machine in {"x86_64", "amd64"}:
            return "darwin-x64"
        if machine in {"arm64", "aarch64"}:
            return "darwin-arm64"
    if sys.platform.startswith("linux"):
        if machine in {"x86_64", "amd64"}:
            return "linux-x64"
        if machine in {"aarch64", "arm64"}:
            return "linux-arm64"
    return None


def load_manifest(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("format") != PACK_FORMAT:
        raise ValueError(f"unsupported tool pack manifest format: {data.get('format')!r}")
    return data


def sha256_file(path: Path, *, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def release_asset_url(manifest: dict, platform_id: str) -> str:
    entry = (manifest.get("platforms") or {}).get(platform_id)
    if not isinstance(entry, dict):
        raise KeyError(f"platform {platform_id!r} not in manifest")
    asset = str(entry.get("asset") or "").strip()
    if not asset:
        raise KeyError(f"platform {platform_id!r} missing asset name")
    explicit = str(entry.get("url") or "").strip()
    if explicit:
        return explicit
    base = str(manifest.get("base_url") or "").rstrip("/")
    if base:
        return f"{base}/{asset}"
    repository = str(manifest.get("repository") or DEFAULT_REPOSITORY).strip()
    tag = str(manifest.get("release_tag") or DEFAULT_RELEASE_TAG).strip()
    return f"https://github.com/{repository}/releases/download/{tag}/{asset}"


def first_existing(candidates: list[Path]) -> Path | None:
    for candidate in candidates:
        if candidate.exists():
            return candidate.resolve()
    return None


def read_stamp(platform_root: Path) -> str | None:
    stamp = platform_root / STAMP_NAME
    if not stamp.is_file():
        return None
    return stamp.read_text(encoding="utf-8").strip() or None


def write_stamp(platform_root: Path, sha256: str) -> None:
    platform_root.mkdir(parents=True, exist_ok=True)
    (platform_root / STAMP_NAME).write_text(sha256.strip() + "\n", encoding="utf-8")


def _progress_write(prefix: str, done: int, total: int | None) -> None:
    if total and total > 0:
        pct = min(100.0, 100.0 * done / total)
        sys.stdout.write(f"\r{prefix} {pct:5.1f}% ({done // (1024 * 1024)} / {total // (1024 * 1024)} MiB)")
    else:
        sys.stdout.write(f"\r{prefix} {done // (1024 * 1024)} MiB")
    sys.stdout.flush()


def _ssl_context():
    """Build an SSL context, preferring well-known CA bundles when Python's default trust store is empty."""
    candidates = [
        os.environ.get("SSL_CERT_FILE"),
        os.environ.get("REQUESTS_CA_BUNDLE"),
        "/usr/local/etc/ca-certificates/cert.pem",
        "/etc/ssl/cert.pem",
        "/etc/ssl/certs/ca-certificates.crt",
    ]
    for candidate in candidates:
        if not candidate:
            continue
        path = Path(candidate)
        if path.is_file():
            return ssl.create_default_context(cafile=str(path))
    return ssl.create_default_context()


def download_file(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "dropbox-browser-bootstrap/1.0"},
    )
    try:
        with urllib.request.urlopen(request, timeout=120, context=_ssl_context()) as response:
            total = response.headers.get("Content-Length")
            total_n = int(total) if total and total.isdigit() else None
            done = 0
            with dest.open("wb") as handle:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    handle.write(chunk)
                    done += len(chunk)
                    _progress_write(f"download {dest.name}", done, total_n)
        sys.stdout.write("\n")
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"download failed ({exc.code}): {url}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"download failed: {url} ({exc})") from exc


def extract_pack_zip(zip_path: Path, extract_root: Path) -> Path:
    """Extract pack zip into extract_root; return the platform directory."""
    extract_root.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path, "r") as zf:
        entries = [info for info in zf.infolist() if not info.is_dir()]
        if not entries:
            raise RuntimeError(f"empty pack zip: {zip_path}")
        top = entries[0].filename.split("/", 1)[0]
        if not top or top in {".", ".."}:
            raise RuntimeError(f"invalid top-level pack directory in {zip_path}")
        for info in zf.infolist():
            name = info.filename.replace("\\", "/")
            parts = tuple(part for part in name.split("/") if part)
            if (
                name.startswith("/")
                or not parts
                or parts[0] != top
                or any(part == ".." for part in parts)
            ):
                raise RuntimeError(f"unsafe pack archive member: {info.filename!r}")
        # Remove previous platform dir if present.
        platform_dir = extract_root / top
        if platform_dir.exists():
            shutil.rmtree(platform_dir)
        for info in zf.infolist():
            zf.extract(info, extract_root)
        # Restore executable bits recorded in the zip on POSIX.
        if sys.platform != "win32":
            for info in zf.infolist():
                if info.is_dir():
                    continue
                mode = (info.external_attr >> 16) & 0o777
                if mode & 0o111:
                    target = extract_root / info.filename
                    if target.exists():
                        target.chmod(mode or 0o755)
    if not platform_dir.is_dir():
        raise RuntimeError(f"pack extract missing {platform_dir}")
    return platform_dir


def resolve_local_pack(asset: str, search_dirs: list[Path]) -> Path | None:
    return first_existing([directory / asset for directory in search_dirs if directory is not None])


def bootstrap(
    *,
    platform_id: str | None = None,
    manifest_path: Path = MANIFEST_PATH,
    extract_root: Path = EXTRACT_ROOT,
    packs_dir: Path = PACKS_DIR,
    force: bool = False,
    offline: bool = False,
) -> Path:
    platform_id = platform_id or runtime_platform_id()
    if not platform_id:
        raise RuntimeError(
            f"unsupported platform for tool packs: {sys.platform}/{__import__('platform').machine()}"
        )
    manifest = load_manifest(manifest_path)
    platforms = manifest.get("platforms") or {}
    entry = platforms.get(platform_id)
    if not isinstance(entry, dict):
        available = ", ".join(sorted(platforms)) or "(none)"
        raise RuntimeError(
            f"no tool pack for {platform_id}. Available in manifest: {available}. "
            "Linux packs are not published yet."
        )

    expected_sha = str(entry.get("sha256") or "").strip().lower()
    asset = str(entry.get("asset") or "").strip()
    if not expected_sha or not asset:
        raise RuntimeError(f"manifest entry for {platform_id} is incomplete")

    platform_dir = extract_root / platform_id
    current = read_stamp(platform_dir) if platform_dir.is_dir() else None
    if not force and current and current.lower() == expected_sha:
        print(f"tool pack already installed: {platform_dir} (sha256 match)")
        return platform_dir

    local = resolve_local_pack(
        asset,
        [
            packs_dir,
            PROJECT_ROOT / "tools-packs",
            Path.cwd() / "tools-packs",
        ],
    )

    with tempfile.TemporaryDirectory(prefix="db-bootstrap-") as tmp:
        tmp_path = Path(tmp)
        zip_path = local
        if zip_path is None:
            if offline:
                raise RuntimeError(
                    f"offline mode: place {asset} under tools-packs/ or pass an existing pack"
                )
            url = release_asset_url(manifest, platform_id)
            zip_path = tmp_path / asset
            print(f"fetching {platform_id} pack…")
            print(f"  {url}")
            download_file(url, zip_path)
        else:
            print(f"using local pack: {zip_path}")

        actual = sha256_file(zip_path).lower()
        if actual != expected_sha:
            raise RuntimeError(
                f"sha256 mismatch for {asset}\n  expected: {expected_sha}\n  actual:   {actual}"
            )

        print(f"extracting to {extract_root / platform_id}…")
        platform_dir = extract_pack_zip(zip_path, extract_root)
        write_stamp(platform_dir, expected_sha)

    print(f"installed: {platform_dir}")
    return platform_dir


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", help="override platform id (default: auto-detect)")
    parser.add_argument("--force", action="store_true", help="re-download even if stamp matches")
    parser.add_argument(
        "--offline",
        action="store_true",
        help="only use tools-packs/ local zips (no network)",
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        default=MANIFEST_PATH,
        help="path to runtime_manifest.json",
    )
    args = parser.parse_args(argv)
    try:
        bootstrap(
            platform_id=args.platform,
            manifest_path=args.manifest,
            force=args.force,
            offline=args.offline,
        )
    except Exception as exc:  # noqa: BLE001 - CLI boundary
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    raise SystemExit(main())
