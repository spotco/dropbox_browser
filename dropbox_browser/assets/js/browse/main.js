import {buildBrowseListingEndpoint, buildBrowsePageHref} from './api.js';
import {startFolderInfoPolling} from './folder-info.js';
import {readBrowseHref, readBrowseLocation, shouldInterceptBrowseLink} from './navigation.js';
import {emptyRowHtml, errorRowHtml, loadingRowHtml, renderBreadcrumbs, renderBrowseRowsBody, renderVirtualBrowseRowsBody} from './render.js';
import {collectBrowseTypeOptions, filterBrowseRows, hasActiveBrowseFilters, normalizeBrowseFilters} from './search.js';
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

function readSetting(key, defaultValue) {
  if (!window.Settings || typeof window.Settings.get !== 'function') return defaultValue;
  return window.Settings.get(key, defaultValue);
}

function writeSetting(key, value) {
  if (!window.Settings || typeof window.Settings.set !== 'function') return;
  window.Settings.set(key, value);
}

function browseFilterStorageKey(path) {
  return path || '/';
}

function emptyBrowseFilters() {
  return normalizeBrowseFilters({});
}

function defaultBrowseFilterState() {
  return {
    visible: false,
    filters: emptyBrowseFilters(),
  };
}

function normalizeStoredBrowseFilterState(value) {
  if (!value || typeof value !== 'object') return defaultBrowseFilterState();
  return {
    visible: value.visible !== false,
    filters: normalizeBrowseFilters(value.filters || {}),
  };
}

function readPersistedBrowseFilterState(path) {
  var entries = readSetting('browse-filters-by-path', {});
  if (!entries || typeof entries !== 'object') return defaultBrowseFilterState();
  var entry = entries[browseFilterStorageKey(path)];
  if (!entry) return defaultBrowseFilterState();
  return normalizeStoredBrowseFilterState(entry);
}

function writePersistedBrowseFilterState(path, state) {
  var entries = readSetting('browse-filters-by-path', {});
  var nextEntries = entries && typeof entries === 'object' ? Object.assign({}, entries) : {};
  var key = browseFilterStorageKey(path);
  if (!state || state.visible === false) {
    delete nextEntries[key];
  } else {
    nextEntries[key] = {
      visible: true,
      filters: normalizeBrowseFilters(state.filters || {}),
    };
  }
  writeSetting('browse-filters-by-path', nextEntries);
}

function resolveBrowseFilterState(path, filters) {
  var normalized = normalizeBrowseFilters(filters);
  if (hasActiveBrowseFilters(normalized)) {
    return {
      visible: true,
      filters: normalized,
    };
  }
  return readPersistedBrowseFilterState(path);
}

function getEffectiveBrowseFilters(state) {
  if (!state || !state.filterBarVisible) return emptyBrowseFilters();
  return normalizeBrowseFilters(state.filters);
}

function updateBodyDataset(state) {
  var body = document.body;
  if (!body) return;
  var effectiveFilters = getEffectiveBrowseFilters(state);
  body.dataset.currentFolderPath = state.path;
  body.dataset.currentSortKey = state.sort;
  body.dataset.currentSortDirection = state.dir;
  body.dataset.browseEndpoint = buildBrowseListingEndpoint(state);
  body.dataset.browseRowCount = String((state.rows || []).length);
  body.dataset.browseFilterActive = hasActiveBrowseFilters(effectiveFilters) ? '1' : '0';
}

function updateRefreshHref(state) {
  var refreshLink = document.getElementById('refresh-cache');
  if (!refreshLink) return;
  refreshLink.setAttribute('href', buildBrowsePageHref({
    path: state.path,
    sort: state.sort,
    dir: state.dir,
    filters: getEffectiveBrowseFilters(state),
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
      filters: getEffectiveBrowseFilters(state),
    }));
    var indicator = '';
    if (state.sort === key) indicator = state.dir === 'asc' ? ' ^' : ' v';
    link.textContent = label + indicator;
  });
}

function currentBrowsePageHref(state) {
  return buildBrowsePageHref({
    path: state.path,
    sort: state.sort,
    dir: state.dir,
    filters: getEffectiveBrowseFilters(state),
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

function getFilteredRows(state) {
  return filterBrowseRows(state.rows, getEffectiveBrowseFilters(state));
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderSelectOptions(select, values, activeValue) {
  if (!select) return;
  var safeActiveValue = activeValue && activeValue !== 'all' ? String(activeValue) : 'all';
  var options = ['all'].concat(values || []);
  if (safeActiveValue !== 'all' && options.indexOf(safeActiveValue) === -1) options.push(safeActiveValue);
  select.innerHTML = options.map(function (value) {
    var label = value === 'all' ? 'All' : value;
    var selected = value === safeActiveValue ? ' selected' : '';
    return '<option value="' + escapeHtml(value) + '"' + selected + '>' + escapeHtml(label) + '</option>';
  }).join('');
}

function updateFilterControls(state) {
  var bar = document.getElementById('browse-filter-bar');
  var toggle = document.getElementById('browse-filter-toggle');
  var query = document.getElementById('browse-filter-query');
  var kind = document.getElementById('browse-filter-kind');
  var status = document.getElementById('browse-filter-status');
  var type = document.getElementById('browse-filter-type');
  var count = document.getElementById('browse-filter-count');
  var reset = document.getElementById('browse-filter-reset');
  if (!bar || !toggle || !query || !kind || !status || !type || !count || !reset) return;
  var visibleRows = getFilteredRows(state);
  var totalRows = Array.isArray(state.rows) ? state.rows.length : 0;
  var typeOptions = collectBrowseTypeOptions(state.rows);
  bar.hidden = !state.filterBarVisible;
  bar.classList.toggle('hidden', !state.filterBarVisible);
  toggle.textContent = state.filterBarVisible ? 'Hide Filters' : 'Show Filters';
  if (query.value !== state.filters.query) query.value = state.filters.query;
  kind.value = state.filters.kind;
  status.value = state.filters.status;
  renderSelectOptions(type, typeOptions, state.filters.type);
  count.textContent = 'Showing ' + String(visibleRows.length) + ' of ' + String(totalRows) + ' items';
  reset.disabled = !hasActiveBrowseFilters(state.filters);
}

function renderRows(mount, state, virtualState, options) {
  var body = document.body;
  var filteredRows = getFilteredRows(state);
  var sortedRows = sortBrowseRows(filteredRows, state.sort, state.dir);
  var force = !!(options && options.force);
  updateFilterControls(state);
  if (sortedRows.length === 0) {
    mount.innerHTML = emptyRowHtml(
      Array.isArray(state.rows) && state.rows.length > 0
        ? 'No rows match the current filters.'
        : 'This folder is empty.',
    );
    virtualState.enabled = false;
    virtualState.windowKey = 'empty:' + String(filteredRows.length) + ':' + String((state.rows || []).length);
    setVirtualizationDataset(body, virtualState, null, 0);
    updateBodyDataset(state);
    updateRefreshHref(state);
    updateSortControls(state);
    body.dataset.browseFilteredRowCount = '0';
    return;
  }
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
  body.dataset.browseFilteredRowCount = String(sortedRows.length);
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
      var filters = normalizeBrowseFilters(state.filters);
      var filterSensitive =
        (filters.status !== 'all' && affectedKeys.status) ||
        (filters.type !== 'all' && affectedKeys.type) ||
        filters.kind !== 'all';
      if (!affectedKeys[state.sort] && !filterSensitive) return;
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
  var filterUrlTimer = null;
  var FILTER_URL_DEBOUNCE_MS = 300;
  var initialFilterState = resolveBrowseFilterState(state.path, state.filters);
  state.filters = initialFilterState.filters;
  state.filterBarVisible = initialFilterState.visible;

  function notifyBrowseFolderChanged(previousPath, nextPath) {
    if (previousPath === nextPath) return;
    window.dispatchEvent(new CustomEvent('browse-folder-changed', {
      detail: {
        previousPath: previousPath,
        path: nextPath,
      },
    }));
  }

  function cancelFilterUrlTimer() {
    if (filterUrlTimer !== null) {
      window.clearTimeout(filterUrlTimer);
      filterUrlTimer = null;
    }
  }

  function syncBrowseUrl(historyMode) {
    var href = currentBrowsePageHref(state);
    if (historyMode === 'push') {
      window.history.pushState({}, '', href);
    } else if (historyMode === 'replace') {
      window.history.replaceState({}, '', href);
    }
  }

  function scheduleFilterUrlReplace() {
    cancelFilterUrlTimer();
    filterUrlTimer = window.setTimeout(function () {
      filterUrlTimer = null;
      syncBrowseUrl('replace');
    }, FILTER_URL_DEBOUNCE_MS);
  }

  function stopActiveWork() {
    cancelFilterUrlTimer();
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
      var filterState = resolveBrowseFilterState(nextState.path, nextState.filters || state.filters);
      state.path = nextState.path;
      state.sort = nextState.sort;
      state.dir = nextState.dir;
      state.filters = filterState.filters;
      state.filterBarVisible = filterState.visible;
      updateBodyDataset(state);
    } else {
      updateBodyDataset(state);
    }
    updateFilterControls(state);
  }

  function loadBrowseState(nextState, options) {
    var normalized = {
      path: nextState.path,
      sort: nextState.sort,
      dir: nextState.dir,
      refresh: !!nextState.refresh,
      filters: normalizeBrowseFilters(nextState.filters || state.filters),
    };
    var historyMode = options && options.history ? options.history : 'none';
    var scrollToTop = !options || options.scroll !== false;
    var version = requestVersion + 1;
    requestVersion = version;
    var previousPath = state.path;
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
        notifyBrowseFolderChanged(previousPath, state.path);
        if (scrollToTop) window.scrollTo(0, 0);
        var href = currentBrowsePageHref(state);
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

  function applyFilterChange(nextFilters, historyMode) {
    state.filters = normalizeBrowseFilters(nextFilters);
    if (hasActiveBrowseFilters(state.filters)) state.filterBarVisible = true;
    writePersistedBrowseFilterState(state.path, {
      visible: state.filterBarVisible,
      filters: state.filters,
    });
    renderRows(mount, state, virtualState, {force: true});
    if (historyMode === 'push') {
      cancelFilterUrlTimer();
      syncBrowseUrl('push');
    } else if (historyMode === 'replace') {
      cancelFilterUrlTimer();
      syncBrowseUrl('replace');
    } else if (historyMode === 'debounced-replace') {
      scheduleFilterUrlReplace();
    }
  }

  function applyFilterBarVisibility(visible) {
    cancelFilterUrlTimer();
    state.filterBarVisible = !!visible;
    if (!state.filterBarVisible && hasActiveBrowseFilters(state.filters)) {
      state.filters = emptyBrowseFilters();
      writePersistedBrowseFilterState(state.path, {visible: false});
      renderRows(mount, state, virtualState, {force: true});
      syncBrowseUrl('push');
      return;
    }
    if (!state.filterBarVisible) {
      state.filters = emptyBrowseFilters();
      writePersistedBrowseFilterState(state.path, {visible: false});
      renderRows(mount, state, virtualState, {force: true});
      syncBrowseUrl('push');
      return;
    }
    writePersistedBrowseFilterState(state.path, {
      visible: true,
      filters: state.filters,
    });
    updateFilterControls(state);
  }

  document.addEventListener('input', function (event) {
    if (!event.target) return;
    if (event.target.id === 'browse-filter-query') {
      applyFilterChange({
        query: event.target.value,
        kind: state.filters.kind,
        status: state.filters.status,
        type: state.filters.type,
      }, 'debounced-replace');
    }
  });

  document.addEventListener('change', function (event) {
    if (!event.target) return;
    if (event.target.id === 'browse-filter-kind') {
      applyFilterChange({
        query: state.filters.query,
        kind: event.target.value,
        status: state.filters.status,
        type: state.filters.type,
      }, 'push');
      return;
    }
    if (event.target.id === 'browse-filter-status') {
      applyFilterChange({
        query: state.filters.query,
        kind: state.filters.kind,
        status: event.target.value,
        type: state.filters.type,
      }, 'push');
      return;
    }
    if (event.target.id === 'browse-filter-type') {
      applyFilterChange({
        query: state.filters.query,
        kind: state.filters.kind,
        status: state.filters.status,
        type: event.target.value,
      }, 'push');
    }
  });

  document.addEventListener('click', function (event) {
    var toggleButton = event.target && event.target.closest ? event.target.closest('#browse-filter-toggle') : null;
    if (toggleButton) {
      event.preventDefault();
      applyFilterBarVisibility(!state.filterBarVisible);
      return;
    }
    var resetButton = event.target && event.target.closest ? event.target.closest('#browse-filter-reset') : null;
    if (resetButton) {
      event.preventDefault();
      applyFilterChange({ query: '', kind: 'all', status: 'all', type: 'all' }, 'push');
      return;
    }
    var sortLink = event.target && event.target.closest ? event.target.closest('thead a[data-browse-sort]') : null;
    if (sortLink) {
      if (state.loading) return;
      event.preventDefault();
      var clickedSort = sortLink.getAttribute('data-browse-sort') || 'name';
      var nextSortState = nextBrowseSortState(state.sort, state.dir, clickedSort);
      state.sort = nextSortState.sort;
      state.dir = nextSortState.dir;
      renderRows(mount, state, virtualState, {force: true});
      window.history.pushState({}, '', currentBrowsePageHref(state));
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
