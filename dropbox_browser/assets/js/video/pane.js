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
  // Do not auto-fetch the recursive library; match music and only load when
  // the user presses "Load Current Folder". Keep an already-loaded tree for
  // the current folder until the user navigates or reloads explicitly.
  if (!ctx.state.libraryRequested) {
    ctx.setStatus('Current folder video library is ready to load.');
  }
  void ctx.syncPlaybackForActiveItem();
  void ctx.loadPlaybackStatus();
}

  ctx.syncPaneMode = syncPaneMode;
  ctx.paneApi = {
    syncPaneMode: syncPaneMode,
  };
}
