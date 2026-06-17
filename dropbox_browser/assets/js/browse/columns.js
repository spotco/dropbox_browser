var STORAGE_KEY = 'browse-column-widths-v1';
var DEFAULT_COLUMN_MIN_WIDTH = 32;

export var BROWSE_COLUMN_KEYS = ['name', 'type', 'status', 'size', 'date', 'view', 'sync'];

export var BROWSE_COLUMN_MIN_WIDTHS = {
  name: 200,
  type: 72,
  status: 96,
  size: 88,
  date: 144,
  view: 60,
  sync: 100,
};

var BROWSE_COLUMN_DEFAULT_WEIGHTS = {
  name: 3.2,
  type: 1,
  status: 1.3,
  size: 1.1,
  date: 1.8,
  view: 0.8,
  sync: 1.4,
};

function normalizedColumnKeys(keys) {
  return Array.isArray(keys) && keys.length ? keys.slice() : BROWSE_COLUMN_KEYS.slice();
}

function minWidthsForConfig(columnMinWidths) {
  return columnMinWidths && typeof columnMinWidths === 'object'
    ? columnMinWidths
    : BROWSE_COLUMN_MIN_WIDTHS;
}

function readSetting(key, defaultValue) {
  if (!window.Settings || typeof window.Settings.get !== 'function') return defaultValue;
  return window.Settings.get(key, defaultValue);
}

function writeSetting(key, value) {
  if (!window.Settings || typeof window.Settings.set !== 'function') return;
  window.Settings.set(key, value);
}

export function clampColumnWidth(key, value, columnMinWidths) {
  var minWidth = minWidthsForConfig(columnMinWidths)[key] || DEFAULT_COLUMN_MIN_WIDTH;
  var parsed = Number(value);
  if (!isFinite(parsed)) return minWidth;
  return Math.max(minWidth, Math.round(parsed));
}

export function normalizeStoredColumnWidths(value, columnKeys, columnMinWidths) {
  var keys = normalizedColumnKeys(columnKeys);
  if (!value || typeof value !== 'object') return {};
  var normalized = {};
  keys.forEach(function (key) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return;
    var parsed = Number(value[key]);
    if (!isFinite(parsed) || parsed <= 0) return;
    normalized[key] = clampColumnWidth(key, parsed, columnMinWidths);
  });
  return normalized;
}

function minimumTotalWidth(keys, columnMinWidths) {
  var minWidths = minWidthsForConfig(columnMinWidths);
  return keys.reduce(function (sum, key) {
    return sum + (minWidths[key] || DEFAULT_COLUMN_MIN_WIDTH);
  }, 0);
}

function distributeExtraWidth(keys, extraWidth, columnMinWidths) {
  var minWidths = minWidthsForConfig(columnMinWidths);
  var widths = {};
  var normalizedExtra = Math.max(0, Math.round(Number(extraWidth) || 0));
  var totalWeight = keys.reduce(function (sum, key) {
    return sum + (BROWSE_COLUMN_DEFAULT_WEIGHTS[key] || 1);
  }, 0);
  var assigned = 0;
  keys.forEach(function (key, index) {
    var minWidth = minWidths[key] || DEFAULT_COLUMN_MIN_WIDTH;
    var weight = BROWSE_COLUMN_DEFAULT_WEIGHTS[key] || 1;
    var extra = index === keys.length - 1
      ? normalizedExtra - assigned
      : Math.round((weight / totalWeight) * normalizedExtra);
    widths[key] = minWidth + extra;
    assigned += extra;
  });
  return widths;
}

export function fitColumnWidthsToTotal(keys, widths, totalWidth, columnMinWidths) {
  var columnKeys = normalizedColumnKeys(keys);
  var total = Math.max(Math.round(Number(totalWidth) || 0), minimumTotalWidth(columnKeys, columnMinWidths));
  var normalizedInput = normalizeStoredColumnWidths(widths, columnKeys, columnMinWidths);
  var allPresent = columnKeys.every(function (key) {
    return typeof normalizedInput[key] === 'number';
  });
  if (!allPresent) {
    return distributeExtraWidth(columnKeys, total - minimumTotalWidth(columnKeys, columnMinWidths), columnMinWidths);
  }
  var rawTotal = columnKeys.reduce(function (sum, key) {
    return sum + normalizedInput[key];
  }, 0);
  if (rawTotal <= 0) {
    return distributeExtraWidth(columnKeys, total - minimumTotalWidth(columnKeys, columnMinWidths), columnMinWidths);
  }
  var scaled = {};
  var assigned = 0;
  columnKeys.forEach(function (key, index) {
    var target = index === columnKeys.length - 1
      ? total - assigned
      : Math.round((normalizedInput[key] / rawTotal) * total);
    scaled[key] = clampColumnWidth(key, target, columnMinWidths);
    assigned += scaled[key];
  });
  var delta = total - columnKeys.reduce(function (sum, key) {
    return sum + scaled[key];
  }, 0);
  if (delta !== 0) {
    var adjustableKeys = delta > 0 ? columnKeys.slice() : columnKeys.slice().reverse();
    adjustableKeys.some(function (key) {
      var minWidth = minWidthsForConfig(columnMinWidths)[key] || DEFAULT_COLUMN_MIN_WIDTH;
      if (delta < 0 && scaled[key] + delta < minWidth) {
        var reduction = scaled[key] - minWidth;
        if (reduction <= 0) return false;
        scaled[key] -= reduction;
        delta += reduction;
        return delta === 0;
      }
      scaled[key] += delta;
      delta = 0;
      return true;
    });
  }
  return scaled;
}

function availableShrink(width, key, columnMinWidths) {
  var minWidth = minWidthsForConfig(columnMinWidths)[key] || DEFAULT_COLUMN_MIN_WIDTH;
  return Math.max(0, width - minWidth);
}

function consumeShrinkAlongKeys(widths, shrinkKeys, requestedDelta, columnMinWidths) {
  var remaining = Math.max(0, Math.round(Number(requestedDelta) || 0));
  if (!remaining) return 0;
  shrinkKeys.some(function (key) {
    if (!remaining) return true;
    var currentWidth = widths[key];
    if (!currentWidth) return false;
    var reduction = Math.min(remaining, availableShrink(currentWidth, key, columnMinWidths));
    if (reduction <= 0) return false;
    widths[key] = currentWidth - reduction;
    remaining -= reduction;
    return remaining === 0;
  });
  return Math.max(0, Math.round(Number(requestedDelta) || 0)) - remaining;
}

export function resizeColumnPair(widths, leftKey, rightKey, delta, columnKeys, columnMinWidths) {
  var normalized = normalizeStoredColumnWidths(widths, columnKeys, columnMinWidths);
  var leftWidth = normalized[leftKey];
  var rightWidth = normalized[rightKey];
  if (!leftWidth || !rightWidth) return normalized;
  var keys = normalizedColumnKeys(columnKeys);
  var dividerIndex = keys.indexOf(leftKey);
  if (dividerIndex < 0 || keys[dividerIndex + 1] !== rightKey) return normalized;
  var requestedDelta = Math.round(Number(delta) || 0);
  if (!requestedDelta) return normalized;
  if (requestedDelta > 0) {
    var gainedRight = consumeShrinkAlongKeys(normalized, keys.slice(dividerIndex + 1), requestedDelta, columnMinWidths);
    normalized[leftKey] = leftWidth + gainedRight;
    return normalized;
  }
  var gainedLeft = consumeShrinkAlongKeys(normalized, keys.slice(0, dividerIndex + 1).reverse(), Math.abs(requestedDelta), columnMinWidths);
  normalized[rightKey] = rightWidth + gainedLeft;
  return normalized;
}

function measureAvailableTableWidth(table) {
  if (!table) return 0;
  if (table.parentElement) {
    if (table.parentElement.clientWidth) return Math.round(table.parentElement.clientWidth);
    if (typeof table.parentElement.getBoundingClientRect === 'function') {
      var parentRect = table.parentElement.getBoundingClientRect();
      if (parentRect && parentRect.width) return Math.round(parentRect.width);
    }
  }
  if (typeof table.getBoundingClientRect === 'function') {
    var tableRect = table.getBoundingClientRect();
    if (tableRect && tableRect.width) return Math.round(tableRect.width);
  }
  return 0;
}

export function applyBrowseColumnWidths(table, widths) {
  if (!table || typeof table.querySelectorAll !== 'function') return {};
  var keys = [];
  table.querySelectorAll('col[data-browse-column]').forEach(function (column) {
    var key = column.getAttribute('data-browse-column') || '';
    if (key) keys.push(key);
  });
  var totalWidth = measureAvailableTableWidth(table);
  var normalized = fitColumnWidthsToTotal(keys, widths, totalWidth);
  return writeBrowseColumnWidths(table, normalized);
}

export function writeBrowseColumnWidths(table, widths) {
  if (!table || typeof table.querySelectorAll !== 'function') return {};
  var normalized = normalizeStoredColumnWidths(widths);
  table.querySelectorAll('col[data-browse-column]').forEach(function (column) {
    var key = column.getAttribute('data-browse-column') || '';
    var width = normalized[key];
    if (width) {
      column.style.width = String(width) + 'px';
    } else {
      column.style.removeProperty('width');
    }
  });
  return normalized;
}

function readPersistedBrowseColumnWidths() {
  var stored = readSetting(STORAGE_KEY, {});
  if (!stored || typeof stored !== 'object') return {};
  if (stored.preferred && typeof stored.preferred === 'object') {
    return normalizeStoredColumnWidths(stored.preferred);
  }
  return normalizeStoredColumnWidths(stored);
}

function writePersistedBrowseColumnWidths(widths) {
  writeSetting(STORAGE_KEY, {preferred: normalizeStoredColumnWidths(widths)});
}

function clearPersistedBrowseColumnWidths() {
  writePersistedBrowseColumnWidths({});
}

function columnKeysFromTable(table) {
  var keys = [];
  table.querySelectorAll('col[data-browse-column]').forEach(function (column) {
    var key = column.getAttribute('data-browse-column') || '';
    if (key) keys.push(key);
  });
  return keys;
}

export function initBrowseColumnResizing(options) {
  var doc = options && options.document ? options.document : document;
  var win = options && options.window ? options.window : window;
  var table = options && options.table ? options.table : (doc ? doc.querySelector('table[data-browse-table]') : null);
  var onWidthsChanged = options && typeof options.onWidthsChanged === 'function' ? options.onWidthsChanged : function () {};
  if (!doc || !win || !table) return null;
  if (table.__browseColumnResizeApi) return table.__browseColumnResizeApi;

  var columnKeys = columnKeysFromTable(table);
  var preferredWidths = readPersistedBrowseColumnWidths();
  var widths = applyBrowseColumnWidths(table, preferredWidths);
  var activeDrag = null;

  function fitWidthsToTable() {
    widths = applyBrowseColumnWidths(table, preferredWidths);
    onWidthsChanged(widths);
    return widths;
  }

  function writeCurrentWidths() {
    widths = writeBrowseColumnWidths(table, widths);
    onWidthsChanged(widths);
    return widths;
  }

  function stopDrag() {
    if (!activeDrag) return;
    activeDrag.handle.classList.remove('dragging');
    if (doc.body) doc.body.classList.remove('browse-column-resizing');
    win.removeEventListener('pointermove', activeDrag.move);
    win.removeEventListener('pointerup', activeDrag.end);
    win.removeEventListener('pointercancel', activeDrag.end);
    preferredWidths = normalizeStoredColumnWidths(widths, columnKeys);
    writePersistedBrowseColumnWidths(preferredWidths);
    activeDrag = null;
  }

  table.querySelectorAll('.browse-column-resizer[data-browse-column-resizer]').forEach(function (handle) {
    handle.addEventListener('pointerdown', function (event) {
      var leftKey = handle.getAttribute('data-browse-column-resizer') || '';
      var index = columnKeys.indexOf(leftKey);
      var rightKey = index >= 0 ? columnKeys[index + 1] : '';
      if (!leftKey || !rightKey) return;
      event.preventDefault();
      var startX = event.clientX;
      var startWidths = Object.assign({}, widths);
      stopDrag();
      if (typeof handle.setPointerCapture === 'function' && event.pointerId !== undefined) {
        try {
          handle.setPointerCapture(event.pointerId);
        } catch (_error) {}
      }
      handle.classList.add('dragging');
      if (doc.body) doc.body.classList.add('browse-column-resizing');
      activeDrag = {
        handle: handle,
        move: function (moveEvent) {
          widths = resizeColumnPair(startWidths, leftKey, rightKey, moveEvent.clientX - startX);
          writeCurrentWidths();
        },
        end: function () {
          stopDrag();
        },
      };
      win.addEventListener('pointermove', activeDrag.move);
      win.addEventListener('pointerup', activeDrag.end);
      win.addEventListener('pointercancel', activeDrag.end);
    });
  });

  win.addEventListener('resize', function () {
    fitWidthsToTable();
  });

  var api = {
    getWidths: function () {
      return Object.assign({}, widths);
    },
    getPreferredWidths: function () {
      return Object.assign({}, preferredWidths);
    },
    refresh: function () {
      fitWidthsToTable();
      return Object.assign({}, widths);
    },
    reset: function () {
      preferredWidths = {};
      clearPersistedBrowseColumnWidths();
      fitWidthsToTable();
      return Object.assign({}, widths);
    },
  };
  table.__browseColumnResizeApi = api;
  return api;
}
