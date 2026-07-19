const path = require("node:path");
const {pathToFileURL} = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  return import(pathToFileURL(absolutePath).href + `?t=${Date.now()}`);
}

function makeEl() {
  return {
    hidden: false,
    value: "",
    style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getAttribute() { return ""; },
    removeAttribute() {},
    appendChild() {},
    replaceChildren() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    dispatchEvent() {},
    pause() {},
    paused: true,
    ended: false,
    load() {},
    textTracks: [],
    currentTime: 0,
    error: null,
  };
}

function createCtx(activeItem) {
  const diagnostics = [];
  return {
    els: {
      videoEl: makeEl(),
      playbackStageEl: makeEl(),
      loadingOverlayEl: makeEl(),
      loadingTitleEl: makeEl(),
      loadingMetaEl: makeEl(),
      loadingProgressEl: makeEl(),
      loadingProgressLabelEl: makeEl(),
      progressSliderEl: makeEl(),
      elapsedTimeEl: makeEl(),
      subtitleTrackSelectEl: makeEl(),
      subtitleShadowEnabledEl: makeEl(),
      subtitleStrokeEnabledEl: Object.assign(makeEl(), { checked: true }),
      subtitleFontSizeInputEl: Object.assign(makeEl(), { value: "28" }),
      subtitleOffsetInputEl: Object.assign(makeEl(), { value: "0" }),
    },
    state: {
      paneActive: true,
      queue: [activeItem],
      activeQueueIndex: 0,
      videoClientId: "client-123",
      compatibilityAvailable: true,
      playbackMode: "compatibility",
      playbackSyncToken: 7,
      pendingAutoplay: false,
      transportWantsPlay: false,
      seekRestartInProgress: false,
      compatibilityRecoveryAttempts: 0,
      compatibilityRecoveryTimer: 0,
      compatibilityRecoveryScheduled: false,
      compatibilityRecoveryForceVideoTranscode: false,
      compatibilityRecoveryForceAudioTranscode: false,
      compatibilityRecoveryFallbackKey: "",
      compatibilityForcedVideoTranscodeRetryKeys: Object.create(null),
      compatibilityForcedAudioTranscodeRetryKeys: Object.create(null),
      compatibilitySessionId: "session-1",
      compatibilitySessionPath: activeItem.path,
      compatibilitySessionVideoMode: "video_copy",
      compatibilitySessionVideoModeReason: "selected_h264_stream_copy_safe",
      compatibilitySessionAudioMode: "audio_transcode",
      compatibilitySessionAudioModeReason: "audio_copy_not_supported",
      compatibilityAudioStreamIndex: null,
      compatibilitySessionBurnedInSubtitleStreamIndex: null,
      compatibilityStartSeconds: 0,
      compatibilityEncodedMediaEndSeconds: 0,
      compatibilitySubtitleStreamIndex: null,
      compatibilityBufferedFragmentCount: 0,
      compatibilitySessionStatusRequestInFlight: false,
      compatibilitySessionStatusTimer: 0,
      compatibilitySessionProgressRequestInFlight: false,
      compatibilitySessionProgressTimer: 0,
      compatibilitySessionProgressPendingImmediate: false,
      compatibilityProgressBurstUntilMs: 0,
      compatibilityPlaybackRevealed: false,
      compatibilityPlaybackRevealPending: false,
      compatibilitySubtitleWaitStageActive: false,
      requestedSeekSeconds: null,
      pendingSubtitleStyleApply: false,
      hlsController: null,
      probeCache: Object.create(null),
      selectedAudioStreamIndexByPath: Object.create(null),
      selectedSubtitleStreamIndexByPath: Object.create(null),
      subtitleStyleDraft: null,
      subtitleStyleApplied: null,
      subtitleTrackPreferenceByLayout: Object.create(null),
      subtitleFullVttCacheByPath: Object.create(null),
      subtitleWarmInFlightByPath: Object.create(null),
      subtitleWindowCacheByPath: Object.create(null),
      subtitleWindowInFlightByPath: Object.create(null),
      subtitleCoverageByPath: Object.create(null),
      subtitleBackgroundCoverageByPath: Object.create(null),
      subtitleMountedWindowByPath: Object.create(null),
      subtitleObjectUrls: [],
      subtitleMountedSeekSeconds: null,
      subtitleMountedStreamIndex: null,
      subtitleDebug: {
        rawVtt: "",
        cues: [],
        fetchStartSeconds: 0,
        streamIndex: "",
        trackLabel: "",
        lastLoggedCueKey: "",
      },
    },
    _lastStatus: "",
    _lastPlaceholder: null,
    _diagnostics: diagnostics,
    activeQueueItem() {
      return activeItem;
    },
    activeItemTitle() {
      return "Movie";
    },
    currentGlobalPlaybackSeconds() {
      return 18;
    },
    formatPlaybackTime(seconds) {
      return String(Number(seconds) || 0);
    },
    formatNativePlaybackTime(seconds) {
      return String(Number(seconds) || 0);
    },
    setStatus(message) {
      this._lastStatus = String(message || "");
    },
    setPlaybackSummary() {},
    renderAudioTrackSelector() {},
    showLoadingOverlay() {},
    loadingOverlayCopy() {
      return {};
    },
    reportVideoDiagnostic(payload) {
      diagnostics.push(payload);
    },
    resetPlaybackTiming() {},
    reportPlaybackTiming() {},
    reportCompatibilitySeekTiming() {},
    mediaRangesSummary() {
      return [];
    },
    currentProcessedRangeSnapshot() {
      return {};
    },
    selectedAudioStreamIndex() {
      return null;
    },
    selectedBurnedInSubtitleStreamIndex() {
      return null;
    },
    subtitlesEnabledForItem() {
      return false;
    },
    renderSubtitleTrackSelector() {},
    resetSubtitlesForActiveItemChange() {},
    compatibilityNeededMeta() {
      return "Compatibility playback required.";
    },
    compatibilityNeededStatus() {
      return "Compatibility playback required.";
    },
    persistSubtitleSelectionFromUi() {},
    clearSubtitleTrack() {},
    showPlaybackVideo() {},
    syncPlaybackProgress() {},
    syncTransportControls() {},
    hideLoadingOverlay() {},
    requestVideoPlay() {},
    playbackShouldBeRunning() {
      return true;
    },
    resyncSubtitleTrackAfterHlsRecovery() {},
    compatibilitySeekableRanges() {
      return [];
    },
    playbackSyncTokenIsCurrent(syncToken) {
      return syncToken === this.state.playbackSyncToken;
    },
    ensureAudioTracksForItem: async function () {
      return { duration_seconds: 120 };
    },
    stopCompatibilitySession: async function () {},
    postStopCompatibilitySession: async function () {},
    attachCompatibilityVideo() {},
    normalizeSubtitleStreamIndex(value) {
      return value == null ? null : Number(value);
    },
    scheduleSubtitlesAfterPlaybackReady() {},
    showCompatibilitySubtitleWaitStage() {},
    applySubtitlesForSeek() {},
    ensureSubtitlesAfterPlaybackReady() {},
    hideVideoElement() {},
    clearVideoSource() {},
    showPlaybackPlaceholder(title, meta) {
      this._lastPlaceholder = {
        title: title == null ? "" : String(title),
        meta: meta == null ? "" : String(meta),
      };
    },
    resetPlaybackProgress() {},
    clearCompatibilityRecoveryTimer() {},
    clearCompatibilitySessionStatusPoll() {},
    clearCompatibilitySessionProgressReport() {},
    resetCompatibilityRecoveryState() {},
    flushNativeSubtitleRenderSurface() {},
    currentSubtitleStyleOptions() {
      return {
        shadowEnabled: true,
        strokeEnabled: true,
        fontSizePx: 34,
        offsetPx: -18,
      };
    },
    appliedSubtitleStyleOptions() {
      return {
        shadowEnabled: true,
        strokeEnabled: true,
        fontSizePx: 28,
        offsetPx: 0,
      };
    },
  };
}

test("createCompatibilitySession includes force_video_transcode when requested", async () => {
  const {initCompatibility} = await importModuleFromWorkspace("dropbox_browser/assets/js/video/compatibility.js");
  const item = {path: "Videos/copy.mkv"};
  const ctx = createCtx(item);
  const requests = [];
  global.fetch = async function (_url, options) {
    requests.push(String(options && options.body || ""));
    return {
      ok: true,
      async json() {
        return {status: "ok", session_id: "s1"};
      },
    };
  };
  global.window = { setTimeout, clearTimeout };
  initCompatibility(ctx);

  await ctx.createCompatibilitySession(item, 2, 18, null, { forceVideoTranscode: true });

  assert.equal(requests.length, 1);
  assert.match(requests[0], /path=Videos%2Fcopy\.mkv/);
  assert.match(requests[0], /client_id=client-123/);
  assert.match(requests[0], /audio_stream_index=2/);
  assert.match(requests[0], /start_time_seconds=18/);
  assert.match(requests[0], /force_video_transcode=1/);
});

test("createCompatibilitySession includes force_audio_transcode when requested", async () => {
  const {initCompatibility} = await importModuleFromWorkspace("dropbox_browser/assets/js/video/compatibility.js");
  const item = {path: "Videos/copy.mkv"};
  const ctx = createCtx(item);
  const requests = [];
  global.fetch = async function (_url, options) {
    requests.push(String(options && options.body || ""));
    return {
      ok: true,
      async json() {
        return {status: "ok", session_id: "s1"};
      },
    };
  };
  global.window = { setTimeout, clearTimeout };
  initCompatibility(ctx);

  await ctx.createCompatibilitySession(item, 2, 18, null, { forceAudioTranscode: true });

  assert.equal(requests.length, 1);
  assert.match(requests[0], /path=Videos%2Fcopy\.mkv/);
  assert.match(requests[0], /client_id=client-123/);
  assert.match(requests[0], /audio_stream_index=2/);
  assert.match(requests[0], /start_time_seconds=18/);
  assert.match(requests[0], /force_audio_transcode=1/);
});

test("createCompatibilitySession uses applied subtitle styling for burned-in subtitle sessions", async () => {
  const {initCompatibility} = await importModuleFromWorkspace("dropbox_browser/assets/js/video/compatibility.js");
  const item = {path: "Videos/copy.mkv"};
  const ctx = createCtx(item);
  const requests = [];
  ctx.currentSubtitleStyleOptions = function () {
    return {
      shadowEnabled: false,
      strokeEnabled: false,
      fontSizePx: 34,
      offsetPx: -18,
    };
  };
  ctx.appliedSubtitleStyleOptions = function () {
    return {
      shadowEnabled: true,
      strokeEnabled: true,
      fontSizePx: 28,
      offsetPx: 0,
    };
  };
  global.fetch = async function (_url, options) {
    requests.push(String(options && options.body || ""));
    return {
      ok: true,
      async json() {
        return {status: "ok", session_id: "s1"};
      },
    };
  };
  global.window = { setTimeout, clearTimeout };
  initCompatibility(ctx);

  await ctx.createCompatibilitySession(item, 2, 18, 5, {});

  assert.equal(requests.length, 1);
  assert.match(requests[0], /client_id=client-123/);
  assert.match(requests[0], /subtitle_stream_index=5/);
  assert.match(requests[0], /subtitle_stroke_enabled=1/);
  assert.match(requests[0], /subtitle_shadow_enabled=1/);
});

test("createCompatibilitySession surfaces structured server error messages", async () => {
  const {initCompatibility} = await importModuleFromWorkspace("dropbox_browser/assets/js/video/compatibility.js");
  const item = {path: "Videos/copy.mkv"};
  const ctx = createCtx(item);
  global.fetch = async function () {
    return {
      ok: false,
      headers: {
        get(name) {
          return name === "content-type" ? "application/json" : "";
        },
      },
      async json() {
        return {
          status: "error",
          message: "Video session limit reached (2 max concurrent sessions; all session slots are currently active).",
          error_code: "session_cap_reached",
          session_error_reason: "all_sessions_active",
        };
      },
    };
  };
  global.window = { setTimeout, clearTimeout };
  initCompatibility(ctx);

  await assert.rejects(
    () => ctx.createCompatibilitySession(item, 2, 18, null, {}),
    function (error) {
      assert.equal(
        error.message,
        "Video session limit reached (2 max concurrent sessions; all session slots are currently active)."
      );
      assert.equal(error.videoErrorCode, "session_cap_reached");
      assert.equal(error.videoSessionErrorReason, "all_sessions_active");
      return true;
    }
  );
});

test("copy-mode fatal HLS media error schedules forced-transcode recovery once", async () => {
  const {initCompatibility} = await importModuleFromWorkspace("dropbox_browser/assets/js/video/compatibility.js");
  const item = {path: "Videos/copy.mkv"};
  const ctx = createCtx(item);
  let recoverMediaErrorCalls = 0;
  ctx.state.hlsController = {
    recoverMediaError() {
      recoverMediaErrorCalls += 1;
    },
  };
  global.window = {
    setTimeout() {
      return 123;
    },
    clearTimeout() {},
  };
  initCompatibility(ctx);

  await ctx.handleCompatibilityHlsError({
    type: "mediaError",
    details: "bufferAppendError",
    fatal: true,
  });

  const fallbackKey = ctx.compatibilityForcedVideoTranscodeRetryKey(item.path, 18);
  assert.equal(recoverMediaErrorCalls, 0);
  assert.equal(ctx.state.compatibilityRecoveryScheduled, true);
  assert.equal(ctx.state.compatibilityRecoveryForceVideoTranscode, true);
  assert.equal(ctx.state.compatibilityRecoveryFallbackKey, fallbackKey);
  assert.equal(ctx.state.compatibilityForcedVideoTranscodeRetryKeys[fallbackKey], true);
  assert.match(ctx._lastStatus, /retrying with video transcode/i);

  ctx.clearCompatibilityRecoveryTimer();
  const scheduledAgain = ctx.scheduleCompatibilityVideoCopyFallback(
    "hls-media-copy-fallback",
    18,
    { type: "mediaError", fatal: true }
  );
  assert.equal(scheduledAgain, false);
  assert.equal(ctx.state.compatibilityRecoveryAttempts, 1);
});

test("copy-mode forced-transcode recovery recreates the session instead of seeking in-session", async () => {
  const {initCompatibility} = await importModuleFromWorkspace("dropbox_browser/assets/js/video/compatibility.js");
  const item = {path: "Videos/copy.mkv"};
  const ctx = createCtx(item);
  const sessionRequests = [];
  const stopRequests = [];
  let timerCallback = null;
  global.fetch = async function (url, options) {
    const requestUrl = String(url || "");
    if (requestUrl.includes("/video/endpoints/session/stop")) {
      stopRequests.push(String(options && options.body || ""));
      return { ok: true, async json() { return { status: "ok" }; } };
    }
    if (requestUrl.includes("/video/endpoints/session")) {
      sessionRequests.push(String(options && options.body || ""));
      return {
        ok: true,
        async json() {
          return {
            session_id: "session-2",
            playlist_url: "/video/stream.m3u8?id=session-2",
            start_time_seconds: 18,
            encoded_media_end_seconds: 0,
            subtitle_stream_index: null,
            video_mode: "video_transcode",
            video_mode_reason: "forced_video_transcode",
          };
        },
      };
    }
    throw new Error("Unexpected fetch url: " + requestUrl);
  };
  global.window = {
    setTimeout(callback) {
      timerCallback = callback;
      return 321;
    },
    clearTimeout() {},
  };
  initCompatibility(ctx);
  ctx.attachCompatibilityVideo = function () {};

  await ctx.handleCompatibilityHlsError({
    type: "mediaError",
    details: "bufferAppendError",
    fatal: true,
  });

  assert.equal(typeof timerCallback, "function");
  await timerCallback();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sessionRequests.length, 1);
  assert.equal(stopRequests.length, 1);
  assert.match(stopRequests[0], /id=session-1/);
  assert.match(sessionRequests[0], /force_video_transcode=1/);
  assert.match(sessionRequests[0], /start_time_seconds=18/);
});

test("audio-copy fatal HLS media error schedules forced-audio-transcode recovery once", async () => {
  const {initCompatibility} = await importModuleFromWorkspace("dropbox_browser/assets/js/video/compatibility.js");
  const item = {path: "Videos/copy.mkv"};
  const ctx = createCtx(item);
  ctx.state.compatibilitySessionVideoMode = "video_transcode";
  ctx.state.compatibilitySessionVideoModeReason = "video_copy_not_supported";
  ctx.state.compatibilitySessionAudioMode = "audio_copy";
  ctx.state.compatibilitySessionAudioModeReason = "selected_aac_stream_copy_safe";
  let recoverMediaErrorCalls = 0;
  ctx.state.hlsController = {
    recoverMediaError() {
      recoverMediaErrorCalls += 1;
    },
  };
  global.window = {
    setTimeout() {
      return 456;
    },
    clearTimeout() {},
  };
  initCompatibility(ctx);

  await ctx.handleCompatibilityHlsError({
    type: "mediaError",
    details: "bufferAppendError",
    fatal: true,
  });

  const fallbackKey = ctx.compatibilityForcedAudioTranscodeRetryKey(item.path, 18);
  assert.equal(recoverMediaErrorCalls, 0);
  assert.equal(ctx.state.compatibilityRecoveryScheduled, true);
  assert.equal(ctx.state.compatibilityRecoveryForceAudioTranscode, true);
  assert.equal(ctx.state.compatibilityRecoveryFallbackKey, fallbackKey);
  assert.equal(ctx.state.compatibilityForcedAudioTranscodeRetryKeys[fallbackKey], true);
  assert.match(ctx._lastStatus, /retrying with audio transcode/i);

  ctx.clearCompatibilityRecoveryTimer();
  const scheduledAgain = ctx.scheduleCompatibilityAudioCopyFallback(
    "hls-media-audio-copy-fallback",
    18,
    { type: "mediaError", fatal: true }
  );
  assert.equal(scheduledAgain, false);
  assert.equal(ctx.state.compatibilityRecoveryAttempts, 1);
});

test("audio-copy forced-transcode recovery recreates the session instead of seeking in-session", async () => {
  const {initCompatibility} = await importModuleFromWorkspace("dropbox_browser/assets/js/video/compatibility.js");
  const item = {path: "Videos/copy.mkv"};
  const ctx = createCtx(item);
  ctx.state.compatibilitySessionVideoMode = "video_transcode";
  ctx.state.compatibilitySessionVideoModeReason = "video_copy_not_supported";
  ctx.state.compatibilitySessionAudioMode = "audio_copy";
  ctx.state.compatibilitySessionAudioModeReason = "selected_aac_stream_copy_safe";
  const sessionRequests = [];
  const stopRequests = [];
  let timerCallback = null;
  global.fetch = async function (url, options) {
    const requestUrl = String(url || "");
    if (requestUrl.includes("/video/endpoints/session/stop")) {
      stopRequests.push(String(options && options.body || ""));
      return { ok: true, async json() { return { status: "ok" }; } };
    }
    if (requestUrl.includes("/video/endpoints/session")) {
      sessionRequests.push(String(options && options.body || ""));
      return {
        ok: true,
        async json() {
          return {
            session_id: "session-2",
            playlist_url: "/video/stream.m3u8?id=session-2",
            start_time_seconds: 18,
            encoded_media_end_seconds: 0,
            subtitle_stream_index: null,
            video_mode: "video_transcode",
            video_mode_reason: "video_copy_not_supported",
            audio_mode: "audio_transcode",
            audio_mode_reason: "forced_audio_transcode",
          };
        },
      };
    }
    throw new Error("Unexpected fetch url: " + requestUrl);
  };
  global.window = {
    setTimeout(callback) {
      timerCallback = callback;
      return 654;
    },
    clearTimeout() {},
  };
  initCompatibility(ctx);
  ctx.attachCompatibilityVideo = function () {};

  await ctx.handleCompatibilityHlsError({
    type: "mediaError",
    details: "bufferAppendError",
    fatal: true,
  });

  assert.equal(typeof timerCallback, "function");
  await timerCallback();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sessionRequests.length, 1);
  assert.equal(stopRequests.length, 1);
  assert.match(stopRequests[0], /id=session-1/);
  assert.match(sessionRequests[0], /force_audio_transcode=1/);
  assert.match(sessionRequests[0], /start_time_seconds=18/);
});

test("stale restart cleanup stops only the session created by that restart", async () => {
  const {initCompatibility} = await importModuleFromWorkspace("dropbox_browser/assets/js/video/compatibility.js");
  const item = {path: "Videos/copy.mkv"};
  const ctx = createCtx(item);
  const stopRequests = [];
  const sessionRequests = [];
  global.fetch = async function (url, options) {
    const requestUrl = String(url || "");
    if (requestUrl.includes("/video/endpoints/session/stop")) {
      stopRequests.push(String(options && options.body || ""));
      return { ok: true, async json() { return { status: "ok" }; } };
    }
    if (requestUrl.includes("/video/endpoints/session")) {
      sessionRequests.push(String(options && options.body || ""));
      ctx.state.playbackSyncToken = 99;
      ctx.state.compatibilitySessionId = "session-3";
      return {
        ok: true,
        async json() {
          return {
            session_id: "session-2",
            playlist_url: "/video/stream.m3u8?id=session-2",
            start_time_seconds: 18,
            encoded_media_end_seconds: 0,
            subtitle_stream_index: null,
            video_mode: "video_transcode",
            video_mode_reason: "forced_video_transcode",
          };
        },
      };
    }
    throw new Error("Unexpected fetch url: " + requestUrl);
  };
  global.window = { setTimeout, clearTimeout };
  initCompatibility(ctx);

  await ctx.restartCompatibilityAt(18, "scrub", { forceSessionRestart: true });

  assert.equal(sessionRequests.length, 1);
  assert.equal(stopRequests.length, 2);
  assert.match(stopRequests[0], /id=session-1/);
  assert.match(stopRequests[0], /transition_token=8/);
  assert.match(stopRequests[1], /id=session-2/);
  assert.match(stopRequests[1], /transition_token=8/);
  assert.doesNotMatch(stopRequests[1], /id=session-3/);
  assert.equal(ctx.state.compatibilitySessionId, "session-3");
});

test("missing-session HLS 404 stops playback instead of scheduling generic recovery", async () => {
  const {initCompatibility} = await importModuleFromWorkspace("dropbox_browser/assets/js/video/compatibility.js");
  const item = {path: "Videos/copy.mkv"};
  const ctx = createCtx(item);
  const requests = [];
  let destroyCalls = 0;
  ctx.state.hlsController = {
    destroy() {
      destroyCalls += 1;
    },
  };
  global.fetch = async function (url) {
    requests.push(String(url || ""));
    return {
      ok: true,
      async json() {
        return {
          active_session: null,
          active_sessions: [],
        };
      },
    };
  };
  global.window = {
    setTimeout() {
      throw new Error("Recovery timer should not be scheduled when the session is missing.");
    },
    clearTimeout() {},
  };
  initCompatibility(ctx);

  await ctx.handleCompatibilityHlsError({
    type: "networkError",
    details: "fragLoadError",
    fatal: true,
    reason: "HTTP Error 404 Not Found",
    frag: { url: "/video/endpoints/session/file?id=session-1&name=segment_00000.m4s" },
  });

  assert.deepEqual(requests, ["/video/endpoints/status?id=session-1"]);
  assert.equal(ctx.state.compatibilityRecoveryScheduled, false);
  assert.equal(ctx.state.compatibilityRecoveryTimer, 0);
  assert.equal(ctx.state.compatibilitySessionId, "");
  assert.equal(ctx.state.transportWantsPlay, false);
  assert.equal(ctx.state.pendingAutoplay, false);
  assert.equal(destroyCalls, 1);
  assert.match(ctx._lastStatus, /compatibility playback stopped/i);
  assert.ok(ctx._lastPlaceholder);
  assert.match(ctx._lastPlaceholder.meta, /no longer available/i);
});

test("local-session HLS 404 still schedules recovery when filtered status says the session exists", async () => {
  const {initCompatibility} = await importModuleFromWorkspace("dropbox_browser/assets/js/video/compatibility.js");
  const item = {path: "Videos/copy.mkv"};
  const ctx = createCtx(item);
  const requests = [];
  const scheduled = [];
  global.fetch = async function (url) {
    requests.push(String(url || ""));
    return {
      ok: true,
      async json() {
        return {
          active_session: null,
          active_sessions: [{
            session_id: "session-1",
            path: "Videos/copy.mkv",
            encoded_media_end_seconds: 24,
          }],
        };
      },
    };
  };
  global.window = {
    setTimeout(callback, delay) {
      scheduled.push({callback, delay});
      return scheduled.length;
    },
    clearTimeout() {},
  };
  initCompatibility(ctx);

  await ctx.handleCompatibilityHlsError({
    type: "networkError",
    details: "fragLoadError",
    fatal: true,
    reason: "HTTP Error 404 Not Found",
    frag: { url: "/video/endpoints/session/file?id=session-1&name=segment_00000.m4s" },
  });

  assert.deepEqual(requests, ["/video/endpoints/status?id=session-1"]);
  assert.equal(ctx.state.compatibilityRecoveryScheduled, true);
  assert.equal(scheduled.length, 1);
  assert.equal(ctx.state.compatibilitySessionId, "session-1");
});

test("compatibility session progress report posts session id, global time, media time, state, and sync token", async () => {
  const {initCompatibility} = await importModuleFromWorkspace("dropbox_browser/assets/js/video/compatibility.js");
  const item = {path: "Videos/copy.mkv"};
  const ctx = createCtx(item);
  const requests = [];
  ctx.state.compatibilityStartSeconds = 120;
  ctx.els.videoEl.currentTime = 12.5;
  ctx.els.videoEl.paused = false;
  ctx.currentGlobalPlaybackSeconds = function () {
    return 132.5;
  };
  global.fetch = async function (url, options) {
    requests.push({
      url: String(url || ""),
      body: String(options && options.body || ""),
    });
    return {
      ok: true,
      async json() {
        return {status: "ok", updated: true};
      },
    };
  };
  global.window = { setTimeout, clearTimeout };
  initCompatibility(ctx);

  const reported = await ctx.reportCompatibilitySessionProgress("manual");

  assert.equal(reported, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/video/endpoints/session/progress");
  assert.match(requests[0].body, /id=session-1/);
  assert.match(requests[0].body, /client_id=client-123/);
  assert.match(requests[0].body, /playback_seconds=132\.5/);
  assert.match(requests[0].body, /playback_media_seconds=12\.5/);
  assert.match(requests[0].body, /playback_state=playing/);
  assert.match(requests[0].body, /playback_sync_token=7/);
});

test("stale compatibility session progress for the local session stops playback with the session-state message", async () => {
  const {initCompatibility} = await importModuleFromWorkspace("dropbox_browser/assets/js/video/compatibility.js");
  const item = {path: "Videos/copy.mkv"};
  const ctx = createCtx(item);
  let destroyCalls = 0;
  ctx.state.hlsController = {
    destroy() {
      destroyCalls += 1;
    },
  };
  global.fetch = async function () {
    return {
      ok: true,
      async json() {
        return {
          status: "ok",
          updated: false,
          stale: true,
          session_id: "session-1",
          session_state: "expired",
          session_state_message: "Video session expired after being idle.",
          stale_reason: "expired",
          active_session_id: "",
        };
      },
    };
  };
  global.window = {
    setTimeout() {
      throw new Error("Stale local-session progress should not reschedule progress polling.");
    },
    clearTimeout() {},
  };
  initCompatibility(ctx);

  const reported = await ctx.reportCompatibilitySessionProgress("manual");

  assert.equal(reported, false);
  assert.equal(ctx.state.compatibilitySessionId, "");
  assert.equal(ctx.state.pendingAutoplay, false);
  assert.equal(ctx.state.transportWantsPlay, false);
  assert.equal(destroyCalls, 1);
  assert.match(ctx._lastStatus, /expired after being idle/i);
  assert.ok(ctx._lastPlaceholder);
  assert.match(ctx._lastPlaceholder.meta, /expired after being idle/i);
});

test("stale compatibility session progress for a replaced session remains harmless", async () => {
  const {initCompatibility} = await importModuleFromWorkspace("dropbox_browser/assets/js/video/compatibility.js");
  const item = {path: "Videos/copy.mkv"};
  const ctx = createCtx(item);
  const scheduled = [];
  global.fetch = async function () {
    return {
      ok: true,
      async json() {
        return {
          status: "ok",
          updated: false,
          stale: true,
          session_id: "session-1",
          session_state: "stopped",
          session_state_message: "Video session was stopped.",
          stale_reason: "stopped",
          active_session_id: "session-2",
        };
      },
    };
  };
  global.window = {
    setTimeout(callback, delay) {
      scheduled.push({callback, delay});
      return scheduled.length;
    },
    clearTimeout() {},
  };
  initCompatibility(ctx);
  ctx.state.compatibilitySessionId = "session-2";

  const reported = await ctx.reportCompatibilitySessionProgress("manual", {
    expectedSessionId: "session-2",
    reschedule: true,
  });

  assert.equal(reported, false);
  assert.equal(ctx.state.compatibilitySessionId, "session-2");
  assert.equal(ctx._lastPlaceholder, null);
  assert.equal(scheduled.length, 1);
});

test("compatibility session progress reporting uses burst timing near startup and after burst settles", async () => {
  const {initCompatibility} = await importModuleFromWorkspace("dropbox_browser/assets/js/video/compatibility.js");
  const item = {path: "Videos/copy.mkv"};
  const ctx = createCtx(item);
  const scheduled = [];
  const originalDateNow = Date.now;
  let nowMs = 1000;
  try {
    Date.now = function () {
      return nowMs;
    };
    global.fetch = async function () {
      return { ok: true, async json() { return {status: "ok", updated: true}; } };
    };
    global.window = {
      setTimeout(callback, delay) {
        scheduled.push({callback, delay});
        return scheduled.length;
      },
      clearTimeout() {},
    };
    initCompatibility(ctx);

    ctx.els.videoEl.currentTime = 5;
    ctx.scheduleCompatibilitySessionProgressReport();
    assert.equal(scheduled[0].delay, 1000);

    ctx.armCompatibilityProgressBurst();
    scheduled.length = 0;
    ctx.scheduleCompatibilitySessionProgressReport();
    assert.equal(scheduled[0].delay, 1000);

    nowMs += 20000;
    ctx.els.videoEl.currentTime = 60;
    scheduled.length = 0;
    ctx.scheduleCompatibilitySessionProgressReport();
    assert.equal(scheduled[0].delay, 5000);
  }
  finally {
    Date.now = originalDateNow;
  }
});

test("compatibility session progress reporting suppresses stale scheduled sends after session change", async () => {
  const {initCompatibility} = await importModuleFromWorkspace("dropbox_browser/assets/js/video/compatibility.js");
  const item = {path: "Videos/copy.mkv"};
  const ctx = createCtx(item);
  const scheduled = [];
  const requests = [];
  global.fetch = async function (url, options) {
    requests.push({url: String(url || ""), body: String(options && options.body || "")});
    return { ok: true, async json() { return {status: "ok", updated: true}; } };
  };
  global.window = {
    setTimeout(callback, delay) {
      scheduled.push({callback, delay});
      return scheduled.length;
    },
    clearTimeout() {},
  };
  initCompatibility(ctx);

  ctx.scheduleCompatibilitySessionProgressReport(0, {
    expectedSessionId: "session-1",
    expectedSyncToken: 7,
    reschedule: false,
  });
  ctx.state.compatibilitySessionId = "session-2";
  await scheduled[0].callback();

  assert.equal(requests.length, 0);
});

test("stopCompatibilitySession posts session id and client id", async () => {
  const {initCompatibility} = await importModuleFromWorkspace("dropbox_browser/assets/js/video/compatibility.js");
  const item = {path: "Videos/copy.mkv"};
  const ctx = createCtx(item);
  const requests = [];
  global.fetch = async function (url, options) {
    requests.push({url: String(url || ""), body: String(options && options.body || "")});
    return { ok: true, async json() { return {status: "ok"}; } };
  };
  global.window = { setTimeout, clearTimeout };
  initCompatibility(ctx);

  await ctx.stopCompatibilitySession();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/video/endpoints/session/stop");
  assert.match(requests[0].body, /id=session-1/);
  assert.match(requests[0].body, /client_id=client-123/);
});

test("unload-safe session stop enables keepalive", async () => {
  const {initCompatibility} = await importModuleFromWorkspace("dropbox_browser/assets/js/video/compatibility.js");
  const item = {path: "Videos/copy.mkv"};
  const ctx = createCtx(item);
  const requests = [];
  global.fetch = async function (url, options) {
    requests.push({
      url: String(url || ""),
      body: String(options && options.body || ""),
      keepalive: Boolean(options && options.keepalive),
    });
    return { ok: true, async json() { return {status: "ok"}; } };
  };
  global.window = { setTimeout, clearTimeout };
  initCompatibility(ctx);

  await ctx.stopCompatibilitySession("session-beforeunload", {unloadSafe: true});

  assert.deepEqual(requests, [{
    url: "/video/endpoints/session/stop",
    body: "id=session-beforeunload&client_id=client-123",
    keepalive: true,
  }]);
});

test("unload-safe session stop can identify a session still being created by client id", async () => {
  const {initCompatibility} = await importModuleFromWorkspace("dropbox_browser/assets/js/video/compatibility.js");
  const item = {path: "Videos/copy.mkv"};
  const ctx = createCtx(item);
  ctx.state.compatibilitySessionId = "";
  const requests = [];
  global.fetch = async function (url, options) {
    requests.push({
      url: String(url || ""),
      body: String(options && options.body || ""),
      keepalive: Boolean(options && options.keepalive),
    });
    return { ok: true, async json() { return {status: "ok"}; } };
  };
  global.window = { setTimeout, clearTimeout };
  initCompatibility(ctx);

  await ctx.stopCompatibilitySession("", {unloadSafe: true});

  assert.deepEqual(requests, [{
    url: "/video/endpoints/session/stop",
    body: "client_id=client-123",
    keepalive: true,
  }]);
});

test("unload-safe session stop without an id or client id is a no-op", async () => {
  const {initCompatibility} = await importModuleFromWorkspace("dropbox_browser/assets/js/video/compatibility.js");
  const item = {path: "Videos/copy.mkv"};
  const ctx = createCtx(item);
  ctx.state.compatibilitySessionId = "";
  ctx.state.videoClientId = "";
  const requests = [];
  global.fetch = async function (url) {
    requests.push(String(url || ""));
    return { ok: true, async json() { return {status: "ok"}; } };
  };
  global.window = { setTimeout, clearTimeout };
  initCompatibility(ctx);

  await ctx.stopCompatibilitySession("", {unloadSafe: true});

  assert.equal(requests.length, 0);
});

test("client-owned session stop can clean up navigation races without keepalive", async () => {
  const {initCompatibility} = await importModuleFromWorkspace("dropbox_browser/assets/js/video/compatibility.js");
  const item = {path: "Videos/copy.mkv"};
  const ctx = createCtx(item);
  ctx.state.compatibilitySessionId = "session-1";
  const requests = [];
  global.fetch = async function (url, options) {
    requests.push({
      url: String(url || ""),
      body: String(options && options.body || ""),
      keepalive: Boolean(options && options.keepalive),
    });
    return { ok: true, async json() { return {status: "ok"}; } };
  };
  global.window = { setTimeout, clearTimeout };
  initCompatibility(ctx);

  await ctx.stopCompatibilitySession("", {clientOwned: true});

  assert.deepEqual(requests, [{
    url: "/video/endpoints/session/stop",
    body: "client_id=client-123",
    keepalive: false,
  }]);
});

test("stopCompatibilitySession can clear local session state before the stop request settles", async () => {
  const {initCompatibility} = await importModuleFromWorkspace("dropbox_browser/assets/js/video/compatibility.js");
  const item = {path: "Videos/copy.mkv"};
  const ctx = createCtx(item);
  const requests = [];
  var resolveFetch;
  global.fetch = function (url, options) {
    requests.push({url: String(url || ""), body: String(options && options.body || "")});
    return new Promise(function (resolve) {
      resolveFetch = resolve;
    });
  };
  global.window = { setTimeout, clearTimeout };
  initCompatibility(ctx);

  const stopPromise = ctx.stopCompatibilitySession("", {clearLocalFirst: true});

  assert.equal(requests.length, 1);
  assert.equal(ctx.state.compatibilitySessionId, "");
  resolveFetch({ ok: true, async json() { return {status: "ok"}; } });
  await stopPromise;

  assert.equal(ctx.state.compatibilitySessionId, "");
});

test("stopCompatibilitySession leaves newer local session state intact after stopping stale snapshot", async () => {
  const {initCompatibility} = await importModuleFromWorkspace("dropbox_browser/assets/js/video/compatibility.js");
  const item = {path: "Videos/copy.mkv"};
  const ctx = createCtx(item);
  const requests = [];
  global.fetch = async function (url, options) {
    requests.push({url: String(url || ""), body: String(options && options.body || "")});
    ctx.state.compatibilitySessionId = "session-newer";
    return { ok: true, async json() { return {status: "ok"}; } };
  };
  global.window = { setTimeout, clearTimeout };
  initCompatibility(ctx);

  await ctx.stopCompatibilitySession("session-stale");

  assert.equal(requests.length, 1);
  assert.equal(ctx.state.compatibilitySessionId, "session-newer");
});

test("stopCompatibilitySession can stop an explicit session id snapshot", async () => {
  const {initCompatibility} = await importModuleFromWorkspace("dropbox_browser/assets/js/video/compatibility.js");
  const item = {path: "Videos/copy.mkv"};
  const ctx = createCtx(item);
  const requests = [];
  global.fetch = async function (url, options) {
    requests.push({url: String(url || ""), body: String(options && options.body || "")});
    return { ok: true, async json() { return {status: "ok"}; } };
  };
  global.window = { setTimeout, clearTimeout };
  initCompatibility(ctx);
  ctx.state.compatibilitySessionId = "session-newer";

  await ctx.stopCompatibilitySession("session-beforeunload");

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/video/endpoints/session/stop");
  assert.match(requests[0].body, /id=session-beforeunload/);
  assert.doesNotMatch(requests[0].body, /id=session-newer/);
  assert.match(requests[0].body, /client_id=client-123/);
});

test("playback stale session create stops only the returned stale session id", async () => {
  const {initPlayback} = await importModuleFromWorkspace("dropbox_browser/assets/js/video/playback.js");
  const item = {path: "Videos/copy.mkv"};
  const ctx = createCtx(item);
  ctx.state.playbackStatusLoaded = true;
  const stoppedSessions = [];
  ctx.postStopCompatibilitySession = async function (sessionId, options) {
    stoppedSessions.push([String(sessionId || ""), options && options.transitionToken]);
  };
  ctx.createCompatibilitySession = async function () {
    ctx.state.playbackSyncToken = 9;
    ctx.state.compatibilitySessionId = "session-newer";
    return {
      status: "ok",
      session_id: "session-stale-created",
      playlist_url: "/video/endpoints/session/file?id=session-stale-created&name=stream.m3u8",
      start_time_seconds: 0,
      encoded_media_end_seconds: 0,
      hls_segment_duration_seconds: 6,
      session_create_elapsed_ms: 1,
      video_mode: "video_copy",
      video_mode_reason: "selected_h264_stream_copy_safe",
      audio_mode: "audio_transcode",
      audio_mode_reason: "audio_copy_not_supported",
      subtitle_stream_index: null,
    };
  };
  initPlayback(ctx);

  await ctx.playbackApi.syncForActiveItem();

  assert.deepEqual(stoppedSessions, [["session-stale-created", 8]]);
  assert.equal(ctx.state.compatibilitySessionId, "session-newer");
});

test("playback leaving the active queue exits expanded layout before showing the empty state", async () => {
  const {initPlayback} = await importModuleFromWorkspace("dropbox_browser/assets/js/video/playback.js");
  const ctx = createCtx({path: "Videos/cleared.mkv"});
  const exits = [];
  ctx.activeQueueItem = function () {
    return null;
  };
  ctx.state.activeQueueIndex = -1;
  ctx.exitToEmbeddedPlaybackLayout = function () {
    exits.push("embedded");
  };
  initPlayback(ctx);

  await ctx.playbackApi.syncForActiveItem();

  assert.deepEqual(exits, ["embedded"]);
  assert.deepEqual(ctx._lastPlaceholder, {
    title: "No video selected",
    meta: "Queue a video to start compatibility playback.",
  });
});

test("playback navigation stops the previous path before creating the next session", async () => {
  const {initPlayback} = await importModuleFromWorkspace("dropbox_browser/assets/js/video/playback.js");
  const alpha = {path: "Videos/alpha.mkv"};
  const bravo = {path: "Videos/bravo.mkv"};
  const ctx = createCtx(bravo);
  let active = bravo;
  const events = [];
  ctx.activeQueueItem = function () {
    return active;
  };
  ctx.state.playbackStatusLoaded = true;
  ctx.state.compatibilitySessionId = "session-alpha";
  ctx.state.compatibilitySessionPath = alpha.path;
  ctx.stopCompatibilitySession = async function (sessionId, options) {
    events.push(["stop", String(sessionId || ""), options && options.transitionToken]);
  };
  ctx.createCompatibilitySession = async function (item, audioStreamIndex, startSeconds, subtitleStreamIndex, options) {
    events.push(["create", item.path, options && options.transitionToken]);
    return {
      status: "ok",
      session_id: "session-bravo",
      playlist_url: "/video/endpoints/session/file?id=session-bravo&name=stream.m3u8",
      start_time_seconds: 0,
      encoded_media_end_seconds: 0,
      subtitle_stream_index: null,
    };
  };
  initPlayback(ctx);

  await ctx.playbackApi.syncForActiveItem();

  assert.deepEqual(events, [["stop", "session-alpha", 8], ["create", "Videos/bravo.mkv", 8]]);
  assert.equal(ctx.state.compatibilitySessionId, "session-bravo");
});

test("pane deactivation stops the local session id snapshot", async () => {
  const {initPane} = await importModuleFromWorkspace("dropbox_browser/assets/js/video/pane.js");
  const item = {path: "Videos/copy.mkv"};
  const ctx = createCtx(item);
  ctx.pane = makeEl();
  const stoppedSessionIds = [];
  ctx.stopCompatibilitySession = async function (sessionId) {
    stoppedSessionIds.push(String(sessionId || ""));
  };
  ctx.resetPlaybackSurface = function () {};
  initPane(ctx);
  ctx.state.compatibilitySessionId = "session-before-pane-close";

  ctx.paneApi.syncPaneMode("server-log");

  assert.deepEqual(stoppedSessionIds, ["session-before-pane-close"]);
});

test("compatibility status polling requests the local session id and updates local encoded range", async () => {
  const {initCompatibility} = await importModuleFromWorkspace("dropbox_browser/assets/js/video/compatibility.js");
  const item = {path: "Videos/copy.mkv"};
  const ctx = createCtx(item);
  const requests = [];
  const scheduled = [];
  let syncPlaybackProgressCalls = 0;
  ctx.syncPlaybackProgress = function () {
    syncPlaybackProgressCalls += 1;
  };
  global.fetch = async function (url) {
    requests.push(String(url || ""));
    return {
      ok: true,
      async json() {
        return {
          active_session: null,
          active_sessions: [{
            session_id: "session-1",
            path: "Videos/copy.mkv",
            encoded_media_end_seconds: 24,
          }],
        };
      },
    };
  };
  global.window = {
    setTimeout(callback, delay) {
      scheduled.push({callback, delay});
      return scheduled.length;
    },
    clearTimeout() {},
  };
  initCompatibility(ctx);

  await ctx.pollCompatibilitySessionStatus();

  assert.equal(requests.length, 1);
  assert.equal(requests[0], "/video/endpoints/status?id=session-1");
  assert.equal(ctx.state.compatibilityEncodedMediaEndSeconds, 24);
  assert.equal(syncPlaybackProgressCalls, 1);
  assert.equal(scheduled.length, 1);
});

test("compatibility status polling ignores mismatched compatibility alias when the local session is missing from filtered status", async () => {
  const {initCompatibility} = await importModuleFromWorkspace("dropbox_browser/assets/js/video/compatibility.js");
  const item = {path: "Videos/copy.mkv"};
  const ctx = createCtx(item);
  const scheduled = [];
  let syncPlaybackProgressCalls = 0;
  ctx.syncPlaybackProgress = function () {
    syncPlaybackProgressCalls += 1;
  };
  global.fetch = async function () {
    return {
      ok: true,
      async json() {
        return {
          active_session: {
            session_id: "other-session",
            path: "Videos/other.mkv",
            encoded_media_end_seconds: 60,
          },
          active_sessions: [],
        };
      },
    };
  };
  global.window = {
    setTimeout(callback, delay) {
      scheduled.push({callback, delay});
      return scheduled.length;
    },
    clearTimeout() {},
  };
  initCompatibility(ctx);

  await ctx.pollCompatibilitySessionStatus();

  assert.equal(ctx.state.compatibilityEncodedMediaEndSeconds, 0);
  assert.equal(syncPlaybackProgressCalls, 0);
  assert.equal(scheduled.length, 1);
});
