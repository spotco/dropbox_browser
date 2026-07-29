import {normalizeBrowseFilters} from './search.js';

function appendStateParams(params, state, includeSort) {
  if (state.path) params.set('path', state.path);
  if (state.reveal) params.set('reveal', state.reveal);
  if (includeSort) {
    if (state.sort && state.sort !== 'name') params.set('sort', state.sort);
    if (state.dir && state.dir !== 'asc') params.set('dir', state.dir);
  }
  if (state.refresh) params.set('refresh', '1');
  return params;
}

function appendFilterParams(params, filters) {
  var normalized = normalizeBrowseFilters(filters);
  if (normalized.query) params.set('q', normalized.query);
  if (normalized.kind !== 'all') params.set('kind', normalized.kind);
  if (normalized.status !== 'all') params.set('status', normalized.status);
  if (normalized.type !== 'all') params.set('type', normalized.type);
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
    reveal: normalizeBrowsePath(input.reveal || ''),
    sort: normalizeSortKey(input.sort || 'name'),
    dir: normalizeSortDirection(input.dir || 'asc'),
    refresh: input.refresh === true || input.refresh === '1',
    filters: normalizeBrowseFilters(input.filters || {
      query: input.q || '',
      kind: input.kind || 'all',
      status: input.status || 'all',
      type: input.type || 'all',
    }),
  };
}

export function buildBrowseListingEndpoint(state) {
  var normalized = normalizeBrowseState(state);
  var params = appendStateParams(new URLSearchParams(), normalized, true);
  var query = params.toString();
  return '/browse/endpoints/listing' + (query ? '?' + query : '');
}

export function buildBrowsePageHref(state) {
  var normalized = normalizeBrowseState(state);
  var params = appendStateParams(new URLSearchParams(), normalized, false);
  appendFilterParams(params, normalized.filters);
  var query = params.toString();
  return '/?' + query;
}
