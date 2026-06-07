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

The music-library integration test uses a separate harness on non-default port
`8011` through `tests/e2e/support/integration_server.js` and
`tests/e2e/support/run_integration_server.py`. It loads the committed deep-music
fixture `tests/e2e/fixtures/music-library-deep.json`, keeps temp/cache paths
isolated, and verifies `Music Player -> Song Library -> Load Current Folder`
through partial cached-library polling and final completion.

Run that integration test directly:

```powershell
npx playwright test tests/e2e/music-library.integration.spec.js
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
