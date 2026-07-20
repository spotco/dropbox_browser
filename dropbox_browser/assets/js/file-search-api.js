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
  var limit = Number(input.limit);
  return {
    path: normalizePath(input.path || ''),
    query: String(input.query || ''),
    recursive: input.recursive === false ? false : true,
    session: input.session === true,
    sessionId: String(input.sessionId || ''),
    cancel: input.cancel === true,
    limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : null,
  };
}

export function buildFileSearchEndpoint(state) {
  var normalized = normalizeFileSearchState(state);
  var params = new URLSearchParams();
  if (normalized.path) params.set('path', normalized.path);
  params.set('recursive', normalized.recursive ? '1' : '0');
  if (normalized.query) params.set('query', normalized.query);
  if (normalized.session) params.set('session', '1');
  if (normalized.sessionId) params.set('session_id', normalized.sessionId);
  if (normalized.cancel) params.set('cancel', '1');
  if (normalized.limit !== null) params.set('limit', String(normalized.limit));
  var query = params.toString();
  return '/browse/endpoints/search' + (query ? '?' + query : '');
}
