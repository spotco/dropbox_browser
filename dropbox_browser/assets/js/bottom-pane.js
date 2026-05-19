(function () {
  var modeSelect = document.getElementById('bottom-pane-mode');
  var paneViews = Array.prototype.slice.call(document.querySelectorAll('.bottom-pane-view'));
  var defaultMode = 'server-log';

  if (!modeSelect || paneViews.length === 0) return;

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
  setPaneMode(Settings.get('bottom-pane-mode', defaultMode));
}());
