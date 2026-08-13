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
configuration. It includes the current worktree so remote lanes test the same
uncommitted changes as the local lane. Linux workers are supported when their
private project-map checkout and browser dependencies pass preflight.
If no usable remote setup is available, automatic mode falls back to the local
Playwright run. Use `npm run test:e2e:local` to force a local-only run, or
`npm run test:e2e:remote` when remote execution is required and a missing or
unusable remote setup should fail the command. The gitignored
`LOCAL_NOTES.md` selects the shared root, project name, and local lane. Worker
checkout/runtime settings belong in the shared project's private
`projects/dropbox_browser.json`; credentials remain in the shared worker
checkout. The product source dynamically links the shared SDK when it is
present and does not vendor or name a private inventory repository.

Workers may use an installed browser instead of Playwright's bundled Chromium.
Set the worker's private `browser` path when needed; the distributed runner
exports it as `DROPBOX_BROWSER_BROWSER_EXECUTABLE`, and the Playwright config
uses that executable for the lane. Linux workers with no configured browser
path use the bundled Chromium.

Before a remote run, the default `--publish-workers auto` compares each
selected worker with local `HEAD`. Dirty or stale checkouts are preserved in a
remote stash and reset to that commit. `--publish-source auto` (default) fetches
from `origin` only when that remote already contains local `HEAD`. Unpublished
local commits are shipped with a Git bundle over SSH; GitHub is not updated.
Use `--publish-source local` to always use the SSH bundle, or
`--publish-source origin` to push `HEAD` to `origin/<branch>` when needed.
`--include-worktree` also copies uncommitted local files onto workers after the
reset. Use `--publish-workers never` to reject instead of synchronizing, or
`--sync-clean`/`--publish-workers always` to force a refresh.

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
