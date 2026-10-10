import {buildBrowseListingEndpoint, buildBrowsePageHref} from './api.js';
import {initBrowseColumnResizing} from './columns.js';
import {startFolderInfoPolling} from './folder-info.js';
import {initBrowseHorizontalScrollbar} from './horizontal-scrollbar.js';
import {initImageHoverPreview} from './image-hover-preview.js';
import {listingWarningMessage} from './listing-warning.js';
import {readBrowseHref, readBrowseLocation, shouldInterceptBrowseLink} from './navigation.js';
import {
  createBrowseRow,
  emptyRowHtml,
  errorRowHtml,
  loadingRowHtml,
  renderBreadcrumbs,
  renderBrowseRowsBody,
  updateBrowseRow,
} from './render.js';
import {collectBrowseTypeOptions, filterBrowseRows, hasActiveBrowseFilters, normalizeBrowseFilters} from './search.js';
import {applyBrowseSnapshot, createBrowseState, setBrowseError, setBrowseLoading} from './state.js';
import {nextBrowseSortState, sortBrowseRows} from './sort.js';
import {
  BROWSE_SORT_SETTING_KEY,
  readBrowseSortState,
  writeBrowseSortState,
} from './sort-settings.js';
import {initBrowseThumbnails} from './thumbnails.js';
import {
  DEFAULT_VIRTUAL_OVERSCAN,
  DEFAULT_VIRTUAL_ROW_HEIGHT,
  DEFAULT_VIRTUAL_THRESHOLD,
  createVirtualRowRecycler,
  insertBeforeChild,
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
  var meta = document.querySelector('header .meta');
  var breadcrumbNav = document.querySelector('.breadcrumbs');
  var refreshLink = document.getElementById('refresh-cache');
  var topbarCopyButton = document.querySelector('.topbar-actions .copy-path');
  var dropboxLink = document.querySelector('.topbar-actions .dropbox-link');
  if (page.title) {
    document.title = page.title;
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
  updateListingWarning(payload);
}

var LISTING_WARNING_ID = 'browse-listing-warning';

function listingWarningElement(create) {
  var existing = document.getElementById(LISTING_WARNING_ID);
  if (existing || !create) return existing;
  var shell = document.querySelector('.browse-table-shell');
  if (!shell || !shell.parentNode) return null;
  var banner = document.createElement('div');
  banner.id = LISTING_WARNING_ID;
  banner.className = 'browse-listing-warning';
  banner.setAttribute('role', 'status');
  banner.hidden = true;
  var text = document.createElement('span');
  text.className = 'browse-listing-warning-text';
  var button = document.createElement('button');
  button.type = 'button';
  button.className = 'browse-listing-warning-refresh';
  button.textContent = 'Refresh';
  button.addEventListener('click', function () {
    var client = window.DropboxBrowseClient;
    if (!client || typeof client.reloadCurrentFolder !== 'function') {
      window.location.reload();
      return;
    }
    button.disabled = true;
    button.textContent = 'Refreshing...';
    // The failed listing was never cached, so a normal reload asks Dropbox
    // again without discarding the folder metadata caches. Refresh in place
    // (keeping the rows and scroll position) when the client supports it.
    var reload = typeof client.refreshCurrentFolderInPlace === 'function'
      ? client.refreshCurrentFolderInPlace({refresh: false})
      : client.reloadCurrentFolder({refresh: false, history: 'replace'});
    Promise.resolve(reload).then(
      function () { resetListingWarningButton(button); },
      function () { resetListingWarningButton(button); },
    );
  });
  banner.appendChild(text);
  banner.appendChild(button);
  shell.parentNode.insertBefore(banner, shell);
  return banner;
}

function resetListingWarningButton(button) {
  button.disabled = false;
  button.textContent = 'Refresh';
}


function updateListingWarning(payload) {
  var listing = (payload && payload.listing) || {};
  var message = listingWarningMessage(listing);
  var banner = listingWarningElement(!!message);
  if (!banner) return;
  if (!message) {
    banner.hidden = true;
    banner.removeAttribute('data-listing-state');
    return;
  }
  banner.querySelector('.browse-listing-warning-text').textContent = message;
  banner.setAttribute('title', 'Dropbox error: ' + String(listing.remote_error));
  banner.setAttribute('data-listing-state', listing.stale ? 'stale' : 'local-only');
  banner.hidden = false;
}

function hideListingWarning() {
  var banner = listingWarningElement(false);
  if (banner) banner.hidden = true;
}

// Banner for a failed in-place refresh: the rows shown are kept but may be
// out of date; its Refresh button retries.
function showListingRefreshFailedWarning(errorMessage) {
  var banner = listingWarningElement(true);
  if (!banner) return;
  banner.querySelector('.browse-listing-warning-text').textContent =
    'Could not refresh the folder listing. The rows shown may be out of date.';
  banner.setAttribute('title', String(errorMessage || 'Could not load folder listing.'));
  banner.setAttribute('data-listing-state', 'refresh-failed');
  banner.hidden = false;
}

function readSetting(key, defaultValue) {
  if (!window.Settings || typeof window.Settings.get !== 'function') return defaultValue;
  return window.Settings.get(key, defaultValue);
}

function writeSetting(key, value) {
  if (!window.Settings || typeof window.Settings.set !== 'function') return;
  window.Settings.set(key, value);
}

function persistedBrowseSortState(path) {
  return readBrowseSortState(path, readSetting(BROWSE_SORT_SETTING_KEY, {}));
}

function persistBrowseSortState(path, sortKey, direction) {
  var entries = readSetting(BROWSE_SORT_SETTING_KEY, {});
  writeSetting(
    BROWSE_SORT_SETTING_KEY,
    writeBrowseSortState(path, sortKey, direction, entries),
  );
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
    recycler: null,
    createRecycler: null,
    topSpacer: null,
    bottomSpacer: null,
  };
}

function resetVirtualMeasurement(virtualState) {
  virtualState.rowHeight = DEFAULT_VIRTUAL_ROW_HEIGHT;
  virtualState.rowHeightMeasured = false;
  virtualState.windowKey = '';
  if (virtualState.recycler) virtualState.recycler.setRowHeight(virtualState.rowHeight);
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

function destroyBrowseVirtualRecycler(virtualState) {
  if (virtualState.recycler) virtualState.recycler.destroy();
  virtualState.recycler = null;
  virtualState.topSpacer = null;
  virtualState.bottomSpacer = null;
}

function setBrowseSpacerHeight(spacer, height) {
  var cell;
  if (!spacer) return;
  cell = spacer.firstElementChild;
  spacer.hidden = !(Number(height) > 0);
  if (cell) cell.style.height = String(Math.max(0, Number(height) || 0)) + 'px';
}

function renderRows(mount, state, virtualState, options) {
  var body = document.body;
  var filteredRows = getFilteredRows(state);
  var sortedRows = sortBrowseRows(filteredRows, state.sort, state.dir);
  var force = !!(options && options.force);
  updateFilterControls(state);
  if (sortedRows.length === 0) {
    destroyBrowseVirtualRecycler(virtualState);
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
    virtualState.enabled = true;
    if (virtualState.recycler && virtualState.bottomSpacer && virtualState.bottomSpacer.parentNode !== mount) {
      destroyBrowseVirtualRecycler(virtualState);
    }
    if (!virtualState.recycler) {
      if (typeof virtualState.createRecycler !== 'function') {
        throw new Error('browse virtual recycler factory is not installed');
      }
      mount.innerHTML = '';
      virtualState.recycler = virtualState.createRecycler(mount);
    }
    virtualState.recycler.setData(sortedRows.length, function (index) {
      return sortedRows[index];
    });
    var windowState = virtualState.recycler.render(force);
    setVirtualizationDataset(body, virtualState, windowState, windowState.endIndex - windowState.startIndex);
  } else {
    destroyBrowseVirtualRecycler(virtualState);
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

function renderSnapshot(mount, state, payload, virtualState, onRendered, options) {
  applyBrowseSnapshot(state, payload);
  updatePageShell(payload);
  // An in-place refresh keeps the measured row height: resetting it to the
  // default would shift the virtual spacers and with them the visible rows.
  if (!(options && options.keepMeasurement)) resetVirtualMeasurement(virtualState);
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
  var horizontalScrollbar = initBrowseHorizontalScrollbar({
    document: document,
    window: window,
    shell: document.querySelector('.browse-table-shell'),
    scrollContainer: document.querySelector('main'),
    logPanel: document.getElementById('log-panel'),
  });
  var browseColumns = initBrowseColumnResizing({
    document: document,
    window: window,
    onWidthsChanged: function () {
      horizontalScrollbar.refresh();
    },
  });
  initImageHoverPreview({document: document, window: window, root: mount});
  var thumbnailLoader = initBrowseThumbnails({document: document, window: window, root: mount});
  var scrollPreview = document.getElementById('browse-scroll-preview');
  var scrollPreviewIndex = document.getElementById('browse-scroll-preview-index');
  var scrollPreviewName = document.getElementById('browse-scroll-preview-name');
  var scrollPreviewMeta = document.getElementById('browse-scroll-preview-meta');
  var scrollPreviewDetail = document.getElementById('browse-scroll-preview-detail');
  var pageScrollEl = document.querySelector('main');

  var locationState = readBrowseLocation(window.location.search);
  var state = createBrowseState(locationState);
  var initialSortState = persistedBrowseSortState(state.path);
  state.sort = initialSortState.key;
  state.dir = initialSortState.direction;
  var requestVersion = 0;
  var currentController = null;
  var currentListingPromise = null;
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
  var BROWSE_ENTRY_STATE_KEY = 'browseEntryId';
  var BROWSE_SCROLL_STORAGE_KEY = 'dropbox-browser.browse-scroll-positions';
  var BROWSE_SCROLL_STORAGE_LIMIT = 100;
  // Last scroll offset per folder path, so a forward navigation into a folder
  // visited earlier in this tab (breadcrumb, folder row, any folder link)
  // comes back where the user left it. Same cap and LRU order as above.
  var BROWSE_PATH_SCROLL_STORAGE_KEY = 'dropbox-browser.browse-scroll-positions-by-path';
  var currentBrowseEntryId = '';
  var browseScrollPositions = null;
  var browsePathScrollPositions = null;
  var initialFilterState = resolveBrowseFilterState(state.path, state.filters);
  state.filters = initialFilterState.filters;
  state.filterBarVisible = initialFilterState.visible;
  body.dataset.browseScrollPreview = 'hidden';
  body.dataset.browseScrollPreviewIndex = '';

  function logRevealDebug(level, message, extra) {
    if (!window.ClientLogger) return;
    window.ClientLogger.log('browse-reveal', level, message, extra || {});
  }

  function scrollPageToTop() {
    if (pageScrollEl && pageScrollEl.scrollHeight > pageScrollEl.clientHeight) {
      pageScrollEl.scrollTop = 0;
      return;
    }
    window.scrollTo(0, 0);
  }

  // Scroll restoration for same-document history entries.
  //
  // The browse page scrolls <main> (body.has-log-panel), which the browser's
  // native history scroll restoration does not track, and every navigation
  // swaps the listing for a loading row before the new listing arrives. Each
  // history entry therefore carries a browseEntryId in history.state; the
  // offset of the entry being left is recorded (while its listing is still
  // mounted) under that id in sessionStorage, and is re-applied after the
  // listing for the destination entry has rendered. New entries start at the
  // top. sessionStorage keeps offsets across reload and cross-document Back.
  function readBrowseScrollTop() {
    if (pageScrollEl && pageScrollEl.scrollHeight > pageScrollEl.clientHeight) {
      return pageScrollEl.scrollTop;
    }
    return typeof window.scrollY === 'number' ? window.scrollY : 0;
  }

  function historyStateWith(patch) {
    var current = window.history.state;
    var base = current && typeof current === 'object' ? current : {};
    return Object.assign({}, base, patch || {});
  }

  function createBrowseEntryId() {
    return String(Date.now().toString(36)) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function browseEntryState(entryId) {
    var value = {};
    value[BROWSE_ENTRY_STATE_KEY] = entryId;
    return value;
  }

  function browseEntryIdFromHistoryState(historyState) {
    if (!historyState || typeof historyState !== 'object') return '';
    var value = historyState[BROWSE_ENTRY_STATE_KEY];
    return typeof value === 'string' ? value : '';
  }

  function readScrollPositionStore(storageKey) {
    var positions = {order: [], offsets: {}};
    try {
      var parsed = JSON.parse(window.sessionStorage.getItem(storageKey) || 'null');
      if (parsed && Array.isArray(parsed.order) && parsed.offsets && typeof parsed.offsets === 'object') {
        positions = {order: parsed.order.slice(), offsets: Object.assign({}, parsed.offsets)};
      }
    } catch (_error) {
      // Storage may be unavailable or corrupt; fall back to in-memory only.
    }
    return positions;
  }

  function writeScrollPositionStore(storageKey, positions, key, value) {
    positions.order = positions.order.filter(function (id) { return id !== key; });
    positions.order.push(key);
    positions.offsets[key] = value;
    while (positions.order.length > BROWSE_SCROLL_STORAGE_LIMIT) {
      delete positions.offsets[positions.order.shift()];
    }
    try {
      window.sessionStorage.setItem(storageKey, JSON.stringify(positions));
    } catch (_error) {
      // Best effort; the in-memory copy still serves this document.
    }
  }

  function loadBrowseScrollPositions() {
    if (!browseScrollPositions) browseScrollPositions = readScrollPositionStore(BROWSE_SCROLL_STORAGE_KEY);
    return browseScrollPositions;
  }

  function loadBrowsePathScrollPositions() {
    if (!browsePathScrollPositions) browsePathScrollPositions = readScrollPositionStore(BROWSE_PATH_SCROLL_STORAGE_KEY);
    return browsePathScrollPositions;
  }

  function validScrollOffset(value) {
    var number = Number(value);
    return value !== undefined && value !== null && isFinite(number) && number >= 0 ? number : null;
  }

  function savedBrowseScrollTop(entryId) {
    if (!entryId) return null;
    return validScrollOffset(loadBrowseScrollPositions().offsets[entryId]);
  }

  // Keyed by the normalized folder path ('' is the Dropbox root).
  function savedBrowsePathScrollTop(path) {
    if (typeof path !== 'string') return null;
    var offsets = loadBrowsePathScrollPositions().offsets;
    if (!Object.prototype.hasOwnProperty.call(offsets, path)) return null;
    return validScrollOffset(offsets[path]);
  }

  function rememberBrowseScrollPosition() {
    // While a listing is loading the table is collapsed to a loading row, so
    // the live offset no longer describes the current entry.
    if (!currentBrowseEntryId || state.loading) return;
    var offset = Math.round(readBrowseScrollTop());
    writeScrollPositionStore(BROWSE_SCROLL_STORAGE_KEY, loadBrowseScrollPositions(), currentBrowseEntryId, offset);
    writeScrollPositionStore(BROWSE_PATH_SCROLL_STORAGE_KEY, loadBrowsePathScrollPositions(), state.path || '', offset);
  }

  function pushBrowseHistoryEntry(href) {
    currentBrowseEntryId = createBrowseEntryId();
    window.history.pushState(browseEntryState(currentBrowseEntryId), '', href);
  }

  function replaceBrowseHistoryEntry(href) {
    window.history.replaceState(historyStateWith(browseEntryState(currentBrowseEntryId)), '', href);
  }

  function adoptBrowseHistoryEntry(historyState) {
    var entryId = browseEntryIdFromHistoryState(historyState);
    // An entry without its own record (new tab, typed URL, an entry pushed by
    // another script) falls back to the folder's last offset in this tab.
    var path = readBrowseLocation(window.location.search).path;
    if (!entryId) {
      entryId = createBrowseEntryId();
      currentBrowseEntryId = entryId;
      replaceBrowseHistoryEntry(window.location.href);
      return {entryId: entryId, restoreScrollTop: savedBrowsePathScrollTop(path)};
    }
    currentBrowseEntryId = entryId;
    var entryScrollTop = savedBrowseScrollTop(entryId);
    return {
      entryId: entryId,
      restoreScrollTop: entryScrollTop !== null ? entryScrollTop : savedBrowsePathScrollTop(path),
    };
  }

  function restoreBrowseScrollTop(value) {
    setBrowseScrollTop(value);
    // Re-window virtual rows for the restored offset right away instead of
    // waiting for the async scroll event.
    renderAndRefresh({force: false});
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

  // Nested with updateScrollPreview so afterRender cannot ReferenceError.
  function createBrowseVirtualRecycler(mount) {
    var topSpacer = document.createElement('tr');
    var bottomSpacer = document.createElement('tr');
    [topSpacer, bottomSpacer].forEach(function (spacer) {
      var cell = document.createElement('td');
      spacer.className = 'browse-virtual-spacer';
      spacer.setAttribute('aria-hidden', 'true');
      cell.colSpan = 7;
      spacer.appendChild(cell);
      mount.appendChild(spacer);
    });
    virtualState.topSpacer = topSpacer;
    virtualState.bottomSpacer = bottomSpacer;
    return createVirtualRowRecycler({
      viewport: mount,
      rowCount: 0,
      rowHeight: virtualState.rowHeight,
      overscan: virtualState.overscan,
      threshold: virtualState.threshold,
      getViewport: function () { return readTableViewport(mount, virtualState.rowHeight); },
      createRow: createBrowseRow,
      mountRow: function (row) { insertBeforeChild(mount, row, bottomSpacer); },
      updateRow: updateBrowseRow,
      measureRowHeight: function (row) {
        if (!row || typeof row.getBoundingClientRect !== 'function') return 0;
        return Number(row.getBoundingClientRect().height) || 0;
      },
      renderWindow: function (windowState, _mountedCount, _pool, recyclerState) {
        virtualState.rowHeight = recyclerState.rowHeight;
        virtualState.rowHeightMeasured = recyclerState.rowHeightMeasured;
        virtualState.windowKey = recyclerState.windowKey;
        setBrowseSpacerHeight(topSpacer, windowState.topSpacerHeight);
        setBrowseSpacerHeight(bottomSpacer, windowState.bottomSpacerHeight);
        setVirtualizationDataset(document.body, virtualState, windowState, _mountedCount);
      },
      afterRender: function (windowState, mountedCount, _pool, recyclerState) {
        virtualState.rowHeight = recyclerState.rowHeight;
        virtualState.rowHeightMeasured = recyclerState.rowHeightMeasured;
        virtualState.windowKey = recyclerState.windowKey;
        setBrowseSpacerHeight(topSpacer, windowState.topSpacerHeight);
        setBrowseSpacerHeight(bottomSpacer, windowState.bottomSpacerHeight);
        setVirtualizationDataset(document.body, virtualState, windowState, mountedCount);
        thumbnailLoader.refresh();
        if (body.dataset.browseScrollPreview === 'visible') {
          updateScrollPreview({persistent: previewScrollbarDragActive});
        }
      },
    });
  }

  virtualState.createRecycler = createBrowseVirtualRecycler;

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
    replaceBrowseHistoryEntry(currentBrowsePageHref(state));
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
      rememberBrowseScrollPosition();
      pushBrowseHistoryEntry(href);
    } else if (historyMode === 'replace') {
      replaceBrowseHistoryEntry(href);
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
    destroyBrowseVirtualRecycler(virtualState);
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
    var nextSortState = persistedBrowseSortState(nextState.path);
    var normalized = {
      path: nextState.path,
      reveal: nextState.reveal || '',
      sort: nextSortState.key,
      dir: nextSortState.direction,
      refresh: !!nextState.refresh,
      filters: normalizeBrowseFilters(nextState.filters || state.filters),
    };
    var historyMode = options && options.history ? options.history : 'none';
    var scrollToTop = !options || options.scroll !== false;
    var restoreScrollTop = options && typeof options.restoreScrollTop === 'number' ? options.restoreScrollTop : null;
    // In-place refresh (after a sync, cache refresh or banner Refresh): keep
    // the current rows on screen while the listing is re-fetched, then
    // re-render them at the same scroll offset. Nothing outside the table is
    // rebuilt, so the bottom panel and its media players are untouched.
    var inPlace = !!(options && options.inPlace);
    var revealPath = inPlace && options && typeof options.revealPath === 'string' ? options.revealPath : '';
    var preservedScrollTop = inPlace ? readBrowseScrollTop() : null;
    var scrollAnchor = null;
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
    if (normalized.path !== previousPath) hideListingWarning();
    if (inPlace) {
      // Supersede any in-flight load, but keep folder-info polling for the
      // rows still shown until the new listing arrives.
      if (currentController) {
        currentController.abort();
        currentController = null;
      }
      body.dataset.browseInPlaceRefresh = 'running';
    } else {
      stopActiveWork();
      renderLoading(normalized);
    }
    currentController = typeof AbortController === 'function' ? new AbortController() : null;
    var listingPromise = fetch(
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
        if (inPlace) {
          stopFolderPolling();
          stopFolderPolling = function () {};
          // Measured right before the re-render so scrolling during the fetch
          // counts.
          preservedScrollTop = readBrowseScrollTop();
          scrollAnchor = captureBrowseScrollAnchor(revealPath);
        }
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
        }, {keepMeasurement: inPlace});
        body.dataset.browseClient = 'ready';
        notifyBrowseFolderChanged(previousPath, state.path);
        if (inPlace) {
          restoreBrowseScrollTop(preservedScrollTop);
          restoreBrowseScrollAnchor(scrollAnchor);
          if (revealPath) keepBrowseRowVisible(revealPath);
          body.dataset.browseInPlaceRefresh = 'done';
          body.dataset.browseInPlaceRefreshCount = String((Number(body.dataset.browseInPlaceRefreshCount) || 0) + 1);
        } else if (state.reveal) scheduleRevealAttempt();
        else if (restoreScrollTop !== null) restoreBrowseScrollTop(restoreScrollTop);
        else if (scrollToTop) scrollPageToTop();
        var href = currentBrowsePageHref(state);
        if (historyMode === 'push') {
          pushBrowseHistoryEntry(href);
        } else if (historyMode === 'replace') {
          replaceBrowseHistoryEntry(href);
        }
        return true;
      })
      .catch(function (error) {
        if (error && error.name === 'AbortError') return false;
        if (version !== requestVersion) return false;
        currentController = null;
        if (inPlace) {
          // Keep the rows already on screen and say they may be stale.
          showListingRefreshFailedWarning(error && error.message ? error.message : '');
          body.dataset.browseInPlaceRefresh = 'error';
          return false;
        }
        setBrowseError(state, error && error.message ? error.message : 'Could not load folder listing.');
        destroyBrowseVirtualRecycler(virtualState);
        mount.innerHTML = errorRowHtml(state.error);
        thumbnailLoader.refresh();
        horizontalScrollbar.refresh();
        body.dataset.browseClient = 'error';
        setVirtualizationDataset(body, virtualState, null, 0);
        hideScrollPreview();
        return false;
      });
    currentListingPromise = listingPromise;
    return listingPromise;
  }

  window.DropboxBrowseClient = {
    isActive: function () {
      return !!(body && body.dataset.clientRender === '1');
    },
    getCurrentListing: function () {
      return {
        path: state.path,
        rows: Array.isArray(state.rows) ? state.rows.slice() : [],
        loading: !!state.loading,
        error: state.error || null,
      };
    },
    getCurrentListingPromise: function () {
      return currentListingPromise;
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
    // Re-fetch the current folder and update its rows without a page reload
    // and without clearing the table: scroll position, filters, sort, column
    // widths and everything outside the table stay as they are.
    //   expectedPath: only refresh if the browser still shows this folder
    //                 (resolves false when the user navigated elsewhere).
    //   revealPath:   keep this row visible after the re-render.
    //   refresh:      true to bypass the server listing cache (?refresh=1).
    // Resolves true on success; false when skipped or when the listing could
    // not be loaded (the old rows stay and a warning banner is shown).
    refreshCurrentFolderInPlace: function (options) {
      var settings = options || {};
      if (typeof settings.expectedPath === 'string' && settings.expectedPath !== state.path) {
        return Promise.resolve(false);
      }
      // A folder navigation (click, Back/Forward) is still loading: never
      // supersede it. Aborting it would drop its history push (the URL would
      // keep the old folder and Back would skip it, losing its saved scroll
      // offset). The navigation fetches a fresh listing anyway, so its result
      // stands in for this refresh.
      if (state.loading && currentListingPromise) {
        return Promise.resolve(currentListingPromise).then(function (loaded) { return !!loaded; });
      }
      return loadBrowseState({
        path: state.path,
        filters: state.filters,
        refresh: settings.refresh === true,
      }, {
        history: 'none',
        inPlace: true,
        revealPath: typeof settings.revealPath === 'string' ? settings.revealPath : '',
      });
    },
  };

  // The row the user is looking at (the synced row when given, else the
  // first row at the top of the viewport) and its offset from the top of the
  // scroll viewport, so a re-render can put it back at the same place even if
  // rows above it were added or removed.
  function captureBrowseScrollAnchor(preferredPath) {
    if (!pageScrollEl || typeof mount.querySelectorAll !== 'function') return null;
    var viewTop = pageScrollEl.getBoundingClientRect().top;
    var viewBottom = viewTop + pageScrollEl.clientHeight;
    var preferred = preferredPath ? findMountedRowByPath(preferredPath) : null;
    if (preferred) {
      var preferredRect = preferred.getBoundingClientRect();
      if (preferredRect.bottom > viewTop && preferredRect.top < viewBottom) {
        return {path: preferredPath, offset: preferredRect.top - viewTop};
      }
    }
    var rows = mount.querySelectorAll('tr[data-row-path]');
    for (var index = 0; index < rows.length; index += 1) {
      var rect = rows[index].getBoundingClientRect();
      if (rect.bottom > viewTop && rect.top < viewBottom) {
        return {path: rows[index].getAttribute('data-row-path'), offset: rect.top - viewTop};
      }
    }
    return null;
  }

  function restoreBrowseScrollAnchor(anchor) {
    if (!anchor || !pageScrollEl) return;
    var row = findMountedRowByPath(anchor.path);
    if (!row) return;
    var delta = (row.getBoundingClientRect().top - pageScrollEl.getBoundingClientRect().top) - anchor.offset;
    if (Math.abs(delta) < 1) return;
    setBrowseScrollTop(readBrowseScrollTop() + delta);
    renderAndRefresh({force: false});
  }

  function keepBrowseRowVisible(relPath) {
    var mountedRow = findMountedRowByPath(relPath);
    if (mountedRow && typeof mountedRow.scrollIntoView === 'function') {
      // 'nearest' does nothing when the row is already fully visible.
      mountedRow.scrollIntoView({block: 'nearest'});
      return;
    }
    if (!virtualState.enabled) return;
    var rows = getSortedFilteredRows(state);
    var rowIndex = rows.findIndex(function (row) {
      return row && row.path === relPath;
    });
    if (rowIndex < 0) return;
    scrollVirtualRowIntoViewport(rowIndex);
    renderAndRefresh({force: false});
  }

  function scheduleViewportRender() {
    if (state.loading || !virtualState.enabled) return;
    if (virtualState.recycler) {
      virtualState.recycler.schedule(false);
      if (body.dataset.browseScrollPreview === 'visible') {
        window.requestAnimationFrame(function () {
          if (!state.loading && virtualState.enabled && body.dataset.browseScrollPreview === 'visible') {
            updateScrollPreview({persistent: previewScrollbarDragActive});
          }
        });
      }
      return;
    }
    if (scrollFrameRequested) return;
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
    if (historyMode === 'push') rememberBrowseScrollPosition();
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
    rememberBrowseScrollPosition();
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
    var resetColumnsButton = event.target && event.target.closest ? event.target.closest('#browse-column-reset') : null;
    if (resetColumnsButton) {
      event.preventDefault();
      if (browseColumns && typeof browseColumns.reset === 'function') browseColumns.reset();
      return;
    }
    var sortLink = event.target && event.target.closest ? event.target.closest('thead a[data-browse-sort]') : null;
    if (sortLink) {
      if (state.loading) return;
      event.preventDefault();
      rememberBrowseScrollPosition();
      var clickedSort = sortLink.getAttribute('data-browse-sort') || 'name';
      var nextSortState = nextBrowseSortState(state.sort, state.dir, clickedSort);
      state.sort = nextSortState.sort;
      state.dir = nextSortState.dir;
      persistBrowseSortState(state.path, state.sort, state.dir);
      renderAndRefresh({force: true});
      pushBrowseHistoryEntry(currentBrowsePageHref(state));
      return;
    }

    var link = event.target && event.target.closest ? event.target.closest('a') : null;
    if (!link || state.loading) return;
    if (isModifiedClick(event) || !shouldInterceptBrowseLink(link)) return;
    var nextState = readBrowseHref(link.href || link.getAttribute('href') || '');
    if (!nextState) return;
    event.preventDefault();
    rememberBrowseScrollPosition();
    // A folder visited before in this tab comes back at its last offset
    // (reveal targets still take precedence in loadBrowseState); a folder
    // never visited starts at the top.
    var pathScrollTop = savedBrowsePathScrollTop(nextState.path);
    loadBrowseState(nextState, pathScrollTop !== null
      ? {history: 'push', scroll: true, restoreScrollTop: pathScrollTop}
      : {history: 'push', scroll: true});
  });

  window.addEventListener('popstate', function (event) {
    // history.state already describes the destination entry, but the DOM
    // (and its scroll offset) still belongs to the entry being left.
    rememberBrowseScrollPosition();
    var entry = adoptBrowseHistoryEntry(event.state);
    loadBrowseState(readBrowseLocation(window.location.search), {
      history: 'none',
      scroll: true,
      restoreScrollTop: entry.restoreScrollTop,
    });
  });
  window.addEventListener('pagehide', rememberBrowseScrollPosition);
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

  if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual';
  // Reload or a cross-document Back into this entry keeps history.state.
  var initialBrowseEntry = adoptBrowseHistoryEntry(window.history.state);
  loadBrowseState(state, {
    history: 'replace',
    scroll: false,
    restoreScrollTop: initialBrowseEntry.restoreScrollTop,
  });
  if (typeof window.Event === 'function' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new window.Event('dropbox-browser-browse-client-ready'));
  }
}

initBrowse();
