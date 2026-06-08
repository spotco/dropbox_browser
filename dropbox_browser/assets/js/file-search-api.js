function normalizePath(rawPath) {
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

export function normalizeFileSearchState(state) {
  var input = state || {};
  return {
    path: normalizePath(input.path || ''),
    query: String(input.query || ''),
    recursive: input.recursive === false ? false : true,
  };
}

export function buildFileSearchEndpoint(state) {
  var normalized = normalizeFileSearchState(state);
  var params = new URLSearchParams();
  if (normalized.path) params.set('path', normalized.path);
  params.set('recursive', normalized.recursive ? '1' : '0');
  if (normalized.query) params.set('query', normalized.query);
  var query = params.toString();
  return '/browse/endpoints/search' + (query ? '?' + query : '');
}
