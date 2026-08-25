# Dropbox Browser

Dropbox Browser is a dependency-free Python web application for browsing
an `rclone` remote, streaming previews and downloads, and optionally comparing
the remote with a local folder. The runtime server uses Python's standard
library HTTP server; `rclone` supplies Dropbox access.

The supported browse shell is client-rendered by default. The page also
contains optional bottom panes for recursive file search, music playback, video
playback, and a GPS Photo Map.

## Distributed E2E worker synchronization

`npm run test:e2e` is distributed by default through
`tools/run_distributed_e2e.py`. Worker synchronization is owned by the shared
`sptmp2_network_computers/python/network_computers/direct_worktree_sync.py`
module. It pins each selected worker to the local current branch and committed
`HEAD`, discards remote non-ignored dirt with a visible intentional warning,
and applies the complete local non-ignored Git-visible worktree by default:
staged, unstaged, untracked, deleted, and renamed files. Spaces, Unicode,
exact bytes, symlinks, hashes, and deletions are verified; ignored files are
excluded. The protocol uses only a local SCP'd Git bundle and direct file
transfer. It never fetches or pushes `origin`, changes `origin/*`, stashes
remote work, or uses `git clean -fdx`.

`--publish-workers auto|always|never` and `--sync-clean` retain their shared
destructive-sync meanings. `--include-worktree` and `--publish-source` remain
compatibility flags; local dirt is not opt-in, and `--publish-source origin`
fails closed. Automatic distributed mode fails instead of silently falling
back to a local-only success; use `npm run test:e2e:local` or `--mode local`
for an explicit local diagnostic.

Assignment is also shared: `network_computers.adaptive_e2e` starts with the
currently available topology when `sptmp2/e2e/adaptive-schedule.json`
is absent, then learns bounded lane duration/size rates from successful local
and remote jobs. The learning file is gitignored and never becomes tracked
source. A matching worker is hash-checked so repeat runs transfer only a
changed branch or overlay.

## Requirements

- POSIX launchers use the local python3/python interpreter (Python 3.9 or
  newer is supported). The Windows tool pack currently embeds CPython 3.14.0;
  on an older local interpreter the server warns at startup and still attempts
  to run.
- Native tools: rclone, FFmpeg/FFprobe, and ImageMagick (`magick`). Install the
  pack for **this platform only** from the GitHub `tools-v1` release:

  ```powershell
  run\win\setup_exe.bat
  ```

  On Windows, setup uses only built-in PowerShell 5.1/.NET APIs to download and
  extract the pack. It installs the only supported Windows Python runtime under
  `.tools\windows-x64\python\`; no system Python, Python packages, or PowerShell
  modules are required. Details: [tools/README.md](tools/README.md).

Useful upstream references:

- [rclone configuration](https://rclone.org/docs/)
- [`rclone lsjson`](https://rclone.org/commands/rclone_lsjson/)
- [`rclone cat`](https://rclone.org/commands/rclone_cat/)
- [FFmpeg documentation](https://ffmpeg.org/documentation.html)
- [ImageMagick command-line processing](https://imagemagick.org/script/command-line-processing.php)

## Start the server

```powershell
run\win\setup_exe.bat
run\win\run.bat
```

On Intel macOS:

```sh
run/osx_intel/setup_exe.sh
run/osx_intel/run.sh
```

Platform helpers live under [`run/`](run/README.md) (`run/win`, `run/osx_intel`) and
resolve the repo root from their own path, so they work from any cwd.

The default address is `http://127.0.0.1:8000/`.

Useful options:

```text
--host 127.0.0.1
--port 8000
--remote dropbox:
--rclone .\rclone.exe
--rclone-config C:\Users\you\AppData\Roaming\rclone\rclone.conf
--local-root C:\path\to\local\copy
--client-render / --no-client-render
```

`--local-root` overrides `DropboxFolder`. `--client-render` is enabled by
default; the legacy `--no-client-render` mode remains available for manual
compatibility checks but is not the maintained or regression-tested browse UI.

The bundled Windows helpers under `run\win\` are also available:

- `run.bat` starts the server using the configured local folder.
- `run_select_folder.bat` chooses a local folder, writes it to
  `config_local.json`, and starts the server.
- `update.bat` pulls `origin/master`.
- `rclone_setup.bat` creates the Dropbox rclone remote.
- `setup_exe.bat` installs platform tool binaries into `.tools\`.

## Configuration

Configuration is layered as built-in defaults, `config.json`, then the optional
machine-local `config_local.json`. Environment variables are expanded in path
settings, and relative `DropboxFolder` paths are resolved from the repository
root. `config_local.json` is intended for local overrides and is ignored by
Git.

A minimal local setup might be:

```json
{
  "DropboxFolder": "./DropboxLocal",
  "RCloneConfig": "%APPDATA%\\rclone\\rclone.conf",
  "LocalhostOnlyAccess": true,
  "FolderCacheWorkers": 4,
  "SyncJobWorkers": 4,
  "FolderCacheTTLSeconds": 1209600,
  "ListingCacheTTLSeconds": 1800,
  "CacheStaticAssets": true
}
```

See [Configuration](docs/configuration.md) for the complete setting reference,
tool discovery order, generated-state locations, video tuning, cache limits,
client diagnostics, and rclone write retry policy.

## Safety and behavior

- The server is local-only by default (`LocalhostOnlyAccess: true`). Binding to
  a non-loopback host does not disable that access check.
- Remote paths are normalized and parent traversal is rejected. Local paths are
  resolved under the configured local root.
- `/file` and `/download` stream through `rclone cat`; ordinary previews and
  downloads are not first copied to an application download directory. Range
  requests and `HEAD` are supported.
- Browser uploads are not supported.
- Sync is an explicit copy operation. It may overwrite the selected destination
  in the selected direction, but never deletes destination-only files.
- The server never executes local delete commands. The local-only batch action
  downloads a `.bat` file for the user to review and run.

## Features and documentation

- [Architecture and ownership](docs/architecture.md)
- [HTTP routes and JSON contracts](docs/http-api.md)
- [Configuration and generated state](docs/configuration.md)
- [Client-rendered browse, filters, search, and thumbnails](docs/browse-ui.md)
- [Background workers, cache epochs, diff status, and sync jobs](docs/background-workers.md)
- [Sync and rclone write behavior](docs/sync-and-rclone.md)
- [Image/video thumbnails and media preview](docs/media-caches.md)
- [Music library, playlists, metadata, and waveforms](docs/music-player.md)
- [Photo Map metadata, grouping, cache, and preview](docs/photo-map.md)
- [Video HLS player and subtitle architecture](docs/video-player.md)
- [Windows-safe name matching](docs/windows-name-matching.md)
- [Testing and regression workflow](docs/testing.md)

The runtime serves vendored Leaflet and marker-cluster assets for Photo Map;
the client uses the [Leaflet reference](https://leafletjs.com/reference.html)
and [Playwright documentation](https://playwright.dev/docs/intro) is useful for
browser-test work.

## Generated state

The application creates local state under `Cache/`, `Temp/`, and
`ThumbnailCache/`. These directories include folder/listing metadata, Photo Map
records, video sessions and disk caches, thumbnail files, run traces, and
diagnostic logs. They are runtime artifacts, not source inputs and should not be
used as test fixtures.

## Tests

Run the Python unit-test groups with:

```bat
run\win\run_python.bat tests.run --list
run\win\run_python.bat tests.run <relevant-group> -v
run\win\run_python.bat unittest discover -s tests -v
```

Run the JavaScript and Playwright suites with:

```powershell
npm install
npm run test:js
npm run test:e2e:client-render
npm run test:e2e:music
npm run test:e2e:video
npm run test:all
```

See [Testing](docs/testing.md) for group aliases, isolated fixtures, focused
Photo Map checks, and the recommended regression sequence.

## Known limits

- Empty local-only folders cannot be copied to Dropbox by the file-based sync
  operations. A recursive copy can create remote folders as a side effect of
  copying contained files, but an empty folder may remain `Local Only`.
- Folder metadata and media-library responses can be partial while background
  folder-cache workers finish. The clients poll and update progressively.
- File Search is recursive but cache-backed: it scans known folder-cache data
  and may return partial results until metadata is available.
- Photo Map currently recognizes remote `.jpg`, `.jpeg`, `.mov`, and `.mp4`
  files. JPEG EXIF GPS and QuickTime location metadata are supported; PNG and
  HEIC are intentionally unsupported by Photo Map.
- Video compatibility playback requires both FFmpeg and FFprobe. Without them,
  the rest of the browser remains available, but HLS compatibility playback and
  video poster generation are unavailable.
