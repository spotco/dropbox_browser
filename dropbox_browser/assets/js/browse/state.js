import {normalizeBrowseState, normalizeSortDirection, normalizeSortKey} from './api.js';

export function createBrowseState(initialState) {
  var normalized = normalizeBrowseState(initialState);
  return {
    path: normalized.path,
    sort: normalized.sort,
    dir: normalized.dir,
    refresh: normalized.refresh,
    rows: [],
    pendingMetadataPaths: [],
    pollCurrentFileStatuses: false,
    loading: false,
    error: null,
  };
}

export function applyBrowseSnapshot(state, payload) {
  var page = payload && payload.page ? payload.page : {};
  var sort = payload && payload.sort ? payload.sort : {};
  state.rows = Array.isArray(payload && payload.rows) ? payload.rows.slice() : [];
  state.pendingMetadataPaths = Array.isArray(payload && payload.pending_metadata_paths)
    ? payload.pending_metadata_paths.slice()
    : [];
  state.path = typeof page.path === 'string' ? page.path : state.path;
  state.sort = sort.current_key ? normalizeSortKey(sort.current_key) : state.sort;
  state.dir = sort.current_direction ? normalizeSortDirection(sort.current_direction) : state.dir;
  state.refresh = false;
  state.pollCurrentFileStatuses = !!(payload && payload.current_folder_info && payload.current_folder_info.poll_current_file_statuses);
  state.loading = false;
  state.error = null;
  return state;
}

export function setBrowseLoading(state, loading) {
  state.loading = !!loading;
  if (loading) state.error = null;
  return state;
}

export function setBrowseError(state, message) {
  state.loading = false;
  state.error = message || 'Unknown browse error.';
  return state;
}
