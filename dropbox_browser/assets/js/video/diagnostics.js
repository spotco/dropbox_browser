export function initDiagnostics(ctx) {
function resetPlaybackTiming(path, reason) {
  ctx.state.playbackTiming = {
    path: String(path || ''),
    reason: String(reason || 'playback'),
    startedAtMs: performance.now(),
    milestones: Object.create(null),
    summaryLogged: false,
  };
  reportPlaybackTiming('playback_requested');
}

function reportPlaybackTiming(milestone, fields) {
  var timing = ctx.state.playbackTiming;
  if (!timing || !timing.startedAtMs) return 0;
  var elapsedMs = Math.round(performance.now() - timing.startedAtMs);
  if (milestone) timing.milestones[milestone] = elapsedMs;
  if (!window.ClientLogger || !window.ClientLogger.enabledFor('video-timing')) return elapsedMs;
  var details = Object.assign({}, fields || {}, {
    milestone: milestone,
    elapsed_ms: elapsedMs,
    path: timing.path || '',
    reason: timing.reason || '',
    session_id: ctx.state.compatibilitySessionId || '',
    playback_mode: ctx.state.playbackMode || '',
  });
  window.ClientLogger.log('video-timing', 'info', 'Playback timing: ' + milestone, details);
  return elapsedMs;
}

function emitPlaybackTimingSummary(fields) {
  var timing = ctx.state.playbackTiming;
  if (!timing || timing.summaryLogged) return;
  timing.summaryLogged = true;
  var totalMs = Math.round(performance.now() - timing.startedAtMs);
  if (!window.ClientLogger || !window.ClientLogger.enabledFor('video-timing')) return;
  window.ClientLogger.log('video-timing', 'info', 'Playback timing summary', Object.assign({
    path: timing.path || '',
    reason: timing.reason || '',
    session_id: ctx.state.compatibilitySessionId || '',
    milestones: Object.assign({}, timing.milestones),
    total_to_playing_ms: totalMs,
  }, fields || {}));
}

function reportVideoDiagnostic(fields) {
  try {
    if (!window.ClientLogger) return;
    var active = ctx.activeQueueItem();
    var details = Object.assign({}, fields || {}, {
      playback_mode: ctx.state.playbackMode || '',
      session_id: ctx.state.compatibilitySessionId || '',
      path: active && active.path ? active.path : '',
      current_time: ctx.els.videoEl ? ctx.els.videoEl.currentTime || 0 : '',
      global_current_time: ctx.currentGlobalPlaybackSeconds(),
      source_start_seconds: ctx.state.compatibilityStartSeconds || 0,
      ready_state: ctx.els.videoEl ? ctx.els.videoEl.readyState : '',
      network_state: ctx.els.videoEl ? ctx.els.videoEl.networkState : '',
    });
    var level = details.level || 'debug';
    var message = details.message || 'video diagnostic';
    window.ClientLogger.log('video', level, message, details);
  }
  catch (_error) {
    return;
  }
}

function reportCompatibilitySeekTiming(milestone, fields) {
  var snapshotTarget = fields
    ? (fields.target_seconds ?? fields.requested_time ?? fields.raw_target_seconds)
    : undefined;
  var details = Object.assign({}, ctx.currentProcessedRangeSnapshot(snapshotTarget), fields || {});
  reportPlaybackTiming(milestone, details);
  reportVideoDiagnostic(Object.assign({
    level: 'info',
    message: 'Compatibility seek: ' + milestone,
  }, details));
}

function subtitleSyncContext(fields) {
  var active = ctx.activeQueueItem();
  var mountState = ctx.state.subtitleMountState || {};
  return Object.assign({}, fields || {}, {
    playback_mode: ctx.state.playbackMode || '',
    path: active && active.path ? active.path : '',
    media_current_time: ctx.els.videoEl ? ctx.els.videoEl.currentTime || 0 : '',
    global_current_time: ctx.currentGlobalPlaybackSeconds(),
    source_start_seconds: ctx.state.compatibilityStartSeconds || 0,
    subtitle_fetch_start_seconds: ctx.state.subtitleDebug.fetchStartSeconds || 0,
    subtitle_track_label: ctx.state.subtitleDebug.trackLabel || '',
    subtitle_mount_mode: mountState.mode || 'none',
    subtitle_mounted_stream_index: mountState.streamIndex,
    subtitle_mounted_seek_seconds: Number(mountState.seekSeconds) || 0,
    playback_sync_token: ctx.state.playbackSyncToken,
  });
}

function reportSubtitleDiagnostic(fields) {
  try {
    if (!window.ClientLogger || !window.ClientLogger.enabledFor('video-subtitles')) return;
    var details = subtitleSyncContext(fields || {});
    var level = details.level || 'debug';
    var message = details.message || 'subtitle diagnostic';
    delete details.level;
    delete details.message;
    window.ClientLogger.log('video-subtitles', level, message, details);
  }
  catch (_error) {
    return;
  }
}

function reportSubtitleSyncDiagnostic(fields) {
  reportSubtitleDiagnostic(fields);
  try {
    if (!window.ClientLogger || !window.ClientLogger.enabledFor('video')) return;
    var details = subtitleSyncContext(fields || {});
    var level = details.level || 'info';
    var message = details.message || 'subtitle sync';
    delete details.level;
    delete details.message;
    window.ClientLogger.log('video', level, message, details);
  }
  catch (_error) {
    return;
  }
}

  ctx.resetPlaybackTiming = resetPlaybackTiming;
  ctx.reportPlaybackTiming = reportPlaybackTiming;
  ctx.emitPlaybackTimingSummary = emitPlaybackTimingSummary;
  ctx.reportVideoDiagnostic = reportVideoDiagnostic;
  ctx.reportCompatibilitySeekTiming = reportCompatibilitySeekTiming;
  ctx.subtitleSyncContext = subtitleSyncContext;
  ctx.reportSubtitleDiagnostic = reportSubtitleDiagnostic;
  ctx.reportSubtitleSyncDiagnostic = reportSubtitleSyncDiagnostic;
}
