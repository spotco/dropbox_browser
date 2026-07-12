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
  ["dropbox_browser/assets/js/video/library.js", "initLibrary"],
  ["dropbox_browser/assets/js/video/queue.js", "initQueue"],
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
