import {buildFileSearchEndpoint} from './file-search-api.js';
import {filenameCompareKey} from './filename-compare-key.js';
import {
  DEFAULT_VIRTUAL_OVERSCAN,
  DEFAULT_VIRTUAL_ROW_HEIGHT,
  DEFAULT_VIRTUAL_THRESHOLD,
  computeVirtualWindow,
  shouldVirtualizeRows,
} from './browse/virtual-list.js';

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatFolderPath(path) {
  return path || 'Dropbox';
}

export function resultCountText(count) {
  var safeCount = Math.max(0, Number(count) || 0);
  return safeCount + ' result' + (safeCount === 1 ? '' : 's');
}

export function normalizeFileSearchText(value) {
  return filenameCompareKey(String(value || ''))
    .replace(/[_./\\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenizeFileSearchQuery(value) {
  var normalized = normalizeFileSearchText(value);
  return normalized ? normalized.split(' ') : [];
}

function fileExtension(row) {
  var name = String((row && (row.display_name || row.path || '')) || '');
  var index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index + 1).toLowerCase() : '';
}

export function classifyFileSearchTypeGroup(row) {
  var ext = fileExtension(row);
  var typeLabel = filenameCompareKey(row && row.type_label ? row.type_label : '');
  if (row && row.kind === 'folder') return 'other';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'avif', 'svg'].indexOf(ext) >= 0) return 'images';
  if (['mp3', 'm4a', 'flac', 'wav', 'ogg', 'aac', 'wma', 'mid', 'midi'].indexOf(ext) >= 0 || typeLabel === 'audio') return 'audio';
  if (['mp4', 'm4v', 'mkv', 'mov', 'avi', 'webm', 'mpeg', 'mpg', 'wmv'].indexOf(ext) >= 0 || typeLabel === 'video') return 'video';
  if (['pdf', 'doc', 'docx', 'odt', 'rtf', 'txt', 'text', 'md', 'markdown', 'csv', 'tsv', 'xls', 'xlsx', 'ods', 'odp', 'ppt', 'pptx'].indexOf(ext) >= 0 ||
      ['pdf', 'word', 'document', 'table', 'markdown'].indexOf(typeLabel) >= 0) return 'documents';
  if (['zip', '7z', 'rar', 'tar', 'gz', 'bz2', 'tgz', 'xz'].indexOf(ext) >= 0 || typeLabel === 'zip') return 'archives';
  if (['py', 'js', 'mjs', 'cjs', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'xml', 'html', 'htm', 'css', 'sh', 'ps1', 'psm1', 'psd1', 'bat', 'cmd', 'sql', 'ini', 'cfg', 'conf', 'env'].indexOf(ext) >= 0 ||
      ['python', 'javascript', 'json', 'xml', 'html', 'css', 'powershell', 'editorconfig', 'console', 'database'].indexOf(typeLabel) >= 0) return 'code';
  return 'other';
}

function padDatePart(value) {
  return String(value).padStart(2, '0');
}

function formatDateInputValue(date) {
  return date.getFullYear() + '-' + padDatePart(date.getMonth() + 1) + '-' + padDatePart(date.getDate());
}

function localDateStart(value) {
  if (!value) return null;
  var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0, 0).getTime();
}

function localDateEnd(value) {
  if (!value) return null;
  var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59, 999).getTime();
}

export function resolveFileSearchDateRange(criteria, now) {
  var current = now instanceof Date ? now : new Date();
  var preset = criteria && criteria.datePreset ? criteria.datePreset : 'any';
  if (preset === 'this-year') {
    return {
      dateFrom: current.getFullYear() + '-01-01',
      dateTo: current.getFullYear() + '-12-31',
    };
  }
  if (preset === 'last-year') {
    var year = current.getFullYear() - 1;
    return {
      dateFrom: year + '-01-01',
      dateTo: year + '-12-31',
    };
  }
  if (preset === 'last-30-days') {
    var start = new Date(current.getFullYear(), current.getMonth(), current.getDate());
    start.setDate(start.getDate() - 29);
    return {
      dateFrom: formatDateInputValue(start),
      dateTo: formatDateInputValue(current),
    };
  }
  if (preset === 'custom') {
    return {
      dateFrom: criteria && criteria.dateFrom ? criteria.dateFrom : '',
      dateTo: criteria && criteria.dateTo ? criteria.dateTo : '',
    };
  }
  return {dateFrom: '', dateTo: ''};
}

export function hasActiveFileSearchCriteria(criteria) {
  var current = criteria || {};
  if (tokenizeFileSearchQuery(current.query || '').length > 0) return true;
  if ((current.typeGroup || 'all') !== 'all') return true;
  if ((current.datePreset || 'any') !== 'any') return true;
  return false;
}

function rowSearchHaystack(row) {
  var relativePath = row && row.relative_path ? row.relative_path : row && row.path ? row.path : '';
  var extension = fileExtension(row);
  return normalizeFileSearchText([
    row && row.display_name ? row.display_name : '',
    relativePath,
    extension,
  ].join(' '));
}

function matchesFileSearchQuery(row, criteria) {
  var tokens = tokenizeFileSearchQuery(criteria && criteria.query ? criteria.query : '');
  if (tokens.length === 0) return true;
  var haystack = rowSearchHaystack(row);
  return tokens.every(function (token) {
    return haystack.indexOf(token) >= 0;
  });
}

function matchesFileSearchType(row, criteria) {
  var typeGroup = criteria && criteria.typeGroup ? criteria.typeGroup : 'all';
  if (typeGroup === 'all') return true;
  return classifyFileSearchTypeGroup(row) === typeGroup;
}

function matchesFileSearchDate(row, criteria) {
  var range = resolveFileSearchDateRange(criteria, new Date());
  if (!range.dateFrom && !range.dateTo) return true;
  var sortDateSeconds = Number(row && row.sort_date);
  if (!Number.isFinite(sortDateSeconds) || sortDateSeconds <= 0) return false;
  var valueMs = sortDateSeconds * 1000;
  var fromMs = localDateStart(range.dateFrom);
  var toMs = localDateEnd(range.dateTo);
  if (fromMs !== null && valueMs < fromMs) return false;
  if (toMs !== null && valueMs > toMs) return false;
  return true;
}

export function filterFileSearchResults(results, criteria) {
  var rows = Array.isArray(results) ? results : [];
  return rows.filter(function (row) {
    return matchesFileSearchQuery(row, criteria) &&
      matchesFileSearchType(row, criteria) &&
      matchesFileSearchDate(row, criteria);
  });
}

export function shouldPollFileSearchStatus(status) {
  var snapshot = status || {};
  if (snapshot.search_pending || snapshot.search_scan_complete === false || snapshot.has_more_results) return true;
  if (snapshot.complete) return false;
  if (snapshot.pending) return true;
  return Number(snapshot.missing_listing_count) > 0;
}

export function fileSearchPendingStatusMessage(status) {
  var snapshot = status || {};
  if (snapshot.search_pending || snapshot.search_scan_complete === false) {
    var scanned = Number(snapshot.scanned_folder_count) || 0;
    return scanned > 0 ? 'Search scan is still running (' + scanned + ' folders scanned).' : 'Search scan is starting...';
  }
  if (snapshot.has_more_results) return 'More search results are available.';
  var parts = [];
  var pendingFolders = Number(snapshot.pending_folder_count) || 0;
  var queuedFolders = Number(snapshot.queued_folder_count) || 0;
  var missingListings = Number(snapshot.missing_listing_count) || 0;
  if (pendingFolders > 0) parts.push(String(pendingFolders) + ' pending folders');
  if (queuedFolders > 0) parts.push(String(queuedFolders) + ' queued folders');
  if (missingListings > 0) parts.push(String(missingListings) + ' uncached listings');
  if (parts.length === 0) return 'Search is still waiting for cached folder metadata to finish.';
  return 'Search is still waiting for cached folder metadata: ' + parts.join(', ') + '.';
}

function primaryHrefForRow(row) {
  if (row.kind === 'folder') return row.folder_href || '/?path=' + encodeURIComponent(row.path || '');
  return row.preview_href || row.download_href || '#';
}

export function parentFolderPathForRow(row) {
  var fullPath = String((row && row.path) || '');
  if (!fullPath) return '';
  var index = fullPath.lastIndexOf('/');
  return index >= 0 ? fullPath.slice(0, index) : '';
}

export function containingFolderHrefForRow(row) {
  var parentPath = parentFolderPathForRow(row);
  return parentPath ? '/?path=' + encodeURIComponent(parentPath) : '/';
}

export function dropboxHomeHrefForRow(row) {
  var path = String((row && row.path) || '');
  var encoded = path
    .split('/')
    .map(function (segment) { return encodeURIComponent(segment); })
    .join('/');
  return 'https://www.dropbox.com/home' + (encoded ? '/' + encoded : '');
}

function appendRevealParam(href, revealPath) {
  if (!revealPath) return href;
  return href + (href.indexOf('?') >= 0 ? '&' : '?') + 'reveal=' + encodeURIComponent(revealPath);
}

export function defaultBrowseHrefForRow(row) {
  if (row && row.kind === 'folder') return primaryHrefForRow(row);
  return appendRevealParam(containingFolderHrefForRow(row), row && row.path ? row.path : '');
}

function renderFileSearchResult(row) {
  var actions = [];
  if (row.kind === 'folder') {
    actions.push('<a href="' + esc(primaryHrefForRow(row)) + '">Open</a>');
  } else {
    if (row.preview_href) actions.push('<a href="' + esc(row.preview_href) + '">Preview</a>');
    if (row.download_href) actions.push('<a href="' + esc(row.download_href) + '">Download</a>');
  }
  if (row.path) {
    actions.push('<a href="' + esc(containingFolderHrefForRow(row)) + '">Show Folder</a>');
    actions.push('<a href="' + esc(dropboxHomeHrefForRow(row)) + '" target="_blank" rel="noopener noreferrer">Go to Dropbox</a>');
  }
  if (row.local_copy_path) {
    actions.push(
      '<button type="button" class="copy-path" data-copy-path="' + esc(row.local_copy_path) + '">' +
      (row.kind === 'folder' ? 'Copy Folder Path' : 'Copy Filepath') +
      '</button>'
    );
  }
  return (
    '<div class="file-search-result" data-kind="' + esc(row.kind || '') + '" data-file-search-result-id="' + esc(row.path || row.display_name || '') + '">' +
    '<a class="file-search-result-name" href="' + esc(defaultBrowseHrefForRow(row)) + '" title="' + esc(row.display_name || '') + '">' +
    '<span class="file-search-result-icon-slot">' +
    '<img class="file-search-result-icon" src="' + esc(row.icon_href || '') + '" alt="" aria-hidden="true" loading="lazy">' +
    '</span>' +
    '<span class="file-search-result-name-text">' + esc(row.display_name || '') + '</span>' +
    '</a>' +
    '<div class="file-search-result-meta">' +
    '<span class="file-search-result-path">' + esc(row.relative_path || row.path || '') + '</span>' +
    '<span class="file-search-result-type">' + esc(row.type_label || '') + '</span>' +
    '<span class="file-search-result-status status ' + esc(row.status_class || '') + '">' + esc(row.status_label || '') + '</span>' +
    '<span class="file-search-result-size">' + esc(row.size_display || '') + '</span>' +
    '<span class="file-search-result-date">' + esc(row.date_display || '') + '</span>' +
    '</div>' +
    '<div class="file-search-result-actions">' + actions.join(' ') + '</div>' +
    '</div>'
  );
}

export function renderFileSearchResults(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return (
      '<div id="file-search-empty" class="file-search-empty">' +
      'No cached search results to show.' +
      '</div>'
    );
  }
  return results.map(renderFileSearchResult).join('');
}

function renderFileSearchSpacer(height) {
  if (!height) return '';
  return '<div class="file-search-virtual-spacer" aria-hidden="true" style="height:' + esc(height) + 'px"></div>';
}

export function renderVirtualFileSearchResults(results, windowState) {
  if (!Array.isArray(results) || results.length === 0) {
    return renderFileSearchResults(results);
  }
  var startIndex = Math.max(0, Number(windowState && windowState.startIndex) || 0);
  var endIndex = Math.min(results.length, Number(windowState && windowState.endIndex) || results.length);
  var slice = results.slice(startIndex, endIndex);
  return renderFileSearchSpacer(windowState && windowState.topSpacerHeight) +
    slice.map(renderFileSearchResult).join('') +
    renderFileSearchSpacer(windowState && windowState.bottomSpacerHeight);
}

function readFileSearchViewport(container, rowHeight) {
  return {
    scrollTop: Math.max(0, Number(container && container.scrollTop) || 0),
    viewportHeight: Math.max(rowHeight, Number(container && container.clientHeight) || rowHeight),
  };
}

function measureMountedFileSearchRowHeight(container, fallbackHeight) {
  if (!container || typeof container.querySelector !== 'function') {
    return fallbackHeight || DEFAULT_VIRTUAL_ROW_HEIGHT;
  }
  var row = container.querySelector('.file-search-result[data-file-search-result-id]');
  if (!row || typeof row.getBoundingClientRect !== 'function') {
    return fallbackHeight || DEFAULT_VIRTUAL_ROW_HEIGHT;
  }
  var height = row.getBoundingClientRect().height;
  return height > 0 ? height : (fallbackHeight || DEFAULT_VIRTUAL_ROW_HEIGHT);
}

export function initFileSearch(options) {
  var doc = options.document;
  var win = options.window;
  var fetchImpl = options.fetchImpl;
  var pollDelayMs = Math.max(0, Number(options.pollDelayMs) || 250);
  var queryDebounceMs = Math.max(0, Number(options.queryDebounceMs) || 250);
  var pane = doc.getElementById('file-search-pane');
  var rootPathEl = doc.getElementById('file-search-root-path');
  var statusEl = doc.getElementById('file-search-status');
  var resultCountEl = doc.getElementById('file-search-result-count');
  var queryEl = doc.getElementById('file-search-query');
  var typeEl = doc.getElementById('file-search-type');
  var presetEl = doc.getElementById('file-search-date-preset');
  var dateFromEl = doc.getElementById('file-search-date-from');
  var dateToEl = doc.getElementById('file-search-date-to');
  var submitButton = doc.getElementById('file-search-submit');
  var resetButton = doc.getElementById('file-search-reset');
  var resultsEl = doc.getElementById('file-search-results');

  if (!pane || !rootPathEl || !statusEl || !resultCountEl || !queryEl || !typeEl || !presetEl || !dateFromEl || !dateToEl || !submitButton || !resetButton || !resultsEl) return null;

  function logFileSearchDebug(message, extra) {
    if (!win.ClientLogger) return;
    win.ClientLogger.debug('file-search', message, extra || {});
  }

  var requestVersion = 0;
  var currentController = null;
  var pollTimer = null;
  var queryTimer = null;
  var scrollFrameRequested = false;
  var state = {
    rawResults: [],
    status: {},
    snapshotLoaded: false,
    snapshotQuery: '',
    searchRootPath: '',
    sessionId: '',
    batchLimit: 25,
    searchActive: false,
    filteredResults: [],
    criteria: {
      query: '',
      typeGroup: 'all',
      datePreset: 'any',
      dateFrom: '',
      dateTo: '',
    },
    virtual: {
      rowHeight: DEFAULT_VIRTUAL_ROW_HEIGHT,
      rowHeightMeasured: false,
      overscan: DEFAULT_VIRTUAL_OVERSCAN,
      threshold: DEFAULT_VIRTUAL_THRESHOLD,
      enabled: false,
      windowKey: '',
    },
  };

  function currentFolderPath() {
    var body = doc.body;
    if (!body || !body.dataset) return '';
    return typeof body.dataset.currentFolderPath === 'string' ? body.dataset.currentFolderPath : '';
  }

  function displayedRootPath() {
    return state.searchRootPath || currentFolderPath();
  }

  function paneMode() {
    var modeSelect = doc.getElementById('bottom-pane-mode');
    return modeSelect ? String(modeSelect.value || '') : '';
  }

  function isActive() {
    return paneMode() === 'file-search' && !pane.hidden;
  }

  function stopQueryTimer() {
    if (queryTimer !== null) {
      win.clearTimeout(queryTimer);
      queryTimer = null;
    }
  }

  function stopPolling() {
    if (pollTimer !== null) {
      win.clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function updateSearchButton() {
    submitButton.textContent = state.searchActive ? 'Stop Search' : 'Search';
    submitButton.setAttribute('data-search-state', state.searchActive ? 'active' : 'idle');
  }

  function invalidateRequests() {
    requestVersion += 1;
  }

  function resetSnapshot() {
    state.rawResults = [];
    state.status = {};
    state.snapshotLoaded = false;
    state.snapshotQuery = '';
    state.sessionId = '';
    state.filteredResults = [];
    state.virtual.rowHeight = DEFAULT_VIRTUAL_ROW_HEIGHT;
    state.virtual.rowHeightMeasured = false;
    state.virtual.enabled = false;
    state.virtual.windowKey = '';
  }

  function stopSearchRun() {
    var sessionId = state.sessionId;
    var shouldCancelSession = !!(sessionId && state.searchActive && shouldPollFileSearchStatus(state.status));
    state.searchActive = false;
    stopPolling();
    if (shouldCancelSession) {
      state.sessionId = '';
      try {
        Promise.resolve(fetchImpl(buildFileSearchEndpoint({
          path: state.searchRootPath,
          recursive: true,
          sessionId: sessionId,
          cancel: true,
          limit: state.batchLimit,
        }))).catch(function () { return false; });
      } catch (_error) {
        // Cancellation is best-effort; the local request state is authoritative.
      }
    } else if (sessionId) {
      state.sessionId = '';
    }
    updateSearchButton();
  }

  function abortActiveRequest() {
    stopQueryTimer();
    stopPolling();
    if (currentController && typeof currentController.abort === 'function') {
      currentController.abort();
    }
    currentController = null;
  }

  function readCriteria() {
    return {
      query: String(queryEl.value || ''),
      typeGroup: String(typeEl.value || 'all'),
      datePreset: String(presetEl.value || 'any'),
      dateFrom: String(dateFromEl.value || ''),
      dateTo: String(dateToEl.value || ''),
    };
  }

  function applyCriteria() {
    state.criteria = readCriteria();
  }

  function syncDateInputsFromPreset() {
    var range = resolveFileSearchDateRange(readCriteria(), new Date());
    var isCustom = presetEl.value === 'custom';
    var isAny = presetEl.value === 'any';
    dateFromEl.disabled = !isCustom;
    dateToEl.disabled = !isCustom;
    if (isAny) {
      dateFromEl.value = '';
      dateToEl.value = '';
      return;
    }
    if (!isCustom) {
      dateFromEl.value = range.dateFrom;
      dateToEl.value = range.dateTo;
    }
  }

  function emptyHtml(message) {
    return (
      '<div id="file-search-empty" class="file-search-empty">' +
      esc(message) +
      '</div>'
    );
  }

  function showIdle() {
    rootPathEl.textContent = formatFolderPath(displayedRootPath());
    resultCountEl.textContent = resultCountText(0);
    if (!state.searchRootPath) {
      statusEl.textContent = 'Press Search to capture the current folder and search cached descendants.';
      resultsEl.innerHTML = emptyHtml('Press Search to capture the current folder and search cached descendants.');
    } else {
      statusEl.textContent = 'Press Search to run with the current filters.';
      resultsEl.innerHTML = emptyHtml('Press Search to run with the current filters.');
    }
    state.virtual.enabled = false;
    state.virtual.windowKey = 'idle';
    updateSearchButton();
  }

  function renderSnapshot() {
    var filtered;
    var status;
    var activeCriteria;
    activeCriteria = hasActiveFileSearchCriteria(state.criteria);
    if (!activeCriteria && !state.snapshotLoaded) {
      showIdle();
      return;
    }
    rootPathEl.textContent = formatFolderPath(displayedRootPath());
    if (!state.snapshotLoaded) {
      resultCountEl.textContent = 'Loading...';
      statusEl.textContent = state.searchActive ? 'Loading cached search results...' : 'Press Search to run with the current filters.';
      resultsEl.innerHTML = emptyHtml(state.searchActive ? 'Loading cached search results...' : 'Press Search to run with the current filters.');
      return;
    }
    filtered = filterFileSearchResults(state.rawResults, state.criteria);
    state.filteredResults = filtered;
    status = state.status || {};
    resultCountEl.textContent = resultCountText(filtered.length);
    if (state.searchActive && shouldPollFileSearchStatus(status)) {
      statusEl.textContent = fileSearchPendingStatusMessage(status);
    } else {
      statusEl.textContent = status.complete ? 'Search complete.' : (status.message || 'Search results loaded from cached metadata.');
    }
    if (filtered.length > 0) {
      renderVisibleResults(filtered, {force: true});
      return;
    }
    state.virtual.enabled = false;
    state.virtual.windowKey = 'empty';
    if (status.cache_status === 'unavailable') {
      resultsEl.innerHTML = emptyHtml(status.message || 'No cached data for this folder yet.');
      return;
    }
    if (status.complete) {
      resultsEl.innerHTML = emptyHtml('No matching files.');
      return;
    }
    resultsEl.innerHTML = emptyHtml('No matches yet. Cached folders are still indexing.');
  }

  function serverQueryForCriteria(criteria) {
    return String(criteria && criteria.query ? criteria.query : '').trim();
  }

  function renderVisibleResults(results, options) {
    var force = !!(options && options.force);
    if (!Array.isArray(results) || results.length === 0) {
      state.virtual.enabled = false;
      state.virtual.windowKey = 'empty';
      resultsEl.innerHTML = emptyHtml('No cached search results to show.');
      return;
    }
    if (!shouldVirtualizeRows(results.length, {threshold: state.virtual.threshold})) {
      state.virtual.enabled = false;
      state.virtual.windowKey = 'full:' + String(results.length);
      resultsEl.innerHTML = renderFileSearchResults(results);
      return;
    }
    var viewport = readFileSearchViewport(resultsEl, state.virtual.rowHeight);
    var windowState = computeVirtualWindow({
      rowCount: results.length,
      rowHeight: state.virtual.rowHeight,
      scrollTop: viewport.scrollTop,
      viewportHeight: viewport.viewportHeight,
      overscan: state.virtual.overscan,
    });
    var nextWindowKey = [
      results.length,
      state.virtual.rowHeight,
      windowState.startIndex,
      windowState.endIndex,
      windowState.topSpacerHeight,
      windowState.bottomSpacerHeight,
    ].join(':');
    if (force || state.virtual.windowKey !== nextWindowKey) {
      resultsEl.innerHTML = renderVirtualFileSearchResults(results, windowState);
      if (!state.virtual.rowHeightMeasured) {
        var measuredHeight = measureMountedFileSearchRowHeight(resultsEl, state.virtual.rowHeight);
        state.virtual.rowHeightMeasured = true;
        if (measuredHeight !== state.virtual.rowHeight) {
          state.virtual.rowHeight = measuredHeight;
          windowState = computeVirtualWindow({
            rowCount: results.length,
            rowHeight: state.virtual.rowHeight,
            scrollTop: viewport.scrollTop,
            viewportHeight: viewport.viewportHeight,
            overscan: state.virtual.overscan,
          });
          nextWindowKey = [
            results.length,
            state.virtual.rowHeight,
            windowState.startIndex,
            windowState.endIndex,
            windowState.topSpacerHeight,
            windowState.bottomSpacerHeight,
          ].join(':');
          resultsEl.innerHTML = renderVirtualFileSearchResults(results, windowState);
        }
      }
      state.virtual.windowKey = nextWindowKey;
    }
    state.virtual.enabled = true;
  }

  function scheduleVirtualRender() {
    if (scrollFrameRequested || !state.virtual.enabled) return;
    scrollFrameRequested = true;
    win.requestAnimationFrame(function () {
      scrollFrameRequested = false;
      renderVisibleResults(state.filteredResults, {force: false});
    });
  }

  function renderError(message) {
    stopSearchRun();
    resetSnapshot();
    resultCountEl.textContent = resultCountText(0);
    statusEl.textContent = message || 'Could not load cached search results.';
    resultsEl.innerHTML = emptyHtml(message || 'Could not load cached search results.');
  }

  function schedulePoll() {
    stopPolling();
    if (!isActive() || !state.searchActive) return;
    pollTimer = win.setTimeout(function () {
      pollTimer = null;
      loadSnapshot({isPolling: true});
    }, pollDelayMs);
  }

  function loadSnapshot() {
    var options = arguments[0] || {};
    var requestCriteria;
    var serverQuery;
    if (!isActive()) return Promise.resolve(false);
    applyCriteria();
    requestCriteria = state.criteria;
    serverQuery = serverQueryForCriteria(requestCriteria);
    rootPathEl.textContent = formatFolderPath(displayedRootPath());
    if (!hasActiveFileSearchCriteria(requestCriteria)) {
      stopSearchRun();
      abortActiveRequest();
      showIdle();
      return Promise.resolve(false);
    }
    var version = requestVersion + 1;
    requestVersion = version;
    abortActiveRequest();
    currentController = typeof AbortController === 'function' ? new AbortController() : null;
    if (!options.isPolling) {
      renderSnapshot();
    }
    logFileSearchDebug('fetch search snapshot', {
      path: state.searchRootPath,
      query: serverQuery,
      isPolling: !!options.isPolling,
      isActive: isActive(),
    });
    var endpointState = {
      path: state.searchRootPath,
      query: serverQuery,
      recursive: true,
      limit: state.batchLimit,
    };
    if (state.sessionId) endpointState.sessionId = state.sessionId;
    else endpointState.session = true;
    return fetchImpl(
      buildFileSearchEndpoint(endpointState),
      currentController ? {signal: currentController.signal} : undefined,
    )
      .then(function (response) {
        if (!response.ok) throw new Error('Could not load cached search results.');
        return response.json();
      })
      .then(function (payload) {
        if (version !== requestVersion) return false;
        if (!isActive()) return false;
        currentController = null;
        if (payload && payload.session_id) state.sessionId = String(payload.session_id);
        var incomingResults = Array.isArray(payload && payload.results) ? payload.results : [];
        var resultByKey = new Map();
        state.rawResults.forEach(function (row) {
          resultByKey.set(String((row && row.kind) || '') + ':' + String((row && (row.path || row.display_name)) || ''), row);
        });
        incomingResults.forEach(function (row) {
          var key = String((row && row.kind) || '') + ':' + String((row && (row.path || row.display_name)) || '');
          if (resultByKey.has(key)) {
            var index = state.rawResults.indexOf(resultByKey.get(key));
            if (index >= 0) state.rawResults[index] = row;
          } else {
            state.rawResults.push(row);
          }
          resultByKey.set(key, row);
        });
        state.status = payload && payload.status ? payload.status : {};
        state.snapshotLoaded = true;
        state.snapshotQuery = serverQuery;
        renderSnapshot();
        if (shouldPollFileSearchStatus(payload && payload.status)) {
          schedulePoll();
        } else {
          stopSearchRun();
        }
        return true;
      })
      .catch(function (error) {
        if (error && error.name === 'AbortError') return false;
        if (version !== requestVersion) return false;
        currentController = null;
        renderError(error && error.message ? error.message : 'Could not load cached search results.');
        return false;
      });
  }

  function focusQuerySoon() {
    win.requestAnimationFrame(function () {
      queryEl.focus();
      queryEl.select();
    });
  }

  function applyFiltersNow() {
    applyCriteria();
    if (!hasActiveFileSearchCriteria(state.criteria)) {
      invalidateRequests();
      stopSearchRun();
      abortActiveRequest();
      resetSnapshot();
      showIdle();
      return false;
    }
    if (state.searchActive || state.snapshotLoaded) {
      invalidateRequests();
      stopSearchRun();
      abortActiveRequest();
      resetSnapshot();
      rootPathEl.textContent = formatFolderPath(displayedRootPath());
      resultCountEl.textContent = resultCountText(0);
      statusEl.textContent = 'Press Search to run with the current filters.';
      resultsEl.innerHTML = emptyHtml('Press Search to run with the current filters.');
      updateSearchButton();
      return false;
    }
    showIdle();
    return false;
  }

  function startSearchRun() {
    applyCriteria();
    logFileSearchDebug('start search requested', {
      query: state.criteria.query,
      typeGroup: state.criteria.typeGroup,
      datePreset: state.criteria.datePreset,
      currentFolderPath: currentFolderPath(),
      isActive: isActive(),
    });
    if (!hasActiveFileSearchCriteria(state.criteria)) {
      resetSnapshot();
      showIdle();
      focusQuerySoon();
      return Promise.resolve(false);
    }
    invalidateRequests();
    abortActiveRequest();
    resetSnapshot();
    state.searchRootPath = currentFolderPath();
    state.searchActive = true;
    updateSearchButton();
    return loadSnapshot();
  }

  resetButton.addEventListener('click', function () {
    queryEl.value = '';
    typeEl.value = 'all';
    presetEl.value = 'any';
    dateFromEl.value = '';
    dateToEl.value = '';
    syncDateInputsFromPreset();
    invalidateRequests();
    stopSearchRun();
    abortActiveRequest();
    resetSnapshot();
    state.searchRootPath = '';
    showIdle();
    focusQuerySoon();
  });

  resultsEl.addEventListener('click', function (event) {
    var link = event.target && event.target.closest ? event.target.closest('.file-search-result-name') : null;
    if (!link) return;
    var row = event.target && event.target.closest ? event.target.closest('.file-search-result') : null;
    var href = link.getAttribute('href') || link.href || '';
    logFileSearchDebug('result link click', {
      kind: row ? (row.getAttribute('data-kind') || '') : '',
      rowId: row ? (row.getAttribute('data-file-search-result-id') || '') : '',
      href: href,
      hasReveal: href.indexOf('reveal=') >= 0,
      text: link.textContent || '',
    });
  });

  submitButton.addEventListener('click', function () {
    if (state.searchActive) {
      invalidateRequests();
      stopSearchRun();
      abortActiveRequest();
      renderSnapshot();
      return;
    }
    startSearchRun();
  });

  queryEl.addEventListener('keydown', function (event) {
    if (!event || event.key !== 'Enter') return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    if (typeof queryEl.blur === 'function') queryEl.blur();
    if (!state.searchActive) startSearchRun();
  });
  queryEl.addEventListener('input', applyFiltersNow);
  typeEl.addEventListener('change', applyFiltersNow);
  presetEl.addEventListener('change', function () {
    syncDateInputsFromPreset();
    applyFiltersNow();
  });
  dateFromEl.addEventListener('change', applyFiltersNow);
  dateToEl.addEventListener('change', applyFiltersNow);
  win.addEventListener('browse-folder-changed', function () {
    if (!state.searchRootPath) rootPathEl.textContent = formatFolderPath(currentFolderPath());
  });
  win.addEventListener('bottom-pane-mode-changed', function (ev) {
    if (!ev.detail || ev.detail.mode !== 'file-search') {
      invalidateRequests();
      abortActiveRequest();
      stopSearchRun();
      return;
    }
    rootPathEl.textContent = formatFolderPath(displayedRootPath());
    if (!state.snapshotLoaded) showIdle();
    focusQuerySoon();
  });
  resultsEl.addEventListener('scroll', scheduleVirtualRender, {passive: true});
  win.addEventListener('resize', scheduleVirtualRender);

  syncDateInputsFromPreset();
  rootPathEl.textContent = formatFolderPath(displayedRootPath());
  showIdle();

  return {
    loadResults: loadSnapshot,
    startSearch: startSearchRun,
    abort: abortActiveRequest,
    stopPolling: stopPolling,
    applyFilters: applyFiltersNow,
  };
}

if (typeof document !== 'undefined' && typeof window !== 'undefined' && typeof window.fetch === 'function') {
  initFileSearch({
    document: document,
    window: window,
    fetchImpl: window.fetch.bind(window),
  });
}
