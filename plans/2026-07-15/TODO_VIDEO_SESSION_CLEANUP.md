# TODO: Clean Up Video HLS Sessions on Navigation and Reload

## Status

Confirmed on 2026-07-15. Do not kill the currently playing session while
working this issue.

The server intentionally supports multiple compatibility sessions, but one
video client should not leave a transcoding session behind every time the user
selects Next, Previous, or reloads the page. The stale sessions observed in
this reproduction were real running ffmpeg processes, not OS zombies.

## Reproduction

The existing headless Playwright video harness can reproduce the navigation
leak without real Dropbox access or a visible browser:

1. Run the video e2e project, or add the assertions below to
   `tests/e2e/video-subtitle-switch.integration.spec.js` test
   `video controls navigate the queue, persist loop, and wrap natural end when enabled`.
2. Install the existing HLS stub, open the video pane, and play `alpha.mkv`.
3. Queue `bravo.mkv`, click **Next**, and wait for the `bravo.mkv` session POST.
4. Poll `GET /video/endpoints/status` and inspect `active_sessions`.

The expected result is one active session for `Videos/bravo.mkv`. Before the
fix, the result is two active sessions: the old `alpha.mkv` ffmpeg process and
the new `bravo.mkv` ffmpeg process. Repeating Next/Previous grows the count.

Minimal assertion shape:

```js
const status = await page.request.get("/video/endpoints/status");
const payload = await status.json();
expect(payload.active_sessions.map((item) => item.path)).toEqual([
  "Videos/bravo.mkv",
]);
```

For reload, play one item, capture its session id from `status`, call
`await page.reload()`, then poll `status` until the old id is absent. The
current `beforeunload` implementation can lose its ordinary asynchronous
fetch during reload, so the old ffmpeg process remains until idle expiry.

Useful headless commands:

```powershell
npm run test:e2e:video -- --grep "video controls navigate the queue"
npx playwright test tests/e2e/video-subtitle-switch.integration.spec.js --project=video --grep "video controls navigate the queue"
```

## Root Cause

### Next/Previous and natural playlist advance

- `dropbox_browser/assets/js/video/media-library-bridge.js:185-197` routes
  Next and Previous to `playPlaylistIndex()`.
- `playPlaylistIndex()` changes the queue index and calls
  `playbackApi.syncForActiveItem()`.
- `dropbox_browser/assets/js/video/playback.js:31-49` only stops a session when
  there is no active item. The active-item branch resets the surface, probes the
  new item, and creates a new HLS session at line 110, but never stops the old
  active-item session first.
- The existing playback sync token protects against stale session creation and
  stops a newly-created session whose token is stale at lines 111-113. It does
  not stop the already-running session that was replaced by the navigation.
- The server is behaving as implemented: `VideoSessionManager` allows multiple
  sessions for multiple tabs/browsers and only removes an old session through
  explicit stop, cap eviction, create failure, shutdown, or idle expiry.

The direct fix should snapshot the old session id and path when an active item
change begins, explicitly stop that session before creating the new one, and
re-check the playback sync token after the awaited stop. Only stop when the
session path differs from the new active item so a redundant sync for the same
item does not restart playback. The explicit id is important: a concurrent
transition must not stop a newer session through the mutable current-session
field.

Rapid repeated navigation should also be covered. Existing token checks can
stop a session created by a superseded transition, but the transition code
should remain serialized or use explicit session-id snapshots so two in-flight
sync calls cannot clear each other's newer state.

### Page refresh

- `dropbox_browser/assets/js/video.js:473-477` calls the async stop operation from
  `beforeunload` and does not wait for it.
- `dropbox_browser/assets/js/video/compatibility.js:909-924` sends a normal
  `fetch()` without `keepalive`; browsers may cancel it as the document is
  unloading.
- `createVideoClientId()` in `dropbox_browser/assets/js/video.js:28-36` creates
  an in-memory random id on each page load. A refresh therefore gets a new
  client id, so a server-side same-client cleanup policy cannot identify the
  previous page unless the id becomes stable for the lifetime of the tab.

The reload fix should use an unload-safe request (`fetch(..., {keepalive: true})`
for the small form body, with a `navigator.sendBeacon` fallback where useful)
and wire the cleanup to `pagehide` as well as `beforeunload`, with duplicate
stop requests remaining harmless. Keep the explicit session id snapshot.
Persisting the client id in `sessionStorage` would enable a server-side safety
net that stops an older session when the same tab creates a replacement, but
that policy must distinguish tabs and should not be added without defining the
multi-tab ownership semantics.

The 15-minute idle TTL is only a backstop, not an adequate navigation cleanup
mechanism. Expiry is evaluated when the session manager is used; it is not a
dedicated process reaper loop.

## Regression Coverage

### Focused JavaScript coverage

Add a `playback.js` test that starts with an existing session for item A,
switches the active item to B, and asserts:

- stop is called with the explicit session id for A before session creation for B;
- the new B session id remains current;
- a stale transition cannot stop B or clear B's local state.

The existing tests in `tests/js/video-compatibility-copy-fallback.test.js`
cover explicit stop ids and stale newly-created sessions, but do not cover an
active-item path change with an already-running old session.

### Existing e2e tests to extend

- Extend the queue navigation test in
  `tests/e2e/video-subtitle-switch.integration.spec.js` to assert one active
  server session after Next, Previous, and natural playlist advance. Also
  assert that the previous session id is absent.
- Extend the automatic playlist-next subtitle test in the same file to assert
  that subtitle teardown and session teardown happen for the old item.
- Add a dedicated reload test in the video e2e suite that captures the old
  session id, reloads the page, and polls `/video/endpoints/status` until the
  old session is gone. This test should use the real integration server and
  HLS stub, not only request interception, so it validates server process
  cleanup.
- Keep the existing `clearActiveVideoSessionAndCache()` cleanup helper as a
  test safety net, but do not rely on it to catch leaks because it removes all
  sessions after the test and can hide an intermediate count greater than one.

Run the focused JS group and video e2e group after the fix, then the full suite
because the change crosses client playback lifecycle and server session
ownership.

## Process Tracking When Debug Logging Is Off

`log_video_debug()` in `dropbox_browser/video.py:207-222` is completely gated
by `LogVideoDebug`, so normal local runs have no persistent server-side
lifecycle trace. The status endpoint already exposes `session_id`, path,
client id, `ffmpeg_pid`, timestamps, and active-session count; extend it with
low-volume process state that is useful without enabling verbose logging:

- `process_state` (`running` or `exited`) and `process_returncode` from
  `Popen.poll()`;
- session age and idle age;
- `last_lifecycle_reason`, stop-request timestamp, and a bounded recent
  lifecycle list for created/stopped/expired/evicted sessions;
- the old and new session ids, paths, and a client transition/generation id on
  create and stop responses;
- retain the ffmpeg PID and optionally expose the server parent PID for
  Windows process-tree correlation. Do not expose the full command by default;
  keep it behind the existing debug setting because paths and URLs can be
  large.

On the client, add a small always-available session-lifecycle diagnostic
channel (separate from noisy video timing) recording `transition_id`, old
session id, new session id, active path, stop request/response, and whether the
request was sent during pagehide/unload. The existing `video` client logging
and `video_debug.jsonl` remain useful when explicitly enabled, but they should
not be required to answer the basic question: which session owns each ffmpeg
PID and why was it removed?

