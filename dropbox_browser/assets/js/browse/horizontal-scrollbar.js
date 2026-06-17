export function initBrowseHorizontalScrollbar(options) {
  var doc = options && options.document ? options.document : document;
  var win = options && options.window ? options.window : window;
  var shell = options && options.shell ? options.shell : (doc ? doc.querySelector('.browse-table-shell') : null);
  var scrollContainer = options && options.scrollContainer ? options.scrollContainer : (doc ? doc.querySelector('main') : null);
  var logPanel = options && options.logPanel ? options.logPanel : (doc ? doc.getElementById('log-panel') : null);
  if (!doc || !win || !shell) {
    return {
      refresh: function () {},
      destroy: function () {},
    };
  }

  var bar = doc.createElement('div');
  var spacer = doc.createElement('div');
  var syncing = false;
  var refreshFrame = 0;
  var resizeObserver = null;
  bar.className = 'browse-horizontal-scrollbar hidden';
  bar.setAttribute('aria-hidden', 'true');
  bar.setAttribute('data-browse-horizontal-scrollbar', '');
  spacer.className = 'browse-horizontal-scrollbar-spacer';
  bar.appendChild(spacer);
  doc.body.appendChild(bar);

  function bottomOffset() {
    if (!logPanel || typeof logPanel.getBoundingClientRect !== 'function') return 0;
    var viewportHeight = win.innerHeight || doc.documentElement.clientHeight || 0;
    var panelRect = logPanel.getBoundingClientRect();
    return Math.max(0, Math.round(viewportHeight - panelRect.top));
  }

  function syncFromShell() {
    if (syncing) return;
    syncing = true;
    bar.scrollLeft = shell.scrollLeft;
    syncing = false;
  }

  function syncFromBar() {
    if (syncing) return;
    syncing = true;
    shell.scrollLeft = bar.scrollLeft;
    syncing = false;
  }

  function refreshNow() {
    refreshFrame = 0;
    var viewportWidth = win.innerWidth || doc.documentElement.clientWidth || 0;
    var viewportHeight = win.innerHeight || doc.documentElement.clientHeight || 0;
    var rect = shell.getBoundingClientRect();
    var hasHorizontalOverflow = shell.scrollWidth > shell.clientWidth + 1;
    var isVisible = rect.bottom > 0 && rect.top < viewportHeight;
    if (!hasHorizontalOverflow || !isVisible) {
      bar.classList.add('hidden');
      return;
    }

    var left = Math.max(0, rect.left);
    var right = Math.min(viewportWidth, rect.right);
    var width = Math.max(0, right - left);
    if (width <= 0) {
      bar.classList.add('hidden');
      return;
    }

    spacer.style.width = String(shell.scrollWidth) + 'px';
    bar.style.left = String(left) + 'px';
    bar.style.width = String(width) + 'px';
    bar.style.bottom = String(bottomOffset()) + 'px';
    syncFromShell();
    bar.classList.remove('hidden');
  }

  function refresh() {
    if (refreshFrame) return;
    refreshFrame = win.requestAnimationFrame(refreshNow);
  }

  shell.addEventListener('scroll', syncFromShell, {passive: true});
  bar.addEventListener('scroll', syncFromBar, {passive: true});
  win.addEventListener('resize', refresh, {passive: true});
  win.addEventListener('scroll', refresh, {passive: true});
  if (scrollContainer) scrollContainer.addEventListener('scroll', refresh, {passive: true});
  if (typeof win.ResizeObserver === 'function' && logPanel) {
    resizeObserver = new win.ResizeObserver(refresh);
    resizeObserver.observe(logPanel);
  }

  refresh();

  return {
    refresh: refresh,
    destroy: function () {
      if (refreshFrame) win.cancelAnimationFrame(refreshFrame);
      shell.removeEventListener('scroll', syncFromShell);
      bar.removeEventListener('scroll', syncFromBar);
      win.removeEventListener('resize', refresh);
      win.removeEventListener('scroll', refresh);
      if (scrollContainer) scrollContainer.removeEventListener('scroll', refresh);
      if (resizeObserver) resizeObserver.disconnect();
      if (bar.parentElement) bar.parentElement.removeChild(bar);
    },
  };
}
