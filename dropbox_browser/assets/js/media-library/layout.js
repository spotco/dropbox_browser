import {fitColumnWidthsToTotal, normalizeStoredColumnWidths, resizeColumnPair} from '../browse/columns.js';

export function initLayout(ctx) {
  var els = ctx.els;
  var state = ctx.state;
  var PLAYLIST_COLUMN_KEYS = ['filename', 'path', 'reorder'];
  var PLAYLIST_COLUMN_MIN_WIDTHS = {
    filename: 120,
    path: 150,
    reorder: 56
  };
  var PLAYLIST_COLUMN_GAP_PX = 16;
  var PLAYLIST_COLUMN_HORIZONTAL_PADDING_PX = 16;
  var playlistColumnWidths = normalizeStoredColumnWidths(
    state.defaultPlaylistColumnWidths,
    PLAYLIST_COLUMN_KEYS,
    PLAYLIST_COLUMN_MIN_WIDTHS
  );
  var activePlaylistColumnDrag = null;
  var musicPaneRestoreFrame = null;
  var musicPaneRestorePending = false;
  var musicPaneRestoreObserver = null;

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

  function restoreMusicPanePercents() {
    var savedWidths = readSavedMusicPanePercents();
    if (!musicPaneCanApply()) {
      musicPaneRestorePending = true;
      observeMusicPaneRestore();
      scheduleMusicPaneRestore();
      return savedWidths;
    }
    musicPaneRestorePending = false;
    return applyMusicPanePercents(savedWidths, false);
  }

  function musicPaneCanApply() {
    return !!(els.playerShell && musicPaneResizeEnabled() && musicPaneAvailableWidth() > 0);
  }

  function applyPendingMusicPaneRestore() {
    if (!musicPaneRestorePending || !musicPaneCanApply()) return false;
    musicPaneRestorePending = false;
    applyMusicPanePercents(readSavedMusicPanePercents(), false);
    return true;
  }

  function observeMusicPaneRestore() {
    if (
      musicPaneRestoreObserver !== null
      || !els.playerShell
      || typeof window.ResizeObserver !== 'function'
    ) return;
    musicPaneRestoreObserver = new window.ResizeObserver(function () {
      applyPendingMusicPaneRestore();
    });
    musicPaneRestoreObserver.observe(els.playerShell);
  }

  function scheduleMusicPaneRestore() {
    if (musicPaneRestoreFrame !== null || typeof window.requestAnimationFrame !== 'function') return;
    musicPaneRestoreFrame = window.requestAnimationFrame(function () {
      musicPaneRestoreFrame = null;
      applyPendingMusicPaneRestore();
    });
  }

  function currentMusicPanePixels() {
    return [
      els.libraryPane ? els.libraryPane.getBoundingClientRect().width : 0,
      els.playlistPane ? els.playlistPane.getBoundingClientRect().width : 0,
      els.playbackPane ? els.playbackPane.getBoundingClientRect().width : 0
    ];
  }

  function playlistColumnAvailableWidth() {
    var tableWidth;
    var listWidth;
    if (!els.playlistTableEl) return 0;
    listWidth = els.playlistListEl ? Math.round(els.playlistListEl.clientWidth) : 0;
    if (listWidth > 0) {
      return Math.max(0, listWidth - PLAYLIST_COLUMN_GAP_PX - PLAYLIST_COLUMN_HORIZONTAL_PADDING_PX);
    }
    tableWidth = Math.round(els.playlistTableEl.getBoundingClientRect().width);
    return Math.max(0, tableWidth - PLAYLIST_COLUMN_GAP_PX - PLAYLIST_COLUMN_HORIZONTAL_PADDING_PX);
  }

  function applyPlaylistColumnWidths(widths, persist) {
    var normalized = fitColumnWidthsToTotal(
      PLAYLIST_COLUMN_KEYS,
      widths,
      playlistColumnAvailableWidth(),
      PLAYLIST_COLUMN_MIN_WIDTHS
    );
    var totalWidth = PLAYLIST_COLUMN_KEYS.reduce(function (sum, key) {
      return sum + normalized[key];
    }, 0);
    playlistColumnWidths = normalized;
    if (els.playlistTableEl) {
      els.playlistTableEl.style.setProperty(
        '--music-playlist-grid-columns',
        normalized.filename + 'px ' + normalized.path + 'px ' + normalized.reorder + 'px'
      );
      els.playlistTableEl.style.setProperty(
        '--music-playlist-grid-min-width',
        String(totalWidth + PLAYLIST_COLUMN_GAP_PX + PLAYLIST_COLUMN_HORIZONTAL_PADDING_PX) + 'px'
      );
    }
    if (persist !== false) Settings.set(state.playlistColumnWidthSettingKey, normalized);
    return Object.assign({}, normalized);
  }

  function refreshPlaylistColumnWidths(persist) {
    if (!els.playlistTableEl) return {};
    return applyPlaylistColumnWidths(playlistColumnWidths, persist);
  }

  function stopPlaylistColumnResize() {
    if (!activePlaylistColumnDrag) return;
    activePlaylistColumnDrag.handle.classList.remove('dragging');
    if (document.body) document.body.classList.remove('music-playlist-column-resizing');
    window.removeEventListener('pointermove', activePlaylistColumnDrag.move);
    window.removeEventListener('pointerup', activePlaylistColumnDrag.end);
    window.removeEventListener('pointercancel', activePlaylistColumnDrag.end);
    Settings.set(state.playlistColumnWidthSettingKey, playlistColumnWidths);
    activePlaylistColumnDrag = null;
  }

  function startPlaylistColumnResize(leftKey, ev) {
    var columnIndex = PLAYLIST_COLUMN_KEYS.indexOf(leftKey);
    var rightKey = columnIndex >= 0 ? PLAYLIST_COLUMN_KEYS[columnIndex + 1] : '';
    var handle = ev.currentTarget;
    var startX = ev.clientX;
    var startWidths;
    if (!leftKey || !rightKey || !handle) return;
    ev.preventDefault();
    ev.stopPropagation();
    startWidths = Object.assign({}, playlistColumnWidths);
    stopPlaylistColumnResize();
    if (typeof handle.setPointerCapture === 'function' && ev.pointerId !== undefined) {
      try {
        handle.setPointerCapture(ev.pointerId);
      } catch (_error) {}
    }
    handle.classList.add('dragging');
    if (document.body) document.body.classList.add('music-playlist-column-resizing');
    activePlaylistColumnDrag = {
      handle: handle,
      move: function (moveEv) {
        playlistColumnWidths = resizeColumnPair(
          startWidths,
          leftKey,
          rightKey,
          moveEv.clientX - startX,
          PLAYLIST_COLUMN_KEYS,
          PLAYLIST_COLUMN_MIN_WIDTHS
        );
        applyPlaylistColumnWidths(playlistColumnWidths, false);
      },
      end: function () {
        stopPlaylistColumnResize();
      }
    };
    window.addEventListener('pointermove', activePlaylistColumnDrag.move);
    window.addEventListener('pointerup', activePlaylistColumnDrag.end);
    window.addEventListener('pointercancel', activePlaylistColumnDrag.end);
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
    applyPlaylistColumnWidths: applyPlaylistColumnWidths,
    clearPlaybackUiPaintTimer: clearPlaybackUiPaintTimer,
    currentMusicPanePixels: currentMusicPanePixels,
    flushDeferredMusicPaneUpdates: flushDeferredMusicPaneUpdates,
    musicPaneAvailableWidth: musicPaneAvailableWidth,
    musicPaneResizeEnabled: musicPaneResizeEnabled,
    normalizeMusicPanePercents: normalizeMusicPanePercents,
    persistMusicPanePercents: persistMusicPanePercents,
    playbackUiMayPaint: playbackUiMayPaint,
    refreshPlaylistColumnWidths: refreshPlaylistColumnWidths,
    readSavedMusicPanePercents: readSavedMusicPanePercents,
    restoreMusicPanePercents: restoreMusicPanePercents,
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
  document.addEventListener('DOMContentLoaded', function () {
    applyPendingMusicPaneRestore();
  });
  Array.prototype.forEach.call(
    document.querySelectorAll('.music-playlist-column-resizer[data-music-playlist-column-resizer]'),
    function (handle) {
      handle.addEventListener('pointerdown', function (ev) {
        startPlaylistColumnResize(handle.getAttribute('data-music-playlist-column-resizer') || '', ev);
      });
    }
  );
  playlistColumnWidths = normalizeStoredColumnWidths(
    Settings.get(state.playlistColumnWidthSettingKey, state.defaultPlaylistColumnWidths),
    PLAYLIST_COLUMN_KEYS,
    PLAYLIST_COLUMN_MIN_WIDTHS
  );
  applyPlaylistColumnWidths(playlistColumnWidths, false);
  window.addEventListener('resize', function () {
    refreshPlaylistColumnWidths(false);
  });
}
