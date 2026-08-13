import {fitColumnWidthsToTotal, normalizeStoredColumnWidths, resizeColumnPair} from '../browse/columns.js';

export function initLayout(ctx) {
  var els = ctx.els;
  var state = ctx.state;
  var PLAYLIST_COLUMN_KEYS = ['index', 'filename', 'path', 'reorder'];
  var PLAYLIST_COLUMN_MIN_WIDTHS = {
    index: 48,
    filename: 120,
    path: 150,
    reorder: 56
  };
  var PLAYLIST_COLUMN_GAP_PX = 16;
  var PLAYLIST_COLUMN_HORIZONTAL_PADDING_PX = 16;
  var playlistColumnWidths = completePlaylistColumnWidths(state.defaultPlaylistColumnWidths);

  function completePlaylistColumnWidths(widths) {
    // Merge saved widths with defaults so upgrades (e.g. new "index" column) keep
    // prior custom sizes and only fill missing keys with a reasonable default.
    var normalized = normalizeStoredColumnWidths(
      widths,
      PLAYLIST_COLUMN_KEYS,
      PLAYLIST_COLUMN_MIN_WIDTHS
    );
    var defaults = state.defaultPlaylistColumnWidths || {};
    var completed = {};
    PLAYLIST_COLUMN_KEYS.forEach(function (key) {
      if (typeof normalized[key] === 'number') {
        completed[key] = normalized[key];
        return;
      }
      var fallback = Number(defaults[key]);
      if (Number.isFinite(fallback) && fallback > 0) {
        completed[key] = Math.max(PLAYLIST_COLUMN_MIN_WIDTHS[key] || 0, Math.round(fallback));
        return;
      }
      completed[key] = PLAYLIST_COLUMN_MIN_WIDTHS[key] || 48;
    });
    return completed;
  }
  var activePlaylistColumnDrag = null;
  var activeNarrowMusicPaneDrag = null;
  var musicPaneRestoreFrame = null;
  var musicPaneRestorePending = false;
  var musicPaneRestoreObserver = null;

  function isVisible() {
    return !ctx.pane.hidden && !ctx.pane.classList.contains('hidden');
  }

  function isNarrowMusicLayout() {
    return !!(
      window.matchMedia
      && window.matchMedia('(max-width: 860px)').matches
    );
  }

  function normalizeNarrowMusicPanePercents(values, defaults) {
    var fallback = Array.isArray(defaults) && defaults.length === 2 ? defaults : [50, 50];
    if (!Array.isArray(values) || values.length !== 2) return fallback.slice();
    var parsed = values.map(function (value) {
      return Number(value);
    });
    if (parsed.some(function (value) { return !Number.isFinite(value) || value <= 0; })) {
      return fallback.slice();
    }
    var total = parsed[0] + parsed[1];
    if (!Number.isFinite(total) || total <= 0) return fallback.slice();
    return parsed.map(function (value) {
      return (value / total) * 100;
    });
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
      !isNarrowMusicLayout() &&
      window.getComputedStyle(els.libraryPlaylistResizer).display !== 'none' &&
      window.getComputedStyle(els.playlistPlaybackResizer).display !== 'none');
  }

  function narrowMusicPaneResizeEnabled() {
    return !!(els.playerShell && els.libraryPlaylistResizer && els.playlistPlaybackResizer &&
      isNarrowMusicLayout() &&
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

  function narrowMusicPaneAvailableWidth() {
    if (!els.playerShell) return 0;
    return Math.max(
      0,
      (Number(els.playerShell.getBoundingClientRect().width) || 0) - state.musicPaneResizerWidth
    );
  }

  function narrowMusicPaneAvailableHeight() {
    if (!els.playerShell) return 0;
    return Math.max(
      0,
      (Number(els.playerShell.getBoundingClientRect().height) || 0) - state.musicPaneResizerWidth
    );
  }

  function adjustedNarrowMusicPanePixels(rawValues, total, minimums) {
    var targetTotal = Math.max(total, minimums[0] + minimums[1]);
    var extras = rawValues.map(function (value, index) {
      return Math.max(0, value - minimums[index]);
    });
    var extraTotal = extras[0] + extras[1];
    if (extraTotal <= 0) {
      extras = [1, 1];
      extraTotal = 2;
    }
    return minimums.map(function (minimum, index) {
      return minimum + ((targetTotal - minimums[0] - minimums[1]) * extras[index] / extraTotal);
    });
  }

  function syncMusicPaneResizerOrientation() {
    if (els.libraryPlaylistResizer && typeof els.libraryPlaylistResizer.setAttribute === 'function') {
      els.libraryPlaylistResizer.setAttribute('aria-orientation', 'vertical');
    }
    if (els.playlistPlaybackResizer && typeof els.playlistPlaybackResizer.setAttribute === 'function') {
      els.playlistPlaybackResizer.setAttribute(
        'aria-orientation',
        isNarrowMusicLayout() ? 'horizontal' : 'vertical'
      );
    }
  }

  function narrowMusicPaneWidthSettingKey() {
    return state.narrowMusicPaneWidthSettingKey || 'music-narrow-pane-widths';
  }

  function narrowMusicPaneHeightSettingKey() {
    return state.narrowMusicPaneHeightSettingKey || 'music-narrow-pane-heights';
  }

  function persistNarrowMusicPaneSizes() {
    Settings.set(
      narrowMusicPaneWidthSettingKey(),
      state.currentNarrowMusicPaneWidthPercents
    );
    Settings.set(
      narrowMusicPaneHeightSettingKey(),
      state.currentNarrowMusicPaneHeightPercents
    );
  }

  function applyNarrowMusicPaneSizes(widths, heights, persist) {
    var normalizedWidths = normalizeNarrowMusicPanePercents(
      widths,
      state.defaultNarrowMusicPaneWidthPercents
    );
    var normalizedHeights = normalizeNarrowMusicPanePercents(
      heights,
      state.defaultNarrowMusicPaneHeightPercents
    );
    var availableWidth;
    var availableHeight;
    var widthPixels;
    var heightPixels;
    state.currentNarrowMusicPaneWidthPercents = normalizedWidths.slice();
    state.currentNarrowMusicPaneHeightPercents = normalizedHeights.slice();
    if (!els.playerShell || !isNarrowMusicLayout()) {
      return {widths: normalizedWidths, heights: normalizedHeights};
    }
    availableWidth = narrowMusicPaneAvailableWidth();
    availableHeight = narrowMusicPaneAvailableHeight();
    widthPixels = adjustedNarrowMusicPanePixels(
      normalizedWidths.map(function (percent) { return availableWidth * percent / 100; }),
      availableWidth,
      state.minNarrowMusicPaneWidthsPx
    );
    heightPixels = adjustedNarrowMusicPanePixels(
      normalizedHeights.map(function (percent) { return availableHeight * percent / 100; }),
      availableHeight,
      state.minNarrowMusicPaneHeightsPx
    );
    state.currentNarrowMusicPaneWidthPercents = normalizeNarrowMusicPanePercents(
      widthPixels,
      state.defaultNarrowMusicPaneWidthPercents
    );
    state.currentNarrowMusicPaneHeightPercents = normalizeNarrowMusicPanePercents(
      heightPixels,
      state.defaultNarrowMusicPaneHeightPercents
    );
    els.playerShell.style.gridTemplateColumns =
      widthPixels[0] + 'px ' + state.musicPaneResizerWidth + 'px ' + widthPixels[1] + 'px';
    els.playerShell.style.gridTemplateRows =
      heightPixels[0] + 'px ' + state.musicPaneResizerWidth + 'px ' + heightPixels[1] + 'px';
    syncMusicPaneResizerOrientation();
    if (persist !== false) persistNarrowMusicPaneSizes();
    return {
      widths: state.currentNarrowMusicPaneWidthPercents.slice(),
      heights: state.currentNarrowMusicPaneHeightPercents.slice()
    };
  }

  function readSavedNarrowMusicPaneWidthPercents() {
    return normalizeNarrowMusicPanePercents(
      Settings.get(
        narrowMusicPaneWidthSettingKey(),
        state.defaultNarrowMusicPaneWidthPercents
      ),
      state.defaultNarrowMusicPaneWidthPercents
    );
  }

  function readSavedNarrowMusicPaneHeightPercents() {
    return normalizeNarrowMusicPanePercents(
      Settings.get(
        narrowMusicPaneHeightSettingKey(),
        state.defaultNarrowMusicPaneHeightPercents
      ),
      state.defaultNarrowMusicPaneHeightPercents
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
    if (isNarrowMusicLayout()) return normalized;
    if (!musicPaneResizeEnabled()) {
      els.playerShell.style.removeProperty('grid-template-columns');
      els.playerShell.style.removeProperty('grid-template-rows');
      syncMusicPaneResizerOrientation();
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
    els.playerShell.style.removeProperty('grid-template-rows');
    syncMusicPaneResizerOrientation();
    if (persist !== false) persistMusicPanePercents(normalized);
    return normalized;
  }

  function readSavedMusicPanePercents() {
    return normalizeMusicPanePercents(Settings.get(state.musicPaneWidthSettingKey, state.defaultMusicPanePercents));
  }

  function restoreMusicPanePercents() {
    if (isNarrowMusicLayout()) {
      var narrowWidths = readSavedNarrowMusicPaneWidthPercents();
      var narrowHeights = readSavedNarrowMusicPaneHeightPercents();
      if (!musicPaneCanApply()) {
        musicPaneRestorePending = true;
        observeMusicPaneRestore();
        scheduleMusicPaneRestore();
        return narrowWidths;
      }
      musicPaneRestorePending = false;
      applyNarrowMusicPaneSizes(narrowWidths, narrowHeights, false);
      return narrowWidths;
    }
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
    if (isNarrowMusicLayout()) {
      return !!(
        els.playerShell
        && narrowMusicPaneResizeEnabled()
        && narrowMusicPaneAvailableWidth() > 0
        && narrowMusicPaneAvailableHeight() > 0
      );
    }
    return !!(els.playerShell && musicPaneResizeEnabled() && musicPaneAvailableWidth() > 0);
  }

  function applyPendingMusicPaneRestore() {
    if (!musicPaneRestorePending || !musicPaneCanApply()) return false;
    musicPaneRestorePending = false;
    if (isNarrowMusicLayout()) {
      applyNarrowMusicPaneSizes(
        readSavedNarrowMusicPaneWidthPercents(),
        readSavedNarrowMusicPaneHeightPercents(),
        false
      );
    } else {
      applyMusicPanePercents(readSavedMusicPanePercents(), false);
    }
    // Pane width just became measurable; re-fit playlist columns to the new list width.
    refreshPlaylistColumnWidths(false);
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

  function currentNarrowMusicPanePixels() {
    return [
      els.libraryPane ? els.libraryPane.getBoundingClientRect().width : 0,
      els.playlistPane ? els.playlistPane.getBoundingClientRect().width : 0
    ];
  }

  function currentNarrowMusicPaneHeights() {
    return [
      els.libraryPane ? els.libraryPane.getBoundingClientRect().height : 0,
      els.playbackPane ? els.playbackPane.getBoundingClientRect().height : 0
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
    var completed = completePlaylistColumnWidths(
      Object.assign({}, playlistColumnWidths, widths || {})
    );
    var normalized = fitColumnWidthsToTotal(
      PLAYLIST_COLUMN_KEYS,
      completed,
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
        normalized.index + 'px ' +
          normalized.filename + 'px ' +
          normalized.path + 'px ' +
          normalized.reorder + 'px'
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

  function stopNarrowMusicPaneResize() {
    var active = activeNarrowMusicPaneDrag;
    if (!active) return;
    active.handle.classList.remove('dragging');
    window.removeEventListener('pointermove', active.move);
    window.removeEventListener('pointerup', active.end);
    window.removeEventListener('pointercancel', active.end);
    Settings.set(
      active.axis === 'width'
        ? narrowMusicPaneWidthSettingKey()
        : narrowMusicPaneHeightSettingKey(),
      active.axis === 'width'
        ? state.currentNarrowMusicPaneWidthPercents
        : state.currentNarrowMusicPaneHeightPercents
    );
    activeNarrowMusicPaneDrag = null;
  }

  function startNarrowMusicPaneResize(axis, ev) {
    var handle = ev.currentTarget;
    var startValues;
    var minimums;
    var total;
    var startPointer;
    if (!narrowMusicPaneResizeEnabled() || !handle) return;
    ev.preventDefault();
    ev.stopPropagation();
    stopNarrowMusicPaneResize();
    startValues = axis === 'width'
      ? currentNarrowMusicPanePixels()
      : currentNarrowMusicPaneHeights();
    minimums = axis === 'width'
      ? state.minNarrowMusicPaneWidthsPx
      : state.minNarrowMusicPaneHeightsPx;
    total = startValues[0] + startValues[1];
    startPointer = axis === 'width' ? ev.clientX : ev.clientY;
    if (total <= 0) return;
    if (typeof handle.setPointerCapture === 'function' && ev.pointerId !== undefined) {
      try {
        handle.setPointerCapture(ev.pointerId);
      } catch (_error) {}
    }
    handle.classList.add('dragging');

    function move(moveEv) {
      var delta = (axis === 'width' ? moveEv.clientX : moveEv.clientY) - startPointer;
      var nextValue = Math.min(
        Math.max(startValues[0] + delta, minimums[0]),
        Math.max(minimums[0], total - minimums[1])
      );
      var values = [nextValue, total - nextValue];
      if (axis === 'width') {
        applyNarrowMusicPaneSizes(values, state.currentNarrowMusicPaneHeightPercents, false);
      } else {
        applyNarrowMusicPaneSizes(state.currentNarrowMusicPaneWidthPercents, values, false);
      }
    }

    function end() {
      stopNarrowMusicPaneResize();
    }

    activeNarrowMusicPaneDrag = {axis: axis, handle: handle, move: move, end: end};
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  function startMusicPaneResize(resizerIndex, ev) {
    if (isNarrowMusicLayout()) {
      startNarrowMusicPaneResize(resizerIndex === 0 ? 'width' : 'height', ev);
      return;
    }
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
    applyNarrowMusicPaneSizes: applyNarrowMusicPaneSizes,
    applyPlaylistColumnWidths: applyPlaylistColumnWidths,
    clearPlaybackUiPaintTimer: clearPlaybackUiPaintTimer,
    currentMusicPanePixels: currentMusicPanePixels,
    currentNarrowMusicPaneHeights: currentNarrowMusicPaneHeights,
    currentNarrowMusicPanePixels: currentNarrowMusicPanePixels,
    flushDeferredMusicPaneUpdates: flushDeferredMusicPaneUpdates,
    musicPaneAvailableWidth: musicPaneAvailableWidth,
    musicPaneResizeEnabled: musicPaneResizeEnabled,
    narrowMusicPaneResizeEnabled: narrowMusicPaneResizeEnabled,
    normalizeNarrowMusicPanePercents: normalizeNarrowMusicPanePercents,
    normalizeMusicPanePercents: normalizeMusicPanePercents,
    persistMusicPanePercents: persistMusicPanePercents,
    playbackUiMayPaint: playbackUiMayPaint,
    refreshPlaylistColumnWidths: refreshPlaylistColumnWidths,
    readSavedMusicPanePercents: readSavedMusicPanePercents,
    readSavedNarrowMusicPaneHeightPercents: readSavedNarrowMusicPaneHeightPercents,
    readSavedNarrowMusicPaneWidthPercents: readSavedNarrowMusicPaneWidthPercents,
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
  playlistColumnWidths = completePlaylistColumnWidths(
    Settings.get(state.playlistColumnWidthSettingKey, state.defaultPlaylistColumnWidths)
  );
  applyPlaylistColumnWidths(playlistColumnWidths, false);
  window.addEventListener('resize', function () {
    restoreMusicPanePercents();
    refreshPlaylistColumnWidths(false);
  });
  syncMusicPaneResizerOrientation();
}
