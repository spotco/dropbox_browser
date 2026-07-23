# Testing

The suite uses stdlib `unittest`, fake rclone responses, and isolated temp/cache
paths. Keep regression coverage focused and cheap to run while iterating.

## Test Groups

List groups:

```powershell
python -m tests.run --list
```

Common groups:

- `web` - rendered pages, assets, UI contracts.
- `streaming` - pure streaming helpers plus `/file` and `/download` HTTP behavior.
- `file-sync` - sync routes and sync job queue.
- `background-file-info` - folder-cache workers and `/folder-info` polling.
- `diff` - Dropbox/local status semantics.
- `cache` - listing/folder cache invalidation.
- `names` - Windows-safe name matching and listing merge.
- `rclone` - rclone adapter behavior.
- `thumbnails` - thumbnail config, cache, `/thumbnail` route, and listing fields.

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
```

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
