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

Status: done (2026-07-18). Reproduced deterministically with the original UI
ordering: holding the stop left `bravo.mkv` selected but prevented its session
create request. Fixed by using the API-level browser E2E that holds the old
stop, creates a newer token-ordered session, releases the stop, and asserts
that the new session remains active. The replacement test passed in isolation.

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

Status: done (2026-07-18). Reproduced the shutdown failure directly with a
queued `FolderJob` followed by a `FolderShutdownJob`, which raised the reported
cross-dataclass priority-queue `TypeError`. Also reproduced the cache-write
race by removing the cache directory between temporary-file creation and
atomic replace. Fixed the shared priority queue to compare heterogeneous
dataclass jobs through their priority fields and stable sequence numbers, and
made disposable cache writes ignore teardown-time `FileNotFoundError`. The
focused worker/sync groups passed, and the concurrent video/JavaScript run
passed without either reported signature.

### 3. Full video E2E: rapid navigation missed the Bravo create request

The first complete run of
`video-subtitle-switch.integration.spec.js` (37 tests, one worker) failed in
`rapid next and previous navigation keeps the final subtitle item isolated`.
`waitForSessionPost()` timed out for the Bravo session create request after the
test had clicked Next/Previous.

The same test passed when run alone, and passed during the next complete-spec
run. The relevant cleanup/navigation tests, including the new delayed-stop
test, therefore did not show a repeatable product failure.

Status: done (2026-07-18). Reproduced the timing gap by delaying the stop
response: the old test observed the immediately-rendered Previous button and
clicked it before the Bravo session-create request was emitted. Fixed the E2E
to await the Bravo POST before clicking Previous, and added transition-token
ordering assertions for the Bravo and final Alpha requests. The stress test
passed 3/3 with a delayed stop, and the complete 37-test spec also passed this
case before reaching the separately documented WebVTT startup flake.

### 4. Full video E2E: WebVTT scrub-remount startup timed out

During the second complete video-spec run, `WebVTT subtitle debug timing stays
aligned after in-session scrub remount` failed while `waitForVisibleVideo()`
waited 30 seconds. The predicate remained false before the subtitle timing
assertions ran.

The test passed when rerun alone. This is consistent with HLS/ffmpeg startup
resource contention or timing sensitivity in the full serial spec, not a
confirmed subtitle-content or subtitle-switching failure.

Status: done (2026-07-18). Reproduced the timeout in the full serial spec
after the preceding 12 tests, while the test passed in isolation. The failure
was limited to the real-media playback surface remaining hidden after the
loading overlay had replaced the placeholder, before the subtitle assertions
ran. Added an item-specific 60-second media-visible startup budget while
leaving the normal 30-second helper budget unchanged for other tests. The
preceding-nine-tests-plus-item-4 serial pressure run passed, and the item-4
test passed 5/5 in isolation. The Python video group passed 151/151. A later
complete spec run reached a separate existing item-10 startup timeout, so it
does not change item 4's focused verification.

### 5. Full video E2E: exited HLS sessions exhausted the session cap

The item-10 startup timeout recurred during a serial run and initially looked
like another media-visible timing failure. Failure diagnostics showed the
client had fallen back to its placeholder because the server returned
`session_cap_reached`. The server still counted eight sessions whose FFmpeg
processes had already exited; their recent paused/playing progress made them
look active to the eviction policy.

Status: done (2026-07-18). Reproduced the cap exhaustion after the preceding
video tests and added coverage for a stopped session with recent playback
progress. Capacity activity now treats an exited process as inactive, while
leaving its generated HLS assets registered for clients that may still be
consuming them. The focused capacity tests passed 2/2, and the serial sequence
through the affected item-10 and item-4 cases passed 13/13. The Python video
group passed 151/151.

### 6. Full Playwright E2E: music integration server missed the beforeAll deadline

The repeated full E2E command
`npm run test:e2e` failed in the music project before the test body ran:

```text
tests/e2e/music-player.integration.spec.js:222:1
library loads complete tree, sort, playlist CRUD, and playback
"beforeAll" hook timeout of 10000ms exceeded
```

The timeout occurs at the suite-level `startIntegrationServer()` call on line
214. In each of three full-suite runs, this test failed immediately and the
remaining music tests were not run. The music test passed 3/3 when isolated
with one worker and a fresh integration server:

```text
npx playwright test tests/e2e/music-player.integration.spec.js \
  --project=music --workers=1 \
  --grep "library loads complete tree, sort, playlist CRUD, and playback" \
  --repeat-each=3
```

This looks like full-suite startup/resource contention in the E2E harness:
the Python integration server does not become ready before Playwright's
10-second hook deadline when the projects are launched together. It is not
currently evidence of a music-library or playlist behavior failure. Capture
server-start timing and port/process diagnostics, then either make the
beforeAll startup budget reflect the server's readiness contract or serialize
the projects if they are competing for a shared resource.

Status: done (2026-07-18). Reproduced under full-suite startup pressure and
confirmed that the generated-fixture server could outlast the inherited
10-second hook timeout. Added `test.setTimeout(60000)` to the music-player
`beforeAll`, matching the integration server's 30-second readiness budget.
The focused test passed 3/3, the complete music project passed 7/7, and a
post-fix full E2E run executed all music tests successfully; its only failure
was the separately tracked video item-7 session-status mismatch.

### 7. Full Playwright E2E: automatic playlist-next test sees retained prior sessions

The same three `npm run test:e2e` runs also failed at:

```text
tests/e2e/video-subtitle-switch.integration.spec.js:2331:1
automatic playlist next clears old subtitles and mounts the next video track
```

After the test mounted `Videos/bravo.mkv`,
`expectOnlyActiveVideoSession()` waited 15 seconds for the status response to
contain only Bravo. It instead continued to receive prior session paths,
including `Videos/offset.mkv`, `Videos/ass-fruits.mkv`, and
`Videos/alpha.mkv`, alongside `Videos/bravo.mkv`:

```text
Expected: ["Videos/bravo.mkv"]
Received: ["Videos/offset.mkv", "Videos/offset.mkv",
           "Videos/ass-fruits.mkv", "Videos/alpha.mkv",
           "Videos/bravo.mkv", "Videos/alpha.mkv", "Videos/alpha.mkv"]
Timeout 15000ms exceeded while waiting on the predicate
```

The failure is suite-state dependent rather than random: it occurred in all
three full runs, but the test passed 3/3 in isolation with one worker:

```text
npx playwright test tests/e2e/video-subtitle-switch.integration.spec.js \
  --project=video --workers=1 \
  --grep "automatic playlist next clears old subtitles and mounts the next video track" \
  --repeat-each=3
```

The cause is the E2E assertion, not a session leak: exited HLS sessions remain
registered intentionally so their generated HLS assets stay available to
clients that may still be consuming them. `active_sessions` therefore contains
both live and retained stopped summaries, and the old helper treated every
summary as simultaneous playback. A short Bravo input can also finish before
the assertion, so requiring the current session to have `state: "active"` would
be incorrect.

Status: done (2026-07-18). Reproduced in the full serial video project and
confirmed the response included retained stopped sessions from earlier tests.
Fixed `expectOnlyActiveVideoSession()` to identify the newly created session by
its returned session ID, require that session's path, and reject only other
sessions whose state is actually `active`. Retained stopped sessions remain
available for asset serving and explicit session-id status checks. The focused
test passed 3/3, the Python video group passed 152/152, and the complete serial
video project passed 44/44.

### 8. Full Playwright E2E: bitmap subtitle server became unreachable

In the third repetition of the full command
`npm run test:e2e`, the bitmap video project failed before its first playback
assertion:

```text
tests/e2e/video-subtitle-bitmap.integration.spec.js:196:1
bitmap subtitle tracks restart compatibility playback instead of mounting a sidecar track
Error: apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:8315
```

The refusal occurred in `waitForCompatibilityReady()` while polling
`GET /video/endpoints/status` at line 51. The full run had 69 passed tests, one
failed test, and one dependent bitmap test skipped. The other two full-suite
repetitions passed 71/71. The bitmap test passed 3/3 in isolation with one
worker:

```text
npx playwright test tests/e2e/video-subtitle-bitmap.integration.spec.js \
  --project=video --workers=1 \
  --grep "bitmap subtitle tracks restart compatibility playback instead of mounting a sidecar track" \
  --repeat-each=3
```

This was a parallel Playwright server-port collision, not bitmap subtitle
behavior. `client-render.smoke.spec.js` and `music-player.integration.spec.js`
both used port 8012, while other fixed client-render ports overlapped video
worker-0 ports. Under concurrent project startup, one test could reach the
wrong server or a server that had been displaced, producing the bitmap
connection refusal.

Status: done (2026-07-18). Reproduced the collision directly with
`npx playwright test --project=music --project=client-render --workers=2`;
the client-render smoke test reached the wrong service and failed its browse
row assertion. Moved all four fixed client-render servers to the dedicated
ports 8022–8025, away from music (8011–8012) and video worker ports. The
music/client-render concurrency reproduction passed 27/27 after the fix, the
bitmap test passed 3/3 in isolation, and a complete 10-worker `npm run
test:e2e` run passed 71/71.

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
- Continue investigating any unrelated full-spec failures after the session
  cap fix if they recur.
- Investigate the open full-suite music beforeAll startup timeout and the
  retained-session status mismatch recorded in items 6 and 7.
- Prefer isolated or intentionally serialized suite runs until the
  folder-cache teardown race is understood.
