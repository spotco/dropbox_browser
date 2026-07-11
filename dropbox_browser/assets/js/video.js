import {advanceQueueAfterPlaybackEnd} from './video-core.js';
import {initShared} from './video/shared.js';
import {initCache} from './video/cache.js';
import {initDiagnostics} from './video/diagnostics.js';
import {initLibrary} from './video/library.js';
import {initQueue} from './video/queue.js';
import {initProbe} from './video/probe.js';
import {initTracks} from './video/tracks.js';
import {initCompatibility} from './video/compatibility.js';
import {initSubtitles} from './video/subtitles.js';
import {initControls} from './video/controls.js';
import {initPlayback} from './video/playback.js';
import {initPane} from './video/pane.js';

(function () {
  var pane = document.getElementById('video-player-pane');
  if (!pane) return;

  function createVideoClientId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return 'video-client-' + window.crypto.randomUUID();
    }
    return 'video-client-'
      + Date.now().toString(36)
      + '-'
      + Math.random().toString(36).slice(2, 10);
  }

  function readVideoSetting(key, fallback) {
    try {
      if (typeof Settings === 'undefined' || !Settings || typeof Settings.get !== 'function') return fallback;
      return Settings.get(key, fallback);
    }
    catch (_error) {
      return fallback;
    }
  }

  function writeVideoSetting(key, value) {
    try {
      if (typeof Settings === 'undefined' || !Settings || typeof Settings.set !== 'function') return;
      Settings.set(key, value);
    }
    catch (_error) {
      // Test contexts may provide partial Settings shims.
    }
  }

  var ctx = {
    pane: pane,
    els: {
      pathEl: document.getElementById('video-library-path'),
      statusEl: document.getElementById('video-player-status'),
      titleEl: document.getElementById('video-current-title'),
      metaEl: document.getElementById('video-current-meta'),
      placeholderEl: document.getElementById('video-playback-placeholder'),
      playbackSurfaceEl: document.getElementById('video-playback-surface'),
      playbackStageEl: document.getElementById('video-playback-stage'),
      loadingOverlayEl: document.getElementById('video-loading-overlay'),
      loadingTitleEl: document.getElementById('video-loading-title'),
      loadingMetaEl: document.getElementById('video-loading-meta'),
      loadingProgressEl: document.getElementById('video-loading-progress-fill'),
      loadingProgressLabelEl: document.getElementById('video-loading-progress-label'),
      subtitleStatusBannerEl: document.getElementById('video-subtitle-status-banner'),
      subtitleStatusTitleEl: document.getElementById('video-subtitle-status-title'),
      subtitleStatusMetaEl: document.getElementById('video-subtitle-status-meta'),
      controlsOverlayEl: document.getElementById('video-controls-overlay'),
      videoEl: document.getElementById('video-player-media'),
      subtitleOverlayEl: document.getElementById('video-subtitle-overlay'),
      playToggleButton: document.getElementById('video-play-toggle'),
      muteToggleButton: document.getElementById('video-mute-toggle'),
      volumeSliderEl: document.getElementById('video-volume-slider'),
      fullscreenButton: document.getElementById('video-fullscreen-toggle'),
      fullWindowButton: document.getElementById('video-full-window-toggle'),
      loopButton: document.getElementById('video-loop-toggle'),
      previousButton: document.getElementById('video-previous'),
      nextButton: document.getElementById('video-next'),
      back15Button: document.getElementById('video-back-15'),
      forward15Button: document.getElementById('video-forward-15'),
      progressSliderEl: document.getElementById('video-progress-slider'),
      elapsedTimeEl: document.getElementById('video-elapsed-time'),
      totalTimeEl: document.getElementById('video-total-time'),
      trackPanelEl: document.getElementById('video-track-panel'),
      audioTrackSelectEl: document.getElementById('video-audio-track'),
      audioTrackSummaryEl: document.getElementById('video-audio-track-summary'),
      subtitleTrackSelectEl: document.getElementById('video-subtitle-track'),
      subtitleTrackSummaryEl: document.getElementById('video-subtitle-track-summary'),
      subtitleStyleControlsEl: document.getElementById('video-subtitle-style-controls'),
      subtitleShadowEnabledEl: document.getElementById('video-subtitle-shadow-enabled'),
      subtitleStrokeEnabledEl: document.getElementById('video-subtitle-stroke-enabled'),
      subtitleFontSizeInputEl: document.getElementById('video-subtitle-font-size'),
      subtitleOffsetInputEl: document.getElementById('video-subtitle-offset'),
      subtitleStyleResetButtonEl: document.getElementById('video-subtitle-style-reset'),
      subtitleStyleApplyButtonEl: document.getElementById('video-subtitle-style-apply'),
      debugPanelEl: document.getElementById('video-debug-panel'),
      debugActionsEl: document.getElementById('video-debug-actions'),
      clearCacheButtonEl: document.getElementById('video-clear-cache-button'),
      debugMetaEl: document.getElementById('video-debug-meta'),
      debugCurrentTitleEl: document.getElementById('video-debug-current-title'),
      debugCurrentCueEl: document.getElementById('video-debug-current-cue'),
      debugNextTitleEl: document.getElementById('video-debug-next-title'),
      debugNextCueEl: document.getElementById('video-debug-next-cue'),
      libraryListEl: document.getElementById('video-library-list'),
      queueListEl: document.getElementById('video-queue-list'),
      libraryUpButton: document.getElementById('video-library-up'),
      libraryAddSelectedButton: document.getElementById('video-library-add-selected'),
      queuePlayButton: document.getElementById('video-queue-play'),
      queueRemoveButton: document.getElementById('video-queue-remove'),
      queueUpButton: document.getElementById('video-queue-up'),
      queueDownButton: document.getElementById('video-queue-down'),
      queueClearButton: document.getElementById('video-queue-clear'),
    },
    state: {
      paneActive: false,
      currentFolder: '',
      libraryItems: [],
      selectedLibraryPaths: Object.create(null),
      queue: [],
      selectedQueueIndex: -1,
      activeQueueIndex: -1,
      loopQueue: false,
      loopQueueSettingKey: 'video-loop-queue',
      loadingLibrary: false,
      loadingPlaybackStatus: false,
      playbackStatusLoaded: false,
      compatibilityAvailable: false,
      ffmpegAvailable: false,
      ffprobeAvailable: false,
      videoClientId: createVideoClientId(),
      backpressureThresholds: {
        lowWaterSeconds: 45,
        mediumWaterSeconds: 120,
        highWaterSeconds: 300,
        maxWaterSeconds: 600,
      },
      playbackMode: 'none',
      lastPlaybackPath: '',
      pendingAutoplay: false,
      transportWantsPlay: false,
      compatibilitySessionId: '',
      compatibilitySessionPath: '',
      compatibilityAudioStreamIndex: null,
      compatibilitySessionBurnedInSubtitleStreamIndex: null,
      compatibilitySessionVideoMode: '',
      compatibilitySessionVideoModeReason: '',
      compatibilitySessionAudioMode: '',
      compatibilitySessionAudioModeReason: '',
      compatibilityEncodedMediaEndSeconds: 0,
      compatibilitySegmentDurationSeconds: 0,
      compatibilityPlaylistSegmentCount: 0,
      compatibilityCurrentSegmentIndex: 0,
      compatibilityLoadedSegmentMinIndex: 0,
      compatibilityLoadedSegmentMaxIndex: 0,
      compatibilityLoadedSegmentIndicesByKey: Object.create(null),
      compatibilitySegmentLoadSampleCount: 0,
      compatibilitySegmentLoadAverageMs: 0,
      compatibilitySegmentLoadWindowStartMs: NaN,
      compatibilitySegmentFetchSampleCount: 0,
      compatibilitySegmentFetchAverageMs: 0,
      hlsController: null,
      compatibilityRecoveryAttempts: 0,
      compatibilityRecoveryTimer: 0,
      compatibilityRecoveryScheduled: false,
      compatibilityStartSeconds: 0,
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
      subtitleWindowCacheByPath: Object.create(null),
      subtitleWindowInFlightByPath: Object.create(null),
      subtitleCoverageByPath: Object.create(null),
      subtitleBackgroundCoverageByPath: Object.create(null),
      subtitleMountedWindowByPath: Object.create(null),
      subtitleObjectUrls: [],
      subtitleMountState: {
        mode: 'none',
        path: '',
        streamIndex: null,
        seekSeconds: 0,
        coverageStartSeconds: null,
        coverageEndSeconds: null,
        playbackSyncToken: null,
        generation: 0,
      },
      subtitlePlaybackRefreshInFlightKey: '',
      subtitlePlaybackSyncState: {
        path: '',
        streamIndex: null,
        mountedSeekSeconds: 0,
        playbackSyncToken: null,
        mountGeneration: 0,
        outsideCoverageObserved: false,
      },
      subtitleDebug: {
        rawVtt: '',
        cues: [],
        fetchStartSeconds: 0,
        streamIndex: '',
        trackLabel: '',
        lastLoggedCueKey: '',
      },
      progressSliderActive: false,
      controlsIdleTimer: 0,
      controlsOverlayVisible: false,
      loadingOverlayVisible: false,
      loadingOverlayMeta: '',
      compatibilityManifestStallTimer: 0,
      playbackTiming: null,
      lastControlsRevealPointerKey: '',
      controlsScrubReveal: false,
      subtitleFailureState: 'idle',
      // Full-window layout mode (CSS viewport takeover; not native fullscreen).
      // See docs/video-player.md "Playback Layout Modes".
      fullWindowActive: false,
      // Session-only preferred expanded mode for double-click from embedded:
      // 'fullscreen' (native Fullscreen API, default) | 'full-window'.
      preferredExpandedMode: 'fullscreen',
      // Pre-entry --log-panel-height (px number) restored on full-window exit.
      savedLogPanelHeight: null,
    },
    setStatus: function (text) {
      if (ctx.els.statusEl) ctx.els.statusEl.textContent = text;
    },
    readVideoSetting: readVideoSetting,
    writeVideoSetting: writeVideoSetting,
  };

  initShared(ctx);
  initCache(ctx);
  initDiagnostics(ctx);
  initLibrary(ctx);
  initQueue(ctx);
  initProbe(ctx);
  initTracks(ctx);
  initCompatibility(ctx);
  initSubtitles(ctx);
  initControls(ctx);
  initPlayback(ctx);
  initPane(ctx);

  pane.setAttribute('data-video-player-ready', 'subtitles');
  ctx.restoreVideoLoopQueue();
  ctx.state.audioTrackPreferenceByLayout = ctx.loadStoredTrackPreferences('dropbox-browser-video-audio-track-preferences');
  ctx.state.subtitleTrackPreferenceByLayout = ctx.loadStoredTrackPreferences('dropbox-browser-video-subtitle-track-preferences');
  ctx.updateCurrentFolder(ctx.currentFolderPath());
  ctx.renderAudioTrackSelector(null, null);
  ctx.renderSubtitleTrackSelector(null, null);
  ctx.syncTrackSummary();
  if (ctx.els.videoEl) {
    ctx.els.videoEl.controls = false;
    ctx.els.videoEl.removeAttribute('controls');
  }
  ctx.resetPlaybackProgress();
  void ctx.playbackApi.syncForActiveItem();
  ctx.renderLibrary();
  ctx.renderQueue();

  window.addEventListener('bottom-pane-mode-changed', function (ev) {
    if (!ev.detail) return;
    ctx.paneApi.syncPaneMode(ev.detail.mode);
  });

  window.addEventListener('browse-folder-changed', function (ev) {
    var detail = ev && ev.detail ? ev.detail : {};
    var nextPath = typeof detail.path === 'string' ? detail.path : ctx.currentFolderPath();
    ctx.updateCurrentFolder(nextPath);
    if (ctx.state.paneActive) void ctx.loadLibrary(nextPath);
  });

  window.addEventListener('beforeunload', function () {
    ctx.clearCompatibilityRecoveryTimer();
    var unloadSessionId = String(ctx.state.compatibilitySessionId || '');
    void ctx.compatibilityApi.stopSession(unloadSessionId);
  });

  pane.addEventListener('video-playback-ended', function () {
    if (ctx.state.activeQueueIndex < 0) return;
    ctx.state.activeQueueIndex = advanceQueueAfterPlaybackEnd(
      ctx.state.queue.length,
      ctx.state.activeQueueIndex,
      ctx.state.loopQueue
    );
    if (ctx.state.activeQueueIndex >= 0) {
      ctx.state.selectedQueueIndex = ctx.state.activeQueueIndex;
      ctx.state.pendingAutoplay = true;
      ctx.state.transportWantsPlay = true;
    }
    ctx.renderQueue();
  });

  ctx.paneApi.syncPaneMode(ctx.readVideoSetting('bottom-pane-mode', 'server-log'));
}());
