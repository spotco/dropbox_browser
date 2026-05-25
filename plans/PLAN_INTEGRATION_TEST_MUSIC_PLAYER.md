# Music Player Integration Test Plan

This file tracks the requested browser integration test for `Music Player ->
Song Library -> Load Current Folder` on an uncached `/?path=music` page that
has just started loading.

## Progress

- [ ] Read `docs/background-workers.md`, `docs/testing.md`, and this plan.
- [ ] Inspect the existing Playwright harness, music-player UI flow, and test
  support helpers before editing.
- [ ] Add a dedicated in-process integration server harness with no subprocess
  rclone adapter.
- [ ] Add one committed deep-music fixture file for this test.
- [ ] Add narrow test-only polling/timing overrides needed for practical
  runtime.
- [ ] Add one Playwright integration test for the requested flow.
- [ ] Update the relevant docs.
- [ ] Run targeted verification.

## Step 1 - Confirm Existing Coverage And Harness Boundaries

- [ ] Re-read the existing music-library endpoint tests in
  `tests/test_music_endpoints.py`.
- [ ] Re-read the existing folder-cache worker tests in
  `tests/test_folder_info_workers.py`.
- [ ] Re-read the current Playwright harness in:
  - `tests/e2e/support/server.js`
  - `tests/e2e/support/run_server.py`
- [ ] Confirm the current Playwright harness shells out through
  `tests/fake_rclone.cmd` / `tests/fake_rclone.py`.
- [ ] Preserve the existing harness for current E2E tests; do not break the
  current `smoke.spec.js` flow.
- [ ] Keep this new integration test isolated to the explicitly requested music
  scenario only.

## Step 2 - Add A Dedicated Integration Server Harness

The new test must not run the real `rclone.exe`. Fake rclone shims are allowed
and preferred when they reduce implementation cost.

- [ ] Add a dedicated Python integration server entrypoint under
  `tests/e2e/support/` for the music integration test.
- [ ] Reuse the existing fake-rclone E2E infrastructure where practical:
  - `tests/fake_rclone.cmd`
  - `tests/fake_rclone.py`
  - the existing stdlib HTTP server stack
- [ ] If the existing fake-rclone fixture format cannot express the staged
  partial-completion behavior cleanly, extend it narrowly for this test rather
  than introducing a broader new server architecture by default.
- [ ] Use isolated temp/cache paths for the integration run.
- [ ] Keep the integration server on a non-default port, using Playwright port
  configuration such as `8011`.
- [ ] Make the harness expose any artifacts the Playwright test needs for
  backend assertions:
  - final library payload or status endpoint state, if needed;
  - isolated worker trace log path or a simple test endpoint that returns
    relevant trace data;
  - a way to confirm the fake-rclone test path was used and not the real
    `rclone.exe`.
- [ ] Keep the integration harness specific and narrow; do not replace the
  default E2E support server globally unless that is required and remains
  backward-compatible.

## Step 3 - Create One Committed Deep-Music Fixture File

Use one committed static fixture file for this integration test only.

- [ ] Create one fixture file under `tests/e2e/fixtures/`.
- [ ] Keep the fixture audio-only.
- [ ] Base the structure on the current observed cached `dropbox:music` tree
  shape, but commit a deterministic trimmed subset.
- [ ] Include:
  - several top-level album folders;
  - at least one nested `Disc 1` / `Disc 2` subtree;
  - many songs per folder relative to normal unit fixtures;
  - realistic folder and track names;
  - enough folders and songs to validate partial and final library rendering.
- [ ] Keep the fixture small enough that:
  - the Playwright DOM assertions remain maintainable;
  - the test runtime stays within the agreed budget.
- [ ] Record exact expected totals for:
  - final folder count in Song Library;
  - final song count in Song Library;
  - any staged intermediate counts used by the test.
- [ ] Do not read the developer's live `Cache/` directory at test runtime.

## Step 4 - Add Controlled Partial-Completion Timing

The test needs an uncached page that loads quickly while descendant folder
metadata arrives over time.

- [ ] Make the root `/?path=music` page load immediately from simulated direct
  listing data.
- [ ] Ensure descendant folder-cache metadata for some subtrees is not complete
  when the page first renders.
- [ ] Add at least one intentionally delayed subtree that starts as incomplete
  so Song Library can show a visible `not cached` row initially.
- [ ] Add staged delayed completion for at least two checkpoints when practical:
  - initial partial state;
  - intermediate partial growth;
  - final completed state.
- [ ] Drive staged completion with explicit gates or deterministic waits inside
  the fake-rclone fixture/harness or an equivalent narrow test helper.
- [ ] Do not let the request thread block waiting for descendant completion.

## Step 5 - Add Narrow Test-Only Polling And Timing Overrides

The production JS currently uses the normal music-library poll delay. The
integration test needs a smaller deterministic delay without changing default
runtime behavior.

- [ ] Add a narrow test-only override for the music-library poll interval.
- [ ] Keep the production default unchanged.
- [ ] Set the integration test override to a practical fast interval such as
  `100-200 ms`.
- [ ] Keep the test runtime target roughly within `3-8 s`.
- [ ] Ensure the integration test fails by timeout at `15 s`.
- [ ] Prefer a server-rendered or app-configured override path over a global
  production JS constant change.
- [ ] Keep the override implementation explicit enough that future tests can
  reuse it intentionally, not accidentally.

## Step 6 - Add The Playwright Browser Test

Add one Playwright test under `tests/e2e/` for the requested scenario.

- [ ] Start from `/?path=music`.
- [ ] Switch the bottom pane to `Music Player`.
- [ ] Click `Load Current Folder`.
- [ ] Measure and assert that the initial load action returns quickly, with a
  concrete threshold such as under `250 ms`.
- [ ] Assert the initial Song Library state is partial and user-visible:
  - loading status text or equivalent incomplete-state text appears;
  - at least one folder row shows the `not cached` badge;
  - exact initial visible folder/song counts match the expected staged fixture
    state.
- [ ] Assert that at least one relevant file-browser folder row is still
  incomplete at this stage.

### Intermediate Assertions

- [ ] Release or wait for the first delayed subtree completion.
- [ ] Assert the next music-library poll updates the browser without another
  manual click.
- [ ] Assert exact intermediate folder/song counts.
- [ ] Assert newly available songs appear in Song Library after the matching
  file-browser folder is no longer loading.
- [ ] If the harness supports a second staged subtree cleanly, repeat once more
  for another exact-count intermediate checkpoint.

### Final Assertions

- [ ] Wait for all delayed subtree work and background folder-cache workers to
  complete.
- [ ] Assert the final music-library state is complete in the browser.
- [ ] Assert the browser has received and rendered the final completed poll.
- [ ] Assert exact final Song Library counts:
  - final folder count;
  - final song count.
- [ ] Assert representative expected deep rendered paths are present.
- [ ] If the final flattened tree remains modest enough, assert the full
  rendered tree contents exactly; otherwise use totals plus representative deep
  paths.
- [ ] Assert polling stops once the completed state is reached.

## Step 7 - Add Backend Completion Assertions For The Integration Run

Do not rely on browser DOM checks alone.

- [ ] Assert server-side completion using the integration run's final
  `/music/endpoints/library` state, trace endpoint, or other equivalent
  integration-visible artifact.
- [ ] Assert worker trace evidence shows:
  - one or more `music_library_poll` events;
  - descendant folder-cache completion events for the staged subtrees.
- [ ] Assert the integration run used the fake-rclone test path and not the
  real `rclone.exe`.

## Step 8 - Keep Exact Counts Stable And Non-Brittle

Exact counts are required, but they should be asserted only at synchronized
checkpoints, not tied blindly to raw poll sequence numbers.

- [ ] Use explicit staged completion gates or deterministic checkpoint waits.
- [ ] Record exact expected counts for:
  - initial partial response;
  - each intermediate staged response used by the test;
  - final completed response.
- [ ] Avoid brittle assertions of the form:
  - "poll #2 must always have X";
  - "poll #3 must always have Y"
  unless the harness guarantees that exact sequencing.
- [ ] Prefer:
  - release staged subtree;
  - wait for next successful UI update;
  - assert exact counts at that synchronized stage.

## Step 9 - Update Docs

Update only the relevant docs for this explicitly requested integration test.

- [ ] Update `docs/testing.md` to describe:
  - the existence of this Playwright integration test;
  - how to run it directly;
  - that it uses a non-default integration port;
  - that it uses one committed simulated deep-music fixture;
  - that it verifies partial and final Song Library polling behavior.
- [ ] Update `docs/background-workers.md` to describe the integration-test
  coverage at a high level where relevant:
  - non-blocking `Load Current Folder`;
  - partial `not cached` state;
  - incremental library growth from background folder-cache work;
  - final completed library state after worker completion.
- [ ] Keep the docs concise and implementation-specific.

## Step 10 - Verification

Run the smallest relevant checks while implementing, then the full targeted set
before handoff.

- [ ] Run the specific new Playwright test directly.
- [ ] Run any existing E2E smoke test affected by harness changes.
- [ ] Run music endpoint tests:
  `python -m unittest tests.test_music_endpoints -v`
- [ ] Run folder-cache worker tests:
  `python -m unittest tests.test_folder_info_workers -v`
- [ ] Run web/UI tests if any production JS/template surface changed:
  `python -m tests.run web -v`
- [ ] Run compile checks:
  `python -m compileall -q dropbox_browser.py dropbox_browser`
- [ ] If shared helpers or config paths changed materially, rerun the relevant
  broader group before handoff.

## Future Run Notes

- The test must remain integration-only because it was explicitly requested.
- Do not broaden this into a generic live-cache or real-Dropbox test.
- Do not depend on developer-specific cache contents at runtime.
- Do not change production polling defaults globally to make the test pass.
- Do not run the real `rclone.exe`; fake rclone is always fine for testing.

## Open Questions

- None.
