import {compareFilenameKeys, filenameCompareKey} from '../filename-compare-key.js';

export function libraryNameSortKey(name) {
  return filenameCompareKey(name);
}

export function compareLibraryNames(left, right) {
  var result = compareFilenameKeys(
    libraryNameSortKey(left && left.display_name),
    libraryNameSortKey(right && right.display_name)
  );
  if (result) return result;
  var leftName = String((left && left.display_name) || '');
  var rightName = String((right && right.display_name) || '');
  if (leftName < rightName) return -1;
  if (leftName > rightName) return 1;
  return 0;
}

export function libraryNodeDateSortValue(node) {
  var value = 0;
  if (node && node.type === 'folder') value = node.recursive_mtime != null ? node.recursive_mtime : node.mtime;
  else if (node) value = node.mtime;
  value = Number(value || 0);
  return Number.isFinite(value) ? value : 0;
}

export function compareLibraryDates(left, right) {
  var leftValue = libraryNodeDateSortValue(left);
  var rightValue = libraryNodeDateSortValue(right);
  if (leftValue > rightValue) return -1;
  if (leftValue < rightValue) return 1;
  return compareLibraryNames(left, right);
}

export function reverseLibraryComparison(result) {
  if (result < 0) return 1;
  if (result > 0) return -1;
  return 0;
}

export function compareLibraryNodes(sortKey, sortDirection, left, right) {
  var result = sortKey === 'date' ? compareLibraryDates(left, right) : compareLibraryNames(left, right);
  if (sortDirection === 'asc') {
    if (sortKey === 'date') return reverseLibraryComparison(result);
    return result;
  }
  if (sortKey === 'date') return result;
  return reverseLibraryComparison(result);
}

export function sortLibraryItems(items, sortKey, sortDirection) {
  return items.slice().sort(function (left, right) {
    return compareLibraryNodes(sortKey, sortDirection, left, right);
  });
}

export function firstSelectedVisibleNodeId(visibleNodeIds, selectedIds, selectionAnchor) {
  var index;
  for (index = 0; index < visibleNodeIds.length; index += 1) {
    if (selectedIds[visibleNodeIds[index]]) return visibleNodeIds[index];
  }
  if (selectionAnchor && selectedIds[selectionAnchor]) return selectionAnchor;
  return Object.keys(selectedIds)[0] || null;
}
