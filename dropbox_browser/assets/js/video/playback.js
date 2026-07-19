export function initPlayback(ctx) {
function exitExpandedLayoutWhenPlaybackIsUnavailable() {
  if (typeof ctx.activeQueueItem !== 'function' || ctx.activeQueueItem()) return;
  if (typeof ctx.exitToEmbeddedPlaybackLayout === 'function') {
    void ctx.exitToEmbeddedPlaybackLayout();
  }
}

function resetPlaybackSurface() {
  if (!ctx.els.videoEl) return;
  exitExpandedLayoutWhenPlaybackIsUnavailable();
  ctx.clearCompatibilityRecoveryTimer();
  ctx.clearCompatibilitySessionStatusPoll();
  ctx.clearCompatibilitySessionProgressReport();
  ctx.hideLoadingOverlay();
  ctx.flushNativeSubtitleRenderSurface();
  ctx.resetCompatibilityRecoveryState();
  ctx.state.lastPlaybackPath = '';
  ctx.state.compatibilityStartSeconds = 0;
  ctx.state.compatibilitySubtitleStreamIndex = null;
  ctx.state.compatibilitySessionVideoMode = '';
  ctx.state.compatibilitySessionVideoModeReason = '';
  ctx.state.compatibilitySessionAudioMode = '';
  ctx.state.compatibilitySessionAudioModeReason = '';
  ctx.state.requestedSeekSeconds = null;
  ctx.state.seekRestartInProgress = false;
  ctx.state.pendingSubtitleTrackChange = false;
  ctx.state.compatibilitySessionProgressPendingImmediate = false;
  ctx.state.compatibilityProgressBurstUntilMs = 0;
  ctx.resetPlaybackProgress();
}

function clearVideoSource() {
  resetPlaybackSurface();
}

var SUBTITLE_PREVIEW_MAX_CHARS = 120;

async function syncPlaybackForActiveItem() {
  var active = ctx.activeQueueItem();
  ctx.clearCompatibilityRecoveryTimer();
  var syncToken = ++ctx.state.playbackSyncToken;
  if (!active) {
    var localSessionId = String(ctx.state.compatibilitySessionId || '');
    ctx.state.playbackMode = 'none';
    ctx.state.pendingAutoplay = false;
    ctx.state.transportWantsPlay = false;
    ctx.renderAudioTrackSelector(null, null);
    ctx.renderSubtitleTrackSelector(null, null);
    await ctx.stopCompatibilitySession(localSessionId);
    resetPlaybackSurface();
    ctx.showPlaybackPlaceholder(
      'No video selected',
      'Queue a video to start compatibility playback.'
    );
    return;
  }

  var activePath = String(active.path || '');
  var previousSessionId = String(ctx.state.compatibilitySessionId || '');
  var previousSessionPath = String(ctx.state.compatibilitySessionPath || '');
  resetPlaybackSurface();
  ctx.resetSubtitlesForActiveItemChange(active);
  if (previousSessionPath !== activePath) {
    await ctx.stopCompatibilitySession(previousSessionId, {transitionToken: syncToken});
    if (syncToken !== ctx.state.playbackSyncToken) return;
  }

  if (!ctx.state.playbackStatusLoaded) {
    if (!ctx.state.loadingPlaybackStatus) void ctx.loadPlaybackStatus();
    ctx.state.playbackMode = 'loading';
    ctx.renderAudioTrackSelector(active, null);
    ctx.showPlaybackPlaceholder(ctx.activeItemTitle(active), 'Loading video playback capabilities.');
    ctx.showLoadingOverlay(ctx.loadingOverlayCopy(active, 'Loading video playback capabilities.', 0.08));
    ctx.setStatus('Loading video playback capabilities.');
    return;
  }

  ctx.showPlaybackPlaceholder(ctx.activeItemTitle(active), '');

  if (!ctx.state.compatibilityAvailable) {
    var unavailableSessionId = String(ctx.state.compatibilitySessionId || '');
    ctx.state.pendingAutoplay = false;
    ctx.state.transportWantsPlay = false;
    ctx.state.playbackMode = 'compatibility-unavailable';
    ctx.renderAudioTrackSelector(active, null);
    ctx.renderSubtitleTrackSelector(active, null);
    await ctx.stopCompatibilitySession(unavailableSessionId);
    if (syncToken !== ctx.state.playbackSyncToken) return;
    ctx.showPlaybackPlaceholder(ctx.activeItemTitle(active), ctx.compatibilityNeededMeta(active));
    ctx.setStatus(ctx.compatibilityNeededStatus());
    return;
  }

  ctx.setPlaybackSummary(ctx.activeItemTitle(active), ctx.compatibilityNeededMeta(active));
  ctx.resetPlaybackTiming(active.path || '', 'initial-playback');
  ctx.showLoadingOverlay(ctx.loadingOverlayCopy(
    active,
    'Inspecting video tracks and preparing compatibility playback.',
    0.22
  ));
  ctx.setStatus(ctx.compatibilityNeededStatus());
  ctx.reportPlaybackTiming('probe_start', {probe_cache_hit: Boolean(ctx.state.probeCache[active.path || ''])});
  var probePayload = await ctx.ensureAudioTracksForItem(active);
  ctx.reportPlaybackTiming('probe_complete', {probe_cache_hit: Boolean(ctx.state.probeCache[active.path || ''])});
  ctx.renderSubtitleTrackSelector(active, probePayload);
  if (syncToken !== ctx.state.playbackSyncToken) return;
  if (!probePayload) {
    ctx.state.pendingAutoplay = false;
    ctx.state.transportWantsPlay = false;
    ctx.state.playbackMode = 'compatibility-error';
    ctx.showPlaybackPlaceholder(ctx.activeItemTitle(active), 'Could not inspect video tracks for compatibility playback.');
    ctx.setStatus('Could not inspect video tracks.');
    ctx.resetPlaybackProgress();
    return;
  }
  var audioStreamIndex = ctx.selectedAudioStreamIndex(active, probePayload);
  var burnedInSubtitleStreamIndex = ctx.selectedBurnedInSubtitleStreamIndex(active, probePayload);
  var waitingForSelectedSubtitles = ctx.subtitlesEnabledForItem(active, probePayload)
    && burnedInSubtitleStreamIndex === null;
  try {
    ctx.showLoadingOverlay(ctx.loadingOverlayCopy(active, 'Creating the local HLS compatibility session.', 0.48));
    ctx.reportPlaybackTiming('session_create_requested');
    var session = await ctx.createCompatibilitySession(
      active,
      audioStreamIndex,
      0,
      burnedInSubtitleStreamIndex,
      {transitionToken: syncToken},
    );
    if (syncToken !== ctx.state.playbackSyncToken) {
      await ctx.postStopCompatibilitySession(session.session_id || '', {transitionToken: syncToken});
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
      server_session_create_elapsed_ms: session.session_create_elapsed_ms,
      video_mode: session.video_mode || '',
      audio_mode: session.audio_mode || '',
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
    ctx.attachCompatibilityVideo(
      session.playlist_url,
      ctx.activeItemTitle(active),
      'Playing through a local HLS compatibility session.',
      Number(session.start_time_seconds) || 0,
      syncToken
    );
    ctx.state.compatibilitySubtitleStreamIndex = ctx.normalizeSubtitleStreamIndex(session.subtitle_stream_index);
    if (waitingForSelectedSubtitles) ctx.showCompatibilitySubtitleWaitStage(active);
    ctx.scheduleSubtitlesAfterPlaybackReady(
      active,
      probePayload,
      Number(session.start_time_seconds) || 0,
      syncToken,
      'initial-playback'
    );
  }
  catch (_error) {
    if (syncToken !== ctx.state.playbackSyncToken) return;
    ctx.state.compatibilitySessionId = '';
    ctx.state.compatibilitySubtitleStreamIndex = null;
    ctx.state.playbackMode = 'compatibility';
    ctx.reportVideoDiagnostic({
      level: 'warn',
      message: 'Compatibility playback start failed; scheduling recovery',
    });
    ctx.scheduleCompatibilityRecovery('initial-start-failed', 0, null);
  }
}

  ctx.resetPlaybackSurface = resetPlaybackSurface;
  ctx.clearVideoSource = clearVideoSource;
  ctx.syncPlaybackForActiveItem = syncPlaybackForActiveItem;
  ctx.playbackApi = {
    syncForActiveItem: syncPlaybackForActiveItem,
  };
}
