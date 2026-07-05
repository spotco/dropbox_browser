export function initPane(ctx) {
function syncPaneMode(mode) {
  var active = mode === 'video-player';
  ctx.state.paneActive = active;
  ctx.pane.setAttribute('data-video-pane-active', active ? '1' : '0');
  if (!active) {
    var localSessionId = String(ctx.state.compatibilitySessionId || '');
    void ctx.stopCompatibilitySession(localSessionId);
    ctx.resetPlaybackSurface();
    ctx.renderAudioTrackSelector(null, null);
    ctx.renderSubtitleTrackSelector(null, null);
    return;
  }
  ctx.updateCurrentFolder(ctx.currentFolderPath());
  ctx.setStatus('Current folder video library is ready to load.');
  void ctx.syncPlaybackForActiveItem();
  void ctx.loadPlaybackStatus();
  void ctx.loadLibrary(ctx.state.currentFolder);
}

  ctx.syncPaneMode = syncPaneMode;
  ctx.paneApi = {
    syncPaneMode: syncPaneMode,
  };
}
