import {
  clampCompatibilityRestartTargetSeconds,
  nextQueueIndex,
  playbackDurationSeconds,
  previousQueueIndex,
} from '../video-core.js';
import {
  CONTROLS_IDLE_HIDE_MS,
  VIDEO_ICONS,
} from './constants.js';

export function initControls(ctx) {
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

function resetPlaybackProgress() {
  if (ctx.els.playToggleButton) {
    ctx.setControlButtonState(ctx.els.playToggleButton, 'Play', VIDEO_ICONS.play);
    ctx.els.playToggleButton.disabled = true;
  }
  if (ctx.els.muteToggleButton) {
    ctx.setControlButtonState(ctx.els.muteToggleButton, 'Mute', VIDEO_ICONS.volume);
    ctx.els.muteToggleButton.disabled = true;
  }
  if (ctx.els.volumeSliderEl) {
    ctx.els.volumeSliderEl.disabled = true;
  }
  if (ctx.els.fullscreenButton) {
    ctx.setControlButtonState(ctx.els.fullscreenButton, 'Fullscreen', VIDEO_ICONS.fullscreen);
    ctx.els.fullscreenButton.disabled = true;
  }
  if (ctx.els.pipButton) {
    ctx.setControlButtonState(ctx.els.pipButton, 'Picture in picture', VIDEO_ICONS.pipEnter);
    ctx.els.pipButton.disabled = true;
  }
  syncLoopQueueButton();
  syncQueueNavigationButtons(false);
  syncSeekStepButtons(false, 0);
  if (ctx.els.progressSliderEl) {
    ctx.els.progressSliderEl.min = '0';
    ctx.els.progressSliderEl.max = '0';
    ctx.els.progressSliderEl.value = '0';
    ctx.els.progressSliderEl.disabled = true;
  }
  ctx.resetProcessedProgressTrack();
  if (ctx.els.elapsedTimeEl) ctx.els.elapsedTimeEl.textContent = '0:00';
  if (ctx.els.totalTimeEl) ctx.els.totalTimeEl.textContent = '0:00';
  ctx.state.progressSliderActive = false;
  if (!ctx.state.loadingOverlayVisible && !ctx.state.seekRestartInProgress && !ctx.state.controlsScrubReveal) {
    hideControlsOverlay();
  }
}

function videoControlsAvailable() {
  if (!ctx.els.videoEl) return false;
  var active = ctx.activeQueueItem();
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
  var duration = currentPlaybackDurationSeconds();
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
    ctx.setControlButtonState(
      ctx.els.playToggleButton,
      isPaused ? 'Play' : 'Pause',
      isPaused ? VIDEO_ICONS.play : VIDEO_ICONS.pause
    );
  }
  if (ctx.els.muteToggleButton) {
    var isMuted = ctx.els.videoEl.muted || ctx.els.videoEl.volume === 0;
    var volumeLevel = ctx.els.videoEl.muted ? 0 : ctx.els.videoEl.volume;
    ctx.els.muteToggleButton.disabled = !canControl;
    ctx.setControlButtonState(
      ctx.els.muteToggleButton,
      isMuted ? 'Unmute' : 'Mute',
      ctx.volumeIconForLevel(volumeLevel, isMuted)
    );
  }
  if (ctx.els.volumeSliderEl) {
    ctx.els.volumeSliderEl.disabled = !canControl;
    ctx.els.volumeSliderEl.value = String(ctx.els.videoEl.muted ? 0 : ctx.els.videoEl.volume);
  }
  if (ctx.els.fullscreenButton) {
    var fullscreenHost = ctx.fullscreenHostElement();
    var isFullscreen = document.fullscreenElement === fullscreenHost;
    ctx.els.fullscreenButton.disabled = !canControl || !fullscreenHost || typeof fullscreenHost.requestFullscreen !== 'function';
    ctx.setControlButtonState(
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
    ctx.setControlButtonState(
      ctx.els.pipButton,
      isPipActive ? 'Exit picture in picture' : 'Picture in picture',
      isPipActive ? VIDEO_ICONS.pipExit : VIDEO_ICONS.pipEnter
    );
  }
  syncLoopQueueButton();
  syncQueueNavigationButtons(canControl);
  syncSeekStepButtons(canControl, duration);
}

function syncLoopQueueButton() {
  if (!ctx.els.loopButton) return;
  var enabled = Boolean(ctx.state.loopQueue);
  ctx.els.loopButton.disabled = false;
  ctx.els.loopButton.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  ctx.els.loopButton.classList.toggle('is-active', enabled);
  ctx.setControlButtonState(
    ctx.els.loopButton,
    enabled ? 'Loop queue on' : 'Loop queue',
    VIDEO_ICONS.loop
  );
}

function restoreVideoLoopQueue() {
  var key = ctx.state.loopQueueSettingKey || 'video-loop-queue';
  var stored = typeof ctx.readVideoSetting === 'function'
    ? ctx.readVideoSetting(key, false)
    : false;
  ctx.state.loopQueue = Boolean(stored);
  syncLoopQueueButton();
}

function persistVideoLoopQueue() {
  var key = ctx.state.loopQueueSettingKey || 'video-loop-queue';
  if (typeof ctx.writeVideoSetting === 'function') {
    ctx.writeVideoSetting(key, Boolean(ctx.state.loopQueue));
  }
}

function toggleVideoLoopQueue() {
  ctx.state.loopQueue = !ctx.state.loopQueue;
  persistVideoLoopQueue();
  syncLoopQueueButton();
  syncTransportControls();
}

function currentPlaybackDurationSeconds() {
  var active = ctx.activeQueueItem();
  var probePayload = active ? ctx.state.probeCache[active.path || ''] || null : null;
  return playbackDurationSeconds(
    ctx.els.videoEl ? Number(ctx.els.videoEl.duration) : NaN,
    probePayload,
    ctx.state.playbackMode
  );
}

function syncQueueNavigationButtons(canControl) {
  var queueLength = ctx.state.queue.length;
  var activeIndex = ctx.state.activeQueueIndex;
  if (ctx.els.previousButton) {
    ctx.els.previousButton.disabled = !canControl || previousQueueIndex(queueLength, activeIndex, ctx.state.loopQueue) < 0;
    ctx.setControlButtonState(ctx.els.previousButton, 'Previous video', VIDEO_ICONS.previous);
  }
  if (ctx.els.nextButton) {
    ctx.els.nextButton.disabled = !canControl || nextQueueIndex(queueLength, activeIndex, ctx.state.loopQueue) < 0;
    ctx.setControlButtonState(ctx.els.nextButton, 'Next video', VIDEO_ICONS.next);
  }
}

function syncSeekStepButtons(canControl, duration) {
  var canSeek = canControl && Number.isFinite(Number(duration)) && Number(duration) > 0;
  if (ctx.els.back15Button) {
    ctx.els.back15Button.disabled = !canSeek;
    ctx.setControlButtonState(ctx.els.back15Button, 'Back 15 seconds', VIDEO_ICONS.back15);
  }
  if (ctx.els.forward15Button) {
    ctx.els.forward15Button.disabled = !canSeek;
    ctx.setControlButtonState(ctx.els.forward15Button, 'Forward 15 seconds', VIDEO_ICONS.forward15);
  }
}

function playQueueIndexFromControls(index) {
  if (index < 0 || index >= ctx.state.queue.length) return;
  ctx.state.activeQueueIndex = index;
  ctx.state.selectedQueueIndex = index;
  ctx.state.pendingAutoplay = true;
  ctx.state.transportWantsPlay = true;
  ctx.renderQueue();
  revealControlsOverlay();
}

function playPreviousVideo() {
  playQueueIndexFromControls(previousQueueIndex(
    ctx.state.queue.length,
    ctx.state.activeQueueIndex,
    ctx.state.loopQueue
  ));
}

function playNextVideo() {
  playQueueIndexFromControls(nextQueueIndex(
    ctx.state.queue.length,
    ctx.state.activeQueueIndex,
    ctx.state.loopQueue
  ));
}

function seekBySeconds(deltaSeconds) {
  if (!ctx.els.videoEl || !videoControlsAvailable()) return;
  var duration = currentPlaybackDurationSeconds();
  if (!Number.isFinite(duration) || duration <= 0) return;
  var currentSeconds = ctx.currentGlobalPlaybackSeconds();
  var target = Math.max(0, Math.min(duration, currentSeconds + deltaSeconds));
  if (deltaSeconds > 0) {
    target = clampCompatibilityRestartTargetSeconds(target, duration);
  }
  ctx.state.controlsScrubReveal = true;
  revealControlsOverlay();
  void ctx.restartCompatibilityAt(target, deltaSeconds < 0 ? 'step-back-15' : 'step-forward-15');
}

function eventTargetIsTextEntry(target) {
  if (!target) return false;
  var tagName = String(target.tagName || '').toLowerCase();
  if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') return true;
  return Boolean(target.isContentEditable);
}

function handleVideoSpaceKey(event) {
  if (!event || event.key !== ' ') return;
  var fullscreenHost = ctx.fullscreenHostElement();
  var stageFullscreen = fullscreenHost && document.fullscreenElement === fullscreenHost;
  if (!stageFullscreen && !ctx.state.paneActive) return;
  if (!stageFullscreen && eventTargetIsTextEntry(event.target)) return;
  if (!videoControlsAvailable()) return;
  event.preventDefault();
  toggleVideoPlayPause();
  revealControlsOverlay();
}

function syncPlaybackProgress() {
  if (!ctx.els.videoEl || !ctx.els.progressSliderEl) return;
  var active = ctx.activeQueueItem();
  var probePayload = active ? ctx.state.probeCache[active.path || ''] || null : null;
  var duration = playbackDurationSeconds(
    Number(ctx.els.videoEl.duration),
    probePayload,
    ctx.state.playbackMode
  );
  var currentTime = ctx.currentGlobalPlaybackSeconds();
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
    ctx.els.elapsedTimeEl.textContent = ctx.formatNativePlaybackTime(elapsedValue);
  }
  if (ctx.els.totalTimeEl) ctx.els.totalTimeEl.textContent = ctx.formatNativePlaybackTime(duration);
  ctx.syncProcessedProgressTrack(duration);
}

function requestVideoPlay() {
  if (!ctx.els.videoEl || typeof ctx.els.videoEl.play !== 'function') {
    ctx.state.pendingAutoplay = false;
    ctx.state.transportWantsPlay = false;
    return;
  }
  ctx.reportPlaybackTiming('play_requested');
  var requestedSyncToken = ctx.state.playbackSyncToken;
  ctx.state.transportWantsPlay = true;
  ctx.state.pendingAutoplay = true;
  var playPromise = ctx.els.videoEl.play();
  if (playPromise && typeof playPromise.catch === 'function') {
    playPromise.catch(function () {
      if (requestedSyncToken !== ctx.state.playbackSyncToken) return;
      ctx.state.pendingAutoplay = false;
      ctx.state.transportWantsPlay = false;
      ctx.setStatus('Playback is ready. Press play if the browser blocked autoplay.');
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
  var fullscreenHost = ctx.fullscreenHostElement();
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
    ctx.setStatus('Fullscreen is unavailable in this browser context.');
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
    ctx.setStatus('Picture-in-picture is unavailable for this video.');
  }
  finally {
    syncTransportControls();
  }
}

  ctx.clearControlsIdleTimer = clearControlsIdleTimer;
  ctx.setControlsOverlayIdle = setControlsOverlayIdle;
  ctx.showControlsOverlay = showControlsOverlay;
  ctx.hideControlsOverlay = hideControlsOverlay;
  ctx.scheduleControlsIdleHide = scheduleControlsIdleHide;
  ctx.scheduleControlsIdleHideIfNotActive = scheduleControlsIdleHideIfNotActive;
  ctx.controlsPointerMoveIsSignificant = controlsPointerMoveIsSignificant;
  ctx.revealControlsOverlay = revealControlsOverlay;
  ctx.resetPlaybackProgress = resetPlaybackProgress;
  ctx.videoControlsAvailable = videoControlsAvailable;
  ctx.playbackShouldBeRunning = playbackShouldBeRunning;
  ctx.syncTransportControls = syncTransportControls;
  ctx.syncLoopQueueButton = syncLoopQueueButton;
  ctx.restoreVideoLoopQueue = restoreVideoLoopQueue;
  ctx.persistVideoLoopQueue = persistVideoLoopQueue;
  ctx.toggleVideoLoopQueue = toggleVideoLoopQueue;
  ctx.syncQueueNavigationButtons = syncQueueNavigationButtons;
  ctx.syncSeekStepButtons = syncSeekStepButtons;
  ctx.playPreviousVideo = playPreviousVideo;
  ctx.playNextVideo = playNextVideo;
  ctx.seekVideoBySeconds = seekBySeconds;
  ctx.syncPlaybackProgress = syncPlaybackProgress;
  ctx.requestVideoPlay = requestVideoPlay;
  ctx.toggleVideoPlayPause = toggleVideoPlayPause;
  ctx.toggleVideoMute = toggleVideoMute;
  ctx.setVideoVolumeFromSlider = setVideoVolumeFromSlider;
  ctx.toggleVideoFullscreen = toggleVideoFullscreen;
  ctx.togglePictureInPicture = togglePictureInPicture;

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
  if (ctx.els.loopButton) {
    ctx.els.loopButton.addEventListener('click', function (event) {
      event.stopPropagation();
      toggleVideoLoopQueue();
      revealControlsOverlay();
    });
  }
  if (ctx.els.previousButton) {
    ctx.els.previousButton.addEventListener('click', function (event) {
      event.stopPropagation();
      playPreviousVideo();
    });
  }
  if (ctx.els.nextButton) {
    ctx.els.nextButton.addEventListener('click', function (event) {
      event.stopPropagation();
      playNextVideo();
    });
  }
  if (ctx.els.back15Button) {
    ctx.els.back15Button.addEventListener('click', function (event) {
      event.stopPropagation();
      seekBySeconds(-15);
    });
  }
  if (ctx.els.forward15Button) {
    ctx.els.forward15Button.addEventListener('click', function (event) {
      event.stopPropagation();
      seekBySeconds(15);
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
        if (ctx.state.seekRestartInProgress) {
          ctx.reportCompatibilitySeekTiming('seek_queued_during_restart', {
            queued_requested_time: nextTime,
            prior_requested_time: ctx.state.requestedSeekSeconds,
          });
          ctx.state.requestedSeekSeconds = nextTime;
          if (ctx.els.elapsedTimeEl) {
            ctx.els.elapsedTimeEl.textContent = ctx.formatNativePlaybackTime(nextTime);
          }
          syncPlaybackProgress();
          return;
        }
        ctx.reportCompatibilitySeekTiming('scrub_restart_requested', {
          target_seconds: nextTime,
        });
        void ctx.restartCompatibilityAt(nextTime, 'scrub');
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
      ctx.syncSubtitlesForCurrentPlaybackTime('timeupdate');
      ctx.syncSubtitleOverlayDisplay();
      ctx.syncSubtitleDebugDisplay();
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
    if (typeof document !== 'undefined') {
      document.addEventListener('fullscreenchange', syncTransportControls);
      document.addEventListener('keydown', handleVideoSpaceKey);
    }
    ctx.els.videoEl.addEventListener('enterpictureinpicture', syncTransportControls);
    ctx.els.videoEl.addEventListener('leavepictureinpicture', syncTransportControls);
    ctx.els.videoEl.addEventListener('emptied', resetPlaybackProgress);
    ctx.els.videoEl.addEventListener('playing', function () {
      ctx.state.transportWantsPlay = true;
      ctx.state.pendingAutoplay = false;
      ctx.resetCompatibilityRecoveryState();
      ctx.hideLoadingOverlay();
      syncTransportControls();
      syncPlaybackProgress();
    });
    ctx.els.videoEl.addEventListener('ended', function () {
      ctx.state.transportWantsPlay = false;
      ctx.state.pendingAutoplay = false;
      syncTransportControls();
      var event = new CustomEvent('video-playback-ended');
      ctx.pane.dispatchEvent(event);
    });
    ctx.els.videoEl.addEventListener('error', function () {
      var active = ctx.activeQueueItem();
      if (!active) return;
      if (ctx.state.playbackMode === 'compatibility') return;
      ctx.clearVideoSource();
      ctx.showPlaybackPlaceholder(ctx.activeItemTitle(active), 'Video playback failed.');
      ctx.setStatus('Video playback failed.');
    });
  }
}
