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
  const attrValues = new Map();
  return {
    addEventListener() {},
    removeEventListener() {},
    setAttribute(name, value) {
      attrValues.set(String(name), String(value));
    },
    getAttribute(name) {
      return attrValues.has(String(name)) ? attrValues.get(String(name)) : null;
    },
    removeAttribute(name) {
      attrValues.delete(String(name));
    },
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
      playbackStageEl: makeEl(),
      loadingOverlayEl: makeEl(),
      loadingTitleEl: makeEl(),
      loadingMetaEl: makeEl(),
      loadingProgressEl: makeEl(),
      loadingProgressLabelEl: makeEl(),
      placeholderEl: makeEl(),
      progressSliderEl: makeEl(),
      elapsedTimeEl: makeEl(),
      totalTimeEl: makeEl(),
      subtitleOverlayEl: makeEl(),
      subtitleStatusBannerEl: makeEl(),
      subtitleStatusTitleEl: makeEl(),
      subtitleStatusMetaEl: makeEl(),
      subtitleTrackSelectEl: makeEl(),
      debugMetaEl: makeEl(),
      debugCurrentTitleEl: makeEl(),
      debugCurrentCueEl: makeEl(),
      debugNextTitleEl: makeEl(),
      debugNextCueEl: makeEl(),
    },
    state: {
      queue: [activeItem],
      activeQueueIndex: 0,
      playbackMode: "compatibility",
      backpressureThresholds: {
        lowWaterSeconds: 45,
        mediumWaterSeconds: 120,
        highWaterSeconds: 300,
        maxWaterSeconds: 600,
      },
      seekRestartInProgress: false,
      playbackSyncToken: 7,
      compatibilityStartSeconds: 0,
      compatibilitySegmentDurationSeconds: 0,
      compatibilityPlaylistSegmentCount: 0,
      compatibilityLoadedSegmentMinIndex: 0,
      compatibilityLoadedSegmentMaxIndex: 0,
      compatibilityLoadedSegmentIndicesByKey: Object.create(null),
      compatibilitySegmentLoadSampleCount: 0,
      compatibilitySegmentLoadAverageMs: 0,
      compatibilitySegmentLoadWindowStartMs: NaN,
      compatibilitySegmentFetchSampleCount: 0,
      compatibilitySegmentFetchAverageMs: 0,
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
      subtitleMountState: {
        mode: "none",
        path: "",
        streamIndex: null,
        seekSeconds: 0,
        coverageStartSeconds: null,
        coverageEndSeconds: null,
        playbackSyncToken: null,
        generation: 0,
      },
      subtitlePlaybackSyncState: {
        path: "",
        streamIndex: null,
        mountedSeekSeconds: 0,
        playbackSyncToken: null,
        mountGeneration: 0,
        outsideCoverageObserved: false,
      },
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
    selectedBurnedInSubtitleStreamIndex() {
      return null;
    },
    resolvedSubtitleStreamIndex() {
      return 3;
    },
    subtitleTrackLabel() {
      return "English";
    },
    subtitleTrackLayoutKey() {
      return "default";
    },
    setStoredSubtitleTrackPreference() {},
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
    reportVideoDiagnostic() {},
    showCompatibilitySubtitleWaitStage() {
      this._subtitleWaitShown = true;
    },
    hideVideoElement() {},
    destroyHlsController() {},
    clearSubtitleOverlay() {},
    syncTransportControls() {},
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
  assert.equal(ctx.state.subtitleMountState.mode, "window");
  assert.equal(ctx.state.subtitleMountState.path, item.path);
  assert.equal(ctx.state.subtitleMountState.streamIndex, 3);
  assert.equal(ctx.state.subtitleMountState.seekSeconds, 0);
  assert.equal(ctx.state.subtitleMountState.coverageStartSeconds, 0);
  assert.equal(ctx.state.subtitleMountState.coverageEndSeconds, 300);
  assert.deepEqual(ctx.state.subtitleMountedWindowByPath[item.path]["3"], {
    start_seconds: 0,
    end_seconds: 300,
  });
  assert.equal(ctx.subtitleMountCoversTarget(item, 3, 0, 120), true);
  assert.equal(ctx.subtitleMountCoversTarget(item, 3, 0, 303), false);
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
  assert.equal(ctx.state.subtitleMountState.streamIndex, null);
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

  assert.equal(ctx.state.subtitleMountState.streamIndex, 3);
  assert.equal(ctx.state.subtitleMountState.seekSeconds, 0);
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
  const diagnostics = [];
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
  ctx.reportSubtitleSyncDiagnostic = function (fields) {
    diagnostics.push(Object.assign({}, fields));
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
  assert.equal(ctx.state.subtitleMountState.streamIndex, 3);
  assert.deepEqual(ctx.state.subtitleMountedWindowByPath[item.path]["3"], {
    start_seconds: 105,
    end_seconds: 405,
  });
  assert.equal(ctx._subtitleWaitShown, true);
  assert.equal(ctx._lastStatus, "Loading subtitle track.");
  assert.equal(diagnostics.some((entry) => entry.message === "Subtitle waiting on missing coverage"), true);
  assert.equal(diagnostics.some((entry) => entry.message === "Subtitle window request started"), true);
  assert.equal(diagnostics.some((entry) => entry.message === "Subtitle window request ready"), true);
  const mountFromCacheEntries = diagnostics.filter((entry) => entry.message === "Subtitle mount from cache");
  assert.equal(mountFromCacheEntries.length > 0, true);
  assert.equal(mountFromCacheEntries[mountFromCacheEntries.length - 1].subtitle_cache_source, "window");
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
  assert.equal(ctx.state.subtitleMountState.streamIndex, 3);
  assert.deepEqual(ctx.state.subtitleMountedWindowByPath[item.path]["3"], {
    start_seconds: 105,
    end_seconds: 405,
  });
});

test("full cached subtitles clear stale mounted window coverage and stay mounted past the startup window", async () => {
  const [{initSubtitles}] = await Promise.all([
    importModuleFromWorkspace("dropbox_browser/assets/js/video/subtitles.js"),
  ]);
  const item = {path: "movie.mp4"};
  const ctx = createCtx(item);
  const probePayload = {
    subtitle_streams: [{index: 3, webvtt_compatible: true, language: "eng"}],
    default_subtitle_stream_index: 3,
    duration_seconds: 24,
  };
  ctx.state.probeCache[item.path] = probePayload;
  ctx.state.selectedSubtitleStreamIndexByPath[item.path] = 3;
  global.document = {
    createElement() {
      return createTrackNode();
    },
  };
  global.URL = {
    createObjectURL() {
      return "blob:test-full-cache";
    },
    revokeObjectURL() {},
  };
  initSubtitles(ctx);
  ctx.storeSubtitleWindowPayload(item.path, 3, {
    status: "ok",
    track: 3,
    window_start_seconds: 0,
    window_end_seconds: 12,
    coverage_complete: false,
    loaded_ranges: [{start_seconds: 0, end_seconds: 12}],
    gap_action: "pause-until-ready",
    window_status: "ready",
    vtt: "WEBVTT\n\n00:00:10.000 --> 00:00:12.000\nSEEK-WINDOW-ENG\n",
  }, {
    mounted: true,
  });
  assert.equal(ctx.state.subtitleMountedWindowByPath[item.path]["3"].end_seconds, 12);
  ctx.storeFullSubtitleVtt(
    item.path,
    3,
    "WEBVTT\n\n00:00:10.000 --> 00:00:12.000\nSEEK-WINDOW-ENG\n"
      + "\n00:00:16.000 --> 00:00:18.000\nSEEK-WINDOW-ENG AGAIN\n",
  );

  const mounted = ctx.mountSubtitleTrackForItem(item, probePayload, 3, 0, {
    playbackSyncToken: 7,
    silent: true,
    coverageTargetSeconds: 17,
  });

  assert.equal(mounted, true);
  assert.equal(ctx.state.subtitleMountState.streamIndex, 3);
  assert.equal(ctx.state.subtitleMountState.mode, "full");
  assert.equal(ctx.state.subtitleMountState.path, item.path);
  assert.equal(ctx.state.subtitleMountState.streamIndex, 3);
  assert.equal(ctx.state.subtitleMountState.coverageStartSeconds, null);
  assert.equal(ctx.state.subtitleMountState.coverageEndSeconds, null);
  assert.equal(ctx.state.subtitleMountedWindowByPath[item.path]["3"], undefined);
  assert.equal(ctx.subtitleMountCoversTarget(item, 3, 0, 17), true);
  assert.equal(
    ctx.subtitlesAreMounted(item, 3, 0, 17),
    true,
  );
});

test("subtitlesAreMounted ignores stale legacy mounted-window metadata when full mount state is active", async () => {
  const [{initSubtitles}] = await Promise.all([
    importModuleFromWorkspace("dropbox_browser/assets/js/video/subtitles.js"),
  ]);
  const item = {path: "movie.mp4"};
  const ctx = createCtx(item);
  initSubtitles(ctx);

  ctx.recordFullSubtitleMount(item, 3, 0, {
    playbackSyncToken: 7,
  });
  ctx.state.subtitleMountedWindowByPath[item.path] = Object.assign(Object.create(null), {
    3: {
      start_seconds: 0,
      end_seconds: 12,
    },
  });
  ctx.els.videoEl.textTracks.push({
    kind: "subtitles",
    mode: "hidden",
    activeCues: [],
    addEventListener() {},
    removeEventListener() {},
  });

  assert.equal(ctx.subtitlesAreMounted(item, 3, 0, 17), true);
});

test("subtitlesAreMounted does not treat debug or legacy mounted fields as authority", async () => {
  const [{initSubtitles}] = await Promise.all([
    importModuleFromWorkspace("dropbox_browser/assets/js/video/subtitles.js"),
  ]);
  const item = {path: "movie.mp4"};
  const ctx = createCtx(item);
  initSubtitles(ctx);

  ctx.state.subtitleMountedWindowByPath[item.path] = Object.assign(Object.create(null), {
    3: {
      start_seconds: 0,
      end_seconds: 300,
    },
  });
  ctx.state.subtitleDebug.trackLabel = "English";
  ctx.state.subtitleDebug.cues = [{
    start: 0,
    end: 1,
    text: "Hello",
  }];
  ctx.els.videoEl.textTracks.push({
    kind: "subtitles",
    mode: "hidden",
    activeCues: [],
    addEventListener() {},
    removeEventListener() {},
  });

  assert.equal(ctx.state.subtitleMountState.mode, "none");
  assert.equal(ctx.subtitlesAreMounted(item, 3, 0, 17), false);
});

test("mountedSubtitleSeekSeconds reads the explicit subtitle mount state", async () => {
  const [{initSubtitles}] = await Promise.all([
    importModuleFromWorkspace("dropbox_browser/assets/js/video/subtitles.js"),
  ]);
  const item = {path: "movie.mp4"};
  const ctx = createCtx(item);
  initSubtitles(ctx);

  assert.equal(ctx.mountedSubtitleSeekSeconds(), 0);

  ctx.recordWindowSubtitleMount(item, 3, 12, {
    window_start_seconds: 10,
    window_end_seconds: 20,
  }, {
    playbackSyncToken: 7,
  });
  assert.equal(ctx.mountedSubtitleSeekSeconds(), 12);
});

test("shouldRefreshSubtitlesForPlaybackTime triggers once when playback first crosses outside mounted window coverage", async () => {
  const [{initSubtitles}] = await Promise.all([
    importModuleFromWorkspace("dropbox_browser/assets/js/video/subtitles.js"),
  ]);
  const item = {path: "movie.mp4"};
  const ctx = createCtx(item);
  initSubtitles(ctx);

  ctx.recordWindowSubtitleMount(item, 3, 0, {
    window_start_seconds: 0,
    window_end_seconds: 12,
  }, {
    playbackSyncToken: 7,
  });

  assert.equal(ctx.shouldRefreshSubtitlesForPlaybackTime(item, 3, 10), false);
  assert.equal(ctx.shouldRefreshSubtitlesForPlaybackTime(item, 3, 17), true);
  assert.equal(ctx.shouldRefreshSubtitlesForPlaybackTime(item, 3, 18), false);

  ctx.recordWindowSubtitleMount(item, 3, 12, {
    window_start_seconds: 12,
    window_end_seconds: 24,
  }, {
    playbackSyncToken: 7,
  });

  assert.equal(ctx.shouldRefreshSubtitlesForPlaybackTime(item, 3, 18), false);
  assert.equal(ctx.shouldRefreshSubtitlesForPlaybackTime(item, 3, 27), true);
});

test("shouldRefreshSubtitlesForPlaybackTime keeps full-cache steady playback as a no-op", async () => {
  const [{initSubtitles}] = await Promise.all([
    importModuleFromWorkspace("dropbox_browser/assets/js/video/subtitles.js"),
  ]);
  const item = {path: "movie.mp4"};
  const ctx = createCtx(item);
  initSubtitles(ctx);

  ctx.recordFullSubtitleMount(item, 3, 0, {
    playbackSyncToken: 7,
  });

  assert.equal(ctx.shouldRefreshSubtitlesForPlaybackTime(item, 3, 17), false);
  assert.equal(ctx.shouldRefreshSubtitlesForPlaybackTime(item, 3, 18), false);
});

test("storeFullSubtitleVtt clears obsolete mounted window metadata before the next remount", async () => {
  const [{initSubtitles}] = await Promise.all([
    importModuleFromWorkspace("dropbox_browser/assets/js/video/subtitles.js"),
  ]);
  const item = {path: "movie.mp4"};
  const ctx = createCtx(item);
  initSubtitles(ctx);

  ctx.storeSubtitleWindowPayload(item.path, 3, {
    status: "ok",
    track: 3,
    window_start_seconds: 0,
    window_end_seconds: 12,
    coverage_complete: false,
    loaded_ranges: [{start_seconds: 0, end_seconds: 12}],
    gap_action: "pause-until-ready",
    window_status: "ready",
    vtt: "WEBVTT\n\n00:00:10.000 --> 00:00:12.000\nSEEK-WINDOW-ENG\n",
  }, {
    mounted: true,
  });

  assert.deepEqual(ctx.state.subtitleMountedWindowByPath[item.path]["3"], {
    start_seconds: 0,
    end_seconds: 12,
  });
  ctx.storeFullSubtitleVtt(item.path, 3, "WEBVTT\n\n00:00:16.000 --> 00:00:18.000\nSEEK-WINDOW-ENG AGAIN\n");

  assert.equal(ctx.state.subtitleMountedWindowByPath[item.path]["3"], undefined);
});

test("clearSubtitleTrack resets explicit subtitle mount state", async () => {
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
      return "blob:test-reset";
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
  assert.equal(ctx.mountSubtitleTrackForItem(item, probePayload, 3, 0, {
    playbackSyncToken: 7,
    silent: true,
  }), true);

  ctx.clearSubtitleTrack();

  assert.equal(ctx.state.subtitleMountState.mode, "none");
  assert.equal(ctx.state.subtitleMountState.path, "");
  assert.equal(ctx.state.subtitleMountState.streamIndex, null);
  assert.equal(ctx.state.subtitleMountState.coverageStartSeconds, null);
  assert.equal(ctx.state.subtitleMountState.coverageEndSeconds, null);
  assert.equal(ctx.mountedSubtitleSeekSeconds(), 0);
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

  assert.equal(ctx.els.progressSliderEl.style.getPropertyValue("--video-progress-media-start"), "0.000%");
  assert.equal(ctx.els.progressSliderEl.style.getPropertyValue("--video-progress-media-end"), "100.000%");
  assert.equal(ctx.els.progressSliderEl.style.getPropertyValue("--video-progress-subtitle-start"), "50.000%");
  assert.equal(ctx.els.progressSliderEl.style.getPropertyValue("--video-progress-subtitle-end"), "67.500%");
  assert.equal(ctx.els.progressSliderEl.style.getPropertyValue("--video-progress-processed-start"), "50.000%");
  assert.equal(ctx.els.progressSliderEl.style.getPropertyValue("--video-progress-processed-end"), "67.500%");
  assert.equal(ctx.els.progressSliderEl.getAttribute("data-subtitle-coverage-state"), "limited");
  assert.deepEqual(ctx.currentProgressDebugLines(600), [
    "CPU priority: catch-up • loaded buffer ahead: 4:10.",
    "Loaded video: 0:00 - 10:00. Subtitle-ready: 5:00 - 6:45.",
  ]);
});

test("storeSubtitleWindowPayload expands scrubber coverage when a later background payload reports broader loaded ranges", async () => {
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
  initSubtitles(ctx);
  initShared(ctx);
  ctx.syncPlaybackProgress = function () {
    ctx.syncProcessedProgressTrack(600);
  };

  ctx.storeSubtitleWindowPayload(item.path, 3, {
    status: "ok",
    track: 3,
    window_start_seconds: 0,
    window_end_seconds: 120,
    coverage_complete: false,
    loaded_ranges: [{start_seconds: 0, end_seconds: 120}],
    gap_action: "pause-until-ready",
    window_status: "ready",
    vtt: "WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n",
  }, {
    background: true,
    mounted: true,
  });

  assert.equal(ctx.els.progressSliderEl.style.getPropertyValue("--video-progress-subtitle-end"), "20.000%");
  assert.equal(ctx.els.progressSliderEl.style.getPropertyValue("--video-progress-processed-end"), "20.000%");
  assert.equal(ctx.els.progressSliderEl.getAttribute("data-subtitle-coverage-state"), "limited");

  ctx.storeSubtitleWindowPayload(item.path, 3, {
    status: "ok",
    track: 3,
    window_start_seconds: 120,
    window_end_seconds: 600,
    coverage_complete: true,
    loaded_ranges: [{start_seconds: 0, end_seconds: 600}],
    gap_action: "pause-until-ready",
    window_status: "ready",
    vtt: "WEBVTT\n\n02:00.000 --> 02:01.000\nHello again\n",
  }, {
    background: true,
  });

  assert.equal(ctx.els.progressSliderEl.style.getPropertyValue("--video-progress-subtitle-end"), "100.000%");
  assert.equal(ctx.els.progressSliderEl.style.getPropertyValue("--video-progress-processed-end"), "100.000%");
  assert.equal(ctx.els.progressSliderEl.getAttribute("data-subtitle-coverage-state"), "full");
  assert.deepEqual(ctx.currentProgressDebugLines(600), [
    "CPU priority: catch-up • loaded buffer ahead: 10:00.",
    "Loaded video: 0:00 - 10:00. Subtitle-ready: 0:00 - 10:00.",
  ]);
});

test("syncProcessedProgressTrack reports paused heavy throttle state and current loaded buffer ahead in debug lines", async () => {
  const [{initShared}] = await Promise.all([
    importModuleFromWorkspace("dropbox_browser/assets/js/video/shared.js"),
  ]);
  const item = {path: "movie.mp4"};
  const ctx = createCtx(item);
  ctx.state.backpressureThresholds = {
    lowWaterSeconds: 45,
    mediumWaterSeconds: 120,
    highWaterSeconds: 300,
    maxWaterSeconds: 600,
  };
  ctx.state.compatibilityEncodedMediaEndSeconds = 360;
  ctx.state.compatibilityStartSeconds = 120;
  ctx.els.videoEl.currentTime = 90;
  ctx.els.videoEl.paused = true;
  initShared(ctx);

  ctx.syncProcessedProgressTrack(600);

  assert.deepEqual(ctx.currentProgressDebugLines(600), [
    "CPU priority: heavy-throttle • loaded buffer ahead: 6:30.",
    "Loaded video: 2:00 - 10:00.",
  ]);
});

test("syncSubtitleDebugDisplay shows HLS segment context, subtitle mode, and cue indices", async () => {
  const [{initShared}, {initSubtitles}] = await Promise.all([
    importModuleFromWorkspace("dropbox_browser/assets/js/video/shared.js"),
    importModuleFromWorkspace("dropbox_browser/assets/js/video/subtitles.js"),
  ]);
  const item = {path: "movie.mp4"};
  const ctx = createCtx(item);
  ctx.state.probeCache[item.path] = {
    subtitle_streams: [{index: 3, webvtt_compatible: true, language: "eng"}],
    default_subtitle_stream_index: 3,
    duration_seconds: 1800,
  };
  ctx.state.compatibilityStartSeconds = 90;
  ctx.state.compatibilitySegmentDurationSeconds = 6;
  ctx.state.compatibilityPlaylistSegmentCount = 300;
  ctx.state.compatibilityLoadedSegmentMinIndex = 67;
  ctx.state.compatibilityLoadedSegmentMaxIndex = 74;
  ctx.state.compatibilitySegmentLoadAverageMs = 420;
  ctx.state.subtitleDebug.trackLabel = "English";
  ctx.state.subtitleDebug.rawVtt = "WEBVTT";
  ctx.state.subtitleDebug.cues = [
    {start: 0, end: 2, text: "One", rawText: "One"},
    {start: 2, end: 4, text: "Two", rawText: "Two"},
    {start: 4, end: 6, text: "Three", rawText: "Three"},
  ];
  ctx.els.videoEl.currentTime = 1;
  initShared(ctx);
  initSubtitles(ctx);

  ctx.syncSubtitleDebugDisplay();

  assert.match(ctx.els.debugMetaEl.textContent, /HLS segment: \[16\/300\] 1:30:000 - 1:36:000/);
  assert.match(ctx.els.debugMetaEl.textContent, /Loaded HLS segments: \[82-89\/300\] • avg load: 0.42s • segment length: 6.00s/);
  assert.match(ctx.els.debugMetaEl.textContent, /Subtitle mode: webvtt/);
  assert.equal(ctx.els.debugCurrentTitleEl.textContent, "Current Subtitle [1/3]");
  assert.equal(ctx.els.debugNextTitleEl.textContent, "Next Subtitle [2/3]");
});

test("syncSubtitleDebugDisplay keeps HLS segment denominator at least as large as observed segment indices", async () => {
  const [{initShared}, {initSubtitles}] = await Promise.all([
    importModuleFromWorkspace("dropbox_browser/assets/js/video/shared.js"),
    importModuleFromWorkspace("dropbox_browser/assets/js/video/subtitles.js"),
  ]);
  const item = {path: "movie.mp4"};
  const ctx = createCtx(item);
  ctx.state.probeCache[item.path] = {
    subtitle_streams: [{index: 3, webvtt_compatible: true, language: "eng"}],
    default_subtitle_stream_index: 3,
    duration_seconds: 186.3,
  };
  ctx.state.compatibilityStartSeconds = 174.3;
  ctx.state.compatibilitySegmentDurationSeconds = 6;
  ctx.state.compatibilityCurrentSegmentIndex = 4;
  ctx.state.compatibilityLoadedSegmentMinIndex = 1;
  ctx.state.compatibilityLoadedSegmentMaxIndex = 7;
  ctx.state.compatibilitySegmentLoadAverageMs = 0;
  ctx.state.subtitleDebug.trackLabel = "English";
  ctx.els.videoEl.currentTime = 19;
  initShared(ctx);
  initSubtitles(ctx);

  ctx.syncSubtitleDebugDisplay();

  assert.match(ctx.els.debugMetaEl.textContent, /HLS segment: \[33\/36\] 3:12:300 - 3:18:300/);
  assert.match(ctx.els.debugMetaEl.textContent, /Loaded HLS segments: \[30-36\/36\] • avg load: n\/a • segment length: 6.00s/);
});

test("syncSubtitleDebugDisplay renders discontinuous loaded HLS segment ranges as absolute indices", async () => {
  const [{initShared}, {initSubtitles}] = await Promise.all([
    importModuleFromWorkspace("dropbox_browser/assets/js/video/shared.js"),
    importModuleFromWorkspace("dropbox_browser/assets/js/video/subtitles.js"),
  ]);
  const item = {path: "movie.mp4"};
  const ctx = createCtx(item);
  ctx.state.probeCache[item.path] = {
    subtitle_streams: [{index: 3, webvtt_compatible: true, language: "eng"}],
    default_subtitle_stream_index: 3,
    duration_seconds: 720,
  };
  ctx.state.compatibilityStartSeconds = 180;
  ctx.state.compatibilitySegmentDurationSeconds = 6;
  ctx.state.compatibilityLoadedSegmentIndicesByKey = {
    "1": true,
    "2": true,
    "5": true,
    "6": true,
  };
  ctx.state.compatibilitySegmentLoadAverageMs = 4120;
  ctx.state.subtitleDebug.trackLabel = "English";
  ctx.els.videoEl.currentTime = 0;
  initShared(ctx);
  initSubtitles(ctx);

  ctx.syncSubtitleDebugDisplay();

  assert.match(ctx.els.debugMetaEl.textContent, /Loaded HLS segments: \[31-32, 35-36\/120\] • avg load: 4.12s • segment length: 6.00s/);
});

test("compatibility segment load average uses segment arrival cadence", async () => {
  const [{initShared}, {initSubtitles}, {initCompatibility}] = await Promise.all([
    importModuleFromWorkspace("dropbox_browser/assets/js/video/shared.js"),
    importModuleFromWorkspace("dropbox_browser/assets/js/video/subtitles.js"),
    importModuleFromWorkspace("dropbox_browser/assets/js/video/compatibility.js"),
  ]);
  const item = {path: "movie.mp4"};
  const ctx = createCtx(item);
  let nowMs = 1000;
  global.window = {
    setTimeout,
    clearTimeout,
    performance: {
      now() {
        return nowMs;
      },
    },
  };
  initShared(ctx);
  initSubtitles(ctx);
  initCompatibility(ctx);

  ctx.noteCompatibilityFragmentLoading({frag: {sn: 0}});
  nowMs = 1400;
  ctx.noteCompatibilityFragmentLoaded({frag: {sn: 0}});
  nowMs = 1900;
  ctx.noteCompatibilityFragmentBuffered({frag: {sn: 0}}, "test", ctx.state.playbackSyncToken);

  ctx.noteCompatibilityFragmentLoading({frag: {sn: 1}});
  nowMs = 2000;
  ctx.noteCompatibilityFragmentLoaded({frag: {sn: 1}});
  nowMs = 2600;
  ctx.noteCompatibilityFragmentBuffered({frag: {sn: 1}}, "test", ctx.state.playbackSyncToken);

  assert.equal(ctx.state.compatibilitySegmentLoadSampleCount, 2);
  assert.equal(ctx.state.compatibilitySegmentLoadAverageMs, 500);
  assert.equal(ctx.state.compatibilitySegmentFetchSampleCount, 2);
  assert.equal(ctx.state.compatibilitySegmentFetchAverageMs, 250);
  assert.equal(ctx.state.compatibilityLoadedSegmentMinIndex, 1);
  assert.equal(ctx.state.compatibilityLoadedSegmentMaxIndex, 2);
});

test("compatibility segment fetch average prefers hls loader stats", async () => {
  const [{initShared}, {initSubtitles}, {initCompatibility}] = await Promise.all([
    importModuleFromWorkspace("dropbox_browser/assets/js/video/shared.js"),
    importModuleFromWorkspace("dropbox_browser/assets/js/video/subtitles.js"),
    importModuleFromWorkspace("dropbox_browser/assets/js/video/compatibility.js"),
  ]);
  const item = {path: "movie.mp4"};
  const ctx = createCtx(item);
  initShared(ctx);
  initSubtitles(ctx);
  initCompatibility(ctx);

  ctx.noteCompatibilityFragmentLoaded({
    frag: {sn: 0, stats: {loading: {start: 10, first: 30, end: 90}}},
  });
  ctx.noteCompatibilityFragmentLoaded({
    frag: {sn: 1, stats: {loading: {start: 20, first: 30, end: 180}}},
  });

  assert.equal(ctx.state.compatibilitySegmentLoadSampleCount, 2);
  assert.equal(ctx.state.compatibilitySegmentLoadAverageMs, 85);
  assert.equal(ctx.state.compatibilitySegmentFetchSampleCount, 2);
  assert.equal(ctx.state.compatibilitySegmentFetchAverageMs, 120);
});

test("handleSubtitleTrackChange requests the new text track against current playback coverage", async () => {
  const [{initTracks}] = await Promise.all([
    importModuleFromWorkspace("dropbox_browser/assets/js/video/tracks.js"),
  ]);
  const item = {path: "movie.mp4"};
  const ctx = createCtx(item);
  const probePayload = {
    subtitle_streams: [
      {index: 3, webvtt_compatible: true, language: "eng", title: "English"},
      {index: 4, webvtt_compatible: true, language: "fra", title: "French"},
    ],
    default_subtitle_stream_index: 3,
  };
  ctx.state.probeCache[item.path] = probePayload;
  ctx.state.selectedSubtitleStreamIndexByPath[item.path] = 3;
  ctx.els.subtitleTrackSelectEl = makeEl();
  ctx.els.subtitleTrackSelectEl.value = "4";
  ctx.els.subtitleTrackSelectEl.disabled = false;
  ctx.els.videoEl.currentTime = 18;
  ctx.subtitleStreamsForPayload = function (payload) {
    return Array.isArray(payload && payload.subtitle_streams) ? payload.subtitle_streams : [];
  };
  ctx.normalizeSubtitleStreamIndex = function (value) {
    if (value === "" || value === null || value === undefined) return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  };
  ctx.selectedSubtitleStream = function (active, payload) {
    const selected = ctx.state.selectedSubtitleStreamIndexByPath[active.path] || "";
    return ctx.subtitleStreamsForPayload(payload).find((stream) => Number(stream.index) === Number(selected)) || null;
  };
  ctx.subtitleStreamRequiresBurnIn = function () {
    return false;
  };
  ctx.compatibilitySessionHasBurnedInSubtitles = function () {
    return false;
  };
  ctx.persistSubtitleSelectionFromUi = function () {};
  ctx.clearSubtitleTrack = function () {};
  ctx.restartCompatibilityAt = async function () {
    throw new Error("text subtitle track switch should not restart compatibility playback");
  };
  const mountedChecks = [];
  ctx.subtitlesAreMounted = function (active, streamIndex, fetchStartSeconds, coverageTargetSeconds) {
    mountedChecks.push({active, streamIndex, fetchStartSeconds, coverageTargetSeconds});
    return false;
  };
  const mountCalls = [];
  ctx.mountSubtitleTrackForItem = function (active, payload, streamIndex, fetchStartSeconds, options) {
    mountCalls.push({active, payload, streamIndex, fetchStartSeconds, options});
    return false;
  };
  const seekCalls = [];
  ctx.applySubtitlesForSeek = async function (active, payload, fetchStartSeconds, options) {
    seekCalls.push({active, payload, fetchStartSeconds, options});
  };
  global.window = {
    localStorage: {
      getItem() {
        return null;
      },
      setItem() {},
      removeItem() {},
    },
  };

  initTracks(ctx);
  await ctx.handleSubtitleTrackChange();

  assert.equal(ctx.state.selectedSubtitleStreamIndexByPath[item.path], 4);
  assert.deepEqual(mountedChecks, [{
    active: item,
    streamIndex: 4,
    fetchStartSeconds: 0,
    coverageTargetSeconds: 18,
  }]);
  assert.equal(mountCalls.length, 1);
  assert.equal(mountCalls[0].streamIndex, 4);
  assert.equal(mountCalls[0].fetchStartSeconds, 0);
  assert.equal(mountCalls[0].options.coverageTargetSeconds, 18);
  assert.equal(seekCalls.length, 1);
  assert.equal(seekCalls[0].fetchStartSeconds, 0);
  assert.equal(seekCalls[0].options.coverageTargetSeconds, 18);
  assert.equal(seekCalls[0].options.reloadReason, "subtitle-track-change");
});

test("startup subtitle extraction failure surfaces an explicit subtitle error state", async () => {
  const [{initShared}, {initSubtitles}, {initCompatibility}] = await Promise.all([
    importModuleFromWorkspace("dropbox_browser/assets/js/video/shared.js"),
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
  global.fetch = async function () {
    return {
      ok: false,
    };
  };
  global.window = {setTimeout, clearTimeout};

  initShared(ctx);
  initSubtitles(ctx);
  initCompatibility(ctx);

  await ctx.waitForCompatibilityStartupSubtitles(ctx.state.playbackSyncToken, "test");

  assert.equal(ctx._lastStatus, "Subtitle extraction failed.");
  assert.equal(ctx.els.playbackStageEl.getAttribute("data-subtitle-state"), "error");
  assert.equal(ctx.els.subtitleTrackSelectEl.getAttribute("data-subtitle-state"), "error");
  assert.equal(ctx.els.subtitleStatusTitleEl.textContent, "Subtitle loading failed");
  assert.match(String(ctx.els.subtitleStatusMetaEl.textContent || ""), /startup playback window/i);
});
