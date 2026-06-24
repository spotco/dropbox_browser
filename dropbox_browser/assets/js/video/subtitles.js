import {
  findActiveParsedCues,
  parseWebVttCues,
  rebaseWebVttText,
  stripWebVttMarkup,
  webvttCueTextToHtml,
} from '../video-core.js';
import {SUBTITLE_PREVIEW_MAX_CHARS} from './constants.js';

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
  if (ctx.els.debugCurrentCueEl) {
    ctx.els.debugCurrentCueEl.textContent = 'No active subtitle cue.';
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

function subtitlesAreMounted(item, streamIndex, seekSeconds) {
  if (!item || (item.path || '') !== ctx.activeItemPath()) return false;
  var mountedSeek = Math.max(0, Number(ctx.state.subtitleMountedSeekSeconds) || 0);
  var requestedSeek = Math.max(0, Number(seekSeconds) || 0);
  if (Math.abs(mountedSeek - requestedSeek) > 0.05) return false;
  var normalized = normalizeSubtitleStreamIndex(streamIndex);
  var mounted = normalizeSubtitleStreamIndex(ctx.state.subtitleMountedStreamIndex);
  if (normalized === null || mounted === null || normalized !== mounted) return false;
  var textTrack = managedSubtitleTextTrack();
  return subtitleTrackIsActive(textTrack);
}

function ensureSubtitlesAfterPlaybackReady(reason) {
  var active = ctx.activeQueueItem();
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
  track.label = subtitleStream ? ctx.subtitleTrackLabel(subtitleStream) : 'Subtitles';
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
  try {
    if (!cachedPayload) {
      cachedPayload = await ctx.ensureSubtitleTracksForItem(item);
      if (!cachedPayload || item.path !== ctx.activeItemPath()) return;
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
    ctx.reportSubtitleSyncDiagnostic({
      level: 'error',
      message: 'Subtitle extraction failed',
      error_message: error && error.message ? String(error.message) : 'unknown',
      subtitle_stream_index: streamIndex,
    });
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
  ctx.preloadAllSubtitleVttsForItem = preloadAllSubtitleVttsForItem;
  ctx.subtitlePlaybackRequestIsStale = subtitlePlaybackRequestIsStale;
  ctx.updateSubtitleDebugForStream = updateSubtitleDebugForStream;
  ctx.mountSubtitleTrackForItem = mountSubtitleTrackForItem;
  ctx.scheduleSubtitlesAfterPlaybackReady = scheduleSubtitlesAfterPlaybackReady;
  ctx.applySubtitlesForSeek = applySubtitlesForSeek;
  ctx.subtitlesApi = {
    applyForSeek: applySubtitlesForSeek,
  };
}