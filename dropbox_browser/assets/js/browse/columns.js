var STORAGE_KEY = 'browse-column-widths-v1';
var DEFAULT_COLUMN_MIN_WIDTH = 32;

export var BROWSE_COLUMN_KEYS = ['name', 'type', 'status', 'size', 'date', 'view', 'sync'];

export var BROWSE_COLUMN_MIN_WIDTHS = {
  name: DEFAULT_COLUMN_MIN_WIDTH,
  type: DEFAULT_COLUMN_MIN_WIDTH,
  status: DEFAULT_COLUMN_MIN_WIDTH,
  size: DEFAULT_COLUMN_MIN_WIDTH,
  date: DEFAULT_COLUMN_MIN_WIDTH,
  view: DEFAULT_COLUMN_MIN_WIDTH,
  sync: DEFAULT_COLUMN_MIN_WIDTH,
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
  var base = Math.floor(extraWidth / keys.length);
  var remainder = extraWidth - (base * keys.length);
  var widths = {};
  keys.forEach(function (key, index) {
    widths[key] = (minWidths[key] || DEFAULT_COLUMN_MIN_WIDTH) + base + (index < remainder ? 1 : 0);
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

export function resizeColumnPair(widths, leftKey, rightKey, delta, columnKeys, columnMinWidths) {
  var normalized = normalizeStoredColumnWidths(widths, columnKeys, columnMinWidths);
  var leftWidth = normalized[leftKey];
  var rightWidth = normalized[rightKey];
  if (!leftWidth || !rightWidth) return normalized;
  var minWidths = minWidthsForConfig(columnMinWidths);
  var leftMin = minWidths[leftKey] || DEFAULT_COLUMN_MIN_WIDTH;
  var rightMin = minWidths[rightKey] || DEFAULT_COLUMN_MIN_WIDTH;
  var pairTotal = leftWidth + rightWidth;
  var nextLeft = Math.min(Math.max(leftWidth + Math.round(Number(delta) || 0), leftMin), pairTotal - rightMin);
  var nextRight = pairTotal - nextLeft;
  normalized[leftKey] = nextLeft;
  normalized[rightKey] = nextRight;
  return normalized;
}

export function applyBrowseColumnWidths(table, widths) {
  if (!table || typeof table.querySelectorAll !== 'function') return {};
  var keys = [];
  table.querySelectorAll('col[data-browse-column]').forEach(function (column) {
    var key = column.getAttribute('data-browse-column') || '';
    if (key) keys.push(key);
  });
  var totalWidth = 0;
  if (typeof table.getBoundingClientRect === 'function') {
    totalWidth = Math.round(table.getBoundingClientRect().width);
  }
  if (!totalWidth && table.parentElement && typeof table.parentElement.getBoundingClientRect === 'function') {
    totalWidth = Math.round(table.parentElement.getBoundingClientRect().width);
  }
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
  return normalizeStoredColumnWidths(readSetting(STORAGE_KEY, {}));
}

function writePersistedBrowseColumnWidths(widths) {
  writeSetting(STORAGE_KEY, normalizeStoredColumnWidths(widths));
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
  if (!doc || !win || !table) return null;
  if (table.__browseColumnResizeApi) return table.__browseColumnResizeApi;

  var columnKeys = columnKeysFromTable(table);
  var widths = applyBrowseColumnWidths(table, readPersistedBrowseColumnWidths());
  var activeDrag = null;

  function fitWidthsToTable(persist) {
    widths = applyBrowseColumnWidths(table, widths);
    if (persist !== false) writePersistedBrowseColumnWidths(widths);
    return widths;
  }

  function writeCurrentWidths(persist) {
    widths = writeBrowseColumnWidths(table, widths);
    if (persist !== false) writePersistedBrowseColumnWidths(widths);
    return widths;
  }

  function stopDrag() {
    if (!activeDrag) return;
    activeDrag.handle.classList.remove('dragging');
    if (doc.body) doc.body.classList.remove('browse-column-resizing');
    win.removeEventListener('pointermove', activeDrag.move);
    win.removeEventListener('pointerup', activeDrag.end);
    win.removeEventListener('pointercancel', activeDrag.end);
    writePersistedBrowseColumnWidths(widths);
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
          writeCurrentWidths(false);
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
    fitWidthsToTable(false);
  });

  var api = {
    getWidths: function () {
      return Object.assign({}, widths);
    },
    refresh: function () {
      fitWidthsToTable(false);
      return Object.assign({}, widths);
    },
  };
  table.__browseColumnResizeApi = api;
  return api;
}
