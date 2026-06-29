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
      pipButton: document.getElementById('video-pip-toggle'),
      progressSliderEl: document.getElementById('video-progress-slider'),
      elapsedTimeEl: document.getElementById('video-elapsed-time'),
      totalTimeEl: document.getElementById('video-total-time'),
      audioTrackSelectEl: document.getElementById('video-audio-track'),
      subtitleTrackSelectEl: document.getElementById('video-subtitle-track'),
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
      loadingLibrary: false,
      loadingPlaybackStatus: false,
      playbackStatusLoaded: false,
      compatibilityAvailable: false,
      ffmpegAvailable: false,
      ffprobeAvailable: false,
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
      compatibilityPlaylistSegmentCount: 0,
      compatibilityCurrentSegmentIndex: 0,
      compatibilityLoadedSegmentMinIndex: 0,
      compatibilityLoadedSegmentMaxIndex: 0,
      compatibilitySegmentLoadSampleCount: 0,
      compatibilitySegmentLoadAverageMs: 0,
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
      playbackSyncToken: 0,
      probeCache: Object.create(null),
      probeFailures: Object.create(null),
      selectedAudioStreamIndexByPath: Object.create(null),
      selectedSubtitleStreamIndexByPath: Object.create(null),
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
      subtitleMountedSeekSeconds: null,
      subtitleMountedStreamIndex: null,
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
    },
    setStatus: function (text) {
      if (ctx.els.statusEl) ctx.els.statusEl.textContent = text;
    },
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
  ctx.state.audioTrackPreferenceByLayout = ctx.loadStoredTrackPreferences('dropbox-browser-video-audio-track-preferences');
  ctx.state.subtitleTrackPreferenceByLayout = ctx.loadStoredTrackPreferences('dropbox-browser-video-subtitle-track-preferences');
  ctx.updateCurrentFolder(ctx.currentFolderPath());
  ctx.renderAudioTrackSelector(null, null);
  ctx.renderSubtitleTrackSelector(null, null);
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
    void ctx.compatibilityApi.stopSession();
  });

  pane.addEventListener('video-playback-ended', function () {
    ctx.state.activeQueueIndex = advanceQueueAfterPlaybackEnd(ctx.state.queue.length, ctx.state.activeQueueIndex);
    if (ctx.state.activeQueueIndex >= 0) {
      ctx.state.selectedQueueIndex = ctx.state.activeQueueIndex;
      ctx.state.pendingAutoplay = true;
      ctx.state.transportWantsPlay = true;
    }
    ctx.renderQueue();
  });

  ctx.paneApi.syncPaneMode(Settings.get('bottom-pane-mode', 'server-log'));
}());
