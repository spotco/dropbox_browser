# Video Multi-Session Infrastructure Plan

## Goal

Make video HLS sessions independent per browser/tab instead of one global active
session. Two viewers should be able to play different videos through the same
server process without evicting each other's playlists, media segments, ffmpeg
processes, progress state, or tagged `/file` input reads.

Success criteria:

- Creating a new HLS session does not stop unrelated existing sessions.
- Each session ID can fetch its own `stream.m3u8`, init segment, and media
  segments until that exact session is stopped, expired, or evicted by policy.
- Tagged `/file` input reads are matched and throttled against the owning
  session, not a global active session.
- Progress/status updates are session-scoped and stale updates are explicit.
- Resource limits are deliberate: too many concurrent ffmpeg sessions return a
  clear error or evict only an idle session, never silently kill active playback.
- Client recovery does not create a browser fight loop.

## Current Diagnosis

Grok's diagnosis matches the current code and docs.

`VideoSessionManager` in `dropbox_browser/video.py` has one `_active_session`.
`create_session()` calls `_clear_active_locked()` before assigning the new
session, so every new video session kills ffmpeg for the previous one and deletes
its `Temp/video_sessions/<session_id>/` directory.

The rest of the manager is built around that single active session:

- `session_asset()` serves assets only if `session_id == _active_session.session_id`.
- `_wait_for_asset()` aborts if `_active_session is not session`.
- `tagged_input_session()` and `tagged_input_throttle_decision()` only match the
  active session, so replaced sessions have their ffmpeg input cancelled.
- `update_session_progress()` only updates the active session and returns
  `stale: true` for any other session.
- `active_session_payload()` exposes one active session to
  `/video/endpoints/status`.
- `stop_active_session()` stops at most one session.

This explains the observed loop:

- Browser A creates session A and starts polling session A assets.
- Browser B creates session B, which clears session A.
- Browser A's next HLS asset poll receives `404 Video session not found`.
- Browser A schedules compatibility recovery and creates session C, clearing B.
- Browser B then repeats the same recovery path.

Seeks and compatibility restarts intensify the loop because they intentionally
stop/recreate the current compatibility session.

## Non-Negotiable Principles

- Keep video playback remote-only through local ffmpeg HLS sessions.
- Keep `/file` and `/download` byte-range behavior intact.
- Keep tagged ffmpeg input requests cancellable when their own session is
  stopped, expired, or evicted.
- Do not add upload behavior.
- Do not make normal page loads perform expensive Dropbox recursion.
- Avoid pretending unlimited concurrent transcodes are safe; encode capacity
  must be explicit and observable.

## Phase 1 - Lock The Existing Failure With Tests

- [ ] Add a server test that creates two HLS sessions for different paths and
      proves the first session currently becomes unavailable.
- [ ] Add the desired-behavior version of that test: after session B is created,
      session A's playlist and segment URLs still return `200`.
- [ ] Add a tagged input test proving a session's `/file?...video_session_id=A`
      lookup should still match after session B exists.
- [ ] Add a progress test proving `POST /video/endpoints/session/progress` updates
      the session named by `id`, not whichever session was created last.
- [ ] Add a stop test proving `POST /video/endpoints/session/stop&id=A` stops
      only A and leaves B available.
- [ ] Keep any current single-session behavior tests, but rename or rewrite them
      so they assert the new lifecycle policy rather than accidental replacement.

## Phase 2 - Replace Global Active Session With A Session Registry

- [ ] Replace `_active_session: VideoHlsSession | None` with
      `_sessions: dict[str, VideoHlsSession]`.
- [ ] Add helper methods:
      `_get_session_locked(session_id)`,
      `_remove_session_locked(session_id, reason)`,
      `_stop_session_resources(session)`, and
      `_session_summaries_locked()`.
- [ ] Make `shutdown()` stop and remove every session before deleting
      `Temp/video_sessions/`.
- [ ] Change `create_session()` so it registers the new session without clearing
      unrelated sessions.
- [ ] On create failure or playlist timeout, remove only the new session.
- [ ] Ensure all session directory cleanup is idempotent and never deletes the
      session root while other sessions are still active.
- [ ] Keep lock hold times short: do not wait for playlist/assets or block on
      process IO while holding the registry lock except during brief removal.

## Phase 3 - Make Session Lookup Truly Per-ID

- [ ] Update `session_asset(session_id, name)` to look up that exact session in
      `_sessions`.
- [ ] Update `_wait_for_asset()` to check whether that exact session ID is still
      present, not whether it is still globally active.
- [ ] Update `tagged_input_session()` to match `session_id` and `rel_path` against
      `_sessions[session_id]`.
- [ ] Update `tagged_input_throttle_decision()` to compute encode-ahead from the
      named session and return `session_missing`, `path_mismatch`, or throttling
      for only that session.
- [ ] Update `update_session_progress()` to mutate `_sessions[session_id]`.
- [ ] Keep stale progress harmless, but include enough response fields for the
      client to tell whether the session is missing, stopped, expired, or evicted.
- [ ] Rename `stop_active_session()` to a session-scoped API internally, while
      keeping the HTTP endpoint path stable for compatibility.
- [ ] Keep `active_session_payload()` temporarily as a compatibility alias that
      returns the most recently accessed session, then migrate clients/tests to
      plural status.

## Phase 4 - Define Resource Limits And Eviction

- [ ] Add config for maximum concurrent HLS sessions, for example
      `VideoMaxConcurrentSessions`, with a conservative default such as `2`.
- [ ] Add config for idle TTL if current `HLS_SESSION_TTL_SECONDS` needs to be
      exposed or tuned.
- [ ] Make `_cleanup_expired_locked()` scan every session and remove idle expired
      sessions.
- [ ] Decide and implement cap behavior:
      reject new session creation with `429 Too Many Requests` when all sessions
      are active, or evict only the oldest idle session.
- [ ] Define "idle" using `last_accessed_at`, last progress report, and playback
      state. Do not evict a recently playing session just because another browser
      starts playback.
- [ ] Include eviction reason in server debug logs and client-visible errors.
- [ ] Add tests for cap reached, idle eviction, and active-session rejection.
- [ ] Document CPU implications: two HEVC transcodes are two ffmpeg processes,
      not one shared encoder.

## Phase 5 - Expand Status Contracts

- [ ] Change `/video/endpoints/status` to return `active_sessions: []` with one
      summary per session.
- [ ] Keep `active_session` in the payload for one release as a backward-compatible
      field, choosing the most recently accessed session.
- [ ] Add query support such as `status?id=<session_id>` so a client can cheaply
      poll its own session.
- [ ] Include per-session fields:
      `session_id`, `path`, `start_time_seconds`, `encoded_media_end_seconds`,
      `video_mode`, `audio_mode`, `ffmpeg_pid`, `created_at`, `last_accessed_at`,
      `client_playback`, and a lifecycle `state`.
- [ ] Include aggregate fields:
      `session_count`, `max_session_count`, `backpressure_thresholds`, and
      compatibility availability.
- [ ] Add tests for empty status, one-session status, multi-session status, and
      status-by-ID for missing sessions.

## Phase 6 - Make The Client Session-Aware

- [ ] Add a browser/tab playback client ID generated per page load and sent on
      session create/progress/stop. Use it for diagnostics and ownership display,
      not as a security boundary.
- [ ] Update status polling in `compatibility.js` to ask for the local
      `compatibilitySessionId`.
- [ ] Treat "my session is missing" as a distinct lifecycle event instead of a
      generic HLS recoverable error.
- [ ] Make progress POST responses actionable:
      if `updated: false` and the local session is missing, clear local timers
      and show a stopped/expired/evicted message.
- [ ] Avoid using `active_session.session_id` as the authority for the current
      browser. The local `compatibilitySessionId` is the authority.
- [ ] Keep normal compatibility recovery for true segment lag within the local
      session.
- [ ] When a 404 arrives for a local HLS asset, poll `status?id=<local id>`
      before auto-restarting. If the session is gone because of stop/expiry/cap,
      do not immediately create a replacement that can evict another viewer.
- [ ] Ensure routine scrubbing restarts only the current browser's session by
      stopping its own ID and creating a replacement; it must not stop other IDs.
- [ ] Update client diagnostics to include both `session_id` and `client_id`.

## Phase 7 - Update Stop, Unload, And Cleanup Behavior

- [ ] Keep `beforeunload` or `sendBeacon` stop behavior, but make it stop only
      the local session ID.
- [ ] Make pane deactivation and queue-item changes stop only the local session.
- [ ] Confirm stale unload beacons from a previous page cannot stop a newly
      created session from another browser.
- [ ] Confirm `stopCompatibilitySession()` clears local state only after the
      server acknowledges or the request has been attempted.
- [ ] Add tests around stop requests with missing, stale, and foreign session IDs.

## Phase 8 - Observability And Manual Validation

- [ ] Add debug events for:
      `session_registered`, `session_stopped`, `session_expired`,
      `session_evicted`, `session_cap_reached`, and per-session tagged input
      throttle/cancel decisions.
- [ ] Update `docs/video-player.md` to describe multi-session lifecycle,
      plural status payloads, cap behavior, and resource costs.
- [ ] Update any benchmark or debug scripts that assume one active session.
- [ ] Add a manual validation checklist:
      open Brave and another browser, start different HEVC videos, confirm both
      playlists keep returning `200`, then seek in one browser and confirm the
      other keeps playing.
- [ ] Validate lower-cost and high-cost pairs separately:
      H.264 copy + H.264 copy, HEVC transcode + H.264 copy, and HEVC burned-in
      subtitle transcode + HEVC transcode.
- [ ] Watch `Temp/video_debug.jsonl`, browser console logs, CPU load, and
      `/video/endpoints/status` during the manual run.

## Phase 9 - Regression Commands

- [ ] Run `python -m tests.run video -v`.
- [ ] Run `python -m tests.run streaming -v` because tagged ffmpeg input uses
      `/file`.
- [ ] Run `python -m tests.run web -v` for asset/status endpoint contracts.
- [ ] Run `npm run test:js` for video client helper behavior.
- [ ] Run the video Playwright coverage with `npx playwright test --grep video`
      before merging broad client changes.
- [ ] Run `python -m unittest discover -s tests -v` before checkin because the
      session registry changes shared server lifecycle behavior.

## Music Player And Other Multi-Session Risk Audit

The music player does not have the same server-side single-session bug.
Music playback uses the browser `<audio>` element pointed at
`/file?path=<song>&source=remote`. The server streams each request through
`rclone cat`; there is no music session manager, no global active music process,
and no server-side stop endpoint that one browser can use to evict another
browser's audio stream.

Still-relevant music multi-tab risks:

- [ ] `localStorage` settings and playlists are shared across tabs by design
      through `Settings` and `PlaylistStore`. Two tabs editing/saving playlists
      can overwrite each other's browser-local playlist state. This is not a
      streaming eviction bug, but it is a multi-tab editing consistency issue.
- [ ] Music library polling shares `FolderCacheManager` background metadata work.
      Multiple tabs may queue or observe the same cache jobs. This should be
      cooperative, but it can cause extra polling/log noise and should remain
      idempotent.
- [ ] Multiple audio streams can run concurrently and each creates its own
      `rclone cat` process. That is expected, but there is no explicit music
      concurrency cap or UI warning.
- [ ] Cover-art and metadata loading use direct `/file` reads and client-side
      object URLs. They should not conflict across browsers, but many tabs can
      create additional remote reads.

Other Dropbox Browser areas:

- [ ] `/file` and `/download` are already request-scoped. They can run
      concurrently, but heavy parallel previews/downloads compete for rclone and
      network bandwidth.
- [ ] Folder cache workers are global shared infrastructure by design. They have
      active job maps and page epochs, but that state is keyed by paths/epochs,
      not by a single browser session. The risk is stale or over-broad
      cancellation during refresh/navigation, not one viewer evicting another
      media session.
- [ ] Sync jobs are global and intentionally mutate local/remote files. Multiple
      browsers can enqueue conflicting sync work if the UI allows it. This is a
      separate workflow-safety problem and should be guarded by existing sync
      direction/overwrite rules, not solved by the video session registry.
- [ ] File search, browse listing, thumbnails, probe cache, subtitle cache, and
      client-log ingestion are shared caches/endpoints. They can have resource
      contention or stale-cache issues, but they do not currently expose a
      single active owner that invalidates other clients.

Conclusion: the urgent architectural fix is video-specific. The reusable
infrastructure lesson is to avoid global "active X" state for any feature that
represents a browser-owned long-running operation. Future long-running features
should start with per-operation IDs, explicit lifecycle, TTL, and concurrency
limits rather than adding a singleton and retrofitting multi-client behavior
later.
