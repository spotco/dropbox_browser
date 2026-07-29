import {normalizeSortDirection, normalizeSortKey} from './api.js';

export const BROWSE_SORT_SETTING_KEY = 'browse-sort-by-path';

export function defaultBrowseSortState() {
  return {key: 'name', direction: 'asc'};
}

export function normalizeStoredBrowseSort(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return defaultBrowseSortState();
  }
  return {
    key: normalizeSortKey(value.key),
    direction: normalizeSortDirection(value.direction),
  };
}

export function browseSortStorageKey(path) {
  return path || '/';
}

export function readBrowseSortState(path, entries) {
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    return defaultBrowseSortState();
  }
  return normalizeStoredBrowseSort(entries[browseSortStorageKey(path)]);
}

export function writeBrowseSortState(path, sortKey, direction, entries) {
  var current = entries && typeof entries === 'object' && !Array.isArray(entries) ? entries : {};
  var next = Object.assign({}, current);
  var normalized = normalizeStoredBrowseSort({key: sortKey, direction: direction});
  next[browseSortStorageKey(path)] = normalized;
  return next;
}
