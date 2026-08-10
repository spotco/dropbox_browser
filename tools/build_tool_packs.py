#!/usr/bin/env python3
"""Build slim platform tool packs from the Windows tree and osx-intel branch."""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

from tool_packs import (
    DEFAULT_RELEASE_TAG,
    DEFAULT_REPOSITORY,
    MANIFEST_PATH,
    PACKS_DIR,
    PROJECT_ROOT,
    WINDOWS_IMAGEMAGICK_FILES,
    empty_manifest,
    is_darwin_imagemagick_keep,
    pack_zip_name,
    save_manifest,
    sha256_file,
)


def _copy_file(src: Path, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dest)


def _stage_windows(staging_root: Path) -> Path:
    platform_root = staging_root / "windows-x64"
    platform_root.mkdir(parents=True, exist_ok=True)

    rclone = PROJECT_ROOT / "rclone.exe"
    ffmpeg = PROJECT_ROOT / "FFmpeg" / "bin" / "ffmpeg.exe"
    ffprobe = PROJECT_ROOT / "FFmpeg" / "bin" / "ffprobe.exe"
    for required in (rclone, ffmpeg, ffprobe):
        if not required.is_file():
            raise FileNotFoundError(f"missing Windows tool: {required}")

    _copy_file(rclone, platform_root / "rclone.exe")
    _copy_file(ffmpeg, platform_root / "ffmpeg.exe")
    _copy_file(ffprobe, platform_root / "ffprobe.exe")

    image_src = PROJECT_ROOT / "ImageMagick"
    image_dest = platform_root / "ImageMagick"
    for name in WINDOWS_IMAGEMAGICK_FILES:
        src = image_src / name
        if not src.is_file():
            raise FileNotFoundError(f"missing ImageMagick file: {src}")
        _copy_file(src, image_dest / name)

    # Optional licenses next to ffmpeg.
    for license_name in ("LICENSE.txt", "README.md"):
        src = PROJECT_ROOT / "FFmpeg" / license_name
        if src.is_file():
            _copy_file(src, platform_root / f"FFmpeg-{license_name}")

    return platform_root


def _export_osx_intel_tree(dest: Path, git_ref: str = "osx-intel") -> Path:
    """Export tools/osx-intel from a git ref into dest.

    Uses ``git archive`` and a custom extract that skips absolute/out-of-tree
    symlinks left by the MacPorts ImageMagick install (those break Python's
    tar safety filter on Windows).
    """
    dest.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        ["git", "-C", str(PROJECT_ROOT), "archive", git_ref, "tools/osx-intel"],
        check=True,
        stdout=subprocess.PIPE,
    )
    import io
    import tarfile

    with tarfile.open(fileobj=io.BytesIO(proc.stdout), mode="r:") as archive:
        _safe_extract_tar(archive, dest)
    exported = dest / "tools" / "osx-intel"
    if not exported.is_dir():
        raise RuntimeError("git archive did not produce tools/osx-intel")
    return exported


def _safe_extract_tar(archive: "tarfile.TarFile", dest: Path) -> None:
    """Extract tar members, skipping absolute/out-of-tree links."""
    import tarfile

    dest = dest.resolve()
    for member in archive.getmembers():
        name = member.name.replace("\\", "/")
        if not name or name.startswith("/") or name.startswith("..") or "/../" in f"/{name}/":
            continue
        target = (dest / name).resolve()
        try:
            target.relative_to(dest)
        except ValueError:
            continue

        if member.isdir():
            target.mkdir(parents=True, exist_ok=True)
            continue

        if member.issym() or member.islnk():
            link = member.linkname or ""
            # Skip MacPorts absolute links (e.g. C:/opt/local/...).
            if not link or link.startswith("/") or ":/" in link[:3] or ":\\" in link[:3]:
                continue
            link_path = Path(link)
            if link_path.is_absolute() or ".." in link_path.parts:
                # Allow relative links that stay inside dest when resolved.
                resolved = (target.parent / link).resolve()
                try:
                    resolved.relative_to(dest)
                except ValueError:
                    continue
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists() or target.is_symlink():
                target.unlink()
            try:
                target.symlink_to(link)
            except OSError:
                # Windows without symlink privilege: materialize later if needed.
                # Prefer copying the pointed-to archive member when it is a file.
                linked_member_name = str((Path(name).parent / link).as_posix())
                try:
                    linked = archive.getmember(linked_member_name)
                except KeyError:
                    continue
                if not linked.isfile():
                    continue
                source = archive.extractfile(linked)
                if source is None:
                    continue
                with source, target.open("wb") as out:
                    shutil.copyfileobj(source, out)
            continue

        if not member.isfile():
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        source = archive.extractfile(member)
        if source is None:
            continue
        with source, target.open("wb") as out:
            shutil.copyfileobj(source, out)



def _stage_darwin_x64(staging_root: Path, osx_source: Path) -> Path:
    platform_root = staging_root / "darwin-x64"
    platform_root.mkdir(parents=True, exist_ok=True)

    bin_src = osx_source / "bin"
    bin_dest = platform_root / "bin"
    for name in ("rclone", "ffmpeg", "ffprobe", "magick"):
        src = bin_src / name
        if not src.is_file():
            raise FileNotFoundError(f"missing osx-intel tool: {src}")
        _copy_file(src, bin_dest / name)

    im_src = osx_source / "imagemagick7"
    if not im_src.is_dir():
        raise FileNotFoundError(f"missing osx-intel ImageMagick tree: {im_src}")

    kept = 0
    for path in im_src.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(im_src).as_posix()
        if not is_darwin_imagemagick_keep(f"imagemagick7/{rel}"):
            continue
        _copy_file(path, platform_root / "imagemagick7" / Path(rel))
        kept += 1
    if kept < 10:
        raise RuntimeError(f"darwin ImageMagick stage looks empty ({kept} files)")

    # Ensure magick launcher remains executable bit in zip via external attr later if needed.
    return platform_root


def _zip_platform_tree(platform_root: Path, zip_path: Path) -> None:
    if zip_path.exists():
        zip_path.unlink()
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    platform_id = platform_root.name
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for path in sorted(platform_root.rglob("*")):
            if not path.is_file():
                continue
            arcname = Path(platform_id, path.relative_to(platform_root)).as_posix()
            # Preserve executable bit for non-Windows scripts/binaries in zip metadata.
            info = zipfile.ZipInfo(arcname)
            info.compress_type = zipfile.ZIP_DEFLATED
            is_exec = path.suffix == "" or path.name in {"magick", "rclone", "ffmpeg", "ffprobe"} or path.name.endswith(
                ".bin"
            )
            if is_exec and platform_id.startswith("darwin"):
                info.external_attr = 0o755 << 16
            else:
                info.external_attr = 0o644 << 16
            with path.open("rb") as handle:
                zf.writestr(info, handle.read())


def build_packs(
    *,
    platforms: list[str],
    release_tag: str,
    repository: str,
    osx_ref: str = "osx-intel",
) -> dict[str, Path]:
    PACKS_DIR.mkdir(parents=True, exist_ok=True)
    built: dict[str, Path] = {}

    with tempfile.TemporaryDirectory(prefix="db-tool-packs-") as tmp:
        tmp_path = Path(tmp)
        staging = tmp_path / "staging"
        staging.mkdir()

        if "windows-x64" in platforms:
            print("staging windows-x64 from working tree…")
            root = _stage_windows(staging)
            zip_path = PACKS_DIR / pack_zip_name("windows-x64", release_tag)
            print(f"  zipping {zip_path.name}…")
            _zip_platform_tree(root, zip_path)
            built["windows-x64"] = zip_path

        if "darwin-x64" in platforms:
            print(f"exporting {osx_ref}:tools/osx-intel…")
            proc = subprocess.run(
                ["git", "-C", str(PROJECT_ROOT), "rev-parse", "--verify", osx_ref],
                capture_output=True,
                text=True,
            )
            if proc.returncode != 0:
                raise RuntimeError(f"git ref {osx_ref!r} not found; need osx-intel branch for darwin pack")
            export_root = tmp_path / "osx-export"
            osx_tree = _export_osx_intel_tree(export_root, git_ref=osx_ref)

            print("staging darwin-x64 (slim ImageMagick runtime)…")
            root = _stage_darwin_x64(staging, osx_tree)
            zip_path = PACKS_DIR / pack_zip_name("darwin-x64", release_tag)
            print(f"  zipping {zip_path.name}…")
            _zip_platform_tree(root, zip_path)
            built["darwin-x64"] = zip_path

    # Update manifest with hashes and URLs.
    if MANIFEST_PATH.is_file():
        import json

        try:
            manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            manifest = empty_manifest(release_tag, repository)
    else:
        manifest = empty_manifest(release_tag, repository)

    manifest["format"] = "dropbox-browser-tool-packs-v1"
    manifest["release_tag"] = release_tag
    manifest["repository"] = repository
    manifest["base_url"] = f"https://github.com/{repository}/releases/download/{release_tag}"
    platforms_map = dict(manifest.get("platforms") or {})

    for platform_id, zip_path in built.items():
        digest = sha256_file(zip_path)
        size = zip_path.stat().st_size
        asset = zip_path.name
        platforms_map[platform_id] = {
            "asset": asset,
            "sha256": digest,
            "size_bytes": size,
            "url": f"https://github.com/{repository}/releases/download/{release_tag}/{asset}",
        }
        print(f"  {platform_id}: {size / (1024 * 1024):.1f} MiB  sha256={digest[:16]}…")

    manifest["platforms"] = platforms_map
    save_manifest(manifest)
    print(f"wrote {MANIFEST_PATH.relative_to(PROJECT_ROOT)}")
    return built


def publish_release(
    *,
    zip_paths: list[Path],
    release_tag: str,
    repository: str,
    title: str | None = None,
    notes: str | None = None,
) -> None:
    """Create or update a GitHub release and upload pack assets via gh."""
    title = title or f"Runtime tools {release_tag}"
    notes = notes or (
        "Platform-specific runtime tool packs for Dropbox Browser "
        "(rclone, ffmpeg, ffprobe, ImageMagick).\n\n"
        "Bootstrap with:\n"
        "  python tools/bootstrap_tools.py\n\n"
        "Only the pack matching your platform is downloaded."
    )

    # Ensure release exists.
    view = subprocess.run(
        ["gh", "release", "view", release_tag, "--repo", repository],
        capture_output=True,
        text=True,
    )
    if view.returncode != 0:
        print(f"creating release {release_tag}…")
        subprocess.run(
            [
                "gh",
                "release",
                "create",
                release_tag,
                "--repo",
                repository,
                "--title",
                title,
                "--notes",
                notes,
            ],
            check=True,
        )
    else:
        print(f"release {release_tag} already exists")

    print("uploading assets…")
    cmd = [
        "gh",
        "release",
        "upload",
        release_tag,
        "--repo",
        repository,
        "--clobber",
        *[str(path) for path in zip_paths],
    ]
    subprocess.run(cmd, check=True)
    print(f"published: https://github.com/{repository}/releases/tag/{release_tag}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--platform",
        action="append",
        dest="platforms",
        choices=("windows-x64", "darwin-x64"),
        help="platform to build (repeatable; default: both)",
    )
    parser.add_argument("--release-tag", default=DEFAULT_RELEASE_TAG)
    parser.add_argument("--repository", default=DEFAULT_REPOSITORY)
    parser.add_argument("--osx-ref", default="osx-intel", help="git ref containing tools/osx-intel")
    parser.add_argument("--publish", action="store_true", help="upload packs with gh release")
    args = parser.parse_args(argv)

    platforms = args.platforms or ["windows-x64", "darwin-x64"]
    built = build_packs(
        platforms=platforms,
        release_tag=args.release_tag,
        repository=args.repository,
        osx_ref=args.osx_ref,
    )
    if args.publish:
        publish_release(
            zip_paths=list(built.values()),
            release_tag=args.release_tag,
            repository=args.repository,
        )
    else:
        print("build complete (pass --publish to upload with gh)")
    return 0


if __name__ == "__main__":
    # Allow `python tools/build_tool_packs.py` without installing a package.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    raise SystemExit(main())
