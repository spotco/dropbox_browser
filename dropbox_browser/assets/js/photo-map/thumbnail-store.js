function sourcePath(value) {
  if (value && typeof value === 'object') {
    return String(value.photoMapSourcePath || value.path || '');
  }
  return String(value || '');
}

function copyEntry(entry) {
  return entry ? Object.assign({}, entry) : null;
}

/*
 * The host owns one logical thumbnail state per source path.  Renderers may
 * still keep their own presentation objects for now; this store is the
 * authority used to decide whether a path is ready and which URL is current.
 */
export function createPhotoMapThumbnailStore() {
  var entries = new Map();
  var listeners = new Set();

  function notify(next, previous, reason) {
    if (next.state === (previous && previous.state) &&
        next.url === (previous && previous.url) &&
        next.errorReason === (previous && previous.errorReason)) return false;
    listeners.forEach(function (listener) {
      listener(copyEntry(next), copyEntry(previous), reason || 'state-update');
    });
    return true;
  }

  function update(item, state, options) {
    var path = sourcePath(item);
    if (!path) return null;
    var nextState = String(state || 'idle');
    var config = options || {};
    var previous = entries.get(path) || {path: path, state: 'idle', url: ''};

    // A completed URL is durable for the current generation.  Scheduler
    // preemption and viewport churn must never turn a ready renderer back into
    // a loading/idle placeholder.
    if (previous.state === 'ready' && (nextState === 'loading' || nextState === 'idle')) {
      return copyEntry(previous);
    }

    var next = Object.assign({}, previous, {
      path: path,
      state: nextState,
      errorReason: nextState === 'error' ? String(config.reason || '') : '',
    });
    if (nextState !== 'ready' && !config.url) next.url = previous.url || '';
    if (config.url) next.url = String(config.url);
    if (config.generation !== undefined) next.generation = config.generation;
    entries.set(path, next);
    notify(next, previous, config.reason);
    return copyEntry(next);
  }

  function setResult(item, result) {
    var path = sourcePath(item);
    var url = result && result.url ? String(result.url) : '';
    if (!path || !url) return null;
    var entry = update(item, 'ready', {url: url, reason: 'thumbnail-loaded'});
    if (!entry) return null;
    // Do not retain the loader's DOM Image object in application state or in
    // debug snapshots. Renderers only need the stable URL and logical status.
    entry.result = {path: path, status: 'loaded', url: url};
    var stored = entries.get(path);
    entries.set(path, Object.assign({}, stored, {result: entry.result}));
    return copyEntry(entry.result);
  }

  function get(path) {
    return copyEntry(entries.get(sourcePath(path)) || null);
  }

  function getResult(path) {
    var entry = entries.get(sourcePath(path));
    if (!entry || entry.state !== 'ready' || !entry.url) return null;
    return copyEntry(entry.result || {path: entry.path, status: 'loaded', url: entry.url});
  }

  function clear() {
    entries.clear();
  }

  return {
    get: get,
    getResult: getResult,
    hasReady: function (path) { return !!getResult(path); },
    setState: update,
    setResult: setResult,
    clear: clear,
    paths: function () { return Array.from(entries.keys()); },
    readyPaths: function () {
      return Array.from(entries.values()).filter(function (entry) {
        return entry.state === 'ready';
      }).map(function (entry) { return entry.path; });
    },
    snapshot: function () {
      return Array.from(entries.values()).map(copyEntry);
    },
    subscribe: function (listener) {
      if (typeof listener !== 'function') return function () {};
      listeners.add(listener);
      return function () { listeners.delete(listener); };
    },
  };
}
