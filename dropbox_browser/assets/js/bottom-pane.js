(function () {
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
