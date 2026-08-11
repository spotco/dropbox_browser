# Platform launch scripts

Helpers live under platform folders so Windows and Intel macOS keep separate
entry points. Every script resolves the **repository root from its own path**,
so you can invoke them from any working directory.

| Platform | Folder |
| --- | --- |
| Windows | [`win/`](win/) |
| Intel macOS | [`osx_intel/`](osx_intel/) |
| Debian/Ubuntu x86_64 | [`linux-deb/`](linux-deb/) |

## Windows (`run/win`)

| Script | Role |
| --- | --- |
| `setup_exe.bat` | Download/install the windows-x64 tool pack into **repo** `.tools/windows-x64/` (not into `run/win`) |
| `clear_exe.bat` | Remove `.tools/`, `tools-packs/`, and legacy Windows tool exes |
| `clear_cache.bat` | Clear FolderInfo/ListingCache JSON and worker-trace temp log |
| `rclone_setup.bat` | Create the Dropbox rclone remote |
| `update.bat` | `git pull origin master` |
| `run_server.bat` | Start the HTTP server |
| `run.bat` | Start server and open the browser |
| `run_select_folder.bat` | Pick local Dropbox folder, then `run.bat` |

Examples (any cwd):

```bat
F:\dev\dropbox_browser\run\win\setup_exe.bat
F:\dev\dropbox_browser\run\win\run.bat
```

## Intel macOS (`run/osx_intel`)

| Script | Role |
| --- | --- |
| `setup_exe.sh` | Download/install the darwin-x64 tool pack into `.tools/` |
| `rclone_setup.sh` | Create the Dropbox rclone remote |
| `update.sh` | `git pull origin master` |
| `run_server.sh` | Start the HTTP server |
| `run.sh` | Start server and open the browser |

```sh
/path/to/dropbox_browser/run/osx_intel/setup_exe.sh
/path/to/dropbox_browser/run/osx_intel/run.sh
```

Shared bootstrap implementation: [`tools/bootstrap_tools.py`](../tools/bootstrap_tools.py).

## Debian/Ubuntu Linux x86_64 (run/linux-deb)

The Linux launcher uses the host python3, matching Intel macOS. The native
tool pack is staged under .tools/linux-x64/; Linux is not yet published as a
GitHub tools-v1 asset.

| Script | Role |
| --- | --- |
| setup_exe.sh | Download/checksum/install native Linux tools into .tools/linux-x64/ |
| rclone_setup.sh | Create the Dropbox rclone remote |
| run_server.sh | Start the HTTP server |
| run.sh | Start the server and open the browser |
