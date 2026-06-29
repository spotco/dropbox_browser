export const HLS_SEGMENT_DURATION_SECONDS = 6;

export function playbackDurationSeconds(mediaDuration, probePayload, playbackMode) {
  if (playbackMode === 'compatibility' && probePayload) {
    var probeDuration = Number(probePayload.duration_seconds);
    if (Number.isFinite(probeDuration) && probeDuration > 0) return probeDuration;
  }
  if (Number.isFinite(mediaDuration) && mediaDuration > 0) return mediaDuration;
  return 0;
}

export function clampCompatibilityRestartTargetSeconds(targetSeconds, durationSeconds) {
  var target = Math.max(0, Number(targetSeconds) || 0);
  var duration = Number(durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) return target;

  var minimumTailSeconds = Math.min(1, duration / 2);
  var maximumRestartTarget = Math.max(0, duration - minimumTailSeconds);
  return Math.min(target, maximumRestartTarget);
}

function normalizeStreamIndex(value) {
  if (value === null || value === undefined || value === '') return null;
  var numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function mediaTimeFromGlobalTime(sessionStartSeconds, globalTimeSeconds) {
  var sessionStart = Math.max(0, Number(sessionStartSeconds) || 0);
  var globalTime = Math.max(0, Number(globalTimeSeconds) || 0);
  return Math.max(0, globalTime - sessionStart);
}

export function compatibilityEncodedMediaEndSeconds(seekableRanges, trackedMediaEndSeconds) {
  var tracked = Number(trackedMediaEndSeconds);
  var seekableEnd = compatibilitySeekableEndSeconds(seekableRanges);
  if (seekableEnd > 0 && Number.isFinite(tracked) && tracked > 0) {
    return Math.max(seekableEnd, tracked);
  }
  if (seekableEnd > 0) return seekableEnd;
  if (Number.isFinite(tracked) && tracked > 0) return tracked;
  return 0;
}

export function compatibilitySeekableEndSeconds(seekableRanges) {
  var seekableEnd = 0;
  if (Array.isArray(seekableRanges)) {
    for (var index = 0; index < seekableRanges.length; index += 1) {
      var range = seekableRanges[index];
      var end = Number(range && range.end);
      if (Number.isFinite(end) && end > seekableEnd) seekableEnd = end;
    }
  }
  return seekableEnd;
}

export function compatibilityProcessedRange(input) {
  var duration = Number(input && input.durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) {
    return {
      startSeconds: 0,
      endSeconds: 0,
      startPercent: 0,
      endPercent: 0,
    };
  }

  var sessionStart = Math.max(0, Number(input && input.sessionStartSeconds) || 0);
  var encodedMediaEnd = Math.max(0, Number(input && input.encodedMediaEndSeconds) || 0);
  var startSeconds = Math.min(duration, sessionStart);
  var endSeconds = Math.min(duration, sessionStart + encodedMediaEnd);
  if (endSeconds < startSeconds) endSeconds = startSeconds;

  return {
    startSeconds: startSeconds,
    endSeconds: endSeconds,
    startPercent: Math.max(0, Math.min(100, (startSeconds / duration) * 100)),
    endPercent: Math.max(0, Math.min(100, (endSeconds / duration) * 100)),
  };
}

export function compatibilitySeekableRange(input) {
  var duration = Number(input && input.durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) {
    return {
      startSeconds: 0,
      endSeconds: 0,
      startPercent: 0,
      endPercent: 0,
    };
  }

  var sessionStart = Math.max(0, Number(input && input.sessionStartSeconds) || 0);
  var seekableEnd = compatibilitySeekableEndSeconds(input && input.seekableRanges);
  var startSeconds = Math.min(duration, sessionStart);
  var endSeconds = Math.min(duration, sessionStart + seekableEnd);
  if (endSeconds < startSeconds) endSeconds = startSeconds;

  return {
    startSeconds: startSeconds,
    endSeconds: endSeconds,
    startPercent: Math.max(0, Math.min(100, (startSeconds / duration) * 100)),
    endPercent: Math.max(0, Math.min(100, (endSeconds / duration) * 100)),
  };
}

export function compatibilityInSessionSeekDecision(input) {
  var target = Math.max(0, Number(input && input.targetSeconds) || 0);
  var sessionStart = Math.max(0, Number(input && input.sessionStartSeconds) || 0);
  var tolerance = Number(input && input.toleranceSeconds);
  if (!Number.isFinite(tolerance) || tolerance < 0) tolerance = 0.25;

  if (!input || input.playbackMode !== 'compatibility') {
    return {action: 'restart', reason: 'playback-mode'};
  }
  if (!input.hasActiveSession || !input.sessionId) {
    return {action: 'restart', reason: 'no-session'};
  }
  if ((input.itemPath || '') !== (input.sessionPath || '')) {
    return {action: 'restart', reason: 'path-changed'};
  }

  var selectedAudio = normalizeStreamIndex(input.selectedAudioStreamIndex);
  var sessionAudio = normalizeStreamIndex(input.sessionAudioStreamIndex);
  var selectedSubtitle = normalizeStreamIndex(input.selectedBurnedInSubtitleStreamIndex);
  var sessionSubtitle = normalizeStreamIndex(input.sessionSubtitleStreamIndex);
  if (selectedAudio !== sessionAudio || selectedSubtitle !== sessionSubtitle) {
    return {action: 'restart', reason: 'track-selection'};
  }

  var trackedEncodedEnd = Number(input.encodedMediaEndSeconds);
  var encodedMediaEnd = Number.isFinite(trackedEncodedEnd) && trackedEncodedEnd > 0
    ? trackedEncodedEnd
    : 0;
  var seekableMediaEnd = compatibilitySeekableEndSeconds(input.seekableRanges);
  if (!(encodedMediaEnd > 0)) {
    encodedMediaEnd = seekableMediaEnd;
  }
  if (target < sessionStart - tolerance) {
    return {action: 'restart', reason: 'before-session-start'};
  }
  if (seekableMediaEnd > 0 && target > sessionStart + seekableMediaEnd + tolerance) {
    return {action: 'restart', reason: 'beyond-seekable-range'};
  }
  if (target > sessionStart + encodedMediaEnd + tolerance) {
    return {action: 'restart', reason: 'beyond-encoded-range'};
  }

  return {
    action: 'in-session',
    reason: 'encoded-range',
    mediaTargetSeconds: mediaTimeFromGlobalTime(sessionStart, target),
  };
}

export function compatibilityRecoveryRequiresSessionRestart(reason) {
  var normalized = String(reason || '');
  return normalized === 'hls-missing-segment'
    || normalized === 'hls-fatal-error'
    || normalized === 'hls-media-copy-fallback'
    || normalized === 'hls-media-audio-copy-fallback'
    || normalized === 'media-element-error'
    || normalized === 'media-element-copy-fallback'
    || normalized === 'media-element-audio-copy-fallback'
    || normalized === 'restart-failed'
    || normalized === 'initial-start-failed';
}

export function shouldApplyDeferredCompatibilitySeek(
  deferredSeekSeconds,
  completedSeekSeconds,
  toleranceSeconds,
) {
  if (deferredSeekSeconds === null || deferredSeekSeconds === undefined || deferredSeekSeconds === '') {
    return false;
  }
  var deferred = Number(deferredSeekSeconds);
  var completed = Number(completedSeekSeconds);
  if (!Number.isFinite(deferred) || deferred < 0) return false;
  if (!Number.isFinite(completed)) return false;
  var tolerance = Number(toleranceSeconds);
  if (!Number.isFinite(tolerance) || tolerance < 0) tolerance = 0.05;
  return Math.abs(deferred - completed) > tolerance;
}
