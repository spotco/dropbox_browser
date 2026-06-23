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
    || normalized === 'media-element-error'
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

var WEBVTT_ENTITY_RE = /&(?:amp|lt|gt|lrm|rlm);/gi;
var WEBVTT_TIMESTAMP_TAG_RE = /<\d{1,2}:\d{2}(?::\d{2})?\.\d{3}>/g;
var WEBVTT_TAG_RE = /<\/?[a-zA-Z][^>]*>/g;
var WEBVTT_SUPPORTED_TAGS = {
  b: 'b',
  i: 'i',
  u: 'u',
  c: 'span',
  v: 'span',
  lang: 'span',
  ruby: 'ruby',
  rt: 'rt',
};

function decodeWebVttEntities(text) {
  return String(text || '').replace(WEBVTT_ENTITY_RE, function (entity) {
    var key = entity.slice(1, -1).toLowerCase();
    if (key === 'amp') return '&';
    if (key === 'lt') return '<';
    if (key === 'gt') return '>';
    if (key === 'lrm') return '\u200E';
    if (key === 'rlm') return '\u200F';
    return entity;
  });
}

function escapeWebVttHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function parseWebVttTag(tagBody) {
  var closing = tagBody.charAt(0) === '/';
  var body = closing ? tagBody.slice(1) : tagBody;
  var dotIndex = body.indexOf('.');
  var spaceIndex = body.indexOf(' ');
  var nameEnd = dotIndex >= 0 && spaceIndex >= 0
    ? Math.min(dotIndex, spaceIndex)
    : (dotIndex >= 0 ? dotIndex : spaceIndex);
  var name = (nameEnd < 0 ? body : body.slice(0, nameEnd)).toLowerCase();
  var annotation = '';
  if (!closing) {
    if (name === 'v' && spaceIndex >= 0) {
      annotation = body.slice(spaceIndex + 1).trim();
    }
    else if (dotIndex >= 0) {
      annotation = body.slice(dotIndex + 1).trim();
    }
    else if (name === 'lang' && spaceIndex >= 0) {
      annotation = body.slice(spaceIndex + 1).trim();
    }
  }
  return {
    closing: closing,
    name: name,
    annotation: annotation,
  };
}

function openWebVttTagHtml(parsed) {
  var htmlTag = WEBVTT_SUPPORTED_TAGS[parsed.name];
  if (!htmlTag) return '';
  if (parsed.name === 'c') {
    if (parsed.annotation) {
      return '<span class="vtt-c ' + escapeWebVttHtml(parsed.annotation) + '">';
    }
    return '<span class="vtt-c">';
  }
  if (parsed.name === 'v') {
    var attrs = ' class="vtt-v"';
    if (parsed.annotation) {
      attrs += ' data-voice="' + escapeWebVttHtml(parsed.annotation) + '"';
    }
    return '<span' + attrs + '>';
  }
  if (parsed.name === 'lang') {
    if (parsed.annotation) {
      return '<span lang="' + escapeWebVttHtml(parsed.annotation) + '">';
    }
    return '<span>';
  }
  return '<' + htmlTag + '>';
}

function closeWebVttTagHtml(name) {
  var htmlTag = WEBVTT_SUPPORTED_TAGS[name];
  if (!htmlTag) return '';
  if (htmlTag === 'span') return '</span>';
  return '</' + htmlTag + '>';
}

export function stripWebVttMarkup(text) {
  return decodeWebVttEntities(text)
    .replace(WEBVTT_TIMESTAMP_TAG_RE, '')
    .replace(WEBVTT_TAG_RE, '');
}

export function webvttCueTextToHtml(text) {
  var input = decodeWebVttEntities(text);
  input = input.replace(WEBVTT_TIMESTAMP_TAG_RE, '');
  var result = '';
  var lastIndex = 0;
  var match;
  var tagRe = /<\/?[a-zA-Z][^>]*>/g;
  while ((match = tagRe.exec(input)) !== null) {
    result += escapeWebVttHtml(input.slice(lastIndex, match.index));
    var parsed = parseWebVttTag(match[0].slice(1, -1));
    if (!WEBVTT_SUPPORTED_TAGS[parsed.name]) {
      result += escapeWebVttHtml(match[0]);
    }
    else if (parsed.closing) {
      result += closeWebVttTagHtml(parsed.name);
    }
    else {
      result += openWebVttTagHtml(parsed);
    }
    lastIndex = tagRe.lastIndex;
  }
  result += escapeWebVttHtml(input.slice(lastIndex));
  return result;
}

export function findActiveParsedCues(cues, mediaTime) {
  if (!Array.isArray(cues) || !Number.isFinite(mediaTime)) return [];
  var active = [];
  for (var index = 0; index < cues.length; index += 1) {
    var cue = cues[index];
    if (mediaTime >= cue.start && mediaTime < cue.end) active.push(cue);
  }
  return active;
}
