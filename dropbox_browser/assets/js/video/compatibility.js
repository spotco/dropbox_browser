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
  COMPATIBILITY_RECOVERY_MAX_DELAY_MS,
  COMPATIBILITY_RECOVERY_MIN_DELAY_MS,
  COMPATIBILITY_SESSION_STATUS_POLL_MS,
  COMPATIBILITY_START_BUFFER_FRAGMENTS,
  COMPATIBILITY_SUBTITLE_WAIT_META,
} from './constants.js';

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
  if (
    !ctx.state.paneActive
    || !ctx.state.compatibilitySessionId
    || ctx.state.playbackMode !== 'compatibility'
    || ctx.state.compatibilitySessionStatusRequestInFlight
  ) {
    return;
  }
  ctx.state.compatibilitySessionStatusRequestInFlight = true;
  try {
    var response = await fetch('/video/endpoints/status');
    if (!response.ok) return;
    var payload = await response.json();
    var activeSession = payload && payload.active_session ? payload.active_session : null;
    if (
      activeSession
      && activeSession.session_id === ctx.state.compatibilitySessionId
      && activeSession.path === ctx.state.compatibilitySessionPath
    ) {
      ctx.state.compatibilityEncodedMediaEndSeconds = Math.max(
        ctx.state.compatibilityEncodedMediaEndSeconds || 0,
        Number(activeSession.encoded_media_end_seconds) || 0
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
  var active = ctx.activeQueueItem();
  if (!active || !ctx.state.compatibilityAvailable) return;
  if (ctx.state.compatibilityRecoveryTimer || ctx.state.compatibilityRecoveryScheduled) return;
  if (ctx.state.seekRestartInProgress) return;

  ctx.state.compatibilityRecoveryAttempts += 1;
  ctx.state.compatibilityRecoveryScheduled = true;
  ctx.state.transportWantsPlay = true;
  ctx.state.pendingAutoplay = true;

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
    hls_details: data && data.details || '',
    hls_reason: data && (data.reason || data.error && data.error.message) || '',
    hls_url: data && data.frag && data.frag.url ? data.frag.url : (data && data.context && data.context.url ? data.context.url : ''),
  });

  ctx.state.compatibilityRecoveryTimer = window.setTimeout(function () {
    ctx.state.compatibilityRecoveryTimer = 0;
    ctx.state.compatibilityRecoveryScheduled = false;
    if (!ctx.activeQueueItem() || !ctx.state.compatibilityAvailable) return;
    void restartCompatibilityAt(resumeSeconds, reason || 'auto-recovery');
  }, delayMs);
}

function handleCompatibilityHlsError(data) {
  if (!data || !data.fatal) return;
  var active = ctx.activeQueueItem();
  if (!active || ctx.state.playbackMode !== 'compatibility') return;
  if (!hlsErrorTargetsCurrentSession(data)) return;

  if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
    if (isStaleOrMissingSegmentHlsError(data)) {
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
  await ctx.ensureStartupSubtitleWindowForPlayback(active, probePayload, fetchStartSeconds, {
    windowStatus: fetchStartSeconds > 0 ? 'seek' : 'startup',
    playbackSyncToken: surfaceSyncToken,
  });
}

function showCompatibilitySubtitleWaitStage(item) {
  if (!item) return;
  ctx.state.compatibilitySubtitleWaitStageActive = true;
  ctx.showLoadingOverlay(ctx.loadingOverlayCopy(
    item,
    COMPATIBILITY_SUBTITLE_WAIT_META,
    0.84
  ));
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

async function stopCompatibilitySession() {
  var sessionId = ctx.state.compatibilitySessionId;
  clearCompatibilitySessionStatusPoll();
  ctx.state.compatibilitySessionId = '';
  ctx.state.compatibilitySessionPath = '';
  ctx.state.compatibilityAudioStreamIndex = null;
  ctx.state.compatibilitySessionBurnedInSubtitleStreamIndex = null;
  ctx.state.compatibilityEncodedMediaEndSeconds = 0;
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

function attachCompatibilityVideo(playlistUrl, title, meta, startSeconds, surfaceSyncToken) {
  if (!ctx.els.videoEl) return;
  ctx.clearVideoSource();
  resetCompatibilityBufferState();
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
      ctx.reportVideoDiagnostic({
        level: 'debug',
        message: 'HLS fragment loading',
        frag_sn: data && data.frag ? data.frag.sn : '',
        frag_url: data && data.frag ? data.frag.url : '',
      });
    });
    ctx.state.hlsController.on(Hls.Events.FRAG_LOADED, function (_eventName, data) {
      ctx.reportVideoDiagnostic({
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
        ctx.reportPlaybackTiming('hls_first_fragment_loaded', {
          frag_sn: data.frag.sn,
          loading_ms: data && data.stats && data.stats.loading
            ? Math.round(data.stats.loading.end - data.stats.loading.start)
            : '',
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
      handleCompatibilityHlsError(data);
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
  ctx.syncPlaybackProgress();
  ctx.syncTransportControls();
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

async function restartCompatibilityAt(targetSeconds, reason) {
  var active = ctx.activeQueueItem();
  if (!active || !ctx.state.compatibilityAvailable) return;
  clearCompatibilityRecoveryTimer();
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
  var forceSessionRestart = compatibilityRecoveryRequiresSessionRestart(reason || '');
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
  await stopCompatibilitySession();
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
      burnedInSubtitleStreamIndex
    );
    if (syncToken !== ctx.state.playbackSyncToken) {
      await stopCompatibilitySession();
      return;
    }
    ctx.state.compatibilitySessionId = session.session_id || '';
    ctx.state.compatibilitySessionPath = active.path || '';
    ctx.state.compatibilityAudioStreamIndex = audioStreamIndex;
    ctx.state.compatibilitySessionBurnedInSubtitleStreamIndex = burnedInSubtitleStreamIndex;
    ctx.reportPlaybackTiming('session_create_complete', {
      requested_time: clampedTarget,
      server_session_create_elapsed_ms: session.session_create_elapsed_ms,
    });
    ctx.reportCompatibilitySeekTiming('session_create_response', {
      requested_time: clampedTarget,
      server_start_time_seconds: Number(session.start_time_seconds) || 0,
      encoded_media_end_seconds: Number(session.encoded_media_end_seconds) || 0,
      session_id: session.session_id || '',
      seek_reason: reason || '',
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
  catch (_error) {
    if (syncToken !== ctx.state.playbackSyncToken) return;
    ctx.state.compatibilitySessionId = '';
    ctx.state.compatibilitySubtitleStreamIndex = null;
    ctx.state.seekRestartInProgress = false;
    ctx.state.requestedSeekSeconds = null;
    ctx.state.playbackMode = 'compatibility';
    ctx.reportVideoDiagnostic({
      level: 'warn',
      message: 'Compatibility seek restart failed; scheduling recovery',
      seek_reason: reason || '',
      requested_time: clampedTarget,
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
  ctx.noteCompatibilityFragmentBuffered = noteCompatibilityFragmentBuffered;
  ctx.failCompatibilityPlayback = failCompatibilityPlayback;
  ctx.clearCompatibilitySessionStatusPoll = clearCompatibilitySessionStatusPoll;
  ctx.scheduleCompatibilitySessionStatusPoll = scheduleCompatibilitySessionStatusPoll;
  ctx.pollCompatibilitySessionStatus = pollCompatibilitySessionStatus;
  ctx.attachCompatibilityVideo = attachCompatibilityVideo;
  ctx.createCompatibilitySession = createCompatibilitySession;
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
    ctx.els.videoEl.addEventListener('playing', function () {
      if (ctx.state.playbackMode !== 'compatibility') return;
      ctx.reportPlaybackTiming('playing');
      ctx.emitPlaybackTimingSummary({
        buffered_seconds_ahead: compatibilityBufferedSecondsAhead(),
      });
      ctx.reportVideoDiagnostic({
        level: 'info',
        message: 'Compatibility playback playing',
      });
      ctx.setStatus('Playing remote video through HLS compatibility playback.');
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
      scheduleCompatibilityRecovery('media-element-error', ctx.currentGlobalPlaybackSeconds(), null);
    });
  }
}
