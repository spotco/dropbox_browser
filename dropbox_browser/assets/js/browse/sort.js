function rowGroup(row) {
  return row && row.kind === 'folder' ? 0 : 1;
}

function compareText(left, right) {
  return String(left || '').localeCompare(String(right || ''));
}

function compareNumber(left, right) {
  return Number(left || 0) - Number(right || 0);
}

export function compareBrowseRows(left, right, sortKey, direction) {
  var groupDiff = rowGroup(left) - rowGroup(right);
  if (groupDiff) return groupDiff;

  var factor = direction === 'desc' ? -1 : 1;
  var primary = 0;
  if (sortKey === 'size' || sortKey === 'date') {
    primary = compareNumber(left['sort_' + sortKey], right['sort_' + sortKey]);
  } else {
    primary = compareText(left['sort_' + sortKey], right['sort_' + sortKey]);
  }
  if (primary) return primary * factor;

  var nameFallback = compareText(left.sort_name, right.sort_name);
  return nameFallback * factor;
}

export function sortBrowseRows(rows, sortKey, direction) {
  return rows.slice().sort(function (left, right) {
    return compareBrowseRows(left, right, sortKey, direction);
  });
}

export function nextBrowseSortState(currentSort, currentDirection, clickedSort) {
  if (clickedSort === currentSort) {
    return {
      sort: currentSort,
      dir: currentDirection === 'asc' ? 'desc' : 'asc',
    };
  }
  return {
    sort: clickedSort,
    dir: 'asc',
  };
}
