# Plan: Video and Test Flakes Observed During Session-Cleanup Work

Date: 2026-07-16

## Purpose

Record the intermittent failures seen while investigating video session
cleanup, subtitle switching, and close-during-create behavior. This separates
test-harness timing problems from deterministic application races.

## Observed flaky events

### 1. First UI-level delayed-stop reproduction was invalid

An initial attempt to reproduce the rapid opposite-navigation race held the
first `POST /video/endpoints/session/stop` request before clicking Next. The
test then timed out waiting for the Bravo session request. The stop was awaited
by the navigation path, so holding it also blocked the UI transition/control
state needed to reach the next create. This was a test-design deadlock, not
evidence that the product could not navigate.

Status: replaced with an API-level browser E2E that holds the old stop,
creates a newer token-ordered session, releases the stop, and asserts that the
new session remains active.

### 2. Concurrent Python and JavaScript suites raced folder-cache teardown

While `python -m tests.run video -v` and `npm run test:js` were launched at the
same time, the video suite failed in
`test_library_endpoint_excludes_local_only_entries` during server shutdown:

- `TypeError: '<' not supported between instances of 'FolderShutdownJob' and
  'FolderJob'` while pushing the shutdown item into the priority queue.
- A folder-cache worker also logged `FileNotFoundError` while atomically
  replacing a cache file after its temporary directory had already gone away.

The video group passed when rerun alone, and the JavaScript suite passed alone.
This points to a background-worker/test-isolation or shutdown-order race,
possibly amplified by concurrent processes, rather than a video-session
regression.

Status: unresolved infrastructure flake. The failure should be reproduced with
repeated concurrent runs before changing production behavior.

### 3. Full video E2E: rapid navigation missed the Bravo create request

The first complete run of
`video-subtitle-switch.integration.spec.js` (37 tests, one worker) failed in
`rapid next and previous navigation keeps the final subtitle item isolated`.
`waitForSessionPost()` timed out for the Bravo session create request after the
test had clicked Next/Previous.

The same test passed when run alone, and passed during the next complete-spec
run. The relevant cleanup/navigation tests, including the new delayed-stop
test, therefore did not show a repeatable product failure.

Status: flaky E2E timing/control-state observation. Keep the test, but improve
its synchronization if it recurs; capture the navigation token and request
sequence in failure diagnostics.

### 4. Full video E2E: WebVTT scrub-remount startup timed out

During the second complete video-spec run, `WebVTT subtitle debug timing stays
aligned after in-session scrub remount` failed while `waitForVisibleVideo()`
waited 30 seconds. The predicate remained false before the subtitle timing
assertions ran.

The test passed when rerun alone. This is consistent with HLS/ffmpeg startup
resource contention or timing sensitivity in the full serial spec, not a
confirmed subtitle-content or subtitle-switching failure.

Status: flaky E2E startup timing. If it recurs, preserve the trace/error
context and inspect session-create, playlist-ready, and media-visible timing
before increasing timeouts.

## Not flakes: deterministic races found in the application

- Navigation previously leaked the replaced session/process.
- A delayed client-wide stop could remove the final newer session after rapid
  Next/Previous navigation.
- Closing while session creation was pending needed client-generation
  cancellation before registration.

These now have focused coverage and fixes. The browser tests also continue to
exercise subtitle teardown and replacement behavior, but a passing E2E run does
not prove the timing-sensitive cases are non-flaky.

## Verification recorded on 2026-07-16

- Python full suite: 462 passed.
- Video Python group: 150 passed when run in isolation.
- JavaScript suite: 224 passed when run in isolation.
- Focused cleanup E2Es: passed.
- Full video E2E: one run failed at rapid navigation; a subsequent run passed
  the cleanup/navigation tests but hit the WebVTT startup flake. Both failed
  tests passed when rerun individually.

## Follow-up

- Reproduce the folder-cache teardown error with repeated concurrent Python/JS
  runs and inspect priority-queue ordering plus worker shutdown joins.
- Add request/token diagnostics to the rapid-navigation E2E if the missed
  Bravo request recurs.
- Collect HLS session and playlist-ready timing for repeated full video-spec
  runs before deciding whether the WebVTT test needs a synchronization change.
- Prefer isolated or intentionally serialized suite runs until the
  folder-cache teardown race is understood.
