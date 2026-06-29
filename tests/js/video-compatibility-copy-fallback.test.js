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
    },
    state: {
      paneActive: true,
      queue: [activeItem],
      activeQueueIndex: 0,
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
      compatibilityPlaybackRevealed: false,
      compatibilityPlaybackRevealPending: false,
      compatibilitySubtitleWaitStageActive: false,
      requestedSeekSeconds: null,
      hlsController: null,
      probeCache: Object.create(null),
      selectedAudioStreamIndexByPath: Object.create(null),
      selectedSubtitleStreamIndexByPath: Object.create(null),
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
    showPlaybackPlaceholder() {},
    resetPlaybackProgress() {},
    flushNativeSubtitleRenderSurface() {},
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
  assert.match(requests[0], /audio_stream_index=2/);
  assert.match(requests[0], /start_time_seconds=18/);
  assert.match(requests[0], /force_audio_transcode=1/);
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

  ctx.handleCompatibilityHlsError({
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
  let timerCallback = null;
  global.fetch = async function (url, options) {
    const requestUrl = String(url || "");
    if (requestUrl.includes("/video/endpoints/session/stop")) {
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

  ctx.handleCompatibilityHlsError({
    type: "mediaError",
    details: "bufferAppendError",
    fatal: true,
  });

  assert.equal(typeof timerCallback, "function");
  await timerCallback();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sessionRequests.length, 1);
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

  ctx.handleCompatibilityHlsError({
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
  let timerCallback = null;
  global.fetch = async function (url, options) {
    const requestUrl = String(url || "");
    if (requestUrl.includes("/video/endpoints/session/stop")) {
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

  ctx.handleCompatibilityHlsError({
    type: "mediaError",
    details: "bufferAppendError",
    fatal: true,
  });

  assert.equal(typeof timerCallback, "function");
  await timerCallback();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sessionRequests.length, 1);
  assert.match(sessionRequests[0], /force_audio_transcode=1/);
  assert.match(sessionRequests[0], /start_time_seconds=18/);
});
