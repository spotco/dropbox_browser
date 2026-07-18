(function () {
  var panel = document.getElementById('log-panel');
  var entries = document.getElementById('log-entries');
  var resizer = document.getElementById('log-resizer');
  var grip = document.getElementById('log-grip');
  var fullWindowButton = document.getElementById('bottom-pane-full-window-toggle');
  var minimizeButton = document.getElementById('bottom-pane-minimize');
  var defaultHeight = 240;
  var minHeight = 42;
  var currentHeight = defaultHeight;
  var fullWindowActive = false;
  var heightBeforeFullWindow = null;
  var activeResize = null;

  function scrollLogToBottom() {
    entries.scrollTop = entries.scrollHeight;
  }

  function maxHeight() {
    return Math.max(minHeight, window.innerHeight || minHeight);
  }

  function clampHeight(height) {
    var parsed = parseInt(height, 10);
    if (!isFinite(parsed)) parsed = defaultHeight;
    return Math.min(Math.max(parsed, minHeight), maxHeight());
  }

  function applyHeight(height) {
    var clamped = clampHeight(height);
    currentHeight = clamped;
    document.documentElement.style.setProperty('--log-panel-height', clamped + 'px');
    Settings.set('log-height', clamped);
    return clamped;
  }

  function getHeight() {
    return currentHeight;
  }

  function applyFullWindowHeight() {
    // Do not persist the viewport height as the normal panel setting.
    var fill = Math.max(minHeight, window.innerHeight || minHeight);
    document.documentElement.style.setProperty('--log-panel-height', fill + 'px');
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
      fullWindowButton.setAttribute('aria-pressed', fullWindowActive ? 'true' : 'false');
      fullWindowButton.title = fullWindowActive
        ? 'Exit full-page bottom panel'
        : 'Expand bottom panel to full page';
      fullWindowButton.setAttribute('aria-label', fullWindowButton.title);
      icon = fullWindowButton.querySelector('img');
      if (icon) {
        icon.src = fullWindowActive
          ? '/assets/icons/material-icon-theme/video-full-window-exit.svg'
          : '/assets/icons/material-icon-theme/video-full-window-enter.svg';
      }
    }
    if (minimizeButton) {
      minimizeButton.disabled = !fullWindowActive && currentHeight <= minHeight;
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
        heightBeforeFullWindow = Number(opts.savedHeight);
      } else {
        heightBeforeFullWindow = currentHeight;
      }
    }
    fullWindowActive = true;
    applyFullWindowShellClass(true);
    setResizerInteractionEnabled(false);
    applyFullWindowHeight();
    syncToolbarButtons();
    emitFullWindowChange(opts.source || 'api');
    return heightBeforeFullWindow;
  }

  function exitFullWindow(options) {
    var opts = options || {};
    var restore = Number.isFinite(Number(opts.restoreHeight))
      ? Number(opts.restoreHeight)
      : heightBeforeFullWindow;
    fullWindowActive = false;
    applyFullWindowShellClass(false);
    setResizerInteractionEnabled(true);
    heightBeforeFullWindow = null;
    var result = Number.isFinite(restore) && restore > 0
      ? applyHeight(restore)
      : applyHeight(currentHeight);
    syncToolbarButtons();
    emitFullWindowChange(opts.source || 'api');
    return result;
  }

  function minimizePanel() {
    if (fullWindowActive) exitFullWindow({source: 'minimize'});
    var result = applyHeight(minHeight);
    syncToolbarButtons();
    return result;
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

  function ensureMusicPaneHeight() {
    if (fullWindowActive) return;
    var target = clampHeight(musicMinHeight());
    if (currentHeight < target) applyHeight(target);
  }

  applyHeight(Settings.get('log-height', defaultHeight));
  syncToolbarButtons();

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
      var viewportHeight = Math.max(minHeight, window.innerHeight || minHeight);
      if (nextHeight >= viewportHeight - 1) {
        enterFullWindow({source: 'drag', savedHeight: startHeight});
        return;
      }
      applyHeight(nextHeight);
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
      minimizePanel();
    });
  }
  window.addEventListener('resize', function () {
    if (fullWindowActive) {
      applyFullWindowHeight();
      syncToolbarButtons();
      return;
    }
    applyHeight(currentHeight);
    syncToolbarButtons();
  });
  window.addEventListener('bottom-pane-mode-changed', function (ev) {
    if (!ev.detail) return;
    if (ev.detail.mode === 'music-player') ensureMusicPaneHeight();
    if (ev.detail.mode === 'server-log') scrollLogToBottom();
  });

  window.DropboxBrowserLogPanel = {
    getHeight: getHeight,
    applyHeight: applyHeight,
    applyFullWindowHeight: applyFullWindowHeight,
    enterFullWindow: enterFullWindow,
    exitFullWindow: exitFullWindow,
    toggleFullWindow: toggleFullWindow,
    minimize: minimizePanel,
    isFullWindowActive: function () { return fullWindowActive; },
    // Compatibility aliases for the video adapter during the migration.
    setVideoFullWindowActive: function (active, options) {
      return active ? enterFullWindow(options) : exitFullWindow(options);
    },
    isVideoFullWindowActive: function () { return fullWindowActive; },
  };

  var nextIndex = 0;
  var nextUpdateSeq = 0;

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

  function poll() {
    fetch('/logs?since=' + nextIndex + '&since_upd=' + nextUpdateSeq)
      .then(function (r) { return r.json(); })
      .then(function (data) {
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
      .then(function () { setTimeout(poll, 2000); });
  }

  setTimeout(poll, 500);
}());
