# Testing

The suite uses stdlib `unittest`, fake rclone responses, and isolated temp/cache
paths. Keep regression coverage focused and cheap to run while iterating.

On Windows, install the pack first with `run\win\setup_exe.bat`, then use
`run\win\run_python.bat <module> [arguments]` in place of every
`python -m <module> [arguments]` command below. It uses only the portable
tool-pack Python and adds the checkout to its intentionally isolated import
path; never substitute a system Python.

## Test Groups

List groups:

```powershell
python -m tests.run --list
```

Common groups and aliases:

- `web` (also `ui`, `javascript`, `webpage`) - rendered pages, assets, and
  UI contracts.
- `streaming` and `streaming-http` - pure range/streaming helpers plus
  `/file` and `/download` HTTP behavior.
- `file-sync`, `sync`, `sync-routes`, and `sync-jobs` - sync routes, plans,
  write workers, and grouped progress.
- `background-file-info`, `background`, `folder-info`, `foldercache`,
  `foldercache-compute`, `foldercache-records`, and `foldercache-state` -
  folder-cache workers, records, computation, and `/folder-info` polling.
- `diff`, `folderdiff`, and `status` - Dropbox/local status semantics.
- `cache` - listing/folder cache invalidation and cache behavior.
- `client-log` - browser-to-server client log ingestion and filtering.
- `cli` - command-line/config/startup contracts.
- `names` and `windows-names` - Windows-safe name matching and listing merge.
- `rclone` - rclone adapter behavior, cancellation, and retry policy.
- `thumbnails` and `video-thumbnails` - image/video thumbnail config, cache,
  routes, and listing fields.
- `photo-map` and `photo-map-cache` - Photo Map metadata/cache behavior.
- `music` and `music-endpoints` - music library and endpoint contracts.
- `video` and `video-endpoints` - video probes, HLS sessions, subtitles, and
  endpoint contracts.

Run one or more groups:

```powershell
python -m tests.run web rclone -v
python -m tests.run --group file-sync --group background-file-info
```

Run a specific unittest:

```powershell
python -m unittest tests.test_sync_routes.SyncRouteTests.test_sync_local_only_file_copies_local_to_dropbox -v
```

Run full suite:

```powershell
python -m unittest discover -s tests -v
```

Photo Map-only checks:

```powershell
python -m tests.run photo-map -v
npm run test:js:photo-map
```

Other focused client/server commands include:

```powershell
npm run test:js
npm run test:e2e:client-render
npm run test:e2e:music
npm run test:e2e:video
npm run test:all
```

Run `npm install` once before the Node/Playwright commands. The Python suite
does not require third-party runtime dependencies; the E2E suites require the
development dependencies declared in `package.json` and a discoverable
FFmpeg binary for media fixtures.

The client-render Playwright suite also covers the Photo Map pane lifecycle:
it verifies that Photo Map requests do not start while Music/Video is selected,
that switching away destroys the active map, and that returning to Photo Map
reuses completed local cache records without re-reading the remote media.

Run that focused browser check with:

```powershell
npx playwright test tests/e2e/client-render.photo-map.spec.js --project=client-render
```

Use the full suite before checkin/commit, before handoff of broad cross-module
changes, or when a shared helper used by multiple groups changes.

## Branch Naming

For this project, “main” means the `master` branch. The canonical project
branch is `master`; when a task or conversation refers to “main”, use `master`.

## Client-Rendered Browse Assumption

The suite treats client-rendered browse as the only maintained UI mode.
`--no-client-render` remains a CLI flag, but it is not regression-tested.

When a test needs browse row data, call
`GET /browse/endpoints/listing` instead of parsing `GET /` table HTML. Shared
helper: `browse_listing()` in `tests/app_test_support.py`.

## JavaScript and Browser Tests

Node-based tests live under `tests/js/` and use the built-in `node:test`
runner:

```powershell
npm run test:js
```

Browser integration tests live under `tests/e2e/` and use Playwright against a
real Python server process:

```powershell
npm run test:e2e
npm run test:e2e:local
npm run test:e2e:remote
```

`npm run test:e2e` is the default full E2E command. It runs
`tools/run_distributed_e2e.py` in automatic mode across the local lane and every
reachable compatible Windows or macOS Intel worker selected by the shared
configuration. Linux workers are supported when their application adapter or
private project-map checkout and browser dependencies pass preflight. Automatic mode fails closed
when distributed setup or all remote workers are unavailable; it never silently
claims a local-only run as distributed. Use `npm run test:e2e:local` to force a
local-only diagnostic, or
`npm run test:e2e:remote` when remote execution is required and a missing or
unusable remote setup should fail the command. The gitignored
`LOCAL_NOTES.md` selects the shared root, project name, and local lane. Worker
checkout/runtime settings belong in the application adapter or an ignored
local `projects/dropbox_browser.json` copy; credentials remain in the shared
worker checkout. A clean sptmp2 clone uses Dropbox’s built-in adapter when no
private map exists. The product source dynamically links the shared SDK when
it is present and does not vendor or name a private inventory repository.

Workers may use an installed browser instead of Playwright's bundled Chromium.
Set the worker's private `browser` path when needed; the distributed runner
exports it as `DROPBOX_BROWSER_BROWSER_EXECUTABLE`, and the Playwright config
uses that executable for the lane. Linux workers with no configured browser
path use the bundled Chromium.

Before a remote run, the default `--publish-workers auto` calls the shared
`network_computers.direct_worktree_sync` protocol. It resolves the local
branch and committed `HEAD`, compares each worker's branch/HEAD/cleanliness,
and uses an SCP'd local Git bundle plus direct file transfer. All local
non-ignored Git-visible dirt is synchronized to every selected worker by
default: staged, unstaged, untracked, deleted, and renamed paths, including
spaces and Unicode. Ignored files are excluded. Remote non-ignored dirt is
disposable: the runner emits a visible worker-specific warning, hard-resets
tracked changes, removes non-ignored untracked files with `git clean -fd`, and
does not stash or use `git clean -fdx`. The shared protocol verifies exact
overlay hashes, expected deletions, branch, `HEAD`, and no unexpected
non-ignored dirt. It never fetches `origin`, updates `origin/*`, or runs
`git push`. `--include-worktree` is retained as a compatibility no-op;
`--publish-source auto`/`local` are local-bundle compatibility modes and
`--publish-source origin` fails closed. Use `--publish-workers never` to fail
before changing workers, or `--sync-clean`/`--publish-workers always` to force
the destructive reset path while still applying the local overlay.

Scheduling is owned by the same shared `network_computers.adaptive_e2e` module
used by OSPhoto. An empty ignored `sptmp2/e2e/adaptive-schedule.json`
uses topology capacity; successful runs append bounded lane timing samples and
future plans minimize predicted makespan across only the lanes available for
that run. No product-specific hardcoded weight algorithm or tracked learning
file is used.

Before an actual remote run, set the coordination owner (the local notes may
also provide `coord_owner`):

```powershell
$env:SPTMP2_COORD_OWNER = "dropbox_browser"
python tools/run_distributed_e2e.py
```

The runner claims each selected worker for a bounded interval before remote
preflight, passes the owner through availability checks, and releases leases
when the run ends. `--dry-run` does not claim resources. Use
`python -m network_computers.cli coord status` to inspect the shared board;
maintenance should use `coord offline set`. Never force another project's
lease before its recorded `force_after` time.

The Playwright harness launches `python -m dropbox_browser.cli` with an
isolated `--local-root` through `tests/e2e/support/run_server.py` plus
`tests/fake_rclone.cmd`, which forwards to `tests/fake_rclone.py`. The
Playwright worker starts and stops that server explicitly so short E2E runs do
not hang during teardown. Remote Dropbox data comes from the fixture configured
by `DROPBOX_BROWSER_E2E_FIXTURE`.

### Music e2e fixtures and suites

Music library/playlist behavior is locked by Playwright against a real local
server (not live Dropbox). Two serial suites:

| Suite | Port | Fixture | Focus |
|-------|------|---------|--------|
| `tests/e2e/music-library.integration.spec.js` | `8011` | committed `tests/e2e/fixtures/music-library-deep.json` | Partial folder-cache poll → complete library |
| `tests/e2e/music-player.integration.spec.js` | `8012` | generated `tests/e2e/fixtures/music_player_generated_fixture.py` | Full library + playlist + playback |

Harness: `tests/e2e/support/integration_server.js` +
`tests/e2e/support/run_integration_server.py` (isolated temp/cache paths).

The generated music-player fixture builds short WAV tracks with vendored ffmpeg
under the integration temp root so `/file` + `<audio>` work offline. It covers
library load/sort, shift-range and sibling select-all, playlist
add/dedupe/reorder/remove, context Play, save/load/rename/overwrite/delete,
overwrite and discard **cancel** paths, m3u + JSON import, JSON export, playback
transport (play/pause, next/prev, loop, deterministic shuffle non-sequential
next, seek, volume), and Settings survival across reload (library sort, pane
widths, playlist column widths, load-dialog sort/filter).

Shared client code for that surface lives under
`dropbox_browser/assets/js/media-library/` (also used by the video player).
There is **no** shared music/video e2e suite; video keeps its own specs and
updates selectors for the music-like library/playlist DOM.

### Video e2e fixtures

Video-player integration tests may point `DROPBOX_BROWSER_E2E_FIXTURE` at a
Python fixture generator script. The integration harness executes that script
into its isolated temp root, lets it materialize binary test media on disk, and
then loads the returned JSON fixture description. After the shared media-library
wire-up, video e2es typically click **Load Current Folder** before selecting
tree rows (recursive library, not a flat live listing).

Playwright projects group e2e specs by feature area (see `playwright.config.js`):

| Project | Match | npm script |
|---------|-------|------------|
| `music` | `music-*.spec.js` | `npm run test:e2e:music` |
| `video` | `video-*.spec.js` | `npm run test:e2e:video` |
| `client-render` | `client-render.*.spec.js` | `npm run test:e2e:client-render` |

Run only music-player e2es (library deep-poll + full player suite):

```powershell
npm run test:e2e:music
# equivalent:
npx playwright test --project=music
```

Individual files still work:

```powershell
npx playwright test tests/e2e/music-library.integration.spec.js
npx playwright test tests/e2e/music-player.integration.spec.js
```

Keep the split intentional:

- `tests/js/` for focused JavaScript behavior that does not need a full browser.
- `tests/e2e/` for end-to-end browser and server interactions.

## E2E deduplication (branch `e2e-dedup-faster`)

The Playwright suite went from 157 tests in 26 files to 133 tests in
24 files by removing duplicated behaviour, not coverage. PR review
then restored four checks (below) and a second conservative pass
folded eight more, landing at 131 tests in 25 files. Every removed
case either repeated an assertion already made by a kept test, or had
its assertions folded into a kept test (noted inline at each fold
site with an `e2e-dedup-faster` comment):

- Bottom-panel persistence was tested in three files; the mode matrix
  in `client-render.log-panel-persistence.spec.js` now runs in full only
  for `server-log`, with the startup-overwrite-sensitive cases kept for
  the other modes, and the duplicate in
  `client-render.horizontal-scrollbar.spec.js` was removed.
- `client-render.scroll-restore.spec.js`: Back/Forward/re-enter and
  reload/breadcrumb are sequential phases of two tests (8 → 5).
- `client-render.photo-map-preview.spec.js`: close-button and
  browser-history preview dismissal are two phases of one test (6 → 5).
- `support/video-subtitle-switch-suite.js`: the two Clear Cache tests
  are phases of one test; the recovery shard goes 11 → 10.
- Shared `media-pane-ui` helper checks run once in full, against the
  music player; the video file keeps the wide-divider check plus
  compact video-specific checks (see the PR-review restorations below).
- Static CSS/meta reads were folded onto a shared page load:
  `client-render.mobile-overscroll.spec.js` (4 → 2).
- The narrow-layout snapshots in `music-player.integration.spec.js`
  are phases of one test (the music file's test count drops by 4), and
  the format matrix from the deleted
  `music-formats.integration.spec.js` runs in
  `music-media-session.integration.spec.js`, which already used the
  same fixture and helpers.
- Removed as a superset: the first `video-subtitle-startup-wait` test
  (the kept test asserts the same subtitle-wait state plus full
  coverage).

Deliberately kept despite surface similarity: the two probe-cache
recovery tests (different server fallback branches), the
`sync-in-place-refresh` / `upload-refresh` pair (different fault
injection: HTTP 500 vs rclone throttling, different listing states),
and both media-session suites (opposite pane-hide behaviour).

### PR-review restorations (old → new mapping)

Four removals from the first pass were judged coverage losses on
review and are restored; the unit tests named in the first pass do not
exercise these integration paths.

| Removed in pass 1 | Restored as | Assertions / fixtures preserved |
| --- | --- | --- |
| Video playlist-column, context-menu and narrow-divider tests (`video-playback-small-layout`) | Column floors restored verbatim via `checkPlaylistColumnFloors` with the `video-playlist-column-widths` key and the assertion that `music-playlist-column-widths` is never written; context-menu and narrow-divider return as compact smokes (corner-flip clamp on `#video-playlist-context-menu`; two collapse drags via `paneLayout`) | Video DOM ids, video settings keys and initialization; exhaustive shared geometry stays music-only |
| Styled-font size-parity test (`video-subtitle-size-parity`) | Same test, same file (kept separate from the forced-burn-in test: different fixture file `styled-font.mkv`, own session-body assertion, both playbacks would still be paid inside one 240s budget) | Full ASS → SRT → sanitizer → FFmpeg → rendered-frame path; measured text-size ratio 0.75–1.33 vs overlay; `subtitle_display_height_px` in the forced session body |
| `client-render.row-height.spec.js` (folded into `virtualization`) | Spec restored verbatim with its `audio-downloads-long.json` fixture; the virtualization fold was reverted | Absolute 49px row height, uniform heights, `.status`/`.col-size`/`.col-date` `nowrap`, filename `title` attribute and visible text fidelity for the long filename |
| Browse-column cascade test (`client-render.smoke`) | Same test restored verbatim, with its `waitForBrowseColumnsFitted` helper | Successive 16px floors through real handles, drag past full exhaustion as a no-op, unchanged current/preferred widths after a viewport refit |

### Second pass (PR follow-up)

Seven further folds plus one investigated merge, all test-only. Each
row lists the surviving location and what had to be preserved; the
fault-injection, cold-start and persistence properties called out in
the review are noted explicitly.

| Old test | Surviving test / phase | Preserved |
| --- | --- | --- |
| upload-refresh: "in-place refresh right after an upload keeps Dropbox-only files when the first listing is throttled" | Phase 1 of "once Dropbox recovers, reloading shows the Dropbox listing again…" | Same single-fault arming (`armLsjsonFaultsAfterNextUpload(1)`); Dropbox-only row kept, upload `Synced`, local-only status, no warning — all asserted **before** any reload; phase 2 keeps the two healthy reloads. Persistent-throttling and initial local-only tests stay separate |
| smoke: "hiding the filter bar clears active filters and restores all rows" | Middle phase of "filter bar toggles from the top action row and persists" | Visible-state and hidden-state reload persistence (toggle test), filter fill → 1 row + `q=remote` URL, hide → 3 rows, `data-browse-filter-active=0`, `q` removed from URL |
| topbar: "column header row stays visible and aligned while main scrolls" | Trailing phases of "top bar shows only the breadcrumb title…" | 85px height, breadcrumb/toggle non-overlap, missing legacy `thead`, alignment at initial/middle/bottom scroll. Narrow/minimized, sorting and drag-extremes tests untouched |
| photo-map-preview: "returns to the grid and accepts another real member click" | Phase 3 of "restores the selected member after dismissing its full preview…" | The details-popup branch specifically: `Close preview` **inside the details** (not the overlay close) → details gone, `aria-pressed=false` → real click on a member → details visible, `aria-pressed=true` |
| smoke: "mode fetches and renders browse rows from the listing endpoint" | Phase 1 of "folder navigation uses history without a full page reload" | Title, `data-client-render`, endpoint attribute, no empty state, preview (`/file?`) and download links, zero page errors — all on the initial load, before navigation |
| smoke: "deep link loads the requested folder" | Phase 2 of the navigation test | A genuinely fresh `page.goto('/?path=folder')` (new document), URL/`data-current-folder-path`/`nested.txt` assertions — not warm in-app navigation |
| smoke: "ignores legacy sort and direction URL parameters" | Phase 3 of the navigation test | Cold `page.goto('/?sort=date&dir=desc')`; parameters stripped from the URL, `data-current-sort-key=name`, direction `asc`. No sort is changed earlier in the host test, so no persisted per-folder sort interferes |
| switch suite: "Space shortcut toggles playback…" + "controls stay visible and usable in fullscreen" | Single test "video controls and Space shortcut work in embedded and fullscreen modes without hijacking text inputs" (core shard 10 → 9) | One HLS-stub setup (`fragmentCount: 4, playlistFragmentCount: 5`), alpha playback + bravo queued; embedded Space, text-input exemption, fullscreen geometry/control state, fullscreen Space, loop/next/previous navigation, back-15 seek — in that order |

Discarded candidate: sharing one server across the four
`camera-uploads-large.json` specs (`file-search`, `virtualization`,
`horizontal-scrollbar`, `topbar-column-header`). Playwright isolates
spec files in separate workers, so sharing would need an external
daemon or merging the files. Measured on spzeni1, the four specs cost
6.0s / ~9s / 8.1s / 13.0s of test time in total and run on different
distributed lanes in parallel; server boot is only ~1–2s of each.
Merging them into one lane would serialize ~35s of tests to save
~4–6s of boots — a net wall-clock loss, plus cross-test state risk.

## Regression Workflow

When a regression can be represented in the test harness:

1. Add a focused unit test that reproduces the bad behavior.
2. Run that specific test and verify it fails for the expected reason.
3. Apply the smallest fix that addresses the regression.
4. Rerun the specific test and verify it passes.
5. Run the relevant test group.
6. Run the full suite before checkin/commit or for broad/shared changes.

Do not rely only on browser/manual verification for regressions that can be
represented with fake rclone and isolated temp/cache paths.

## Test Support

Shared test helpers live in `tests/support.py` and `tests/app_test_support.py`.

Useful helpers:

- `SimulatedRclone`
- `SimulatedLsjsonResponse`
- `TestServer`
- `IsolatedPathsTestCase`
- `wait_until`
- `remote_file_item`
- `remote_dir_item`

`IsolatedPathsTestCase.read_trace_events()` reads the isolated worker JSONL
trace log for background-worker assertions.

For feature-specific behavior, see [Browse UI](browse-ui.md),
[Music Player](music-player.md), [Photo Map](photo-map.md),
[Media Caches](media-caches.md), and [Video Player](video-player.md).

## Compile/Smoke Checks

Useful quick checks:

```powershell
python -m py_compile dropbox_browser.py
python -m compileall -q dropbox_browser.py dropbox_browser
python dropbox_browser.py --help
```

If starting the server from an agent shell, use a hidden background process and
verify the root URL returns HTTP 200:

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8000/ -TimeoutSec 30
```
