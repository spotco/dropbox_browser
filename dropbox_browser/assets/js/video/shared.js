import {
  compatibilitySeekableRange,
  playbackDurationSeconds,
} from '../video-core.js';
import {
  COMPATIBILITY_SUBTITLE_WAIT_META,
  VIDEO_ICONS,
} from './constants.js';

export function initShared(ctx) {
  ctx.body = typeof document !== 'undefined' ? document.body : null;
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

function currentFolderPath() {
  return ctx.body && typeof ctx.body.dataset.currentFolderPath === 'string'
    ? ctx.body.dataset.currentFolderPath
    : '';
}

function currentGlobalPlaybackSeconds() {
  var mediaTime = ctx.els.videoEl ? Number(ctx.els.videoEl.currentTime) : 0;
  return ctx.state.compatibilityStartSeconds + (Number.isFinite(mediaTime) && mediaTime >= 0 ? mediaTime : 0);
}

function currentVideoBackpressureState() {
  var thresholds = ctx.state.backpressureThresholds || {};
  var low = Math.max(0, Number(thresholds.lowWaterSeconds) || 45);
  var medium = Math.max(low, Number(thresholds.mediumWaterSeconds) || 120);
  var high = Math.max(medium, Number(thresholds.highWaterSeconds) || 300);
  var maximum = Math.max(high, Number(thresholds.maxWaterSeconds) || 600);
  var playbackSecondsFromSessionStart = Math.max(
    0,
    (Number(currentGlobalPlaybackSeconds()) || 0) - (Number(ctx.state.compatibilityStartSeconds) || 0)
  );
  var aheadSeconds = Math.max(
    0,
    (Number(ctx.state.compatibilityEncodedMediaEndSeconds) || 0) - playbackSecondsFromSessionStart
  );
  var playbackState = 'unknown';
  if (ctx.state.playbackMode === 'compatibility' && typeof ctx.compatibilityPlaybackState === 'function') {
    playbackState = String(ctx.compatibilityPlaybackState());
  }
  else if (ctx.els.videoEl) {
    playbackState = ctx.els.videoEl.ended ? 'paused' : (ctx.els.videoEl.paused ? 'paused' : 'playing');
  }
  var paused = playbackState === 'paused';
  var mode;
  if (aheadSeconds < low) mode = 'catch-up';
  else if (aheadSeconds >= maximum) mode = 'pause-input';
  else if (aheadSeconds >= high) mode = paused ? 'pause-input' : 'heavy-throttle';
  else if (aheadSeconds >= medium) mode = paused ? 'heavy-throttle' : 'slow-background';
  else mode = paused ? 'slow-background' : 'steady-background';
  return {
    mode: mode,
    aheadSeconds: aheadSeconds,
  };
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

function clearSubtitleFailureState() {
  ctx.state.subtitleFailureState = 'idle';
  if (ctx.els.subtitleStatusTitleEl) ctx.els.subtitleStatusTitleEl.textContent = '';
  if (ctx.els.subtitleStatusMetaEl) ctx.els.subtitleStatusMetaEl.textContent = '';
  if (ctx.els.subtitleStatusBannerEl) setStageLayerVisibility(ctx.els.subtitleStatusBannerEl, false);
  if (ctx.els.playbackStageEl) ctx.els.playbackStageEl.setAttribute('data-subtitle-state', 'idle');
  if (ctx.els.subtitleTrackSelectEl) {
    ctx.els.subtitleTrackSelectEl.setAttribute('data-subtitle-state', 'idle');
    ctx.els.subtitleTrackSelectEl.removeAttribute('title');
  }
}

function showSubtitleFailureState(options) {
  var title = options && typeof options.title === 'string'
    ? options.title
    : 'Subtitle loading failed';
  var meta = options && typeof options.meta === 'string'
    ? options.meta
    : 'The selected subtitle window could not be extracted.';
  ctx.state.subtitleFailureState = 'error';
  if (ctx.els.subtitleStatusTitleEl) ctx.els.subtitleStatusTitleEl.textContent = title;
  if (ctx.els.subtitleStatusMetaEl) ctx.els.subtitleStatusMetaEl.textContent = meta;
  if (ctx.els.subtitleStatusBannerEl) setStageLayerVisibility(ctx.els.subtitleStatusBannerEl, true);
  if (ctx.els.playbackStageEl) ctx.els.playbackStageEl.setAttribute('data-subtitle-state', 'error');
  if (ctx.els.subtitleTrackSelectEl) {
    ctx.els.subtitleTrackSelectEl.setAttribute('data-subtitle-state', 'error');
    ctx.els.subtitleTrackSelectEl.title = meta;
  }
}

function resetProcessedProgressTrack() {
  if (!ctx.els.progressSliderEl) return;
  ctx.els.progressSliderEl.style.setProperty('--video-progress-media-start', '0%');
  ctx.els.progressSliderEl.style.setProperty('--video-progress-media-end', '0%');
  ctx.els.progressSliderEl.style.setProperty('--video-progress-subtitle-start', '0%');
  ctx.els.progressSliderEl.style.setProperty('--video-progress-subtitle-end', '0%');
  ctx.els.progressSliderEl.style.setProperty('--video-progress-processed-start', '0%');
  ctx.els.progressSliderEl.style.setProperty('--video-progress-processed-end', '0%');
  ctx.els.progressSliderEl.removeAttribute('data-subtitle-coverage-state');
  ctx.els.progressSliderEl.title = '';
}

function selectedSubtitleCoverageRangeForPlaybackTarget(duration, targetSeconds) {
  if (ctx.state.playbackMode !== 'compatibility') return null;
  var active = activeQueueItem();
  if (!active || !active.path) return null;
  var probePayload = ctx.state.probeCache[active.path || ''] || null;
  if (!probePayload) return null;
  if (!ctx.subtitlesEnabledForItem(active, probePayload)) return null;
  if (ctx.selectedBurnedInSubtitleStreamIndex(active, probePayload) !== null) return null;
  var streamIndex = ctx.resolvedSubtitleStreamIndex(active, probePayload);
  if (streamIndex === '') return null;
  if (
    Number.isFinite(Number(duration))
    && Number(duration) > 0
    && typeof ctx.getCachedFullSubtitleVtt === 'function'
    && ctx.getCachedFullSubtitleVtt(active.path || '', streamIndex)
  ) {
    return {
      start_seconds: 0,
      end_seconds: Number(duration),
    };
  }
  if (typeof ctx.subtitleCoverageRangeForTarget !== 'function') return null;
  return ctx.subtitleCoverageRangeForTarget(active.path || '', streamIndex, targetSeconds);
}

function currentProgressDebugLines(durationOverride, targetSecondsOverride) {
  var active = activeQueueItem();
  var probePayload = active ? ctx.state.probeCache[active.path || ''] || null : null;
  var duration = Number(durationOverride);
  if (!Number.isFinite(duration) || duration <= 0) {
    duration = playbackDurationSeconds(
      ctx.els.videoEl ? Number(ctx.els.videoEl.duration) : NaN,
      probePayload,
      ctx.state.playbackMode
    );
  }
  if (!Number.isFinite(duration) || duration <= 0) return [];
  var mediaRange = compatibilitySeekableRange({
    durationSeconds: duration,
    sessionStartSeconds: ctx.state.compatibilityStartSeconds,
    seekableRanges: ctx.compatibilitySeekableRanges(),
  });
  var bufferAheadSeconds = Math.max(0, mediaRange.endSeconds - currentGlobalPlaybackSeconds());
  var backpressureState = currentVideoBackpressureState();
  var focusSeconds = Number.isFinite(Number(targetSecondsOverride))
    ? Number(targetSecondsOverride)
    : (
      Number.isFinite(Number(ctx.state.requestedSeekSeconds))
        ? Number(ctx.state.requestedSeekSeconds)
        : currentGlobalPlaybackSeconds()
    );
  var subtitleCoverageRange = null;
  var streamIndex = null;
  if (active && active.path && probePayload && typeof ctx.resolvedSubtitleStreamIndex === 'function') {
    streamIndex = ctx.resolvedSubtitleStreamIndex(active, probePayload);
  }
  if (
    active
    && active.path
    && streamIndex !== ''
    && streamIndex !== null
    && Number.isFinite(duration)
    && duration > 0
    && typeof ctx.getCachedFullSubtitleVtt === 'function'
    && ctx.getCachedFullSubtitleVtt(active.path || '', streamIndex)
  ) {
    subtitleCoverageRange = {
      start_seconds: 0,
      end_seconds: duration,
    };
  }
  if (
    !subtitleCoverageRange
    && active
    && active.path
    && streamIndex !== ''
    && streamIndex !== null
    && typeof ctx.subtitleCoverageSummaryRange === 'function'
  ) {
    var summaryRange = ctx.subtitleCoverageSummaryRange(active.path || '', streamIndex);
    if (summaryRange) subtitleCoverageRange = summaryRange;
  }
  if (!subtitleCoverageRange) {
    subtitleCoverageRange = selectedSubtitleCoverageRangeForPlaybackTarget(duration, focusSeconds);
  }
  var loadedLine = 'Loaded video: '
    + formatNativePlaybackTime(mediaRange.startSeconds)
    + ' - '
    + formatNativePlaybackTime(mediaRange.endSeconds)
    + '.';
  if (subtitleCoverageRange) {
    loadedLine += ' Subtitle-ready: '
      + formatNativePlaybackTime(Math.max(0, Number(subtitleCoverageRange.start_seconds) || 0))
      + ' - '
      + formatNativePlaybackTime(Math.max(0, Number(subtitleCoverageRange.end_seconds) || 0))
      + '.';
  }
  return [
    'CPU priority: '
      + backpressureState.mode
      + ' • loaded buffer ahead: '
      + formatNativePlaybackTime(bufferAheadSeconds)
      + '.',
    loadedLine,
  ];
}

function syncProcessedProgressTrack(duration) {
  if (!ctx.els.progressSliderEl) return;
  var mediaRange = compatibilitySeekableRange({
    durationSeconds: duration,
    sessionStartSeconds: ctx.state.compatibilityStartSeconds,
    seekableRanges: ctx.compatibilitySeekableRanges(),
  });
  var bufferAheadSeconds = Math.max(0, mediaRange.endSeconds - currentGlobalPlaybackSeconds());
  var backpressureState = currentVideoBackpressureState();
  var processedRange = {
    startSeconds: mediaRange.startSeconds,
    endSeconds: mediaRange.endSeconds,
    startPercent: mediaRange.startPercent,
    endPercent: mediaRange.endPercent,
  };
  var focusSeconds = Number.isFinite(Number(ctx.state.requestedSeekSeconds))
    ? Number(ctx.state.requestedSeekSeconds)
    : currentGlobalPlaybackSeconds();
  var subtitleCoverageRange = selectedSubtitleCoverageRangeForPlaybackTarget(duration, focusSeconds);
  var subtitleCoverageState = 'off';
  var subtitleStartPercent = 0;
  var subtitleEndPercent = 0;
  if (subtitleCoverageRange) {
    var subtitleStartSeconds = Math.max(0, Number(subtitleCoverageRange.start_seconds) || 0);
    var subtitleEndSeconds = Math.max(0, Number(subtitleCoverageRange.end_seconds) || 0);
    subtitleStartPercent = duration > 0 ? (subtitleStartSeconds / duration) * 100 : 0;
    subtitleEndPercent = duration > 0 ? (subtitleEndSeconds / duration) * 100 : 0;
    subtitleCoverageState = (
      Math.abs(subtitleStartSeconds - mediaRange.startSeconds) <= 0.25
      && Math.abs(subtitleEndSeconds - mediaRange.endSeconds) <= 0.25
    )
      ? 'full'
      : 'limited';
    processedRange.startSeconds = Math.max(
      processedRange.startSeconds,
      subtitleStartSeconds
    );
    processedRange.endSeconds = Math.min(
      processedRange.endSeconds,
      subtitleEndSeconds
    );
    if (processedRange.endSeconds < processedRange.startSeconds) {
      processedRange.endSeconds = processedRange.startSeconds;
    }
    processedRange.startPercent = duration > 0 ? (processedRange.startSeconds / duration) * 100 : 0;
    processedRange.endPercent = duration > 0 ? (processedRange.endSeconds / duration) * 100 : 0;
  }
  ctx.els.progressSliderEl.style.setProperty(
    '--video-progress-media-start',
    mediaRange.startPercent.toFixed(3) + '%'
  );
  ctx.els.progressSliderEl.style.setProperty(
    '--video-progress-media-end',
    mediaRange.endPercent.toFixed(3) + '%'
  );
  ctx.els.progressSliderEl.style.setProperty(
    '--video-progress-subtitle-start',
    subtitleStartPercent.toFixed(3) + '%'
  );
  ctx.els.progressSliderEl.style.setProperty(
    '--video-progress-subtitle-end',
    subtitleEndPercent.toFixed(3) + '%'
  );
  ctx.els.progressSliderEl.style.setProperty(
    '--video-progress-processed-start',
    processedRange.startPercent.toFixed(3) + '%'
  );
  ctx.els.progressSliderEl.style.setProperty(
    '--video-progress-processed-end',
    processedRange.endPercent.toFixed(3) + '%'
  );
  ctx.els.progressSliderEl.setAttribute('data-subtitle-coverage-state', subtitleCoverageState);
  ctx.els.progressSliderEl.title = '';
}

function currentProcessedRangeSnapshot(targetSeconds, durationOverride) {
  var duration = Number(durationOverride);
  if (!Number.isFinite(duration) || duration <= 0) {
    duration = playbackDurationSeconds(
      ctx.els.videoEl ? Number(ctx.els.videoEl.duration) : NaN,
      null,
      ctx.state.playbackMode
    );
  }
  var processedRange = compatibilitySeekableRange({
    durationSeconds: duration,
    sessionStartSeconds: ctx.state.compatibilityStartSeconds,
    seekableRanges: ctx.compatibilitySeekableRanges(),
  });
  var normalizedTarget = Number(targetSeconds);
  var tolerance = 0.25;
  var targetInProcessedRange = Number.isFinite(normalizedTarget)
    && normalizedTarget >= (processedRange.startSeconds - tolerance)
    && normalizedTarget <= (processedRange.endSeconds + tolerance);
  return {
    duration_seconds: Number.isFinite(duration) ? duration : '',
    current_global_time: currentGlobalPlaybackSeconds(),
    current_media_time: ctx.els.videoEl ? Number(ctx.els.videoEl.currentTime) || 0 : '',
    session_start_seconds: ctx.state.compatibilityStartSeconds || 0,
    encoded_media_end_seconds: ctx.state.compatibilityEncodedMediaEndSeconds || 0,
    processed_range_start_seconds: processedRange.startSeconds,
    processed_range_end_seconds: processedRange.endSeconds,
    processed_target_in_range: targetInProcessedRange,
    requested_time: Number.isFinite(normalizedTarget) ? normalizedTarget : '',
    media_seekable: ctx.els.videoEl ? mediaRangesSummary(ctx.els.videoEl.seekable) : [],
    media_buffered: ctx.els.videoEl ? mediaRangesSummary(ctx.els.videoEl.buffered) : [],
  };
}

function updateLoadingOverlay(visible, options) {
  var title = options && typeof options.title === 'string' ? options.title : 'Preparing playback';
  var meta = options && typeof options.meta === 'string' ? options.meta : '';
  var reason = options && typeof options.reason === 'string' ? options.reason : 'general';
  var progressValue = options ? Number(options.progress) : NaN;
  if (
    visible
    && compatibilityStartupShouldWaitForSubtitles()
  ) {
    title = activeItemTitle(activeQueueItem());
    meta = COMPATIBILITY_SUBTITLE_WAIT_META;
    reason = 'subtitle-wait';
    progressValue = 0.84;
    ctx.state.compatibilitySubtitleWaitStageActive = true;
  }
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
    ctx.els.loadingOverlayEl.setAttribute('data-loading-reason', visible ? reason : 'idle');
    var progressHost = ctx.els.loadingOverlayEl.querySelector('.video-loading-progress');
    if (progressHost) progressHost.setAttribute('aria-valuenow', String(progressPercent));
  }
  if (ctx.els.playbackStageEl) {
    ctx.els.playbackStageEl.setAttribute('data-loading-state', visible ? 'active' : 'idle');
    ctx.els.playbackStageEl.setAttribute('data-loading-reason', visible ? reason : 'idle');
  }
  ctx.state.loadingOverlayVisible = visible;
  ctx.state.loadingOverlayMeta = visible ? meta : '';
  if (!visible) ctx.state.compatibilitySubtitleWaitStageActive = false;
}

function compatibilityStartupShouldWaitForSubtitles() {
  if (ctx.state.playbackMode !== 'compatibility') return false;
  if (ctx.state.compatibilityPlaybackRevealed) return false;
  var active = activeQueueItem();
  if (!active) return false;
  var probePayload = ctx.state.probeCache[active.path || ''] || null;
  if (!probePayload) return false;
  if (!ctx.subtitlesEnabledForItem(active, probePayload)) return false;
  if (ctx.selectedBurnedInSubtitleStreamIndex(active, probePayload) !== null) return false;
  var streamIndex = ctx.resolvedSubtitleStreamIndex(active, probePayload);
  if (streamIndex === '') return false;
  var fetchStartSeconds = Math.max(0, Number(ctx.state.compatibilityStartSeconds) || 0);
  var coverageTargetSeconds = fetchStartSeconds;
  if (typeof ctx.currentGlobalPlaybackSeconds === 'function') {
    coverageTargetSeconds = Math.max(0, Number(ctx.currentGlobalPlaybackSeconds()) || 0);
  }
  return !ctx.subtitlesAreMounted(active, streamIndex, fetchStartSeconds, coverageTargetSeconds);
}

function showLoadingOverlay(options) {
  updateLoadingOverlay(true, options);
  ctx.syncTransportControls();
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

function formatPlaybackTimeWithMilliseconds(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00:000';
  var totalMilliseconds = Math.max(0, Math.floor(Number(totalSeconds) * 1000));
  var hours = Math.floor(totalMilliseconds / 3600000);
  var minutes = Math.floor((totalMilliseconds % 3600000) / 60000);
  var seconds = Math.floor((totalMilliseconds % 60000) / 1000);
  var milliseconds = totalMilliseconds % 1000;
  if (hours > 0) {
    return String(hours)
      + ':'
      + String(minutes).padStart(2, '0')
      + ':'
      + String(seconds).padStart(2, '0')
      + ':'
      + String(milliseconds).padStart(3, '0');
  }
  return String(minutes)
    + ':'
    + String(seconds).padStart(2, '0')
    + ':'
    + String(milliseconds).padStart(3, '0');
}

function showPlaybackPlaceholder(title, meta) {
  hideLoadingOverlay();
  clearSubtitleFailureState();
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
    reason: 'general',
  };
}

function playbackSyncTokenIsCurrent(syncToken) {
  return !Number.isFinite(syncToken) || syncToken === ctx.state.playbackSyncToken;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

  ctx.setControlIcon = setControlIcon;
  ctx.setControlButtonState = setControlButtonState;
  ctx.formatNativePlaybackTime = formatNativePlaybackTime;
  ctx.fullscreenHostElement = fullscreenHostElement;
  ctx.volumeIconForLevel = volumeIconForLevel;
  ctx.currentFolderPath = currentFolderPath;
  ctx.setPlaybackSummary = setPlaybackSummary;
  ctx.resetProcessedProgressTrack = resetProcessedProgressTrack;
  ctx.syncProcessedProgressTrack = syncProcessedProgressTrack;
  ctx.currentProgressDebugLines = currentProgressDebugLines;
  ctx.currentProcessedRangeSnapshot = currentProcessedRangeSnapshot;
  ctx.mediaRangesSummary = mediaRangesSummary;
  ctx.currentGlobalPlaybackSeconds = currentGlobalPlaybackSeconds;
  ctx.currentVideoBackpressureState = currentVideoBackpressureState;
  ctx.updateLoadingOverlay = updateLoadingOverlay;
  ctx.compatibilityStartupShouldWaitForSubtitles = compatibilityStartupShouldWaitForSubtitles;
  ctx.showLoadingOverlay = showLoadingOverlay;
  ctx.hideLoadingOverlay = hideLoadingOverlay;
  ctx.updateCurrentFolder = updateCurrentFolder;
  ctx.parentFolderPath = parentFolderPath;
  ctx.selectedLibraryItems = selectedLibraryItems;
  ctx.activeQueueItem = activeQueueItem;
  ctx.activeItemPath = activeItemPath;
  ctx.setStageLayerVisibility = setStageLayerVisibility;
  ctx.hideVideoElement = hideVideoElement;
  ctx.showVideoElement = showVideoElement;
  ctx.showPlaceholderElement = showPlaceholderElement;
  ctx.hidePlaceholderElement = hidePlaceholderElement;
  ctx.formatPlaybackTime = formatPlaybackTime;
  ctx.formatPlaybackTimeWithMilliseconds = formatPlaybackTimeWithMilliseconds;
  ctx.showPlaybackPlaceholder = showPlaybackPlaceholder;
  ctx.showPlaybackVideo = showPlaybackVideo;
  ctx.activeItemTitle = activeItemTitle;
  ctx.compatibilityNeededStatus = compatibilityNeededStatus;
  ctx.compatibilityNeededMeta = compatibilityNeededMeta;
  ctx.loadingOverlayCopy = loadingOverlayCopy;
  ctx.playbackSyncTokenIsCurrent = playbackSyncTokenIsCurrent;
  ctx.escapeHtml = escapeHtml;
  ctx.clearSubtitleFailureState = clearSubtitleFailureState;
  ctx.showSubtitleFailureState = showSubtitleFailureState;
}
