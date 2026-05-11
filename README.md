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

## Run

```powershell
python dropbox_browser.py --remote dropbox:
```

With a local folder comparison:

```powershell
python dropbox_browser.py --remote dropbox: --local-root "C:\path\to\local\folder"
```

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
--local-root C:\path\to\folder
```

## Safety Rules

- Uploads are create-only.
- Uploads are blocked if a file or folder with the same name already exists in
  the current Dropbox folder.
- When `--local-root` is provided, uploads are also blocked if the same name
  already exists locally in the current folder.
- The server has no delete or overwrite endpoint.

## Notes

Folder listings are loaded from Dropbox using `rclone lsjson`. File previews and
downloads stream bytes through `rclone cat`.
