const COUNTER_NAMES = [
  'cacheReads',
  'cacheReadErrors',
  'cacheEntries',
  'cacheHits',
  'cacheMisses',
  'cacheWriteBatches',
  'cacheWriteEntries',
  'cacheWriteErrors',
  'metadataQueued',
  'metadataCompleted',
  'metadataLocated',
  'metadataNoLocation',
  'metadataUnsupported',
  'metadataErrors',
  'metadataAborted',
  'thumbnailQueued',
  'thumbnailCompleted',
  'thumbnailErrors',
  'thumbnailAborted',
];

function emptyCounters() {
  var counters = {};
  COUNTER_NAMES.forEach(function (name) { counters[name] = 0; });
  return counters;
}

function numericAmount(value) {
  return Number.isFinite(value) ? value : 1;
}

export function createPhotoMapDiagnostics(win) {
  var generation = 0;
  var counters = emptyCounters();

  function enabled() {
    return !!(win && win.ClientLogger && typeof win.ClientLogger.enabledFor === 'function' &&
      win.ClientLogger.enabledFor('photo-map'));
  }

  function increment(name, amount) {
    if (!Object.prototype.hasOwnProperty.call(counters, name)) return;
    counters[name] += numericAmount(amount);
  }

  function snapshot(extra) {
    return Object.assign({generation: generation}, counters, extra || {});
  }

  function logSummary(message, extra) {
    if (!enabled() || !win.ClientLogger || typeof win.ClientLogger.info !== 'function') return false;
    return win.ClientLogger.info('photo-map', message, snapshot(extra));
  }

  return {
    enabled: enabled,
    beginGeneration: function (value) {
      generation = Number.isFinite(value) ? value : generation + 1;
      counters = emptyCounters();
    },
    isGeneration: function (value) { return generation === value; },
    increment: increment,
    snapshot: function (extra) { return snapshot(extra); },
    logSummary: logSummary,
  };
}
