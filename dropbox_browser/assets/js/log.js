(function () {
  var panel = document.getElementById('log-panel');
  var entries = document.getElementById('log-entries');
  var resizer = document.getElementById('log-resizer');
  var toolbar = document.getElementById('log-toolbar');
  var grip = document.getElementById('log-grip');
  var fullWindowButton = document.getElementById('bottom-pane-full-window-toggle');
  var minimizeButton = document.getElementById('bottom-pane-minimize');
  var defaultHeight = 240;
  var minHeight = 42;
  var minPlaylistModalContentHeight = 96;
  var normalPanelMaxHeightOffset = 80;
  var fullWindowSettingKey = 'bottom-panel-full-window';
  // 'log-height' is the last expanded (user-chosen) height. Minimizing is a
  // separate persisted flag so it never overwrites that height and the panel
  // can be restored to it, also after a reload.
  var minimizedSettingKey = 'log-panel-minimized';
  var minimized = false;
  var modeSelect = document.getElementById('bottom-pane-mode');
  var currentHeight = defaultHeight;
  var preferredHeight = defaultHeight;
  var fullWindowActive = false;
  var heightBeforeFullWindow = null;
  var activeResize = null;

  function syncPlaylistModalGeometry() {
    var panelRect;
    var toolbarRect;
    var topInset;
    var availableHeight;
    if (!panel || !toolbar) return;
    panelRect = panel.getBoundingClientRect();
    toolbarRect = toolbar.getBoundingClientRect();
    topInset = Math.max(0, Math.min(panelRect.height, toolbarRect.bottom - panelRect.top));
    availableHeight = Math.max(0, panelRect.bottom - toolbarRect.bottom);
    document.documentElement.style.setProperty('--log-panel-modal-top-inset', topInset + 'px');
    // Keep enough room for a dialog heading and actions; its open state is
    // preserved so it returns when the panel grows again.
    panel.setAttribute(
      'data-playlist-modal-content-collapsed',
      availableHeight < minPlaylistModalContentHeight ? 'true' : 'false'
    );
  }

  function scrollLogToBottom() {
    entries.scrollTop = entries.scrollHeight;
  }

  function maxHeight() {
    return Math.max(
      minHeight,
      (window.innerHeight || minHeight) - normalPanelMaxHeightOffset
    );
  }

  function parseHeight(height) {
    var parsed = parseInt(height, 10);
    return isFinite(parsed) ? parsed : defaultHeight;
  }

  function clampHeight(height) {
    var parsed = parseHeight(height);
    return Math.min(Math.max(parsed, minHeight), maxHeight());
  }

  function setMinimized(next, persist) {
    minimized = Boolean(next);
    if (panel && typeof panel.setAttribute === 'function') {
      panel.setAttribute('data-minimized', minimized ? 'true' : 'false');
    }
    if (persist !== false) Settings.set(minimizedSettingKey, minimized);
  }

  function applyHeight(height, persist) {
    var clamped = clampHeight(height);
    currentHeight = clamped;
    document.documentElement.style.setProperty('--log-panel-height', clamped + 'px');
    syncPlaylistModalGeometry();
    if (persist !== false) {
      // A user-driven height at the minimum (minimize button or dragging all
      // the way down) is the minimized state; keep the expanded height.
      if (clamped <= minHeight) {
        setMinimized(true);
      } else {
        setMinimized(false);
        preferredHeight = clamped;
        Settings.set('log-height', clamped);
      }
    }
    return clamped;
  }

  function expandedHeight() {
    return preferredHeight > minHeight ? preferredHeight : defaultHeight;
  }

  function shouldPersistFullWindowState(source) {
    // Video-focused full window and automatic overflow recovery are transient
    // layout changes. Only explicit shared-panel actions become the user's
    // persisted panel preference.
    return source !== 'video' && source !== 'restore' && source !== 'restore-overflow' && source !== 'resize-overflow';
  }

  function getHeight() {
    return currentHeight;
  }

  function applyFullWindowHeight() {
    // Do not persist the viewport height as the normal panel setting.
    var fill = Math.max(minHeight, window.innerHeight || minHeight);
    document.documentElement.style.setProperty('--log-panel-height', fill + 'px');
    syncPlaylistModalGeometry();
    return fill;
  }

  function applyFullWindowShellClass(active) {
    if (typeof document !== 'undefined' && document.body) {
      document.body.classList.toggle('bottom-panel-full-window-mode', Boolean(active));
    }
  }

  function syncToolbarButtons() {
    var icon;
    if (fullWindowButton) {
      fullWindowButton.disabled = fullWindowActive;
      fullWindowButton.setAttribute('aria-pressed', 'false');
      fullWindowButton.title = 'Expand bottom panel to full page';
      fullWindowButton.setAttribute('aria-label', fullWindowButton.title);
      icon = fullWindowButton.querySelector('img');
      if (icon) {
        icon.src = '/assets/icons/material-icon-theme/video-full-window-enter.svg';
      }
    }
    if (minimizeButton) {
      var restoreMode = !fullWindowActive && currentHeight <= minHeight;
      minimizeButton.disabled = false;
      minimizeButton.setAttribute('aria-pressed', restoreMode ? 'true' : 'false');
      minimizeButton.title = restoreMode ? 'Restore bottom panel' : 'Minimize bottom panel';
      minimizeButton.setAttribute('aria-label', minimizeButton.title);
      if (minimizeButton.classList) minimizeButton.classList.toggle('is-restore', restoreMode);
    }
  }

  function setResizerInteractionEnabled(enabled) {
    var pointerEvents = enabled ? '' : 'none';
    if (resizer) {
      resizer.style.pointerEvents = pointerEvents;
      resizer.setAttribute('aria-disabled', enabled ? 'false' : 'true');
      if (enabled) resizer.removeAttribute('data-full-window-locked');
      else resizer.setAttribute('data-full-window-locked', '1');
    }
    if (grip) {
      grip.style.pointerEvents = pointerEvents;
      if (enabled) grip.removeAttribute('data-full-window-locked');
      else grip.setAttribute('data-full-window-locked', '1');
    }
  }

  function emitFullWindowChange(source) {
    if (typeof document === 'undefined' || typeof document.dispatchEvent !== 'function') return;
    var event;
    var detail = {
      active: fullWindowActive,
      source: source || 'api',
      height: fullWindowActive ? applyFullWindowHeight() : currentHeight,
    };
    if (typeof CustomEvent === 'function') {
      event = new CustomEvent('bottom-panel-full-window-changed', {detail: detail});
    } else {
      event = document.createEvent('CustomEvent');
      event.initCustomEvent('bottom-panel-full-window-changed', false, false, detail);
    }
    document.dispatchEvent(event);
  }

  function stopResize() {
    if (!activeResize) return;
    if (resizer) resizer.classList.remove('dragging');
    window.removeEventListener('pointermove', activeResize.move);
    window.removeEventListener('pointerup', activeResize.end);
    window.removeEventListener('pointercancel', activeResize.end);
    activeResize = null;
  }

  function enterFullWindow(options) {
    var opts = options || {};
    stopResize();
    if (!fullWindowActive) {
      if (Number.isFinite(Number(opts.savedHeight))) {
        heightBeforeFullWindow = Math.max(minHeight, parseHeight(opts.savedHeight));
      } else {
        heightBeforeFullWindow = preferredHeight;
      }
    }
    fullWindowActive = true;
    if (shouldPersistFullWindowState(opts.source || 'api')) {
      Settings.set(fullWindowSettingKey, true);
    }
    applyFullWindowShellClass(true);
    setResizerInteractionEnabled(false);
    applyFullWindowHeight();
    syncToolbarButtons();
    emitFullWindowChange(opts.source || 'api');
    return heightBeforeFullWindow;
  }

  function exitFullWindow(options) {
    var opts = options || {};
    var source = opts.source || 'api';
    var restore = Number.isFinite(Number(opts.restoreHeight))
      ? Number(opts.restoreHeight)
      : heightBeforeFullWindow;
    fullWindowActive = false;
    applyFullWindowShellClass(false);
    setResizerInteractionEnabled(true);
    heightBeforeFullWindow = null;
    var result = Number.isFinite(restore) && restore > 0
      ? applyHeight(restore)
      : applyHeight(preferredHeight);
    if (shouldPersistFullWindowState(source)) {
      Settings.set(fullWindowSettingKey, false);
    }
    syncToolbarButtons();
    emitFullWindowChange(source);
    return result;
  }

  function minimizePanel() {
    if (fullWindowActive) exitFullWindow({source: 'minimize'});
    var result = applyHeight(minHeight);
    syncToolbarButtons();
    return result;
  }

  // Un-minimize to the last expanded height (clamped to the viewport; an
  // expanded height that no longer fits opens full-window like a reload does).
  function restorePanel() {
    if (fullWindowActive) return applyFullWindowHeight();
    var target = expandedHeight();
    setMinimized(false);
    if (target > maxHeight()) {
      enterFullWindow({source: 'restore-overflow', savedHeight: target});
      return currentHeight;
    }
    var result = applyHeight(target);
    syncToolbarButtons();
    return result;
  }

  function toggleMinimized() {
    if (!fullWindowActive && currentHeight <= minHeight) return restorePanel();
    return minimizePanel();
  }

  function layoutHeight() {
    return minimized ? minHeight : preferredHeight;
  }

  function toggleFullWindow() {
    if (fullWindowActive) return exitFullWindow({source: 'toggle'});
    return enterFullWindow({source: 'toggle'});
  }

  function musicMinHeight() {
    var pane = document.getElementById('music-player-pane');
    if (!pane) return minHeight;
    var value = window.getComputedStyle(pane).getPropertyValue('--music-min-pane-height');
    var parsed = parseInt(value, 10);
    return isFinite(parsed) ? parsed : minHeight;
  }

  // Explicitly switching to the music player grows a small panel so the
  // player is usable (this becomes the new expanded height).
  function ensureMusicPaneHeight() {
    if (fullWindowActive) return;
    var target = clampHeight(musicMinHeight());
    if (currentHeight < target) {
      applyHeight(Math.max(target, minimized ? clampHeight(expandedHeight()) : 0));
      syncToolbarButtons();
    }
  }

  // Restore the saved panel state exactly. Never write settings here: startup
  // code must not overwrite the user's saved height or minimized state.
  var savedHeightSetting = Settings.get('log-height', null);
  var hasSavedHeight = savedHeightSetting !== null && savedHeightSetting !== undefined;
  preferredHeight = Math.max(minHeight, parseHeight(Settings.get('log-height', defaultHeight)));
  var savedMinimized = Settings.get(minimizedSettingKey, null);
  if (savedMinimized === null || savedMinimized === undefined) {
    // Before the minimized flag existed, minimizing saved log-height = 42.
    savedMinimized = hasSavedHeight && preferredHeight <= minHeight;
  }
  if (preferredHeight <= minHeight) preferredHeight = defaultHeight;
  setMinimized(savedMinimized === true, false);
  var persistedFullWindow = Settings.get(fullWindowSettingKey, false) === true;
  applyHeight(layoutHeight(), false);
  syncToolbarButtons();
  if (persistedFullWindow || (!minimized && preferredHeight > maxHeight())) {
    enterFullWindow({
      source: persistedFullWindow ? 'restore' : 'restore-overflow',
      savedHeight: preferredHeight,
    });
  }
  syncPlaylistModalGeometry();
  if (typeof window.ResizeObserver === 'function' && panel && toolbar) {
    var modalGeometryObserver = new window.ResizeObserver(syncPlaylistModalGeometry);
    modalGeometryObserver.observe(panel);
    modalGeometryObserver.observe(toolbar);
  }

  function startResize(ev) {
    if (fullWindowActive) {
      ev.preventDefault();
      return;
    }
    ev.preventDefault();
    var startY = ev.clientY;
    var startHeight = currentHeight;
    stopResize();
    resizer.classList.add('dragging');

    function move(moveEv) {
      if (fullWindowActive) return;
      var nextHeight = startHeight + startY - moveEv.clientY;
      applyHeight(nextHeight);
      syncToolbarButtons();
      scrollLogToBottom();
    }

    function end() {
      stopResize();
    }

    activeResize = {move: move, end: end};
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  if (resizer) resizer.addEventListener('pointerdown', startResize);
  if (grip) grip.addEventListener('pointerdown', startResize);
  if (fullWindowButton) {
    fullWindowButton.addEventListener('click', function () {
      toggleFullWindow();
    });
  }
  if (minimizeButton) {
    minimizeButton.addEventListener('click', function () {
      toggleMinimized();
    });
  }
  window.addEventListener('resize', function () {
    syncPlaylistModalGeometry();
    if (fullWindowActive) {
      applyFullWindowHeight();
      syncToolbarButtons();
      return;
    }
    if (!minimized && preferredHeight > maxHeight()) {
      enterFullWindow({source: 'resize-overflow', savedHeight: preferredHeight});
      return;
    }
    applyHeight(layoutHeight(), false);
    syncToolbarButtons();
  });
  window.addEventListener('bottom-pane-mode-changed', function (ev) {
    if (!ev.detail) return;
    if (ev.detail.mode === 'music-player') ensureMusicPaneHeight();
    if (ev.detail.mode === 'server-log') scrollLogToBottom();
  });

  // bottom-pane.js restores the persisted mode before this classic script is
  // loaded, so the initial Music Player selection does not emit an event that
  // the listener above can observe. Only a first visit (no saved height) gets
  // the music minimum, in memory only; a saved height or minimized state is
  // restored as-is instead of being overwritten on every load.
  if (
    modeSelect && modeSelect.value === 'music-player'
    && !hasSavedHeight && !minimized && !fullWindowActive
  ) {
    var initialMusicHeight = clampHeight(musicMinHeight());
    if (currentHeight < initialMusicHeight) {
      preferredHeight = initialMusicHeight;
      applyHeight(initialMusicHeight, false);
      syncToolbarButtons();
    }
  }

  window.DropboxBrowserLogPanel = {
    getHeight: getHeight,
    applyHeight: applyHeight,
    applyFullWindowHeight: applyFullWindowHeight,
    enterFullWindow: enterFullWindow,
    exitFullWindow: exitFullWindow,
    toggleFullWindow: toggleFullWindow,
    minimize: minimizePanel,
    restore: restorePanel,
    isMinimized: function () { return minimized && !fullWindowActive; },
    isFullWindowActive: function () { return fullWindowActive; },
  };

  var nextIndex = 0;
  var nextUpdateSeq = 0;
  var pollTimer = null;
  var pollController = null;
  var pollGeneration = 0;
  var polling = false;

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function buildEntry(e) {
    return '<span class="log-ts">[' + esc(e.ts) + ']</span> ' +
      '<span class="log-kind-' + esc(e.kind) + '">' + esc(e.kind) + '</span> ' +
      esc(e.message);
  }

  function applyEntry(div, e) {
    var slowClass = e.elapsed >= 5 ? ' log-very-slow' : e.elapsed >= 1 ? ' log-slow' : '';
    div.className = 'log-entry' + slowClass;
    div.innerHTML = buildEntry(e);
  }

  function stopPolling() {
    polling = false;
    pollGeneration += 1;
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    if (pollController) {
      pollController.abort();
      pollController = null;
    }
  }

  function schedulePoll(delay, generation) {
    if (!polling || generation !== pollGeneration) return;
    pollTimer = setTimeout(function () {
      pollTimer = null;
      poll();
    }, delay);
  }

  function startPolling() {
    if (polling) return;
    polling = true;
    pollGeneration += 1;
    schedulePoll(500, pollGeneration);
  }

  function poll() {
    var generation;
    var controller;
    var fetchOptions;
    if (!polling) return;
    generation = pollGeneration;
    controller = typeof AbortController === 'function' ? new AbortController() : null;
    pollController = controller;
    fetchOptions = controller ? {signal: controller.signal} : undefined;
    fetch('/logs?since=' + nextIndex + '&since_upd=' + nextUpdateSeq, fetchOptions)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!polling || generation !== pollGeneration) return;
        if (data.update_seq !== undefined) nextUpdateSeq = data.update_seq;
        data.entries.forEach(function (e) {
          nextIndex = Math.max(nextIndex, e.index + 1);
          var div = document.createElement('div');
          div.setAttribute('data-id', e.index);
          applyEntry(div, e);
          entries.appendChild(div);
        });
        (data.updates || []).forEach(function (e) {
          var div = entries.querySelector('[data-id="' + e.index + '"]');
          if (div) applyEntry(div, e);
        });
        if (data.entries.length > 0) {
          scrollLogToBottom();
        }
      })
      .catch(function () {})
      .then(function () {
        if (pollController === controller) pollController = null;
        schedulePoll(2000, generation);
      });
  }

  window.addEventListener('bottom-pane-mode-changed', function (ev) {
    if (!ev.detail) return;
    if (ev.detail.mode === 'server-log') {
      startPolling();
      scrollLogToBottom();
    } else {
      stopPolling();
    }
  });

  if (modeSelect && modeSelect.value === 'server-log') startPolling();
}());
