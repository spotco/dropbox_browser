(function () {
  var link = document.getElementById('refresh-cache');
  var blocker = document.getElementById('refresh-blocker');
  var message = document.getElementById('refresh-message');
  var progress = document.getElementById('refresh-progress-bar');
  var pageState = document.body ? document.body.dataset : {};
  if (!link || !blocker || !message) return;

  var shiftDown = false;
  var refreshing = false;

  function formBody(fields) {
    var params = new URLSearchParams();
    Object.keys(fields).forEach(function (key) { params.set(key, fields[key]); });
    return params;
  }

  function setShiftState(active) {
    shiftDown = !!active;
    link.textContent = shiftDown ? '\u21bb refresh all children' : '\u21bb refresh';
    link.title = shiftDown ? 'Refresh cached metadata for this folder and all known child folders' : 'Refresh cached metadata for this folder';
  }

  function showBlocker(text) {
    message.textContent = text;
    if (progress) progress.className = 'running';
    blocker.classList.remove('hidden');
  }

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Shift') setShiftState(true);
  });
  document.addEventListener('keyup', function (event) {
    if (event.key === 'Shift') setShiftState(false);
  });
  window.addEventListener('blur', function () {
    setShiftState(false);
  });
  link.addEventListener('mousemove', function (event) {
    setShiftState(event.shiftKey);
  });
  link.addEventListener('mouseleave', function () {
    if (!shiftDown) setShiftState(false);
  });
  link.addEventListener('click', function (event) {
    event.preventDefault();
    if (refreshing) return;
    refreshing = true;
    var recursive = !!event.shiftKey;
    showBlocker(recursive ? 'Refreshing current folder and known child folders' : 'Refreshing current folder');
    fetch('/refresh-cache', {
      method: 'POST',
      body: formBody({
        path: pageState.currentFolderPath || '',
        recursive: recursive ? '1' : '0'
      })
    })
      .then(function (r) {
        if (!r.ok) throw new Error('Refresh request failed');
        return r.json();
      })
      .then(function () {
        message.textContent = 'Cache invalidated. Reloading page';
        window.location.reload();
      })
      .catch(function (err) {
        refreshing = false;
        message.textContent = err.message || 'Refresh failed';
        if (progress) {
          progress.className = '';
          progress.style.width = '100%';
          progress.style.background = '#8a1f1f';
        }
      });
  });
  setShiftState(false);
}());
