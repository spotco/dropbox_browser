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
    style: {setProperty() {}},
    textTracks: [],
    querySelectorAll() {
      return [];
    },
    hidden: false,
    disabled: false,
    value: "0",
  });

  const ctx = {
    pane,
    body: {dataset: {currentFolderPath: ""}},
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
      pipButton: makeEl(),
      progressSliderEl: makeEl(),
      elapsedTimeEl: makeEl(),
      totalTimeEl: makeEl(),
      audioTrackSelectEl: makeEl(),
      subtitleTrackSelectEl: makeEl(),
      debugMetaEl: makeEl(),
      debugCurrentCueEl: makeEl(),
      debugNextCueEl: makeEl(),
      libraryListEl: makeEl(),
      queueListEl: makeEl(),
      libraryUpButton: makeEl(),
      libraryAddSelectedButton: makeEl(),
      queuePlayButton: makeEl(),
      queueRemoveButton: makeEl(),
      queueUpButton: makeEl(),
      queueDownButton: makeEl(),
      queueClearButton: makeEl(),
    },
    state: {
      paneActive: false,
      currentFolder: "",
      libraryItems: [],
      selectedLibraryPaths: Object.create(null),
      queue: [],
      selectedQueueIndex: -1,
      activeQueueIndex: -1,
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
      playbackSyncToken: 0,
      probeCache: Object.create(null),
      probeFailures: Object.create(null),
      selectedAudioStreamIndexByPath: Object.create(null),
      selectedSubtitleStreamIndexByPath: Object.create(null),
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
  ["dropbox_browser/assets/js/video/library.js", "initLibrary"],
  ["dropbox_browser/assets/js/video/queue.js", "initQueue"],
  ["dropbox_browser/assets/js/video/probe.js", "initProbe"],
  ["dropbox_browser/assets/js/video/tracks.js", "initTracks"],
  ["dropbox_browser/assets/js/video/compatibility.js", "initCompatibility"],
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