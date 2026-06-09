export var DEFAULT_VIRTUAL_ROW_HEIGHT = 49;
export var DEFAULT_VIRTUAL_OVERSCAN = 6;
export var DEFAULT_VIRTUAL_THRESHOLD = 10;

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
