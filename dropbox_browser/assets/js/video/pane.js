export function initPane(ctx) {
function syncPaneMode(mode) {
  var active = mode === 'video-player';
  ctx.state.paneActive = active;
  ctx.pane.setAttribute('data-video-pane-active', active ? '1' : '0');
  if (!active) {
    // Leave full-window / native fullscreen so browse chrome and other panes
    // are not trapped under video layout takeover (bottom-pane mode change).
    if (typeof ctx.exitToEmbeddedPlaybackLayout === 'function') {
      void ctx.exitToEmbeddedPlaybackLayout();
    } else if (typeof ctx.exitFullWindowLayout === 'function') {
      ctx.exitFullWindowLayout();
    }
    if (typeof ctx.syncTransportControls === 'function') {
      ctx.syncTransportControls();
    }
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
