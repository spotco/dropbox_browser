#!/usr/bin/env python3
"""Download and extract the runtime tool pack for this platform only."""

from __future__ import annotations

import argparse
import shutil
import sys
import tempfile
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

from tool_packs import (
    EXTRACT_ROOT,
    MANIFEST_PATH,
    PACKS_DIR,
    PROJECT_ROOT,
    first_existing,
    load_manifest,
    read_stamp,
    release_asset_url,
    runtime_platform_id,
    sha256_file,
    write_stamp,
)


def _progress_write(prefix: str, done: int, total: int | None) -> None:
    if total and total > 0:
        pct = min(100.0, 100.0 * done / total)
        sys.stdout.write(f"\r{prefix} {pct:5.1f}% ({done // (1024 * 1024)} / {total // (1024 * 1024)} MiB)")
    else:
        sys.stdout.write(f"\r{prefix} {done // (1024 * 1024)} MiB")
    sys.stdout.flush()


def download_file(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "dropbox-browser-bootstrap/1.0"},
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
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
        names = [info.filename for info in zf.infolist() if not info.is_dir()]
        if not names:
            raise RuntimeError(f"empty pack zip: {zip_path}")
        top = names[0].split("/")[0]
        # Remove previous platform dir if present.
        platform_dir = extract_root / top
        if platform_dir.exists():
            shutil.rmtree(platform_dir)
        zf.extractall(extract_root)
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
