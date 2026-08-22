import Hls from '../vendor/hls.js';
import {
  clampCompatibilityRestartTargetSeconds,
  compatibilityInSessionSeekDecision,
  compatibilityRecoveryRequiresSessionRestart,
  HLS_SEGMENT_DURATION_SECONDS,
  playbackDurationSeconds,
  shouldApplyDeferredCompatibilitySeek,
} from '../video-core.js';
import {
  COMPATIBILITY_PROGRESS_REPORT_BURST_MS,
  COMPATIBILITY_PROGRESS_REPORT_BURST_WINDOW_MS,
  COMPATIBILITY_PROGRESS_REPORT_STARTUP_SECONDS,
  COMPATIBILITY_PROGRESS_REPORT_STEADY_MS,
  COMPATIBILITY_RECOVERY_MAX_DELAY_MS,
  COMPATIBILITY_RECOVERY_MIN_DELAY_MS,
  COMPATIBILITY_SESSION_STATUS_POLL_MS,
  COMPATIBILITY_START_BUFFER_FRAGMENTS,
  COMPATIBILITY_SUBTITLE_WAIT_META,
} from './constants.js';
import {setPlaylistPlaybackStatus} from '../media-library/shared.js';

export function initCompatibility(ctx) {
function clearCompatibilitySessionStatusPoll() {
  if (!ctx.state.compatibilitySessionStatusTimer) return;
  window.clearTimeout(ctx.state.compatibilitySessionStatusTimer);
  ctx.state.compatibilitySessionStatusTimer = 0;
}

function scheduleCompatibilitySessionStatusPoll() {
  clearCompatibilitySessionStatusPoll();
  if (!ctx.state.paneActive || !ctx.state.compatibilitySessionId || ctx.state.playbackMode !== 'compatibility') return;
  ctx.state.compatibilitySessionStatusTimer = window.setTimeout(function () {
    ctx.state.compatibilitySessionStatusTimer = 0;
    void pollCompatibilitySessionStatus();
  }, COMPATIBILITY_SESSION_STATUS_POLL_MS);
}

async function pollCompatibilitySessionStatus() {
  var localSessionId = String(ctx.state.compatibilitySessionId || '');
  if (
    !ctx.state.paneActive
    || !localSessionId
    || ctx.state.playbackMode !== 'compatibility'
    || ctx.state.compatibilitySessionStatusRequestInFlight
  ) {
    return;
  }
  ctx.state.compatibilitySessionStatusRequestInFlight = true;
  try {
    var response = await fetch('/video/endpoints/status?id=' + encodeURIComponent(localSessionId));
    if (!response.ok) return;
    var payload = await response.json();
    var sessions = payload && Array.isArray(payload.active_sessions) ? payload.active_sessions : [];
    var localSession = sessions.length ? sessions[0] : null;
    if (
      !localSession
      && payload
      && payload.active_session
      && payload.active_session.session_id === localSessionId
    ) {
      localSession = payload.active_session;
    }
    if (
      localSession
      && localSession.session_id === localSessionId
      && localSession.path === ctx.state.compatibilitySessionPath
    ) {
      ctx.state.compatibilityEncodedMediaEndSeconds = Math.max(
        ctx.state.compatibilityEncodedMediaEndSeconds || 0,
        Number(localSession.encoded_media_end_seconds) || 0
      );
      ctx.syncPlaybackProgress();
    }
  }
  catch (_error) {
    return;
  }
  finally {
    ctx.state.compatibilitySessionStatusRequestInFlight = false;
    scheduleCompatibilitySessionStatusPoll();
  }
}

function clearCompatibilitySessionProgressReport() {
  if (!ctx.state.compatibilitySessionProgressTimer) return;
  window.clearTimeout(ctx.state.compatibilitySessionProgressTimer);
  ctx.state.compatibilitySessionProgressTimer = 0;
}

function compatibilityMediaPlaybackSeconds() {
  if (!ctx.els.videoEl) return 0;
  var mediaTime = Number(ctx.els.videoEl.currentTime);
  return Number.isFinite(mediaTime) && mediaTime >= 0 ? mediaTime : 0;
}

function compatibilityPlaybackState() {
  if (ctx.state.playbackMode !== 'compatibility' || !ctx.state.compatibilitySessionId) return 'unknown';
  if (!ctx.els.videoEl) return ctx.playbackShouldBeRunning() ? 'playing' : 'paused';
  if (ctx.els.videoEl.ended) return 'paused';
  return ctx.els.videoEl.paused ? 'paused' : 'playing';
}

function updateCompatibilityCurrentSegmentIndex() {
  var mediaSeconds = compatibilityMediaPlaybackSeconds();
  if (!Number.isFinite(mediaSeconds) || mediaSeconds < 0) {
    ctx.state.compatibilityCurrentSegmentIndex = 0;
    return;
  }
  ctx.state.compatibilityCurrentSegmentIndex = Math.floor(mediaSeconds / HLS_SEGMENT_DURATION_SECONDS) + 1;
}

function compatibilitySegmentLoadNowMs() {
  if (typeof window !== 'undefined' && window.performance && typeof window.performance.now === 'function') {
    return window.performance.now();
  }
  return Date.now();
}

function compatibilitySegmentLoadKey(data) {
  if (!data || !data.frag || data.frag.sn === 'initSegment') return '';
  if (data.part) return '';
  var segmentNumber = Number(data.frag.sn);
  if (!Number.isFinite(segmentNumber)) return '';
  return String(segmentNumber);
}

function compatibilitySegmentLoadStats(data) {
  if (!data) return null;
  if (data.part && data.part.stats) return data.part.stats;
  if (data.frag && data.frag.stats) return data.frag.stats;
  if (data.stats) return data.stats;
  return null;
}

function compatibilitySegmentLoadDurationMs(data) {
  var stats = compatibilitySegmentLoadStats(data);
  var loading = stats && stats.loading ? stats.loading : null;
  if (!loading) return null;
  var start = Number(loading.start);
  var end = Number(loading.end);
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
    return Math.round(end - start);
  }
  var first = Number(loading.first);
  if (Number.isFinite(start) && Number.isFinite(first) && first >= start) {
    return Math.round(first - start);
  }
  return null;
}

function compatibilitySegmentLoadedAtMs(data) {
  var stats = compatibilitySegmentLoadStats(data);
  var loading = stats && stats.loading ? stats.loading : null;
  var end = loading ? Number(loading.end) : NaN;
  if (Number.isFinite(end) && end >= 0) return end;
  return compatibilitySegmentLoadNowMs();
}

function compatibilitySegmentLoadStartedAtMs(data) {
  var stats = compatibilitySegmentLoadStats(data);
  var loading = stats && stats.loading ? stats.loading : null;
  var start = loading ? Number(loading.start) : NaN;
  if (Number.isFinite(start) && start >= 0) return start;
  var segmentKey = compatibilitySegmentLoadKey(data);
  var pendingStarts = ctx.state.compatibilityPendingSegmentLoadStartMsByKey || null;
  var pendingStartMs = segmentKey && pendingStarts ? Number(pendingStarts[segmentKey]) : NaN;
  if (Number.isFinite(pendingStartMs)) return pendingStartMs;
  return compatibilitySegmentLoadNowMs();
}

function recordCompatibilitySegmentFetchDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  var nextCount = (Number(ctx.state.compatibilitySegmentFetchSampleCount) || 0) + 1;
  var priorAverage = Number(ctx.state.compatibilitySegmentFetchAverageMs) || 0;
  ctx.state.compatibilitySegmentFetchAverageMs = ((priorAverage * (nextCount - 1)) + durationMs) / nextCount;
  ctx.state.compatibilitySegmentFetchSampleCount = nextCount;
}

function recordCompatibilitySegmentLoadArrival(startedAtMs, loadedAtMs) {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(loadedAtMs)) return;
  if (!Number.isFinite(Number(ctx.state.compatibilitySegmentLoadWindowStartMs))) {
    ctx.state.compatibilitySegmentLoadWindowStartMs = startedAtMs;
  }
  var nextCount = (Number(ctx.state.compatibilitySegmentLoadSampleCount) || 0) + 1;
  var windowStartMs = Number(ctx.state.compatibilitySegmentLoadWindowStartMs);
  ctx.state.compatibilitySegmentLoadAverageMs = Math.max(0, loadedAtMs - windowStartMs) / nextCount;
  ctx.state.compatibilitySegmentLoadSampleCount = nextCount;
}

function noteCompatibilityFragmentLoading(data) {
  var segmentKey = compatibilitySegmentLoadKey(data);
  if (!segmentKey) return;
  if (!ctx.state.compatibilityPendingSegmentLoadStartMsByKey) {
    ctx.state.compatibilityPendingSegmentLoadStartMsByKey = Object.create(null);
  }
  ctx.state.compatibilityPendingSegmentLoadStartMsByKey[segmentKey] = compatibilitySegmentLoadNowMs();
}

function noteCompatibilityFragmentLoaded(data) {
  if (!data || !data.frag || data.frag.sn === 'initSegment') return;
  var durationMs = compatibilitySegmentLoadDurationMs(data);
  var startedAtMs = compatibilitySegmentLoadStartedAtMs(data);
  var loadedAtMs = compatibilitySegmentLoadedAtMs(data);
  var segmentKey = compatibilitySegmentLoadKey(data);
  var pendingStarts = ctx.state.compatibilityPendingSegmentLoadStartMsByKey || null;
  var pendingStartMs = segmentKey && pendingStarts ? Number(pendingStarts[segmentKey]) : NaN;
  if (segmentKey && pendingStarts && Object.prototype.hasOwnProperty.call(pendingStarts, segmentKey)) {
    delete pendingStarts[segmentKey];
  }
  if (!Number.isFinite(durationMs)) {
    if (Number.isFinite(pendingStartMs)) {
      durationMs = compatibilitySegmentLoadNowMs() - pendingStartMs;
    }
  }
  recordCompatibilitySegmentFetchDuration(durationMs);
  recordCompatibilitySegmentLoadArrival(startedAtMs, loadedAtMs);
}

function armCompatibilityProgressBurst() {
  ctx.state.compatibilityProgressBurstUntilMs = Date.now() + COMPATIBILITY_PROGRESS_REPORT_BURST_WINDOW_MS;
}

function compatibilitySessionProgressReportDelayMs() {
  if ((ctx.state.compatibilityProgressBurstUntilMs || 0) > Date.now()) {
    return COMPATIBILITY_PROGRESS_REPORT_BURST_MS;
  }
  if (compatibilityMediaPlaybackSeconds() < COMPATIBILITY_PROGRESS_REPORT_STARTUP_SECONDS) {
    return COMPATIBILITY_PROGRESS_REPORT_BURST_MS;
  }
  return COMPATIBILITY_PROGRESS_REPORT_STEADY_MS;
}

function compatibilityProgressReportingActive(expectedSessionId, expectedSyncToken) {
  if (!ctx.state.paneActive) return false;
  if (!ctx.state.compatibilitySessionId) return false;
  if (ctx.state.playbackMode !== 'compatibility') return false;
  if (expectedSessionId && ctx.state.compatibilitySessionId !== expectedSessionId) return false;
  if (Number.isFinite(expectedSyncToken) && ctx.state.playbackSyncToken !== expectedSyncToken) return false;
  var active = ctx.activeQueueItem();
  return Boolean(active && active.path && ctx.state.compatibilitySessionPath === active.path);
}

function scheduleCompatibilitySessionProgressReport(delayMs, options) {
  clearCompatibilitySessionProgressReport();
  if (!compatibilityProgressReportingActive()) return;
  var normalizedDelay = Number.isFinite(Number(delayMs))
    ? Math.max(0, Number(delayMs))
    : compatibilitySessionProgressReportDelayMs();
  var expectedSessionId = options && options.expectedSessionId
    ? String(options.expectedSessionId)
    : String(ctx.state.compatibilitySessionId || '');
  var expectedSyncToken = Number.isFinite(Number(options && options.expectedSyncToken))
    ? Number(options.expectedSyncToken)
    : ctx.state.playbackSyncToken;
  ctx.state.compatibilitySessionProgressTimer = window.setTimeout(function () {
    ctx.state.compatibilitySessionProgressTimer = 0;
    void reportCompatibilitySessionProgress(options && options.reason ? options.reason : 'timer', {
      reschedule: options && options.reschedule !== false,
      expectedSessionId: expectedSessionId,
      expectedSyncToken: expectedSyncToken,
    });
  }, normalizedDelay);
}

function requestCompatibilitySessionProgressReport(reason, options) {
  var immediate = !options || options.immediate !== false;
  if (options && options.burst) armCompatibilityProgressBurst();
  if (!compatibilityProgressReportingActive()) return;
  if (!immediate && ctx.state.compatibilitySessionProgressTimer) return;
  if (ctx.state.compatibilitySessionProgressRequestInFlight) {
    if (immediate) {
      ctx.state.compatibilitySessionProgressPendingImmediate = true;
    }
    return;
  }
  scheduleCompatibilitySessionProgressReport(
    immediate ? 0 : compatibilitySessionProgressReportDelayMs(),
    {
      reason: reason || 'event',
      reschedule: options && options.reschedule === false ? false : true,
      expectedSessionId: ctx.state.compatibilitySessionId || '',
      expectedSyncToken: ctx.state.playbackSyncToken,
    }
  );
}

function staleProgressPayloadTargetsLocalSession(payload, expectedSessionId) {
  if (!payload || payload.updated !== false) return false;
  var localSessionId = String(ctx.state.compatibilitySessionId || '');
  var payloadSessionId = payload && payload.session_id ? String(payload.session_id) : '';
  var targetSessionId = expectedSessionId
    ? String(expectedSessionId)
    : localSessionId;
  if (!localSessionId || !payloadSessionId || payloadSessionId !== localSessionId) return false;
  if (targetSessionId && payloadSessionId !== targetSessionId) return false;
  return true;
}

async function reportCompatibilitySessionProgress(reason, options) {
  var expectedSessionId = options && options.expectedSessionId ? String(options.expectedSessionId) : '';
  var expectedSyncToken = Number.isFinite(Number(options && options.expectedSyncToken))
    ? Number(options.expectedSyncToken)
    : ctx.state.playbackSyncToken;
  if (!compatibilityProgressReportingActive(expectedSessionId, expectedSyncToken)) {
    return false;
  }
  if (ctx.state.compatibilitySessionProgressRequestInFlight) {
    if (!options || options.immediate !== false) {
      ctx.state.compatibilitySessionProgressPendingImmediate = true;
    }
    return false;
  }
  ctx.state.compatibilitySessionProgressRequestInFlight = true;
  var body = 'id=' + encodeURIComponent(ctx.state.compatibilitySessionId || '')
    + '&client_id=' + encodeURIComponent(ctx.state.videoClientId || '')
    + '&playback_seconds=' + encodeURIComponent(String(ctx.currentGlobalPlaybackSeconds()))
    + '&playback_media_seconds=' + encodeURIComponent(String(compatibilityMediaPlaybackSeconds()))
    + '&playback_state=' + encodeURIComponent(compatibilityPlaybackState())
    + '&playback_sync_token=' + encodeURIComponent(String(ctx.state.playbackSyncToken));
  try {
    var response = await fetch('/video/endpoints/session/progress', {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8'},
      body: body,
    });
    if (!response.ok) return false;
    var payload = await response.json();
    if (payload && payload.updated === false) {
      if (staleProgressPayloadTargetsLocalSession(payload, expectedSessionId)) {
        handleMissingCompatibilitySession(String(payload.session_id || ''), payload, null);
      }
      return false;
    }
    ctx.reportVideoDiagnostic({
      level: 'debug',
      message: 'Compatibility session progress reported',
      report_reason: reason || '',
      client_id: ctx.state.videoClientId || '',
      playback_seconds: ctx.currentGlobalPlaybackSeconds(),
      playback_media_seconds: compatibilityMediaPlaybackSeconds(),
      playback_state: compatibilityPlaybackState(),
      playback_sync_token: ctx.state.playbackSyncToken,
    });
    return true;
  }
  catch (_error) {
    return false;
  }
  finally {
    ctx.state.compatibilitySessionProgressRequestInFlight = false;
    if (ctx.state.compatibilitySessionProgressPendingImmediate) {
      ctx.state.compatibilitySessionProgressPendingImmediate = false;
      requestCompatibilitySessionProgressReport('pending-immediate', {burst: false});
    }
    else if (options && options.reschedule !== false) {
      scheduleCompatibilitySessionProgressReport(undefined, {
        reason: 'timer',
        reschedule: true,
        expectedSessionId: ctx.state.compatibilitySessionId || '',
        expectedSyncToken: ctx.state.playbackSyncToken,
      });
    }
  }
}

function destroyHlsController() {
  clearCompatibilityManifestStallTimer();
  if (ctx.state.hlsController && typeof ctx.state.hlsController.destroy === 'function') {
    ctx.state.hlsController.destroy();
  }
  ctx.state.hlsController = null;
}

function clearCompatibilityManifestStallTimer() {
  if (!ctx.state.compatibilityManifestStallTimer) return;
  window.clearTimeout(ctx.state.compatibilityManifestStallTimer);
  ctx.state.compatibilityManifestStallTimer = 0;
}

function clearCompatibilityRecoveryTimer() {
  ctx.state.compatibilityRecoveryScheduled = false;
  ctx.state.compatibilityRecoveryForceVideoTranscode = false;
  ctx.state.compatibilityRecoveryForceAudioTranscode = false;
  ctx.state.compatibilityRecoveryFallbackKey = '';
  if (!ctx.state.compatibilityRecoveryTimer) return;
  window.clearTimeout(ctx.state.compatibilityRecoveryTimer);
  ctx.state.compatibilityRecoveryTimer = 0;
}

function resetCompatibilityRecoveryState() {
  ctx.state.compatibilityRecoveryAttempts = 0;
  ctx.state.compatibilityForcedVideoTranscodeRetryKeys = Object.create(null);
  ctx.state.compatibilityForcedAudioTranscodeRetryKeys = Object.create(null);
  ctx.state.compatibilityRecoveryForceVideoTranscode = false;
  ctx.state.compatibilityRecoveryForceAudioTranscode = false;
  ctx.state.compatibilityRecoveryFallbackKey = '';
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

function hlsErrorAssetUrl(data) {
  if (data && data.frag && data.frag.url) return String(data.frag.url);
  if (data && data.context && data.context.url) return String(data.context.url);
  return '';
}

function compatibilitySessionMissingMessage(statusPayload) {
  var sessionState = statusPayload && statusPayload.session_state
    ? String(statusPayload.session_state)
    : '';
  var sessionStateMessage = statusPayload && statusPayload.session_state_message
    ? String(statusPayload.session_state_message)
    : '';
  if (sessionStateMessage) return sessionStateMessage;
  if (sessionState === 'stopped') return 'Video session was stopped.';
  if (sessionState === 'expired') return 'Video session expired after being idle.';
  if (sessionState === 'evicted') return 'Video session was evicted to free server capacity.';
  return 'Video session is no longer available.';
}

function clearLocalCompatibilitySessionState() {
  var sessionId = ctx.state.compatibilitySessionId || '';
  clearCompatibilitySessionStatusPoll();
  clearCompatibilitySessionProgressReport();
  clearCompatibilityRecoveryTimer();
  ctx.state.compatibilitySessionProgressPendingImmediate = false;
  ctx.state.compatibilityProgressBurstUntilMs = 0;
  ctx.state.compatibilitySessionId = '';
  ctx.state.compatibilitySessionPath = '';
  ctx.state.compatibilityAudioStreamIndex = null;
  ctx.state.compatibilitySessionBurnedInSubtitleStreamIndex = null;
  ctx.state.compatibilitySessionVideoMode = '';
  ctx.state.compatibilitySessionVideoModeReason = '';
  ctx.state.compatibilitySessionAudioMode = '';
  ctx.state.compatibilitySessionAudioModeReason = '';
  ctx.state.compatibilitySegmentDurationSeconds = 0;
  ctx.state.compatibilityEncodedMediaEndSeconds = 0;
  ctx.state.compatibilitySubtitleStreamIndex = null;
  destroyHlsController();
  return sessionId;
}

async function pollMissingCompatibilitySessionStatus(sessionId) {
  var normalizedSessionId = String(sessionId || '');
  if (!normalizedSessionId) return null;
  try {
    var response = await fetch('/video/endpoints/status?id=' + encodeURIComponent(normalizedSessionId));
    if (!response.ok) return null;
    var payload = await response.json();
    var sessions = payload && Array.isArray(payload.active_sessions) ? payload.active_sessions : [];
    if (sessions.length && sessions[0] && sessions[0].session_id === normalizedSessionId) {
      return {
        missing: false,
        payload: sessions[0],
      };
    }
    return {
      missing: true,
      payload: payload || null,
    };
  }
  catch (_error) {
    return null;
  }
}

function handleMissingCompatibilitySession(sessionId, statusPayload, data) {
  var active = ctx.activeQueueItem();
  if (!active) return false;
  var message = compatibilitySessionMissingMessage(statusPayload);
  clearLocalCompatibilitySessionState();
  ctx.state.pendingAutoplay = false;
  ctx.state.transportWantsPlay = false;
  ctx.state.seekRestartInProgress = false;
  ctx.state.requestedSeekSeconds = null;
  ctx.reportVideoDiagnostic({
    level: 'warn',
    message: 'Compatibility session missing for this browser',
    session_id: sessionId || '',
    session_state: statusPayload && statusPayload.session_state ? String(statusPayload.session_state) : '',
    session_state_message: message,
    hls_details: data && data.details || '',
    hls_reason: data && (data.reason || data.error && data.error.message) || '',
    hls_url: hlsErrorAssetUrl(data),
  });
  failCompatibilityPlayback(
    active,
    message,
    'Compatibility playback stopped: ' + message
  );
  return true;
}

function compatibilityForcedVideoTranscodeRetryKey(itemPath, targetSeconds) {
  var path = String(itemPath || '');
  var seconds = Math.max(0, Number(targetSeconds) || 0).toFixed(3);
  return path + '|' + seconds;
}

function compatibilityForcedAudioTranscodeRetryKey(itemPath, targetSeconds) {
  var path = String(itemPath || '');
  var seconds = Math.max(0, Number(targetSeconds) || 0).toFixed(3);
  return path + '|' + seconds;
}

function scheduleCompatibilityRecovery(reason, targetSeconds, data, options) {
  var active = ctx.activeQueueItem();
  if (!active || !ctx.state.compatibilityAvailable) return false;
  if (ctx.state.compatibilityRecoveryTimer || ctx.state.compatibilityRecoveryScheduled) return false;
  if (ctx.state.seekRestartInProgress) return false;

  ctx.state.compatibilityRecoveryAttempts += 1;
  ctx.state.compatibilityRecoveryScheduled = true;
  ctx.state.transportWantsPlay = true;
  ctx.state.pendingAutoplay = true;
  ctx.state.compatibilityRecoveryForceVideoTranscode = Boolean(
    options && options.forceVideoTranscode
  );
  ctx.state.compatibilityRecoveryForceAudioTranscode = Boolean(
    options && options.forceAudioTranscode
  );
  ctx.state.compatibilityRecoveryFallbackKey = options && options.fallbackKey
    ? String(options.fallbackKey)
    : '';

  var resumeSeconds = Number.isFinite(Number(targetSeconds)) && Number(targetSeconds) >= 0
    ? Number(targetSeconds)
    : ctx.currentGlobalPlaybackSeconds();
  var delayMs = compatibilityRecoveryDelayMs();

  ctx.showLoadingOverlay({
    title: ctx.activeItemTitle(active),
    meta: 'Recovering compatibility playback...',
    progress: 0.5,
  });
  ctx.setStatus('Recovering compatibility playback (attempt ' + String(ctx.state.compatibilityRecoveryAttempts) + ').');
  ctx.reportVideoDiagnostic({
    level: 'warn',
    message: 'Compatibility playback recovery scheduled',
    recovery_reason: reason || '',
    recovery_attempt: ctx.state.compatibilityRecoveryAttempts,
    recovery_delay_ms: delayMs,
    resume_time: resumeSeconds,
    force_video_transcode: ctx.state.compatibilityRecoveryForceVideoTranscode ? '1' : '0',
    force_audio_transcode: ctx.state.compatibilityRecoveryForceAudioTranscode ? '1' : '0',
    hls_details: data && data.details || '',
    hls_reason: data && (data.reason || data.error && data.error.message) || '',
    hls_url: data && data.frag && data.frag.url ? data.frag.url : (data && data.context && data.context.url ? data.context.url : ''),
  });

  ctx.state.compatibilityRecoveryTimer = window.setTimeout(function () {
    var restartForceVideoTranscode = Boolean(ctx.state.compatibilityRecoveryForceVideoTranscode);
    var restartForceAudioTranscode = Boolean(ctx.state.compatibilityRecoveryForceAudioTranscode);
    ctx.state.compatibilityRecoveryTimer = 0;
    ctx.state.compatibilityRecoveryScheduled = false;
    ctx.state.compatibilityRecoveryForceVideoTranscode = false;
    ctx.state.compatibilityRecoveryForceAudioTranscode = false;
    ctx.state.compatibilityRecoveryFallbackKey = '';
    if (!ctx.activeQueueItem() || !ctx.state.compatibilityAvailable) return;
    void restartCompatibilityAt(resumeSeconds, reason || 'auto-recovery', {
      forceVideoTranscode: restartForceVideoTranscode,
      forceAudioTranscode: restartForceAudioTranscode,
    });
  }, delayMs);
  return true;
}

function scheduleCompatibilityVideoCopyFallback(reason, targetSeconds, data) {
  var active = ctx.activeQueueItem();
  if (!active || !active.path) return false;
  if (ctx.state.compatibilitySessionVideoMode !== 'video_copy') return false;
  if (!ctx.state.compatibilityForcedVideoTranscodeRetryKeys) {
    ctx.state.compatibilityForcedVideoTranscodeRetryKeys = Object.create(null);
  }
  var fallbackKey = compatibilityForcedVideoTranscodeRetryKey(active.path || '', targetSeconds);
  if (ctx.state.compatibilityForcedVideoTranscodeRetryKeys[fallbackKey]) {
    ctx.reportVideoDiagnostic({
      level: 'warn',
      message: 'Compatibility video-copy fallback suppressed after prior forced transcode retry',
      recovery_reason: reason || '',
      resume_time: Number(targetSeconds) || 0,
      fallback_key: fallbackKey,
    });
    return false;
  }
  var scheduled = scheduleCompatibilityRecovery(reason, targetSeconds, data, {
    forceVideoTranscode: true,
    fallbackKey,
  });
  if (!scheduled) return false;
  ctx.state.compatibilityForcedVideoTranscodeRetryKeys[fallbackKey] = true;
  ctx.setStatus('Compatibility playback copy mode failed; retrying with video transcode.');
  ctx.reportVideoDiagnostic({
    level: 'warn',
    message: 'Compatibility video-copy fallback scheduled',
    recovery_reason: reason || '',
    resume_time: Number(targetSeconds) || 0,
    fallback_key: fallbackKey,
  });
  return true;
}

function scheduleCompatibilityAudioCopyFallback(reason, targetSeconds, data) {
  var active = ctx.activeQueueItem();
  if (!active || !active.path) return false;
  if (ctx.state.compatibilitySessionAudioMode !== 'audio_copy') return false;
  if (!ctx.state.compatibilityForcedAudioTranscodeRetryKeys) {
    ctx.state.compatibilityForcedAudioTranscodeRetryKeys = Object.create(null);
  }
  var fallbackKey = compatibilityForcedAudioTranscodeRetryKey(active.path || '', targetSeconds);
  if (ctx.state.compatibilityForcedAudioTranscodeRetryKeys[fallbackKey]) {
    ctx.reportVideoDiagnostic({
      level: 'warn',
      message: 'Compatibility audio-copy fallback suppressed after prior forced audio transcode retry',
      recovery_reason: reason || '',
      resume_time: Number(targetSeconds) || 0,
      fallback_key: fallbackKey,
    });
    return false;
  }
  var scheduled = scheduleCompatibilityRecovery(reason, targetSeconds, data, {
    forceAudioTranscode: true,
    fallbackKey,
  });
  if (!scheduled) return false;
  ctx.state.compatibilityForcedAudioTranscodeRetryKeys[fallbackKey] = true;
  ctx.setStatus('Compatibility playback audio copy mode failed; retrying with audio transcode.');
  ctx.reportVideoDiagnostic({
    level: 'warn',
    message: 'Compatibility audio-copy fallback scheduled',
    recovery_reason: reason || '',
    resume_time: Number(targetSeconds) || 0,
    fallback_key: fallbackKey,
  });
  return true;
}

async function handleCompatibilityHlsError(data) {
  if (!data || !data.fatal) return;
  var active = ctx.activeQueueItem();
  if (!active || ctx.state.playbackMode !== 'compatibility') return;
  if (!hlsErrorTargetsCurrentSession(data)) return;

  if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
    if (isStaleOrMissingSegmentHlsError(data)) {
      var localSessionId = String(ctx.state.compatibilitySessionId || '');
      var missingStatus = await pollMissingCompatibilitySessionStatus(localSessionId);
      if (missingStatus && missingStatus.missing) {
        handleMissingCompatibilitySession(localSessionId, missingStatus.payload, data);
        return;
      }
      scheduleCompatibilityRecovery('hls-missing-segment', ctx.currentGlobalPlaybackSeconds(), data);
      return;
    }
    ctx.setStatus('Compatibility playback hit a network error; retrying the stream.');
    if (ctx.state.hlsController) {
      ctx.state.hlsController.startLoad();
      ctx.resyncSubtitleTrackAfterHlsRecovery('network-error', data);
    }
    return;
  }

  if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
    if (scheduleCompatibilityVideoCopyFallback('hls-media-copy-fallback', ctx.currentGlobalPlaybackSeconds(), data)) {
      return;
    }
    if (scheduleCompatibilityAudioCopyFallback('hls-media-audio-copy-fallback', ctx.currentGlobalPlaybackSeconds(), data)) {
      return;
    }
    ctx.setStatus('Compatibility playback hit a media error; attempting recovery.');
    if (ctx.state.hlsController) {
      ctx.state.hlsController.recoverMediaError();
      ctx.resyncSubtitleTrackAfterHlsRecovery('media-error', data);
    }
    return;
  }

  scheduleCompatibilityRecovery('hls-fatal-error', ctx.currentGlobalPlaybackSeconds(), data);
}

function resetCompatibilityBufferState() {
  ctx.state.compatibilityBufferedFragmentCount = 0;
  ctx.state.compatibilityPlaylistSegmentCount = 0;
  ctx.state.compatibilityCurrentSegmentIndex = 0;
  ctx.state.compatibilityLoadedSegmentMinIndex = 0;
  ctx.state.compatibilityLoadedSegmentMaxIndex = 0;
  ctx.state.compatibilityLoadedSegmentIndicesByKey = Object.create(null);
  ctx.state.compatibilityPendingSegmentLoadStartMsByKey = Object.create(null);
  ctx.state.compatibilitySegmentLoadSampleCount = 0;
  ctx.state.compatibilitySegmentLoadAverageMs = 0;
  ctx.state.compatibilitySegmentLoadWindowStartMs = NaN;
  ctx.state.compatibilitySegmentFetchSampleCount = 0;
  ctx.state.compatibilitySegmentFetchAverageMs = 0;
  ctx.state.compatibilityPlaybackRevealed = false;
  ctx.state.compatibilityPlaybackRevealPending = false;
  ctx.state.compatibilitySubtitleWaitStageActive = false;
}

function compatibilitySeekableRanges() {
  if (!ctx.els.videoEl || !ctx.els.videoEl.seekable) return [];
  return ctx.mediaRangesSummary(ctx.els.videoEl.seekable);
}

function noteEncodedMediaEndFromFragment(data) {
  if (!data || !data.frag || data.frag.sn === 'initSegment') return;
  var sequence = Number(data.frag.sn);
  if (!Number.isFinite(sequence) || sequence < 0) return;
  var fragmentEnd = (sequence + 1) * HLS_SEGMENT_DURATION_SECONDS;
  if (fragmentEnd > (ctx.state.compatibilityEncodedMediaEndSeconds || 0)) {
    ctx.state.compatibilityEncodedMediaEndSeconds = fragmentEnd;
  }
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

async function waitForCompatibilityStartupSubtitles(surfaceSyncToken, reason) {
  var active = ctx.activeQueueItem();
  if (!active || ctx.state.playbackMode !== 'compatibility') return;
  if (!ctx.playbackSyncTokenIsCurrent(surfaceSyncToken)) return;
  if (ctx.state.seekRestartInProgress) return;
  var probePayload = ctx.state.probeCache[active.path || ''] || null;
  if (!ctx.subtitlesEnabledForItem(active, probePayload)) return;
  if (ctx.selectedBurnedInSubtitleStreamIndex(active, probePayload) !== null) return;
  var fetchStartSeconds = Math.max(0, ctx.state.compatibilityStartSeconds || 0);
  var streamIndex = ctx.resolvedSubtitleStreamIndex(active, probePayload);
  if (ctx.subtitlesAreMounted(active, streamIndex, fetchStartSeconds)) return;
  showCompatibilitySubtitleWaitStage(active);
  try {
    await ctx.ensureStartupSubtitleWindowForPlayback(active, probePayload, fetchStartSeconds, {
      windowStatus: fetchStartSeconds > 0 ? 'seek' : 'startup',
      playbackSyncToken: surfaceSyncToken,
    });
  }
  catch (error) {
    ctx.reportVideoDiagnostic({
      level: 'error',
      message: 'Startup subtitle extraction failed',
      error_message: error && error.message ? String(error.message) : 'unknown',
      subtitle_stream_index: streamIndex,
      playback_sync_token: surfaceSyncToken,
    });
    if (typeof ctx.showSubtitleFailureState === 'function') {
      ctx.showSubtitleFailureState({
        title: 'Subtitle loading failed',
        meta: 'The selected subtitle track could not be extracted for the startup playback window.',
      });
    }
    ctx.setStatus('Subtitle extraction failed.');
    ctx.setPlaybackSummary(ctx.activeItemTitle(active), 'Selected subtitle track could not be converted to WebVTT.');
  }
}

function showCompatibilitySubtitleWaitStage(item) {
  if (!item) return;
  if (typeof ctx.clearSubtitleFailureState === 'function') ctx.clearSubtitleFailureState();
  ctx.state.compatibilitySubtitleWaitStageActive = true;
  var overlay = ctx.loadingOverlayCopy(
    item,
    COMPATIBILITY_SUBTITLE_WAIT_META,
    0.84
  );
  overlay.title = 'Waiting for subtitles';
  overlay.reason = 'subtitle-wait';
  ctx.showLoadingOverlay(overlay);
  ctx.setPlaybackSummary(
    ctx.activeItemTitle(item),
    COMPATIBILITY_SUBTITLE_WAIT_META
  );
  ctx.setStatus('Waiting for subtitles to finish loading.');
}

async function revealCompatibilityPlaybackWhenReady(title, surfaceSyncToken, reason) {
  try {
    await waitForCompatibilityStartupSubtitles(surfaceSyncToken, reason || 'hls-buffer-ready');
  }
  finally {
    if (ctx.playbackSyncTokenIsCurrent(surfaceSyncToken)) {
      ctx.state.compatibilityPlaybackRevealPending = false;
    }
  }
  if (ctx.state.playbackMode !== 'compatibility' || !ctx.playbackSyncTokenIsCurrent(surfaceSyncToken)) return;
  if (ctx.state.compatibilityPlaybackRevealed) return;
  ctx.state.compatibilityPlaybackRevealed = true;
  ctx.hideLoadingOverlay();
  ctx.setStatus('Compatibility playback session is ready.');
  if (ctx.state.compatibilityStartSeconds > 0) {
    ctx.setStatus('Compatibility playback session is ready at ' + ctx.formatPlaybackTime(ctx.state.compatibilityStartSeconds) + '.');
  }
  ctx.reportVideoDiagnostic({
    level: 'info',
    message: 'Compatibility playback buffer ready',
    reveal_reason: reason || '',
    buffered_fragments: ctx.state.compatibilityBufferedFragmentCount,
    buffered_seconds_ahead: compatibilityBufferedSecondsAhead(),
    source_start_seconds: ctx.state.compatibilityStartSeconds,
  });
  ctx.reportPlaybackTiming('buffer_ready', {
    reveal_reason: reason || '',
    buffered_fragments: ctx.state.compatibilityBufferedFragmentCount,
    buffered_seconds_ahead: compatibilityBufferedSecondsAhead(),
  });
  if (ctx.state.pendingAutoplay) ctx.requestVideoPlay();
  ctx.ensureSubtitlesAfterPlaybackReady(reason || 'hls-buffer-ready');
}

function maybeRevealCompatibilityPlayback(title, surfaceSyncToken, reason) {
  if (ctx.state.playbackMode !== 'compatibility' || !ctx.playbackSyncTokenIsCurrent(surfaceSyncToken)) return;
  if (ctx.state.compatibilityPlaybackRevealed || ctx.state.compatibilityPlaybackRevealPending) return;
  if (!compatibilityStartBufferReady()) return;
  ctx.state.compatibilityPlaybackRevealPending = true;
  void revealCompatibilityPlaybackWhenReady(title, surfaceSyncToken, reason);
}

function noteCompatibilityFragmentBuffered(data, title, surfaceSyncToken) {
  if (ctx.state.playbackMode !== 'compatibility' || !ctx.playbackSyncTokenIsCurrent(surfaceSyncToken)) return;
  noteEncodedMediaEndFromFragment(data);
  var segmentKey = compatibilitySegmentLoadKey(data);
  var pendingStarts = ctx.state.compatibilityPendingSegmentLoadStartMsByKey || null;
  if (segmentKey && pendingStarts && Object.prototype.hasOwnProperty.call(pendingStarts, segmentKey)) {
    delete pendingStarts[segmentKey];
  }
  if (data && data.frag && data.frag.sn !== 'initSegment') {
    var segmentIndex = Number(data.frag.sn) + 1;
    if (Number.isFinite(segmentIndex) && segmentIndex > 0) {
      if (!ctx.state.compatibilityLoadedSegmentIndicesByKey) {
        ctx.state.compatibilityLoadedSegmentIndicesByKey = Object.create(null);
      }
      ctx.state.compatibilityLoadedSegmentIndicesByKey[String(segmentIndex)] = true;
      if (!ctx.state.compatibilityLoadedSegmentMinIndex || segmentIndex < ctx.state.compatibilityLoadedSegmentMinIndex) {
        ctx.state.compatibilityLoadedSegmentMinIndex = segmentIndex;
      }
      if (!ctx.state.compatibilityLoadedSegmentMaxIndex || segmentIndex > ctx.state.compatibilityLoadedSegmentMaxIndex) {
        ctx.state.compatibilityLoadedSegmentMaxIndex = segmentIndex;
      }
    }
  }
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
  if (typeof ctx.syncPlaybackProgress === 'function') {
    ctx.syncPlaybackProgress();
  }
  if (typeof ctx.syncSubtitleDebugDisplay === 'function') {
    ctx.syncSubtitleDebugDisplay();
  }
  maybeRevealCompatibilityPlayback(title, surfaceSyncToken, 'hls-fragment-buffered');
}

function failCompatibilityPlayback(item, meta, status) {
  ctx.clearVideoSource();
  ctx.showPlaybackPlaceholder(ctx.activeItemTitle(item), meta || 'Compatibility playback failed for this file.');
  ctx.setStatus(status || 'Compatibility playback failed.');
  ctx.hideLoadingOverlay();
  ctx.resetPlaybackProgress();
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

async function postStopCompatibilitySession(sessionId, options) {
  var clientId = ctx.state.videoClientId || '';
  var normalizedSessionId = String(sessionId || '');
  var unloadSafe = Boolean(options && options.unloadSafe);
  var clientOwned = Boolean(options && options.clientOwned);
  if ((!normalizedSessionId && !unloadSafe && !clientOwned) || (!normalizedSessionId && !clientId)) return;
  var body = (normalizedSessionId && !clientOwned ? 'id=' + encodeURIComponent(normalizedSessionId) + '&' : '')
    + 'client_id=' + encodeURIComponent(clientId);
  var transitionToken = options && options.transitionToken;
  if (transitionToken != null && Number.isFinite(Number(transitionToken))) {
    body += '&transition_token=' + encodeURIComponent(String(Math.max(0, Math.trunc(Number(transitionToken)))));
  }
  try {
    await fetch('/video/endpoints/session/stop', {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8'},
      body: body,
      ...(unloadSafe ? {keepalive: true} : {}),
    });
  }
  catch (_error) {
    if (!unloadSafe || typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return;
    try {
      var beaconBody = typeof Blob === 'function'
        ? new Blob([body], {type: 'application/x-www-form-urlencoded; charset=UTF-8'})
        : body;
      navigator.sendBeacon('/video/endpoints/session/stop', beaconBody);
    }
    catch (_beaconError) {
      return;
    }
  }
}

async function stopCompatibilitySession(sessionIdOverride, options) {
  var explicitSessionId = sessionIdOverride == null
    ? ''
    : String(sessionIdOverride || '');
  var sessionId = explicitSessionId || String(ctx.state.compatibilitySessionId || '');
  var unloadSafe = Boolean(options && options.unloadSafe);
  var clientOwned = Boolean(options && options.clientOwned);
  if (!sessionId && !unloadSafe && !clientOwned) return;
  var clearLocalFirst = Boolean(options && options.clearLocalFirst);
  if (clearLocalFirst && String(ctx.state.compatibilitySessionId || '') === sessionId) {
    clearLocalCompatibilitySessionState();
  }
  await postStopCompatibilitySession(sessionId, options);
  if (String(ctx.state.compatibilitySessionId || '') === sessionId) {
    clearLocalCompatibilitySessionState();
  }
}

function attachCompatibilityVideo(playlistUrl, title, meta, startSeconds, surfaceSyncToken) {
  if (!ctx.els.videoEl) return;
  ctx.clearVideoSource();
  resetCompatibilityBufferState();
  armCompatibilityProgressBurst();
  var normalizedStartSeconds = Math.max(0, Number(startSeconds) || 0);
  ctx.reportCompatibilitySeekTiming('hls_attach_started', {
    playlist_url: playlistUrl || '',
    source_start_seconds: normalizedStartSeconds,
    encoded_media_end_seconds: ctx.state.compatibilityEncodedMediaEndSeconds || 0,
    seek_restart_in_progress: ctx.state.seekRestartInProgress,
    playback_sync_token: surfaceSyncToken,
  });
  ctx.reportPlaybackTiming('hls_attached');
  ctx.state.compatibilityStartSeconds = normalizedStartSeconds;
  ctx.els.videoEl.controls = false;
  ctx.els.videoEl.removeAttribute('controls');
  resetCompatibilityRecoveryState();
  ctx.state.playbackMode = 'compatibility';
  scheduleCompatibilitySessionStatusPoll();
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
      if (!ctx.playbackSyncTokenIsCurrent(surfaceSyncToken)) return;
      ctx.showLoadingOverlay({
        title: title,
        meta: 'Loading the HLS playlist.',
        progress: 0.84,
      });
      ctx.reportVideoDiagnostic({
        level: 'debug',
        message: 'HLS manifest loading',
        hls_url: data && data.url ? data.url : '',
      });
      ctx.reportPlaybackTiming('hls_manifest_loading');
    });
    ctx.state.hlsController.on(Hls.Events.MANIFEST_LOADED, function (_eventName, data) {
      if (!ctx.playbackSyncTokenIsCurrent(surfaceSyncToken)) return;
      var hlsLevelCount = data && Array.isArray(data.levels) ? data.levels.length : 0;
      var firstLevel = data && Array.isArray(data.levels) && data.levels.length ? data.levels[0] : null;
      var details = firstLevel && firstLevel.details ? firstLevel.details : null;
      if (details && Number.isFinite(Number(details.startSN)) && Number.isFinite(Number(details.endSN))) {
        ctx.state.compatibilityPlaylistSegmentCount = Math.max(0, (Number(details.endSN) - Number(details.startSN)) + 1);
      }
      ctx.showLoadingOverlay({
        title: title,
        meta: 'Playlist is ready. Attaching the stream.',
        progress: 0.9,
      });
      ctx.reportVideoDiagnostic({
        level: 'debug',
        message: 'HLS manifest loaded',
        hls_level_count: hlsLevelCount,
      });
      ctx.reportPlaybackTiming('hls_manifest_loaded', {
        hls_level_count: hlsLevelCount,
        playlist_url: playlistUrl || '',
        source_start_seconds: ctx.state.compatibilityStartSeconds || 0,
        encoded_media_end_seconds: ctx.state.compatibilityEncodedMediaEndSeconds || 0,
      });
      clearCompatibilityManifestStallTimer();
      ctx.state.compatibilityManifestStallTimer = window.setTimeout(function () {
        if (!ctx.playbackSyncTokenIsCurrent(surfaceSyncToken)) return;
        if (ctx.state.playbackMode !== 'compatibility') return;
        ctx.reportCompatibilitySeekTiming('hls_manifest_parse_stall', {
          stall_ms: 5000,
          loading_overlay_meta: ctx.state.loadingOverlayMeta || '',
          playlist_url: playlistUrl || '',
          hls_level_count: hlsLevelCount,
          playback_sync_token: surfaceSyncToken,
          current_playback_sync_token: ctx.state.playbackSyncToken,
        });
      }, 5000);
    });
    ctx.state.hlsController.on(Hls.Events.MANIFEST_PARSED, function () {
      clearCompatibilityManifestStallTimer();
      if (ctx.state.playbackMode !== 'compatibility' || !ctx.playbackSyncTokenIsCurrent(surfaceSyncToken)) return;
      ctx.showLoadingOverlay({
        title: title,
        meta: 'Buffering the first frame.',
        progress: 0.96,
      });
      ctx.reportVideoDiagnostic({
        level: 'debug',
        message: 'HLS manifest parsed',
        hls_start_position: 0,
        hls_live_sync_mode: 'file-start',
        source_start_seconds: ctx.state.compatibilityStartSeconds,
      });
      ctx.reportPlaybackTiming('hls_manifest_parsed', {
        source_start_seconds: ctx.state.compatibilityStartSeconds,
      });
      if (ctx.state.hlsController && typeof ctx.state.hlsController.startLoad === 'function') {
        ctx.state.hlsController.startLoad(0);
      }
      if ((ctx.state.compatibilityEncodedMediaEndSeconds || 0) >= HLS_SEGMENT_DURATION_SECONDS) {
        ctx.state.compatibilityBufferedFragmentCount = Math.max(
          ctx.state.compatibilityBufferedFragmentCount,
          COMPATIBILITY_START_BUFFER_FRAGMENTS
        );
        maybeRevealCompatibilityPlayback(title, surfaceSyncToken, 'hls-encoded-range-known');
      }
      ctx.setStatus('Buffering compatibility playback before starting.');
    });
    ctx.state.hlsController.on(Hls.Events.FRAG_LOADING, function (_eventName, data) {
      noteCompatibilityFragmentLoading(data);
      if (data && data.frag && data.frag.sn !== 'initSegment') {
        var segmentIndex = Number(data.frag.sn) + 1;
        if (Number.isFinite(segmentIndex) && segmentIndex > 0) {
          ctx.state.compatibilityCurrentSegmentIndex = segmentIndex;
        }
      }
      ctx.reportVideoDiagnostic({
        level: 'debug',
        message: 'HLS fragment loading',
        frag_sn: data && data.frag ? data.frag.sn : '',
        frag_url: data && data.frag ? data.frag.url : '',
      });
    });
    ctx.state.hlsController.on(Hls.Events.FRAG_LOADED, function (_eventName, data) {
      var stats = compatibilitySegmentLoadStats(data);
      var loadingMs = compatibilitySegmentLoadDurationMs(data);
      noteCompatibilityFragmentLoaded(data);
      ctx.reportVideoDiagnostic({
        level: 'debug',
        message: 'HLS fragment loaded',
        frag_sn: data && data.frag ? data.frag.sn : '',
        frag_url: data && data.frag ? data.frag.url : '',
        loaded_bytes: stats ? stats.loaded : '',
        loading_ms: Number.isFinite(loadingMs) ? loadingMs : '',
        average_load_ms: Number(ctx.state.compatibilitySegmentLoadAverageMs) || '',
        load_sample_count: Number(ctx.state.compatibilitySegmentLoadSampleCount) || '',
        average_fetch_ms: Number(ctx.state.compatibilitySegmentFetchAverageMs) || '',
        fetch_sample_count: Number(ctx.state.compatibilitySegmentFetchSampleCount) || '',
      });
      if (
        data && data.frag && data.frag.sn !== 'initSegment'
        && ctx.state.playbackTiming
        && !ctx.state.playbackTiming.milestones.hls_first_fragment_loaded
      ) {
        ctx.reportPlaybackTiming('hls_first_fragment_loaded', {
          frag_sn: data.frag.sn,
          loading_ms: Number.isFinite(loadingMs) ? loadingMs : '',
        });
      }
    });
    ctx.state.hlsController.on(Hls.Events.FRAG_BUFFERED, function (_eventName, data) {
      ctx.reportVideoDiagnostic({
        level: 'debug',
        message: 'HLS fragment buffered',
        frag_sn: data && data.frag ? data.frag.sn : '',
        frag_url: data && data.frag ? data.frag.url : '',
      });
      noteCompatibilityFragmentBuffered(data, title, surfaceSyncToken);
    });
    ctx.state.hlsController.on(Hls.Events.ERROR, function (_eventName, data) {
      ctx.reportVideoDiagnostic({
        level: data && data.fatal ? 'error' : 'warn',
        message: data && data.fatal ? 'Fatal HLS error' : 'Recoverable HLS error',
        hls_type: data && data.type || '',
        hls_details: data && data.details || '',
        hls_fatal: data && data.fatal ? '1' : '0',
        hls_reason: data && (data.reason || data.error && data.error.message) || '',
        hls_url: data && data.frag && data.frag.url ? data.frag.url : (data && data.context && data.context.url ? data.context.url : ''),
      });
      void handleCompatibilityHlsError(data);
    });
    ctx.state.hlsController.attachMedia(ctx.els.videoEl);
    ctx.state.hlsController.loadSource(playlistUrl);
    if (ctx.playbackSyncTokenIsCurrent(surfaceSyncToken)) {
      ctx.showLoadingOverlay({
        title: title,
        meta: 'Connecting the video player to the HLS session.',
        progress: 0.78,
      });
    }
    ctx.setStatus('Compatibility playback session is loading.');
  }
  else if (ctx.els.videoEl.canPlayType('application/vnd.apple.mpegurl')) {
    if (ctx.playbackSyncTokenIsCurrent(surfaceSyncToken)) {
      ctx.showLoadingOverlay({
        title: title,
        meta: 'Loading the HLS playlist.',
        progress: 0.84,
      });
    }
    ctx.setStatus('Compatibility playback session is loading.');
    ctx.els.videoEl.src = playlistUrl;
    ctx.els.videoEl.load();
    ctx.els.videoEl.addEventListener('loadedmetadata', function onLoadedMetadata() {
      ctx.els.videoEl.removeEventListener('loadedmetadata', onLoadedMetadata);
      if (ctx.state.playbackMode !== 'compatibility' || !ctx.playbackSyncTokenIsCurrent(surfaceSyncToken)) return;
      ctx.setStatus('Buffering compatibility playback before starting.');
    });
  }
  else {
    throw new Error('HLS playback is not supported in this browser.');
  }
  ctx.clearSubtitleTrack();
  ctx.showPlaybackVideo(title, meta);
  updateCompatibilityCurrentSegmentIndex();
  ctx.syncPlaybackProgress();
  ctx.syncTransportControls();
  requestCompatibilitySessionProgressReport('session-attach', {burst: true});
}

async function createCompatibilitySession(item, audioStreamIndex, startSeconds, subtitleStreamIndex, options) {
  var body = 'path=' + encodeURIComponent(item.path || '')
    + '&source=remote'
    + '&client_id=' + encodeURIComponent(ctx.state.videoClientId || '')
    + '&start_time_seconds=' + encodeURIComponent(String(Math.max(0, Number(startSeconds) || 0)));
  var subtitleStyleOptions = typeof ctx.appliedSubtitleStyleOptions === 'function'
    ? ctx.appliedSubtitleStyleOptions()
    : null;
  if (typeof audioStreamIndex === 'number') {
    body += '&audio_stream_index=' + encodeURIComponent(String(audioStreamIndex));
  }
  if (typeof subtitleStreamIndex === 'number') {
    body += '&subtitle_stream_index=' + encodeURIComponent(String(subtitleStreamIndex));
    if (subtitleStyleOptions) {
      body += '&subtitle_stroke_enabled=' + (subtitleStyleOptions.strokeEnabled ? '1' : '0');
      body += '&subtitle_shadow_enabled=' + (subtitleStyleOptions.shadowEnabled ? '1' : '0');
      // Forced text burn-in maps the overlay size/offset onto ffmpeg
      // force_style args; bitmap burn-in sessions ignore them server-side.
      if (subtitleStyleOptions.forceBurnIn) {
        // Burn-in Fontsize is relative to the frame; the server scales the
        // overlay's on-screen size using the displayed video box height so
        // burned-in text matches the WebVTT overlay's rendered size.
        // Embedded pane layout applies a CSS scale to subtitle sizes, so use
        // the overlay element's COMPUTED font size rather than the raw style
        // value, and scale the offset by the same factor.
        var videoEl = ctx.els.videoEl;
        var displayHeight = videoEl ? Math.round(Number(videoEl.clientHeight) || 0) : 0;
        if (!displayHeight && ctx.els.playbackStageEl) {
          // Before the first frame attaches, the video box is zero-sized;
          // the stage shares the video's displayed area (object-fit contain
          // with matching aspect), so its height is the right reference.
          displayHeight = Math.round(Number(ctx.els.playbackStageEl.clientHeight) || 0);
        }
        var effectiveFontSize = 0;
        var effectiveOffset = subtitleStyleOptions.offsetPx;
        if (ctx.els.subtitleOverlayEl && ctx.els.subtitleOverlayEl.textContent !== undefined) {
          var computedSize = Number(
            parseFloat(window.getComputedStyle(ctx.els.subtitleOverlayEl).fontSize)
          );
          if (Number.isFinite(computedSize) && computedSize > 0
            && subtitleStyleOptions.fontSizePx > 0) {
            effectiveFontSize = Math.round(computedSize);
            var factor = computedSize / subtitleStyleOptions.fontSizePx;
            if (Number.isFinite(factor)) {
              effectiveOffset = Math.round(subtitleStyleOptions.offsetPx * factor);
            }
          }
        }
        if (!effectiveFontSize) {
          effectiveFontSize = subtitleStyleOptions.fontSizePx;
        }
        body += '&force_subtitle_burn_in=1';
        body += '&subtitle_font_size_px=' + encodeURIComponent(String(effectiveFontSize));
        body += '&subtitle_offset_px=' + encodeURIComponent(String(effectiveOffset));
        if (displayHeight > 0) {
          body += '&subtitle_display_height_px=' + encodeURIComponent(String(displayHeight));
        }
      }
    }
  }
  if (options && options.forceVideoTranscode) {
    body += '&force_video_transcode=1';
  }
  if (options && options.forceAudioTranscode) {
    body += '&force_audio_transcode=1';
  }
  if (options && options.transitionToken != null && Number.isFinite(Number(options.transitionToken))) {
    body += '&transition_token=' + encodeURIComponent(String(Math.max(0, Math.trunc(Number(options.transitionToken)))));
  }
  var response = await fetch('/video/endpoints/session', {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8'},
    body: body,
  });
  if (!response.ok) {
    var errorPayload = null;
    var errorText = '';
    try {
      if (response.headers && typeof response.headers.get === 'function') {
        var contentType = String(response.headers.get('content-type') || '');
        if (contentType.indexOf('application/json') >= 0) {
          errorPayload = await response.json();
        }
        else {
          errorText = await response.text();
        }
      }
      else {
        errorText = await response.text();
      }
    }
    catch (_error) {
      errorText = '';
    }
    var message = errorPayload && errorPayload.message
      ? String(errorPayload.message)
      : (errorText || 'Failed to start compatibility playback.');
    var error = new Error(message);
    if (errorPayload && errorPayload.error_code) {
      error.videoErrorCode = String(errorPayload.error_code);
    }
    if (errorPayload && errorPayload.session_error_reason) {
      error.videoSessionErrorReason = String(errorPayload.session_error_reason);
    }
    throw error;
  }
  return response.json();
}

function trySeekCompatibilityInSession(active, probePayload, clampedTarget, reason, phase) {
  if (!active || !ctx.els.videoEl) return false;
  var decision = compatibilityInSessionSeekDecision({
    targetSeconds: clampedTarget,
    sessionStartSeconds: ctx.state.compatibilityStartSeconds,
    seekableRanges: compatibilitySeekableRanges(),
    encodedMediaEndSeconds: ctx.state.compatibilityEncodedMediaEndSeconds,
    hasActiveSession: Boolean(ctx.state.compatibilitySessionId),
    sessionId: ctx.state.compatibilitySessionId,
    playbackMode: ctx.state.playbackMode,
    itemPath: active.path || '',
    sessionPath: ctx.state.compatibilitySessionPath || '',
    selectedAudioStreamIndex: ctx.selectedAudioStreamIndex(active, probePayload),
    sessionAudioStreamIndex: ctx.state.compatibilityAudioStreamIndex,
    selectedBurnedInSubtitleStreamIndex: ctx.selectedBurnedInSubtitleStreamIndex(active, probePayload),
    sessionSubtitleStreamIndex: ctx.state.compatibilitySessionBurnedInSubtitleStreamIndex,
  });
  ctx.reportCompatibilitySeekTiming('compatibility_seek_evaluated', {
    seek_reason: reason || '',
    evaluation_phase: phase || '',
    decision_action: decision.action || '',
    decision_reason: decision.reason || '',
    target_seconds: clampedTarget,
    decision_media_target_seconds: Number.isFinite(Number(decision.mediaTargetSeconds))
      ? Number(decision.mediaTargetSeconds)
      : '',
  });
  if (decision.action !== 'in-session' || !Number.isFinite(Number(decision.mediaTargetSeconds))) {
    return false;
  }

  var wasPlaying = ctx.playbackShouldBeRunning();
  ctx.reportPlaybackTiming('in_session_seek_requested', {
    requested_time: clampedTarget,
    seek_reason: reason || '',
    encoded_media_end_seconds: ctx.state.compatibilityEncodedMediaEndSeconds || 0,
  });
  ctx.reportVideoDiagnostic(Object.assign(
    {
      level: 'info',
      message: 'Compatibility in-session seek',
      seek_reason: reason || '',
      requested_time: clampedTarget,
      media_target_seconds: decision.mediaTargetSeconds,
      session_id: ctx.state.compatibilitySessionId || '',
    },
    ctx.currentProcessedRangeSnapshot(clampedTarget)
  ));
  ctx.state.requestedSeekSeconds = clampedTarget;
  if (ctx.els.progressSliderEl) ctx.els.progressSliderEl.value = String(clampedTarget);
  if (ctx.els.elapsedTimeEl) ctx.els.elapsedTimeEl.textContent = ctx.formatNativePlaybackTime(clampedTarget);
  ctx.els.videoEl.currentTime = decision.mediaTargetSeconds;
  ctx.state.requestedSeekSeconds = null;
  ctx.setPlaybackSummary(
    ctx.activeItemTitle(active),
    'Playing through a local HLS compatibility session from '
      + ctx.formatPlaybackTime(ctx.state.compatibilityStartSeconds) + '.'
  );
  ctx.setStatus('Compatibility playback at ' + ctx.formatPlaybackTime(clampedTarget) + '.');
  if (probePayload) {
    void ctx.applySubtitlesForSeek(active, probePayload, ctx.state.compatibilityStartSeconds, {
      playbackSyncToken: ctx.state.playbackSyncToken,
      reloadReason: reason || 'scrub-in-session',
      coverageTargetSeconds: clampedTarget,
    });
  }
  if (wasPlaying) ctx.requestVideoPlay();
  ctx.reportPlaybackTiming('in_session_seek_complete', {
    requested_time: clampedTarget,
    seek_reason: reason || '',
  });
  return true;
}

async function restartCompatibilityAt(targetSeconds, reason, options) {
  var active = ctx.activeQueueItem();
  if (!active || !ctx.state.compatibilityAvailable) return;
  clearCompatibilityRecoveryTimer();
  var forceVideoTranscode = Boolean(options && options.forceVideoTranscode);
  var forceAudioTranscode = Boolean(options && options.forceAudioTranscode);
  var forceSessionRestart = Boolean(options && options.forceSessionRestart);
  var syncToken = ++ctx.state.playbackSyncToken;
  var rawTargetSeconds = Math.max(0, Number(targetSeconds) || 0);
  ctx.reportCompatibilitySeekTiming('restart_seek_started', {
    raw_target_seconds: rawTargetSeconds,
    seek_reason: reason || '',
    playback_sync_token: syncToken,
  });
  var cachedProbePayload = ctx.state.probeCache[active.path || ''] || null;
  var duration = playbackDurationSeconds(
    ctx.els.videoEl ? Number(ctx.els.videoEl.duration) : NaN,
    cachedProbePayload,
    'compatibility'
  );
  var clampedTarget = rawTargetSeconds;
  if (Number.isFinite(duration) && duration > 0) {
    clampedTarget = Math.min(duration, clampedTarget);
    var preClampTarget = clampedTarget;
    clampedTarget = clampCompatibilityRestartTargetSeconds(clampedTarget, duration);
    if (clampedTarget !== preClampTarget || rawTargetSeconds !== clampedTarget) {
      ctx.reportCompatibilitySeekTiming('restart_target_clamped', {
        raw_target_seconds: rawTargetSeconds,
        pre_clamp_target_seconds: preClampTarget,
        clamped_target_seconds: clampedTarget,
        duration_seconds: duration,
        seek_reason: reason || '',
      });
    }
  }
  forceSessionRestart = forceSessionRestart || (
    forceVideoTranscode
    || forceAudioTranscode
    || compatibilityRecoveryRequiresSessionRestart(reason || '')
  );
  if (!forceSessionRestart && trySeekCompatibilityInSession(active, cachedProbePayload, clampedTarget, reason, 'before-probe')) {
    return;
  }
  ctx.resetPlaybackTiming(active.path || '', reason || 'seek-restart');
  ctx.reportPlaybackTiming('probe_start', {probe_cache_hit: Boolean(ctx.state.probeCache[active.path || ''])});
  var probePayload = cachedProbePayload || await ctx.ensureAudioTracksForItem(active);
  ctx.reportPlaybackTiming('probe_complete', {probe_cache_hit: Boolean(ctx.state.probeCache[active.path || ''])});
  if (syncToken !== ctx.state.playbackSyncToken) return;
  duration = playbackDurationSeconds(
    ctx.els.videoEl ? Number(ctx.els.videoEl.duration) : NaN,
    probePayload,
    'compatibility'
  );
  clampedTarget = rawTargetSeconds;
  if (Number.isFinite(duration) && duration > 0) {
    clampedTarget = Math.min(duration, clampedTarget);
    var postProbePreClampTarget = clampedTarget;
    clampedTarget = clampCompatibilityRestartTargetSeconds(clampedTarget, duration);
    if (clampedTarget !== postProbePreClampTarget || rawTargetSeconds !== clampedTarget) {
      ctx.reportCompatibilitySeekTiming('restart_target_clamped', {
        raw_target_seconds: rawTargetSeconds,
        pre_clamp_target_seconds: postProbePreClampTarget,
        clamped_target_seconds: clampedTarget,
        duration_seconds: duration,
        seek_reason: reason || '',
        evaluation_phase: 'after-probe',
      });
    }
  }
  if (!forceSessionRestart && trySeekCompatibilityInSession(active, probePayload, clampedTarget, reason, 'after-probe')) {
    return;
  }
  var wasPlaying = ctx.playbackShouldBeRunning();
  ctx.state.requestedSeekSeconds = clampedTarget;
  ctx.state.seekRestartInProgress = true;
  ctx.clearSubtitleTrack();
  ctx.state.pendingAutoplay = wasPlaying || reason === 'scrub';
  if (ctx.els.videoEl && typeof ctx.els.videoEl.pause === 'function') {
    ctx.els.videoEl.pause();
  }
  if (ctx.els.progressSliderEl) ctx.els.progressSliderEl.value = String(clampedTarget);
  if (ctx.els.elapsedTimeEl) ctx.els.elapsedTimeEl.textContent = ctx.formatNativePlaybackTime(clampedTarget);
  ctx.setPlaybackSummary(ctx.activeItemTitle(active), 'Loading compatibility playback at ' + ctx.formatPlaybackTime(clampedTarget) + '.');
  ctx.showLoadingOverlay(ctx.loadingOverlayCopy(
    active,
    'Creating a compatibility stream at ' + ctx.formatPlaybackTime(clampedTarget) + '.',
    0.48
  ));
  ctx.setStatus('Loading compatibility playback at ' + ctx.formatPlaybackTime(clampedTarget) + '.');
  ctx.reportVideoDiagnostic(Object.assign(
    {
      level: 'info',
      message: 'Compatibility seek restart requested',
      seek_reason: reason || '',
      actual_global_time_before: ctx.currentGlobalPlaybackSeconds(),
      media_current_time_before: ctx.els.videoEl ? ctx.els.videoEl.currentTime || 0 : '',
    },
    ctx.currentProcessedRangeSnapshot(clampedTarget, duration)
  ));
  ctx.renderSubtitleTrackSelector(active, probePayload);
  ctx.persistSubtitleSelectionFromUi(active);
  if (!probePayload) {
    ctx.state.pendingAutoplay = false;
    ctx.state.transportWantsPlay = false;
    ctx.state.seekRestartInProgress = false;
    ctx.setStatus('Could not inspect video tracks.');
    return;
  }
  await stopCompatibilitySession('', {
    clearLocalFirst: true,
    transitionToken: syncToken,
  });
  if (syncToken !== ctx.state.playbackSyncToken) return;
  var audioStreamIndex = ctx.selectedAudioStreamIndex(active, probePayload);
  var burnedInSubtitleStreamIndex = ctx.selectedBurnedInSubtitleStreamIndex(active, probePayload);
  var waitingForSelectedSubtitles = ctx.subtitlesEnabledForItem(active, probePayload)
    && burnedInSubtitleStreamIndex === null;
  try {
    ctx.reportPlaybackTiming('session_create_requested', {requested_time: clampedTarget});
    var session = await createCompatibilitySession(
      active,
      audioStreamIndex,
      clampedTarget,
      burnedInSubtitleStreamIndex,
      {
        forceVideoTranscode,
        forceAudioTranscode,
        transitionToken: syncToken,
      }
    );
    if (syncToken !== ctx.state.playbackSyncToken) {
      await postStopCompatibilitySession(session.session_id || '', {transitionToken: syncToken});
      return;
    }
    ctx.state.compatibilitySessionId = session.session_id || '';
    ctx.state.compatibilitySessionPath = active.path || '';
    ctx.state.compatibilityAudioStreamIndex = audioStreamIndex;
    ctx.state.compatibilitySessionBurnedInSubtitleStreamIndex = burnedInSubtitleStreamIndex;
    ctx.state.compatibilitySessionVideoMode = session.video_mode || '';
    ctx.state.compatibilitySessionVideoModeReason = session.video_mode_reason || '';
    ctx.state.compatibilitySessionAudioMode = session.audio_mode || '';
    ctx.state.compatibilitySessionAudioModeReason = session.audio_mode_reason || '';
    ctx.reportPlaybackTiming('session_create_complete', {
      requested_time: clampedTarget,
      server_session_create_elapsed_ms: session.session_create_elapsed_ms,
      force_video_transcode: forceVideoTranscode ? '1' : '0',
      force_audio_transcode: forceAudioTranscode ? '1' : '0',
    });
    ctx.reportCompatibilitySeekTiming('session_create_response', {
      requested_time: clampedTarget,
      server_start_time_seconds: Number(session.start_time_seconds) || 0,
      encoded_media_end_seconds: Number(session.encoded_media_end_seconds) || 0,
      session_id: session.session_id || '',
      seek_reason: reason || '',
      video_mode: session.video_mode || '',
      force_video_transcode: forceVideoTranscode ? '1' : '0',
      audio_mode: session.audio_mode || '',
      force_audio_transcode: forceAudioTranscode ? '1' : '0',
    });
    ctx.showLoadingOverlay(ctx.loadingOverlayCopy(
      active,
      'Compatibility session is ready. Starting the video player.',
      0.72
    ));
    ctx.state.compatibilityEncodedMediaEndSeconds = Math.max(
      0,
      Number(session.encoded_media_end_seconds) || 0
    );
    ctx.state.compatibilitySegmentDurationSeconds = Math.max(
      0,
      Number(session.hls_segment_duration_seconds) || 0
    );
    var deferredSeekSeconds = ctx.state.requestedSeekSeconds;
    attachCompatibilityVideo(
      session.playlist_url,
      ctx.activeItemTitle(active),
      'Playing through a local HLS compatibility session from ' + ctx.formatPlaybackTime(Number(session.start_time_seconds) || 0) + '.',
      Number(session.start_time_seconds) || clampedTarget,
      syncToken
    );
    ctx.state.compatibilitySubtitleStreamIndex = ctx.normalizeSubtitleStreamIndex(session.subtitle_stream_index);
    ctx.state.seekRestartInProgress = false;
    ctx.state.requestedSeekSeconds = null;
    if (ctx.state.pendingSubtitleStyleApply) {
      ctx.state.pendingSubtitleStyleApply = false;
      void restartCompatibilityAt(ctx.currentGlobalPlaybackSeconds(), 'subtitle-style-apply-pending', {
        forceSessionRestart: true,
      });
      return;
    }
    if (shouldApplyDeferredCompatibilitySeek(deferredSeekSeconds, clampedTarget, 0.05)) {
      ctx.reportVideoDiagnostic({
        level: 'info',
        message: 'Compatibility deferred seek requested after restart',
        seek_reason: reason || '',
        completed_requested_time: clampedTarget,
        deferred_requested_time: Number(deferredSeekSeconds),
        restart_session_start_seconds: Number(session.start_time_seconds) || clampedTarget,
      });
      void restartCompatibilityAt(Number(deferredSeekSeconds), 'scrub-deferred');
      return;
    }
    if (ctx.state.pendingSubtitleTrackChange) {
      ctx.state.pendingSubtitleTrackChange = false;
      ctx.reportVideoDiagnostic({
        level: 'info',
        message: 'Replaying deferred subtitle track change after compatibility restart',
        seek_reason: reason || '',
        requested_time: clampedTarget,
        session_id: session.session_id || '',
        subtitle_stream_index: session.subtitle_stream_index,
      });
      void ctx.handleSubtitleTrackChange();
    }
    ctx.reportVideoDiagnostic(Object.assign(
      {
        level: 'info',
        message: 'Compatibility seek restart ready',
        seek_reason: reason || '',
        requested_time: clampedTarget,
        session_id: session.session_id || '',
        subtitle_stream_index: session.subtitle_stream_index,
      },
      ctx.currentProcessedRangeSnapshot(clampedTarget, duration)
    ));
    if (waitingForSelectedSubtitles) showCompatibilitySubtitleWaitStage(active);
    ctx.scheduleSubtitlesAfterPlaybackReady(
      active,
      probePayload,
      Number(session.start_time_seconds) || clampedTarget,
      syncToken,
      reason || 'restart'
    );
  }
  catch (error) {
    if (syncToken !== ctx.state.playbackSyncToken) return;
    ctx.state.compatibilitySessionId = '';
    ctx.state.compatibilitySubtitleStreamIndex = null;
    ctx.state.seekRestartInProgress = false;
    ctx.state.requestedSeekSeconds = null;
    ctx.state.playbackMode = 'compatibility';
    if (error && error.videoErrorCode === 'session_cap_reached') {
      var errorMessage = error && error.message
        ? String(error.message)
        : 'Video session limit reached.';
      ctx.reportVideoDiagnostic({
        level: 'warn',
        message: 'Compatibility seek restart rejected by server capacity limit',
        seek_reason: reason || '',
        requested_time: clampedTarget,
        error_message: errorMessage,
        error_code: error.videoErrorCode || '',
        session_error_reason: error.videoSessionErrorReason || '',
      });
      failCompatibilityPlayback(
        active,
        errorMessage,
        'Compatibility playback could not start: ' + errorMessage
      );
      return;
    }
    ctx.reportVideoDiagnostic({
      level: 'warn',
      message: 'Compatibility seek restart failed; scheduling recovery',
      seek_reason: reason || '',
      requested_time: clampedTarget,
      error_message: error && error.message ? String(error.message) : '',
    });
    scheduleCompatibilityRecovery(reason || 'restart-failed', clampedTarget, null);
  }
}

  ctx.destroyHlsController = destroyHlsController;
  ctx.clearCompatibilityManifestStallTimer = clearCompatibilityManifestStallTimer;
  ctx.clearCompatibilityRecoveryTimer = clearCompatibilityRecoveryTimer;
  ctx.resetCompatibilityRecoveryState = resetCompatibilityRecoveryState;
  ctx.compatibilityRecoveryDelayMs = compatibilityRecoveryDelayMs;
  ctx.isStaleOrMissingSegmentHlsError = isStaleOrMissingSegmentHlsError;
  ctx.scheduleCompatibilityRecovery = scheduleCompatibilityRecovery;
  ctx.scheduleCompatibilityVideoCopyFallback = scheduleCompatibilityVideoCopyFallback;
  ctx.scheduleCompatibilityAudioCopyFallback = scheduleCompatibilityAudioCopyFallback;
  ctx.compatibilityForcedVideoTranscodeRetryKey = compatibilityForcedVideoTranscodeRetryKey;
  ctx.compatibilityForcedAudioTranscodeRetryKey = compatibilityForcedAudioTranscodeRetryKey;
  ctx.handleCompatibilityHlsError = handleCompatibilityHlsError;
  ctx.resetCompatibilityBufferState = resetCompatibilityBufferState;
  ctx.compatibilitySeekableRanges = compatibilitySeekableRanges;
  ctx.noteEncodedMediaEndFromFragment = noteEncodedMediaEndFromFragment;
  ctx.compatibilityStartBufferReady = compatibilityStartBufferReady;
  ctx.compatibilityBufferedSecondsAhead = compatibilityBufferedSecondsAhead;
  ctx.waitForCompatibilityStartupSubtitles = waitForCompatibilityStartupSubtitles;
  ctx.showCompatibilitySubtitleWaitStage = showCompatibilitySubtitleWaitStage;
  ctx.revealCompatibilityPlaybackWhenReady = revealCompatibilityPlaybackWhenReady;
  ctx.maybeRevealCompatibilityPlayback = maybeRevealCompatibilityPlayback;
  ctx.noteCompatibilityFragmentLoading = noteCompatibilityFragmentLoading;
  ctx.noteCompatibilityFragmentLoaded = noteCompatibilityFragmentLoaded;
  ctx.noteCompatibilityFragmentBuffered = noteCompatibilityFragmentBuffered;
  ctx.failCompatibilityPlayback = failCompatibilityPlayback;
  ctx.clearCompatibilitySessionStatusPoll = clearCompatibilitySessionStatusPoll;
  ctx.scheduleCompatibilitySessionStatusPoll = scheduleCompatibilitySessionStatusPoll;
  ctx.pollCompatibilitySessionStatus = pollCompatibilitySessionStatus;
  ctx.clearCompatibilitySessionProgressReport = clearCompatibilitySessionProgressReport;
  ctx.compatibilityMediaPlaybackSeconds = compatibilityMediaPlaybackSeconds;
  ctx.compatibilityPlaybackState = compatibilityPlaybackState;
  ctx.armCompatibilityProgressBurst = armCompatibilityProgressBurst;
  ctx.compatibilitySessionProgressReportDelayMs = compatibilitySessionProgressReportDelayMs;
  ctx.scheduleCompatibilitySessionProgressReport = scheduleCompatibilitySessionProgressReport;
  ctx.requestCompatibilitySessionProgressReport = requestCompatibilitySessionProgressReport;
  ctx.reportCompatibilitySessionProgress = reportCompatibilitySessionProgress;
  ctx.attachCompatibilityVideo = attachCompatibilityVideo;
  ctx.createCompatibilitySession = createCompatibilitySession;
  ctx.postStopCompatibilitySession = postStopCompatibilitySession;
  ctx.trySeekCompatibilityInSession = trySeekCompatibilityInSession;
  ctx.restartCompatibilityAt = restartCompatibilityAt;
  ctx.stopCompatibilitySession = stopCompatibilitySession;
  ctx.hlsErrorTargetsCurrentSession = hlsErrorTargetsCurrentSession;
  ctx.compatibilityApi = {
    restartAt: restartCompatibilityAt,
    stopSession: stopCompatibilitySession,
  };

  if (ctx.els.videoEl) {
    ctx.els.videoEl.addEventListener('loadeddata', function () {
      if (ctx.state.playbackMode !== 'compatibility') return;
      if (compatibilityBufferedSecondsAhead() >= 6) {
        maybeRevealCompatibilityPlayback(ctx.activeItemTitle(ctx.activeQueueItem()), ctx.state.playbackSyncToken, 'media-loadeddata');
      }
    });
    ctx.els.videoEl.addEventListener('canplay', function () {
      if (ctx.state.playbackMode !== 'compatibility') return;
      if (compatibilityBufferedSecondsAhead() >= 6) {
        maybeRevealCompatibilityPlayback(ctx.activeItemTitle(ctx.activeQueueItem()), ctx.state.playbackSyncToken, 'media-canplay');
      }
    });
    ctx.els.videoEl.addEventListener('waiting', function () {
      if (ctx.state.playbackMode !== 'compatibility') return;
      ctx.reportVideoDiagnostic({level: 'debug', message: 'Video element waiting'});
      if (!ctx.playbackShouldBeRunning() || ctx.state.seekRestartInProgress) return;
      if (ctx.state.compatibilityPlaybackRevealed) return;
      var active = ctx.activeQueueItem();
      ctx.showLoadingOverlay({
        title: ctx.activeItemTitle(active),
        meta: 'Buffering compatibility playback.',
        progress: 0.96,
      });
    });
    ctx.els.videoEl.addEventListener('stalled', function () {
      if (ctx.state.playbackMode !== 'compatibility') return;
      ctx.reportVideoDiagnostic({level: 'warn', message: 'Video element stalled'});
    });
    ctx.els.videoEl.addEventListener('seeking', function () {
      if (ctx.state.playbackMode === 'compatibility') {
        armCompatibilityProgressBurst();
        requestCompatibilitySessionProgressReport('seeking', {burst: true});
        ctx.reportVideoDiagnostic({
          level: 'debug',
          message: 'Video element seeking',
          requested_time: ctx.state.requestedSeekSeconds,
          actual_global_time: ctx.currentGlobalPlaybackSeconds(),
          source_start_seconds: ctx.state.compatibilityStartSeconds,
          media_seekable: ctx.mediaRangesSummary(ctx.els.videoEl.seekable),
          media_buffered: ctx.mediaRangesSummary(ctx.els.videoEl.buffered),
        });
      }
      ctx.syncPlaybackProgress();
    });
    ctx.els.videoEl.addEventListener('seeked', function () {
      if (ctx.state.playbackMode === 'compatibility') {
        armCompatibilityProgressBurst();
        requestCompatibilitySessionProgressReport('seeked', {burst: true});
        var requestedTime = ctx.state.requestedSeekSeconds;
        var actualTime = ctx.currentGlobalPlaybackSeconds();
        ctx.reportVideoDiagnostic({
          level: 'debug',
          message: 'Video element seeked',
          requested_time: requestedTime,
          actual_global_time: actualTime,
          seek_delta: Number.isFinite(Number(requestedTime)) ? actualTime - Number(requestedTime) : '',
          source_start_seconds: ctx.state.compatibilityStartSeconds,
          media_seekable: ctx.mediaRangesSummary(ctx.els.videoEl.seekable),
          media_buffered: ctx.mediaRangesSummary(ctx.els.videoEl.buffered),
        });
      }
      ctx.state.progressSliderActive = false;
      ctx.syncPlaybackProgress();
    });
    ctx.els.videoEl.addEventListener('timeupdate', function () {
      if (ctx.state.playbackMode !== 'compatibility') return;
      requestCompatibilitySessionProgressReport('timeupdate', {immediate: false});
    });
    ctx.els.videoEl.addEventListener('pause', function () {
      if (ctx.state.playbackMode !== 'compatibility') return;
      requestCompatibilitySessionProgressReport('pause', {burst: false});
    });
    ctx.els.videoEl.addEventListener('playing', function () {
      if (ctx.state.playbackMode !== 'compatibility') return;
      armCompatibilityProgressBurst();
      requestCompatibilitySessionProgressReport('playing', {burst: true});
      ctx.reportPlaybackTiming('playing');
      ctx.emitPlaybackTimingSummary({
        buffered_seconds_ahead: compatibilityBufferedSecondsAhead(),
      });
      ctx.reportVideoDiagnostic({
        level: 'info',
        message: 'Compatibility playback playing',
      });
      setPlaylistPlaybackStatus(ctx, ctx.activeQueueItem());
    });
    ctx.els.videoEl.addEventListener('error', function () {
      var active = ctx.activeQueueItem();
      if (!active) return;
      if (ctx.state.playbackMode !== 'compatibility') return;
      ctx.reportVideoDiagnostic({
        level: 'error',
        message: 'Video element error during compatibility playback',
        media_error_code: ctx.els.videoEl.error ? ctx.els.videoEl.error.code : '',
        media_error_message: ctx.els.videoEl.error ? ctx.els.videoEl.error.message : '',
      });
      if (scheduleCompatibilityVideoCopyFallback('media-element-copy-fallback', ctx.currentGlobalPlaybackSeconds(), null)) {
        return;
      }
      if (scheduleCompatibilityAudioCopyFallback('media-element-audio-copy-fallback', ctx.currentGlobalPlaybackSeconds(), null)) {
        return;
      }
      scheduleCompatibilityRecovery('media-element-error', ctx.currentGlobalPlaybackSeconds(), null);
    });
  }
}
