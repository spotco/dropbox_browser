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
  var ctx = {
    pane: pane,
    els: {
      pathEl: document.getElementById('video-library-path'),
      statusEl: document.getElementById('video-player-status'),
      titleEl: document.getElementById('video-current-title'),
      metaEl: document.getElementById('video-current-meta'),
      placeholderEl: document.getElementById('video-playback-placeholder'),
      playbackSurfaceEl: document.getElementById('video-playback-surface'),
      controlsOverlayEl: document.getElementById('video-controls-overlay'),
      videoEl: document.getElementById('video-player-media'),
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
      compatibilitySessionId: '',
      hlsController: null,
      compatibilityNetworkRecoveries: 0,
      compatibilityMediaRecoveries: 0,
      compatibilityStartSeconds: 0,
      requestedSeekSeconds: null,
      seekRestartInProgress: false,
      playbackSyncToken: 0,
      probeCache: Object.create(null),
      probeFailures: Object.create(null),
      selectedAudioStreamIndexByPath: Object.create(null),
      selectedSubtitleStreamIndexByPath: Object.create(null),
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
  }

  function scheduleControlsIdleHide() {
    clearControlsIdleTimer();
    if (!ctx.els.videoEl || ctx.els.videoEl.paused || !videoControlsAvailable()) {
      setControlsOverlayIdle(false);
      return;
    }
    ctx.state.controlsIdleTimer = window.setTimeout(function () {
      ctx.state.controlsIdleTimer = 0;
      setControlsOverlayIdle(true);
    }, CONTROLS_IDLE_HIDE_MS);
  }

  function revealControlsOverlay() {
    if (!videoControlsAvailable()) return;
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

  function hideVideoElement() {
    if (!ctx.els.videoEl) return;
    ctx.els.videoEl.hidden = true;
    ctx.els.videoEl.classList.add('hidden');
  }

  function showVideoElement() {
    if (!ctx.els.videoEl) return;
    ctx.els.videoEl.hidden = false;
    ctx.els.videoEl.classList.remove('hidden');
  }

  function showPlaceholderElement() {
    if (!ctx.els.placeholderEl) return;
    ctx.els.placeholderEl.hidden = false;
    ctx.els.placeholderEl.classList.remove('hidden');
  }

  function hidePlaceholderElement() {
    if (!ctx.els.placeholderEl) return;
    ctx.els.placeholderEl.hidden = true;
    ctx.els.placeholderEl.classList.add('hidden');
  }

  function destroyHlsController() {
    if (ctx.state.hlsController && typeof ctx.state.hlsController.destroy === 'function') {
      ctx.state.hlsController.destroy();
    }
    ctx.state.hlsController = null;
  }

  function resetCompatibilityRecoveryState() {
    ctx.state.compatibilityNetworkRecoveries = 0;
    ctx.state.compatibilityMediaRecoveries = 0;
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
    hideControlsOverlay();
  }

  function videoControlsAvailable() {
    if (!ctx.els.videoEl) return false;
    var active = activeQueueItem();
    return Boolean(active && ctx.state.playbackMode === 'compatibility' && !ctx.els.videoEl.hidden);
  }

  function syncTransportControls() {
    if (!ctx.els.videoEl) return;
    var canControl = videoControlsAvailable();
    if (canControl) showControlsOverlay();
    else hideControlsOverlay();
    if (ctx.els.playToggleButton) {
      var isPaused = ctx.els.videoEl.paused;
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
      var isFullscreen = document.fullscreenElement === ctx.els.videoEl;
      ctx.els.fullscreenButton.disabled = !canControl || typeof ctx.els.videoEl.requestFullscreen !== 'function';
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
    if (canControl && !ctx.els.videoEl.paused) scheduleControlsIdleHide();
    else setControlsOverlayIdle(false);
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
    resetPlaybackProgress();
  }

  function resetPlaybackSurface() {
    if (!ctx.els.videoEl) return;
    hideVideoElement();
    destroyHlsController();
    clearSubtitleTrack();
    resetCompatibilityRecoveryState();
    var video = ctx.els.videoEl;
    video.controls = false;
    video.removeAttribute('controls');
    try {
      video.pause();
    }
    catch (_pauseError) {
      // Best-effort pause before resetting media element state.
    }
    video.removeAttribute('src');
    try {
      video.load();
    }
    catch (_loadError) {
      // Best-effort load to flush native text-track rendering on MSE/HLS playback.
    }
    ctx.state.lastPlaybackPath = '';
    ctx.state.compatibilityStartSeconds = 0;
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

  function clearSubtitleTrack() {
    if (ctx.els.videoEl) {
      Array.from(ctx.els.videoEl.querySelectorAll('track')).forEach(function (node) {
        node.remove();
      });
      if (ctx.els.videoEl.textTracks) {
        for (var index = 0; index < ctx.els.videoEl.textTracks.length; index += 1) {
          ctx.els.videoEl.textTracks[index].mode = 'disabled';
        }
      }
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
    if (!item || !select || select.disabled || !select.value) return;
    var path = item.path || '';
    if (!path) return;
    ctx.state.selectedSubtitleStreamIndexByPath[path] = Number(select.value);
  }

  function resolvedSubtitleStreamIndex(item, probePayload) {
    if (!item || !probePayload) return '';
    return selectedSubtitleStreamIndex(item, probePayload);
  }

  function subtitlesEnabledForItem(item, probePayload) {
    if (!item || !probePayload) return false;
    return resolvedSubtitleStreamIndex(item, probePayload) !== '';
  }

  function subtitlesAlreadyActive() {
    if (ctx.state.subtitleDebug.trackLabel) return true;
    var textTrack = managedSubtitleTextTrack();
    return Boolean(textTrack && textTrack.mode === 'showing');
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
    return Boolean(textTrack && textTrack.mode === 'showing');
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

  function requestVideoPlay() {
    if (!ctx.els.videoEl || typeof ctx.els.videoEl.play !== 'function') {
      ctx.state.pendingAutoplay = false;
      return;
    }
    ctx.state.pendingAutoplay = false;
    var playPromise = ctx.els.videoEl.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(function () {
        setStatus('Playback is ready. Press play if the browser blocked autoplay.');
        syncTransportControls();
      });
    }
    syncTransportControls();
  }

  function toggleVideoPlayPause() {
    if (!ctx.els.videoEl || ctx.els.videoEl.hidden) return;
    if (ctx.els.videoEl.paused) {
      requestVideoPlay();
      return;
    }
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
    if (!ctx.els.videoEl || !videoControlsAvailable()) return;
    try {
      if (document.fullscreenElement === ctx.els.videoEl && typeof document.exitFullscreen === 'function') {
        await document.exitFullscreen();
        return;
      }
      if (typeof ctx.els.videoEl.requestFullscreen === 'function') {
        await ctx.els.videoEl.requestFullscreen();
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

  function attachCompatibilityVideo(playlistUrl, title, meta, startSeconds) {
    if (!ctx.els.videoEl) return;
    clearVideoSource();
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
      });
      ctx.state.hlsController.on(Hls.Events.MANIFEST_LOADING, function (_eventName, data) {
        reportVideoDiagnostic({
          level: 'debug',
          message: 'HLS manifest loading',
          hls_url: data && data.url ? data.url : '',
        });
      });
      ctx.state.hlsController.on(Hls.Events.MANIFEST_LOADED, function (_eventName, data) {
        reportVideoDiagnostic({
          level: 'debug',
          message: 'HLS manifest loaded',
          hls_level_count: data && Array.isArray(data.levels) ? data.levels.length : '',
        });
      });
      ctx.state.hlsController.on(Hls.Events.MANIFEST_PARSED, function () {
        if (ctx.state.playbackMode !== 'compatibility') return;
        reportVideoDiagnostic({
          level: 'debug',
          message: 'HLS manifest parsed',
          hls_start_position: 0,
          hls_live_sync_mode: 'file-start',
          source_start_seconds: ctx.state.compatibilityStartSeconds,
        });
        if (ctx.state.hlsController && typeof ctx.state.hlsController.startLoad === 'function') {
          ctx.state.hlsController.startLoad(0);
        }
        setStatus('Compatibility playback session is ready.');
        if (ctx.state.compatibilityStartSeconds > 0) {
          setStatus('Compatibility playback session is ready at ' + formatPlaybackTime(ctx.state.compatibilityStartSeconds) + '.');
        }
        if (ctx.state.pendingAutoplay) requestVideoPlay();
        ensureSubtitlesAfterPlaybackReady('hls-manifest-parsed');
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
      });
      ctx.state.hlsController.on(Hls.Events.FRAG_BUFFERED, function (_eventName, data) {
        reportVideoDiagnostic({
          level: 'debug',
          message: 'HLS fragment buffered',
          frag_sn: data && data.frag ? data.frag.sn : '',
          frag_url: data && data.frag ? data.frag.url : '',
        });
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
        if (!data || !data.fatal) return;
        var active = activeQueueItem();
        if (!active) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && ctx.state.compatibilityNetworkRecoveries < 2) {
          ctx.state.compatibilityNetworkRecoveries += 1;
          setStatus('Compatibility playback hit a network error; retrying the stream.');
          ctx.state.hlsController.startLoad();
          resyncSubtitleTrackAfterHlsRecovery('network-error', data);
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && ctx.state.compatibilityMediaRecoveries < 2) {
          ctx.state.compatibilityMediaRecoveries += 1;
          setStatus('Compatibility playback hit a media error; attempting recovery.');
          ctx.state.hlsController.recoverMediaError();
          resyncSubtitleTrackAfterHlsRecovery('media-error', data);
          return;
        }
        failCompatibilityPlayback(active, 'Compatibility playback failed for this file.', 'Compatibility playback failed.');
      });
      ctx.state.hlsController.attachMedia(ctx.els.videoEl);
      ctx.state.hlsController.loadSource(playlistUrl);
      setStatus('Compatibility playback session is loading.');
    }
    else if (ctx.els.videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      setStatus('Compatibility playback session is loading.');
      ctx.els.videoEl.src = playlistUrl;
      ctx.els.videoEl.load();
      ctx.els.videoEl.addEventListener('loadedmetadata', function onLoadedMetadata() {
        ctx.els.videoEl.removeEventListener('loadedmetadata', onLoadedMetadata);
        if (ctx.state.playbackMode !== 'compatibility') return;
        setStatus('Compatibility playback session is ready.');
        if (ctx.state.compatibilityStartSeconds > 0) {
          setStatus('Compatibility playback session is ready at ' + formatPlaybackTime(ctx.state.compatibilityStartSeconds) + '.');
        }
        if (ctx.state.pendingAutoplay) requestVideoPlay();
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
    parts.push('Stream ' + String(stream.index));
    return parts.join(' • ');
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
    if (!audioStreams.length) return null;
    var saved = ctx.state.selectedAudioStreamIndexByPath[path];
    if (typeof saved === 'number' && audioStreams.some(function (stream) { return stream.index === saved; })) {
      return saved;
    }
    var probeDefault = probePayload.default_audio_stream_index;
    if (typeof probeDefault === 'number' && audioStreams.some(function (stream) { return stream.index === probeDefault; })) {
      ctx.state.selectedAudioStreamIndexByPath[path] = probeDefault;
      return probeDefault;
    }
    var fallback = audioStreams[0].index;
    ctx.state.selectedAudioStreamIndexByPath[path] = fallback;
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
    var subtitleStreams = webvttCompatibleSubtitleStreams(probePayload);
    if (!subtitleStreams.length) return '';
    var saved = ctx.state.selectedSubtitleStreamIndexByPath[path];
    if (saved === '') return '';
    if (typeof saved === 'number' && subtitleStreams.some(function (stream) { return stream.index === saved; })) {
      return saved;
    }
    if (probePayload.subtitle_off_default && saved === undefined) {
      return '';
    }
    var probeDefault = probePayload.default_subtitle_stream_index;
    if (typeof probeDefault === 'number' && subtitleStreams.some(function (stream) { return stream.index === probeDefault; })) {
      ctx.state.selectedSubtitleStreamIndexByPath[path] = probeDefault;
      return probeDefault;
    }
    ctx.state.selectedSubtitleStreamIndexByPath[path] = '';
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
      option.disabled = !subtitleStreamSupportsWebVtt(stream);
      if (selected === stream.index) option.selected = true;
      select.appendChild(option);
    });
    select.disabled = false;
  }

  async function loadProbeMetadata(item) {
    if (!item || !item.path) return null;
    var path = item.path;
    if (ctx.state.probeCache[path]) return ctx.state.probeCache[path];
    if (ctx.state.probeFailures[path]) return null;
    try {
      var response = await fetch('/video/endpoints/probe?path=' + encodeURIComponent(path) + '&source=remote');
      if (!response.ok) throw new Error('Failed to probe video metadata.');
      var payload = await response.json();
      ctx.state.probeCache[path] = payload;
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
        candidate.mode = candidate === textTrack ? 'showing' : 'disabled';
      }
      bindSubtitleTextTrackEvents(textTrack);
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

  async function createCompatibilitySession(item, audioStreamIndex, startSeconds) {
    var body = 'path=' + encodeURIComponent(item.path || '')
      + '&source=remote'
      + '&start_time_seconds=' + encodeURIComponent(String(Math.max(0, Number(startSeconds) || 0)));
    if (typeof audioStreamIndex === 'number') {
      body += '&audio_stream_index=' + encodeURIComponent(String(audioStreamIndex));
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
    var syncToken = ++ctx.state.playbackSyncToken;
    var probePayload = ctx.state.probeCache[active.path || ''] || await ensureAudioTracksForItem(active);
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
    var wasPlaying = ctx.els.videoEl ? !ctx.els.videoEl.paused : false;
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
      ctx.state.seekRestartInProgress = false;
      setStatus('Could not inspect video tracks.');
      return;
    }
    var audioStreamIndex = selectedAudioStreamIndex(active, probePayload);
    var subtitleWarmPromise = preloadAllSubtitleVttsForItem(active, probePayload);
    try {
      var session = await createCompatibilitySession(active, audioStreamIndex, clampedTarget);
      if (syncToken !== ctx.state.playbackSyncToken) {
        await stopCompatibilitySession();
        return;
      }
      ctx.state.compatibilitySessionId = session.session_id || '';
      ctx.state.seekRestartInProgress = false;
      ctx.state.requestedSeekSeconds = null;
      attachCompatibilityVideo(
        session.playlist_url,
        activeItemTitle(active),
        'Playing through a local HLS compatibility session from ' + formatPlaybackTime(Number(session.start_time_seconds) || 0) + '.',
        Number(session.start_time_seconds) || clampedTarget
      );
      reportVideoDiagnostic({
        level: 'info',
        message: 'Compatibility seek restart ready',
        seek_reason: reason || '',
        requested_time: clampedTarget,
        source_start_seconds: Number(session.start_time_seconds) || clampedTarget,
        session_id: session.session_id || '',
      });
      await subtitleWarmPromise;
      if (syncToken !== ctx.state.playbackSyncToken) return;
      await applySubtitlesForSeek(active, probePayload, Number(session.start_time_seconds) || clampedTarget, {
        reloadReason: reason || 'restart',
        playbackSyncToken: syncToken,
      });
    }
    catch (_error) {
      if (syncToken !== ctx.state.playbackSyncToken) return;
      ctx.state.compatibilitySessionId = '';
      ctx.state.seekRestartInProgress = false;
      ctx.state.requestedSeekSeconds = null;
      ctx.state.playbackMode = 'compatibility-error';
      setStatus('Could not start compatibility playback at ' + formatPlaybackTime(clampedTarget) + '.');
      reportVideoDiagnostic({
        level: 'error',
        message: 'Compatibility seek restart failed',
        seek_reason: reason || '',
        requested_time: clampedTarget,
      });
    }
  }

  async function syncPlaybackForActiveItem() {
    var active = activeQueueItem();
    var syncToken = ++ctx.state.playbackSyncToken;
    if (!active) {
      ctx.state.playbackMode = 'none';
      ctx.state.pendingAutoplay = false;
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
      setStatus('Loading video playback capabilities.');
      return;
    }

    resetPlaybackSurface();
    resetSubtitlesForActiveItemChange(active);
    showPlaybackPlaceholder(activeItemTitle(active), '');

    if (!ctx.state.compatibilityAvailable) {
      ctx.state.pendingAutoplay = false;
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
    setStatus(compatibilityNeededStatus());
    var probePayload = await ensureAudioTracksForItem(active);
    renderSubtitleTrackSelector(active, probePayload);
    var subtitleWarmPromise = preloadAllSubtitleVttsForItem(active, probePayload);
    if (syncToken !== ctx.state.playbackSyncToken) return;
    if (!probePayload) {
      ctx.state.pendingAutoplay = false;
      ctx.state.playbackMode = 'compatibility-error';
      showPlaybackPlaceholder(activeItemTitle(active), 'Could not inspect video tracks for compatibility playback.');
      setStatus('Could not inspect video tracks.');
      resetPlaybackProgress();
      return;
    }
    var audioStreamIndex = selectedAudioStreamIndex(active, probePayload);
    try {
      var session = await createCompatibilitySession(active, audioStreamIndex, 0);
      if (syncToken !== ctx.state.playbackSyncToken) {
        await stopCompatibilitySession();
        return;
      }
      ctx.state.compatibilitySessionId = session.session_id || '';
      attachCompatibilityVideo(
        session.playlist_url,
        activeItemTitle(active),
        'Playing through a local HLS compatibility session.',
        Number(session.start_time_seconds) || 0
      );
      await subtitleWarmPromise;
      if (syncToken !== ctx.state.playbackSyncToken) return;
      await applySubtitlesForSeek(active, probePayload, Number(session.start_time_seconds) || 0, {
        playbackSyncToken: syncToken,
        reloadReason: 'initial-playback',
      });
    }
    catch (_error) {
      if (syncToken !== ctx.state.playbackSyncToken) return;
      ctx.state.compatibilitySessionId = '';
      ctx.state.playbackMode = 'compatibility-error';
      showPlaybackPlaceholder(
        activeItemTitle(active),
        'Compatibility playback could not be started for this file.'
      );
      setStatus('Could not start compatibility playback.');
      resetPlaybackProgress();
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
    renderQueue();
  }

  function playSelectedQueueItem() {
    ctx.state.activeQueueIndex = playQueueIndex(ctx.state.queue.length, ctx.state.selectedQueueIndex);
    if (ctx.state.activeQueueIndex >= 0) {
      ctx.state.selectedQueueIndex = ctx.state.activeQueueIndex;
      ctx.state.pendingAutoplay = true;
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
    ctx.state.pendingAutoplay = true;
    setStatus('Restarting compatibility playback for the selected audio track.');
    await restartCompatibilityAt(currentGlobalPlaybackSeconds(), 'audio-track-change');
  }

  async function handleSubtitleTrackChange() {
    var active = activeQueueItem();
    var select = ctx.els.subtitleTrackSelectEl;
    if (!active || !select || select.disabled) return;
    var nextValue = select.value;
    ctx.state.selectedSubtitleStreamIndexByPath[active.path || ''] = nextValue ? Number(nextValue) : '';
    if (!nextValue) {
      clearSubtitleTrack();
      setStatus('Subtitles turned off.');
      return;
    }
    if (ctx.state.seekRestartInProgress) {
      setStatus('Subtitle track will load when playback seek completes.');
      return;
    }
    var probePayload = ctx.state.probeCache[active.path || ''] || null;
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
    ctx.els.playbackSurfaceEl.addEventListener('mousemove', revealControlsOverlay);
    ctx.els.playbackSurfaceEl.addEventListener('mouseenter', revealControlsOverlay);
    ctx.els.playbackSurfaceEl.addEventListener('mouseleave', function () {
      clearControlsIdleTimer();
      if (ctx.els.videoEl && !ctx.els.videoEl.paused && videoControlsAvailable()) {
        setControlsOverlayIdle(true);
      }
    });
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
  if (ctx.els.controlsOverlayEl) {
    ctx.els.controlsOverlayEl.addEventListener('mousemove', revealControlsOverlay);
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
        void restartCompatibilityAt(nextTime, 'scrub');
        return;
      }
      ctx.state.progressSliderActive = false;
      syncPlaybackProgress();
    });
  }
  if (ctx.els.videoEl) {
    ctx.els.videoEl.addEventListener('loadedmetadata', syncPlaybackProgress);
    ctx.els.videoEl.addEventListener('durationchange', syncPlaybackProgress);
    ctx.els.videoEl.addEventListener('timeupdate', function () {
      syncPlaybackProgress();
      syncSubtitleDebugDisplay();
    });
    ctx.els.videoEl.addEventListener('play', syncTransportControls);
    ctx.els.videoEl.addEventListener('pause', syncTransportControls);
    ctx.els.videoEl.addEventListener('volumechange', syncTransportControls);
    document.addEventListener('fullscreenchange', syncTransportControls);
    ctx.els.videoEl.addEventListener('enterpictureinpicture', syncTransportControls);
    ctx.els.videoEl.addEventListener('leavepictureinpicture', syncTransportControls);
    ctx.els.videoEl.addEventListener('waiting', function () {
      if (ctx.state.playbackMode !== 'compatibility') return;
      reportVideoDiagnostic({level: 'debug', message: 'Video element waiting'});
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
      resetCompatibilityRecoveryState();
      syncTransportControls();
      syncPlaybackProgress();
      if (ctx.state.playbackMode === 'compatibility') {
        reportVideoDiagnostic({
          level: 'info',
          message: 'Compatibility playback playing',
        });
        setStatus('Playing remote video through HLS compatibility playback.');
        return;
      }
    });
    ctx.els.videoEl.addEventListener('ended', function () {
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
        if (ctx.state.hlsController) return;
        failCompatibilityPlayback(active, 'Compatibility playback failed for this file.', 'Compatibility playback failed.');
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
    void stopCompatibilitySession();
  });

  pane.addEventListener('video-playback-ended', function () {
    ctx.state.activeQueueIndex = advanceQueueAfterPlaybackEnd(ctx.state.queue.length, ctx.state.activeQueueIndex);
    if (ctx.state.activeQueueIndex >= 0) {
      ctx.state.selectedQueueIndex = ctx.state.activeQueueIndex;
      ctx.state.pendingAutoplay = true;
    }
    renderQueue();
  });

  syncPaneMode(Settings.get('bottom-pane-mode', 'server-log'));
}());
