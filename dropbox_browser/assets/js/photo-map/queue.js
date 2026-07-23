import {PHOTO_MAP_METADATA_CONCURRENCY} from './config.js';

export async function runPhotoMapMetadataQueue(items, worker, options) {
  var config = options || {};
  var source = Array.isArray(items) ? items : [];
  var signal = config.signal;
  var isCurrent = typeof config.isCurrent === 'function' ? config.isCurrent : function () { return true; };
  var concurrency = Number.isInteger(config.concurrency) && config.concurrency > 0
    ? config.concurrency
    : PHOTO_MAP_METADATA_CONCURRENCY;
  var nextIndex = 0;
  var results = [];

  async function consume() {
    while (nextIndex < source.length && !(signal && signal.aborted) && isCurrent()) {
      var index = nextIndex;
      nextIndex += 1;
      var item = source[index];
      var result;
      try {
        result = await worker(item, signal);
      } catch (error) {
        result = {
          path: item && item.path ? item.path : '',
          sourcePath: item && item.photoMapSourcePath ? item.photoMapSourcePath : (item && item.path ? item.path : ''),
          status: 'error',
          reason: error && error.name === 'AbortError' ? 'aborted' : 'queue-worker-failure',
        };
      }
      if ((signal && signal.aborted) || !isCurrent()) return;
      results.push({item: item, result: result});
      if (typeof config.onResult === 'function') config.onResult(item, result);
    }
  }

  var workers = [];
  var workerCount = Math.min(concurrency, source.length);
  for (var index = 0; index < workerCount; index += 1) workers.push(consume());
  await Promise.all(workers);
  return {
    results: results,
    aborted: !!(signal && signal.aborted) || !isCurrent(),
    queued: nextIndex < source.length,
  };
}
