export function initLayout(ctx) {
  var els = ctx.els;
  var state = ctx.state;

  function isVisible() {
    return !ctx.pane.hidden && !ctx.pane.classList.contains('hidden');
  }

  function normalizeMusicPanePercents(values) {
    if (!Array.isArray(values) || values.length !== 3) return state.defaultMusicPanePercents.slice();
    var parsed = values.map(function (value) {
      return Number(value);
    });
    if (parsed.some(function (value) { return !Number.isFinite(value) || value <= 0; })) {
      return state.defaultMusicPanePercents.slice();
    }
    var total = parsed[0] + parsed[1] + parsed[2];
    if (!Number.isFinite(total) || total <= 0) return state.defaultMusicPanePercents.slice();
    return parsed.map(function (value) {
      return (value / total) * 100;
    });
  }

  function musicPaneResizeEnabled() {
    return !!(els.playerShell && els.libraryPlaylistResizer && els.playlistPlaybackResizer &&
      window.getComputedStyle(els.libraryPlaylistResizer).display !== 'none' &&
      window.getComputedStyle(els.playlistPlaybackResizer).display !== 'none');
  }

  function musicPaneAvailableWidth() {
    if (!els.playerShell) return 0;
    return Math.max(
      0,
      els.playerShell.getBoundingClientRect().width - (state.musicPaneResizerWidth * 2)
    );
  }

  function adjustedMusicPanePixels(rawWidths, totalWidth) {
    var minimumTotal = state.minMusicPaneWidthsPx[0] + state.minMusicPaneWidthsPx[1] + state.minMusicPaneWidthsPx[2];
    var targetTotal = Math.max(totalWidth, minimumTotal);
    var remaining = targetTotal - minimumTotal;
    var extras = rawWidths.map(function (width, index) {
      return Math.max(0, width - state.minMusicPaneWidthsPx[index]);
    });
    var extraTotal = extras[0] + extras[1] + extras[2];
    if (extraTotal <= 0) {
      extras = state.defaultMusicPanePercents.map(function (percent, index) {
        return Math.max(0, (targetTotal * percent / 100) - state.minMusicPaneWidthsPx[index]);
      });
      extraTotal = extras[0] + extras[1] + extras[2];
    }
    if (extraTotal <= 0) {
      extras = [1, 1, 1];
      extraTotal = 3;
    }
    return state.minMusicPaneWidthsPx.map(function (minimum, index) {
      return minimum + (remaining * extras[index] / extraTotal);
    });
  }

  function persistMusicPanePercents(widths) {
    state.currentMusicPanePercents = normalizeMusicPanePercents(widths);
    Settings.set(state.musicPaneWidthSettingKey, state.currentMusicPanePercents);
  }

  function applyMusicPanePercents(widths, persist) {
    var normalized = normalizeMusicPanePercents(widths);
    var availableWidth;
    var pixels;
    state.currentMusicPanePercents = normalized.slice();
    if (!els.playerShell) return normalized;
    if (!musicPaneResizeEnabled()) {
      els.playerShell.style.removeProperty('grid-template-columns');
      if (persist !== false) persistMusicPanePercents(normalized);
      return normalized;
    }
    availableWidth = musicPaneAvailableWidth();
    pixels = adjustedMusicPanePixels(normalized.map(function (percent) {
      return availableWidth * percent / 100;
    }), availableWidth);
    normalized = normalizeMusicPanePercents(pixels);
    state.currentMusicPanePercents = normalized.slice();
    els.playerShell.style.gridTemplateColumns =
      pixels[0] + 'px ' + state.musicPaneResizerWidth + 'px ' +
      pixels[1] + 'px ' + state.musicPaneResizerWidth + 'px ' +
      pixels[2] + 'px';
    if (persist !== false) persistMusicPanePercents(normalized);
    return normalized;
  }

  function readSavedMusicPanePercents() {
    return normalizeMusicPanePercents(Settings.get(state.musicPaneWidthSettingKey, state.defaultMusicPanePercents));
  }

  function currentMusicPanePixels() {
    return [
      els.libraryPane ? els.libraryPane.getBoundingClientRect().width : 0,
      els.playlistPane ? els.playlistPane.getBoundingClientRect().width : 0,
      els.playbackPane ? els.playbackPane.getBoundingClientRect().width : 0
    ];
  }

  function startMusicPaneResize(resizerIndex, ev) {
    if (!musicPaneResizeEnabled()) return;
    ev.preventDefault();
    var startX = ev.clientX;
    var startWidths = currentMusicPanePixels();
    var activeResizer = resizerIndex === 0 ? els.libraryPlaylistResizer : els.playlistPlaybackResizer;
    if (!activeResizer) return;
    activeResizer.classList.add('dragging');

    function move(moveEv) {
      var delta = moveEv.clientX - startX;
      var widths = startWidths.slice();
      var pairStartIndex = resizerIndex;
      var totalPairWidth = startWidths[pairStartIndex] + startWidths[pairStartIndex + 1];
      var nextWidth = Math.min(
        Math.max(startWidths[pairStartIndex] + delta, state.minMusicPaneWidthsPx[pairStartIndex]),
        totalPairWidth - state.minMusicPaneWidthsPx[pairStartIndex + 1]
      );
      widths[pairStartIndex] = nextWidth;
      widths[pairStartIndex + 1] = totalPairWidth - nextWidth;
      applyMusicPanePercents(widths, false);
    }

    function end() {
      activeResizer.classList.remove('dragging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      persistMusicPanePercents(state.currentMusicPanePercents);
    }

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  function playbackUiMayPaint() {
    return !document.hidden && isVisible();
  }

  function clearPlaybackUiPaintTimer() {
    if (!state.playbackUiPaintTimer) return;
    window.clearTimeout(state.playbackUiPaintTimer);
    state.playbackUiPaintTimer = null;
  }

  function schedulePlaybackDisplayPaint() {
    var delay;
    if (!playbackUiMayPaint()) return;
    if (document.hasFocus()) {
      clearPlaybackUiPaintTimer();
      ctx.playbackApi.paintPlaybackDisplay();
      return;
    }
    if (state.playbackUiPaintTimer) return;
    delay = Math.max(0, state.playbackUiThrottleMs - (Date.now() - state.playbackUiLastPaintMs));
    state.playbackUiPaintTimer = window.setTimeout(function () {
      state.playbackUiPaintTimer = null;
      if (playbackUiMayPaint()) ctx.playbackApi.paintPlaybackDisplay();
    }, delay);
  }

  function flushDeferredMusicPaneUpdates() {
    var focusRemotePath;
    if (!playbackUiMayPaint()) return;
    if (state.pendingLibraryStatusText !== null) {
      ctx.setStatus(state.pendingLibraryStatusText);
      state.pendingLibraryStatusText = null;
    }
    if (state.libraryRenderDirty) ctx.libraryApi.paintLibrary();
    if (state.playlistRenderDirty) ctx.playlistApi.paintPlaylist();
    else if (state.playlistSelectionDirty) ctx.playlistApi.paintPlaylistSelection();
    focusRemotePath = state.pendingPlaylistFocusRemotePath;
    state.pendingPlaylistFocusRemotePath = null;
    if (focusRemotePath) ctx.playlistApi.focusPlaylistRemotePath(focusRemotePath);
  }

  function resumeLibraryUpdates() {
    if (!state.libraryRequested || !playbackUiMayPaint() || state.loading) return;
    ctx.libraryApi.fetchLibrary(true);
  }

  ctx.layoutApi = {
    adjustedMusicPanePixels: adjustedMusicPanePixels,
    applyMusicPanePercents: applyMusicPanePercents,
    clearPlaybackUiPaintTimer: clearPlaybackUiPaintTimer,
    currentMusicPanePixels: currentMusicPanePixels,
    flushDeferredMusicPaneUpdates: flushDeferredMusicPaneUpdates,
    musicPaneAvailableWidth: musicPaneAvailableWidth,
    musicPaneResizeEnabled: musicPaneResizeEnabled,
    normalizeMusicPanePercents: normalizeMusicPanePercents,
    persistMusicPanePercents: persistMusicPanePercents,
    playbackUiMayPaint: playbackUiMayPaint,
    readSavedMusicPanePercents: readSavedMusicPanePercents,
    resumeLibraryUpdates: resumeLibraryUpdates,
    schedulePlaybackDisplayPaint: schedulePlaybackDisplayPaint,
    startMusicPaneResize: startMusicPaneResize
  };

  if (els.libraryPlaylistResizer) {
    els.libraryPlaylistResizer.addEventListener('pointerdown', function (ev) {
      startMusicPaneResize(0, ev);
    });
  }
  if (els.playlistPlaybackResizer) {
    els.playlistPlaybackResizer.addEventListener('pointerdown', function (ev) {
      startMusicPaneResize(1, ev);
    });
  }
}
