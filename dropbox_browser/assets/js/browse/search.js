function normalizeFilterText(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase();
}

export function normalizeBrowseFilters(filters) {
  var normalized = filters || {};
  return {
    query: String(normalized.query || ''),
    kind: normalized.kind === 'file' || normalized.kind === 'folder' ? normalized.kind : 'all',
    status: normalized.status && normalized.status !== 'all' ? String(normalized.status) : 'all',
    type: normalized.type && normalized.type !== 'all' ? String(normalized.type) : 'all',
  };
}

export function hasActiveBrowseFilters(filters) {
  var normalized = normalizeBrowseFilters(filters);
  return !!(normalized.query || normalized.kind !== 'all' || normalized.status !== 'all' || normalized.type !== 'all');
}

export function rowMatchesBrowseFilters(row, filters) {
  var normalized = normalizeBrowseFilters(filters);
  if (normalized.kind !== 'all' && row.kind !== normalized.kind) return false;
  if (normalized.status !== 'all' && row.status_label !== normalized.status) return false;
  if (normalized.type !== 'all' && row.type_label !== normalized.type) return false;
  if (!normalized.query) return true;
  var haystack = normalizeFilterText(row.display_name || '');
  return haystack.indexOf(normalizeFilterText(normalized.query)) !== -1;
}

export function filterBrowseRows(rows, filters) {
  var list = Array.isArray(rows) ? rows : [];
  var normalized = normalizeBrowseFilters(filters);
  return list.filter(function (row) {
    return rowMatchesBrowseFilters(row, normalized);
  });
}

export function collectBrowseTypeOptions(rows) {
  var seen = {};
  (Array.isArray(rows) ? rows : []).forEach(function (row) {
    if (!row || !row.type_label) return;
    seen[String(row.type_label)] = true;
  });
  return Object.keys(seen).sort(function (left, right) {
    return left.localeCompare(right);
  });
}
