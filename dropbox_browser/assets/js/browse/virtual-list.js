export var DEFAULT_VIRTUAL_ROW_HEIGHT = 49;
export var DEFAULT_VIRTUAL_OVERSCAN = 6;
export var DEFAULT_VIRTUAL_THRESHOLD = 10;

export function insertBeforeChild(parent, node, reference) {
  if (!parent || !node) return node;
  if (reference && reference.parentNode === parent && typeof parent.insertBefore === 'function') {
    parent.insertBefore(node, reference);
    return node;
  }
  if (typeof parent.appendChild === 'function') parent.appendChild(node);
  return node;
}

export function shouldVirtualizeRows(rowCount, options) {
  var threshold = options && options.threshold ? options.threshold : DEFAULT_VIRTUAL_THRESHOLD;
  return rowCount >= threshold && typeof window !== 'undefined' && typeof document !== 'undefined';
}

export function computeVirtualWindow(options) {
  var rowCount = Math.max(0, Number(options && options.rowCount) || 0);
  var rowHeight = Math.max(1, Number(options && options.rowHeight) || DEFAULT_VIRTUAL_ROW_HEIGHT);
  var scrollTop = Math.max(0, Number(options && options.scrollTop) || 0);
  var viewportHeight = Math.max(rowHeight, Number(options && options.viewportHeight) || rowHeight);
  var overscan = Math.max(0, Number(options && options.overscan) || DEFAULT_VIRTUAL_OVERSCAN);
  if (rowCount === 0) {
    return {
      startIndex: 0,
      endIndex: 0,
      topSpacerHeight: 0,
      bottomSpacerHeight: 0,
      totalHeight: 0,
    };
  }

  var startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  var visibleRowCount = Math.max(1, Math.ceil(viewportHeight / rowHeight));
  var endIndex = Math.min(rowCount, startIndex + visibleRowCount + overscan * 2);
  var topSpacerHeight = startIndex * rowHeight;
  var bottomSpacerHeight = Math.max(0, (rowCount - endIndex) * rowHeight);
  return {
    startIndex: startIndex,
    endIndex: endIndex,
    topSpacerHeight: topSpacerHeight,
    bottomSpacerHeight: bottomSpacerHeight,
    totalHeight: rowCount * rowHeight,
  };
}

export function rowIndexForScrollPosition(options) {
  var rowCount = Math.max(0, Number(options && options.rowCount) || 0);
  if (rowCount === 0) return -1;
  var rowHeight = Math.max(1, Number(options && options.rowHeight) || DEFAULT_VIRTUAL_ROW_HEIGHT);
  var scrollTop = Math.max(0, Number(options && options.scrollTop) || 0);
  var viewportHeight = Math.max(rowHeight, Number(options && options.viewportHeight) || rowHeight);
  var totalHeight = rowCount * rowHeight;
  var scrollableHeight = Math.max(0, totalHeight - viewportHeight);
  if (scrollableHeight <= 0) return 0;
  var progress = Math.min(1, scrollTop / scrollableHeight);
  return Math.min(rowCount - 1, Math.max(0, Math.round(progress * (rowCount - 1))));
}

export function readTableViewport(tbody, rowHeight, viewportHeight) {
  if (!tbody || typeof window === 'undefined') {
    return {
      scrollTop: 0,
      viewportHeight: viewportHeight || rowHeight || DEFAULT_VIRTUAL_ROW_HEIGHT,
    };
  }
  var rect = tbody.getBoundingClientRect();
  var scrollParent = tbody.closest ? tbody.closest('main') : null;
  var scrollOffset = window.scrollY;
  var tableTop = rect.top + window.scrollY;
  var resolvedViewportHeight = viewportHeight || window.innerHeight || rowHeight || DEFAULT_VIRTUAL_ROW_HEIGHT;
  if (scrollParent && scrollParent.scrollHeight > scrollParent.clientHeight) {
    var parentRect = scrollParent.getBoundingClientRect();
    scrollOffset = scrollParent.scrollTop;
    tableTop = rect.top - parentRect.top + scrollParent.scrollTop;
    resolvedViewportHeight = viewportHeight || scrollParent.clientHeight || rowHeight || DEFAULT_VIRTUAL_ROW_HEIGHT;
  }
  var scrollTop = Math.max(0, scrollOffset - tableTop);
  return {
    scrollTop: scrollTop,
    viewportHeight: resolvedViewportHeight,
  };
}

export function measureMountedRowHeight(tbody, fallbackHeight) {
  if (!tbody || typeof tbody.querySelector !== 'function') {
    return fallbackHeight || DEFAULT_VIRTUAL_ROW_HEIGHT;
  }
  var row = tbody.querySelector('tr[data-browse-row-id]');
  if (!row || typeof row.getBoundingClientRect !== 'function') {
    return fallbackHeight || DEFAULT_VIRTUAL_ROW_HEIGHT;
  }
  var height = row.getBoundingClientRect().height;
  return height > 0 ? height : (fallbackHeight || DEFAULT_VIRTUAL_ROW_HEIGHT);
}

/*
 * Shared bounded row pool for virtualized list consumers.
 *
 * The recycler deliberately knows nothing about row markup. Consumers provide
 * a row factory, a binder, and an optional mount/render hook. This keeps the
 * window math, pool lifetime, and animation-frame scheduling identical for
 * media playlists and the file-browser table while preserving their distinct
 * DOM contracts.
 */
export function createVirtualRowRecycler(options) {
  var settings = options || {};
  var viewport = settings.viewport || null;
  var rowCount = Math.max(0, Number(settings.rowCount) || 0);
  var getItem = typeof settings.getItem === 'function' ? settings.getItem : function () { return null; };
  var rowHeight = Math.max(1, Number(settings.rowHeight) || DEFAULT_VIRTUAL_ROW_HEIGHT);
  var overscan = Math.max(0, Number(settings.overscan) || DEFAULT_VIRTUAL_OVERSCAN);
  var threshold = Math.max(1, Number(settings.threshold) || DEFAULT_VIRTUAL_THRESHOLD);
  var pool = [];
  var windowKey = '';
  var lastWindow = null;
  var renderFrame = null;
  var destroyed = false;
  var rowHeightMeasured = false;

  function readViewport() {
    var value;
    if (typeof settings.getViewport === 'function') {
      value = settings.getViewport() || {};
    } else {
      value = {
        scrollTop: viewport && Number(viewport.scrollTop) || 0,
        viewportHeight: viewport && Number(viewport.clientHeight) || rowHeight
      };
    }
    return {
      scrollTop: Math.max(0, Number(value.scrollTop) || 0),
      viewportHeight: Math.max(rowHeight, Number(value.viewportHeight) || rowHeight)
    };
  }

  function currentWindow() {
    var visible = readViewport();
    return computeVirtualWindow({
      rowCount: rowCount,
      rowHeight: rowHeight,
      scrollTop: visible.scrollTop,
      viewportHeight: visible.viewportHeight,
      overscan: overscan
    });
  }

  function poolSizeFor(windowState) {
    return Math.max(0, windowState.endIndex - windowState.startIndex);
  }

  function ensurePool(size) {
    var row;
    while (pool.length < size) {
      if (typeof settings.createRow !== 'function') break;
      row = settings.createRow(pool.length);
      if (!row) break;
      pool.push(row);
      if (typeof settings.mountRow === 'function') settings.mountRow(row, pool.length - 1);
    }
  }

  function hideRow(row, hidden) {
    if (!row) return;
    if (typeof settings.hideRow === 'function') {
      settings.hideRow(row, hidden);
      return;
    }
    row.hidden = !!hidden;
  }

  function render(force) {
    var windowState;
    var nextWindowKey;
    var activeCount;
    var index;
    var row;
    var measuredHeight;
    var measuredDiff;
    if (destroyed) return lastWindow;
    if (!shouldVirtualizeRows(rowCount, {threshold: threshold})) {
      pool.forEach(function (pooledRow) { hideRow(pooledRow, true); });
      lastWindow = null;
      return null;
    }
    windowState = currentWindow();
    nextWindowKey = [
      rowCount,
      rowHeight,
      windowState.startIndex,
      windowState.endIndex,
      windowState.topSpacerHeight,
      windowState.bottomSpacerHeight
    ].join(':');
    if (!force && windowKey === nextWindowKey) return lastWindow;

    activeCount = poolSizeFor(windowState);
    ensurePool(activeCount);
    for (index = 0; index < pool.length; index += 1) {
      row = pool[index];
      if (index >= activeCount) {
        hideRow(row, true);
        continue;
      }
      hideRow(row, false);
      if (typeof settings.updateRow === 'function') {
        settings.updateRow(
          row,
          getItem(windowState.startIndex + index),
          windowState.startIndex + index,
          index,
          windowState,
          {
            rowHeight: rowHeight,
            rowHeightMeasured: rowHeightMeasured,
            rowCount: rowCount,
          },
        );
      }
    }
    windowKey = nextWindowKey;
    lastWindow = windowState;
    if (typeof settings.renderWindow === 'function') {
      settings.renderWindow(windowState, activeCount, pool, {
        rowHeight: rowHeight,
        rowHeightMeasured: rowHeightMeasured,
        rowCount: rowCount,
        windowKey: windowKey,
      });
    }

    if (!rowHeightMeasured && pool.length > 0 && typeof settings.measureRowHeight === 'function') {
      measuredHeight = Number(settings.measureRowHeight(pool[0], rowHeight));
      if (measuredHeight > 0) {
        rowHeightMeasured = true;
        measuredDiff = Math.abs(measuredHeight - rowHeight);
        if (measuredDiff > 0.5) {
          rowHeight = measuredHeight;
          windowKey = '';
          return render(true);
        }
      }
    }
    if (typeof settings.afterRender === 'function') {
      settings.afterRender(windowState, activeCount, pool, {
        rowHeight: rowHeight,
        rowHeightMeasured: rowHeightMeasured,
        rowCount: rowCount,
        windowKey: windowKey,
      });
    }
    return lastWindow;
  }

  function schedule(force) {
    if (destroyed || renderFrame !== null) return;
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      renderFrame = window.requestAnimationFrame(function () {
        renderFrame = null;
        render(!!force);
      });
      return;
    }
    render(!!force);
  }

  function cancel() {
    if (renderFrame === null) return;
    if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(renderFrame);
    }
    renderFrame = null;
  }

  function setData(nextRowCount, nextGetItem) {
    rowCount = Math.max(0, Number(nextRowCount) || 0);
    if (typeof nextGetItem === 'function') getItem = nextGetItem;
    windowKey = '';
    lastWindow = null;
    return api;
  }

  function setRowHeight(nextRowHeight) {
    rowHeight = Math.max(1, Number(nextRowHeight) || DEFAULT_VIRTUAL_ROW_HEIGHT);
    rowHeightMeasured = false;
    windowKey = '';
    lastWindow = null;
    return api;
  }

  function stateSnapshot() {
    return {
      enabled: shouldVirtualizeRows(rowCount, {threshold: threshold}),
      rowCount: rowCount,
      rowHeight: rowHeight,
      rowHeightMeasured: rowHeightMeasured,
      overscan: overscan,
      threshold: threshold,
      windowKey: windowKey,
      window: lastWindow,
      mountedCount: pool.filter(function (row) { return row && !row.hidden; }).length,
      poolSize: pool.length,
    };
  }

  function destroy() {
    cancel();
    pool.forEach(function (row) {
      if (typeof settings.unmountRow === 'function') settings.unmountRow(row);
      else if (row && row.parentNode && typeof row.parentNode.removeChild === 'function') row.parentNode.removeChild(row);
    });
    pool = [];
    destroyed = true;
    lastWindow = null;
  }

  var api = {
    cancel: cancel,
    destroy: destroy,
    getState: stateSnapshot,
    render: render,
    schedule: schedule,
    setData: setData,
    setRowHeight: setRowHeight,
  };
  return api;
}
