const path = require("node:path");
const {pathToFileURL} = require("node:url");
const test = require("node:test");
const assert = require("node:assert/strict");

async function importModuleFromWorkspace(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  return import(pathToFileURL(absolutePath).href + `?t=${Date.now()}`);
}

function createVideoCtx() {
  const pane = {
    setAttribute() {},
    dispatchEvent() {},
    addEventListener() {},
  };
  const makeEl = () => ({
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    removeAttribute() {},
    querySelector() {
      return null;
    },
    appendChild() {},
    replaceChildren() {},
    classList: {
      add() {},
      remove() {},
      toggle() {},
    },
    style: {setProperty() {}, removeProperty() {}, getPropertyValue() { return ""; }},
    textTracks: [],
    querySelectorAll() {
      return [];
    },
    hidden: false,
    disabled: false,
    value: "0",
    checked: true,
  });

  const ctx = {
    pane,
    body: {
      dataset: {currentFolderPath: ""},
      style: {setProperty() {}, removeProperty() {}, getPropertyValue() { return ""; }},
    },
    els: {
      pathEl: makeEl(),
      statusEl: makeEl(),
      titleEl: makeEl(),
      metaEl: makeEl(),
      placeholderEl: makeEl(),
      playbackSurfaceEl: makeEl(),
      playbackStageEl: makeEl(),
      loadingOverlayEl: makeEl(),
      loadingTitleEl: makeEl(),
      loadingMetaEl: makeEl(),
      loadingProgressEl: makeEl(),
      loadingProgressLabelEl: makeEl(),
      controlsOverlayEl: makeEl(),
      videoEl: makeEl(),
      subtitleOverlayEl: makeEl(),
      playToggleButton: makeEl(),
      muteToggleButton: makeEl(),
      volumeSliderEl: makeEl(),
      fullscreenButton: makeEl(),
      fullWindowButton: makeEl(),
      progressSliderEl: makeEl(),
      elapsedTimeEl: makeEl(),
      totalTimeEl: makeEl(),
      audioTrackSelectEl: makeEl(),
      subtitleTrackSelectEl: makeEl(),
      subtitleStyleControlsEl: makeEl(),
      subtitleShadowEnabledEl: makeEl(),
      subtitleStrokeEnabledEl: makeEl(),
      subtitleFontSizeInputEl: makeEl(),
      subtitleOffsetInputEl: makeEl(),
      subtitleStyleResetButtonEl: makeEl(),
      subtitleStyleApplyButtonEl: makeEl(),
      debugMetaEl: makeEl(),
      debugCurrentCueEl: makeEl(),
      debugNextCueEl: makeEl(),
      loadButton: makeEl(),
      treeEl: makeEl(),
      libraryPane: makeEl(),
      playlistListEl: makeEl(),
      playlistTableEl: makeEl(),
      playlistPane: makeEl(),
      shuffleButton: makeEl(),
      loopButton: makeEl(),
    },
    state: {
      paneActive: false,
      currentFolder: "",
      libraryItems: [],
      selectedLibraryPaths: Object.create(null),
      playlist: [],
      currentPlaylistIndex: -1,
      queue: [],
      selectedQueueIndex: -1,
      activeQueueIndex: -1,
      shuffleEnabled: false,
      loopPlaylist: false,
      loopQueue: false,
      shuffleBag: [],
      shuffleSequence: [],
      shuffleCursor: -1,
      loadingLibrary: false,
      loadingPlaybackStatus: false,
      playbackStatusLoaded: false,
      compatibilityAvailable: false,
      ffmpegAvailable: false,
      ffprobeAvailable: false,
      playbackMode: "none",
      lastPlaybackPath: "",
      pendingAutoplay: false,
      transportWantsPlay: false,
      compatibilitySessionId: "",
      compatibilitySessionPath: "",
      compatibilityAudioStreamIndex: null,
      compatibilitySessionBurnedInSubtitleStreamIndex: null,
      compatibilityEncodedMediaEndSeconds: 0,
      hlsController: null,
      compatibilityRecoveryAttempts: 0,
      compatibilityRecoveryTimer: 0,
      compatibilityRecoveryScheduled: false,
      compatibilityStartSeconds: 0,
      compatibilityBufferedFragmentCount: 0,
      compatibilitySessionStatusRequestInFlight: false,
      compatibilitySessionStatusTimer: 0,
      compatibilityPlaybackRevealed: false,
      compatibilityPlaybackRevealPending: false,
      compatibilitySubtitleWaitStageActive: false,
      compatibilitySubtitleStreamIndex: null,
      requestedSeekSeconds: null,
      seekRestartInProgress: false,
      pendingSubtitleStyleApply: false,
      playbackSyncToken: 0,
      probeCache: Object.create(null),
      probeFailures: Object.create(null),
      selectedAudioStreamIndexByPath: Object.create(null),
      selectedSubtitleStreamIndexByPath: Object.create(null),
      subtitleStyleDraft: null,
      subtitleStyleApplied: null,
      audioTrackPreferenceByLayout: Object.create(null),
      subtitleTrackPreferenceByLayout: Object.create(null),
      subtitleFullVttCacheByPath: Object.create(null),
      subtitleWarmInFlightByPath: Object.create(null),
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
      progressSliderActive: false,
      controlsIdleTimer: 0,
      controlsOverlayVisible: false,
      loadingOverlayVisible: false,
      loadingOverlayMeta: "",
      compatibilityManifestStallTimer: 0,
      playbackTiming: null,
      lastControlsRevealPointerKey: "",
      controlsScrubReveal: false,
    },
    setStatus() {},
    compatibilityApi: {
      restartAt() {},
      stopSession() {},
    },
    playbackApi: {
      syncForActiveItem() {},
    },
    subtitlesApi: {
      applyForSeek() {},
    },
    paneApi: {
      syncPaneMode() {},
    },
  };

  return ctx;
}

const MODULES = [
  ["dropbox_browser/assets/js/video/constants.js", null],
  ["dropbox_browser/assets/js/video/shared.js", "initShared"],
  ["dropbox_browser/assets/js/video/cache.js", "initCache"],
  ["dropbox_browser/assets/js/video/diagnostics.js", "initDiagnostics"],
  ["dropbox_browser/assets/js/video/media-library-bridge.js", "initMediaLibraryBridge"],
  ["dropbox_browser/assets/js/video/probe.js", "initProbe"],
  ["dropbox_browser/assets/js/video/tracks.js", "initTracks"],
  ["dropbox_browser/assets/js/video/compatibility.js", "initCompatibility"],
  ["dropbox_browser/assets/js/video/subtitle-mount-core.js", null],
  ["dropbox_browser/assets/js/video/subtitles.js", "initSubtitles"],
  ["dropbox_browser/assets/js/video/controls.js", "initControls"],
  ["dropbox_browser/assets/js/video/playback.js", "initPlayback"],
  ["dropbox_browser/assets/js/video/pane.js", "initPane"],
];

for (const [relativePath, initName] of MODULES) {
  test(`video module imports cleanly: ${relativePath}`, async () => {
    const mod = await importModuleFromWorkspace(relativePath);
    if (!initName) {
      assert.ok(Object.keys(mod).length > 0);
      return;
    }
    assert.equal(typeof mod[initName], "function");
    await assert.doesNotReject(async () => {
      mod[initName](createVideoCtx());
    });
  });
}

// ---- Media Session (system media controls) wiring in video/controls.js ----

const MEDIA_SESSION_PATH = path.resolve(__dirname, "..", "..", "dropbox_browser/assets/js/media-library/media-session.js");

function createFakeMediaSession() {
  return {
    handlers: new Map(),
    metadata: null,
    playbackState: "none",
    positionCalls: [],
    setActionHandler(action, handler) {
      if (handler) this.handlers.set(action, handler);
      else this.handlers.delete(action);
    },
    setPositionState(state) {
      this.positionCalls.push(state);
    },
  };
}

function createFakeVideoElement() {
  const listeners = new Map();
  const element = {
    hidden: false,
    paused: false,
    ended: false,
    muted: false,
    volume: 1,
    readyState: 4,
    duration: 600,
    videoWidth: 0,
    videoHeight: 0,
    playCalls: 0,
    pauseCalls: 0,
    currentTimeWrites: [],
    _currentTime: 100,
    get currentTime() {
      return this._currentTime;
    },
    set currentTime(value) {
      this.currentTimeWrites.push(value);
      this._currentTime = value;
    },
    addEventListener(name, handler) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(handler);
    },
    dispatch(name) {
      (listeners.get(name) || []).forEach((handler) => handler({}));
    },
    play() {
      this.playCalls += 1;
      this.paused = false;
      return Promise.resolve();
    },
    pause() {
      this.pauseCalls += 1;
      this.paused = true;
    },
  };
  return element;
}

async function createMediaSessionVideoHarness() {
  const mediaSession = await import(pathToFileURL(MEDIA_SESSION_PATH).href);
  const clock = {ms: 0};
  mediaSession.resetMediaSessionForTests(() => clock.ms);
  const session = createFakeMediaSession();
  Object.defineProperty(globalThis, "navigator", {value: {mediaSession: session}, configurable: true, writable: true});
  const windowListeners = new Map();
  global.window = {
    setTimeout() {
      return 1;
    },
    clearTimeout() {},
    addEventListener(name, handler) {
      windowListeners.set(name, handler);
    },
  };
  const videoEl = createFakeVideoElement();
  const restarts = [];
  const ctx = createVideoCtx();
  ctx.els = {
    videoEl,
    progressSliderEl: {min: "0", max: "0", value: "0", disabled: false, addEventListener() {}},
  };
  Object.assign(ctx.state, {
    queue: [{path: "videos/Episode A.mkv", display_name: "Episode A.mkv"}],
    activeQueueIndex: 0,
    playbackMode: "compatibility",
    compatibilityAvailable: true,
    transportWantsPlay: true,
    compatibilityStartSeconds: 0,
    paneActive: true,
  });
  Object.assign(ctx, {
    activeQueueItem() {
      const index = ctx.state.activeQueueIndex;
      return index >= 0 && index < ctx.state.queue.length ? ctx.state.queue[index] : null;
    },
    activeItemTitle(item) {
      return item ? item.display_name || item.path : "Selected video";
    },
    currentGlobalPlaybackSeconds() {
      return ctx.state.compatibilityStartSeconds + Number(videoEl.currentTime);
    },
    restartCompatibilityAt(target, reason) {
      restarts.push([target, reason]);
      return Promise.resolve();
    },
    reportPlaybackTiming() {},
    reportCompatibilitySeekTiming() {},
    resetCompatibilityRecoveryState() {},
    hideLoadingOverlay() {},
    setControlButtonState() {},
    resetProcessedProgressTrack() {},
    syncProcessedProgressTrack() {},
    formatNativePlaybackTime(value) {
      return String(value);
    },
    syncSubtitlesForCurrentPlaybackTime() {},
    syncSubtitleOverlayDisplay() {},
    syncSubtitleDebugDisplay() {},
    fullscreenHostElement() {
      return null;
    },
  });
  const {initControls} = await importModuleFromWorkspace("dropbox_browser/assets/js/video/controls.js");
  initControls(ctx);
  return {ctx, session, videoEl, restarts, mediaSession, windowListeners, clock};
}

test("video media-session seeks go through the compatibility restart, not videoEl.currentTime", async () => {
  const originalWindow = global.window;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    const {ctx, session, videoEl, restarts, mediaSession, windowListeners, clock} = await createMediaSessionVideoHarness();
    assert.equal(typeof windowListeners.get("pagehide"), "function");

    // Probe / placeholder states never publish: no metadata yet.
    videoEl.readyState = 0;
    videoEl.dispatch("playing");
    assert.equal(mediaSession.mediaSessionOwner(), null);

    videoEl.readyState = 4;
    videoEl.dispatch("playing");
    assert.equal(mediaSession.mediaSessionOwner(), "video");
    assert.equal(session.metadata.title, "Episode A.mkv");
    assert.equal(session.metadata.artist, "");
    assert.equal(session.playbackState, "playing");
    assert.deepEqual(session.positionCalls.at(-1), {duration: 600, playbackRate: 1, position: 100});

    session.handlers.get("seekforward")({action: "seekforward"});
    session.handlers.get("seekbackward")({action: "seekbackward", seekOffset: 5});
    session.handlers.get("seekto")({action: "seekto", seekTime: 300});
    session.handlers.get("seekto")({action: "seekto", seekTime: 5000});
    session.handlers.get("seekto")({action: "seekto"});
    assert.deepEqual(restarts, [
      [115, "step-forward-15"],
      [95, "step-back-15"],
      [300, "media-session-seek"],
      [599, "media-session-seek"],
    ]);
    assert.deepEqual(videoEl.currentTimeWrites, []);
    // The requested target is published at once instead of the stale element time.
    assert.equal(session.positionCalls.at(-1).position, 599);

    // While the restart runs, progress ticks publish requestedSeekSeconds.
    ctx.state.seekRestartInProgress = true;
    ctx.state.requestedSeekSeconds = 300;
    videoEl._currentTime = 2;
    videoEl.dispatch("pause");
    assert.equal(session.playbackState, "playing");
    clock.ms += 1500;
    ctx.syncPlaybackProgress();
    assert.equal(session.positionCalls.at(-1).position, 300);
    // A second tick inside the throttle window is not written.
    const positionWrites = session.positionCalls.length;
    clock.ms += 200;
    ctx.syncPlaybackProgress();
    assert.equal(session.positionCalls.length, positionWrites);
    ctx.state.seekRestartInProgress = false;
    ctx.state.requestedSeekSeconds = null;
    videoEl._currentTime = 100;

    // Pause / play map onto the transport branches.
    session.handlers.get("pause")();
    assert.equal(videoEl.pauseCalls, 1);
    assert.equal(ctx.state.transportWantsPlay, false);
    assert.equal(session.playbackState, "paused");
    assert.equal(mediaSession.mediaSessionOwner(), "video");

    // Play during the loading overlay only records intent (no second session).
    ctx.state.loadingOverlayVisible = true;
    const playsBefore = videoEl.playCalls;
    session.handlers.get("play")();
    assert.equal(videoEl.playCalls, playsBefore);
    assert.equal(ctx.state.transportWantsPlay, true);
    assert.equal(ctx.state.pendingAutoplay, true);
    assert.deepEqual(restarts.length, 4);
    ctx.state.loadingOverlayVisible = false;

    ctx.state.transportWantsPlay = false;
    videoEl.paused = true;
    session.handlers.get("play")();
    assert.equal(videoEl.playCalls, playsBefore + 1);
    assert.equal(session.playbackState, "playing");

    windowListeners.get("pagehide")();
    assert.equal(mediaSession.mediaSessionOwner(), null);
    assert.equal(session.metadata, null);
  } finally {
    global.window = originalWindow;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
  }
});

test("video pane deactivation releases only a video-owned media session", async () => {
  const originalWindow = global.window;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    const {ctx, session, videoEl, mediaSession} = await createMediaSessionVideoHarness();
    const {initPane} = await importModuleFromWorkspace("dropbox_browser/assets/js/video/pane.js");
    initPane(ctx);
    const stops = [];
    Object.assign(ctx, {
      exitToEmbeddedPlaybackLayout() {
        return Promise.resolve();
      },
      stopCompatibilitySession(sessionId) {
        stops.push(sessionId);
        return Promise.resolve();
      },
      resetPlaybackSurface() {},
      renderAudioTrackSelector() {},
      renderSubtitleTrackSelector() {},
    });
    const musicCalls = [];
    mediaSession.bindMediaSession("music", {
      play: () => musicCalls.push("play"),
      pause: () => musicCalls.push("pause"),
      next() {},
      previous() {},
      seekBy() {},
      seekTo() {},
    });

    // Music owns the session while video also has a loaded item.
    mediaSession.updateMediaSession("music", {
      title: "Song",
      artist: "Artist",
      playbackState: "playing",
      position: 5,
      duration: 180,
      canSeek: true,
    });
    ctx.syncPlaybackProgress();
    assert.equal(mediaSession.mediaSessionOwner(), "music");
    ctx.syncPaneMode("music-player");
    assert.equal(stops.length, 1);
    assert.equal(mediaSession.mediaSessionOwner(), "music");
    assert.equal(session.metadata.title, "Song");
    assert.equal(session.playbackState, "playing");
    assert.deepEqual(musicCalls, []);

    // Late events from the element left behind never reclaim from music.
    videoEl.dispatch("playing");
    videoEl.dispatch("play");
    assert.equal(mediaSession.mediaSessionOwner(), "music");
    assert.equal(session.metadata.title, "Song");

    // Video takes over on play; leaving the pane now clears the card.
    ctx.state.paneActive = true;
    videoEl.dispatch("playing");
    assert.equal(mediaSession.mediaSessionOwner(), "video");
    assert.equal(session.metadata.title, "Episode A.mkv");
    ctx.syncPaneMode("music-player");
    assert.equal(ctx.state.paneActive, false);
    assert.equal(mediaSession.mediaSessionOwner(), null);
    assert.equal(session.metadata, null);
    assert.equal(session.playbackState, "none");
    assert.equal(session.handlers.size, 0);
    assert.deepEqual(musicCalls, []);

    // A late "playing" / "play" / progress tick from the old HLS element after
    // deactivation keeps the session released.
    const positionWrites = session.positionCalls.length;
    videoEl.dispatch("playing");
    videoEl.dispatch("play");
    videoEl.dispatch("timeupdate");
    assert.equal(mediaSession.mediaSessionOwner(), null);
    assert.equal(session.metadata, null);
    assert.equal(session.playbackState, "none");
    assert.equal(session.handlers.size, 0);
    assert.equal(session.positionCalls.length, positionWrites);
  } finally {
    global.window = originalWindow;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
  }
});
test("OS seeks during a pending compatibility restart keep one restart in flight plus the latest target", async () => {
  const originalWindow = global.window;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    const {ctx, session, videoEl, restarts} = await createMediaSessionVideoHarness();
    const queued = [];
    ctx.reportCompatibilitySeekTiming = (name, payload) => queued.push([name, payload.queued_requested_time]);
    // Like restartCompatibilityAt: mark the restart in flight, then wait on stream creation.
    let finishStreamCreation;
    ctx.restartCompatibilityAt = (target, reason) => {
      restarts.push([target, reason]);
      ctx.state.requestedSeekSeconds = target;
      ctx.state.seekRestartInProgress = true;
      return new Promise((resolve) => {
        finishStreamCreation = resolve;
      });
    };
    videoEl.dispatch("playing");

    session.handlers.get("seekforward")({action: "seekforward"});
    session.handlers.get("seekforward")({action: "seekforward"});
    session.handlers.get("seekforward")({action: "seekforward", seekOffset: 30});
    session.handlers.get("seekto")({action: "seekto", seekTime: 400});
    session.handlers.get("seekbackward")({action: "seekbackward"});
    session.handlers.get("seekto")({action: "seekto", seekTime: 250});

    // One in-flight restart; every later seek only replaced the deferred target.
    assert.deepEqual(restarts, [[115, "step-forward-15"]]);
    assert.equal(ctx.state.requestedSeekSeconds, 250);
    assert.deepEqual(queued.map((entry) => entry[1]), [130, 160, 400, 385, 250]);
    assert.deepEqual(videoEl.currentTimeWrites, []);
    // The card shows the latest target, not the stale element time.
    assert.equal(session.positionCalls.at(-1).position, 250);

    // After the restart completes, the next OS seek starts a new restart again.
    ctx.state.seekRestartInProgress = false;
    ctx.state.requestedSeekSeconds = null;
    finishStreamCreation();
    session.handlers.get("seekto")({action: "seekto", seekTime: 50});
    assert.deepEqual(restarts, [[115, "step-forward-15"], [50, "media-session-seek"]]);
  } finally {
    global.window = originalWindow;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
  }
});

function installArtworkDom() {
  const canvases = [];
  const urls = {created: [], revoked: []};
  const originalDocument = global.document;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  global.document = {
    addEventListener() {},
    createElement(tag) {
      assert.equal(tag, "canvas");
      const canvas = {
        width: 0,
        height: 0,
        blobCallbacks: [],
        getContext() {
          return {drawImage() {}};
        },
        toBlob(callback) {
          canvas.blobCallbacks.push(callback);
        },
      };
      canvases.push(canvas);
      return canvas;
    },
  };
  URL.createObjectURL = () => {
    const url = `blob:frame-${urls.created.length + 1}`;
    urls.created.push(url);
    return url;
  };
  URL.revokeObjectURL = (url) => urls.revoked.push(url);
  return {
    canvases,
    urls,
    restore() {
      if (originalDocument === undefined) delete global.document;
      else global.document = originalDocument;
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    },
  };
}

test("video artwork capture waits for a decodable frame before spending attempts", async () => {
  const originalWindow = global.window;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const dom = installArtworkDom();
  try {
    const {ctx, session, videoEl} = await createMediaSessionVideoHarness();
    // Metadata only (no requestVideoFrameCallback, no frame yet).
    videoEl.readyState = 1;
    videoEl.dispatch("playing");
    for (let i = 0; i < 5; i += 1) ctx.syncPlaybackProgress();
    assert.equal(dom.canvases.length, 0);

    // First frame: one capture starts and stays in flight until toBlob settles.
    videoEl.readyState = 4;
    videoEl.videoWidth = 1280;
    videoEl.videoHeight = 720;
    ctx.syncPlaybackProgress();
    ctx.syncPlaybackProgress();
    ctx.syncPlaybackProgress();
    assert.equal(dom.canvases.length, 1);
    assert.equal(dom.canvases[0].width, 512);
    assert.equal(dom.canvases[0].height, 288);

    // An empty blob spends that attempt; the next tick tries once more.
    dom.canvases[0].blobCallbacks[0](null);
    ctx.syncPlaybackProgress();
    assert.equal(dom.canvases.length, 2);
    dom.canvases[1].blobCallbacks[0]({size: 2048});
    assert.deepEqual(dom.urls.created, ["blob:frame-1"]);
    assert.deepEqual(session.metadata.artwork, [{src: "blob:frame-1", type: "image/jpeg"}]);
    ctx.syncPlaybackProgress();
    assert.equal(dom.canvases.length, 2);
  } finally {
    dom.restore();
    global.window = originalWindow;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
  }
});

test("video artwork capture runs one at a time per item and never leaks a stale object URL", async () => {
  const originalWindow = global.window;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const dom = installArtworkDom();
  try {
    const {ctx, session, videoEl} = await createMediaSessionVideoHarness();
    ctx.state.queue.push({path: "videos/Episode B.mkv", display_name: "Episode B.mkv"});
    videoEl.videoWidth = 320;
    videoEl.videoHeight = 240;
    videoEl.dispatch("playing");
    assert.equal(dom.canvases.length, 1);
    ctx.syncPlaybackProgress();
    assert.equal(dom.canvases.length, 1);

    // The item changes while the first capture is still encoding.
    ctx.state.activeQueueIndex = 1;
    ctx.syncPlaybackProgress();
    assert.equal(dom.canvases.length, 2);
    assert.equal(session.metadata.title, "Episode B.mkv");

    // The stale callback for Episode A creates no URL and does not touch B.
    dom.canvases[0].blobCallbacks[0]({size: 1024});
    assert.deepEqual(dom.urls.created, []);
    assert.deepEqual(session.metadata.artwork, []);

    dom.canvases[1].blobCallbacks[0]({size: 1024});
    assert.deepEqual(dom.urls.created, ["blob:frame-1"]);
    assert.deepEqual(session.metadata.artwork, [{src: "blob:frame-1", type: "image/jpeg"}]);
    assert.deepEqual(dom.urls.revoked, []);

    // Changing item again revokes the superseded frame; release revokes the next.
    ctx.state.activeQueueIndex = 0;
    ctx.syncPlaybackProgress();
    assert.deepEqual(dom.urls.revoked, ["blob:frame-1"]);
    dom.canvases[2].blobCallbacks[0]({size: 1024});
    assert.deepEqual(dom.urls.created, ["blob:frame-1", "blob:frame-2"]);
    ctx.releaseVideoMediaSession();
    assert.deepEqual(dom.urls.revoked, ["blob:frame-1", "blob:frame-2"]);
  } finally {
    dom.restore();
    global.window = originalWindow;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
  }
});

test("a rejected video play() (autoplay block) publishes paused unless a newer request took over", async () => {
  const originalWindow = global.window;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    const {ctx, session, videoEl, mediaSession} = await createMediaSessionVideoHarness();
    const plays = [];
    videoEl.play = function () {
      this.playCalls += 1;
      let resolvePlay;
      let rejectPlay;
      const promise = new Promise((resolve, reject) => {
        resolvePlay = resolve;
        rejectPlay = reject;
      });
      plays.push({
        resolve: () => {
          this.paused = false;
          resolvePlay();
        },
        reject: () => rejectPlay(new Error("NotAllowedError")),
      });
      return promise;
    };
    const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));
    videoEl.dispatch("playing");
    videoEl.paused = true;
    ctx.state.transportWantsPlay = false;

    session.handlers.get("play")();
    assert.equal(mediaSession.mediaSessionOwner(), "video");
    assert.equal(session.playbackState, "playing");
    plays[0].reject();
    await flushMicrotasks();
    assert.equal(session.playbackState, "paused");
    assert.equal(ctx.state.transportWantsPlay, false);
    assert.equal(mediaSession.mediaSessionOwner(), "video");

    // Request A is still pending when request B starts; A's rejection is stale.
    session.handlers.get("play")();
    session.handlers.get("play")();
    assert.equal(plays.length, 3);
    plays[1].reject();
    await flushMicrotasks();
    assert.equal(session.playbackState, "playing");
    plays[2].resolve();
    await flushMicrotasks();
    assert.equal(session.playbackState, "playing");

    // A rejection after the item changed does not clobber the new item.
    videoEl.paused = true;
    ctx.state.transportWantsPlay = false;
    ctx.state.queue.push({path: "videos/Episode B.mkv", display_name: "Episode B.mkv"});
    session.handlers.get("play")();
    ctx.state.activeQueueIndex = 1;
    plays[3].reject();
    await flushMicrotasks();
    assert.equal(session.playbackState, "playing");
  } finally {
    global.window = originalWindow;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
  }
});
