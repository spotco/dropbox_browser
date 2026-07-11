# Folder-info root stuck `partial` / `loading` flake

## Goal

Diagnose and fix the intermittent failure of

`tests.test_folder_info_workers.FolderInfoWorkerTests.test_page_load_and_background_poll_return_expected_data`

so full-suite multi-runs stay green without masking a real folder-cache
completion bug.

## Status

- **Fix landed (2026-07-11)** on `dev/video-file-http-optimization`.
- Root cause refined beyond the original parent-attach TOCTOU hypothesis: a
  **stale deferred cache flush** can clobber a newer complete root record on
  disk after the child has already finalized the parent in memory.
- Observed during full-suite ×4 after unrelated video work on
  `dev/video-file-http-optimization`.
- Not caused by tagged `/file` HTTP optimization or AVI probe changes.

## Symptom

### Full-suite multi-run (2026-07-11)

| Run | Result | Duration |
|---|---|---:|
| 1 | OK (450) | ~105.5 s |
| 2 | OK (450) | ~107.2 s |
| 3 | **FAILED (1)** | ~112.0 s |
| 4 | OK (450) | ~106.4 s |

Failed runs: **1 of 4**.

### Failing assertion

`wait_until` times out waiting for the folder-info predicate. Last payload:

```text
{
  "sub": {
    "status": "complete",
    "complete": true,
    "diff_status": "synced",
    "diff_complete": true,
    "file_statuses": {"child.txt": {"diff_status": "synced"}},
    "size_display": "10 B",
    "size_sort_value": 10,
    "count_display": "1 files",
    ...
  },
  "": {
    "status": "partial",
    "complete": false,
    "diff_status": "loading",
    "diff_complete": false,
    "file_statuses": {"shared.txt": {"diff_status": "synced"}},
    "size_display": "9 B",
    "size_sort_value": 9,
    "count_display": "1 files",
    ...
  }
}
```

Interpretation of that payload:

| Path | Observed | Expected by test |
|---|---|---|
| `sub` | complete + synced | same |
| root `""` | **partial**, **loading**, **diff_complete=false** | `diff_complete` true (and root finished) |
| root size | **9 B / 1 file** (only `shared.txt`) | should eventually include child: ~19 B / 2 files if `sub` merged |
| `shared.txt` file status | synced | synced |

Root never absorbed the child folder’s contribution. Child finished; parent stayed
stuck mid-computation.

## Repro

### Primary (suite load)

```powershell
# Often green alone; intermittent under full suite load
for ($i=1; $i -le 4; $i++) {
  python -m unittest discover -s tests -q
}
```

Artifact from a failed run (if still present):

- `Temp/full_suite_run_3.log` (from the 2026-07-11 multi-run harness)

### Focused test

```powershell
python -m unittest `
  tests.test_folder_info_workers.FolderInfoWorkerTests.test_page_load_and_background_poll_return_expected_data `
  -v
```

Usually passes in isolation. Flake rate rises when many other tests/workers run
in the same process / under CPU contention.

### Fixture (from the test)

- Local + simulated remote both have:
  - root `shared.txt` (`b"root data"` → 9 bytes)
  - `sub/child.txt` (`b"child data"` → 10 bytes)
- App built with default folder-cache **workers=2**
- Flow:
  1. `_browse_listing(server)` → page load at root, child row shows Loading
  2. `_wait_folder_info(paths=["sub"], current="")` until predicate holds
  3. Assert cache records for root and sub

### Predicate that times out

```python
lambda data: (
    data.get("sub", {}).get("complete")
    and data.get("sub", {}).get("diff_status") == "synced"
    and data.get("", {}).get("diff_complete")   # stuck here
    and data.get("", {}).get("file_statuses", {}).get("shared.txt", {}).get("diff_status") == "synced"
)
```

Default `wait_until` timeout: **5.0 s** (`tests/support.py`).

## Ownership map

| Concern | Module |
|---|---|
| Test and wait helper | `tests/test_folder_info_workers.py`, `tests/app_test_support.py` |
| `/folder-info` HTTP | `dropbox_browser/handlers.py` (`serve_folder_info`) |
| Recursive metadata + diff jobs | `dropbox_browser/foldercache.py` |
| Parent/child totals propagation | `dropbox_browser/foldercache_state.py` |
| Diff status labels | `dropbox_browser/folderdiff.py` |
| Browse snapshot queues root | `dropbox_browser/services.py` (`build_browse_snapshot`) |
| Background worker docs | `docs/background-workers.md` |

## What was investigated

### 1. Failure is not random payload noise

The last payload is consistent with a **stuck incomplete root**:

- `sub` fully complete/synced
- root still `partial` / `loading` / `diff_complete=false`
- root size/count match **direct files only** (no child subtree totals)

### 2. Live file-status override masks part of the stuck state

In `serve_folder_info`, when `rel_path == current_rel` and `local_root` is set:

```python
file_statuses = self.app.file_statuses_for_entries(self.app.list_entries(rel_path))
```

So for `current=""`:

- `shared.txt` can show **`synced` from a live listing compare**
- while the **cached root record** still has overall **`diff_status=loading`** and
  **`diff_complete=false`**

The test’s `shared.txt` check can pass even when root recursive work is broken.
The hard fail is **`diff_complete` on root**.

### 3. `/folder-info` does not re-queue `partial` paths

```python
if st in ("complete", "partial"):
    # return cached snapshot; do not cache.request()
else:
    # calculating / pending only
    cache.request(full_remote, request_page_time)
```

Once root is **`partial`**, polling **never restarts** root work. Progress depends
entirely on background workers finishing parent completion. If completion is
missed, the poll spins until timeout.

This is why the test “hangs” instead of healing within a few more requests.

### 4. How root is supposed to finish

Relevant design (from code + `docs/background-workers.md`):

- Page load should not block on recursive Dropbox work.
- Workers compute direct listing + direct diff, then recurse into child folders.
- Child completion should:
  - remove the child from parent `_pending_children`
  - `propagate` size/count/mtime upward
  - call `maybe_complete(parent)` when no pending children remain
- Only then should root become `complete` with `diff_complete=true` and
  `diff_status=synced` (for this synced fixture).

Key helpers:

- `FolderCacheManager._compute` — registers subfolders, pending set, enqueue
- `FolderAccumulationState.propagate` — push child deltas to parent
- `FolderAccumulationState.on_subtree_complete` — discard pending child; maybe complete parent
- `FolderCacheManager._maybe_complete` — set synced/diff_complete and write complete cache

### 5. Multi-worker parent/child race (current best explanation)

Default app in this test: **`workers=2`**.

Browse queues root. Poll requests both **`sub`** and **`current=""`** (root).
Both can run concurrently.

Important code paths:

**A. Child completes before parent registers it**

```python
# foldercache_state.on_subtree_complete
parent = self.parent.get(path)
if parent is None:
    return  # no upward completion
```

If `sub` finishes while `_parent["dropbox:sub"]` is unset, completion does **not**
update root.

**B. Parent is supposed to attach already-complete children**

In `_compute`, after direct listing, for each subfolder:

1. Prefer complete child from a **pre-lock cache snapshot** (`sf_cached`).
2. Else add to `_pending_children`, then try attach-from-`_acc` if the child is
   already done in memory.
3. Else enqueue a child job if not already in progress / direct_done.

There is an intentional “attach already-complete independent child” branch so
parents do not wait forever for a callback that already fired. That branch is
necessary and also **TOCTOU-sensitive**:

- Child completeness is snapshotted **before** the parent lock
  (`sf_cached = {sf: self.get(sf) for sf in subfolders}`).
- Under concurrency, child state can change between snapshot and lock handling.
- If attach paths miss, root can end with `pending_children` still containing
  `sub` or with no child contribution applied.

**C. Root already in `_direct_done` will not recompute**

Worker dequeue:

```python
already_done = self._direct_done.get(remote_path, 0.0) >= effective_page_time
if already_done:
    # job_skipped_complete — does not repair pending_children
```

If the first root compute left root partial/wrong pending state, later root jobs
for the same epoch can be **skipped as already done**, so the stuck state
persists.

**D. Abandoned parents skip finalization**

```python
# on_subtree_complete
if parent in self.abandoned:
    self.write_cache(parent, False)
    return  # no maybe_complete
```

Page-epoch cancellation can abandon parents. Less likely in this single-page
test, but relevant under broader suite timing if epochs interact unexpectedly.

### 6. Evidence from payload that attach never happened

Root stuck with:

- `size_sort_value: 9` (direct `shared.txt` only)
- `count_display: "1 files"`

If `sub` (10 B, 1 file) had been successfully propagated and completed into root,
totals should include the child. They do not → **parent never successfully ran
the complete child-contribution / maybe_complete path**.

### 7. What was ruled out / low confidence as primary cause

- **Video `/file` HTTP work** — different modules; no shared path with folder-info.
- **AVI header-probe duration fix** — probe/cache only; not folder-cache.
- **Wrong fixture remote/local mismatch** — would produce `has_diffs`, not endless
  `loading` with live-synced `shared.txt`.
- **wait_until too short for legitimate slow work** — `sub` already complete;
  remaining work is only parent finalization (should be near-instant if called).
  Timeout is a consequence of a stuck state, not slow rclone in this fixture.

## Current belief about the fix

Primary fix belongs in **folder-cache disk coherence + completion**, not in the
test timeout.

### Confirmed root cause (2026-07-11 implementation)

Cache writes are deferred (`_mark_cache_dirty_locked` → flush after lock
release) so workers do not block on disk I/O. With `workers=2`:

1. Root compute finishes **partial** (pending `sub`), snapshots incomplete
   record, begins `write_json_atomic` outside the lock.
2. Child completes, propagates into root, `maybe_complete(root)`, flushes
   **complete** root to disk (size includes child).
3. Root’s late partial write **overwrites** the complete record.
4. `get()` / `status()` read **disk only** → permanent `partial` / size =
   direct files only.
5. `/folder-info` does not re-queue `partial` → poll hangs until timeout.

This matches the flake payload exactly (`sub` complete, root size 9 / 1 file,
`diff_complete=false`).

### Preferred direction (in order) — implementation status

1. **[done] Epoch-aware deferred cache flush**
   - Advance a per-path write epoch on every dirty mark.
   - Skip flush snapshots whose epoch is no longer current.
   - If a write still races past the pre-check, re-dirty and rewrite current
     state (`cache_write_skipped_stale` / `cache_write_repaired_stale` traces).

2. **[done] Make parent attach of complete children race-safe under the lock**
   - Under the lock, prefer live memory completeness over the pre-lock
     `sf_cached` snapshot; attach from disk or memory before leaving a child
     in `pending_children`.

3. **[done] Do not skip recompute when incomplete pending children remain**
   - `job_skipped_complete` now calls `_repair_complete_children_locked` so
     already-complete pending children can still finalize the parent.

4. **[done] Optional safety net in `/folder-info`**
   - When `current` is still `partial` and every other requested path is
     `complete`, re-`request` current (`stuck_parent_reenqueued`).
   - `request()` repairs already-complete pending children and, if memory is
     already complete, flushes disk without full recompute
     (`request_flushed_complete`).
   - Legitimate parents still waiting on children dedupe; incomplete polled
     children do not trigger the safety net.

5. **[done] Test hardening**
   - `test_stale_parent_partial_flush_does_not_clobber_completed_root` gates the
     first incomplete root disk write, lets the child finalize root in memory,
     then releases the stale write and asserts root stays complete with child
     totals (19 B / 2 files).

### Explicit non-goals for the first fix

- Do not change diff semantics (size-based, mtime ignored).
- Do not make page load synchronous recursive.
- Do not special-case this one test path in production with “always complete
  root when any child complete” without pending bookkeeping.

## Suggested implementation steps

- [x] Write a deterministic multi-worker regression test that reproduces stuck
      root partial after child complete (synthetic delays / ordering if needed).
      → `test_stale_parent_partial_flush_does_not_clobber_completed_root`
- [x] Confirm with traces / forced ordering: gate first incomplete root
      `write_json_atomic`, let child complete + finalize root in memory, release
      stale partial write. Old flush leaves disk `complete=false` size=9;
      epoch-aware flush keeps complete size=19.
- [x] Fix stale deferred cache flush (write epochs + skip/repair) and harden
      parent attach / pending finalization under lock (items 1–3).
- [x] Optionally re-request incomplete partial parents from `/folder-info`
      (safety net): re-request partial `current` when all other polled paths are
      complete; `request()` can flush complete memory → disk.
      → `test_folder_info_rerequests_partial_current_when_children_complete`,
        `test_folder_info_does_not_rerequest_partial_current_while_children_incomplete`
- [x] Run `python -m tests.run background-file-info -v` (27 tests OK after safety net).
- [ ] Full suite multi-run (e.g. ×4 or ×10) before checkin.
- [x] Note in `docs/background-workers.md` about deferred flush races and
      partial current re-request safety net.

## Debugging commands

```powershell
# Focused
python -m unittest `
  tests.test_folder_info_workers.FolderInfoWorkerTests.test_page_load_and_background_poll_return_expected_data `
  -v

# Group
python -m tests.run background-file-info -v

# Stress full suite
for ($i=1; $i -le 10; $i++) {
  Write-Output "===== RUN $i ====="
  python -m unittest discover -s tests -q
  if ($LASTEXITCODE -ne 0) { break }
}
```

On failure, inspect isolated run traces if configured (`Temp/runs/...` /
`read_trace_events` in tests) for:

- `page_load`
- `request_enqueued` / `child_enqueued`
- `folder_state_updated` (subfolders, direct_files)
- `subtree_complete` for `dropbox:sub` and `dropbox:`
- `job_skipped_complete` for root
- `folder_info_poll` status_counts (`partial` vs `complete`)

## Related notes

- Documented worker model: `docs/background-workers.md`
- Diff status values: `loading`, `synced`, `has_diffs`, `local_only`,
  `dropbox_only`
- Folder cache continues metadata work even after first direct diff so size/date
  can finish; this flake is about **never finishing**, not early `has_diffs`.

## Open questions

1. Can a deterministic unit-level race be forced without sleeps by injecting
   ordering hooks around `_compute` / `on_subtree_complete`?
2. Is there a production UI symptom (root row stuck Loading after child rows
   finish) corresponding to this test, or is it mostly test/worker scheduling?
3. ~~Should `/folder-info` treat “all requested children complete, parent still
   partial/loading” as an automatic re-finalize trigger?~~ **Yes** — implemented
   as a conservative re-`request` of `current` only when every other path in the
   poll batch is already complete.

## Decision summary

| Item | Belief |
|---|---|
| Flaky? | Yes (~suite load) |
| Root cause class | Stale deferred parent cache flush clobbering newer complete disk record; amplified by partial non-requeue |
| Strong evidence | Forced gate on incomplete root write reproduces size=9 / complete=false after child complete |
| Fix location | `foldercache.py` (write epochs + attach/repair + request flush); `/folder-info` partial-current safety net |
| Wrong fix | Only lengthen test timeout |
| Related to recent video work? | No |
| Status | Core fix, safety net, and regression tests landed; full-suite multi-run still recommended before checkin |
