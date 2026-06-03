import {buildBrowseListingEndpoint, buildBrowsePageHref} from './api.js';
import {startFolderInfoPolling} from './folder-info.js';
import {readBrowseHref, readBrowseLocation, shouldInterceptBrowseLink} from './navigation.js';
import {errorRowHtml, loadingRowHtml, renderBreadcrumbs, renderBrowseRowsBody, renderVirtualBrowseRowsBody} from './render.js';
import {applyBrowseSnapshot, createBrowseState, setBrowseError, setBrowseLoading} from './state.js';
import {nextBrowseSortState, sortBrowseRows} from './sort.js';
import {
  DEFAULT_VIRTUAL_OVERSCAN,
  DEFAULT_VIRTUAL_ROW_HEIGHT,
  DEFAULT_VIRTUAL_THRESHOLD,
  computeVirtualWindow,
  measureMountedRowHeight,
  readTableViewport,
  shouldVirtualizeRows,
} from './virtual-list.js';

function updatePageShell(payload) {
  var page = payload.page || {};
  var heading = document.querySelector('header h1');
  var meta = document.querySelector('header .meta');
  var breadcrumbNav = document.querySelector('.breadcrumbs');
  var refreshLink = document.getElementById('refresh-cache');
  var topbarCopyButton = document.querySelector('.topbar-actions .copy-path');
  var dropboxLink = document.querySelector('.topbar-actions .dropbox-link');
  if (page.title) {
    document.title = page.title;
    if (heading) heading.textContent = page.title;
  }
  if (meta) {
    meta.textContent = page.remote + ' / ' + page.path + ' - ' + page.local_note;
  }
  if (breadcrumbNav) {
    breadcrumbNav.innerHTML = renderBreadcrumbs(payload.breadcrumbs || []);
    if (refreshLink) {
      refreshLink.setAttribute('href', page.refresh_href || refreshLink.getAttribute('href') || '/');
      refreshLink.setAttribute('title', 'Refresh cached metadata for this folder');
      breadcrumbNav.appendChild(document.createTextNode(' '));
      breadcrumbNav.appendChild(refreshLink);
    }
  }
  if (topbarCopyButton && page.current_local_folder) {
    topbarCopyButton.setAttribute('data-copy-path', page.current_local_folder);
  }
  if (dropboxLink && page.dropbox_home_url) {
    dropboxLink.setAttribute('href', page.dropbox_home_url);
  }
}

function updateBodyDataset(state) {
  var body = document.body;
  if (!body) return;
  body.dataset.currentFolderPath = state.path;
  body.dataset.currentSortKey = state.sort;
  body.dataset.currentSortDirection = state.dir;
  body.dataset.browseEndpoint = buildBrowseListingEndpoint(state);
  body.dataset.browseRowCount = String((state.rows || []).length);
}

function updateRefreshHref(state) {
  var refreshLink = document.getElementById('refresh-cache');
  if (!refreshLink) return;
  refreshLink.setAttribute('href', buildBrowsePageHref({
    path: state.path,
    sort: state.sort,
    dir: state.dir,
    refresh: true,
  }));
}

function updateSortControls(state) {
  document.querySelectorAll('thead a[data-browse-sort]').forEach(function (link) {
    var key = link.getAttribute('data-browse-sort') || 'name';
    var label = link.getAttribute('data-browse-sort-label') || link.textContent || key;
    var nextState = nextBrowseSortState(state.sort, state.dir, key);
    link.setAttribute('href', buildBrowsePageHref({
      path: state.path,
      sort: nextState.sort,
      dir: nextState.dir,
    }));
    var indicator = '';
    if (state.sort === key) indicator = state.dir === 'asc' ? ' ^' : ' v';
    link.textContent = label + indicator;
  });
}

function createVirtualState() {
  return {
    rowHeight: DEFAULT_VIRTUAL_ROW_HEIGHT,
    overscan: DEFAULT_VIRTUAL_OVERSCAN,
    threshold: DEFAULT_VIRTUAL_THRESHOLD,
    enabled: false,
    windowKey: '',
  };
}

function setVirtualizationDataset(body, virtualState, windowState, renderCount) {
  if (!body) return;
  body.dataset.browseVirtualized = virtualState.enabled ? '1' : '0';
  body.dataset.browseRenderCount = String(renderCount || 0);
  if (!virtualState.enabled || !windowState) {
    body.dataset.browseVisibleRange = '';
    return;
  }
  body.dataset.browseVisibleRange = String(windowState.startIndex) + ':' + String(windowState.endIndex);
}

function renderRows(mount, state, virtualState, options) {
  var body = document.body;
  var sortedRows = sortBrowseRows(state.rows, state.sort, state.dir);
  var force = !!(options && options.force);
  if (shouldVirtualizeRows(sortedRows.length, {threshold: virtualState.threshold})) {
    var viewport = readTableViewport(mount, virtualState.rowHeight);
    var windowState = computeVirtualWindow({
      rowCount: sortedRows.length,
      rowHeight: virtualState.rowHeight,
      scrollTop: viewport.scrollTop,
      viewportHeight: viewport.viewportHeight,
      overscan: virtualState.overscan,
    });
    var nextWindowKey = [
      sortedRows.length,
      virtualState.rowHeight,
      windowState.startIndex,
      windowState.endIndex,
      windowState.topSpacerHeight,
      windowState.bottomSpacerHeight,
    ].join(':');
    if (force || virtualState.windowKey !== nextWindowKey) {
      mount.innerHTML = renderVirtualBrowseRowsBody(sortedRows, windowState);
      var measuredHeight = measureMountedRowHeight(mount, virtualState.rowHeight);
      if (measuredHeight !== virtualState.rowHeight) {
        virtualState.rowHeight = measuredHeight;
        windowState = computeVirtualWindow({
          rowCount: sortedRows.length,
          rowHeight: virtualState.rowHeight,
          scrollTop: viewport.scrollTop,
          viewportHeight: viewport.viewportHeight,
          overscan: virtualState.overscan,
        });
        nextWindowKey = [
          sortedRows.length,
          virtualState.rowHeight,
          windowState.startIndex,
          windowState.endIndex,
          windowState.topSpacerHeight,
          windowState.bottomSpacerHeight,
        ].join(':');
        mount.innerHTML = renderVirtualBrowseRowsBody(sortedRows, windowState);
      }
      virtualState.windowKey = nextWindowKey;
    }
    virtualState.enabled = true;
    setVirtualizationDataset(body, virtualState, windowState, windowState.endIndex - windowState.startIndex);
  } else {
    mount.innerHTML = renderBrowseRowsBody(sortedRows);
    virtualState.enabled = false;
    virtualState.windowKey = 'full:' + String(sortedRows.length);
    setVirtualizationDataset(body, virtualState, null, sortedRows.length);
  }
  updateBodyDataset(state);
  updateRefreshHref(state);
  updateSortControls(state);
}

function renderSnapshot(mount, state, payload, virtualState) {
  applyBrowseSnapshot(state, payload);
  updatePageShell(payload);
  renderRows(mount, state, virtualState, {force: true});
  return startFolderInfoPolling(state, {
    onRowsChanged: function (affectedKeys) {
      if (!affectedKeys[state.sort]) return;
      renderRows(mount, state, virtualState, {force: true});
    },
  });
}

function isModifiedClick(event) {
  return event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}

function initBrowse() {
  var body = document.body;
  if (!body || body.dataset.clientRender !== '1') return;
  var mount = document.getElementById('browse-rows');
  if (!mount) return;

  var locationState = readBrowseLocation(window.location.search);
  var state = createBrowseState(locationState);
  var requestVersion = 0;
  var currentController = null;
  var stopFolderPolling = function () {};
  var virtualState = createVirtualState();
  var scrollFrameRequested = false;

  function stopActiveWork() {
    if (currentController) {
      currentController.abort();
      currentController = null;
    }
    stopFolderPolling();
    stopFolderPolling = function () {};
  }

  function renderLoading(nextState) {
    setBrowseLoading(state, true);
    mount.innerHTML = loadingRowHtml('Loading folder listing...');
    body.dataset.browseClient = 'loading';
    setVirtualizationDataset(body, virtualState, null, 0);
    if (nextState) {
      state.path = nextState.path;
      state.sort = nextState.sort;
      state.dir = nextState.dir;
      updateBodyDataset(state);
    } else {
      updateBodyDataset(state);
    }
  }

  function loadBrowseState(nextState, options) {
    var normalized = {
      path: nextState.path,
      sort: nextState.sort,
      dir: nextState.dir,
      refresh: !!nextState.refresh,
    };
    var historyMode = options && options.history ? options.history : 'none';
    var scrollToTop = !options || options.scroll !== false;
    var version = requestVersion + 1;
    requestVersion = version;
    stopActiveWork();
    renderLoading(normalized);
    currentController = typeof AbortController === 'function' ? new AbortController() : null;
    return fetch(
      buildBrowseListingEndpoint(normalized),
      currentController ? {signal: currentController.signal} : undefined,
    )
      .then(function (response) {
        if (!response.ok) throw new Error('Could not load folder listing.');
        return response.json();
      })
      .then(function (payload) {
        if (version !== requestVersion) return false;
        currentController = null;
        stopFolderPolling = renderSnapshot(mount, state, payload, virtualState);
        body.dataset.browseClient = 'ready';
        if (scrollToTop) window.scrollTo(0, 0);
        var href = buildBrowsePageHref({
          path: state.path,
          sort: state.sort,
          dir: state.dir,
        });
        if (historyMode === 'push') {
          window.history.pushState({}, '', href);
        } else if (historyMode === 'replace') {
          window.history.replaceState({}, '', href);
        }
        return true;
      })
      .catch(function (error) {
        if (error && error.name === 'AbortError') return false;
        if (version !== requestVersion) return false;
        currentController = null;
        setBrowseError(state, error && error.message ? error.message : 'Could not load folder listing.');
        mount.innerHTML = errorRowHtml(state.error);
        body.dataset.browseClient = 'error';
        setVirtualizationDataset(body, virtualState, null, 0);
        return false;
      });
  }

  function scheduleViewportRender() {
    if (scrollFrameRequested || state.loading || !virtualState.enabled) return;
    scrollFrameRequested = true;
    window.requestAnimationFrame(function () {
      scrollFrameRequested = false;
      renderRows(mount, state, virtualState, {force: false});
    });
  }

  document.addEventListener('click', function (event) {
    var sortLink = event.target && event.target.closest ? event.target.closest('thead a[data-browse-sort]') : null;
    if (sortLink) {
      if (state.loading) return;
      event.preventDefault();
      var clickedSort = sortLink.getAttribute('data-browse-sort') || 'name';
      var nextSortState = nextBrowseSortState(state.sort, state.dir, clickedSort);
      state.sort = nextSortState.sort;
      state.dir = nextSortState.dir;
      renderRows(mount, state, virtualState, {force: true});
      window.history.pushState({}, '', buildBrowsePageHref({
        path: state.path,
        sort: state.sort,
        dir: state.dir,
      }));
      return;
    }

    var link = event.target && event.target.closest ? event.target.closest('a') : null;
    if (!link || state.loading) return;
    if (isModifiedClick(event) || !shouldInterceptBrowseLink(link)) return;
    var nextState = readBrowseHref(link.href || link.getAttribute('href') || '');
    if (!nextState) return;
    event.preventDefault();
    loadBrowseState(nextState, {history: 'push', scroll: true});
  });

  window.addEventListener('popstate', function () {
    loadBrowseState(readBrowseLocation(window.location.search), {history: 'none', scroll: true});
  });
  window.addEventListener('scroll', scheduleViewportRender, {passive: true});
  window.addEventListener('resize', scheduleViewportRender);

  loadBrowseState(state, {history: 'replace', scroll: false});
}

initBrowse();
