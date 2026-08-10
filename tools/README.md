# Runtime tool packs

Platform-specific binaries for rclone, FFmpeg/FFprobe, and ImageMagick ship as
GitHub Release assets so a machine only downloads **its** pack.

## Bootstrap (normal use)

From a clone:

```bat
run\win\setup_exe.bat
run\win\run.bat
```

```sh
run/osx_intel/setup_exe.sh
run/osx_intel/run.sh
```

Or call the shared bootstrap directly:

```bat
python tools\bootstrap_tools.py
```

```sh
python3 tools/bootstrap_tools.py
```

`bootstrap_tools.py` reads [`runtime_manifest.json`](runtime_manifest.json),
downloads one zip from the `tools-v1` release URL for the current platform,
verifies SHA-256, and extracts into `.tools/<platform-id>/` (gitignored).

Offline: place the zip under `tools-packs/` and run:

```bat
python tools\bootstrap_tools.py --offline
```

## Platforms

| Id | Status |
| --- | --- |
| `windows-x64` | rclone, ffmpeg/ffprobe, ImageMagick, **portable `python/`** |
| `darwin-x64` | Published from the `osx-intel` branch `tools/osx-intel` tree (slimmed) |
| `linux-x64` | Not yet |

Runtime binaries are **not** tracked in git. Use `setup_exe` / bootstrap, or
point `FFMpegPath` / `PATH` at system installs.

## Maintainer: build and publish

Requires `gh` authenticated (`gh auth login` or `GH_TOKEN`).

```bat
python tools\build_tool_packs.py --publish
```

Build only:

```bat
python tools\build_tool_packs.py
python tools\build_tool_packs.py --platform windows-x64
```

This writes zips under `tools-packs/` (gitignored), updates
`runtime_manifest.json` hashes/URLs, and with `--publish` creates/updates the
`tools-v1` GitHub release assets.
