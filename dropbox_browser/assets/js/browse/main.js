import {buildBrowseListingEndpoint, buildBrowsePageHref} from './api.js';
import {initBrowseColumnResizing} from './columns.js';
import {startFolderInfoPolling} from './folder-info.js';
import {initBrowseHorizontalScrollbar} from './horizontal-scrollbar.js';
import {initImageHoverPreview} from './image-hover-preview.js';
import {readBrowseHref, readBrowseLocation, shouldInterceptBrowseLink} from './navigation.js';
import {emptyRowHtml, errorRowHtml, loadingRowHtml, renderBreadcrumbs, renderBrowseRowsBody, renderVirtualBrowseRowsBody} from './render.js';
import {collectBrowseTypeOptions, filterBrowseRows, hasActiveBrowseFilters, normalizeBrowseFilters} from './search.js';
import {applyBrowseSnapshot, createBrowseState, setBrowseError, setBrowseLoading} from './state.js';
import {nextBrowseSortState, sortBrowseRows} from './sort.js';
import {initBrowseThumbnails} from './thumbnails.js';
import {
  DEFAULT_VIRTUAL_OVERSCAN,
  DEFAULT_VIRTUAL_ROW_HEIGHT,
  DEFAULT_VIRTUAL_THRESHOLD,
  computeVirtualWindow,
  measureMountedRowHeight,
  readTableViewport,
  rowIndexForScrollPosition,
  shouldVirtualizeRows,
} from './virtual-list.js';

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderHeaderMetaHtml(page, breadcrumbs) {
  if (!page || !page.local_root_name) {
    return escapeHtml(page.remote) + ' / ' + renderBreadcrumbs(breadcrumbs || []);
  }
  var items = [];
  items.push(escapeHtml((page.local_root_prefix || '') + ' ') + '<a href="/">' + escapeHtml(page.local_root_name) + '</a>');
  (breadcrumbs || []).slice(1).forEach(function (item) {
    items.push('<a href="' + escapeHtml(item.href) + '">' + escapeHtml(item.name) + '</a>');
  });
  return items.join(' \\ ');
}

function updatePageShell(payload) {
  var page = payload.page || {};
  var headingLink = document.querySelector('header h1 a.site-title-link');
  var meta = document.querySelector('header .meta');
  var breadcrumbNav = document.querySelector('.breadcrumbs');
  var refreshLink = document.getElementById('refresh-cache');
  var topbarCopyButton = document.querySelector('.topbar-actions .copy-path');
  var dropboxLink = document.querySelector('.topbar-actions .dropbox-link');
  if (page.title) {
    document.title = page.title;
    if (headingLink) headingLink.textContent = page.title;
  }
  if (meta) {
    meta.innerHTML = renderHeaderMetaHtml(page, payload.breadcrumbs || []);
  }
  if (refreshLink) {
    refreshLink.setAttribute('href', page.refresh_href || refreshLink.getAttribute('href') || '/');
    refreshLink.setAttribute('title', 'Refresh cached metadata for this folder');
  }
  if (breadcrumbNav && refreshLink && refreshLink.parentElement !== breadcrumbNav) {
    breadcrumbNav.textContent = '';
    breadcrumbNav.appendChild(refreshLink);
  }
  if (topbarCopyButton && page.current_local_folder) {
    topbarCopyButton.setAttribute('data-copy-path', page.current_local_folder);
  }
  if (dropboxLink && page.dropbox_home_url) {
    dropboxLink.setAttribute('href', page.dropbox_home_url);
    dropboxLink.setAttribute('target', '_blank');
    dropboxLink.setAttribute('rel', 'noopener noreferrer');
    dropboxLink.textContent = 'Go to Dropbox';
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
    reveal: state.reveal,
    sort: state.sort,
    dir: state.dir,
    filters: getEffectiveBrowseFilters(state),
  });
}

function createVirtualState() {
  return {
    rowHeight: DEFAULT_VIRTUAL_ROW_HEIGHT,
    rowHeightMeasured: false,
    overscan: DEFAULT_VIRTUAL_OVERSCAN,
    threshold: DEFAULT_VIRTUAL_THRESHOLD,
    enabled: false,
    windowKey: '',
  };
}

function resetVirtualMeasurement(virtualState) {
  virtualState.rowHeight = DEFAULT_VIRTUAL_ROW_HEIGHT;
  virtualState.rowHeightMeasured = false;
  virtualState.windowKey = '';
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

function getSortedFilteredRows(state) {
  return sortBrowseRows(getFilteredRows(state), state.sort, state.dir);
}

function browsePreviewMetaText(row) {
  var kindLabel = row.kind === 'folder' ? 'Folder' : (row.type_label || 'File');
  return kindLabel + ' - ' + (row.status_label || '');
}

function browsePreviewDetailText(row, sortKey) {
  if (sortKey === 'size') {
    if (row.count_display && row.size_display && row.size_display !== '—') return row.size_display + ' (' + row.count_display + ')';
    if (row.count_display) return row.count_display;
    if (row.size_display && row.size_display !== '—') return row.size_display;
  }
  if (sortKey === 'date' && row.date_display) return row.date_display;
  if (sortKey === 'type' && row.type_label) return 'Type: ' + row.type_label;
  if (sortKey === 'status' && row.status_label) return 'Status: ' + row.status_label;
  if (row.kind === 'folder' && row.count_display) return row.count_display;
  if (row.date_display) return row.date_display;
  if (row.size_display && row.size_display !== '—') return row.size_display;
  return '';
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
      if (!virtualState.rowHeightMeasured) {
        var measuredHeight = measureMountedRowHeight(mount, virtualState.rowHeight);
        virtualState.rowHeightMeasured = true;
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

function renderSnapshot(mount, state, payload, virtualState, onRendered) {
  applyBrowseSnapshot(state, payload);
  updatePageShell(payload);
  resetVirtualMeasurement(virtualState);
  renderRows(mount, state, virtualState, {force: true, reason: 'snapshot'});
  if (typeof onRendered === 'function') onRendered();
  return startFolderInfoPolling(state, {
    onRowsChanged: function (affectedKeys) {
      var filters = normalizeBrowseFilters(state.filters);
      var filterSensitive =
        (filters.status !== 'all' && affectedKeys.status) ||
        (filters.type !== 'all' && affectedKeys.type) ||
        filters.kind !== 'all';
      if (!affectedKeys[state.sort] && !filterSensitive) return;
      renderRows(mount, state, virtualState, {force: true, reason: 'folder-info'});
      if (typeof onRendered === 'function') onRendered();
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
  initBrowseColumnResizing({document: document, window: window});
  initImageHoverPreview({document: document, window: window, root: mount});
  var thumbnailLoader = initBrowseThumbnails({document: document, window: window, root: mount});
  var horizontalScrollbar = initBrowseHorizontalScrollbar({
    document: document,
    window: window,
    shell: document.querySelector('.browse-table-shell'),
    scrollContainer: document.querySelector('main'),
  });
  var scrollPreview = document.getElementById('browse-scroll-preview');
  var scrollPreviewIndex = document.getElementById('browse-scroll-preview-index');
  var scrollPreviewName = document.getElementById('browse-scroll-preview-name');
  var scrollPreviewMeta = document.getElementById('browse-scroll-preview-meta');
  var scrollPreviewDetail = document.getElementById('browse-scroll-preview-detail');
  var pageScrollEl = document.querySelector('main');

  var locationState = readBrowseLocation(window.location.search);
  var state = createBrowseState(locationState);
  var requestVersion = 0;
  var currentController = null;
  var stopFolderPolling = function () {};
  var virtualState = createVirtualState();
  var scrollFrameRequested = false;
  var revealFrameRequested = false;
  var revealAttemptCount = 0;
  var filterUrlTimer = null;
  var FILTER_URL_DEBOUNCE_MS = 300;
  var previewHideTimer = null;
  var previewScrollbarDragActive = false;
  var PREVIEW_HIDE_DELAY_MS = 360;
  var PREVIEW_DRAG_RELEASE_DELAY_MS = 140;
  var SCROLLBAR_GUTTER_PX = 30;
  var initialFilterState = resolveBrowseFilterState(state.path, state.filters);
  state.filters = initialFilterState.filters;
  state.filterBarVisible = initialFilterState.visible;
  body.dataset.browseScrollPreview = 'hidden';
  body.dataset.browseScrollPreviewIndex = '';

  function logRevealDebug(level, message, extra) {
    var consoleLevel = level === 'debug' ? 'log' : level;
    if (!window.console || typeof window.console[consoleLevel] !== 'function') return;
    var details = extra || {};
    window.console[consoleLevel]('[browse-reveal] ' + message, details);
  }

  function scrollPageToTop() {
    if (pageScrollEl && pageScrollEl.scrollHeight > pageScrollEl.clientHeight) {
      pageScrollEl.scrollTop = 0;
      return;
    }
    window.scrollTo(0, 0);
  }

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

  function cancelPreviewHideTimer() {
    if (previewHideTimer !== null) {
      window.clearTimeout(previewHideTimer);
      previewHideTimer = null;
    }
  }

  function hideScrollPreview() {
    cancelPreviewHideTimer();
    body.dataset.browseScrollPreview = 'hidden';
    body.dataset.browseScrollPreviewIndex = '';
    if (!scrollPreview) return;
    scrollPreview.classList.add('hidden');
    scrollPreview.setAttribute('aria-hidden', 'true');
  }

  function scheduleScrollPreviewHide(delay) {
    cancelPreviewHideTimer();
    previewHideTimer = window.setTimeout(function () {
      previewHideTimer = null;
      if (previewScrollbarDragActive) return;
      hideScrollPreview();
    }, delay);
  }

  function updateScrollPreview(options) {
    if (!scrollPreview || state.loading || !virtualState.enabled) {
      hideScrollPreview();
      return;
    }
    var rows = getSortedFilteredRows(state);
    if (!Array.isArray(rows) || rows.length === 0) {
      hideScrollPreview();
      return;
    }
    var viewport = readTableViewport(mount, virtualState.rowHeight);
    var rowIndex = rowIndexForScrollPosition({
      rowCount: rows.length,
      rowHeight: virtualState.rowHeight,
      scrollTop: viewport.scrollTop,
      viewportHeight: viewport.viewportHeight,
    });
    if (rowIndex < 0 || rowIndex >= rows.length) {
      hideScrollPreview();
      return;
    }
    var row = rows[rowIndex];
    var detailText = browsePreviewDetailText(row, state.sort);
    body.dataset.browseScrollPreview = 'visible';
    body.dataset.browseScrollPreviewIndex = String(rowIndex);
    scrollPreviewIndex.textContent = String(rowIndex + 1) + ' / ' + String(rows.length);
    scrollPreviewName.textContent = row.display_name || row.path || '';
    scrollPreviewMeta.textContent = browsePreviewMetaText(row);
    scrollPreviewDetail.textContent = detailText;
    scrollPreviewDetail.hidden = !detailText;
    scrollPreview.classList.remove('hidden');
    scrollPreview.setAttribute('aria-hidden', 'false');
    if (options && options.persistent) {
      cancelPreviewHideTimer();
      return;
    }
    scheduleScrollPreviewHide(PREVIEW_HIDE_DELAY_MS);
  }

  function renderAndRefresh(options) {
    var nextOptions = Object.assign({reason: 'render-refresh'}, options || {});
    if (nextOptions.force) resetVirtualMeasurement(virtualState);
    renderRows(mount, state, virtualState, nextOptions);
    thumbnailLoader.refresh();
    horizontalScrollbar.refresh();
    if (state.reveal) scheduleRevealAttempt();
    if (!virtualState.enabled) {
      hideScrollPreview();
      return;
    }
    if (body.dataset.browseScrollPreview === 'visible') {
      updateScrollPreview({persistent: previewScrollbarDragActive});
    }
  }

  function consumeRevealTarget() {
    if (!state.reveal) return;
    logRevealDebug('debug', 'consume reveal target', {
      path: state.path,
      reveal: state.reveal,
      attempts: revealAttemptCount,
    });
    revealAttemptCount = 0;
    revealFrameRequested = false;
    state.reveal = '';
    window.history.replaceState({}, '', currentBrowsePageHref(state));
  }

  function findMountedRowByPath(relPath) {
    if (!mount || typeof mount.querySelectorAll !== 'function' || !relPath) return null;
    var rows = mount.querySelectorAll('tr[data-row-path]');
    for (var index = 0; index < rows.length; index += 1) {
      var row = rows[index];
      if (!row) continue;
      var rowPath = row.dataset && typeof row.dataset.rowPath === 'string'
        ? row.dataset.rowPath
        : row.getAttribute('data-row-path');
      if (rowPath === relPath) return row;
    }
    return null;
  }

  function setBrowseScrollTop(value) {
    var nextValue = Math.max(0, Number(value) || 0);
    logRevealDebug('debug', 'set scroll top', {
      nextValue: nextValue,
      usingMainScroller: !!(pageScrollEl && pageScrollEl.scrollHeight > pageScrollEl.clientHeight),
      mainScrollTop: pageScrollEl ? pageScrollEl.scrollTop : null,
      windowScrollY: typeof window.scrollY === 'number' ? window.scrollY : null,
    });
    if (pageScrollEl && pageScrollEl.scrollHeight > pageScrollEl.clientHeight) {
      pageScrollEl.scrollTop = nextValue;
      return;
    }
    window.scrollTo(0, nextValue);
  }

  function scrollVirtualRowIntoViewport(rowIndex) {
    var tableRect = mount.getBoundingClientRect();
    var targetOffset = rowIndex * virtualState.rowHeight;
    logRevealDebug('debug', 'scroll virtual row into viewport', {
      rowIndex: rowIndex,
      rowHeight: virtualState.rowHeight,
      targetOffset: targetOffset,
      tableRectTop: tableRect.top,
      tableRectHeight: tableRect.height,
      mainClientHeight: pageScrollEl ? pageScrollEl.clientHeight : null,
      mainScrollHeight: pageScrollEl ? pageScrollEl.scrollHeight : null,
      mainScrollTop: pageScrollEl ? pageScrollEl.scrollTop : null,
      windowInnerHeight: window.innerHeight || null,
      windowScrollY: typeof window.scrollY === 'number' ? window.scrollY : null,
    });
    if (pageScrollEl && pageScrollEl.scrollHeight > pageScrollEl.clientHeight) {
      var parentRect = pageScrollEl.getBoundingClientRect();
      var tableTop = tableRect.top - parentRect.top + pageScrollEl.scrollTop;
      var centeredTop = tableTop + targetOffset - Math.max(0, (pageScrollEl.clientHeight - virtualState.rowHeight) / 2);
      setBrowseScrollTop(centeredTop);
      return;
    }
    var windowHeight = window.innerHeight || virtualState.rowHeight;
    var absoluteTableTop = tableRect.top + window.scrollY;
    var targetTop = absoluteTableTop + targetOffset - Math.max(0, (windowHeight - virtualState.rowHeight) / 2);
    setBrowseScrollTop(targetTop);
  }

  function attemptRevealBrowsePath(relPath) {
    if (!relPath) return true;
    var rows = getSortedFilteredRows(state);
    var rowIndex = rows.findIndex(function (row) {
      return row && row.path === relPath;
    });
    logRevealDebug('debug', 'attempt reveal browse path', {
      browsePath: state.path,
      reveal: relPath,
      rowIndex: rowIndex,
      rowCount: rows.length,
      virtualEnabled: virtualState.enabled,
      virtualWindowKey: virtualState.windowKey,
      filteredRowCount: body.dataset.browseFilteredRowCount || null,
      renderCount: body.dataset.browseRenderCount || null,
      visibleRange: body.dataset.browseVisibleRange || null,
      currentUrl: window.location.href,
    });
    if (rowIndex < 0) {
      logRevealDebug('warn', 'reveal target row not found in loaded rows', {
        browsePath: state.path,
        reveal: relPath,
        rowCount: rows.length,
      });
      consumeRevealTarget();
      return true;
    }
    var mountedRow = findMountedRowByPath(relPath);
    logRevealDebug('debug', 'mounted row lookup', {
      reveal: relPath,
      mounted: !!mountedRow,
    });
    if (mountedRow && typeof mountedRow.scrollIntoView === 'function') {
      logRevealDebug('debug', 'scroll mounted row into view', {
        reveal: relPath,
      });
      mountedRow.scrollIntoView({block: 'nearest'});
      consumeRevealTarget();
      return true;
    }
    if (virtualState.enabled) {
      scrollVirtualRowIntoViewport(rowIndex);
      renderAndRefresh({force: false});
      return false;
    }
    return false;
  }

  function scheduleRevealAttempt() {
    if (!state.reveal || revealFrameRequested) return;
    logRevealDebug('debug', 'schedule reveal attempt', {
      reveal: state.reveal,
      attemptCount: revealAttemptCount,
      currentUrl: window.location.href,
    });
    revealFrameRequested = true;
    window.requestAnimationFrame(function () {
      revealFrameRequested = false;
      if (!state.reveal) return;
      revealAttemptCount += 1;
      if (attemptRevealBrowsePath(state.reveal)) return;
      if (revealAttemptCount < 8) {
        scheduleRevealAttempt();
        return;
      }
      consumeRevealTarget();
    });
  }

  function isScrollbarGesture(event) {
    if (!event || typeof event.clientX !== 'number') return false;
    if (event.pointerType === 'touch') return false;
    if (pageScrollEl && pageScrollEl.scrollHeight > pageScrollEl.clientHeight) {
      var rect = pageScrollEl.getBoundingClientRect();
      return event.clientX >= rect.right - SCROLLBAR_GUTTER_PX && event.clientX <= rect.right + 2;
    }
    return (window.innerWidth - event.clientX) <= SCROLLBAR_GUTTER_PX;
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
      var currentParams = new URL(window.location.href).searchParams;
      var nextFilters = getEffectiveBrowseFilters(state);
      var nextQuery = typeof nextFilters.query === 'string' ? nextFilters.query.trim() : '';
      var historyMode = 'replace';
      if (state.path && nextQuery && !currentParams.has('q')) {
        historyMode = 'push';
      }
      syncBrowseUrl(historyMode);
    }, FILTER_URL_DEBOUNCE_MS);
  }

  function stopActiveWork() {
    cancelFilterUrlTimer();
    previewScrollbarDragActive = false;
    hideScrollPreview();
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
    thumbnailLoader.refresh();
    horizontalScrollbar.refresh();
    body.dataset.browseClient = 'loading';
    setVirtualizationDataset(body, virtualState, null, 0);
    hideScrollPreview();
    if (nextState) {
      var filterState = resolveBrowseFilterState(nextState.path, nextState.filters || state.filters);
      state.path = nextState.path;
      state.reveal = nextState.reveal || '';
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
      reveal: nextState.reveal || '',
      sort: nextState.sort,
      dir: nextState.dir,
      refresh: !!nextState.refresh,
      filters: normalizeBrowseFilters(nextState.filters || state.filters),
    };
    var historyMode = options && options.history ? options.history : 'none';
    var scrollToTop = !options || options.scroll !== false;
    var version = requestVersion + 1;
    logRevealDebug('debug', 'load browse state', {
      nextPath: normalized.path,
      nextReveal: normalized.reveal || '',
      historyMode: historyMode,
      scrollToTop: scrollToTop,
      currentUrl: window.location.href,
    });
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
        stopFolderPolling = renderSnapshot(mount, state, payload, virtualState, function () {
          thumbnailLoader.refresh();
          horizontalScrollbar.refresh();
          if (state.reveal) scheduleRevealAttempt();
          if (!virtualState.enabled) {
            hideScrollPreview();
            return;
          }
          if (previewScrollbarDragActive || body.dataset.browseScrollPreview === 'visible') {
            updateScrollPreview({persistent: previewScrollbarDragActive});
            return;
          }
          hideScrollPreview();
        });
        body.dataset.browseClient = 'ready';
        notifyBrowseFolderChanged(previousPath, state.path);
        if (state.reveal) scheduleRevealAttempt();
        else if (scrollToTop) scrollPageToTop();
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
        thumbnailLoader.refresh();
        horizontalScrollbar.refresh();
        body.dataset.browseClient = 'error';
        setVirtualizationDataset(body, virtualState, null, 0);
        hideScrollPreview();
        return false;
      });
  }

  window.DropboxBrowseClient = {
    isActive: function () {
      return !!(body && body.dataset.clientRender === '1');
    },
    reloadCurrentFolder: function (options) {
      var settings = options || {};
      var nextState = readBrowseLocation(window.location.search);
      if (settings.refresh !== false) nextState.refresh = true;
      return loadBrowseState(nextState, {
        history: settings.history || 'replace',
        scroll: settings.scroll === true,
      });
    },
  };

  function scheduleViewportRender() {
    if (scrollFrameRequested || state.loading || !virtualState.enabled) return;
    scrollFrameRequested = true;
    window.requestAnimationFrame(function () {
      scrollFrameRequested = false;
      renderRows(mount, state, virtualState, {force: false, reason: 'scroll'});
      thumbnailLoader.refresh();
      horizontalScrollbar.refresh();
      updateScrollPreview({persistent: previewScrollbarDragActive});
    });
  }

  function applyFilterChange(nextFilters, historyMode) {
    state.filters = normalizeBrowseFilters(nextFilters);
    if (hasActiveBrowseFilters(state.filters)) state.filterBarVisible = true;
    writePersistedBrowseFilterState(state.path, {
      visible: state.filterBarVisible,
      filters: state.filters,
    });
    renderAndRefresh({force: true});
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
      renderAndRefresh({force: true});
      syncBrowseUrl('push');
      return;
    }
    if (!state.filterBarVisible) {
      state.filters = emptyBrowseFilters();
      writePersistedBrowseFilterState(state.path, {visible: false});
      renderAndRefresh({force: true});
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
      renderAndRefresh({force: true});
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
  window.addEventListener('pointerdown', function (event) {
    previewScrollbarDragActive = isScrollbarGesture(event);
    if (previewScrollbarDragActive) updateScrollPreview({persistent: true});
  }, {passive: true});
  window.addEventListener('pointerup', function () {
    if (!previewScrollbarDragActive) return;
    previewScrollbarDragActive = false;
    if (body.dataset.browseScrollPreview === 'visible') scheduleScrollPreviewHide(PREVIEW_DRAG_RELEASE_DELAY_MS);
  }, {passive: true});
  window.addEventListener('pointercancel', function () {
    previewScrollbarDragActive = false;
    hideScrollPreview();
  }, {passive: true});
  window.addEventListener('blur', function () {
    previewScrollbarDragActive = false;
    hideScrollPreview();
  });
  window.addEventListener('scroll', scheduleViewportRender, {passive: true});
  if (pageScrollEl) pageScrollEl.addEventListener('scroll', scheduleViewportRender, {passive: true});
  window.addEventListener('resize', scheduleViewportRender);

  loadBrowseState(state, {history: 'replace', scroll: false});
}

initBrowse();
