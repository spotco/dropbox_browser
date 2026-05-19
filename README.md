# Dropbox Browser

A small Python standard-library web server for browsing and downloading Dropbox
files through `rclone`. It can optionally compare the current Dropbox folder with
a local folder and show which files exist only on one side.

No Python web framework is required.

## Prerequisites

- Python 3.10+
- `rclone` configured with a Dropbox remote

This repository includes `rclone.exe`. The server defaults to reading the rclone
config path from `config.json` (`RCloneConfig` property) when that file exists.

Useful `config.json` settings in the repository root:

```json
{
  "DropboxFolder": "./DropboxLocal",
  "RCloneConfig": "%APPDATA%\\rclone\\rclone.conf",
  "LogRcloneCommands": true,
  "LogHttpRequests": true,
  "FolderCacheWorkers": 4,
  "SyncJobWorkers": 4,
  "FolderCacheTTLSeconds": 86400,
  "ListingCacheTTLSeconds": 1800
}
```

- `DropboxFolder` is the local folder compared with Dropbox. Relative paths are
  resolved from the repository root, and the default is `./DropboxLocal`.
- `config_local.json`, when present, overrides `config.json` properties and is
  ignored by git for machine-local settings.
- `FolderCacheWorkers` controls the background folder metadata/diff worker pool.
- `SyncJobWorkers` controls the browser-triggered sync/delete worker pool.
- `FolderCacheTTLSeconds` and `ListingCacheTTLSeconds` tune cache freshness.

## Run

```powershell
python dropbox_browser.py --remote dropbox:
```

Or use the bundled Windows scripts:

- `run.bat` starts the server using `DropboxFolder` from `config.json`.
- `run_select_folder.bat` opens a folder picker, writes the selected folder to
  `DropboxFolder` in `config_local.json`, then starts the server.

Then open:

```text
http://127.0.0.1:8000/
```

Useful options:

```text
--host 127.0.0.1
--port 8000
--rclone .\rclone.exe
--rclone-config C:\Users\you\AppData\Roaming\rclone\rclone.conf
```

## Safety Rules

- The server has no delete endpoint.
- Browser uploads are not supported.
- File sync, when enabled in the browser, is copy-only and may overwrite the
  selected destination file. It does not delete destination-only files.

## Tests

Run the full unit suite:

```powershell
python -m unittest discover -s tests -v
```

Run grouped test categories:

```powershell
python -m tests.run --list
python -m tests.run web rclone -v
python -m tests.run --group file-sync --group background-file-info
```

Common groups include `web`, `streaming`, `file-sync`, `background-file-info`,
`diff`, `cache`, `names`, and `rclone`.

## Developer Notes

Focused maintenance notes live under `docs/`:

- `docs/architecture.md` - behavior and module ownership map.
- `docs/background-workers.md` - folder-cache workers, diff status, sync jobs,
  and trace logs.
- `docs/windows-name-matching.md` - Windows-safe Dropbox/local filename rules.
- `docs/testing.md` - grouped tests and regression workflow.

## Known Bugs

- Empty local-only folders do not sync to Dropbox because current sync operations
  are file-based. Recursive local-to-Dropbox sync creates remote folders as a
  side effect of copying contained files, but an empty folder can still remain
  `Local Only`.
- Folder rows do not expose single-item sync forms. Sync controls currently
  apply to file rows and batch actions.

## Notes

Folder listings are loaded from Dropbox using `rclone lsjson`. File previews and
downloads stream bytes through `rclone cat`.
