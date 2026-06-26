const path = require("node:path");
const {pathToFileURL} = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  return import(pathToFileURL(absolutePath).href + `?t=${Date.now()}`);
}

function makeEl() {
  const styleValues = new Map();
  return {
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    removeAttribute() {},
    appendChild() {},
    replaceChildren() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    classList: {
      add() {},
      remove() {},
      toggle() {},
    },
    style: {
      setProperty(name, value) {
        styleValues.set(name, String(value));
      },
      getPropertyValue(name) {
        return styleValues.get(name) || "";
      },
    },
    hidden: false,
    textTracks: [],
    value: "",
  };
}

function createVideoEl() {
  const tracks = [];
  const videoEl = makeEl();
  videoEl.currentTime = 0;
  videoEl.textTracks = tracks;
  videoEl.appendChild = function (node) {
    node.isConnected = true;
    if (node.track) tracks.push(node.track);
  };
  videoEl.querySelectorAll = function () {
    return [];
  };
  return videoEl;
}

function createTrackNode() {
  return {
    kind: "",
    label: "",
    srclang: "",
    src: "",
    default: false,
    readyState: 2,
    isConnected: false,
    track: {
      kind: "subtitles",
      mode: "disabled",
      activeCues: [],
      addEventListener() {},
      removeEventListener() {},
    },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    remove() {
      this.isConnected = false;
    },
  };
}

function createCtx(activeItem) {
  return {
    els: {
      videoEl: createVideoEl(),
      progressSliderEl: makeEl(),
      elapsedTimeEl: makeEl(),
      totalTimeEl: makeEl(),
      subtitleOverlayEl: makeEl(),
      debugMetaEl: makeEl(),
      debugCurrentCueEl: makeEl(),
      debugNextCueEl: makeEl(),
    },
    state: {
      queue: [activeItem],
      activeQueueIndex: 0,
      playbackMode: "compatibility",
      seekRestartInProgress: false,
      playbackSyncToken: 7,
      compatibilityStartSeconds: 0,
      compatibilitySubtitleWaitStageActive: false,
      probeCache: Object.create(null),
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
    _subtitleWaitShown: false,
    activeQueueItem() {
      return activeItem;
    },
    activeItemPath() {
      return activeItem.path;
    },
    selectedSubtitleStreamIndex() {
      return 3;
    },
    subtitleTrackLabel() {
      return "English";
    },
    compatibilitySeekableRanges() {
      return [{start: 0, end: 600}];
    },
    playbackSyncTokenIsCurrent(syncToken) {
      return syncToken === this.state.playbackSyncToken;
    },
    showLoadingOverlay() {},
    loadingOverlayCopy() {
      return {};
    },
    setPlaybackSummary() {},
    activeItemTitle() {
      return "Movie";
    },
    currentGlobalPlaybackSeconds() {
      return Number(this.els.videoEl.currentTime) || 0;
    },
    formatPlaybackTime(seconds) {
      return String(Number(seconds) || 0);
    },
    setStatus(message) {
      this._lastStatus = String(message || "");
    },
    reportSubtitleSyncDiagnostic() {},
    reportSubtitleDiagnostic() {},
    showCompatibilitySubtitleWaitStage() {
      this._subtitleWaitShown = true;
    },
    hideVideoElement() {},
    destroyHlsController() {},
    clearSubtitleOverlay() {},
    hlsErrorTargetsCurrentSession() {
      return true;
    },
  };
}

test("startup subtitle wait fetches only the initial subtitle window and records coverage", async () => {
  const [{initSubtitles}, {initCompatibility}] = await Promise.all([
    importModuleFromWorkspace("dropbox_browser/assets/js/video/subtitles.js"),
    importModuleFromWorkspace("dropbox_browser/assets/js/video/compatibility.js"),
  ]);
  const item = {path: "movie.mp4"};
  const ctx = createCtx(item);
  const probePayload = {
    subtitle_streams: [{index: 3, webvtt_compatible: true, language: "eng"}],
    default_subtitle_stream_index: 3,
  };
  ctx.state.probeCache[item.path] = probePayload;
  const requests = [];
  global.fetch = async function (url) {
    requests.push(String(url));
    return {
      ok: true,
      async json() {
        return {
          status: "ok",
          track: 3,
          window_start_seconds: 0,
          window_end_seconds: 300,
          coverage_complete: true,
          loaded_ranges: [{start_seconds: 0, end_seconds: 300}],
          gap_action: "pause-until-ready",
          window_status: "ready",
          vtt: "WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n",
        };
      },
    };
  };
  global.window = {setTimeout, clearTimeout};
  initSubtitles(ctx);
  initCompatibility(ctx);
  ctx.applySubtitlesForSeek = async function () {
    throw new Error("startup wait should not mount full subtitles");
  };

  await ctx.waitForCompatibilityStartupSubtitles(7, "playback-ready");

  assert.equal(requests.length, 1);
  assert.match(requests[0], /\/video\/endpoints\/subtitles\/window\?/);
  assert.match(requests[0], /track=3/);
  assert.match(requests[0], /start=0/);
  assert.match(requests[0], /duration=300/);
  assert.match(requests[0], /window_status=startup/);
  assert.match(requests[0], /playback_sync_token=7/);
  assert.deepEqual(ctx.state.subtitleCoverageByPath[item.path]["3"], [{start_seconds: 0, end_seconds: 300}]);
  assert.equal(Object.keys(ctx.state.subtitleFullVttCacheByPath[item.path] || {}).length, 0);
});

test("startup subtitle wait uses seek window policy for non-zero compatibility starts", async () => {
  const [{initSubtitles}, {initCompatibility}] = await Promise.all([
    importModuleFromWorkspace("dropbox_browser/assets/js/video/subtitles.js"),
    importModuleFromWorkspace("dropbox_browser/assets/js/video/compatibility.js"),
  ]);
  const item = {path: "movie.mp4"};
  const ctx = createCtx(item);
  ctx.state.compatibilityStartSeconds = 120;
  const probePayload = {
    subtitle_streams: [{index: 3, webvtt_compatible: true, language: "eng"}],
    default_subtitle_stream_index: 3,
  };
  ctx.state.probeCache[item.path] = probePayload;
  const requests = [];
  global.fetch = async function (url) {
    requests.push(String(url));
    return {
      ok: true,
      async json() {
        return {
          status: "ok",
          track: 3,
          window_start_seconds: 105,
          window_end_seconds: 405,
          coverage_complete: true,
          loaded_ranges: [{start_seconds: 105, end_seconds: 405}],
          gap_action: "pause-until-ready",
          window_status: "ready",
          vtt: "WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n",
        };
      },
    };
  };
  global.window = {setTimeout, clearTimeout};
  initSubtitles(ctx);
  initCompatibility(ctx);

  await ctx.waitForCompatibilityStartupSubtitles(7, "restart");

  assert.equal(requests.length, 1);
  assert.match(requests[0], /start=105/);
  assert.match(requests[0], /duration=300/);
  assert.match(requests[0], /window_status=seek/);
  assert.match(requests[0], /playback_sync_token=7/);
});

test("mountSubtitleTrackForItem mounts from a cached subtitle window and records mounted coverage", async () => {
  const [{initSubtitles}] = await Promise.all([
    importModuleFromWorkspace("dropbox_browser/assets/js/video/subtitles.js"),
  ]);
  const item = {path: "movie.mp4"};
  const ctx = createCtx(item);
  const probePayload = {
    subtitle_streams: [{index: 3, webvtt_compatible: true, language: "eng"}],
    default_subtitle_stream_index: 3,
  };
  ctx.state.probeCache[item.path] = probePayload;
  global.document = {
    createElement(tagName) {
      assert.equal(tagName, "track");
      return createTrackNode();
    },
  };
  global.URL = {
    createObjectURL() {
      return "blob:test";
    },
    revokeObjectURL() {},
  };
  initSubtitles(ctx);
  ctx.storeSubtitleWindowPayload(item.path, 3, {
    status: "ok",
    track: 3,
    window_start_seconds: 0,
    window_end_seconds: 300,
    coverage_complete: true,
    loaded_ranges: [{start_seconds: 0, end_seconds: 300}],
    gap_action: "pause-until-ready",
    window_status: "ready",
    vtt: "WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n",
  });

  const mounted = ctx.mountSubtitleTrackForItem(item, probePayload, 3, 0, {
    playbackSyncToken: 7,
    silent: true,
  });

  assert.equal(mounted, true);
  assert.equal(ctx.state.subtitleMountedStreamIndex, 3);
  assert.equal(ctx.state.subtitleMountedSeekSeconds, 0);
  assert.deepEqual(ctx.state.subtitleMountedWindowByPath[item.path]["3"], {
    start_seconds: 0,
    end_seconds: 300,
  });
  assert.equal(ctx.state.subtitleDebug.cues.length, 1);
});

test("mountSubtitleTrackForItem does not mount from a cached subtitle window outside its covered range", async () => {
  const [{initSubtitles}] = await Promise.all([
    importModuleFromWorkspace("dropbox_browser/assets/js/video/subtitles.js"),
  ]);
  const item = {path: "movie.mp4"};
  const ctx = createCtx(item);
  const probePayload = {
    subtitle_streams: [{index: 3, webvtt_compatible: true, language: "eng"}],
    default_subtitle_stream_index: 3,
  };
  ctx.state.probeCache[item.path] = probePayload;
  global.document = {
    createElement() {
      return createTrackNode();
    },
  };
  global.URL = {
    createObjectURL() {
      return "blob:test";
    },
    revokeObjectURL() {},
  };
  initSubtitles(ctx);
  ctx.storeSubtitleWindowPayload(item.path, 3, {
    status: "ok",
    track: 3,
    window_start_seconds: 0,
    window_end_seconds: 60,
    coverage_complete: true,
    loaded_ranges: [{start_seconds: 0, end_seconds: 60}],
    gap_action: "pause-until-ready",
    window_status: "ready",
    vtt: "WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n",
  });

  const mounted = ctx.mountSubtitleTrackForItem(item, probePayload, 3, 120, {
    playbackSyncToken: 7,
    silent: true,
  });

  assert.equal(mounted, false);
  assert.equal(ctx.state.subtitleMountedStreamIndex, null);
  assert.equal(ctx.state.subtitleDebug.cues.length, 0);
});

test("applySubtitlesForSeek remounts immediately from cached coverage during in-session seek", async () => {
  const [{initSubtitles}] = await Promise.all([
    importModuleFromWorkspace("dropbox_browser/assets/js/video/subtitles.js"),
  ]);
  const item = {path: "movie.mp4"};
  const ctx = createCtx(item);
  const probePayload = {
    subtitle_streams: [{index: 3, webvtt_compatible: true, language: "eng"}],
    default_subtitle_stream_index: 3,
  };
  ctx.state.probeCache[item.path] = probePayload;
  global.document = {
    createElement() {
      return createTrackNode();
    },
  };
  global.URL = {
    createObjectURL() {
      return "blob:test";
    },
    revokeObjectURL() {},
  };
  global.fetch = async function () {
    throw new Error("covered seek should not fetch a new subtitle window");
  };
  initSubtitles(ctx);
  ctx.storeSubtitleWindowPayload(item.path, 3, {
    status: "ok",
    track: 3,
    window_start_seconds: 105,
    window_end_seconds: 405,
    coverage_complete: true,
    loaded_ranges: [{start_seconds: 105, end_seconds: 405}],
    gap_action: "pause-until-ready",
    window_status: "ready",
    vtt: "WEBVTT\n\n02:00.000 --> 02:01.000\nHello\n",
  });

  await ctx.applySubtitlesForSeek(item, probePayload, 0, {
    coverageTargetSeconds: 120,
    playbackSyncToken: 7,
    silent: true,
  });

  assert.equal(ctx.state.subtitleMountedStreamIndex, 3);
  assert.equal(ctx.state.subtitleMountedSeekSeconds, 0);
  assert.deepEqual(ctx.state.subtitleMountedWindowByPath[item.path]["3"], {
    start_seconds: 105,
    end_seconds: 405,
  });
  assert.equal(ctx.state.subtitleDebug.cues.length, 1);
  assert.equal(ctx.state.subtitleDebug.cues[0].start, 120);
  assert.equal(ctx._subtitleWaitShown, false);
});

test("applySubtitlesForSeek fetches an uncovered seek window and mounts it once ready", async () => {
  const [{initSubtitles}] = await Promise.all([
    importModuleFromWorkspace("dropbox_browser/assets/js/video/subtitles.js"),
  ]);
  const item = {path: "movie.mp4"};
  const ctx = createCtx(item);
  const probePayload = {
    subtitle_streams: [{index: 3, webvtt_compatible: true, language: "eng"}],
    default_subtitle_stream_index: 3,
  };
  ctx.state.probeCache[item.path] = probePayload;
  const requests = [];
  global.document = {
    createElement() {
      return createTrackNode();
    },
  };
  global.URL = {
    createObjectURL() {
      return "blob:test";
    },
    revokeObjectURL() {},
  };
  global.fetch = async function (url) {
    requests.push(String(url));
    return {
      ok: true,
      async json() {
        return {
          status: "ok",
          track: 3,
          window_start_seconds: 105,
          window_end_seconds: 405,
          coverage_complete: true,
          loaded_ranges: [{start_seconds: 105, end_seconds: 405}],
          gap_action: "pause-until-ready",
          window_status: "ready",
          vtt: "WEBVTT\n\n02:00.000 --> 02:01.000\nHello\n",
        };
      },
    };
  };
  initSubtitles(ctx);

  await ctx.applySubtitlesForSeek(item, probePayload, 0, {
    coverageTargetSeconds: 120,
    playbackSyncToken: 7,
    reloadReason: "scrub-in-session",
    silent: true,
  });

  assert.equal(requests.length, 1);
  assert.match(requests[0], /\/video\/endpoints\/subtitles\/window\?/);
  assert.match(requests[0], /start=105/);
  assert.match(requests[0], /window_status=seek/);
  assert.equal(ctx.state.subtitleMountedStreamIndex, 3);
  assert.deepEqual(ctx.state.subtitleMountedWindowByPath[item.path]["3"], {
    start_seconds: 105,
    end_seconds: 405,
  });
  assert.equal(ctx._subtitleWaitShown, true);
  assert.equal(ctx._lastStatus, "Loading subtitle track.");
});

test("applySubtitlesForSeek reuses cached seek windows on repeated covered seeks", async () => {
  const [{initSubtitles}] = await Promise.all([
    importModuleFromWorkspace("dropbox_browser/assets/js/video/subtitles.js"),
  ]);
  const item = {path: "movie.mp4"};
  const ctx = createCtx(item);
  const probePayload = {
    subtitle_streams: [{index: 3, webvtt_compatible: true, language: "eng"}],
    default_subtitle_stream_index: 3,
  };
  ctx.state.probeCache[item.path] = probePayload;
  const requests = [];
  global.document = {
    createElement() {
      return createTrackNode();
    },
  };
  global.URL = {
    createObjectURL() {
      return "blob:test";
    },
    revokeObjectURL() {},
  };
  global.fetch = async function (url) {
    requests.push(String(url));
    return {
      ok: true,
      async json() {
        return {
          status: "ok",
          track: 3,
          window_start_seconds: 105,
          window_end_seconds: 405,
          coverage_complete: true,
          loaded_ranges: [{start_seconds: 105, end_seconds: 405}],
          gap_action: "pause-until-ready",
          window_status: "ready",
          vtt: "WEBVTT\n\n02:00.000 --> 02:01.000\nHello\n",
        };
      },
    };
  };
  initSubtitles(ctx);

  await ctx.applySubtitlesForSeek(item, probePayload, 0, {
    coverageTargetSeconds: 120,
    playbackSyncToken: 7,
    silent: true,
  });
  ctx.clearSubtitleTrack();
  await ctx.applySubtitlesForSeek(item, probePayload, 0, {
    coverageTargetSeconds: 130,
    playbackSyncToken: 7,
    silent: true,
  });

  assert.equal(requests.length, 1);
  assert.equal(ctx.state.subtitleMountedStreamIndex, 3);
  assert.deepEqual(ctx.state.subtitleMountedWindowByPath[item.path]["3"], {
    start_seconds: 105,
    end_seconds: 405,
  });
});

test("syncProcessedProgressTrack clamps the displayed loaded band to selected subtitle coverage", async () => {
  const [{initShared}, {initSubtitles}] = await Promise.all([
    importModuleFromWorkspace("dropbox_browser/assets/js/video/shared.js"),
    importModuleFromWorkspace("dropbox_browser/assets/js/video/subtitles.js"),
  ]);
  const item = {path: "movie.mp4"};
  const ctx = createCtx(item);
  const probePayload = {
    subtitle_streams: [{index: 3, webvtt_compatible: true, language: "eng"}],
    default_subtitle_stream_index: 3,
  };
  ctx.state.probeCache[item.path] = probePayload;
  ctx.els.videoEl.duration = 600;
  ctx.els.videoEl.currentTime = 350;
  initSubtitles(ctx);
  initShared(ctx);
  ctx.storeSubtitleWindowPayload(item.path, 3, {
    status: "ok",
    track: 3,
    window_start_seconds: 300,
    window_end_seconds: 405,
    coverage_complete: true,
    loaded_ranges: [{start_seconds: 300, end_seconds: 405}],
    gap_action: "pause-until-ready",
    window_status: "ready",
    vtt: "WEBVTT\n\n05:00.000 --> 05:01.000\nHello\n",
  });

  ctx.syncProcessedProgressTrack(600);

  assert.equal(ctx.els.progressSliderEl.style.getPropertyValue("--video-progress-processed-start"), "50.000%");
  assert.equal(ctx.els.progressSliderEl.style.getPropertyValue("--video-progress-processed-end"), "67.500%");
});
