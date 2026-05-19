(function () {
  var panel = document.getElementById('log-panel');
  var entries = document.getElementById('log-entries');
  var resizer = document.getElementById('log-resizer');
  var grip = document.getElementById('log-grip');
  var defaultHeight = 240;
  var minHeight = 42;

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
    document.documentElement.style.setProperty('--log-panel-height', clamped + 'px');
    Settings.set('log-height', clamped);
    return clamped;
  }

  applyHeight(Settings.get('log-height', defaultHeight));

  function startResize(ev) {
    ev.preventDefault();
    var startY = ev.clientY;
    var startHeight = panel.getBoundingClientRect().height;
    resizer.classList.add('dragging');

    function move(moveEv) {
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

  resizer.addEventListener('pointerdown', startResize);
  grip.addEventListener('pointerdown', startResize);
  window.addEventListener('resize', function () { applyHeight(panel.getBoundingClientRect().height); });
  window.addEventListener('bottom-pane-mode-changed', function (ev) {
    if (ev.detail && ev.detail.mode === 'server-log') scrollLogToBottom();
  });

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
