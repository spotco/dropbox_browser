# Unicode Local Source `rclone copyto` Bug

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

### Upload-only Dropbox repro script

For a controlled Dropbox upload repro under `https://www.dropbox.com/home/dropbox_browser`,
run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\plans\unicode_copy_bug\repro_rclone_unicode_copyto.ps1
```

The script:

- creates two local source files under `Temp\rclone-real-repro`
- uploads only under `dropbox:dropbox_browser/rclone-unicode-repro/<timestamp>`
- uploads workaround cases only under `dropbox:dropbox_browser/rclone-unicode-repro-workaround/<timestamp>`
- never deletes anything from Dropbox
- times out each `rclone` call instead of hanging silently

The expected outcome is that the plain control upload succeeds, the filename
containing `？` reproduces the `rclone` local-path failure before upload, and
the workaround uploads provide comparison points.


### Verified workaround
Your instinct is correct — this is a real rclone bug/quirk, and it's a well-known one.

**What's happening:** The filename contains `？` (U+FF1F, FULLWIDTH QUESTION MARK). On Windows, rclone's local backend encoder maps certain Unicode "fullwidth" punctuation characters — specifically the ones that are illegal in Windows filenames (`:`, `?`, `*`, `<`, `>`, `|`, `\`, `"`) — to their fullwidth Unicode equivalents as an escape mechanism. The problem is that when rclone is given a *source path* that already contains one of these fullwidth characters, it escapes it *again* with the `‛` (U+201B, SINGLE HIGH-REVERSED-9 QUOTATION MARK) prefix, mangling the path so Windows can't find it.

So `？` (fullwidth question mark) in the source path gets double-encoded into something that no longer resolves to the real file — hence "directory not found" even though the file is right there.

**This is the same class of bug as** [rclone issue #5512](https://github.com/rclone/rclone/issues/5512) (Unicode colon causing identical failure, same error message, same root cause in the encoder). It was reported in 2021 and similar variants have appeared since.

**Workaround:** Pass `--local-encoding` to strip the offending character classes from the encoder. The fullwidth question mark maps from `Question`, so try:

```powershell
.\rclone.exe copyto --local-encoding "Slash,LtGt,DoubleQuote,Asterisk,Pipe,BackSlash,Ctl,RightSpace,RightPeriod,InvalidUtf8,Dot" -- $bad $dest
```

(That's the default Windows local encoding with `Colon` and `Question` removed.) Or the blunter option:

```powershell
.\rclone.exe copyto --local-encoding None -- $bad $dest
```

`--local-encoding None` disables the encoding entirely and passes the raw path through, which works as long as you're copying *to* somewhere that can handle the characters.

This workaround was verified here against both the controlled repro file and the
real path:

```text
F:\Dropbox\music\sdvx4\0287 - U.N.オーエンは彼女なのか？(TO-HOlic mix).mp3
```

Plain `rclone copyto` fails, while `--local-encoding "Slash,LtGt,DoubleQuote,Asterisk,Pipe,BackSlash,Ctl,RightSpace,RightPeriod,InvalidUtf8,Dot"`
and `--local-encoding None` both succeed.