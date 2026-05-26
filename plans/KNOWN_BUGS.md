# Known Bugs

## rclone `copyto` fails on some Windows local source filenames

On Windows, `rclone copyto` can fail to read certain existing local source files
that contain Unicode punctuation in the filename. In this repo, the failure was
reproduced with:

```text
F:\Dropbox\music\sdvx4\0287 - U.N.オーエンは彼女なのか？(TO-HOlic mix).mp3
```

The file exists and is readable from Python/PowerShell, but `rclone copyto`
fails before any Dropbox upload happens.

### Exact local repro

From the repository root:

```powershell
Set-Location 'E:\dev\dropbox_browser'
```

Verify the file exists to Windows:

```powershell
$bad = 'F:\Dropbox\music\sdvx4\0287 - U.N.オーエンは彼女なのか？(TO-HOlic mix).mp3'
Test-Path -LiteralPath $bad
```

Expected result:

```text
True
```

Try `rclone copyto` to a local temp destination:

```powershell
$bad = 'F:\Dropbox\music\sdvx4\0287 - U.N.オーエンは彼女なのか？(TO-HOlic mix).mp3'
$dest = Join-Path $env:TEMP 'rclone-bad-copy-test.mp3'
Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue
.\rclone.exe copyto -- $bad $dest
```

Observed result:

```text
2026/05/25 23:08:09 ERROR : Local file system at //?/F:/Dropbox/music/sdvx4/0287 - U.N.オーエンは彼女なのか？(TO-HOlic mix).mp3: error reading source root directory: directory not found
2026/05/25 23:08:09 ERROR : Attempt 1/3 failed with 1 errors and: directory not found
2026/05/25 23:08:09 ERROR : Local file system at //?/F:/Dropbox/music/sdvx4/0287 - U.N.オーエンは彼女なのか？(TO-HOlic mix).mp3: error reading source root directory: directory not found
2026/05/25 23:08:09 ERROR : Attempt 2/3 failed with 1 errors and: directory not found
2026/05/25 23:08:09 ERROR : Local file system at //?/F:/Dropbox/music/sdvx4/0287 - U.N.オーエンは彼女なのか？(TO-HOlic mix).mp3: error reading source root directory: directory not found
2026/05/25 23:08:09 ERROR : Attempt 3/3 failed with 1 errors and: directory not found
2026/05/25 23:08:09 NOTICE: Failed to copyto: directory not found
```

### Control case

A normal file in the same folder succeeds:

```powershell
$good = 'F:\Dropbox\music\sdvx4\0231 - honey trap.mp3'
$dest = Join-Path $env:TEMP 'rclone-good-copy-test.mp3'
Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue
.\rclone.exe copyto -- $good $dest
```

Expected result:

```text
exit code 0
```

This isolates the problem to `rclone` handling of the local source path, not
the browser sync route or the Dropbox remote.
