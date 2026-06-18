export function appendQueueItems(queue, items) {
  return queue.concat(items.map(function (item) {
    return Object.assign({}, item);
  }));
}

export function enqueueAndPlay(queue, activeIndex, item) {
  const nextQueue = appendQueueItems(queue, [item]);
  return { queue: nextQueue, activeIndex: nextQueue.length - 1 };
}

export function enqueueSelected(queue, activeIndex, items) {
  const nextQueue = appendQueueItems(queue, items);
  return { queue: nextQueue, activeIndex };
}

export function removeQueueIndex(queue, activeIndex, removeIndex) {
  if (removeIndex < 0 || removeIndex >= queue.length) return { queue, activeIndex };
  const nextQueue = queue.slice(0, removeIndex).concat(queue.slice(removeIndex + 1));
  if (nextQueue.length === 0) return { queue: nextQueue, activeIndex: -1 };
  if (activeIndex === removeIndex) {
    return { queue: nextQueue, activeIndex: Math.min(removeIndex, nextQueue.length - 1) };
  }
  if (activeIndex > removeIndex) {
    return { queue: nextQueue, activeIndex: activeIndex - 1 };
  }
  return { queue: nextQueue, activeIndex };
}

export function clearQueue() {
  return { queue: [], activeIndex: -1 };
}

export function moveQueueIndex(queue, activeIndex, fromIndex, toIndex) {
  if (fromIndex < 0 || fromIndex >= queue.length) return { queue, activeIndex, moved: false };
  if (toIndex < 0 || toIndex >= queue.length) return { queue, activeIndex, moved: false };
  if (fromIndex === toIndex) return { queue, activeIndex, moved: false };
  const nextQueue = queue.slice();
  const [item] = nextQueue.splice(fromIndex, 1);
  nextQueue.splice(toIndex, 0, item);
  let nextActiveIndex = activeIndex;
  if (activeIndex === fromIndex) {
    nextActiveIndex = toIndex;
  }
  else if (fromIndex < activeIndex && toIndex >= activeIndex) {
    nextActiveIndex -= 1;
  }
  else if (fromIndex > activeIndex && toIndex <= activeIndex) {
    nextActiveIndex += 1;
  }
  return { queue: nextQueue, activeIndex: nextActiveIndex, moved: true };
}

export function playQueueIndex(queueLength, index) {
  if (index < 0 || index >= queueLength) return -1;
  return index;
}

export function advanceQueueAfterPlaybackEnd(queueLength, activeIndex) {
  if (queueLength <= 0) return -1;
  if (activeIndex < 0) return queueLength > 0 ? 0 : -1;
  const nextIndex = activeIndex + 1;
  return nextIndex < queueLength ? nextIndex : -1;
}

export const HLS_SEGMENT_DURATION_SECONDS = 6;

export function playbackDurationSeconds(mediaDuration, probePayload, playbackMode) {
  if (playbackMode === 'compatibility' && probePayload) {
    var probeDuration = Number(probePayload.duration_seconds);
    if (Number.isFinite(probeDuration) && probeDuration > 0) return probeDuration;
  }
  if (Number.isFinite(mediaDuration) && mediaDuration > 0) return mediaDuration;
  return 0;
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
  var seekableEnd = 0;
  if (Array.isArray(seekableRanges)) {
    for (var index = 0; index < seekableRanges.length; index += 1) {
      var range = seekableRanges[index];
      var end = Number(range && range.end);
      if (Number.isFinite(end) && end > seekableEnd) seekableEnd = end;
    }
  }
  if (seekableEnd > 0 && Number.isFinite(tracked) && tracked > 0) {
    return Math.max(seekableEnd, tracked);
  }
  if (seekableEnd > 0) return seekableEnd;
  if (Number.isFinite(tracked) && tracked > 0) return tracked;
  return 0;
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

  var encodedMediaEnd = compatibilityEncodedMediaEndSeconds(
    input.seekableRanges,
    input.encodedMediaEndSeconds,
  );
  if (!(encodedMediaEnd > 0)) {
    return {action: 'restart', reason: 'no-encoded-range'};
  }

  if (target < sessionStart - tolerance) {
    return {action: 'restart', reason: 'before-session-start'};
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
