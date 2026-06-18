import Hls from './vendor/hls.js';
import {
  advanceQueueAfterPlaybackEnd,
  clearQueue,
  enqueueAndPlay,
  enqueueSelected,
  moveQueueIndex,
  playbackDurationSeconds,
  playQueueIndex,
  removeQueueIndex,
} from './video-core.js';

(function () {
  var pane = document.getElementById('video-player-pane');
  if (!pane) return;

  var body = document.body;
  var VIDEO_ICONS = {
    play: '/assets/icons/material-icon-theme/video-play.svg',
    pause: '/assets/icons/material-icon-theme/video-pause.svg',
    volume: '/assets/icons/material-icon-theme/video-volume.svg',
    volumeLow: '/assets/icons/material-icon-theme/video-volume-low.svg',
    volumeMuted: '/assets/icons/material-icon-theme/video-volume-muted.svg',
    fullscreen: '/assets/icons/material-icon-theme/video-fullscreen.svg',
    fullscreenExit: '/assets/icons/material-icon-theme/video-fullscreen-exit.svg',
    pipEnter: '/assets/icons/material-icon-theme/video-pip-enter.svg',
    pipExit: '/assets/icons/material-icon-theme/video-pip-exit.svg',
  };
  var CONTROLS_IDLE_HIDE_MS = 2800;
  var COMPATIBILITY_START_BUFFER_FRAGMENTS = 1;
  var COMPATIBILITY_RECOVERY_MIN_DELAY_MS = 1500;
  var COMPATIBILITY_RECOVERY_MAX_DELAY_MS = 30000;
  var PROBE_STORAGE_KEY = 'dropbox-browser:video-probe-v1';
  var PROBE_STORAGE_TTL_MS = 60 * 60 * 1000;
  var PROBE_STORAGE_MAX_BYTES = 2 * 1024 * 1024;
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
      debugMetaEl: document.getElementById('video-debug-meta'),
      debugCurrentCueEl: document.getElementById('video-debug-current-cue'),
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
      playbackMode: 'none',
      lastPlaybackPath: '',
      pendingAutoplay: false,
      transportWantsPlay: false,
      compatibilitySessionId: '',
      hlsController: null,
      compatibilityRecoveryAttempts: 0,
      compatibilityRecoveryTimer: 0,
      compatibilityRecoveryScheduled: false,
      compatibilityStartSeconds: 0,
      compatibilityBufferedFragmentCount: 0,
      compatibilityPlaybackRevealed: false,
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
      playbackTiming: null,
      lastControlsRevealPointerKey: '',
      controlsScrubReveal: false,
    }
  };

  function setControlIcon(button, iconUrl) {
    var icon;
    if (!button) return;
    icon = button.querySelector('.video-control-icon');
    if (icon) icon.src = iconUrl;
  }

  function setControlButtonState(button, label, iconUrl) {
    if (!button) return;
    button.setAttribute('aria-label', label);
    button.title = label;
    setControlIcon(button, iconUrl);
  }

  function formatNativePlaybackTime(totalSeconds) {
    if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00';
    var seconds = Math.floor(totalSeconds);
    var hours = Math.floor(seconds / 3600);
    var minutes = Math.floor((seconds % 3600) / 60);
    var remainder = seconds % 60;
    if (hours > 0) {
      return String(hours)
        + ':'
        + String(minutes).padStart(2, '0')
        + ':'
        + String(remainder).padStart(2, '0');
    }
    return String(minutes) + ':' + String(remainder).padStart(2, '0');
  }

  function fullscreenHostElement() {
    return ctx.els.playbackStageEl || ctx.els.videoEl || null;
  }

  function volumeIconForLevel(volume, muted) {
    if (muted || volume === 0) return VIDEO_ICONS.volumeMuted;
    if (volume < 0.34) return VIDEO_ICONS.volumeLow;
    return VIDEO_ICONS.volume;
  }

  function clearControlsIdleTimer() {
    if (!ctx.state.controlsIdleTimer) return;
    window.clearTimeout(ctx.state.controlsIdleTimer);
    ctx.state.controlsIdleTimer = 0;
  }

  function setControlsOverlayIdle(isIdle) {
    if (!ctx.els.controlsOverlayEl) return;
    if (isIdle) ctx.els.controlsOverlayEl.classList.add('is-idle');
    else ctx.els.controlsOverlayEl.classList.remove('is-idle');
  }

  function showControlsOverlay() {
    if (!ctx.els.controlsOverlayEl || !videoControlsAvailable()) return;
    ctx.els.controlsOverlayEl.hidden = false;
    ctx.els.controlsOverlayEl.classList.remove('is-hidden');
    ctx.state.controlsOverlayVisible = true;
    setControlsOverlayIdle(false);
  }

  function hideControlsOverlay() {
    if (!ctx.els.controlsOverlayEl) return;
    clearControlsIdleTimer();
    ctx.els.controlsOverlayEl.hidden = true;
    ctx.els.controlsOverlayEl.classList.add('is-hidden');
    ctx.els.controlsOverlayEl.classList.remove('is-idle');
    ctx.state.controlsOverlayVisible = false;
    ctx.state.controlsScrubReveal = false;
  }

  function scheduleControlsIdleHide() {
    clearControlsIdleTimer();
    if (!ctx.els.videoEl || !videoControlsAvailable()) {
      hideControlsOverlay();
      return;
    }
    ctx.state.controlsIdleTimer = window.setTimeout(function () {
      ctx.state.controlsIdleTimer = 0;
      hideControlsOverlay();
    }, CONTROLS_IDLE_HIDE_MS);
  }

  function scheduleControlsIdleHideIfNotActive() {
    if (ctx.state.controlsIdleTimer) return;
    scheduleControlsIdleHide();
  }

  function controlsPointerMoveIsSignificant(event) {
    var movementX, movementY, clientX, clientY, pointerKey;
    if (!event) return true;
    movementX = Math.round(Number(event.movementX) || 0);
    movementY = Math.round(Number(event.movementY) || 0);
    if (movementX !== 0 || movementY !== 0) {
      clientX = Math.round(Number(event.clientX) || 0);
      clientY = Math.round(Number(event.clientY) || 0);
      ctx.state.lastControlsRevealPointerKey = clientX + '|' + clientY;
      return true;
    }
    clientX = Math.round(Number(event.clientX) || 0);
    clientY = Math.round(Number(event.clientY) || 0);
    pointerKey = clientX + '|' + clientY;
    if (pointerKey === ctx.state.lastControlsRevealPointerKey) return false;
    ctx.state.lastControlsRevealPointerKey = pointerKey;
    return true;
  }

  function revealControlsOverlay(event) {
    if (!videoControlsAvailable()) return;
    if (event && !controlsPointerMoveIsSignificant(event)) return;
    showControlsOverlay();
    scheduleControlsIdleHide();
  }

  function currentFolderPath() {
    return body && typeof body.dataset.currentFolderPath === 'string'
      ? body.dataset.currentFolderPath
      : '';
  }

  function setStatus(text) {
    if (ctx.els.statusEl) ctx.els.statusEl.textContent = text;
  }

  function resetPlaybackTiming(path, reason) {
    ctx.state.playbackTiming = {
      path: String(path || ''),
      reason: String(reason || 'playback'),
      startedAtMs: performance.now(),
      milestones: Object.create(null),
      summaryLogged: false,
    };
    reportPlaybackTiming('playback_requested');
  }

  function reportPlaybackTiming(milestone, fields) {
    var timing = ctx.state.playbackTiming;
    if (!timing || !timing.startedAtMs) return 0;
    var elapsedMs = Math.round(performance.now() - timing.startedAtMs);
    if (milestone) timing.milestones[milestone] = elapsedMs;
    if (!window.ClientLogger || !window.ClientLogger.enabledFor('video-timing')) return elapsedMs;
    var details = Object.assign({}, fields || {}, {
      milestone: milestone,
      elapsed_ms: elapsedMs,
      path: timing.path || '',
      reason: timing.reason || '',
      session_id: ctx.state.compatibilitySessionId || '',
      playback_mode: ctx.state.playbackMode || '',
    });
    window.ClientLogger.log('video-timing', 'info', 'Playback timing: ' + milestone, details);
    return elapsedMs;
  }

  function emitPlaybackTimingSummary(fields) {
    var timing = ctx.state.playbackTiming;
    if (!timing || timing.summaryLogged) return;
    timing.summaryLogged = true;
    var totalMs = Math.round(performance.now() - timing.startedAtMs);
    if (!window.ClientLogger || !window.ClientLogger.enabledFor('video-timing')) return;
    window.ClientLogger.log('video-timing', 'info', 'Playback timing summary', Object.assign({
      path: timing.path || '',
      reason: timing.reason || '',
      session_id: ctx.state.compatibilitySessionId || '',
      milestones: Object.assign({}, timing.milestones),
      total_to_playing_ms: totalMs,
    }, fields || {}));
  }

  function reportVideoDiagnostic(fields) {
    try {
      if (!window.ClientLogger) return;
      var active = activeQueueItem();
      var details = Object.assign({}, fields || {}, {
        playback_mode: ctx.state.playbackMode || '',
        session_id: ctx.state.compatibilitySessionId || '',
        path: active && active.path ? active.path : '',
        current_time: ctx.els.videoEl ? ctx.els.videoEl.currentTime || 0 : '',
        global_current_time: currentGlobalPlaybackSeconds(),
        source_start_seconds: ctx.state.compatibilityStartSeconds || 0,
        ready_state: ctx.els.videoEl ? ctx.els.videoEl.readyState : '',
        network_state: ctx.els.videoEl ? ctx.els.videoEl.networkState : '',
      });
      var level = details.level || 'debug';
      var message = details.message || 'video diagnostic';
      window.ClientLogger.log('video', level, message, details);
    }
    catch (_error) {
      return;
    }
  }

  function currentGlobalPlaybackSeconds() {
    var mediaTime = ctx.els.videoEl ? Number(ctx.els.videoEl.currentTime) : 0;
    return ctx.state.compatibilityStartSeconds + (Number.isFinite(mediaTime) && mediaTime >= 0 ? mediaTime : 0);
  }

  function mediaRangesSummary(ranges) {
    var result = [];
    if (!ranges) return result;
    for (var index = 0; index < ranges.length; index += 1) {
      try {
        result.push({
          start: ranges.start(index),
          end: ranges.end(index),
        });
      }
      catch (_error) {
        return result;
      }
    }
    return result;
  }

  function setPlaybackSummary(title, meta) {
    if (ctx.els.titleEl) ctx.els.titleEl.textContent = title;
    if (ctx.els.metaEl) ctx.els.metaEl.textContent = meta;
  }

  function updateLoadingOverlay(visible, options) {
    var title = options && typeof options.title === 'string' ? options.title : 'Preparing playback';
    var meta = options && typeof options.meta === 'string' ? options.meta : '';
    var progressValue = options ? Number(options.progress) : NaN;
    var progressPercent = Number.isFinite(progressValue)
      ? Math.max(0, Math.min(100, Math.round(progressValue * 100)))
      : 0;
    if (ctx.els.loadingTitleEl) ctx.els.loadingTitleEl.textContent = title;
    if (ctx.els.loadingMetaEl) ctx.els.loadingMetaEl.textContent = meta;
    if (ctx.els.loadingProgressEl) ctx.els.loadingProgressEl.style.width = progressPercent + '%';
    if (ctx.els.loadingProgressLabelEl) {
      ctx.els.loadingProgressLabelEl.textContent = progressPercent + '%';
    }
    if (ctx.els.loadingOverlayEl) {
      if (visible) {
        setStageLayerVisibility(ctx.els.loadingOverlayEl, true);
        hidePlaceholderElement();
      }
      else {
        setStageLayerVisibility(ctx.els.loadingOverlayEl, false);
      }
      ctx.els.loadingOverlayEl.setAttribute('aria-busy', visible ? 'true' : 'false');
      var progressHost = ctx.els.loadingOverlayEl.querySelector('.video-loading-progress');
      if (progressHost) progressHost.setAttribute('aria-valuenow', String(progressPercent));
    }
    if (ctx.els.playbackStageEl) {
      ctx.els.playbackStageEl.setAttribute('data-loading-state', visible ? 'active' : 'idle');
    }
    ctx.state.loadingOverlayVisible = visible;
  }

  function showLoadingOverlay(options) {
    updateLoadingOverlay(true, options);
    syncTransportControls();
  }

  function hideLoadingOverlay() {
    updateLoadingOverlay(false, {progress: 1});
  }

  function updateCurrentFolder(path) {
    ctx.state.currentFolder = path || '';
    if (ctx.els.pathEl) ctx.els.pathEl.textContent = ctx.state.currentFolder || '/';
  }

  function parentFolderPath(path) {
    if (!path) return '';
    var parts = path.split('/').filter(Boolean);
    parts.pop();
    return parts.join('/');
  }

  function selectedLibraryItems() {
    return ctx.state.libraryItems.filter(function (item) {
      return item.type === 'file' && ctx.state.selectedLibraryPaths[item.path];
    });
  }

  function activeQueueItem() {
    if (ctx.state.activeQueueIndex < 0 || ctx.state.activeQueueIndex >= ctx.state.queue.length) return null;
    return ctx.state.queue[ctx.state.activeQueueIndex];
  }

  function activeItemPath() {
    var active = activeQueueItem();
    return active && active.path ? active.path : '';
  }

  // Stage layers must always toggle both the hidden attribute and the hidden class.
  // The CSS now enforces this contract, but centralizing it here keeps future
  // playback-surface changes from drifting into mixed visibility states again.
  function setStageLayerVisibility(element, visible) {
    if (!element) return;
    element.hidden = !visible;
    if (visible) element.classList.remove('hidden');
    else element.classList.add('hidden');
  }

  function hideVideoElement() {
    setStageLayerVisibility(ctx.els.videoEl, false);
  }

  function showVideoElement() {
    setStageLayerVisibility(ctx.els.videoEl, true);
  }

  function showPlaceholderElement() {
    setStageLayerVisibility(ctx.els.placeholderEl, true);
  }

  function hidePlaceholderElement() {
    setStageLayerVisibility(ctx.els.placeholderEl, false);
  }

  function destroyHlsController() {
    if (ctx.state.hlsController && typeof ctx.state.hlsController.destroy === 'function') {
      ctx.state.hlsController.destroy();
    }
    ctx.state.hlsController = null;
  }

  function clearCompatibilityRecoveryTimer() {
    if (!ctx.state.compatibilityRecoveryTimer) return;
    window.clearTimeout(ctx.state.compatibilityRecoveryTimer);
    ctx.state.compatibilityRecoveryTimer = 0;
    ctx.state.compatibilityRecoveryScheduled = false;
  }

  function resetCompatibilityRecoveryState() {
    ctx.state.compatibilityRecoveryAttempts = 0;
    clearCompatibilityRecoveryTimer();
  }

  function compatibilityRecoveryDelayMs() {
    var attempt = Math.max(0, Number(ctx.state.compatibilityRecoveryAttempts) || 0);
    return Math.min(
      COMPATIBILITY_RECOVERY_MAX_DELAY_MS,
      Math.round(COMPATIBILITY_RECOVERY_MIN_DELAY_MS * Math.pow(1.6, Math.min(attempt, 12)))
    );
  }

  function isStaleOrMissingSegmentHlsError(data) {
    if (!data) return false;
    if (data.details === 'fragLoadError' || data.details === 'levelLoadError') return true;
    var reason = String(data.reason || (data.error && data.error.message) || '');
    return reason.indexOf('404') >= 0 || reason.indexOf('Not Found') >= 0;
  }

  function scheduleCompatibilityRecovery(reason, targetSeconds, data) {
    var active = activeQueueItem();
    if (!active || !ctx.state.compatibilityAvailable) return;
    if (ctx.state.compatibilityRecoveryTimer || ctx.state.compatibilityRecoveryScheduled) return;
    if (ctx.state.seekRestartInProgress) return;

    ctx.state.compatibilityRecoveryAttempts += 1;
    ctx.state.compatibilityRecoveryScheduled = true;
    ctx.state.transportWantsPlay = true;
    ctx.state.pendingAutoplay = true;

    var resumeSeconds = Number.isFinite(Number(targetSeconds)) && Number(targetSeconds) >= 0
      ? Number(targetSeconds)
      : currentGlobalPlaybackSeconds();
    var delayMs = compatibilityRecoveryDelayMs();

    showLoadingOverlay({
      title: activeItemTitle(active),
      meta: 'Recovering compatibility playback...',
      progress: 0.5,
    });
    setStatus('Recovering compatibility playback (attempt ' + String(ctx.state.compatibilityRecoveryAttempts) + ').');
    reportVideoDiagnostic({
      level: 'warn',
      message: 'Compatibility playback recovery scheduled',
      recovery_reason: reason || '',
      recovery_attempt: ctx.state.compatibilityRecoveryAttempts,
      recovery_delay_ms: delayMs,
      resume_time: resumeSeconds,
      hls_details: data && data.details || '',
      hls_reason: data && (data.reason || data.error && data.error.message) || '',
      hls_url: data && data.frag && data.frag.url ? data.frag.url : (data && data.context && data.context.url ? data.context.url : ''),
    });

    ctx.state.compatibilityRecoveryTimer = window.setTimeout(function () {
      ctx.state.compatibilityRecoveryTimer = 0;
      ctx.state.compatibilityRecoveryScheduled = false;
      if (!activeQueueItem() || !ctx.state.compatibilityAvailable) return;
      void restartCompatibilityAt(resumeSeconds, reason || 'auto-recovery');
    }, delayMs);
  }

  function handleCompatibilityHlsError(data) {
    if (!data || !data.fatal) return;
    var active = activeQueueItem();
    if (!active || ctx.state.playbackMode !== 'compatibility') return;
    if (!hlsErrorTargetsCurrentSession(data)) return;

    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      if (isStaleOrMissingSegmentHlsError(data)) {
        scheduleCompatibilityRecovery('hls-missing-segment', currentGlobalPlaybackSeconds(), data);
        return;
      }
      setStatus('Compatibility playback hit a network error; retrying the stream.');
      if (ctx.state.hlsController) {
        ctx.state.hlsController.startLoad();
        resyncSubtitleTrackAfterHlsRecovery('network-error', data);
      }
      return;
    }

    if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      setStatus('Compatibility playback hit a media error; attempting recovery.');
      if (ctx.state.hlsController) {
        ctx.state.hlsController.recoverMediaError();
        resyncSubtitleTrackAfterHlsRecovery('media-error', data);
      }
      return;
    }

    scheduleCompatibilityRecovery('hls-fatal-error', currentGlobalPlaybackSeconds(), data);
  }

  function resetCompatibilityBufferState() {
    ctx.state.compatibilityBufferedFragmentCount = 0;
    ctx.state.compatibilityPlaybackRevealed = false;
  }

  function compatibilityStartBufferReady() {
    return ctx.state.compatibilityBufferedFragmentCount >= COMPATIBILITY_START_BUFFER_FRAGMENTS;
  }

  function compatibilityBufferedSecondsAhead() {
    if (!ctx.els.videoEl || !ctx.els.videoEl.buffered || ctx.els.videoEl.buffered.length === 0) return 0;
    try {
      var currentTime = Number(ctx.els.videoEl.currentTime);
      if (!Number.isFinite(currentTime) || currentTime < 0) return 0;
      return Math.max(0, ctx.els.videoEl.buffered.end(ctx.els.videoEl.buffered.length - 1) - currentTime);
    }
    catch (_error) {
      return 0;
    }
  }

  function maybeRevealCompatibilityPlayback(title, surfaceSyncToken, reason) {
    if (ctx.state.playbackMode !== 'compatibility' || !playbackSyncTokenIsCurrent(surfaceSyncToken)) return;
    if (ctx.state.compatibilityPlaybackRevealed) return;
    if (!compatibilityStartBufferReady()) return;
    ctx.state.compatibilityPlaybackRevealed = true;
    hideLoadingOverlay();
    setStatus('Compatibility playback session is ready.');
    if (ctx.state.compatibilityStartSeconds > 0) {
      setStatus('Compatibility playback session is ready at ' + formatPlaybackTime(ctx.state.compatibilityStartSeconds) + '.');
    }
    reportVideoDiagnostic({
      level: 'info',
      message: 'Compatibility playback buffer ready',
      reveal_reason: reason || '',
      buffered_fragments: ctx.state.compatibilityBufferedFragmentCount,
      buffered_seconds_ahead: compatibilityBufferedSecondsAhead(),
      source_start_seconds: ctx.state.compatibilityStartSeconds,
    });
    reportPlaybackTiming('buffer_ready', {
      reveal_reason: reason || '',
      buffered_fragments: ctx.state.compatibilityBufferedFragmentCount,
      buffered_seconds_ahead: compatibilityBufferedSecondsAhead(),
    });
    if (ctx.state.pendingAutoplay) requestVideoPlay();
    ensureSubtitlesAfterPlaybackReady(reason || 'hls-buffer-ready');
  }

  function noteCompatibilityFragmentBuffered(data, title, surfaceSyncToken) {
    if (ctx.state.playbackMode !== 'compatibility' || !playbackSyncTokenIsCurrent(surfaceSyncToken)) return;
    ctx.state.compatibilityBufferedFragmentCount += 1;
    if (
      ctx.state.compatibilityBufferedFragmentCount < COMPATIBILITY_START_BUFFER_FRAGMENTS
      && ctx.state.hlsController
      && Array.isArray(ctx.state.hlsController.levels)
      && ctx.state.hlsController.levels[0]
      && ctx.state.hlsController.levels[0].details
      && data
      && data.frag
    ) {
      var details = ctx.state.hlsController.levels[0].details;
      if (details.live === false && details.endSN === data.frag.sn) {
        ctx.state.compatibilityBufferedFragmentCount = COMPATIBILITY_START_BUFFER_FRAGMENTS;
      }
    }
    maybeRevealCompatibilityPlayback(title, surfaceSyncToken, 'hls-fragment-buffered');
  }

  function formatPlaybackTime(totalSeconds) {
    if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '00:00:00';
    var seconds = Math.floor(totalSeconds);
    var hours = Math.floor(seconds / 3600);
    var minutes = Math.floor((seconds % 3600) / 60);
    var remainder = seconds % 60;
    return String(hours).padStart(2, '0')
      + ':'
      + String(minutes).padStart(2, '0')
      + ':'
      + String(remainder).padStart(2, '0');
  }

  function resetPlaybackProgress() {
    if (ctx.els.playToggleButton) {
      setControlButtonState(ctx.els.playToggleButton, 'Play', VIDEO_ICONS.play);
      ctx.els.playToggleButton.disabled = true;
    }
    if (ctx.els.muteToggleButton) {
      setControlButtonState(ctx.els.muteToggleButton, 'Mute', VIDEO_ICONS.volume);
      ctx.els.muteToggleButton.disabled = true;
    }
    if (ctx.els.volumeSliderEl) {
      ctx.els.volumeSliderEl.disabled = true;
    }
    if (ctx.els.fullscreenButton) {
      setControlButtonState(ctx.els.fullscreenButton, 'Fullscreen', VIDEO_ICONS.fullscreen);
      ctx.els.fullscreenButton.disabled = true;
    }
    if (ctx.els.pipButton) {
      setControlButtonState(ctx.els.pipButton, 'Picture in picture', VIDEO_ICONS.pipEnter);
      ctx.els.pipButton.disabled = true;
    }
    if (ctx.els.progressSliderEl) {
      ctx.els.progressSliderEl.min = '0';
      ctx.els.progressSliderEl.max = '0';
      ctx.els.progressSliderEl.value = '0';
      ctx.els.progressSliderEl.disabled = true;
    }
    if (ctx.els.elapsedTimeEl) ctx.els.elapsedTimeEl.textContent = '0:00';
    if (ctx.els.totalTimeEl) ctx.els.totalTimeEl.textContent = '0:00';
    ctx.state.progressSliderActive = false;
    if (!ctx.state.loadingOverlayVisible && !ctx.state.seekRestartInProgress && !ctx.state.controlsScrubReveal) {
      hideControlsOverlay();
    }
  }

  function videoControlsAvailable() {
    if (!ctx.els.videoEl) return false;
    var active = activeQueueItem();
    if (!active || !ctx.state.compatibilityAvailable) return false;
    if (ctx.state.loadingOverlayVisible) return true;
    return ctx.state.playbackMode === 'compatibility' && !ctx.els.videoEl.hidden;
  }

  function playbackShouldBeRunning() {
    return Boolean(ctx.state.transportWantsPlay);
  }

  function syncTransportControls() {
    if (!ctx.els.videoEl) return;
    var canControl = videoControlsAvailable();
    if (!canControl) {
      if (!ctx.state.loadingOverlayVisible && !ctx.state.controlsScrubReveal) {
        hideControlsOverlay();
      }
    }
    else if (ctx.state.loadingOverlayVisible || !playbackShouldBeRunning() || ctx.state.controlsScrubReveal) {
      showControlsOverlay();
      if (ctx.state.loadingOverlayVisible || !playbackShouldBeRunning()) {
        clearControlsIdleTimer();
        setControlsOverlayIdle(false);
      }
      else scheduleControlsIdleHideIfNotActive();
    }
    else if (ctx.state.controlsOverlayVisible) scheduleControlsIdleHideIfNotActive();
    if (ctx.els.playToggleButton) {
      var isPaused = !playbackShouldBeRunning();
      ctx.els.playToggleButton.disabled = !canControl;
      setControlButtonState(
        ctx.els.playToggleButton,
        isPaused ? 'Play' : 'Pause',
        isPaused ? VIDEO_ICONS.play : VIDEO_ICONS.pause
      );
    }
    if (ctx.els.muteToggleButton) {
      var isMuted = ctx.els.videoEl.muted || ctx.els.videoEl.volume === 0;
      var volumeLevel = ctx.els.videoEl.muted ? 0 : ctx.els.videoEl.volume;
      ctx.els.muteToggleButton.disabled = !canControl;
      setControlButtonState(
        ctx.els.muteToggleButton,
        isMuted ? 'Unmute' : 'Mute',
        volumeIconForLevel(volumeLevel, isMuted)
      );
    }
    if (ctx.els.volumeSliderEl) {
      ctx.els.volumeSliderEl.disabled = !canControl;
      ctx.els.volumeSliderEl.value = String(ctx.els.videoEl.muted ? 0 : ctx.els.videoEl.volume);
    }
    if (ctx.els.fullscreenButton) {
      var fullscreenHost = fullscreenHostElement();
      var isFullscreen = document.fullscreenElement === fullscreenHost;
      ctx.els.fullscreenButton.disabled = !canControl || !fullscreenHost || typeof fullscreenHost.requestFullscreen !== 'function';
      setControlButtonState(
        ctx.els.fullscreenButton,
        isFullscreen ? 'Exit fullscreen' : 'Fullscreen',
        isFullscreen ? VIDEO_ICONS.fullscreenExit : VIDEO_ICONS.fullscreen
      );
    }
    if (ctx.els.pipButton) {
      var pipSupported = Boolean(
        document.pictureInPictureEnabled && typeof ctx.els.videoEl.requestPictureInPicture === 'function'
      );
      var isPipActive = document.pictureInPictureElement === ctx.els.videoEl;
      ctx.els.pipButton.disabled = !canControl || !pipSupported;
      setControlButtonState(
        ctx.els.pipButton,
        isPipActive ? 'Exit picture in picture' : 'Picture in picture',
        isPipActive ? VIDEO_ICONS.pipExit : VIDEO_ICONS.pipEnter
      );
    }
  }

  function syncPlaybackProgress() {
    if (!ctx.els.videoEl || !ctx.els.progressSliderEl) return;
    var active = activeQueueItem();
    var probePayload = active ? ctx.state.probeCache[active.path || ''] || null : null;
    var duration = playbackDurationSeconds(
      Number(ctx.els.videoEl.duration),
      probePayload,
      ctx.state.playbackMode
    );
    var currentTime = currentGlobalPlaybackSeconds();
    if (ctx.state.seekRestartInProgress && Number.isFinite(Number(ctx.state.requestedSeekSeconds))) {
      currentTime = Number(ctx.state.requestedSeekSeconds);
    }
    if (!Number.isFinite(duration) || duration <= 0) {
      resetPlaybackProgress();
      return;
    }
    syncTransportControls();
    ctx.els.progressSliderEl.max = String(duration);
    ctx.els.progressSliderEl.disabled = false;
    if (!ctx.state.progressSliderActive) {
      var value = Number.isFinite(currentTime) && currentTime >= 0 ? currentTime : 0;
      ctx.els.progressSliderEl.value = String(Math.min(duration, value));
    }
    if (ctx.els.elapsedTimeEl) {
      var elapsedValue = ctx.state.progressSliderActive
        ? Number(ctx.els.progressSliderEl.value)
        : currentTime;
      ctx.els.elapsedTimeEl.textContent = formatNativePlaybackTime(elapsedValue);
    }
    if (ctx.els.totalTimeEl) ctx.els.totalTimeEl.textContent = formatNativePlaybackTime(duration);
  }

  function failCompatibilityPlayback(item, meta, status) {
    clearVideoSource();
    showPlaybackPlaceholder(activeItemTitle(item), meta || 'Compatibility playback failed for this file.');
    setStatus(status || 'Compatibility playback failed.');
    hideLoadingOverlay();
    resetPlaybackProgress();
  }

  function flushNativeSubtitleRenderSurface() {
    clearSubtitleOverlay();
    if (!ctx.els.videoEl) return;
    var video = ctx.els.videoEl;
    hideVideoElement();
    disableNativeSubtitleTracks();
    Array.from(video.querySelectorAll('track')).forEach(function (node) {
      node.remove();
    });
    revokeSubtitleObjectUrls();
    ctx.state.subtitleMountedSeekSeconds = null;
    ctx.state.subtitleMountedStreamIndex = null;
    resetSubtitleDebugState();
    video.controls = false;
    video.removeAttribute('controls');
    try {
      video.pause();
    }
    catch (_pauseError) {
      // Best-effort pause before flushing media element state.
    }
    destroyHlsController();
    video.removeAttribute('src');
    try {
      video.load();
    }
    catch (_loadError) {
      // Best-effort load to flush native text-track rendering on MSE/HLS playback.
    }
  }

  function resetPlaybackSurface() {
    if (!ctx.els.videoEl) return;
    clearCompatibilityRecoveryTimer();
    hideLoadingOverlay();
    flushNativeSubtitleRenderSurface();
    resetCompatibilityRecoveryState();
    ctx.state.lastPlaybackPath = '';
    ctx.state.compatibilityStartSeconds = 0;
    ctx.state.compatibilitySubtitleStreamIndex = null;
    ctx.state.requestedSeekSeconds = null;
    ctx.state.seekRestartInProgress = false;
    resetPlaybackProgress();
  }

  function clearVideoSource() {
    resetPlaybackSurface();
  }

  var SUBTITLE_PREVIEW_MAX_CHARS = 120;

  function resetSubtitleDebugState() {
    ctx.state.subtitleDebug.rawVtt = '';
    ctx.state.subtitleDebug.cues = [];
    ctx.state.subtitleDebug.fetchStartSeconds = 0;
    ctx.state.subtitleDebug.streamIndex = '';
    ctx.state.subtitleDebug.trackLabel = '';
    ctx.state.subtitleDebug.lastLoggedCueKey = '';
    if (ctx.els.debugMetaEl) {
      ctx.els.debugMetaEl.textContent = 'No subtitle track loaded.';
    }
    if (ctx.els.debugCurrentCueEl) {
      ctx.els.debugCurrentCueEl.textContent = 'No active subtitle cue.';
    }
    if (ctx.els.debugNextCueEl) {
      ctx.els.debugNextCueEl.textContent = 'No upcoming subtitle cue.';
    }
  }

  function parseVttTimestamp(raw) {
    var text = String(raw || '').trim();
    if (!text) return NaN;
    var chunks = text.split(':');
    var seconds = 0;
    if (chunks.length === 3) {
      seconds = Number(chunks[0]) * 3600 + Number(chunks[1]) * 60 + Number(chunks[2]);
    }
    else if (chunks.length === 2) {
      seconds = Number(chunks[0]) * 60 + Number(chunks[1]);
    }
    else {
      seconds = Number(text);
    }
    return Number.isFinite(seconds) ? seconds : NaN;
  }

  function parseWebVttCues(vttText) {
    var cues = [];
    var normalized = String(vttText || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    var blocks = normalized.split(/\n\n+/);
    blocks.forEach(function (block) {
      var trimmed = block.trim();
      if (!trimmed || trimmed.indexOf('WEBVTT') === 0) return;
      var lines = trimmed.split('\n');
      var timingIndex = 0;
      if (lines.length > 1 && lines[0].indexOf('-->') < 0 && lines[1].indexOf('-->') >= 0) {
        timingIndex = 1;
      }
      var timingLine = lines[timingIndex] || '';
      if (timingLine.indexOf('-->') < 0) return;
      var timingParts = timingLine.split('-->');
      var start = parseVttTimestamp(timingParts[0]);
      var end = parseVttTimestamp(String(timingParts[1] || '').trim().split(/\s+/)[0]);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return;
      var rawText = lines.slice(timingIndex + 1).join('\n');
      cues.push({
        start: start,
        end: end,
        rawTimingLine: timingLine.trim(),
        rawText: rawText,
        rawBlock: trimmed,
      });
    });
    return cues;
  }

  var VTT_TIMING_LINE_RE = /(\d{1,2}:\d{2}(?::\d{2})?\.\d{1,3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?\.\d{1,3})([^\n]*)/;

  function formatVttTimestamp(seconds) {
    var clamped = Math.max(0, Number(seconds) || 0);
    var whole = Math.floor(clamped);
    var millis = Math.round((clamped - whole) * 1000);
    if (millis === 1000) {
      whole += 1;
      millis = 0;
    }
    var hours = Math.floor(whole / 3600);
    var minutes = Math.floor((whole % 3600) / 60);
    var remainder = whole % 60;
    if (hours > 0) {
      return String(hours).padStart(2, '0')
        + ':'
        + String(minutes).padStart(2, '0')
        + ':'
        + String(remainder).padStart(2, '0')
        + '.'
        + String(millis).padStart(3, '0');
    }
    return String(minutes).padStart(2, '0')
      + ':'
      + String(remainder).padStart(2, '0')
      + '.'
      + String(millis).padStart(3, '0');
  }

  function shiftVttTimingLine(match, shiftSeconds) {
    var start = parseVttTimestamp(match[1]);
    var end = parseVttTimestamp(match[2]);
    var shiftedStart = start - shiftSeconds;
    var shiftedEnd = end - shiftSeconds;
    if (shiftedEnd <= 0) return null;
    if (shiftedStart < 0) shiftedStart = 0;
    return formatVttTimestamp(shiftedStart) + ' --> ' + formatVttTimestamp(shiftedEnd) + (match[3] || '');
  }

  function subtitleTrackIsActive(textTrack) {
    return Boolean(textTrack && (textTrack.mode === 'showing' || textTrack.mode === 'hidden'));
  }

  function collectActiveSubtitleTexts(textTrack) {
    var texts = [];
    if (!textTrack || !textTrack.activeCues) return texts;
    for (var index = 0; index < textTrack.activeCues.length; index += 1) {
      var text = String(textTrack.activeCues[index].text || '').trim();
      if (text) texts.push(text);
    }
    return texts;
  }

  function clearSubtitleOverlay() {
    if (!ctx.els.subtitleOverlayEl) return;
    ctx.els.subtitleOverlayEl.textContent = '';
    ctx.els.subtitleOverlayEl.hidden = true;
    ctx.els.subtitleOverlayEl.classList.add('hidden');
  }

  function syncSubtitleOverlayDisplay() {
    if (!ctx.els.subtitleOverlayEl) return;
    var textTrack = managedSubtitleTextTrack();
    var texts = collectActiveSubtitleTexts(textTrack);
    if (!texts.length) {
      clearSubtitleOverlay();
      return;
    }
    ctx.els.subtitleOverlayEl.textContent = texts.join('\n');
    ctx.els.subtitleOverlayEl.hidden = false;
    ctx.els.subtitleOverlayEl.classList.remove('hidden');
  }

  function rebaseWebVttText(body, startTimeSeconds) {
    if (!(startTimeSeconds > 0)) return body;
    var blocks = String(body || '').trim().split(/\n\n+/);
    var outBlocks = [];
    blocks.forEach(function (block) {
      var trimmed = block.trim();
      if (!trimmed) return;
      if (trimmed.indexOf('WEBVTT') === 0) {
        outBlocks.push(trimmed);
        return;
      }
      var lines = trimmed.split('\n');
      var timingIdx = 0;
      if (lines.length > 1 && lines[0].indexOf('-->') < 0 && lines[1].indexOf('-->') >= 0) {
        timingIdx = 1;
      }
      var timingMatch = lines[timingIdx].trim().match(VTT_TIMING_LINE_RE);
      if (!timingMatch) {
        outBlocks.push(trimmed);
        return;
      }
      var shiftedTiming = shiftVttTimingLine(timingMatch, startTimeSeconds);
      if (!shiftedTiming) return;
      lines[timingIdx] = shiftedTiming;
      outBlocks.push(lines.join('\n'));
    });
    if (!outBlocks.length) return 'WEBVTT\n\n';
    return outBlocks.join('\n\n') + '\n';
  }

  function subtitleFullVttCacheForPath(path) {
    var key = String(path || '');
    if (!key) return null;
    if (!ctx.state.subtitleFullVttCacheByPath[key]) {
      ctx.state.subtitleFullVttCacheByPath[key] = Object.create(null);
    }
    return ctx.state.subtitleFullVttCacheByPath[key];
  }

  function getCachedFullSubtitleVtt(path, subtitleStreamIndex) {
    var cache = subtitleFullVttCacheForPath(path);
    if (!cache) return '';
    var stored = cache[String(subtitleStreamIndex)];
    return typeof stored === 'string' ? stored : '';
  }

  function storeFullSubtitleVtt(path, subtitleStreamIndex, subtitleText) {
    var cache = subtitleFullVttCacheForPath(path);
    if (!cache) return;
    cache[String(subtitleStreamIndex)] = String(subtitleText || '');
  }

  function findActiveParsedCue(cues, mediaTime) {
    if (!Array.isArray(cues) || !Number.isFinite(mediaTime)) return null;
    for (var index = 0; index < cues.length; index += 1) {
      var cue = cues[index];
      if (mediaTime >= cue.start && mediaTime < cue.end) return cue;
    }
    return null;
  }

  function findNextParsedCue(cues, mediaTime) {
    if (!Array.isArray(cues) || !Number.isFinite(mediaTime)) return null;
    for (var index = 0; index < cues.length; index += 1) {
      var cue = cues[index];
      if (cue.start > mediaTime) return cue;
    }
    return null;
  }

  function subtitleTrackOffsetSeconds() {
    var fetchStart = Number(ctx.state.subtitleDebug.fetchStartSeconds);
    if (Number.isFinite(fetchStart) && fetchStart >= 0) return fetchStart;
    return Math.max(0, Number(ctx.state.compatibilityStartSeconds) || 0);
  }

  function formatAbsoluteCueTimestamp(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return 'n/a';
    var whole = Math.floor(seconds);
    var millis = Math.round((seconds - whole) * 1000);
    if (millis === 1000) {
      whole += 1;
      millis = 0;
    }
    var hours = Math.floor(whole / 3600);
    var minutes = Math.floor((whole % 3600) / 60);
    var remainder = whole % 60;
    return String(hours).padStart(2, '0')
      + ':'
      + String(minutes).padStart(2, '0')
      + ':'
      + String(remainder).padStart(2, '0')
      + '.'
      + String(millis).padStart(3, '0');
  }

  function formatAbsoluteCueRange(startSeconds, endSeconds) {
    return formatAbsoluteCueTimestamp(startSeconds) + ' --> ' + formatAbsoluteCueTimestamp(endSeconds);
  }

  function previewSubtitleText(text, maxChars) {
    var limit = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : SUBTITLE_PREVIEW_MAX_CHARS;
    var normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return '';
    if (normalized.length <= limit) return normalized;
    return normalized.slice(0, limit - 1) + '…';
  }

  function resolveDisplayedCue(parsedCue, browserCues) {
    if (parsedCue) {
      return {
        start: parsedCue.start,
        end: parsedCue.end,
        text: parsedCue.rawText,
      };
    }
    if (browserCues.length) {
      return {
        start: browserCues[0].start,
        end: browserCues[0].end,
        text: browserCues[0].text,
      };
    }
    return null;
  }

  function formatDisplayedCueBlock(cue, trackOffsetSeconds) {
    if (!cue) return '';
    return formatAbsoluteCueRange(
      trackOffsetSeconds + cue.start,
      trackOffsetSeconds + cue.end
    ) + '\n' + cue.text;
  }

  function formatUpcomingCueBlock(cue, trackOffsetSeconds) {
    if (!cue) return '';
    return formatAbsoluteCueRange(
      trackOffsetSeconds + cue.start,
      trackOffsetSeconds + cue.end
    ) + '\n' + previewSubtitleText(cue.rawText);
  }

  function managedSubtitleTextTrack() {
    if (!ctx.els.videoEl || !ctx.els.videoEl.textTracks) return null;
    var fallback = null;
    for (var index = 0; index < ctx.els.videoEl.textTracks.length; index += 1) {
      var textTrack = ctx.els.videoEl.textTracks[index];
      if (!textTrack || textTrack.kind !== 'subtitles') continue;
      if (textTrack.mode === 'showing') return textTrack;
      if (!fallback) fallback = textTrack;
    }
    return fallback;
  }

  function summarizeBrowserCue(cue) {
    if (!cue) return null;
    return {
      start: Number(cue.startTime),
      end: Number(cue.endTime),
      text: String(cue.text || ''),
    };
  }

  function summarizeBrowserActiveCues(textTrack) {
    if (!textTrack || !textTrack.activeCues) return [];
    var result = [];
    for (var index = 0; index < textTrack.activeCues.length; index += 1) {
      var summary = summarizeBrowserCue(textTrack.activeCues[index]);
      if (summary) result.push(summary);
    }
    return result;
  }

  function formatSubtitleDebugTimestamp(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return 'n/a';
    return formatPlaybackTime(seconds);
  }

  function buildSubtitleCueLogKey(displayedCue, globalTime) {
    if (!displayedCue) return String(globalTime) + '::';
    return String(globalTime)
      + '::'
      + String(displayedCue.start)
      + '|'
      + String(displayedCue.end)
      + '|'
      + displayedCue.text;
  }

  function subtitleSyncContext(fields) {
    var active = activeQueueItem();
    return Object.assign({}, fields || {}, {
      playback_mode: ctx.state.playbackMode || '',
      path: active && active.path ? active.path : '',
      media_current_time: ctx.els.videoEl ? ctx.els.videoEl.currentTime || 0 : '',
      global_current_time: currentGlobalPlaybackSeconds(),
      source_start_seconds: ctx.state.compatibilityStartSeconds || 0,
      subtitle_fetch_start_seconds: ctx.state.subtitleDebug.fetchStartSeconds || 0,
      subtitle_track_label: ctx.state.subtitleDebug.trackLabel || '',
      subtitle_mounted_stream_index: ctx.state.subtitleMountedStreamIndex,
      playback_sync_token: ctx.state.playbackSyncToken,
    });
  }

  function reportSubtitleDiagnostic(fields) {
    try {
      if (!window.ClientLogger || !window.ClientLogger.enabledFor('video-subtitles')) return;
      var details = subtitleSyncContext(fields || {});
      var level = details.level || 'debug';
      var message = details.message || 'subtitle diagnostic';
      delete details.level;
      delete details.message;
      window.ClientLogger.log('video-subtitles', level, message, details);
    }
    catch (_error) {
      return;
    }
  }

  function reportSubtitleSyncDiagnostic(fields) {
    reportSubtitleDiagnostic(fields);
    try {
      if (!window.ClientLogger || !window.ClientLogger.enabledFor('video')) return;
      var details = subtitleSyncContext(fields || {});
      var level = details.level || 'info';
      var message = details.message || 'subtitle sync';
      delete details.level;
      delete details.message;
      window.ClientLogger.log('video', level, message, details);
    }
    catch (_error) {
      return;
    }
  }

  function maybeLogSubtitleCueChange(displayedCue, nextCue, globalTime, trackOffsetSeconds) {
    var cueKey = buildSubtitleCueLogKey(displayedCue, globalTime);
    if (cueKey === ctx.state.subtitleDebug.lastLoggedCueKey) return;
    ctx.state.subtitleDebug.lastLoggedCueKey = cueKey;
    reportSubtitleDiagnostic({
      level: 'info',
      message: 'Subtitle cue display changed',
      absolute_cue_start: displayedCue ? trackOffsetSeconds + displayedCue.start : '',
      absolute_cue_end: displayedCue ? trackOffsetSeconds + displayedCue.end : '',
      cue_text: displayedCue ? displayedCue.text : '',
      next_absolute_cue_start: nextCue ? trackOffsetSeconds + nextCue.start : '',
      next_cue_preview: nextCue ? previewSubtitleText(nextCue.rawText) : '',
    });
  }

  function syncSubtitleDebugDisplay() {
    if (!ctx.els.debugMetaEl || !ctx.els.debugCurrentCueEl || !ctx.els.debugNextCueEl) return;
    var mediaTime = ctx.els.videoEl ? Number(ctx.els.videoEl.currentTime) : NaN;
    var globalTime = currentGlobalPlaybackSeconds();
    var trackOffsetSeconds = subtitleTrackOffsetSeconds();
    var parsedCue = findActiveParsedCue(ctx.state.subtitleDebug.cues, mediaTime);
    var nextCue = findNextParsedCue(ctx.state.subtitleDebug.cues, mediaTime);
    var textTrack = managedSubtitleTextTrack();
    var browserCues = summarizeBrowserActiveCues(textTrack);
    var displayedCue = resolveDisplayedCue(parsedCue, browserCues);
    var metaLines = [
      'Track: ' + (ctx.state.subtitleDebug.trackLabel || 'none'),
      'Playback position (absolute): ' + formatSubtitleDebugTimestamp(globalTime),
      'HLS segment offset: ' + formatSubtitleDebugTimestamp(ctx.state.compatibilityStartSeconds),
      'Subtitle track offset: ' + formatSubtitleDebugTimestamp(trackOffsetSeconds),
      'HLS media time: ' + formatSubtitleDebugTimestamp(mediaTime),
      'Parsed cues loaded: ' + String(ctx.state.subtitleDebug.cues.length),
      'Browser textTrack mode: ' + (textTrack ? textTrack.mode : 'none'),
    ];
    ctx.els.debugMetaEl.textContent = metaLines.join('\n');

    if (displayedCue) {
      ctx.els.debugCurrentCueEl.textContent = formatDisplayedCueBlock(displayedCue, trackOffsetSeconds);
    }
    else if (ctx.state.subtitleDebug.cues.length || (textTrack && textTrack.mode !== 'disabled')) {
      ctx.els.debugCurrentCueEl.textContent = 'No active subtitle cue.';
    }
    else if (ctx.state.subtitleDebug.rawVtt) {
      ctx.els.debugCurrentCueEl.textContent = 'Subtitle track loaded, but no cue is active.';
    }
    else {
      ctx.els.debugCurrentCueEl.textContent = 'No active subtitle cue.';
    }

    if (nextCue) {
      ctx.els.debugNextCueEl.textContent = formatUpcomingCueBlock(nextCue, trackOffsetSeconds);
    }
    else if (ctx.state.subtitleDebug.cues.length) {
      ctx.els.debugNextCueEl.textContent = 'No more subtitles in the loaded track.';
    }
    else {
      ctx.els.debugNextCueEl.textContent = 'No upcoming subtitle cue.';
    }

    if (ctx.state.subtitleDebug.cues.length || browserCues.length) {
      maybeLogSubtitleCueChange(displayedCue, nextCue, globalTime, trackOffsetSeconds);
    }
  }

  function bindSubtitleTextTrackEvents(textTrack) {
    if (!textTrack) return;
    textTrack.addEventListener('cuechange', function () {
      syncSubtitleOverlayDisplay();
      syncSubtitleDebugDisplay();
    });
  }

  function normalizeSubtitleStreamIndex(value) {
    if (value === '' || value === null || value === undefined) return null;
    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function revokeSubtitleObjectUrls() {
    if (!Array.isArray(ctx.state.subtitleObjectUrls)) {
      ctx.state.subtitleObjectUrls = [];
      return;
    }
    ctx.state.subtitleObjectUrls.forEach(function (url) {
      if (url) URL.revokeObjectURL(url);
    });
    ctx.state.subtitleObjectUrls = [];
  }

  function disableNativeSubtitleTracks() {
    if (!ctx.els.videoEl || !ctx.els.videoEl.textTracks) return;
    for (var index = 0; index < ctx.els.videoEl.textTracks.length; index += 1) {
      var textTrack = ctx.els.videoEl.textTracks[index];
      if (!textTrack) continue;
      textTrack.mode = 'disabled';
    }
  }

  function clearSubtitleTrack() {
    clearSubtitleOverlay();
    if (ctx.els.videoEl) {
      disableNativeSubtitleTracks();
      Array.from(ctx.els.videoEl.querySelectorAll('track')).forEach(function (node) {
        node.remove();
      });
    }
    revokeSubtitleObjectUrls();
    ctx.state.subtitleMountedSeekSeconds = null;
    ctx.state.subtitleMountedStreamIndex = null;
    resetSubtitleDebugState();
  }

  function resetSubtitlesForActiveItemChange(item) {
    renderSubtitleTrackSelector(item, null);
    reportSubtitleSyncDiagnostic({
      level: 'info',
      message: 'Subtitles cleared for playback item change',
      item_path: item && item.path ? item.path : '',
    });
  }

  function persistSubtitleSelectionFromUi(item) {
    var select = ctx.els.subtitleTrackSelectEl;
    var probePayload;
    var subtitleStreams;
    var stream;
    var layoutKey;
    if (!item || !select || select.disabled) return;
    probePayload = ctx.state.probeCache[item.path || ''] || null;
    if (!probePayload) return;
    subtitleStreams = subtitleStreamsForPayload(probePayload);
    layoutKey = subtitleTrackLayoutKey(probePayload);
    if (!select.value) {
      setStoredSubtitleTrackPreference(layoutKey, {off: true});
      return;
    }
    var path = item.path || '';
    if (!path) return;
    ctx.state.selectedSubtitleStreamIndexByPath[path] = Number(select.value);
    stream = subtitleStreams.find(function (candidate) {
      return String(candidate.index) === String(select.value);
    }) || null;
    if (stream) setStoredSubtitleTrackPreference(layoutKey, subtitleTrackPreferenceDescriptor(subtitleStreams, stream));
  }

  function persistAudioSelectionFromUi(item) {
    var select = ctx.els.audioTrackSelectEl;
    var probePayload;
    var audioStreams;
    var stream;
    var layoutKey;
    if (!item || !select || select.disabled || !select.value) return;
    probePayload = ctx.state.probeCache[item.path || ''] || null;
    if (!probePayload) return;
    audioStreams = Array.isArray(probePayload.audio_streams) ? probePayload.audio_streams : [];
    stream = audioStreams.find(function (candidate) {
      return String(candidate.index) === String(select.value);
    }) || null;
    if (!stream) return;
    layoutKey = audioTrackLayoutKey(probePayload);
    setStoredAudioTrackPreference(layoutKey, audioTrackPreferenceDescriptor(audioStreams, stream));
  }

  function resolvedSubtitleStreamIndex(item, probePayload) {
    if (!item || !probePayload) return '';
    return selectedSubtitleStreamIndex(item, probePayload);
  }

  function subtitlesEnabledForItem(item, probePayload) {
    if (!item || !probePayload) return false;
    return resolvedSubtitleStreamIndex(item, probePayload) !== '';
  }

  function selectedSubtitleStream(item, probePayload) {
    var streamIndex = resolvedSubtitleStreamIndex(item, probePayload);
    var normalized = normalizeSubtitleStreamIndex(streamIndex);
    if (normalized === null) return null;
    return subtitleStreamsForPayload(probePayload).find(function (stream) {
      return normalizeSubtitleStreamIndex(stream.index) === normalized;
    }) || null;
  }

  function selectedBurnedInSubtitleStreamIndex(item, probePayload) {
    var stream = selectedSubtitleStream(item, probePayload);
    if (!stream || !subtitleStreamRequiresBurnIn(stream)) return null;
    return normalizeSubtitleStreamIndex(stream.index);
  }

  function compatibilitySessionHasBurnedInSubtitles() {
    return normalizeSubtitleStreamIndex(ctx.state.compatibilitySubtitleStreamIndex) !== null;
  }

  function subtitlesAlreadyActive() {
    if (ctx.state.subtitleDebug.trackLabel) return true;
    var textTrack = managedSubtitleTextTrack();
    return subtitleTrackIsActive(textTrack);
  }

  function subtitlesAreMounted(item, streamIndex, seekSeconds) {
    if (!item || (item.path || '') !== activeItemPath()) return false;
    var mountedSeek = Math.max(0, Number(ctx.state.subtitleMountedSeekSeconds) || 0);
    var requestedSeek = Math.max(0, Number(seekSeconds) || 0);
    if (Math.abs(mountedSeek - requestedSeek) > 0.05) return false;
    var normalized = normalizeSubtitleStreamIndex(streamIndex);
    var mounted = normalizeSubtitleStreamIndex(ctx.state.subtitleMountedStreamIndex);
    if (normalized === null || mounted === null || normalized !== mounted) return false;
    var textTrack = managedSubtitleTextTrack();
    return subtitleTrackIsActive(textTrack);
  }

  function hlsErrorTargetsCurrentSession(data) {
    var sessionId = ctx.state.compatibilitySessionId || '';
    if (!sessionId) return true;
    var url = '';
    if (data && data.frag && data.frag.url) url = String(data.frag.url);
    else if (data && data.context && data.context.url) url = String(data.context.url);
    if (!url) return true;
    var match = url.match(/[?&]id=([^&]+)/);
    if (!match) return true;
    return match[1] === sessionId;
  }

  function ensureSubtitlesAfterPlaybackReady(reason) {
    var active = activeQueueItem();
    if (!active || ctx.state.playbackMode !== 'compatibility') return;
    if (ctx.state.seekRestartInProgress) return;
    var probePayload = ctx.state.probeCache[active.path || ''] || null;
    if (!subtitlesEnabledForItem(active, probePayload)) return;
    if (selectedBurnedInSubtitleStreamIndex(active, probePayload) !== null) return;
    var fetchStartSeconds = Math.max(0, ctx.state.compatibilityStartSeconds || 0);
    void applySubtitlesForSeek(active, probePayload, fetchStartSeconds, {
      reloadReason: reason || 'playback-ready',
      playbackSyncToken: ctx.state.playbackSyncToken,
    });
  }

  function resyncSubtitleTrackAfterHlsRecovery(reason, data) {
    if (!hlsErrorTargetsCurrentSession(data)) {
      reportSubtitleDiagnostic({
        level: 'info',
        message: 'Subtitle resync skipped for stale HLS session',
        recovery_reason: reason || '',
      });
      return;
    }
    var active = activeQueueItem();
    if (!active || ctx.state.playbackMode !== 'compatibility') return;
    var probePayload = ctx.state.probeCache[active.path || ''] || null;
    if (!subtitlesEnabledForItem(active, probePayload)) return;
    reportSubtitleDiagnostic({
      level: 'info',
      message: 'Subtitle resync after HLS recovery',
      recovery_reason: reason || '',
    });
    ensureSubtitlesAfterPlaybackReady(reason || 'hls-recovery');
  }

  async function stopCompatibilitySession() {
    var sessionId = ctx.state.compatibilitySessionId;
    ctx.state.compatibilitySessionId = '';
    ctx.state.compatibilitySubtitleStreamIndex = null;
    destroyHlsController();
    if (!sessionId) return;
    try {
      await fetch('/video/endpoints/session/stop', {
        method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8'},
        body: 'id=' + encodeURIComponent(sessionId),
      });
    }
    catch (_error) {
      return;
    }
  }

  function showPlaybackPlaceholder(title, meta) {
    hideLoadingOverlay();
    hideVideoElement();
    showPlaceholderElement();
    setPlaybackSummary(title, meta);
  }

  function showPlaybackVideo(title, meta) {
    hidePlaceholderElement();
    showVideoElement();
    setPlaybackSummary(title, meta);
  }

  function activeItemTitle(item) {
    return item && (item.display_name || item.filename || item.path)
      ? (item.display_name || item.filename || item.path)
      : 'Selected video';
  }

  function compatibilityNeededStatus() {
    if (ctx.state.playbackStatusLoaded && !ctx.state.compatibilityAvailable) {
      return 'Video playback requires ffmpeg and ffprobe.';
    }
    return 'Compatibility playback session is being prepared.';
  }

  function compatibilityNeededMeta(item) {
    if (ctx.state.playbackStatusLoaded && !ctx.state.compatibilityAvailable) {
      return 'Install or configure ffmpeg and ffprobe to enable video playback.';
    }
    return 'Preparing an HLS compatibility session for this queue item.';
  }

  function loadingOverlayCopy(item, meta, progress) {
    return {
      title: activeItemTitle(item),
      meta: meta,
      progress: progress,
    };
  }

  function playbackSyncTokenIsCurrent(syncToken) {
    return !Number.isFinite(syncToken) || syncToken === ctx.state.playbackSyncToken;
  }

  function requestVideoPlay() {
    if (!ctx.els.videoEl || typeof ctx.els.videoEl.play !== 'function') {
      ctx.state.pendingAutoplay = false;
      ctx.state.transportWantsPlay = false;
      return;
    }
    reportPlaybackTiming('play_requested');
    var requestedSyncToken = ctx.state.playbackSyncToken;
    ctx.state.transportWantsPlay = true;
    ctx.state.pendingAutoplay = true;
    var playPromise = ctx.els.videoEl.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(function () {
        if (requestedSyncToken !== ctx.state.playbackSyncToken) return;
        ctx.state.pendingAutoplay = false;
        ctx.state.transportWantsPlay = false;
        setStatus('Playback is ready. Press play if the browser blocked autoplay.');
        syncTransportControls();
      });
    }
    syncTransportControls();
  }

  function toggleVideoPlayPause() {
    if (!ctx.els.videoEl || ctx.els.videoEl.hidden) return;
    if (!playbackShouldBeRunning()) {
      if (ctx.state.loadingOverlayVisible || ctx.state.seekRestartInProgress) {
        ctx.state.transportWantsPlay = true;
        ctx.state.pendingAutoplay = true;
        syncTransportControls();
        return;
      }
      requestVideoPlay();
      return;
    }
    ctx.state.transportWantsPlay = false;
    ctx.state.pendingAutoplay = false;
    ctx.els.videoEl.pause();
    syncTransportControls();
  }

  function toggleVideoMute() {
    if (!ctx.els.videoEl || !videoControlsAvailable()) return;
    if (ctx.els.videoEl.muted || ctx.els.videoEl.volume === 0) {
      if (ctx.els.videoEl.volume === 0) ctx.els.videoEl.volume = 1;
      ctx.els.videoEl.muted = false;
    }
    else {
      ctx.els.videoEl.muted = true;
    }
    syncTransportControls();
  }

  function setVideoVolumeFromSlider() {
    if (!ctx.els.videoEl || !ctx.els.volumeSliderEl) return;
    var nextVolume = Number(ctx.els.volumeSliderEl.value);
    if (!Number.isFinite(nextVolume)) return;
    nextVolume = Math.max(0, Math.min(1, nextVolume));
    ctx.els.videoEl.volume = nextVolume;
    ctx.els.videoEl.muted = nextVolume === 0;
    syncTransportControls();
  }

  async function toggleVideoFullscreen() {
    var fullscreenHost = fullscreenHostElement();
    if (!ctx.els.videoEl || !fullscreenHost || !videoControlsAvailable()) return;
    try {
      if (document.fullscreenElement === fullscreenHost && typeof document.exitFullscreen === 'function') {
        await document.exitFullscreen();
        return;
      }
      if (typeof fullscreenHost.requestFullscreen === 'function') {
        await fullscreenHost.requestFullscreen();
      }
    }
    catch (_error) {
      setStatus('Fullscreen is unavailable in this browser context.');
    }
    finally {
      syncTransportControls();
    }
  }

  async function togglePictureInPicture() {
    if (!ctx.els.videoEl || !videoControlsAvailable()) return;
    if (!document.pictureInPictureEnabled || typeof ctx.els.videoEl.requestPictureInPicture !== 'function') {
      syncTransportControls();
      return;
    }
    try {
      if (document.pictureInPictureElement === ctx.els.videoEl) {
        await document.exitPictureInPicture();
        return;
      }
      await ctx.els.videoEl.requestPictureInPicture();
    }
    catch (_error) {
      setStatus('Picture-in-picture is unavailable for this video.');
    }
    finally {
      syncTransportControls();
    }
  }

  function attachCompatibilityVideo(playlistUrl, title, meta, startSeconds, surfaceSyncToken) {
    if (!ctx.els.videoEl) return;
    clearVideoSource();
    resetCompatibilityBufferState();
    reportPlaybackTiming('hls_attached');
    ctx.state.compatibilityStartSeconds = Math.max(0, Number(startSeconds) || 0);
    ctx.els.videoEl.controls = false;
    ctx.els.videoEl.removeAttribute('controls');
    resetCompatibilityRecoveryState();
    if (Hls && typeof Hls.isSupported === 'function' && Hls.isSupported()) {
      ctx.state.hlsController = new Hls({
        autoStartLoad: false,
        enableWorker: true,
        liveDurationInfinity: true,
        lowLatencyMode: false,
        maxLiveSyncPlaybackRate: 1,
        startFragPrefetch: true,
      });
      ctx.state.hlsController.on(Hls.Events.MANIFEST_LOADING, function (_eventName, data) {
        if (!playbackSyncTokenIsCurrent(surfaceSyncToken)) return;
        showLoadingOverlay({
          title: title,
          meta: 'Loading the HLS playlist.',
          progress: 0.84,
        });
        reportVideoDiagnostic({
          level: 'debug',
          message: 'HLS manifest loading',
          hls_url: data && data.url ? data.url : '',
        });
        reportPlaybackTiming('hls_manifest_loading');
      });
      ctx.state.hlsController.on(Hls.Events.MANIFEST_LOADED, function (_eventName, data) {
        if (!playbackSyncTokenIsCurrent(surfaceSyncToken)) return;
        showLoadingOverlay({
          title: title,
          meta: 'Playlist is ready. Attaching the stream.',
          progress: 0.9,
        });
        reportVideoDiagnostic({
          level: 'debug',
          message: 'HLS manifest loaded',
          hls_level_count: data && Array.isArray(data.levels) ? data.levels.length : '',
        });
        reportPlaybackTiming('hls_manifest_loaded', {
          hls_level_count: data && Array.isArray(data.levels) ? data.levels.length : '',
        });
      });
      ctx.state.hlsController.on(Hls.Events.MANIFEST_PARSED, function () {
        if (ctx.state.playbackMode !== 'compatibility' || !playbackSyncTokenIsCurrent(surfaceSyncToken)) return;
        showLoadingOverlay({
          title: title,
          meta: 'Buffering the first frame.',
          progress: 0.96,
        });
        reportVideoDiagnostic({
          level: 'debug',
          message: 'HLS manifest parsed',
          hls_start_position: 0,
          hls_live_sync_mode: 'file-start',
          source_start_seconds: ctx.state.compatibilityStartSeconds,
        });
        reportPlaybackTiming('hls_manifest_parsed', {
          source_start_seconds: ctx.state.compatibilityStartSeconds,
        });
        if (ctx.state.hlsController && typeof ctx.state.hlsController.startLoad === 'function') {
          ctx.state.hlsController.startLoad(0);
        }
        setStatus('Buffering compatibility playback before starting.');
      });
      ctx.state.hlsController.on(Hls.Events.FRAG_LOADING, function (_eventName, data) {
        reportVideoDiagnostic({
          level: 'debug',
          message: 'HLS fragment loading',
          frag_sn: data && data.frag ? data.frag.sn : '',
          frag_url: data && data.frag ? data.frag.url : '',
        });
      });
      ctx.state.hlsController.on(Hls.Events.FRAG_LOADED, function (_eventName, data) {
        reportVideoDiagnostic({
          level: 'debug',
          message: 'HLS fragment loaded',
          frag_sn: data && data.frag ? data.frag.sn : '',
          frag_url: data && data.frag ? data.frag.url : '',
          loaded_bytes: data && data.stats ? data.stats.loaded : '',
          loading_ms: data && data.stats && data.stats.loading
            ? Math.round(data.stats.loading.end - data.stats.loading.start)
            : '',
        });
        if (
          data && data.frag && data.frag.sn !== 'initSegment'
          && ctx.state.playbackTiming
          && !ctx.state.playbackTiming.milestones.hls_first_fragment_loaded
        ) {
          reportPlaybackTiming('hls_first_fragment_loaded', {
            frag_sn: data.frag.sn,
            loading_ms: data && data.stats && data.stats.loading
              ? Math.round(data.stats.loading.end - data.stats.loading.start)
              : '',
          });
        }
      });
      ctx.state.hlsController.on(Hls.Events.FRAG_BUFFERED, function (_eventName, data) {
        reportVideoDiagnostic({
          level: 'debug',
          message: 'HLS fragment buffered',
          frag_sn: data && data.frag ? data.frag.sn : '',
          frag_url: data && data.frag ? data.frag.url : '',
        });
        noteCompatibilityFragmentBuffered(data, title, surfaceSyncToken);
      });
      ctx.state.hlsController.on(Hls.Events.ERROR, function (_eventName, data) {
        reportVideoDiagnostic({
          level: data && data.fatal ? 'error' : 'warn',
          message: data && data.fatal ? 'Fatal HLS error' : 'Recoverable HLS error',
          hls_type: data && data.type || '',
          hls_details: data && data.details || '',
          hls_fatal: data && data.fatal ? '1' : '0',
          hls_reason: data && (data.reason || data.error && data.error.message) || '',
          hls_url: data && data.frag && data.frag.url ? data.frag.url : (data && data.context && data.context.url ? data.context.url : ''),
        });
        handleCompatibilityHlsError(data);
      });
      ctx.state.hlsController.attachMedia(ctx.els.videoEl);
      ctx.state.hlsController.loadSource(playlistUrl);
      if (playbackSyncTokenIsCurrent(surfaceSyncToken)) {
        showLoadingOverlay({
          title: title,
          meta: 'Connecting the video player to the HLS session.',
          progress: 0.78,
        });
      }
      setStatus('Compatibility playback session is loading.');
    }
    else if (ctx.els.videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      if (playbackSyncTokenIsCurrent(surfaceSyncToken)) {
        showLoadingOverlay({
          title: title,
          meta: 'Loading the HLS playlist.',
          progress: 0.84,
        });
      }
      setStatus('Compatibility playback session is loading.');
      ctx.els.videoEl.src = playlistUrl;
      ctx.els.videoEl.load();
      ctx.els.videoEl.addEventListener('loadedmetadata', function onLoadedMetadata() {
        ctx.els.videoEl.removeEventListener('loadedmetadata', onLoadedMetadata);
        if (ctx.state.playbackMode !== 'compatibility' || !playbackSyncTokenIsCurrent(surfaceSyncToken)) return;
        setStatus('Buffering compatibility playback before starting.');
      });
    }
    else {
      throw new Error('HLS playback is not supported in this browser.');
    }
    ctx.state.playbackMode = 'compatibility';
    clearSubtitleTrack();
    showPlaybackVideo(title, meta);
    syncPlaybackProgress();
    syncTransportControls();
  }

  function audioTrackLabel(stream) {
    var parts = [];
    if (stream.language) parts.push(String(stream.language).toUpperCase());
    if (stream.title) parts.push(stream.title);
    if (stream.codec_name) parts.push(String(stream.codec_name).toUpperCase());
    parts.push('Stream ' + String(stream.index));
    return parts.join(' • ');
  }

  function subtitleTrackLabel(stream) {
    var parts = [];
    if (stream.language) parts.push(String(stream.language).toUpperCase());
    if (stream.title) parts.push(stream.title);
    if (stream.codec_name) parts.push(String(stream.codec_name).toUpperCase());
    if (subtitleStreamRequiresBurnIn(stream)) parts.push('Burn-in restart');
    parts.push('Stream ' + String(stream.index));
    return parts.join(' • ');
  }

  function normalizedTrackLanguage(stream) {
    if (!stream || !stream.language) return 'und';
    return String(stream.language).toLowerCase();
  }

  function trackTitleTokens(value) {
    return String(value || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
  }

  function audioTrackRole(stream) {
    var tokens = trackTitleTokens(stream && stream.title);
    if (tokens.some(function (token) { return token === 'commentary' || token === 'comment'; })) return 'commentary';
    if (tokens.some(function (token) { return token === 'descriptive' || token === 'description' || token === 'assistive'; })) return 'descriptive';
    return 'main';
  }

  function subtitleTrackRole(stream) {
    var tokens = trackTitleTokens(stream && stream.title);
    if (tokens.some(function (token) { return token === 'commentary' || token === 'comment'; })) return 'commentary';
    if (tokens.some(function (token) { return token === 'forced' || token === 'force'; })) return 'forced';
    if (tokens.some(function (token) { return token === 'sign' || token === 'signs' || token === 'songs'; })) return 'signs';
    return 'main';
  }

  function audioTrackPreferenceSignature(stream) {
    return JSON.stringify({
      language: normalizedTrackLanguage(stream),
      role: audioTrackRole(stream),
    });
  }

  function subtitleTrackPreferenceSignature(stream) {
    return JSON.stringify({
      language: normalizedTrackLanguage(stream),
      role: subtitleTrackRole(stream),
      burn_in: subtitleStreamRequiresBurnIn(stream) ? 1 : 0,
    });
  }

  function preferenceOrdinalForTrack(streams, stream, signatureFn) {
    var targetSignature;
    var ordinal = 0;
    if (!stream || !Array.isArray(streams)) return 0;
    targetSignature = signatureFn(stream);
    for (var index = 0; index < streams.length; index += 1) {
      if (streams[index] === stream) return ordinal;
      if (signatureFn(streams[index]) === targetSignature) ordinal += 1;
    }
    return ordinal;
  }

  function audioTrackPreferenceDescriptor(streams, stream) {
    if (!stream) return null;
    return {
      signature: audioTrackPreferenceSignature(stream),
      ordinal: preferenceOrdinalForTrack(streams, stream, audioTrackPreferenceSignature),
    };
  }

  function subtitleTrackPreferenceDescriptor(streams, stream) {
    if (!stream) return {off: true};
    return {
      signature: subtitleTrackPreferenceSignature(stream),
      ordinal: preferenceOrdinalForTrack(streams, stream, subtitleTrackPreferenceSignature),
    };
  }

  function resolvePreferredTrackByDescriptor(streams, descriptor, signatureFn) {
    var ordinal;
    var matches;
    if (!Array.isArray(streams) || !streams.length || !descriptor || typeof descriptor !== 'object') return null;
    if (descriptor.off) return '';
    if (typeof descriptor.signature !== 'string' || !descriptor.signature) return null;
    ordinal = Number.isInteger(descriptor.ordinal) && descriptor.ordinal >= 0 ? descriptor.ordinal : 0;
    matches = streams.filter(function (stream) {
      return signatureFn(stream) === descriptor.signature;
    });
    if (!matches.length) return null;
    return matches[Math.min(ordinal, matches.length - 1)] || null;
  }

  function encodeTrackPreferenceLayout(layoutParts) {
    return Array.isArray(layoutParts) ? JSON.stringify(layoutParts) : '';
  }

  function audioTrackLayoutKey(probePayload) {
    var audioStreams = Array.isArray(probePayload && probePayload.audio_streams) ? probePayload.audio_streams : [];
    return encodeTrackPreferenceLayout(audioStreams.map(audioTrackPreferenceSignature));
  }

  function subtitleTrackLayoutKey(probePayload) {
    var subtitleStreams = subtitleStreamsForPayload(probePayload);
    return encodeTrackPreferenceLayout(['off'].concat(subtitleStreams.map(subtitleTrackPreferenceSignature)));
  }

  function loadStoredTrackPreferences(storageKey) {
    try {
      var storage = window.localStorage;
      if (!storage) return Object.create(null);
      var raw = storage.getItem(storageKey);
      if (!raw) return Object.create(null);
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return Object.create(null);
      return Object.assign(Object.create(null), parsed);
    }
    catch (_error) {
      return Object.create(null);
    }
  }

  function saveStoredTrackPreferences(storageKey, value) {
    try {
      var storage = window.localStorage;
      if (!storage) return;
      storage.setItem(storageKey, JSON.stringify(value || {}));
    }
    catch (_error) {
      return;
    }
  }

  function setStoredAudioTrackPreference(layoutKey, descriptor) {
    if (!layoutKey || !descriptor) return;
    ctx.state.audioTrackPreferenceByLayout[layoutKey] = descriptor;
    saveStoredTrackPreferences('dropbox-browser-video-audio-track-preferences', ctx.state.audioTrackPreferenceByLayout);
  }

  function setStoredSubtitleTrackPreference(layoutKey, descriptor) {
    if (!layoutKey || !descriptor) return;
    ctx.state.subtitleTrackPreferenceByLayout[layoutKey] = descriptor;
    saveStoredTrackPreferences('dropbox-browser-video-subtitle-track-preferences', ctx.state.subtitleTrackPreferenceByLayout);
  }

  function setAudioTrackPlaceholder(text) {
    var select = ctx.els.audioTrackSelectEl;
    if (!select) return;
    select.innerHTML = '';
    var option = document.createElement('option');
    option.value = '';
    option.textContent = text;
    select.appendChild(option);
    select.disabled = true;
  }

  function setSubtitleTrackPlaceholder(text) {
    var select = ctx.els.subtitleTrackSelectEl;
    if (!select) return;
    select.innerHTML = '';
    var option = document.createElement('option');
    option.value = '';
    option.textContent = text;
    select.appendChild(option);
    select.disabled = true;
  }

  function selectedAudioStreamIndex(item, probePayload) {
    if (!item || !probePayload) return null;
    var path = item.path || '';
    var audioStreams = Array.isArray(probePayload.audio_streams) ? probePayload.audio_streams : [];
    var layoutKey;
    var storedPreference;
    var matchedStoredStream;
    if (!audioStreams.length) return null;
    var saved = ctx.state.selectedAudioStreamIndexByPath[path];
    if (typeof saved === 'number' && audioStreams.some(function (stream) { return stream.index === saved; })) {
      return saved;
    }
    layoutKey = audioTrackLayoutKey(probePayload);
    storedPreference = ctx.state.audioTrackPreferenceByLayout[layoutKey];
    matchedStoredStream = resolvePreferredTrackByDescriptor(audioStreams, storedPreference, audioTrackPreferenceSignature);
    if (matchedStoredStream) {
      ctx.state.selectedAudioStreamIndexByPath[path] = matchedStoredStream.index;
      return matchedStoredStream.index;
    }
    var probeDefault = probePayload.default_audio_stream_index;
    if (typeof probeDefault === 'number' && audioStreams.some(function (stream) { return stream.index === probeDefault; })) {
      ctx.state.selectedAudioStreamIndexByPath[path] = probeDefault;
      var defaultStream = audioStreams.find(function (stream) { return stream.index === probeDefault; }) || null;
      if (defaultStream) setStoredAudioTrackPreference(layoutKey, audioTrackPreferenceDescriptor(audioStreams, defaultStream));
      return probeDefault;
    }
    var fallback = audioStreams[0].index;
    ctx.state.selectedAudioStreamIndexByPath[path] = fallback;
    setStoredAudioTrackPreference(layoutKey, audioTrackPreferenceDescriptor(audioStreams, audioStreams[0]));
    return fallback;
  }

  function renderAudioTrackSelector(item, probePayload) {
    var select = ctx.els.audioTrackSelectEl;
    if (!select) return;
    if (!item) {
      setAudioTrackPlaceholder('No video selected');
      return;
    }
    if (!probePayload) {
      var failed = Boolean(ctx.state.probeFailures[item.path || '']);
      setAudioTrackPlaceholder(failed ? 'Audio tracks unavailable' : 'Loading audio tracks...');
      return;
    }
    var audioStreams = Array.isArray(probePayload.audio_streams) ? probePayload.audio_streams : [];
    if (!audioStreams.length) {
      setAudioTrackPlaceholder('No audio tracks found');
      return;
    }
    var selected = selectedAudioStreamIndex(item, probePayload);
    select.innerHTML = '';
    audioStreams.forEach(function (stream) {
      var option = document.createElement('option');
      option.value = String(stream.index);
      option.textContent = audioTrackLabel(stream);
      if (selected === stream.index) option.selected = true;
      select.appendChild(option);
    });
    select.disabled = false;
  }

  function selectedSubtitleStreamIndex(item, probePayload) {
    if (!item || !probePayload) return '';
    var path = item.path || '';
    var subtitleStreams = subtitleStreamsForPayload(probePayload);
    var layoutKey;
    var storedPreference;
    var matchedStoredStream;
    if (!subtitleStreams.length) return '';
    var saved = ctx.state.selectedSubtitleStreamIndexByPath[path];
    if (saved === '') return '';
    if (typeof saved === 'number' && subtitleStreams.some(function (stream) { return stream.index === saved; })) {
      return saved;
    }
    layoutKey = subtitleTrackLayoutKey(probePayload);
    storedPreference = ctx.state.subtitleTrackPreferenceByLayout[layoutKey];
    if (storedPreference && typeof storedPreference === 'object' && storedPreference.off) {
      ctx.state.selectedSubtitleStreamIndexByPath[path] = '';
      return '';
    }
    matchedStoredStream = resolvePreferredTrackByDescriptor(subtitleStreams, storedPreference, subtitleTrackPreferenceSignature);
    if (matchedStoredStream) {
      ctx.state.selectedSubtitleStreamIndexByPath[path] = matchedStoredStream.index;
      return matchedStoredStream.index;
    }
    if (probePayload.subtitle_off_default && saved === undefined) {
      setStoredSubtitleTrackPreference(layoutKey, {off: true});
      return '';
    }
    var probeDefault = probePayload.default_subtitle_stream_index;
    if (typeof probeDefault === 'number' && subtitleStreams.some(function (stream) { return stream.index === probeDefault; })) {
      ctx.state.selectedSubtitleStreamIndexByPath[path] = probeDefault;
      var defaultSubtitleStream = subtitleStreams.find(function (stream) { return stream.index === probeDefault; }) || null;
      if (defaultSubtitleStream) {
        setStoredSubtitleTrackPreference(layoutKey, subtitleTrackPreferenceDescriptor(subtitleStreams, defaultSubtitleStream));
      }
      return probeDefault;
    }
    ctx.state.selectedSubtitleStreamIndexByPath[path] = '';
    setStoredSubtitleTrackPreference(layoutKey, {off: true});
    return '';
  }

  function renderSubtitleTrackSelector(item, probePayload) {
    var select = ctx.els.subtitleTrackSelectEl;
    if (!select) return;
    if (!item) {
      setSubtitleTrackPlaceholder('No video selected');
      return;
    }
    if (!probePayload) {
      var failed = Boolean(ctx.state.probeFailures[item.path || '']);
      setSubtitleTrackPlaceholder(failed ? 'Subtitle tracks unavailable' : 'Loading subtitle tracks...');
      return;
    }
    var subtitleStreams = subtitleStreamsForPayload(probePayload);
    if (!subtitleStreams.length) {
      setSubtitleTrackPlaceholder('No subtitle tracks found');
      return;
    }
    var selected = selectedSubtitleStreamIndex(item, probePayload);
    select.innerHTML = '';
    var offOption = document.createElement('option');
    offOption.value = '';
    offOption.textContent = 'Subtitles Off';
    if (selected === '') offOption.selected = true;
    select.appendChild(offOption);
    subtitleStreams.forEach(function (stream) {
      var option = document.createElement('option');
      option.value = String(stream.index);
      option.textContent = subtitleTrackLabel(stream);
      if (selected === stream.index) option.selected = true;
      select.appendChild(option);
    });
    select.disabled = false;
  }

  function probeStorageEntrySize(path, entry) {
    if (!entry || !entry.payload) return path.length + 32;
    return path.length + JSON.stringify(entry.payload).length + 32;
  }

  function readProbeStorageIndex() {
    try {
      var raw = sessionStorage.getItem(PROBE_STORAGE_KEY);
      if (!raw) return {entries: Object.create(null), totalBytes: 0};
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !parsed.entries || typeof parsed.entries !== 'object') {
        return {entries: Object.create(null), totalBytes: 0};
      }
      return parsed;
    }
    catch (_error) {
      return {entries: Object.create(null), totalBytes: 0};
    }
  }

  function writeProbeStorageIndex(index) {
    try {
      sessionStorage.setItem(PROBE_STORAGE_KEY, JSON.stringify(index));
    }
    catch (_error) {
      return;
    }
  }

  function evictProbeStorageForSize(index) {
    var paths = Object.keys(index.entries || {});
    var rows = paths.map(function (path) {
      var entry = index.entries[path];
      return {
        path: path,
        accessedAt: entry && entry.accessedAt ? entry.accessedAt : 0,
        size: probeStorageEntrySize(path, entry),
      };
    });
    rows.sort(function (left, right) {
      return left.accessedAt - right.accessedAt;
    });
    var totalBytes = rows.reduce(function (sum, row) { return sum + row.size; }, 0);
    while (totalBytes > PROBE_STORAGE_MAX_BYTES && rows.length) {
      var oldest = rows.shift();
      if (!oldest) break;
      delete index.entries[oldest.path];
      totalBytes -= oldest.size;
    }
    index.totalBytes = totalBytes;
  }

  function pruneExpiredProbeStorage(index) {
    var now = Date.now();
    var totalBytes = 0;
    Object.keys(index.entries || {}).forEach(function (path) {
      var entry = index.entries[path];
      if (!entry || !entry.cachedAt || now - entry.cachedAt > PROBE_STORAGE_TTL_MS) {
        delete index.entries[path];
        return;
      }
      totalBytes += probeStorageEntrySize(path, entry);
    });
    index.totalBytes = totalBytes;
    evictProbeStorageForSize(index);
  }

  function getProbeFromSessionStorage(path) {
    var index = readProbeStorageIndex();
    pruneExpiredProbeStorage(index);
    var entry = index.entries[path];
    if (!entry || !entry.payload) {
      writeProbeStorageIndex(index);
      return null;
    }
    entry.accessedAt = Date.now();
    writeProbeStorageIndex(index);
    return entry.payload;
  }

  function setProbeInSessionStorage(path, payload) {
    var index = readProbeStorageIndex();
    pruneExpiredProbeStorage(index);
    if (index.entries[path]) {
      index.totalBytes = Math.max(
        0,
        (index.totalBytes || 0) - probeStorageEntrySize(path, index.entries[path])
      );
    }
    var entry = {
      payload: payload,
      cachedAt: Date.now(),
      accessedAt: Date.now(),
    };
    index.entries[path] = entry;
    index.totalBytes = (index.totalBytes || 0) + probeStorageEntrySize(path, entry);
    evictProbeStorageForSize(index);
    writeProbeStorageIndex(index);
  }

  async function loadProbeMetadata(item) {
    if (!item || !item.path) return null;
    var path = item.path;
    if (ctx.state.probeCache[path]) return ctx.state.probeCache[path];
    var storedPayload = getProbeFromSessionStorage(path);
    if (storedPayload) {
      ctx.state.probeCache[path] = storedPayload;
      return storedPayload;
    }
    if (ctx.state.probeFailures[path]) return null;
    try {
      var response = await fetch('/video/endpoints/probe?path=' + encodeURIComponent(path) + '&source=remote');
      if (!response.ok) throw new Error('Failed to probe video metadata.');
      var payload = await response.json();
      ctx.state.probeCache[path] = payload;
      setProbeInSessionStorage(path, payload);
      delete ctx.state.probeFailures[path];
      syncPlaybackProgress();
      return payload;
    }
    catch (_error) {
      ctx.state.probeFailures[path] = true;
      return null;
    }
  }

  async function ensureAudioTracksForItem(item) {
    if (!item) {
      renderAudioTrackSelector(null, null);
      return null;
    }
    renderAudioTrackSelector(item, ctx.state.probeCache[item.path || ''] || null);
    var payload = await loadProbeMetadata(item);
    if (item.path !== activeItemPath()) return payload;
    renderAudioTrackSelector(item, payload);
    return payload;
  }

  async function ensureSubtitleTracksForItem(item) {
    if (!item) {
      renderSubtitleTrackSelector(null, null);
      return null;
    }
    renderSubtitleTrackSelector(item, ctx.state.probeCache[item.path || ''] || null);
    var payload = await loadProbeMetadata(item);
    if (item.path !== activeItemPath()) return payload;
    renderSubtitleTrackSelector(item, payload);
    return payload;
  }

  function subtitleTrackUrl(item, subtitleStreamIndex) {
    return '/video/endpoints/subtitles?path='
      + encodeURIComponent(item.path || '')
      + '&source=remote&track='
      + encodeURIComponent(String(subtitleStreamIndex));
  }

  function allSubtitlesUrl(item) {
    return '/video/endpoints/subtitles/all?path='
      + encodeURIComponent(item.path || '')
      + '&source=remote';
  }

  function subtitleStreamsForPayload(probePayload) {
    return Array.isArray(probePayload && probePayload.subtitle_streams)
      ? probePayload.subtitle_streams
      : [];
  }

  function subtitleStreamSupportsWebVtt(stream) {
    if (!stream) return false;
    if (stream.webvtt_compatible === false) return false;
    return true;
  }

  function subtitleStreamRequiresBurnIn(stream) {
    return !subtitleStreamSupportsWebVtt(stream);
  }

  function webvttCompatibleSubtitleStreams(probePayload) {
    return subtitleStreamsForPayload(probePayload).filter(subtitleStreamSupportsWebVtt);
  }

  function isSubtitleVttCachedForStream(path, subtitleStreamIndex) {
    return Boolean(getCachedFullSubtitleVtt(path, subtitleStreamIndex));
  }

  function allSubtitleTracksCachedForItem(item, probePayload) {
    if (!item || !item.path) return true;
    var subtitleStreams = webvttCompatibleSubtitleStreams(probePayload);
    if (!subtitleStreams.length) return true;
    var path = item.path;
    return subtitleStreams.every(function (stream) {
      return !stream
        || stream.index === undefined
        || stream.index === null
        || isSubtitleVttCachedForStream(path, stream.index);
    });
  }

  async function preloadSubtitleVttForStream(item, subtitleStreamIndex) {
    var response = await fetch(subtitleTrackUrl(item, subtitleStreamIndex));
    if (!response.ok) {
      throw new Error('Subtitle extraction failed for track ' + String(subtitleStreamIndex) + '.');
    }
    var body = await response.text();
    if (!body || body.indexOf('WEBVTT') !== 0) {
      throw new Error('Invalid WebVTT for track ' + String(subtitleStreamIndex) + '.');
    }
    storeFullSubtitleVtt(item.path || '', subtitleStreamIndex, body);
  }

  async function preloadAllSubtitleVttsForItem(item, probePayload) {
    if (!item || !item.path) return;
    var path = item.path;
    var payload = probePayload || ctx.state.probeCache[path] || null;
    if (!payload) return;
    var subtitleStreams = webvttCompatibleSubtitleStreams(payload);
    if (!subtitleStreams.length) return;
    if (allSubtitleTracksCachedForItem(item, payload)) return;
    if (ctx.state.subtitleWarmInFlightByPath[path]) {
      return ctx.state.subtitleWarmInFlightByPath[path];
    }
    var warmWork = (async function () {
      var batchFailed = false;
      try {
        var response = await fetch(allSubtitlesUrl(item));
        if (!response.ok) {
          batchFailed = true;
          reportSubtitleSyncDiagnostic({
            level: 'warn',
            message: 'Subtitle batch preload failed',
            http_status: response.status,
          });
        }
        else {
          var body = await response.json();
          var tracks = body && body.tracks && typeof body.tracks === 'object' ? body.tracks : {};
          Object.keys(tracks).forEach(function (key) {
            var entry = tracks[key];
            if (!entry || typeof entry.vtt !== 'string') return;
            storeFullSubtitleVtt(path, Number(key), entry.vtt);
          });
        }
      }
      catch (error) {
        batchFailed = true;
        reportSubtitleSyncDiagnostic({
          level: 'warn',
          message: 'Subtitle batch preload failed',
          error_message: error && error.message ? String(error.message) : 'unknown',
        });
      }
      if (batchFailed) {
        var missingStreams = subtitleStreams.filter(function (stream) {
          return !isSubtitleVttCachedForStream(path, stream.index);
        });
        await Promise.all(missingStreams.map(function (stream) {
          return preloadSubtitleVttForStream(item, stream.index).catch(function (error) {
            reportSubtitleSyncDiagnostic({
              level: 'warn',
              message: 'Subtitle per-track preload failed',
              subtitle_stream_index: stream.index,
              error_message: error && error.message ? String(error.message) : 'unknown',
            });
          });
        }));
      }
    })().finally(function () {
      if (ctx.state.subtitleWarmInFlightByPath[path] === warmWork) {
        delete ctx.state.subtitleWarmInFlightByPath[path];
      }
    });
    ctx.state.subtitleWarmInFlightByPath[path] = warmWork;
    return warmWork;
  }

  function subtitlePlaybackRequestIsStale(options) {
    if (!options || options.playbackSyncToken === undefined) return false;
    return options.playbackSyncToken !== ctx.state.playbackSyncToken;
  }

  function updateSubtitleDebugForStream(item, probePayload, streamIndex, fetchStartSeconds) {
    var normalized = normalizeSubtitleStreamIndex(streamIndex);
    if (!item || normalized === null) {
      resetSubtitleDebugState();
      return;
    }
    var fullSubtitleText = getCachedFullSubtitleVtt(item.path || '', normalized);
    if (!fullSubtitleText) {
      resetSubtitleDebugState();
      return;
    }
    var subtitleStreams = subtitleStreamsForPayload(probePayload);
    var subtitleStream = subtitleStreams.find(function (stream) {
      return normalizeSubtitleStreamIndex(stream.index) === normalized;
    }) || null;
    var rebasedText = rebaseWebVttText(fullSubtitleText, fetchStartSeconds);
    ctx.state.subtitleDebug.rawVtt = rebasedText;
    ctx.state.subtitleDebug.cues = parseWebVttCues(rebasedText);
    ctx.state.subtitleDebug.fetchStartSeconds = fetchStartSeconds;
    ctx.state.subtitleDebug.streamIndex = normalized;
    ctx.state.subtitleDebug.trackLabel = subtitleStream ? subtitleTrackLabel(subtitleStream) : 'Subtitles';
    ctx.state.subtitleDebug.lastLoggedCueKey = '';
    syncSubtitleDebugDisplay();
  }

  function mountSubtitleTrackForItem(item, probePayload, streamIndex, seekSeconds, options) {
    options = options || {};
    if (!item || !ctx.els.videoEl || item.path !== activeItemPath()) return false;
    if (subtitlePlaybackRequestIsStale(options)) return false;
    var normalized = normalizeSubtitleStreamIndex(streamIndex);
    if (normalized === null) {
      clearSubtitleTrack();
      return true;
    }
    var payload = probePayload || ctx.state.probeCache[item.path || ''] || null;
    if (!payload) return false;
    var fullSubtitleText = getCachedFullSubtitleVtt(item.path || '', normalized);
    if (!fullSubtitleText) return false;
    var requestedSeek = Math.max(0, Number(seekSeconds) || 0);
    var rebasedText = rebaseWebVttText(fullSubtitleText, requestedSeek);
    clearSubtitleTrack();
    var subtitleStreams = subtitleStreamsForPayload(payload);
    var subtitleStream = subtitleStreams.find(function (stream) {
      return normalizeSubtitleStreamIndex(stream.index) === normalized;
    }) || null;
    var objectUrl = URL.createObjectURL(new Blob([rebasedText], {type: 'text/vtt'}));
    ctx.state.subtitleObjectUrls.push(objectUrl);
    var track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = subtitleStream ? subtitleTrackLabel(subtitleStream) : 'Subtitles';
    track.srclang = subtitleStream && subtitleStream.language ? String(subtitleStream.language) : 'und';
    track.src = objectUrl;
    track.default = true;
    track.setAttribute('data-video-subtitle-track', '1');
    track.setAttribute('data-video-subtitle-stream-index', String(normalized));
    ctx.els.videoEl.appendChild(track);
    ctx.state.subtitleMountedSeekSeconds = requestedSeek;
    ctx.state.subtitleMountedStreamIndex = normalized;
    function activateTrack() {
      if (!track.isConnected) return;
      var textTrack = track.track;
      if (!textTrack) return;
      for (var index = 0; index < ctx.els.videoEl.textTracks.length; index += 1) {
        var candidate = ctx.els.videoEl.textTracks[index];
        if (!candidate || candidate.kind !== 'subtitles') continue;
        candidate.mode = candidate === textTrack ? 'hidden' : 'disabled';
      }
      bindSubtitleTextTrackEvents(textTrack);
      syncSubtitleOverlayDisplay();
      updateSubtitleDebugForStream(item, payload, normalized, requestedSeek);
      reportSubtitleSyncDiagnostic({
        level: 'info',
        message: 'Subtitle track mounted',
        subtitle_stream_index: normalized,
        subtitle_fetch_start_seconds: requestedSeek,
      });
    }
    if (track.readyState >= 2) activateTrack();
    else track.addEventListener('load', activateTrack, {once: true});
    if (!options.silent) setStatus('Subtitle track is ready.');
    return true;
  }

  function scheduleSubtitlesAfterPlaybackReady(item, probePayload, seekSeconds, syncToken, reloadReason) {
    if (!item || !probePayload) return;
    if (selectedBurnedInSubtitleStreamIndex(item, probePayload) !== null) return;
    void preloadAllSubtitleVttsForItem(item, probePayload).then(function () {
      if (syncToken !== ctx.state.playbackSyncToken) return;
      return applySubtitlesForSeek(item, probePayload, seekSeconds, {
        playbackSyncToken: syncToken,
        reloadReason: reloadReason || 'initial-playback',
      });
    });
  }

  async function applySubtitlesForSeek(item, probePayload, seekSeconds, options) {
    options = options || {};
    var fetchStartSeconds = Math.max(0, Number(seekSeconds) || 0);
    persistSubtitleSelectionFromUi(item);
    if (!item || !ctx.els.videoEl) return;
    if (subtitlePlaybackRequestIsStale(options)) return;
    var cachedPayload = probePayload || ctx.state.probeCache[item.path || ''] || null;
    var streamIndex = resolvedSubtitleStreamIndex(item, cachedPayload);
    if (streamIndex === '') {
      clearSubtitleTrack();
      return;
    }
    if (subtitlesAreMounted(item, streamIndex, fetchStartSeconds)) {
      reportSubtitleSyncDiagnostic({
        level: 'info',
        message: 'Subtitle mount skipped',
        skip_reason: 'already-mounted',
      });
      return;
    }
    reportSubtitleSyncDiagnostic({
      level: 'info',
      message: 'Subtitle mount started',
      reload_reason: options.reloadReason || '',
      fetch_start_seconds: fetchStartSeconds,
    });
    try {
      if (!cachedPayload) {
        cachedPayload = await ensureSubtitleTracksForItem(item);
        if (!cachedPayload || item.path !== activeItemPath()) return;
        streamIndex = resolvedSubtitleStreamIndex(item, cachedPayload);
        if (streamIndex === '') return;
      }
      await preloadAllSubtitleVttsForItem(item, cachedPayload);
      if (subtitlePlaybackRequestIsStale(options)) return;
      cachedPayload = cachedPayload || ctx.state.probeCache[item.path || ''] || null;
      if (!mountSubtitleTrackForItem(item, cachedPayload, streamIndex, fetchStartSeconds, options)) {
        throw new Error('Subtitle mount failed.');
      }
    }
    catch (error) {
      reportSubtitleSyncDiagnostic({
        level: 'error',
        message: 'Subtitle extraction failed',
        error_message: error && error.message ? String(error.message) : 'unknown',
        subtitle_stream_index: streamIndex,
      });
      if (!subtitlesAlreadyActive()) {
        setStatus('Subtitle extraction failed.');
        setPlaybackSummary(activeItemTitle(item), 'Selected subtitle track could not be converted to WebVTT.');
      }
      else {
        setStatus('Subtitle refresh failed; keeping the previous subtitle track.');
      }
    }
  }

  async function createCompatibilitySession(item, audioStreamIndex, startSeconds, subtitleStreamIndex) {
    var body = 'path=' + encodeURIComponent(item.path || '')
      + '&source=remote'
      + '&start_time_seconds=' + encodeURIComponent(String(Math.max(0, Number(startSeconds) || 0)));
    if (typeof audioStreamIndex === 'number') {
      body += '&audio_stream_index=' + encodeURIComponent(String(audioStreamIndex));
    }
    if (typeof subtitleStreamIndex === 'number') {
      body += '&subtitle_stream_index=' + encodeURIComponent(String(subtitleStreamIndex));
    }
    var response = await fetch('/video/endpoints/session', {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8'},
      body: body,
    });
    if (!response.ok) {
      var errorText = '';
      try {
        errorText = await response.text();
      }
      catch (_error) {
        errorText = '';
      }
      throw new Error(errorText || 'Failed to start compatibility playback.');
    }
    return response.json();
  }

  async function restartCompatibilityAt(targetSeconds, reason) {
    var active = activeQueueItem();
    if (!active || !ctx.state.compatibilityAvailable) return;
    clearCompatibilityRecoveryTimer();
    var syncToken = ++ctx.state.playbackSyncToken;
    resetPlaybackTiming(active.path || '', reason || 'seek-restart');
    reportPlaybackTiming('probe_start', {probe_cache_hit: Boolean(ctx.state.probeCache[active.path || ''])});
    var probePayload = ctx.state.probeCache[active.path || ''] || await ensureAudioTracksForItem(active);
    reportPlaybackTiming('probe_complete', {probe_cache_hit: Boolean(ctx.state.probeCache[active.path || ''])});
    if (syncToken !== ctx.state.playbackSyncToken) return;
    var duration = playbackDurationSeconds(
      ctx.els.videoEl ? Number(ctx.els.videoEl.duration) : NaN,
      probePayload,
      'compatibility'
    );
    var clampedTarget = Math.max(0, Number(targetSeconds) || 0);
    if (Number.isFinite(duration) && duration > 0) {
      clampedTarget = Math.min(duration, clampedTarget);
    }
    var wasPlaying = playbackShouldBeRunning();
    ctx.state.requestedSeekSeconds = clampedTarget;
    ctx.state.seekRestartInProgress = true;
    clearSubtitleTrack();
    ctx.state.pendingAutoplay = wasPlaying || reason === 'scrub';
    if (ctx.els.videoEl && typeof ctx.els.videoEl.pause === 'function') {
      ctx.els.videoEl.pause();
    }
    if (ctx.els.progressSliderEl) ctx.els.progressSliderEl.value = String(clampedTarget);
    if (ctx.els.elapsedTimeEl) ctx.els.elapsedTimeEl.textContent = formatNativePlaybackTime(clampedTarget);
    setPlaybackSummary(activeItemTitle(active), 'Loading compatibility playback at ' + formatPlaybackTime(clampedTarget) + '.');
    showLoadingOverlay(loadingOverlayCopy(
      active,
      'Creating a compatibility stream at ' + formatPlaybackTime(clampedTarget) + '.',
      0.48
    ));
    setStatus('Loading compatibility playback at ' + formatPlaybackTime(clampedTarget) + '.');
    reportVideoDiagnostic({
      level: 'info',
      message: 'Compatibility seek restart requested',
      seek_reason: reason || '',
      requested_time: clampedTarget,
      source_start_seconds: ctx.state.compatibilityStartSeconds,
      actual_global_time_before: currentGlobalPlaybackSeconds(),
      media_current_time_before: ctx.els.videoEl ? ctx.els.videoEl.currentTime || 0 : '',
      media_buffered: ctx.els.videoEl ? mediaRangesSummary(ctx.els.videoEl.buffered) : [],
      media_seekable: ctx.els.videoEl ? mediaRangesSummary(ctx.els.videoEl.seekable) : [],
      duration: duration || '',
    });
    renderSubtitleTrackSelector(active, probePayload);
    persistSubtitleSelectionFromUi(active);
    if (!probePayload) {
      ctx.state.pendingAutoplay = false;
      ctx.state.transportWantsPlay = false;
      ctx.state.seekRestartInProgress = false;
      setStatus('Could not inspect video tracks.');
      return;
    }
    await stopCompatibilitySession();
    if (syncToken !== ctx.state.playbackSyncToken) return;
    var audioStreamIndex = selectedAudioStreamIndex(active, probePayload);
    var burnedInSubtitleStreamIndex = selectedBurnedInSubtitleStreamIndex(active, probePayload);
    try {
      reportPlaybackTiming('session_create_requested', {requested_time: clampedTarget});
      var session = await createCompatibilitySession(
        active,
        audioStreamIndex,
        clampedTarget,
        burnedInSubtitleStreamIndex
      );
      if (syncToken !== ctx.state.playbackSyncToken) {
        await stopCompatibilitySession();
        return;
      }
      ctx.state.compatibilitySessionId = session.session_id || '';
      reportPlaybackTiming('session_create_complete', {
        requested_time: clampedTarget,
        server_session_create_elapsed_ms: session.session_create_elapsed_ms,
      });
      ctx.state.seekRestartInProgress = false;
      ctx.state.requestedSeekSeconds = null;
      showLoadingOverlay(loadingOverlayCopy(
        active,
        'Compatibility session is ready. Starting the video player.',
        0.72
      ));
      attachCompatibilityVideo(
        session.playlist_url,
        activeItemTitle(active),
        'Playing through a local HLS compatibility session from ' + formatPlaybackTime(Number(session.start_time_seconds) || 0) + '.',
        Number(session.start_time_seconds) || clampedTarget,
        syncToken
      );
      ctx.state.compatibilitySubtitleStreamIndex = normalizeSubtitleStreamIndex(session.subtitle_stream_index);
      reportVideoDiagnostic({
        level: 'info',
        message: 'Compatibility seek restart ready',
        seek_reason: reason || '',
        requested_time: clampedTarget,
        source_start_seconds: Number(session.start_time_seconds) || clampedTarget,
        session_id: session.session_id || '',
        subtitle_stream_index: session.subtitle_stream_index,
      });
      scheduleSubtitlesAfterPlaybackReady(
        active,
        probePayload,
        Number(session.start_time_seconds) || clampedTarget,
        syncToken,
        reason || 'restart'
      );
    }
    catch (_error) {
      if (syncToken !== ctx.state.playbackSyncToken) return;
      ctx.state.compatibilitySessionId = '';
      ctx.state.compatibilitySubtitleStreamIndex = null;
      ctx.state.seekRestartInProgress = false;
      ctx.state.requestedSeekSeconds = null;
      ctx.state.playbackMode = 'compatibility';
      reportVideoDiagnostic({
        level: 'warn',
        message: 'Compatibility seek restart failed; scheduling recovery',
        seek_reason: reason || '',
        requested_time: clampedTarget,
      });
      scheduleCompatibilityRecovery(reason || 'restart-failed', clampedTarget, null);
    }
  }

  async function syncPlaybackForActiveItem() {
    var active = activeQueueItem();
    clearCompatibilityRecoveryTimer();
    var syncToken = ++ctx.state.playbackSyncToken;
    if (!active) {
      ctx.state.playbackMode = 'none';
      ctx.state.pendingAutoplay = false;
      ctx.state.transportWantsPlay = false;
      renderAudioTrackSelector(null, null);
      renderSubtitleTrackSelector(null, null);
      await stopCompatibilitySession();
      resetPlaybackSurface();
      showPlaybackPlaceholder(
        'No video selected',
        'Queue a video to start compatibility playback.'
      );
      return;
    }

    if (!ctx.state.playbackStatusLoaded) {
      if (!ctx.state.loadingPlaybackStatus) void loadPlaybackStatus();
      ctx.state.playbackMode = 'loading';
      resetPlaybackSurface();
      resetSubtitlesForActiveItemChange(active);
      renderAudioTrackSelector(active, null);
      showPlaybackPlaceholder(activeItemTitle(active), 'Loading video playback capabilities.');
      showLoadingOverlay(loadingOverlayCopy(active, 'Loading video playback capabilities.', 0.08));
      setStatus('Loading video playback capabilities.');
      return;
    }

    resetPlaybackSurface();
    resetSubtitlesForActiveItemChange(active);
    showPlaybackPlaceholder(activeItemTitle(active), '');

    if (!ctx.state.compatibilityAvailable) {
      ctx.state.pendingAutoplay = false;
      ctx.state.transportWantsPlay = false;
      ctx.state.playbackMode = 'compatibility-unavailable';
      renderAudioTrackSelector(active, null);
      renderSubtitleTrackSelector(active, null);
      await stopCompatibilitySession();
      if (syncToken !== ctx.state.playbackSyncToken) return;
      showPlaybackPlaceholder(activeItemTitle(active), compatibilityNeededMeta(active));
      setStatus(compatibilityNeededStatus());
      return;
    }

    setPlaybackSummary(activeItemTitle(active), compatibilityNeededMeta(active));
    resetPlaybackTiming(active.path || '', 'initial-playback');
    showLoadingOverlay(loadingOverlayCopy(
      active,
      'Inspecting video tracks and preparing compatibility playback.',
      0.22
    ));
    setStatus(compatibilityNeededStatus());
    reportPlaybackTiming('probe_start', {probe_cache_hit: Boolean(ctx.state.probeCache[active.path || ''])});
    var probePayload = await ensureAudioTracksForItem(active);
    reportPlaybackTiming('probe_complete', {probe_cache_hit: Boolean(ctx.state.probeCache[active.path || ''])});
    renderSubtitleTrackSelector(active, probePayload);
    if (syncToken !== ctx.state.playbackSyncToken) return;
    if (!probePayload) {
      ctx.state.pendingAutoplay = false;
      ctx.state.transportWantsPlay = false;
      ctx.state.playbackMode = 'compatibility-error';
      showPlaybackPlaceholder(activeItemTitle(active), 'Could not inspect video tracks for compatibility playback.');
      setStatus('Could not inspect video tracks.');
      resetPlaybackProgress();
      return;
    }
    var audioStreamIndex = selectedAudioStreamIndex(active, probePayload);
    var burnedInSubtitleStreamIndex = selectedBurnedInSubtitleStreamIndex(active, probePayload);
    try {
      showLoadingOverlay(loadingOverlayCopy(active, 'Creating the local HLS compatibility session.', 0.48));
      reportPlaybackTiming('session_create_requested');
      var session = await createCompatibilitySession(active, audioStreamIndex, 0, burnedInSubtitleStreamIndex);
      if (syncToken !== ctx.state.playbackSyncToken) {
        await stopCompatibilitySession();
        return;
      }
      ctx.state.compatibilitySessionId = session.session_id || '';
      reportPlaybackTiming('session_create_complete', {
        server_session_create_elapsed_ms: session.session_create_elapsed_ms,
      });
      showLoadingOverlay(loadingOverlayCopy(
        active,
        'Compatibility session is ready. Starting the video player.',
        0.72
      ));
      attachCompatibilityVideo(
        session.playlist_url,
        activeItemTitle(active),
        'Playing through a local HLS compatibility session.',
        Number(session.start_time_seconds) || 0,
        syncToken
      );
      ctx.state.compatibilitySubtitleStreamIndex = normalizeSubtitleStreamIndex(session.subtitle_stream_index);
      scheduleSubtitlesAfterPlaybackReady(
        active,
        probePayload,
        Number(session.start_time_seconds) || 0,
        syncToken,
        'initial-playback'
      );
    }
    catch (_error) {
      if (syncToken !== ctx.state.playbackSyncToken) return;
      ctx.state.compatibilitySessionId = '';
      ctx.state.compatibilitySubtitleStreamIndex = null;
      ctx.state.playbackMode = 'compatibility';
      reportVideoDiagnostic({
        level: 'warn',
        message: 'Compatibility playback start failed; scheduling recovery',
      });
      scheduleCompatibilityRecovery('initial-start-failed', 0, null);
    }
  }

  function renderLibrary() {
    var root = ctx.els.libraryListEl;
    if (!root) return;
    if (ctx.state.loadingLibrary) {
      root.innerHTML = '<div class="video-empty-state">Loading current folder video library...</div>';
      return;
    }
    if (!ctx.state.libraryItems.length) {
      root.innerHTML = '<div class="video-empty-state">No folders or supported video files found in this folder.</div>';
      return;
    }
    root.innerHTML = '';
    ctx.state.libraryItems.forEach(function (item) {
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'video-library-row';
      row.setAttribute('data-video-path', item.path || '');
      row.setAttribute('data-video-type', item.type || '');
      if (item.type === 'file' && ctx.state.selectedLibraryPaths[item.path]) {
        row.classList.add('is-selected');
      }
      var icon = item.type === 'folder' ? '▸' : '▶';
      var detail = item.type === 'folder'
        ? 'Open folder'
        : [item.extension || '', item.compatibility_expected ? 'Compatibility likely' : 'Native likely']
          .filter(Boolean)
          .join(' • ');
      row.innerHTML =
        '<span class="video-row-icon" aria-hidden="true">' + icon + '</span>' +
        '<span class="video-row-main">' +
        '<span class="video-row-title">' + escapeHtml(item.display_name || '') + '</span>' +
        '<span class="video-row-detail">' + escapeHtml(detail) + '</span>' +
        '</span>' +
        '<span class="video-row-action">' + (item.type === 'folder' ? 'Open' : 'Queue') + '</span>';
      row.addEventListener('click', function () {
        if (item.type === 'folder') {
          loadLibrary(item.path || '');
          return;
        }
        toggleLibrarySelection(item.path || '');
      });
      row.addEventListener('dblclick', function () {
        if (item.type !== 'file') return;
        var result = enqueueAndPlay(ctx.state.queue, ctx.state.activeQueueIndex, item);
        ctx.state.queue = result.queue;
        ctx.state.activeQueueIndex = result.activeIndex;
        ctx.state.selectedQueueIndex = result.activeIndex;
        ctx.state.pendingAutoplay = true;
        ctx.state.transportWantsPlay = true;
        renderQueue();
      });
      root.appendChild(row);
    });
    updateLibraryButtons();
  }

  function renderQueue() {
    var root = ctx.els.queueListEl;
    if (!root) return;
    if (!ctx.state.queue.length) {
      root.innerHTML = '<div class="video-empty-state">Queue is empty.</div>';
      updateQueueButtons();
      void syncPlaybackForActiveItem();
      return;
    }
    root.innerHTML = '';
    ctx.state.queue.forEach(function (item, index) {
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'video-queue-row';
      if (index === ctx.state.selectedQueueIndex) row.classList.add('is-selected');
      if (index === ctx.state.activeQueueIndex) row.classList.add('is-active');
      row.setAttribute('data-video-queue-index', String(index));
      row.innerHTML =
        '<span class="video-row-main">' +
        '<span class="video-row-title">' + escapeHtml(item.display_name || '') + '</span>' +
        '<span class="video-row-detail">' + escapeHtml(item.path || '') + '</span>' +
        '</span>' +
        '<span class="video-row-action">' + (index === ctx.state.activeQueueIndex ? 'Now Playing' : 'Queued') + '</span>';
      row.addEventListener('click', function () {
        ctx.state.selectedQueueIndex = index;
        renderQueue();
      });
      row.addEventListener('dblclick', function () {
        ctx.state.activeQueueIndex = playQueueIndex(ctx.state.queue.length, index);
        ctx.state.selectedQueueIndex = ctx.state.activeQueueIndex;
        ctx.state.pendingAutoplay = true;
        ctx.state.transportWantsPlay = true;
        renderQueue();
      });
      root.appendChild(row);
    });
    updateQueueButtons();
    void syncPlaybackForActiveItem();
  }

  function updateLibraryButtons() {
    if (!ctx.els.libraryAddSelectedButton || !ctx.els.libraryUpButton) return;
    ctx.els.libraryAddSelectedButton.disabled = selectedLibraryItems().length === 0;
    ctx.els.libraryUpButton.disabled = !ctx.state.currentFolder;
  }

  function updateQueueButtons() {
    var hasQueue = ctx.state.queue.length > 0;
    var hasSelection = ctx.state.selectedQueueIndex >= 0 && ctx.state.selectedQueueIndex < ctx.state.queue.length;
    if (ctx.els.queuePlayButton) ctx.els.queuePlayButton.disabled = !hasSelection;
    if (ctx.els.queueRemoveButton) ctx.els.queueRemoveButton.disabled = !hasSelection;
    if (ctx.els.queueUpButton) ctx.els.queueUpButton.disabled = !hasSelection || ctx.state.selectedQueueIndex <= 0;
    if (ctx.els.queueDownButton) ctx.els.queueDownButton.disabled = !hasSelection || ctx.state.selectedQueueIndex < 0 || ctx.state.selectedQueueIndex >= ctx.state.queue.length - 1;
    if (ctx.els.queueClearButton) ctx.els.queueClearButton.disabled = !hasQueue;
  }

  function toggleLibrarySelection(path) {
    if (!path) return;
    if (ctx.state.selectedLibraryPaths[path]) delete ctx.state.selectedLibraryPaths[path];
    else ctx.state.selectedLibraryPaths[path] = true;
    renderLibrary();
  }

  function addSelectedVideos() {
    var items = selectedLibraryItems();
    if (!items.length) return;
    var result = enqueueSelected(ctx.state.queue, ctx.state.activeQueueIndex, items);
    ctx.state.queue = result.queue;
    ctx.state.activeQueueIndex = result.activeIndex;
    ctx.state.selectedQueueIndex = ctx.state.queue.length - 1;
    setStatus('Added ' + items.length + ' video' + (items.length === 1 ? '' : 's') + ' to the queue.');
    renderQueue();
  }

  function removeSelectedQueueItem() {
    var result = removeQueueIndex(ctx.state.queue, ctx.state.activeQueueIndex, ctx.state.selectedQueueIndex);
    ctx.state.queue = result.queue;
    ctx.state.activeQueueIndex = result.activeIndex;
    ctx.state.selectedQueueIndex = result.activeIndex;
    ctx.state.pendingAutoplay = false;
    ctx.state.transportWantsPlay = false;
    renderQueue();
  }

  function moveSelectedQueueItem(delta) {
    var fromIndex = ctx.state.selectedQueueIndex;
    var toIndex = fromIndex + delta;
    var result = moveQueueIndex(ctx.state.queue, ctx.state.activeQueueIndex, fromIndex, toIndex);
    ctx.state.queue = result.queue;
    ctx.state.activeQueueIndex = result.activeIndex;
    if (result.moved) ctx.state.selectedQueueIndex = toIndex;
    renderQueue();
  }

  function clearEntireQueue() {
    var result = clearQueue();
    ctx.state.queue = result.queue;
    ctx.state.activeQueueIndex = result.activeIndex;
    ctx.state.selectedQueueIndex = -1;
    ctx.state.pendingAutoplay = false;
    ctx.state.transportWantsPlay = false;
    renderQueue();
  }

  function playSelectedQueueItem() {
    ctx.state.activeQueueIndex = playQueueIndex(ctx.state.queue.length, ctx.state.selectedQueueIndex);
    if (ctx.state.activeQueueIndex >= 0) {
      ctx.state.selectedQueueIndex = ctx.state.activeQueueIndex;
      ctx.state.pendingAutoplay = true;
      ctx.state.transportWantsPlay = true;
      renderQueue();
    }
  }

  async function handleAudioTrackChange() {
    var active = activeQueueItem();
    var select = ctx.els.audioTrackSelectEl;
    if (!active || !select || select.disabled) return;
    var nextValue = select.value;
    if (!nextValue) return;
    ctx.state.selectedAudioStreamIndexByPath[active.path || ''] = Number(nextValue);
    persistAudioSelectionFromUi(active);
    ctx.state.pendingAutoplay = true;
    ctx.state.transportWantsPlay = true;
    setStatus('Restarting compatibility playback for the selected audio track.');
    await restartCompatibilityAt(currentGlobalPlaybackSeconds(), 'audio-track-change');
  }

  async function handleSubtitleTrackChange() {
    var active = activeQueueItem();
    var select = ctx.els.subtitleTrackSelectEl;
    if (!active || !select || select.disabled) return;
    var path = active.path || '';
    var nextValue = select.value;
    var probePayload = ctx.state.probeCache[path] || null;
    var previousSelectedValue = ctx.state.selectedSubtitleStreamIndexByPath[path];
    var previousSelectedStream = subtitleStreamsForPayload(probePayload).find(function (stream) {
      return typeof previousSelectedValue === 'number'
        && normalizeSubtitleStreamIndex(stream.index) === normalizeSubtitleStreamIndex(previousSelectedValue);
    }) || null;
    ctx.state.selectedSubtitleStreamIndexByPath[path] = nextValue ? Number(nextValue) : '';
    persistSubtitleSelectionFromUi(active);
    if (!nextValue) {
      if (
        compatibilitySessionHasBurnedInSubtitles()
        || (previousSelectedStream && subtitleStreamRequiresBurnIn(previousSelectedStream))
      ) {
        ctx.state.compatibilitySubtitleStreamIndex = null;
        ctx.state.pendingAutoplay = true;
        ctx.state.transportWantsPlay = true;
        setStatus('Restarting compatibility playback without subtitles.');
        await restartCompatibilityAt(currentGlobalPlaybackSeconds(), 'subtitle-track-change');
        return;
      }
      clearSubtitleTrack();
      ctx.state.compatibilitySubtitleStreamIndex = null;
      setStatus('Subtitles turned off.');
      return;
    }
    if (ctx.state.seekRestartInProgress) {
      setStatus('Subtitle track will load when playback seek completes.');
      return;
    }
    var selectedStream = selectedSubtitleStream(active, probePayload);
    if (selectedStream && subtitleStreamRequiresBurnIn(selectedStream)) {
      clearSubtitleTrack();
      ctx.state.compatibilitySubtitleStreamIndex = normalizeSubtitleStreamIndex(selectedStream.index);
      ctx.state.pendingAutoplay = true;
      ctx.state.transportWantsPlay = true;
      setStatus('Restarting compatibility playback for burned-in subtitles.');
      await restartCompatibilityAt(currentGlobalPlaybackSeconds(), 'subtitle-track-change');
      return;
    }
    if (compatibilitySessionHasBurnedInSubtitles()) {
      ctx.state.compatibilitySubtitleStreamIndex = null;
      ctx.state.pendingAutoplay = true;
      ctx.state.transportWantsPlay = true;
      setStatus('Restarting compatibility playback for sidecar subtitles.');
      await restartCompatibilityAt(currentGlobalPlaybackSeconds(), 'subtitle-track-change');
      return;
    }
    var fetchStartSeconds = Math.max(0, ctx.state.compatibilityStartSeconds || 0);
    var streamIndex = Number(nextValue);
    if (subtitlesAreMounted(active, streamIndex, fetchStartSeconds)) {
      setStatus('Subtitle track is ready.');
      return;
    }
    if (getCachedFullSubtitleVtt(active.path || '', streamIndex)
      && mountSubtitleTrackForItem(active, probePayload, streamIndex, fetchStartSeconds, {silent: true})) {
      setStatus('Subtitle track is ready.');
      return;
    }
    setStatus('Loading subtitle track.');
    await applySubtitlesForSeek(active, probePayload, fetchStartSeconds, {
      reloadReason: 'subtitle-track-change',
    });
  }

  async function loadPlaybackStatus() {
    if (ctx.state.loadingPlaybackStatus) return;
    ctx.state.loadingPlaybackStatus = true;
    try {
      var response = await fetch('/video/endpoints/status');
      if (!response.ok) throw new Error('Failed to load video playback status.');
      var payload = await response.json();
      ctx.state.playbackStatusLoaded = true;
      ctx.state.ffmpegAvailable = Boolean(payload.ffmpeg_available);
      ctx.state.ffprobeAvailable = Boolean(payload.ffprobe_available);
      ctx.state.compatibilityAvailable = Boolean(payload.compatibility_available);
      if (ctx.state.paneActive) void syncPlaybackForActiveItem();
    }
    catch (_error) {
      ctx.state.playbackStatusLoaded = true;
      ctx.state.ffmpegAvailable = false;
      ctx.state.ffprobeAvailable = false;
      ctx.state.compatibilityAvailable = false;
      if (ctx.state.paneActive) void syncPlaybackForActiveItem();
    }
    finally {
      ctx.state.loadingPlaybackStatus = false;
    }
  }

  async function loadLibrary(path) {
    updateCurrentFolder(path || '');
    ctx.state.loadingLibrary = true;
    ctx.state.selectedLibraryPaths = Object.create(null);
    renderLibrary();
    try {
      var response = await fetch('/video/endpoints/library?path=' + encodeURIComponent(ctx.state.currentFolder));
      if (!response.ok) throw new Error('Failed to load video library.');
      var payload = await response.json();
      ctx.state.libraryItems = Array.isArray(payload.items) ? payload.items : [];
      setStatus('Current folder video library is ready to load.');
    }
    catch (_error) {
      ctx.state.libraryItems = [];
      setStatus('Could not load current folder videos.');
    }
    finally {
      ctx.state.loadingLibrary = false;
      renderLibrary();
    }
  }

  function syncPaneMode(mode) {
    var active = mode === 'video-player';
    ctx.state.paneActive = active;
    pane.setAttribute('data-video-pane-active', active ? '1' : '0');
    if (!active) {
      void stopCompatibilitySession();
      resetPlaybackSurface();
      renderAudioTrackSelector(null, null);
      renderSubtitleTrackSelector(null, null);
      return;
    }
    updateCurrentFolder(currentFolderPath());
    setStatus('Current folder video library is ready to load.');
    void syncPlaybackForActiveItem();
    void loadPlaybackStatus();
    void loadLibrary(ctx.state.currentFolder);
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  pane.setAttribute('data-video-player-ready', 'subtitles');
  ctx.state.audioTrackPreferenceByLayout = loadStoredTrackPreferences('dropbox-browser-video-audio-track-preferences');
  ctx.state.subtitleTrackPreferenceByLayout = loadStoredTrackPreferences('dropbox-browser-video-subtitle-track-preferences');
  updateCurrentFolder(currentFolderPath());
  renderAudioTrackSelector(null, null);
  renderSubtitleTrackSelector(null, null);
  if (ctx.els.videoEl) {
    ctx.els.videoEl.controls = false;
    ctx.els.videoEl.removeAttribute('controls');
  }
  resetPlaybackProgress();
  void syncPlaybackForActiveItem();
  renderLibrary();
  renderQueue();

  if (ctx.els.libraryUpButton) {
    ctx.els.libraryUpButton.addEventListener('click', function () {
      void loadLibrary(parentFolderPath(ctx.state.currentFolder));
    });
  }
  if (ctx.els.libraryAddSelectedButton) {
    ctx.els.libraryAddSelectedButton.addEventListener('click', addSelectedVideos);
  }
  if (ctx.els.queuePlayButton) {
    ctx.els.queuePlayButton.addEventListener('click', playSelectedQueueItem);
  }
  if (ctx.els.queueRemoveButton) {
    ctx.els.queueRemoveButton.addEventListener('click', removeSelectedQueueItem);
  }
  if (ctx.els.queueUpButton) {
    ctx.els.queueUpButton.addEventListener('click', function () {
      moveSelectedQueueItem(-1);
    });
  }
  if (ctx.els.queueDownButton) {
    ctx.els.queueDownButton.addEventListener('click', function () {
      moveSelectedQueueItem(1);
    });
  }
  if (ctx.els.queueClearButton) {
    ctx.els.queueClearButton.addEventListener('click', clearEntireQueue);
  }
  if (ctx.els.audioTrackSelectEl) {
    ctx.els.audioTrackSelectEl.addEventListener('change', function () {
      void handleAudioTrackChange();
    });
  }
  if (ctx.els.subtitleTrackSelectEl) {
    ctx.els.subtitleTrackSelectEl.addEventListener('change', function () {
      void handleSubtitleTrackChange();
    });
  }
  if (ctx.els.playbackSurfaceEl) {
    ctx.els.playbackSurfaceEl.addEventListener('mousemove', function (event) {
      revealControlsOverlay(event);
    });
    ctx.els.playbackSurfaceEl.addEventListener('mouseenter', revealControlsOverlay);
    ctx.els.playbackSurfaceEl.addEventListener('mouseleave', hideControlsOverlay);
    ctx.els.playbackSurfaceEl.addEventListener('click', function (event) {
      if (!videoControlsAvailable()) return;
      if (event.target && event.target.closest && event.target.closest('#video-controls-overlay')) return;
      toggleVideoPlayPause();
      revealControlsOverlay();
    });
    ctx.els.playbackSurfaceEl.addEventListener('dblclick', function (event) {
      if (!videoControlsAvailable()) return;
      if (event.target && event.target.closest && event.target.closest('#video-controls-overlay')) return;
      void toggleVideoFullscreen();
      revealControlsOverlay();
    });
  }
  if (ctx.els.playbackStageEl) {
    ctx.els.playbackStageEl.addEventListener('mousemove', function (event) {
      revealControlsOverlay(event);
    });
    ctx.els.playbackStageEl.addEventListener('mouseenter', revealControlsOverlay);
  }
  if (ctx.els.controlsOverlayEl) {
    ctx.els.controlsOverlayEl.addEventListener('mousemove', function (event) {
      revealControlsOverlay(event);
    });
    ctx.els.controlsOverlayEl.addEventListener('focusin', revealControlsOverlay);
  }
  if (ctx.els.playToggleButton) {
    ctx.els.playToggleButton.addEventListener('click', function (event) {
      event.stopPropagation();
      toggleVideoPlayPause();
      revealControlsOverlay();
    });
  }
  if (ctx.els.muteToggleButton) {
    ctx.els.muteToggleButton.addEventListener('click', function (event) {
      event.stopPropagation();
      toggleVideoMute();
      revealControlsOverlay();
    });
  }
  if (ctx.els.volumeSliderEl) {
    ctx.els.volumeSliderEl.addEventListener('input', function () {
      setVideoVolumeFromSlider();
      revealControlsOverlay();
    });
    ctx.els.volumeSliderEl.addEventListener('change', function () {
      setVideoVolumeFromSlider();
      revealControlsOverlay();
    });
  }
  if (ctx.els.fullscreenButton) {
    ctx.els.fullscreenButton.addEventListener('click', function (event) {
      event.stopPropagation();
      void toggleVideoFullscreen();
      revealControlsOverlay();
    });
  }
  if (ctx.els.pipButton) {
    ctx.els.pipButton.addEventListener('click', function (event) {
      event.stopPropagation();
      void togglePictureInPicture();
      revealControlsOverlay();
    });
  }
  if (ctx.els.progressSliderEl) {
    ctx.els.progressSliderEl.addEventListener('input', function () {
      ctx.state.progressSliderActive = true;
      ctx.state.controlsScrubReveal = true;
      syncPlaybackProgress();
      revealControlsOverlay();
    });
    ctx.els.progressSliderEl.addEventListener('change', function () {
      if (!ctx.els.videoEl || ctx.els.progressSliderEl.disabled) {
        ctx.state.progressSliderActive = false;
        return;
      }
      var nextTime = Number(ctx.els.progressSliderEl.value);
      if (Number.isFinite(nextTime) && nextTime >= 0) {
        ctx.state.progressSliderActive = false;
        ctx.state.controlsScrubReveal = true;
        revealControlsOverlay();
        void restartCompatibilityAt(nextTime, 'scrub');
        return;
      }
      ctx.state.progressSliderActive = false;
      syncPlaybackProgress();
    });
  }
  if (ctx.els.videoEl) {
    ctx.els.videoEl.addEventListener('loadedmetadata', syncPlaybackProgress);
    ctx.els.videoEl.addEventListener('loadeddata', function () {
      if (ctx.state.playbackMode !== 'compatibility') return;
      if (compatibilityBufferedSecondsAhead() >= 6) {
        maybeRevealCompatibilityPlayback(activeItemTitle(activeQueueItem()), ctx.state.playbackSyncToken, 'media-loadeddata');
      }
    });
    ctx.els.videoEl.addEventListener('canplay', function () {
      if (ctx.state.playbackMode !== 'compatibility') return;
      if (compatibilityBufferedSecondsAhead() >= 6) {
        maybeRevealCompatibilityPlayback(activeItemTitle(activeQueueItem()), ctx.state.playbackSyncToken, 'media-canplay');
      }
    });
    ctx.els.videoEl.addEventListener('durationchange', syncPlaybackProgress);
    ctx.els.videoEl.addEventListener('timeupdate', function () {
      syncPlaybackProgress();
      syncSubtitleOverlayDisplay();
      syncSubtitleDebugDisplay();
    });
    ctx.els.videoEl.addEventListener('play', function () {
      ctx.state.transportWantsPlay = true;
      ctx.state.pendingAutoplay = false;
      syncTransportControls();
    });
    ctx.els.videoEl.addEventListener('pause', function () {
      if (!ctx.state.seekRestartInProgress) {
        ctx.state.pendingAutoplay = false;
        ctx.state.transportWantsPlay = false;
      }
      syncTransportControls();
    });
    ctx.els.videoEl.addEventListener('volumechange', syncTransportControls);
    document.addEventListener('fullscreenchange', syncTransportControls);
    ctx.els.videoEl.addEventListener('enterpictureinpicture', syncTransportControls);
    ctx.els.videoEl.addEventListener('leavepictureinpicture', syncTransportControls);
    ctx.els.videoEl.addEventListener('waiting', function () {
      if (ctx.state.playbackMode !== 'compatibility') return;
      reportVideoDiagnostic({level: 'debug', message: 'Video element waiting'});
      if (!playbackShouldBeRunning() || ctx.state.seekRestartInProgress) return;
      var active = activeQueueItem();
      showLoadingOverlay({
        title: activeItemTitle(active),
        meta: 'Buffering compatibility playback.',
        progress: 0.96,
      });
    });
    ctx.els.videoEl.addEventListener('stalled', function () {
      if (ctx.state.playbackMode !== 'compatibility') return;
      reportVideoDiagnostic({level: 'warn', message: 'Video element stalled'});
    });
    ctx.els.videoEl.addEventListener('seeking', function () {
      if (ctx.state.playbackMode === 'compatibility') {
        reportVideoDiagnostic({
          level: 'debug',
          message: 'Video element seeking',
          requested_time: ctx.state.requestedSeekSeconds,
          actual_global_time: currentGlobalPlaybackSeconds(),
          source_start_seconds: ctx.state.compatibilityStartSeconds,
          media_seekable: mediaRangesSummary(ctx.els.videoEl.seekable),
          media_buffered: mediaRangesSummary(ctx.els.videoEl.buffered),
        });
      }
      syncPlaybackProgress();
    });
    ctx.els.videoEl.addEventListener('seeked', function () {
      if (ctx.state.playbackMode === 'compatibility') {
        var requestedTime = ctx.state.requestedSeekSeconds;
        var actualTime = currentGlobalPlaybackSeconds();
        reportVideoDiagnostic({
          level: 'debug',
          message: 'Video element seeked',
          requested_time: requestedTime,
          actual_global_time: actualTime,
          seek_delta: Number.isFinite(Number(requestedTime)) ? actualTime - Number(requestedTime) : '',
          source_start_seconds: ctx.state.compatibilityStartSeconds,
          media_seekable: mediaRangesSummary(ctx.els.videoEl.seekable),
          media_buffered: mediaRangesSummary(ctx.els.videoEl.buffered),
        });
      }
      ctx.state.progressSliderActive = false;
      syncPlaybackProgress();
    });
    ctx.els.videoEl.addEventListener('emptied', resetPlaybackProgress);
    ctx.els.videoEl.addEventListener('playing', function () {
      ctx.state.transportWantsPlay = true;
      ctx.state.pendingAutoplay = false;
      resetCompatibilityRecoveryState();
      hideLoadingOverlay();
      syncTransportControls();
      syncPlaybackProgress();
      if (ctx.state.playbackMode === 'compatibility') {
        reportPlaybackTiming('playing');
        emitPlaybackTimingSummary({
          buffered_seconds_ahead: compatibilityBufferedSecondsAhead(),
        });
        reportVideoDiagnostic({
          level: 'info',
          message: 'Compatibility playback playing',
        });
        setStatus('Playing remote video through HLS compatibility playback.');
        return;
      }
    });
    ctx.els.videoEl.addEventListener('ended', function () {
      ctx.state.transportWantsPlay = false;
      ctx.state.pendingAutoplay = false;
      syncTransportControls();
      var event = new CustomEvent('video-playback-ended');
      pane.dispatchEvent(event);
    });
    ctx.els.videoEl.addEventListener('error', function () {
      var active = activeQueueItem();
      if (!active) return;
      if (ctx.state.playbackMode === 'compatibility') {
        reportVideoDiagnostic({
          level: 'error',
          message: 'Video element error during compatibility playback',
          media_error_code: ctx.els.videoEl.error ? ctx.els.videoEl.error.code : '',
          media_error_message: ctx.els.videoEl.error ? ctx.els.videoEl.error.message : '',
        });
        scheduleCompatibilityRecovery('media-element-error', currentGlobalPlaybackSeconds(), null);
        return;
      }
      clearVideoSource();
      showPlaybackPlaceholder(activeItemTitle(active), 'Video playback failed.');
      setStatus('Video playback failed.');
    });
  }

  window.addEventListener('bottom-pane-mode-changed', function (ev) {
    if (!ev.detail) return;
    syncPaneMode(ev.detail.mode);
  });

  window.addEventListener('browse-folder-changed', function (ev) {
    var detail = ev && ev.detail ? ev.detail : {};
    var nextPath = typeof detail.path === 'string' ? detail.path : currentFolderPath();
    updateCurrentFolder(nextPath);
    if (ctx.state.paneActive) void loadLibrary(nextPath);
  });

  window.addEventListener('beforeunload', function () {
    clearCompatibilityRecoveryTimer();
    void stopCompatibilitySession();
  });

  pane.addEventListener('video-playback-ended', function () {
    ctx.state.activeQueueIndex = advanceQueueAfterPlaybackEnd(ctx.state.queue.length, ctx.state.activeQueueIndex);
    if (ctx.state.activeQueueIndex >= 0) {
      ctx.state.selectedQueueIndex = ctx.state.activeQueueIndex;
      ctx.state.pendingAutoplay = true;
      ctx.state.transportWantsPlay = true;
    }
    renderQueue();
  });

  syncPaneMode(Settings.get('bottom-pane-mode', 'server-log'));
}());
