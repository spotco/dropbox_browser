// The browse table's column header row is rendered as its own table inside the
// fixed top bar (header.browse-topbar) so it stays visible while <main>
// scrolls. This keeps that head table lined up with the body table: same left
// edge and width (which already account for <main>'s vertical scrollbar and
// padding, because we measure the table shell) and the same horizontal scroll
// offset. Column widths are shared through the colgroups by columns.js.
export function initBrowseTableHead(options) {
  var doc = options && options.document ? options.document : document;
  var win = options && options.window ? options.window : window;
  var headTable = options && options.headTable ? options.headTable : null;
  var bodyTable = options && options.bodyTable ? options.bodyTable : null;
  var shell = options && options.shell ? options.shell : (bodyTable ? bodyTable.parentElement : null);
  var clip = headTable ? headTable.parentElement : null;
  var bar = clip ? clip.parentElement : null;
  var noop = {sync: function () {}, refresh: function () {}, destroy: function () {}};
  if (!doc || !win || !headTable || !bodyTable || !shell || !clip || !bar) return noop;
  if (typeof shell.getBoundingClientRect !== 'function' || typeof bar.getBoundingClientRect !== 'function') return noop;
  if (headTable.__browseTableHeadApi) return headTable.__browseTableHeadApi;

  var frame = 0;
  var resizeObserver = null;

  function syncScroll() {
    var offset = Math.round(Number(shell.scrollLeft) || 0);
    headTable.style.transform = offset ? 'translateX(' + String(-offset) + 'px)' : '';
  }

  function sync() {
    if (frame) {
      win.cancelAnimationFrame(frame);
      frame = 0;
    }
    var shellRect = shell.getBoundingClientRect();
    var barRect = bar.getBoundingClientRect();
    // Hidden (e.g. bottom-panel full-window mode): keep the last geometry.
    if (!shellRect.width || !barRect.width) return;
    clip.style.left = String(Math.round((shellRect.left - barRect.left) * 100) / 100) + 'px';
    clip.style.width = String(Math.round(shellRect.width * 100) / 100) + 'px';
    clip.style.right = 'auto';
    var tableWidth = bodyTable.getBoundingClientRect().width;
    if (tableWidth) headTable.style.width = String(Math.round(tableWidth * 100) / 100) + 'px';
    syncScroll();
  }

  function refresh() {
    if (frame) return;
    frame = win.requestAnimationFrame(function () {
      frame = 0;
      sync();
    });
  }

  shell.addEventListener('scroll', syncScroll, {passive: true});
  win.addEventListener('resize', refresh, {passive: true});
  if (typeof win.ResizeObserver === 'function') {
    resizeObserver = new win.ResizeObserver(refresh);
    resizeObserver.observe(shell);
    resizeObserver.observe(bodyTable);
    resizeObserver.observe(bar);
  }
  sync();

  var api = {
    sync: sync,
    refresh: refresh,
    destroy: function () {
      if (frame) win.cancelAnimationFrame(frame);
      shell.removeEventListener('scroll', syncScroll);
      win.removeEventListener('resize', refresh);
      if (resizeObserver) resizeObserver.disconnect();
      delete headTable.__browseTableHeadApi;
    },
  };
  headTable.__browseTableHeadApi = api;
  return api;
}
