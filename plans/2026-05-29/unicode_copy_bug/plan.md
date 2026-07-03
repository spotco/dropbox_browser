# Plan: implement the Windows Unicode local-source sync fix

## Goal

Make browser-driven local-to-Dropbox file sync succeed on Windows for local
source filenames that already contain rclone's fullwidth compatibility
characters, including:

```text
F:\Dropbox\music\sdvx4\0287 - U.N.オーエンは彼女なのか？(TO-HOlic mix).mp3
```

After this plan is implemented, all normal local-to-Dropbox file syncs should
continue working, and files with names like the path above should sync without
special manual steps.

## Planned implementation

1. Add a Windows-only local-source encoding helper in `dropbox_browser/rclone.py`.
   Centralize the verified workaround string
   `Slash,LtGt,DoubleQuote,Asterisk,Pipe,BackSlash,Ctl,RightSpace,RightPeriod,InvalidUtf8,Dot`
   behind a named constant/helper instead of scattering raw CLI args.

2. Apply that helper only when the `copyto` source is a local filesystem path.
   The app's failing path is `local_to_dropbox -> DropboxBrowser.execute_sync_operation() -> RcloneClient.copy_file_overwrite()`.
   Update `copy_file_overwrite()` so Windows local-source uploads add
   `--local-encoding <workaround>` before `--`, while Dropbox-to-local copies
   keep their current behavior.

3. Keep the change narrow to write operations that start from local disk.
   Do not change listing, streaming, `cat`, or remote-to-local logic. Do not
   alter delete behavior or batch planning; batch sync should inherit the fix
   automatically because it already routes local uploads through the same
   `copy_file_overwrite()` call.

4. Add regression coverage in `tests/test_rclone.py` and `tests/test_sync_routes.py`.
   Cover at least:
   - local-path `copyto` to Dropbox includes the workaround args;
   - Dropbox-to-local `copyto` does not add them;
   - a sync route for a Unicode local filename reaches the rclone call with the
     workaround enabled.

5. Validate with the focused test groups first, then the full suite.
   Run:
   - `python -m tests.run rclone file-sync -v`
   - `python -m unittest discover -s tests -v`

6. Re-run the real-world verification after the code change.
   Confirm the browser/app path can sync
   `0287 - U.N.オーエンは彼女なのか？(TO-HOlic mix).mp3`
   into Dropbox without manual command editing, and keep the repro script as a
   manual cross-check under `plans/unicode_copy_bug/`.
