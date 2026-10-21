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

    // Video takes over on play; leaving the pane now clears the card.
    videoEl.dispatch("playing");
    assert.equal(mediaSession.mediaSessionOwner(), "video");
    assert.equal(session.metadata.title, "Episode A.mkv");
    ctx.syncPaneMode("music-player");
    assert.equal(mediaSession.mediaSessionOwner(), null);
    assert.equal(session.metadata, null);
    assert.equal(session.playbackState, "none");
    assert.equal(session.handlers.size, 0);
    assert.deepEqual(musicCalls, []);
  } finally {
    global.window = originalWindow;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
  }
});