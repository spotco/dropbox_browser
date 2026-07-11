(function () {
  var panel = document.getElementById('log-panel');
  var entries = document.getElementById('log-entries');
  var resizer = document.getElementById('log-resizer');
  var grip = document.getElementById('log-grip');
  var defaultHeight = 240;
  var minHeight = 42;
  var currentHeight = defaultHeight;
  var videoFullWindowActive = false;
  var heightBeforeFullWindow = null;

  function scrollLogToBottom() {
    entries.scrollTop = entries.scrollHeight;
  }

  function maxHeight() {
    return Math.max(minHeight, window.innerHeight - 80);
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
    // Bypass clampHeight (which reserves 80px for page chrome). Do not persist.
    var fill = Math.max(minHeight, window.innerHeight || minHeight);
    document.documentElement.style.setProperty('--log-panel-height', fill + 'px');
    return fill;
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

  function setVideoFullWindowActive(active, options) {
    var opts = options || {};
    var nextActive = Boolean(active);
    if (nextActive) {
      if (!videoFullWindowActive) {
        if (Number.isFinite(Number(opts.savedHeight))) {
          heightBeforeFullWindow = Number(opts.savedHeight);
        } else {
          heightBeforeFullWindow = currentHeight;
        }
      }
      videoFullWindowActive = true;
      setResizerInteractionEnabled(false);
      applyFullWindowHeight();
      return heightBeforeFullWindow;
    }
    videoFullWindowActive = false;
    setResizerInteractionEnabled(true);
    var restore = Number.isFinite(Number(opts.restoreHeight))
      ? Number(opts.restoreHeight)
      : heightBeforeFullWindow;
    heightBeforeFullWindow = null;
    if (Number.isFinite(restore) && restore > 0) {
      return applyHeight(restore);
    }
    return applyHeight(currentHeight);
  }

  function musicMinHeight() {
    var pane = document.getElementById('music-player-pane');
    if (!pane) return minHeight;
    var value = window.getComputedStyle(pane).getPropertyValue('--music-min-pane-height');
    var parsed = parseInt(value, 10);
    return isFinite(parsed) ? parsed : minHeight;
  }

  function ensureMusicPaneHeight() {
    if (videoFullWindowActive) return;
    var target = clampHeight(musicMinHeight());
    if (currentHeight < target) applyHeight(target);
  }

  applyHeight(Settings.get('log-height', defaultHeight));

  function startResize(ev) {
    if (videoFullWindowActive) {
      ev.preventDefault();
      return;
    }
    ev.preventDefault();
    var startY = ev.clientY;
    var startHeight = currentHeight;
    resizer.classList.add('dragging');

    function move(moveEv) {
      if (videoFullWindowActive) return;
      applyHeight(startHeight + startY - moveEv.clientY);
      scrollLogToBottom();
    }

    function end() {
      resizer.classList.remove('dragging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    }

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  if (resizer) resizer.addEventListener('pointerdown', startResize);
  if (grip) grip.addEventListener('pointerdown', startResize);
  window.addEventListener('resize', function () {
    if (videoFullWindowActive) {
      applyFullWindowHeight();
      return;
    }
    applyHeight(currentHeight);
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
    setVideoFullWindowActive: setVideoFullWindowActive,
    isVideoFullWindowActive: function () { return videoFullWindowActive; },
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
