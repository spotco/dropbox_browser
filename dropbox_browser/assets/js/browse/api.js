function appendStateParams(params, state) {
  if (state.path) params.set('path', state.path);
  if (state.sort && state.sort !== 'name') params.set('sort', state.sort);
  if (state.dir && state.dir !== 'asc') params.set('dir', state.dir);
  if (state.refresh) params.set('refresh', '1');
  return params;
}

export function normalizeBrowsePath(rawPath) {
  if (!rawPath) return '';
  var normalized = String(rawPath).replace(/\\/g, '/');
  var parts = normalized.split('/').filter(function (part) {
    return part && part !== '.';
  });
  if (parts.some(function (part) { return part === '..'; })) {
    throw new Error('Parent path segments are not allowed.');
  }
  return parts.join('/');
}

export function normalizeSortKey(sortKey) {
  return ['name', 'type', 'status', 'size', 'date'].indexOf(sortKey) >= 0 ? sortKey : 'name';
}

export function normalizeSortDirection(direction) {
  return direction === 'desc' ? 'desc' : 'asc';
}

export function normalizeBrowseState(state) {
  var input = state || {};
  return {
    path: normalizeBrowsePath(input.path || ''),
    sort: normalizeSortKey(input.sort || 'name'),
    dir: normalizeSortDirection(input.dir || 'asc'),
    refresh: input.refresh === true || input.refresh === '1',
  };
}

export function buildBrowseListingEndpoint(state) {
  var normalized = normalizeBrowseState(state);
  var params = appendStateParams(new URLSearchParams(), normalized);
  var query = params.toString();
  return '/browse/endpoints/listing' + (query ? '?' + query : '');
}

export function buildBrowsePageHref(state) {
  var normalized = normalizeBrowseState(state);
  var params = appendStateParams(new URLSearchParams(), normalized);
  var query = params.toString();
  return '/?' + query;
}
