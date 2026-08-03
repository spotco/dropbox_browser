# Sync and rclone write behavior

Sync is an explicit, browser-triggered copy feature for installations that have
a local comparison root. It is copy-only: it can overwrite the selected
destination in the selected direction, but it never removes destination-only
files.

## Directions and gates

For a file row, `POST /sync` accepts:

- `local_to_dropbox` — reads the safe local path and writes the remote file;
- `dropbox_to_local` — reads the remote file and writes the safe local path.

The corresponding UI checkbox must be sent with the request:
`enable_write_dropbox=1` for local-to-Dropbox or `enable_to_local=1` for
Dropbox-to-local. The handler checks the gate again, so a hidden/stale UI cannot
silently start a copy.

Folder rows do not have single-item sync forms. Batch actions are available for
the current folder and can be recursive:

- `local_to_dropbox_all` copies local-only and differing files to Dropbox;
- `dropbox_only_to_local_all` copies Dropbox-only and differing files locally;
- `download_local_only_delete_bat` downloads reviewable commands for local-only
  files. The server never runs those commands.

## Batch confirmation

Batch execution has two asynchronous phases:

1. `/sync-batch-plan` scans the selected tree and returns an operation id. The
   UI polls `/sync-status` while it prepares a confirmation summary and stores a
   short-lived plan token.
2. `/sync-batch` consumes the token, revalidates the selection, recomputes the
   plan, and queues the copy operations in `SyncJobManager`.

The recomputation is deliberate protection against a changed remote/local tree,
but it means a large recursive batch can spend time planning again after the
user confirms and before the first copy starts. Single-file jobs have priority
over queued batch work. Batch jobs continue after individual failures and expose
errors in the operation status.

After a successful copy, affected listing and folder-cache parents are
invalidated. The UI can then refresh metadata and status without relying on a
stale snapshot.

## rclone operations

`RcloneClient` owns all subprocess invocation:

- `lsjson` for direct remote listings;
- `lsjson --stat`/fallback listing for file resolution;
- `cat` for preview/download streams and ranged reads;
- `rcat` for local-to-Dropbox file writes;
- `copyto` for Dropbox-to-local writes;
- `mkdir` when a recursive copy needs a remote parent.

Commands use `--` before targets. A single-flight guard coalesces identical
`lsjson` work, and `RcloneCancelToken` can kill active background listing work
or tagged video input when the owner is no longer relevant.

## Write retries

Writes use `RcloneRetryPolicy`. The default timeout for an attempt is based on
the source size, capped and multiplied for later attempts. Timeout and retry
settings are configurable through the `RcloneWrite*` keys described in
[Configuration](configuration.md). Dropbox throttle messages such as rate
limits and too-many-write-operation responses are also recognized by sync
workers and retried with bounded backoff.

The retry policy applies to the write operations, not to arbitrary user file
uploads: browser upload routes are intentionally absent.

## Status semantics

File status is based on normalized names, item type, and size. Modification time
alone does not make an item different. A same-name file/folder conflict is a
diff. Name matching uses Unicode NFKC normalization followed by `casefold()`;
when a Dropbox spelling cannot exist on Windows, the actual local filesystem
path is used for the destination.

See [Background Workers](background-workers.md) for recursive diff propagation
and [Windows Name Matching](windows-name-matching.md) for path-resolution rules.
