import {
  HLS_SEGMENT_DURATION_SECONDS,
  findActiveParsedCues,
  parseWebVttCues,
  rebaseWebVttText,
  stripWebVttMarkup,
  webvttCueTextToHtml,
} from '../video-core.js';
import {
  SUBTITLE_PREVIEW_MAX_CHARS,
  SUBTITLE_WINDOW_DURATION_SECONDS,
  SUBTITLE_WINDOW_SEEK_LAG_SECONDS,
  SUBTITLE_WINDOW_SEEK_LEAD_SECONDS,
  SUBTITLE_WINDOW_OVERLAP_SECONDS,
} from './constants.js';

export function initSubtitles(ctx) {
function flushNativeSubtitleRenderSurface() {
  clearSubtitleOverlay();
  if (!ctx.els.videoEl) return;
  var video = ctx.els.videoEl;
  ctx.hideVideoElement();
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
  ctx.destroyHlsController();
  video.removeAttribute('src');
  try {
    video.load();
  }
  catch (_loadError) {
    // Best-effort load to flush native text-track rendering on MSE/HLS playback.
  }
}

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
  if (ctx.els.debugCurrentTitleEl) {
    ctx.els.debugCurrentTitleEl.textContent = 'Current Subtitle';
  }
  if (ctx.els.debugCurrentCueEl) {
    ctx.els.debugCurrentCueEl.textContent = 'No active subtitle cue.';
  }
  if (ctx.els.debugNextTitleEl) {
    ctx.els.debugNextTitleEl.textContent = 'Next Subtitle';
  }
  if (ctx.els.debugNextCueEl) {
    ctx.els.debugNextCueEl.textContent = 'No upcoming subtitle cue.';
  }
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
  ctx.els.subtitleOverlayEl.replaceChildren();
  ctx.els.subtitleOverlayEl.hidden = true;
  ctx.els.subtitleOverlayEl.classList.add('hidden');
}

function buildSubtitleOverlayHtml(textTrack, parsedCues, mediaTime) {
  if (Array.isArray(parsedCues) && parsedCues.length && Number.isFinite(mediaTime)) {
    var parsedHtmlParts = [];
    var activeParsedCues = findActiveParsedCues(parsedCues, mediaTime);
    for (var parsedIndex = 0; parsedIndex < activeParsedCues.length; parsedIndex += 1) {
      var parsedHtml = webvttCueTextToHtml(activeParsedCues[parsedIndex].rawText);
      if (parsedHtml) parsedHtmlParts.push(parsedHtml);
    }
    return parsedHtmlParts.join('<br>');
  }
  var texts = collectActiveSubtitleTexts(textTrack);
  if (!texts.length) return '';
  return texts.map(function (text) {
    return webvttCueTextToHtml(text);
  }).join('<br>');
}

function syncSubtitleOverlayDisplay() {
  if (!ctx.els.subtitleOverlayEl) return;
  var mediaTime = ctx.els.videoEl ? Number(ctx.els.videoEl.currentTime) : NaN;
  var textTrack = managedSubtitleTextTrack();
  var overlayHtml = buildSubtitleOverlayHtml(
    textTrack,
    ctx.state.subtitleDebug.cues,
    mediaTime
  );
  if (!overlayHtml) {
    clearSubtitleOverlay();
    return;
  }
  ctx.els.subtitleOverlayEl.innerHTML = overlayHtml;
  ctx.els.subtitleOverlayEl.hidden = false;
  ctx.els.subtitleOverlayEl.classList.remove('hidden');
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

function subtitleWindowCacheForPath(path) {
  var key = String(path || '');
  if (!key) return null;
  if (!ctx.state.subtitleWindowCacheByPath[key]) {
    ctx.state.subtitleWindowCacheByPath[key] = Object.create(null);
  }
  return ctx.state.subtitleWindowCacheByPath[key];
}

function subtitleWindowInFlightForPath(path) {
  var key = String(path || '');
  if (!key) return null;
  if (!ctx.state.subtitleWindowInFlightByPath[key]) {
    ctx.state.subtitleWindowInFlightByPath[key] = Object.create(null);
  }
  return ctx.state.subtitleWindowInFlightByPath[key];
}

function subtitleCoverageForPath(path) {
  var key = String(path || '');
  if (!key) return null;
  if (!ctx.state.subtitleCoverageByPath[key]) {
    ctx.state.subtitleCoverageByPath[key] = Object.create(null);
  }
  return ctx.state.subtitleCoverageByPath[key];
}

function subtitleBackgroundCoverageForPath(path) {
  var key = String(path || '');
  if (!key) return null;
  if (!ctx.state.subtitleBackgroundCoverageByPath[key]) {
    ctx.state.subtitleBackgroundCoverageByPath[key] = Object.create(null);
  }
  return ctx.state.subtitleBackgroundCoverageByPath[key];
}

function subtitleMountedWindowForPath(path) {
  var key = String(path || '');
  if (!key) return null;
  if (!ctx.state.subtitleMountedWindowByPath[key]) {
    ctx.state.subtitleMountedWindowByPath[key] = Object.create(null);
  }
  return ctx.state.subtitleMountedWindowByPath[key];
}

function subtitleWindowRequestKey(subtitleStreamIndex, windowStartSeconds, windowDurationSeconds) {
  return String(subtitleStreamIndex)
    + '|'
    + String(Math.max(0, Number(windowStartSeconds) || 0))
    + '|'
    + String(Math.max(0, Number(windowDurationSeconds) || 0));
}

function subtitleWindowInFlightKey(subtitleStreamIndex, windowStartSeconds, windowDurationSeconds, windowStatus, playbackSyncToken) {
  return subtitleWindowRequestKey(subtitleStreamIndex, windowStartSeconds, windowDurationSeconds)
    + '|'
    + String(windowStatus || 'requested')
    + '|'
    + String(playbackSyncToken === undefined || playbackSyncToken === null ? '' : playbackSyncToken);
}

function mergedSubtitleRanges(ranges) {
  if (!Array.isArray(ranges) || !ranges.length) return [];
  var normalized = ranges
    .map(function (range) {
      if (!range) return null;
      var start = Math.max(0, Number(range.start_seconds) || 0);
      var end = Math.max(start, Number(range.end_seconds) || 0);
      return {start_seconds: start, end_seconds: end};
    })
    .filter(Boolean)
    .sort(function (left, right) {
      if (left.start_seconds !== right.start_seconds) return left.start_seconds - right.start_seconds;
      return left.end_seconds - right.end_seconds;
    });
  if (!normalized.length) return [];
  var merged = [normalized[0]];
  normalized.slice(1).forEach(function (range) {
    var current = merged[merged.length - 1];
    if (range.start_seconds <= current.end_seconds + SUBTITLE_WINDOW_OVERLAP_SECONDS) {
      current.end_seconds = Math.max(current.end_seconds, range.end_seconds);
      return;
    }
    merged.push({start_seconds: range.start_seconds, end_seconds: range.end_seconds});
  });
  return merged;
}

function subtitleRangesCoverWindow(ranges, windowStartSeconds, windowEndSeconds) {
  var start = Math.max(0, Number(windowStartSeconds) || 0);
  var end = Math.max(start, Number(windowEndSeconds) || 0);
  return mergedSubtitleRanges(ranges).some(function (range) {
    return start >= range.start_seconds && end <= range.end_seconds + SUBTITLE_WINDOW_OVERLAP_SECONDS;
  });
}

function mergeSubtitleCoverageRanges(existingRanges, incomingRanges) {
  return mergedSubtitleRanges([]
    .concat(Array.isArray(existingRanges) ? existingRanges : [])
    .concat(Array.isArray(incomingRanges) ? incomingRanges : []));
}

function storeSubtitleWindowPayload(path, subtitleStreamIndex, payload, options) {
  var cache = subtitleWindowCacheForPath(path);
  if (!cache || !payload) return;
  var requestKey = subtitleWindowRequestKey(
    subtitleStreamIndex,
    payload.window_start_seconds,
    Math.max(0, (Number(payload.window_end_seconds) || 0) - (Number(payload.window_start_seconds) || 0))
  );
  cache[requestKey] = payload;
  var coverage = subtitleCoverageForPath(path);
  if (coverage) {
    coverage[String(subtitleStreamIndex)] = mergeSubtitleCoverageRanges(
      coverage[String(subtitleStreamIndex)],
      payload.loaded_ranges
    );
  }
  if (options && options.background) {
    var backgroundCoverage = subtitleBackgroundCoverageForPath(path);
    if (backgroundCoverage) {
      backgroundCoverage[String(subtitleStreamIndex)] = mergeSubtitleCoverageRanges(
        backgroundCoverage[String(subtitleStreamIndex)],
        payload.loaded_ranges
      );
    }
  }
  if (options && options.mounted) {
    var mountedCoverage = subtitleMountedWindowForPath(path);
    if (mountedCoverage) {
      mountedCoverage[String(subtitleStreamIndex)] = {
        start_seconds: Math.max(0, Number(payload.window_start_seconds) || 0),
        end_seconds: Math.max(0, Number(payload.window_end_seconds) || 0),
      };
    }
  }
  if (typeof ctx.syncPlaybackProgress === 'function') {
    ctx.syncPlaybackProgress();
  }
}

function subtitlePayloadTrackIndex(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.track !== undefined && payload.track !== null) {
    return normalizeSubtitleStreamIndex(payload.track);
  }
  return normalizeSubtitleStreamIndex(payload.subtitle_stream_index);
}

function subtitlePayloadRanges(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.loaded_ranges) && payload.loaded_ranges.length) {
    return payload.loaded_ranges;
  }
  return [{
    start_seconds: Math.max(0, Number(payload.window_start_seconds) || 0),
    end_seconds: Math.max(0, Number(payload.window_end_seconds) || 0),
  }];
}

function cachedSubtitleWindowPayload(path, subtitleStreamIndex, mediaTimeSeconds) {
  var cache = subtitleWindowCacheForPath(path);
  if (!cache) return null;
  var normalized = normalizeSubtitleStreamIndex(subtitleStreamIndex);
  if (normalized === null) return null;
  var requestedTime = Math.max(0, Number(mediaTimeSeconds) || 0);
  var bestPayload = null;
  var bestSpan = Number.POSITIVE_INFINITY;
  Object.keys(cache).forEach(function (key) {
    var payload = cache[key];
    if (subtitlePayloadTrackIndex(payload) !== normalized) return;
    if (!subtitleRangesCoverWindow(subtitlePayloadRanges(payload), requestedTime, requestedTime)) return;
    var start = Math.max(0, Number(payload.window_start_seconds) || 0);
    var end = Math.max(start, Number(payload.window_end_seconds) || 0);
    var span = end - start;
    if (span < bestSpan) {
      bestPayload = payload;
      bestSpan = span;
      return;
    }
    if (span === bestSpan && bestPayload && start > (Number(bestPayload.window_start_seconds) || 0)) {
      bestPayload = payload;
    }
  });
  return bestPayload;
}

function cachedSubtitleSourceForSeek(path, subtitleStreamIndex, seekSeconds) {
  var fullSubtitleText = getCachedFullSubtitleVtt(path, subtitleStreamIndex);
  if (fullSubtitleText) {
    return {
      sourceType: 'full',
      subtitleText: fullSubtitleText,
      payload: null,
    };
  }
  var payload = cachedSubtitleWindowPayload(path, subtitleStreamIndex, seekSeconds);
  if (!payload || typeof payload.vtt !== 'string' || !payload.vtt) return null;
  return {
    sourceType: 'window',
    subtitleText: payload.vtt,
    payload: payload,
  };
}

function subtitleCoverageRangeForTarget(path, subtitleStreamIndex, targetSeconds) {
  var coverage = subtitleCoverageForPath(path);
  if (!coverage) return null;
  var ranges = mergedSubtitleRanges(coverage[String(subtitleStreamIndex)]);
  if (!ranges.length) return null;
  var target = Math.max(0, Number(targetSeconds) || 0);
  for (var index = 0; index < ranges.length; index += 1) {
    var range = ranges[index];
    if (target >= range.start_seconds && target <= range.end_seconds + SUBTITLE_WINDOW_OVERLAP_SECONDS) {
      return range;
    }
    if (target < range.start_seconds) {
      return range;
    }
  }
  return ranges[ranges.length - 1];
}

function subtitleCoverageSummaryRange(path, subtitleStreamIndex) {
  var coverage = subtitleCoverageForPath(path);
  if (!coverage) return null;
  var ranges = mergedSubtitleRanges(coverage[String(subtitleStreamIndex)]);
  if (!ranges.length) return null;
  return {
    start_seconds: ranges[0].start_seconds,
    end_seconds: ranges[ranges.length - 1].end_seconds,
  };
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
  var normalized = stripWebVttMarkup(text).replace(/\s+/g, ' ').trim();
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
  return ctx.formatPlaybackTime(seconds);
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

function maybeLogSubtitleCueChange(displayedCue, nextCue, globalTime, trackOffsetSeconds) {
  var cueKey = buildSubtitleCueLogKey(displayedCue, globalTime);
  if (cueKey === ctx.state.subtitleDebug.lastLoggedCueKey) return;
  ctx.state.subtitleDebug.lastLoggedCueKey = cueKey;
  ctx.reportSubtitleDiagnostic({
    level: 'info',
    message: 'Subtitle cue display changed',
    absolute_cue_start: displayedCue ? trackOffsetSeconds + displayedCue.start : '',
    absolute_cue_end: displayedCue ? trackOffsetSeconds + displayedCue.end : '',
    cue_text: displayedCue ? displayedCue.text : '',
    next_absolute_cue_start: nextCue ? trackOffsetSeconds + nextCue.start : '',
    next_cue_preview: nextCue ? previewSubtitleText(nextCue.rawText) : '',
  });
}

function currentSubtitleModeLabel(textTrack, active, probePayload) {
  if (!active || !probePayload) return 'none';
  if (typeof ctx.selectedBurnedInSubtitleStreamIndex === 'function') {
    var burnedIn = ctx.selectedBurnedInSubtitleStreamIndex(active, probePayload);
    if (burnedIn !== null) return 'burn-in';
  }
  if (typeof ctx.resolvedSubtitleStreamIndex === 'function') {
    var resolved = ctx.resolvedSubtitleStreamIndex(active, probePayload);
    if (resolved === '') return 'off';
  }
  if (textTrack && textTrack.mode && textTrack.mode !== 'disabled') {
    return 'webvtt';
  }
  if (ctx.state.subtitleDebug.rawVtt) return 'webvtt';
  return 'none';
}

function formatSegmentTimestamp(totalSeconds) {
  if (typeof ctx.formatPlaybackTimeWithMilliseconds === 'function') {
    return ctx.formatPlaybackTimeWithMilliseconds(totalSeconds);
  }
  var totalMilliseconds = Math.max(0, Math.floor((Number(totalSeconds) || 0) * 1000));
  var minutes = Math.floor(totalMilliseconds / 60000);
  var seconds = Math.floor((totalMilliseconds % 60000) / 1000);
  var milliseconds = totalMilliseconds % 1000;
  return String(minutes) + ':' + String(seconds).padStart(2, '0') + ':' + String(milliseconds).padStart(3, '0');
}

function compatibilityPlaylistSegmentCountForDebug(probePayload) {
  var segmentDuration = compatibilitySegmentDurationForDebug();
  var observedMaxIndex = Math.max(
    0,
    compatibilityAbsoluteSegmentIndex(Number(ctx.state.compatibilityCurrentSegmentIndex) || 0),
    compatibilityAbsoluteSegmentIndex(Number(ctx.state.compatibilityLoadedSegmentMaxIndex) || 0)
  );
  var probeDuration = Number(probePayload && probePayload.duration_seconds) || 0;
  if (probeDuration > 0) {
    return Math.max(
      1,
      observedMaxIndex,
      Math.ceil(probeDuration / segmentDuration)
    );
  }
  var explicitCount = Number(ctx.state.compatibilityPlaylistSegmentCount) || 0;
  if (explicitCount > 0) {
    return Math.max(
      observedMaxIndex,
      compatibilityAbsoluteSegmentIndex(explicitCount)
    );
  }
  return observedMaxIndex;
}

function compatibilitySegmentDurationForDebug() {
  var serverDuration = Number(ctx.state.compatibilitySegmentDurationSeconds) || 0;
  return serverDuration > 0 ? serverDuration : HLS_SEGMENT_DURATION_SECONDS;
}

function compatibilityAbsoluteSegmentOffset() {
  var segmentDuration = compatibilitySegmentDurationForDebug();
  var sessionStartSeconds = Math.max(0, Number(ctx.state.compatibilityStartSeconds) || 0);
  return Math.floor(sessionStartSeconds / segmentDuration);
}

function compatibilityAbsoluteSegmentIndex(sessionSegmentIndex) {
  var index = Number(sessionSegmentIndex) || 0;
  if (index <= 0) return 0;
  return compatibilityAbsoluteSegmentOffset() + index;
}

function compatibilityLoadedAbsoluteSegmentIndices() {
  var keys = ctx.state.compatibilityLoadedSegmentIndicesByKey || null;
  var result = [];
  if (keys) {
    Object.keys(keys).forEach(function (key) {
      if (!keys[key]) return;
      var absoluteIndex = compatibilityAbsoluteSegmentIndex(Number(key));
      if (absoluteIndex > 0) result.push(absoluteIndex);
    });
  }
  if (!result.length) {
    var minIndex = compatibilityAbsoluteSegmentIndex(Number(ctx.state.compatibilityLoadedSegmentMinIndex) || 0);
    var maxIndex = compatibilityAbsoluteSegmentIndex(Number(ctx.state.compatibilityLoadedSegmentMaxIndex) || 0);
    if (minIndex > 0 && maxIndex >= minIndex) {
      for (var index = minIndex; index <= maxIndex; index += 1) result.push(index);
    }
  }
  result.sort(function (a, b) { return a - b; });
  return result.filter(function (value, index, values) {
    return index === 0 || value !== values[index - 1];
  });
}

function compatibilityLoadedSegmentRangeLabel(indices) {
  if (!indices.length) return '';
  var ranges = [];
  var start = indices[0];
  var end = indices[0];
  for (var index = 1; index < indices.length; index += 1) {
    var value = indices[index];
    if (value === end + 1) {
      end = value;
      continue;
    }
    ranges.push(start === end ? String(start) : (String(start) + '-' + String(end)));
    start = value;
    end = value;
  }
  ranges.push(start === end ? String(start) : (String(start) + '-' + String(end)));
  return ranges.join(', ');
}

function currentHlsSegmentSummaryLine(mediaTime, probePayload) {
  if (ctx.state.playbackMode !== 'compatibility') return 'HLS segment: none';
  var segmentDuration = compatibilitySegmentDurationForDebug();
  var normalizedMediaTime = Number.isFinite(mediaTime) && mediaTime >= 0 ? mediaTime : 0;
  var sessionSegmentIndex = Math.floor(normalizedMediaTime / segmentDuration) + 1;
  var segmentIndex = compatibilityAbsoluteSegmentIndex(sessionSegmentIndex);
  var totalSegments = compatibilityPlaylistSegmentCountForDebug(probePayload);
  var segmentStart = (Number(ctx.state.compatibilityStartSeconds) || 0)
    + ((sessionSegmentIndex - 1) * segmentDuration);
  var segmentEnd = segmentStart + segmentDuration;
  return 'HLS segment: ['
    + String(segmentIndex)
    + '/'
    + String(totalSegments || '?')
    + '] '
    + formatSegmentTimestamp(segmentStart)
    + ' - '
    + formatSegmentTimestamp(segmentEnd);
}

function loadedHlsSegmentsSummaryLine(probePayload) {
  if (ctx.state.playbackMode !== 'compatibility') return 'Loaded HLS segments: none';
  var loadedIndices = compatibilityLoadedAbsoluteSegmentIndices();
  var rangeLabel = compatibilityLoadedSegmentRangeLabel(loadedIndices);
  var totalSegments = compatibilityPlaylistSegmentCountForDebug(probePayload);
  var averageLoadMs = Number(ctx.state.compatibilitySegmentLoadAverageMs) || 0;
  var averageLoadLabel = averageLoadMs > 0 ? ((averageLoadMs / 1000).toFixed(2) + 's') : 'n/a';
  var segmentLengthLabel = compatibilitySegmentDurationForDebug().toFixed(2) + 's';
  if (!rangeLabel) {
    return 'Loaded HLS segments: none • avg load: ' + averageLoadLabel + ' • segment length: ' + segmentLengthLabel;
  }
  return 'Loaded HLS segments: ['
    + rangeLabel
    + '/'
    + String(totalSegments || '?')
    + '] • avg load: '
    + averageLoadLabel
    + ' • segment length: '
    + segmentLengthLabel;
}

function cueOrdinalLabel(baseLabel, cue, cueList) {
  var total = Array.isArray(cueList) ? cueList.length : 0;
  if (!cue || !total) return baseLabel;
  var cueIndex = cueList.indexOf(cue);
  if (cueIndex < 0) return baseLabel;
  return baseLabel + ' [' + String(cueIndex + 1) + '/' + String(total) + ']';
}

function syncSubtitleDebugDisplay() {
  if (!ctx.els.debugMetaEl || !ctx.els.debugCurrentCueEl || !ctx.els.debugNextCueEl) return;
  var mediaTime = ctx.els.videoEl ? Number(ctx.els.videoEl.currentTime) : NaN;
  var globalTime = ctx.currentGlobalPlaybackSeconds();
  var trackOffsetSeconds = subtitleTrackOffsetSeconds();
  var parsedCue = findActiveParsedCue(ctx.state.subtitleDebug.cues, mediaTime);
  var nextCue = findNextParsedCue(ctx.state.subtitleDebug.cues, mediaTime);
  var textTrack = managedSubtitleTextTrack();
  var browserCues = summarizeBrowserActiveCues(textTrack);
  var displayedCue = resolveDisplayedCue(parsedCue, browserCues);
  var active = typeof ctx.activeQueueItem === 'function' ? ctx.activeQueueItem() : null;
  var probePayload = active ? ctx.state.probeCache[active.path || ''] || null : null;
  var progressLines = typeof ctx.currentProgressDebugLines === 'function'
    ? ctx.currentProgressDebugLines()
    : [];
  var metaLines = progressLines.concat([
    'Track: ' + (ctx.state.subtitleDebug.trackLabel || 'none'),
    'Playback position (absolute): ' + formatSubtitleDebugTimestamp(globalTime),
    currentHlsSegmentSummaryLine(mediaTime, probePayload),
    loadedHlsSegmentsSummaryLine(probePayload),
    'HLS media time: ' + formatSubtitleDebugTimestamp(mediaTime),
    'Subtitle mode: ' + currentSubtitleModeLabel(textTrack, active, probePayload),
  ]);
  ctx.els.debugMetaEl.textContent = metaLines.join('\n');
  if (ctx.els.debugCurrentTitleEl) {
    ctx.els.debugCurrentTitleEl.textContent = cueOrdinalLabel('Current Subtitle', parsedCue, ctx.state.subtitleDebug.cues);
  }
  if (ctx.els.debugNextTitleEl) {
    ctx.els.debugNextTitleEl.textContent = cueOrdinalLabel('Next Subtitle', nextCue, ctx.state.subtitleDebug.cues);
  }

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
  if (typeof ctx.clearSubtitleFailureState === 'function') ctx.clearSubtitleFailureState();
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
  if (typeof ctx.clearSubtitleFailureState === 'function') ctx.clearSubtitleFailureState();
  ctx.renderSubtitleTrackSelector(item, null);
  ctx.reportSubtitleSyncDiagnostic({
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
  layoutKey = ctx.subtitleTrackLayoutKey(probePayload);
  if (!select.value) {
    ctx.setStoredSubtitleTrackPreference(layoutKey, {off: true});
    return;
  }
  var path = item.path || '';
  if (!path) return;
  ctx.state.selectedSubtitleStreamIndexByPath[path] = Number(select.value);
  stream = subtitleStreams.find(function (candidate) {
    return String(candidate.index) === String(select.value);
  }) || null;
  if (stream) ctx.setStoredSubtitleTrackPreference(layoutKey, ctx.subtitleTrackPreferenceDescriptor(subtitleStreams, stream));
}

function resolvedSubtitleStreamIndex(item, probePayload) {
  if (!item || !probePayload) return '';
  return ctx.selectedSubtitleStreamIndex(item, probePayload);
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

function subtitlesAreMounted(item, streamIndex, seekSeconds, coverageTargetSeconds) {
  if (!item || (item.path || '') !== ctx.activeItemPath()) return false;
  var mountedSeek = Math.max(0, Number(ctx.state.subtitleMountedSeekSeconds) || 0);
  var requestedSeek = Math.max(0, Number(seekSeconds) || 0);
  if (Math.abs(mountedSeek - requestedSeek) > 0.05) return false;
  var normalized = normalizeSubtitleStreamIndex(streamIndex);
  var mounted = normalizeSubtitleStreamIndex(ctx.state.subtitleMountedStreamIndex);
  if (normalized === null || mounted === null || normalized !== mounted) return false;
  var mountedCoverage = subtitleMountedWindowForPath(item.path || '');
  var activeMountedCoverage = mountedCoverage ? mountedCoverage[String(normalized)] : null;
  if (activeMountedCoverage) {
    var requestedCoverageTarget = Math.max(0, Number(
      coverageTargetSeconds === undefined ? seekSeconds : coverageTargetSeconds
    ) || 0);
    if (!subtitleRangesCoverWindow([activeMountedCoverage], requestedCoverageTarget, requestedCoverageTarget)) {
      return false;
    }
  }
  var textTrack = managedSubtitleTextTrack();
  return subtitleTrackIsActive(textTrack);
}

function ensureSubtitlesAfterPlaybackReady(reason) {
  var active = ctx.activeQueueItem();
  if (!active || ctx.state.playbackMode !== 'compatibility') return;
  if (ctx.state.seekRestartInProgress) return;
  if (ctx.state.subtitleFailureState === 'error') return;
  var probePayload = ctx.state.probeCache[active.path || ''] || null;
  if (!subtitlesEnabledForItem(active, probePayload)) return;
  if (selectedBurnedInSubtitleStreamIndex(active, probePayload) !== null) return;
  var fetchStartSeconds = Math.max(0, ctx.state.compatibilityStartSeconds || 0);
  void applySubtitlesForSeek(active, probePayload, fetchStartSeconds, {
    reloadReason: reason || 'playback-ready',
    playbackSyncToken: ctx.state.playbackSyncToken,
  });
}

function syncSubtitlesForCurrentPlaybackTime(reason) {
  var active = ctx.activeQueueItem();
  if (!active || ctx.state.playbackMode !== 'compatibility') return;
  if (ctx.state.seekRestartInProgress) return;
  if (ctx.state.subtitleFailureState === 'error') return;
  var probePayload = ctx.state.probeCache[active.path || ''] || null;
  if (!subtitlesEnabledForItem(active, probePayload)) return;
  if (selectedBurnedInSubtitleStreamIndex(active, probePayload) !== null) return;
  var streamIndex = resolvedSubtitleStreamIndex(active, probePayload);
  if (streamIndex === '') return;
  var mountedSeekSeconds = Math.max(0, Number(ctx.state.subtitleMountedSeekSeconds) || 0);
  var targetSeconds = Math.max(0, Number(ctx.currentGlobalPlaybackSeconds()) || 0);
  if (subtitlesAreMounted(active, streamIndex, mountedSeekSeconds, targetSeconds)) return;
  if (!subtitlesAlreadyActive()) return;
  var refreshKey = [
    active.path || '',
    String(streamIndex),
    String(ctx.state.playbackSyncToken),
  ].join('|');
  if (ctx.state.subtitlePlaybackRefreshInFlightKey === refreshKey) return;
  ctx.state.subtitlePlaybackRefreshInFlightKey = refreshKey;
  void applySubtitlesForSeek(active, probePayload, mountedSeekSeconds, {
    coverageTargetSeconds: targetSeconds,
    playbackSyncToken: ctx.state.playbackSyncToken,
    reloadReason: reason || 'playback-window-boundary',
    silent: true,
  }).finally(function () {
    if (ctx.state.subtitlePlaybackRefreshInFlightKey === refreshKey) {
      ctx.state.subtitlePlaybackRefreshInFlightKey = '';
    }
  });
}

function resyncSubtitleTrackAfterHlsRecovery(reason, data) {
  if (!ctx.hlsErrorTargetsCurrentSession(data)) {
    ctx.reportSubtitleDiagnostic({
      level: 'info',
      message: 'Subtitle resync skipped for stale HLS session',
      recovery_reason: reason || '',
    });
    return;
  }
  var active = ctx.activeQueueItem();
  if (!active || ctx.state.playbackMode !== 'compatibility') return;
  var probePayload = ctx.state.probeCache[active.path || ''] || null;
  if (!subtitlesEnabledForItem(active, probePayload)) return;
  ctx.reportSubtitleDiagnostic({
    level: 'info',
    message: 'Subtitle resync after HLS recovery',
    recovery_reason: reason || '',
  });
  ensureSubtitlesAfterPlaybackReady(reason || 'hls-recovery');
}

function subtitleTrackUrl(item, subtitleStreamIndex) {
  return '/video/endpoints/subtitles?path='
    + encodeURIComponent(item.path || '')
    + '&source=remote&track='
    + encodeURIComponent(String(subtitleStreamIndex));
}

function subtitleWindowUrl(item, subtitleStreamIndex, request) {
  var parts = [
    'path=' + encodeURIComponent(item.path || ''),
    'source=remote',
    'track=' + encodeURIComponent(String(subtitleStreamIndex)),
    'start=' + encodeURIComponent(String(Math.max(0, Number(request.windowStartSeconds) || 0))),
    'duration=' + encodeURIComponent(String(Math.max(0, Number(request.windowDurationSeconds) || 0))),
    'window_status=' + encodeURIComponent(String(request.windowStatus || 'requested')),
  ];
  if (request.playbackSyncToken !== undefined && request.playbackSyncToken !== null) {
    parts.push('playback_sync_token=' + encodeURIComponent(String(request.playbackSyncToken)));
  }
  return '/video/endpoints/subtitles/window?' + parts.join('&');
}

function allSubtitlesUrl(item) {
  return '/video/endpoints/subtitles/all?path='
    + encodeURIComponent(item.path || '')
    + '&source=remote';
}

function buildSubtitleWindowRequestForPlayback(seekSeconds, options) {
  var playbackSeconds = Math.max(0, Number(seekSeconds) || 0);
  if (playbackSeconds > 0) {
    return {
      windowStartSeconds: Math.max(0, playbackSeconds - SUBTITLE_WINDOW_SEEK_LEAD_SECONDS),
      windowDurationSeconds: SUBTITLE_WINDOW_DURATION_SECONDS,
      windowStatus: (options && options.windowStatus) || 'seek',
      playbackSyncToken: options ? options.playbackSyncToken : null,
    };
  }
  return {
    windowStartSeconds: 0,
    windowDurationSeconds: SUBTITLE_WINDOW_DURATION_SECONDS,
    windowStatus: (options && options.windowStatus) || 'startup',
    playbackSyncToken: options ? options.playbackSyncToken : null,
  };
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

async function preloadSubtitleWindowForStream(item, subtitleStreamIndex, seekSeconds, options) {
  options = options || {};
  if (!item || !item.path) return null;
  var path = item.path || '';
  var request = buildSubtitleWindowRequestForPlayback(seekSeconds, options);
  var cachedCoverage = subtitleCoverageForPath(path);
  var currentCoverage = cachedCoverage ? cachedCoverage[String(subtitleStreamIndex)] : null;
  var windowEndSeconds = request.windowStartSeconds + request.windowDurationSeconds;
  if (subtitleRangesCoverWindow(currentCoverage, request.windowStartSeconds, windowEndSeconds)) {
    var cachedWindows = subtitleWindowCacheForPath(path);
    if (cachedWindows) {
      var exactKey = subtitleWindowRequestKey(
        subtitleStreamIndex,
        request.windowStartSeconds,
        request.windowDurationSeconds
      );
      if (cachedWindows[exactKey]) {
        ctx.reportSubtitleSyncDiagnostic({
          level: 'info',
          message: 'Subtitle window cache hit',
          subtitle_stream_index: subtitleStreamIndex,
          request_window_start_seconds: request.windowStartSeconds,
          request_window_end_seconds: windowEndSeconds,
          request_window_status: request.windowStatus,
          cache_hit: true,
        });
        return cachedWindows[exactKey];
      }
    }
  }
  var inflight = subtitleWindowInFlightForPath(path);
  if (!inflight) return null;
  var inflightKey = subtitleWindowInFlightKey(
    subtitleStreamIndex,
    request.windowStartSeconds,
    request.windowDurationSeconds,
    request.windowStatus,
    request.playbackSyncToken
  );
  if (inflight[inflightKey]) {
    ctx.reportSubtitleSyncDiagnostic({
      level: 'info',
      message: 'Subtitle window request reused in-flight work',
      subtitle_stream_index: subtitleStreamIndex,
      request_window_start_seconds: request.windowStartSeconds,
      request_window_end_seconds: windowEndSeconds,
      request_window_status: request.windowStatus,
      cache_hit: false,
      inflight_waited: true,
    });
    return inflight[inflightKey];
  }
  var work = (async function () {
    ctx.reportSubtitleSyncDiagnostic({
      level: 'info',
      message: 'Subtitle window request started',
      subtitle_stream_index: subtitleStreamIndex,
      request_window_start_seconds: request.windowStartSeconds,
      request_window_end_seconds: windowEndSeconds,
      request_window_status: request.windowStatus,
      cache_hit: false,
      inflight_waited: false,
    });
    var response = await fetch(subtitleWindowUrl(item, subtitleStreamIndex, request));
    if (!response.ok) {
      throw new Error('Subtitle window extraction failed for track ' + String(subtitleStreamIndex) + '.');
    }
    var payload = await response.json();
    if (!payload || typeof payload !== 'object' || payload.status !== 'ok' || typeof payload.vtt !== 'string') {
      throw new Error('Invalid subtitle window payload for track ' + String(subtitleStreamIndex) + '.');
    }
    storeSubtitleWindowPayload(path, subtitleStreamIndex, payload, {
      background: true,
    });
    ctx.reportSubtitleSyncDiagnostic({
      level: 'info',
      message: 'Subtitle window request ready',
      subtitle_stream_index: subtitleStreamIndex,
      request_window_start_seconds: request.windowStartSeconds,
      request_window_end_seconds: windowEndSeconds,
      request_window_status: request.windowStatus,
      response_window_end_seconds: Number(payload.window_end_seconds) || 0,
      loaded_range_count: Array.isArray(payload.loaded_ranges) ? payload.loaded_ranges.length : 0,
      coverage_complete: Boolean(payload.coverage_complete),
      cache_hit: false,
    });
    return payload;
  })().finally(function () {
    if (inflight[inflightKey] === work) {
      delete inflight[inflightKey];
    }
  });
  inflight[inflightKey] = work;
  return work;
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
        ctx.reportSubtitleSyncDiagnostic({
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
        var stillMissingStreams = subtitleStreams.filter(function (stream) {
          return !isSubtitleVttCachedForStream(path, stream.index);
        });
        if (stillMissingStreams.length) {
          batchFailed = true;
          ctx.reportSubtitleSyncDiagnostic({
            level: 'warn',
            message: 'Subtitle batch preload returned incomplete tracks',
            expected_track_count: subtitleStreams.length,
            received_track_count: Object.keys(tracks).length,
            missing_track_indices: stillMissingStreams.map(function (stream) {
              return stream.index;
            }),
          });
        }
      }
    }
    catch (error) {
      batchFailed = true;
      ctx.reportSubtitleSyncDiagnostic({
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
          ctx.reportSubtitleSyncDiagnostic({
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

async function ensureStartupSubtitleWindowForPlayback(item, probePayload, seekSeconds, options) {
  options = options || {};
  if (!item || !probePayload || !item.path) return null;
  if (selectedBurnedInSubtitleStreamIndex(item, probePayload) !== null) return null;
  var streamIndex = resolvedSubtitleStreamIndex(item, probePayload);
  if (streamIndex === '') return null;
  if (subtitlePlaybackRequestIsStale(options)) return null;
  return preloadSubtitleWindowForStream(item, streamIndex, seekSeconds, {
    windowStatus: options.windowStatus || 'startup',
    playbackSyncToken: options.playbackSyncToken,
  });
}

function updateSubtitleDebugForStream(item, probePayload, streamIndex, fetchStartSeconds, options) {
  options = options || {};
  var normalized = normalizeSubtitleStreamIndex(streamIndex);
  if (!item || normalized === null) {
    resetSubtitleDebugState();
    return;
  }
  var coverageTargetSeconds = options.coverageTargetSeconds === undefined
    ? fetchStartSeconds
    : options.coverageTargetSeconds;
  var cachedSource = cachedSubtitleSourceForSeek(item.path || '', normalized, coverageTargetSeconds);
  if (!cachedSource) {
    resetSubtitleDebugState();
    return;
  }
  var subtitleStreams = subtitleStreamsForPayload(probePayload);
  var subtitleStream = subtitleStreams.find(function (stream) {
    return normalizeSubtitleStreamIndex(stream.index) === normalized;
  }) || null;
  var rebasedText = rebaseWebVttText(cachedSource.subtitleText, fetchStartSeconds);
  ctx.state.subtitleDebug.rawVtt = rebasedText;
  ctx.state.subtitleDebug.cues = parseWebVttCues(rebasedText);
  ctx.state.subtitleDebug.fetchStartSeconds = fetchStartSeconds;
  ctx.state.subtitleDebug.streamIndex = normalized;
  ctx.state.subtitleDebug.trackLabel = subtitleStream ? ctx.subtitleTrackLabel(subtitleStream) : 'Subtitles';
  ctx.state.subtitleDebug.lastLoggedCueKey = '';
  syncSubtitleDebugDisplay();
}

function mountSubtitleTrackForItem(item, probePayload, streamIndex, seekSeconds, options) {
  options = options || {};
  if (!item || !ctx.els.videoEl || item.path !== ctx.activeItemPath()) return false;
  if (subtitlePlaybackRequestIsStale(options)) return false;
  var normalized = normalizeSubtitleStreamIndex(streamIndex);
  if (normalized === null) {
    clearSubtitleTrack();
    return true;
  }
  var payload = probePayload || ctx.state.probeCache[item.path || ''] || null;
  if (!payload) return false;
  var requestedSeek = Math.max(0, Number(seekSeconds) || 0);
  var coverageTargetSeconds = options.coverageTargetSeconds === undefined
    ? requestedSeek
    : Math.max(0, Number(options.coverageTargetSeconds) || 0);
  var cachedSource = cachedSubtitleSourceForSeek(item.path || '', normalized, coverageTargetSeconds);
  if (!cachedSource) return false;
  ctx.reportSubtitleSyncDiagnostic({
    level: 'info',
    message: 'Subtitle mount from cache',
    subtitle_stream_index: normalized,
    subtitle_fetch_start_seconds: requestedSeek,
    coverage_target_seconds: coverageTargetSeconds,
    subtitle_cache_source: cachedSource.sourceType,
  });
  var rebasedText = rebaseWebVttText(cachedSource.subtitleText, requestedSeek);
  if (cachedSource.sourceType === 'full') {
    var staleMountedCoverage = subtitleMountedWindowForPath(item.path || '');
    if (staleMountedCoverage) {
      delete staleMountedCoverage[String(normalized)];
    }
  }
  clearSubtitleTrack();
  var subtitleStreams = subtitleStreamsForPayload(payload);
  var subtitleStream = subtitleStreams.find(function (stream) {
    return normalizeSubtitleStreamIndex(stream.index) === normalized;
  }) || null;
  var objectUrl = URL.createObjectURL(new Blob([rebasedText], {type: 'text/vtt'}));
  ctx.state.subtitleObjectUrls.push(objectUrl);
  var track = document.createElement('track');
  track.kind = 'subtitles';
  track.label = subtitleStream ? ctx.subtitleTrackLabel(subtitleStream) : 'Subtitles';
  track.srclang = subtitleStream && subtitleStream.language ? String(subtitleStream.language) : 'und';
  track.src = objectUrl;
  track.default = true;
  track.setAttribute('data-video-subtitle-track', '1');
  track.setAttribute('data-video-subtitle-stream-index', String(normalized));
  ctx.els.videoEl.appendChild(track);
  ctx.state.subtitleMountedSeekSeconds = requestedSeek;
  ctx.state.subtitleMountedStreamIndex = normalized;
  if (cachedSource.payload) {
    storeSubtitleWindowPayload(item.path || '', normalized, cachedSource.payload, {
      mounted: true,
    });
  }
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
    updateSubtitleDebugForStream(item, payload, normalized, requestedSeek, {
      coverageTargetSeconds: coverageTargetSeconds,
    });
    ctx.reportSubtitleSyncDiagnostic({
      level: 'info',
      message: 'Subtitle track mounted',
      subtitle_stream_index: normalized,
      subtitle_fetch_start_seconds: requestedSeek,
    });
  }
  if (track.readyState >= 2) activateTrack();
  else track.addEventListener('load', activateTrack, {once: true});
  if (!options.silent) ctx.setStatus('Subtitle track is ready.');
  return true;
}

function scheduleSubtitlesAfterPlaybackReady(item, probePayload, seekSeconds, syncToken, reloadReason) {
  if (!item || !probePayload) return;
  if (selectedBurnedInSubtitleStreamIndex(item, probePayload) !== null) return;
  var streamIndex = resolvedSubtitleStreamIndex(item, probePayload);
  if (streamIndex !== '' && !subtitlesAreMounted(item, streamIndex, seekSeconds)) {
    ctx.showCompatibilitySubtitleWaitStage(item);
  }
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
  var coverageTargetSeconds = options.coverageTargetSeconds === undefined
    ? fetchStartSeconds
    : Math.max(0, Number(options.coverageTargetSeconds) || 0);
  persistSubtitleSelectionFromUi(item);
  if (!item || !ctx.els.videoEl) return;
  if (subtitlePlaybackRequestIsStale(options)) return;
  var cachedPayload = probePayload || ctx.state.probeCache[item.path || ''] || null;
  var streamIndex = resolvedSubtitleStreamIndex(item, cachedPayload);
  if (streamIndex === '') {
    clearSubtitleTrack();
    return;
  }
  if (subtitlesAreMounted(item, streamIndex, fetchStartSeconds, coverageTargetSeconds)) {
    ctx.reportSubtitleSyncDiagnostic({
      level: 'info',
      message: 'Subtitle mount skipped',
      skip_reason: 'already-mounted',
    });
    return;
  }
  ctx.reportSubtitleSyncDiagnostic({
    level: 'info',
    message: 'Subtitle mount started',
    reload_reason: options.reloadReason || '',
    fetch_start_seconds: fetchStartSeconds,
  });
  if (typeof ctx.clearSubtitleFailureState === 'function') ctx.clearSubtitleFailureState();
  try {
    if (!cachedPayload) {
      cachedPayload = await ctx.ensureSubtitleTracksForItem(item);
      if (!cachedPayload || item.path !== ctx.activeItemPath()) return;
      streamIndex = resolvedSubtitleStreamIndex(item, cachedPayload);
      if (streamIndex === '') return;
    }
    if (mountSubtitleTrackForItem(item, cachedPayload, streamIndex, fetchStartSeconds, {
      playbackSyncToken: options.playbackSyncToken,
      silent: options.silent,
      coverageTargetSeconds: coverageTargetSeconds,
    })) {
      if (!options.silent) ctx.setStatus('Subtitle track is ready.');
      return;
    }
    var path = item.path || '';
    var cachedCoverage = subtitleCoverageForPath(path);
    var currentCoverage = cachedCoverage ? cachedCoverage[String(streamIndex)] : null;
    if (!subtitleRangesCoverWindow(currentCoverage, coverageTargetSeconds, coverageTargetSeconds)) {
      if (ctx.state.playbackMode === 'compatibility') {
        ctx.showCompatibilitySubtitleWaitStage(item);
      }
      ctx.reportSubtitleSyncDiagnostic({
        level: 'info',
        message: 'Subtitle waiting on missing coverage',
        subtitle_stream_index: streamIndex,
        coverage_target_seconds: coverageTargetSeconds,
        request_window_status: coverageTargetSeconds > 0 ? 'seek' : 'startup',
      });
      ctx.setStatus('Loading subtitle track.');
      await preloadSubtitleWindowForStream(item, streamIndex, coverageTargetSeconds, {
        windowStatus: coverageTargetSeconds > 0 ? 'seek' : 'startup',
        playbackSyncToken: options.playbackSyncToken,
      });
    }
    else {
      await preloadAllSubtitleVttsForItem(item, cachedPayload);
    }
    if (subtitlePlaybackRequestIsStale(options)) return;
    cachedPayload = cachedPayload || ctx.state.probeCache[item.path || ''] || null;
    if (!mountSubtitleTrackForItem(item, cachedPayload, streamIndex, fetchStartSeconds, {
      playbackSyncToken: options.playbackSyncToken,
      silent: options.silent,
      coverageTargetSeconds: coverageTargetSeconds,
    })) {
      throw new Error('Subtitle mount failed.');
    }
  }
  catch (error) {
    ctx.reportSubtitleSyncDiagnostic({
      level: 'error',
      message: 'Subtitle extraction failed',
      error_message: error && error.message ? String(error.message) : 'unknown',
      subtitle_stream_index: streamIndex,
    });
    if (ctx.state.playbackMode === 'compatibility' && typeof ctx.hideLoadingOverlay === 'function') {
      ctx.hideLoadingOverlay();
    }
    if (typeof ctx.showSubtitleFailureState === 'function') {
      if (!subtitlesAlreadyActive()) {
        ctx.showSubtitleFailureState({
          title: 'Subtitle loading failed',
          meta: 'The selected subtitle track could not be extracted for the requested playback window.',
        });
      }
      else {
        ctx.showSubtitleFailureState({
          title: 'Subtitle refresh failed',
          meta: 'Keeping the previous subtitle window because the requested subtitle range could not be extracted.',
        });
      }
    }
    if (!subtitlesAlreadyActive()) {
      ctx.setStatus('Subtitle extraction failed.');
      ctx.setPlaybackSummary(ctx.activeItemTitle(item), 'Selected subtitle track could not be converted to WebVTT.');
    }
    else {
      ctx.setStatus('Subtitle refresh failed; keeping the previous subtitle track.');
    }
  }
}

  ctx.flushNativeSubtitleRenderSurface = flushNativeSubtitleRenderSurface;
  ctx.resetSubtitleDebugState = resetSubtitleDebugState;
  ctx.subtitleTrackIsActive = subtitleTrackIsActive;
  ctx.collectActiveSubtitleTexts = collectActiveSubtitleTexts;
  ctx.clearSubtitleOverlay = clearSubtitleOverlay;
  ctx.buildSubtitleOverlayHtml = buildSubtitleOverlayHtml;
  ctx.syncSubtitleOverlayDisplay = syncSubtitleOverlayDisplay;
  ctx.subtitleFullVttCacheForPath = subtitleFullVttCacheForPath;
  ctx.getCachedFullSubtitleVtt = getCachedFullSubtitleVtt;
  ctx.storeFullSubtitleVtt = storeFullSubtitleVtt;
  ctx.subtitleWindowCacheForPath = subtitleWindowCacheForPath;
  ctx.subtitleCoverageForPath = subtitleCoverageForPath;
  ctx.subtitleMountedWindowForPath = subtitleMountedWindowForPath;
  ctx.storeSubtitleWindowPayload = storeSubtitleWindowPayload;
  ctx.cachedSubtitleWindowPayload = cachedSubtitleWindowPayload;
  ctx.subtitleCoverageRangeForTarget = subtitleCoverageRangeForTarget;
  ctx.subtitleCoverageSummaryRange = subtitleCoverageSummaryRange;
  ctx.findActiveParsedCue = findActiveParsedCue;
  ctx.findNextParsedCue = findNextParsedCue;
  ctx.subtitleTrackOffsetSeconds = subtitleTrackOffsetSeconds;
  ctx.formatAbsoluteCueTimestamp = formatAbsoluteCueTimestamp;
  ctx.formatAbsoluteCueRange = formatAbsoluteCueRange;
  ctx.previewSubtitleText = previewSubtitleText;
  ctx.resolveDisplayedCue = resolveDisplayedCue;
  ctx.formatDisplayedCueBlock = formatDisplayedCueBlock;
  ctx.formatUpcomingCueBlock = formatUpcomingCueBlock;
  ctx.managedSubtitleTextTrack = managedSubtitleTextTrack;
  ctx.summarizeBrowserCue = summarizeBrowserCue;
  ctx.summarizeBrowserActiveCues = summarizeBrowserActiveCues;
  ctx.formatSubtitleDebugTimestamp = formatSubtitleDebugTimestamp;
  ctx.buildSubtitleCueLogKey = buildSubtitleCueLogKey;
  ctx.maybeLogSubtitleCueChange = maybeLogSubtitleCueChange;
  ctx.syncSubtitleDebugDisplay = syncSubtitleDebugDisplay;
  ctx.bindSubtitleTextTrackEvents = bindSubtitleTextTrackEvents;
  ctx.normalizeSubtitleStreamIndex = normalizeSubtitleStreamIndex;
  ctx.revokeSubtitleObjectUrls = revokeSubtitleObjectUrls;
  ctx.disableNativeSubtitleTracks = disableNativeSubtitleTracks;
  ctx.clearSubtitleTrack = clearSubtitleTrack;
  ctx.resetSubtitlesForActiveItemChange = resetSubtitlesForActiveItemChange;
  ctx.persistSubtitleSelectionFromUi = persistSubtitleSelectionFromUi;
  ctx.resolvedSubtitleStreamIndex = resolvedSubtitleStreamIndex;
  ctx.subtitlesEnabledForItem = subtitlesEnabledForItem;
  ctx.selectedSubtitleStream = selectedSubtitleStream;
  ctx.selectedBurnedInSubtitleStreamIndex = selectedBurnedInSubtitleStreamIndex;
  ctx.compatibilitySessionHasBurnedInSubtitles = compatibilitySessionHasBurnedInSubtitles;
  ctx.subtitlesAlreadyActive = subtitlesAlreadyActive;
  ctx.subtitlesAreMounted = subtitlesAreMounted;
  ctx.ensureSubtitlesAfterPlaybackReady = ensureSubtitlesAfterPlaybackReady;
  ctx.syncSubtitlesForCurrentPlaybackTime = syncSubtitlesForCurrentPlaybackTime;
  ctx.resyncSubtitleTrackAfterHlsRecovery = resyncSubtitleTrackAfterHlsRecovery;
  ctx.subtitleTrackUrl = subtitleTrackUrl;
  ctx.allSubtitlesUrl = allSubtitlesUrl;
  ctx.subtitleStreamsForPayload = subtitleStreamsForPayload;
  ctx.subtitleStreamSupportsWebVtt = subtitleStreamSupportsWebVtt;
  ctx.subtitleStreamRequiresBurnIn = subtitleStreamRequiresBurnIn;
  ctx.webvttCompatibleSubtitleStreams = webvttCompatibleSubtitleStreams;
  ctx.isSubtitleVttCachedForStream = isSubtitleVttCachedForStream;
  ctx.allSubtitleTracksCachedForItem = allSubtitleTracksCachedForItem;
  ctx.preloadSubtitleVttForStream = preloadSubtitleVttForStream;
  ctx.preloadSubtitleWindowForStream = preloadSubtitleWindowForStream;
  ctx.preloadAllSubtitleVttsForItem = preloadAllSubtitleVttsForItem;
  ctx.ensureStartupSubtitleWindowForPlayback = ensureStartupSubtitleWindowForPlayback;
  ctx.subtitlePlaybackRequestIsStale = subtitlePlaybackRequestIsStale;
  ctx.updateSubtitleDebugForStream = updateSubtitleDebugForStream;
  ctx.mountSubtitleTrackForItem = mountSubtitleTrackForItem;
  ctx.scheduleSubtitlesAfterPlaybackReady = scheduleSubtitlesAfterPlaybackReady;
  ctx.applySubtitlesForSeek = applySubtitlesForSeek;
  ctx.subtitlesApi = {
    applyForSeek: applySubtitlesForSeek,
  };
}
