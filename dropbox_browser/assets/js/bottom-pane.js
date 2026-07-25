(function () {
  // Gate bottom-panel interaction until music + video media-library layout has
  // restored pane splits and active playlist column widths. Classic scripts
  // (this file, log.js) run before those type=module hosts finish.
  var MEDIA_LAYOUT_READY_KEYS = ['music', 'video'];
  var mediaLayoutReady = Object.create(null);
  var bottomPanelInteractionReady = false;
  var bottomPanelReadyFallbackTimer = null;
  var BOTTOM_PANEL_READY_FALLBACK_MS = 8000;
  // Reuse the existing toolbar status text (#music-player-status-text); do not add nodes.
  var statusBarEl = document.getElementById('music-player-status');
  var statusTextEl = document.getElementById('music-player-status-text');
  var loadStartedAtMs = (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();
  var loadStatusTimer = null;
  var loadStatusFinalized = false;
  var LOAD_STATUS_TICK_MS = 100;

  MEDIA_LAYOUT_READY_KEYS.forEach(function (key) {
    mediaLayoutReady[key] = false;
  });

  function nowMs() {
    return (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
  }

  function formatLoadSeconds() {
    return ((nowMs() - loadStartedAtMs) / 1000).toFixed(1);
  }

  function setBootstrapStatusBarVisible(visible) {
    if (!statusBarEl) return;
    statusBarEl.hidden = !visible;
    statusBarEl.classList.toggle('hidden', !visible);
    statusBarEl.classList.toggle('is-visible', visible);
  }

  function paintLoadingStatus() {
    if (loadStatusFinalized || !statusTextEl) return;
    statusTextEl.textContent = 'Loading(' + formatLoadSeconds() + 's)...';
    setBootstrapStatusBarVisible(true);
  }

  function finalizeLoadStatus() {
    if (loadStatusFinalized) return;
    loadStatusFinalized = true;
    if (loadStatusTimer !== null) {
      window.clearInterval(loadStatusTimer);
      loadStatusTimer = null;
    }
    // Final bootstrap message only; never rewrite this from the loader again.
    if (statusTextEl) {
      statusTextEl.textContent = 'Loaded (' + formatLoadSeconds() + 's)!';
    }
    setBootstrapStatusBarVisible(true);
  }

  function setBottomPanelInteractionReady(ready) {
    if (ready === bottomPanelInteractionReady) return;
    bottomPanelInteractionReady = !!ready;
    if (document.body) {
      document.body.classList.toggle('bottom-panel-bootstrapping', !bottomPanelInteractionReady);
      document.body.setAttribute(
        'data-bottom-panel-ready',
        bottomPanelInteractionReady ? '1' : '0'
      );
    }
    if (bottomPanelInteractionReady) finalizeLoadStatus();
  }

  function allMediaLayoutsReady() {
    return MEDIA_LAYOUT_READY_KEYS.every(function (key) {
      return !!mediaLayoutReady[key];
    });
  }

  function markBottomPanelMediaLayoutReady(key) {
    if (MEDIA_LAYOUT_READY_KEYS.indexOf(key) < 0) return;
    mediaLayoutReady[key] = true;
    if (!allMediaLayoutsReady()) return;
    if (bottomPanelReadyFallbackTimer !== null) {
      window.clearTimeout(bottomPanelReadyFallbackTimer);
      bottomPanelReadyFallbackTimer = null;
    }
    setBottomPanelInteractionReady(true);
  }

  window.markBottomPanelMediaLayoutReady = markBottomPanelMediaLayoutReady;
  setBottomPanelInteractionReady(false);
  paintLoadingStatus();
  loadStatusTimer = window.setInterval(paintLoadingStatus, LOAD_STATUS_TICK_MS);
  bottomPanelReadyFallbackTimer = window.setTimeout(function () {
    bottomPanelReadyFallbackTimer = null;
    setBottomPanelInteractionReady(true);
  }, BOTTOM_PANEL_READY_FALLBACK_MS);

  var panel = document.getElementById('log-panel');
  var modeSelect = document.getElementById('bottom-pane-mode');
  var paneViews = Array.prototype.slice.call(document.querySelectorAll('.bottom-pane-view'));
  var defaultMode = 'server-log';

  if (!modeSelect || paneViews.length === 0 || !panel) return;

  function activePaneView() {
    for (var i = 0; i < paneViews.length; i += 1) {
      if (!paneViews[i].hidden) return paneViews[i];
    }
    return null;
  }

  function canScrollVertically(el, deltaY) {
    if (!el || !deltaY || el.scrollHeight <= el.clientHeight) return false;
    if (deltaY < 0) return el.scrollTop > 0;
    return el.scrollTop + el.clientHeight < el.scrollHeight;
  }

  function nearestScrollableAncestor(target) {
    var view = activePaneView();
    var node = target;
    while (node && node !== panel && node !== document.body) {
      if (node instanceof HTMLElement) {
        if (canScrollVertically(node, 1) || canScrollVertically(node, -1)) return node;
      }
      if (node === view) break;
      node = node.parentElement;
    }
    return null;
  }

  function handlePanelWheel(ev) {
    var node = ev.target;
    while (node && node !== panel && node !== document.body) {
      if (node.classList && node.classList.contains('leaflet-container')) return;
      node = node.parentElement;
    }
    var scrollable = nearestScrollableAncestor(ev.target);
    if (!scrollable) {
      ev.preventDefault();
      return;
    }
    if (!canScrollVertically(scrollable, ev.deltaY)) {
      ev.preventDefault();
      return;
    }
    scrollable.scrollTop += ev.deltaY;
    ev.preventDefault();
  }

  function modeExists(mode) {
    return paneViews.some(function (view) {
      return view.getAttribute('data-pane-mode') === mode;
    });
  }

  function setPaneMode(mode) {
    if (!modeExists(mode)) mode = defaultMode;
    paneViews.forEach(function (view) {
      var selected = view.getAttribute('data-pane-mode') === mode;
      view.hidden = !selected;
      view.classList.toggle('hidden', !selected);
      view.setAttribute('aria-hidden', selected ? 'false' : 'true');
    });
    if (modeSelect.value !== mode) modeSelect.value = mode;
    Settings.set('bottom-pane-mode', mode);
    window.dispatchEvent(new CustomEvent('bottom-pane-mode-changed', {
      detail: {mode: mode}
    }));
  }

  modeSelect.addEventListener('change', function () {
    setPaneMode(modeSelect.value);
  });
  panel.addEventListener('wheel', handlePanelWheel, {passive: false});
  setPaneMode(Settings.get('bottom-pane-mode', defaultMode));
}());
