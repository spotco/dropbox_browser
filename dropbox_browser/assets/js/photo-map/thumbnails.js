import {PHOTO_MAP_THUMBNAIL_CONCURRENCY} from './config.js';
import {runPhotoMapMetadataQueue} from './queue.js';

export function buildPhotoMapThumbnailUrl(sourcePath) {
  var params = new URLSearchParams();
  params.set('path', String(sourcePath || ''));
  params.set('source', 'remote');
  return '/thumbnail?' + params.toString();
}

function pathSet(values) {
  if (values instanceof Set) return values;
  return new Set(Array.isArray(values) ? values.map(String) : []);
}

function metadataForItem(item, metadataResults) {
  if (metadataResults instanceof Map) return metadataResults.get(item.path) || null;
  if (Array.isArray(metadataResults)) {
    return metadataResults.find(function (result) { return result && result.path === item.path; }) || null;
  }
  return null;
}

export function selectPhotoMapThumbnailItems(items, options) {
  var config = options || {};
  var visiblePaths = pathSet(config.visiblePaths);
  var selectedPath = config.selectedPath ? String(config.selectedPath) : '';
  var results = [];
  var seen = new Set();
  (Array.isArray(items) ? items : []).forEach(function (item) {
    var path = String((item && (item.photoMapSourcePath || item.path)) || '');
    var metadata = metadataForItem(item, config.metadataResults);
    var visible = visiblePaths.has(path) || selectedPath === path || item.photoMapVisible === true || item.photoMapSelected === true;
    if (!path || seen.has(path) || !visible || !metadata || metadata.status !== 'located') return;
    if ((metadata.mediaKind || item.photoMapMediaKind) !== 'photo') return;
    seen.add(path);
    results.push(Object.assign({}, item, {
      photoMapThumbnailUrl: buildPhotoMapThumbnailUrl(path),
    }));
  });
  return results;
}

export function loadPhotoMapThumbnail(imageFactory, sourcePath, signal) {
  var image = imageFactory();
  var url = buildPhotoMapThumbnailUrl(sourcePath);
  return new Promise(function (resolve, reject) {
    var settled = false;
    function finish(callback, value) {
      if (settled) return;
      settled = true;
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', abort);
      callback(value);
    }
    function abort() {
      try { image.src = ''; } catch (_error) {}
      var error = new Error('Photo Map thumbnail request aborted.');
      error.name = 'AbortError';
      finish(reject, error);
    }
    image.onload = function () { finish(resolve, {url: url, image: image}); };
    image.onerror = function () { finish(reject, new Error('Photo Map thumbnail request failed.')); };
    if (signal) {
      if (signal.aborted) return abort();
      if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', abort, {once: true});
    }
    image.src = url;
  });
}

export function runPhotoMapThumbnailQueue(items, options) {
  var config = options || {};
  var loader = config.loader;
  if (typeof loader !== 'function') {
    loader = function (item, signal) {
      return loadPhotoMapThumbnail(config.imageFactory, item.photoMapSourcePath || item.path, signal);
    };
  }
  return runPhotoMapMetadataQueue(items, async function (item, signal) {
    var loaded = await loader(item, signal);
    return Object.assign({}, loaded, {path: item.path, status: 'loaded'});
  }, {
    concurrency: config.concurrency || PHOTO_MAP_THUMBNAIL_CONCURRENCY,
    signal: config.signal,
    isCurrent: config.isCurrent,
    onResult: config.onResult,
  });
}
